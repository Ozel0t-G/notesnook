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
  openConnectDb,
  signIn
} from "./fixtures.js";
import { ConnectAdapter } from "../../src/connect/adapter.js";
import { IdempotencyJournal } from "../../src/connect/journal.js";
import {
  fingerprintOf,
  noteContentHash,
  noteRevision,
  taskRevision
} from "../../src/connect/revision.js";
import { toTiptapHtml } from "../../src/connect/content.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

async function prepareHtml(
  db: ConnectHarness["db"],
  format: "markdown" | "plaintext" | "tiptap",
  content: string
) {
  const draft = { type: "tiptap" as const, data: toTiptapHtml(format, content) };
  await db.content.preProcess(draft);
  return draft.data;
}

async function revisionOf(db: ConnectHarness["db"], noteId: string) {
  const note = await db.notes.note(noteId);
  const content = await db.content.findByNoteId(noteId);
  return noteRevision(note!, content);
}

describe("VeyraN Connect idempotent writes", () => {
  it("creates a note with a real id, url and evidence", async () => {
    harness = await createHarness();
    const result = (await harness.adapter.execute({
      operation: "create_note",
      operationId: "create-1",
      content: "# Title\n\nBody **bold**"
    })) as Record<string, string>;
    expect(result.operationId).toBe("create-1");
    expect(result.url).toBe(`nn://note/${result.noteId}`);
    expect(result.persisted).toBe("local_saved");
    expect(result.sync).toBe("unknown");
    expect(await harness.db.notes.exists(result.noteId)).toBe(true);
    const content = await harness.db.content.findByNoteId(result.noteId);
    expect(content!.data).toContain("<strong>bold</strong>");
    expect(content!.data).toContain("data-block-id");
  });

  it("replays an identical operation without a second write", async () => {
    harness = await createHarness();
    const request = {
      operation: "create_note" as const,
      operationId: "replay-1",
      content: "hello world"
    };
    const first = (await harness.adapter.execute(request)) as {
      noteId: string;
    };
    const before = await harness.db.notes.all.count();
    const second = (await harness.adapter.execute(request)) as {
      noteId: string;
    };
    expect(second.noteId).toBe(first.noteId);
    expect(await harness.db.notes.all.count()).toBe(before);
  });

  it("rejects a reused operationId with a different payload", async () => {
    harness = await createHarness();
    await harness.adapter.execute({
      operation: "create_note",
      operationId: "conflict-1",
      content: "first"
    });
    await expectCode(
      harness.adapter.execute({
        operation: "create_note",
        operationId: "conflict-1",
        content: "second"
      }),
      "IDEMPOTENCY_CONFLICT"
    );
  });

  it("serializes the same operationId across two adapter instances", async () => {
    harness = await createHarness();
    const second = new ConnectAdapter(harness.db);
    await second.setGrants({
      accountId: harness.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [harness.notebookId],
      noteIDs: [harness.noteId],
      listIDs: [harness.listId]
    });
    const request = {
      operation: "create_note" as const,
      operationId: "concurrent-1",
      content: "concurrent content"
    };
    const before = await harness.db.notes.all.count();
    const [a, b] = (await Promise.all([
      harness.adapter.execute(request),
      second.execute(request)
    ])) as { noteId: string }[];
    expect(a.noteId).toBe(b.noteId);
    expect(await harness.db.notes.all.count()).toBe(before + 1);
    second.close();
  });

  it("fails closed on a full journal instead of evicting history", async () => {
    harness = await createHarness({ maxJournalEntries: 1 });
    await harness.adapter.execute({
      operation: "create_note",
      operationId: "full-1",
      content: "one"
    });
    await expectCode(
      harness.adapter.execute({
        operation: "create_note",
        operationId: "full-2",
        content: "two"
      }),
      "JOURNAL_FULL"
    );
    // The first receipt must still be replayable.
    const replay = (await harness.adapter.execute({
      operation: "create_note",
      operationId: "full-1",
      content: "one"
    })) as { noteId: string };
    expect(replay.noteId).toBeTruthy();
  });

  it("fails closed on a corrupt receipt", async () => {
    harness = await createHarness();
    const { makeId } = await import("../../src/utils/id.js");
    const { RECEIPT_PREFIX } = await import("../../src/connect/journal.js");
    const operationId = "corrupt-1";
    const key = `${RECEIPT_PREFIX}${operationId}`;
    await harness.db.settings.collection.upsert({
      id: makeId(key),
      type: "settingitem",
      key,
      value: "{not-json",
      dateCreated: Date.now()
    } as never);
    await expectCode(
      harness.adapter.execute({
        operation: "create_note",
        operationId,
        content: "x"
      }),
      "JOURNAL_CORRUPT"
    );
  });

  it("fails closed on a tombstoned receipt", async () => {
    harness = await createHarness();
    const { makeId } = await import("../../src/utils/id.js");
    const { RECEIPT_PREFIX } = await import("../../src/connect/journal.js");
    const operationId = "tombstone-1";
    await harness.adapter.execute({
      operation: "create_note",
      operationId,
      content: "x"
    });
    const key = `${RECEIPT_PREFIX}${operationId}`;
    await harness.db.settings.collection.softDelete([makeId(key)]);
    await expectCode(
      harness.adapter.execute({
        operation: "create_note",
        operationId,
        content: "x"
      }),
      "JOURNAL_CORRUPT"
    );
  });

  it("recovers a crash before the write without duplicating", async () => {
    harness = await createHarness();
    const operationId = "crash-before";
    const html = await prepareHtml(harness.db, "markdown", "crash before");
    const contentHash = noteContentHash("tiptap", html);
    const reservedId = "crashbefore000000000001";
    await new IdempotencyJournal(harness.db).begin({
      operationId,
      operation: "create_note",
      accountId: harness.accountId,
      fingerprint: fingerprintOf({
        operation: "create_note",
        notebookId: null,
        title: null,
        format: "markdown",
        contentHash
      }),
      createReservation: async () => ({
        reservedId,
        expect: { kind: "note_create", contentHash, title: null }
      })
    });
    expect(await harness.db.notes.exists(reservedId)).toBe(false);
    const result = (await harness.adapter.execute({
      operation: "create_note",
      operationId,
      content: "crash before"
    })) as { noteId: string };
    expect(result.noteId).toBe(reservedId);
    expect(await harness.db.notes.exists(reservedId)).toBe(true);
  });

  it("recovers a crash after the write without overwriting", async () => {
    harness = await createHarness();
    const operationId = "crash-after";
    const html = await prepareHtml(harness.db, "markdown", "crash after");
    const contentHash = noteContentHash("tiptap", html);
    const reservedId = "crashafter0000000000001";
    await new IdempotencyJournal(harness.db).begin({
      operationId,
      operation: "create_note",
      accountId: harness.accountId,
      fingerprint: fingerprintOf({
        operation: "create_note",
        notebookId: null,
        title: null,
        format: "markdown",
        contentHash
      }),
      createReservation: async () => ({
        reservedId,
        expect: { kind: "note_create", contentHash, title: null }
      })
    });
    // Simulate the write having landed before the acknowledgement was lost.
    await harness.db.notes.add({
      id: reservedId,
      content: { type: "tiptap", data: html }
    });
    const before = await harness.db.notes.all.count();
    const result = (await harness.adapter.execute({
      operation: "create_note",
      operationId,
      content: "crash after"
    })) as { noteId: string };
    expect(result.noteId).toBe(reservedId);
    expect(await harness.db.notes.all.count()).toBe(before);
  });

  it("reports uncertain instead of an unrelated existing object", async () => {
    harness = await createHarness();
    const operationId = "crash-unrelated";
    const html = await prepareHtml(harness.db, "markdown", "intended");
    const contentHash = noteContentHash("tiptap", html);
    const reservedId = "crashunrelated0000000001";
    await new IdempotencyJournal(harness.db).begin({
      operationId,
      operation: "create_note",
      accountId: harness.accountId,
      fingerprint: fingerprintOf({
        operation: "create_note",
        notebookId: null,
        title: null,
        format: "markdown",
        contentHash
      }),
      createReservation: async () => ({
        reservedId,
        expect: { kind: "note_create", contentHash, title: null }
      })
    });
    await harness.db.notes.add({
      id: reservedId,
      content: { type: "tiptap", data: "<p>someone else</p>" }
    });
    await expectCode(
      harness.adapter.execute({
        operation: "create_note",
        operationId,
        content: "intended"
      }),
      "IDEMPOTENCY_UNCERTAIN"
    );
  });

  it("restores the notebook binding when a create crashed after the body landed", async () => {
    harness = await createHarness();
    const operationId = "crash-binding";
    const html = await prepareHtml(harness.db, "markdown", "binding body");
    const contentHash = noteContentHash("tiptap", html);
    const reservedId = "crashbinding00000000001";
    await new IdempotencyJournal(harness.db).begin({
      operationId,
      operation: "create_note",
      accountId: harness.accountId,
      fingerprint: fingerprintOf({
        operation: "create_note",
        notebookId: harness.notebookId,
        title: null,
        format: "markdown",
        contentHash
      }),
      createReservation: async () => ({
        reservedId,
        expect: {
          kind: "note_create",
          contentHash,
          title: null,
          notebookId: harness.notebookId
        }
      })
    });
    // The body was persisted but the required notebook association was not.
    await harness.db.notes.add({
      id: reservedId,
      content: { type: "tiptap", data: html }
    });
    const before = await harness.db.notes.all.count();

    const result = (await harness.adapter.execute({
      operation: "create_note",
      operationId,
      notebookId: harness.notebookId,
      content: "binding body"
    })) as { noteId: string };
    expect(result.noteId).toBe(reservedId);
    expect(await harness.db.notes.all.count()).toBe(before);

    const relations = await harness.db.relations
      .to({ id: reservedId, type: "note" }, "notebook")
      .get();
    expect(relations.some((r) => r.fromId === harness.notebookId)).toBe(true);
  });

  it("refuses to replay a receipt after the scope is revoked", async () => {
    harness = await createHarness();
    const request = {
      operation: "create_note" as const,
      operationId: "revoke-replay-1",
      content: "revoked body"
    };
    await harness.adapter.execute(request);

    // Same account, but the creation scope is gone: the recorded outcome must
    // not be readable, replayed or re-executed.
    await harness.adapter.setGrants({
      accountId: harness.accountId,
      canRead: true,
      canChange: true
    });
    await expectCode(harness.adapter.execute(request), "NOT_AUTHORIZED");

    // Same for a different account.
    await signIn(harness.db, "acct-2");
    await expectCode(harness.adapter.execute(request), "DENIED");
  });

  it("refuses to replay a receipt while locked or after close", async () => {
    harness = await createHarness();
    const request = {
      operation: "create_note" as const,
      operationId: "locked-replay-1",
      content: "locked body"
    };
    await harness.adapter.execute(request);

    harness.adapter.lock();
    await expectCode(harness.adapter.execute(request), "ADAPTER_LOCKED");
    harness.adapter.unlock();

    harness.adapter.close();
    await expectCode(harness.adapter.execute(request), "ADAPTER_CLOSED");
  });

  it("replays an acknowledged creation without reading private contents", async () => {
    harness = await createHarness();
    const request = {
      operation: "create_note" as const,
      operationId: "replay-private",
      content: "private body"
    };
    const first = (await harness.adapter.execute(request)) as {
      noteId: string;
    };
    // Lock the content so any read would be refused; a pure replay still works.
    await harness.db
      .sql()
      .updateTable("content")
      .set({ locked: true, data: JSON.stringify({ cipher: "x" }) })
      .where("noteId", "=", first.noteId)
      .execute();
    const replay = (await harness.adapter.execute(request)) as {
      noteId: string;
    };
    expect(replay.noteId).toBe(first.noteId);
  });

  it("survives close/reopen and keeps the receipt replayable", async () => {
    harness = await createHarness();
    const request = {
      operation: "create_note" as const,
      operationId: "persist-1",
      content: "persisted body"
    };
    const first = (await harness.adapter.execute(request)) as {
      noteId: string;
    };
    const dbPath = harness.path;
    const accountId = harness.accountId;
    const notebookId = harness.notebookId;
    const listId = harness.listId;
    harness.adapter.close();
    await harness.close();
    harness = undefined;

    const reopened = await openConnectDb(dbPath);
    harness = {
      ...reopened,
      adapter: new ConnectAdapter(reopened.db),
      accountId,
      notebookId,
      noteId: first.noteId,
      listId
    };
    await harness.adapter.setGrants({
      accountId,
      canRead: true,
      // A fresh adapter starts with no grants: the replay path re-checks
      // `canCreate` for the recorded operation, so the reopened fixture must
      // grant it explicitly (never widen authorization for the test).
      canCreate: true,
      noteIDs: [first.noteId]
    });
    const got = (await harness.adapter.execute({
      operation: "get_note",
      noteId: first.noteId
    })) as { noteId: string; content: string };
    expect(got.noteId).toBe(first.noteId);
    expect(got.content).toContain("persisted body");
    const replay = (await harness.adapter.execute(request)) as {
      noteId: string;
    };
    expect(replay.noteId).toBe(first.noteId);
  });
});

describe("VeyraN Connect guarded note mutations", () => {
  it("conflicts on a stale revision even for same-millisecond edits", async () => {
    harness = await createHarness();
    const r0 = await revisionOf(harness.db, harness.noteId);
    await harness.db.notes.add({
      id: harness.noteId,
      content: { type: "tiptap", data: "<p>edit one</p>" }
    });
    await harness.db.notes.add({
      id: harness.noteId,
      content: { type: "tiptap", data: "<p>edit two</p>" }
    });
    await expectCode(
      harness.adapter.execute({
        operation: "update_note",
        operationId: "stale-1",
        noteId: harness.noteId,
        expectedRevision: r0,
        patch: { title: "nope" }
      }),
      "REVISION_CONFLICT"
    );
  });

  it("conflicts when a manual edit lands during a delayed reservation", async () => {
    let injected = false;
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          if (label === "note" && !injected) {
            injected = true;
            await harness!.db.notes.add({
              id: harness!.noteId,
              content: { type: "tiptap", data: "<p>manual</p>" }
            });
          }
        }
      }
    });
    const r0 = await revisionOf(harness.db, harness.noteId);
    await expectCode(
      harness.adapter.execute({
        operation: "append_to_note",
        operationId: "delayed-1",
        noteId: harness.noteId,
        content: "appended",
        expectedRevision: r0
      }),
      "REVISION_CONFLICT"
    );
  });

  it("appends and updates with a fresh revision", async () => {
    harness = await createHarness();
    const r0 = await revisionOf(harness.db, harness.noteId);
    const appended = (await harness.adapter.execute({
      operation: "append_to_note",
      operationId: "append-1",
      noteId: harness.noteId,
      content: "**tail**",
      expectedRevision: r0
    })) as { revision: string };
    expect(appended.revision).not.toBe(r0);
    const content = await harness.db.content.findByNoteId(harness.noteId);
    expect(content!.data).toContain("<strong>tail</strong>");

    const updated = (await harness.adapter.execute({
      operation: "update_note",
      operationId: "update-1",
      noteId: harness.noteId,
      expectedRevision: appended.revision,
      patch: { title: "Renamed", pinned: true }
    })) as { revision: string };
    expect(updated.revision).not.toBe(appended.revision);
    const note = await harness.db.notes.note(harness.noteId);
    expect(note!.title).toBe("Renamed");
    expect(note!.pinned).toBe(true);
  });

  it("rejects readonly, trashed and locked transitions without overwriting", async () => {
    harness = await createHarness();
    const r0 = await revisionOf(harness.db, harness.noteId);
    await harness.db.notes.readonly(true, harness.noteId);
    await expectCode(
      harness.adapter.execute({
        operation: "update_note",
        operationId: "ro-1",
        noteId: harness.noteId,
        expectedRevision: r0,
        patch: { title: "x" }
      }),
      "NOTE_READONLY"
    );
    await harness.db.notes.readonly(false, harness.noteId);

    const r1 = await revisionOf(harness.db, harness.noteId);
    await harness.db.notes.moveToTrash(harness.noteId);
    await expectCode(
      harness.adapter.execute({
        operation: "append_to_note",
        operationId: "trash-1",
        noteId: harness.noteId,
        content: "x",
        expectedRevision: r1
      }),
      "NOTE_TRASHED"
    );
  });

  it("never treats locked content as empty", async () => {
    harness = await createHarness();
    const cipher = JSON.stringify({ cipher: "locked", iv: "iv" });
    await harness.db
      .sql()
      .updateTable("content")
      .set({ locked: true, data: cipher })
      .where("noteId", "=", harness.noteId)
      .execute();
    const r = await harness.db.notes.note(harness.noteId);
    await expectCode(
      harness.adapter.execute({
        operation: "append_to_note",
        operationId: "locked-1",
        noteId: harness.noteId,
        content: "x",
        expectedRevision: noteRevision(r!, undefined)
      }),
      "NOTE_LOCKED"
    );
    const after = await harness.db
      .sql()
      .selectFrom("content")
      .select(["data"])
      .where("noteId", "=", harness.noteId)
      .executeTakeFirst();
    expect(after!.data).toBe(cipher);
  });

  it("round-trips unicode and editor formatting", async () => {
    harness = await createHarness();
    const result = (await harness.adapter.execute({
      operation: "create_note",
      operationId: "unicode-1",
      // Created inside the granted notebook so the same adapter is authorized
      // to read it back; the created note is never implicitly self-granted.
      notebookId: harness.notebookId,
      content:
        "Hi éè 你好 😀\n\nSecond paragraph with a [link](nn://note/abc)"
    })) as { noteId: string };
    const got = (await harness.adapter.execute({
      operation: "get_note",
      noteId: result.noteId
    })) as { content: string };
    expect(got.content).toContain("你好");
    expect(got.content).toContain("nn://note/abc");
  });

  it("strips unsafe HTML from markdown/plaintext input", async () => {
    harness = await createHarness();
    const result = (await harness.adapter.execute({
      operation: "create_note",
      operationId: "unsafe-1",
      format: "plaintext",
      // Granted notebook so the read-back below is authorized by scope.
      notebookId: harness.notebookId,
      content: '<script>alert(1)</script><img src="x" onerror="boom()">'
    })) as { noteId: string };
    const got = (await harness.adapter.execute({
      operation: "get_note",
      noteId: result.noteId
    })) as { content: string };
    // Plaintext is escaped, never parsed: no script/img *elements* may exist,
    // the markup survives only as text.
    expect(got.content).not.toContain("<script");
    expect(got.content).not.toContain("<img");
    expect(got.content).toContain("&lt;script&gt;");

    // Tiptap input is markup: the sanitizer must remove the element's event
    // handler attributes instead of escaping them.
    const raw = (await harness.adapter.execute({
      operation: "create_note",
      operationId: "unsafe-2",
      format: "tiptap",
      notebookId: harness.notebookId,
      content: '<p onclick="x()"><img src="x" onerror="boom()"></p>'
    })) as { noteId: string };
    const rawGot = (await harness.adapter.execute({
      operation: "get_note",
      noteId: raw.noteId
    })) as { content: string };
    expect(rawGot.content).not.toContain("onerror");
    expect(rawGot.content).not.toContain("onclick");
  });
});

describe("VeyraN Connect guarded task mutations", () => {
  it("creates, lists, updates and completes tasks with dates", async () => {
    harness = await createHarness();
    const created = (await harness.adapter.execute({
      operation: "create_task",
      operationId: "task-1",
      listId: harness.listId,
      title: "Pay rent",
      dueDate: "2030-01-01",
      dueTime: "09:00",
      reminderDate: "2030-01-01",
      reminderTime: "08:30",
      priority: "high",
      recurrenceRule: "FREQ=DAILY"
    })) as { taskId: string; revision: string; link: string };
    expect(created.link).toBe(`veyran://task/${created.taskId}`);

    const lists = (await harness.adapter.execute({
      operation: "list_task_lists"
    })) as { lists: { id: string }[] };
    expect(lists.lists.map((l) => l.id)).toEqual([harness.listId]);

    const listed = (await harness.adapter.execute({
      operation: "list_tasks"
    })) as { tasks: { taskId: string; dueDate?: string }[] };
    expect(listed.tasks.map((t) => t.taskId)).toContain(created.taskId);

    const updated = (await harness.adapter.execute({
      operation: "update_task",
      operationId: "task-2",
      taskId: created.taskId,
      expectedRevision: created.revision,
      patch: { title: "Pay rent now", priority: "low" }
    })) as { revision: string };
    expect(updated.revision).not.toBe(created.revision);

    const beforeCount = harness.db.tasks.listSync().length;
    const completed = (await harness.adapter.execute({
      operation: "complete_task",
      operationId: "task-3",
      taskId: created.taskId,
      expectedRevision: updated.revision
    })) as { completed: boolean };
    expect(completed.completed).toBe(true);
    // Recurrence still creates the next occurrence.
    expect(harness.db.tasks.listSync().length).toBe(beforeCount + 1);
  });

  it("rejects a stale task revision and manual changes during reservation", async () => {
    harness = await createHarness();
    const created = (await harness.adapter.execute({
      operation: "create_task",
      operationId: "task-stale-1",
      listId: harness.listId,
      title: "Task"
    })) as { taskId: string; revision: string };
    await harness.db.tasks.update(created.taskId, { title: "Manual" });
    await expectCode(
      harness.adapter.execute({
        operation: "complete_task",
        operationId: "task-stale-2",
        taskId: created.taskId,
        expectedRevision: created.revision
      }),
      "REVISION_CONFLICT"
    );
    const current = (await harness.db.tasks.get(created.taskId))!;
    expect(current.completed).toBe(false);
    expect(taskRevision(current)).toBeTruthy();
  });

  it("rejects tasks in non-granted lists", async () => {
    harness = await createHarness();
    const otherList = await harness.db.taskLists.create("Other");
    const foreign = await harness.db.tasks.create({
      title: "foreign",
      listId: otherList.id
    });
    await expectCode(
      harness.adapter.execute({
        operation: "update_task",
        operationId: "task-foreign-1",
        taskId: foreign.id,
        expectedRevision: taskRevision(foreign),
        patch: { title: "no" }
      }),
      "NOT_AUTHORIZED"
    );
    const listed = (await harness.adapter.execute({
      operation: "list_tasks"
    })) as { tasks: { taskId: string }[] };
    expect(listed.tasks.some((t) => t.taskId === foreign.id)).toBe(false);
  });
});
