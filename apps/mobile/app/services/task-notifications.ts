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
  taskNotificationId
} from "./task-notification-plan";
import { cancelAllTaskAlarms } from "./task-alarms";
import { taskAlertTitle } from "./task-alarm-plan";

// Keep four slots free under iOS's 64 pending local notification limit.
const MAX_TOTAL_PENDING = Platform.OS === "ios" ? 60 : 500;
let timer: ReturnType<typeof setTimeout> | undefined;
let reconciliation = Promise.resolve();
let started = false;
let lastPress: { id: string; at: number } | undefined;
let stopSubscriptions: (() => void) | undefined;
let lastTruncation = "";

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
  const now = Date.now();
  const all = await db.tasks.list();
  const existing = await notifee.getTriggerNotifications();
  const privacyHidden = Boolean(
    useSettingStore.getState().settings.appLockEnabled
  );
  // AlarmKit overrides Silent Mode. Remove alarms from older builds before
  // scheduling system notifications so there is only one audible delivery path.
  let oldAlarmsCleared = true;
  try {
    await cancelAllTaskAlarms();
  } catch (error) {
    oldAlarmsCleared = false;
    DatabaseLogger.error(error as Error, "Cancel legacy Task alarms");
  }
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
    oldAlarmsCleared
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
        body: task.urgent ? strings.tasksUrgent() : undefined,
        data: {
          type: "task",
          taskId: task.id,
          updatedAt: String(task.updatedAt),
          privacyHidden: privacyHidden ? "1" : "0",
          urgentFallback: task.urgentFallback ? "1" : "0"
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
    clearTimeout(timer);
    reconciliation = reconciliation
      .then(async () => {
        await cancelAllTaskTriggers();
        await cancelAllTaskAlarms();
        lastTruncation = "";
      })
      .catch((error) =>
        DatabaseLogger.error(
          error as Error,
          "Cancel Task alerts after account change"
        )
      );
  });
  const logoutSubscription = db.eventManager.subscribe(
    EVENTS.userLoggedOut,
    () => {
      clearTimeout(timer);
      reconciliation = reconciliation
        .then(async () => {
          await cancelAllTaskTriggers();
          await cancelAllTaskAlarms();
          lastTruncation = "";
        })
        .catch((error) =>
          DatabaseLogger.error(
            error as Error,
            "Cancel Task alerts after logout"
          )
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

async function cancelAllTaskTriggers() {
  const existing = await notifee.getTriggerNotifications();
  for (const entry of existing) {
    const id = entry.notification.id;
    if (id?.startsWith("task:")) await notifee.cancelTriggerNotification(id);
  }
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
  notificationId: taskNotificationId,
  urgentStatus: async () => {
    const status = (await notifee.getNotificationSettings())
      .authorizationStatus;
    if (status === AuthorizationStatus.NOT_DETERMINED)
      return "notDetermined" as const;
    return (await taskNotificationPermission())
      ? ("authorized" as const)
      : ("denied" as const);
  },
  requestUrgentPermission: async () =>
    (await requestPermission()) ? ("authorized" as const) : ("denied" as const)
};
