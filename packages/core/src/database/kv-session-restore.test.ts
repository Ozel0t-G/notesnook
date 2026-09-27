/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

import { expect, test } from "vitest";
import { KVStorage } from "./kv.js";

test("a fault during session restore commits none of the staged KV writes", async () => {
  let records = new Map<string, string>([
    ["user", JSON.stringify({ id: "original" })],
    ["lastSynced", "812"]
  ]);
  const database = {
    transaction: () => ({
      execute: async (run: (tx: unknown) => Promise<void>) => {
        const staged = new Map(records);
        const tx = {
          deleteFrom: () => ({
            where: (_field: string, _op: string, key: string) => ({
              execute: async () => void staged.delete(key)
            })
          }),
          replaceInto: () => ({
            values: ({ key, value }: { key: string; value: string }) => ({
              execute: async () => void staged.set(key, value)
            })
          })
        };
        await run(tx);
        records = staged;
      }
    })
  };
  const kv = new KVStorage(Promise.resolve(database) as never);
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  await expect(
    kv.restoreSessionState({
      user: { id: "replacement" } as never,
      lastSynced: 0,
      backendAffinity: circular as never
    })
  ).rejects.toThrow();

  expect(JSON.parse(records.get("user") || "null")).toEqual({ id: "original" });
  expect(records.get("lastSynced")).toBe("812");
  expect(records.has("backendAffinity")).toBe(false);
});
