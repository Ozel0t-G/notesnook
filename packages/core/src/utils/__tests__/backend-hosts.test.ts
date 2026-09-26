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


import { test, describe, expect } from "vitest";
import hosts, { isServerCompatible } from "../constants.js";
import {
  normalizeBackendId,
  LEGACY_BACKEND_ID
} from "../../api/backend-affinity.js";

// vitest runs with NODE_ENV=test, and isProduction() in constants.ts treats
// "test" as production, so these assertions see the shipped production hosts.

const VEYRAN = "veyran.northcore.space";

describe("production backend hosts", () => {
  test("auth, sync, events and sharing all resolve to VeyraN", () => {
    expect(hosts.API_HOST).toBe("https://api.veyran.northcore.space");
    expect(hosts.AUTH_HOST).toBe("https://auth.veyran.northcore.space");
    expect(hosts.SSE_HOST).toBe("https://events.veyran.northcore.space");
    expect(hosts.MONOGRAPH_HOST).toBe("https://share.veyran.northcore.space");
  });

  test("no core host silently routes to Notesnook or Streetwriters", () => {
    for (const key of [
      "API_HOST",
      "AUTH_HOST",
      "SSE_HOST",
      "MONOGRAPH_HOST"
    ] as const) {
      expect(hosts[key], `${key} must be VeyraN-owned`).toContain(VEYRAN);
      expect(hosts[key]).not.toContain("notesnook.com");
      expect(hosts[key]).not.toContain("streetwriters.co");
    }
  });

  test("every core host is https", () => {
    for (const key of [
      "API_HOST",
      "AUTH_HOST",
      "SSE_HOST",
      "MONOGRAPH_HOST"
    ] as const) {
      expect(hosts[key].startsWith("https://"), `${key} must be https`).toBe(
        true
      );
    }
  });

  // Billing, pricing and issue reporting have no VeyraN deployment. They are
  // deliberately left upstream and are owned by the brand/entitlement branch;
  // this test documents that as intent so a future repoint is a conscious act.
  test("ancillary hosts remain upstream by design", () => {
    expect(hosts.SUBSCRIPTIONS_HOST).toBe(
      "https://subscriptions.streetwriters.co"
    );
    expect(hosts.ISSUES_HOST).toBe("https://issues.streetwriters.co");
    expect(hosts.NOTESNOOK_HOST).toBe("https://notesnook.com");
  });

  // The live VeyraN sync and events servers both report version 1.
  test("server compatibility gate accepts the deployed server version", () => {
    expect(isServerCompatible(1)).toBe(true);
    expect(isServerCompatible(2)).toBe(false);
  });
});

describe("normalizeBackendId", () => {
  test("reduces a host url to a comparable identity", () => {
    expect(normalizeBackendId("https://api.veyran.northcore.space")).toBe(
      "api.veyran.northcore.space"
    );
  });

  test("ignores cosmetic differences that are not a backend change", () => {
    const expected = "api.veyran.northcore.space";
    for (const input of [
      "https://api.veyran.northcore.space",
      "https://api.veyran.northcore.space/",
      "https://API.Veyran.Northcore.Space",
      "https://api.veyran.northcore.space:443",
      "api.veyran.northcore.space"
    ]) {
      expect(normalizeBackendId(input), input).toBe(expected);
    }
  });

  test("keeps a non-default port, which is a different backend", () => {
    expect(normalizeBackendId("http://localhost:5264")).toBe("localhost:5264");
    expect(normalizeBackendId("http://localhost:8264")).not.toBe(
      normalizeBackendId("http://localhost:5264")
    );
  });

  test("distinguishes the legacy backend from the configured one", () => {
    expect(LEGACY_BACKEND_ID).toBe("api.notesnook.com");
    expect(normalizeBackendId(hosts.API_HOST)).not.toBe(LEGACY_BACKEND_ID);
  });

  test("does not throw on empty or malformed input", () => {
    expect(normalizeBackendId("")).toBe("");
    expect(normalizeBackendId("  ")).toBe("");
  });
});
