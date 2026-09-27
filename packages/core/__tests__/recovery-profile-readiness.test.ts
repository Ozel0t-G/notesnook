import { describe, expect, test } from "vitest";
import { databaseTest } from "./utils/index.js";

describe("recovery on an initialized empty profile", () => {
  test("has collections ready and no account encryption key or local account data", async () => {
    const db = await databaseTest();
    const recovery = db.user as unknown as {
      hasLocalAccountData(): Promise<boolean>;
    };

    expect(await db.storage().snapshotCryptoKeyState()).toBeUndefined();
    expect(await recovery.hasLocalAccountData()).toBe(false);
  });
});
