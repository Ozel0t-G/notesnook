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
import { createHarness, ConnectHarness } from "./fixtures.js";
import {
  DomainWriteToken,
  withDomainWrite
} from "../../src/connect/domain-lock.js";
import { noteRevision } from "../../src/connect/revision.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

/** A resolvable promise used to hold a paused await open. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function revisionOf(db: ConnectHarness["db"], noteId: string) {
  const note = await db.notes.note(noteId);
  const content = await db.content.findByNoteId(noteId);
  return noteRevision(note!, content);
}

function storedContent(db: ConnectHarness["db"], noteId: string) {
  return db
    .sql()
    .selectFrom("content")
    .select(["locked", "data", "localOnly", "deleted"])
    .where("noteId", "=", noteId)
    .executeTakeFirst();
}

/**
 * Focused regression tests for the safety defects found by the independent
 * audit of Core candidate 50f0a92c. Each test pauses a real `await` of the
 * production path, changes an external safety condition while it is suspended,
 * and then asserts that no unauthorized or stale write/read escapes.
 */
describe("VeyraN Connect content pre-processing (CAS)", () => {
  it("preserves metadata written while a pre-processing read is paused", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    const content = harness.db.content;
    const original = content.preProcess.bind(content);
    const entered = gate();
    const hold = gate();
    let paused = false;
    content.preProcess = async (row) => {
      if (!paused) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      return original(row);
    };

    try {
      const read = content.findByNoteId(noteId);
      await entered.promise;

      // `localOnly` is metadata: it does not touch the body, so the CAS data
      // condition still matches and only the transformed payload may be
      // written back. The stale `localOnly: false` of the suspended read must
      // not be restored.
      await harness.db.notes.localOnly(true, noteId);

      hold.open();
      const row = await read;

      expect(row?.localOnly).toBe(true);
      const stored = await storedContent(harness.db, noteId);
      expect(stored?.localOnly).toBeTruthy();
      expect((await harness.db.notes.note(noteId))?.localOnly).toBe(true);
      // The migration still landed: the write-back was not skipped wholesale.
      expect(String(stored?.data)).toContain("data-block-id");
    } finally {
      content.preProcess = original;
    }
  });

  it("returns the current locked body when a vault lock wins the CAS", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    await harness.db.vault.create("vault-password");
    const content = harness.db.content;
    const original = content.preProcess.bind(content);
    const entered = gate();
    const hold = gate();
    let paused = false;
    content.preProcess = async (row) => {
      if (!paused) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      return original(row);
    };

    try {
      const read = content.findByNoteId(noteId);
      await entered.promise;

      // The vault lock replaces the body while the read is suspended, so the
      // compare-and-swap no longer matches.
      await harness.db.vault.add(noteId);

      hold.open();
      const row = await read;

      // The observer must see the *current* row (ciphertext + locked), never
      // the plaintext this read started from.
      expect(row?.locked).toBe(true);
      expect(String(row?.data)).not.toContain("hello");
      const stored = await storedContent(harness.db, noteId);
      expect(stored?.locked).toBeTruthy();
      expect(String(stored?.data)).not.toContain("hello");
    } finally {
      content.preProcess = original;
    }
  });
});

describe("VeyraN Connect content lease validation", () => {
  it("refuses locked mutations with a stale or foreign lease", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    const content = harness.db.content;
    const before = await content.findByNoteId(noteId);

    let stale!: DomainWriteToken;
    await withDomainWrite(harness.db, async (token) => {
      stale = token;
    });
    let foreign!: DomainWriteToken;
    await withDomainWrite({}, async (token) => {
      foreign = token;
    });

    await expect(
      content.updateByNoteIdLocked(stale, { data: "<p>hacked</p>" }, noteId)
    ).rejects.toThrow(/active domain write lease/);
    await expect(content.removeByNoteIdLocked(foreign, noteId)).rejects.toThrow(
      /active domain write lease/
    );
    expect(() => content.removeLocked(stale, before!.id)).toThrow(
      /active domain write lease/
    );

    const after = await content.findByNoteId(noteId);
    expect(after?.data).toBe(before?.data);
    expect(after?.deleted).toBeFalsy();
  });

  it("refuses a permanent note removal with a stale lease", async () => {
    harness = await createHarness();
    const notes = harness.db.notes;
    let stale!: DomainWriteToken;
    await withDomainWrite(harness.db, async (token) => {
      stale = token;
    });

    // The removal spans a relation unlink, the note row and the content row:
    // none of it may run with a lease that is not live.
    expect(() => notes.removeLocked(stale, harness!.noteId)).toThrow(
      /active domain write lease/
    );
    expect(await notes.note(harness.noteId)).toBeTruthy();
    expect(await harness.db.content.findByNoteId(harness.noteId)).toBeTruthy();
  });

  it("refuses a copied lease while an unrelated writer holds the lock", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    let copied!: DomainWriteToken;
    await withDomainWrite(harness.db, async (token) => {
      copied = token;
    });

    const entered = gate();
    const hold = gate();
    const holder = withDomainWrite(harness.db, async () => {
      entered.open();
      await hold.promise;
    });
    await entered.promise;

    let reachedWrite = false;
    const mutation = harness.db.content
      .updateByNoteIdLocked(copied, { data: "<p>hacked</p>" }, noteId)
      .then(
        () => {
          reachedWrite = true;
        },
        (error) => error
      );

    hold.open();
    await holder;
    const error = await mutation;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/active domain write lease/);
    expect(reachedWrite).toBe(false);
    expect(String((await storedContent(harness.db, noteId))?.data)).toContain(
      "hello"
    );
  });
});

describe("VeyraN Connect write fences after post-processing", () => {
  it("writes nothing when the adapter is locked during content post-processing", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    const content = harness.db.content;
    const original = content.postProcess.bind(content);
    const entered = gate();
    const hold = gate();
    let paused = false;
    content.postProcess = async (item, guard) => {
      if (!paused) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      return original(item, guard);
    };

    try {
      const beforeContent = await content.findByNoteId(noteId);
      const beforeNote = await harness.db.notes.note(noteId);
      const revision = await revisionOf(harness.db, noteId);

      const pending = harness.adapter.execute({
        operation: "append_to_note",
        operationId: "postprocess-lock",
        noteId,
        content: "**tail**",
        expectedRevision: revision
      });
      await entered.promise;

      // The append is suspended inside the content pipeline: the fence is
      // revoked before its first persistence boundary.
      harness.adapter.lock();
      hold.open();

      await expectCode(pending, "ADAPTER_LOCKED");

      const afterContent = await content.findByNoteId(noteId);
      const afterNote = await harness.db.notes.note(noteId);
      expect(afterContent?.data).toBe(beforeContent?.data);
      expect(afterContent?.dateEdited).toBe(beforeContent?.dateEdited);
      expect(afterNote?.dateEdited).toBe(beforeNote?.dateEdited);
      expect(afterNote?.headline).toBe(beforeNote?.headline);
    } finally {
      content.postProcess = original;
    }
  });

  it("writes nothing when the grants are revoked during post-processing", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    const content = harness.db.content;
    const original = content.postProcess.bind(content);
    const entered = gate();
    const hold = gate();
    let paused = false;
    content.postProcess = async (item, guard) => {
      if (!paused) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      return original(item, guard);
    };

    try {
      const before = await content.findByNoteId(noteId);
      const revision = await revisionOf(harness.db, noteId);
      const pending = harness.adapter.execute({
        operation: "append_to_note",
        operationId: "postprocess-revoke",
        noteId,
        content: "tail",
        expectedRevision: revision
      });
      await entered.promise;

      harness.adapter.clearGrants();
      hold.open();

      await expectCode(pending, "GRANTS_CHANGED");
      expect(String((await content.findByNoteId(noteId))?.data)).toBe(
        String(before?.data)
      );
    } finally {
      content.postProcess = original;
    }
  });
});

describe("VeyraN Connect task write fences", () => {
  it("does not create a Task when the adapter is locked during list materialization", async () => {
    harness = await createHarness();
    const defaultList = await harness.db.taskLists.default();
    await harness.adapter.setGrants({
      accountId: harness.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [harness.notebookId],
      noteIDs: [harness.noteId],
      listIDs: [harness.listId, defaultList.id]
    });

    const lists = harness.db.taskLists;
    const original = lists.ensureDefaultPersisted.bind(lists);
    const entered = gate();
    const hold = gate();
    let paused = false;
    lists.ensureDefaultPersisted = async (lease) => {
      if (!paused) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      // Forward the lease: the adapter's create already holds the Task write
      // critical section, so the materialization must run inline.
      return original(lease);
    };

    try {
      const pending = harness.adapter.execute({
        operation: "create_task",
        operationId: "task-lock",
        listId: defaultList.id,
        title: "should never exist"
      });
      // Let the operation reach its reservation before it is suspended.
      await nextTick();
      await entered.promise;

      harness.adapter.lock();
      hold.open();

      await expectCode(pending, "ADAPTER_LOCKED");
      const created = (await harness.db.tasks.list()).filter(
        (task) => task.title === "should never exist"
      );
      expect(created).toHaveLength(0);
    } finally {
      lists.ensureDefaultPersisted = original;
    }
  });

  it("does not move a Task when the adapter is locked before the task save", async () => {
    harness = await createHarness();
    const defaultList = await harness.db.taskLists.default();
    await harness.adapter.setGrants({
      accountId: harness.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [harness.notebookId],
      noteIDs: [harness.noteId],
      listIDs: [harness.listId, defaultList.id]
    });
    const task = await harness.db.tasks.create({
      title: "stay put",
      listId: harness.listId
    });

    const lists = harness.db.taskLists;
    const original = lists.ensureDefaultPersisted.bind(lists);
    const entered = gate();
    const hold = gate();
    let paused = false;
    lists.ensureDefaultPersisted = async (lease) => {
      if (!paused) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      // Forward the lease: the adapter's guarded update already holds the Task
      // write critical section, so the materialization must run inline.
      return original(lease);
    };

    try {
      const pending = harness.adapter.execute({
        operation: "update_task",
        operationId: "task-move-lock",
        taskId: task.id,
        expectedRevision: (
          await import("../../src/connect/revision.js")
        ).taskRevision(task),
        patch: { listId: defaultList.id }
      });
      await nextTick();
      await entered.promise;

      harness.adapter.lock();
      hold.open();

      await expectCode(pending, "ADAPTER_LOCKED");
      expect((await harness.db.tasks.get(task.id))?.listId).toBe(
        harness.listId
      );
    } finally {
      lists.ensureDefaultPersisted = original;
    }
  });

  it("never touches the Task when it is not stored in the granted list", async () => {
    harness = await createHarness();
    const other = await harness.db.taskLists.create("Other");
    const task = await harness.db.tasks.create({
      title: "moved away",
      listId: other.id
    });
    await expectCode(
      harness.adapter.execute({
        operation: "update_task",
        operationId: "task-out-of-scope",
        taskId: task.id,
        expectedRevision: (
          await import("../../src/connect/revision.js")
        ).taskRevision(task),
        patch: { title: "hijacked" }
      }),
      "NOT_AUTHORIZED"
    );
    expect((await harness.db.tasks.get(task.id))?.title).toBe("moved away");
  });
});

describe("VeyraN Connect and the sync merge", () => {
  it("serializes a real settingitem (Task) merge with the task write lock", async () => {
    harness = await createHarness();
    const task = await harness.db.tasks.create({
      title: "local task",
      listId: harness.listId
    });

    // A *real* outbound chunk for the stored Task row, not an empty mirror.
    const chunks: unknown[] = [];
    for await (const chunk of harness.db.syncer.sync.collector.collect(
      500,
      true
    ))
      chunks.push(chunk);
    const chunk = (
      chunks as {
        type: string;
        items: unknown[];
        count: number;
      }[]
    ).find((candidate) => candidate.type === "settingitem");
    expect(chunk).toBeTruthy();
    expect(chunk!.items.length).toBeGreaterThan(0);
    const keys = await harness.db.user.getDataEncryptionKeys();
    expect(keys?.length).toBeGreaterThan(0);

    const entered = gate();
    const hold = gate();
    let merged = false;
    const holder = harness.db.tasks.runExclusiveTaskWrite(async () => {
      entered.open();
      await hold.promise;
    });
    await entered.promise;

    const merge = harness.db.syncer.sync
      .processChunk(chunk as never, keys!, {} as never)
      .then(() => {
        merged = true;
      });
    await nextTick();
    // read → merge → put must hold the same lock as local Task writers.
    expect(merged).toBe(false);

    hold.open();
    await holder;
    await merge;
    expect(merged).toBe(true);
    expect((await harness.db.tasks.get(task.id))?.title).toBe("local task");
  });

  it("does not overwrite a guarded local task write with a stale merge", async () => {
    harness = await createHarness();
    const task = await harness.db.tasks.create({
      title: "before",
      listId: harness.listId
    });
    const revision = (
      await import("../../src/connect/revision.js")
    ).taskRevision(task);

    const chunks: unknown[] = [];
    for await (const chunk of harness.db.syncer.sync.collector.collect(
      500,
      true
    ))
      chunks.push(chunk);
    const chunk = (chunks as { type: string; items: unknown[] }[]).find(
      (candidate) => candidate.type === "settingitem"
    );
    const keys = await harness.db.user.getDataEncryptionKeys();

    // Suspend the merge *after* it read the local rows and before its put.
    const settings = harness.db.settings.collection;
    const originalRecords = settings.records.bind(settings);
    const read = gate();
    const resume = gate();
    let paused = false;
    settings.records = async (ids) => {
      const result = await originalRecords(ids);
      if (!paused) {
        paused = true;
        read.open();
        await resume.promise;
      }
      return result;
    };

    try {
      let mergeDone = false;
      const merge = harness.db.syncer.sync
        .processChunk(chunk as never, keys!, {} as never)
        .then(() => {
          mergeDone = true;
        });
      await read.promise;

      // A guarded local write now has to wait for the merge's lock instead of
      // slipping in between the merge's read and its put.
      let writeDone = false;
      const write = harness.db.tasks
        .updateGuarded(task.id, { title: "after" }, async () => undefined)
        .then(() => {
          writeDone = true;
        });
      await nextTick();
      expect(writeDone).toBe(false);
      expect(mergeDone).toBe(false);

      resume.open();
      await merge;
      await write;
      expect((await harness.db.tasks.get(task.id))?.title).toBe("after");
      expect(revision).toBeTruthy();
    } finally {
      settings.records = originalRecords;
    }
  });
});

describe("VeyraN Connect local-only records", () => {
  it("never returns, searches or mutates a local-only note", async () => {
    harness = await createHarness();
    const noteInNotebook = await harness.db.notes.add({
      title: "Local secret",
      content: { type: "tiptap", data: "<p>localonlysecret</p>" }
    });
    await harness.db.notes.addToNotebook(harness.notebookId, noteInNotebook);
    await harness.db.notes.localOnly(true, noteInNotebook);

    await expectCode(
      harness.adapter.execute({
        operation: "get_note",
        noteId: noteInNotebook
      }),
      "NOT_AUTHORIZED"
    );

    const search = (await harness.adapter.execute({
      operation: "search_notes",
      query: "localonlysecret"
    })) as { results: { noteId: string }[] };
    expect(search.results.some((r) => r.noteId === noteInNotebook)).toBe(false);

    await expectCode(
      harness.adapter.execute({
        operation: "append_to_note",
        operationId: "local-note-append",
        noteId: noteInNotebook,
        content: "no",
        expectedRevision: await revisionOf(harness.db, noteInNotebook)
      }),
      "NOT_AUTHORIZED"
    );
    expect(
      String((await storedContent(harness.db, noteInNotebook))?.data)
    ).toContain("localonlysecret");
  });

  it("never lists or mutates a local-only task", async () => {
    harness = await createHarness();
    const local = await harness.db.tasks.create({
      title: "local task",
      listId: harness.listId,
      localOnly: true
    });

    const listed = (await harness.adapter.execute({
      operation: "list_tasks"
    })) as { tasks: { taskId: string }[] };
    expect(listed.tasks.some((task) => task.taskId === local.id)).toBe(false);

    const revision = (
      await import("../../src/connect/revision.js")
    ).taskRevision(local);
    await expectCode(
      harness.adapter.execute({
        operation: "update_task",
        operationId: "local-task-update",
        taskId: local.id,
        expectedRevision: revision,
        patch: { title: "hijacked" }
      }),
      "NOT_AUTHORIZED"
    );
    await expectCode(
      harness.adapter.execute({
        operation: "complete_task",
        operationId: "local-task-complete",
        taskId: local.id,
        expectedRevision: revision
      }),
      "NOT_AUTHORIZED"
    );
    expect((await harness.db.tasks.get(local.id))?.title).toBe("local task");
    expect((await harness.db.tasks.get(local.id))?.completed).toBe(false);
  });

  it("fails closed instead of reporting a missing body as an empty note", async () => {
    harness = await createHarness();
    await harness.db
      .sql()
      .deleteFrom("content")
      .where("noteId", "=", harness.noteId)
      .execute();

    await expectCode(
      harness.adapter.execute({
        operation: "get_note",
        noteId: harness.noteId
      }),
      "NOTE_LOCKED"
    );
  });
});

describe("VeyraN Connect receipt metadata", () => {
  it("stores no plaintext note/task title or description in a receipt", async () => {
    harness = await createHarness();
    const { taskRevision } = await import("../../src/connect/revision.js");
    await harness.adapter.execute({
      operation: "create_note",
      operationId: "receipt-title-note",
      title: "VerificationSecretNoteTitle",
      content: "body"
    });
    const task = (await harness.adapter.execute({
      operation: "create_task",
      operationId: "receipt-title-task",
      listId: harness.listId,
      title: "VerificationSecretTaskTitle",
      description: "VerificationSecretTaskDescription"
    })) as { taskId: string };
    const stored = await harness.db.tasks.get(task.taskId);
    await harness.adapter.execute({
      operation: "update_task",
      operationId: "receipt-title-task-update",
      taskId: task.taskId,
      expectedRevision: taskRevision(stored!),
      patch: { title: "VerificationSecretPatchedTitle" }
    });

    const rows = (await harness.db
      .sql()
      .selectFrom("settings")
      .select(["key", "value"])
      .where("key", "like", "veyranConnect:v1:receipt:%")
      .execute()) as { key: string; value: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.value).not.toContain("VerificationSecretNoteTitle");
      expect(row.value).not.toContain("VerificationSecretTaskTitle");
      expect(row.value).not.toContain("VerificationSecretPatchedTitle");
      expect(row.value).not.toContain("VerificationSecretTaskDescription");
    }
    // The idempotent replay still works (the hashes verify).
    const replay = (await harness.adapter.execute({
      operation: "update_task",
      operationId: "receipt-title-task-update",
      taskId: task.taskId,
      expectedRevision: taskRevision(stored!),
      patch: { title: "VerificationSecretPatchedTitle" }
    })) as { taskId: string };
    expect(replay.taskId).toBe(task.taskId);
  });
});

describe("VeyraN Connect live notebook membership", () => {
  it("denies the body when the note left its granted notebook while it was read", async () => {
    harness = await createHarness();
    // Authorized *only* through the granted notebook (the fixture grants
    // `noteId` directly, so this note is the membership-only case).
    const noteInNotebook = await harness.db.notes.add({
      title: "In notebook",
      content: { type: "tiptap", data: "<p>member</p>" }
    });
    await harness.db.notes.addToNotebook(harness.notebookId, noteInNotebook);

    let unlinked = false;
    harness.adapter.onFenceStep = async (label) => {
      if (label === "content" && !unlinked) {
        unlinked = true;
        await harness!.db.relations
          .to({ id: noteInNotebook, type: "note" }, "notebook")
          .unlink();
      }
    };

    await expectCode(
      harness.adapter.execute({
        operation: "get_note",
        noteId: noteInNotebook
      }),
      "NOT_AUTHORIZED"
    );

    // A directly granted note is unaffected by notebook membership.
    const direct = (await harness.adapter.execute({
      operation: "get_note",
      noteId: harness.noteId
    })) as { noteId: string; content: string };
    expect(direct.noteId).toBe(harness.noteId);
    expect(direct.content).toContain("hello");
  });
});
