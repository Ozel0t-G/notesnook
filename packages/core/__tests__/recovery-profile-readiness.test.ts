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
        key: "defaultNotebook",
        value: "some-notebook"
      })
      .execute();
    expect(await affinity.hasLocalAccountData()).toBe(true);
    expect((await affinity.check()).status).toBe("unknown");
  });

  /**
   * The app writes these rows itself on every fresh profile. Counting them as
   * account data blocked sign-in after every fresh install or local-data wipe.
   */
  test("settings the app writes by default are not account data", async () => {
    const { db, affinity } = await profile();
    await db
      .sql()
      .insertInto("settings")
      .values({
        id: "default-date-format",
        type: "settingitem",
        key: "dateFormat",
        value: "MM/DD/YYYY"
      })
      .execute();
    await db
      .sql()
      .insertInto("settings")
      .values({
        id: "default-time-format",
        type: "settingitem",
        key: "timeFormat",
        value: "12-hour"
      })
      .execute();
    await db
      .sql()
      .insertInto("settings")
      .values({
        id: "default-title-format",
        type: "settingitem",
        key: "titleFormat",
        value: "$headline$"
      })
      .execute();
    expect(await affinity.hasLocalAccountData()).toBe(false);
    expect((await affinity.check()).status).toBe("no-user");
  });

  test("legacy storage settings remain protected", async () => {
    const { db, affinity } = await profile();
    await db
      .storage()
      .write("settings", { id: "legacy-settings", type: "settings" });
    expect(await affinity.hasLocalAccountData()).toBe(true);
    expect((await affinity.check()).status).toBe("unknown");
  });

  /**
   * The complete set of rows `resetFeatures()` persists on a fresh Web profile
   * before anyone signs in: the feature-gated defaults for the toolbar preset,
   * trash cleanup interval, default notebook and default tag, on top of the
   * date/time/title formats above. Their presence alone previously made every
   * fresh profile look like an orphaned account, blocking the first email step.
   */
  test("resetFeatures startup settings are not account data", async () => {
    const { db, affinity } = await profile();
    const rows = [
      {
        id: "startup-toolbar",
        type: "settingitem",
        key: "toolbarConfig:desktop",
        value: JSON.stringify({
          version: 3,
          preset: "default",
          config: [{ id: "bold" }]
        })
      },
      {
        id: "startup-trash",
        type: "settingitem",
        key: "trashCleanupInterval",
        value: "7"
      },
      {
        id: "startup-notebook",
        type: "settingitem",
        key: "defaultNotebook",
        value: null
      },
      { id: "startup-tag", type: "settingitem", key: "defaultTag", value: null }
    ];
    for (const row of rows)
      await db.sql().insertInto("settings").values(row).execute();

    expect(await affinity.hasLocalAccountRecords()).toBe(false);
    expect(await affinity.hasLocalAccountData()).toBe(false);
    expect((await affinity.check()).status).toBe("no-user");
  });

  test.each([
    [
      "a non-empty default notebook",
      {
        id: "saved-notebook",
        type: "settingitem",
        key: "defaultNotebook",
        value: "some-notebook"
      }
    ],
    [
      "a non-default trash cleanup interval",
      {
        id: "saved-trash",
        type: "settingitem",
        key: "trashCleanupInterval",
        value: "30"
      }
    ],
    [
      "a customized toolbar preset",
      {
        id: "saved-toolbar",
        type: "settingitem",
        key: "toolbarConfig:desktop",
        value: JSON.stringify({ version: 3, preset: "custom", config: [] })
      }
    ],
    // `resetFeatures()` only auto-writes `toolbarConfig:desktop`; a `default`
    // preset on any other platform is a real user choice or imported account
    // data and must survive a profile-recovery check.
    [
      "a default toolbar preset on another platform",
      {
        id: "saved-mobile-toolbar",
        type: "settingitem",
        key: "toolbarConfig:mobile",
        value: JSON.stringify({ version: 3, preset: "default", config: [] })
      }
    ],
    [
      "a default toolbar preset on a second non-desktop platform",
      {
        id: "saved-tablet-toolbar",
        type: "settingitem",
        key: "toolbarConfig:smallTablet",
        value: JSON.stringify({ version: 3, preset: "default", config: [] })
      }
    ],
    [
      "a desktop toolbar preset whose config is not a tools array",
      {
        id: "saved-desktop-toolbar",
        type: "settingitem",
        key: "toolbarConfig:desktop",
        value: JSON.stringify({
          version: 3,
          preset: "default",
          config: { preset: "default" }
        })
      }
    ]
  ])(
    "a non-default value in %s remains protected",
    async (_label, row) => {
      const { db, affinity } = await profile();
      await db.sql().insertInto("settings").values(row).execute();
      expect(await affinity.hasLocalAccountData()).toBe(true);
      expect((await affinity.check()).status).toBe("unknown");
    }
  );

  // A tombstone records something the user had, even when it names a key the
  // app otherwise writes by itself.
  test("a tombstone on a startup-default key remains protected", async () => {
    const { db, affinity } = await profile();
    await db
      .sql()
      .insertInto("settings")
      .values({
        id: "deleted-title-format",
        type: "settingitem",
        key: "titleFormat",
        value: "Note $date$",
        deleted: true
      })
      .execute();
    expect(await affinity.hasLocalAccountData()).toBe(true);
    expect((await affinity.check()).status).toBe("unknown");
  });
});
