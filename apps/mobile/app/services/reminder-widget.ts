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
import { NativeModules, Platform } from "react-native";
import { db, DatabaseLogger } from "../common/database";
import { useSettingStore } from "../stores/use-setting-store";
import { useThemeStore } from "../stores/use-theme-store";
import SettingsService from "./settings";
import { buildReminderWidgetSnapshot } from "./reminder-widget-snapshot";

type NativeReminderWidget = {
  writeSnapshot(snapshot: string): Promise<void>;
  clearSnapshot(): Promise<void>;
};

const Native: NativeReminderWidget | undefined =
  Platform.OS === "ios" ? NativeModules.ReminderWidgetModule : undefined;

let updateTimer: NodeJS.Timeout | undefined;
let writeQueue = Promise.resolve();

async function writeCurrentSnapshot() {
  if (!Native || !db.isInitialized) return;
  const themeState = useThemeStore.getState();
  const reminders = await db.reminders.all.items(undefined, {
    sortBy: "dueDate",
    sortDirection: "asc"
  });
  const snapshot = buildReminderWidgetSnapshot(reminders, {
    appearance: SettingsService.getProperty("useSystemTheme")
      ? "system"
      : themeState.colorScheme,
    accentLight: themeState.lightTheme.scopes.base.primary.accent,
    accentDark: themeState.darkTheme.scopes.base.primary.accent
  });
  await Native.writeSnapshot(JSON.stringify(snapshot));
}

function update() {
  if (!Native) return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    writeQueue = writeQueue.then(writeCurrentSnapshot).catch((error) => {
      DatabaseLogger.error(error as Error, "ReminderWidget.update");
    });
  }, 250);
}

function start() {
  if (!Native) return () => {};

  update();
  const databaseSubscription = db.eventManager.subscribe(
    EVENTS.databaseUpdated,
    (event: DatabaseUpdatedEvent) => {
      if (event.collection === "reminders") update();
    }
  );
  const syncSubscription = db.eventManager.subscribe(EVENTS.syncCompleted, () =>
    update()
  );
  const logoutSubscription = db.eventManager.subscribe(
    EVENTS.userLoggedOut,
    () => Native.clearSnapshot()
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
    if (state.settings.useSystemTheme !== previous.settings.useSystemTheme) {
      update();
    }
  });

  return () => {
    databaseSubscription.unsubscribe();
    syncSubscription.unsubscribe();
    logoutSubscription.unsubscribe();
    unsubscribeTheme();
    unsubscribeSettings();
    clearTimeout(updateTimer);
  };
}

export const ReminderWidget = {
  start,
  update,
  waitForUpdate: () => writeQueue,
  clear: () => Native?.clearSnapshot() ?? Promise.resolve()
};
