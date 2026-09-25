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

import { EVENTS, type Task } from "@notesnook/core";

const nativeWrite = jest.fn(async (_snapshot: string) => {});
const nativeClear = jest.fn(async () => {});
const callbacks = new Map<string, (event?: unknown) => void>();
let appStateChanged: ((state: string) => void) | undefined;
let tasks: Task[] = [];
let appLockEnabled = false;
let appLocked = false;
let settingsChanged: ((state: unknown, previous: unknown) => void) | undefined;
let userChanged: ((state: unknown, previous: unknown) => void) | undefined;

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: {
    ReminderWidgetModule: {
      writeSnapshot: (snapshot: string) => nativeWrite(snapshot),
      clearSnapshot: () => nativeClear()
    }
  },
  AppState: {
    currentState: "active",
    addEventListener: (_name: string, callback: (state: string) => void) => {
      appStateChanged = callback;
      return { remove: jest.fn() };
    }
  }
}));
jest.mock("react-native-begin-background-task", () => ({
  beginBackgroundTask: jest.fn(async () => 1),
  endBackgroundTask: jest.fn(async () => {})
}));
jest.mock("../common/database", () => ({
  db: {
    isInitialized: true,
    tasks: { list: () => Promise.resolve(tasks) },
    eventManager: {
      subscribe: (name: string, callback: (event?: unknown) => void) => {
        callbacks.set(name, callback);
        return { unsubscribe: jest.fn() };
      }
    }
  },
  DatabaseLogger: { error: jest.fn() }
}));
jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => ({ settings: { appLockEnabled } }),
    subscribe: (callback: (state: unknown, previous: unknown) => void) => {
      settingsChanged = callback;
      return jest.fn();
    }
  }
}));
jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({ appLocked, user: { id: "account" } }),
    subscribe: (callback: (state: unknown, previous: unknown) => void) => {
      userChanged = callback;
      return jest.fn();
    }
  }
}));
jest.mock("../stores/use-theme-store", () => ({
  useThemeStore: {
    getState: () => ({
      colorScheme: "light",
      lightTheme: { scopes: { base: { primary: { accent: "#123ABC" } } } },
      darkTheme: { scopes: { base: { primary: { accent: "#456DEF" } } } }
    }),
    subscribe: () => jest.fn()
  }
}));
jest.mock("./settings", () => ({
  __esModule: true,
  default: { getProperty: () => true }
}));

import { ReminderWidget } from "./reminder-widget";

describe("Task snapshot writer lifecycle", () => {
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  test("Task mutation and immediate background write current bytes and reload via native bridge", async () => {
    const stop = ReminderWidget.start();
    await ReminderWidget.waitForUpdate();
    nativeWrite.mockClear();

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(now.getDate()).padStart(2, "0")}`;
    const item = {
      id: "widget-regression-test",
      title: "Widget Regression Test",
      listId: "default",
      completed: false,
      reminderDate: today,
      reminderTime: "14:00",
      scheduleVersion: 2,
      priority: "high",
      flagged: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      schemaVersion: 1
    } as Task;
    tasks = [item];
    callbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    appStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(nativeWrite).toHaveBeenCalledTimes(1);
    expect(JSON.parse(nativeWrite.mock.calls[0][0]).tasks[0]).toMatchObject({
      id: item.id,
      title: item.title,
      dueDate: today,
      dueTime: "14:00"
    });

    tasks = [{ ...item, title: "Edited Task", listId: "another-list" }];
    callbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    appStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(JSON.parse(nativeWrite.mock.calls[1][0]).tasks[0].title).toBe(
      "Edited Task"
    );

    tasks = [{ ...item, completed: true }];
    callbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    appStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(JSON.parse(nativeWrite.mock.calls[2][0]).tasks).toEqual([]);

    tasks = [item];
    callbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    appStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(JSON.parse(nativeWrite.mock.calls[3][0]).tasks[0].id).toBe(item.id);

    tasks = [];
    callbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    appStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(JSON.parse(nativeWrite.mock.calls[4][0]).tasks).toEqual([]);
    nativeWrite.mockClear();
    appStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(nativeWrite).not.toHaveBeenCalled();
    await ReminderWidget.clear();
    await ReminderWidget.waitForUpdate();
    expect(nativeWrite).not.toHaveBeenCalled();

    tasks = [item];
    appLockEnabled = true;
    settingsChanged?.(
      { settings: { appLockEnabled: true } },
      { settings: { appLockEnabled: false } }
    );
    await ReminderWidget.waitForUpdate();
    expect(nativeClear).toHaveBeenCalled();
    const privateBytes = nativeWrite.mock.calls[nativeWrite.mock.calls.length - 1]?.[0] || "";
    expect(JSON.parse(privateBytes)).toMatchObject({
      privacyHidden: true,
      tasks: []
    });
    expect(privateBytes).not.toContain(item.title);

    appLocked = true;
    userChanged?.(
      { appLocked: true, user: { id: "account" } },
      { appLocked: false, user: { id: "account" } }
    );
    appStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    const lockedBytes = nativeWrite.mock.calls[nativeWrite.mock.calls.length - 1]?.[0] || "";
    expect(lockedBytes).not.toContain(item.title);
    stop();
  });
});
