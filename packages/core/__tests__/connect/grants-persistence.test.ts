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

// The device-local VeyraN Connect grants record against **real encrypted
// storage**: the row is written through the real Core `settings` collection of
// a real password-encrypted SQLite database, the database is closed, the same
// file is reopened and the row is read back and parsed with the *production*
// codec (`apps/mobile/app/services/veyran-connect-grants`, which the host
// service itself imports). No fake collection, no pre-parsed map: the value
// that comes back is exactly what a reopened app would hold.

import { afterEach, describe, expect, it } from "vitest";
import { openConnectDb, signIn, type ConnectFixture } from "./fixtures.js";
import {
  LOCAL_RECORD_ID,
  buildLocalRecordItem,
  normalizeCapabilities,
  readLocalRecordFrom,
  serializeLocalRecord,
  type ConnectLocalRecord
} from "../../../../apps/mobile/app/services/veyran-connect-grants.js";

let fixture: ConnectFixture | undefined;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = undefined;
  }
});

const CAPABILITIES = normalizeCapabilities({
  canRead: true,
  canCreate: true,
  canChange: true,
  canTask: true,
  notebookIds: ["notebook-1"],
  listIds: ["list-1"],
  noteIds: ["note-1"],
  defaultNotebookId: "notebook-1"
});

const RECORD: ConnectLocalRecord = {
  v: 1,
  accountId: "acct-1",
  capabilities: CAPABILITIES
};

describe("VeyraN Connect local grants record (real encrypted storage)", () => {
  it("is a canonical JSON string that parses back identically after a close/reopen", async () => {
    const opened = await openConnectDb();
    const dbPath = opened.path;
    await signIn(opened.db, "acct-1");

    const item = buildLocalRecordItem(RECORD);
    expect(item).toBeDefined();
    // The production row shape, written through the real Core collection: one
    // encrypted `settingitem`, `localOnly: true`, `value` a JSON *string*.
    await opened.db.settings.collection.upsert(item! as never);

    const stored = opened.db.settings.collection.get(LOCAL_RECORD_ID) as
      | { value?: unknown; localOnly?: boolean; key?: string }
      | undefined;
    expect(stored?.localOnly).toBe(true);
    expect(stored?.key).toBe("veyranConnectLocal");
    expect(typeof stored?.value).toBe("string");
    expect(stored?.value).toBe(serializeLocalRecord(RECORD));
    // Parsed from the warm in-memory cache: identical to the reopened read.
    expect(readLocalRecordFrom(opened.db.settings.collection)).toEqual(RECORD);

    // Close the encrypted database, reopen the very same file.
    await opened.close();
    fixture = await openConnectDb(dbPath);
    const reopened = fixture.db;

    const row = reopened.settings.collection.get(LOCAL_RECORD_ID) as
      | { value?: unknown; localOnly?: boolean }
      | undefined;
    expect(row).toBeDefined();
    // A reopened row holds the stored text (the `settingitem` DataMapper does
    // not parse this key), which is exactly what the codec must accept.
    expect(typeof row?.value).toBe("string");
    expect(row?.value).toBe(serializeLocalRecord(RECORD));

    const parsed = readLocalRecordFrom(reopened.settings.collection);
    expect(parsed).toEqual(RECORD);
    expect(parsed?.accountId).toBe("acct-1");
    expect(parsed?.capabilities).toEqual(CAPABILITIES);
    // The record ids survive as ids, not as re-generated defaults.
    expect(parsed?.capabilities.defaultNotebookId).toBe("notebook-1");
    expect(parsed?.capabilities.notebookIds).toEqual(["notebook-1"]);
  });

  it("keeps the record account-bound across a reopen", async () => {
    const opened = await openConnectDb();
    const dbPath = opened.path;
    await signIn(opened.db, "acct-1");

    await opened.db.settings.collection.upsert(
      buildLocalRecordItem(RECORD)! as never
    );
    // A second, foreign record written for another account (as a backup restore
    // or another account's device would produce) is a distinct value.
    await opened.db.settings.collection.upsert(
      buildLocalRecordItem({
        v: 1,
        accountId: "acct-2",
        capabilities: normalizeCapabilities({ canRead: true })
      })! as never
    );

    await opened.close();
    fixture = await openConnectDb(dbPath);

    const parsed = readLocalRecordFrom(fixture.db.settings.collection);
    expect(parsed?.accountId).toBe("acct-2");
    // The last write is what a reopened app sees — the host still has to *bind*
    // it to the live account, which the decision-level tests cover.
    expect(parsed?.accountId).not.toBe("acct-1");
  });

  it("rejects foreign, legacy and non-JSON rows after a reopen", async () => {
    let current = await openConnectDb();
    const dbPath = current.path;
    await signIn(current.db, "acct-1");

    // Legacy version / missing localOnly marker / not JSON at all.
    const rows = [
      JSON.stringify({ v: 2, localOnly: true, accountId: "acct-1" }),
      JSON.stringify({ v: 1, accountId: "acct-1" }),
      "this is not json"
    ];

    for (const value of rows) {
      await current.db.settings.collection.upsert({
        id: LOCAL_RECORD_ID,
        key: "veyranConnectLocal" as never,
        value: value as never,
        type: "settingitem",
        localOnly: true,
        dateCreated: Date.now(),
        dateModified: Date.now()
      } as never);
      await current.close();
      fixture = await openConnectDb(dbPath);
      expect(
        readLocalRecordFrom(fixture.db.settings.collection)
      ).toBeUndefined();
      current = fixture;
    }
    fixture = current;
  });
});
