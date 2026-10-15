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

// Discriminating regression tests for the VeyraN SIWC *beginAuth* seam.
//
// The native module is a jest double and the lifecycle stores expose the exact
// authoritative fields the eligibility proof reads, so every case exercises the
// real fail-closed gate and the real attempt/adoption fencing. No network, no
// Keychain, no token: the double only records the bounded calls. A scripted
// native rejection carries a raw string only to prove it is *never* surfaced.

type BeginAuthScript =
  | { kind: "reject"; code: unknown }
  | { kind: "reject_raw"; value: unknown }
  | { kind: "false" }
  | { kind: "raw"; value: unknown };

const mockState = {
  accountId: "account-A" as string | null,
  dbInitialized: true,
  isAppLoading: false,
  appLocked: false,
  isLoggingOut: false,
  accountSetupRequired: false,
  userStoreThrows: false,
  beginAuthGate: undefined as Promise<void> | undefined,
  beginAuthScripts: [] as BeginAuthScript[],
  beginAuthGeneration: 1,
  beginAuthProviderEpoch: 4,
  beginAuthCalls: [] as Array<{ mode: string; accountId: string }>,
  cancelAuthCalls: 0,
  logs: [] as string[]
};

let mockNativeListener: ((payload: unknown) => void) | undefined;

const mockFns = {
  getStatus: jest.fn(async () => ({ supported: true })),
  statusForAccount: jest.fn(async (_accountId: string) => ({
    signedIn: true,
    status: "ready" as const,
    subject: "chatgpt-user",
    clientId: "issued-client",
    hasDirectScopes: true
  })),
  beginAuth: jest.fn(async (mode: string, accountId: string) => {
    mockState.beginAuthCalls.push({ mode, accountId });
    if (mockState.beginAuthGate) await mockState.beginAuthGate;
    const script = mockState.beginAuthScripts.shift();
    if (script) {
      if (script.kind === "reject") {
        const error = new Error("native rejection");
        (error as { code?: unknown }).code = script.code;
        throw error;
      }
      if (script.kind === "reject_raw") throw script.value;
      if (script.kind === "false") {
        return { started: false, port: 0, redirectUri: "" };
      }
      if (script.kind === "raw") return script.value as never;
    }
    return {
      started: true,
      port: 49152,
      redirectUri: "",
      generation: mockState.beginAuthGeneration,
      providerEpoch: mockState.beginAuthProviderEpoch,
      ownerAccountId: accountId
    };
  }),
  cancelAuth: jest.fn(async () => {
    mockState.cancelAuthCalls += 1;
  }),
  logout: jest.fn(async (_accountId: string) => ({
    cleared: true,
    revocationConfirmed: true,
    noActiveConnection: false
  })),
  clearCredential: jest.fn(async () => ({ cleared: true })),
  refresh: jest.fn(async (_accountId: string) => ({ refreshed: true })),
  getModels: jest.fn(async (_accountId: string) => ({ models: [] })),
  streamInvoke: jest.fn(async () => ({ completed: true, text: "" })),
  cancelStream: jest.fn(async () => {}),
  fence: jest.fn(async () => {})
};

jest.mock("react-native", () => ({
  Platform: { OS: "ios", isMacCatalyst: true },
  NativeModules: {
    get VeyraNSIWCModule() {
      return mockFns;
    }
  },
  NativeEventEmitter: class {
    constructor(_module: unknown) {}
    addListener(name: string, cb: (payload: unknown) => void) {
      if (name === "siwcEvent") mockNativeListener = cb;
      return { remove: () => {} };
    }
  }
}));

jest.mock("../../common/database", () => ({
  get db() {
    return { get isInitialized() { return mockState.dbInitialized; } };
  },
  DatabaseLogger: {
    error: (_context: unknown, message: unknown) =>
      mockState.logs.push(String(message)),
    info: () => {},
    log: () => {}
  }
}));

jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => {
      if (mockState.userStoreThrows) throw new Error("setting store unavailable");
      return { isAppLoading: mockState.isAppLoading };
    }
  }
}));

jest.mock("../../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => {
      if (mockState.userStoreThrows) throw new Error("user store unavailable");
      return {
        user: mockState.accountId ? { id: mockState.accountId } : null,
        appLocked: mockState.appLocked,
        isLoggingOut: mockState.isLoggingOut,
        accountSetupRequired: mockState.accountSetupRequired
      };
    }
  }
}));

import {
  beginSIWCAuth,
  cancelSIWCAuth,
  fenceSIWC,
  setSIWCAuthHandler,
  siwcHostEligibility,
  startSIWCHost,
  type SIWCBeginAuthResult,
  type SIWCHostBlockReason
} from "./index";

function resetState() {
  mockState.accountId = "account-A";
  mockState.dbInitialized = true;
  mockState.isAppLoading = false;
  mockState.appLocked = false;
  mockState.isLoggingOut = false;
  mockState.accountSetupRequired = false;
  mockState.userStoreThrows = false;
  mockState.beginAuthGate = undefined;
  mockState.beginAuthScripts = [];
  mockState.beginAuthGeneration = 1;
  mockState.beginAuthProviderEpoch = 4;
  mockState.beginAuthCalls = [];
  mockState.cancelAuthCalls = 0;
  mockState.logs = [];
  // The provider subscription is process-global and registered once per file
  // (the emitter double's `remove()` is a no-op), so the listener stays bound
  // across cases; only the handler is reset per case.
  setSIWCAuthHandler(undefined);
  jest.clearAllMocks();
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** The bounded, deterministic reason set (mirrors `SIWCHostBlockReason`). */
const REASONS: readonly SIWCHostBlockReason[] = [
  "db_uninitialized",
  "app_loading",
  "app_locked",
  "logging_out",
  "setup_required",
  "no_account",
  "unknown"
];

async function beginFresh(): Promise<SIWCBeginAuthResult> {
  return beginSIWCAuth("fresh");
}

describe("VeyraN SIWC beginAuth — bounded host reasons", () => {
  beforeEach(resetState);

  it("reports exactly one bounded reason per gate with no PII", () => {
    expect(siwcHostEligibility()).toEqual({
      eligible: true,
      accountId: "account-A"
    });

    const cases: Array<[() => void, SIWCHostBlockReason]> = [
      [() => (mockState.dbInitialized = false), "db_uninitialized"],
      [() => (mockState.isAppLoading = true), "app_loading"],
      [() => (mockState.appLocked = true), "app_locked"],
      [() => (mockState.isLoggingOut = true), "logging_out"],
      [() => (mockState.accountSetupRequired = true), "setup_required"],
      [() => (mockState.accountId = null), "no_account"]
    ];
    for (const [apply, reason] of cases) {
      resetState();
      apply();
      const out = siwcHostEligibility();
      expect(out.eligible).toBe(false);
      expect(out.reason).toBe(reason);
      // Only a bounded token ever crosses: never an account id or e-mail.
      expect(REASONS).toContain(out.reason);
      expect(JSON.stringify(out.reason)).not.toContain("account-A");
      resetState();
    }
  });

  it("fails closed as `unknown` when an eligibility getter throws", () => {
    mockState.userStoreThrows = true;
    expect(siwcHostEligibility()).toEqual({
      eligible: false,
      accountId: null,
      reason: "unknown"
    });
  });

  it("keeps a fixed gate order (lock wins over a missing account)", () => {
    mockState.appLocked = true;
    mockState.accountId = null;
    expect(siwcHostEligibility().reason).toBe("app_locked");
    mockState.appLocked = false;
    expect(siwcHostEligibility().reason).toBe("no_account");
  });

  it("answers a blocked host with the truthful reason and zero native work", async () => {
    for (const [apply, reason] of [
      [() => (mockState.appLocked = true), "app_locked"],
      [() => (mockState.accountId = null), "no_account"],
      [() => (mockState.accountSetupRequired = true), "setup_required"],
      [() => (mockState.userStoreThrows = true), "unknown"]
    ] as Array<[() => void, SIWCHostBlockReason]>) {
      resetState();
      startSIWCHost();
      apply();
      const result = await beginFresh();
      expect(result.started).toBe(false);
      expect(result.error).toBe("host_blocked");
      expect(mockState.beginAuthCalls.length).toBe(0);
      expect(mockState.cancelAuthCalls).toBe(0);
      expect(String(result.error)).not.toBe(reason);
    }
  });
});

describe("VeyraN SIWC beginAuth — first registration fallback", () => {
  beforeEach(resetState);

  it("retries exactly once as fresh only for the exact not_signed_in code", async () => {
    startSIWCHost();
    mockState.beginAuthScripts = [{ kind: "reject", code: "not_signed_in" }];
    const result = await beginSIWCAuth("returning");
    expect(result.started).toBe(true);
    expect(result.fallback).toBe("fresh_registration");
    expect(mockState.beginAuthCalls.map((c) => c.mode)).toEqual([
      "returning",
      "fresh"
    ]);
    // A successful fallback never issued a stray native cancel.
    expect(mockState.cancelAuthCalls).toBe(0);
  });

  it("returns a bounded not_signed_in outcome when fresh also reports it", async () => {
    startSIWCHost();
    mockState.beginAuthScripts = [
      { kind: "reject", code: "not_signed_in" },
      { kind: "reject", code: "not_signed_in" }
    ];
    const result = await beginSIWCAuth("returning");
    expect(result).toEqual({ started: false, error: "not_signed_in" });
    expect(mockState.beginAuthCalls.map((c) => c.mode)).toEqual([
      "returning",
      "fresh"
    ]);
  });

  it("never retries a fresh/consent request nor a non-not_signed_in returning rejection", async () => {
    startSIWCHost();
    for (const mode of ["fresh", "consent"] as const) {
      resetState();
      startSIWCHost();
      mockState.beginAuthScripts = [{ kind: "reject", code: "not_signed_in" }];
      const result = await beginSIWCAuth(mode);
      expect(result.started).toBe(false);
      expect(result.error).toBe("not_signed_in");
      expect(result.fallback).toBeUndefined();
      expect(mockState.beginAuthCalls.length).toBe(1);
    }

    for (const code of ["keychain_failure", "transport_unavailable"] as const) {
      resetState();
      startSIWCHost();
      mockState.beginAuthScripts = [{ kind: "reject", code }];
      const result = await beginSIWCAuth("returning");
      expect(result.started).toBe(false);
      expect(result.error).toBe(code);
      expect(result.fallback).toBeUndefined();
      // Exactly one attempt: a failed/unreadable record is never treated as
      // absence.
      expect(mockState.beginAuthCalls.map((c) => c.mode)).toEqual(["returning"]);
      expect(mockState.cancelAuthCalls).toBe(0);
    }
  });

  it("maps only whitelisted native codes and rejects everything else statically", async () => {
    startSIWCHost();
    mockState.beginAuthScripts = [{ kind: "reject", code: "callback_invalid" }];
    expect(await beginSIWCAuth("returning")).toEqual({
      started: false,
      error: "callback_invalid"
    });
    expect(mockState.beginAuthCalls.length).toBe(1);

    resetState();
    startSIWCHost();
    mockState.beginAuthScripts = [{ kind: "reject", code: "totally_made_up" }];
    expect(await beginSIWCAuth("returning")).toEqual({
      started: false,
      error: "start_failed"
    });
    expect(mockState.beginAuthCalls.length).toBe(1);
  });

  it("never surfaces a raw rejection: static code, category-only log", async () => {
    startSIWCHost();
    mockState.beginAuthScripts = [
      { kind: "reject_raw", value: new Error("token=SECRET provider body") }
    ];
    const result = await beginSIWCAuth("returning");
    expect(result).toEqual({ started: false, error: "start_failed" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(mockState.logs.join(" ")).not.toContain("SECRET");
    expect(mockState.logs.join(" ")).toContain("VeyraNSIWC.beginAuth");

    // A non-object rejection (a bare string) behaves identically.
    resetState();
    startSIWCHost();
    mockState.beginAuthScripts = [{ kind: "reject_raw", value: "raw token=SECRET" }];
    const bare = await beginSIWCAuth("returning");
    expect(bare).toEqual({ started: false, error: "start_failed" });
    expect(JSON.stringify(bare)).not.toContain("SECRET");
    expect(mockState.logs.join(" ")).not.toContain("SECRET");
  });
});

describe("VeyraN SIWC beginAuth — native result shape", () => {
  beforeEach(resetState);

  it("redacts a rejection with a throwing code getter and does not register again", async () => {
    startSIWCHost();
    const rejection = Object.defineProperty({}, "code", {
      get() { throw new Error("SECRET"); }
    });
    mockState.beginAuthScripts = [{ kind: "reject_raw", value: rejection }];
    const result = await beginSIWCAuth("returning");
    expect(result).toEqual({ started: false, error: "start_failed" });
    expect(mockState.beginAuthCalls.length).toBe(1);
    expect(mockState.logs.join(" ")).not.toContain("SECRET");
  });

  it("reports a bounded static failure for a resolved started:false", async () => {
    startSIWCHost();
    mockState.beginAuthScripts = [{ kind: "false" }];
    expect(await beginFresh()).toEqual({
      started: false,
      error: "start_failed"
    });
  });

  it("never reports started=true for missing/malformed flow metadata", async () => {
    const malformed: unknown[] = [
      { started: true, generation: NaN, providerEpoch: 4, ownerAccountId: "account-A" },
      { started: true, generation: 1, providerEpoch: Infinity, ownerAccountId: "account-A" },
      { started: true, generation: 1, providerEpoch: -1, ownerAccountId: "account-A" },
      { started: true, port: 49152, redirectUri: "" },
      { started: true, generation: "1", providerEpoch: 4, ownerAccountId: "account-A" },
      { started: true, generation: 1, providerEpoch: 4, ownerAccountId: "account-B" },
      { started: true, generation: 1, ownerAccountId: "account-A" },
      { started: true, generation: undefined, providerEpoch: 4, ownerAccountId: "account-A" }
    ];
    for (const value of malformed) {
      resetState();
      startSIWCHost();
      const events: unknown[] = [];
      setSIWCAuthHandler((event) => events.push(event));
      mockState.beginAuthScripts = [{ kind: "raw", value }];
      const result = await beginFresh();
      expect(result.started).toBe(false);
      expect(result.error).toBe("start_failed");
      // The malformed listener is torn down and no flow is armed: a matching
      // looking event changes nothing.
      expect(mockState.cancelAuthCalls).toBe(1);
      mockNativeListener?.({
        type: "authenticated",
        subject: "u",
        generation: 1,
        providerEpoch: 4,
        ownerAccountId: "account-A"
      });
      expect(events.length).toBe(0);
      setSIWCAuthHandler(undefined);
    }
  });
});

describe("VeyraN SIWC beginAuth — stale adoption and cancel ownership", () => {
  beforeEach(resetState);

  it("fails closed when the host is fenced while the returning start is in flight", async () => {
    startSIWCHost();
    const gate = deferred();
    mockState.beginAuthGate = gate.promise;
    mockState.beginAuthScripts = [{ kind: "reject", code: "not_signed_in" }];
    const pending = beginSIWCAuth("returning");
    fenceSIWC();
    gate.resolve();
    const result = await pending;
    expect(result.started).toBe(false);
    expect(result.error).toBe("account_changed");
    // No fallback attempt was made and the stale listener was canceled.
    expect(mockState.beginAuthCalls.length).toBe(1);
    expect(mockState.cancelAuthCalls).toBe(1);
  });

  it("fails closed when the host is locked while the returning start is in flight", async () => {
    startSIWCHost();
    const gate = deferred();
    mockState.beginAuthGate = gate.promise;
    mockState.beginAuthScripts = [{ kind: "reject", code: "not_signed_in" }];
    const pending = beginSIWCAuth("returning");
    mockState.appLocked = true;
    gate.resolve();
    const result = await pending;
    expect(result.started).toBe(false);
    expect(result.error).toBe("host_blocked");
    expect(mockState.beginAuthCalls.length).toBe(1);
  });

  it("fails closed when the account changes while the returning start is in flight", async () => {
    startSIWCHost();
    const gate = deferred();
    mockState.beginAuthGate = gate.promise;
    mockState.beginAuthScripts = [{ kind: "reject", code: "not_signed_in" }];
    const pending = beginSIWCAuth("returning");
    mockState.accountId = "account-B";
    gate.resolve();
    const result = await pending;
    expect(result.started).toBe(false);
    expect(result.error).toBe("account_changed");
    expect(mockState.beginAuthCalls.length).toBe(1);
  });

  it("never adopts a resolved flow whose account changed mid-flight", async () => {
    startSIWCHost();
    const events: unknown[] = [];
    setSIWCAuthHandler((event) => events.push(event));
    const gate = deferred();
    mockState.beginAuthGate = gate.promise;
    const pending = beginFresh();
    mockState.accountId = "account-B";
    gate.resolve();
    const result = await pending;
    expect(result.started).toBe(false);
    expect(result.error).toBe("account_changed");
    mockNativeListener?.({
      type: "authenticated",
      subject: "u",
      generation: 1,
      providerEpoch: 4,
      ownerAccountId: "account-A"
    });
    expect(events.length).toBe(0);
    expect(mockState.cancelAuthCalls).toBe(1);
    setSIWCAuthHandler(undefined);
  });

  it("never adopts a resolved flow that was fenced mid-flight", async () => {
    startSIWCHost();
    const events: unknown[] = [];
    setSIWCAuthHandler((event) => events.push(event));
    const gate = deferred();
    mockState.beginAuthGate = gate.promise;
    const pending = beginFresh();
    fenceSIWC();
    gate.resolve();
    const result = await pending;
    expect(result.started).toBe(false);
    expect(result.error).toBe("account_changed");
    mockNativeListener?.({
      type: "authenticated",
      subject: "u",
      generation: 1,
      providerEpoch: 4,
      ownerAccountId: "account-A"
    });
    expect(events.length).toBe(0);
    setSIWCAuthHandler(undefined);
  });

  it("adopts exactly one flow for two concurrent presses", async () => {
    startSIWCHost();
    const events: unknown[] = [];
    setSIWCAuthHandler((event) => events.push({ type: event.type }));
    const gate = deferred();
    mockState.beginAuthGate = gate.promise;
    const first = beginFresh();
    const second = beginFresh();
    gate.resolve();
    const results = await Promise.all([first, second]);
    // Exactly one attempt owns the flow; the superseded one reports a bounded
    // non-started outcome and never fires the global native cancel.
    expect(results.filter((r) => r.started).length).toBe(1);
    expect(results.filter((r) => !r.started).length).toBe(1);
    expect(mockState.cancelAuthCalls).toBe(0);
    mockNativeListener?.({
      type: "authenticated",
      subject: "u",
      generation: 1,
      providerEpoch: 4,
      ownerAccountId: "account-A"
    });
    expect(events.length).toBe(1);
    setSIWCAuthHandler(undefined);
  });

  it("an explicit cancel supersedes a pending start exactly once", async () => {
    startSIWCHost();
    const events: unknown[] = [];
    setSIWCAuthHandler((event) => events.push({ type: event.type }));
    const gate = deferred();
    mockState.beginAuthGate = gate.promise;
    const pending = beginFresh();
    await cancelSIWCAuth();
    gate.resolve();
    const result = await pending;
    expect(result.started).toBe(false);
    // Only the explicit cancel fired the native cancel; the superseded attempt
    // must not fire it a second time (that would kill a newer listener).
    expect(mockState.cancelAuthCalls).toBe(1);
    mockNativeListener?.({
      type: "authenticated",
      subject: "u",
      generation: 1,
      providerEpoch: 4,
      ownerAccountId: "account-A"
    });
    expect(events.length).toBe(0);
    setSIWCAuthHandler(undefined);
  });

  it("lets a newer start survive an older attempt that resolves later", async () => {
    startSIWCHost();
    const gate = deferred();
    mockState.beginAuthGate = gate.promise;
    const older = beginFresh();
    gate.resolve();
    // The newer start supersedes the older one before it resolves.
    const newer = await beginFresh();
    const olderResult = await older;
    expect(newer.started).toBe(true);
    expect(olderResult.started).toBe(false);
    // The superseded attempt never canceled the newer flow.
    expect(mockState.cancelAuthCalls).toBe(0);
  });

  it("keeps a fresh sign-in on an eligible host unchanged", async () => {
    startSIWCHost();
    const result = await beginFresh();
    expect(result).toEqual({
      started: true,
      port: 49152,
      redirectUri: ""
    });
    expect(result.fallback).toBeUndefined();
    await tick();
  });
});
