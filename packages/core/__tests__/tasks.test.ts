import { describe, expect, test, vi } from "vitest";
import { databaseTest, loginFakeUser } from "./utils/index.js";
import { isTaskOverdue, Tasks } from "../src/collections/tasks.js";
import Collector from "../src/api/sync/collector.js";
import { Sync } from "../src/api/sync/index.js";

describe("standalone Tasks", () => {
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
    expect(today.map((item) => item.id)).toContain(
      overdueWithFutureReminder.id
    );
    expect(today.map((item) => item.id)).not.toContain(future.id);
    const scheduled = (
      await db.tasks.smartList("scheduled", new Date(2026, 8, 24))
    ).map((item) => item.id);
    expect(scheduled).toContain(future.id);
    expect(scheduled).not.toContain(overdueWithFutureReminder.id);
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
    await db.tasks.complete(task.id);
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
    await db.tasks.complete(task.id);
    const next = (await db.tasks.smartList("all"))[0];
    expect(next.dueDate).toBe("2026-11-06");
    expect(next.reminderAt).toBe(new Date(2026, 9, 30, 18).getTime());
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
        await db.tasks.complete(task.id);
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
    await db.tasks.complete(task.id);
    const [second] = await db.tasks.smartList("all");
    await db.tasks.complete(second.id);
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
    const id = await db.reminders.add({ title: "Legacy", date, mode: "once" });
    await db.tasks.migrateLegacyReminders();
    await db.tasks.migrateLegacyReminders();
    const tasks = (await db.tasks.list()).filter(
      (item) => item.legacyReminderId === id
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reminderAt).toBe(date);
    expect(tasks[0].dueDate).toBe("2026-10-31");
    expect(tasks[0].dueTime).toBe("18:00");
    expect(await db.reminders.reminder(id!)).toBeUndefined();
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

  test("migration resumes after Task persistence but before Reminder deletion", async () => {
    const db = await databaseTest();
    const id = await db.reminders.add({
      title: "Interrupted",
      date: new Date(2026, 10, 3, 9).getTime()
    });
    const removal = vi
      .spyOn(db.reminders, "remove")
      .mockRejectedValueOnce(new Error("interrupted"));
    await expect(db.tasks.migrateLegacyReminders()).rejects.toThrow(
      "interrupted"
    );
    expect(
      (await db.tasks.list()).filter((item) => item.legacyReminderId === id)
    ).toHaveLength(1);
    expect(await db.reminders.reminder(id!)).toBeDefined();
    removal.mockRestore();
    await db.tasks.migrateLegacyReminders();
    expect(
      (await db.tasks.list()).filter((item) => item.legacyReminderId === id)
    ).toHaveLength(1);
    expect(await db.reminders.reminder(id!)).toBeUndefined();
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
    await expect(db.tasks.complete(task.id)).rejects.toThrow("interrupted");
    upsert.mockRestore();
    expect((await db.tasks.get(task.id))?.completed).toBe(true);
    await db.tasks.reconcileRecurrence();
    await db.tasks.reconcileRecurrence();
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
    await Promise.all([db.tasks.complete(task.id), db.tasks.complete(task.id)]);
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
    await db.tasks.complete(task.id);
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
      date: new Date(2026, 9, 1, 9).getTime()
    });
    await db.tasks.migrateLegacyReminders();
    expect(await db.tasks.get(task.id)).toBeUndefined();
    expect(await db.reminders.reminder(id!)).toBeUndefined();
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
    await expect(db.tasks.complete(task.id)).rejects.toThrow("interrupted");
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
