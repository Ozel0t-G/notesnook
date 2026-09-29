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

import type { Task } from "@notesnook/core";

let mockUserId: string | undefined = "account-a";

const mockSyncOverdueActivities = jest.fn(
  async (..._args: unknown[]): Promise<OverdueActivityResult> => ({
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
type AlarmReport = {
  status: "unsupported" | "notDetermined" | "denied" | "authorized";
  scheduledAlarmKeys?: string[];
};
type CancelReport = {
  status: AlarmReport["status"];
  cancelledAlarmKeys?: string[];
};

const mockReplaceAlarms = jest.fn(
  async (..._args: unknown[]): Promise<AlarmReport> => ({
    status: "authorized",
    scheduledAlarmKeys: []
  })
);
const mockVerifyAlarms = jest.fn(
  async (..._args: unknown[]): Promise<AlarmReport> => ({
    status: "authorized",
    scheduledAlarmKeys: []
  })
);
const mockCancelScheduledAlarms = jest.fn(
  async (..._args: unknown[]): Promise<CancelReport> => ({
    status: "authorized",
    cancelledAlarmKeys: []
  })
);
const mockCancelAll = jest.fn(async () => {});

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: {
    TaskAlarmModule: {
      replaceAlarms: (...args: unknown[]) => mockReplaceAlarms(...args),
      verifyAlarms: (...args: unknown[]) => mockVerifyAlarms(...args),
      cancelScheduledAlarms: (...args: unknown[]) =>
        mockCancelScheduledAlarms(...args),
      cancelAll: () => mockCancelAll(),
      syncOverdueActivities: (...args: unknown[]) =>
        mockSyncOverdueActivities(...args),
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
  desiredTaskAlarms
} from "./task-alarm-plan";
import {
  endOverdueActivities,
  reconcileTaskAlarmDelivery,
  runIndependentCleanup,
  syncOverdueActivities,
  type OverdueActivityResult
} from "./task-alarms";

const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000);
const tomorrowDate = `${tomorrow.getFullYear()}-${String(
  tomorrow.getMonth() + 1
).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

function recurringTask(id: string): Task {
  return {
    id,
    title: id,
    completed: false,
    urgent: true,
    scheduleVersion: 2,
    recurrenceRule: "FREQ=DAILY",
    seriesId: `series-${id}`,
    reminderDate: tomorrowDate,
    reminderTime: "14:00",
    seriesStartDate: tomorrowDate,
    seriesStartTime: "14:00",
    updatedAt: 42
  } as Task;
}

beforeEach(() => {
  mockUserId = "account-a";
  mockSyncOverdueActivities.mockClear();
  mockEndOverdueActivities.mockClear();
  mockReplaceAlarms.mockClear();
  mockVerifyAlarms.mockClear();
  mockCancelScheduledAlarms.mockClear();
  mockCancelAll.mockClear();
  mockReplaceAlarms.mockResolvedValue({
    status: "authorized",
    scheduledAlarmKeys: []
  });
  mockVerifyAlarms.mockResolvedValue({
    status: "authorized",
    scheduledAlarmKeys: []
  });
  mockCancelScheduledAlarms.mockResolvedValue({
    status: "authorized",
    cancelledAlarmKeys: []
  });
});

describe("Urgent Task alarm delivery", () => {
  test("keeps the account-scoped desired list and reports which occurrences the system holds", async () => {
    const delivery = await reconcileTaskAlarmDelivery([], false);

    expect(mockReplaceAlarms).toHaveBeenCalledWith("account-a", []);
    expect(delivery.status).toBe("authorized");
    expect(delivery.verified).toBe(true);
    expect([...delivery.scheduledAlarmKeys]).toEqual([]);
  });

  test("uses the current occurrence's own key, so one failed occurrence cannot fall back the whole series", async () => {
    const task = recurringTask("recurring");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    expect(wanted.length).toBeGreaterThan(2);
    // The native side scheduled every occurrence but the last one.
    mockReplaceAlarms.mockResolvedValueOnce({
      status: "authorized",
      scheduledAlarmKeys: wanted.slice(0, -1)
    });

    const delivery = await reconcileTaskAlarmDelivery([task], false);

    expect(delivery.verified).toBe(true);
    // The delivery answer is per occurrence: only the one whose alarm is
    // missing needs an audible fallback.
    expect(wanted.filter((key) => !delivery.scheduledAlarmKeys.has(key))).toEqual(
      [wanted[wanted.length - 1]]
    );
  });

  test("treats denied/unsupported as a verified 'nothing scheduled' answer, never as an error", async () => {
    mockReplaceAlarms.mockResolvedValueOnce({
      status: "denied" as const,
      scheduledAlarmKeys: ["task:should-be-ignored"]
    });

    const delivery = await reconcileTaskAlarmDelivery([], false);

    expect(delivery.status).toBe("denied");
    expect(delivery.verified).toBe(true);
    expect(delivery.scheduledAlarmKeys.size).toBe(0);
    expect(delivery.error).toBeUndefined();
    expect(mockVerifyAlarms).not.toHaveBeenCalled();
  });

  test("recovers an unknown reconcile by verifying what the system still holds", async () => {
    const task = recurringTask("recurring");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    mockReplaceAlarms.mockRejectedValueOnce(new Error("manager unavailable"));
    mockVerifyAlarms.mockResolvedValueOnce({
      status: "authorized" as const,
      scheduledAlarmKeys: wanted.slice(0, 2)
    });

    const delivery = await reconcileTaskAlarmDelivery([task], false);

    expect(mockVerifyAlarms).toHaveBeenCalledWith("account-a", wanted);
    expect(delivery.verified).toBe(true);
    expect([...delivery.scheduledAlarmKeys]).toEqual(wanted.slice(0, 2));
    // The original failure is still reported, so it is not silently swallowed.
    expect(delivery.error).toBeInstanceOf(Error);
    expect(mockCancelScheduledAlarms).not.toHaveBeenCalled();
  });

  test("cancels only not-yet-alerting alarms when even verification fails", async () => {
    const task = recurringTask("recurring");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    mockReplaceAlarms.mockRejectedValueOnce(new Error("replace failed"));
    mockVerifyAlarms.mockRejectedValueOnce(new Error("verify failed"));

    const delivery = await reconcileTaskAlarmDelivery([task], false);

    expect(mockCancelScheduledAlarms).toHaveBeenCalledWith(
      "account-a",
      wanted
    );
    // Verified cancellation: nothing future will sound, so a fallback for every
    // occurrence is safe and cannot duplicate an alarm.
    expect(delivery.verified).toBe(true);
    expect(delivery.scheduledAlarmKeys.size).toBe(0);
  });

  test("stays unverified when verification and cancellation both fail", async () => {
    const task = recurringTask("recurring");
    mockReplaceAlarms.mockRejectedValueOnce(new Error("replace failed"));
    mockVerifyAlarms.mockRejectedValueOnce(new Error("verify failed"));
    mockCancelScheduledAlarms.mockRejectedValueOnce(new Error("cancel failed"));

    const delivery = await reconcileTaskAlarmDelivery([task], false);

    // The caller must not schedule a duplicate audible fallback on this answer.
    expect(delivery.verified).toBe(false);
    expect(delivery.scheduledAlarmKeys.size).toBe(0);
    expect(delivery.error).toBeInstanceOf(Error);
  });
});

describe("independent Task surface cleanup", () => {
  test("attempts every mechanism even when an earlier one rejects", async () => {
    const ran: string[] = [];
    const failures = await runIndependentCleanup([
      {
        label: "task notifications",
        run: async () => {
          ran.push("notifications");
          throw new Error("cancel refused");
        }
      },
      {
        label: "native alarms",
        run: async () => {
          ran.push("alarms");
        }
      },
      {
        label: "overdue activities",
        run: async () => {
          ran.push("activities");
        }
      }
    ]);

    // A rejected notification cancellation must not leave the native alarms or
    // the Live Activity behind.
    expect(ran).toEqual(["notifications", "alarms", "activities"]);
    expect(failures).toEqual(["task notifications"]);
  });

  test("reports every failed mechanism and is clean when all succeed", async () => {
    expect(
      await runIndependentCleanup([
        { label: "a", run: async () => {} },
        { label: "b", run: async () => {} }
      ])
    ).toEqual([]);
    expect(
      await runIndependentCleanup([
        {
          label: "a",
          run: async () => {
            throw new Error("a");
          }
        },
        {
          label: "b",
          run: async () => {
            throw new Error("b");
          }
        }
      ])
    ).toEqual(["a", "b"]);
  });
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
});
