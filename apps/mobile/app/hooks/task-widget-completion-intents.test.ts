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

import {
  NATIVE_TASK_COMPLETION_MAX_AGE_MS,
  canReplayTaskWidgetCompletion,
  isNativeTaskCompletionAction,
  isValidTaskWidgetId,
  mayCommitNativeTaskCompletion,
  PendingTaskCompletions,
  TaskCompletionIntentStorage,
  taskWidgetAccountScope
} from "./task-widget-completion-intents";

const taskId = "0123456789abcdef01234567";
const recurringId = "0123456789abcdef0123456789abcdef";

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: TaskCompletionIntentStorage = {
    getString: (key) => values.get(key),
    setString: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    }
  };
  return { values, storage };
}

describe("Task widget completion intents", () => {
  test("keeps distinct account scopes for a later sign-in to the original account", () => {
    const { storage } = memoryStorage();
    const first = taskWidgetAccountScope(storage, "account-a");
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(taskWidgetAccountScope(storage, "account-a")).toBe(first);
    const second = taskWidgetAccountScope(storage, "account-b");
    expect(second).not.toBe(first);
    expect(taskWidgetAccountScope(storage, "account-a")).toBe(first);
    expect(taskWidgetAccountScope(storage, null)).not.toBe(first);
    expect(taskWidgetAccountScope(storage, "account-b")).toBe(second);
  });

  test("preserves an existing account scope when upgrading the storage format", () => {
    const { values, storage } = memoryStorage();
    const token = "a".repeat(32);
    values.set(
      "taskWidgetAccountScope:v1",
      JSON.stringify({ accountId: "account-a", token })
    );
    expect(taskWidgetAccountScope(storage, "account-a")).toBe(token);
    taskWidgetAccountScope(storage, "account-b");
    expect(taskWidgetAccountScope(storage, "account-a")).toBe(token);
  });

  test("rejects malformed App Group completion actions", () => {
    const valid = {
      filename: `${"a".repeat(64)}.json`,
      id: taskId,
      scope: "b".repeat(32),
      updatedAt: Date.now(),
      enqueuedAt: Date.now()
    };
    expect(isNativeTaskCompletionAction(valid)).toBe(true);
    expect(isNativeTaskCompletionAction({ ...valid, id: "../secret" })).toBe(
      false
    );
    expect(
      isNativeTaskCompletionAction({ ...valid, filename: "../task.json" })
    ).toBe(false);
    expect(isNativeTaskCompletionAction({ ...valid, scope: "account-a" })).toBe(
      false
    );
    expect(
      mayCommitNativeTaskCompletion(valid, valid.scope, {
        completed: false,
        updatedAt: valid.updatedAt
      })
    ).toBe(true);
    expect(
      mayCommitNativeTaskCompletion(valid, "c".repeat(32), {
        completed: false,
        updatedAt: valid.updatedAt
      })
    ).toBe(false);
    expect(
      mayCommitNativeTaskCompletion(valid, valid.scope, {
        completed: false,
        updatedAt: valid.updatedAt + 1
      })
    ).toBe(false);
    expect(
      mayCommitNativeTaskCompletion(valid, valid.scope, {
        completed: true,
        updatedAt: valid.updatedAt
      })
    ).toBe(false);
    expect(
      mayCommitNativeTaskCompletion(
        valid,
        valid.scope,
        { completed: false, updatedAt: valid.updatedAt },
        valid.enqueuedAt + 24 * 60 * 60 * 1000
      )
    ).toBe(true);
    expect(
      mayCommitNativeTaskCompletion(
        valid,
        valid.scope,
        { completed: false, updatedAt: valid.updatedAt },
        valid.enqueuedAt + NATIVE_TASK_COMPLETION_MAX_AGE_MS + 1
      )
    ).toBe(false);
  });

  test("accepts only Task ID shapes", () => {
    expect(isValidTaskWidgetId(taskId)).toBe(true);
    expect(isValidTaskWidgetId(recurringId)).toBe(true);
    expect(isValidTaskWidgetId("../../settings")).toBe(false);
    expect(isValidTaskWidgetId("not-a-task")).toBe(false);
    expect(isValidTaskWidgetId(`${taskId}%00`)).toBe(false);
  });

  test("never replays behind App Lock or before database readiness", () => {
    const ready = {
      databaseReady: true,
      appLoading: false,
      appLocked: false,
      loggingOut: false
    };
    expect(canReplayTaskWidgetCompletion(ready)).toBe(true);
    expect(canReplayTaskWidgetCompletion({ ...ready, appLocked: true })).toBe(
      false
    );
    expect(
      canReplayTaskWidgetCompletion({ ...ready, databaseReady: false })
    ).toBe(false);
    expect(canReplayTaskWidgetCompletion({ ...ready, appLoading: true })).toBe(
      false
    );
    expect(canReplayTaskWidgetCompletion({ ...ready, loggingOut: true })).toBe(
      false
    );
  });

  test("persists before replay, survives restart, and acknowledges only after success", () => {
    const { values, storage } = memoryStorage();
    const pending = new PendingTaskCompletions(storage);
    const now = Date.now();
    expect(pending.enqueue(taskId, "account-a", now)).toBe(true);
    expect(pending.enqueue(taskId, "account-a", now + 1)).toBe(true);
    expect([...values.values()][0]).toBe(
      JSON.stringify([{ id: taskId, accountId: "account-a", enqueuedAt: now }])
    );
    expect(new PendingTaskCompletions(storage).peekNext("account-a")).toBe(
      taskId
    );
    // Restoring the same user from an initially empty store must keep it.
    expect(
      new PendingTaskCompletions(storage).belongsToAccount("account-a")
    ).toBe(true);
    expect(
      new PendingTaskCompletions(storage).belongsToAccount("account-b")
    ).toBe(false);
    expect(pending.peekNext("account-a")).toBe(taskId);
    // A crash before the database mutation is acknowledged leaves the intent.
    expect(new PendingTaskCompletions(storage).peekNext("account-a")).toBe(
      taskId
    );
    expect(pending.acknowledge(taskId, now + 2)).toBe(true);
    expect(
      new PendingTaskCompletions(storage).peekNext("account-a")
    ).toBeUndefined();
    expect(pending.enqueue(taskId, "account-a", now + 4)).toBe(false);
  });

  test("drops a delayed completion before replay", () => {
    const { storage } = memoryStorage();
    const pending = new PendingTaskCompletions(storage);
    const now = Date.now();
    expect(pending.enqueue(taskId, "account-a", now)).toBe(true);
    expect(
      pending.peekNext("account-a", now + 24 * 60 * 60 * 1000 + 1)
    ).toBeUndefined();
    expect(
      new PendingTaskCompletions(storage).peekNext("account-a")
    ).toBeUndefined();
  });

  test("clock correction does not silently discard a pending completion", () => {
    const { values, storage } = memoryStorage();
    const now = Date.now();
    values.set(
      "taskWidgetPendingCompletions:v1",
      JSON.stringify([
        { id: taskId, accountId: "account-a", enqueuedAt: now + 60 * 60 * 1000 }
      ])
    );
    const pending = new PendingTaskCompletions(storage);
    expect(pending.peekNext("account-a", now)).toBe(taskId);
    expect(
      JSON.parse([...values.values()][0])[0].enqueuedAt
    ).toBeLessThanOrEqual(Date.now());
  });

  test("drops pending completions if the account changes or logs out", () => {
    const { storage } = memoryStorage();
    const pending = new PendingTaskCompletions(storage);
    pending.enqueue(taskId, "account-a");
    expect(pending.peekNext("account-b")).toBeUndefined();
    expect(
      new PendingTaskCompletions(storage).peekNext("account-a")
    ).toBeUndefined();
    pending.enqueue(recurringId, "account-a");
    pending.clear();
    expect(
      new PendingTaskCompletions(storage).peekNext("account-a")
    ).toBeUndefined();
  });

  test("keeps pending intent when durable acknowledgement fails", () => {
    const { storage } = memoryStorage();
    const pending = new PendingTaskCompletions(storage);
    pending.enqueue(taskId, "account-a");
    storage.removeItem = () => {
      throw new Error("storage unavailable");
    };
    expect(pending.acknowledge(taskId)).toBe(false);
    expect(new PendingTaskCompletions(storage).peekNext("account-a")).toBe(
      taskId
    );
  });

  test("rejects malformed persisted queue and caps pending IDs", () => {
    const { storage } = memoryStorage();
    storage.setString(
      "taskWidgetPendingCompletions:v1",
      JSON.stringify([{ id: "bad", accountId: "account-a" }])
    );
    expect(
      new PendingTaskCompletions(storage).peekNext("account-a")
    ).toBeUndefined();
    const pending = new PendingTaskCompletions(storage);
    for (let i = 0; i < 50; i++) {
      const id = i.toString(16).padStart(24, "0");
      expect(pending.enqueue(id, "account-a")).toBe(true);
    }
    expect(pending.enqueue(recurringId, "account-a")).toBe(false);
  });
});
