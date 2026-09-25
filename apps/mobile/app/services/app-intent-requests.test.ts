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
const mockCreateTask = jest.fn(async (_input: unknown) => ({ id: "saved-task" }));
const mockCompleteTask = jest.fn(async (_id: string) => {});
const mockAddNote = jest.fn(async (_input: unknown) => "saved-note");
const mockTaskList = jest.fn(
  async (): Promise<Array<{ id: string; title: string; completed: boolean }>> =>
    []
);
const mockTodayList = jest.fn(async () => [{ title: "Pay invoice" }]);
const mockTaskLists = jest.fn(async () => [
  { id: "personal", name: "Personal" }
]);
const mockRequestPermission = jest.fn(async () => true);

jest.mock("../common/database", () => ({
  db: {
    isInitialized: true,
    taskLists: {
      default: async () => ({ id: "default" }),
      list: () => mockTaskLists()
    },
    tasks: {
      create: (input: unknown) => mockCreateTask(input),
      complete: (id: string) => mockCompleteTask(id),
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
    getState: () => ({ settings: { appLockEnabled: mockAppLockEnabled } })
  }
}));
jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({ appLocked: mockAppLocked, isLoggingOut: false })
  }
}));

import { executeAppIntentRequest } from "./app-intent-requests";

beforeEach(() => {
  mockAppLocked = false;
  mockAppLockEnabled = false;
  jest.clearAllMocks();
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

  test("does not complete a Task when an exact title identifies two Tasks", async () => {
    mockTaskList.mockResolvedValueOnce([
      { id: "one", title: "Call Alex", completed: false },
      { id: "two", title: "call alex", completed: false }
    ]);
    await expect(
      executeAppIntentRequest({
        id: "4",
        action: "completeTask",
        payload: { title: "Call Alex" }
      })
    ).resolves.toEqual({ status: "ambiguous", value: "" });
    expect(mockCompleteTask).not.toHaveBeenCalled();
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
