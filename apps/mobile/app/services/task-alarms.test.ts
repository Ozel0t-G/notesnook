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
  activeAlarmKeys?: string[];
  unredactedAlarmKeys?: string[];
};
type CancelReport = {
  status: AlarmReport["status"];
  cancelledAlarmKeys?: string[];
  retainedAlarmKeys?: string[];
  notFoundAlarmKeys?: string[];
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

// The opaque account scope is the widget's random token; here it is fixed so
// the native call is assertable. The MMKV store is faked so this suite never
// loads the real native-backed storage.
jest.mock("../common/database/mmkv", () => ({
  MMKV: {
    getString: () => null,
    setString: () => {},
    removeItem: () => {}
  }
}));

/** Deterministic stand-in for `taskWidgetAccountScope`. */
const ACCOUNT_SCOPE = "a".repeat(32);
jest.mock("../hooks/task-widget-completion-intents", () => ({
  taskWidgetAccountScope: () => "a".repeat(32)
}));

import { desiredTaskAlarms } from "./task-alarm-plan";
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

/** A withdrawal that reports every asked key as verifiably withdrawn. */
const withdrawnAll = { withdraw: jest.fn(async () => new Set<string>()) };

beforeEach(() => {
  mockUserId = "account-a";
  mockSyncOverdueActivities.mockClear();
  mockEndOverdueActivities.mockClear();
  mockReplaceAlarms.mockClear();
  mockVerifyAlarms.mockClear();
  mockCancelScheduledAlarms.mockClear();
  mockCancelAll.mockClear();
  withdrawnAll.withdraw.mockClear();
  mockReplaceAlarms.mockImplementation(
    async (_accountId, _accountScope, alarms) => ({
      status: "authorized",
      scheduledAlarmKeys: (alarms as { alarmKey: string }[]).map(
        (alarm) => alarm.alarmKey
      ),
      activeAlarmKeys: []
    })
  );
  mockVerifyAlarms.mockResolvedValue({
    status: "authorized",
    scheduledAlarmKeys: [],
    activeAlarmKeys: []
  });
  mockCancelScheduledAlarms.mockResolvedValue({
    status: "authorized",
    cancelledAlarmKeys: [],
    retainedAlarmKeys: []
  });
});

describe("Urgent Task alarm delivery", () => {
  test("keeps the account-scoped desired list and reports which occurrences the system holds", async () => {
    const delivery = await reconcileTaskAlarmDelivery([], false, withdrawnAll);

    expect(mockReplaceAlarms).toHaveBeenCalledWith(
      "account-a",
      ACCOUNT_SCOPE,
      []
    );
    expect(delivery.status).toBe("authorized");
    expect(delivery.verified).toBe(true);
    expect([...delivery.heldAlarmKeys]).toEqual([]);
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

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawnAll);

    expect(delivery.verified).toBe(true);
    // Only the occurrence whose alarm is missing is *proven* not held, so only
    // that one may gain an audible fallback.
    expect([...delivery.absentAlarmKeys]).toEqual([wanted[wanted.length - 1]]);
  });

  test("withdraws a competing fallback before the alarm is written, and reports the unwithdrawn key", async () => {
    const task = recurringTask("gate");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    // The first occurrence's fallback cannot be confirmed withdrawn.
    const withdrawal = {
      withdraw: jest.fn(async () => new Set([wanted[0]]))
    };

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawal);

    expect(withdrawal.withdraw).toHaveBeenCalledWith(wanted);
    // Only the occurrences whose fallback is verifiably gone are introduced.
    const sent = mockReplaceAlarms.mock.calls[0][2] as {
      alarmKey: string;
    }[];
    expect(sent.map((alarm) => alarm.alarmKey)).toEqual(wanted.slice(1));
    // The blocked occurrence keeps its notification as the sole delivery, so it
    // is still a fallback candidate and was never claimed as alarmed.
    expect([...delivery.absentAlarmKeys]).toEqual([wanted[0]]);
    expect([...delivery.heldAlarmKeys]).toEqual(wanted.slice(1));
  });

  test("introduces nothing new when the withdrawal itself throws", async () => {
    const task = recurringTask("gate-throws");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    const withdrawal = {
      withdraw: jest.fn(async () => {
        throw new Error("trigger store unavailable");
      })
    };

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawal);

    expect(mockReplaceAlarms.mock.calls[0][2]).toEqual([]);
    expect([...delivery.absentAlarmKeys]).toEqual(wanted);
  });

  test("reads the native state first and writes nothing when it cannot be read", async () => {
    const task = recurringTask("unreadable");
    mockVerifyAlarms.mockRejectedValueOnce(new Error("manager unavailable"));

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawnAll);

    expect(mockVerifyAlarms).toHaveBeenCalledTimes(1);
    expect(mockReplaceAlarms).not.toHaveBeenCalled();
    expect(withdrawnAll.withdraw).not.toHaveBeenCalled();
    // Ambiguous, so nothing is held and nothing is proven absent: the caller
    // keeps every existing fallback and creates no new one.
    expect(delivery.verified).toBe(false);
    expect(delivery.absentAlarmKeys.size).toBe(0);
    expect(delivery.heldAlarmKeys.size).toBe(0);
    expect(delivery.error).toBeInstanceOf(Error);
  });

  test("cleans held alarms up when authorization was revoked, without falling back for the ones still presenting", async () => {
    const task = recurringTask("revoked");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    mockVerifyAlarms.mockResolvedValueOnce({
      status: "denied",
      scheduledAlarmKeys: wanted,
      activeAlarmKeys: [wanted[0]]
    });
    mockCancelScheduledAlarms.mockResolvedValueOnce({
      status: "denied",
      cancelledAlarmKeys: wanted.slice(1),
      retainedAlarmKeys: [wanted[0]]
    });

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawnAll);

    expect(mockReplaceAlarms).not.toHaveBeenCalled();
    // The snoozed/alerting occurrence still owns its delivery; the cancelled
    // ones are the only occurrences that may become notifications.
    expect([...delivery.heldAlarmKeys]).toEqual([wanted[0]]);
    expect([...delivery.activeAlarmKeys]).toEqual([wanted[0]]);
    expect([...delivery.absentAlarmKeys].sort()).toEqual(wanted.slice(1).sort());
    expect(delivery.verified).toBe(true);
  });

  test("treats an unreachable revoked-alarm cleanup as still held", async () => {
    const task = recurringTask("revoked-cancel-fails");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    mockVerifyAlarms.mockResolvedValueOnce({
      status: "denied",
      scheduledAlarmKeys: wanted
    });
    mockCancelScheduledAlarms.mockRejectedValueOnce(new Error("cancel failed"));

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawnAll);

    expect([...delivery.heldAlarmKeys].sort()).toEqual([...wanted].sort());
    expect(delivery.absentAlarmKeys.size).toBe(0);
    expect(delivery.error).toBeInstanceOf(Error);
  });

  test("recovers a lost replace answer by verifying what the system still holds", async () => {
    const task = recurringTask("recurring");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    mockReplaceAlarms.mockRejectedValueOnce(new Error("manager unavailable"));
    mockVerifyAlarms
      .mockResolvedValueOnce({ status: "authorized", scheduledAlarmKeys: [] })
      .mockResolvedValueOnce({
        status: "authorized",
        scheduledAlarmKeys: wanted.slice(0, 2)
      });

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawnAll);

    expect(mockVerifyAlarms).toHaveBeenLastCalledWith("account-a", wanted);
    expect(delivery.verified).toBe(true);
    expect([...delivery.heldAlarmKeys]).toEqual(wanted.slice(0, 2));
    expect([...delivery.absentAlarmKeys].sort()).toEqual(
      wanted.slice(2).sort()
    );
    // The original failure is still reported, so it is not silently swallowed.
    expect(delivery.error).toBeInstanceOf(Error);
    expect(mockCancelScheduledAlarms).not.toHaveBeenCalled();
  });

  test("cancels only not-yet-alerting alarms when even verification fails, and reports what it retained", async () => {
    const task = recurringTask("recurring");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    mockReplaceAlarms.mockRejectedValueOnce(new Error("replace failed"));
    // The first (read) verification succeeds; the retry after the failed write
    // is the one that fails.
    mockVerifyAlarms
      .mockResolvedValueOnce({ status: "authorized", scheduledAlarmKeys: [] })
      .mockRejectedValueOnce(new Error("verify failed"));
    mockCancelScheduledAlarms.mockResolvedValueOnce({
      status: "authorized",
      cancelledAlarmKeys: wanted.slice(1),
      retainedAlarmKeys: [wanted[0]]
    });

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawnAll);

    expect(mockCancelScheduledAlarms).toHaveBeenCalledWith(
      "account-a",
      wanted
    );
    // Cancelled occurrences are provably silent, so their fallback is safe;
    // the retained one is still going to alert and gets none.
    expect([...delivery.absentAlarmKeys].sort()).toEqual(
      wanted.slice(1).sort()
    );
    expect([...delivery.heldAlarmKeys]).toEqual([wanted[0]]);
    expect(delivery.verified).toBe(true);
  });

  test("stays unverified when verification and cancellation both fail", async () => {
    const task = recurringTask("recurring");
    mockReplaceAlarms.mockRejectedValueOnce(new Error("replace failed"));
    mockVerifyAlarms
      .mockResolvedValueOnce({ status: "authorized", scheduledAlarmKeys: [] })
      .mockRejectedValueOnce(new Error("verify failed"));
    mockCancelScheduledAlarms.mockRejectedValueOnce(new Error("cancel failed"));

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawnAll);

    // The caller must not schedule a duplicate audible fallback on this answer.
    expect(delivery.verified).toBe(false);
    expect(delivery.absentAlarmKeys.size).toBe(0);
    expect(delivery.heldAlarmKeys.size).toBe(0);
    expect(delivery.error).toBeInstanceOf(Error);
  });

  test("surfaces an unredacted held alarm instead of claiming the redaction succeeded", async () => {
    const task = recurringTask("unredacted");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    // The device holds the occurrence but could not redact a presentation that
    // was already on screen.
    mockReplaceAlarms.mockResolvedValueOnce({
      status: "authorized",
      scheduledAlarmKeys: [wanted[0]],
      activeAlarmKeys: [wanted[0]],
      unredactedAlarmKeys: [wanted[0]]
    });

    const delivery = await reconcileTaskAlarmDelivery([task], true, withdrawnAll);

    expect([...delivery.unredactedAlarmKeys]).toEqual([wanted[0]]);
    // The occurrence is still *held*, so it must not also gain a fallback; only
    // the honesty of the answer changes.
    expect(delivery.heldAlarmKeys.has(wanted[0])).toBe(true);
    expect(delivery.absentAlarmKeys.has(wanted[0])).toBe(false);
    expect(delivery.verified).toBe(true);
  });

  test("classifies a requested key the system no longer holds as provably absent", async () => {
    const task = recurringTask("gone");
    const wanted = desiredTaskAlarms([task], false).map(
      (alarm) => alarm.alarmKey
    );
    mockReplaceAlarms.mockRejectedValueOnce(new Error("replace failed"));
    mockVerifyAlarms
      .mockResolvedValueOnce({ status: "authorized", scheduledAlarmKeys: [] })
      .mockRejectedValueOnce(new Error("verify failed"));
    mockCancelScheduledAlarms.mockResolvedValueOnce({
      status: "authorized",
      cancelledAlarmKeys: [wanted[0]],
      retainedAlarmKeys: [],
      notFoundAlarmKeys: [wanted[1]]
    });

    const delivery = await reconcileTaskAlarmDelivery([task], false, withdrawnAll);

    // A cancelled occurrence *and* one the system simply does not hold are both
    // provably silent, so their fallback cannot duplicate anything; everything
    // else is unanswered and gains no second delivery.
    expect([...delivery.absentAlarmKeys].sort()).toEqual(
      [wanted[0], wanted[1]].sort()
    );
    expect([...delivery.heldAlarmKeys]).toEqual([]);
  });

  test("reports a non-authorized pass as a complete 'no alarm' answer when nothing is held", async () => {
    mockVerifyAlarms.mockResolvedValueOnce({
      status: "denied",
      scheduledAlarmKeys: ["task:should-be-ignored"]
    });

    const delivery = await reconcileTaskAlarmDelivery([], false, withdrawnAll);

    expect(delivery.status).toBe("denied");
    expect(delivery.verified).toBe(true);
    expect(delivery.heldAlarmKeys.size).toBe(0);
    expect(mockCancelScheduledAlarms).not.toHaveBeenCalled();
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
    const surfaces = [
      {
        taskId: "task-1",
        timestamp: 1700000000000,
        title: "Pay rent",
        updatedAt: 1,
        alarmKey: "task:task-1"
      }
    ];

    const result = await syncOverdueActivities(surfaces, true);

    expect(mockSyncOverdueActivities).toHaveBeenCalledWith(
      "account-a",
      surfaces,
      true,
      ACCOUNT_SCOPE
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
      {
        taskId: "task-1",
        timestamp: 1,
        title: "a",
        updatedAt: 1,
        alarmKey: "task:task-1"
      },
      {
        taskId: "task-2",
        timestamp: 2,
        title: "b",
        updatedAt: 1,
        alarmKey: "task:task-2"
      }
    ]);

    expect(result.status).toBe("denied");
    expect(result.failedTaskIds).toEqual(["task-1", "task-2"]);
  });

  test("scopes surfaces to the signed-in account, and to local data when signed out", async () => {
    mockUserId = undefined;

    await syncOverdueActivities([]);

    expect(mockSyncOverdueActivities).toHaveBeenCalledWith(
      "local",
      [],
      false,
      ACCOUNT_SCOPE
    );
  });

  test("ends every overdue surface on request", async () => {
    const result = await endOverdueActivities();

    expect(mockEndOverdueActivities).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "authorized", ended: 2 });
  });
});
