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
    tasks: {
      get: jest.fn(),
      completeIfUnchanged: jest.fn(),
      update: jest.fn()
    }
  },
  DatabaseLogger: { error: jest.fn() }
}));
jest.mock("../stores/use-user-store", () => ({
  useUserStore: { getState: () => ({ user: { id: "account" } }) }
}));
jest.mock("./settings", () => ({
  __esModule: true,
  default: { get: () => ({ appLockEnabled: false }) }
}));
// The payload parser and the account decision have their own suite
// (`task-navigation.test.ts`); here their two pure outputs are stubbed so the
// *action* path can be driven end to end through the real gate.
jest.mock("./task-navigation", () => ({
  taskNotificationIntent: (data: Record<string, unknown> | undefined) =>
    data && typeof data.taskId === "string"
      ? {
          taskId: data.taskId,
          accountId: data.accountId || undefined,
          occurrenceKey: data.occurrenceKey || undefined,
          seriesId: data.seriesId || undefined,
          source: "notification"
        }
      : undefined,
  decideTaskIntentAccount: (
    intentAccountId: string | undefined,
    currentAccountId: string | null
  ) =>
    intentAccountId === undefined
      ? "accountless"
      : intentAccountId === currentAccountId
      ? "match"
      : "mismatch"
}));

import { db } from "../common/database";
import {
  runTaskNotificationAction,
  snoozedSchedule,
  TASK_ACTION_COMPLETE,
  TASK_ACTION_SNOOZE,
  taskActionApplies,
  type TaskActionTarget
} from "./task-notification-actions";

const database = db as unknown as {
  tasks: {
    get: jest.Mock;
    completeIfUnchanged: jest.Mock;
    update: jest.Mock;
  };
};

/**
 * The series' *first* record as core stores it: only the occurrences core
 * materializes later carry an `occurrenceKey`
 * (`packages/core/src/collections/tasks.ts#ensureNextOccurrence`), so this
 * record's own occurrence is `2026-10-20T09:00` (its reminder, in the timed
 * series derivation the planner uses).
 */
const legacySeriesHead: TaskActionTarget = {
  id: "legacy-series-head",
  completed: false,
  updatedAt: 42,
  recurrenceRule: "FREQ=DAILY",
  seriesId: "legacy-series-head",
  seriesStartDate: "2026-10-20",
  seriesStartTime: "09:00",
  scheduleVersion: 2,
  reminderDate: "2026-10-20",
  reminderTime: "09:00"
};

const initialOccurrenceKey = "2026-10-20T09:00";
const futureOccurrenceKey = "2026-10-21T09:00";

function legacyNotificationPayload(occurrenceKey: string) {
  return {
    type: "task",
    taskId: legacySeriesHead.id,
    updatedAt: String(legacySeriesHead.updatedAt),
    accountId: "account",
    occurrenceKey,
    seriesId: "legacy-series-head"
  };
}

beforeEach(() => {
  database.tasks.get.mockReset();
  database.tasks.completeIfUnchanged.mockReset();
  database.tasks.update.mockReset();
  database.tasks.get.mockResolvedValue(legacySeriesHead);
  database.tasks.completeIfUnchanged.mockResolvedValue(true);
  database.tasks.update.mockResolvedValue(legacySeriesHead);
});

describe("task notification actions", () => {
  it("snoozes to one hour from now across midnight", () => {
    expect(snoozedSchedule(new Date(2026, 8, 29, 23, 30))).toEqual({
      reminderDate: "2026-09-30",
      reminderTime: "00:30"
    });
  });

  it("applies only to the unchanged, open occurrence", () => {
    const task = {
      id: "task-a",
      completed: false,
      updatedAt: 42,
      occurrenceKey: "a"
    };
    expect(taskActionApplies(task, { updatedAt: "42", occurrenceKey: "a" })).toBe(
      true
    );
    expect(taskActionApplies(task, { updatedAt: "41" })).toBe(false);
    expect(taskActionApplies(task, { updatedAt: "42", occurrenceKey: "b" })).toBe(
      false
    );
    expect(
      taskActionApplies({ ...task, completed: true }, { updatedAt: "42" })
    ).toBe(false);
  });

  it("confirms a legacy notification for the record's own first occurrence", () => {
    // The payload names the occurrence this keyless record *is*, confirmed by
    // the same derivation the planner used to stamp the notification.
    expect(
      taskActionApplies(legacySeriesHead, {
        updatedAt: "42",
        occurrenceKey: initialOccurrenceKey
      })
    ).toBe(true);
  });

  it("refuses a legacy notification that names a future occurrence", () => {
    // The series has not materialized the occurrence yet, so there is no record
    // to apply the action to: completing or snoozing the head record would act
    // on a different occurrence of the series.
    expect(
      taskActionApplies(legacySeriesHead, {
        updatedAt: "42",
        occurrenceKey: futureOccurrenceKey
      })
    ).toBe(false);
  });

  it("refuses a future occurrence's complete action without touching the Task", async () => {
    const applied = await runTaskNotificationAction(
      TASK_ACTION_COMPLETE,
      legacyNotificationPayload(futureOccurrenceKey)
    );

    expect(applied).toBe(false);
    expect(database.tasks.completeIfUnchanged).not.toHaveBeenCalled();
  });

  it("refuses a future occurrence's snooze action without touching the Task", async () => {
    const applied = await runTaskNotificationAction(
      TASK_ACTION_SNOOZE,
      legacyNotificationPayload(futureOccurrenceKey)
    );

    expect(applied).toBe(false);
    expect(database.tasks.update).not.toHaveBeenCalled();
  });

  it("still completes and snoozes the legacy notification's own occurrence", async () => {
    const payload = legacyNotificationPayload(initialOccurrenceKey);

    expect(await runTaskNotificationAction(TASK_ACTION_COMPLETE, payload)).toBe(
      true
    );
    expect(database.tasks.completeIfUnchanged).toHaveBeenCalledWith(
      legacySeriesHead.id,
      42
    );

    expect(await runTaskNotificationAction(TASK_ACTION_SNOOZE, payload)).toBe(
      true
    );
    expect(database.tasks.update).toHaveBeenCalledTimes(1);
  });
});
