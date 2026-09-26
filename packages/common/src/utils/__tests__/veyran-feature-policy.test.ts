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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_FEATURE_IDS,
  getFeature,
  getFeatureLimit,
  isFeatureAvailable
} from "../is-feature-available.js";
import {
  VEYRAN_CLIENT_SUPPORTED_FEATURES,
  VEYRAN_BACKEND_DEPENDENT_FEATURES,
  isVeyranClientSupported,
  isVeyranBackendDependent
} from "../veyran-feature-policy.js";

// The VeyraN policy resolves a feature's limit through `db.user.getUser()`.
// `mockUser` is mutable so individual tests below can simulate a real
// pre-existing paid or legacy Notesnook account signed into this app,
// instead of always asserting the (also real) case of a brand-new FREE
// account. vitest hoists `vi.mock` above these imports automatically.
let mockUser: { subscription?: { plan: number } } | undefined;
vi.mock("../../database.js", () => ({
  database: {
    user: { getUser: vi.fn(() => Promise.resolve(mockUser)) },
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

afterEach(() => {
  mockUser = undefined;
});

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

describe("VeyraN feature policy: a real paid or legacy Notesnook account cannot enable an unsupported service", () => {
  // A user can sign into VeyraN with an account that already has a genuine,
  // still-active Notesnook subscription from before VeyraN existed (sync and
  // auth are untouched here — only billing is disabled). This must not let
  // `notesnookCircle`, `monographAnalytics`, or `sms2FA` — none of which
  // VeyraN operates — read as available just because `subscription.plan`
  // says PRO/BELIEVER/LEGACY_PRO. `storage`/`fileSize` must likewise stay at
  // the FREE caption: VeyraN cannot verify that a paid tier's capacity still
  // applies here, so it does not infer it.
  const PAID_PLANS = {
    PRO: 2,
    BELIEVER: 3,
    EDUCATION: 4,
    LEGACY_PRO: 5
  } as const;

  for (const [planName, plan] of Object.entries(PAID_PLANS)) {
    describe(`account plan: ${planName}`, () => {
      it.each([...VEYRAN_BACKEND_DEPENDENT_FEATURES])(
        "%s still resolves the FREE-tier limit, not the account's real plan",
        async (id) => {
          mockUser = { subscription: { plan } };
          const feature = getFeature(id);
          const limit = await getFeatureLimit(feature);
          expect(limit).toBe(feature.availability.free);
        }
      );

      it.each([...VEYRAN_CLIENT_SUPPORTED_FEATURES])(
        "%s is still granted at the top tier regardless of the account's real plan",
        async (id) => {
          mockUser = { subscription: { plan } };
          const feature = getFeature(id);
          const limit = await getFeatureLimit(feature);
          expect(limit).toBe(feature.availability.believer);
        }
      );
    });
  }
});

describe("VeyraN feature policy: actual UI-facing outcomes (isFeatureAvailable)", () => {
  it("notesnookCircle is reported unavailable, with no 'plan' upsell wording, even on a paid account", async () => {
    mockUser = { subscription: { plan: 2 /* PRO */ } };
    const result = await isFeatureAvailable("notesnookCircle");
    expect(result.isAllowed).toBe(false);
    expect(result.error).toBe("Notesnook Circle isn't available in this app.");
    expect(result.error.toLowerCase()).not.toContain("plan");
  });

  it("sms2FA is reported unavailable, with no 'plan' upsell wording, even on a paid account", async () => {
    mockUser = { subscription: { plan: 3 /* BELIEVER */ } };
    const result = await isFeatureAvailable("sms2FA");
    expect(result.isAllowed).toBe(false);
    expect(result.error).toBe("SMS-based 2FA isn't available in this app.");
    expect(result.error.toLowerCase()).not.toContain("plan");
  });

  it("monographAnalytics is reported unavailable, with no 'plan' upsell wording, even on a legacy account", async () => {
    mockUser = { subscription: { plan: 5 /* LEGACY_PRO */ } };
    const result = await isFeatureAvailable("monographAnalytics");
    expect(result.isAllowed).toBe(false);
    expect(result.error).toBe(
      "Monograph analytics aren't available in this app."
    );
    expect(result.error.toLowerCase()).not.toContain("plan");
  });

  it("storage reports the real FREE-tier caption honestly, never 'not available on this plan'", async () => {
    mockUser = { subscription: { plan: 2 /* PRO */ } };
    const result = await isFeatureAvailable("storage");
    expect(result.caption).toBe("50MB/mo");
    expect(result.error.toLowerCase()).not.toContain("plan");
  });

  it("fileSize reports the real FREE-tier caption honestly, never 'on this plan'", async () => {
    mockUser = { subscription: { plan: 5 /* LEGACY_PRO */ } };
    const result = await isFeatureAvailable("fileSize");
    expect(result.caption).toBe("10MB");
    expect(result.error.toLowerCase()).not.toContain("plan");
  });

  it("a client-supported feature is allowed with no error, for a brand-new FREE account", async () => {
    const result = await isFeatureAvailable("taskList");
    expect(result.isAllowed).toBe(true);
  });
});
