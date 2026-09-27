import { describe, expect, test } from "vitest";
import { databaseTest } from "./utils/index.js";

describe("recovery on an initialized empty profile", () => {
  async function profile() {
    const db = await databaseTest();
    return { db, affinity: db.user.backendAffinity };
  }

  test("has collections ready and no account encryption key or local account data", async () => {
    const { db, affinity } = await profile();

    expect(await db.storage().snapshotCryptoKeyState()).toBeUndefined();
    expect(await affinity.hasLocalAccountData()).toBe(false);
    expect((await affinity.check()).status).toBe("no-user");
  });

  test("a trashed-only note remains protected", async () => {
    const { db, affinity } = await profile();
    await db
      .sql()
      .insertInto("notes")
      .values({ id: "trashed-note", type: "trash", deleted: true })
      .execute();
    expect(await db.notes.collection.count()).toBe(0);
    expect(await affinity.hasLocalAccountData()).toBe(true);
    expect((await affinity.check()).status).toBe("unknown");
  });

  test("a deleted Task tombstone in settings remains protected", async () => {
    const { db, affinity } = await profile();
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
    expect(await affinity.hasLocalAccountData()).toBe(true);
    expect((await affinity.check()).status).toBe("unknown");
  });

  test("a settings-only profile remains protected", async () => {
    const { db, affinity } = await profile();
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
    expect(await affinity.hasLocalAccountData()).toBe(true);
    expect((await affinity.check()).status).toBe("unknown");
  });

  test("legacy storage settings remain protected", async () => {
    const { db, affinity } = await profile();
    await db
      .storage()
      .write("settings", { id: "legacy-settings", type: "settings" });
    expect(await affinity.hasLocalAccountData()).toBe(true);
    expect((await affinity.check()).status).toBe("unknown");
  });
});
