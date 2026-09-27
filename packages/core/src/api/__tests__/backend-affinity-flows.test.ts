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

import {
  test,
  describe,
  expect,
  beforeEach,
  afterEach,
  vi,
  Mock
} from "vitest";

// Must be mocked before UserManager is imported so it binds the mock.
vi.mock("../../utils/http.js", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: Object.assign(vi.fn(), { json: vi.fn() }),
    delete: vi.fn()
  }
}));

import http from "../../utils/http.js";
import hosts, { setPersistedHostOverrides } from "../../utils/constants.js";
import UserManager from "../user-manager.js";
import { SyncDevices } from "../sync/devices.js";
import { StoredAffinity } from "../backend-affinity.js";
import { EVENTS, EV } from "../../common.js";
import EventManager from "../../utils/event-manager.js";
import type Database from "../index.js";
import type { User } from "../../types.js";

const VEYRAN = {
  api: "https://api.veyran.northcore.space",
  auth: "https://auth.veyran.northcore.space"
};
const NOTESNOOK = {
  api: "https://api.notesnook.com",
  auth: "https://auth.streetwriters.co"
};

const mockGet = http.get as unknown as Mock;
const mockPost = http.post as unknown as Mock;

function affinityRecord(api: string, auth: string): StoredAffinity {
  return { v: 1, api, auth, recordedAt: 1 };
}

function serverUser(id = "u1"): User {
  return {
    id,
    email: "someone@example.test",
    salt: "server-supplied-salt",
    isEmailConfirmed: true,
    subscription: { plan: 0, status: 0, provider: 0 }
  } as unknown as User;
}

/**
 * A UserManager wired to an in-memory database. This exercises the real
 * signup/login/logout code paths rather than the affinity helper alone, which is
 * where the relabelling and destructive-reset defects lived.
 */
function harness(options: {
  storedUser?: User;
  affinity?: StoredAffinity;
  token?: Record<string, unknown>;
  lastSynced?: number;
  deviceId?: string;
}) {
  const kv = new Map<string, unknown>();
  if (options.storedUser) kv.set("user", options.storedUser);
  if (options.affinity) kv.set("backendAffinity", options.affinity);
  if (options.token) kv.set("token", options.token);
  if (options.lastSynced !== undefined)
    kv.set("lastSynced", options.lastSynced);
  if (options.deviceId) kv.set("deviceId", options.deviceId);

  const reset = vi.fn(async () => true);
  const setLastSynced = vi.fn(async (value: number) => {
    kv.set("lastSynced", value);
  });
  const deriveCryptoKey = vi.fn(async () => undefined);
  const unregister = vi.fn(async () => void kv.delete("deviceId"));
  const register = vi.fn(async () => void kv.set("deviceId", "new-device"));

  const kvAccessor = () => ({
    read: async (key: string) => kv.get(key),
    write: async (key: string, value: unknown) => void kv.set(key, value),
    delete: async (key: string) => void kv.delete(key),
    clear: async () => kv.clear()
  });

  const db = {
    kv: kvAccessor,
    eventManager: new EventManager(),
    reset,
    setLastSynced,
    storage: () => ({
      hash: async (password: string) => `hashed:${password}`,
      deriveCryptoKey,
      deriveCryptoKeyFallback: vi.fn(async () => undefined),
      getCryptoKey: async () => "master-key",
      encrypt: async () => ({ cipher: "c", iv: "i", salt: "s", length: 1 }),
      encryptMulti: async () => [],
      clear: async () => kv.clear(),
      read: async (key: string) => kv.get(key),
      write: async (key: string, value: unknown) => void kv.set(key, value)
    }),
    crypto: () => ({ generateRandomKey: async () => ({ key: "k" }) }),
    syncer: { devices: { register, unregister } }
  } as unknown as Database;

  const user = new UserManager(db);
  // BackendAffinity reads the account through db.user.
  (db as unknown as { user: UserManager }).user = user;

  return {
    db,
    user,
    kv,
    reset,
    setLastSynced,
    deriveCryptoKey,
    register,
    unregister
  };
}

const original = { api: hosts.API_HOST, auth: hosts.AUTH_HOST };

beforeEach(() => {
  vi.clearAllMocks();
  hosts.API_HOST = VEYRAN.api;
  hosts.AUTH_HOST = VEYRAN.auth;
  setPersistedHostOverrides(undefined);
});
afterEach(() => {
  hosts.API_HOST = original.api;
  hosts.AUTH_HOST = original.auth;
  setPersistedHostOverrides(undefined);
  EV.unsubscribeAll();
});

describe("login records affinity only from a verified account", () => {
  const mfaToken = {
    access_token: "mfa-pw-token",
    scope: "auth:grant_types:mfa_password",
    refresh_token: "r",
    expires_in: 3600,
    t: Date.now()
  };

  /**
   * The core defect Codex found. fetchUser falls back to the cached user when
   * the account lookup fails, so recording affinity after it would relabel
   * existing notes as belonging to a server that never confirmed them.
   */
  test("a cached user from a failed lookup must not bind the profile", async () => {
    const legacy = serverUser("legacy-user");
    const { user, kv } = harness({ storedUser: legacy, token: mfaToken });

    // The password grant succeeds against the configured identity server...
    mockPost.mockResolvedValue({
      access_token: "new",
      refresh_token: "r2",
      scope: "notesnook.sync offline_access IdentityServerApi",
      expires_in: 3600
    });
    // ...but the account lookup against the configured API fails.
    mockGet.mockRejectedValue(new Error("network down"));

    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/cannot be attributed|could not confirm/i);

    expect(kv.get("backendAffinity")).toBeUndefined();
  });

  test("a server response with no user body must not bind the profile", async () => {
    const { user, kv } = harness({
      storedUser: serverUser("legacy-user"),
      token: mfaToken
    });
    mockPost.mockResolvedValue({
      access_token: "new",
      refresh_token: "r2",
      scope: "notesnook.sync offline_access IdentityServerApi",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(undefined);

    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow();
    expect(kv.get("backendAffinity")).toBeUndefined();
  });

  test("a freshly verified account binds the profile", async () => {
    const { user, kv } = harness({ token: mfaToken });
    mockPost.mockResolvedValue({
      access_token: "new",
      refresh_token: "r2",
      scope: "notesnook.sync offline_access IdentityServerApi",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(serverUser());

    await user.authenticatePassword("someone@example.test", "pw");

    expect(kv.get("backendAffinity")).toMatchObject({
      v: 1,
      api: VEYRAN.api,
      auth: VEYRAN.auth
    });
  });

  /**
   * Logging in to a different server does not transfer ownership of data synced
   * from another one. The record must survive and the login must fail.
   */
  test("logging in to another backend does not relabel existing data", async () => {
    const stored = affinityRecord(NOTESNOOK.api, NOTESNOOK.auth);
    const { user, kv } = harness({
      storedUser: serverUser("legacy-user"),
      affinity: stored,
      token: mfaToken
    });
    mockPost.mockResolvedValue({
      access_token: "new",
      refresh_token: "r2",
      scope: "notesnook.sync offline_access IdentityServerApi",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(serverUser("legacy-user"));

    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/belongs to a different server/);

    expect(kv.get("backendAffinity")).toEqual(stored);
  });

  test("the failed login is rolled back to the pre-login token", async () => {
    const { user, kv } = harness({
      storedUser: serverUser("legacy-user"),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth),
      token: mfaToken
    });
    mockPost.mockResolvedValue({
      access_token: "new",
      refresh_token: "r2",
      scope: "notesnook.sync offline_access IdentityServerApi",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(serverUser("legacy-user"));

    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow();

    expect((kv.get("token") as { access_token: string }).access_token).toBe(
      "mfa-pw-token"
    );
  });
});

describe("signup records affinity only from a verified account", () => {
  test("an unverified signup does not bind the profile", async () => {
    const { user, kv } = harness({ storedUser: serverUser("stale") });
    mockPost.mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      scope: "notesnook.sync offline_access",
      expires_in: 3600
    });
    mockGet.mockRejectedValue(new Error("network down"));

    await expect(user.signup("new@example.test", "pw")).rejects.toThrow();
    expect(kv.get("backendAffinity")).toBeUndefined();
  });
});

describe("automatic logout must not destroy local data", () => {
  /**
   * The original data-loss path: a foreign token is rejected, the refresh fails
   * invalid_grant, and logout() reaches db.reset(), which drops every table.
   */
  test("an automatic logout is refused when the profile is bound elsewhere", async () => {
    const { user, db, reset } = harness({
      storedUser: serverUser(),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth)
    });
    const expired = vi.fn();
    db.eventManager.subscribe(EVENTS.userSessionExpired, expired);

    await user.logout(false, "Your token has been revoked.", {
      userInitiated: false
    });

    expect(reset).not.toHaveBeenCalled();
    // The user is asked to re-authenticate instead of having data destroyed.
    expect(expired).toHaveBeenCalledTimes(1);
  });

  test("an automatic logout is refused when the profile is unattributable", async () => {
    const { user, reset } = harness({ storedUser: serverUser() });
    await user.logout(false, "revoked", { userInitiated: false });
    expect(reset).not.toHaveBeenCalled();
  });

  // An explicit sign-out is still expected to clear local data.
  test("a user-initiated logout still resets, even across a boundary", async () => {
    const { user, reset } = harness({
      storedUser: serverUser(),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth)
    });
    await user.logout(false, "signed out");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("a user-initiated logout on a matching backend resets", async () => {
    const { user, reset } = harness({
      storedUser: serverUser(),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth)
    });
    await user.logout(false, "signed out");
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("account fetches are blocked across a boundary", () => {
  test("fetchUser refuses to reach a foreign backend", async () => {
    const { user } = harness({
      storedUser: serverUser(),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth)
    });
    await expect(user.fetchUser()).rejects.toThrow(/different server/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("fetchUser refuses when the profile is unattributable", async () => {
    const { user } = harness({ storedUser: serverUser() });
    await expect(user.fetchUser()).rejects.toThrow(/cannot be attributed/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("fetchUser proceeds on a matching backend", async () => {
    const { user } = harness({
      storedUser: serverUser(),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: {
        access_token: "a",
        scope: "notesnook.sync",
        refresh_token: "r",
        expires_in: 3600,
        t: Date.now()
      }
    });
    mockGet.mockResolvedValue(serverUser());
    await expect(user.fetchUser()).resolves.toBeDefined();
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining(VEYRAN.api),
      "a"
    );
  });
});

describe("token refresh is blocked across a boundary", () => {
  test("a refresh token is never presented to a foreign identity server", async () => {
    const { user } = harness({
      storedUser: serverUser(),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth),
      token: {
        access_token: "old",
        refresh_token: "legacy-refresh",
        scope: "notesnook.sync offline_access",
        expires_in: -1,
        t: Date.now() - 10_000
      }
    });

    const tokenManager = (
      user as unknown as {
        tokenManager: { _refreshToken(force: boolean): Promise<void> };
      }
    ).tokenManager;
    await expect(tokenManager._refreshToken(true)).rejects.toThrow(
      /different server/
    );
    expect(mockPost).not.toHaveBeenCalled();
  });
});

/**
 * Round-2 regressions. The previous implementation wrote the fetched remote user
 * into KV inside the fetch, before the backend boundary was checked, so a
 * rejected cross-backend login restored the token but left another backend's
 * identity cached over this profile's own. The cached user carries the salt that
 * local content is keyed from, so that was silent corruption of the profile's
 * identity, not just a stale field.
 */
describe("a rejected login leaves the profile exactly as it was", () => {
  const mfaToken = {
    access_token: "mfa-pw-token",
    scope: "auth:grant_types:mfa_password",
    refresh_token: "r",
    expires_in: 3600,
    t: Date.now()
  };

  /** The account this device already belongs to, on the other backend. */
  function localIdentity() {
    return {
      ...serverUser("local-user"),
      email: "local@example.test",
      salt: "local-salt-that-keys-local-content"
    } as User;
  }

  /** A different account, returned by the backend being signed in to. */
  function foreignIdentity() {
    return {
      ...serverUser("foreign-user"),
      email: "foreign@example.test",
      salt: "foreign-salt"
    } as User;
  }

  function grantSucceedsButAccountIsForeign() {
    mockPost.mockResolvedValue({
      access_token: "new",
      refresh_token: "r2",
      scope: "notesnook.sync offline_access IdentityServerApi",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(foreignIdentity());
  }

  test("the cached identity and its salt are not overwritten", async () => {
    const local = localIdentity();
    const stored = affinityRecord(NOTESNOOK.api, NOTESNOOK.auth);
    const { user, kv } = harness({
      storedUser: local,
      affinity: stored,
      token: mfaToken
    });
    grantSucceedsButAccountIsForeign();

    await expect(
      user.authenticatePassword("foreign@example.test", "pw")
    ).rejects.toThrow(/belongs to a different server/);

    expect(kv.get("user")).toEqual(local);
    expect((kv.get("user") as User).salt).toBe(
      "local-salt-that-keys-local-content"
    );
  });

  test("the pre-login token is restored", async () => {
    const { user, kv } = harness({
      storedUser: localIdentity(),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth),
      token: mfaToken
    });
    grantSucceedsButAccountIsForeign();

    await expect(
      user.authenticatePassword("foreign@example.test", "pw")
    ).rejects.toThrow();

    expect(kv.get("token")).toMatchObject({ access_token: "mfa-pw-token" });
  });

  test("the existing affinity record is untouched", async () => {
    const stored = affinityRecord(NOTESNOOK.api, NOTESNOOK.auth);
    const { user, kv } = harness({
      storedUser: localIdentity(),
      affinity: stored,
      token: mfaToken
    });
    grantSucceedsButAccountIsForeign();

    await expect(
      user.authenticatePassword("foreign@example.test", "pw")
    ).rejects.toThrow();

    expect(kv.get("backendAffinity")).toEqual(stored);
  });

  // The whole point of the rejection: nothing may become eligible to upload.
  test("sync stays blocked afterwards, so no note data can leave", async () => {
    const { user, kv } = harness({
      storedUser: localIdentity(),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth),
      token: mfaToken
    });
    grantSucceedsButAccountIsForeign();

    await expect(
      user.authenticatePassword("foreign@example.test", "pw")
    ).rejects.toThrow();

    expect(await user.backendAffinity.isBlocked()).toBe(true);
    expect(kv.get("backendAffinity")).toMatchObject({ api: NOTESNOOK.api });
  });

  test("the sync checkpoint is not reset by a rejected login", async () => {
    const { user, setLastSynced } = harness({
      storedUser: localIdentity(),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth),
      token: mfaToken
    });
    grantSucceedsButAccountIsForeign();

    await expect(
      user.authenticatePassword("foreign@example.test", "pw")
    ).rejects.toThrow();

    expect(setLastSynced).not.toHaveBeenCalled();
  });

  test("no encryption key is derived from the foreign salt", async () => {
    const { user, deriveCryptoKey } = harness({
      storedUser: localIdentity(),
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth),
      token: mfaToken
    });
    grantSucceedsButAccountIsForeign();

    await expect(
      user.authenticatePassword("foreign@example.test", "pw")
    ).rejects.toThrow();

    expect(deriveCryptoKey).not.toHaveBeenCalled();
  });

  /**
   * Round-2 regression: an unrecorded profile with explicitly saved Notesnook
   * hosts was rebindable by a fresh VeyraN login.
   */
  test("saved configuration for another backend blocks the login and keeps state", async () => {
    const local = localIdentity();
    const { user, kv } = harness({ storedUser: local, token: mfaToken });
    setPersistedHostOverrides({
      API_HOST: NOTESNOOK.api,
      AUTH_HOST: NOTESNOOK.auth
    });
    grantSucceedsButAccountIsForeign();

    await expect(
      user.authenticatePassword("foreign@example.test", "pw")
    ).rejects.toThrow(/belongs to a different server/);

    expect(kv.has("backendAffinity")).toBe(false);
    expect(kv.get("user")).toEqual(local);
  });

  /** An unattributable profile must not be adopted by simply logging in. */
  test("an unattributable profile is not adopted by logging in", async () => {
    const local = localIdentity();
    const { user, kv } = harness({ storedUser: local, token: mfaToken });
    grantSucceedsButAccountIsForeign();

    await expect(
      user.authenticatePassword("foreign@example.test", "pw")
    ).rejects.toThrow(/cannot be attributed to a backend/);

    expect(kv.has("backendAffinity")).toBe(false);
    expect(kv.get("user")).toEqual(local);
  });
});

describe("a rejected signup leaves the profile exactly as it was", () => {
  test("credentials and identity are rolled back when binding is refused", async () => {
    const local = {
      ...serverUser("local-user"),
      salt: "local-salt"
    } as User;
    const priorToken = {
      access_token: "prior",
      refresh_token: "pr",
      scope: "notesnook.sync offline_access",
      expires_in: 3600,
      t: Date.now()
    };
    const { user, kv } = harness({
      storedUser: local,
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth),
      token: priorToken
    });

    mockPost.mockResolvedValue({
      access_token: "signup-token",
      refresh_token: "sr",
      scope: "notesnook.sync offline_access",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(serverUser("brand-new"));

    await expect(user.signup("new@example.test", "pw")).rejects.toThrow(
      /belongs to a different server/
    );

    expect(kv.get("user")).toEqual(local);
    expect(kv.get("token")).toMatchObject({ access_token: "prior" });
    expect(kv.get("backendAffinity")).toMatchObject({ api: NOTESNOOK.api });
  });

  test("a signup on a profile with no prior account still binds and commits", async () => {
    const { user, kv } = harness({});
    mockPost.mockResolvedValue({
      access_token: "signup-token",
      refresh_token: "sr",
      scope: "notesnook.sync offline_access",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(serverUser("brand-new"));

    await user.signup("new@example.test", "pw");

    expect(kv.get("backendAffinity")).toMatchObject({
      v: 1,
      api: VEYRAN.api,
      auth: VEYRAN.auth
    });
    expect(kv.get("user")).toMatchObject({ id: "brand-new" });
  });

  test("a late signup failure restores the original sync and device state", async () => {
    const { user, kv, register, unregister } = harness({
      lastSynced: 789,
      deviceId: "previous-device"
    });
    mockPost.mockResolvedValue({
      access_token: "signup-token",
      refresh_token: "signup-refresh",
      scope: "notesnook.sync offline_access IdentityServerApi",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(serverUser("brand-new"));
    register.mockImplementationOnce(async () => {
      kv.set("deviceId", "new-device");
      throw new Error("device registration interrupted");
    });

    await expect(user.signup("new@example.test", "pw")).rejects.toThrow(
      "device registration interrupted"
    );
    expect(unregister).toHaveBeenCalledOnce();
    expect(kv.get("lastSynced")).toBe(789);
    expect(kv.get("deviceId")).toBe("previous-device");
    expect(kv.has("user")).toBe(false);
    expect(kv.has("token")).toBe(false);
    expect(kv.has("backendAffinity")).toBe(false);
  });
});

describe("three-step login preserves the original session", () => {
  const originalToken = {
    access_token: "original-access",
    refresh_token: "original-refresh",
    scope: "notesnook.sync offline_access IdentityServerApi",
    expires_in: 3600,
    t: 123
  };

  function arrangeGrants(remoteUser = serverUser("same-account")) {
    mockPost
      .mockResolvedValueOnce({
        access_token: "email-stage",
        scope: "auth:grant_types:mfa",
        additional_data: { methods: ["app"] }
      })
      .mockResolvedValueOnce({
        access_token: "mfa-stage",
        scope: "auth:grant_types:mfa_password"
      })
      .mockResolvedValueOnce({
        access_token: "final-access",
        refresh_token: "final-refresh",
        scope: "notesnook.sync offline_access IdentityServerApi",
        expires_in: 3600
      });
    mockGet.mockResolvedValue(remoteUser);
  }

  test("email and MFA never replace the persisted access or refresh token", async () => {
    const { user, kv } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken
    });
    arrangeGrants();

    await user.authenticateEmail("Someone@example.test");
    expect(kv.get("token")).toEqual(originalToken);
    await user.authenticateMultiFactorCode("123456", "app");
    expect(kv.get("token")).toEqual(originalToken);
    await user.authenticatePassword("someone@example.test", "pw");
    expect(kv.get("token")).toMatchObject({
      access_token: "final-access",
      refresh_token: "final-refresh"
    });
  });

  test("a server change during MFA stops before presenting the temporary credential", async () => {
    const { user, kv } = harness({ token: originalToken });
    mockPost.mockResolvedValueOnce({
      access_token: "email-stage",
      scope: "auth:grant_types:mfa",
      additional_data: { methods: ["app"] }
    });
    await user.authenticateEmail("someone@example.test");
    hosts.AUTH_HOST = NOTESNOOK.auth;

    await expect(
      user.authenticateMultiFactorCode("123456", "app")
    ).rejects.toThrow(/Server settings changed/);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(kv.get("token")).toEqual(originalToken);
  });

  test("rejected remote account restores the entire original session", async () => {
    const stored = affinityRecord(VEYRAN.api, VEYRAN.auth);
    const local = serverUser("same-account");
    const { user, kv } = harness({
      storedUser: local,
      affinity: stored,
      token: originalToken,
      lastSynced: 909,
      deviceId: "old-device"
    });
    arrangeGrants(serverUser("foreign-account"));

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/different account/);

    expect(kv.get("token")).toEqual(originalToken);
    expect(kv.get("user")).toEqual(local);
    expect(kv.get("backendAffinity")).toEqual(stored);
    expect(kv.get("lastSynced")).toBe(909);
    expect(kv.get("deviceId")).toBe("old-device");
  });

  test("a late device failure restores sync, device, identity, and token", async () => {
    const stored = affinityRecord(VEYRAN.api, VEYRAN.auth);
    const local = serverUser("same-account");
    const { user, kv, register, unregister } = harness({
      storedUser: local,
      affinity: stored,
      token: originalToken,
      lastSynced: 456,
      deviceId: "old-device"
    });
    arrangeGrants();
    register.mockImplementationOnce(async () => {
      kv.set("deviceId", "new-device");
      throw new Error("device write failed");
    });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow("device write failed");

    expect(unregister).toHaveBeenCalledOnce();
    expect(kv.get("token")).toEqual(originalToken);
    expect(kv.get("user")).toEqual(local);
    expect(kv.get("backendAffinity")).toEqual(stored);
    expect(kv.get("lastSynced")).toBe(456);
    expect(kv.get("deviceId")).toBe("old-device");
  });

  test("can retry after failure without carrying a temporary identity", async () => {
    const { user, kv } = harness({ token: originalToken });
    arrangeGrants();
    mockGet.mockRejectedValueOnce(new Error("temporary outage"));
    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/Could not confirm/);
    expect(kv.get("token")).toEqual(originalToken);

    arrangeGrants();
    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await user.authenticatePassword("someone@example.test", "pw");
    expect(kv.get("user")).toMatchObject({ id: "same-account" });
  });

  test("an incorrect password can be retried without repeating MFA or replacing the old session", async () => {
    const { user, kv } = harness({ token: originalToken });
    mockPost
      .mockResolvedValueOnce({
        access_token: "email-stage",
        scope: "auth:grant_types:mfa",
        additional_data: { methods: ["app"] }
      })
      .mockResolvedValueOnce({
        access_token: "mfa-stage",
        scope: "auth:grant_types:mfa_password"
      })
      .mockRejectedValueOnce(new Error("Password is incorrect."))
      .mockRejectedValueOnce(new Error("Password is incorrect."))
      .mockResolvedValueOnce({
        access_token: "final-access",
        refresh_token: "final-refresh",
        scope: "notesnook.sync offline_access IdentityServerApi",
        expires_in: 3600
      });
    mockGet.mockResolvedValue(serverUser());

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "wrong")
    ).rejects.toThrow("Password is incorrect.");
    expect(kv.get("token")).toEqual(originalToken);
    await user.authenticatePassword("someone@example.test", "correct");
    expect(kv.get("token")).toMatchObject({ access_token: "final-access" });
  });
});

test("a failed local device write attempts to remove its remote registration", async () => {
  const write = vi.fn(async () => {
    throw new Error("device write failed");
  });
  mockPost.mockResolvedValue(undefined);
  const devices = new SyncDevices(() => ({ write } as never), {
    getAccessToken: async () => "access-token"
  } as never);

  await expect(devices.register()).rejects.toThrow("device write failed");
  const url = mockPost.mock.calls[0][0];
  expect(http.delete).toHaveBeenCalledWith(url, "access-token");
});
