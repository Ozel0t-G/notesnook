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

import DB from "../../src/api/index.js";
import { NodeStorageInterface } from "../../__mocks__/node-storage.mock.js";
import { FS } from "../../__mocks__/fs.mock.js";
import Compressor from "../../__mocks__/compressor.mock.js";
import { EventSourcePolyfill as EventSource } from "event-source-polyfill";
import { randomBytes } from "../../src/utils/random.js";
import { SqliteDialect } from "@streetwriters/kysely";
import BetterSQLite3 from "better-sqlite3-multiple-ciphers";
import path from "path";
import { tmpdir } from "os";
import { getId } from "../../src/utils/id.js";
import { existsSync, mkdirSync } from "fs";
import * as betterTrigram from "sqlite-better-trigram";
import * as fts5Html from "sqlite3-fts5-html";
import { getLoadablePath } from "sqlite-regex";

const TEST_PASSWORD = "iamalongpassword";

export interface ConnectFixture {
  db: DB;
  path: string;
  close: () => Promise<void>;
}

export async function openConnectDb(dbPath?: string): Promise<ConnectFixture> {
  const dir = path.join(tmpdir(), "veyran-connect-tests");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = dbPath ?? path.join(dir, `connect-${getId()}.sql`);
  const betterSqliteDb = BetterSQLite3(file).unsafeMode(true);
  const db = new DB();
  db.setup({
    storage: new NodeStorageInterface(),
    eventsource: EventSource,
    fs: FS,
    compressor: async () => Compressor,
    maxNoteVersions: async () => 1000,
    sqliteOptions: {
      dialect: () => new SqliteDialect({ database: betterSqliteDb }),
      password: TEST_PASSWORD
    },
    batchSize: 500
  });
  betterTrigram.load(betterSqliteDb);
  fts5Html.load(betterSqliteDb);
  betterSqliteDb.loadExtension(getLoadablePath());
  await db.init();
  return {
    db,
    path: file,
    close: async () => {
      try {
        betterSqliteDb.close();
      } catch {
        // already closed
      }
    }
  };
}

/** Sign in a synthetic local account with a real stable id. No network. */
export async function signIn(
  db: DB,
  id: string,
  email = `${id}@example.com`
): Promise<string> {
  await db.kv().write("backendAffinity", {
    v: 1,
    ...db.user.backendAffinity.current(),
    recordedAt: Date.now()
  });
  const salt = randomBytes(16).toString("base64");
  await db.storage().deriveCryptoKey({ password: "password", salt });
  const key = await db.crypto().generateRandomKey();
  const attachmentsKey = await db
    .storage()
    .encrypt({ password: "password", salt }, JSON.stringify(key));
  await db.user.setUser({ id, email, salt, attachmentsKey });
  return id;
}

/**
 * Map each note's *current* content id to its note id.
 *
 * The adapter reads a note's body through the read-only `SQLCollection.get`
 * keyed by the note's own `contentId` (never the arbitrary, mutating
 * `findByNoteId`), so read instrumentation must key on the content id and map
 * it back to the note.
 */
export async function noteContentIds(
  db: DB,
  noteIds: readonly string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const noteId of noteIds) {
    const note = await db.notes.note(noteId);
    const contentId = (note as { contentId?: string } | undefined)?.contentId;
    if (typeof contentId === "string" && contentId) map.set(contentId, noteId);
  }
  return map;
}

export interface ConnectHarness extends ConnectFixture {
  adapter: import("../../src/connect/adapter.js").ConnectAdapter;
  accountId: string;
  notebookId: string;
  noteId: string;
  listId: string;
}

/** Build a fixture with grants covering one notebook, note and task list. */
export async function createHarness(options?: {
  dbPath?: string;
  maxJournalEntries?: number;
  instrumentation?: { onStep?: (label: string) => Promise<void> };
}): Promise<ConnectHarness> {
  const { ConnectAdapter } = await import("../../src/connect/adapter.js");
  const fixture = await openConnectDb(options?.dbPath);
  const accountId = await signIn(fixture.db, "acct-1");
  const notebookId = await fixture.db.notebooks.add({ title: "Notebook 1" });
  const noteId = await fixture.db.notes.add({
    title: "Note 1",
    content: { type: "tiptap", data: "<p>hello</p>" }
  });
  const listId = (await fixture.db.taskLists.create("List 1")).id;
  const adapter = new ConnectAdapter(fixture.db, {
    maxJournalEntries: options?.maxJournalEntries,
    instrumentation: options?.instrumentation
  });
  await adapter.setGrants({
    accountId,
    canCreate: true,
    canRead: true,
    canChange: true,
    canTask: true,
    notebookIDs: [notebookId],
    noteIDs: [noteId],
    listIDs: [listId]
  });
  return {
    ...fixture,
    adapter,
    accountId,
    notebookId,
    noteId,
    listId
  };
}
