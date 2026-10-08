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
  VEYRAN_SERVICE_MANAGED_LIMITS,
  VEYRAN_BACKEND_DEPENDENT_FEATURES,
  isVeyranClientSupported,
  isVeyranServiceManaged,
  isVeyranBackendDependent
} from "../veyran-feature-policy.js";

// `mockUser` simulates a real pre-existing paid or legacy Notesnook account
// signed into this app. Current features are all classified by the VeyraN
// policy, so `getPlanFor` short-circuits and does not actually read the
// account; these tests still guard the policy branches (a backend-dependent
// feature must resolve at the FREE tier even if the plan were consulted).
// vitest hoists `vi.mock` above these imports automatically.
let mockUser: { subscription?: { plan: number } } | undefined;
// Overrides the user lookup for the signed-out cases below (a pending or
// failing local database read). Left undefined everywhere else so the other
// tests keep reading `mockUser`.
let mockUserLookup:
  | (() => Promise<{ subscription?: { plan: number } } | undefined>)
  | undefined;
vi.mock("../../database.js", () => ({
  database: {
    user: {
      getUser: vi.fn(() =>
        mockUserLookup ? mockUserLookup() : Promise.resolve(mockUser)
      )
    },
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
  mockUserLookup = undefined;
});

/** Fails the test instead of hanging the whole run when a promise that must
 * resolve immediately (a plan-independent feature) never settles. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
  };
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      clear();
      reject(new Error(`did not resolve within ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).then(
    (value) => {
      clear();
      return value;
    },
    (error) => {
      clear();
      throw error;
    }
  );
}

describe("VeyraN feature policy classification", () => {
  it("classifies every known feature into exactly one of the three buckets (no gaps, no overlap)", () => {
    const client = new Set(VEYRAN_CLIENT_SUPPORTED_FEATURES);
    const verified = new Set(VEYRAN_SERVICE_MANAGED_LIMITS);
    const backend = new Set(VEYRAN_BACKEND_DEPENDENT_FEATURES);
    const buckets = [client, verified, backend];

    for (const id of ALL_FEATURE_IDS) {
      const memberships = buckets.filter((bucket) => bucket.has(id)).length;
      expect(memberships).toBe(1);
    }

    const unclassified = ALL_FEATURE_IDS.filter(
      (id) => !client.has(id) && !verified.has(id) && !backend.has(id)
    );
    expect(unclassified).toEqual([]);

    // Guard against the classification sets drifting stale if a feature is
    // ever removed from is-feature-available.ts without updating this file.
    const unknown = [...client, ...verified, ...backend].filter(
      (id) => !ALL_FEATURE_IDS.includes(id)
    );
    expect(unknown).toEqual([]);
  });

  it("never treats a feature as belonging to more than one bucket", () => {
    for (const id of ALL_FEATURE_IDS) {
      const flags = [
        isVeyranClientSupported(id),
        isVeyranServiceManaged(id),
        isVeyranBackendDependent(id)
      ];
      expect(flags.filter(Boolean).length).toBe(1);
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

describe("VeyraN feature policy: a real paid or legacy Notesnook account", () => {
  // An existing local account can retain a legacy paid plan value. It must not let
  // `notesnookCircle`, `monographAnalytics`, or `sms2FA` — none of which
  // VeyraN operates — read as available just because `subscription.plan`
  // says PRO/BELIEVER/LEGACY_PRO.
  const PAID_PLANS = {
    PRO: 2,
    BELIEVER: 3,
    EDUCATION: 4,
    LEGACY_PRO: 5
  } as const;

  for (const [planName, plan] of Object.entries(PAID_PLANS)) {
    describe(`account plan: ${planName}`, () => {
      it.each([...VEYRAN_BACKEND_DEPENDENT_FEATURES])(
        "%s still resolves the FREE-tier limit, not the account's real plan (unsupported service)",
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

      it.each([...VEYRAN_SERVICE_MANAGED_LIMITS])(
        "%s ignores a legacy plan value and defers numeric limits to the service",
        async (id) => {
          mockUser = { subscription: { plan } };
          const feature = getFeature(id);
          const limit = await getFeatureLimit(feature);
          expect(limit.caption).toBe("Service-managed");
          expect(await limit.isAllowed(100 * 1024 * 1024)).toBe(true);
          expect(limit).not.toBe(feature.availability.free);
        }
      );
    });
  }

  it("service limits do not invent FREE capacity for a new account", async () => {
    mockUser = { subscription: { plan: 0 /* FREE */ } };
    for (const id of VEYRAN_SERVICE_MANAGED_LIMITS) {
      const feature = getFeature(id);
      const limit = await getFeatureLimit(feature);
      expect(limit.caption).toBe("Service-managed");
    }
  });
});

describe("VeyraN feature policy: actual UI-facing outcomes (isFeatureAvailable)", () => {
  it("notesnookCircle is reported unavailable, with no 'plan' upsell wording, even on a paid account", async () => {
    mockUser = { subscription: { plan: 2 /* PRO */ } };
    const result = await isFeatureAvailable("notesnookCircle");
    expect(result.isAllowed).toBe(false);
    expect(result.error).toBe(
      "The partner marketplace isn't available in VeyraN."
    );
    expect(result.availableOn).toBeUndefined();
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

  it("storage uses a service-managed limit, never a legacy plan tier", async () => {
    const result = await isFeatureAvailable("storage");
    expect(result.caption).toBe("Service-managed");
    expect(result.isAllowed).toBe(true);
    expect(result.error.toLowerCase()).not.toContain("plan");
  });

  it("fileSize allows a service-validated upload without claiming a client tier", async () => {
    const result = await isFeatureAvailable("fileSize", 11 * 1024 * 1024);
    expect(result.caption).toBe("Service-managed");
    expect(result.isAllowed).toBe(true);
    expect(result.error.toLowerCase()).not.toContain("plan");
  });

  it("storage ignores a pre-existing PRO plan as a VeyraN capacity claim", async () => {
    mockUser = { subscription: { plan: 2 /* PRO */ } };
    const result = await isFeatureAvailable("storage");
    expect(result.caption).toBe("Service-managed");
  });

  it("fileSize ignores a legacy paid plan as a VeyraN capacity claim", async () => {
    mockUser = { subscription: { plan: 5 /* LEGACY_PRO */ } };
    const result = await isFeatureAvailable("fileSize");
    expect(result.caption).toBe("Service-managed");
  });

  it("a client-supported feature is allowed with no error, for a brand-new FREE account", async () => {
    const result = await isFeatureAvailable("taskList");
    expect(result.isAllowed).toBe(true);
  });
});

describe("VeyraN feature policy: local/unauthenticated (signed-out) mode", () => {
  /**
   * Regression: a fresh local/offline install has no account. Reading the
   * account goes through the database KV store (`db.user.getUser()`), which
   * for a signed-out local database has no `user` row to return: it can
   * reject, and before `db.init()` resolves it can remain pending.
   *
   * `getFeatureLimit` used to await that lookup *before* applying the VeyraN
   * policy, so a client-supported feature such as App lock — which never
   * consults the account at all — could resolve late or never, depending on
   * what the KV lookup did. On the iPad Settings popover this showed Passcode
   * Lock enabled and crown-free, yet tapping it did nothing, because the
   * action-time gate awaited the same unresolved check (see feature-gate.ts).
   * App lock must resolve from the policy alone, without an account, whether
   * the lookup rejects or never settles.
   */
  const signedOutLookup = () => Promise.reject(new Error("no such table: kv"));

  it("resolves a client-supported feature even when the user record never arrives", async () => {
    mockUserLookup = () =>
      new Promise<{ subscription?: { plan: number } } | undefined>(() => {});
    const result = await withTimeout(isFeatureAvailable("appLock"), 1000);
    expect(result.isAllowed).toBe(true);
    // Allowed: nothing to upgrade to, so no "available on plan X" upsell.
    expect(result.availableOn).toBeUndefined();
  });

  it("resolves a client-supported feature when the user lookup fails", async () => {
    mockUserLookup = signedOutLookup;
    const result = await isFeatureAvailable("appLock");
    expect(result.isAllowed).toBe(true);
  });

  it("still denies every backend-dependent feature when the user lookup fails", async () => {
    mockUserLookup = signedOutLookup;
    for (const id of VEYRAN_BACKEND_DEPENDENT_FEATURES) {
      const result = await isFeatureAvailable(id);
      expect(result.isAllowed).toBe(false);
    }
  });

  it("keeps sms2FA fail-closed with no upsell wording when the user lookup fails", async () => {
    mockUserLookup = signedOutLookup;
    const result = await isFeatureAvailable("sms2FA");
    expect(result.isAllowed).toBe(false);
    expect(result.error).toBe("SMS-based 2FA isn't available in this app.");
    expect(result.error.toLowerCase()).not.toContain("plan");
  });

  it("does not invent a paid plan for an absent (signed-out) user record", async () => {
    mockUser = undefined;
    const result = await isFeatureAvailable("monographAnalytics");
    expect(result.isAllowed).toBe(false);
    expect(result.caption).toBe(false);
  });
});
