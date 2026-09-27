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
import TokenManager from "../token-manager.js";
import MFAManager from "../mfa-manager.js";
import { StoredAffinity } from "../backend-affinity.js";
import { EVENTS, EV } from "../../common.js";
import EventManager from "../../utils/event-manager.js";
import Database from "../index.js";
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
const mockDelete = http.delete as unknown as Mock;

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
  cryptoKey?: string;
  syncActivity?: { autoSyncActive: boolean; connectionActive: boolean };
  localContent?: boolean;
}) {
  const kv = new Map<string, unknown>();
  if (options.storedUser) kv.set("user", options.storedUser);
  if (options.affinity) kv.set("backendAffinity", options.affinity);
  if (options.token) kv.set("token", options.token);
  if (options.lastSynced !== undefined)
    kv.set("lastSynced", options.lastSynced);
  if (options.deviceId) kv.set("deviceId", options.deviceId);
  if (options.cryptoKey) kv.set("cryptoKey", options.cryptoKey);

  const reset = vi.fn(async () => true);
  const setLastSynced = vi.fn(async (value: number) => {
    kv.set("lastSynced", value);
  });
  const deriveCryptoKey = vi.fn(async () => {
    kv.set("cryptoKey", "new-derived-key");
  });
  const storageWrite = vi.fn(async (key: string, value: unknown) => {
    kv.set(key, value);
  });
  const storageRemove = vi.fn(async (key: string) => {
    kv.delete(key);
  });
  const storageRead = vi.fn(async (key: string) => kv.get(key));
  const unregister = vi.fn(async () => void kv.delete("deviceId"));
  const register = vi.fn(async () => void kv.set("deviceId", "new-device"));
  const snapshotRecoveryState = vi.fn(
    () =>
      options.syncActivity || { autoSyncActive: false, connectionActive: false }
  );
  const resumeAfterRecovery = vi.fn(
    async (_state: { autoSyncActive: boolean; connectionActive: boolean }) =>
      undefined
  );

  const restoreSessionState = vi.fn(async (state: Record<string, unknown>) => {
    // Match the real KV adapter's transaction: stage the entire write, then
    // replace the map only when every operation succeeds.
    const staged = new Map(kv);
    for (const key of [
      "user",
      "token",
      "backendAffinity",
      "lastSynced",
      "deviceId"
    ]) {
      const value = state[key];
      if (value === undefined) staged.delete(key);
      else staged.set(key, value);
    }
    kv.clear();
    for (const [key, value] of staged) kv.set(key, value);
  });

  const kvRead = vi.fn(async (key: string) => kv.get(key));
  const kvWrite = vi.fn(async (key: string, value: unknown) => {
    kv.set(key, value);
  });
  const kvAccessor = () => ({
    read: kvRead,
    write: kvWrite,
    delete: async (key: string) => void kv.delete(key),
    restoreSessionState,
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
      snapshotCryptoKeyState: async () => kv.get("cryptoKey"),
      restoreCryptoKeyState: async (state: unknown) => {
        if (state === undefined) kv.delete("cryptoKey");
        else kv.set("cryptoKey", state);
      },
      deriveCryptoKeyFallback: vi.fn(async () => undefined),
      getCryptoKey: async () => "master-key",
      encrypt: async () => ({ cipher: "c", iv: "i", salt: "s", length: 1 }),
      encryptMulti: async () => [],
      clear: async () => kv.clear(),
      read: storageRead,
      write: storageWrite,
      remove: storageRemove
    }),
    crypto: () => ({ generateRandomKey: async () => ({ key: "k" }) }),
    syncer: {
      devices: { register, unregister },
      snapshotRecoveryState,
      resumeAfterRecovery
    }
  } as unknown as Database;

  (db as any).sql = () => ({
    selectFrom: (table: string) => ({
      select: () => ({
        limit: () => ({
          executeTakeFirst: async () =>
            options.localContent && table === "notes"
              ? { id: "local" }
              : undefined
        })
      })
    })
  });
  (db as any).legacyNotes = { count: () => 0 };
  (db as any).legacyTags = { count: () => 0 };
  (db as any).legacyColors = { count: () => 0 };

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
    unregister,
    snapshotRecoveryState,
    resumeAfterRecovery,
    restoreSessionState,
    storageWrite,
    storageRemove,
    storageRead,
    kvRead,
    kvWrite
  };
}

const original = {
  api: hosts.API_HOST,
  auth: hosts.AUTH_HOST,
  sse: hosts.SSE_HOST
};

beforeEach(() => {
  vi.clearAllMocks();
  hosts.API_HOST = VEYRAN.api;
  hosts.AUTH_HOST = VEYRAN.auth;
  hosts.SSE_HOST = "https://events.veyran.northcore.space";
  setPersistedHostOverrides(undefined);
});
afterEach(() => {
  hosts.API_HOST = original.api;
  hosts.AUTH_HOST = original.auth;
  hosts.SSE_HOST = original.sse;
  setPersistedHostOverrides(undefined);
  EV.unsubscribeAll();
});

describe("login records affinity only from a verified account", () => {
  const mfaToken = {
    access_token: "mfa-pw-token",
    scope: "auth:grant_types:mfa_password",
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
    const { user, kv } = harness({});
    mockPost
      .mockResolvedValueOnce({
        access_token: "email-stage",
        scope: "auth:grant_types:mfa"
      })
      .mockResolvedValueOnce({
        access_token: "mfa-stage",
        scope: "auth:grant_types:mfa_password"
      })
      .mockResolvedValueOnce({
        access_token: "new",
        refresh_token: "r2",
        scope: "notesnook.sync offline_access IdentityServerApi",
        expires_in: 3600
      });
    mockGet.mockResolvedValue(serverUser());

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
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
  test("a host switch while hashing prevents signup from reaching the new server", async () => {
    const { user, db, kv } = harness({});
    const storage = db.storage.bind(db);
    vi.spyOn(db, "storage").mockImplementation(() => ({
      ...storage(),
      hash: async () => {
        hosts.API_HOST = NOTESNOOK.api;
        return "hashed:pw";
      }
    }));
    await expect(user.signup("new@example.test", "pw")).rejects.toThrow(
      /Server settings changed/
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(kv.has("backendAffinity")).toBe(false);
  });

  test("a host switch after local key derivation rolls signup back before user update", async () => {
    const { user, kv, deriveCryptoKey, register } = harness({});
    mockPost.mockResolvedValue({
      access_token: "new-signup-token",
      refresh_token: "new-refresh",
      scope: "notesnook.sync offline_access IdentityServerApi"
    });
    mockGet.mockResolvedValue(serverUser("brand-new"));
    deriveCryptoKey.mockImplementationOnce(async () => {
      hosts.API_HOST = NOTESNOOK.api;
    });

    await expect(user.signup("new@example.test", "pw")).rejects.toThrow(
      /Server settings changed/
    );
    expect(http.patch.json).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(kv.has("user")).toBe(false);
    expect(kv.has("token")).toBe(false);
    expect(kv.has("backendAffinity")).toBe(false);
    expect(kv.has("backendRecoveryRequired")).toBe(false);
  });

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
  test.each([false, true])(
    "an SSE logout preserves local data with recovery intent %s",
    async (recoveryPending) => {
      const local = serverUser("account");
      const token = {
        access_token: "existing-access",
        refresh_token: "existing-refresh",
        scope: "notesnook.sync offline_access IdentityServerApi",
        expires_in: 3600,
        t: Date.now()
      };
      const { user, db, kv, reset } = harness({
        storedUser: local,
        affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
        token,
        lastSynced: 811,
        deviceId: "registered-device",
        cryptoKey: "local-content-key"
      });
      const expired = vi.fn();
      const eventDb = new Database();
      eventDb.user = user;
      eventDb.tokenManager.getAccessToken = vi.fn(
        async () => "existing-access"
      );
      const close = vi.fn();
      class TestEventSource {
        onmessage?: (event: { data: string }) => Promise<void>;
        onopen?: () => void;
        onerror?: (error: unknown) => void;
        readyState = 1;
        OPEN = 1;
        close = close;
      }
      eventDb.setup({ eventsource: TestEventSource as never } as never);
      db.eventManager.subscribe(EVENTS.userSessionExpired, expired);

      await eventDb.connectSSE();
      const stream = eventDb.eventSource as unknown as TestEventSource;
      expect(stream?.onmessage).toBeDefined();
      // The stream may have opened before recovery was needed. An in-flight
      // logout event must still be unable to remove the old credentials.
      if (recoveryPending) kv.set("backendRecoveryRequired", true);
      await stream.onmessage?.({
        data: JSON.stringify({
          type: "logout",
          data: JSON.stringify({ reason: "server revoked session" })
        })
      });

      expect(reset).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(kv.get("token")).toEqual(recoveryPending ? token : undefined);
      expect(kv.get("user")).toEqual(local);
      expect(kv.get("lastSynced")).toBe(811);
      expect(kv.get("deviceId")).toBe("registered-device");
      expect(kv.get("cryptoKey")).toBe("local-content-key");
      expect(kv.get("backendRecoveryRequired")).toBe(
        recoveryPending ? true : undefined
      );
      expect(expired).toHaveBeenCalledOnce();
    }
  );

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

  test("a revoked session on the matching backend clears only credentials", async () => {
    const local = serverUser("account");
    const { user, db, kv, reset } = harness({
      storedUser: local,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: {
        access_token: "revoked",
        refresh_token: "revoked-refresh",
        scope: "notesnook.sync offline_access IdentityServerApi"
      },
      lastSynced: 811,
      deviceId: "registered-device",
      cryptoKey: "local-content-key"
    });
    const expired = vi.fn();
    db.eventManager.subscribe(EVENTS.userSessionExpired, expired);

    await user.logout(false, "invalid_grant", { userInitiated: false });

    expect(reset).not.toHaveBeenCalled();
    expect(kv.has("token")).toBe(false);
    expect(kv.get("user")).toEqual(local);
    expect(kv.get("lastSynced")).toBe(811);
    expect(kv.get("deviceId")).toBe("registered-device");
    expect(kv.get("cryptoKey")).toBe("local-content-key");
    expect(expired).toHaveBeenCalledOnce();
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
  test("a host switch while reading the token cannot send a refresh credential", async () => {
    const token = {
      access_token: "race-access",
      refresh_token: "race-refresh",
      scope: "offline_access notesnook.sync",
      t: 0,
      expires_in: 1
    };
    const manager = new TokenManager(
      () =>
        ({
          read: async () => {
            hosts.AUTH_HOST = NOTESNOOK.auth;
            return token;
          }
        } as never),
      new EventManager(),
      async () => undefined
    );
    await expect(manager._refreshToken(true)).rejects.toThrow(
      /Server settings changed/
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("a host switch after refresh response cannot persist the new credential", async () => {
    const oldToken = {
      access_token: "old-refresh-race",
      refresh_token: "old-refresh-secret",
      scope: "offline_access notesnook.sync",
      t: 0,
      expires_in: 1
    };
    const write = vi.fn();
    const manager = new TokenManager(
      () => ({ read: async () => oldToken, write } as never),
      new EventManager(),
      async () => undefined
    );
    mockPost.mockImplementationOnce(async () => {
      hosts.AUTH_HOST = NOTESNOOK.auth;
      return { access_token: "new-refresh-race" };
    });
    await expect(manager._refreshToken(true)).rejects.toThrow(
      /Server settings changed/
    );
    expect(mockPost).toHaveBeenCalledWith(
      `${VEYRAN.auth}/connect/token`,
      expect.objectContaining({ refresh_token: "old-refresh-secret" })
    );
    expect(write).not.toHaveBeenCalled();
  });

  test("a host switch during local revoke cleanup cannot redirect logout", async () => {
    const oldToken = {
      access_token: "revoke-host-race",
      refresh_token: "revoke-refresh",
      scope: "offline_access notesnook.sync",
      t: Date.now(),
      expires_in: 3600
    };
    const manager = new TokenManager(
      () =>
        ({
          read: async () => oldToken,
          delete: async () => {
            hosts.AUTH_HOST = NOTESNOOK.auth;
          }
        } as never),
      new EventManager(),
      async () => undefined
    );
    await expect(manager.revokeToken()).rejects.toThrow(
      /Server settings changed/
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

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

  test("a legacy token without cached user cannot be read or refreshed", async () => {
    const { user } = harness({
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth),
      token: {
        access_token: "legacy-access",
        refresh_token: "legacy-refresh",
        scope: "notesnook.sync offline_access IdentityServerApi",
        expires_in: 3600,
        t: Date.now()
      }
    });
    const tokenManager = (user as unknown as { tokenManager: TokenManager })
      .tokenManager;
    await expect(tokenManager.getToken(false, false)).rejects.toThrow(
      /cannot be attributed/
    );
    await expect(tokenManager._refreshToken(true)).rejects.toThrow(
      /cannot be attributed/
    );
    expect(mockPost).not.toHaveBeenCalled();
  });
});

test("an events-host switch during token acquisition cannot open a stream", async () => {
  const { user } = harness({
    storedUser: serverUser(),
    affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
    token: { access_token: "existing-access" }
  });
  const eventDb = new Database();
  eventDb.user = user;
  eventDb.tokenManager.getAccessToken = vi.fn(async () => {
    hosts.SSE_HOST = "https://events.example.test";
    return "existing-access";
  });
  const opened = vi.fn();
  class TestEventSource {
    constructor() {
      opened();
    }
    close() {}
  }
  eventDb.setup({ eventsource: TestEventSource as never } as never);

  await expect(eventDb.connectSSE()).rejects.toThrow(/Server settings changed/);
  expect(opened).not.toHaveBeenCalled();
});

describe("recovery intent blocks credential retrieval", () => {
  test("an unexpired token cannot reach account or sync APIs while quarantined", async () => {
    const { user, db, kv } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: {
        access_token: "unexpired-access",
        refresh_token: "unexpired-refresh",
        scope: "notesnook.sync offline_access IdentityServerApi",
        expires_in: 3600,
        t: Date.now()
      }
    });
    kv.set("backendRecoveryRequired", true);
    const tokenManager = (user as unknown as { tokenManager: TokenManager })
      .tokenManager;
    const devices = new SyncDevices(db.kv, tokenManager);

    await expect(tokenManager.getToken(false, false)).rejects.toThrow(
      /cannot be attributed/
    );
    await expect(tokenManager.getAccessToken()).rejects.toThrow(
      /cannot be attributed/
    );
    await expect(user.getSessions()).rejects.toThrow(/cannot be attributed/);
    await expect(user.clearSessions()).rejects.toThrow(/cannot be attributed/);
    await expect(devices.register()).rejects.toThrow(/cannot be attributed/);
    await expect(
      tokenManager.getAccessTokenFromAuthorizationCode("same-account", "code")
    ).rejects.toThrow(/cannot be attributed/);
    expect(mockGet).not.toHaveBeenCalled();
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
    expect(kv.has("backendRecoveryRequired")).toBe(false);
  });

  test("a failed intent write prevents every local account mutation", async () => {
    const { user, kv, storageWrite, register } = harness({});
    mockPost.mockResolvedValue({ access_token: "signup-access" });
    mockGet.mockResolvedValue(serverUser("brand-new"));
    storageWrite.mockRejectedValueOnce(new Error("intent storage unavailable"));

    await expect(user.signup("new@example.test", "pw")).rejects.toThrow(
      "intent storage unavailable"
    );
    expect(kv.get("token")).toBeUndefined();
    expect(kv.has("user")).toBe(false);
    expect(kv.get("backendAffinity")).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  test("an uncertain intent write blocks the profile after restart", async () => {
    const { user, db, kv, storageWrite } = harness({});
    mockPost.mockResolvedValue({ access_token: "signup-access" });
    mockGet.mockResolvedValue(serverUser("brand-new"));
    storageWrite.mockImplementationOnce(async (key: string, value: unknown) => {
      kv.set(key, value);
      throw new Error("write acknowledgement lost");
    });

    await expect(user.signup("new@example.test", "pw")).rejects.toThrow(
      "write acknowledgement lost"
    );
    expect(kv.has("user")).toBe(false);
    expect(kv.get("backendRecoveryRequired")).toBe(true);
    const reopened = new UserManager(db);
    (db as unknown as { user: UserManager }).user = reopened;
    expect(await reopened.backendAffinity.isBlocked()).toBe(true);
  });

  test("a late signup failure restores an empty local session", async () => {
    const { user, kv, register, unregister } = harness({});
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
    expect(kv.get("lastSynced")).toBeUndefined();
    expect(kv.get("deviceId")).toBeUndefined();
    expect(kv.get("cryptoKey")).toBeUndefined();
    expect(kv.has("user")).toBe(false);
    expect(kv.has("token")).toBe(false);
    expect(kv.get("backendAffinity")).toBeUndefined();
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

  function mfaFor(user: UserManager) {
    const tokenManager = (user as unknown as { tokenManager: TokenManager })
      .tokenManager;
    return new MFAManager(tokenManager, () =>
      user.getPendingMfaSendCredential()
    );
  }

  test("fresh email MFA sends a code and completes login without persisting interim grants", async () => {
    const { user, kv } = harness({});
    const mfa = mfaFor(user);
    mockPost
      .mockResolvedValueOnce({
        access_token: "fresh-email-grant",
        scope: "auth:grant_types:mfa",
        expires_in: 600,
        additional_data: { primaryMethod: "email" }
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        access_token: "fresh-mfa-grant",
        scope: "auth:grant_types:mfa_password",
        expires_in: 600
      })
      .mockResolvedValueOnce({
        access_token: "fresh-final-grant",
        refresh_token: "fresh-final-refresh",
        scope: "notesnook.sync offline_access IdentityServerApi",
        expires_in: 3600
      });
    mockGet.mockResolvedValue(serverUser("fresh-account"));

    await user.authenticateEmail("someone@example.test");
    expect(kv.get("token")).toBeUndefined();
    await mfa.sendCode("email");
    expect(mockPost.mock.calls[1]).toEqual([
      `${VEYRAN.auth}/mfa/send`,
      { type: "email" },
      "fresh-email-grant"
    ]);
    expect(kv.get("token")).toBeUndefined();
    await user.authenticateMultiFactorCode("123456", "email");
    expect(kv.get("token")).toBeUndefined();
    await user.authenticatePassword("someone@example.test", "password");
    expect(kv.get("token")).toMatchObject({
      access_token: "fresh-final-grant",
      refresh_token: "fresh-final-refresh"
    });
    expect(kv.get("backendAffinity")).toMatchObject(VEYRAN);
  });

  test("rejected MFA code leaves the original session intact", async () => {
    const { user, kv } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken
    });
    const mfa = mfaFor(user);
    mockPost
      .mockResolvedValueOnce({
        access_token: "retry-email-grant",
        scope: "auth:grant_types:mfa",
        expires_in: 600
      })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("Invalid verification code"));
    await user.authenticateEmail("someone@example.test");
    await mfa.sendCode("email");
    await expect(
      user.authenticateMultiFactorCode("wrong", "email")
    ).rejects.toThrow("Invalid verification code");
    expect(kv.get("token")).toEqual(originalToken);
    expect(kv.get("user")).toMatchObject({ id: "same-account" });
  });

  test("MFA code delivery refuses a host change without sending its challenge", async () => {
    const { user, kv } = harness({});
    const mfa = mfaFor(user);
    mockPost.mockResolvedValueOnce({
      access_token: "host-email-grant",
      scope: "auth:grant_types:mfa",
      expires_in: 600
    });
    await user.authenticateEmail("someone@example.test");
    hosts.AUTH_HOST = NOTESNOOK.auth;
    await expect(mfa.sendCode("email")).rejects.toThrow(
      /Server settings changed/
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(kv.get("token")).toBeUndefined();
  });

  test("MFA delivery rechecks the host after retrieving a pending challenge", async () => {
    const { user } = harness({});
    const tokenManager = (user as unknown as { tokenManager: TokenManager })
      .tokenManager;
    const mfa = new MFAManager(tokenManager, async () => {
      const challenge = await user.getPendingMfaSendCredential();
      hosts.AUTH_HOST = NOTESNOOK.auth;
      return challenge;
    });
    mockPost.mockResolvedValueOnce({
      access_token: "race-email-grant",
      scope: "auth:grant_types:mfa",
      expires_in: 600
    });
    await user.authenticateEmail("someone@example.test");
    await expect(mfa.sendCode("email")).rejects.toThrow(
      /Server settings changed/
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test("settings-level code delivery still uses the bound existing session", async () => {
    const { user } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: { ...originalToken, t: Date.now() }
    });
    const mfa = mfaFor(user);
    mockPost.mockResolvedValue({ ok: true });
    await mfa.sendCode("email");
    expect(mockPost.mock.calls[0]).toEqual([
      `${VEYRAN.auth}/mfa/send`,
      { type: "email" },
      originalToken.access_token
    ]);
  });

  test("an advanced challenge cannot fall back to another stored session", async () => {
    const { user, kv } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken
    });
    const mfa = mfaFor(user);
    mockPost
      .mockResolvedValueOnce({
        access_token: "advanced-email-grant",
        scope: "auth:grant_types:mfa",
        expires_in: 600
      })
      .mockResolvedValueOnce({
        access_token: "advanced-password-grant",
        scope: "auth:grant_types:mfa_password",
        expires_in: 600
      });
    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "email");
    await expect(mfa.sendCode("email")).rejects.toThrow(/challenge has ended/);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(kv.get("token")).toEqual(originalToken);
  });

  test("a superseded MFA response cannot replace the current challenge or stored session", async () => {
    const { user, kv } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken
    });
    mockPost
      .mockResolvedValueOnce({
        access_token: "superseded-email-grant",
        scope: "auth:grant_types:mfa",
        expires_in: 600
      })
      .mockImplementationOnce(async () => {
        (user as any).pendingLogin = undefined;
        return {
          access_token: "stale-password-grant",
          scope: "auth:grant_types:mfa_password",
          expires_in: 600
        };
      });
    await user.authenticateEmail("someone@example.test");
    await expect(
      user.authenticateMultiFactorCode("123456", "email")
    ).rejects.toThrow(/challenge changed/);
    expect(kv.get("token")).toEqual(originalToken);
  });

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
    expect(kv.has("backendRecoveryRequired")).toBe(false);
  });

  test("a host switch after the password grant cannot present the new token to that host", async () => {
    const { user, kv, register } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken
    });
    mockPost
      .mockResolvedValueOnce({
        access_token: "email-stage",
        scope: "auth:grant_types:mfa"
      })
      .mockResolvedValueOnce({
        access_token: "mfa-stage",
        scope: "auth:grant_types:mfa_password"
      })
      .mockImplementationOnce(async () => {
        hosts.API_HOST = NOTESNOOK.api;
        return {
          access_token: "new-account-token",
          refresh_token: "new-refresh",
          scope: "notesnook.sync offline_access IdentityServerApi"
        };
      });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/Could not confirm|Server settings changed/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(kv.get("token")).toEqual(originalToken);
  });

  test("recovery teardown is announced only after the durable marker and before local identity changes", async () => {
    const local = serverUser("same-account");
    const { user, db, kv } = harness({
      storedUser: local,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "old-key"
    });
    arrangeGrants();
    const observed: Array<{ marker: unknown; token: unknown; user: unknown }> =
      [];
    db.eventManager.subscribe(EVENTS.backendRecoveryStarted, () => {
      observed.push({
        marker: kv.get("backendRecoveryRequired"),
        token: kv.get("token"),
        user: kv.get("user")
      });
    });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await user.authenticatePassword("someone@example.test", "pw");

    expect(observed).toEqual([
      { marker: true, token: originalToken, user: local }
    ]);
  });

  test("login waits for active sync teardown before replacing the old token", async () => {
    const { user, db, kv } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "old-key"
    });
    arrangeGrants();
    let announceTeardown!: () => void;
    let finishTeardown!: () => void;
    const teardownStarted = new Promise<void>((resolve) => {
      announceTeardown = resolve;
    });
    const teardownFinished = new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
    db.eventManager.subscribe(EVENTS.backendRecoveryStarted, async () => {
      announceTeardown();
      await teardownFinished;
    });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    const login = user.authenticatePassword("someone@example.test", "pw");
    await teardownStarted;
    expect(kv.get("backendRecoveryRequired")).toBe(true);
    expect(kv.get("token")).toEqual(originalToken);
    finishTeardown();
    await login;
    expect(kv.get("token")).toMatchObject({ access_token: "final-access" });
  });

  test("failed upload cancellation retains the durable quarantine and original session", async () => {
    const local = serverUser("same-account");
    const oldSession = { ...originalToken, t: Date.now() };
    const { user, db, kv, register, resumeAfterRecovery } = harness({
      storedUser: local,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: oldSession,
      cryptoKey: "old-key",
      deviceId: "old-device",
      lastSynced: 51,
      syncActivity: { autoSyncActive: true, connectionActive: true }
    });
    arrangeGrants();
    const cancelUploads = vi.fn(async () => {
      throw new Error("upload cancel failed");
    });
    db.eventManager.subscribe(EVENTS.backendRecoveryStarted, cancelUploads);

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/could not safely stop active sync traffic/);

    expect(cancelUploads).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
    expect(resumeAfterRecovery).not.toHaveBeenCalled();
    expect(kv.get("user")).toEqual(local);
    expect(kv.get("token")).toEqual(oldSession);
    expect(kv.get("cryptoKey")).toBe("old-key");
    expect(kv.get("deviceId")).toBe("old-device");
    expect(kv.get("lastSynced")).toBe(51);
    expect(kv.get("backendRecoveryRequired")).toBe(true);
    expect(await user.backendAffinity.isBlocked()).toBe(true);
    const reopened = new UserManager(db);
    (db as unknown as { user: UserManager }).user = reopened;
    expect(await reopened.backendAffinity.isBlocked()).toBe(true);
  });

  test("marker removal failure before deletion rolls back the committed login", async () => {
    const local = serverUser("same-account");
    const oldAffinity = affinityRecord(VEYRAN.api, VEYRAN.auth);
    const { user, kv, storageRemove } = harness({
      storedUser: local,
      affinity: oldAffinity,
      token: originalToken,
      lastSynced: 730,
      deviceId: "old-device",
      cryptoKey: "old-key"
    });
    arrangeGrants();
    storageRemove.mockRejectedValueOnce(new Error("marker removal failed"));

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow("marker removal failed");

    expect(kv.get("user")).toEqual(local);
    expect(kv.get("token")).toEqual(originalToken);
    expect(kv.get("backendAffinity")).toEqual(oldAffinity);
    expect(kv.get("lastSynced")).toBe(730);
    expect(kv.get("deviceId")).toBe("old-device");
    expect(kv.get("cryptoKey")).toBe("old-key");
    expect(kv.has("backendRecoveryRequired")).toBe(false);
  });

  test("marker removal failure after deletion accepts the verified login", async () => {
    const { user, kv, storageRemove } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "old-key"
    });
    arrangeGrants();
    storageRemove.mockImplementationOnce(async (key: string) => {
      kv.delete(key);
      throw new Error("acknowledgment lost after marker deletion");
    });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).resolves.toBeUndefined();

    expect(kv.get("token")).toMatchObject({ access_token: "final-access" });
    expect(kv.get("cryptoKey")).toBe("new-derived-key");
    expect(kv.has("backendRecoveryRequired")).toBe(false);
  });

  test("marker readback failure accepts a fully verified login", async () => {
    const { user, db, kv, storageRead, storageRemove } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "old-key"
    });
    arrangeGrants();
    let failedReadback = false;
    storageRead.mockImplementation(async (key: string) => {
      if (
        key === "backendRecoveryRequired" &&
        storageRemove.mock.calls.length &&
        !failedReadback
      ) {
        failedReadback = true;
        throw new Error("marker readback failed");
      }
      return kv.get(key);
    });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).resolves.toBeUndefined();

    expect(kv.get("token")).toMatchObject({ access_token: "final-access" });
    expect(kv.get("cryptoKey")).toBe("new-derived-key");
    expect(kv.has("backendRecoveryRequired")).toBe(false);
    const reopened = new UserManager(db);
    (db as unknown as { user: UserManager }).user = reopened;
    expect(await reopened.backendAffinity.isBlocked()).toBe(false);
  });

  test("ambiguous marker cleanup preserves the durable guard after verified login", async () => {
    const { user, db, kv, storageRead, storageRemove } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "old-key"
    });
    arrangeGrants();
    storageRemove.mockRejectedValueOnce(new Error("marker deletion failed"));
    storageRead.mockImplementation(async (key: string) => {
      if (key === "backendRecoveryRequired" && storageRemove.mock.calls.length)
        throw new Error("marker readback failed");
      return kv.get(key);
    });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).resolves.toBeUndefined();

    expect(kv.get("token")).toMatchObject({ access_token: "final-access" });
    expect(kv.get("backendRecoveryRequired")).toBe(true);
    const reopened = new UserManager(db);
    (db as unknown as { user: UserManager }).user = reopened;
    expect(await reopened.backendAffinity.isBlocked()).toBe(true);
  });

  test("a server change during MFA stops before presenting the temporary credential", async () => {
    const { user, kv } = harness({
      storedUser: serverUser("same-account"),
      token: originalToken,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth)
    });
    mockPost.mockResolvedValueOnce({
      access_token: "email-stage",
      scope: "auth:grant_types:mfa",
      additional_data: { methods: ["app"] }
    });
    await user.authenticateEmail("someone@example.test");
    hosts.AUTH_HOST = NOTESNOOK.auth;

    await expect(
      user.authenticateMultiFactorCode("123456", "app")
    ).rejects.toThrow(/Server settings changed|different server/);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(kv.get("token")).toEqual(originalToken);
  });

  test("a failed recovery-intent write leaves the old login and key untouched", async () => {
    const local = serverUser("same-account");
    const { user, kv, storageWrite } = harness({
      storedUser: local,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "old-key"
    });
    arrangeGrants();
    storageWrite.mockRejectedValueOnce(new Error("intent write failed"));

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow("intent write failed");

    expect(kv.get("token")).toEqual(originalToken);
    expect(kv.get("user")).toEqual(local);
    expect(kv.get("cryptoKey")).toBe("old-key");
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
    expect(kv.has("backendRecoveryRequired")).toBe(false);
  });

  test("verified rollback resumes the original active sync state only after restoration", async () => {
    const originalSession = { ...originalToken, t: Date.now() };
    const local = serverUser("same-account");
    const { user, db, kv, register, resumeAfterRecovery } = harness({
      storedUser: local,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalSession,
      cryptoKey: "old-key",
      deviceId: "old-device",
      lastSynced: 745,
      syncActivity: { autoSyncActive: true, connectionActive: true }
    });
    let syncActive = true;
    db.eventManager.subscribe(EVENTS.backendRecoveryStarted, () => {
      syncActive = false;
    });
    resumeAfterRecovery.mockImplementationOnce(async (state) => {
      expect(kv.has("backendRecoveryRequired")).toBe(false);
      expect(kv.get("token")).toEqual(originalSession);
      expect(kv.get("user")).toEqual(local);
      expect(kv.get("cryptoKey")).toBe("old-key");
      expect(kv.get("deviceId")).toBe("old-device");
      expect(kv.get("lastSynced")).toBe(745);
      expect(state).toEqual({ autoSyncActive: true, connectionActive: true });
      syncActive = true;
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

    expect(syncActive).toBe(true);
    expect(resumeAfterRecovery).toHaveBeenCalledOnce();
  });

  test("failed rollback keeps previously active sync stopped", async () => {
    const { user, db, kv, register, restoreSessionState, resumeAfterRecovery } =
      harness({
        storedUser: serverUser("same-account"),
        affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
        token: { ...originalToken, t: Date.now() },
        cryptoKey: "old-key",
        deviceId: "old-device",
        syncActivity: { autoSyncActive: true, connectionActive: true }
      });
    let syncActive = true;
    db.eventManager.subscribe(EVENTS.backendRecoveryStarted, () => {
      syncActive = false;
    });
    arrangeGrants();
    register.mockRejectedValueOnce(new Error("device write failed"));
    restoreSessionState.mockRejectedValueOnce(new Error("KV recovery failed"));

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/rollback could not be completed/);

    expect(syncActive).toBe(false);
    expect(resumeAfterRecovery).not.toHaveBeenCalled();
    expect(kv.get("backendRecoveryRequired")).toBe(true);
  });

  test("an expired original session is not reconnected after rollback", async () => {
    const { user, register, resumeAfterRecovery } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "old-key",
      syncActivity: { autoSyncActive: true, connectionActive: true }
    });
    arrangeGrants();
    register.mockRejectedValueOnce(new Error("device write failed"));

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow("device write failed");

    expect(resumeAfterRecovery).not.toHaveBeenCalled();
  });

  test("rollback unregisters a newly registered device with the verified token despite quarantine", async () => {
    const { user, db, kv, deriveCryptoKey } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      deviceId: "old-device",
      cryptoKey: "old-key"
    });
    const tokenManager = (user as unknown as { tokenManager: TokenManager })
      .tokenManager;
    (db.syncer as unknown as { devices: SyncDevices }).devices =
      new SyncDevices(db.kv, tokenManager);
    arrangeGrants();
    mockDelete.mockResolvedValueOnce(undefined);
    deriveCryptoKey.mockRejectedValueOnce(new Error("key write failed"));

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow("key write failed");

    expect(mockDelete).toHaveBeenCalledOnce();
    expect(mockDelete.mock.calls[0][0]).toMatch(
      /^https:\/\/api\.veyran\.northcore\.space\/devices\?deviceId=/
    );
    expect(mockDelete.mock.calls[0][1]).toBe("final-access");
    expect(kv.get("token")).toEqual(originalToken);
    expect(kv.get("deviceId")).toBe("old-device");
    expect(kv.get("cryptoKey")).toBe("old-key");
    expect(kv.has("backendRecoveryRequired")).toBe(false);
  });

  test("a failed device-ID read still attempts local rollback and retains the durable block", async () => {
    const local = serverUser("same-account");
    const { user, db, kv, register, kvRead, restoreSessionState } = harness({
      storedUser: local,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      lastSynced: 366,
      deviceId: "old-device"
    });
    arrangeGrants();
    let failDeviceRead = false;
    kvRead.mockImplementation(async (key: string) => {
      if (key === "deviceId" && failDeviceRead) {
        failDeviceRead = false;
        throw new Error("device ID read failed");
      }
      return kv.get(key);
    });
    register.mockImplementationOnce(async () => {
      kv.set("deviceId", "new-device");
      failDeviceRead = true;
      throw new Error("device registration failed");
    });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/rollback could not be completed/);

    expect(restoreSessionState).toHaveBeenCalledOnce();
    expect(kv.get("token")).toEqual(originalToken);
    expect(kv.get("user")).toEqual(local);
    expect(kv.get("lastSynced")).toBe(366);
    expect(kv.get("deviceId")).toBe("old-device");
    expect(kv.get("backendRecoveryRequired")).toBe(true);
    const reopened = new UserManager(db);
    (db as unknown as { user: UserManager }).user = reopened;
    expect(await reopened.backendAffinity.isBlocked()).toBe(true);
  });

  test("a key-store failure after writing a new key restores the original key and session", async () => {
    const { user, kv, deriveCryptoKey } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "original-key",
      lastSynced: 123,
      deviceId: "original-device"
    });
    arrangeGrants();
    deriveCryptoKey.mockImplementationOnce(async () => {
      kv.set("cryptoKey", "partially-written-new-key");
      throw new Error("key store write interrupted");
    });

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow("key store write interrupted");

    expect(kv.get("cryptoKey")).toBe("original-key");
    expect(kv.get("token")).toEqual(originalToken);
    expect(kv.get("deviceId")).toBe("original-device");
    expect(kv.get("lastSynced")).toBe(123);
  });

  test("failed atomic KV recovery blocks further account traffic and still restores the key", async () => {
    const { user, db, kv, deriveCryptoKey, restoreSessionState } = harness({
      storedUser: serverUser("same-account"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: originalToken,
      cryptoKey: "original-key"
    });
    arrangeGrants();
    deriveCryptoKey.mockImplementationOnce(async () => {
      kv.set("cryptoKey", "partially-written-new-key");
      throw new Error("key write failed");
    });
    restoreSessionState.mockRejectedValueOnce(
      new Error("database is read-only")
    );

    await user.authenticateEmail("someone@example.test");
    await user.authenticateMultiFactorCode("123456", "app");
    await expect(
      user.authenticatePassword("someone@example.test", "pw")
    ).rejects.toThrow(/rollback could not be completed/);

    expect(kv.get("cryptoKey")).toBe("original-key");
    expect(kv.get("backendRecoveryRequired")).toBe(true);
    expect(await user.backendAffinity.isBlocked()).toBe(true);
    await expect(
      user.authenticateEmail("someone@example.test")
    ).rejects.toThrow(/cannot be attributed/);
    const reopened = new UserManager(db);
    (db as unknown as { user: UserManager }).user = reopened;
    expect(await reopened.backendAffinity.isBlocked()).toBe(true);
  });

  test("can retry after failure without carrying a temporary identity", async () => {
    const { user, kv } = harness({
      storedUser: serverUser("same-account"),
      token: originalToken,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth)
    });
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
    const { user, kv } = harness({
      storedUser: serverUser(),
      token: originalToken,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth)
    });
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

describe("verified recovery-code session", () => {
  test("a fresh empty VeyraN profile verifies the remote account before saving its token", async () => {
    const { user, kv } = harness({});
    mockPost.mockResolvedValue({
      access_token: "recovery-access",
      refresh_token: "recovery-refresh",
      expires_in: 3600
    });
    mockGet.mockResolvedValue(serverUser("recovered"));

    await expect(
      user.authenticateRecoveryCode("recovered", "code")
    ).resolves.toMatchObject({ id: "recovered" });

    expect(mockPost.mock.calls[0][0]).toBe(`${VEYRAN.auth}/account/token`);
    expect(mockGet.mock.calls[0][0]).toBe(`${VEYRAN.api}/users`);
    expect(mockGet.mock.calls[0][1]).toBe("recovery-access");
    expect(kv.get("token")).toMatchObject({
      access_token: "recovery-access",
      refresh_token: "recovery-refresh"
    });
    expect(kv.get("backendAffinity")).toMatchObject(VEYRAN);
    expect(kv.get("backendRecoveryRequired")).toBeUndefined();
  });

  test("wrong remote account leaves the previous token and profile untouched", async () => {
    const previous = { access_token: "old", refresh_token: "old-refresh" };
    const { user, kv } = harness({
      storedUser: serverUser("old"),
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      token: previous
    });
    await expect(
      user.authenticateRecoveryCode("different", "code")
    ).rejects.toThrow(/another account|already has a session/);
    expect(kv.get("token")).toEqual(previous);
    expect(kv.get("user")).toMatchObject({ id: "old" });
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("stored legacy affinity and local data refuse fresh recovery without relabeling", async () => {
    const legacy = harness({
      affinity: affinityRecord(NOTESNOOK.api, NOTESNOOK.auth)
    });
    await expect(
      legacy.user.authenticateRecoveryCode("recovered", "code")
    ).rejects.toThrow(/different server/);
    expect(legacy.kv.get("backendAffinity")).toMatchObject(NOTESNOOK);

    const local = harness({ localContent: true });
    await expect(
      local.user.authenticateRecoveryCode("recovered", "code")
    ).rejects.toThrow(/cannot be attributed/);
    expect(local.kv.get("backendAffinity")).toBeUndefined();
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("orphaned key or device state cannot be claimed as a fresh profile", async () => {
    for (const state of [
      { cryptoKey: "old-key" },
      { deviceId: "old-device" }
    ]) {
      const profile = harness(state);
      await expect(
        profile.user.authenticateRecoveryCode("recovered", "code")
      ).rejects.toThrow(/cannot be attributed/);
      expect(profile.kv.get("backendAffinity")).toBeUndefined();
    }
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("host change during code exchange rejects before account fetch or persistence", async () => {
    const { user, kv } = harness({});
    mockPost.mockImplementationOnce(async () => {
      hosts.API_HOST = NOTESNOOK.api;
      return {
        access_token: "recovery-exchange-host",
        refresh_token: "new-refresh"
      };
    });
    await expect(
      user.authenticateRecoveryCode("recovered", "code")
    ).rejects.toThrow(/Server settings changed/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(kv.get("token")).toBeUndefined();
    expect(kv.get("backendAffinity")).toBeUndefined();
  });

  test("host change during account fetch rejects before local commit", async () => {
    const { user, kv } = harness({});
    mockPost.mockResolvedValue({ access_token: "recovery-fetch-host" });
    mockGet.mockImplementationOnce(async () => {
      hosts.API_HOST = NOTESNOOK.api;
      return serverUser("recovered");
    });
    await expect(
      user.authenticateRecoveryCode("recovered", "code")
    ).rejects.toThrow(/Server settings changed/);
    expect(kv.get("token")).toBeUndefined();
    expect(kv.get("backendAffinity")).toBeUndefined();
  });

  test("failed local recovery commit restores the original account state", async () => {
    const oldUser = serverUser("recovered");
    const { user, kv, kvWrite } = harness({
      storedUser: oldUser,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth),
      lastSynced: 42,
      deviceId: "old-device"
    });
    mockPost.mockResolvedValue({
      access_token: "recovery-local-fault",
      refresh_token: "new-refresh"
    });
    mockGet.mockResolvedValue(serverUser("recovered"));
    kvWrite.mockImplementation(async (key: string, value: unknown) => {
      if (key === "token") throw new Error("token write failed");
      kv.set(key, value);
    });
    await expect(
      user.authenticateRecoveryCode("recovered", "code")
    ).rejects.toThrow("token write failed");
    expect(kv.get("token")).toBeUndefined();
    expect(kv.get("user")).toEqual(oldUser);
    expect(kv.get("lastSynced")).toBe(42);
    expect(kv.get("deviceId")).toBe("old-device");
    expect(kv.get("backendRecoveryRequired")).toBeUndefined();
  });
});

describe("uncached local data cannot be silently bound by signup or login", () => {
  test("signup and the first login step reject an unattributed note before any credential request", async () => {
    const signup = harness({ localContent: true });
    await expect(
      signup.user.signup("someone@example.test", "password")
    ).rejects.toThrow(/cannot be attributed/);
    expect(signup.kv.get("backendAffinity")).toBeUndefined();

    const login = harness({ localContent: true });
    await expect(
      login.user.authenticateEmail("someone@example.test")
    ).rejects.toThrow(/cannot be attributed/);
    expect(login.kv.get("backendAffinity")).toBeUndefined();
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("the final password step rejects uncached local data without relabeling", async () => {
    const { user, kv } = harness({ localContent: true });
    (user as any).pendingLogin = {
      email: "someone@example.test",
      token: {
        access_token: "mfa-stage-local-data",
        scope: "auth:grant_types:mfa_password"
      },
      backend: VEYRAN,
      serverSettings: "{}"
    };
    await expect(
      user.authenticatePassword("someone@example.test", "password")
    ).rejects.toThrow(/cannot be attributed/);
    expect(kv.get("backendAffinity")).toBeUndefined();
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("matching host affinity still refuses signup and login for orphaned notes", async () => {
    const signup = harness({
      localContent: true,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth)
    });
    await expect(
      signup.user.signup("someone@example.test", "password")
    ).rejects.toThrow(/cannot be attributed/);
    const login = harness({
      localContent: true,
      affinity: affinityRecord(VEYRAN.api, VEYRAN.auth)
    });
    await expect(
      login.user.authenticateEmail("someone@example.test")
    ).rejects.toThrow(/cannot be attributed/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("matching saved server hosts still refuse uncached local data", async () => {
    setPersistedHostOverrides({ API_HOST: VEYRAN.api, AUTH_HOST: VEYRAN.auth });
    const profile = harness({ localContent: true });
    await expect(
      profile.user.signup("someone@example.test", "password")
    ).rejects.toThrow(/cannot be attributed/);
    expect(profile.kv.get("backendAffinity")).toBeUndefined();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
