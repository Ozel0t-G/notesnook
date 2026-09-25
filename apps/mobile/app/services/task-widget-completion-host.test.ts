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

// The iOS 27 Task widget intent runs in the main app process in the background,
// which can be a cold start with no App component and no editor. These cover
// what that process is allowed to do before it reports a completion.

const mockState = {
  appLockEnabled: false,
  migrationsRequired: false,
  initialized: false
};
const mockInitializeDatabaseOnce = jest.fn(
  async (
    _password?: string,
    _options?: { createDatabaseKey?: boolean }
  ): Promise<void> => {
    mockState.initialized = true;
  }
);
const mockCommitCompletion = jest.fn(
  async (_action: { filename: string; id: string }): Promise<string> =>
    "completed"
);

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: { TaskWidgetCompletionModule: {} },
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} };
    }
  }
}));
jest.mock("../common/database", () => ({
  get db() {
    return {
      isInitialized: mockState.initialized,
      migrations: { required: () => mockState.migrationsRequired }
    };
  },
  DatabaseLogger: { error: () => {}, info: () => {} },
  initializeDatabaseOnce: (
    password?: string,
    options?: { createDatabaseKey?: boolean }
  ) => mockInitializeDatabaseOnce(password, options)
}));
jest.mock("./reminder-widget", () => ({
  ReminderWidget: {
    commitCompletion: (action: { filename: string; id: string }) =>
      mockCommitCompletion(action)
  }
}));
jest.mock("./settings", () => ({
  __esModule: true,
  default: { get: () => ({ appLockEnabled: mockState.appLockEnabled }) }
}));

import {
  isTaskWidgetCompletionRequest,
  runTaskWidgetCompletion
} from "./task-widget-completion-host";

const request = {
  requestId: "11111111-2222-3333-4444-555555555555",
  taskId: "0123456789abcdef01234567",
  scope: "0123456789abcdef0123456789abcdef",
  updatedAt: 1758800000000,
  filename: `${"a".repeat(64)}.json`
};

describe("cold start Task widget completion", () => {
  beforeEach(() => {
    mockState.appLockEnabled = false;
    mockState.migrationsRequired = false;
    mockState.initialized = false;
    mockInitializeDatabaseOnce.mockClear();
    mockCommitCompletion.mockClear();
    mockCommitCompletion.mockResolvedValue("completed");
  });

  test("a cold process opens the Task domain once and commits the queued action", async () => {
    await expect(runTaskWidgetCompletion(request)).resolves.toBe("completed");
    expect(mockInitializeDatabaseOnce).toHaveBeenCalledTimes(1);
    expect(mockCommitCompletion).toHaveBeenCalledWith({
      filename: request.filename,
      id: request.taskId
    });
  });

  test("a repeat tap on an already completed Task is idempotent, not a failure", async () => {
    // The core completion returns the existing record and still ensures the
    // next occurrence, so the host reports the same definitive result twice.
    await expect(runTaskWidgetCompletion(request)).resolves.toBe("completed");
    await expect(runTaskWidgetCompletion(request)).resolves.toBe("completed");
    expect(mockCommitCompletion).toHaveBeenCalledTimes(2);
  });

  test("persisted App Lock refuses the action before the database is opened", async () => {
    // The in-memory lock flag is still false in a headless process, so this has
    // to come from persisted settings, and it has to come first.
    mockState.appLockEnabled = true;
    await expect(runTaskWidgetCompletion(request)).resolves.toBe("locked");
    expect(mockInitializeDatabaseOnce).not.toHaveBeenCalled();
    expect(mockCommitCompletion).not.toHaveBeenCalled();
  });

  test("App Lock turned on while the database was opening still refuses", async () => {
    mockInitializeDatabaseOnce.mockImplementationOnce(async () => {
      mockState.initialized = true;
      mockState.appLockEnabled = true;
    });
    await expect(runTaskWidgetCompletion(request)).resolves.toBe("locked");
    expect(mockCommitCompletion).not.toHaveBeenCalled();
  });

  test("an unavailable database key fails the action instead of creating one", async () => {
    mockInitializeDatabaseOnce.mockRejectedValueOnce(
      new Error("Failed to get database key")
    );
    await expect(runTaskWidgetCompletion(request)).resolves.toBe("unavailable");
    expect(mockInitializeDatabaseOnce).toHaveBeenCalledWith(undefined, {
      createDatabaseKey: false
    });
    expect(mockCommitCompletion).not.toHaveBeenCalled();
  });

  test("a pending migration leaves the action queued", async () => {
    mockState.migrationsRequired = true;
    await expect(runTaskWidgetCompletion(request)).resolves.toBe("unavailable");
    expect(mockCommitCompletion).not.toHaveBeenCalled();
  });

  test("a failed commit is reported as a failure, never as a completion", async () => {
    for (const outcome of [
      "failed",
      "stale",
      "accountMismatch",
      "locked"
    ] as const) {
      mockCommitCompletion.mockResolvedValueOnce(outcome);
      await expect(runTaskWidgetCompletion(request)).resolves.toBe(outcome);
    }
  });

  test("a malformed request cannot reach the Task domain", () => {
    expect(isTaskWidgetCompletionRequest(request)).toBe(true);
    for (const invalid of [
      null,
      "string",
      { ...request, taskId: "../../etc/passwd" },
      { ...request, taskId: "0123456789abcdef0123456" },
      { ...request, scope: "not-a-scope" },
      { ...request, updatedAt: 0 },
      { ...request, updatedAt: 1.5 },
      { ...request, filename: "../snapshot.json" },
      { ...request, filename: `${"a".repeat(63)}.json` },
      { ...request, requestId: "" },
      { ...request, requestId: "x".repeat(65) }
    ])
      expect(isTaskWidgetCompletionRequest(invalid)).toBe(false);
  });
});
