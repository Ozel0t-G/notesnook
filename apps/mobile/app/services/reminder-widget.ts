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
import { AppState, NativeModules, Platform } from "react-native";
import {
  beginBackgroundTask,
  endBackgroundTask
  // @ts-ignore The package does not ship TypeScript declarations.
} from "react-native-begin-background-task";
import { db, DatabaseLogger } from "../common/database";
import { MMKV } from "../common/database/mmkv";
import {
  isNativeTaskCompletionAction,
  mayCommitNativeTaskCompletion,
  taskWidgetAccountScope,
  type NativeTaskCompletionAction
} from "../hooks/task-widget-completion-intents";
import { useSettingStore } from "../stores/use-setting-store";
import { useThemeStore } from "../stores/use-theme-store";
import { useUserStore } from "../stores/use-user-store";
import SettingsService from "./settings";
import {
  buildPrivateTaskWidgetSnapshot,
  buildTaskWidgetSnapshot
} from "./task-widget-snapshot";

type NativeReminderWidget = {
  writeSnapshot(snapshot: string): Promise<void>;
  clearSnapshot(): Promise<void>;
  listPendingCompletions(): Promise<unknown[]>;
  acknowledgeCompletion(filename: string): Promise<void>;
};

const Native: NativeReminderWidget | undefined =
  Platform.OS === "ios" ? NativeModules.ReminderWidgetModule : undefined;

let updateTimer: NodeJS.Timeout | undefined;
let writeQueue = Promise.resolve();
let snapshotGeneration = 0;
let drainingCompletions = false;

// The widget extension cannot open the encrypted React Native Task domain.
// Its action remains visibly pending until this host path commits and projects it.
async function drainPendingCompletions() {
  if (!Native || drainingCompletions || !db.isInitialized) return;
  if (useUserStore.getState().appLocked || useUserStore.getState().isLoggingOut)
    return;
  drainingCompletions = true;
  try {
    const accountId = (await db.user.getUser())?.id || null;
    const scope = taskWidgetAccountScope(MMKV, accountId);
    const actions = await Native.listPendingCompletions();
    for (const raw of actions) {
      const filename = (raw as NativeTaskCompletionAction | null)?.filename;
      if (!isNativeTaskCompletionAction(raw)) {
        if (
          typeof filename === "string" &&
          /^[0-9a-f]{64}\.json$/.test(filename)
        )
          await Native.acknowledgeCompletion(filename);
        continue;
      }
      if (
        raw.scope !== scope ||
        raw.enqueuedAt > Date.now() + 5 * 60 * 1000 ||
        Date.now() - raw.enqueuedAt > 24 * 60 * 60 * 1000
      ) {
        await Native.acknowledgeCompletion(raw.filename);
        continue;
      }
      const task = await db.tasks.get(raw.id);
      if (
        useUserStore.getState().appLocked ||
        useUserStore.getState().isLoggingOut ||
        ((await db.user.getUser())?.id || null) !== accountId
      )
        break;
      if (task?.completed) {
        await flushUpdateForCompletion();
        await Native.acknowledgeCompletion(raw.filename);
        continue;
      }
      if (!mayCommitNativeTaskCompletion(raw, scope, task)) {
        await Native.acknowledgeCompletion(raw.filename);
        continue;
      }
      // This is the same encrypted-domain operation as in the Tasks screen.
      // A retry after a crash is idempotent and creates the next occurrence.
      await db.tasks.complete(raw.id);
      await flushUpdateForCompletion();
      await Native.acknowledgeCompletion(raw.filename);
    }
  } catch (error) {
    // Keep the durable action for a later foreground/unlock retry.
    DatabaseLogger.error(error as Error, "ReminderWidget.complete");
  } finally {
    drainingCompletions = false;
  }
}

function mayExposeTaskTitles() {
  return (
    !useSettingStore.getState().settings.appLockEnabled &&
    !useUserStore.getState().appLocked
  );
}

function clearSnapshot() {
  snapshotGeneration++;
  clearTimeout(updateTimer);
  updateTimer = undefined;
  if (!Native) return Promise.resolve();
  writeQueue = writeQueue
    .then(() => Native.clearSnapshot())
    .catch((error) =>
      DatabaseLogger.error(error as Error, "ReminderWidget.clear")
    );
  if (AppState.currentState !== "active")
    void protectBackgroundWrite(writeQueue, beginBackgroundTask());
  return writeQueue;
}

async function writeCurrentSnapshot() {
  if (!Native || !db.isInitialized) return;
  const generation = snapshotGeneration;
  const themeState = useThemeStore.getState();
  const appearance = SettingsService.getProperty("useSystemTheme")
    ? "system"
    : themeState.colorScheme;
  const options = {
    appearance,
    accentLight: themeState.lightTheme.scopes.base.primary.accent,
    accentDark: themeState.darkTheme.scopes.base.primary.accent
  } as const;
  if (!mayExposeTaskTitles()) {
    if (generation !== snapshotGeneration) return;
    if (useSettingStore.getState().settings.appLockEnabled)
      await Native.writeSnapshot(
        JSON.stringify(buildPrivateTaskWidgetSnapshot(options))
      );
    else await Native.clearSnapshot();
    return;
  }
  const tasks = await db.tasks.list();
  if (generation !== snapshotGeneration || !mayExposeTaskTitles()) return;
  const accountId = (await db.user.getUser())?.id || null;
  if (generation !== snapshotGeneration || !mayExposeTaskTitles()) return;
  const snapshot = buildTaskWidgetSnapshot(tasks, {
    ...options,
    accountScope: taskWidgetAccountScope(MMKV, accountId)
  });
  await Native.writeSnapshot(JSON.stringify(snapshot));
}

function flushUpdate() {
  if (!Native) return Promise.resolve();
  clearTimeout(updateTimer);
  updateTimer = undefined;
  writeQueue = writeQueue.then(writeCurrentSnapshot).catch((error) => {
    DatabaseLogger.error(error as Error, "ReminderWidget.update");
  });
  return writeQueue;
}

/** Keep the action pending when a committed Task cannot yet be projected. */
function flushUpdateForCompletion() {
  if (!Native) return Promise.resolve();
  clearTimeout(updateTimer);
  updateTimer = undefined;
  const write = writeQueue.then(writeCurrentSnapshot);
  writeQueue = write.catch((error) => {
    DatabaseLogger.error(error as Error, "ReminderWidget.completeSnapshot");
  });
  return write;
}

async function protectBackgroundWrite(
  write: Promise<void>,
  backgroundTask: Promise<number>
) {
  let backgroundTaskId: number | undefined;
  try {
    backgroundTaskId = await backgroundTask;
    await write;
  } catch (error) {
    DatabaseLogger.error(error as Error, "ReminderWidget.background");
    await write;
  } finally {
    if (backgroundTaskId !== undefined) {
      try {
        await endBackgroundTask(backgroundTaskId);
      } catch (error) {
        DatabaseLogger.error(error as Error, "ReminderWidget.backgroundEnd");
      }
    }
  }
}

function update() {
  if (!Native) return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    flushUpdate();
  }, 250);
}

function start() {
  if (!Native) {
    if (Platform.OS === "ios")
      DatabaseLogger.error(
        new Error("Native Task widget bridge unavailable"),
        "ReminderWidget.start"
      );
    return () => {};
  }

  update();
  void drainPendingCompletions();
  const databaseSubscription = db.eventManager.subscribe(
    EVENTS.databaseUpdated,
    (event: DatabaseUpdatedEvent) => {
      if (event.collection === "settings" || event.collection === "reminders")
        update();
    }
  );
  const syncSubscription = db.eventManager.subscribe(EVENTS.syncCompleted, () =>
    update()
  );
  // iOS may suspend JavaScript before the debounce fires after the user saves
  // a Task and immediately leaves the app. Flush the derived cache first.
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      const backgroundTask = beginBackgroundTask();
      void protectBackgroundWrite(
        updateTimer ? flushUpdate() : writeQueue,
        backgroundTask
      );
    } else {
      update();
      void drainPendingCompletions();
    }
  });
  const logoutSubscription = db.eventManager.subscribe(
    EVENTS.userLoggedOut,
    () => void clearSnapshot()
  );
  const unsubscribeTheme = useThemeStore.subscribe((state, previous) => {
    if (
      state.colorScheme !== previous.colorScheme ||
      state.darkTheme !== previous.darkTheme ||
      state.lightTheme !== previous.lightTheme
    ) {
      update();
    }
  });
  const unsubscribeSettings = useSettingStore.subscribe((state, previous) => {
    if (state.settings.appLockEnabled !== previous.settings.appLockEnabled) {
      void clearSnapshot();
      flushUpdate();
    } else if (
      state.settings.useSystemTheme !== previous.settings.useSystemTheme
    ) {
      update();
    }
  });
  const unsubscribeUser = useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) {
      void clearSnapshot();
    } else if (state.appLocked !== previous.appLocked) {
      if (state.appLocked) {
        void clearSnapshot();
        flushUpdate();
      } else {
        update();
        void drainPendingCompletions();
      }
    }
  });

  return () => {
    databaseSubscription.unsubscribe();
    syncSubscription.unsubscribe();
    logoutSubscription.unsubscribe();
    appStateSubscription.remove();
    unsubscribeTheme();
    unsubscribeSettings();
    unsubscribeUser();
    clearTimeout(updateTimer);
    updateTimer = undefined;
  };
}

export const ReminderWidget = {
  start,
  update,
  drainPendingCompletions,
  waitForUpdate: () => {
    if (updateTimer) flushUpdate();
    return writeQueue;
  },
  clear: clearSnapshot
};
