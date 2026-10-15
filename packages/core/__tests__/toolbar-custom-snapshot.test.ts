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

/**
 * Bounded core verification for the additive `ToolbarConfig.customPreset`
 * field (B3c). This is deliberately *storage* only: it proves the field
 * survives the real `settingitem` value serializer/parser, a settings cache
 * re-init (i.e. a genuine SQL read) and a real multi-item crypto round-trip.
 * It touches no production core settings/sync/migration code and needs no
 * authenticated user or network: `databaseTest()` is the existing in-memory
 * database and the crypto key is synthetic (`crypto().generateRandomKey()`).
 */

import { test, expect, describe } from "vitest";
import { databaseTest } from "./utils/index.ts";

type CustomPreset = {
  known: true;
  groups: (string | string[])[][];
};

type ToolbarConfig = {
  version: number;
  preset: string;
  config: (string | string[])[][];
  customPreset?: CustomPreset;
};

const NESTED_GROUPS: (string | string[])[][] = [
  ["bold"],
  ["headings", ["code", "subscript"]]
];

describe("toolbar customPreset snapshot persistence", () => {
  test("write -> SQL cache re-init -> read round-trips a nested customPreset deep-equally", async () => {
    await databaseTest().then(async (db) => {
      const config: ToolbarConfig = {
        version: 2,
        preset: "custom",
        config: NESTED_GROUPS,
        customPreset: { known: true, groups: NESTED_GROUPS }
      };

      await db.settings.setToolbarConfig("mobile", config);

      // Cache hit: not proof of persistence. Re-init rebuilds the settings
      // cache from the database, so the assertions below run against the value
      // the serializer wrote and the `settingitem` DataMapper parsed back.
      await db.settings.init();

      const stored = db.settings.getToolbarConfig("mobile");
      expect(stored).toEqual(config);
      expect(stored?.customPreset).toEqual({
        known: true,
        groups: [["bold"], ["headings", ["code", "subscript"]]]
      });
      // Nested subgroup survived as a real array, not a stringified blob.
      expect(stored?.customPreset?.groups[1][1]).toEqual(["code", "subscript"]);
    });
  });

  test("a legacy config without customPreset keeps its exact bytes and key order", async () => {
    await databaseTest().then(async (db) => {
      const legacy = { version: 2, preset: "minimal", config: [] };
      await db.settings.setToolbarConfig("tablet", legacy);

      await db.settings.init();
      const stored = db.settings.getToolbarConfig("tablet") as ToolbarConfig;

      // The additive field must never be injected when there is no known
      // custom: legacy payloads keep their exact JSON (order and all) so
      // backup/sync fixtures and exact-payload assertions stay stable.
      expect(JSON.stringify(stored)).toBe(JSON.stringify(legacy));
      expect(Object.keys(stored)).toEqual(["version", "preset", "config"]);
      expect("customPreset" in stored).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(stored, "customPreset")).toBe(
        false
      );
    });
  });

  test("an explicit empty custom snapshot survives the round-trip", async () => {
    await databaseTest().then(async (db) => {
      const config: ToolbarConfig = {
        version: 2,
        preset: "custom",
        config: [],
        customPreset: { known: true, groups: [] }
      };
      await db.settings.setToolbarConfig("smallTablet", config);

      await db.settings.init();
      const stored = db.settings.getToolbarConfig("smallTablet");
      expect(stored).toEqual(config);
      expect(stored?.customPreset).toEqual({ known: true, groups: [] });
    });
  });

  test("the serialized config survives a real encryptMulti/decryptMulti round-trip", async () => {
    await databaseTest().then(async (db) => {
      const config: ToolbarConfig = {
        version: 2,
        preset: "custom",
        config: NESTED_GROUPS,
        customPreset: { known: true, groups: NESTED_GROUPS }
      };

      // Synthetic key: no deriveCryptoKey, no user, no auth, no network.
      const key = await db.crypto().generateRandomKey();
      const items = [JSON.stringify(config)];
      const ciphers = await db.storage().encryptMulti(key, items);
      const decrypted = await db.storage().decryptMulti(key, ciphers);

      expect(decrypted).toEqual(items);
      expect(JSON.parse(decrypted[0])).toEqual(config);
      expect(JSON.parse(decrypted[0]).customPreset.groups[1][1]).toEqual([
        "code",
        "subscript"
      ]);
    });
  });
});
