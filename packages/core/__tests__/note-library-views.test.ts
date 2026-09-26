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

import { expect, test } from "vitest";
import Database from "../src/api/index.js";
import { databaseTest, TEST_NOTE } from "./utils/index.js";

/**
 * The Library screen shows two note collections at the very top:
 *
 * - "All Notes" -> db.notes.all
 * - "Inbox"     -> db.notes.unassigned (active notes without a notebook)
 */

async function addNote(db: Database, title: string) {
  const id = await db.notes.add({ ...TEST_NOTE, title });
  if (!id) throw new Error(`Failed to add note "${title}".`);
  return id;
}

async function addNotebook(db: Database, title: string) {
  const id = await db.notebooks.add({ title });
  if (!id) throw new Error(`Failed to add notebook "${title}".`);
  return id;
}

async function titlesOf(selector: {
  items: () => Promise<{ title: string }[]>;
}) {
  return (await selector.items()).map((note) => note.title).sort();
}

test("all notes contains notes from every notebook and the inbox", () =>
  databaseTest().then(async (db) => {
    const notebookId = await addNotebook(db, "Work");
    const filed = await addNote(db, "filed");
    await addNote(db, "loose");
    await db.notes.addToNotebook(notebookId, filed);

    expect(await titlesOf(db.notes.all)).toEqual(["filed", "loose"]);
    expect(await db.notes.all.count()).toBe(2);
  }));

test("all notes excludes archived and trashed notes", () =>
  databaseTest().then(async (db) => {
    const kept = await addNote(db, "kept");
    const archived = await addNote(db, "archived");
    const trashed = await addNote(db, "trashed");

    await db.notes.archive(true, archived);
    await db.notes.moveToTrash(trashed);

    expect(await titlesOf(db.notes.all)).toEqual(["kept"]);
    expect(await db.notes.all.count()).toBe(1);
    expect(await db.notes.all.has(kept)).toBe(true);
  }));

test("inbox only contains notes without a notebook", () =>
  databaseTest().then(async (db) => {
    const notebookId = await addNotebook(db, "Work");
    const filed = await addNote(db, "filed");
    await addNote(db, "loose");
    await db.notes.addToNotebook(notebookId, filed);

    expect(await titlesOf(db.notes.unassigned)).toEqual(["loose"]);
    expect(await db.notes.unassigned.count()).toBe(1);
    expect(await db.notes.unassigned.has(filed)).toBe(false);
  }));

test("inbox count follows notebook assignment and removal", () =>
  databaseTest().then(async (db) => {
    const notebookId = await addNotebook(db, "Work");
    const id = await addNote(db, "note");

    expect(await db.notes.unassigned.count()).toBe(1);

    await db.notes.addToNotebook(notebookId, id);
    expect(await db.notes.unassigned.count()).toBe(0);

    await db.notes.removeFromNotebook(notebookId, id);
    expect(await db.notes.unassigned.count()).toBe(1);
    expect(await db.notes.all.count()).toBe(1);
  }));

test("inbox ignores deleted relations that still carry their references", () =>
  databaseTest().then(async (db) => {
    const notebookId = await addNotebook(db, "Work");
    const id = await addNote(db, "note");

    // A tombstone arriving from sync keeps fromId/toId populated, so the
    // `relations.deleted` flag is the only thing telling it apart from a live
    // membership.
    await db
      .sql()
      .insertInto("relations")
      .values({
        id: "deleted-relation",
        type: "relation",
        dateCreated: Date.now(),
        dateModified: Date.now(),
        fromId: notebookId,
        fromType: "notebook",
        toId: id,
        toType: "note",
        deleted: 1,
        synced: 1
      })
      .execute();

    expect(await db.notes.unassigned.count()).toBe(1);
    expect(await db.notes.unassigned.has(id)).toBe(true);
  }));

test("removing a note from a notebook puts it back in the inbox", () =>
  databaseTest().then(async (db) => {
    const notebookId = await addNotebook(db, "Work");
    const id = await addNote(db, "note");
    await db.notes.addToNotebook(notebookId, id);

    expect(await db.notes.unassigned.count()).toBe(0);

    await db.notes.removeFromNotebook(notebookId, id);

    expect(await db.notes.unassigned.count()).toBe(1);
    expect(await db.relations.from({ type: "notebook", id: notebookId }, "note").count()).toBe(0);
  }));

test("a note in a sub notebook is not in the inbox", () =>
  databaseTest().then(async (db) => {
    const rootId = await addNotebook(db, "Root");
    const childId = await addNotebook(db, "Child");
    await db.relations.add(
      { type: "notebook", id: rootId },
      { type: "notebook", id: childId }
    );

    const id = await addNote(db, "note");
    await db.notes.addToNotebook(childId, id);

    expect(await db.notes.unassigned.count()).toBe(0);
  }));

test("a note is back in the inbox once its only notebook is trashed", () =>
  databaseTest().then(async (db) => {
    const notebookId = await addNotebook(db, "Work");
    const id = await addNote(db, "note");
    await db.notes.addToNotebook(notebookId, id);

    expect(await db.notes.unassigned.count()).toBe(0);

    await db.notebooks.moveToTrash(notebookId);

    expect(await db.notes.unassigned.count()).toBe(1);
    expect(await db.notes.all.count()).toBe(1);
  }));

test("a note stays out of the inbox while any live notebook holds it", () =>
  databaseTest().then(async (db) => {
    const first = await addNotebook(db, "First");
    const second = await addNotebook(db, "Second");
    const id = await addNote(db, "note");
    await db.notes.addToNotebook(first, id);
    await db.notes.addToNotebook(second, id);

    await db.notes.removeFromNotebook(first, id);
    expect(await db.notes.unassigned.count()).toBe(0);

    await db.notes.removeFromNotebook(second, id);
    expect(await db.notes.unassigned.count()).toBe(1);
  }));

test("inbox excludes archived, trashed and restored notes like all notes does", () =>
  databaseTest().then(async (db) => {
    const id = await addNote(db, "note");
    expect(await db.notes.unassigned.count()).toBe(1);

    await db.notes.archive(true, id);
    expect(await db.notes.unassigned.count()).toBe(0);
    expect(await db.notes.all.count()).toBe(0);

    await db.notes.archive(false, id);
    expect(await db.notes.unassigned.count()).toBe(1);

    await db.notes.moveToTrash(id);
    expect(await db.notes.unassigned.count()).toBe(0);
    expect(await db.notes.all.count()).toBe(0);

    await db.trash.restore(id);
    expect(await db.notes.unassigned.count()).toBe(1);
    expect(await db.notes.all.count()).toBe(1);
  }));

test("a trashed note filed in a notebook does not resurface in the inbox", () =>
  databaseTest().then(async (db) => {
    const notebookId = await addNotebook(db, "Work");
    const id = await addNote(db, "note");
    await db.notes.addToNotebook(notebookId, id);

    await db.notes.moveToTrash(id);

    expect(await db.notes.unassigned.count()).toBe(0);
    expect(await db.notes.all.count()).toBe(0);
  }));

test("inbox is a subset of all notes", () =>
  databaseTest().then(async (db) => {
    const notebookId = await addNotebook(db, "Work");
    const filed = await addNote(db, "filed");
    await addNote(db, "loose one");
    await addNote(db, "loose two");
    await db.notes.addToNotebook(notebookId, filed);

    const all = await db.notes.all.ids();
    const inbox = await db.notes.unassigned.ids();

    expect(inbox).toHaveLength(2);
    expect(all).toHaveLength(3);
    expect(inbox.every((id) => all.includes(id))).toBe(true);
  }));
