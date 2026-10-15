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

import { describe, it, expect, afterEach } from "vitest";
import { expectCode } from "./helpers.js";
import {
  createHarness,
  ConnectHarness,
  openConnectDb
} from "./fixtures.js";
import { ConnectAdapter } from "../../src/connect/adapter.js";
import { IdempotencyJournal } from "../../src/connect/journal.js";
import { fingerprintOf } from "../../src/connect/revision.js";
import { hashId } from "../../src/connect/hash.js";
import { makeId } from "../../src/utils/id.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

type CreateResult = { taskId: string; revision: string };

function createRequest(
  ctx: ConnectHarness,
  operationId: string,
  extra: Record<string, unknown>
) {
  return {
    operation: "create_task" as const,
    operationId,
    listId: ctx.listId,
    ...extra
  };
}

/** The exact fingerprint `createTaskImpl` computes for a plain title create. */
function createTaskFingerprint(title: string, listId: string) {
  return fingerprintOf({
    operation: "create_task",
    title,
    listId,
    dueDate: null,
    dueTime: null,
    reminderDate: null,
    reminderTime: null,
    reminderAt: null,
    priority: null,
    recurrenceRule: null,
    flagged: null,
    urgent: null,
    description: null
  });
}

async function hideListRaw(ctx: ConnectHarness, listId: string) {
  const existing = ctx.db.taskLists.getSync(listId)!;
  const recordKey = `appleTasks:v1:list:${listId}`;
  await ctx.db.settings.collection.upsert({
    id: makeId(recordKey),
    type: "settingitem",
    key: recordKey,
    value: JSON.stringify(existing),
    localOnly: true,
    dateCreated: Date.now()
  } as never);
}

/**
 * `create_task` payload materialization: only the optional fields the caller
 * actually supplied may become own properties of the object handed to the
 * domain materializer. Passing an absent `reminderDate`/`reminderTime` as an
 * own `undefined` key used to flip every create into a `scheduleVersion: 2`
 * write — discarding a legacy `reminderAt` and invalidating a legacy
 * `urgent + reminderAt` Task.
 */
describe("VeyraN Connect create_task materialization", () => {
  it("accepts a legacy urgent reminderAt and preserves it", async () => {
    harness = await createHarness();
    const ctx = harness;
    const reminderAt = Date.parse("2030-01-02T03:04:00.000Z");
    const created = (await ctx.adapter.execute(
      createRequest(ctx, "task-legacy-urgent", {
        title: "Legacy urgent",
        urgent: true,
        reminderAt
      })
    )) as CreateResult;

    const stored = (await ctx.db.tasks.get(created.taskId))!;
    expect(stored.urgent).toBe(true);
    expect(stored.reminderAt).toBe(reminderAt);
    // The absence of an explicit floating calendar must NOT set scheduleVersion.
    expect(stored.scheduleVersion).toBeUndefined();
    expect(stored.reminderDate).toBeUndefined();
    expect(stored.reminderTime).toBeUndefined();
  });

  it("treats reminderAt: 0 as a supplied reminder instant", async () => {
    harness = await createHarness();
    const ctx = harness;
    const created = (await ctx.adapter.execute(
      createRequest(ctx, "task-zero-urgent", {
        title: "Epoch urgent",
        urgent: true,
        reminderAt: 0
      })
    )) as CreateResult;
    const stored = (await ctx.db.tasks.get(created.taskId))!;
    expect(stored.urgent).toBe(true);
    expect(stored.reminderAt).toBe(0);
    expect(stored.scheduleVersion).toBeUndefined();
  });

  it("lets an explicit floating calendar set scheduleVersion 2 and mirror due", async () => {
    harness = await createHarness();
    const ctx = harness;
    const created = (await ctx.adapter.execute(
      createRequest(ctx, "task-floating", {
        title: "Floating",
        urgent: true,
        dueDate: "2030-01-02",
        dueTime: "03:04",
        reminderDate: "2030-01-02",
        reminderTime: "03:04"
      })
    )) as CreateResult;

    const stored = (await ctx.db.tasks.get(created.taskId))!;
    expect(stored.scheduleVersion).toBe(2);
    expect(stored.reminderDate).toBe("2030-01-02");
    expect(stored.reminderTime).toBe("03:04");
    // An explicit floating calendar mirrors the due date when it started equal.
    expect(stored.dueDate).toBe("2030-01-02");
    expect(stored.dueTime).toBe("03:04");
    // `reminderAt` is the domain-normalized local wall-clock instant, not the
    // raw request value: assert it is a finite number, not an equality against
    // a UTC instant.
    expect(typeof stored.reminderAt).toBe("number");
    expect(Number.isFinite(stored.reminderAt)).toBe(true);
  });

  it("supports a dueDate + recurrence without a reminder", async () => {
    harness = await createHarness();
    const ctx = harness;
    const created = (await ctx.adapter.execute(
      createRequest(ctx, "task-recurrence", {
        title: "Recurring",
        dueDate: "2030-02-01",
        dueTime: "08:00",
        recurrenceRule: "FREQ=DAILY"
      })
    )) as CreateResult;

    const stored = (await ctx.db.tasks.get(created.taskId))!;
    expect(stored.dueDate).toBe("2030-02-01");
    expect(stored.dueTime).toBe("08:00");
    expect(stored.recurrenceRule).toBe("FREQ=DAILY");
    expect(stored.seriesId).toBeTruthy();
    expect(stored.seriesStartDate).toBe("2030-02-01");
    expect(stored.reminderAt).toBeUndefined();
    expect(stored.scheduleVersion).toBeUndefined();
  });

  it("accepts an urgent legacy due-date-only schedule", async () => {
    harness = await createHarness();
    const ctx = harness;
    const created = (await ctx.adapter.execute(
      createRequest(ctx, "task-urgent-due", {
        title: "Urgent due",
        urgent: true,
        dueDate: "2030-03-04",
        dueTime: "09:30"
      })
    )) as CreateResult;
    const stored = (await ctx.db.tasks.get(created.taskId))!;
    expect(stored.urgent).toBe(true);
    expect(stored.dueDate).toBe("2030-03-04");
    expect(stored.scheduleVersion).toBeUndefined();
  });

  it("still rejects an urgent Task with no schedule at all", async () => {
    harness = await createHarness();
    const ctx = harness;
    await expectCode(
      ctx.adapter.execute(
        createRequest(ctx, "task-urgent-empty", {
          title: "No schedule",
          urgent: true
        })
      ),
      "INVALID_INPUT"
    );
  });

  it("rejects a supplied reminderTime without a reminderDate before any receipt", async () => {
    harness = await createHarness();
    const ctx = harness;
    const before = ctx.db.tasks.listSync().length;
    await expectCode(
      ctx.adapter.execute(
        createRequest(ctx, "task-time-only", {
          title: "Time only",
          reminderTime: "14:00"
        })
      ),
      "INVALID_INPUT"
    );
    // The pre-reservation validator uses the *same* domain materializer, so no
    // Task is written and no receipt is reserved.
    expect(ctx.db.tasks.listSync().length).toBe(before);
  });

  it("rejects a time-only update onto a legacy due schedule before any receipt", async () => {
    harness = await createHarness();
    const ctx = harness;
    const created = (await ctx.adapter.execute(
      createRequest(ctx, "task-time-only-update", {
        title: "Legacy due",
        dueDate: "2030-04-05",
        dueTime: "08:00"
      })
    )) as CreateResult;

    await expectCode(
      ctx.adapter.execute({
        operation: "update_task",
        operationId: "task-time-only-update-2",
        taskId: created.taskId,
        expectedRevision: created.revision,
        patch: { reminderTime: "14:00" }
      }),
      "INVALID_INPUT"
    );
    // The legacy due-date schedule is untouched: the update never landed.
    const stored = (await ctx.db.tasks.get(created.taskId))!;
    expect(stored.dueDate).toBe("2030-04-05");
    expect(stored.dueTime).toBe("08:00");
    expect(stored.scheduleVersion).toBeUndefined();
  });

  it("replays an identical legacy-urgent create without a second write", async () => {
    harness = await createHarness();
    const ctx = harness;
    const reminderAt = Date.parse("2031-05-06T07:08:00.000Z");
    const request = createRequest(ctx, "task-legacy-replay", {
      title: "Legacy replay",
      urgent: true,
      reminderAt
    });
    const before = ctx.db.tasks.listSync().length;
    const first = (await ctx.adapter.execute(request)) as CreateResult;
    const second = (await ctx.adapter.execute(request)) as CreateResult;
    expect(second.taskId).toBe(first.taskId);
    expect(ctx.db.tasks.listSync().length).toBe(before + 1);
    expect((await ctx.db.tasks.get(first.taskId))!.reminderAt).toBe(reminderAt);
  });

  it("keeps a legacy reminder across an unrelated update and re-materializes an explicit calendar", async () => {
    harness = await createHarness();
    const ctx = harness;
    const reminderAt = Date.parse("2032-06-07T08:09:00.000Z");
    const created = (await ctx.adapter.execute(
      createRequest(ctx, "task-update-legacy", {
        title: "Update legacy",
        urgent: true,
        reminderAt
      })
    )) as CreateResult;

    const renamed = (await ctx.adapter.execute({
      operation: "update_task",
      operationId: "task-update-legacy-2",
      taskId: created.taskId,
      expectedRevision: created.revision,
      patch: { title: "Renamed" }
    })) as CreateResult;
    // An update that omits the calendar fields does not rewrite the schedule.
    expect((await ctx.db.tasks.get(created.taskId))!.reminderAt).toBe(reminderAt);

    await ctx.adapter.execute({
      operation: "update_task",
      operationId: "task-update-legacy-3",
      taskId: created.taskId,
      expectedRevision: renamed.revision,
      patch: {
        dueDate: "2033-01-02",
        dueTime: "04:05",
        reminderDate: "2033-01-02",
        reminderTime: "04:05"
      }
    });
    const stored = (await ctx.db.tasks.get(created.taskId))!;
    expect(stored.scheduleVersion).toBe(2);
    expect(stored.reminderDate).toBe("2033-01-02");
    expect(stored.dueDate).toBe("2033-01-02");
  });

  it("survives a close/reopen and keeps the legacy-urgent receipt replayable", async () => {
    harness = await createHarness();
    const ctx = harness;
    const reminderAt = Date.parse("2034-09-10T11:12:00.000Z");
    const request = createRequest(ctx, "task-restart", {
      title: "Restart",
      urgent: true,
      reminderAt
    });
    const first = (await ctx.adapter.execute(request)) as CreateResult;
    const dbPath = ctx.path;
    const accountId = ctx.accountId;
    const notebookId = ctx.notebookId;
    const noteId = ctx.noteId;
    const listId = ctx.listId;
    ctx.adapter.close();
    await ctx.close();
    harness = undefined;

    const reopened = await openConnectDb(dbPath);
    harness = {
      ...reopened,
      adapter: new ConnectAdapter(reopened.db),
      accountId,
      notebookId,
      noteId,
      listId
    };
    await harness.adapter.setGrants({
      accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [notebookId],
      noteIDs: [noteId],
      listIDs: [listId]
    });
    const replay = (await harness.adapter.execute(request)) as CreateResult;
    expect(replay.taskId).toBe(first.taskId);
    expect((await reopened.db.tasks.get(first.taskId))!.reminderAt).toBe(
      reminderAt
    );
  });
});

/**
 * `create_task` recovery verification must pin the *stored* record and respect
 * the reserved record's current privacy/scope. A reserved id occupied by a
 * different (or now-private) Task is never reported as this operation's success
 * and is never overwritten.
 */
describe("VeyraN Connect create_task recovery verification", () => {
  it("reports uncertain when the reserved id holds a different Task", async () => {
    harness = await createHarness();
    const ctx = harness;
    const operationId = "task-recovery-wrong";
    const reservedId = "taskrecoverywrong00001";
    await new IdempotencyJournal(ctx.db).begin({
      operationId,
      operation: "create_task",
      accountId: ctx.accountId,
      fingerprint: createTaskFingerprint("Intended", ctx.listId),
      createReservation: async () => ({
        reservedId,
        expect: {
          kind: "task_create",
          titleHash: hashId("Intended"),
          listId: ctx.listId
        }
      })
    });
    // A *different* Task (same title, different reserved id) already occupies
    // the reserved id with a wrong title.
    const other = await ctx.db.tasks.create({
      id: reservedId,
      title: "Someone else",
      listId: ctx.listId
    });
    expect(other.title).toBe("Someone else");

    await expectCode(
      ctx.adapter.execute(
        createRequest(ctx, operationId, { title: "Intended" })
      ),
      "IDEMPOTENCY_UNCERTAIN"
    );
    // The pre-existing record is untouched.
    expect((await ctx.db.tasks.get(reservedId))!.title).toBe("Someone else");
  });

  it("reports uncertain when the reserved id holds the same title in a different list", async () => {
    harness = await createHarness();
    const ctx = harness;
    const otherList = await ctx.db.taskLists.create("Recovery other");
    await ctx.adapter.setGrants({
      accountId: ctx.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [ctx.notebookId],
      noteIDs: [ctx.noteId],
      listIDs: [ctx.listId, otherList.id]
    });
    const operationId = "task-recovery-wrong-list";
    const reservedId = "taskrecoverywronglist01";
    await new IdempotencyJournal(ctx.db).begin({
      operationId,
      operation: "create_task",
      accountId: ctx.accountId,
      fingerprint: createTaskFingerprint("Same title", ctx.listId),
      createReservation: async () => ({
        reservedId,
        expect: {
          kind: "task_create",
          titleHash: hashId("Same title"),
          listId: ctx.listId
        }
      })
    });
    await ctx.db.tasks.create({
      id: reservedId,
      title: "Same title",
      listId: otherList.id
    });
    await expectCode(
      ctx.adapter.execute(
        createRequest(ctx, operationId, { title: "Same title" })
      ),
      "IDEMPOTENCY_UNCERTAIN"
    );
  });

  it("refuses recovery when the reserved record lives in a raw-private list", async () => {
    harness = await createHarness();
    const ctx = harness;
    const otherList = await ctx.db.taskLists.create("Recovery private");
    await ctx.adapter.setGrants({
      accountId: ctx.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [ctx.notebookId],
      noteIDs: [ctx.noteId],
      listIDs: [ctx.listId, otherList.id]
    });
    const operationId = "task-recovery-private";
    const reservedId = "taskrecoveryprivate01";
    await new IdempotencyJournal(ctx.db).begin({
      operationId,
      operation: "create_task",
      accountId: ctx.accountId,
      fingerprint: createTaskFingerprint("Private", ctx.listId),
      createReservation: async () => ({
        reservedId,
        expect: {
          kind: "task_create",
          titleHash: hashId("Private"),
          listId: ctx.listId
        }
      })
    });
    // The record exists in a *granted* list, but its raw settings row is
    // private — the request's own (shareable) list must not stand in for it.
    await ctx.db.tasks.create({
      id: reservedId,
      title: "Private",
      listId: otherList.id
    });
    await hideListRaw(ctx, otherList.id);

    await expectCode(
      ctx.adapter.execute(
        createRequest(ctx, operationId, { title: "Private" })
      ),
      "NOT_AUTHORIZED"
    );
    // The private contents are not read out or overwritten.
    expect((await ctx.db.tasks.get(reservedId))!.title).toBe("Private");
  });

  it("refuses a committed replay once the stored record moved into a raw-private list", async () => {
    harness = await createHarness();
    const ctx = harness;
    const otherList = await ctx.db.taskLists.create("Committed other");
    const request = createRequest(ctx, "task-committed-moved", {
      title: "Committed"
    });
    const created = (await ctx.adapter.execute(request)) as CreateResult;

    await ctx.adapter.setGrants({
      accountId: ctx.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [ctx.notebookId],
      noteIDs: [ctx.noteId],
      listIDs: [ctx.listId, otherList.id]
    });
    await ctx.db.tasks.update(created.taskId, { listId: otherList.id });
    await hideListRaw(ctx, otherList.id);

    // The request's own list is still shareable, but the *stored* record is
    // not — a committed replay must re-check the record's current list.
    await expectCode(ctx.adapter.execute(request), "NOT_AUTHORIZED");
    expect((await ctx.db.tasks.get(created.taskId))!.title).toBe("Committed");
  });

  it("refuses a committed replay once the stored Task was deleted", async () => {
    harness = await createHarness();
    const ctx = harness;
    const request = createRequest(ctx, "task-committed-deleted", {
      title: "Committed gone"
    });
    const created = (await ctx.adapter.execute(request)) as CreateResult;
    expect(await ctx.db.tasks.get(created.taskId)).toBeTruthy();

    await ctx.db.tasks.remove(created.taskId);
    expect(await ctx.db.tasks.get(created.taskId)).toBeUndefined();

    // A committed receipt names an object that was durably written: with the
    // record gone, the replay is denied rather than acknowledged against
    // storage that no longer holds it.
    await expectCode(ctx.adapter.execute(request), "NOT_AUTHORIZED");
    // ...and it never resurrects the deleted Task.
    expect(await ctx.db.tasks.get(created.taskId)).toBeUndefined();
    expect(
      ctx.db.tasks.listSync().some((task) => task.id === created.taskId)
    ).toBe(false);
  });

  it("does not honour a legacy plaintext title shape in a create_task receipt", async () => {
    harness = await createHarness();
    const ctx = harness;
    const operationId = "task-receipt-plaintext";
    const reservedId = "taskreceiptplaintext01";
    await new IdempotencyJournal(ctx.db).begin({
      operationId,
      operation: "create_task",
      accountId: ctx.accountId,
      fingerprint: createTaskFingerprint("Plain", ctx.listId),
      createReservation: async () => ({
        reservedId,
        // The pre-hash legacy shape: a plaintext/model title with no hash. No
        // receipt in the wild carries it, so it must fail closed.
        expect: { kind: "task_create", title: "Plain", listId: ctx.listId }
      })
    });
    // The exact record the operation "would" have written exists at the
    // reserved id, with the plaintext title the legacy receipt records.
    await ctx.db.tasks.create({
      id: reservedId,
      title: "Plain",
      listId: ctx.listId
    });

    await expectCode(
      ctx.adapter.execute(createRequest(ctx, operationId, { title: "Plain" })),
      "IDEMPOTENCY_UNCERTAIN"
    );
    // The pre-existing record is untouched and never overwritten.
    expect((await ctx.db.tasks.get(reservedId))!.title).toBe("Plain");
  });

  it("keeps a committed note receipt historical when the note was trashed", async () => {
    harness = await createHarness();
    const ctx = harness;
    const request = {
      operation: "create_note" as const,
      operationId: "note-committed-trashed",
      content: "historical body"
    };
    const created = (await ctx.adapter.execute(request)) as { noteId: string };
    await ctx.db.notes.remove(created.noteId);
    expect(await ctx.db.notes.note(created.noteId)).toBeUndefined();

    // Note create replay is intentionally historical: the bounded result carries
    // no title/body, and replaying it must never re-create the note or leak its
    // private content.
    const before = await ctx.db.notes.all.count();
    const replay = (await ctx.adapter.execute(request)) as { noteId: string };
    expect(replay.noteId).toBe(created.noteId);
    expect(await ctx.db.notes.all.count()).toBe(before);
    expect(await ctx.db.notes.note(created.noteId)).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain("historical body");
  });
});
