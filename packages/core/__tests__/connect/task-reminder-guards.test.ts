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

import { describe, it, expect } from "vitest";
import { databaseTest } from "../utils/index.js";
import { makeId } from "../../src/utils/id.js";
import {
  taskReminderSchedule,
  validateTaskCreateInput,
  validateTaskUpdateInput
} from "../../src/collections/tasks.js";

/**
 * The raw floating-calendar materialization must never silently drop a caller's
 * reminder *time* because no reminder *date* accompanied it. The rejection
 * happens at the same boundary `Tasks.create`/`Tasks.update` and the Connect
 * pre-reservation validator share, so a time-only payload can neither persist a
 * Task that lost the time nor flip a legacy due-date schedule into a
 * `scheduleVersion: 2` write that clears it.
 */
describe("Task calendar materialization rejects a time without a date", () => {
  it("rejects a raw create that supplies reminderTime without reminderDate", async () => {
    const db = await databaseTest();
    await expect(
      db.tasks.create({ title: "No date", reminderTime: "14:00" })
    ).rejects.toThrow(/reminder time/i);
    expect(db.tasks.listSync()).toHaveLength(0);
  });

  it("rejects the shared create validator for the same payload", () => {
    expect(() =>
      validateTaskCreateInput({ title: "No date", reminderTime: "14:00" })
    ).toThrow(/reminder time/i);
  });

  it("still accepts an explicit undefined reminderTime as a clear", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Cleared",
      reminderDate: undefined,
      reminderTime: undefined
    });
    expect(task.reminderDate).toBeUndefined();
    expect(task.reminderTime).toBeUndefined();
    expect(taskReminderSchedule(task)).toEqual({
      date: undefined,
      time: undefined
    });
  });

  it("accepts a time-only update when a floating reminder date already exists", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Keep date",
      reminderDate: "2026-10-31"
    });
    const updated = await db.tasks.update(task.id, { reminderTime: "14:30" });
    expect(updated.reminderDate).toBe("2026-10-31");
    expect(updated.reminderTime).toBe("14:30");
    expect(updated.scheduleVersion).toBe(2);
  });

  it("rejects a time-only update when no reminder date resolves", async () => {
    const db = await databaseTest();
    const legacy = await db.tasks.create({
      title: "Legacy due",
      dueDate: "2026-10-31",
      dueTime: "09:00"
    });
    await expect(
      db.tasks.update(legacy.id, { reminderTime: "14:30" })
    ).rejects.toThrow(/reminder time/i);
    // The legacy due-date schedule is untouched: the update never landed.
    const stored = (await db.tasks.get(legacy.id))!;
    expect(stored.dueDate).toBe("2026-10-31");
    expect(stored.dueTime).toBe("09:00");
    expect(stored.scheduleVersion).toBeUndefined();
  });

  it("rejects a time-only update that clears the reminder date in the same patch", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Clear date",
      reminderDate: "2026-10-31",
      reminderTime: "09:00"
    });
    await expect(
      db.tasks.update(task.id, {
        reminderDate: undefined,
        reminderTime: "14:30"
      })
    ).rejects.toThrow(/reminder time/i);
    expect((await db.tasks.get(task.id))!.reminderDate).toBe("2026-10-31");
  });

  it("still clears the whole calendar through explicit undefined", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({
      title: "Clear all",
      reminderDate: "2026-10-31",
      reminderTime: "09:00"
    });
    const cleared = await db.tasks.update(task.id, {
      reminderDate: undefined,
      reminderTime: undefined
    });
    expect(taskReminderSchedule(cleared)).toEqual({
      date: undefined,
      time: undefined
    });
    expect(cleared.dueDate).toBeUndefined();
    expect(cleared.dueTime).toBeUndefined();
  });

  it("rejects the shared update validator for a cleared date with a supplied time", () => {
    const current = {
      id: "task-1",
      title: "x",
      listId: "list-1",
      completed: false,
      priority: "none" as const,
      flagged: false,
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1 as const,
      reminderDate: "2026-10-31",
      reminderTime: "09:00",
      scheduleVersion: 2
    };
    expect(() =>
      validateTaskUpdateInput(current, {
        reminderDate: undefined,
        reminderTime: "14:30"
      })
    ).toThrow(/reminder time/i);
  });
});

/**
 * A soft-deleted default list row is a real tombstone, not an unsupported
 * future schema: it must resolve to the virtual default (and be re-materialized
 * inside the Task write lease), while a live but unparsable row still fails
 * closed and is never overwritten.
 */
describe("default Task list tombstone", () => {
  it("resolves a soft-deleted default row and re-materializes it", async () => {
    const db = await databaseTest();
    const list = await db.taskLists.ensureDefaultPersisted();
    const recordKey = `appleTasks:v1:list:${list.id}`;
    await db.settings.collection.softDelete([makeId(recordKey)]);

    expect(db.taskLists.getSync(list.id)?.id).toBe(list.id);
    await expect(db.taskLists.default()).resolves.toMatchObject({
      id: list.id,
      name: "Reminders"
    });

    const task = await db.tasks.create({ title: "After tombstone" });
    expect(task.listId).toBe(list.id);
    // The row is real again: persisted, live and readable.
    expect(db.settings.collection.get(makeId(recordKey))).toBeTruthy();
    expect(db.taskLists.listSync().some((item) => item.id === list.id)).toBe(
      true
    );
    const persisted = await db.taskLists.default();
    expect(persisted.schemaVersion).toBe(1);
  });

  it("re-materializes a tombstoned default row when a Task updates into it", async () => {
    const db = await databaseTest();
    const defaultList = await db.taskLists.ensureDefaultPersisted();
    const custom = await db.taskLists.create("Custom");
    const task = await db.tasks.create({
      title: "Move me",
      listId: custom.id
    });
    const recordKey = `appleTasks:v1:list:${defaultList.id}`;
    await db.settings.collection.softDelete([makeId(recordKey)]);
    expect(db.settings.collection.get(makeId(recordKey))).toBeUndefined();

    const moved = await db.tasks.update(task.id, { listId: defaultList.id });
    expect(moved.listId).toBe(defaultList.id);
    // The held Task write lease re-materialized the default row.
    expect(db.settings.collection.get(makeId(recordKey))).toBeTruthy();
    expect((await db.taskLists.default()).schemaVersion).toBe(1);
  });

  it("still fails closed on a live unknown-version default row", async () => {
    const db = await databaseTest();
    const list = await db.taskLists.ensureDefaultPersisted();
    const carrier = db.settings.collection
      .items()
      .find((item) => item.key === `appleTasks:v1:list:${list.id}`)!;
    const future = JSON.stringify({ ...list, schemaVersion: 2 });
    await db.settings.collection.upsert({ ...carrier, value: future });

    await expect(db.taskLists.default()).rejects.toThrow(
      "unsupported schema version"
    );
    expect(db.taskLists.getSync(list.id)).toBeUndefined();
    // The future row is never overwritten by this client.
    expect(db.settings.collection.get(carrier.id)?.value).toBe(future);
  });
});

/**
 * Runtime-untyped callers must not be able to overwrite a Task list's identity
 * fields through the update patch, and an explicit empty/whitespace `listId`
 * must be rejected instead of silently routing a Task to the default list.
 */
describe("Task list / Task id boundary hardening", () => {
  it("pins the list identity fields a runtime patch tries to overwrite", async () => {
    const db = await databaseTest();
    const list = await db.taskLists.create("Original");
    const before = db.taskLists.getSync(list.id)!;
    const updated = await db.taskLists.update(list.id, {
      name: "Renamed",
      id: "attacker-id",
      schemaVersion: 99,
      createdAt: 12345
    } as never);

    expect(updated.id).toBe(before.id);
    expect(updated.schemaVersion).toBe(1);
    expect(updated.createdAt).toBe(before.createdAt);
    expect(updated.name).toBe("Renamed");
    expect(db.taskLists.getSync(list.id)?.name).toBe("Renamed");
    // The forged id never became a list, and the Tasks still resolve.
    expect(db.taskLists.getSync("attacker-id")).toBeUndefined();
  });

  it("rejects an explicit empty or whitespace listId on create and update", async () => {
    const db = await databaseTest();
    await expect(db.tasks.create({ title: "Empty", listId: "" })).rejects.toThrow(
      /Task list not found/i
    );
    await expect(
      db.tasks.create({ title: "Blank", listId: "   " })
    ).rejects.toThrow(/Task list not found/i);

    const task = await db.tasks.create({ title: "Real" });
    await expect(db.tasks.update(task.id, { listId: "" })).rejects.toThrow(
      /Task list not found/i
    );
    await expect(db.tasks.update(task.id, { listId: "   " })).rejects.toThrow(
      /Task list not found/i
    );
    const stored = (await db.tasks.get(task.id))!;
    expect(stored.listId).toBe(task.listId);
    expect(stored.listId).not.toBe("");
  });

  it("still blocks a reused id when the stored row has an unknown schema", async () => {
    const db = await databaseTest();
    const task = await db.tasks.create({ title: "Legacy row" });
    const carrier = db.settings.collection
      .items()
      .find((item) => item.key === `appleTasks:v1:task:${task.id}`)!;
    await db.settings.collection.upsert({
      ...carrier,
      value: JSON.stringify({
        ...JSON.parse(carrier.value as string),
        schemaVersion: 5
      })
    } as never);

    // The unknown-schema row is skipped as a Task record...
    expect(await db.tasks.get(task.id)).toBeUndefined();
    // ...but its raw row still blocks the id from being reused or overwritten.
    await expect(
      db.tasks.create({ id: task.id, title: "Reused" })
    ).rejects.toThrow(/already exists or was deleted/i);
  });
});
