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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomBytes } from "crypto";

vi.mock("../src/utils/http.js", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: Object.assign(vi.fn(), { json: vi.fn() }),
    delete: vi.fn()
  }
}));

import http from "../src/utils/http.js";
import { databaseTest, TEST_NOTE } from "./utils/index.js";
import UserManager from "../src/api/user-manager.js";
import type Database from "../src/api/index.js";
import type { User } from "../src/types.js";
import hosts, { setPersistedHostOverrides } from "../src/utils/constants.js";
import { EV } from "../src/common.js";
import { KEY_VERSION, SyncTransferItem } from "../src/api/sync/types.js";

const originalHosts = {
  api: hosts.API_HOST,
  auth: hosts.AUTH_HOST,
  sse: hosts.SSE_HOST
};
const VEYRAN = {
  api: "https://api.veyran.northcore.space",
  auth: "https://auth.veyran.northcore.space"
};
let remoteUser: User;
const email = "lifecycle@example.test";
const password = "lifecycle-test-password";
const token = {
  access_token: "veyran-test-access",
  refresh_token: "veyran-test-refresh",
  scope: "notesnook.sync offline_access IdentityServerApi",
  expires_in: 3600
};

beforeEach(() => {
  vi.clearAllMocks();
  hosts.API_HOST = VEYRAN.api;
  hosts.AUTH_HOST = VEYRAN.auth;
  hosts.SSE_HOST = "https://events.veyran.northcore.space";
  setPersistedHostOverrides(undefined);
  remoteUser = {
    id: "new-veyran-account",
    email,
    salt: randomBytes(16).toString("base64"),
    isEmailConfirmed: true,
    subscription: { plan: 0, status: 0, provider: 0 }
  } as unknown as User;
  vi.mocked(http.get).mockImplementation(async () => remoteUser);
  vi.mocked(http.post).mockImplementation(async (url, data) => {
    if (url.endsWith("/users")) return token;
    if (url.endsWith("/connect/token"))
      return data?.grant_type === "email"
        ? {
            access_token: "veyran-test-password-challenge",
            scope: "auth:grant_types:mfa_password"
          }
        : token;
  });
  vi.mocked(http.patch.json).mockImplementation(async (_url, partial) => {
    remoteUser = { ...remoteUser, ...partial };
  });
});

afterEach(() => {
  hosts.API_HOST = originalHosts.api;
  hosts.AUTH_HOST = originalHosts.auth;
  hosts.SSE_HOST = originalHosts.sse;
  setPersistedHostOverrides(undefined);
  EV.unsubscribeAll();
});

async function profile() {
  const db = await databaseTest("persistent");
  // Account transport is mocked. The real event listener remains installed,
  // but no live SSE socket is opened by these database/crypto tests.
  db.options.eventsource = undefined;
  return db;
}

async function collectedNote(db: Database) {
  const id = await db.notes.add({
    ...TEST_NOTE,
    title: "Account lifecycle Note"
  });
  const transfers: SyncTransferItem[] = [];
  for await (const transfer of db.syncer.sync.collector.collect(100, false))
    transfers.push(transfer);
  const noteTransfer = transfers.find((transfer) => transfer.type === "note");
  expect(noteTransfer?.items[0].id).toBe(id);
  expect(noteTransfer?.items[0].keyVersion).toBe(KEY_VERSION.DEK);
  return { id: id!, cipher: noteTransfer!.items[0] };
}

describe("VeyraN account lifecycle with SQLite and real encrypted keys", () => {
  test("registration creates a sync-encryptable Note and persisted session remains usable after reopening its account manager", async () => {
    const db = await profile();
    await db.user.signup(email, password);
    const { id, cipher } = await collectedNote(db);
    const persistedToken = await db.kv().read("token");
    const persistedDevice = await db.kv().read("deviceId");

    db.user = new UserManager(db);
    await db.user.init();
    await expect(db.user.assertAccountReady()).resolves.toMatchObject({
      user: { id: remoteUser.id, email, isEmailConfirmed: true }
    });
    expect(await db.kv().read("token")).toEqual(persistedToken);
    expect(await db.kv().read("deviceId")).toEqual(persistedDevice);
    expect((await db.notes.note(id))?.title).toBe("Account lifecycle Note");
    const keys = await db.user.getDataEncryptionKeys();
    const plain = await db.storage().decrypt(keys![0].key, cipher);
    expect(JSON.parse(plain)).toMatchObject({
      id,
      title: "Account lifecycle Note"
    });
    expect(await db.user.backendAffinity.check()).toMatchObject({
      status: "match",
      configured: VEYRAN
    });
  });

  test("logout and password-only re-login restore the exact remote keyset needed to decrypt a previously synced Note", async () => {
    const db = await profile();
    await db.user.signup(email, password);
    const { id, cipher } = await collectedNote(db);
    const wrappedKey = remoteUser.dataEncryptionKey;
    await db.withAccountDataWriteBarrier(async (assertUnchanged) => {
      await db.user.logout(true, undefined, {
        beforeClearLocalData: assertUnchanged
      });
    });
    expect(await db.user.getUser()).toBeUndefined();
    expect(await db.kv().read("token")).toBeUndefined();
    expect(await db.notes.exists(id)).toBe(false);

    await db.user.authenticateEmail(email);
    expect(db.user.getPendingAuthenticationStep()).toBe("password");
    await db.user.authenticatePassword(email, password);
    await expect(db.user.assertAccountReady()).resolves.toMatchObject({
      user: { email, dataEncryptionKey: wrappedKey }
    });
    const keys = await db.user.getDataEncryptionKeys();
    const plain = await db.storage().decrypt(keys![0].key, cipher);
    expect(JSON.parse(plain)).toMatchObject({
      id,
      title: "Account lifecycle Note"
    });
    const sentUrls = [
      ...vi.mocked(http.get).mock.calls,
      ...vi.mocked(http.post).mock.calls,
      ...vi.mocked(http.patch.json).mock.calls,
      ...vi.mocked(http.delete).mock.calls
    ].map(([url]) => url);
    expect(
      sentUrls.every(
        (url) => url.startsWith(VEYRAN.api) || url.startsWith(VEYRAN.auth)
      )
    ).toBe(true);
    expect(vi.mocked(http.patch.json)).toHaveBeenCalledOnce();
  });

  test("a real key-store failure restores empty local state and retries the already-created remote account", async () => {
    const db = await profile();
    const deriveKey = db.storage().deriveCryptoKey.bind(db.storage());
    vi.spyOn(db.storage(), "deriveCryptoKey").mockImplementationOnce(
      async (credentials) => {
        await deriveKey(credentials);
        throw new Error("native key-store acknowledgement lost");
      }
    );
    await expect(db.user.signup(email, password)).rejects.toThrow(
      "native key-store acknowledgement lost"
    );
    expect(await db.user.getUser()).toBeUndefined();
    expect(await db.storage().snapshotCryptoKeyState()).toBeUndefined();
    expect(await db.kv().read("token")).toBeUndefined();
    expect(await db.user.backendAffinity.check()).toMatchObject({
      status: "no-user"
    });

    await db.user.signup(email, password);
    await db.user.assertAccountReady();
    expect(
      vi.mocked(http.post).mock.calls.filter(([url]) => url.endsWith("/users"))
    ).toHaveLength(1);
    await collectedNote(db);
  });
});
