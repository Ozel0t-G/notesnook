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

import { test, describe, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "../index.js";
import hosts, { getPersistedHostOverrides } from "../../utils/constants.js";
import {
  BackendAffinity,
  BackendMismatchError,
  StoredAffinity
} from "../backend-affinity.js";
import { Sync } from "../sync/index.js";
import EventManager from "../../utils/event-manager.js";
import type { User } from "../../types.js";

const VEYRAN = {
  api: "https://api.veyran.northcore.space",
  auth: "https://auth.veyran.northcore.space",
  sse: "https://events.veyran.northcore.space"
};
const NOTESNOOK = {
  api: "https://api.notesnook.com",
  auth: "https://auth.streetwriters.co"
};

const original = {
  api: hosts.API_HOST,
  auth: hosts.AUTH_HOST,
  sse: hosts.SSE_HOST
};

beforeEach(() => {
  hosts.API_HOST = VEYRAN.api;
  hosts.AUTH_HOST = VEYRAN.auth;
  hosts.SSE_HOST = VEYRAN.sse;
});
afterEach(() => {
  hosts.API_HOST = original.api;
  hosts.AUTH_HOST = original.auth;
  hosts.SSE_HOST = original.sse;
});

describe("Database.host validation", () => {
  test("rejects a malformed sync host and leaves the previous value in place", () => {
    const db = new Database();
    expect(() => db.host({ API_HOST: "not a url" })).toThrow(
      /Invalid backend host configuration/
    );
    expect(hosts.API_HOST).toBe(VEYRAN.api);
  });

  // Plaintext to a public host would expose session tokens and note content.
  test("rejects plaintext http to a public host", () => {
    const db = new Database();
    expect(() => db.host({ AUTH_HOST: "http://auth.example.com" })).toThrow(
      /must use https/
    );
    expect(hosts.AUTH_HOST).toBe(VEYRAN.auth);
  });

  test("rejects a scheme that is neither http nor https", () => {
    const db = new Database();
    expect(() => db.host({ SSE_HOST: "ws://events.example.com" })).toThrow(
      /unsupported scheme/
    );
  });

  test("rejects credentials embedded in a host", () => {
    const db = new Database();
    expect(() =>
      db.host({ API_HOST: "https://user:pw@api.example.com" })
    ).toThrow(/must not embed credentials/);
  });

  // The existing local and LAN development overrides must keep working.
  test("accepts the established development overrides", () => {
    const db = new Database();
    expect(() =>
      db.host({
        API_HOST: "http://localhost:5264",
        AUTH_HOST: "http://localhost:8264",
        SSE_HOST: "http://localhost:7264"
      })
    ).not.toThrow();
    expect(hosts.API_HOST).toBe("http://localhost:5264");

    expect(() =>
      db.host({
        API_HOST: "http://192.168.100.92:5264",
        AUTH_HOST: "http://192.168.100.92:8264",
        SSE_HOST: "http://192.168.100.92:7264"
      })
    ).not.toThrow();
  });

  test("a partial call leaves the unspecified hosts untouched", () => {
    const db = new Database();
    db.host({ API_HOST: "https://other.example.com" });
    expect(hosts.API_HOST).toBe("https://other.example.com");
    expect(hosts.AUTH_HOST).toBe(VEYRAN.auth);
  });

  test("persisted overrides are recorded only when supplied", () => {
    const db = new Database();
    db.host({ API_HOST: VEYRAN.api });
    expect(getPersistedHostOverrides()).toBeUndefined();

    db.host(
      { API_HOST: VEYRAN.api },
      { persistedOverrides: { API_HOST: VEYRAN.api, AUTH_HOST: VEYRAN.auth } }
    );
    expect(getPersistedHostOverrides()).toEqual({
      API_HOST: VEYRAN.api,
      AUTH_HOST: VEYRAN.auth
    });

    // An empty object must not be mistaken for evidence.
    db.host({ API_HOST: VEYRAN.api }, { persistedOverrides: {} });
    expect(getPersistedHostOverrides()).toBeUndefined();
  });
});

/**
 * The preflight must run before any socket is opened. The earlier version
 * checked affinity only after createConnection had already negotiated with the
 * sync host.
 */
describe("sync preflight", () => {
  function syncHarness(affinity?: StoredAffinity) {
    const kv = new Map<string, unknown>();
    kv.set("user", { id: "u1", email: "a@b.test" } as unknown as User);
    if (affinity) kv.set("backendAffinity", affinity);

    const createConnection = vi.fn();
    const db = {
      kv: () => ({
        read: async (k: string) => kv.get(k),
        write: async (k: string, v: unknown) => void kv.set(k, v),
        delete: async (k: string) => void kv.delete(k)
      }),
      storage: () => ({ read: async () => undefined }),
      eventManager: new EventManager(),
      user: { getUser: async () => kv.get("user") },
      tokenManager: { getAccessToken: async () => "token" }
    } as never;
    (
      db as unknown as { user: { backendAffinity: BackendAffinity } }
    ).user.backendAffinity = new BackendAffinity(db);

    const sync = new Sync(db);
    // Stubbed so the test fails if the guard runs too late to prevent the
    // connection being opened.
    (sync as unknown as { createConnection: unknown }).createConnection =
      createConnection;
    return { sync, db, createConnection, kv };
  }

  test("refuses to sync a profile bound to another backend, before connecting", async () => {
    const { sync, createConnection } = syncHarness({
      v: 1,
      api: NOTESNOOK.api,
      auth: NOTESNOOK.auth,
      recordedAt: 1
    });
    await expect(sync.start({ type: "full" })).rejects.toThrow(
      BackendMismatchError
    );
    expect(createConnection).not.toHaveBeenCalled();
  });

  test("refuses to sync an unattributable profile, before connecting", async () => {
    const { sync, createConnection } = syncHarness();
    await expect(sync.start({ type: "full" })).rejects.toThrow(
      /cannot be attributed/
    );
    expect(createConnection).not.toHaveBeenCalled();
  });

  test("a matching profile passes the preflight and proceeds to connect", async () => {
    const { sync, createConnection } = syncHarness({
      v: 1,
      api: VEYRAN.api,
      auth: VEYRAN.auth,
      recordedAt: 1
    });
    // createConnection is stubbed, so start() returns once it finds no
    // connection. Reaching that point proves the preflight allowed it through.
    await expect(sync.start({ type: "full" })).resolves.toBeUndefined();
    expect(createConnection).toHaveBeenCalledTimes(1);
  });
});
