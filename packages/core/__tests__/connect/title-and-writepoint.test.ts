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
import { noteRevision } from "../../src/connect/revision.js";

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

async function revisionOf(ctx: ConnectHarness, noteId: string) {
  const note = await ctx.db.notes.note(noteId);
  const content = await ctx.db.content.findByNoteId(noteId);
  return noteRevision(note!, content);
}

/**
 * The receipts pin exactly which title was stored (hash only), and the
 * Connect-specific empty-title default is deterministic (never the clock- and
 * settings-dependent generated title). The returned revision of a write is the
 * snapshot of *that* write, even when a manual edit is queued immediately
 * after the lease is released.
 */
describe("VeyraN Connect exact title hashing", () => {
  it("gives an empty-title create a deterministic title that survives a restart", async () => {
    harness = await createHarness();
    const ctx = harness;
    const request = {
      operation: "create_note" as const,
      operationId: "exact-empty-title",
      notebookId: ctx.notebookId,
      content: "# Deterministic Headline\n\nbody"
    };
    const created = (await ctx.adapter.execute(request)) as {
      noteId: string;
      revision: string;
    };
    const note = await ctx.db.notes.note(created.noteId);
    // Deterministic and explicit: never the generated-title path (which formats
    // the local clock and settings).
    expect(note?.isGeneratedTitle).toBe(false);
    expect(note?.title.length).toBeGreaterThan(0);
    expect(note?.title.length).toBeLessThanOrEqual(512);
    expect(note?.title).toContain("Deterministic Headline");
    const title = note!.title;

    const dbPath = ctx.path;
    const accountId = ctx.accountId;
    const notebookId = ctx.notebookId;
    ctx.adapter.close();
    await ctx.close();
    harness = undefined;

    const reopened = await openConnectDb(dbPath);
    harness = {
      ...reopened,
      adapter: new ConnectAdapter(reopened.db),
      accountId,
      notebookId,
      noteId: created.noteId,
      listId: ctx.listId
    };
    await harness.adapter.setGrants({
      accountId,
      canRead: true,
      canCreate: true,
      noteIDs: [created.noteId],
      notebookIDs: [notebookId]
    });
    const before = await harness.db.notes.all.count();
    // The replay verifies against the recorded title hash (not a mode) and
    // returns the same entity without a second write.
    const replay = (await harness.adapter.execute(request)) as {
      noteId: string;
    };
    expect(replay.noteId).toBe(created.noteId);
    expect(await harness.db.notes.all.count()).toBe(before);
    expect((await harness.db.notes.note(created.noteId))?.title).toBe(title);
  });

  it("falls back to the constant title when the body has no headline", async () => {
    harness = await createHarness();
    const created = (await harness.adapter.execute({
      operation: "create_note",
      operationId: "exact-blank-title",
      notebookId: harness.notebookId,
      content: ""
    })) as { noteId: string };
    const note = await harness.db.notes.note(created.noteId);
    expect(note?.title).toBe("Untitled");
    expect(note?.isGeneratedTitle).toBe(false);
  });

  it("rejects a blank update title before any effect and keeps it on omission", async () => {
    harness = await createHarness();
    const ctx = harness;
    const before = await receiptCount(ctx.db);
    const revision = await revisionOf(ctx, ctx.noteId);
    const titleBefore = (await ctx.db.notes.note(ctx.noteId))?.title;
    const editedBefore = (await ctx.db.notes.note(ctx.noteId))?.dateEdited;

    for (const blank of ["", "   ", "\n"]) {
      await expectCode(
        ctx.adapter.execute({
          operation: "update_note",
          operationId: `blank-title-${JSON.stringify(blank)}`,
          noteId: ctx.noteId,
          expectedRevision: revision,
          patch: { title: blank }
        }),
        "INVALID_INPUT"
      );
    }
    expect(await receiptCount(ctx.db)).toBe(before);
    expect((await ctx.db.notes.note(ctx.noteId))?.title).toBe(titleBefore);
    expect((await ctx.db.notes.note(ctx.noteId))?.dateEdited).toBe(editedBefore);

    // An *omitted* title keeps the prior title (a pinned-only patch).
    const updated = (await ctx.adapter.execute({
      operation: "update_note",
      operationId: "omit-title-keeps",
      noteId: ctx.noteId,
      expectedRevision: revision,
      patch: { pinned: true }
    })) as { revision: string };
    expect(updated.revision).not.toBe(revision);
    expect((await ctx.db.notes.note(ctx.noteId))?.title).toBe(titleBefore);
  });

  it("never stores a plaintext title — including a derived one — in a receipt", async () => {
    harness = await createHarness();
    const canary = "ReceiptCanaryTitleZzz";
    await harness.adapter.execute({
      operation: "create_note",
      operationId: "receipt-canary",
      notebookId: harness.notebookId,
      content: `# ${canary}\n\nbody`
    });
    const rows = (await harness.db
      .sql()
      .selectFrom("settings")
      .select(["key", "value"])
      .where("key", "like", "veyranConnect:v1:receipt:%")
      .execute()) as { key: string; value: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.value).not.toContain(canary);
      expect(row.value).not.toContain("Untitled");
    }
  });
});

describe("VeyraN Connect write-point revision ownership", () => {
  it("acknowledges its own write revision when a manual edit is queued after the lease", async () => {
    harness = await createHarness();
    const ctx = harness;
    const notes = ctx.db.notes;
    const originalAddGuarded = notes.addGuarded.bind(notes);
    let queued: Promise<unknown> | undefined;
    let ownWriteRevision: string | undefined;

    notes.addGuarded = (async (
      item: Parameters<typeof notes.addGuarded>[0],
      guard: Parameters<typeof notes.addGuarded>[1],
      token?: Parameters<typeof notes.addGuarded>[2]
    ) => {
      const result = await originalAddGuarded(item, guard, token);
      // Still inside the adapter's domain lease: capture the revision of the
      // adapter's own write, then *queue* (never await) a manual edit. The edit
      // must wait for the lease to be released — awaiting it here would
      // deadlock on the domain mutex, which is exactly what this test proves
      // does not happen.
      const note = await notes.note(ctx.noteId);
      const content = note
        ? await ctx.db.content.collection.get(
            (note as { contentId?: string }).contentId ?? ""
          )
        : undefined;
      ownWriteRevision = noteRevision(note!, content as never);
      queued = notes.add({
        id: ctx.noteId,
        content: { type: "tiptap", data: "<p>manual after the lease</p>" }
      });
      return result;
    }) as typeof notes.addGuarded;

    try {
      const revision = await revisionOf(ctx, ctx.noteId);
      const result = (await ctx.adapter.execute({
        operation: "update_note",
        operationId: "own-revision",
        noteId: ctx.noteId,
        expectedRevision: revision,
        patch: { title: "Own revision" }
      })) as { revision: string };

      expect(ownWriteRevision).toBeTruthy();
      // The returned (and receipt-committed) revision is the snapshot of this
      // write — not the later queued manual edit.
      expect(result.revision).toBe(ownWriteRevision);

      await queued;
      const afterManual = await revisionOf(ctx, ctx.noteId);
      expect(afterManual).not.toBe(ownWriteRevision);
    } finally {
      notes.addGuarded = originalAddGuarded;
      if (queued) await queued;
    }
  });
});

describe("VeyraN Connect current-body reads", () => {
  it("serves only the note's current body and never inserts block ids on read", async () => {
    harness = await createHarness();
    const ctx = harness;

    // A stale, unlocked historical row for the same note with a *different*
    // (token-free) body, whose id is not the note's `contentId`.
    const noteRow = await ctx.db.notes.note(ctx.noteId);
    const currentContentId = noteRow!.contentId as string;
    await ctx.db.content.add({
      id: "stalebody000000000000001",
      noteId: ctx.noteId,
      type: "tiptap",
      data: "<p>stale historical body</p>"
    } as never);
    // The current row is rewritten *directly* (bypassing the pipeline) so it
    // carries no block ids — a faithful outside-API body.
    await ctx.db
      .sql()
      .updateTable("content")
      .set({ data: "<p>current body without block ids</p>" })
      .where("id", "=", currentContentId)
      .execute();

    const got = (await ctx.adapter.execute({
      operation: "get_note",
      noteId: ctx.noteId
    })) as { content: string };
    expect(got.content).toBe("<p>current body without block ids</p>");

    // The reader must not have pre-processed/rewritten the row it read.
    const stored = (await ctx.db
      .sql()
      .selectFrom("content")
      .select(["data"])
      .where("id", "=", currentContentId)
      .executeTakeFirst()) as { data: string };
    expect(stored.data).toBe("<p>current body without block ids</p>");

    // A locked current row fails closed instead of falling back to the stale
    // unlocked one.
    await ctx.db
      .sql()
      .updateTable("content")
      .set({ locked: true, data: JSON.stringify({ cipher: "x", iv: "y" }) })
      .where("id", "=", currentContentId)
      .execute();
    await expectCode(
      ctx.adapter.execute({ operation: "get_note", noteId: ctx.noteId }),
      "NOTE_LOCKED"
    );

    // A soft-deleted current row is body-less: also NOTE_LOCKED (never the
    // stale plaintext row).
    await ctx.db.content.collection.softDelete([currentContentId]);
    await expectCode(
      ctx.adapter.execute({ operation: "get_note", noteId: ctx.noteId }),
      "NOTE_LOCKED"
    );
  });
});

describe("VeyraN Connect notebook target liveness", () => {
  it("denies a create into a granted but non-live notebook before any receipt", async () => {
    harness = await createHarness();
    const ctx = harness;
    const before = await receiptCount(ctx.db);

    // Soft-delete the granted notebook *without* unlinking anything: only the
    // live-target check can deny the create, and it must answer exactly like an
    // out-of-scope notebook (`NOT_AUTHORIZED`), reserving no receipt.
    await ctx.db
      .sql()
      .updateTable("notebooks")
      .set({ deleted: true })
      .where("id", "=", ctx.notebookId)
      .execute();

    await expectCode(
      ctx.adapter.execute({
        operation: "create_note",
        operationId: "nb-dead-create",
        notebookId: ctx.notebookId,
        content: "into a dead notebook"
      }),
      "NOT_AUTHORIZED"
    );
    await expectCode(
      ctx.adapter.execute({
        operation: "create_note",
        operationId: "nb-missing-create",
        notebookId: "no-such-notebook-0000001",
        content: "into a missing notebook"
      }),
      "NOT_AUTHORIZED"
    );
    expect(await receiptCount(ctx.db)).toBe(before);
  });
});
