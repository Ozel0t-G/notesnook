import type { Task } from "@notesnook/core";
import { NativeModules, Platform } from "react-native";
import { useUserStore } from "../stores/use-user-store";
import {
  desiredTaskAlarms,
  type OverdueTaskSurface
} from "./task-alarm-plan";

export type UrgentAlarmStatus =
  | "unsupported"
  | "notDetermined"
  | "denied"
  | "authorized";

type ReplaceResult = {
  status: UrgentAlarmStatus;
  failedTaskIds: string[];
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
    alarms: ReturnType<typeof desiredTaskAlarms>
  ): Promise<ReplaceResult>;
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

export async function reconcileTaskAlarms(
  tasks: Task[],
  privacyHidden: boolean
): Promise<ReplaceResult> {
  const desired = desiredTaskAlarms(tasks, privacyHidden);
  if (!Native)
    return {
      status: "unsupported",
      failedTaskIds: desired.map((alarm) => alarm.taskId)
    };
  const accountId = useUserStore.getState().user?.id || "local";
  return Native.replaceAlarms(accountId, desired);
}

export async function cancelAllTaskAlarms() {
  await Native?.cancelAll();
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
  const accountId = useUserStore.getState().user?.id || "local";
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
