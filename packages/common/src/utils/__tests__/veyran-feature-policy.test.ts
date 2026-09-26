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

import { describe, expect, it, vi } from "vitest";
import { ALL_FEATURE_IDS, getFeature, getFeatureLimit } from "../is-feature-available.js";
import {
  VEYRAN_CLIENT_SUPPORTED_FEATURES,
  VEYRAN_BACKEND_DEPENDENT_FEATURES,
  isVeyranClientSupported,
  isVeyranBackendDependent
} from "../veyran-feature-policy.js";

// The VeyraN policy resolves a feature's limit through `db.user.getUser()`.
// Every VeyraN account is permanently on the FREE plan (billing is
// disabled), so this mock stands in for that reality without needing a real
// database. vitest hoists `vi.mock` above these imports automatically.
vi.mock("../../database.js", () => ({
  database: {
    user: { getUser: vi.fn().mockResolvedValue(undefined) },
    colors: { all: { count: vi.fn().mockResolvedValue(0) } },
    tags: { all: { count: vi.fn().mockResolvedValue(0) } },
    notebooks: { all: { count: vi.fn().mockResolvedValue(0) } },
    reminders: { active: { count: vi.fn().mockResolvedValue(0) } },
    shortcuts: { all: [] },
    eventManager: { subscribe: vi.fn() }
  }
}));

// This is a unit test of the pure feature-policy logic, so `@notesnook/core`
// is mocked down to the one enum this file needs. That keeps the test from
// depending on core's build output (and, transitively, on
// `@notesnook/crypto`/`@notesnook/intl` being built) — this file, unlike the
// billing-policy tests in `@notesnook/core`, isn't asserting anything about
// core's own behavior.
vi.mock("@notesnook/core", () => ({
  SubscriptionPlan: {
    FREE: 0,
    ESSENTIAL: 1,
    PRO: 2,
    BELIEVER: 3,
    EDUCATION: 4,
    LEGACY_PRO: 5
  }
}));

describe("VeyraN feature policy classification", () => {
  it("classifies every known feature exactly once (no gaps, no overlap)", () => {
    const client = new Set(VEYRAN_CLIENT_SUPPORTED_FEATURES);
    const backend = new Set(VEYRAN_BACKEND_DEPENDENT_FEATURES);

    for (const id of client) expect(backend.has(id)).toBe(false);

    const unclassified = ALL_FEATURE_IDS.filter(
      (id) => !client.has(id) && !backend.has(id)
    );
    expect(unclassified).toEqual([]);

    // Guard against the classification sets drifting stale if a feature is
    // ever removed from is-feature-available.ts without updating this file.
    const unknown = [...client, ...backend].filter(
      (id) => !ALL_FEATURE_IDS.includes(id)
    );
    expect(unknown).toEqual([]);
  });

  it("never treats a feature as both client-supported and backend-dependent", () => {
    for (const id of ALL_FEATURE_IDS) {
      expect(isVeyranClientSupported(id) && isVeyranBackendDependent(id)).toBe(
        false
      );
    }
  });
});

describe("VeyraN feature policy: client-supported features are fully unlocked", () => {
  it.each([...VEYRAN_CLIENT_SUPPORTED_FEATURES])(
    "%s resolves the believer-tier limit for a FREE (unpaid) VeyraN account",
    async (id) => {
      const feature = getFeature(id);
      const limit = await getFeatureLimit(feature);
      expect(limit).toBe(feature.availability.believer);
    }
  );
});

describe("VeyraN feature policy: backend-dependent features stay honest", () => {
  it.each([...VEYRAN_BACKEND_DEPENDENT_FEATURES])(
    "%s keeps the real (FREE-plan) limit instead of being unlocked",
    async (id) => {
      const feature = getFeature(id);
      const limit = await getFeatureLimit(feature);
      expect(limit).toBe(feature.availability.free);
      expect(limit).not.toBe(feature.availability.believer);
    }
  );

  it("does not fake a paid plan: none of these are silently allowed", async () => {
    for (const id of VEYRAN_BACKEND_DEPENDENT_FEATURES) {
      const feature = getFeature(id);
      const limit = await getFeatureLimit(feature);
      // FREE-tier availability for every current backend-dependent feature
      // is `false`/a small numeric cap, never true/infinity — i.e. nothing
      // here is quietly granted the way a blanket `isPro = true` would.
      expect(limit.value).not.toBe(true);
      expect(limit.value).not.toBe(Infinity);
    }
  });
});
