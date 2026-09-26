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

import { test, describe, expect, beforeEach, afterEach } from "vitest";
import hosts from "../../utils/constants.js";
import { BackendAffinity, LEGACY_BACKEND_ID } from "../backend-affinity.js";
import type Database from "../index.js";
import type { User } from "../../types.js";

/**
 * Minimal stand-in for the parts of Database that BackendAffinity touches. The
 * real database needs a native sqlite binding, which this test deliberately
 * avoids so the guard logic stays fast to verify.
 */
function fakeDb(options: { user?: Partial<User>; affinity?: string }) {
  const kv = new Map<string, unknown>();
  if (options.affinity !== undefined)
    kv.set("backendAffinity", options.affinity);
  return {
    db: {
      kv: () => ({
        read: async (key: string) => kv.get(key),
        write: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key)
      }),
      user: {
        getUser: async () => options.user
      }
    } as unknown as Database,
    kv
  };
}

const CONFIGURED = "api.veyran.northcore.space";
const originalApiHost = hosts.API_HOST;

beforeEach(() => {
  hosts.API_HOST = "https://api.veyran.northcore.space";
});
afterEach(() => {
  hosts.API_HOST = originalApiHost;
});

describe("BackendAffinity.check", () => {
  test("a logged out profile has nothing to protect", async () => {
    const { db } = fakeDb({});
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("no-user");
  });

  test("matches when recorded affinity equals the configured host", async () => {
    const { db } = fakeDb({ user: { id: "u1" }, affinity: CONFIGURED });
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("match");
    expect(result.inferred).toBe(false);
  });

  // This is the regression guard for the data-destruction path: a profile that
  // was logged into Notesnook cloud before affinity tracking existed has no
  // stored affinity, and must be recognised as foreign rather than assumed
  // local. See artifacts/veyran-backend-audit.md section 5.1.
  test("an untracked legacy profile is treated as Notesnook cloud, not as a match", async () => {
    const { db } = fakeDb({ user: { id: "legacy" } });
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("mismatch");
    expect(result.stored).toBe(LEGACY_BACKEND_ID);
    expect(result.inferred).toBe(true);
    expect(result.configured).toBe(CONFIGURED);
  });

  test("an untracked profile still matches when configured against the legacy host", async () => {
    hosts.API_HOST = "https://api.notesnook.com";
    const { db } = fakeDb({ user: { id: "legacy" } });
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("match");
    expect(result.inferred).toBe(true);
  });

  test("mismatches when the profile belongs to another backend", async () => {
    const { db } = fakeDb({
      user: { id: "u1" },
      affinity: "api.somewhere-else.example"
    });
    const affinity = new BackendAffinity(db);
    expect(await affinity.isMismatched()).toBe(true);
  });

  test("a cosmetic host difference is not treated as a backend change", async () => {
    const { db } = fakeDb({ user: { id: "u1" }, affinity: CONFIGURED });
    hosts.API_HOST = "https://API.Veyran.Northcore.Space/";
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("match");
  });

  test("switching hosts under a recorded profile is a mismatch", async () => {
    const { db } = fakeDb({ user: { id: "u1" }, affinity: CONFIGURED });
    hosts.API_HOST = "https://api.notesnook.com";
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("mismatch");
    expect(result.stored).toBe(CONFIGURED);
    expect(result.configured).toBe(LEGACY_BACKEND_ID);
  });
});

describe("BackendAffinity.record", () => {
  test("binds the profile to the configured backend", async () => {
    const { db, kv } = fakeDb({ user: { id: "u1" } });
    const affinity = new BackendAffinity(db);

    // Before recording, an untracked logged-in profile reads as legacy.
    expect((await affinity.check()).status).toBe("mismatch");

    await affinity.record();

    expect(kv.get("backendAffinity")).toBe(CONFIGURED);
    expect((await affinity.check()).status).toBe("match");
  });

  test("clear removes the binding", async () => {
    const { db, kv } = fakeDb({ user: { id: "u1" }, affinity: CONFIGURED });
    const affinity = new BackendAffinity(db);
    await affinity.clear();
    expect(kv.has("backendAffinity")).toBe(false);
  });
});
