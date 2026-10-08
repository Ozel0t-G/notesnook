import type { Task } from "@notesnook/core";
import { NativeModules, Platform } from "react-native";
import { MMKV } from "../common/database/mmkv";
import { taskWidgetAccountScope } from "../hooks/task-widget-completion-intents";
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
 * `activeAlarmKeys` is the subset whose alarm is presenting right now
 * (alerting, counting down after Snooze, or paused), which must never also own
 * a second Lock Screen surface and must never be stopped to free a fallback.
 */
type AlarmReconcileReport = {
  status: UrgentAlarmStatus;
  scheduledAlarmKeys?: string[];
  activeAlarmKeys?: string[];
  /**
   * Occurrences whose Live alarm presentation still shows the real Task title
   * although App Lock is on. The occurrence is still *held*, so it never also
   * owns a duplicate fallback; but a pass that reports any of these is **not** a
   * clean redaction and must say so.
   */
  unredactedAlarmKeys?: string[];
};

type AlarmCancellationReport = {
  status: UrgentAlarmStatus;
  /** Occurrences whose not-yet-alerting alarm was cancelled just now. */
  cancelledAlarmKeys?: string[];
  /**
   * Occurrences still held because their alarm is alerting, snoozed or paused.
   * They are reported instead of being cancelled: a presentation the person is
   * engaged with is never torn down to make room for a fallback.
   */
  retainedAlarmKeys?: string[];
  /**
   * Occurrences the system does not hold at all (already ended or dismissed), so
   * they are *provably* not scheduled and a fallback for them cannot duplicate
   * anything. Distinct from "answered about neither set", which stays unknown.
   */
  notFoundAlarmKeys?: string[];
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
    accountScope: string,
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
   * to make a fallback possible. Reports both the keys it cancelled and the
   * keys it deliberately kept, so the caller never has to guess which
   * occurrences are still held.
   */
  cancelScheduledAlarms(
    accountId: string,
    alarmKeys: string[]
  ): Promise<AlarmCancellationReport>;
  cancelAll(): Promise<void>;
  syncOverdueActivities(
    accountId: string,
    activities: OverdueTaskSurface[],
    privacyHidden: boolean,
    accountScope: string
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
 * The per-occurrence outcome of one alarm reconcile.
 *
 * `heldAlarmKeys` are the occurrences AlarmKit holds (it will deliver them, so
 * they must not also own a notification fallback); `activeAlarmKeys` is the
 * subset presenting right now. `absentAlarmKeys` are the occurrences *proven*
 * not to be held, so a fallback for them is the only audible delivery and
 * cannot duplicate any alarm. Everything else is `unknown`: the caller keeps
 * whatever fallback already exists and creates no new one.
 * `verified` is true when held ∪ absent covers every desired occurrence.
 */
export type TaskAlarmDelivery = {
  status: UrgentAlarmStatus;
  heldAlarmKeys: Set<string>;
  activeAlarmKeys: Set<string>;
  absentAlarmKeys: Set<string>;
  /**
   * Whether `activeAlarmKeys` is an *answer* rather than a default. A failed
   * native read leaves it empty without saying "nothing is presenting", and an
   * empty set that means "unknown" must never be used to create a Live
   * Activity that could compete with an alarm the app cannot see.
   */
  activeAlarmKeysKnown: boolean;
  verified: boolean;
  /**
   * Occurrences whose Live alarm presentation still shows the real Task title
   * while App Lock is on, because AlarmKit exposes no in-place presentation
   * update for an alarm that has already started or is due now (the app never
   * tears a live alarm down and never re-schedules it on a past instant), or
   * because removing a not-yet-presenting unredacted alarm failed. Each of these
   * occurrences is *also* in `heldAlarmKeys`, so it never gains a duplicate
   * fallback; the set exists so privacy is never reported as succeeded while a
   * real title is still on screen.
   */
  unredactedAlarmKeys: Set<string>;
  /** Non-fatal cause of an unverified/failed pass, for honest logging. */
  error?: unknown;
};

/**
 * Withdraws the pending notification fallbacks competing with the occurrences
 * that are about to gain a native alarm, and *verifies* the withdrawal before
 * that alarm is introduced.
 *
 * This is the exclusivity gate for one occurrence: an alarm may only be
 * installed once nothing else is already scheduled to alert for it. If the
 * withdrawal cannot be confirmed, the occurrence is reported back unwithdrawn,
 * no alarm is installed for it, and the existing notification stays the single
 * delivery instead of the two firing together.
 */
export type AlarmFallbackWithdrawal = {
  /** @returns the keys whose withdrawal could NOT be verified. */
  withdraw: (alarmKeys: string[]) => Promise<ReadonlySet<string>>;
};

function currentAccountId() {
  return useUserStore.getState().user?.id || "local";
}

/**
 * The same opaque account-scope token the widget snapshot and the overdue Live
 * Activity are keyed by (`taskWidgetAccountScope`). It is passed to the native
 * alarm scheduler so a future Stop tap can address the identical identity, and
 * the native side refuses anything that is not the exact token shape. A storage
 * failure yields an empty token, which the native side replaces with its
 * derived digest rather than trusting.
 */
function currentAccountScope() {
  try {
    return taskWidgetAccountScope(
      MMKV,
      useUserStore.getState().user?.id || null
    );
  } catch {
    return "";
  }
}

/**
 * Reconciles the Urgent occurrences with stable per-occurrence identities and
 * reports, per occurrence, whether AlarmKit holds it, is presenting it right
 * now, or provably does not hold it.
 *
 * The order is what keeps one occurrence to one audible delivery:
 *
 * 1. **Read first** (`verifyAlarms`). Nothing is written and no fallback is
 *    withdrawn while the current native state is unknown, so an ambiguous read
 *    fails closed: no new alarm, no cancelled fallback.
 * 2. **Withdraw before introducing.** Every occurrence this pass would newly
 *    alarm must have its competing notification fallback withdrawn *and the
 *    withdrawal verified* first. An occurrence whose fallback is still pending
 *    is not alarmed this pass: its notification stays the single delivery.
 * 3. **Write** (`replaceAlarms`) for the occurrences that are already held
 *    (unchanged ones are left alone, changed ones are refreshed) plus the ones
 *    whose fallback was verifiably withdrawn.
 * 4. **Resolve honestly** if the write failed. `verifyAlarms` first; then a
 *    verified cancellation of only the not-yet-alerting alarms; and if even that
 *    fails, the occurrences whose state is still unknown are the only ones left
 *    out of both sets, so the caller keeps their existing fallback untouched
 *    rather than adding a second, possibly-duplicate alert.
 *
 * A revoked/denied/unsupported authorization is not treated as an empty,
 * verified answer: alarms scheduled while the app was authorized can still be
 * held and sound, so they are queried, the not-yet-alerting ones this app owns
 * are cancelled, and the still-presenting ones are reported as held so no
 * fallback duplicates them.
 */
export async function reconcileTaskAlarmDelivery(
  tasks: Task[],
  privacyHidden: boolean,
  fallback?: AlarmFallbackWithdrawal
): Promise<TaskAlarmDelivery> {
  const desired = desiredTaskAlarms(tasks, privacyHidden, Date.now());
  const alarmKeys = desired.map((alarm) => alarm.alarmKey);
  // Every occurrence the caller asked about is provably not alarmed when there
  // is no native alarm path at all (a non-Apple build).
  if (!Native)
    return {
      status: "unsupported",
      heldAlarmKeys: new Set(),
      activeAlarmKeys: new Set(),
      absentAlarmKeys: new Set(alarmKeys),
      activeAlarmKeysKnown: true,
      unredactedAlarmKeys: new Set(),
      verified: true
    };
  const accountId = currentAccountId();
  const accountScope = currentAccountScope();
  const asKeys = (values: string[] | undefined) =>
    new Set(alarmKeys.filter((key) => (values || []).includes(key)));
  /**
   * The truthful per-occurrence answer for a set the system confirms it holds:
   * anything else in `alarmKeys` is provably absent, because the answer covers
   * every key the caller asked about.
   */
  const answer = (
    status: UrgentAlarmStatus,
    held: Set<string>,
    active: Set<string>,
    unredacted: Set<string>,
    error?: unknown
  ): TaskAlarmDelivery => ({
    status,
    heldAlarmKeys: held,
    activeAlarmKeys: active,
    absentAlarmKeys: new Set(alarmKeys.filter((key) => !held.has(key))),
    activeAlarmKeysKnown: true,
    unredactedAlarmKeys: unredacted,
    verified: true,
    error
  });

  // 1. Read first: the current per-occurrence truth.
  let held: Set<string>;
  let active: Set<string>;
  let status: UrgentAlarmStatus;
  try {
    const report = await Native.verifyAlarms(accountId, alarmKeys);
    status = report.status;
    held = asKeys(report.scheduledAlarmKeys);
    active = asKeys(report.activeAlarmKeys);
  } catch (readError) {
    // The native state is unknown. Introducing an alarm now could duplicate one
    // that is already held, so this pass writes nothing and withdraws nothing.
    return {
      status: "unsupported",
      heldAlarmKeys: new Set(),
      activeAlarmKeys: new Set(),
      absentAlarmKeys: new Set(),
      // A failed read says nothing about which occurrences are presenting, so
      // the empty active set must not be read as "nothing is up". Callers use
      // this to refuse to create a Live Activity that could conflict with an
      // alarm they cannot see.
      activeAlarmKeysKnown: false,
      // Nothing is known about redaction from a failed *read* either; it is not
      // a claim that the titles are hidden, only that this pass learned nothing.
      unredactedAlarmKeys: new Set(),
      verified: false,
      error: readError
    };
  }

  // 2. Authorization was revoked (or was never granted). Alarms this app
  // scheduled while it was authorized can still be held and still sound, so they
  // are cleaned up -- except a presentation the person is engaged with -- and
  // reported truthfully instead of being assumed gone.
  if (status !== "authorized") return cleanupRevokedDelivery(accountId, alarmKeys, held, active, status);

  // 3. Withdraw the competing fallback before introducing an alarm.
  const missing = alarmKeys.filter((key) => !held.has(key));
  let unwithdrawn = new Set<string>();
  if (fallback && missing.length) {
    try {
      unwithdrawn = new Set(
        [...(await fallback.withdraw(missing))].filter((key) =>
          missing.includes(key)
        )
      );
    } catch {
      // The withdrawal could not be confirmed, so no occurrence is introduced.
      unwithdrawn = new Set(missing);
    }
  } else if (!fallback) {
    // This caller owns no notification fallback, so there is nothing to
    // withdraw and nothing that could compete with a new alarm.
    unwithdrawn = new Set();
  }
  const toSend = desired.filter(
    (alarm) => !unwithdrawn.has(alarm.alarmKey)
  );

  // 4. Write, then resolve a failed write by verification instead of guessing.
  let replaceError: unknown;
  try {
    const report = await Native.replaceAlarms(accountId, accountScope, toSend);
    // Authorization can be revoked between the read and the write. Nothing new
    // was scheduled then, and what the read found is cleaned up the same way.
    if (report.status !== "authorized")
      return cleanupRevokedDelivery(
        accountId,
        alarmKeys,
        asKeys(report.scheduledAlarmKeys),
        asKeys(report.activeAlarmKeys),
        report.status
      );
    return answer(
      report.status,
      asKeys(report.scheduledAlarmKeys),
      asKeys(report.activeAlarmKeys),
      asKeys(report.unredactedAlarmKeys)
    );
  } catch (error) {
    replaceError = error;
  }
  try {
    const report = await Native.verifyAlarms(accountId, alarmKeys);
    return answer(
      report.status,
      asKeys(report.scheduledAlarmKeys),
      asKeys(report.activeAlarmKeys),
      asKeys(report.unredactedAlarmKeys),
      replaceError
    );
  } catch {
    /* fall through to a verified cancellation */
  }
  try {
    const cancelled = await Native.cancelScheduledAlarms(accountId, alarmKeys);
    const cancelledKeys = new Set(cancelled.cancelledAlarmKeys || []);
    const notFoundKeys = new Set(cancelled.notFoundAlarmKeys || []);
    const retained = asKeys(cancelled.retainedAlarmKeys);
    // Cancelled *and* already-gone occurrences are provably not scheduled now, so
    // their fallback is safe; a retained alarm is still going to sound, so it
    // gets none. Anything replied about neither is unknown and stays out of both
    // sets. A pure cancellation never reports redaction either way.
    return {
      status: cancelled.status,
      heldAlarmKeys: retained,
      activeAlarmKeys: retained,
      activeAlarmKeysKnown: true,
      unredactedAlarmKeys: new Set<string>(),
      absentAlarmKeys: new Set(
        alarmKeys.filter(
          (key) => cancelledKeys.has(key) || notFoundKeys.has(key)
        )
      ),
      verified: true,
      error: replaceError
    };
  } catch (cancelError) {
    return {
      status: "unsupported",
      heldAlarmKeys: new Set(),
      activeAlarmKeys: new Set(),
      absentAlarmKeys: new Set(),
      activeAlarmKeysKnown: false,
      unredactedAlarmKeys: new Set(),
      verified: false,
      error: cancelError ?? replaceError
    };
  }
}

/**
 * The truthful answer for a reconcile in which the app is not authorized to
 * schedule alarms (denied, notDetermined, unsupported, or authorization revoked
 * mid-pass). Alarms that were scheduled while the app *was* authorized can still
 * be held by the system and still sound, so they are cleaned up here -- never a
 * presentation the person is engaged with -- and the ones that remain are
 * reported as held so no notification duplicates them.
 */
async function cleanupRevokedDelivery(
  accountId: string,
  alarmKeys: string[],
  held: Set<string>,
  active: Set<string>,
  status: UrgentAlarmStatus
): Promise<TaskAlarmDelivery> {
  const absent = new Set(alarmKeys.filter((key) => !held.has(key)));
  if (!held.size || !Native)
    return {
      status,
      heldAlarmKeys: new Set(),
      activeAlarmKeys: new Set(),
      absentAlarmKeys: absent,
      activeAlarmKeysKnown: true,
      unredactedAlarmKeys: new Set(),
      verified: true
    };
  try {
    const report = await Native.cancelScheduledAlarms(accountId, [...held]);
    const cancelled = new Set(report.cancelledAlarmKeys || []);
    const notFound = new Set(report.notFoundAlarmKeys || []);
    const retained = new Set(
      alarmKeys.filter((key) => (report.retainedAlarmKeys || []).includes(key))
    );
    return {
      status,
      heldAlarmKeys: retained,
      // A revocation cleanup answers which occurrences are still presenting
      // (`active` from the read) but the cancellation's `retained` set is the
      // authoritative set that keeps sounding, so it is what the surface
      // reconciliation must respect. Both are known.
      activeAlarmKeys: retained,
      activeAlarmKeysKnown: true,
      unredactedAlarmKeys: new Set(),
      absentAlarmKeys: new Set(
        alarmKeys.filter(
          (key) => absent.has(key) || cancelled.has(key) || notFound.has(key)
        )
      ),
      verified: true
    };
  } catch (cancelError) {
    // The owned alarms could not be cleaned up, so they are assumed to still be
    // held and are denied any fallback. Every occurrence is still answered for
    // (held or absent), so the answer covers the caller's whole set; the failed
    // cleanup travels with it as `error`.
    return {
      status,
      heldAlarmKeys: held,
      activeAlarmKeys: active,
      activeAlarmKeysKnown: true,
      absentAlarmKeys: absent,
      unredactedAlarmKeys: new Set(),
      verified: true,
      error: cancelError
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
  privacyHidden = false,
  accountScope = ""
): Promise<OverdueActivityResult> {
  if (!Native)
    return {
      status: "unsupported",
      failedTaskIds: surfaces.map((surface) => surface.taskId)
    };
  const accountId = currentAccountId();
  // `accountScope` is the same opaque token the home-screen widget snapshot
  // uses (`taskWidgetAccountScope`), so a Live Activity and a widget action for
  // one account share one identity instead of two unrelated digests. When the
  // caller does not supply one it is read here from the same store, so every
  // path passes the identical token.
  return Native.syncOverdueActivities(
    accountId,
    surfaces,
    privacyHidden,
    accountScope || currentAccountScope()
  );
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
