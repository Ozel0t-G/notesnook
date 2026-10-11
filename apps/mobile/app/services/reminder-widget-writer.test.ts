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

const mockNativeWrite = jest.fn(async (_snapshot: string) => {});
const mockNativeClear = jest.fn(async () => {});
const mockCallbacks = new Map<string, (event?: unknown) => void>();
let mockAppStateChanged: ((state: string) => void) | undefined;
let mockTasks: Task[] = [];
let mockAppLockEnabled = false;
let mockAppLocked = false;
let mockSettingsChanged:
  | ((state: unknown, previous: unknown) => void)
  | undefined;
let mockUserChanged: ((state: unknown, previous: unknown) => void) | undefined;
let mockThemeChanged:
  | ((state: unknown, previous: unknown) => void)
  | undefined;
// Mirrors the real store: `lightTheme`/`darkTheme` are already the
// accent-applied (effective) themes, so the widget's accent fields follow the
// Settings > Themes palette. The mint default is a contrast-safe pair, so the
// two snapshot accents are deliberately different hexes, not one repeated tone.
let mockThemeState: Record<string, unknown> = {
  colorScheme: "light",
  accentColor: "mint",
  lightTheme: { scopes: { base: { primary: { accent: "#087C3E" } } } },
  darkTheme: { scopes: { base: { primary: { accent: "#73DFA0" } } } }
};

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: {
    ReminderWidgetModule: {
      writeSnapshot: (snapshot: string) => mockNativeWrite(snapshot),
      clearSnapshot: () => mockNativeClear(),
      listPendingCompletions: async () => [],
      acknowledgeCompletion: async () => {}
    }
  },
  AppState: {
    currentState: "active",
    addEventListener: (_name: string, callback: (state: string) => void) => {
      mockAppStateChanged = callback;
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
    tasks: { list: () => Promise.resolve(mockTasks) },
    user: { getUser: async () => ({ id: "account" }) },
    eventManager: {
      subscribe: (name: string, callback: (event?: unknown) => void) => {
        mockCallbacks.set(name, callback);
        return { unsubscribe: jest.fn() };
      }
    }
  },
  DatabaseLogger: { error: jest.fn() }
}));
jest.mock("../common/database/mmkv", () => ({
  MMKV: { getString: () => null, setString: () => {} }
}));
jest.mock("./event-manager", () => ({
  ToastManager: { show: jest.fn() }
}));
jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => ({ settings: { appLockEnabled: mockAppLockEnabled } }),
    subscribe: (callback: (state: unknown, previous: unknown) => void) => {
      mockSettingsChanged = callback;
      return jest.fn();
    }
  }
}));
jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({ appLocked: mockAppLocked, user: { id: "account" } }),
    subscribe: (callback: (state: unknown, previous: unknown) => void) => {
      mockUserChanged = callback;
      return jest.fn();
    }
  }
}));
jest.mock("../stores/use-theme-store", () => ({
  useThemeStore: {
    getState: () => mockThemeState,
    subscribe: (callback: (state: unknown, previous: unknown) => void) => {
      mockThemeChanged = callback;
      return jest.fn();
    }
  }
}));
jest.mock("./settings", () => ({
  __esModule: true,
  default: {
    get: () => ({ appLockEnabled: mockAppLockEnabled }),
    getProperty: () => true
  }
}));
// The writer's lifecycle calls `TaskNotifications.reconcile()` after a write.
// The real module pulls in notifee (and the native alarm bridge), which this
// snapshot-only suite deliberately does not fake: the same lightweight mock the
// completion suite uses keeps the writer's own behavior under test.
jest.mock("./task-notifications", () => ({
  TaskNotifications: { reconcile: jest.fn(async () => {}) }
}));

import { ReminderWidget } from "./reminder-widget";

describe("Task snapshot writer lifecycle", () => {
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  test("Task mutation and immediate background write current bytes and reload via native bridge", async () => {
    const stop = ReminderWidget.start();
    await ReminderWidget.waitForUpdate();
    mockNativeWrite.mockClear();

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
    mockTasks = [item];
    mockCallbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    mockAppStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(mockNativeWrite).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockNativeWrite.mock.calls[0][0]).tasks[0]).toMatchObject(
      {
        id: item.id,
        title: item.title,
        dueDate: today,
        dueTime: "14:00"
      }
    );
    // The widget's brand accent comes from the two existing snapshot v3 fields,
    // which carry the app's effective (palette-applied) accents: the mint
    // default's light and dark halves, each legible on its own surface.
    expect(JSON.parse(mockNativeWrite.mock.calls[0][0])).toMatchObject({
      accentLight: "#087C3E",
      accentDark: "#73DFA0"
    });

    mockTasks = [{ ...item, title: "Edited Task", listId: "another-list" }];
    mockCallbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    mockAppStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(JSON.parse(mockNativeWrite.mock.calls[1][0]).tasks[0].title).toBe(
      "Edited Task"
    );

    mockTasks = [{ ...item, completed: true }];
    mockCallbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    mockAppStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(JSON.parse(mockNativeWrite.mock.calls[2][0]).tasks).toEqual([]);

    mockTasks = [item];
    mockCallbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    mockAppStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(JSON.parse(mockNativeWrite.mock.calls[3][0]).tasks[0].id).toBe(
      item.id
    );

    mockTasks = [];
    mockCallbacks.get(EVENTS.databaseUpdated)?.({ collection: "settings" });
    mockAppStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(JSON.parse(mockNativeWrite.mock.calls[4][0]).tasks).toEqual([]);
    mockNativeWrite.mockClear();
    mockAppStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    expect(mockNativeWrite).not.toHaveBeenCalled();
    await ReminderWidget.clear();
    await ReminderWidget.waitForUpdate();
    expect(mockNativeWrite).not.toHaveBeenCalled();

    mockTasks = [item];
    mockAppLockEnabled = true;
    mockSettingsChanged?.(
      { settings: { appLockEnabled: true } },
      { settings: { appLockEnabled: false } }
    );
    await ReminderWidget.waitForUpdate();
    expect(mockNativeClear).toHaveBeenCalled();
    const privateBytes =
      mockNativeWrite.mock.calls[mockNativeWrite.mock.calls.length - 1]?.[0] ||
      "";
    expect(JSON.parse(privateBytes)).toMatchObject({
      privacyHidden: true,
      tasks: []
    });
    expect(privateBytes).not.toContain(item.title);
    // The locked card still carries the accent: it is a brand color, not the
    // redacted data, so the locked widget keeps the person's appearance.
    expect(JSON.parse(privateBytes)).toMatchObject({
      accentLight: "#087C3E",
      accentDark: "#73DFA0"
    });

    mockAppLocked = true;
    mockUserChanged?.(
      { appLocked: true, user: { id: "account" } },
      { appLocked: false, user: { id: "account" } }
    );
    mockAppStateChanged?.("background");
    await ReminderWidget.waitForUpdate();
    const lockedBytes =
      mockNativeWrite.mock.calls[mockNativeWrite.mock.calls.length - 1]?.[0] ||
      "";
    expect(lockedBytes).not.toContain(item.title);
    stop();
  });

  test("a Settings > Themes palette change rewrites the widget's accent", async () => {
    const stop = ReminderWidget.start();
    await ReminderWidget.waitForUpdate();
    mockNativeWrite.mockClear();

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(now.getDate()).padStart(2, "0")}`;
    mockTasks = [
      {
        id: "palette-task",
        title: "Palette task",
        listId: "default",
        completed: false,
        reminderDate: today,
        reminderTime: "09:00",
        scheduleVersion: 2,
        priority: "none",
        flagged: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        schemaVersion: 1
      } as Task
    ];

    const previousThemeState = mockThemeState;
    mockThemeState = {
      colorScheme: "light",
      accentColor: "violet",
      lightTheme: { scopes: { base: { primary: { accent: "#6B46C1" } } } },
      darkTheme: { scopes: { base: { primary: { accent: "#B9A2FF" } } } }
    };
    mockThemeChanged?.(mockThemeState, previousThemeState);
    await ReminderWidget.waitForUpdate();

    expect(mockNativeWrite).toHaveBeenCalled();
    const written =
      mockNativeWrite.mock.calls[mockNativeWrite.mock.calls.length - 1][0];
    expect(JSON.parse(written)).toMatchObject({
      accentLight: "#6B46C1",
      accentDark: "#B9A2FF"
    });
    // The palette never edits the theme definition or the schema version.
    expect(JSON.parse(written).schemaVersion).toBe(3);
    stop();
  });
});
