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

import { afterEach, describe, expect, it } from "vitest";
import { expectCode } from "./helpers.js";
import { ConnectHarness, createHarness, openConnectDb } from "./fixtures.js";
import { ConnectAdapter } from "../../src/connect/adapter.js";
import {
  IdempotencyJournal,
  RECEIPT_PREFIX
} from "../../src/connect/journal.js";
import { makeId } from "../../src/utils/id.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

/** The grants `createHarness` installed, rebuilt for a re-created adapter. */
function connectGrants(ctx: {
  accountId: string;
  notebookId: string;
  noteId: string;
  listId: string;
}) {
  return {
    accountId: ctx.accountId,
    canCreate: true,
    canRead: true,
    canChange: true,
    canTask: true,
    notebookIDs: [ctx.notebookId],
    noteIDs: [ctx.noteId],
    listIDs: [ctx.listId]
  };
}

/** Seed `count` valid, metadata-only receipts through the actual journal API. */
async function seedReceipts(
  db: ConnectHarness["db"],
  accountId: string,
  prefix: string,
  count: number
) {
  const journal = new IdempotencyJournal(db);
  for (let i = 0; i < count; i++) {
    await journal.begin({
      operationId: `${prefix}-${i}`,
      operation: "create_note",
      accountId,
      fingerprint: `${prefix}-fingerprint-${i}`,
      createReservation: async () => ({ reservedId: `seed${prefix}${i}` })
    });
  }
  return journal;
}

describe("VeyraN Connect journal capacity at the real default bound", () => {
  it("fails closed at 1000, honours a trusted raise, and replays a real committed operation across restart and a lowered bound", async () => {
    harness = await createHarness();
    const ctx = harness;
    const anchor = {
      operation: "create_note" as const,
      operationId: "capacity-anchor",
      content: "anchor body"
    };
    const created = (await ctx.adapter.execute(anchor)) as { noteId: string };

    // 1 real committed receipt + 999 seeded metadata receipts = the default 1000.
    const journal = await seedReceipts(ctx.db, ctx.accountId, "capacity-seed", 999);
    expect(journal.count()).toBe(1000);

    // A new operation is denied — history is never evicted to make room.
    await expectCode(
      ctx.adapter.execute({
        operation: "create_note",
        operationId: "capacity-over",
        content: "x"
      }),
      "JOURNAL_FULL"
    );
    expect(await journal.read("capacity-over")).toBeUndefined();

    // Trusted host raises the bound by recreating the adapter over the db.
    ctx.adapter.close();
    const raised = new ConnectAdapter(ctx.db, { maxJournalEntries: 1001 });
    await raised.setGrants(connectGrants(ctx));
    const extra = (await raised.execute({
      operation: "create_note",
      operationId: "capacity-over",
      content: "x"
    })) as { noteId: string };
    expect(extra.noteId).toBeTruthy();
    expect(new IdempotencyJournal(ctx.db).count()).toBe(1001);

    // The original *real* committed operation replays with no duplicate note.
    const beforeReplay = await ctx.db.notes.all.count();
    const replay = (await raised.execute(anchor)) as { noteId: string };
    expect(replay.noteId).toBe(created.noteId);
    expect(await ctx.db.notes.all.count()).toBe(beforeReplay);
    raised.close();

    // Restart: a fresh adapter at the default bound still denies new writes but
    // replays the recorded outcome.
    const { path: dbPath, accountId, notebookId, noteId, listId } = ctx;
    await ctx.close();
    const reopened = await openConnectDb(dbPath);
    const restarted = new ConnectAdapter(reopened.db);
    await restarted.setGrants(connectGrants({ ...reopened, accountId, notebookId, noteId, listId }));
    await expectCode(
      restarted.execute({
        operation: "create_note",
        operationId: "capacity-restart-over",
        content: "x"
      }),
      "JOURNAL_FULL"
    );
    expect(((await restarted.execute(anchor)) as { noteId: string }).noteId).toBe(
      created.noteId
    );
    restarted.close();

    // Lowering the bound below the current count is the same fail-closed policy.
    const lowered = new ConnectAdapter(reopened.db, { maxJournalEntries: 500 });
    await lowered.setGrants(connectGrants({ ...reopened, accountId, notebookId, noteId, listId }));
    await expectCode(
      lowered.execute({
        operation: "create_note",
        operationId: "capacity-lowered-over",
        content: "x"
      }),
      "JOURNAL_FULL"
    );
    expect(((await lowered.execute(anchor)) as { noteId: string }).noteId).toBe(
      created.noteId
    );

    harness = {
      ...reopened,
      adapter: lowered,
      accountId,
      notebookId,
      noteId,
      listId
    };
  });
});

describe("VeyraN Connect receipt states across a real settings merge", () => {
  it("preserves committed/reserved/tombstoned/unknown-version/cross-account receipts", async () => {
    harness = await createHarness();
    const ctx = harness;
    const journal = new IdempotencyJournal(ctx.db);

    const committedRequest = {
      operation: "create_note" as const,
      operationId: "merge-committed",
      content: "committed body"
    };
    const committed = (await ctx.adapter.execute(committedRequest)) as {
      noteId: string;
    };

    await journal.begin({
      operationId: "merge-reserved",
      operation: "create_note",
      accountId: ctx.accountId,
      fingerprint: "merge-reserved-fingerprint",
      createReservation: async () => ({ reservedId: "mergereserved00000001" })
    });
    await journal.begin({
      operationId: "merge-cross-account",
      operation: "create_note",
      accountId: "acct-other",
      fingerprint: "merge-cross-fingerprint",
      createReservation: async () => ({ reservedId: "mergecross0000000001" })
    });

    // A live but unknown-version receipt row.
    const unknownKey = `${RECEIPT_PREFIX}merge-unknown`;
    await ctx.db.settings.collection.upsert({
      id: makeId(unknownKey),
      type: "settingitem",
      key: unknownKey,
      value: JSON.stringify({ v: 999, operationId: "merge-unknown" }),
      dateCreated: Date.now()
    } as never);

    // A committed receipt whose row was afterwards tombstoned.
    await ctx.adapter.execute({
      operation: "create_note",
      operationId: "merge-tombstone",
      content: "tomb"
    });
    await ctx.db.settings.collection.softDelete([
      makeId(`${RECEIPT_PREFIX}merge-tombstone`)
    ]);

    // A *real* outbound settingitem chunk (it carries every unsynced settings
    // row, receipts included) merged back through the real collector and
    // processChunk with the real account keys.
    const chunks: unknown[] = [];
    for await (const chunk of ctx.db.syncer.sync.collector.collect(500, true))
      chunks.push(chunk);
    const chunk = (chunks as { type: string }[]).find(
      (candidate) => candidate.type === "settingitem"
    );
    expect(chunk).toBeTruthy();
    const keys = await ctx.db.user.getDataEncryptionKeys();
    expect(keys?.length).toBeGreaterThan(0);
    await ctx.db.syncer.sync.processChunk(chunk as never, keys!, {} as never);

    // A committed receipt still replays, with no duplicate write.
    expect((await journal.read("merge-committed"))?.state).toBe("committed");
    const beforeReplay = await ctx.db.notes.all.count();
    const replay = (await ctx.adapter.execute(committedRequest)) as {
      noteId: string;
    };
    expect(replay.noteId).toBe(committed.noteId);
    expect(await ctx.db.notes.all.count()).toBe(beforeReplay);

    // A reserved receipt is neither lost nor silently committed.
    expect((await journal.read("merge-reserved"))?.state).toBe("reserved");

    // A receipt recorded under another account is not hijacked by this one.
    await expectCode(
      ctx.adapter.execute({
        operation: "create_note",
        operationId: "merge-cross-account",
        content: "x"
      }),
      "IDEMPOTENCY_CONFLICT"
    );

    // Unknown-version and tombstoned receipts stay fail-closed.
    await expectCode(journal.read("merge-unknown"), "JOURNAL_CORRUPT");
    await expectCode(journal.read("merge-tombstone"), "JOURNAL_CORRUPT");
  });
});
