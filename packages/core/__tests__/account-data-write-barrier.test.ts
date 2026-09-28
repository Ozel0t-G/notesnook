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
import { describe, expect, test, vi } from "vitest";
import { sql } from "@streetwriters/kysely";
import { databaseTest } from "./utils/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("exclusive account data during sign out", () => {
  test("allows backup reads and auth markers, but fences collection and raw writes", async () => {
    const db = await databaseTest();
    await db
      .sql()
      .insertInto("notes")
      .values({ id: "existing", title: "Saved" })
      .execute();
    const preparedBeforeFreeze = db
      .sql()
      .updateTable("notes")
      .set({ title: "Unsaved" })
      .where("id", "=", "existing");

    await db.withAccountDataWriteBarrier(async (assertUnchanged) => {
      expect(
        await db.sql().selectFrom("notes").select("title").executeTakeFirst()
      ).toEqual({ title: "Saved" });
      expect(
        (await sql`SELECT title FROM notes`.execute(db.sql())).rows
      ).toEqual([{ title: "Saved" }]);
      await db.kv().write("deviceId", "cleanup-device");
      await db.kv().delete("deviceId");
      await db.config().setItem("barrier-test", "allowed");
      await db.config().removeItem("barrier-test");
      assertUnchanged();

      await expect(preparedBeforeFreeze.execute()).rejects.toThrow(
        "Account data changed"
      );
      await expect(db.notes.add({ title: "Late edit" })).rejects.toThrow(
        "Account data changed"
      );
      await expect(db.sql().deleteFrom("notes").execute()).rejects.toThrow(
        "Account data changed"
      );
      await expect(
        sql
          .raw("INSERT INTO notes (id, title) VALUES ('raw', 'Late')")
          .execute(db.sql())
      ).rejects.toThrow("Account data changed");
      await expect(
        sql.raw("DROP TABLE notes").execute(db.sql())
      ).rejects.toThrow("Account data changed");
      await expect(
        sql.raw("SELECT 1; DELETE FROM notes").execute(db.sql())
      ).rejects.toThrow("Account data changed");
      expect(() => assertUnchanged()).toThrow("Account data changed");
    });

    expect(
      await db.sql().selectFrom("notes").select(["id", "title"]).execute()
    ).toEqual([{ id: "existing", title: "Saved" }]);
    await db
      .sql()
      .updateTable("notes")
      .set({ title: "After cancellation" })
      .execute();
    expect(
      await db.sql().selectFrom("notes").select("title").executeTakeFirst()
    ).toEqual({ title: "After cancellation" });
  });

  test("drains a previously admitted transaction through commit before backup", async () => {
    const db = await databaseTest();
    const wrote = deferred();
    const finish = deferred();
    const transaction = db
      .sql()
      .transaction()
      .execute(async (tx) => {
        await tx
          .insertInto("notes")
          .values({ id: "in-flight", title: "Committed before backup" })
          .execute();
        wrote.resolve();
        await finish.promise;
      });
    await wrote.promise;
    let backupStarted = false;
    const backup = db.withAccountDataWriteBarrier(async (assertUnchanged) => {
      backupStarted = true;
      assertUnchanged();
      return await db
        .sql()
        .selectFrom("notes")
        .select("title")
        .executeTakeFirst();
    });
    await Promise.resolve();
    expect(backupStarted).toBe(false);
    finish.resolve();
    await transaction;
    await expect(backup).resolves.toEqual({ title: "Committed before backup" });
  });

  test("an existing transaction cannot add another write after freeze", async () => {
    const db = await databaseTest();
    const wrote = deferred();
    const finish = deferred();
    const transaction = db
      .sql()
      .transaction()
      .execute(async (tx) => {
        await tx
          .insertInto("notes")
          .values({ id: "rolled-back", title: "First" })
          .execute();
        wrote.resolve();
        await finish.promise;
        await tx
          .insertInto("notes")
          .values({ id: "late", title: "Second" })
          .execute();
      });
    await wrote.promise;
    const backup = db.withAccountDataWriteBarrier(async () => {
      throw new Error("Backup must not start after a conflicting write.");
    });
    const transactionFailure = expect(transaction).rejects.toThrow(
      "Account data changed"
    );
    const backupFailure = expect(backup).rejects.toThrow(
      "Account data changed"
    );
    finish.resolve();
    await transactionFailure;
    await backupFailure;
    expect(await db.sql().selectFrom("notes").select("id").execute()).toEqual(
      []
    );
  });

  test("a queued compiled write cannot slip into the next profile after the fence ends", async () => {
    const db = await databaseTest();
    const compiled = db
      .sql()
      .insertInto("notes")
      .values({ id: "stale-save", title: "Previous profile" })
      .compile();
    const locked = deferred();
    const release = deferred();
    const connection = db
      .sql()
      .connection()
      .execute(async (sqlConnection) => {
        await sql`SELECT 1`.execute(sqlConnection);
        locked.resolve();
        await release.promise;
      });
    await locked.promise;
    let failedWrite!: Promise<void>;
    await db.withAccountDataWriteBarrier(async (assertUnchanged) => {
      failedWrite = expect(db.sql().executeQuery(compiled)).rejects.toThrow(
        "Account data changed"
      );
      // Let the execution request reach the occupied driver mutex.
      await Promise.resolve();
      await Promise.resolve();
      assertUnchanged();
    });
    release.resolve();
    await connection;
    await failedWrite;
    expect(await db.sql().selectFrom("notes").select("id").execute()).toEqual(
      []
    );
  });

  test("ordinary and captured handles stay fenced throughout awaited reset", async () => {
    const db = await databaseTest();
    await db
      .sql()
      .insertInto("notes")
      .values({ id: "backed-up", title: "Saved" })
      .execute();
    const captured = db.sql();
    const clearing = deferred();
    const resume = deferred();
    const storage = db.storage();
    const originalClear = storage.clear.bind(storage);
    vi.spyOn(storage, "clear").mockImplementationOnce(async () => {
      clearing.resolve();
      await resume.promise;
      await originalClear();
    });
    const reset = db.withAccountDataWriteBarrier(async (assertUnchanged) => {
      assertUnchanged();
      await db.reset();
      expect(() => assertUnchanged()).toThrow("Account data changed");
    });
    await clearing.promise;
    await expect(
      captured
        .insertInto("notes")
        .values({ id: "late", title: "Never inserted" })
        .execute()
    ).rejects.toThrow("Account data changed");
    await expect(
      sql.raw("UPDATE notes SET title = 'Never changed'").execute(captured)
    ).rejects.toThrow("Account data changed");
    resume.resolve();
    await reset;
    expect(await captured.selectFrom("notes").select("id").execute()).toEqual(
      []
    );
    await captured
      .insertInto("notes")
      .values({ id: "new-profile", title: "Usable after sign out" })
      .execute();
    expect(await captured.selectFrom("notes").select("id").execute()).toEqual([
      { id: "new-profile" }
    ]);
  });
});
