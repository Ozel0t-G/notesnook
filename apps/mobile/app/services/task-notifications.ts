/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { DatabaseUpdatedEvent, EVENTS, type Task } from "@notesnook/core";
import notifee, {
  AuthorizationStatus,
  TimestampTrigger,
  TriggerType
} from "@notifee/react-native";
import { strings } from "@notesnook/intl";
import { AppState, Platform } from "react-native";
import { db, DatabaseLogger } from "../common/database";
import { MMKV } from "../common/database/mmkv";
import { ToastManager } from "./event-manager";
import { useSettingStore } from "../stores/use-setting-store";
import { useUserStore } from "../stores/use-user-store";
import {
  ALWAYS_FALLBACK,
  availableTaskNotificationSlots,
  planTaskNotifications,
  taskNotificationId,
  type UrgentAlarmFallback
} from "./task-notification-plan";
import {
  cancelAllTaskAlarms,
  endOverdueActivities,
  reconcileTaskAlarmDelivery,
  runIndependentCleanup,
  syncOverdueActivities,
  type AlarmFallbackWithdrawal,
  type CleanupAttempt
} from "./task-alarms";
import {
  MAX_OVERDUE_SURFACES,
  overdueTaskSurfaces,
  taskAlarmKey,
  taskAlertTitle
} from "./task-alarm-plan";
import SettingsService from "./settings";

// Keep four slots free under iOS's 64 pending local notification limit.
const MAX_TOTAL_PENDING = Platform.OS === "ios" ? 60 : 500;
let timer: ReturnType<typeof setTimeout> | undefined;
let reconciliation = Promise.resolve();
let started = false;
let lastPress: { id: string; at: number } | undefined;
let stopSubscriptions: (() => void) | undefined;
let lastTruncation = "";
/** Records the cleanup obligations that failed, so they can be retried. */
const PENDING_CLEANUP_KEY = "notesnook.taskSurfaces.pendingCleanup.v1";
/**
 * Bumped as soon as the signed-in account changes (or a logout starts). An
 * in-flight reconcile pass captures it and refuses to write anything once it
 * differs, so an old-account pass that resolves late can never re-create alarms,
 * notifications or Live Activities for the account that was just signed out.
 */
let accountGeneration = 0;

/**
 * Whether Task content may be shown. The persisted setting is the only
 * trustworthy source for a process that has never mounted the App component
 * (a headless intent process keeps the store at its default `false`), while the
 * hydrated store covers a change made in this process before it is persisted.
 * Either one being on means "hidden": a stale `false` must never win.
 */
export function taskSurfacesPrivacyHidden() {
  return (
    !!SettingsService.get().appLockEnabled ||
    !!useSettingStore.getState().settings.appLockEnabled
  );
}

/**
 * Shown when App Lock is on but a *held* alarm still presents the real Task
 * title. AlarmKit has no public API to restyle a presentation that has already
 * started (or is about to start), and this app never tears a live alarm down to
 * redact it, so the surface keeps its title until it ends -- the person is told
 * rather than left believing the title is hidden.
 *
 * A literal, not an `@notesnook/intl` string, for the same bounded-scope reason
 * as `TASK_UNAVAILABLE_MESSAGE`; it carries no Task content.
 */
export const TASK_ALARM_UNREDACTED_MESSAGE =
  "An alarm that is already ringing still shows its Task title. It will be hidden once the alarm ends.";

/**
 * The last set of unredacted occurrences the notice was shown for, so a
 * reconcile that repeats the same failure does not re-notify on every pass.
 */
let lastUnredactedNotice = "";

export function claimTaskNotificationPress(id: string) {
  const now = Date.now();
  if (lastPress?.id === id && now - lastPress.at < 5000) return false;
  lastPress = { id, at: now };
  return true;
}

export async function taskNotificationPermission() {
  const current = await notifee.getNotificationSettings();
  return (
    current.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    current.authorizationStatus === AuthorizationStatus.PROVISIONAL
  );
}

async function requestPermission() {
  const current = await notifee.getNotificationSettings();
  if (current.authorizationStatus === AuthorizationStatus.NOT_DETERMINED) {
    const requested = await notifee.requestPermission();
    return (
      requested.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
      requested.authorizationStatus === AuthorizationStatus.PROVISIONAL
    );
  }
  return taskNotificationPermission();
}

async function reconcileNow() {
  // A cleanup obligation left behind by a failed logout, account change or
  // privacy pass is retried first, before anything new is planned. It needs no
  // domain access at all: every mechanism it runs cancels surfaces this app
  // owns, by ownership rather than by reading the account that created them.
  await retryPendingTaskCleanup();
  if (!db.isInitialized || useUserStore.getState().isLoggingOut) return;
  // Captured with the account id: if the signed-in account changes while this
  // pass is awaiting, the pass must not write old-account alarms,
  // notifications or surfaces after the cleanup has already run.
  const generation = accountGeneration;
  const now = Date.now();
  const all = await db.tasks.list();
  if (generation !== accountGeneration) return;
  const privacyHidden = taskSurfacesPrivacyHidden();
  // The account that owns this reconcile pass. It travels with every Task
  // notification so a tap can be refused if a different account is signed in
  // before any Task data is read.
  const accountId = useUserStore.getState().user?.id || "";
  // AlarmKit is the sole audible delivery path for a successfully-scheduled
  // Urgent alarm; a labeled notification is only a fallback for the Urgent
  // *occurrences* whose native alarm is provably not scheduled (unsupported,
  // denied, or an individual scheduling failure). The answer is per occurrence,
  // so a partially successful recurring series never duplicates audio for the
  // occurrences that did schedule.
  let urgentFallback: UrgentAlarmFallback = ALWAYS_FALLBACK;
  let activeAlarmKeys: ReadonlySet<string> = new Set<string>();
  try {
    const delivery = await reconcileTaskAlarmDelivery(all, privacyHidden, {
      // The exclusivity gate: a competing fallback is withdrawn -- and the
      // withdrawal verified -- before its occurrence is allowed to gain an
      // alarm, so a lost native acknowledgement can never leave both a pending
      // notification and a newly installed alarm for the same occurrence.
      withdraw: (alarmKeys) => withdrawCompetingFallbacks(alarmKeys, all)
    });
    if (generation !== accountGeneration) return;
    activeAlarmKeys = delivery.activeAlarmKeys;
    urgentFallback = {
      needsFallback: (alarmKey) => delivery.absentAlarmKeys.has(alarmKey),
      // An occurrence in neither set is not answered for by this pass: it keeps
      // whatever fallback it already has and gains no new one.
      isUnknown: (alarmKey) =>
        !delivery.heldAlarmKeys.has(alarmKey) &&
        !delivery.absentAlarmKeys.has(alarmKey)
    };
    if (delivery.error)
      DatabaseLogger.warn(
        "Task alarm reconcile was resolved by verification",
        { verified: delivery.verified }
      );
    if (!delivery.verified)
      DatabaseLogger.error(
        delivery.error as Error,
        "Schedule Task alarms (occurrences left unverified; existing fallbacks kept)"
      );
    // App Lock is on but at least one *held* alarm still shows the real Task
    // title. That is never reported as a clean redaction: the failure is logged
    // and said out loud, because the whole point of App Lock is that this does
    // not happen. The occurrence stays held (`heldAlarmKeys`), so it gains no
    // duplicate fallback -- only the honesty of the pass changes.
    if (privacyHidden && delivery.unredactedAlarmKeys.size) {
      DatabaseLogger.error(
        new Error(
          `${delivery.unredactedAlarmKeys.size} Task alarm presentation(s) still show the real title while App Lock is on`
        ),
        "Task alarm privacy"
      );
      const signature = [...delivery.unredactedAlarmKeys].sort().join("|");
      const firstReport = signature !== lastUnredactedNotice;
      lastUnredactedNotice = signature;
      if (firstReport)
        ToastManager.show({
          message: TASK_ALARM_UNREDACTED_MESSAGE,
          type: "error"
        });
    }
  } catch (error) {
    // The reconcile produced no per-occurrence answer at all: keep every
    // existing fallback and create no new one, so nothing can duplicate a
    // possibly-written alarm.
    urgentFallback = { needsFallback: () => false, preserveExisting: true };
    DatabaseLogger.error(error as Error, "Schedule Task alarms");
  }
  // The ongoing overdue Urgent surface (Lock Screen / Dynamic Island),
  // reconciled on the same cadence as alarms and notifications so Urgent being
  // switched off, a completion, deletion, removed reminder or reschedule takes
  // it away without leaving a ghost. An empty desired set ends every surface.
  // It is silent, so it never duplicates an audible alert -- and an occurrence
  // whose alarm is presenting right now already owns a surface, so it is left
  // out rather than shown twice.
  try {
    await syncOverdueActivities(
      overdueTaskSurfaces(all, now, MAX_OVERDUE_SURFACES, (alarmKey) =>
        activeAlarmKeys.has(alarmKey)
      ),
      privacyHidden
    );
  } catch (error) {
    DatabaseLogger.error(error as Error, "Reconcile overdue Task surfaces");
  }
  if (generation !== accountGeneration) return;
  // A Task notification that is already *displayed* in Notification Center /
  // the Lock Screen was produced with the real title. Enabling App Lock must not
  // leave that unredacted copy behind, so any delivered Task notification whose
  // payload was not created redacted is withdrawn (silently; nothing new is
  // shown). Pending triggers are handled by the planner below.
  if (privacyHidden) await runCleanupObligation(["displayed task notifications"]);
  if (generation !== accountGeneration) return;
  // Read the pending triggers *after* the alarm reconcile: this pass may have
  // withdrawn the fallback of an occurrence whose alarm took over, and planning
  // must never be based on a trigger that is already gone.
  const existing = await notifee.getTriggerNotifications();
  if (generation !== accountGeneration) return;
  const availableSlots = availableTaskNotificationSlots(
    existing.map((entry) => entry.notification.id || ""),
    MAX_TOTAL_PENDING
  );
  const taskTriggers = new Map(
    existing
      .filter((entry) => entry.notification.id?.startsWith("task:"))
      .map((entry) => [entry.notification.id as string, entry])
  );
  const plan = planTaskNotifications(
    all,
    [...taskTriggers.values()].map((entry) => ({
      id: entry.notification.id as string,
      updatedAt: entry.notification.data?.updatedAt as string | undefined,
      privacyHidden: entry.notification.data?.privacyHidden === "1",
      urgentFallback: entry.notification.data?.urgentFallback === "1",
      timestamp: (entry.trigger as TimestampTrigger | undefined)?.timestamp
    })),
    now,
    availableSlots,
    privacyHidden,
    urgentFallback
  );
  const eligibleCount = plan.eligibleCount;
  const truncation =
    eligibleCount > availableSlots ? `${eligibleCount}:${availableSlots}` : "";
  if (truncation && truncation !== lastTruncation)
    DatabaseLogger.warn(
      "Pending Task alerts exceed local notification capacity",
      {
        eligibleCount,
        availableSlots
      }
    );
  lastTruncation = truncation;
  for (const id of plan.cancelIds) await notifee.cancelTriggerNotification(id);

  if (!plan.schedule.length || !(await taskNotificationPermission())) return;
  if (generation !== accountGeneration) return;

  const channelId =
    Platform.OS === "android"
      ? await notifee.createChannel({
          id: "com.streetwriters.notesnook.tasks",
          name: "Tasks",
          vibration: true
        })
      : undefined;

  for (const task of plan.schedule) {
    const id = task.notificationId;
    await notifee.createTriggerNotification(
      {
        id,
        title: privacyHidden
          ? strings.tasksTitle()
          : taskAlertTitle(task.title),
        // Only an Urgent occurrence whose AlarmKit alarm is unavailable becomes
        // a notification, and it says so: the person is never left thinking a
        // standard notification is the alarm they asked for.
        body: task.urgentFallback
          ? strings.tasksUrgentFallbackBody()
          : undefined,
        data: {
          type: "task",
          // The record this notification was planned from, plus the occurrence
          // identity below: together they address the occurrence the
          // notification was produced for, not whichever record the series
          // holds when it is tapped.
          taskId: task.id,
          updatedAt: String(task.updatedAt),
          privacyHidden: privacyHidden ? "1" : "0",
          urgentFallback: task.urgentFallback ? "1" : "0",
          // Non-empty only when an account is signed in; the tap router treats
          // an empty value as an accountless payload.
          accountId,
          occurrenceKey: task.occurrenceKey || "",
          seriesId: task.seriesId || ""
        },
        android: {
          channelId: channelId || "com.streetwriters.notesnook.tasks",
          smallIcon: "ic_stat_name",
          pressAction: { id: "default", mainComponent: "notesnook" }
        },
        ios: { interruptionLevel: task.urgent ? "timeSensitive" : "active" }
      },
      {
        type: TriggerType.TIMESTAMP,
        timestamp: task.timestamp,
        alarmManager: { allowWhileIdle: true }
      }
    );
  }
}

function reconcile() {
  reconciliation = reconciliation
    .then(reconcileNow)
    .catch((error) =>
      DatabaseLogger.error(error as Error, "Task notifications")
    );
  return reconciliation;
}

function queueReconcile() {
  clearTimeout(timer);
  timer = setTimeout(() => void reconcile(), 250);
}

function start() {
  if (started) return;
  started = true;
  const databaseSubscription = db.eventManager.subscribe(
    EVENTS.databaseUpdated,
    (event: DatabaseUpdatedEvent) => {
      if (event.collection === "settings") queueReconcile();
    }
  );
  // The core Database owns post-sync Task maintenance. A settings update from
  // that maintenance schedules a second, idempotent planning pass if needed.
  const syncSubscription = db.eventManager.subscribe(
    EVENTS.syncCompleted,
    queueReconcile
  );
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state === "active") queueReconcile();
  });
  const settingsSubscription = useSettingStore.subscribe((state, previous) => {
    if (state.settings.appLockEnabled !== previous.settings.appLockEnabled)
      queueReconcile();
  });
  const userSubscription = useUserStore.subscribe((state, previous) => {
    if (state.user?.id === previous.user?.id) return;
    accountGeneration++;
    clearTimeout(timer);
    reconciliation = reconciliation
      // The signed-in account changed, so every surface that belongs to the
      // previous account has to go before anything is planned for the new
      // one. Each mechanism is attempted independently: a rejected
      // notification cancellation must never leave the old account's native
      // alarms or Live Activity behind.
      .then(async () => {
        await cancelAccountTaskSurfaces("account change");
      })
      .catch((error) =>
        DatabaseLogger.error(
          error as Error,
          "Cancel Task alerts after account change"
        )
      )
      // Whatever the outcome, re-plan for the account that is signed in now --
      // an account change must not leave the new account with no alarms at all
      // until the next unrelated database event.
      .then(() => queueReconcile());
  });
  const logoutSubscription = db.eventManager.subscribe(
    EVENTS.userLoggedOut,
    () => {
      accountGeneration++;
      clearTimeout(timer);
      reconciliation = reconciliation
        .then(async () => {
          await cancelAccountTaskSurfaces("logout");
        })
        .catch((error) =>
          DatabaseLogger.error(error as Error, "Cancel Task alerts after logout")
        );
    }
  );
  stopSubscriptions = () => {
    databaseSubscription.unsubscribe();
    syncSubscription.unsubscribe();
    appStateSubscription.remove();
    settingsSubscription();
    userSubscription();
    logoutSubscription.unsubscribe();
  };
  queueReconcile();
}

/**
 * Withdraws already-displayed Task notifications that carry an unredacted title
 * (payload `privacyHidden !== "1"`) once App Lock is on. Rejects on failure so
 * the caller can keep a pending cleanup obligation: an unredacted Task title
 * left in Notification Center is exactly what App Lock is there to prevent.
 */
async function withdrawUnredactedTaskNotifications() {
  const displayed = await notifee.getDisplayedNotifications();
  for (const entry of displayed) {
    const notification = entry.notification;
    if (
      notification.data?.type === "task" &&
      notification.data.privacyHidden !== "1" &&
      notification.id
    )
      await notifee.cancelDisplayedNotification(notification.id);
  }
}

async function cancelAllTaskTriggers() {
  const existing = await notifee.getTriggerNotifications();
  for (const entry of existing) {
    const id = entry.notification.id;
    if (id?.startsWith("task:")) await notifee.cancelTriggerNotification(id);
  }
}

/** Every device-side surface this app owns for Tasks. */
function taskSurfaceCleanup(): CleanupAttempt[] {
  return [
    { label: "task notifications", run: cancelAllTaskTriggers },
    { label: "native alarms", run: cancelAllTaskAlarms },
    { label: "overdue activities", run: endOverdueActivities },
    {
      label: "displayed task notifications",
      run: withdrawUnredactedTaskNotifications
    }
  ];
}

const ALL_CLEANUP_LABELS = taskSurfaceCleanup().map((attempt) => attempt.label);

type PendingCleanup = { labels: string[]; at: number };

function readPendingCleanup(): PendingCleanup | undefined {
  try {
    const raw = MMKV.getString(PENDING_CLEANUP_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as PendingCleanup;
    if (!Array.isArray(parsed?.labels) || !parsed.labels.length) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Persists the minimal obligation to finish a device cleanup later: the labels
 * of the mechanisms that failed and when. It holds no Task content, no account
 * id and no title -- only which of this app's own cleanup calls still has to
 * run. An empty set clears the obligation.
 */
function writePendingCleanup(labels: string[]): void {
  try {
    if (!labels.length) MMKV.setString(PENDING_CLEANUP_KEY, "");
    else
      MMKV.setString(
        PENDING_CLEANUP_KEY,
        JSON.stringify({ labels, at: Date.now() } satisfies PendingCleanup)
      );
  } catch (error) {
    DatabaseLogger.error(error as Error, "Persist pending Task cleanup");
  }
}

/**
 * Records the outcome of one cleanup pass: the mechanisms it ran are no longer
 * owed (when they succeeded) and the ones that failed are. Labels this pass did
 * not run keep whatever they already owed, so a privacy cleanup can never wipe
 * an unrelated, still-pending account cleanup.
 */
function recordCleanupOutcome(attempted: string[], failures: string[]): void {
  const owed = new Set(readPendingCleanup()?.labels || []);
  for (const label of attempted) owed.delete(label);
  for (const label of failures) owed.add(label);
  writePendingCleanup([...owed]);
}

/**
 * Runs the named cleanup mechanisms independently and persists whatever is
 * still owed. A failure is never only logged: the surfaces it left behind --
 * the previous account's alarms, Live Activities or an unredacted notification
 * -- are retried at the next launch or foreground, before anything new is
 * planned.
 */
async function runCleanupObligation(labels: string[]): Promise<string[]> {
  const attempts = taskSurfaceCleanup().filter((attempt) =>
    labels.includes(attempt.label)
  );
  const failures = await runIndependentCleanup(attempts);
  recordCleanupOutcome(
    attempts.map((attempt) => attempt.label),
    failures
  );
  if (failures.length)
    DatabaseLogger.error(
      new Error(`Task surface cleanup incomplete: ${failures.join(", ")}`),
      "Cancel Task alerts"
    );
  return failures;
}

/** Retries a cleanup obligation left by a previous pass. Never throws. */
async function retryPendingTaskCleanup(): Promise<void> {
  const pending = readPendingCleanup();
  if (!pending) return;
  await runCleanupObligation(pending.labels).catch((error) =>
    DatabaseLogger.error(error as Error, "Retry pending Task cleanup")
  );
}

/**
 * Removes every Task surface that belongs to the account being left: scheduled
 * Task notifications, native Urgent alarms and overdue Live Activities. Each is
 * attempted independently and the failures are kept as a pending obligation, so
 * a single failing mechanism cannot silently retain the previous account's Lock
 * Screen content. Never rejects, so callers can chain a re-plan after it.
 */
async function cancelAccountTaskSurfaces(context: string): Promise<string[]> {
  lastTruncation = "";
  const failures = await runCleanupObligation(ALL_CLEANUP_LABELS);
  if (failures.length)
    DatabaseLogger.error(
      new Error(
        `Task surface cleanup incomplete after ${context}: ${failures.join(
          ", "
        )}`
      ),
      "Cancel Task alerts"
    );
  return failures;
}

/**
 * The notification id that carries an occurrence's fallback, derived from the
 * same stable identity the planner uses (`task:<series or task id>:<key>`).
 */
function taskTriggerAlarmKey(
  id: string | undefined,
  tasks: Task[]
): string | undefined {
  if (!id?.startsWith("task:")) return undefined;
  const body = id.slice("task:".length);
  for (const task of tasks) {
    if (!task.recurrenceRule) {
      if (body === task.id) return taskAlarmKey(task);
      continue;
    }
    const scope = task.seriesId || task.id;
    if (body.startsWith(`${scope}:`))
      return taskAlarmKey(task, body.slice(scope.length + 1));
  }
  return undefined;
}

/** The pending fallback trigger of each named alarm occurrence, by alarm key. */
async function pendingFallbackTriggers(
  alarmKeys: ReadonlySet<string>,
  tasks: Task[]
): Promise<Map<string, string>> {
  const triggers = await notifee.getTriggerNotifications();
  const pending = new Map<string, string>();
  for (const entry of triggers) {
    const id = entry.notification.id;
    const alarmKey = taskTriggerAlarmKey(id, tasks);
    if (id && alarmKey && alarmKeys.has(alarmKey)) pending.set(alarmKey, id);
  }
  return pending;
}

/**
 * The exclusivity gate for newly alarmed occurrences: cancels the notification
 * fallback that would otherwise alert alongside the alarm and then *re-reads*
 * the pending triggers to confirm it is gone. An occurrence whose withdrawal
 * cannot be confirmed is reported back, and the caller (the delivery reconcile)
 * then installs no alarm for it, so the occurrence keeps exactly one audible
 * delivery instead of two.
 */
export async function withdrawCompetingFallbacks(
  alarmKeys: string[],
  tasks: Task[]
): Promise<ReadonlySet<string>> {
  const wanted = new Set(alarmKeys);
  const unverified = new Set<string>();
  try {
    const pending = await pendingFallbackTriggers(wanted, tasks);
    for (const id of pending.values()) await notifee.cancelTriggerNotification(id);
    const remaining = await pendingFallbackTriggers(wanted, tasks);
    for (const key of remaining.keys()) unverified.add(key);
  } catch {
    // Anything unanswered stays unprotected: no alarm may take over an
    // occurrence whose competing fallback might still be pending.
    for (const key of wanted) unverified.add(key);
  }
  return unverified;
}

function stop() {
  clearTimeout(timer);
  stopSubscriptions?.();
  stopSubscriptions = undefined;
  started = false;
}

export const TaskNotifications = {
  start,
  stop,
  reconcile,
  permissionStatus: taskNotificationPermission,
  requestPermission,
  notificationId: taskNotificationId
};
