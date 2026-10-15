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

/**
 * What a read returns must be coherent with *one* state: the objects are
 * re-read (and reauthorized) after the operation's last asynchronous
 * instrumentation point, inside the shared domain critical section every
 * note/content/relation writer takes. An earlier read that a later await
 * invalidated must therefore never be returned, and the seal hook — the last
 * await before the response — must not be able to leave previously authorized
 * content in it.
 */
describe("VeyraN Connect returned-object coherence", () => {
  it("never returns a search hit that lost its notebook while a later hit was read", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const first = await ctx.db.notes.add({
      title: "Alpha hit",
      content: { type: "tiptap", data: "<p>needle alpha</p>" }
    });
    const second = await ctx.db.notes.add({
      title: "Beta hit",
      content: { type: "tiptap", data: "<p>needle beta</p>" }
    });
    await ctx.db.notes.addToNotebook(ctx.notebookId, first, second);

    const content = ctx.db.content;
    // The adapter reads the note's *current* body through the read-only
    // `SQLCollection.get` (keyed by the note's own `contentId`), not the
    // arbitrary, mutating `findByNoteId`; the instrumentation therefore wraps
    // `collection.get` and maps each read content id back to its note id.
    const contentIds = await noteContentIds(ctx.db, [first, second]);
    const originalGet = content.collection.get.bind(content.collection);
    const readHits: string[] = [];
    content.collection.get = async (contentId: string) => {
      const noteId = contentIds.get(contentId);
      if (noteId) readHits.push(noteId);
      return originalGet(contentId);
    };
    let contentSteps = 0;
    let unlinked: string | undefined;
    ctx.adapter.onFenceStep = async (label) => {
      if (label !== "content") return;
      contentSteps++;
      if (contentSteps !== 2 || unlinked) return;
      // The hit read in the previous step is revoked while this one is read.
      unlinked = readHits[0];
      await ctx.db.notes.removeFromNotebook(ctx.notebookId, unlinked!);
    };

    try {
      const result = (await ctx.adapter.execute({
        operation: "search_notes",
        query: "needle"
      })) as { results: { noteId: string; title: string }[] };

      expect(unlinked).toBeTruthy();
      const titles = new Map([
        [first, "Alpha hit"],
        [second, "Beta hit"]
      ]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].noteId).not.toBe(unlinked);
      expect(result.results[0].title).toBe(
        titles.get(result.results[0].noteId)
      );
      expect(result.results.some((hit) => hit.title === titles.get(unlinked!))).toBe(
        false
      );
    } finally {
      content.collection.get = originalGet;
    }
  });

  it("never returns a search hit that was vaulted while a later hit was read", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const first = await ctx.db.notes.add({
      title: "Alpha hit",
      content: { type: "tiptap", data: "<p>needle alpha</p>" }
    });
    const second = await ctx.db.notes.add({
      title: "Beta hit",
      content: { type: "tiptap", data: "<p>needle beta</p>" }
    });
    await ctx.db.notes.addToNotebook(ctx.notebookId, first, second);
    await ctx.db.vault.create("vault-password");

    const content = ctx.db.content;
    const contentIds = await noteContentIds(ctx.db, [first, second]);
    const originalGet = content.collection.get.bind(content.collection);
    const readHits: string[] = [];
    content.collection.get = async (contentId: string) => {
      const noteId = contentIds.get(contentId);
      if (noteId) readHits.push(noteId);
      return originalGet(contentId);
    };
    let contentSteps = 0;
    let vaulted: string | undefined;
    ctx.adapter.onFenceStep = async (label) => {
      if (label !== "content") return;
      contentSteps++;
      if (contentSteps !== 2 || vaulted) return;
      vaulted = readHits[0];
      await ctx.db.vault.add(vaulted!);
    };

    try {
      const result = (await ctx.adapter.execute({
        operation: "search_notes",
        query: "needle"
      })) as { results: { noteId: string }[] };

      expect(vaulted).toBeTruthy();
      expect(result.results).toHaveLength(1);
      expect(result.results[0].noteId).not.toBe(vaulted);
    } finally {
      content.collection.get = originalGet;
    }
  });

  it("denies the body when the note becomes local-only during the seal", async () => {
    const ctx = await createHarness();
    harness = ctx;
    ctx.adapter.onFenceStep = async (label) => {
      if (label === "seal") await ctx.db.notes.localOnly(true, ctx.noteId);
    };

    await expectCode(
      ctx.adapter.execute({ operation: "get_note", noteId: ctx.noteId }),
      "NOT_AUTHORIZED"
    );
  });

  it("denies the body when the note leaves its granted notebook during the seal", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const noteInNotebook = await ctx.db.notes.add({
      title: "In notebook",
      content: { type: "tiptap", data: "<p>member body</p>" }
    });
    await ctx.db.notes.addToNotebook(ctx.notebookId, noteInNotebook);
    ctx.adapter.onFenceStep = async (label) => {
      if (label === "seal")
        await ctx.db.notes.removeFromNotebook(ctx.notebookId, noteInNotebook);
    };

    await expectCode(
      ctx.adapter.execute({
        operation: "get_note",
        noteId: noteInNotebook
      }),
      "NOT_AUTHORIZED"
    );
  });

  it("denies the body when the note is vaulted during the seal", async () => {
    const ctx = await createHarness();
    harness = ctx;
    await ctx.db.vault.create("vault-password");
    ctx.adapter.onFenceStep = async (label) => {
      if (label === "seal") await ctx.db.vault.add(ctx.noteId);
    };

    await expectCode(
      ctx.adapter.execute({ operation: "get_note", noteId: ctx.noteId }),
      "NOTE_LOCKED"
    );
  });

  it("does not list a Task that became local-only while the list was read", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const task = await ctx.db.tasks.create({
      title: "listed task",
      listId: ctx.listId
    });
    let flipped = false;
    ctx.adapter.onFenceStep = async (label) => {
      if (label !== "tasks" || flipped) return;
      flipped = true;
      await ctx.db.tasks.update(task.id, { localOnly: true });
    };

    const listed = (await ctx.adapter.execute({
      operation: "list_tasks"
    })) as { tasks: { taskId: string }[]; total: number };

    expect(flipped).toBe(true);
    expect(listed.tasks.some((entry) => entry.taskId === task.id)).toBe(false);
    expect(listed.total).toBe(0);
  });

  it("does not list a Task that became local-only during the seal", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const task = await ctx.db.tasks.create({
      title: "seal-listed task",
      listId: ctx.listId
    });
    // The seal is the operation's last asynchronous point. A flip that lands
    // there happens *after* dispatch returned, so a listing built during
    // dispatch would already carry the task's private title; the response must
    // be built from the post-seal state instead.
    ctx.adapter.onFenceStep = async (label) => {
      if (label === "seal")
        await ctx.db.tasks.update(task.id, { localOnly: true });
    };

    const listed = (await ctx.adapter.execute({
      operation: "list_tasks"
    })) as { tasks: { taskId: string; title: string }[]; total: number };

    expect(listed.tasks.some((entry) => entry.taskId === task.id)).toBe(false);
    expect(
      listed.tasks.some((entry) => entry.title === "seal-listed task")
    ).toBe(false);
    expect(listed.total).toBe(0);
  });

  it("does not adopt a grants generation installed while the account read was paused", async () => {
    const ctx = await createHarness();
    harness = ctx;
    const users = ctx.db.user;
    const originalGetUser = users.getUser.bind(users);
    const entered = gate();
    const hold = gate();
    let paused = false;
    users.getUser = async () => {
      if (!paused) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      return originalGetUser();
    };

    try {
      const pending = ctx.adapter.execute({ operation: "status" });
      await entered.promise;

      // A clear+regrant and an account A→B→A flip land while the operation's
      // first account read is suspended. The operation started under the old
      // grants/generation and must not be authorized by the new ones.
      ctx.adapter.clearGrants();
      await ctx.adapter.setGrants({ accountId: ctx.accountId, canRead: true });
      await signIn(ctx.db, "acct-2");
      await signIn(ctx.db, "acct-1");

      hold.open();
      await expectCode(pending, "GRANTS_CHANGED");
    } finally {
      users.getUser = originalGetUser;
    }
  });
});
