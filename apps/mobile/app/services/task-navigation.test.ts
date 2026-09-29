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

jest.mock("../common/database", () => ({
  db: {
    isInitialized: true,
    user: { getUser: jest.fn() },
    tasks: {
      get: jest.fn(),
      complete: jest.fn(),
      update: jest.fn(),
      remove: jest.fn()
    },
    taskLists: { getSync: jest.fn() }
  }
}));

jest.mock("./navigation", () => ({
  __esModule: true,
  default: { navigate: jest.fn() }
}));

jest.mock("./event-manager", () => ({
  ToastManager: { show: jest.fn() }
}));

jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: { getState: jest.fn() }
}));

jest.mock("../stores/use-user-store", () => ({
  useUserStore: { getState: jest.fn() }
}));

import { db } from "../common/database";
import { ToastManager } from "./event-manager";
import Navigation from "./navigation";
import { useSettingStore } from "../stores/use-setting-store";
import { useUserStore } from "../stores/use-user-store";
import {
  canRouteTaskNavigation,
  clearPendingTaskNavigation,
  consumePendingTaskNavigation,
  decideTaskIntentAccount,
  nextTaskFocusRequestId,
  openTaskInContext,
  pendingTaskNavigation,
  resolveTaskNavigationTarget,
  TASK_UNAVAILABLE_MESSAGE,
  taskNavigationReadiness,
  taskNotificationIntent
} from "./task-navigation";

const database = db as unknown as { isInitialized: boolean };
const mockedGetUser = db.user.getUser as unknown as jest.Mock;
const mockedGetTask = db.tasks.get as unknown as jest.Mock;
const mockedGetList = db.taskLists.getSync as unknown as jest.Mock;
const navigate = Navigation.navigate as unknown as jest.Mock;
const toast = ToastManager.show as unknown as jest.Mock;
const settingState = useSettingStore.getState as unknown as jest.Mock;
const userState = useUserStore.getState as unknown as jest.Mock;

/** A valid 24-character hex Task id. */
const taskId = (seed: number) => seed.toString(16).padStart(24, "0");

function setReadiness(
  options: {
    loaded?: boolean;
    appLoading?: boolean;
    appLocked?: boolean;
    loggingOut?: boolean;
  } = {}
) {
  const {
    loaded = true,
    appLoading = false,
    appLocked = false,
    loggingOut = false
  } = options;
  database.isInitialized = loaded;
  settingState.mockReturnValue({ isAppLoading: appLoading });
  userState.mockReturnValue({ appLocked, isLoggingOut: loggingOut });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearPendingTaskNavigation();
  setReadiness();
  mockedGetUser.mockResolvedValue({ id: "account-a" });
  mockedGetList.mockReturnValue({ id: "list" });
});

describe("Task navigation readiness", () => {
  test("mirrors the live store/bootstrap signals, inventing no unrelated flag", () => {
    setReadiness();
    expect(taskNavigationReadiness()).toEqual({
      databaseReady: true,
      appLoading: false,
      appLocked: false,
      loggingOut: false
    });
    expect(canRouteTaskNavigation()).toBe(true);

    setReadiness({ loaded: false });
    expect(canRouteTaskNavigation()).toBe(false);
    setReadiness({ appLoading: true });
    expect(canRouteTaskNavigation()).toBe(false);
    setReadiness({ appLocked: true });
    expect(canRouteTaskNavigation()).toBe(false);
    setReadiness({ loggingOut: true });
    expect(canRouteTaskNavigation()).toBe(false);
  });

  test("does not touch the protected domain before readiness", async () => {
    setReadiness({ loaded: false });

    await openTaskInContext({ taskId: taskId(1), source: "notification" });

    expect(mockedGetTask).not.toHaveBeenCalled();
    expect(mockedGetUser).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(pendingTaskNavigation()).toHaveLength(1);
  });

  test("consumes a queued cold/locked intent exactly once after readiness", async () => {
    setReadiness({ appLocked: true });
    await openTaskInContext({
      taskId: taskId(2),
      accountId: "account-a",
      source: "cold-initial-notification"
    });
    expect(pendingTaskNavigation()).toHaveLength(1);

    setReadiness({ appLocked: false });
    mockedGetTask.mockResolvedValue({
      id: taskId(2),
      listId: "personal",
      completed: false
    });

    await consumePendingTaskNavigation();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(pendingTaskNavigation()).toHaveLength(0);

    // Consumed once: a second pass must not re-open it.
    await consumePendingTaskNavigation();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test("drops a queued intent when the account changes or logs out", async () => {
    setReadiness({ appLocked: true });
    await openTaskInContext({
      taskId: taskId(3),
      accountId: "account-a",
      source: "notification"
    });
    expect(pendingTaskNavigation()).toHaveLength(1);

    clearPendingTaskNavigation();
    setReadiness();
    await consumePendingTaskNavigation();

    expect(pendingTaskNavigation()).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("Task intent account policy", () => {
  test("classifies match, mismatch and accountless payloads", () => {
    expect(decideTaskIntentAccount("account-a", "account-a")).toBe("match");
    expect(decideTaskIntentAccount("account-a", "account-b")).toBe("mismatch");
    expect(decideTaskIntentAccount("account-a", null)).toBe("mismatch");
    expect(decideTaskIntentAccount(undefined, "account-a")).toBe("accountless");
    expect(decideTaskIntentAccount(null, null)).toBe("accountless");
  });

  test("rejects a wrong-account notification before any Task lookup or content exposure", async () => {
    mockedGetUser.mockResolvedValue({ id: "account-b" });

    await openTaskInContext({
      taskId: taskId(4),
      accountId: "account-a",
      source: "notification"
    });

    expect(mockedGetTask).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  test("rejects an account-claimed payload when nobody is signed in", async () => {
    mockedGetUser.mockResolvedValue(undefined);

    await openTaskInContext({
      taskId: taskId(5),
      accountId: "account-a",
      source: "notification"
    });

    expect(mockedGetTask).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  test("resolves an accountless legacy payload against the current account only", async () => {
    mockedGetTask.mockResolvedValue({
      id: taskId(6),
      listId: "work",
      completed: false
    });

    await openTaskInContext({ taskId: taskId(6), source: "widget" });

    // No account was claimed, so no account read is needed and no other
    // account can be opened.
    expect(mockedGetUser).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      "Tasks",
      expect.objectContaining({ listId: "work", focusTaskId: taskId(6) })
    );
  });

  test("reads the account and occurrence identity a producer attached", () => {
    expect(
      taskNotificationIntent(
        { taskId: taskId(7), accountId: "account-a", occurrenceKey: "k" },
        "notification"
      )
    ).toEqual({
      taskId: taskId(7),
      accountId: "account-a",
      occurrenceKey: "k",
      source: "notification"
    });
    expect(
      taskNotificationIntent(
        { taskId: taskId(7), accountId: "", occurrenceKey: "" },
        "notification"
      )
    ).toEqual({
      taskId: taskId(7),
      accountId: undefined,
      occurrenceKey: undefined,
      source: "notification"
    });
    expect(taskNotificationIntent({}, "notification")).toBeUndefined();
    expect(taskNotificationIntent(undefined, "notification")).toBeUndefined();
  });
});

describe("Task target resolution", () => {
  test("resolves the target purely from the current record", () => {
    const exists = () => true;
    expect(
      resolveTaskNavigationTarget(undefined, { taskId: "t" }, exists)
    ).toEqual({ kind: "missing", taskId: "t" });
    expect(
      resolveTaskNavigationTarget(
        { id: "t", listId: "l", completed: false },
        { taskId: "t" },
        exists
      )
    ).toEqual({ kind: "list", taskId: "t", listId: "l" });
    expect(
      resolveTaskNavigationTarget(
        { id: "t", listId: "l", completed: true },
        { taskId: "t" },
        exists
      )
    ).toEqual({ kind: "completed", taskId: "t", listId: "l" });
    expect(
      resolveTaskNavigationTarget(
        { id: "t", listId: "l", completed: true },
        { taskId: "t" },
        () => false
      )
    ).toEqual({ kind: "completed", taskId: "t" });
    expect(
      resolveTaskNavigationTarget(
        { id: "t", listId: "l", completed: false, occurrenceKey: "b" },
        { taskId: "t", occurrenceKey: "a" },
        exists
      )
    ).toEqual({ kind: "stale", taskId: "t" });
    // Occurrence identity is only compared when both sides knew one.
    expect(
      resolveTaskNavigationTarget(
        { id: "t", listId: "l", completed: false },
        { taskId: "t", occurrenceKey: "a" },
        exists
      )
    ).toEqual({ kind: "list", taskId: "t", listId: "l" });
  });

  test("ignores an id that cannot be a Task id", async () => {
    await openTaskInContext("not-an-id");

    expect(mockedGetTask).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(pendingTaskNavigation()).toHaveLength(0);
  });

  test("opens the Task's current canonical List, never a stale payload List", async () => {
    mockedGetTask.mockResolvedValue({
      id: taskId(8),
      listId: "moved-to-work",
      completed: false
    });

    await openTaskInContext({
      taskId: taskId(8),
      accountId: "account-a",
      source: "notification"
    });

    expect(mockedGetTask).toHaveBeenCalledWith(taskId(8));
    expect(navigate).toHaveBeenCalledWith("Tasks", {
      listId: "moved-to-work",
      focusTaskId: taskId(8),
      focusRequestId: expect.any(String)
    });
    expect(navigate.mock.calls[0][0]).not.toBe("TaskDetail");
  });

  test("keeps a completed Task visible in its current List instead of resurrecting it", async () => {
    mockedGetTask.mockResolvedValue({
      id: taskId(9),
      listId: "personal",
      completed: true
    });

    await openTaskInContext({ taskId: taskId(9), source: "notification" });

    expect(mockedGetList).toHaveBeenCalledWith("personal");
    expect(navigate).toHaveBeenCalledWith("Tasks", {
      listId: "personal",
      includeCompleted: true,
      focusTaskId: taskId(9),
      focusRequestId: expect.any(String)
    });
  });

  test("falls back to the Completed smart list when the canonical List is gone", async () => {
    mockedGetList.mockReturnValue(undefined);
    mockedGetTask.mockResolvedValue({
      id: taskId(10),
      listId: "deleted-list",
      completed: true
    });

    await openTaskInContext({ taskId: taskId(10), source: "notification" });

    expect(navigate).toHaveBeenCalledWith("Tasks", {
      smartList: "completed",
      focusTaskId: taskId(10),
      focusRequestId: expect.any(String)
    });
  });

  test("lands on a safe Tasks destination with a generic message when the Task is gone", async () => {
    mockedGetTask.mockResolvedValue(undefined);

    await openTaskInContext({
      taskId: taskId(11),
      accountId: "account-a",
      source: "notification"
    });

    expect(navigate).toHaveBeenCalledWith("Tasks");
    expect(toast).toHaveBeenCalledWith({
      message: TASK_UNAVAILABLE_MESSAGE,
      type: "info"
    });
    // The generic message never carries the id it addressed.
    expect(TASK_UNAVAILABLE_MESSAGE).not.toContain(taskId(11));
  });

  test("never targets the next occurrence of a stale recurring payload, and never mutates", async () => {
    mockedGetTask.mockResolvedValue({
      id: taskId(12),
      listId: "personal",
      completed: false,
      occurrenceKey: "2026-10-02T14:00"
    });

    await openTaskInContext({
      taskId: taskId(12),
      occurrenceKey: "2026-10-01T14:00",
      source: "notification"
    });

    expect(navigate).toHaveBeenCalledWith("Tasks");
    expect(toast).toHaveBeenCalledWith({
      message: TASK_UNAVAILABLE_MESSAGE,
      type: "info"
    });
    expect(db.tasks.complete).not.toHaveBeenCalled();
    expect(db.tasks.update).not.toHaveBeenCalled();
    expect(db.tasks.remove).not.toHaveBeenCalled();
  });

  test("never routes into the editor", async () => {
    mockedGetTask.mockResolvedValue({
      id: taskId(13),
      listId: "inbox",
      completed: false
    });

    await openTaskInContext({ taskId: taskId(13), source: "notification" });

    for (const call of navigate.mock.calls)
      expect(call[0]).not.toBe("TaskDetail");
  });
});

describe("last accepted rapid tap wins", () => {
  test("only the most recently accepted request routes when lookups resolve out of order", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    mockedGetTask
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve))
      );

    const first = openTaskInContext({
      taskId: taskId(14),
      source: "notification"
    });
    const second = openTaskInContext({
      taskId: taskId(15),
      source: "notification"
    });

    // The second (latest) request resolves first...
    resolveSecond({ id: taskId(15), listId: "second", completed: false });
    await second;
    // ...and the earlier one resolving late must not steal the navigation.
    resolveFirst({ id: taskId(14), listId: "first", completed: false });
    await first;

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      "Tasks",
      expect.objectContaining({ listId: "second", focusTaskId: taskId(15) })
    );
  });

  test("re-focusing the same Task re-arms with a fresh request nonce", async () => {
    mockedGetTask.mockResolvedValue({
      id: taskId(16),
      listId: "inbox",
      completed: false
    });

    await openTaskInContext({ taskId: taskId(16), source: "notification" });
    await openTaskInContext({ taskId: taskId(16), source: "notification" });

    const requestIds = navigate.mock.calls.map(
      (call) => call[1].focusRequestId as string
    );
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(nextTaskFocusRequestId(1)).not.toBe(nextTaskFocusRequestId(1));
  });
});
