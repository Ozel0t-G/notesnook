/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

import { expect, test, vi } from "vitest";

vi.mock("../src/interfaces/nncrypto", () => ({ NNCrypto: {} }));

import { NNStorage } from "../src/interfaces/storage";

test("web key-state rollback restores the prior key store value", async () => {
  let key: string | undefined = "original-key";
  const store = {
    getValue: vi.fn(async () => key),
    setValue: vi.fn(async (_name: string, value: string) => {
      key = value;
    }),
    deleteValue: vi.fn(async () => {
      key = undefined;
    })
  };
  const storage = new NNStorage(
    "rollback-test",
    () => store as never,
    "memory"
  );
  const snapshot = await storage.snapshotCryptoKeyState();

  key = "new-key";
  await storage.restoreCryptoKeyState(snapshot);
  expect(key).toBe("original-key");

  await storage.restoreCryptoKeyState(undefined);
  expect(key).toBeUndefined();
  expect(store.deleteValue).toHaveBeenCalledWith("userEncryptionKey");
});
