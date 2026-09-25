/*
This file is part of the Notesnook project (https://notesnook.com/)
Copyright (C) 2026 Streetwriters (Private) Limited
This program is free software under the GNU General Public License v3 or later.
*/

import type { Task } from "@notesnook/core";
import {
  availableTaskNotificationSlots,
  planTaskNotifications,
  taskNotificationId
} from "./task-notification-plan";

const NOW = 1_800_000_000_000;

function task(id: string, reminderAt?: number, completed = false): Task {
  return {
    id,
    title: id,
    reminderAt,
    completed,
    updatedAt: 42
  } as Task;
}

describe("Task notification reconciliation", () => {
  test("shares the pending notification budget with non-Task alerts", () => {
    expect(
      availableTaskNotificationSlots(
        ["legacy-1", "legacy-2", "task:old", "notesnook_note_input"],
        60
      )
    ).toBe(57);
    expect(availableTaskNotificationSlots(["legacy-1", "legacy-2"], 1)).toBe(0);
  });
  test("uses stable namespaced identifiers", () => {
    expect(taskNotificationId("a/b")).toBe("task:a/b");
  });

  test("schedules new, reschedules edited, and cancels completed or deleted", () => {
    const plan = planTaskNotifications(
      [
        task("new", NOW + 1000),
        task("edited", NOW + 2000),
        task("done", NOW + 3000, true)
      ],
      [
        { id: "task:edited", updatedAt: "41", timestamp: NOW + 2000 },
        { id: "task:done", updatedAt: "42", timestamp: NOW + 3000 },
        { id: "task:deleted", updatedAt: "42", timestamp: NOW + 4000 }
      ],
      NOW,
      50
    );
    expect(plan.schedule.map((item) => item.id)).toEqual(["new", "edited"]);
    expect(plan.cancelIds.sort()).toEqual([
      "task:deleted",
      "task:done",
      "task:edited"
    ]);
  });

  test("does not duplicate an unchanged trigger", () => {
    const plan = planTaskNotifications(
      [task("same", NOW + 1000)],
      [{ id: "task:same", updatedAt: "42", timestamp: NOW + 1000 }],
      NOW,
      50
    );
    expect(plan.schedule).toEqual([]);
    expect(plan.cancelIds).toEqual([]);
  });

  test("reschedules when App Lock changes notification title privacy", () => {
    const plan = planTaskNotifications(
      [task("private", NOW + 1000)],
      [{ id: "task:private", updatedAt: "42", timestamp: NOW + 1000 }],
      NOW,
      50,
      true
    );
    expect(plan.cancelIds).toEqual(["task:private"]);
    expect(plan.schedule.map((item) => item.id)).toEqual(["private"]);
  });

  test("schedules Urgent through one notification path", () => {
    const plan = planTaskNotifications(
      [
        { ...task("urgent-failed", NOW + 1000), urgent: true },
        { ...task("urgent-ok", NOW + 2000), urgent: true }
      ],
      [],
      NOW,
      50,
      false,
      true
    );
    expect(plan.schedule.map((item) => item.id)).toEqual([
      "urgent-failed",
      "urgent-ok"
    ]);
    expect(plan.schedule.every((item) => !item.urgentFallback)).toBe(true);
  });

  test("does not schedule Urgent while legacy alarms cannot be cleared", () => {
    const plan = planTaskNotifications(
      [
        {
          ...task("date-only", NOW + 1000),
          reminderAt: undefined,
          reminderDate: "2026-09-24",
          scheduleVersion: 2,
          urgent: true
        }
      ],
      [],
      Date.parse("2026-09-23T12:00:00"),
      50,
      false,
      false
    );
    expect(plan.schedule).toHaveLength(0);
  });
});
