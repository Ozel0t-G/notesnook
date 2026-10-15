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
  noteContentIds,
  signIn
} from "./fixtures.js";
import { ConnectAdapter } from "../../src/connect/adapter.js";
import { noteRevision, taskRevision } from "../../src/connect/revision.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

async function receiptCount(db: ConnectHarness["db"]): Promise<number> {
  const rows = await db
    .sql()
    .selectFrom("settings")
    .select(["key"])
    .where("key", "like", "veyranConnect:v1:receipt:%")
    .execute();
  return rows.length;
}

async function attachmentCount(db: ConnectHarness["db"]): Promise<number> {
  const rows = await db
    .sql()
    .selectFrom("attachments")
    .select(["id"])
    .execute();
  return rows.length;
}

async function revisionOf(db: ConnectHarness["db"], noteId: string) {
  const note = await db.notes.note(noteId);
  const content = await db.content.findByNoteId(noteId);
  return noteRevision(note!, content);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

/**
 * Gate corrections after the reviewed boundary patch: authorization must
 * precede the payload fingerprint/receipt, task payloads must be validated by
 * the *actual* domain rules before a reservation, unexpected failures must be
 * normalized to the bounded error surface, an empty-title create/update must
 * not strand, search truncation/limits must reflect only visible hits, and a
 * legacy inline attachment may not be re-imported by a plain append.
 */
describe("VeyraN Connect authorization precedes receipt", () => {
  it("answers a revoked-scope reuse with NOT_AUTHORIZED", async () => {
    harness = await createHarness();
    await harness.adapter.execute({
      operation: "create_note",
      operationId: "gate-revoked-reuse",
      content: "first body"
    });
    // Same account, but the creation scope is gone. Reusing the operationId
    // with a *different* payload must not reveal that a receipt exists.
    await harness.adapter.setGrants({
      accountId: harness.accountId,
      canRead: true,
      canChange: true
    });
    await expectCode(
      harness.adapter.execute({
        operation: "create_note",
        operationId: "gate-revoked-reuse",
        content: "different body"
      }),
      "NOT_AUTHORIZED"
    );
  });

  it("does not reserve a receipt for an unauthorized mutation", async () => {
    harness = await createHarness();
    const before = await receiptCount(harness.db);
    await harness.adapter.setGrants({
      accountId: harness.accountId,
      canRead: true
    });
    await expectCode(
      harness.adapter.execute({
        operation: "create_note",
        operationId: "gate-no-receipt",
        content: "# A body that must never be converted"
      }),
      "NOT_AUTHORIZED"
    );
    expect(await receiptCount(harness.db)).toBe(before);
  });

  it("revokes access to notes of a non-live granted notebook", async () => {
    harness = await createHarness();
    const note = await harness.db.notes.add({
      title: "Notebook note",
      content: { type: "tiptap", data: "<p>notebook secret</p>" }
    });
    await harness.db.notes.addToNotebook(harness.notebookId, note);
    const before = (await harness.adapter.execute({
      operation: "get_note",
      noteId: note
    })) as { noteId: string };
    expect(before.noteId).toBe(note);

    // Soft-delete the notebook *without* unlinking its relations, so the only
    // thing that can deny the note is the live-notebook check.
    await harness.db
      .sql()
      .updateTable("notebooks")
      .set({ deleted: true })
      .where("id", "=", harness.notebookId)
      .execute();
    const relations = await harness.db
      .sql()
      .selectFrom("relations")
      .select(["id"])
      .where("fromId", "=", harness.notebookId)
      .where("toId", "=", note)
      .execute();
    expect(relations.length).toBeGreaterThan(0);

    await expectCode(
      harness.adapter.execute({ operation: "get_note", noteId: note }),
      "NOT_AUTHORIZED"
    );
  });
});

describe("VeyraN Connect task payload validation before reservation", () => {
  it("rejects an empty task title with no receipt/record", async () => {
    harness = await createHarness();
    const beforeReceipts = await receiptCount(harness.db);
    const beforeTasks = harness.db.tasks.listSync().length;
    await expectCode(
      harness.adapter.execute({
        operation: "create_task",
        operationId: "gate-task-empty-title",
        listId: harness.listId,
        title: "   "
      }),
      "INVALID_INPUT"
    );
    expect(await receiptCount(harness.db)).toBe(beforeReceipts);
    expect(harness.db.tasks.listSync().length).toBe(beforeTasks);
  });

  it("rejects an urgent task without a reminder date and time", async () => {
    harness = await createHarness();
    const before = await receiptCount(harness.db);
    await expectCode(
      harness.adapter.execute({
        operation: "create_task",
        operationId: "gate-task-urgent",
        listId: harness.listId,
        title: "Urgent",
        urgent: true
      }),
      "INVALID_INPUT"
    );
    expect(await receiptCount(harness.db)).toBe(before);
  });

  it("rejects a recurring task without a due date", async () => {
    harness = await createHarness();
    await expectCode(
      harness.adapter.execute({
        operation: "create_task",
        operationId: "gate-task-recurrence",
        listId: harness.listId,
        title: "Recurring",
        recurrenceRule: "FREQ=DAILY"
      }),
      "INVALID_INPUT"
    );
  });

  it("rejects an impossible calendar date", async () => {
    harness = await createHarness();
    await expectCode(
      harness.adapter.execute({
        operation: "create_task",
        operationId: "gate-task-impossible-date",
        listId: harness.listId,
        title: "Impossible",
        dueDate: "2025-02-30"
      }),
      "INVALID_INPUT"
    );
  });

  it("rejects an update that clears the title or adds a time", async () => {
    harness = await createHarness();
    const task = await harness.db.tasks.create({
      title: "Keep me",
      listId: harness.listId
    });
    await expectCode(
      harness.adapter.execute({
        operation: "update_task",
        operationId: "gate-task-update-empty-title",
        taskId: task.id,
        expectedRevision: taskRevision(task),
        patch: { title: "" }
      }),
      "INVALID_INPUT"
    );
    expect((await harness.db.tasks.get(task.id))?.title).toBe("Keep me");

    await expectCode(
      harness.adapter.execute({
        operation: "update_task",
        operationId: "gate-task-update-time-only",
        taskId: task.id,
        expectedRevision: taskRevision(task),
        patch: { dueTime: "09:00" }
      }),
      "INVALID_INPUT"
    );
    expect((await harness.db.tasks.get(task.id))?.dueTime).toBeUndefined();
  });
});

describe("VeyraN Connect bounded error surface", () => {
  it("normalizes an unexpected mutation failure", async () => {
    harness = await createHarness();
    const tasks = harness.db.tasks;
    const originalCreate = tasks.create.bind(tasks);
    const secret = "SQLITE_ERROR: raw-secret-body SELECT * FROM notes";
    tasks.create = (async () => {
      throw new Error(secret);
    }) as typeof tasks.create;
    try {
      let caught: unknown;
      try {
        await harness.adapter.execute({
          operation: "create_task",
          operationId: "gate-raw-error",
          listId: harness.listId,
          title: "raw"
        });
      } catch (error) {
        caught = error;
      }
      expect(errorCode(caught)).toBe("INVALID_INPUT");
      expect(String((caught as Error)?.message ?? "")).not.toContain(
        "raw-secret"
      );
      expect(String(caught)).not.toContain("raw-secret");
    } finally {
      tasks.create = originalCreate;
    }
  });

  it("rejects a non-integer journal capacity", async () => {
    harness = await createHarness();
    for (const value of [NaN, 0, -1, Infinity, 1.5]) {
      let caught: unknown;
      try {
        new ConnectAdapter(harness.db, { maxJournalEntries: value });
      } catch (error) {
        caught = error;
      }
      expect(errorCode(caught), `maxJournalEntries=${value}`).toBe(
        "INVALID_INPUT"
      );
    }
  });
});

describe("VeyraN Connect search visibility and bounds", () => {
  it("reports a hidden-only match exactly like no match", async () => {
    harness = await createHarness();
    const hidden = await harness.db.notes.add({
      title: "Hidden hit",
      content: { type: "tiptap", data: "<p>hiddenneedletoken</p>" }
    });
    await harness.db.notes.addToNotebook(harness.notebookId, hidden);
    await harness.db.notes.localOnly(true, hidden);

    const hiddenResult = (await harness.adapter.execute({
      operation: "search_notes",
      query: "hiddenneedletoken",
      limit: 1
    })) as { results: unknown[]; truncated: boolean };
    const noMatch = (await harness.adapter.execute({
      operation: "search_notes",
      query: "definitelynomatchtoken",
      limit: 1
    })) as { results: unknown[]; truncated: boolean };

    expect(hiddenResult.results).toEqual([]);
    expect(hiddenResult.truncated).toBe(false);
    expect(JSON.stringify(hiddenResult)).toBe(JSON.stringify(noMatch));
  });

  it("honors the requested limit and flags an overflow", async () => {
    harness = await createHarness();
    for (const suffix of ["one", "two"]) {
      const id = await harness.db.notes.add({
        title: `Limit ${suffix}`,
        content: { type: "tiptap", data: `<p>limitneedletoken ${suffix}</p>` }
      });
      await harness.db.notes.addToNotebook(harness.notebookId, id);
    }
    const result = (await harness.adapter.execute({
      operation: "search_notes",
      query: "limitneedletoken",
      limit: 1
    })) as { results: { noteId: string }[]; truncated: boolean };
    expect(result.results.length).toBe(1);
    expect(result.truncated).toBe(true);

    const all = (await harness.adapter.execute({
      operation: "search_notes",
      query: "limitneedletoken"
    })) as { results: { noteId: string }[]; truncated: boolean };
    expect(all.results.length).toBe(2);
    expect(all.truncated).toBe(false);
  });

  it("never returns the same note twice for a title+body match", async () => {
    harness = await createHarness();
    const dup = await harness.db.notes.add({
      title: "dupneedletoken title",
      content: { type: "tiptap", data: "<p>dupneedletoken body</p>" }
    });
    await harness.db.notes.addToNotebook(harness.notebookId, dup);
    const result = (await harness.adapter.execute({
      operation: "search_notes",
      query: "dupneedletoken"
    })) as { results: { noteId: string }[] };
    const ids = result.results.map((r) => r.noteId);
    expect(ids.filter((id) => id === dup).length).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("VeyraN Connect raw local-only settings rows", () => {
  it("does not list a task whose raw settings row is local-only", async () => {
    harness = await createHarness();
    const task = await harness.db.tasks.create({
      title: "raw local only",
      listId: harness.listId
    });
    const { makeId } = await import("../../src/utils/id.js");
    const recordKey = `appleTasks:v1:task:${task.id}`;
    // Simulate a legacy/foreign writer: the *raw* column is local-only while
    // the JSON payload no longer carries the flag.
    const { localOnly: _dropped, ...json } = task as unknown as Record<
      string,
      unknown
    >;
    await harness.db.settings.collection.upsert({
      id: makeId(recordKey),
      type: "settingitem",
      key: recordKey,
      value: JSON.stringify(json),
      localOnly: true,
      dateCreated: Date.now()
    } as never);

    // The parsed JSON record is still listable (its `localOnly` is absent); it
    // is the *raw* setting row that must hide it.
    expect(
      harness.db.tasks.listSync().some((entry) => entry.id === task.id)
    ).toBe(true);

    const listed = (await harness.adapter.execute({
      operation: "list_tasks"
    })) as { tasks: { taskId: string }[]; total: number };
    expect(listed.tasks.some((entry) => entry.taskId === task.id)).toBe(false);
    expect(listed.total).toBe(0);
  });
});

describe("VeyraN Connect task revision coverage", () => {
  it("changes when localOnly or reminderLeadMinutes changes", async () => {
    harness = await createHarness();
    const task = await harness.db.tasks.create({
      title: "revision",
      listId: harness.listId
    });
    const base = taskRevision(task);
    expect(taskRevision({ ...task, localOnly: true })).not.toBe(base);
    expect(taskRevision({ ...task, reminderLeadMinutes: 42 })).not.toBe(base);
    expect(taskRevision({ ...task, legacyReminderId: "legacy" })).not.toBe(
      base
    );
  });
});

describe("VeyraN Connect legacy inline attachments", () => {
  it("refuses a plain append on a legacy inline base64 body", async () => {
    harness = await createHarness();
    const target = await harness.db.notes.add({
      title: "Legacy inline",
      content: { type: "tiptap", data: '<p data-block-id="seed">hello</p>' }
    });
    await harness.db.notes.addToNotebook(harness.notebookId, target);
    // Write the legacy body *directly* (bypassing the content pipeline) so no
    // attachment row is created: this models a body from an older client.
    const legacyBody =
      '<p data-block-id="seed"><img src="data:image/png;base64,c2VlZA=="></p>';
    await harness.db
      .sql()
      .updateTable("content")
      .set({ data: legacyBody })
      .where("noteId", "=", target)
      .execute();

    const attachmentsBefore = await attachmentCount(harness.db);
    const receiptsBefore = await receiptCount(harness.db);
    const noteBefore = await harness.db.notes.note(target);
    const revision = await revisionOf(harness.db, target);

    await expectCode(
      harness.adapter.execute({
        operation: "append_to_note",
        operationId: "gate-legacy-append",
        noteId: target,
        content: "tail",
        expectedRevision: revision
      }),
      "UNSUPPORTED_CONTENT"
    );

    expect(await attachmentCount(harness.db)).toBe(attachmentsBefore);
    expect(await receiptCount(harness.db)).toBe(receiptsBefore);
    const noteAfter = await harness.db.notes.note(target);
    expect(noteAfter?.title).toBe(noteBefore?.title);
    expect(noteAfter?.dateEdited).toBe(noteBefore?.dateEdited);
    const contentAfter = await harness.db.content.findByNoteId(target);
    expect(String(contentAfter?.data)).toBe(legacyBody);
  });
});

describe("VeyraN Connect final coherent account read", () => {
  it("denies a note read when the account changes at the end", async () => {
    const ctx = await createHarness();
    harness = ctx;
    // `get_note` reads the note's current content row (through the read-only
    // `SQLCollection.get`, keyed by the note's own `contentId`) once during
    // dispatch and once inside the coherent rebuild. Flip the *persisted*
    // account on the second read, after the last fence assert and before the
    // final bare account read.
    const content = ctx.db.content;
    const contentIds = await noteContentIds(ctx.db, [ctx.noteId]);
    const targetContentId = [...contentIds.keys()][0];
    const originalGet = content.collection.get.bind(content.collection);
    let reads = 0;
    content.collection.get = async (contentId: string) => {
      const row = await originalGet(contentId);
      if (contentId === targetContentId) {
        reads++;
        if (reads === 2) await signIn(ctx.db, "acct-2");
      }
      return row;
    };

    try {
      await expectCode(
        ctx.adapter.execute({ operation: "get_note", noteId: ctx.noteId }),
        "SESSION_CHANGED"
      );
      expect(reads).toBe(2);
    } finally {
      content.collection.get = originalGet;
    }
  });
});

/**
 * A Task list is shareable only while its *raw* settings row is not
 * `localOnly`. The raw column is the domain privacy marker sync carries, and a
 * granted id never overrides it: the check must run before the payload
 * fingerprint, before a durable receipt is looked up (replay) and before any
 * record is written, on every Task operation.
 */
describe("VeyraN Connect raw Task-list privacy", () => {
  async function hideListRaw(ctx: ConnectHarness, listId: string) {
    const { makeId } = await import("../../src/utils/id.js");
    const recordKey = `appleTasks:v1:list:${listId}`;
    const existing = ctx.db.taskLists.getSync(listId)!;
    // Legacy/foreign writer: the raw column is local-only while the JSON
    // payload carries no flag, so only the raw marker can hide it.
    await ctx.db.settings.collection.upsert({
      id: makeId(recordKey),
      type: "settingitem",
      key: recordKey,
      value: JSON.stringify(existing),
      localOnly: true,
      dateCreated: Date.now()
    } as never);
  }

  it("does not list, create in, or mutate a raw local-only list", async () => {
    harness = await createHarness();
    const ctx = harness;
    const task = await ctx.db.tasks.create({
      title: "keep me",
      listId: ctx.listId
    });
    const beforeReceipts = await receiptCount(ctx.db);
    await hideListRaw(ctx, ctx.listId);

    // The parsed JSON record is still listable…
    expect(ctx.db.taskLists.listSync().some((l) => l.id === ctx.listId)).toBe(
      true
    );
    // …but the raw row hides it, so the Connect listing must not show it and
    // the tasks inside it must not be listed either.
    const lists = (await ctx.adapter.execute({
      operation: "list_task_lists"
    })) as { lists: { id: string }[] };
    expect(lists.lists.some((l) => l.id === ctx.listId)).toBe(false);
    const listed = (await ctx.adapter.execute({
      operation: "list_tasks"
    })) as { tasks: { taskId: string }[] };
    expect(listed.tasks.some((t) => t.taskId === task.id)).toBe(false);

    await expectCode(
      ctx.adapter.execute({
        operation: "create_task",
        operationId: "raw-list-create",
        listId: ctx.listId,
        title: "nope"
      }),
      "NOT_AUTHORIZED"
    );
    await expectCode(
      ctx.adapter.execute({
        operation: "update_task",
        operationId: "raw-list-update",
        taskId: task.id,
        expectedRevision: taskRevision(task),
        patch: { title: "hijack" }
      }),
      "NOT_AUTHORIZED"
    );
    await expectCode(
      ctx.adapter.execute({
        operation: "complete_task",
        operationId: "raw-list-complete",
        taskId: task.id,
        expectedRevision: taskRevision(task)
      }),
      "NOT_AUTHORIZED"
    );
    expect(await receiptCount(ctx.db)).toBe(beforeReceipts);
    expect((await ctx.db.tasks.get(task.id))?.title).toBe("keep me");
    expect((await ctx.db.tasks.get(task.id))?.completed).toBe(false);
  });

  it("denies a replay of a committed task receipt once its list is raw local-only", async () => {
    harness = await createHarness();
    const ctx = harness;
    const request = {
      operation: "create_task" as const,
      operationId: "raw-list-replay",
      listId: ctx.listId,
      title: "committed"
    };
    const created = (await ctx.adapter.execute(request)) as { taskId: string };
    await hideListRaw(ctx, ctx.listId);
    // The current grant/target check runs before the recorded outcome is read:
    // a revoked scope must not be able to read the receipt back.
    await expectCode(ctx.adapter.execute(request), "NOT_AUTHORIZED");
    expect((await ctx.db.tasks.get(created.taskId))?.title).toBe("committed");
  });
});
