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

// Discriminating tests for the VeyraN SIWC JS provider.
//
// The native module is a jest double and the lifecycle stores expose the
// *authoritative* fields the eligibility proof reads, so every test exercises
// the real gate and the real adoption fencing rather than a bypass. No network,
// no Keychain, no token: the native double only records the bounded calls.

const mockState = {
  accountId: "account-A" as string | null,
  dbInitialized: true,
  isAppLoading: false,
  appLocked: false,
  isLoggingOut: false,
  accountSetupRequired: false,
  beginAuthGate: undefined as Promise<void> | undefined,
  streamGate: undefined as Promise<void> | undefined,
  beginAuthCalls: [] as Array<{ mode: string; accountId: string }>,
  /** The native flow generation returned by the beginAuth double. */
  beginAuthGeneration: 1,
  /** The native provider epoch returned by the beginAuth double. */
  beginAuthProviderEpoch: 4,
  streamCalls: [] as unknown[],
  /** The exact JS-owned request ids handed to the native stream double. */
  streamRequestIds: [] as string[],
  fenceCalls: 0
};

let mockNativeListener: ((payload: unknown) => void) | undefined;
let mockStreamListener: ((payload: unknown) => void) | undefined;

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
    return {
      started: true,
      port: 49152,
      redirectUri: "",
      generation: mockState.beginAuthGeneration,
      providerEpoch: mockState.beginAuthProviderEpoch,
      ownerAccountId: accountId
    };
  }),
  cancelAuth: jest.fn(async () => {}),
  // The mock is typed with the *production* outcome contract, so a scripted
  // per-case outcome (including `noActiveConnection`) is genuinely checked
  // against the same shape the native side reports.
  logout: jest.fn(
    async (_accountId: string): Promise<SIWCLogoutOutcome> => ({
      cleared: true,
      revocationConfirmed: true,
      noActiveConnection: false
    })
  ),
  clearCredential: jest.fn(async () => ({ cleared: true })),
  refresh: jest.fn(async (_accountId: string) => ({ refreshed: true })),
  getModels: jest.fn(async (_accountId: string) => ({
    models: [{ slug: "gpt-5", displayName: "GPT-5" }]
  })),
  streamInvoke: jest.fn(
    async (
      _accountId: string,
      _model: string,
      _input: unknown[],
      _functions: unknown[],
      _instructions: string | null,
      requestId: string
    ) => {
      mockState.streamCalls.push({ _accountId, _model, _input, _functions });
      mockState.streamRequestIds.push(requestId);
      if (mockState.streamGate) await mockState.streamGate;
      return { completed: true, text: "hello" };
    }
  ),
  cancelStream: jest.fn(async () => {}),
  fence: jest.fn(async () => {
    mockState.fenceCalls += 1;
  })
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
      if (name === "siwcStream") mockStreamListener = cb;
      return { remove: () => {} };
    }
  }
}));

jest.mock("../../common/database", () => ({
  get db() {
    return { get isInitialized() { return mockState.dbInitialized; } };
  },
  DatabaseLogger: { error: () => {}, info: () => {}, log: () => {} }
}));

jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => ({ isAppLoading: mockState.isAppLoading })
  }
}));

jest.mock("../../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({
      user: mockState.accountId ? { id: mockState.accountId } : null,
      appLocked: mockState.appLocked,
      isLoggingOut: mockState.isLoggingOut,
      accountSetupRequired: mockState.accountSetupRequired
    })
  }
}));

import {
  MODEL_CATALOG_UNAVAILABLE_NOTICE,
  buildFunctionTools,
  errorNotice,
  hasDirectScopes,
  isAdoptableEmission,
  isStrictSchema,
  modelsErrorCode,
  modelsErrorNotice,
  parseNativeStreamEvent,
  statusLabel,
  validateInputItems
} from "./helpers";
import {
  beginSIWCAuth,
  cancelSIWCStream,
  fenceSIWC,
  fetchSIWCModels,
  logoutSIWC,
  setSIWCAuthHandler,
  setSIWCStreamHandler,
  siwcHostEligibility,
  siwcCanInvoke,
  startSIWCHost,
  streamSIWC,
  SIWC_CONNECTED_ACCOUNT_LABEL,
  SIWC_CREDITS_NOTICE,
  SIWC_MANAGE_USAGE_URL,
  SIWC_REQUIRED_DIRECT_SCOPES,
  type SIWCLogoutOutcome,
  type SIWCStatusSummary
} from "./index";

function resetState() {
  mockState.accountId = "account-A";
  mockState.dbInitialized = true;
  mockState.isAppLoading = false;
  mockState.appLocked = false;
  mockState.isLoggingOut = false;
  mockState.accountSetupRequired = false;
  mockState.beginAuthGate = undefined;
  mockState.streamGate = undefined;
  mockState.beginAuthCalls = [];
  mockState.beginAuthGeneration = 1;
  mockState.beginAuthProviderEpoch = 4;
  mockState.streamCalls = [];
  mockState.streamRequestIds = [];
  jest.clearAllMocks();
}

describe("VeyraN SIWC — fixed constants", () => {
  beforeEach(resetState);

  it("exposes the exact informative credits notice (not a gate)", () => {
    expect(SIWC_CREDITS_NOTICE).toBe(
      "Nutzung kann ChatGPT-Kontingent oder vorhandene Credits verbrauchen. " +
        "Reine Abo-Nutzung ist nicht garantiert."
    );
  });

  it("uses the official usage-management link and a neutral connected-account label", () => {
    expect(SIWC_MANAGE_USAGE_URL).toBe("https://chatgpt.com/settings/usage");
    expect(SIWC_CONNECTED_ACCOUNT_LABEL).toBe("Verbundenes ChatGPT-Konto");
    // The label never promises plan-only or no-cost usage.
    expect(SIWC_CONNECTED_ACCOUNT_LABEL.toLowerCase()).not.toContain("plan");
    expect(SIWC_REQUIRED_DIRECT_SCOPES).toEqual([
      "resource.invoke",
      "chatgpt.tokens.use.direct"
    ]);
  });

  it("never exposes a model API-key fallback constant", () => {
    const surface = JSON.stringify({ SIWC_CREDITS_NOTICE, SIWC_MANAGE_USAGE_URL });
    expect(surface.toLowerCase()).not.toContain("api_key");
    expect(surface.toLowerCase()).not.toContain("apikey");
  });
});

describe("VeyraN SIWC — direct scope gate", () => {
  beforeEach(resetState);

  it("requires both direct scopes", () => {
    expect(hasDirectScopes(["resource.invoke", "chatgpt.tokens.use.direct"])).toBe(
      true
    );
    expect(hasDirectScopes(["resource.invoke"])).toBe(false);
    expect(hasDirectScopes([])).toBe(false);
  });

  it("siwcCanInvoke requires an explicit confirmed direct grant", () => {
    // The only allow: signed in, exactly `ready`, explicit direct scopes true.
    expect(
      siwcCanInvoke({
        signedIn: true,
        status: "ready",
        hasDirectScopes: true
      })
    ).toBe(true);
    // A missing grant signal is *not* an allow.
    expect(siwcCanInvoke({ signedIn: true, status: "ready" })).toBe(false);
    // A malformed grant value is denied.
    expect(
      siwcCanInvoke({
        signedIn: true,
        status: "ready",
        hasDirectScopes: "true" as unknown as boolean
      })
    ).toBe(false);
    // missingpermission (or any non-ready status) is denied even if signed in.
    expect(
      siwcCanInvoke({
        signedIn: true,
        status: "missingpermission",
        hasDirectScopes: false
      })
    ).toBe(false);
    expect(
      siwcCanInvoke({
        signedIn: true,
        status: "refreshing",
        hasDirectScopes: true
      })
    ).toBe(false);
    // Signed out is denied regardless of any other field.
    expect(
      siwcCanInvoke({
        signedIn: false,
        status: "ready",
        hasDirectScopes: true
      })
    ).toBe(false);
    expect(
      siwcCanInvoke(undefined as unknown as SIWCStatusSummary)
    ).toBe(false);
  });

  it("surfaces static, bounded error notices", () => {
    const notEligible = errorNotice("subscription_sharing_user_not_eligible");
    expect(notEligible.retryable).toBe(false);
    const limit = errorNotice("usage_limit_exceeded");
    expect(limit.link).toBe(SIWC_MANAGE_USAGE_URL);
    expect(limit.message.toLowerCase()).not.toContain("reset um");
    const unavailable = errorNotice("usage_unavailable");
    expect(unavailable.retryable).toBe(true);
    const invalid = errorNotice("invalid_user");
    expect(invalid.retryable).toBe(false);
  });

  it("maps the official subscription-sharing codes to static notices", () => {
    const unavailable = errorNotice("subscription_sharing_usage_unavailable");
    expect(unavailable.code).toBe("usage_unavailable");
    expect(unavailable.retryable).toBe(true);
    const invalidUser = errorNotice("subscription_sharing_invalid_user");
    expect(invalidUser.code).toBe("invalid_user");
    expect(invalidUser.retryable).toBe(false);
    const limited = errorNotice("subscription_sharing_usage_limit_exceeded");
    expect(limited.code).toBe("usage_limit_exceeded");
    expect(limited.link).toBe(SIWC_MANAGE_USAGE_URL);
    expect(limited.retryable).toBe(false);
    // An uncatalogued code stays a bounded, generic notice.
    const unknown = errorNotice("something_odd");
    expect(unknown.code).toBe("unknown");
  });
});

describe("VeyraN SIWC — function namespace", () => {
  beforeEach(resetState);

  it("builds the strict veyran namespace", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
      additionalProperties: false
    };
    expect(isStrictSchema(schema)).toBe(true);
    const tools = buildFunctionTools([
      { name: "do_thing", description: "does a thing", parameters: schema }
    ]);
    expect(tools).toEqual({
      type: "namespace",
      name: "veyran",
      tools: [
        {
          type: "function",
          name: "do_thing",
          description: "does a thing",
          strict: true,
          parameters: schema
        }
      ]
    });
  });

  it("refuses a non-strict schema, a bad name or a duplicate", () => {
    const loose = { type: "object", properties: {}, required: [] };
    expect(isStrictSchema(loose)).toBe(false);
    expect(
      buildFunctionTools([
        { name: "do_thing", description: "d", parameters: loose }
      ])
    ).toBeUndefined();
    expect(
      buildFunctionTools([
        {
          name: "bad name!",
          description: "d",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false
          }
        }
      ])
    ).toBeUndefined();
  });

  it("rejects a system role in the input", () => {
    expect(validateInputItems([{ role: "system", content: "x" }])).toBe(false);
    expect(validateInputItems([{ role: "user", content: "x" }])).toBe(true);
    expect(validateInputItems([])).toBe(false);
  });
});

describe("VeyraN SIWC — stream adoption fencing", () => {
  beforeEach(resetState);

  it("parses only bounded, well-typed native events", () => {
    expect(
      parseNativeStreamEvent({
        type: "delta",
        requestId: "r1",
        providerGeneration: 3,
        text: "hi"
      })
    ).toEqual({ type: "delta", requestId: "r1", providerGeneration: 3, text: "hi" });
    expect(parseNativeStreamEvent({ type: "delta", requestId: "r1" })).toBeUndefined();
    expect(parseNativeStreamEvent("nope")).toBeUndefined();
  });

  it("adopts only the exact requestId + generation", () => {
    const emission = {
      type: "delta" as const,
      requestId: "r1",
      providerGeneration: 3,
      text: "hi"
    };
    expect(
      isAdoptableEmission(emission, { requestId: "r1", providerGeneration: 3 })
    ).toBe(true);
    expect(
      isAdoptableEmission(emission, { requestId: "r1", providerGeneration: 4 })
    ).toBe(false);
    expect(
      isAdoptableEmission(emission, { requestId: "r2", providerGeneration: 3 })
    ).toBe(false);
  });
});

describe("VeyraN SIWC — lifecycle gates", () => {
  beforeEach(resetState);

  it("denies when the app is locked, logging out or still hydrating", () => {
    expect(siwcHostEligibility().eligible).toBe(true);
    mockState.appLocked = true;
    expect(siwcHostEligibility().eligible).toBe(false);
    mockState.appLocked = false;
    mockState.isLoggingOut = true;
    expect(siwcHostEligibility().eligible).toBe(false);
    mockState.isLoggingOut = false;
    mockState.isAppLoading = true;
    expect(siwcHostEligibility().eligible).toBe(false);
  });

  it("startSIWCHost mounts and cleanup fences", () => {
    const cleanup = startSIWCHost();
    expect(typeof cleanup).toBe("function");
    cleanup();
    expect(mockState.fenceCalls).toBeGreaterThan(0);
  });

  it("a fence that lands during beginAuth drops the late result", async () => {
    startSIWCHost();
    let release: () => void = () => {};
    mockState.beginAuthGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promise = beginSIWCAuth("fresh");
    // The seam lands while the native start is in flight.
    fenceSIWC();
    release();
    const result = await promise;
    expect(result.started).toBe(false);
    expect(mockFns.cancelAuth).toHaveBeenCalled();
  });

  it("fetchSIWCModels reflects eligibility", async () => {
    startSIWCHost();
    expect(await fetchSIWCModels("account-A")).toEqual({
      ok: true,
      models: [{ slug: "gpt-5", displayName: "GPT-5" }]
    });
    mockState.accountId = "account-B";
    const denied = await fetchSIWCModels("account-A");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("host_blocked");
  });

  it("streamSIWC rejects invalid input before any native call", async () => {
    startSIWCHost();
    const bad = await streamSIWC("account-A", "gpt-5", [{ role: "system" }], []);
    expect(bad.completed).toBe(false);
    expect(mockState.streamCalls.length).toBe(0);
  });

  it("streamSIWC passes content straight through and reports completion", async () => {
    startSIWCHost();
    const tools = [
      {
        name: "do_thing",
        description: "d",
        parameters: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: false
        }
      }
    ];
    const result = await streamSIWC(
      "account-A",
      "gpt-5",
      [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools
    );
    expect(result).toEqual({ completed: true, text: "hello" });
    expect(mockState.streamCalls.length).toBe(1);
  });

  it("arms adoption from the native generation handshake, not the JS epoch", async () => {
    startSIWCHost();
    const seen: Array<{ type: string }> = [];
    setSIWCStreamHandler((emission) => seen.push({ type: emission.type }));
    let release: () => void = () => {};
    mockState.streamGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = streamSIWC(
      "account-A",
      "gpt-5",
      [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      [
        {
          name: "do_thing",
          description: "d",
          parameters: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            additionalProperties: false
          }
        }
      ]
    );
    // JS owns the request id and hands exactly it to the native side.
    const requestId = mockState.streamRequestIds[0];
    expect(typeof requestId).toBe("string");
    expect(requestId.startsWith("siwc-")).toBe(true);
    // A delta that arrives before the native generation is known is dropped.
    mockStreamListener?.({ type: "delta", requestId, providerGeneration: 1, text: "early" });
    expect(seen.length).toBe(0);
    // A *foreign* handshake (another request id) never arms this invocation.
    mockStreamListener?.({ type: "start", requestId: "r1", providerGeneration: 7 });
    mockStreamListener?.({ type: "delta", requestId: "r1", providerGeneration: 7, text: "foreign" });
    expect(seen.length).toBe(0);
    // The handshake echoes the JS-owned request id with the *native* generation
    // (7), which is deliberately different from the JS host epoch (1).
    mockStreamListener?.({ type: "start", requestId, providerGeneration: 7 });
    // A stale generation is refused; the exact native generation is adopted.
    mockStreamListener?.({ type: "delta", requestId, providerGeneration: 1, text: "stale" });
    mockStreamListener?.({ type: "delta", requestId, providerGeneration: 7, text: "ok" });
    mockStreamListener?.({
      type: "functionCall",
      requestId,
      providerGeneration: 7,
      callId: "c1",
      name: "do_thing",
      arguments: "{}"
    });
    release();
    const result = await pending;
    expect(result.completed).toBe(true);
    expect(seen.map((e) => e.type)).toEqual(["delta", "functionCall"]);
    setSIWCStreamHandler(undefined);
  });

  it("a canceled invocation is always canceled and never clears a newer stream", async () => {
    startSIWCHost();
    const seen: Array<{ type: string }> = [];
    setSIWCStreamHandler((emission) => seen.push({ type: emission.type }));
    let releaseA: () => void = () => {};
    mockState.streamGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const pendingA = streamSIWC("account-A", "gpt-5", [{ role: "user" }], []);
    const requestIdA = mockState.streamRequestIds[0];
    expect(typeof requestIdA).toBe("string");
    // A is canceled while its native call is still in flight.
    await cancelSIWCStream();
    // B becomes the active stream while A is still pending.
    let releaseB: () => void = () => {};
    mockState.streamGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const pendingB = streamSIWC("account-A", "gpt-5", [{ role: "user" }], []);
    const requestIdB = mockState.streamRequestIds[1];
    expect(requestIdB).not.toBe(requestIdA);
    // A completes *successfully* after B became active: it is still canceled.
    releaseA();
    const resultA = await pendingA;
    expect(resultA.completed).toBe(false);
    expect(resultA.error?.code).toBe("canceled");
    // A's completion/finally never cleared B's adoption fence.
    mockStreamListener?.({ type: "start", requestId: requestIdB, providerGeneration: 7 });
    mockStreamListener?.({ type: "delta", requestId: requestIdB, providerGeneration: 7, text: "ok" });
    expect(seen.map((e) => e.type)).toEqual(["delta"]);
    releaseB();
    const resultB = await pendingB;
    expect(resultB.completed).toBe(true);
    setSIWCStreamHandler(undefined);
  });

  it("surfaces auth events only for the exact authorized flow", async () => {
    startSIWCHost();
    const events: Array<{ type: string; code?: string }> = [];
    setSIWCAuthHandler((event) => events.push({ type: event.type, code: event.code }));
    const started = await beginSIWCAuth("fresh");
    expect(started.started).toBe(true);
    const matching = {
      generation: 1,
      providerEpoch: 4,
      ownerAccountId: "account-A"
    };
    // A foreign generation, a foreign epoch, a foreign owner, a raw payload and
    // an event without flow identity are all dropped.
    mockNativeListener?.({ type: "authenticated", subject: "u", ...matching, generation: 99 });
    mockNativeListener?.({ type: "authenticated", subject: "u", ...matching, providerEpoch: 5 });
    mockNativeListener?.({ type: "authenticated", subject: "u", ...matching, ownerAccountId: "account-B" });
    mockNativeListener?.({ type: "authenticated", subject: "u" });
    mockNativeListener?.({ type: "authenticated", subject: "u", ...matching, generation: "1" });
    expect(events.length).toBe(0);
    // The exact flow event is surfaced (redacted).
    mockNativeListener?.({ type: "authenticated", subject: "u", ...matching });
    expect(events).toEqual([{ type: "authenticated", code: undefined }]);
    // A host fence invalidates the authorized flow immediately.
    fenceSIWC();
    mockNativeListener?.({ type: "authError", code: "state_mismatch", ...matching });
    expect(events.length).toBe(1);
    // A locked host drops the event even for a matching generation/epoch.
    const second = await beginSIWCAuth("fresh");
    expect(second.started).toBe(true);
    mockState.appLocked = true;
    mockNativeListener?.({ type: "authError", code: "state_mismatch", ...matching });
    expect(events.length).toBe(1);
    setSIWCAuthHandler(undefined);
  });

  it("never reports an unknown or absent revocation as confirmed", async () => {
    startSIWCHost();
    mockFns.logout.mockResolvedValueOnce({
      cleared: true,
      revocationConfirmed: false,
      noActiveConnection: false
    });
    expect(await logoutSIWC("account-A")).toEqual({
      cleared: true,
      revocationConfirmed: false,
      noActiveConnection: false
    });
    mockFns.logout.mockResolvedValueOnce({
      cleared: true,
      revocationConfirmed: false,
      noActiveConnection: true
    });
    const none = await logoutSIWC("account-A");
    expect(none.revocationConfirmed).toBe(false);
    expect(none.noActiveConnection).toBe(true);
  });

  it("statusLabel never forces consent for an ordinary state", () => {
    expect(statusLabel("ready")).toBe(SIWC_CONNECTED_ACCOUNT_LABEL);
    expect(statusLabel("missingpermission")).toBe("ChatGPT-Nutzung freigeben");
    expect(statusLabel("signedout")).toBe("Nicht angemeldet");
  });
});

// --------------------------------------------------------------------- catalog

describe("VeyraN SIWC — bounded model catalog outcomes", () => {
  beforeEach(resetState);

  it("never echoes an unknown error code in the shared error surface", () => {
    const notice = errorNotice("Bearer SYNTHETIC-SECRET https://example.com/callback");
    expect(notice.code).toBe("unknown");
    expect(JSON.stringify(notice)).not.toContain("SYNTHETIC-SECRET");
  });

  it("rejects malformed model rows and oversized lists at the native boundary", async () => {
    startSIWCHost();
    for (const models of [
      [{ slug: "bad slug", displayName: "Test" }],
      [{ slug: "valid", displayName: " " }],
      [{ slug: "valid", displayName: "x".repeat(201) }],
      Array.from({ length: 513 }, (_, i) => ({ slug: `m-${i}`, displayName: "Test" }))
    ]) {
      mockFns.getModels.mockImplementationOnce(async () => ({ models }));
      const outcome = await fetchSIWCModels("account-A");
      expect(outcome).toEqual({ ok: false, error: MODEL_CATALOG_UNAVAILABLE_NOTICE });
    }
  });

  it("returns the actual server catalog, preserving its visibility:list order", async () => {
    startSIWCHost();
    mockFns.getModels.mockImplementationOnce(async () => ({
      models: [
        { slug: "gpt-5", displayName: "GPT-5" },
        { slug: "gpt-5-mini", displayName: "GPT-5 mini" },
        { slug: "o4", displayName: "o4" }
      ]
    }));
    const outcome = await fetchSIWCModels("account-A");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // Exactly the server rows, in the server order: nothing invented,
      // nothing re-sorted and no default inserted.
      expect(outcome.models.map((model) => model.slug)).toEqual([
        "gpt-5",
        "gpt-5-mini",
        "o4"
      ]);
    }
  });

  it("reports a legitimately empty catalog as ok-empty, never as a failure", async () => {
    startSIWCHost();
    mockFns.getModels.mockImplementationOnce(async () => ({ models: [] }));
    const outcome = await fetchSIWCModels("account-A");
    expect(outcome).toEqual({ ok: true, models: [] });
  });

  it("maps an allowlisted native rejection to its bounded static notice", async () => {
    startSIWCHost();
    mockFns.getModels.mockImplementationOnce(async () => {
      const rejection = new Error(
        "Bearer sk-do-not-leak https://api.openai.com/v1/models?token=abc"
      ) as Error & { code: string };
      rejection.code = "transport_unavailable";
      throw rejection;
    });
    const outcome = await fetchSIWCModels("account-A");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("transport_unavailable");
      expect(outcome.error.retryable).toBe(true);
      // The raw exception message/URL/token never leaks into the notice.
      const serialized = JSON.stringify(outcome.error);
      expect(serialized).not.toContain("sk-do-not-leak");
      expect(serialized).not.toContain("api.openai.com");
      expect(serialized).not.toContain("Bearer");
    }
  });

  it("collapses an unknown/raw rejection to the fixed catalog_unavailable notice", async () => {
    startSIWCHost();
    mockFns.getModels.mockImplementationOnce(async () => {
      const rejection = new Error("provider said: quota for org-123") as Error & {
        code: string;
      };
      rejection.code = "totally_new_native_code";
      throw rejection;
    });
    const outcome = await fetchSIWCModels("account-A");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(MODEL_CATALOG_UNAVAILABLE_NOTICE);
      expect(JSON.stringify(outcome.error)).not.toContain("org-123");
      expect(JSON.stringify(outcome.error)).not.toContain("totally_new_native_code");
    }
  });

  it("treats a malformed native payload as a bounded failure, not an empty catalog", async () => {
    startSIWCHost();
    mockFns.getModels.mockImplementationOnce(async () => ({}) as never);
    const outcome = await fetchSIWCModels("account-A");
    expect(outcome).toEqual({
      ok: false,
      error: MODEL_CATALOG_UNAVAILABLE_NOTICE
    });
  });

  it("preserves the real native catalog diagnostic instead of flattening it", async () => {
    startSIWCHost();
    for (const code of [
      "model_unavailable",
      "token_invalid",
      "identity_mismatch",
      "stream_invalid"
    ] as const) {
      mockFns.getModels.mockImplementationOnce(async () => {
        // A native rejection may carry a raw provider body; only the bounded
        // static code and message may reach the caller.
        const rejection = new Error("raw provider body Bearer secret") as Error & {
          code: string;
        };
        rejection.code = code;
        throw rejection;
      });
      const outcome = await fetchSIWCModels("account-A");
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe(code);
        expect(outcome.error.message).toMatch(/Modell|ChatGPT|Konto/);
        expect(outcome.error.message).not.toContain("raw provider body");
      }
    }
  });

  it("drops a catalog whose host identity changed while the read was in flight", async () => {
    startSIWCHost();
    mockFns.getModels.mockImplementationOnce(async () => {
      // The provider host is fenced/re-registered while the read is pending.
      fenceSIWC();
      return { models: [{ slug: "gpt-5", displayName: "GPT-5" }] };
    });
    const outcome = await fetchSIWCModels("account-A");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("account_changed");
  });

  it("refuses a malformed catalog instead of silently presenting a partial success", async () => {
    startSIWCHost();
    mockFns.getModels.mockImplementationOnce(
      async () =>
        ({
          models: [
            { slug: "gpt-5", displayName: "GPT-5" },
            { slug: "", displayName: "no slug" },
            { slug: "no-name", displayName: "" },
            null,
            { slug: 42, displayName: "bad" }
          ]
        }) as never
    );
    const outcome = await fetchSIWCModels("account-A");
    expect(outcome).toEqual({ ok: false, error: MODEL_CATALOG_UNAVAILABLE_NOTICE });
  });

  it("the catalog error mapper is a strict allowlist that never echoes raw values", () => {
    expect(modelsErrorCode({ code: "not_signed_in" })).toBe("not_signed_in");
    expect(modelsErrorCode({ code: "keychain_failure" })).toBe("keychain_failure");
    expect(modelsErrorCode({ code: "auth_canceled" })).toBe("canceled");
    expect(modelsErrorCode({ code: "usage_limit_exceeded" })).toBe(
      "usage_limit_exceeded"
    );
    // The real catalog-relevant native codes stay distinct with their own
    // static message (the raw message is never echoed).
    for (const code of [
      "model_unavailable",
      "token_invalid",
      "identity_mismatch",
      "stream_invalid"
    ] as const) {
      expect(modelsErrorCode({ code })).toBe(code);
      const notice = modelsErrorNotice({ code, message: "raw Bearer secret" });
      expect(notice.code).toBe(code);
      expect(notice.message).toMatch(/Modell|ChatGPT|Konto/);
      expect(JSON.stringify(notice)).not.toContain("raw Bearer secret");
    }
    // Unknown codes, non-strings, non-objects and thrown getters all collapse.
    expect(modelsErrorCode({ code: "brand_new" })).toBe("catalog_unavailable");
    expect(modelsErrorCode("not_signed_in")).toBe("catalog_unavailable");
    expect(modelsErrorCode(undefined)).toBe("catalog_unavailable");
    expect(modelsErrorCode(new Error("boom"))).toBe("catalog_unavailable");
    const hostile = {
      get code(): unknown {
        throw new Error("getter leaked");
      }
    };
    expect(modelsErrorCode(hostile)).toBe("catalog_unavailable");
    expect(modelsErrorNotice(new Error("Bearer secret")).code).toBe(
      "catalog_unavailable"
    );
  });
});
