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

let mockUserId: string | undefined = "account-a";

const mockSyncOverdueActivities = jest.fn(
  async (): Promise<OverdueActivityResult> => ({
    status: "authorized",
    created: 1,
    updated: 0,
    ended: 0,
    failedTaskIds: []
  })
);
const mockEndOverdueActivities = jest.fn(async () => ({
  status: "authorized" as const,
  ended: 2
}));
const mockReplaceAlarms = jest.fn(async () => ({
  status: "authorized" as const,
  failedTaskIds: [] as string[]
}));
const mockCancelAll = jest.fn(async () => {});

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: {
    TaskAlarmModule: {
      replaceAlarms: (...args: unknown[]) => mockReplaceAlarms(...(args as [])),
      cancelAll: () => mockCancelAll(),
      syncOverdueActivities: (...args: unknown[]) =>
        mockSyncOverdueActivities(...(args as [])),
      endOverdueActivities: () => mockEndOverdueActivities()
    }
  }
}));

jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({ user: mockUserId ? { id: mockUserId } : undefined })
  }
}));

import {
  endOverdueActivities,
  reconcileTaskAlarms,
  syncOverdueActivities,
  type OverdueActivityResult
} from "./task-alarms";

beforeEach(() => {
  mockUserId = "account-a";
  mockSyncOverdueActivities.mockClear();
  mockEndOverdueActivities.mockClear();
  mockReplaceAlarms.mockClear();
});

describe("overdue Task Live Activity bridge", () => {
  test("hands the desired surfaces, the account and the App Lock flag to the native side", async () => {
    const surfaces = [{ taskId: "task-1", timestamp: 1700000000000, title: "Pay rent" }];

    const result = await syncOverdueActivities(surfaces, true);

    expect(mockSyncOverdueActivities).toHaveBeenCalledWith(
      "account-a",
      surfaces,
      true
    );
    expect(result).toEqual({
      status: "authorized",
      created: 1,
      updated: 0,
      ended: 0,
      failedTaskIds: []
    });
  });

  test("reports the Tasks the device could not show instead of assuming success", async () => {
    mockSyncOverdueActivities.mockResolvedValueOnce({
      status: "denied",
      created: 0,
      updated: 0,
      ended: 0,
      failedTaskIds: ["task-1", "task-2"]
    });

    const result = await syncOverdueActivities([
      { taskId: "task-1", timestamp: 1, title: "a" },
      { taskId: "task-2", timestamp: 2, title: "b" }
    ]);

    expect(result.status).toBe("denied");
    expect(result.failedTaskIds).toEqual(["task-1", "task-2"]);
  });

  test("scopes surfaces to the signed-in account, and to local data when signed out", async () => {
    mockUserId = undefined;

    await syncOverdueActivities([]);

    expect(mockSyncOverdueActivities).toHaveBeenCalledWith("local", [], false);
  });

  test("ends every overdue surface on request", async () => {
    const result = await endOverdueActivities();

    expect(mockEndOverdueActivities).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "authorized", ended: 2 });
  });

  test("keeps the alarm reconciliation path unchanged alongside the activity path", async () => {
    await reconcileTaskAlarms([], true);

    expect(mockReplaceAlarms).toHaveBeenCalledWith("account-a", []);
    expect(mockSyncOverdueActivities).not.toHaveBeenCalled();
  });
});
