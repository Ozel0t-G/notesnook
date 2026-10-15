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
import { expectCode, connectErrorCode } from "./helpers.js";
import {
  createHarness,
  ConnectHarness,
  openConnectDb
} from "./fixtures.js";
import type { ConnectHostContext } from "../../src/connect/adapter.js";
import {
  fingerprintOf,
  noteContentHash,
  noteRevision
} from "../../src/connect/revision.js";
import { toTiptapHtml } from "../../src/connect/content.js";
import { RECEIPT_PREFIX } from "../../src/connect/journal.js";
import { getContentFromData } from "../../src/content-types/index.js";

/**
 * Controlled strict **canonical-content** mode for the editor / assistant path.
 *
 * The trusted per-invocation host context may carry
 * `requireCanonicalContent: true`, which requires prospective create/update
 * bodies and append fragments to be safe and byte-stable, then checks the full
 * assembled body for appends. Every accepted case is verified against the real
 * encrypted-SQLite note pipeline (raw row read-back, receipts, reopen); every
 * rejected case is verified to have produced no persistence at all — not just
 * "no new note". The canonical bytes themselves are always derived from the
 * *actual* production converter/pre-processor, never a synthetic serializer.
 */

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

const alwaysCurrent = () => undefined;

/** Build a host context, allowing fields a valid caller would never send. */
function ctx(fields: Record<string, unknown>): ConnectHostContext {
  return {
    assertCurrent: alwaysCurrent,
    ...fields
  } as unknown as ConnectHostContext;
}

/** Strict host context is a distinct idempotency identity from external calls. */
function strictReceiptFingerprint(requestFingerprint: string): string {
  return fingerprintOf({
    fingerprint: requestFingerprint,
    requireCanonicalContent: true
  });
}

/** A valid strict context for a whole-note (unscoped) mutation. */
function strictCreateContext(operationId: string): ConnectHostContext {
  return ctx({ operationId, requireCanonicalContent: true });
}

/** A valid strict context pinned to a note-scoped mutation. */
function strictNoteContext(
  operationId: string,
  noteId: string
): ConnectHostContext {
  return ctx({ operationId, noteId, requireCanonicalContent: true });
}

interface RawRow {
  data?: unknown;
  type?: string;
  noteId?: string;
  locked?: boolean;
}

/** The note's *current* raw content row, via the read-only collection get. */
async function rawRow(
  db: ConnectHarness["db"],
  noteId: string
): Promise<RawRow | undefined> {
  const note = await db.notes.note(noteId);
  const contentId = (note as { contentId?: string } | undefined)?.contentId;
  if (!contentId) return undefined;
  return (await db.content.collection.get(
    contentId
  )) as unknown as RawRow | undefined;
}

/** Revision computed from the raw row (never the migrating `findByNoteId`). */
async function rawRevision(
  db: ConnectHarness["db"],
  noteId: string
): Promise<string> {
  const note = await db.notes.note(noteId);
  const row = await rawRow(db, noteId);
  return noteRevision(note!, row as never);
}

async function receiptRows(db: ConnectHarness["db"]) {
  return db
    .sql()
    .selectFrom("settings")
    .select(["key"])
    .where("key", "like", `${RECEIPT_PREFIX}%`)
    .execute();
}

async function receiptCount(db: ConnectHarness["db"]) {
  return (await receiptRows(db)).length;
}

async function receiptRecord(
  db: ConnectHarness["db"],
  operationId: string
): Promise<
  | { fingerprint?: string; state?: string; result?: { error?: string } }
  | undefined
> {
  const row = (await db
    .sql()
    .selectFrom("settings")
    .select(["key", "value"])
    .where("key", "=", `${RECEIPT_PREFIX}${operationId}`)
    .executeTakeFirst()) as unknown as { value?: string } | undefined;
  if (!row || typeof row.value !== "string") return undefined;
  return JSON.parse(row.value) as {
    fingerprint?: string;
    state?: string;
    result?: { error?: string };
  };
}

async function attachmentCount(db: ConnectHarness["db"]) {
  return (
    await db.sql().selectFrom("attachments").select(["id"]).execute()
  ).length;
}

function noteAttachments(db: ConnectHarness["db"], noteId: string) {
  return db.relations.from({ type: "note", id: noteId }, "attachment").get();
}

/**
 * Spy-through counters installed on the *real* persistence boundaries the
 * note pipeline writes through. Every wrapper delegates to the original bound
 * implementation (never a fake database), so a request that is refused before
 * any boundary is reached leaves every counter at zero. This catches a
 * regression that moved strict validation past `fingerprint` into a write path
 * (content post-processing, a note row, note-history, a relation, an
 * attachment, a settings/receipt row) even when the final note/content bytes
 * happen to look unchanged.
 */
function installPersistenceSpies(db: ConnectHarness["db"]) {
  const counters: Record<string, number> = {};
  const restores: (() => void)[] = [];
  const watch = (label: string, holder: object, key: string) => {
    const target = holder as unknown as Record<string, unknown>;
    const original = target[key];
    if (typeof original !== "function")
      throw new Error(`persistence spy target missing: ${label}`);
    target[key] = function (this: unknown, ...args: unknown[]) {
      counters[label] = (counters[label] ?? 0) + 1;
      return (original as (...a: unknown[]) => unknown).apply(holder, args);
    };
    restores.push(() => {
      target[key] = original;
    });
  };

  watch("note.addGuarded", db.notes, "addGuarded");
  watch("note.add", db.notes, "add");
  watch("content.add", db.content, "add");
  watch("content.postProcess", db.content, "postProcess");
  watch("content.collection.upsert", db.content.collection, "upsert");
  watch("content.collection.update", db.content.collection, "update");
  watch("sessionHistory.add", db.noteHistory, "add");
  watch("relation.add", db.relations, "add");
  watch("relation.unlink", db.relations, "unlink");
  watch("attachment.save", db.attachments, "save");
  watch("settings.collection.upsert", db.settings.collection, "upsert");
  watch("settings.collection.update", db.settings.collection, "update");

  return {
    counters,
    /** Assert *no* real persistence boundary was ever admitted. */
    expectNoAdmissions() {
      const admitted = Object.entries(counters).filter(([, n]) => n > 0);
      expect(
        admitted,
        `persistence boundaries admitted: ${admitted
          .map(([key, n]) => `${key}=${n}`)
          .join(", ")}`
      ).toEqual([]);
    },
    restore() {
      for (const restore of restores.reverse()) restore();
    }
  };
}

/**
 * The *actual* canonical bytes for a candidate body: the real sanitizer plus
 * the real detached block-id pre-processor. Not a synthetic serializer — if the
 * pipeline is not a fixed point of its own output the assertion below fails
 * locally and honestly rather than inventing a supported form.
 */
async function canonicalBytes(
  db: ConnectHarness["db"],
  candidate: string
): Promise<string> {
  const draft = {
    type: "tiptap" as const,
    data: toTiptapHtml("tiptap", candidate)
  };
  await db.content.preProcess(draft);
  // The strict adapter contract is exactly this fixed point; assert it here so
  // a non-idempotent pipeline is attributed to the converter, not the adapter.
  expect(toTiptapHtml("tiptap", draft.data)).toBe(draft.data);
  return draft.data;
}

/** Overwrite the current content row in place (a foreign/legacy writer). */
async function setRawBase(
  db: ConnectHarness["db"],
  noteId: string,
  data: string
): Promise<void> {
  const note = await db.notes.note(noteId);
  const contentId = (note as { contentId?: string } | undefined)?.contentId;
  if (!contentId) throw new Error("fixture note has no content row");
  // A partial column update that bypasses the (write-capable) content pipeline:
  // this is exactly how a legacy/foreign row carrying inline data would sit in
  // the database before a Connect append reads it.
  await db.content.collection.update([contentId], {
    data,
    locked: false
  } as never);
}

describe("VeyraN Connect strict canonical-content mode", () => {
  describe("host-context plumbing", () => {
    it("rejects a non-boolean requireCanonicalContent with no persistence", async () => {
      harness = await createHarness();
      const noteBefore = await harness.db.notes.all.count();
      const receiptsBefore = await receiptCount(harness.db);

      const bad: unknown[] = [1, 0, "true", null, {}, []];
      for (const [index, value] of bad.entries()) {
        await expectCode(
          harness.adapter.execute(
            {
              operation: "create_note",
              operationId: `strict-bad-flag-${index}`,
              format: "tiptap",
              content: "<p>body</p>"
            },
            ctx({
              operationId: `strict-bad-flag-${index}`,
              requireCanonicalContent: value
            })
          ),
          "INVALID_INPUT"
        );
      }

      expect(await harness.db.notes.all.count()).toBe(noteBefore);
      expect(await receiptCount(harness.db)).toBe(receiptsBefore);
    });

    it("accepts and ignores the flag on read and status operations", async () => {
      harness = await createHarness();
      const read = (await harness.adapter.execute(
        { operation: "get_note", noteId: harness.noteId },
        ctx({
          operationId: "strict-read",
          noteId: harness.noteId,
          requireCanonicalContent: true
        })
      )) as { noteId: string; content: string };
      expect(read.noteId).toBe(harness.noteId);
      expect(read.content).toContain("hello");

      const status = (await harness.adapter.execute(
        { operation: "status" },
        ctx({ operationId: "strict-status", requireCanonicalContent: true })
      )) as { operation?: string };
      expect(status).toBeTruthy();
    });

    it("copies the primitive before the first await (caller mutation is inert)", async () => {
      harness = await createHarness();
      const before = await harness.db.notes.all.count();
      // A valid tiptap body that is *not* a canonical fixed point (no block id).
      const noncanonical = "<p>no block id here</p>";
      const live = ctx({
        operationId: "strict-mutation",
        requireCanonicalContent: true
      });

      const pending = harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "strict-mutation",
          format: "tiptap",
          content: noncanonical
        },
        live
      );
      // The snapshot was taken synchronously inside `execute`; flipping the
      // caller's live flag now must not relax the already-selected mode.
      (live as { requireCanonicalContent?: boolean }).requireCanonicalContent =
        false;

      await expectCode(pending, "UNSUPPORTED_CONTENT");
      expect(await harness.db.notes.all.count()).toBe(before);
    });

    it("does not contaminate concurrent strict and external invocations", async () => {
      harness = await createHarness();
      const before = await harness.db.notes.all.count();
      const noncanonical = "<p>concurrent no id</p>";

      const [strict, external] = await Promise.allSettled([
        harness.adapter.execute(
          {
            operation: "create_note",
            operationId: "strict-concurrent",
            format: "tiptap",
            content: noncanonical
          },
          strictCreateContext("strict-concurrent")
        ),
        harness.adapter.execute({
          operation: "create_note",
          operationId: "external-concurrent",
          format: "tiptap",
          content: noncanonical
        })
      ]);

      expect(strict.status).toBe("rejected");
      if (strict.status === "rejected")
        expect(connectErrorCode(strict.reason)).toBe("UNSUPPORTED_CONTENT");
      expect(external.status).toBe("fulfilled");
      // Only the external create persisted.
      expect(await harness.db.notes.all.count()).toBe(before + 1);
    });
  });

  describe("strict scope and rejection", () => {
    it("rejects noncanonical bodies with zero persistence and an untouched base", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const baseRow = await rawRow(db, noteId);
      const baseData = structuredClone(baseRow?.data);
      // Read-only snapshots of the *existing* original objects: a regression
      // that admitted any real write would have to leave all of these
      // structurally identical, not just the final note count.
      const noteBefore = structuredClone(await db.notes.note(noteId));
      const historyBefore = await db.noteHistory.get(noteId).count();
      const relationsBefore = structuredClone(await noteAttachments(db, noteId));
      const before = {
        notes: await db.notes.all.count(),
        receipts: await receiptCount(db),
        attachments: await attachmentCount(db)
      };

      const rejected: { id: string; format?: string; content: string }[] = [
        // script / event handler / style are stripped by the sanitizer.
        { id: "reject-script", format: "tiptap", content: '<p><script>x()</script>hello</p>' },
        { id: "reject-event", format: "tiptap", content: '<p onclick="x()">hello</p>' },
        { id: "reject-style", format: "tiptap", content: '<p style="color:red">hello</p>' },
        // unsafe URL is stripped, so the raw bytes are not a fixed point.
        { id: "reject-unsafe-url", format: "tiptap", content: '<p><a href="javascript:alert(1)">x</a></p>' },
        // missing block ids: the pre-processor would insert them.
        { id: "reject-missing-ids", format: "tiptap", content: "<p>a</p><p>b</p>" },
        // parser normalization: an unquoted/upper attribute is rewritten.
        { id: "reject-normalization", format: "tiptap", content: "<P DATA-BLOCK-ID=p1>a</P>" },
        // empty raw string: the sanitizer materializes the canonical empty doc.
        { id: "reject-empty", format: "tiptap", content: "" },
        // content-bearing request with the default (markdown) format.
        { id: "reject-default-format", content: "plain markdown body" }
      ];

      // Spy through the *real* persistence boundaries (no fake database) for
      // the whole refusal set: a strict rejection must not admit a single
      // content/note/history/relation/attachment/settings write.
      const spies = installPersistenceSpies(db);
      try {
        for (const attempt of rejected) {
          const request: Record<string, unknown> = {
            operation: "create_note",
            operationId: attempt.id,
            content: attempt.content
          };
          if (attempt.format) request.format = attempt.format;
          await expectCode(
            harness.adapter.execute(
              request,
              strictCreateContext(attempt.id)
            ),
            "UNSUPPORTED_CONTENT"
          );
        }

        // A rejected strict *update* on the existing note must not touch it.
        const revision = await rawRevision(db, noteId);
        await expectCode(
          harness.adapter.execute(
            {
              operation: "update_note",
              operationId: "reject-update-noncanonical",
              noteId,
              expectedRevision: revision,
              patch: { content: "<p>still no block id</p>", format: "tiptap" }
            },
            strictNoteContext("reject-update-noncanonical", noteId)
          ),
          "UNSUPPORTED_CONTENT"
        );

        spies.expectNoAdmissions();
      } finally {
        spies.restore();
      }

      expect(await db.notes.all.count()).toBe(before.notes);
      expect(await receiptCount(db)).toBe(before.receipts);
      expect(await attachmentCount(db)).toBe(before.attachments);
      expect((await rawRow(db, noteId))?.data).toEqual(baseData);
      expect(structuredClone(await db.notes.note(noteId))).toEqual(noteBefore);
      expect(await db.noteHistory.get(noteId).count()).toBe(historyBefore);
      expect(structuredClone(await noteAttachments(db, noteId))).toEqual(
        relationsBefore
      );
    });

    it("accepts a canonical explicit empty paragraph with a stable id", async () => {
      harness = await createHarness();
      const canonical = await canonicalBytes(harness.db, "<p></p>");
      expect(canonical).toContain("data-block-id");

      const created = (await harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "strict-empty-paragraph",
          format: "tiptap",
          content: canonical
        },
        strictCreateContext("strict-empty-paragraph")
      )) as { noteId: string };

      expect(String((await rawRow(harness.db, created.noteId))?.data)).toBe(
        canonical
      );
    });

    it("rejects a raw empty string even though the sanitizer has a canonical empty doc", async () => {
      harness = await createHarness();
      const before = await receiptCount(harness.db);
      await expectCode(
        harness.adapter.execute(
          {
            operation: "create_note",
            operationId: "strict-raw-empty",
            format: "tiptap",
            content: ""
          },
          strictCreateContext("strict-raw-empty")
        ),
        "UNSUPPORTED_CONTENT"
      );
      expect(await receiptCount(harness.db)).toBe(before);
    });

    it("allows a title-only strict update without fabricating content", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const revision = await rawRevision(db, noteId);
      const baseData = String((await rawRow(db, noteId))?.data);

      const updated = (await harness.adapter.execute(
        {
          operation: "update_note",
          operationId: "strict-title-only",
          noteId,
          expectedRevision: revision,
          patch: { pinned: true }
        },
        strictNoteContext("strict-title-only", noteId)
      )) as { revision: string };

      expect(updated.revision).not.toBe(revision);
      expect((await db.notes.note(noteId))?.pinned).toBe(true);
      // No content was proposed, so the stored body is untouched.
      expect(String((await rawRow(db, noteId))?.data)).toBe(baseData);
    });
  });

  describe("canonical persistence", () => {
    it("creates a canonical document with real persisted bytes, receipt, replay and conflict", async () => {
      harness = await createHarness();
      const db = harness.db;
      const canonical = await canonicalBytes(
        db,
        "<p>Hello 你好 😀</p><ul><li>one</li><li>two</li></ul><p><a href=\"https://notesnook.com\">site</a></p>"
      );
      expect(canonical).toContain("data-block-id");

      const request = {
        operation: "create_note" as const,
        operationId: "strict-create-canonical",
        format: "tiptap" as const,
        content: canonical
      };
      const created = (await harness.adapter.execute(
        request,
        strictCreateContext("strict-create-canonical")
      )) as { noteId: string; revision: string };

      // Real persisted bytes equal the proposed canonical bytes.
      expect(String((await rawRow(db, created.noteId))?.data)).toBe(canonical);
      expect(await receiptCount(db)).toBe(1);

      // The request identity retains its canonical bytes, while trusted strict
      // host mode is independently bound into the receipt identity.
      const record = await receiptRecord(db, "strict-create-canonical");
      expect(record?.fingerprint).toBe(
        strictReceiptFingerprint(
          fingerprintOf({
            operation: "create_note",
            notebookId: null,
            title: null,
            format: "tiptap",
            contentHash: noteContentHash("tiptap", canonical)
          })
        )
      );

      // Replay of the same operation performs no second write.
      const notesBefore = await db.notes.all.count();
      const replay = (await harness.adapter.execute(
        request,
        strictCreateContext("strict-create-canonical")
      )) as { noteId: string };
      expect(replay.noteId).toBe(created.noteId);
      expect(await db.notes.all.count()).toBe(notesBefore);

      // Changed payload under the same operationId conflicts.
      await expectCode(
        harness.adapter.execute(
          {
            operation: "create_note",
            operationId: "strict-create-canonical",
            format: "tiptap",
            content: await canonicalBytes(db, "<p>different</p>")
          },
          strictCreateContext("strict-create-canonical")
        ),
        "IDEMPOTENCY_CONFLICT"
      );
    });

    it("does not replay an ordinary receipt as a strict host operation", async () => {
      harness = await createHarness();
      const db = harness.db;
      const canonical = await canonicalBytes(db, "<p>same request</p>");
      const request = {
        operation: "create_note" as const,
        operationId: "ordinary-then-strict",
        format: "tiptap" as const,
        content: canonical
      };

      const ordinary = (await harness.adapter.execute(request)) as {
        noteId: string;
      };
      const countBefore = await db.notes.all.count();
      await expectCode(
        harness.adapter.execute(
          request,
          strictCreateContext(request.operationId)
        ),
        "IDEMPOTENCY_CONFLICT"
      );
      expect(await db.notes.all.count()).toBe(countBefore);
      expect(await receiptCount(db)).toBe(1);
      expect((await db.notes.note(ordinary.noteId))?.id).toBe(ordinary.noteId);
    });

    it("survives a reopen", async () => {
      harness = await createHarness();
      const canonical = await canonicalBytes(
        harness.db,
        "<p>reopen 你好</p>"
      );
      const created = (await harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "strict-reopen",
          format: "tiptap",
          content: canonical
        },
        strictCreateContext("strict-reopen")
      )) as { noteId: string };

      const dbPath = harness.path;
      harness.adapter.close();
      await harness.close();
      harness = undefined;

      const reopened = await openConnectDb(dbPath);
      try {
        const row = await rawRow(reopened.db, created.noteId);
        expect(String(row?.data)).toBe(canonical);
      } finally {
        await reopened.close();
      }
    });

    it("prepares an append fragment exactly once and reuses it", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const fragment = await canonicalBytes(db, "<p>appended 你好</p>");
      const baseData = String((await rawRow(db, noteId))?.data);
      const revision = await rawRevision(db, noteId);

      const original = db.content.preProcess.bind(db.content);
      let calls = 0;
      db.content.preProcess = async (content) => {
        calls++;
        return original(content);
      };
      try {
        const appended = (await harness.adapter.execute(
          {
            operation: "append_to_note",
            operationId: "strict-append-once",
            noteId,
            expectedRevision: revision,
            format: "tiptap",
            content: fragment
          },
          strictNoteContext("strict-append-once", noteId)
        )) as { revision: string };

        expect(appended.revision).not.toBe(revision);
        // Exactly the one invocation-preparation call: reservation and perform
        // reused the same prepared fragment (no re-preparing).
        expect(calls).toBe(1);
        expect(String((await rawRow(db, noteId))?.data)).toBe(
          `${baseData}${fragment}`
        );
      } finally {
        db.content.preProcess = original;
      }
    });

    it("rejects a strict append when the stored base would be normalized", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      // This foreign/legacy node is removed by the real content post-processor.
      // The appended fragment is independently canonical, so the combined-body
      // preflight is the only thing that can catch mutation of this base.
      const legacy =
        '<p data-block-id="legacy-base">before</p>' +
        '<nn-search-result data-block-id="legacy-search">private result</nn-search-result>';
      await setRawBase(db, noteId, legacy);
      const fragment = await canonicalBytes(db, "<p>tail 你好</p>");
      const combined = `${legacy}${fragment}`;
      const probe = await getContentFromData("tiptap", combined);
      const transformed = await probe.postProcess(async () => {
        throw new Error("unexpected attachment in synthetic fixture");
      });
      expect(transformed.data).not.toBe(combined);

      const revision = await rawRevision(db, noteId);
      const noteBefore = structuredClone(await db.notes.note(noteId));
      const rawBefore = await rawRow(db, noteId);
      const historyBefore = await db.noteHistory.get(noteId).count();
      const relationsBefore = structuredClone(await noteAttachments(db, noteId));
      const before = {
        notes: await db.notes.all.count(),
        receipts: await receiptCount(db),
        attachments: await attachmentCount(db)
      };
      const spies = installPersistenceSpies(db);
      try {
        await expectCode(
          harness.adapter.execute(
            {
              operation: "append_to_note",
              operationId: "strict-append-legacy-normalization",
              noteId,
              expectedRevision: revision,
              format: "tiptap",
              content: fragment
            },
            strictNoteContext("strict-append-legacy-normalization", noteId)
          ),
          "UNSUPPORTED_CONTENT"
        );
        spies.expectNoAdmissions();
      } finally {
        spies.restore();
      }

      expect(await db.notes.all.count()).toBe(before.notes);
      expect(await receiptCount(db)).toBe(before.receipts);
      expect(await attachmentCount(db)).toBe(before.attachments);
      expect(await rawRow(db, noteId)).toEqual(rawBefore);
      expect(structuredClone(await db.notes.note(noteId))).toEqual(noteBefore);
      expect(await db.noteHistory.get(noteId).count()).toBe(historyBefore);
      expect(structuredClone(await noteAttachments(db, noteId))).toEqual(
        relationsBefore
      );
    });

    it("rejects a stale strict append before allocating its receipt", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const fragment = await canonicalBytes(db, "<p>stale append</p>");
      const revision = await rawRevision(db, noteId);
      const before = {
        row: await rawRow(db, noteId),
        receipts: await receiptCount(db),
        history: await db.noteHistory.get(noteId).count()
      };

      await expectCode(
        harness.adapter.execute(
          {
            operation: "append_to_note",
            operationId: "strict-append-stale-revision",
            noteId,
            expectedRevision: `${revision}-stale`,
            format: "tiptap",
            content: fragment
          },
          strictNoteContext("strict-append-stale-revision", noteId)
        ),
        "REVISION_CONFLICT"
      );

      expect(await receiptCount(db)).toBe(before.receipts);
      expect(await rawRow(db, noteId)).toEqual(before.row);
      expect(await db.noteHistory.get(noteId).count()).toBe(before.history);
    });

    it("prepares a create body exactly once", async () => {
      harness = await createHarness();
      const db = harness.db;
      const canonical = await canonicalBytes(db, "<p>create once</p>");

      const original = db.content.preProcess.bind(db.content);
      let calls = 0;
      db.content.preProcess = async (content) => {
        calls++;
        return original(content);
      };
      try {
        await harness.adapter.execute(
          {
            operation: "create_note",
            operationId: "strict-create-once",
            format: "tiptap",
            content: canonical
          },
          strictCreateContext("strict-create-once")
        );
        expect(calls).toBe(1);
      } finally {
        db.content.preProcess = original;
      }
    });

    it("keeps the exact external fingerprint shapes for append and update", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;

      const fragment = await canonicalBytes(db, "<p>fp fragment</p>");
      const revision = await rawRevision(db, noteId);
      await harness.adapter.execute(
        {
          operation: "append_to_note",
          operationId: "strict-fp-append",
          noteId,
          expectedRevision: revision,
          format: "tiptap",
          content: fragment
        },
        strictNoteContext("strict-fp-append", noteId)
      );
      const appendRecord = await receiptRecord(db, "strict-fp-append");
      expect(appendRecord?.fingerprint).toBe(
        strictReceiptFingerprint(
          fingerprintOf({
            operation: "append_to_note",
            noteId,
            expectedRevision: revision,
            // Request identity uses sanitizer-only bytes, not prepared HTML.
            content: noteContentHash(
              "tiptap",
              toTiptapHtml("tiptap", fragment)
            ),
            patch: null
          })
        )
      );

      const revision2 = await rawRevision(db, noteId);
      const replacement = await canonicalBytes(db, "<p>fp replacement</p>");
      const patch = { content: replacement, format: "tiptap" };
      const updated = (await harness.adapter.execute(
        {
          operation: "update_note",
          operationId: "strict-fp-update",
          noteId,
          expectedRevision: revision2,
          patch
        },
        strictNoteContext("strict-fp-update", noteId)
      )) as { revision: string };
      const updateRecord = await receiptRecord(db, "strict-fp-update");
      expect(updateRecord?.fingerprint).toBe(
        strictReceiptFingerprint(
          fingerprintOf({
            operation: "update_note",
            noteId,
            expectedRevision: revision2,
            // Request identity retains the raw patch object.
            content: null,
            patch
          })
        )
      );

      // Beyond the receipt fingerprint: the update is a *real* write. The raw
      // stored body is exactly the proposed replacement, and the acknowledged
      // revision is the raw row's own revision (not a stale/queued one).
      expect((await rawRow(db, noteId))?.data).toBe(replacement);
      expect(updated.revision).toBe(await rawRevision(db, noteId));

      // A byte-identical replay of the same operation is a receipt hit: it
      // returns the recorded revision and admits no second content write, no
      // history row and no settings/receipt write.
      const rowBeforeReplay = structuredClone(await rawRow(db, noteId));
      const historyBeforeReplay = await db.noteHistory.get(noteId).count();
      const receiptsBeforeReplay = await receiptCount(db);
      let replay!: { revision: string };
      const replaySpies = installPersistenceSpies(db);
      try {
        replay = (await harness.adapter.execute(
          {
            operation: "update_note",
            operationId: "strict-fp-update",
            noteId,
            expectedRevision: revision2,
            patch
          },
          strictNoteContext("strict-fp-update", noteId)
        )) as { revision: string };
        replaySpies.expectNoAdmissions();
      } finally {
        replaySpies.restore();
      }
      expect(replay.revision).toBe(updated.revision);
      expect(structuredClone(await rawRow(db, noteId))).toEqual(
        rowBeforeReplay
      );
      expect(await db.noteHistory.get(noteId).count()).toBe(
        historyBeforeReplay
      );
      expect(await receiptCount(db)).toBe(receiptsBeforeReplay);

      // A *changed* raw payload under the same operationId is a conflict, not
      // a silent second write.
      await expectCode(
        harness.adapter.execute(
          {
            operation: "update_note",
            operationId: "strict-fp-update",
            noteId,
            expectedRevision: revision2,
            patch: {
              content: await canonicalBytes(db, "<p>fp changed</p>"),
              format: "tiptap"
            }
          },
          strictNoteContext("strict-fp-update", noteId)
        ),
        "IDEMPOTENCY_CONFLICT"
      );
      expect((await rawRow(db, noteId))?.data).toBe(replacement);
    });
  });

  describe("persistence-pipeline fixed point", () => {
    it("accepts only bodies the real post-processor leaves byte-identical", async () => {
      harness = await createHarness();
      const db = harness.db;

      const candidates: { raw: string; label: string }[] = [
        {
          label: "remote img",
          raw: '<p data-block-id="p1"><img src="https://example.com/x.png"></p>'
        },
        {
          label: "internal nn link",
          raw: '<p data-block-id="p1"><a href="nn://note/abc">link</a></p>'
        }
      ];

      for (const candidate of candidates) {
        // The candidate must first be a sanitizer/pre-processor fixed point
        // (asserted inside `canonicalBytes`), then we probe the *actual*
        // content-type post-processor (write-free) to learn whether the
        // persistence pipeline would rewrite the bytes.
        const raw = await canonicalBytes(db, candidate.raw);
        const content = await getContentFromData("tiptap", raw);
        const probe = await content.postProcess(async () => {
          throw new Error("no attachment save in preflight");
        });
        const stable = probe.data === raw;

        const before = {
          notes: await db.notes.all.count(),
          receipts: await receiptCount(db),
          attachments: await attachmentCount(db)
        };

        const operationId = `strict-fixedpoint-${candidate.label.replace(/\s+/g, "-")}`;
        if (stable) {
          const created = (await harness.adapter.execute(
            {
              operation: "create_note",
              operationId,
              format: "tiptap",
              content: raw
            },
            strictCreateContext(operationId)
          )) as { noteId: string };
          expect(String((await rawRow(db, created.noteId))?.data)).toBe(raw);
        } else {
          await expectCode(
            harness.adapter.execute(
              {
                operation: "create_note",
                operationId,
                format: "tiptap",
                content: raw
              },
              strictCreateContext(operationId)
            ),
            "UNSUPPORTED_CONTENT"
          );
          expect(await db.notes.all.count()).toBe(before.notes);
          expect(await receiptCount(db)).toBe(before.receipts);
          expect(await attachmentCount(db)).toBe(before.attachments);
        }
      }
    });

    it("appends to a base with a stored data-hash reference without disturbing it", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const hash = (await db.attachments.save(
        "aGVsbG8=",
        "text/plain",
        "a.txt"
      ))!;
      expect(hash).toBeTruthy();
      await db.content.add({
        noteId,
        type: "tiptap",
        data: `<p>base <img data-hash="${hash}" data-mime="text/plain"></p>`
      });
      const relationsBefore = await noteAttachments(db, noteId);
      expect(relationsBefore.length).toBe(1);
      const linkedTargetId = relationsBefore[0]!.toId;
      const attachmentsBefore = await attachmentCount(db);

      const fragment = await canonicalBytes(db, "<p>tail 你好</p>");
      const revision = await rawRevision(db, noteId);
      await harness.adapter.execute(
        {
          operation: "append_to_note",
          operationId: "strict-append-datahash",
          noteId,
          expectedRevision: revision,
          format: "tiptap",
          content: fragment
        },
        strictNoteContext("strict-append-datahash", noteId)
      );

      const stored = String((await rawRow(db, noteId))?.data);
      expect(stored).toContain(`data-hash="${hash}"`);
      expect(stored).toContain("tail 你好");
      // No new attachment import and the existing reference is untouched.
      expect(await attachmentCount(db)).toBe(attachmentsBefore);
      const relationsAfter = await noteAttachments(db, noteId);
      expect(relationsAfter.length).toBe(1);
      expect(relationsAfter[0]!.toId).toBe(linkedTargetId);
    });

    it("rejects a prospective fragment carrying data-hash/data-URI before any receipt", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const bad = [
        '<p data-block-id="p1"><img data-hash="synthetic" data-mime="text/plain"></p>',
        '<p data-block-id="p1"><img src="data:image/png;base64,c3ludGhldGlj"></p>'
      ];
      const before = {
        receipts: await receiptCount(db),
        attachments: await attachmentCount(db)
      };
      for (const [index, content] of bad.entries()) {
        const revision = await rawRevision(db, noteId);
        await expectCode(
          harness.adapter.execute(
            {
              operation: "append_to_note",
              operationId: `strict-append-attachment-${index}`,
              noteId,
              expectedRevision: revision,
              format: "tiptap",
              content
            },
            strictNoteContext(`strict-append-attachment-${index}`, noteId)
          ),
          "UNSUPPORTED_CONTENT"
        );
      }
      expect(await receiptCount(db)).toBe(before.receipts);
      expect(await attachmentCount(db)).toBe(before.attachments);
    });

    it("still denies an append onto a legacy inline-data base and leaves it unchanged", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const legacy =
        '<p>legacy <img src="data:image/png;base64,c3ludGhldGljLWltYWdl"></p>';
      await setRawBase(db, noteId, legacy);
      const before = {
        receipts: await receiptCount(db),
        attachments: await attachmentCount(db)
      };

      const fragment = await canonicalBytes(db, "<p>tail</p>");
      const revision = await rawRevision(db, noteId);
      await expectCode(
        harness.adapter.execute(
          {
            operation: "append_to_note",
            operationId: "strict-append-legacy-inline",
            noteId,
            expectedRevision: revision,
            format: "tiptap",
            content: fragment
          },
          strictNoteContext("strict-append-legacy-inline", noteId)
        ),
        "UNSUPPORTED_CONTENT"
      );

      expect(await receiptCount(db)).toBe(before.receipts);
      expect(await attachmentCount(db)).toBe(before.attachments);
      expect(String((await rawRow(db, noteId))?.data)).toBe(legacy);
    });
  });

  describe("no-write guarantees and authorization", () => {
    it("does not migrate a legacy no-id base on a rejected strict request", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const legacy = "<p>no ids in this row</p>";
      await setRawBase(db, noteId, legacy);

      const revision = await rawRevision(db, noteId);
      await expectCode(
        harness.adapter.execute(
          {
            operation: "append_to_note",
            operationId: "strict-no-migrate",
            noteId,
            expectedRevision: revision,
            format: "tiptap",
            content: "<p>noncanonical fragment</p>"
          },
          strictNoteContext("strict-no-migrate", noteId)
        ),
        "UNSUPPORTED_CONTENT"
      );

      // Raw read (no read-and-preprocess): the base was neither rewritten nor
      // given block ids by the rejected request.
      expect(String((await rawRow(db, noteId))?.data)).toBe(legacy);
      expect(await receiptCount(db)).toBe(0);
    });

    it("denies a host revoked during strict preparation with no receipt or write", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const fragment = await canonicalBytes(db, "<p>revoke me</p>");
      const baseRow = await rawRow(db, noteId);
      const baseData = structuredClone(baseRow?.data);
      const noteBefore = structuredClone(await db.notes.note(noteId));
      const historyBefore = await db.noteHistory.get(noteId).count();
      const revision = await rawRevision(db, noteId);

      let revoked = false;
      const original = db.content.preProcess.bind(db.content);
      db.content.preProcess = async (content) => {
        const result = await original(content);
        // The host loses ownership while the fragment is being prepared.
        revoked = true;
        return result;
      };
      // The revocation must stop the operation before *any* real persistence
      // boundary is reached — not merely before the final note count changes.
      const spies = installPersistenceSpies(db);
      try {
        await expectCode(
          harness.adapter.execute(
            {
              operation: "append_to_note",
              operationId: "strict-revoke-preparation",
              noteId,
              expectedRevision: revision,
              format: "tiptap",
              content: fragment
            },
            {
              operationId: "strict-revoke-preparation",
              noteId,
              requireCanonicalContent: true,
              assertCurrent: () => {
                if (revoked) throw new Error("ownership lost");
              }
            }
          ),
          "SESSION_CHANGED"
        );
        spies.expectNoAdmissions();
      } finally {
        db.content.preProcess = original;
        spies.restore();
      }

      expect(await receiptCount(db)).toBe(0);
      expect((await rawRow(db, noteId))?.data).toEqual(baseData);
      expect(structuredClone(await db.notes.note(noteId))).toEqual(noteBefore);
      expect(await db.noteHistory.get(noteId).count()).toBe(historyBefore);
    });

    it("denies a locked adapter through existing authorization with no receipt", async () => {
      harness = await createHarness();
      const before = await receiptCount(harness.db);
      const canonical = await canonicalBytes(harness.db, "<p>locked</p>");
      harness.adapter.lock();
      await expectCode(
        harness.adapter.execute(
          {
            operation: "create_note",
            operationId: "strict-locked",
            format: "tiptap",
            content: canonical
          },
          strictCreateContext("strict-locked")
        ),
        "ADAPTER_LOCKED"
      );
      expect(await receiptCount(harness.db)).toBe(before);
    });

    it("denies a locked (Vault) target through existing authorization with no replacement", async () => {
      harness = await createHarness();
      const db = harness.db;
      const noteId = harness.noteId;
      const note = await db.notes.note(noteId);
      const contentId = (note as { contentId?: string } | undefined)?.contentId;
      expect(contentId).toBeTruthy();
      // Simulate a vault-locked content row: the body is locked, so it must be
      // denied by the existing mutability gate regardless of any editor text.
      // The row must carry the *real* locked shape (an encrypted cipher blob
      // serialized as JSON): a locked row whose `data` is still plaintext is
      // malformed, and the read mapper would `JSON.parse` it before the adapter
      // is ever exercised.
      await db.content.collection.update([contentId!], {
        locked: true,
        data: JSON.stringify({ cipher: "synthetic" })
      } as never);
      const baseRow = await rawRow(db, noteId);
      // A read-only `get` surfaces the parsed cipher object, not a string, so
      // this is compared structurally (a `String(obj)` compare would be a
      // useless `"[object Object]"` false positive).
      const baseData = structuredClone(baseRow?.data);
      const baseNote = structuredClone(await db.notes.note(noteId));
      expect(baseRow?.locked).toBe(true);
      expect(baseData).toEqual({ cipher: "synthetic" });
      const revision = await rawRevision(db, noteId);
      const receiptsBefore = await receiptCount(db);

      const fragment = await canonicalBytes(db, "<p>vault attempt</p>");
      const spies = installPersistenceSpies(db);
      try {
        await expectCode(
          harness.adapter.execute(
            {
              operation: "append_to_note",
              operationId: "strict-vault-locked",
              noteId,
              expectedRevision: revision,
              format: "tiptap",
              content: fragment
            },
            strictNoteContext("strict-vault-locked", noteId)
          ),
          "NOTE_LOCKED"
        );
        spies.expectNoAdmissions();
      } finally {
        spies.restore();
      }

      // The locked body was neither replaced nor decrypted-then-rewritten.
      const row = await rawRow(db, noteId);
      expect(row?.locked).toBe(true);
      expect(row?.data).toEqual(baseData);
      // The strict mutability preflight denies before a receipt is reserved.
      expect(await receiptCount(db)).toBe(receiptsBefore);
      // The note's own metadata row is untouched.
      expect(structuredClone(await db.notes.note(noteId))).toEqual(baseNote);
    });
  });
});
