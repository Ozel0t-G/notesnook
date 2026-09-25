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
};

const Native: NativeReminderWidget | undefined =
  Platform.OS === "ios" ? NativeModules.ReminderWidgetModule : undefined;

let updateTimer: NodeJS.Timeout | undefined;
let writeQueue = Promise.resolve();
let snapshotGeneration = 0;

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
  const snapshot = buildTaskWidgetSnapshot(tasks, options);
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
    } else update();
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
      } else update();
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
  waitForUpdate: () => {
    if (updateTimer) flushUpdate();
    return writeQueue;
  },
  clear: clearSnapshot
};
