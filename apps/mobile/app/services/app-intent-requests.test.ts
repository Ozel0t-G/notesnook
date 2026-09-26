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

let mockAppLocked = false;
let mockAppLockEnabled = false;
let mockAppLoading = false;
const SCOPE = "0123456789abcdef0123456789abcdef";
type MockTask = {
  id: string;
  title: string;
  completed: boolean;
  listId?: string;
  createdAt?: number;
  updatedAt?: number;
  flagged?: boolean;
  scheduleVersion?: number;
  reminderDate?: string;
  seriesId?: string;
};
const mockCreateTask = jest.fn(async (_input: unknown) => ({ id: "saved-task" }));
const mockCompleteTask = jest.fn(async (_id: string) => {});
const mockAddNote = jest.fn(async (_input: unknown) => "saved-note");
const mockTaskList = jest.fn(async (): Promise<MockTask[]> => []);
const mockGetTask = jest.fn(
  async (id: string): Promise<MockTask | undefined> =>
    (await mockTaskList()).find((task) => task.id === id)
);
const mockTodayList = jest.fn(async () => [{ title: "Pay invoice" }]);
const mockTaskLists = jest.fn(async () => [
  { id: "personal", name: "Personal" }
]);
const mockRequestPermission = jest.fn(async () => true);
const mockWidgetUpdate = jest.fn();

jest.mock("../common/database", () => ({
  db: {
    isInitialized: true,
    user: { getUser: async () => ({ id: "account-a" }) },
    taskLists: {
      default: async () => ({ id: "default" }),
      list: () => mockTaskLists()
    },
    tasks: {
      create: (input: unknown) => mockCreateTask(input),
      complete: (id: string) => mockCompleteTask(id),
      get: (id: string) => mockGetTask(id),
      list: () => mockTaskList(),
      smartList: () => mockTodayList()
    },
    notes: { add: (input: unknown) => mockAddNote(input) },
    settings: {
      getDefaultNotebook: () => undefined,
      getDefaultTag: () => undefined
    }
  }
}));
jest.mock("../common/database/mmkv", () => ({ MMKV: {} }));
jest.mock("../hooks/task-widget-completion-intents", () => ({
  taskWidgetAccountScope: () => SCOPE
}));
jest.mock("./reminder-widget", () => ({
  ReminderWidget: {
    update: () => mockWidgetUpdate(),
    waitForUpdate: async () => {}
  }
}));
jest.mock("./settings", () => ({
  __esModule: true,
  default: { get: () => ({ appLockEnabled: mockAppLockEnabled }) }
}));
jest.mock("./notifications", () => ({
  textToHTML: (text: string) => `<p>${text}</p>`
}));
jest.mock("./task-notifications", () => ({
  TaskNotifications: {
    urgentStatus: async () => "authorized",
    requestUrgentPermission: async () => "authorized",
    requestPermission: () => mockRequestPermission()
  }
}));
jest.mock("./navigation", () => ({
  __esModule: true,
  default: { queueRoutesForUpdate: jest.fn() }
}));
jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => ({
      settings: { appLockEnabled: mockAppLockEnabled },
      isAppLoading: mockAppLoading
    })
  }
}));
jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({ appLocked: mockAppLocked, isLoggingOut: false })
  }
}));
jest.mock("@notesnook/intl", () => ({
  strings: {
    untitled: () => "Untitled",
    tasksOverdue: () => "Overdue",
    dueToday: () => "Due today",
    due: (date: string) => `Due ${date}`
  }
}));

import { executeAppIntentRequest } from "./app-intent-requests";

function task(id: string, overrides: Partial<MockTask> = {}): MockTask {
  return {
    id,
    title: `Task ${id}`,
    completed: false,
    listId: "personal",
    createdAt: 1,
    updatedAt: 1,
    flagged: false,
    // The calendar schedule fields are only authoritative at version 2.
    scheduleVersion: 2,
    ...overrides
  };
}

beforeEach(() => {
  mockAppLocked = false;
  mockAppLockEnabled = false;
  mockAppLoading = false;
  jest.clearAllMocks();
  mockTaskList.mockResolvedValue([]);
  mockCreateTask.mockResolvedValue({ id: "saved-task" });
  mockAddNote.mockResolvedValue("saved-note");
  mockRequestPermission.mockResolvedValue(true);
  mockWidgetUpdate.mockImplementation(() => undefined);
});

describe("App Intent domain acknowledgements", () => {
  test("only acknowledges Task creation after the encrypted domain resolves", async () => {
    let save: ((value: { id: string }) => void) | undefined;
    mockCreateTask.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          save = resolve;
        })
    );
    let settled = false;
    const reply = executeAppIntentRequest({
      id: "1",
      action: "createTask",
      payload: {
        title: "  Collect parcel  ",
        listName: "Personal",
        reminderTimestamp: String(new Date(2026, 9, 2, 14, 30).getTime()),
        repeatMode: "weekly",
        priority: "high",
        flagged: "true"
      }
    }).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Collect parcel",
        listId: "personal",
        reminderDate: "2026-10-02",
        reminderTime: "14:30",
        recurrenceRule: "FREQ=WEEKLY",
        priority: "high",
        flagged: true
      })
    );
    save?.({ id: "saved-task" });
    await expect(reply).resolves.toEqual({ status: "ok", value: "saved-task" });
  });

  test("blocks locked writes and private Today output", async () => {
    mockAppLocked = true;
    await expect(
      executeAppIntentRequest({
        id: "2",
        action: "createNote",
        payload: { content: "private" }
      })
    ).resolves.toEqual({ status: "locked", value: "" });
    expect(mockAddNote).not.toHaveBeenCalled();

    mockAppLocked = false;
    mockAppLockEnabled = true;
    await expect(
      executeAppIntentRequest({ id: "3", action: "todayTasks", payload: {} })
    ).resolves.toEqual({ status: "locked", value: "" });
    expect(mockTodayList).not.toHaveBeenCalled();
  });

  test("completes the picked one of two Tasks that share a title", async () => {
    // The old exact-title lookup refused both of these. A picked record is
    // unambiguous by construction.
    const duplicates = [
      task("aaaaaaaaaaaaaaaaaaaaaaaa", { title: "Call Alex" }),
      task("bbbbbbbbbbbbbbbbbbbbbbbb", { title: "Call Alex" })
    ];
    mockTaskList.mockResolvedValue(duplicates);
    await expect(
      executeAppIntentRequest({
        id: "4",
        action: "completeTask",
        payload: { entityId: `${SCOPE}:bbbbbbbbbbbbbbbbbbbbbbbb` }
      })
    ).resolves.toEqual({
      status: "ok",
      value: "bbbbbbbbbbbbbbbbbbbbbbbb"
    });
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).toHaveBeenCalledWith("bbbbbbbbbbbbbbbbbbbbbbbb");
  });

  test("a Task identifier issued for another account names nothing here", async () => {
    mockTaskList.mockResolvedValue([task("aaaaaaaaaaaaaaaaaaaaaaaa")]);
    await expect(
      executeAppIntentRequest({
        id: "6",
        action: "completeTask",
        payload: {
          entityId: `${"f".repeat(32)}:aaaaaaaaaaaaaaaaaaaaaaaa`
        }
      })
    ).resolves.toEqual({ status: "notFound", value: "" });
    expect(mockGetTask).not.toHaveBeenCalled();
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  test("a saved Shortcut for a recurring Task completes the open occurrence", async () => {
    // Every occurrence has its own id, so the one the Shortcut stored stops
    // being the open one after the first run. Completion still goes through the
    // core operation that advances the series.
    const series = [
      task("aaaaaaaaaaaaaaaaaaaaaaaa", {
        title: "Water plants",
        completed: true,
        reminderDate: "2026-09-19"
      }),
      task("cccccccccccccccccccccccc", {
        title: "Water plants",
        seriesId: "aaaaaaaaaaaaaaaaaaaaaaaa",
        reminderDate: "2026-09-26"
      })
    ];
    mockTaskList.mockResolvedValue(series);
    await expect(
      executeAppIntentRequest({
        id: "7",
        action: "completeTask",
        payload: { entityId: `${SCOPE}:aaaaaaaaaaaaaaaaaaaaaaaa` }
      })
    ).resolves.toEqual({
      status: "ok",
      value: "cccccccccccccccccccccccc"
    });
    expect(mockCompleteTask).toHaveBeenCalledWith("cccccccccccccccccccccccc");
  });

  test("a completed Task with no open occurrence is not reported as completed now", async () => {
    mockTaskList.mockResolvedValue([
      task("aaaaaaaaaaaaaaaaaaaaaaaa", { completed: true })
    ]);
    await expect(
      executeAppIntentRequest({
        id: "8",
        action: "completeTask",
        payload: { entityId: `${SCOPE}:aaaaaaaaaaaaaaaaaaaaaaaa` }
      })
    ).resolves.toEqual({ status: "alreadyCompleted", value: "" });
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  test("App Lock withholds picker suggestions and saved-parameter titles", async () => {
    mockTaskList.mockResolvedValue([task("aaaaaaaaaaaaaaaaaaaaaaaa")]);
    mockAppLockEnabled = true;
    const ids = JSON.stringify([`${SCOPE}:aaaaaaaaaaaaaaaaaaaaaaaa`]);
    for (const action of ["suggestTasks", "resolveTasks"] as const)
      await expect(
        executeAppIntentRequest({ id: "9", action, payload: { ids } })
      ).resolves.toEqual({ status: "locked", value: "" });
    expect(mockTaskList).not.toHaveBeenCalled();
  });

  test("a headless process refuses an App Lock account before reading Tasks", async () => {
    // Nothing mounted the App component, so the unlocked default of the
    // in-memory flag must not be what decides this.
    mockAppLockEnabled = true;
    mockAppLoading = true;
    mockTaskList.mockResolvedValue([task("aaaaaaaaaaaaaaaaaaaaaaaa")]);
    await expect(
      executeAppIntentRequest({
        id: "10",
        action: "completeTask",
        payload: { entityId: `${SCOPE}:aaaaaaaaaaaaaaaaaaaaaaaa` }
      })
    ).resolves.toEqual({ status: "locked", value: "" });
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  test("picker suggestions describe each Task by List and schedule", async () => {
    mockTaskList.mockResolvedValue([
      task("aaaaaaaaaaaaaaaaaaaaaaaa", {
        title: "Call Alex",
        reminderDate: "2026-09-26"
      }),
      task("bbbbbbbbbbbbbbbbbbbbbbbb", { title: "Call Alex" }),
      task("cccccccccccccccccccccccc", { title: "Done", completed: true })
    ]);
    const reply = await executeAppIntentRequest({
      id: "11",
      action: "suggestTasks",
      payload: {}
    });
    expect(reply.status).toBe("ok");
    expect(JSON.parse(reply.value)).toEqual([
      {
        id: `${SCOPE}:aaaaaaaaaaaaaaaaaaaaaaaa`,
        title: "Call Alex",
        subtitle: expect.stringContaining("Personal")
      },
      {
        id: `${SCOPE}:bbbbbbbbbbbbbbbbbbbbbbbb`,
        title: "Call Alex",
        subtitle: "Personal"
      }
    ]);
  });

  test("a saved parameter resolves to the occurrence it would complete", async () => {
    const first = task("aaaaaaaaaaaaaaaaaaaaaaaa", {
      title: "Water plants",
      completed: true,
      reminderDate: "2026-09-19"
    });
    const next = task("cccccccccccccccccccccccc", {
      title: "Water plants",
      seriesId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      reminderDate: "2026-09-26"
    });
    mockTaskList.mockResolvedValue([first, next]);
    const reply = await executeAppIntentRequest({
      id: "13",
      action: "resolveTasks",
      payload: {
        ids: JSON.stringify([
          `${SCOPE}:aaaaaaaaaaaaaaaaaaaaaaaa`,
          `${SCOPE}:dddddddddddddddddddddddd`
        ])
      }
    });
    expect(reply.status).toBe("ok");
    // The identifier the Shortcut stored is kept, and a Task that no longer
    // exists resolves to nothing instead of to a guess.
    expect(JSON.parse(reply.value)).toEqual([
      {
        id: `${SCOPE}:aaaaaaaaaaaaaaaaaaaaaaaa`,
        title: "Water plants",
        subtitle: expect.stringContaining("Personal")
      }
    ]);
  });

  test("a widget snapshot that cannot be refreshed is not a failed completion", async () => {
    mockTaskList.mockResolvedValue([task("aaaaaaaaaaaaaaaaaaaaaaaa")]);
    mockWidgetUpdate.mockImplementationOnce(() => {
      throw new Error("no native widget bridge");
    });
    await expect(
      executeAppIntentRequest({
        id: "12",
        action: "completeTask",
        payload: { entityId: `${SCOPE}:aaaaaaaaaaaaaaaaaaaaaaaa` }
      })
    ).resolves.toEqual({
      status: "ok",
      value: "aaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(mockCompleteTask).toHaveBeenCalledWith("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("does not claim a scheduled Task was created when notification permission is denied", async () => {
    mockRequestPermission.mockResolvedValueOnce(false);
    await expect(
      executeAppIntentRequest({
        id: "5",
        action: "createTask",
        payload: {
          title: "Collect parcel",
          reminderTimestamp: String(new Date(2026, 9, 2, 14, 30).getTime())
        }
      })
    ).resolves.toEqual({ status: "unavailable", value: "" });
    expect(mockCreateTask).not.toHaveBeenCalled();
  });
});
