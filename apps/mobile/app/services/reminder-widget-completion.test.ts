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

// The failure contract of the commit path the widget completion intent awaits:
// only a persisted Task that has been projected into the snapshot and whose
// durable action has been acknowledged may be reported as completed.

import { createHash } from "node:crypto";
import type { Task } from "@notesnook/core";

const SCOPE = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "account";

type Action = {
  filename: string;
  id: string;
  scope: string;
  updatedAt: number;
  enqueuedAt: number;
};

function actionFor(
  task: { id: string; updatedAt: number },
  overrides: Partial<Action> = {}
): Action {
  const scope = overrides.scope ?? SCOPE;
  const updatedAt = overrides.updatedAt ?? task.updatedAt;
  return {
    filename: `${createHash("sha256")
      .update(`${scope}:${task.id}:${updatedAt}`)
      .digest("hex")}.json`,
    id: task.id,
    scope,
    updatedAt,
    enqueuedAt: Date.now(),
    ...overrides
  };
}

let mockActions: Action[] = [];
let mockTasks: Task[] = [];
let mockAccountId: string | null = ACCOUNT;
let mockAppLocked = false;
let mockPersistedAppLock = false;
let mockLockOnAccountRecheck = false;
let mockAccountReads = 0;
let mockLoggingOut = false;
let mockWriteFails = false;
let mockAcknowledgeFails = false;
const mockAcknowledged: string[] = [];
const mockCompleted: string[] = [];

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: {
    ReminderWidgetModule: {
      writeSnapshot: async () => {
        if (mockWriteFails) throw new Error("App Group snapshot write failed");
      },
      clearSnapshot: async () => {},
      listPendingCompletions: async () => mockActions,
      acknowledgeCompletion: async (filename: string) => {
        if (mockAcknowledgeFails)
          throw new Error("Task widget action acknowledge failed");
        mockAcknowledged.push(filename);
        mockActions = mockActions.filter(
          (action) => action.filename !== filename
        );
      }
    }
  },
  AppState: {
    currentState: "background",
    addEventListener: () => ({ remove: jest.fn() })
  }
}));
jest.mock("react-native-begin-background-task", () => ({
  beginBackgroundTask: jest.fn(async () => 1),
  endBackgroundTask: jest.fn(async () => {})
}));
jest.mock("../common/database", () => ({
  db: {
    isInitialized: true,
    tasks: {
      list: async () => mockTasks,
      get: async (id: string) => mockTasks.find((task) => task.id === id),
      // The core operation is idempotent and creates the next occurrence even
      // when the record was already completed; this only records the call.
      complete: async (id: string) => {
        mockCompleted.push(id);
        mockTasks = mockTasks.map((task) =>
          task.id === id ? { ...task, completed: true } : task
        );
      }
    },
    user: {
      getUser: async () => {
        mockAccountReads++;
        if (mockLockOnAccountRecheck && mockAccountReads === 2)
          mockPersistedAppLock = true;
        return mockAccountId ? { id: mockAccountId } : null;
      }
    },
    eventManager: { subscribe: () => ({ unsubscribe: jest.fn() }) }
  },
  DatabaseLogger: { error: jest.fn(), info: jest.fn() }
}));
jest.mock("../common/database/mmkv", () => ({
  MMKV: {
    getString: () =>
      JSON.stringify({ entries: [{ accountId: ACCOUNT, token: SCOPE }] }),
    setString: () => {}
  }
}));
jest.mock("./event-manager", () => ({ ToastManager: { show: jest.fn() } }));
jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => ({ settings: { appLockEnabled: false } }),
    subscribe: () => jest.fn()
  }
}));
jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({
      appLocked: mockAppLocked,
      isLoggingOut: mockLoggingOut,
      user: { id: mockAccountId }
    }),
    subscribe: () => jest.fn()
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
  default: {
    get: () => ({ appLockEnabled: mockPersistedAppLock }),
    getProperty: () => true
  }
}));

import { ReminderWidget } from "./reminder-widget";

const today = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(now.getDate()).padStart(2, "0")}`;
})();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "0123456789abcdef01234567",
    title: "Water the plants",
    listId: "default",
    completed: false,
    dueDate: today,
    dueTime: "09:00",
    reminderDate: today,
    reminderTime: "09:00",
    scheduleVersion: 2,
    priority: "none",
    flagged: false,
    createdAt: Date.now(),
    updatedAt: 1758800000000,
    schemaVersion: 1,
    ...overrides
  } as Task;
}

describe("Task widget completion commit contract", () => {
  beforeEach(() => {
    mockTasks = [task()];
    mockActions = [];
    mockAccountId = ACCOUNT;
    mockAppLocked = false;
    mockPersistedAppLock = false;
    mockLockOnAccountRecheck = false;
    mockAccountReads = 0;
    mockLoggingOut = false;
    mockWriteFails = false;
    mockAcknowledgeFails = false;
    mockAcknowledged.length = 0;
    mockCompleted.length = 0;
  });

  test("a matching action is persisted, projected and acknowledged", async () => {
    const action = actionFor(task());
    mockActions = [action];
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("completed");
    expect(mockCompleted).toEqual([action.id]);
    expect(mockAcknowledged).toEqual([action.filename]);
  });

  test("a targeted intent does not wait to commit unrelated queued actions", async () => {
    const first = task();
    const tapped = task({ id: "fedcba987654321001234567" });
    const firstAction = actionFor(first);
    const tappedAction = actionFor(tapped);
    mockTasks = [first, tapped];
    mockActions = [firstAction, tappedAction];

    await expect(
      ReminderWidget.commitCompletion({
        filename: tappedAction.filename,
        id: tappedAction.id
      })
    ).resolves.toBe("completed");
    expect(mockCompleted).toEqual([tapped.id]);
    expect(mockActions).toEqual([firstAction]);
  });

  test("a repeat tap on a Task already completed by an earlier commit is completed, not failed", async () => {
    const action = actionFor(task());
    mockTasks = [task({ completed: true })];
    mockActions = [action];
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("completed");
    // Core's idempotent path also repairs a missing next recurring occurrence.
    expect(mockCompleted).toEqual([action.id]);
    expect(mockAcknowledged).toEqual([action.filename]);
  });

  test("an action a concurrent drain already consumed reports the persisted truth", async () => {
    const action = actionFor(task());
    mockTasks = [task({ completed: true })];
    mockActions = [];
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("completed");

    mockTasks = [task({ completed: false })];
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("stale");
  });

  test("an already consumed action still requires a refreshed snapshot", async () => {
    const action = actionFor(task());
    mockTasks = [task({ completed: true })];
    mockWriteFails = true;
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("failed");
  });

  test("a failed snapshot write fails the action and leaves it queued", async () => {
    const action = actionFor(task());
    mockActions = [action];
    mockWriteFails = true;
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("failed");
    expect(mockAcknowledged).toEqual([]);
    expect(mockActions).toEqual([action]);
  });

  test("a failed acknowledgement fails the action so a later drain retries it", async () => {
    const action = actionFor(task());
    mockActions = [action];
    mockAcknowledgeFails = true;
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("failed");
    expect(mockActions).toEqual([action]);
  });

  test("App Lock and signing out refuse to commit and keep the action", async () => {
    const action = actionFor(task());
    mockActions = [action];
    mockAppLocked = true;
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("locked");
    mockAppLocked = false;
    mockLoggingOut = true;
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("locked");
    expect(mockCompleted).toEqual([]);
    expect(mockActions).toEqual([action]);
  });

  test("persisted App Lock blocks a headless completion even when memory says unlocked", async () => {
    const action = actionFor(task());
    mockActions = [action];
    mockPersistedAppLock = true;
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("locked");
    expect(mockCompleted).toEqual([]);
    expect(mockAcknowledged).toEqual([]);
    expect(mockActions).toEqual([action]);
  });

  test("App Lock enabled during queue validation blocks the Task write", async () => {
    const action = actionFor(task());
    mockActions = [action];
    mockLockOnAccountRecheck = true;
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("locked");
    expect(mockCompleted).toEqual([]);
    expect(mockAcknowledged).toEqual([]);
    expect(mockActions).toEqual([action]);
  });

  test("another account's action is kept for its owner, not consumed", async () => {
    const action = actionFor(task(), { scope: "f".repeat(32) });
    mockActions = [action];
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("accountMismatch");
    expect(mockCompleted).toEqual([]);
    expect(mockActions).toEqual([action]);
  });

  test("a stale revision is dropped instead of completing a Task the user has since edited", async () => {
    const action = actionFor(task(), { updatedAt: 1758700000000 });
    mockActions = [action];
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("stale");
    expect(mockCompleted).toEqual([]);
    expect(mockAcknowledged).toEqual([action.filename]);
  });

  test("an action older than the retry window is dropped", async () => {
    const action = actionFor(task(), {
      enqueuedAt: Date.now() - 8 * 24 * 60 * 60 * 1000
    });
    mockActions = [action];
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("stale");
    expect(mockCompleted).toEqual([]);
  });

  test("a deleted Task cannot be completed", async () => {
    const action = actionFor(task());
    mockActions = [action];
    mockTasks = [];
    await expect(
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      })
    ).resolves.toBe("stale");
    expect(mockCompleted).toEqual([]);
  });

  test("a targeted commit and a lifecycle drain do not consume the queue twice", async () => {
    const action = actionFor(task());
    mockActions = [action];
    const [outcome] = await Promise.all([
      ReminderWidget.commitCompletion({
        filename: action.filename,
        id: action.id
      }),
      ReminderWidget.drainPendingCompletions()
    ]);
    expect(outcome).toBe("completed");
    expect(mockCompleted).toEqual([action.id]);
    expect(mockAcknowledged).toEqual([action.filename]);
  });
});
