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
import hosts, { setPersistedHostOverrides } from "../../utils/constants.js";
import {
  BackendAffinity,
  BackendMismatchError,
  normalizeEndpoint,
  validateEndpoint,
  validateBackendConfiguration,
  StoredAffinity
} from "../backend-affinity.js";
import type Database from "../index.js";
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

function record(api: string, auth: string): StoredAffinity {
  return { v: 1, api, auth, recordedAt: 1 };
}

/**
 * Stand-in for the parts of Database that BackendAffinity touches. The real
 * database needs a native sqlite binding, which these tests deliberately avoid.
 */
function fakeDb(options: {
  user?: Partial<User>;
  affinity?: StoredAffinity | string;
}) {
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
      user: { getUser: async () => options.user }
    } as unknown as Database,
    kv
  };
}

const original = { api: hosts.API_HOST, auth: hosts.AUTH_HOST };

beforeEach(() => {
  hosts.API_HOST = VEYRAN.api;
  hosts.AUTH_HOST = VEYRAN.auth;
  setPersistedHostOverrides(undefined);
});
afterEach(() => {
  hosts.API_HOST = original.api;
  hosts.AUTH_HOST = original.auth;
  setPersistedHostOverrides(undefined);
});

describe("normalizeEndpoint", () => {
  test("ignores differences that are not a backend change", () => {
    const expected = "https://api.veyran.northcore.space";
    for (const input of [
      "https://api.veyran.northcore.space",
      "https://api.veyran.northcore.space/",
      "https://API.Veyran.Northcore.Space",
      "https://api.veyran.northcore.space:443",
      "  https://api.veyran.northcore.space  "
    ]) {
      expect(normalizeEndpoint(input), input).toBe(expected);
    }
  });

  // A downgrade to plaintext is a different trust level, not the same backend.
  test("scheme is significant", () => {
    expect(normalizeEndpoint("http://api.example.com")).not.toBe(
      normalizeEndpoint("https://api.example.com")
    );
  });

  test("base path is significant", () => {
    expect(normalizeEndpoint("https://host.example/api")).toBe(
      "https://host.example/api"
    );
    expect(normalizeEndpoint("https://host.example/api")).not.toBe(
      normalizeEndpoint("https://host.example")
    );
  });

  test("non-default port is significant", () => {
    expect(normalizeEndpoint("http://localhost:5264")).toBe(
      "http://localhost:5264"
    );
    expect(normalizeEndpoint("http://localhost:5264")).not.toBe(
      normalizeEndpoint("http://localhost:8264")
    );
  });

  test("unusable input yields an empty identity, never a wildcard", () => {
    for (const bad of [
      "",
      "   ",
      "not a url",
      "ftp://host",
      "//host",
      "host"
    ]) {
      expect(normalizeEndpoint(bad), bad).toBe("");
    }
  });
});

describe("endpoint validation", () => {
  test("accepts https and loopback/private http, rejecting the rest", () => {
    expect(
      validateEndpoint("API_HOST", "https://api.example.com")
    ).toBeUndefined();
    expect(
      validateEndpoint("API_HOST", "http://localhost:5264")
    ).toBeUndefined();
    expect(
      validateEndpoint("API_HOST", "http://127.0.0.1:5264")
    ).toBeUndefined();
    expect(
      validateEndpoint("API_HOST", "http://192.168.1.10:5264")
    ).toBeUndefined();

    // Plaintext to a public host would expose session tokens and note content.
    expect(
      validateEndpoint("API_HOST", "http://api.example.com")
    ).toBeDefined();
    expect(validateEndpoint("API_HOST", "ftp://api.example.com")).toBeDefined();
    expect(validateEndpoint("API_HOST", "not a url")).toBeDefined();
    expect(validateEndpoint("API_HOST", "")).toBeDefined();
    expect(
      validateEndpoint("API_HOST", "https://user:pw@api.example.com")
    ).toBeDefined();
    expect(
      validateEndpoint("API_HOST", "https://api.example.com?x=1")
    ).toBeDefined();
  });

  test("reports every offending host at once", () => {
    const errors = validateBackendConfiguration({
      API_HOST: "http://public.example.com",
      AUTH_HOST: "nonsense",
      SSE_HOST: VEYRAN.sse
    });
    expect(errors.map((e) => e.host).sort()).toEqual(["API_HOST", "AUTH_HOST"]);
  });

  test("the shipped production configuration is valid", () => {
    expect(
      validateBackendConfiguration({
        API_HOST: original.api,
        AUTH_HOST: original.auth,
        SSE_HOST: hosts.SSE_HOST
      })
    ).toEqual([]);
  });
});

describe("check", () => {
  test("a logged out profile has nothing to protect", async () => {
    const { db } = fakeDb({});
    expect((await new BackendAffinity(db).check()).status).toBe("no-user");
  });

  test("matches when both api and auth agree", async () => {
    const { db } = fakeDb({
      user: { id: "u" },
      affinity: record(VEYRAN.api, VEYRAN.auth)
    });
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("match");
    expect(result.evidence).toBe("record");
  });

  // The identity server is a separate trust boundary: a token minted elsewhere
  // is worthless here and presenting it historically triggered a wipe.
  test("mismatches when only the auth host differs", async () => {
    const { db } = fakeDb({
      user: { id: "u" },
      affinity: record(VEYRAN.api, NOTESNOOK.auth)
    });
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("mismatch");
    expect(result.mismatched).toEqual(["auth"]);
  });

  test("mismatches when only the api host differs", async () => {
    const { db } = fakeDb({
      user: { id: "u" },
      affinity: record(NOTESNOOK.api, VEYRAN.auth)
    });
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("mismatch");
    expect(result.mismatched).toEqual(["api"]);
  });

  /**
   * The v1 regression. An unrecorded profile was assumed to be Notesnook, so a
   * pre-affinity VeyraN profile read as "match" whenever the client happened to
   * be configured at Notesnook, and its notes would have been uploaded there.
   * An unattributable profile must block in BOTH directions.
   */
  test("an unattributable profile is unknown, not assumed, in either direction", async () => {
    const { db } = fakeDb({ user: { id: "legacy" } });
    const affinity = new BackendAffinity(db);

    hosts.API_HOST = VEYRAN.api;
    hosts.AUTH_HOST = VEYRAN.auth;
    expect((await affinity.check()).status).toBe("unknown");

    hosts.API_HOST = NOTESNOOK.api;
    hosts.AUTH_HOST = NOTESNOOK.auth;
    expect((await affinity.check()).status).toBe("unknown");

    expect(await affinity.isBlocked()).toBe(true);
  });

  // Pre-affinity profiles that already used VeyraN are distinguishable when the
  // user had explicitly saved those URLs.
  test("persisted server configuration attributes an unrecorded profile", async () => {
    const { db } = fakeDb({ user: { id: "legacy" } });
    setPersistedHostOverrides({
      API_HOST: VEYRAN.api,
      AUTH_HOST: VEYRAN.auth
    });
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("match");
    expect(result.evidence).toBe("persisted-config");
  });

  test("persisted configuration for another backend is a mismatch, not a wipe", async () => {
    const { db } = fakeDb({ user: { id: "legacy" } });
    setPersistedHostOverrides({
      API_HOST: NOTESNOOK.api,
      AUTH_HOST: NOTESNOOK.auth
    });
    const result = await new BackendAffinity(db).check();
    expect(result.status).toBe("mismatch");
    expect(result.evidence).toBe("persisted-config");
  });

  test("a half-configured override settles nothing", async () => {
    const { db } = fakeDb({ user: { id: "legacy" } });
    setPersistedHostOverrides({ API_HOST: VEYRAN.api });
    expect((await new BackendAffinity(db).check()).status).toBe("unknown");
  });

  // Written by an earlier build of this branch; too little information to trust.
  test("a pre-release bare-string record is discarded, not upgraded", async () => {
    const { db } = fakeDb({
      user: { id: "u" },
      affinity: "api.veyran.northcore.space"
    });
    const affinity = new BackendAffinity(db);
    expect(await affinity.get()).toBeUndefined();
    expect((await affinity.check()).status).toBe("unknown");
  });

  test("a cosmetic host difference is not a backend change", async () => {
    const { db } = fakeDb({
      user: { id: "u" },
      affinity: record(VEYRAN.api, VEYRAN.auth)
    });
    hosts.API_HOST = "https://API.Veyran.Northcore.Space/";
    expect((await new BackendAffinity(db).check()).status).toBe("match");
  });
});

describe("record", () => {
  test("binds a profile that has no account yet", async () => {
    const { db, kv } = fakeDb({});
    const affinity = new BackendAffinity(db);
    const outcome = await affinity.record();
    expect(outcome.ok).toBe(true);
    expect(kv.get("backendAffinity")).toMatchObject({
      v: 1,
      api: VEYRAN.api,
      auth: VEYRAN.auth
    });
  });

  /**
   * Round-2 regression. record() previously consulted only the stored record, so
   * a profile with existing notes and no record was bound on the strength of a
   * fresh login. An unattributable profile must never be adopted silently.
   */
  test("refuses to adopt an unattributable profile that already has an account", async () => {
    const { db, kv } = fakeDb({ user: { id: "legacy" } });
    const outcome = await new BackendAffinity(db).record();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.conflict.status).toBe("unknown");
    expect(kv.has("backendAffinity")).toBe(false);
  });

  /**
   * Round-2 regression. Explicitly saved Notesnook hosts are evidence, but
   * record() ignored them because there was no stored record, so a fresh VeyraN
   * login could rebind the profile.
   */
  test("refuses to rebind when saved server configuration names another backend", async () => {
    const { db, kv } = fakeDb({ user: { id: "legacy" } });
    setPersistedHostOverrides({
      API_HOST: NOTESNOOK.api,
      AUTH_HOST: NOTESNOOK.auth
    });
    const outcome = await new BackendAffinity(db).record();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.conflict.status).toBe("mismatch");
      expect(outcome.conflict.evidence).toBe("persisted-config");
    }
    expect(kv.has("backendAffinity")).toBe(false);
  });

  // Agreement implied by configuration is promoted to a durable record, so the
  // attribution survives a later change to those settings.
  test("promotes matching saved configuration to a stored record", async () => {
    const { db, kv } = fakeDb({ user: { id: "legacy" } });
    setPersistedHostOverrides({
      API_HOST: VEYRAN.api,
      AUTH_HOST: VEYRAN.auth
    });
    const outcome = await new BackendAffinity(db).record();
    expect(outcome).toMatchObject({ ok: true, changed: true });
    expect(kv.get("backendAffinity")).toMatchObject({
      v: 1,
      api: VEYRAN.api,
      auth: VEYRAN.auth
    });

    // Still attributed once the saved configuration is gone.
    setPersistedHostOverrides(undefined);
    expect((await new BackendAffinity(db).check()).status).toBe("match");
  });

  // Relabelling is the mechanism by which legacy notes would be uploaded to a
  // backend that never owned them.
  test("refuses to relabel a profile bound elsewhere, leaving the record intact", async () => {
    const stored = record(NOTESNOOK.api, NOTESNOOK.auth);
    const { db, kv } = fakeDb({ user: { id: "u" }, affinity: stored });
    const outcome = await new BackendAffinity(db).record();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.conflict.status).toBe("mismatch");
    expect(kv.get("backendAffinity")).toEqual(stored);
  });

  test("re-recording the same backend is a no-op", async () => {
    const { db } = fakeDb({
      user: { id: "u" },
      affinity: record(VEYRAN.api, VEYRAN.auth)
    });
    const outcome = await new BackendAffinity(db).record();
    expect(outcome).toMatchObject({ ok: true, changed: false });
  });

  test("refuses to record against an invalid configuration", async () => {
    const { db } = fakeDb({ user: { id: "u" } });
    hosts.API_HOST = "not a url";
    await expect(new BackendAffinity(db).record()).rejects.toThrow(
      /not valid absolute URLs/
    );
  });
});

describe("assertAllowed", () => {
  test("permits a matching backend", async () => {
    const { db } = fakeDb({
      user: { id: "u" },
      affinity: record(VEYRAN.api, VEYRAN.auth)
    });
    await expect(
      new BackendAffinity(db).assertAllowed("Sync")
    ).resolves.toBeDefined();
  });

  test("permits a profile with no account", async () => {
    const { db } = fakeDb({});
    await expect(
      new BackendAffinity(db).assertAllowed("Sync")
    ).resolves.toBeDefined();
  });

  test("blocks a mismatch and an unknown", async () => {
    for (const affinity of [record(NOTESNOOK.api, NOTESNOOK.auth), undefined]) {
      const { db } = fakeDb({ user: { id: "u" }, affinity });
      await expect(
        new BackendAffinity(db).assertAllowed("Sync")
      ).rejects.toThrow(BackendMismatchError);
    }
  });

  test("the error explains local data is retained", async () => {
    const { db } = fakeDb({
      user: { id: "u" },
      affinity: record(NOTESNOOK.api, NOTESNOOK.auth)
    });
    await expect(new BackendAffinity(db).assertAllowed("Sync")).rejects.toThrow(
      /Local notes remain available/
    );
  });
});

describe("adoptCurrentBackend", () => {
  const unattributed = { user: { id: "legacy" } };

  test("requires explicit user confirmation", async () => {
    const { db, kv } = fakeDb(unattributed);
    await expect(
      new BackendAffinity(db).adoptCurrentBackend({
        confirmedByUser: false,
        verifiedAgainstBackend: true
      })
    ).rejects.toThrow(/explicit user confirmation/);
    expect(kv.has("backendAffinity")).toBe(false);
  });

  test("requires verification against the configured backend", async () => {
    const { db, kv } = fakeDb(unattributed);
    await expect(
      new BackendAffinity(db).adoptCurrentBackend({
        confirmedByUser: true,
        verifiedAgainstBackend: false
      })
    ).rejects.toThrow(/verified response/);
    expect(kv.has("backendAffinity")).toBe(false);
  });

  test("adopts an unattributable profile once both conditions hold", async () => {
    const { db } = fakeDb(unattributed);
    const affinity = new BackendAffinity(db);
    const result = await affinity.adoptCurrentBackend({
      confirmedByUser: true,
      verifiedAgainstBackend: true
    });
    expect(result.status).toBe("match");
  });

  // Moving data between two known backends is a migration, not a checkbox.
  test("refuses to move a profile that is already bound elsewhere", async () => {
    const stored = record(NOTESNOOK.api, NOTESNOOK.auth);
    const { db, kv } = fakeDb({ user: { id: "u" }, affinity: stored });
    await expect(
      new BackendAffinity(db).adoptCurrentBackend({
        confirmedByUser: true,
        verifiedAgainstBackend: true
      })
    ).rejects.toThrow(/already bound or explicitly configured/);
    expect(kv.get("backendAffinity")).toEqual(stored);
  });

  test("explicit adoption cannot override a saved server selection", async () => {
    const { db, kv } = fakeDb({ user: { id: "legacy" } });
    setPersistedHostOverrides({
      API_HOST: NOTESNOOK.api,
      AUTH_HOST: NOTESNOOK.auth
    });
    await expect(
      new BackendAffinity(db).adoptCurrentBackend({
        confirmedByUser: true,
        verifiedAgainstBackend: true
      })
    ).rejects.toThrow(/explicitly configured for a different backend/);
    expect(kv.has("backendAffinity")).toBe(false);
  });

  test("one mismatched explicit endpoint is enough to refuse adoption", async () => {
    const { db, kv } = fakeDb({ user: { id: "legacy" } });
    setPersistedHostOverrides({ API_HOST: NOTESNOOK.api });
    await expect(
      new BackendAffinity(db).adoptCurrentBackend({
        confirmedByUser: true,
        verifiedAgainstBackend: true
      })
    ).rejects.toThrow(/explicitly configured for a different backend/);
    expect(kv.has("backendAffinity")).toBe(false);
  });
});
