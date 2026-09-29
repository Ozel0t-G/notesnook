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

import { DatabaseUpdatedEvent, EVENTS } from "@notesnook/core";
import notifee, {
  AuthorizationStatus,
  TimestampTrigger,
  TriggerType
} from "@notifee/react-native";
import { strings } from "@notesnook/intl";
import { AppState, Platform } from "react-native";
import { db, DatabaseLogger } from "../common/database";
import { useSettingStore } from "../stores/use-setting-store";
import { useUserStore } from "../stores/use-user-store";
import {
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
  syncOverdueActivities
} from "./task-alarms";
import { overdueTaskSurfaces, taskAlertTitle } from "./task-alarm-plan";

// Keep four slots free under iOS's 64 pending local notification limit.
const MAX_TOTAL_PENDING = Platform.OS === "ios" ? 60 : 500;
let timer: ReturnType<typeof setTimeout> | undefined;
let reconciliation = Promise.resolve();
let started = false;
let lastPress: { id: string; at: number } | undefined;
let stopSubscriptions: (() => void) | undefined;
let lastTruncation = "";
/**
 * Bumped as soon as the signed-in account changes (or a logout starts). An
 * in-flight reconcile pass captures it and refuses to write anything once it
 * differs, so an old-account pass that resolves late can never re-create alarms,
 * notifications or Live Activities for the account that was just signed out.
 */
let accountGeneration = 0;

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
  if (!db.isInitialized || useUserStore.getState().isLoggingOut) return;
  // Captured with the account id: if the signed-in account changes while this
  // pass is awaiting, the pass must not write old-account alarms,
  // notifications or surfaces after the cleanup has already run.
  const generation = accountGeneration;
  const now = Date.now();
  const all = await db.tasks.list();
  if (generation !== accountGeneration) return;
  const existing = await notifee.getTriggerNotifications();
  if (generation !== accountGeneration) return;
  const privacyHidden = Boolean(
    useSettingStore.getState().settings.appLockEnabled
  );
  // The account that owns this reconcile pass. It travels with every Task
  // notification so a tap can be refused if a different account is signed in
  // before any Task data is read.
  const accountId = useUserStore.getState().user?.id || "";
  // AlarmKit is the sole audible delivery path for a successfully-scheduled
  // Urgent alarm; a labeled notification is only a fallback for the Urgent
  // *occurrences* whose native alarm is not scheduled (unsupported, denied, or
  // an individual scheduling/verification failure). The answer is per
  // occurrence, so a partially successful recurring series never duplicates
  // audio for the occurrences that did schedule.
  let urgentFallback: UrgentAlarmFallback = { needsFallback: () => true };
  try {
    const delivery = await reconcileTaskAlarmDelivery(all, privacyHidden);
    if (generation !== accountGeneration) return;
    if (delivery.verified) {
      const scheduled = delivery.scheduledAlarmKeys;
      urgentFallback = {
        needsFallback: (alarmKey) => !scheduled.has(alarmKey)
      };
      if (delivery.error)
        DatabaseLogger.warn(
          "Task alarm reconcile was recovered by verification",
          { recovered: true }
        );
    } else {
      // The native state could not be determined: never duplicate a
      // possibly-sounding alarm, and never cancel a working fallback into
      // silence. Existing fallback triggers are kept exactly as they are.
      urgentFallback = { needsFallback: () => false, preserveExisting: true };
      DatabaseLogger.error(
        delivery.error as Error,
        "Schedule Task alarms (unverified; no new fallbacks)"
      );
    }
  } catch (error) {
    urgentFallback = { needsFallback: () => false, preserveExisting: true };
    DatabaseLogger.error(error as Error, "Schedule Task alarms");
  }
  // The ongoing overdue Urgent surface (Lock Screen / Dynamic Island),
  // reconciled on the same cadence as alarms and notifications so Urgent being
  // switched off, a completion, deletion, removed reminder or reschedule takes
  // it away without leaving a ghost. An empty desired set ends every surface.
  // It is silent, so it never duplicates an audible alert.
  try {
    await syncOverdueActivities(overdueTaskSurfaces(all), privacyHidden);
  } catch (error) {
    DatabaseLogger.error(error as Error, "Reconcile overdue Task surfaces");
  }
  if (generation !== accountGeneration) return;
  // A Task notification that is already *displayed* in Notification Center /
  // the Lock Screen was produced with the real title. Enabling App Lock must not
  // leave that unredacted copy behind, so any delivered Task notification whose
  // payload was not created redacted is withdrawn (silently; nothing new is
  // shown). Pending triggers are handled by the planner below.
  if (privacyHidden) await withdrawUnredactedTaskNotifications();
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
          taskId: task.id,
          updatedAt: String(task.updatedAt),
          privacyHidden: privacyHidden ? "1" : "0",
          urgentFallback: task.urgentFallback ? "1" : "0",
          // Non-empty only when an account is signed in; the tap router treats
          // an empty value as an accountless payload.
          accountId,
          occurrenceKey: task.occurrenceKey || ""
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
      .then(() => cancelAccountTaskSurfaces("account change"))
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
        .then(() => cancelAccountTaskSurfaces("logout"))
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
 * (payload `privacyHidden !== "1"`) once App Lock is on. Never throws: a failure
 * is logged and the planner still re-redacts every pending trigger.
 */
async function withdrawUnredactedTaskNotifications() {
  try {
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
  } catch (error) {
    DatabaseLogger.error(error as Error, "Redact displayed Task notifications");
  }
}

async function cancelAllTaskTriggers() {
  const existing = await notifee.getTriggerNotifications();
  for (const entry of existing) {
    const id = entry.notification.id;
    if (id?.startsWith("task:")) await notifee.cancelTriggerNotification(id);
  }
}

/**
 * Removes every Task surface that belongs to the account being left: scheduled
 * Task notifications, native Urgent alarms and overdue Live Activities. Each is
 * attempted independently and the failures are reported together, so a single
 * failing mechanism cannot silently retain the previous account's Lock Screen
 * content. Never rejects, so callers can chain a re-plan after it.
 */
async function cancelAccountTaskSurfaces(context: string): Promise<string[]> {
  const failures = await runIndependentCleanup([
    { label: "task notifications", run: cancelAllTaskTriggers },
    { label: "native alarms", run: cancelAllTaskAlarms },
    { label: "overdue activities", run: endOverdueActivities }
  ]);
  lastTruncation = "";
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
