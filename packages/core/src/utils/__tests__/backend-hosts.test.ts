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
  normalizeEndpoint,
  validateBackendConfiguration
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

describe("host configuration integrity", () => {
  test("the shipped production host set passes validation", () => {
    expect(
      validateBackendConfiguration({
        API_HOST: hosts.API_HOST,
        AUTH_HOST: hosts.AUTH_HOST,
        SSE_HOST: hosts.SSE_HOST
      })
    ).toEqual([]);
  });

  test("api, auth and events are three distinct endpoints", () => {
    const ids = [hosts.API_HOST, hosts.AUTH_HOST, hosts.SSE_HOST].map(
      normalizeEndpoint
    );
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).not.toBe("");
  });

  /**
   * Documents a surprising pre-existing behaviour rather than endorsing it:
   * isProduction() treats NODE_ENV="test" as production, so the test suite and
   * CI resolve the real production hosts. Pinned here so a change is deliberate
   * and visible. See artifacts/veyran-backend-audit.md section 11.
   */
  test("NODE_ENV=test resolves production hosts, not development ones", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(hosts.API_HOST).toBe("https://api.veyran.northcore.space");
    expect(hosts.API_HOST).not.toContain("localhost");
  });
});
