import type { Task } from "@notesnook/core";
import { NativeModules, Platform } from "react-native";
import { useUserStore } from "../stores/use-user-store";
import {
  desiredTaskAlarms,
  type DesiredTaskAlarm,
  type OverdueTaskSurface
} from "./task-alarm-plan";

export type UrgentAlarmStatus =
  | "unsupported"
  | "notDetermined"
  | "denied"
  | "authorized";

/**
 * What the native scheduler reports after a reconcile. `scheduledAlarmKeys` is
 * the per-occurrence truth: exactly the alarms the system currently holds, so
 * the caller can give a notification fallback to the occurrences that are *not*
 * in it and to none of the ones that are (no duplicate audible alert).
 */
type AlarmReconcileReport = {
  status: UrgentAlarmStatus;
  scheduledAlarmKeys?: string[];
};

type AlarmCancellationReport = {
  status: UrgentAlarmStatus;
  cancelledAlarmKeys?: string[];
};

export type OverdueActivityStatus = "unsupported" | "denied" | "authorized";

export type OverdueActivityResult = {
  status: OverdueActivityStatus;
  /** Surfaces created this pass. */
  created?: number;
  /** Surfaces whose content changed and was refreshed in place. */
  updated?: number;
  /** Surfaces the person dismissed, that expired, or that no longer apply. */
  ended?: number;
  /** Tasks whose surface could not be shown; never silently assumed shown. */
  failedTaskIds?: string[];
};

type TaskAlarmNative = {
  status(): Promise<UrgentAlarmStatus>;
  requestAuthorization(): Promise<UrgentAlarmStatus>;
  replaceAlarms(
    accountId: string,
    alarms: DesiredTaskAlarm[]
  ): Promise<AlarmReconcileReport>;
  /** Which of these alarm keys the system currently holds for this account. */
  verifyAlarms(
    accountId: string,
    alarmKeys: string[]
  ): Promise<AlarmReconcileReport>;
  /**
   * Cancels only alarms that have not started alerting yet (`.scheduled`), so a
   * notification fallback cannot duplicate an alarm that is still counting down
   * and so no person's live alarm (alerting, snoozed, paused) is silenced just
   * to make a fallback possible.
   */
  cancelScheduledAlarms(
    accountId: string,
    alarmKeys: string[]
  ): Promise<AlarmCancellationReport>;
  cancelAll(): Promise<void>;
  syncOverdueActivities(
    accountId: string,
    activities: OverdueTaskSurface[],
    privacyHidden: boolean
  ): Promise<OverdueActivityResult>;
  endOverdueActivities(): Promise<OverdueActivityResult>;
};

const Native: TaskAlarmNative | undefined =
  Platform.OS === "ios" ? NativeModules.TaskAlarmModule : undefined;

export async function urgentStatus(): Promise<UrgentAlarmStatus> {
  if (!Native) return "unsupported";
  return Native.status();
}

/** Call from the Urgent switch, never as part of background reconciliation. */
export async function requestUrgentPermission(): Promise<UrgentAlarmStatus> {
  if (!Native) return "unsupported";
  return Native.requestAuthorization();
}

/**
 * The per-occurrence outcome of one alarm reconcile, plus whether it can be
 * trusted. `verified` is true when every desired occurrence is either in
 * `scheduledAlarmKeys` (AlarmKit will deliver it) or known not to be scheduled
 * (its notification fallback is the sole delivery). When false, the native state
 * could not be determined this pass and the caller must not duplicate audio.
 */
export type TaskAlarmDelivery = {
  status: UrgentAlarmStatus;
  scheduledAlarmKeys: Set<string>;
  verified: boolean;
  /** Non-fatal cause of an unverified/failed pass, for honest logging. */
  error?: unknown;
};

function currentAccountId() {
  return useUserStore.getState().user?.id || "local";
}

/**
 * Reconciles the Urgent occurrences with stable per-occurrence identities and
 * reports which of them the system actually holds, resolving an unknown native
 * state honestly instead of guessing Task-wide:
 *
 * 1. `replaceAlarms` answers for every occurrence;
 * 2. if it fails, `verifyAlarms` reports what the system still holds;
 * 3. if that also fails, only the alarms that have not started alerting are
 *    cancelled (verified cancellation) before any audible fallback; and
 * 4. if even that fails, the pass stays unverified: the caller schedules no new
 *    fallback and cancels no existing one.
 */
export async function reconcileTaskAlarmDelivery(
  tasks: Task[],
  privacyHidden: boolean
): Promise<TaskAlarmDelivery> {
  const desired = desiredTaskAlarms(tasks, privacyHidden);
  if (!Native)
    return {
      status: "unsupported",
      scheduledAlarmKeys: new Set(),
      verified: true
    };
  const accountId = currentAccountId();
  const alarmKeys = desired.map((alarm) => alarm.alarmKey);
  const verified = (
    report: AlarmReconcileReport,
    error?: unknown
  ): TaskAlarmDelivery => ({
    status: report.status,
    // A non-authorized status means this app scheduled nothing, so the empty set
    // is the truth and every occurrence legitimately needs its fallback.
    scheduledAlarmKeys:
      report.status === "authorized"
        ? new Set(report.scheduledAlarmKeys || [])
        : new Set(),
    verified: true,
    error
  });
  let replaceError: unknown;
  try {
    return verified(await Native.replaceAlarms(accountId, desired));
  } catch (error) {
    replaceError = error;
  }
  try {
    return verified(await Native.verifyAlarms(accountId, alarmKeys), replaceError);
  } catch {
    /* fall through to a verified cancellation */
  }
  try {
    const cancelled = await Native.cancelScheduledAlarms(accountId, alarmKeys);
    // Every future occurrence is now known not to be alarm-scheduled; alarms
    // already alerting/snoozed/paused are left untouched and belong to
    // occurrences the planner never turns into a notification.
    return {
      status: cancelled.status,
      scheduledAlarmKeys: new Set(),
      verified: true,
      error: replaceError
    };
  } catch (cancelError) {
    return {
      status: "unsupported",
      scheduledAlarmKeys: new Set(),
      verified: false,
      error: cancelError ?? replaceError
    };
  }
}

export async function cancelAllTaskAlarms() {
  await Native?.cancelAll();
}

export type CleanupAttempt = {
  /** Names the mechanism in the honest failure report. */
  label: string;
  run: () => Promise<unknown>;
};

/**
 * Runs every cleanup attempt even when an earlier one rejects. A single failing
 * mechanism (e.g. notification cancellation throwing) must never skip the native
 * alarm and Live Activity cleanup, which would leave the previous account's
 * content on the Lock Screen. Returns the labels that failed, so the caller can
 * keep pending failures honest instead of reporting a clean sweep.
 */
export async function runIndependentCleanup(
  attempts: CleanupAttempt[]
): Promise<string[]> {
  const outcomes = await Promise.allSettled(
    attempts.map((attempt) => attempt.run())
  );
  return outcomes
    .map((outcome, index) =>
      outcome.status === "rejected" ? attempts[index].label : ""
    )
    .filter((label) => label.length > 0);
}

/**
 * Reconciles the ongoing "Urgent Task is overdue and still incomplete" Live
 * Activities with exactly the Tasks that qualify right now. The native side is
 * authoritative: it creates missing surfaces, refreshes the dynamic content of
 * existing ones, ends surfaces that no longer apply (or that belong to another
 * account), and reports the Tasks it could not show instead of pretending they
 * are visible. It also never re-creates a surface the person dismissed or that
 * the system expired.
 *
 * An empty `surfaces` list is meaningful: it ends every surface this app owns
 * (Urgent switched off, reminder removed, task completed/deleted/rescheduled).
 */
export async function syncOverdueActivities(
  surfaces: OverdueTaskSurface[],
  privacyHidden = false
): Promise<OverdueActivityResult> {
  if (!Native)
    return {
      status: "unsupported",
      failedTaskIds: surfaces.map((surface) => surface.taskId)
    };
  const accountId = currentAccountId();
  return Native.syncOverdueActivities(accountId, surfaces, privacyHidden);
}

/**
 * Ends every overdue Live Activity this app owns. Call wherever the Task domain
 * changes underneath a surface: completion, deletion, a removed reminder, a
 * reschedule, Urgent being switched off, logout or an account change.
 */
export async function endOverdueActivities(): Promise<OverdueActivityResult> {
  if (!Native) return { status: "unsupported" };
  return Native.endOverdueActivities();
}
