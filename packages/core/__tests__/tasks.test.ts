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

import { describe, expect, test, vi } from "vitest";
import { databaseTest, loginFakeUser } from "./utils/index.js";
import {
  isTaskOverdue,
  taskReminderSchedule,
  taskReminderTimestamp,
  Tasks
} from "../src/collections/tasks.js";
import Collector from "../src/api/sync/collector.js";
import { Sync } from "../src/api/sync/index.js";

async function atTime<T>(time: number, action: () => Promise<T>): Promise<T> {
  const clock = vi.spyOn(Date, "now").mockReturnValue(time);
  try {
    return await action();
  } finally {
    clock.mockRestore();
  }
}

describe("standalone Tasks", () => {
  test("Task favorites preserve order and an explicit empty selection", async () => {
    const db = await databaseTest();
    expect(await db.taskFavorites.list()).toEqual([
      "smart:today",
      "smart:scheduled",
      "smart:all",
      "smart:flagged",
      "smart:completed"
    ]);
    const work = await db.taskLists.create({
      name: "Work",
      symbol: "briefcase",
      color: "indigo"
    });
    expect(work).toEqual(
      expect.objectContaining({ symbol: "briefcase", color: "indigo" })
    );
    await db.taskFavorites.set([`list:${work.id}`, "smart:today"]);
    expect(db.taskFavorites.listSync()).toEqual([
      `list:${work.id}`,
      "smart:today"
    ]);
    const defaultList = await db.taskLists.default();
    await db.taskFavorites.set([`list:${defaultList.id}`, `list:${work.id}`]);
    expect(db.taskFavorites.listSync()).toEqual([
      `list:${defaultList.id}`,
      `list:${work.id}`
    ]);
    await db.taskFavorites.set([]);
    expect(db.taskFavorites.listSync()).toEqual([]);
    await expect(
      db.taskFavorites.set(["smart:today", "smart:today"])
    ).rejects.toThrow();
    await expect(
      db.taskLists.create({ name: "Bad", symbol: "invalid" })
    ).rejects.toThrow();
  });

  test("create rejects an existing Task ID and a tombstoned ID", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({ title: "Original" });
    await expect(
      db.tasks.create({ id: task.id, title: "Replacement" })
    ).rejects.toThrow("already exists or was deleted");
    expect((await db.tasks.get(task.id))?.title).toBe("Original");
    await db.tasks.remove(task.id);
    await expect(
      db.tasks.create({ id: task.id, title: "Resurrection" })
    ).rejects.toThrow("already exists or was deleted");
    expect(await db.tasks.get(task.id)).toBeUndefined();
  });

  test("Task maintenance failure does not block Notes database startup", async () => {
    const reconcile = vi
      .spyOn(Tasks.prototype, "reconcile")
      .mockRejectedValueOnce(new Error("Task migration failed"));
    try {
      const db = await databaseTest();
      expect(db.isInitialized).toBe(true);
      const id = await db.notes.add({ title: "Notes still work" });
      expect(id).toBeTruthy();
    } finally {
      reconcile.mockRestore();
    }
  });

  test("CRUD, lists, completion history, flag and priority", async () => {
    const db = await databaseTest();
    const list = await db.taskLists.create({ name: "Work", color: "#ff0000" });
    const task = await db.tasks.create({ title: "Report", listId: list.id });
    expect(task.id).toBeTruthy();
    expect(task.priority).toBe("none");
    const edited = await db.tasks.update(task.id, {
      title: "Updated",
      priority: "high",
      flagged: true
    });
    expect(edited.title).toBe("Updated");
    expect(
      (await db.tasks.smartList("flagged")).map((item) => item.id)
    ).toContain(task.id);
    await db.tasks.complete(task.id);
    expect(
      (await db.tasks.smartList("completed")).map((item) => item.id)
    ).toContain(task.id);
    expect(
      (await db.tasks.smartList("all")).map((item) => item.id)
    ).not.toContain(task.id);
    await db.tasks.uncomplete(task.id);
    expect((await db.tasks.get(task.id))?.completedAt).toBeUndefined();
    const fallback = await db.taskLists.default();
    await db.taskLists.remove(list.id);
    expect((await db.tasks.get(task.id))?.listId).toBe(fallback.id);
    await db.tasks.remove(task.id);
    expect(await db.tasks.get(task.id)).toBeUndefined();
  });

  test("guarded completion rejects an edit queued first, even in the same millisecond", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({ title: "Original" });
    const [edited, completed] = await atTime(task.updatedAt, () =>
      Promise.all([
        db.tasks.update(task.id, { title: "Edited" }),
        db.tasks.completeIfUnchanged(task.id, task.updatedAt)
      ])
    );
    expect(edited.updatedAt).toBeGreaterThan(task.updatedAt);
    expect(completed).toBeUndefined();
    expect(await db.tasks.get(task.id)).toMatchObject({
      title: "Edited",
      completed: false
    });
    await db.tasks.complete(task.id);
    expect((await db.tasks.get(task.id))?.completed).toBe(true);
  });

  test("date-only and independent reminder survive storage", async () => {
    const db = await databaseTest();
    const reminderAt = new Date(2026, 9, 24, 9).getTime();
    const task = await db.tasks.create({
      title: "Halloween",
      dueDate: "2026-10-31",
      reminderAt
    });
    expect((await db.tasks.get(task.id))?.dueDate).toBe("2026-10-31");
    expect((await db.tasks.get(task.id))?.dueTime).toBeUndefined();
    expect((await db.tasks.get(task.id))?.reminderAt).toBe(reminderAt);
    await db.tasks.update(task.id, {
      dueDate: undefined,
      reminderAt: undefined
    });
    expect((await db.tasks.get(task.id))?.dueDate).toBeUndefined();
    expect((await db.tasks.get(task.id))?.reminderAt).toBeUndefined();
  });

  test("new reminder schedule is authoritative and date-only alerts use 09:00 local", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Call Ada",
      reminderDate: "2026-10-31",
      reminderTime: "14:30"
    });
    expect(task).toMatchObject({
      reminderDate: "2026-10-31",
      reminderTime: "14:30",
      dueDate: "2026-10-31",
      dueTime: "14:30",
      scheduleVersion: 2
    });
    expect(taskReminderTimestamp(task)).toBe(
      new Date(2026, 9, 31, 14, 30).getTime()
    );
    const dateOnly = await db.tasks.update(task.id, {
      reminderDate: "2026-11-01",
      reminderTime: undefined
    });
    expect(dateOnly.dueTime).toBeUndefined();
    expect(taskReminderTimestamp(dateOnly)).toBe(
      new Date(2026, 10, 1, 9).getTime()
    );
    expect(taskReminderSchedule(dateOnly)).toEqual({
      date: "2026-11-01",
      time: undefined
    });
    const off = await db.tasks.update(task.id, {
      reminderDate: undefined,
      reminderTime: undefined
    });
    expect(taskReminderTimestamp(off)).toBeUndefined();
    expect(off.dueDate).toBeUndefined();
  });

  test("legacy due-only rows project to a reminder without a sync rewrite", async () => {
    const db = await databaseTest();
    const dueOnly = await db.tasks.create({
      title: "Date only",
      dueDate: "2026-12-24"
    });
    const timed = await db.tasks.create({
      title: "Timed",
      dueDate: "2026-12-25",
      dueTime: "16:00"
    });
    const explicitAt = new Date(2026, 11, 20, 13).getTime();
    const both = await db.tasks.create({
      title: "Explicit wins",
      dueDate: "2026-12-31",
      reminderAt: explicitAt
    });
    await db.tasks.reconcile();
    await db.tasks.reconcile();
    expect((await db.tasks.get(dueOnly.id))?.scheduleVersion).toBeUndefined();
    expect(taskReminderSchedule((await db.tasks.get(dueOnly.id))!)).toEqual({
      date: "2026-12-24",
      time: undefined
    });
    expect((await db.tasks.get(dueOnly.id))?.reminderTime).toBeUndefined();
    expect(taskReminderSchedule((await db.tasks.get(timed.id))!)).toEqual({
      date: "2026-12-25",
      time: "16:00"
    });
    expect(taskReminderTimestamp((await db.tasks.get(both.id))!)).toBe(
      explicitAt
    );
    expect(taskReminderSchedule((await db.tasks.get(both.id))!)).toEqual({
      date: "2026-12-20",
      time: "13:00"
    });
  });

  test("a legacy recurring lead survives conversion and later occurrences", async () => {
    const db = await databaseTest();
    const firstReminder = new Date(2026, 9, 23, 18).getTime();
    const old = await db.tasks.create({
      title: "Weekly report",
      dueDate: "2026-10-30",
      dueTime: "18:00",
      reminderAt: firstReminder,
      recurrenceRule: "FREQ=WEEKLY;BYDAY=FR"
    });
    const edited = await db.tasks.update(old.id, {
      reminderDate: "2026-10-23",
      reminderTime: "17:00"
    });
    expect(edited.dueDate).toBe("2026-10-30");
    expect(edited.reminderLeadMinutes).toBe(7 * 24 * 60 + 60);
    await atTime(new Date(2026, 9, 30, 19).getTime(), () =>
      db.tasks.complete(old.id)
    );
    const [next] = await db.tasks.smartList("all");
    expect(next.dueDate).toBe("2026-11-06");
    expect(next.reminderDate).toBe("2026-10-30");
    expect(next.reminderTime).toBe("17:00");
  });

  test("urgent requires a timed reminder and recurrence keeps delivery intent", async () => {
    const db = await databaseTest();
    await expect(
      db.tasks.create({
        title: "Morning alarm",
        reminderDate: "2026-10-24",
        urgent: true
      })
    ).rejects.toThrow("requires a reminder date and time");
    const task = await db.tasks.create({
      title: "Morning alarm",
      reminderDate: "2026-10-24",
      reminderTime: "07:00",
      urgent: true,
      recurrenceRule: "FREQ=DAILY"
    });
    await atTime(new Date(2026, 9, 24, 8).getTime(), () =>
      db.tasks.complete(task.id)
    );
    const [next] = await db.tasks.smartList("all");
    expect(next).toMatchObject({
      reminderDate: "2026-10-25",
      reminderTime: "07:00",
      urgent: true
    });
  });

  test("today retains overdue tasks and scheduled shows future tasks", async () => {
    const db = await databaseTest();
    const overdue = await db.tasks.create({
      title: "Overdue",
      dueDate: "2026-01-01"
    });
    const future = await db.tasks.create({
      title: "Future",
      dueDate: "2026-12-01"
    });
    const overdueWithFutureReminder = await db.tasks.create({
      title: "Overdue with a future reminder",
      dueDate: "2026-01-01",
      reminderAt: new Date(2026, 10, 1, 9).getTime()
    });
    const today = await db.tasks.smartList("today", new Date(2026, 8, 24));
    expect(today.map((item) => item.id)).toContain(overdue.id);
    expect(today.map((item) => item.id)).not.toContain(
      overdueWithFutureReminder.id
    );
    expect(today.map((item) => item.id)).not.toContain(future.id);
    const scheduled = (
      await db.tasks.smartList("scheduled", new Date(2026, 8, 24))
    ).map((item) => item.id);
    expect(scheduled).toContain(future.id);
    expect(scheduled).toContain(overdueWithFutureReminder.id);
    expect(isTaskOverdue(overdue, new Date(2026, 8, 24))).toBe(true);
    expect(isTaskOverdue(future, new Date(2026, 8, 24))).toBe(false);
    const dateOnly = await db.tasks.create({
      title: "Today",
      dueDate: "2026-09-24"
    });
    expect(isTaskOverdue(dateOnly, new Date(2026, 8, 24, 23, 59))).toBe(false);
    expect(isTaskOverdue(dateOnly, new Date(2026, 8, 25))).toBe(true);
  });

  test("date-only due date remains a calendar date across timezone changes", async () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Europe/Oslo";
      const db = await databaseTest();
      const task = await db.tasks.create({
        title: "Date only",
        dueDate: "2026-10-31"
      });
      process.env.TZ = "America/Los_Angeles";
      expect((await db.tasks.get(task.id))?.dueDate).toBe("2026-10-31");
      expect(isTaskOverdue(task, new Date(2026, 9, 31, 23, 59))).toBe(false);
    } finally {
      process.env.TZ = original;
    }
  });

  test.each([
    ["FREQ=DAILY", "2026-03-07", "2026-03-08"],
    ["FREQ=WEEKLY;BYDAY=FR", "2026-03-06", "2026-03-13"],
    ["FREQ=MONTHLY;BYDAY=-1FR", "2026-01-30", "2026-02-27"],
    ["FREQ=YEARLY", "2026-10-31", "2027-10-31"]
  ])("recurrence %s advances from schedule", async (rule, start, next) => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Repeat",
      dueDate: start,
      dueTime: "09:00",
      recurrenceRule: rule
    });
    await atTime(new Date(`${start}T12:00:00`).getTime(), () =>
      db.tasks.complete(task.id)
    );
    const history = await db.tasks.list();
    const active = history.filter((item) => !item.completed);
    expect(active).toHaveLength(1);
    expect(active[0].dueDate).toBe(next);
    expect(active[0].dueTime).toBe("09:00");
    expect(history.filter((item) => item.completed)).toHaveLength(1);
    await db.tasks.complete(task.id);
    expect(
      (await db.tasks.list()).filter((item) => !item.completed)
    ).toHaveLength(1);
    await expect(db.tasks.uncomplete(task.id)).rejects.toThrow(
      "next occurrence exists"
    );
  });

  test("late weekly completion keeps the Friday schedule and shifts reminder", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Friday",
      dueDate: "2026-10-30",
      dueTime: "18:00",
      reminderAt: new Date(2026, 9, 23, 18).getTime(),
      recurrenceRule: "FREQ=WEEKLY;BYDAY=FR"
    });
    await atTime(new Date(2026, 10, 1, 12).getTime(), () =>
      db.tasks.complete(task.id)
    );
    const next = (await db.tasks.smartList("all"))[0];
    expect(next.dueDate).toBe("2026-11-06");
    expect(next.reminderAt).toBe(new Date(2026, 9, 30, 18).getTime());
  });

  test("editing one recurring due date and time retains the series schedule", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Friday series",
      dueDate: "2026-03-06",
      dueTime: "09:00",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=FR"
    });
    const moved = await db.tasks.update(task.id, {
      dueDate: "2026-03-07"
    });
    expect(moved.seriesStartDate).toBe("2026-03-06");
    const edited = await db.tasks.update(task.id, {
      dueTime: "15:00",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=FR"
    });
    expect(edited.seriesStartDate).toBe("2026-03-06");
    expect(edited.seriesStartTime).toBe("09:00");
    await atTime(new Date(2026, 2, 8, 12).getTime(), () =>
      db.tasks.complete(task.id)
    );
    expect((await db.tasks.smartList("all"))[0]).toMatchObject({
      dueDate: "2026-03-13",
      dueTime: "09:00",
      seriesStartDate: "2026-03-06",
      seriesStartTime: "09:00"
    });
  });

  test("late completion skips missed timed occurrences without moving the anchor", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Daily",
      dueDate: "2026-03-07",
      dueTime: "09:00",
      reminderAt: new Date(2026, 2, 6, 9).getTime(),
      recurrenceRule: "FREQ=DAILY"
    });
    await atTime(new Date(2026, 8, 24, 12).getTime(), () =>
      db.tasks.complete(task.id)
    );
    const [next] = await db.tasks.smartList("all");
    expect(next.dueDate).toBe("2026-09-25");
    expect(next.dueTime).toBe("09:00");
    expect(next.reminderAt).toBe(new Date(2026, 8, 24, 9).getTime());
    await db.tasks.reconcileRecurrence();
    await db.tasks.complete(task.id);
    expect((await db.tasks.smartList("all")).map((item) => item.id)).toEqual([
      next.id
    ]);
    expect(await db.tasks.smartList("completed")).toHaveLength(1);
  });

  test("late completion of a date-only series keeps today's occurrence", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Daily date-only",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY"
    });
    await atTime(new Date(2026, 8, 24, 12).getTime(), () =>
      db.tasks.complete(task.id)
    );
    const [next] = await db.tasks.smartList("all");
    expect(next.dueDate).toBe("2026-09-24");
    expect(next.dueTime).toBeUndefined();
  });

  test("recurrence recovery uses the stored completion wall date after a timezone change", async () => {
    const originalZone = process.env.TZ;
    try {
      process.env.TZ = "Europe/Oslo";
      const db = await databaseTest();
      const task = await db.tasks.create({
        title: "Date-only recovery",
        dueDate: "2026-03-07",
        recurrenceRule: "FREQ=DAILY"
      });
      const originalUpsert = db.settings.collection.upsert.bind(
        db.settings.collection
      );
      let writes = 0;
      const upsert = vi
        .spyOn(db.settings.collection, "upsert")
        .mockImplementation(async (item) => {
          if (++writes === 2) throw new Error("interrupted");
          return originalUpsert(item);
        });
      try {
        await expect(
          atTime(new Date(2026, 2, 10, 0, 30).getTime(), () =>
            db.tasks.complete(task.id)
          )
        ).rejects.toThrow("interrupted");
      } finally {
        upsert.mockRestore();
      }
      expect((await db.tasks.get(task.id))?.completedWallDate).toBe(
        "2026-03-10"
      );
      process.env.TZ = "America/Los_Angeles";
      await db.tasks.reconcileRecurrence();
      expect((await db.tasks.smartList("all"))[0].dueDate).toBe("2026-03-10");
    } finally {
      process.env.TZ = originalZone;
    }
  });

  test.each([
    ["2026-03-27", "2026-04-03"],
    ["2026-10-23", "2026-10-30"]
  ])(
    "weekly recurrence preserves wall time across Oslo DST around %s",
    async (start, next) => {
      const original = process.env.TZ;
      try {
        process.env.TZ = "Europe/Oslo";
        const db = await databaseTest();
        const task = await db.tasks.create({
          title: "DST",
          dueDate: start,
          dueTime: "09:00",
          recurrenceRule: "FREQ=WEEKLY;BYDAY=FR"
        });
        await atTime(new Date(`${start}T12:00:00`).getTime(), () =>
          db.tasks.complete(task.id)
        );
        expect((await db.tasks.smartList("all"))[0]).toMatchObject({
          dueDate: next,
          dueTime: "09:00"
        });
      } finally {
        process.env.TZ = original;
      }
    }
  );

  test("RRULE COUNT terminates after the configured occurrences", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Twice",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY;COUNT=2"
    });
    await atTime(new Date(2026, 2, 7, 12).getTime(), () =>
      db.tasks.complete(task.id)
    );
    const [second] = await db.tasks.smartList("all");
    await atTime(new Date(2026, 2, 8, 12).getTime(), () =>
      db.tasks.complete(second.id)
    );
    expect(await db.tasks.smartList("all")).toEqual([]);
    expect(await db.tasks.smartList("completed")).toHaveLength(2);
  });

  test("invalid synced recurrence does not block other recurring Tasks", async () => {
    const db = await databaseTest();
    const broken = await db.tasks.create({
      title: "Broken",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY"
    });
    const healthy = await db.tasks.create({
      title: "Healthy",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY"
    });
    await db.tasks.update(broken.id, {
      completed: true,
      completedAt: Date.now()
    });
    await db.tasks.update(healthy.id, {
      completed: true,
      completedAt: Date.now()
    });
    const carrier = db.settings.collection
      .items()
      .find((item) => item.key === `appleTasks:v1:task:${broken.id}`)!;
    const value = JSON.parse(carrier.value as string);
    value.recurrenceRule = "FREQ=NONEXISTENT";
    await db.settings.collection.upsert({
      ...carrier,
      value: JSON.stringify(value)
    });
    await expect(db.tasks.reconcileRecurrence()).resolves.toBeUndefined();
    expect((await db.tasks.smartList("all")).map((item) => item.title)).toEqual(
      ["Healthy"]
    );
  });

  test("legacy migration is idempotent and preserves legacy due and reminder", async () => {
    const db = await databaseTest();
    const date = new Date(2026, 9, 31, 18).getTime();
    const snoozeUntil = new Date(2026, 10, 1, 9).getTime();
    const id = await db.reminders.add({
      title: "Legacy",
      description: "Bring the original document",
      date,
      mode: "once",
      snoozeUntil
    });
    await db.tasks.migrateLegacyReminders();
    await db.tasks.migrateLegacyReminders();
    const tasks = (await db.tasks.list()).filter(
      (item) => item.legacyReminderId === id
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe("Bring the original document");
    expect(tasks[0].reminderAt).toBe(snoozeUntil);
    expect(tasks[0].dueDate).toBe("2026-10-31");
    expect(tasks[0].dueTime).toBe("18:00");
    expect(await db.reminders.reminder(id!)).toEqual(
      expect.objectContaining({
        title: "Legacy",
        description: "Bring the original document",
        date,
        snoozeUntil
      })
    );
  });

  test.each([
    ["day", "2026-01-01", undefined, "2026-09-25"],
    ["week", "2026-01-02", [1, 3, 5], "2026-09-25"],
    ["month", "2026-01-30", [15, 30], "2026-09-30"],
    ["year", "2024-10-31", undefined, "2026-10-31"]
  ] as const)(
    "stale legacy %s repeat rolls forward to the next scheduled occurrence",
    async (recurringMode, seedDate, selectedDays, nextDate) => {
      const db = await databaseTest();
      const seed = new Date(`${seedDate}T09:00:00`).getTime();
      const id = await db.reminders.add({
        title: `Legacy ${recurringMode}`,
        date: seed,
        mode: "repeat",
        recurringMode,
        selectedDays: selectedDays ? [...selectedDays] : undefined
      });
      await atTime(new Date(2026, 8, 24, 12).getTime(), () =>
        db.tasks.migrateLegacyReminders()
      );
      const [task] = (await db.tasks.list()).filter(
        (item) => item.legacyReminderId === id
      );
      expect(task).toMatchObject({
        dueDate: nextDate,
        dueTime: "09:00",
        seriesStartDate: seedDate,
        seriesStartTime: "09:00",
        reminderAt: new Date(`${nextDate}T09:00:00`).getTime()
      });
      expect((await db.reminders.reminder(id!))?.disabled).not.toBe(true);
      expect(db.tasks.isMigratedReminder(id!)).toBe(true);
      await atTime(new Date(2026, 9, 1, 12).getTime(), () =>
        db.tasks.migrateLegacyReminders()
      );
      expect(
        (await db.tasks.list()).filter((item) => item.legacyReminderId === id)
      ).toEqual([task]);
    }
  );

  test("migrated repeating Reminder retains a future snooze and replaces an expired one", async () => {
    const db = await databaseTest();
    const seed = new Date(2026, 0, 1, 9).getTime();
    const futureSnooze = new Date(2026, 8, 24, 15).getTime();
    const futureId = await db.reminders.add({
      title: "Future snooze",
      date: seed,
      mode: "repeat",
      recurringMode: "day",
      snoozeUntil: futureSnooze
    });
    const expiredId = await db.reminders.add({
      title: "Expired snooze",
      date: seed,
      mode: "repeat",
      recurringMode: "day",
      snoozeUntil: new Date(2026, 8, 23, 15).getTime()
    });
    await atTime(new Date(2026, 8, 24, 12).getTime(), () =>
      db.tasks.migrateLegacyReminders()
    );
    const migrated = await db.tasks.list();
    const future = migrated.find((item) => item.legacyReminderId === futureId)!;
    const expired = migrated.find(
      (item) => item.legacyReminderId === expiredId
    )!;
    expect(future.dueDate).toBe("2026-09-25");
    expect(future.reminderAt).toBe(futureSnooze);
    expect(expired.reminderAt).toBe(new Date(2026, 8, 25, 9).getTime());
    await atTime(new Date(2026, 8, 25, 12).getTime(), () =>
      db.tasks.complete(future.id)
    );
    const successor = (await db.tasks.smartList("all")).find(
      (item) => item.seriesId === future.id
    );
    expect(successor?.dueDate).toBe("2026-09-26");
    expect(successor?.reminderAt).toBe(new Date(2026, 8, 25, 15).getTime());
  });

  test("disabled legacy Reminder does not regain a scheduled reminder", async () => {
    const db = await databaseTest();
    const id = await db.reminders.add({
      title: "Disabled",
      date: new Date(2026, 9, 31, 18).getTime(),
      disabled: true
    });
    await db.tasks.migrateLegacyReminders();
    const [task] = (await db.tasks.list()).filter(
      (item) => item.legacyReminderId === id
    );
    expect(task.dueDate).toBe("2026-10-31");
    expect(task.reminderAt).toBeUndefined();
    expect((await db.reminders.reminder(id!))?.disabled).toBe(true);
  });

  test("200 legacy Reminders migrate once and remain available to older clients", async () => {
    const db = await databaseTest();
    db.options.batchSize = 31;
    const date = new Date(2026, 9, 31, 18).getTime();
    for (let index = 0; index < 200; index++)
      await db.reminders.add({ title: `Reminder ${index}`, date });
    const sourceWrites = vi.spyOn(db.reminders, "add");
    const scan = vi.spyOn(db.reminders, "all", "get");
    try {
      await db.tasks.migrateLegacyReminders();
      expect(scan).toHaveBeenCalledTimes(1);
      expect(
        (await db.tasks.list()).filter((task) => task.legacyReminderId)
      ).toHaveLength(200);
      expect(sourceWrites).not.toHaveBeenCalled();
      expect(
        (await db.reminders.all.items()).every((reminder) => !reminder.disabled)
      ).toBe(true);
      await db.tasks.migrateLegacyReminders();
      expect(scan).toHaveBeenCalledTimes(3);
      expect(
        (await db.tasks.list()).filter((task) => task.legacyReminderId)
      ).toHaveLength(200);
      expect(sourceWrites).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
      sourceWrites.mockRestore();
    }
  });

  test("unsupported legacy modes stay recoverable and are not disabled", async () => {
    const db = await databaseTest();
    const date = new Date(2026, 9, 31, 18).getTime();
    const permanent = await db.reminders.add({
      title: "Permanent",
      date,
      mode: "permanent"
    });
    const unknownRepeat = await db.reminders.add({
      title: "Unknown repeat",
      date,
      mode: "repeat"
    });
    await db.tasks.migrateLegacyReminders();
    expect(await db.tasks.list()).toEqual([]);
    expect((await db.reminders.reminder(permanent!))?.disabled).not.toBe(true);
    expect((await db.reminders.reminder(unknownRepeat!))?.disabled).not.toBe(
      true
    );
  });

  test("local-only legacy Reminder remains local-only in encrypted sync", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const legacyId = await db.reminders.add({
      title: "Private legacy",
      date: new Date(2026, 9, 31, 18).getTime(),
      localOnly: true
    });
    await db.tasks.migrateLegacyReminders();
    const [task] = (await db.tasks.list()).filter(
      (item) => item.legacyReminderId === legacyId
    );
    expect(task.localOnly).toBe(true);
    const setting = db.settings.collection
      .items()
      .find((item) => item.key === `appleTasks:v1:task:${task.id}`);
    expect(setting?.localOnly).toBe(true);
    const chunks = [];
    for await (const chunk of new Collector(db).collect(100))
      chunks.push(chunk);
    const taskTransfer = chunks
      .find((chunk) => chunk.type === "settingitem")
      ?.items.find((item) => item.id === setting?.id);
    expect(taskTransfer).toBeDefined();
    const keys = await db.user.getDataEncryptionKeys();
    const key = keys.find((item) => item.version === taskTransfer!.keyVersion);
    const decrypted = await db.storage().decrypt(key!.key, taskTransfer!);
    expect(JSON.parse(decrypted)).toEqual(
      expect.objectContaining({ id: setting!.id, deleted: true })
    );
    expect(decrypted).not.toContain("Private legacy");
  });

  test("Task and List sync records are collected once without a cached sync loop", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const list = await db.taskLists.create("Synced");
    await db.tasks.create({ title: "Once", listId: list.id });
    const collector = new Collector(db);
    const first = [];
    for await (const chunk of collector.collect(100)) first.push(chunk);
    const second = [];
    for await (const chunk of collector.collect(100)) second.push(chunk);
    expect(first.filter((chunk) => chunk.type === "settingitem")).toHaveLength(
      1
    );
    expect(second).toEqual([]);
  });

  test("encrypted Task and List sync round trip across two databases", async () => {
    const first = await databaseTest();
    await loginFakeUser(first);
    const second = await databaseTest();
    const user = await first.user.getUser();
    expect(user).toBeDefined();
    await second.user.setUser(user!);
    await second.storage().deriveCryptoKey({
      password: "password",
      salt: user!.salt
    });

    const transfer = async (
      source: typeof first,
      destination: typeof second
    ) => {
      const keys = await destination.user.getDataEncryptionKeys();
      const receiver = new Sync(destination);
      const chunks = [];
      for await (const chunk of new Collector(source).collect(100)) {
        chunks.push(chunk);
        await receiver.processChunk(chunk, keys, { type: "fetch" });
      }
      await destination.tasks.reconcile();
      return chunks;
    };

    // Keep modification times strictly ordered across the simulated clients.
    let timestamp = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ++timestamp);
    try {
      const work = await first.taskLists.create({
        name: "Work",
        color: "#f00"
      });
      const defaultList = await first.taskLists.default();
      const favoriteOrder = [
        `list:${defaultList.id}`,
        `list:${work.id}`,
        "smart:flagged"
      ] as const;
      await first.taskFavorites.set([...favoriteOrder]);
      const reminderAt = new Date(2026, 9, 30, 9).getTime();
      const task = await first.tasks.create({
        title: "Ship report",
        listId: work.id,
        dueDate: "2026-10-31",
        dueTime: "18:00",
        reminderAt,
        recurrenceRule: "FREQ=DAILY",
        priority: "medium",
        flagged: true
      });

      const outbound = await transfer(first, second);
      expect(outbound.some((chunk) => chunk.type === "settingitem")).toBe(true);
      expect(await second.taskLists.list()).toContainEqual(
        expect.objectContaining({ id: work.id, name: "Work", color: "#f00" })
      );
      expect(await second.taskFavorites.list()).toEqual(favoriteOrder);
      expect(await second.tasks.get(task.id)).toEqual(
        expect.objectContaining({
          id: task.id,
          title: "Ship report",
          listId: work.id,
          dueDate: "2026-10-31",
          dueTime: "18:00",
          reminderAt,
          recurrenceRule: "FREQ=DAILY",
          priority: "medium",
          flagged: true,
          completed: false
        })
      );

      await second.tasks.update(task.id, {
        title: "Shipped report",
        priority: "high",
        flagged: false
      });
      await second.tasks.complete(task.id);
      const personal = await second.taskLists.create("Personal");
      const next = (await second.tasks.list()).find(
        (item) => item.id !== task.id
      );
      expect(next?.dueDate).toBe("2026-11-01");
      await second.tasks.update(next!.id, { listId: personal.id });

      await transfer(second, first);
      expect(await first.taskFavorites.list()).toEqual(favoriteOrder);
      expect(await first.tasks.get(task.id)).toEqual(
        expect.objectContaining({
          completed: true,
          title: "Shipped report",
          priority: "high",
          flagged: false
        })
      );
      expect(await first.tasks.get(next!.id)).toEqual(
        expect.objectContaining({
          completed: false,
          dueDate: "2026-11-01",
          listId: personal.id
        })
      );
      expect(await first.taskLists.list()).toContainEqual(
        expect.objectContaining({ id: personal.id, name: "Personal" })
      );

      await first.tasks.remove(next!.id);
      await first.taskLists.remove(personal.id);
      await transfer(first, second);
      expect(await second.tasks.get(next!.id)).toBeUndefined();
      expect(
        (await second.taskLists.list()).some((item) => item.id === personal.id)
      ).toBe(false);
      expect((await second.tasks.get(task.id))?.completed).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  test("migrated Reminder remains active for older clients after Task deletion", async () => {
    const db = await databaseTest();
    const id = await db.reminders.add({
      title: "Legacy",
      date: new Date(2026, 10, 3, 9).getTime()
    });
    await db.tasks.migrateLegacyReminders();
    const [task] = (await db.tasks.list()).filter(
      (item) => item.legacyReminderId === id
    );
    expect(task).toBeDefined();
    expect(db.tasks.isMigratedReminder(id!)).toBe(true);
    expect((await db.reminders.reminder(id!))?.disabled).not.toBe(true);
    await db.tasks.remove(task.id);
    await db.tasks.migrateLegacyReminders();
    expect(db.tasks.isMigratedReminder(id!)).toBe(true);
    expect(await db.tasks.get(task.id)).toBeUndefined();
    expect((await db.reminders.reminder(id!))?.disabled).not.toBe(true);
  });

  test("stale recurring Reminder migration stays idempotent without modifying its source", async () => {
    const db = await databaseTest();
    const id = await db.reminders.add({
      title: "Interrupted daily",
      date: new Date(2026, 0, 1, 9).getTime(),
      mode: "repeat",
      recurringMode: "day"
    });
    await atTime(new Date(2026, 8, 24, 12).getTime(), () =>
      db.tasks.migrateLegacyReminders()
    );
    const [persisted] = (await db.tasks.list()).filter(
      (task) => task.legacyReminderId === id
    );
    expect(persisted.dueDate).toBe("2026-09-25");
    expect((await db.reminders.reminder(id!))?.disabled).not.toBe(true);
    await atTime(new Date(2026, 8, 24, 13).getTime(), () =>
      db.tasks.migrateLegacyReminders()
    );
    expect(
      (await db.tasks.list()).filter((task) => task.legacyReminderId === id)
    ).toEqual([persisted]);
    expect((await db.reminders.reminder(id!))?.disabled).not.toBe(true);
  });

  test("completed occurrence recovers its next Task after interrupted persistence", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Daily",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY"
    });
    const original = db.settings.collection.upsert.bind(db.settings.collection);
    let writes = 0;
    const upsert = vi
      .spyOn(db.settings.collection, "upsert")
      .mockImplementation(async (item) => {
        if (++writes === 2) throw new Error("interrupted");
        return original(item);
      });
    await expect(
      atTime(new Date(2026, 2, 7, 12).getTime(), () =>
        db.tasks.complete(task.id)
      )
    ).rejects.toThrow("interrupted");
    upsert.mockRestore();
    expect((await db.tasks.get(task.id))?.completed).toBe(true);
    await db.tasks.reconcileRecurrence();
    await db.tasks.reconcileRecurrence();
    expect(
      (await db.tasks.smartList("all")).map((item) => item.dueDate)
    ).toEqual(["2026-03-08"]);
  });

  test("guarded recurring retry repairs an interrupted next occurrence", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Daily widget",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY"
    });
    const original = db.settings.collection.upsert.bind(db.settings.collection);
    let writes = 0;
    const upsert = vi
      .spyOn(db.settings.collection, "upsert")
      .mockImplementation(async (item) => {
        if (++writes === 2) throw new Error("interrupted");
        return original(item);
      });
    await expect(
      atTime(new Date(2026, 2, 7, 12).getTime(), () =>
        db.tasks.completeIfUnchanged(task.id, task.updatedAt)
      )
    ).rejects.toThrow("interrupted");
    upsert.mockRestore();
    expect((await db.tasks.get(task.id))?.completed).toBe(true);
    await atTime(new Date(2026, 2, 7, 12).getTime(), () =>
      db.tasks.completeIfUnchanged(task.id, task.updatedAt)
    );
    expect(
      (await db.tasks.smartList("all")).map((item) => item.dueDate)
    ).toEqual(["2026-03-08"]);
  });

  test("simultaneous recurring completion creates exactly one next occurrence", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Concurrent repeat",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY"
    });
    await atTime(new Date(2026, 2, 7, 12).getTime(), () =>
      Promise.all([db.tasks.complete(task.id), db.tasks.complete(task.id)])
    );
    expect(
      (await db.tasks.smartList("all")).map((item) => item.dueDate)
    ).toEqual(["2026-03-08"]);
  });

  test("deleted next occurrence stays deleted during recurrence reconciliation", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Daily",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY"
    });
    await atTime(new Date(2026, 2, 7, 12).getTime(), () =>
      db.tasks.complete(task.id)
    );
    const [next] = await db.tasks.smartList("all");
    await db.tasks.remove(next.id);
    await db.tasks.reconcileRecurrence();
    expect(await db.tasks.get(next.id)).toBeUndefined();
    await expect(db.tasks.uncomplete(task.id)).rejects.toThrow(
      "next occurrence exists"
    );
  });

  test("concurrent maintenance does not duplicate migrated Tasks", async () => {
    const db = await databaseTest();
    const id = await db.reminders.add({
      title: "Concurrent",
      date: new Date(2026, 9, 31, 18).getTime()
    });
    await Promise.all([
      db.tasks.reconcile(),
      db.tasks.reconcile(),
      db.tasks.reconcile()
    ]);
    expect(
      (await db.tasks.list()).filter((item) => item.legacyReminderId === id)
    ).toHaveLength(1);
  });

  test("maintenance repairs a Task whose list disappeared", async () => {
    const db = await databaseTest();
    const list = await db.taskLists.create("Transient");
    const task = await db.tasks.create({ title: "Orphan", listId: list.id });
    await db.settings.collection.softDelete([
      db.settings.collection
        .items()
        .find((item) => item.key === `appleTasks:v1:list:${list.id}`)!.id
    ]);
    await db.tasks.repairListReferences();
    expect((await db.tasks.get(task.id))?.listId).toBe(
      (await db.taskLists.default()).id
    );
  });

  test("deleted migrated Task tombstone prevents legacy resurrection", async () => {
    const db = await databaseTest();
    const id = await db.reminders.add({
      title: "Legacy",
      date: new Date(2026, 9, 1, 9).getTime()
    });
    await db.tasks.migrateLegacyReminders();
    const [task] = (await db.tasks.list()).filter(
      (item) => item.legacyReminderId === id
    );
    await db.tasks.remove(task.id);
    await db.reminders.add({
      id,
      title: "Legacy",
      date: new Date(2026, 9, 1, 9).getTime(),
      disabled: false
    });
    await db.tasks.migrateLegacyReminders();
    expect(await db.tasks.get(task.id)).toBeUndefined();
    expect(db.tasks.isMigratedReminder(id!)).toBe(true);
    expect((await db.reminders.reminder(id!))?.disabled).not.toBe(true);
  });

  test("malformed namespaced setting records cannot enter Task queries", async () => {
    const db = await databaseTest();
    await db.settings.collection.upsert({
      id: "malformed",
      type: "settingitem",
      key: "appleTasks:v1:task:x",
      value: JSON.stringify({ id: "x", schemaVersion: 1, title: 123 })
    } as any);
    expect(await db.tasks.list()).toEqual([]);
  });

  test("future default-list schema is not overwritten by this client", async () => {
    const db = await databaseTest();
    const list = await db.taskLists.default();
    const carrier = db.settings.collection
      .items()
      .find((item) => item.key === `appleTasks:v1:list:${list.id}`)!;
    const future = JSON.stringify({ ...list, schemaVersion: 2 });
    await db.settings.collection.upsert({ ...carrier, value: future });
    await expect(db.taskLists.default()).rejects.toThrow(
      "unsupported schema version"
    );
    expect(db.settings.collection.get(carrier.id)?.value).toBe(future);
  });

  test("plain backup restores Task records and lists", async () => {
    const db = await databaseTest();
    const list = await db.taskLists.create("Shopping");
    const defaultList = await db.taskLists.default();
    await db.taskFavorites.set([`list:${defaultList.id}`, `list:${list.id}`]);
    const task = await db.tasks.create({
      title: "Milk",
      listId: list.id,
      priority: "medium",
      flagged: true
    });
    const files = [];
    for await (const entry of db.backup.export({ type: "node" })) {
      if (entry.type === "file" && entry.path !== ".nnbackup")
        files.push(entry.data);
    }
    const restored = await databaseTest();
    for (const data of files) await restored.backup.import(JSON.parse(data));
    expect((await restored.tasks.get(task.id))?.title).toBe("Milk");
    expect((await restored.tasks.get(task.id))?.flagged).toBe(true);
    expect(
      (await restored.taskLists.list()).some((item) => item.id === list.id)
    ).toBe(true);
    expect(await restored.taskFavorites.list()).toEqual([
      `list:${defaultList.id}`,
      `list:${list.id}`
    ]);
    expect(
      restored.settings.collection.get(
        restored.settings.collection
          .items()
          .find((item) => item.key === `appleTasks:v1:task:${task.id}`)!.id
      )?.value
    ).toContain("Milk");
  });

  test("encrypted backup restores Task fields without exposing the title", async () => {
    const source = await databaseTest();
    await loginFakeUser(source);
    const list = await source.taskLists.create("Private errands");
    const reminderAt = new Date(2026, 9, 24, 9).getTime();
    const title = "Confidential October appointment";
    const task = await source.tasks.create({
      title,
      description: "Bring the confidential paperwork",
      listId: list.id,
      dueDate: "2026-10-31",
      reminderAt,
      priority: "high",
      flagged: true
    });

    const encryptedFiles: string[] = [];
    for await (const entry of source.backup.export({
      type: "node",
      encrypt: true
    })) {
      if (entry.type === "file" && entry.path !== ".nnbackup")
        encryptedFiles.push(entry.data);
    }
    expect(encryptedFiles.length).toBeGreaterThan(0);
    for (const data of encryptedFiles) {
      const backup = JSON.parse(data);
      expect(backup.encrypted).toBe(true);
      expect(backup.data).toBeTypeOf("object");
      expect(data).not.toContain(title);
      expect(data).not.toContain("Bring the confidential paperwork");
    }

    const restored = await databaseTest();
    for (const data of encryptedFiles)
      await restored.backup.import(JSON.parse(data), {
        password: "password"
      });
    expect(await restored.taskLists.list()).toContainEqual(
      expect.objectContaining({ id: list.id, name: "Private errands" })
    );
    expect(await restored.tasks.get(task.id)).toEqual(
      expect.objectContaining({
        id: task.id,
        title,
        description: "Bring the confidential paperwork",
        listId: list.id,
        dueDate: "2026-10-31",
        reminderAt,
        priority: "high",
        flagged: true,
        completed: false
      })
    );
    expect((await restored.tasks.get(task.id))?.dueTime).toBeUndefined();
  });

  test("backup import reconciles interrupted recurring completion", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Repeat",
      dueDate: "2026-03-07",
      recurrenceRule: "FREQ=DAILY"
    });
    const original = db.settings.collection.upsert.bind(db.settings.collection);
    let writes = 0;
    const upsert = vi
      .spyOn(db.settings.collection, "upsert")
      .mockImplementation(async (item) => {
        if (++writes === 2) throw new Error("interrupted");
        return original(item);
      });
    await expect(
      atTime(new Date(2026, 2, 7, 12).getTime(), () =>
        db.tasks.complete(task.id)
      )
    ).rejects.toThrow("interrupted");
    upsert.mockRestore();
    const files = [];
    for await (const entry of db.backup.export({ type: "node" }))
      if (entry.type === "file" && entry.path !== ".nnbackup")
        files.push(entry.data);
    const restored = await databaseTest();
    for (const data of files) await restored.backup.import(JSON.parse(data));
    expect(
      (await restored.tasks.smartList("all")).map((item) => item.dueDate)
    ).toEqual(["2026-03-08"]);
  });
});
