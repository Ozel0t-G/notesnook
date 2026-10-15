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

import { describe, it, expect, afterEach, vi } from "vitest";
import { expectCode } from "./helpers.js";
import { createHarness, ConnectHarness, openConnectDb, signIn } from "./fixtures.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

describe("VeyraN Connect grants and fence", () => {
  it("denies every operation with no signed-in account", async () => {
    const fixture = await openConnectDb();
    try {
      const { ConnectAdapter } = await import("../../src/connect/adapter.js");
      const adapter = new ConnectAdapter(fixture.db);
      await expectCode(adapter.execute({ operation: "status" }), "DENIED");
      adapter.close();
    } finally {
      await fixture.close();
    }
  });

  it("denies when the account row disappears (no local fallback)", async () => {
    harness = await createHarness();
    await harness.db.kv().write("user", undefined);
    await expectCode(
      harness.adapter.execute({ operation: "status" }),
      "DENIED"
    );
  });

  it("snapshots grants so later array mutation cannot widen rights", async () => {
    harness = await createHarness();
    const foreign = await harness.db.notes.add({
      title: "Foreign",
      content: { type: "tiptap", data: "<p>secret</p>" }
    });
    const noteIds = [harness.noteId];
    await harness.adapter.setGrants({
      accountId: harness.accountId,
      canRead: true,
      noteIDs: noteIds
    });
    noteIds.push(foreign);
    await expectCode(
      harness.adapter.execute({ operation: "get_note", noteId: foreign }),
      "NOT_AUTHORIZED"
    );
  });

  it("increments the grants generation on every setGrants", async () => {
    harness = await createHarness();
    const g1 = await harness.adapter.setGrants({
      accountId: harness.accountId,
      canRead: true
    });
    const g2 = await harness.adapter.setGrants({
      accountId: harness.accountId,
      canRead: true
    });
    expect(g2).toBe(g1 + 1);
  });

  it("denies while locked/closed and after migration requirement", async () => {
    harness = await createHarness();
    harness.adapter.lock();
    // `status` is callable while locked and reports a truthful blocked state
    // (no content, no ids) instead of throwing `ADAPTER_LOCKED`.
    const blocked = (await harness.adapter.execute({
      operation: "status"
    })) as {
      version: number;
      status: string;
      available: boolean;
    };
    expect(blocked.version).toBe(1);
    expect(blocked.status).toBe("locked");
    expect(blocked.available).toBe(false);
    harness.adapter.unlock();
    await expect(
      harness.adapter.execute({ operation: "status" })
    ).resolves.toBeTruthy();

    const spy = vi
      .spyOn(harness.db.migrations, "required")
      .mockReturnValue(true);
    await expectCode(
      harness.adapter.execute({ operation: "status" }),
      "MIGRATION_IN_PROGRESS"
    );
    spy.mockRestore();

    harness.adapter.close();
    await expectCode(
      harness.adapter.execute({ operation: "status" }),
      "ADAPTER_CLOSED"
    );
  });

  it("returns no content when the account switches during a paused read", async () => {
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          if (label === "note") await signIn(harness!.db, "acct-2");
        }
      }
    });
    await expectCode(
      harness.adapter.execute({
        operation: "get_note",
        noteId: harness.noteId
      }),
      "SESSION_CHANGED"
    );
  });

  it("returns no content when grants are revoked during a paused read", async () => {
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          if (label === "note") harness!.adapter.clearGrants();
        }
      }
    });
    await expectCode(
      harness.adapter.execute({
        operation: "get_note",
        noteId: harness.noteId
      }),
      "GRANTS_CHANGED"
    );
  });

  it("returns no content when the adapter is locked during a paused read", async () => {
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          if (label === "note") harness!.adapter.lock();
        }
      }
    });
    await expectCode(
      harness.adapter.execute({
        operation: "get_note",
        noteId: harness.noteId
      }),
      "ADAPTER_LOCKED"
    );
  });

  it("never leaks foreign notebooks/notes/lists", async () => {
    harness = await createHarness();
    const otherNotebook = await harness.db.notebooks.add({ title: "Other" });
    const foreignNote = await harness.db.notes.add({
      title: "Foreign",
      content: { type: "tiptap", data: "<p>secret</p>" }
    });
    const otherList = await harness.db.taskLists.create("Other list");

    const notebooks = (await harness.adapter.execute({
      operation: "list_notebooks"
    })) as { notebooks: { id: string }[] };
    expect(notebooks.notebooks.map((n) => n.id)).toEqual([harness.notebookId]);

    const search = (await harness.adapter.execute({
      operation: "search_notes",
      query: "secret"
    })) as { results: { noteId: string }[] };
    expect(search.results.some((r) => r.noteId === foreignNote)).toBe(false);

    await expectCode(
      harness.adapter.execute({ operation: "get_note", noteId: foreignNote }),
      "NOT_AUTHORIZED"
    );

    await expectCode(
      harness.adapter.execute({
        operation: "create_note",
        operationId: "op-foreign-nb",
        notebookId: otherNotebook,
        content: "hi"
      }),
      "NOT_AUTHORIZED"
    );

    await expectCode(
      harness.adapter.execute({
        operation: "create_task",
        operationId: "op-foreign-list",
        listId: otherList.id,
        title: "nope"
      }),
      "NOT_AUTHORIZED"
    );
  });

  it("authorizes notes that belong to a granted notebook", async () => {
    harness = await createHarness();
    const noteInNotebook = await harness.db.notes.add({
      title: "In notebook",
      content: { type: "tiptap", data: "<p>member</p>" }
    });
    await harness.db.notes.addToNotebook(harness.notebookId, noteInNotebook);
    const result = (await harness.adapter.execute({
      operation: "get_note",
      noteId: noteInNotebook
    })) as { noteId: string };
    expect(result.noteId).toBe(noteInNotebook);
  });

  it("never returns locked (vaulted) content on read", async () => {
    harness = await createHarness();
    await harness.db
      .sql()
      .updateTable("content")
      .set({ locked: true, data: JSON.stringify({ cipher: "x", iv: "y" }) })
      .where("noteId", "=", harness.noteId)
      .execute();
    await expectCode(
      harness.adapter.execute({ operation: "get_note", noteId: harness.noteId }),
      "NOTE_LOCKED"
    );
  });
});
