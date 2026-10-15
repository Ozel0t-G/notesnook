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
import { taskRevision } from "../../src/connect/revision.js";
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

function grantsOf(ctx: ConnectHarness, listIds: string[]) {
  return {
    accountId: ctx.accountId,
    canCreate: true,
    canRead: true,
    canChange: true,
    canTask: true,
    notebookIDs: [ctx.notebookId],
    noteIDs: [ctx.noteId],
    listIDs: listIds
  };
}

async function completedRecurring(ctx: ConnectHarness) {
  return ctx.db.tasks.create({
    title: "recurring standup",
    listId: ctx.listId,
    dueDate: "2030-01-01",
    recurrenceRule: "FREQ=DAILY",
    completed: true,
    completedAt: Date.parse("2026-10-11T10:00:00.000Z"),
    completedWallDate: "2026-10-11",
    completedWallTime: "10:00"
  });
}

function seriesOf(ctx: ConnectHarness, seriesId: string) {
  return ctx.db.tasks.listSync().filter((task) => task.seriesId === seriesId);
}

/**
 * Two domain-internal follow-ups write *after* their operation's own primary
 * write has already landed: the notebook relation of a created note and the
 * next occurrence of a completed recurring Task. Both wait on a mutex for an
 * unbounded time, so their write has to be validated at its own boundary —
 * while a denial must leave the half-applied operation recoverable (reserved or
 * uncertain), never aborted.
 */
describe("VeyraN Connect guarded domain-internal follow-ups", () => {
  it("does not bind the notebook when the operation is revoked while the binding runs", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const notes = ctx.db.notes;
    const originalNote = notes.note.bind(notes);
    let revoked = false;
    notes.note = async (id: string) => {
      // The first `notes.note` read of a `create_note` is the guarded notebook
      // binding: revoke exactly there, i.e. after the note body/row landed and
      // before the relation write.
      if (!revoked) {
        revoked = true;
        ctx.adapter.clearGrants();
      }
      return originalNote(id);
    };
    const notebookNotes = () =>
      ctx.db.relations
        .from({ id: ctx.notebookId, type: "notebook" }, "note")
        .get();
    const request = {
      operation: "create_note" as const,
      operationId: "binding-revoked",
      notebookId: ctx.notebookId,
      content: "bound body"
    };

    try {
      const before = await ctx.db.notes.all.count();
      await expectCode(ctx.adapter.execute(request), "GRANTS_CHANGED");
      expect(await notebookNotes()).toHaveLength(0);
      // The body itself already landed: it must stay recoverable, not be
      // rolled back and not be duplicated.
      expect(await ctx.db.notes.all.count()).toBe(before + 1);

      // Still revoked: the recorded operation cannot be recovered.
      await expectCode(ctx.adapter.execute(request), "NOT_AUTHORIZED");

      // Re-authorized: the stable retry restores exactly the recorded relation
      // on the same note.
      await ctx.adapter.setGrants(grantsOf(ctx, [ctx.listId]));
      const result = (await ctx.adapter.execute(request)) as { noteId: string };
      expect(await ctx.db.notes.all.count()).toBe(before + 1);
      const bound = await notebookNotes();
      expect(bound.map((relation) => relation.toId)).toEqual([result.noteId]);
      const content = await ctx.db.content.findByNoteId(result.noteId);
      expect(String(content?.data)).toContain("bound body");
    } finally {
      notes.note = originalNote;
    }
  });

  it("creates no next occurrence when the follow-up of an already completed recurrence is revoked", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const task = await completedRecurring(ctx);
    const seriesId = task.seriesId || task.id;
    const lists = ctx.db.taskLists;
    const originalGetSync = lists.getSync.bind(lists);
    let revoked = false;
    lists.getSync = (id: string) => {
      // The first `TaskLists.getSync` of a completion is the recurrence
      // follow-up's list check, i.e. after the completion's own guard ran and
      // before the follow-up is saved.
      if (!revoked) {
        revoked = true;
        ctx.adapter.lock();
      }
      return originalGetSync(id);
    };
    const request = {
      operation: "complete_task" as const,
      operationId: "recurrence-locked",
      taskId: task.id,
      expectedRevision: taskRevision(task)
    };

    try {
      await expectCode(ctx.adapter.execute(request), "ADAPTER_LOCKED");

      // The durable completion is preserved and no occurrence was created.
      expect(seriesOf(ctx, seriesId)).toHaveLength(1);
      const stored = (await ctx.db.tasks.get(task.id))!;
      expect(stored.completed).toBe(true);
      expect(taskRevision(stored)).toBe(taskRevision(task));

      // Re-authorized stable retry: the durable completion is acknowledged (no
      // false abort) and no occurrence is duplicated.
      ctx.adapter.unlock();
      const retried = (await ctx.adapter.execute(request)) as {
        completed: boolean;
        taskId: string;
      };
      expect(retried.taskId).toBe(task.id);
      expect(retried.completed).toBe(true);
      expect(seriesOf(ctx, seriesId)).toHaveLength(1);

      // The missing follow-up is repaired by the existing maintenance path.
      await ctx.db.tasks.reconcileRecurrence();
      expect(seriesOf(ctx, seriesId)).toHaveLength(2);
      expect(
        seriesOf(ctx, seriesId).filter((entry) => !entry.completed)
      ).toHaveLength(1);
    } finally {
      lists.getSync = originalGetSync;
    }
  });

  it("keeps a completion created by this operation recoverable and creates the next occurrence once", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const task = await ctx.db.tasks.create({
      title: "recurring review",
      listId: ctx.listId,
      dueDate: "2030-01-01",
      recurrenceRule: "FREQ=DAILY"
    });
    const seriesId = task.seriesId || task.id;
    const lists = ctx.db.taskLists;
    const originalGetSync = lists.getSync.bind(lists);
    let revoked = false;
    lists.getSync = (id: string) => {
      if (!revoked) {
        revoked = true;
        ctx.adapter.clearGrants();
      }
      return originalGetSync(id);
    };
    const request = {
      operation: "complete_task" as const,
      operationId: "recurrence-revoked",
      taskId: task.id,
      expectedRevision: taskRevision(task)
    };

    try {
      await expectCode(ctx.adapter.execute(request), "GRANTS_CHANGED");

      // The completion this operation wrote is durable; its follow-up was not
      // created without authorization.
      const stored = (await ctx.db.tasks.get(task.id))!;
      expect(stored.completed).toBe(true);
      expect(seriesOf(ctx, seriesId).filter((t) => !t.completed)).toHaveLength(
        0
      );

      // Re-authorized for the task but not for its list: still nothing
      // recovers, and nothing is created.
      await ctx.adapter.setGrants(grantsOf(ctx, []));
      await expectCode(ctx.adapter.execute(request), "NOT_AUTHORIZED");
      expect(seriesOf(ctx, seriesId).filter((t) => !t.completed)).toHaveLength(
        0
      );

      // Re-authorized for the list: the stable retry succeeds and the missing
      // follow-up is repaired exactly once.
      await ctx.adapter.setGrants(grantsOf(ctx, [ctx.listId]));
      const retried = (await ctx.adapter.execute(request)) as {
        completed: boolean;
      };
      expect(retried.completed).toBe(true);
      await ctx.db.tasks.reconcileRecurrence();
      expect(seriesOf(ctx, seriesId).filter((t) => !t.completed)).toHaveLength(
        1
      );

      // A further stable replay never creates a second occurrence.
      await ctx.adapter.execute(request);
      await ctx.db.tasks.reconcileRecurrence();
      expect(seriesOf(ctx, seriesId).filter((t) => !t.completed)).toHaveLength(
        1
      );
    } finally {
      lists.getSync = originalGetSync;
    }
  });
});
