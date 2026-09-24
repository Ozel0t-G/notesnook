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

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = { isLocked: false, credentials: [] as { active: boolean }[] };
  return {
    state,
    keyListener: undefined as
      | ((state: typeof state, previous: typeof state) => void)
      | undefined,
    replace: vi.fn(async (_tasks: unknown) => {}),
    list: vi.fn(async () => [
      {
        id: "private-task",
        title: "Secret Task title",
        completed: false,
        reminderAt: Date.now() + 3_600_000
      }
    ])
  };
});

vi.mock("../src/common/db", () => ({
  db: {
    isInitialized: true,
    tasks: { reconcile: vi.fn(async () => {}), list: mocks.list },
    eventManager: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) }
  }
}));
vi.mock("../src/common/desktop-bridge", () => ({
  desktop: { integration: { replaceTaskReminders: { mutate: mocks.replace } } }
}));
vi.mock("../src/interfaces/key-store", () => ({
  useKeyStore: {
    getState: () => ({
      ...mocks.state,
      activeCredentials: () => mocks.state.credentials.filter((c) => c.active)
    }),
    subscribe: (listener: typeof mocks.keyListener) => {
      mocks.keyListener = listener;
      return () => {};
    }
  }
}));
vi.mock("../src/utils/config", () => ({ default: { get: () => true } }));
vi.mock("../src/utils/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../src/utils/task-scheduler", () => ({
  TaskScheduler: { stopAllWithPrefix: vi.fn(async () => {}) }
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_DESKTOP_APP", true);
  vi.useFakeTimers();
  mocks.replace.mockClear();
  mocks.keyListener = undefined;
  mocks.state.isLocked = false;
  mocks.state.credentials = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("App Lock redacts Electron Task payload and restores titles when disabled", async () => {
  const { TaskNotificationStore } = await import(
    "../src/stores/task-notification-store"
  );
  await TaskNotificationStore.refresh();
  expect(JSON.stringify(mocks.replace.mock.lastCall?.[0])).toContain(
    "Secret Task title"
  );

  TaskNotificationStore.start();
  const beforeLock = { ...mocks.state };
  mocks.state.credentials = [{ active: true }];
  mocks.keyListener?.(mocks.state, beforeLock);
  await TaskNotificationStore.refresh();
  expect(JSON.stringify(mocks.replace.mock.lastCall?.[0])).not.toContain(
    "Secret Task title"
  );

  const beforeUnlock = { ...mocks.state };
  mocks.state.isLocked = true;
  mocks.keyListener?.(mocks.state, beforeUnlock);
  await TaskNotificationStore.refresh();
  expect(JSON.stringify(mocks.replace.mock.lastCall?.[0])).not.toContain(
    "Secret Task title"
  );

  const beforeDisable = { ...mocks.state };
  mocks.state.isLocked = false;
  mocks.state.credentials = [];
  mocks.keyListener?.(mocks.state, beforeDisable);
  await TaskNotificationStore.refresh();
  expect(JSON.stringify(mocks.replace.mock.lastCall?.[0])).toContain(
    "Secret Task title"
  );
});

test("starting while already locked clears a prior desktop schedule immediately", async () => {
  mocks.state.isLocked = true;
  const { TaskNotificationStore } = await import(
    "../src/stores/task-notification-store"
  );
  TaskNotificationStore.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.replace).toHaveBeenCalledTimes(1);
  expect(mocks.replace.mock.calls[0][0]).toEqual([]);
});
