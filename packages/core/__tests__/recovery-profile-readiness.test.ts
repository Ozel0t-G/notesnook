import { describe, expect, test } from "vitest";
import { databaseTest } from "./utils/index.js";

describe("recovery on an initialized empty profile", () => {
  async function profile() {
    const db = await databaseTest();
    const recovery = db.user as unknown as {
      hasLocalAccountData(): Promise<boolean>;
    };
    return { db, recovery };
  }

  test("has collections ready and no account encryption key or local account data", async () => {
    const { db, recovery } = await profile();

    expect(await db.storage().snapshotCryptoKeyState()).toBeUndefined();
    expect(await recovery.hasLocalAccountData()).toBe(false);
  });

  test("a trashed-only note remains protected", async () => {
    const { db, recovery } = await profile();
    await db
      .sql()
      .insertInto("notes")
      .values({ id: "trashed-note", type: "trash", deleted: true })
      .execute();
    expect(await db.notes.collection.count()).toBe(0);
    expect(await recovery.hasLocalAccountData()).toBe(true);
  });

  test("a deleted Task tombstone in settings remains protected", async () => {
    const { db, recovery } = await profile();
    await db
      .sql()
      .insertInto("settings")
      .values({
        id: "deleted-task",
        type: "settingitem",
        key: "appleTasks:v1:task:deleted-task",
        deleted: true
      })
      .execute();
    expect(db.tasks.listSync()).toEqual([]);
    expect(await recovery.hasLocalAccountData()).toBe(true);
  });

  test("a settings-only profile remains protected", async () => {
    const { db, recovery } = await profile();
    await db
      .sql()
      .insertInto("settings")
      .values({
        id: "saved-setting",
        type: "settingitem",
        key: "timeFormat",
        value: "24-hour"
      })
      .execute();
    expect(await recovery.hasLocalAccountData()).toBe(true);
  });

  test("legacy storage settings remain protected", async () => {
    const { db, recovery } = await profile();
    await db
      .storage()
      .write("settings", { id: "legacy-settings", type: "settings" });
    expect(await recovery.hasLocalAccountData()).toBe(true);
  });
});
