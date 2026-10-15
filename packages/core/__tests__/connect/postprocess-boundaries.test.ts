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
import { ConnectError } from "../../src/connect/errors.js";
import { noteRevision } from "../../src/connect/revision.js";
import { expectCode } from "./helpers.js";
import { createHarness, ConnectHarness } from "./fixtures.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

/** A resolvable promise used to hold an operation inside a paused await. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function revisionOf(db: ConnectHarness["db"], noteId: string) {
  const note = await db.notes.note(noteId);
  const content = await db.content.findByNoteId(noteId);
  return noteRevision(note!, content);
}

/**
 * A guard that pauses on the boundary immediately *before* the relation
 * helpers (`pauseAt`), then denies every later call. The paused call itself
 * still passes, so the operation proceeds one step further — into the helper's
 * own read — and only the next check (the helper's own boundary, which exists
 * only when the guard is threaded through it) sees the revocation.
 */
function pausingGuard(options: { pauseAt: number }) {
  const entered = gate();
  const hold = gate();
  const state = { calls: 0, revoked: false };
  const guard = async () => {
    state.calls++;
    if (state.calls > options.pauseAt && state.revoked)
      throw new ConnectError("GRANTS_CHANGED");
    if (state.calls === options.pauseAt) {
      entered.open();
      await hold.promise;
    }
  };
  return {
    guard,
    state,
    async pauseAndRevoke() {
      await entered.promise;
      state.revoked = true;
      hold.open();
    }
  };
}

function noteAttachments(db: ConnectHarness["db"], noteId: string) {
  return db.relations.from({ type: "note", id: noteId }, "attachment").get();
}

/**
 * The content post-processing pipeline owns three kinds of persistence
 * boundary beyond the content row itself: the attachment row a data-URI image
 * is saved as, the note↔note relations derived from `nn://` links and the
 * note↔attachment relations derived from stored hashes. A guard that only runs
 * before the pipeline, or once after it returned and before the relation
 * helpers, cannot see a revocation that lands while one of those helpers is
 * suspended in its own read.
 */
describe("VeyraN Connect post-processing persistence boundaries", () => {
  it("denies the internal-link relation when the operation is revoked during the link lookup", async () => {
    harness = await createHarness();
    const target = await harness.db.notes.add({
      title: "Link target",
      content: { type: "tiptap", data: "<p>target body</p>" }
    });
    const notes = harness.db.notes;
    const originalExists = notes.exists.bind(notes);
    const entered = gate();
    const hold = gate();
    let paused = false;
    notes.exists = async (id: string) => {
      // The link helper reads `notes.exists(link.id)` after the relation
      // lookup and before it writes the relation.
      if (!paused && id === target) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      return originalExists(id);
    };

    try {
      const revision = await revisionOf(harness.db, harness.noteId);
      const pending = harness.adapter.execute({
        operation: "append_to_note",
        operationId: "postprocess-link-revoked",
        noteId: harness.noteId,
        format: "tiptap",
        content: `<p><a href="nn://note/${target}">link</a></p>`,
        expectedRevision: revision
      });
      await entered.promise;

      // The append is suspended inside the content pipeline's link handling.
      harness.adapter.lock();
      hold.open();

      await expectCode(pending, "ADAPTER_LOCKED");

      const links = await harness.db.relations
        .from({ type: "note", id: harness.noteId }, "note")
        .get();
      expect(links.some((link) => link.toId === target)).toBe(false);

      // Nothing of the append landed: neither content nor relation.
      const stored = await harness.db.content.findByNoteId(harness.noteId);
      expect(String(stored?.data)).not.toContain(`nn://note/${target}`);
      expect(String(stored?.data)).toContain("hello");
    } finally {
      notes.exists = originalExists;
    }
  });

  it("does not unlink attachment relations when the operation is revoked after the attachment lookup", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    const hash = (await harness.db.attachments.save(
      "aGVsbG8=",
      "text/plain",
      "a.txt"
    ))!;
    expect(hash).toBeTruthy();
    // The stored body references the attachment; the body being written does
    // not, so the helper has to unlink it. Storing that body through the real
    // content pipeline already derives the note↔attachment relation, so no
    // manual `relations.add` may follow it: that would create a duplicate and
    // make the baseline two relations instead of the one under test.
    await harness.db.content.add({
      noteId,
      type: "tiptap",
      data: `<p>hello <img data-hash="${hash}" data-mime="text/plain"></p>`
    });
    // Capture the single pre-existing relation's target before the paused
    // operation. `Attachments.save` returns the content hash, but the note↔
    // attachment relation's `toId` is the attachment record id generated by
    // the content pipeline, so the hash is not the value to compare against.
    const before = await noteAttachments(harness.db, noteId);
    expect(before.length).toBe(1);
    const linkedTargetId = before[0]!.toId;

    // call 1: after the body pipeline, call 2: between the link and
    // attachment helpers, call 3: the attachment helper's own boundary
    // (present only when the guard is threaded through it).
    const guarded = pausingGuard({ pauseAt: 2 });
    const pending = harness.db.content.add(
      { noteId, type: "tiptap", data: "<p>replaced body</p>" },
      undefined,
      guarded.guard
    );
    await guarded.pauseAndRevoke();

    await expectCode(pending, "GRANTS_CHANGED");
    // The revocation must not have unlinked the pre-existing relation: still
    // exactly one relation, still bound to the very same target it had before.
    const bound = await noteAttachments(harness.db, noteId);
    expect(bound.length).toBe(1);
    expect(bound[0]!.toId).toBe(linkedTargetId);
  });

  it("does not add attachment relations when the operation is revoked after the attachment lookup", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    const hash = (await harness.db.attachments.save(
      "d29ybGQ=",
      "text/plain",
      "b.txt"
    ))!;
    // Precondition: the note has no attachment relation yet, so a single
    // relation after the run would have been *added* by the revoked operation.
    // Comparing a relation's `toId` to the content hash would be vacuous: the
    // relation target is the attachment record id, not the hash.
    expect(await noteAttachments(harness.db, noteId)).toHaveLength(0);
    const guarded = pausingGuard({ pauseAt: 2 });
    const pending = harness.db.content.add(
      {
        noteId,
        type: "tiptap",
        data: `<p><img data-hash="${hash}" data-mime="text/plain"></p>`
      },
      undefined,
      guarded.guard
    );
    await guarded.pauseAndRevoke();

    await expectCode(pending, "GRANTS_CHANGED");
    const bound = await noteAttachments(harness.db, noteId);
    expect(bound).toHaveLength(0);
  });

  it("revalidates before an attachment is saved and writes no attachment on a denial", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    const attachments = harness.db.attachments;
    const originalSave = attachments.save.bind(attachments);
    /** The guard call count observed when each attachment save was invoked. */
    const saves: number[] = [];
    let guardCalls = 0;
    attachments.save = async (
      data: string,
      mimeType: string,
      filename?: string
    ) => {
      saves.push(guardCalls);
      return originalSave(data, mimeType, filename);
    };
    const body =
      '<p><img src="data:image/png;base64,c3ludGhldGljLWltYWdl"></p>';

    try {
      // (1) A revoked guard must stop the attachment *before* it is written.
      await expect(
        harness.db.content.add(
          { noteId, type: "tiptap", data: body },
          undefined,
          async () => {
            guardCalls++;
            throw new ConnectError("GRANTS_CHANGED");
          }
        )
      ).rejects.toThrow(ConnectError);
      expect(saves).toHaveLength(0);
      const rows = await harness.db
        .sql()
        .selectFrom("attachments")
        .select(["id"])
        .execute();
      expect(rows).toHaveLength(0);

      // (2) On the passing path the guard runs before every save.
      guardCalls = 0;
      await harness.db.content.add(
        { noteId, type: "tiptap", data: body },
        undefined,
        async () => {
          guardCalls++;
        }
      );
      expect(saves.length).toBeGreaterThan(0);
      expect(saves[0]).toBeGreaterThanOrEqual(1);
    } finally {
      attachments.save = originalSave;
    }
  });
});

/**
 * The limited-text Connect surface refuses attachment-bearing input outright
 * instead of trying to guard the attachment writer deep inside the content
 * pipeline (where a revocation during `Attachments.save` cannot be undone). The
 * rejection must happen before a reservation exists and before *any* effect, so
 * it can leave neither a note, a relation, an attachment row nor a receipt
 * behind.
 */
describe("VeyraN Connect attachment input rejection", () => {
  it("rejects attachment/data-URI input with no note/relation/attachment/receipt effect", async () => {
    harness = await createHarness();
    const db = harness.db;
    const noteRows = async () =>
      (await db.sql().selectFrom("notes").select(["id"]).execute()).length;
    const relationRows = async () =>
      (await db.sql().selectFrom("relations").select(["id"]).execute()).length;
    const attachmentRows = async () =>
      (
        await db.sql().selectFrom("attachments").select(["id"]).execute()
      ).length;
    const receipts = async () =>
      (
        await db
          .sql()
          .selectFrom("settings")
          .select(["key"])
          .where("key", "like", "veyranConnect:v1:receipt:%")
          .execute()
      ).length;

    const before = {
      notes: await noteRows(),
      relations: await relationRows(),
      attachments: await attachmentRows(),
      receipts: await receipts()
    };

    const dataUri = "data:image/png;base64,c3ludGhldGljLWltYWdl";
    const attempts: { id: string; format: string; content: string }[] = [
      // Markdown image syntax converts to an `<img src="data:...">` that the
      // post-processing pipeline would save as a brand-new attachment.
      { id: "reject-attachment-markdown", format: "markdown", content: `![x](${dataUri})` },
      // A stored-attachment reference the pipeline would bind as a relation.
      {
        id: "reject-attachment-tiptap",
        format: "tiptap",
        content:
          '<p><img data-hash="synthetic-hash" data-mime="text/plain"></p>'
      }
    ];

    for (const attempt of attempts) {
      await expectCode(
        harness.adapter.execute({
          operation: "create_note",
          operationId: attempt.id,
          notebookId: harness.notebookId,
          format: attempt.format,
          content: attempt.content
        }),
        "UNSUPPORTED_CONTENT"
      );
    }

    expect(await noteRows()).toBe(before.notes);
    expect(await relationRows()).toBe(before.relations);
    expect(await attachmentRows()).toBe(before.attachments);
    expect(await receipts()).toBe(before.receipts);
  });
});
