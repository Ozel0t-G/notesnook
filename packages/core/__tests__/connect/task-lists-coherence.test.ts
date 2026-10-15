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
import { ConnectAdapter, MAX_JOURNAL_CAPACITY } from "../../src/connect/adapter.js";
import { makeId } from "../../src/utils/id.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
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

async function grantsFor(ctx: ConnectHarness, listIds: string[]) {
  await ctx.adapter.setGrants({
    accountId: ctx.accountId,
    canCreate: true,
    canRead: true,
    canChange: true,
    canTask: true,
    notebookIDs: [ctx.notebookId],
    noteIDs: [ctx.noteId],
    listIDs: listIds
  });
}

type ListsResult = { lists: { id: string; name: string }[] };

/**
 * `list_task_lists` must return one coherent plan: the objects are rebuilt
 * after the seal inside the Task writers' critical section, so a list rename,
 * delete, create or raw-privacy toggle that lands at the seal cannot leak a
 * stale name or drop a still-authorized list.
 */
describe("VeyraN Connect list_task_lists coherence", () => {
  it("reflects a raw privacy toggle that lands at the seal", async () => {
    harness = await createHarness();
    const ctx = harness;
    let toggled = false;
    ctx.adapter.onFenceStep = async (label) => {
      if (label !== "seal" || toggled) return;
      toggled = true;
      await hideListRaw(ctx, ctx.listId);
    };

    const result = (await ctx.adapter.execute({
      operation: "list_task_lists"
    })) as ListsResult;
    expect(toggled).toBe(true);
    expect(result.lists.some((list) => list.id === ctx.listId)).toBe(false);
  });

  it("reflects a rename that lands at the seal", async () => {
    harness = await createHarness();
    const ctx = harness;
    ctx.adapter.onFenceStep = async (label) => {
      if (label === "seal")
        await ctx.db.taskLists.update(ctx.listId, { name: "Renamed at seal" });
    };

    const result = (await ctx.adapter.execute({
      operation: "list_task_lists"
    })) as ListsResult;
    expect(result.lists).toHaveLength(1);
    expect(result.lists[0].id).toBe(ctx.listId);
    expect(result.lists[0].name).toBe("Renamed at seal");
  });

  it("drops a list removed at the seal", async () => {
    harness = await createHarness();
    const ctx = harness;
    const extra = await ctx.db.taskLists.create("Extra list");
    await grantsFor(ctx, [ctx.listId, extra.id]);
    ctx.adapter.onFenceStep = async (label) => {
      if (label === "seal") await ctx.db.taskLists.remove(extra.id);
    };

    const result = (await ctx.adapter.execute({
      operation: "list_task_lists"
    })) as ListsResult;
    expect(result.lists.map((list) => list.id)).toEqual([ctx.listId]);
  });
});

/**
 * Public Task *list* writes must take the same database-scoped Task write
 * critical section as Task create/update/complete, so a list rename/remove/
 * create cannot interleave with a Task write (no lost updates, no dangling
 * task list references).
 */
describe("VeyraN Connect Task list write coordination", () => {
  it("serializes a list create with the Task write lease", async () => {
    harness = await createHarness();
    const ctx = harness;
    const entered = gate();
    const hold = gate();
    const holder = ctx.db.tasks.runExclusiveTaskWrite(async () => {
      entered.open();
      await hold.promise;
    });
    await entered.promise;

    let created = false;
    const pending = ctx.db.taskLists.create("Race list").then((list) => {
      created = true;
      return list;
    });
    await nextTick();
    expect(created).toBe(false);

    hold.open();
    await holder;
    const list = await pending;
    expect(created).toBe(true);
    // Not lost: the row is persisted and readable.
    expect(ctx.db.taskLists.getSync(list.id)?.name).toBe("Race list");
  });

  it("moves a removed list's Tasks without dangling references", async () => {
    harness = await createHarness();
    const ctx = harness;
    const doomed = await ctx.db.taskLists.create("Doomed");
    const first = await ctx.db.tasks.create({
      title: "doomed one",
      listId: doomed.id
    });
    const second = await ctx.db.tasks.create({
      title: "doomed two",
      listId: doomed.id
    });

    const entered = gate();
    const hold = gate();
    const holder = ctx.db.tasks.runExclusiveTaskWrite(async () => {
      entered.open();
      await hold.promise;
    });
    await entered.promise;

    let removed = false;
    const pending = ctx.db.taskLists.remove(doomed.id).then(() => {
      removed = true;
    });
    await nextTick();
    expect(removed).toBe(false);

    hold.open();
    await holder;
    await pending;
    expect(removed).toBe(true);
    expect(ctx.db.taskLists.getSync(doomed.id)).toBeUndefined();

    // Every Task points at a list that still exists (the moved ones fall back
    // to the default list): no dangling `listId`.
    const listIds = new Set([
      ctx.listId,
      ...ctx.db.taskLists.listSync().map((list) => list.id)
    ]);
    const moved = ctx.db.tasks.listSync().filter(
      (task) => task.id === first.id || task.id === second.id
    );
    expect(moved).toHaveLength(2);
    for (const task of moved) expect(listIds.has(task.listId)).toBe(true);
  });
});

/**
 * Receipt journal capacity: finite, bounded, fail-closed. No automatic growth,
 * eviction, TTL, pruning, delete or reset; no user-supplied request capacity.
 * A trusted host may raise the bound only by closing the old adapter and
 * recreating one over the same database with a higher config.
 */
describe("VeyraN Connect journal capacity", () => {
  it("rejects capacities above the documented upper bound", async () => {
    harness = await createHarness();
    for (const value of [
      MAX_JOURNAL_CAPACITY + 1,
      1_000_000,
      Number.MAX_SAFE_INTEGER
    ]) {
      let caught: unknown;
      try {
        new ConnectAdapter(harness.db, { maxJournalEntries: value });
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string })?.code, `capacity=${value}`).toBe(
        "INVALID_INPUT"
      );
    }
    // The documented upper bound itself is accepted.
    const accepted = new ConnectAdapter(harness.db, {
      maxJournalEntries: MAX_JOURNAL_CAPACITY
    });
    accepted.close();
  });

  it("fails closed at the default capacity and replays old receipts after a trusted raise", async () => {
    harness = await createHarness({ maxJournalEntries: 1 });
    const ctx = harness;
    const first = (await ctx.adapter.execute({
      operation: "create_note",
      operationId: "capacity-1",
      content: "one"
    })) as { noteId: string };

    await expectCode(
      ctx.adapter.execute({
        operation: "create_note",
        operationId: "capacity-2",
        content: "two"
      }),
      "JOURNAL_FULL"
    );

    // Trusted host: close the old adapter (revokes its grants/generation) and
    // recreate over the same database with a higher bound.
    ctx.adapter.close();
    const raised = new ConnectAdapter(ctx.db, { maxJournalEntries: 2 });
    await raised.setGrants({
      accountId: ctx.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [ctx.notebookId],
      noteIDs: [first.noteId],
      listIDs: [ctx.listId]
    });

    const second = (await raised.execute({
      operation: "create_note",
      operationId: "capacity-2",
      content: "two"
    })) as { noteId: string };
    expect(second.noteId).toBeTruthy();

    // The original receipt still replays and creates no duplicate.
    const before = await ctx.db.notes.all.count();
    const replay = (await raised.execute({
      operation: "create_note",
      operationId: "capacity-1",
      content: "one"
    })) as { noteId: string };
    expect(replay.noteId).toBe(first.noteId);
    expect(await ctx.db.notes.all.count()).toBe(before);
    raised.close();
  });

  it("reports an actual metadata snapshot and preserves receipts across a real settings merge", async () => {
    harness = await createHarness();
    const ctx = harness;
    await ctx.adapter.execute({
      operation: "create_note",
      operationId: "merge-receipt",
      content: "merged body"
    });
    // A real Task row guarantees a non-empty settingitem chunk (the chunk also
    // carries the receipt rows).
    await ctx.db.tasks.create({ title: "merge task", listId: ctx.listId });

    const status = (await ctx.adapter.execute({ operation: "status" })) as {
      journal: { capacity: number; count: number };
    };
    // Default capacity is 1000; the count is a local, non-atomic snapshot.
    expect(status.journal.capacity).toBe(1000);
    expect(status.journal.count).toBeGreaterThanOrEqual(1);

    // A *real* outbound settingitem chunk (it carries the receipt rows) merged
    // back through the sync path must not corrupt or duplicate the receipt.
    const chunks: unknown[] = [];
    for await (const chunk of ctx.db.syncer.sync.collector.collect(500, true))
      chunks.push(chunk);
    const chunk = (chunks as { type: string }[]).find(
      (candidate) => candidate.type === "settingitem"
    );
    expect(chunk).toBeTruthy();
    const keys = await ctx.db.user.getDataEncryptionKeys();
    expect(keys?.length).toBeGreaterThan(0);
    await ctx.db.syncer.sync.processChunk(
      chunk as never,
      keys!,
      {} as never
    );

    const before = await ctx.db.notes.all.count();
    const replay = (await ctx.adapter.execute({
      operation: "create_note",
      operationId: "merge-receipt",
      content: "merged body"
    })) as { noteId: string };
    expect(replay.noteId).toBeTruthy();
    expect(await ctx.db.notes.all.count()).toBe(before);
  });
});
