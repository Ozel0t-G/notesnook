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

// Discriminating tests for the VeyraN Connect JS host.
//
// `@notesnook/core` is replaced with a synthetic adapter + the pure wire
// schemas, and the native module is a jest double, so these tests run in a
// plain Node environment. The `settings` double models the *real* Core API: the
// value written by `writeLocalRecord` is stored as the exact JSON string, so a
// "reopen" is simply reading that string back.
//
// The lifecycle stores (`use-user-store` / `use-setting-store`) are mocked to
// expose the *authoritative* fields the eligibility proof reads, so every test
// exercises the real gate instead of an "always eligible" production bypass.

/** A canonical 16-byte unpadded base64url session id (exactly 22 chars). */
const NATIVE_SESSION_ID = "dmV5cmFuLXNlc3Npb24xNg";

const mockState = {
  locked: false,
  closed: false,
  hasGrants: false,
  accountId: "account-A" as string | null,
  executed: [] as unknown[],
  persisted: [] as unknown[],
  gate: undefined as Promise<void> | undefined,
  writeGate: undefined as Promise<void> | undefined,
  /** The stored `settings` row value, exactly as Core would hold it. */
  storedValue: undefined as string | undefined,
  storedDateCreated: undefined as number | undefined,
  failUpsert: false,
  failDelete: false,
  // Authoritative lifecycle state read by `hostEligibility()`.
  dbInitialized: true,
  isAppLoading: false,
  appLocked: false,
  isLoggingOut: false,
  accountSetupRequired: false,
  // Native side.
  nativeFlowCounter: 0,
  activations: [] as Array<{ flow: number; sessionId: string }>,
  /** When set, `activateSession` rejects (phase-two failure). */
  failActivate: false
};

const mockFns = {
  reply: jest.fn(
    async (
      _ticketId: string,
      _response: unknown,
      _expectedLeaseGeneration: number,
      _expectedSessionId: string
    ): Promise<{ accepted: true }> => ({ accepted: true as const })
  ),
  startSession: jest.fn(
    async (
      _accountId: string,
      _generation: number,
      _clientId: string
    ): Promise<{
      sessionId: string;
      grantsGeneration: number;
      nativeLeaseGeneration: number;
    }> => {
      mockState.nativeFlowCounter += 1;
      return {
        sessionId: NATIVE_SESSION_ID,
        grantsGeneration: mockState.nativeFlowCounter,
        nativeLeaseGeneration: mockState.nativeFlowCounter
      };
    }
  ),
  activateSession: jest.fn(
    async (nativeLeaseGeneration: number, sessionId: string): Promise<void> => {
      if (mockState.failActivate) throw new Error("activate failed");
      mockState.activations.push({
        flow: nativeLeaseGeneration,
        sessionId
      });
    }
  ),
  stopSession: jest.fn(async (): Promise<void> => {}),
  disconnect: jest.fn(async (): Promise<void> => {}),
  pickPairingFile: jest.fn(
    async (): Promise<{
      paired: boolean;
      brokerId?: string;
      port?: number;
      cancelled?: boolean;
      /** The native side fenced the pick before any credential store. */
      stale?: boolean;
      supported?: boolean;
    }> => ({ paired: true, brokerId: "b".repeat(32), port: 45999 })
  ),
  getStatus: jest.fn(
    async (): Promise<import("./veyran-connect").ConnectNativeStatus> => ({
      paired: true,
      sessionActive: false,
      brokerId: "b".repeat(32),
      port: 45999
    })
  ),
  queueRoutesForUpdate: jest.fn(),
  reconcile: jest.fn(async (): Promise<void> => {}),
  updateRelation: jest.fn(),
  refreshAllStores: jest.fn(),
  updateNotes: jest.fn(),
  setAppDidEnterBackgroundForAction: jest.fn()
};

let mockNativeListener: ((payload: unknown) => void) | undefined;

jest.mock("react-native", () => ({
  Platform: { OS: "ios", isMacCatalyst: true },
  NativeModules: {
    get VeyraNConnectModule() {
      return mockFns;
    }
  },
  NativeEventEmitter: class {
    constructor(_module: unknown) {}
    addListener(_name: string, cb: (payload: unknown) => void) {
      mockNativeListener = cb;
      return { remove: () => {} };
    }
  }
}));

jest.mock("../common/database", () => ({
  get db() {
    return {
      get isInitialized() {
        return mockState.dbInitialized;
      },
      user: {
        getUser: async () =>
          mockState.accountId ? { id: mockState.accountId } : null
      },
      settings: {
        collection: {
          get: (id: string) => {
            if (id !== "veyran-connect:local-v1") return undefined;
            if (mockState.storedValue === undefined) return undefined;
            return {
              id,
              value: mockState.storedValue,
              dateCreated: mockState.storedDateCreated
            };
          },
          upsert: async (item: { value?: string; dateCreated?: number }) => {
            if (mockState.failUpsert) throw new Error("upsert failed");
            if (mockState.writeGate) await mockState.writeGate;
            mockState.persisted.push(item);
            mockState.storedValue = item.value;
            mockState.storedDateCreated = item.dateCreated;
          },
          delete: async (_ids: string[]) => {
            if (mockState.failDelete) throw new Error("delete failed");
            mockState.storedValue = undefined;
            mockState.storedDateCreated = undefined;
          }
        }
      }
    };
  },
  DatabaseLogger: { error: () => {}, info: () => {}, log: () => {} }
}));

jest.mock("@notesnook/core", () => {
  const CATALOG: Record<string, string> = {
    NOT_AUTHORIZED: "This operation is not permitted by the active grants.",
    ADAPTER_LOCKED: "The VeyraN Connect adapter is locked.",
    ADAPTER_CLOSED: "The VeyraN Connect adapter is closed.",
    DENIED: "No signed-in VeyraN account is available for this operation.",
    INVALID_INPUT: "The request is malformed or exceeds bounded limits."
  };
  class ConnectError extends Error {
    code: string;
    constructor(code: string) {
      super(CATALOG[code] ?? code);
      this.code = code;
    }
  }
  // Stand-ins for the pure Core (zod) schemas. They enforce the same strictness
  // for the two operations used and, importantly, mirror the correlated union
  // shape the service narrows on.
  const requestWireSchema = {
    safeParse(value: unknown): { success: boolean; data?: unknown } {
      if (!value || typeof value !== "object") return { success: false };
      const r = value as Record<string, unknown>;
      if (r.operation === "status" && Object.keys(r).length === 1)
        return { success: true, data: { operation: "status" } };
      if (
        r.operation === "create_note" &&
        typeof r.operationId === "string" &&
        r.operationId.length > 0 &&
        typeof r.content === "string" &&
        (r.notebookId === undefined || typeof r.notebookId === "string")
      )
        return {
          success: true,
          data: {
            operation: "create_note",
            operationId: r.operationId,
            notebookId: r.notebookId,
            title: typeof r.title === "string" ? r.title : undefined,
            content: r.content
          }
        };
      return { success: false };
    }
  };
  const errorEnvelope = (code: string) => ({
    code,
    message: CATALOG[code] ?? code
  });
  const wireResponseSchemaFor = (operation: string) => ({
    safeParse(value: unknown): { success: boolean; data?: unknown } {
      const r = value as
        | { ok?: unknown; result?: { operation?: unknown }; error?: unknown }
        | undefined;
      if (r && r.ok === true && r.result && r.result.operation === operation)
        return { success: true, data: { ok: true, result: r.result } };
      if (r && r.ok === false && r.error) return { success: true, data: r };
      return { success: false };
    }
  });
  class ConnectAdapter {
    closed = false;
    locked = false;
    generation = 0;
    constructor(_db: unknown, _options?: unknown) {}
    async setGrants(input: { accountId?: string }) {
      if (this.closed) throw new ConnectError("ADAPTER_CLOSED");
      if (this.locked) throw new ConnectError("ADAPTER_LOCKED");
      if (!input || !input.accountId) throw new ConnectError("DENIED");
      mockState.hasGrants = true;
      this.generation += 1;
      return this.generation;
    }
    clearGrants() {
      mockState.hasGrants = false;
      this.generation += 1;
    }
    lock() {
      this.locked = true;
      this.generation += 1;
    }
    unlock() {
      if (!this.closed) this.locked = false;
    }
    close() {
      this.closed = true;
      this.locked = true;
      mockState.hasGrants = false;
      this.generation += 1;
    }
    async execute(request: { operation: string }) {
      if (this.closed) throw new ConnectError("ADAPTER_CLOSED");
      if (this.locked) throw new ConnectError("ADAPTER_LOCKED");
      if (!mockState.hasGrants) throw new ConnectError("NOT_AUTHORIZED");
      mockState.executed.push(request);
      if (mockState.gate) await mockState.gate;
      return { operation: request.operation };
    }
  }
  return {
    ConnectAdapter,
    ConnectError,
    isConnectError: (value: unknown) => value instanceof ConnectError,
    requestWireSchema,
    wireResponseSchemaFor,
    errorEnvelope,
    transportWireResponseSchema: { safeParse: () => ({ success: false }) }
  };
});

jest.mock("./navigation", () => ({
  __esModule: true,
  default: { queueRoutesForUpdate: () => mockFns.queueRoutesForUpdate() }
}));
jest.mock("./note-preview-widget", () => ({
  NotePreviewWidget: { updateNotes: () => mockFns.updateNotes() }
}));
jest.mock("./task-notifications", () => ({
  TaskNotifications: { reconcile: () => mockFns.reconcile() }
}));
jest.mock("../stores/create-db-collection-store", () => ({
  refreshAllStores: () => mockFns.refreshAllStores()
}));
jest.mock("../stores/use-relation-store", () => ({
  useRelationStore: {
    getState: () => ({ update: () => mockFns.updateRelation() })
  }
}));
jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => ({
      isAppLoading: mockState.isAppLoading,
      appDidEnterBackgroundForAction: false,
      setAppDidEnterBackgroundForAction: (value: boolean) =>
        mockFns.setAppDidEnterBackgroundForAction(value)
    })
  }
}));
jest.mock("../stores/use-user-store", () => ({
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
  EMPTY_CAPABILITIES,
  LOCAL_RECORD_MAX_BYTES,
  boundedUtf8ByteLength,
  buildGrantsInput,
  clearCurrentCapabilities,
  clearLocalRecord,
  currentActiveNativeSession,
  currentHostIdentity,
  disconnect,
  emptyCapabilities,
  executeConnectRequest,
  getCurrentCapabilities,
  hostAdapter,
  hostEligibility,
  installGrants,
  invalidateHost,
  isActiveNativeSession,
  isCanonicalNativeSessionId,
  isHostIdentityCurrent,
  isSessionActive,
  mountHost,
  normalizeCapabilities,
  normalizeInboundRequest,
  onHostAccountReady,
  onHostLock,
  onHostTearDown,
  parseClaimEvent,
  parseLocalRecordValue,
  pickPairingFile,
  readLocalRecord,
  reinstallPersistedGrantsIfSameAccount,
  serializeLocalRecord,
  setCurrentCapabilities,
  startConnectHost,
  startSession,
  stopSession,
  writeLocalRecord
} from "./veyran-connect";
import type { ConnectRequest } from "@notesnook/core";

const CAPS = normalizeCapabilities({
  canRead: true,
  canCreate: true,
  canTask: true,
  notebookIds: ["nb1"],
  listIds: ["list1"],
  defaultNotebookId: "nb1"
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

/** Persist the account-bound grant record a session start requires. */
async function writeRecord(accountId = "account-A"): Promise<void> {
  const written = await writeLocalRecord({
    v: 1,
    accountId,
    capabilities: CAPS
  });
  expect(written).toBe(true);
}

/** Mount the host, install grants and adopt a native session (two phases). */
async function adoptSession(accountId = "account-A"): Promise<() => void> {
  await writeRecord(accountId);
  const cleanup = startConnectHost();
  await onHostAccountReady(accountId, CAPS);
  const started = await startSession(accountId);
  expect(started).toBe(true);
  return cleanup;
}

function emitClaim(
  ticketId: string,
  generation: number,
  sessionId: string
): void {
  mockNativeListener!({
    ticketId,
    request: { operation: "status" },
    generation,
    sessionId
  });
}

describe("VeyraN Connect host", () => {
  beforeEach(() => {
    mockState.hasGrants = false;
    mockState.accountId = "account-A";
    mockState.executed = [];
    mockState.persisted = [];
    mockState.gate = undefined;
    mockState.writeGate = undefined;
    mockState.storedValue = undefined;
    mockState.storedDateCreated = undefined;
    mockState.failUpsert = false;
    mockState.failDelete = false;
    mockState.dbInitialized = true;
    mockState.isAppLoading = false;
    mockState.appLocked = false;
    mockState.isLoggingOut = false;
    mockState.accountSetupRequired = false;
    mockState.nativeFlowCounter = 0;
    mockState.activations = [];
    mockState.failActivate = false;
    mockNativeListener = undefined;
    jest.clearAllMocks();
    clearCurrentCapabilities();
    // Close any adapter from a previous test so the next call recreates one.
    onHostTearDown();
  });

  test("no Connect operation is authorized before grants are installed", async () => {
    const outcome = await executeConnectRequest(
      { operation: "status" },
      { ...EMPTY_CAPABILITIES }
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("NOT_AUTHORIZED");
    expect(mockState.executed).toHaveLength(0);
  });

  test("grants are never installed for a different account", async () => {
    mountHost();
    mockState.accountId = "account-B";
    const generation = await installGrants("account-A", CAPS);
    expect(generation).toBeUndefined();
    expect(mockState.hasGrants).toBe(false);
  });

  test("a lock invalidates the host epoch", () => {
    mountHost();
    const captured = currentHostIdentity();
    expect(isHostIdentityCurrent(captured)).toBe(true);
    onHostLock();
    expect(isHostIdentityCurrent(captured)).toBe(false);
  });

  test("an in-flight request replies and refreshes nothing after a lock", async () => {
    const cleanup = await adoptSession();
    expect(mockState.hasGrants).toBe(true);
    const flow = mockState.nativeFlowCounter;

    // Gate the execution, emit a request, lock while it is suspended, then let
    // it finish: the reply must never be sent for the stale epoch.
    let release: (() => void) | undefined;
    mockState.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    emitClaim("1".repeat(32), flow, NATIVE_SESSION_ID);
    await flush();
    expect(mockState.executed).toHaveLength(1);
    onHostLock();
    release!();
    await settle();
    expect(mockFns.reply).not.toHaveBeenCalled();
    expect(mockFns.refreshAllStores).not.toHaveBeenCalled();
    cleanup();
  });

  test("a correlated request is answered when the epoch is current", async () => {
    const cleanup = await adoptSession();
    const flow = mockState.nativeFlowCounter;
    emitClaim("2".repeat(32), flow, NATIVE_SESSION_ID);
    await settle();
    expect(mockFns.reply).toHaveBeenCalledTimes(1);
    expect(mockFns.reply.mock.calls[0][0]).toBe("2".repeat(32));
    expect(mockFns.reply.mock.calls[0][1]).toEqual({
      ok: true,
      result: { operation: "status" }
    });
    // The reply carries the exact native lease generation + session id.
    expect(mockFns.reply.mock.calls[0][2]).toBe(flow);
    expect(mockFns.reply.mock.calls[0][3]).toBe(NATIVE_SESSION_ID);
    cleanup();
  });

  test("a native event with no adopted session is ignored", async () => {
    const cleanup = startConnectHost();
    await onHostAccountReady("account-A", CAPS);
    // No `startSession`: there is no adopted native identity to fence against.
    emitClaim("3".repeat(32), 1, NATIVE_SESSION_ID);
    await settle();
    expect(mockState.executed).toHaveLength(0);
    expect(mockFns.reply).not.toHaveBeenCalled();
    cleanup();
  });

  test("a queued event from a previous session is dropped after Stop -> Start", async () => {
    const cleanup = await adoptSession();
    const firstFlow = mockState.nativeFlowCounter;
    // Stop invalidates the epoch and drops the adopted identity; Start adopts a
    // *new* native lease generation (the native engine bumps it on invalidate).
    await stopSession();
    await onHostAccountReady("account-A", CAPS);
    const restarted = await startSession("account-A");
    expect(restarted).toBe(true);
    const secondFlow = mockState.nativeFlowCounter;
    expect(secondFlow).not.toBe(firstFlow);

    // A request queued under the first session must never execute.
    emitClaim("4".repeat(32), firstFlow, NATIVE_SESSION_ID);
    await settle();
    expect(mockState.executed).toHaveLength(0);
    expect(mockFns.reply).not.toHaveBeenCalled();
    cleanup();
  });

  test("a request whose context does not match the live session is ignored", async () => {
    const cleanup = await adoptSession();
    const flow = mockState.nativeFlowCounter;
    emitClaim("5".repeat(32), flow + 1, NATIVE_SESSION_ID);
    emitClaim("6".repeat(32), flow, "AAAAAAAAAAAAAAAAAAAAAA");
    await settle();
    expect(mockState.executed).toHaveLength(0);
    expect(mockFns.reply).not.toHaveBeenCalled();
    cleanup();
  });

  test("an A -> B -> A account cycle is fenced by the epoch", () => {
    mountHost();
    const first = currentHostIdentity();
    // Account change (B), then back (A): each seam bumps the epoch, so the
    // identity captured for A is stale even though the id matches again.
    onHostLock();
    onHostLock();
    expect(isHostIdentityCurrent(first)).toBe(false);
  });

  // --------------------------------------------------------- authoritative gate

  test("hostEligibility denies on every authoritative lifecycle edge", () => {
    mountHost();
    expect(hostEligibility()).toEqual({
      eligible: true,
      accountId: "account-A"
    });
    for (const edge of [
      "dbInitialized",
      "isAppLoading",
      "appLocked",
      "isLoggingOut",
      "accountSetupRequired"
    ] as const) {
      (mockState as Record<string, unknown>)[edge] =
        edge === "dbInitialized" ? false : true;
      expect(hostEligibility().eligible).toBe(false);
      (mockState as Record<string, unknown>)[edge] =
        edge === "dbInitialized" ? true : false;
    }
    mockState.accountId = null;
    expect(hostEligibility().eligible).toBe(false);
  });

  test("a locked app can never resurrect rights on an unlock callback race", async () => {
    mountHost();
    await onHostAccountReady("account-A", CAPS);
    expect(mockState.hasGrants).toBe(true);

    // The exact reviewer sequence: a lock lands, the synchronous seam fences,
    // and a racing `onHostAccountReady` (e.g. from a stale unlock callback)
    // must deny *before* the unconditional adapter.unlock().
    mockState.appLocked = true;
    onHostLock();
    const generation = await onHostAccountReady("account-A", CAPS);
    expect(generation).toBeUndefined();
    expect(mockState.hasGrants).toBe(false);
    expect(hostAdapter()?.locked).toBe(true);
    expect(getCurrentCapabilities().canRead).toBe(false);
  });

  test("a lock during a pending durable write never resurrects rights", async () => {
    mountHost();
    await onHostAccountReady("account-A", CAPS);

    // Suspend the write, lock the app, fence, then let the write finish and try
    // to apply — the post-write recheck must deny and leave the adapter locked.
    let release: (() => void) | undefined;
    mockState.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = writeLocalRecord({
      v: 1,
      accountId: "account-A",
      capabilities: CAPS
    });
    await flush();
    mockState.appLocked = true;
    onHostLock();
    release!();
    const written = await pending;
    expect(written).toBe(true);

    const generation = await onHostAccountReady("account-A", CAPS);
    expect(generation).toBeUndefined();
    expect(mockState.hasGrants).toBe(false);
    expect(hostAdapter()?.locked).toBe(true);
  });

  test("a locked app denies a direct execute too", async () => {
    mountHost();
    await onHostAccountReady("account-A", CAPS);
    mockState.appLocked = true;
    const outcome = await executeConnectRequest(
      { operation: "status" },
      CAPS
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("INVALID_INPUT");
    expect(mockState.executed).toHaveLength(0);
  });

  // -------------------------------------------------------------- two-phase start

  test("startSession activates the exact adopted flow/session (two-phase)", async () => {
    await writeRecord();
    mountHost();
    const started = await startSession("account-A");
    expect(started).toBe(true);
    const active = currentActiveNativeSession();
    expect(active).toBeDefined();
    expect(active?.nativeSessionId).toBe(NATIVE_SESSION_ID);
    expect(active?.nativeFlowGeneration).toBe(1);
    expect(isActiveNativeSession(active!)).toBe(true);
    expect(mockState.activations).toEqual([
      { flow: 1, sessionId: NATIVE_SESSION_ID }
    ]);
  });

  test("a failed activation revokes the adopted context and reports no success", async () => {
    await writeRecord();
    mountHost();
    mockState.failActivate = true;
    const started = await startSession("account-A");
    expect(started).toBe(false);
    expect(currentActiveNativeSession()).toBeUndefined();
    expect(getCurrentCapabilities().canRead).toBe(false);
    expect(mockFns.stopSession).toHaveBeenCalled();
  });

  test("a non-canonical native session id is refused before adoption", async () => {
    await writeRecord();
    mountHost();
    mockFns.startSession.mockResolvedValueOnce({
      sessionId: "c2Vzc2lvbmlkMDAwMDAwMDAwMDA",
      grantsGeneration: 1,
      nativeLeaseGeneration: 1
    });
    const started = await startSession("account-A");
    expect(started).toBe(false);
    expect(currentActiveNativeSession()).toBeUndefined();
    expect(mockState.activations).toHaveLength(0);
    expect(mockFns.stopSession).toHaveBeenCalled();
  });

  test("startSession refuses when the matching record cannot be applied", async () => {
    await writeLocalRecord({
      v: 1,
      accountId: "account-A",
      capabilities: CAPS
    });
    mountHost();
    // No broker paired: the persisted record for this account cannot be applied,
    // so no native session may open and no success may be reported.
    mockFns.getStatus.mockResolvedValueOnce({
      paired: false,
      sessionActive: false
    });
    const started = await startSession("account-A");
    expect(started).toBe(false);
    expect(mockFns.startSession).not.toHaveBeenCalled();
    expect(mockState.hasGrants).toBe(false);
  });

  test("a grant/account change during the start handshake aborts the session", async () => {
    await writeRecord();
    mountHost();
    let release: (() => void) | undefined;
    mockFns.startSession.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        sessionId: NATIVE_SESSION_ID,
        grantsGeneration: 1,
        nativeLeaseGeneration: 1
      };
    });
    const pending = startSession("account-A");
    await flush();
    // A grant change / lock that lands mid-handshake bumps the epoch.
    onHostLock();
    release!();
    const started = await pending;
    expect(started).toBe(false);
    expect(currentActiveNativeSession()).toBeUndefined();
    expect(mockFns.activateSession).not.toHaveBeenCalled();
  });

  test("an omitted create notebook is bound to the chosen default consistently", () => {
    const request = {
      operation: "create_note",
      operationId: "op-1",
      content: "hello"
    } as ConnectRequest;
    const first = normalizeInboundRequest(request, CAPS);
    const second = normalizeInboundRequest(request, CAPS);
    expect(first).toMatchObject({ notebookId: "nb1" });
    expect(second).toMatchObject({ notebookId: "nb1" });
    expect(first).toEqual(second);
  });

  test("a stale default that is not in the granted set is never injected", () => {
    const request = {
      operation: "create_note",
      operationId: "op-1",
      content: "hello"
    } as ConnectRequest;
    const stale = normalizeCapabilities({
      canCreate: true,
      defaultNotebookId: "nb-stale",
      notebookIds: ["nb1"]
    });
    expect(normalizeInboundRequest(request, stale)).not.toHaveProperty(
      "notebookId"
    );
    // And an empty snapshot injects nothing at all.
    clearCurrentCapabilities();
    expect(
      normalizeInboundRequest(request, getCurrentCapabilities())
    ).not.toHaveProperty("notebookId");
  });

  test("create/change/task capabilities require an explicit selection", () => {
    const withoutSelection = buildGrantsInput("account-A", {
      canRead: false,
      canCreate: true,
      canChange: true,
      canTask: true,
      notebookIds: [],
      listIds: [],
      noteIds: []
    });
    expect(withoutSelection.canCreate).toBe(false);
    expect(withoutSelection.canChange).toBe(false);
    expect(withoutSelection.canTask).toBe(false);
    expect(withoutSelection.canRead).toBe(false);
  });

  test("a failed connection error never leaks ids or payloads", async () => {
    const outcome = await executeConnectRequest(
      { operation: "status" },
      EMPTY_CAPABILITIES
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toBe(
      "This operation is not permitted by the active grants."
    );
    expect(JSON.stringify(outcome)).not.toContain("account-A");
  });

  test("a confirmed write refreshes existing surfaces and reconciles tasks", async () => {
    mountHost();
    await onHostAccountReady("account-A", CAPS);
    const outcome = await executeConnectRequest(
      {
        operation: "create_note",
        operationId: "op-write",
        notebookId: "nb1",
        content: "body"
      },
      CAPS
    );
    expect(outcome.ok).toBe(true);
    expect(mockFns.queueRoutesForUpdate).toHaveBeenCalled();
    expect(mockFns.updateRelation).toHaveBeenCalled();
    expect(mockFns.refreshAllStores).toHaveBeenCalled();
    expect(mockFns.updateNotes).toHaveBeenCalled();
    expect(mockFns.reconcile).toHaveBeenCalled();
  });

  test("a malformed or context-less native claim is ignored", () => {
    expect(
      parseClaimEvent({
        ticketId: "not-hex",
        request: {},
        generation: 1,
        sessionId: NATIVE_SESSION_ID
      })
    ).toBeUndefined();
    expect(
      parseClaimEvent({
        ticketId: "1".repeat(32),
        generation: 1,
        sessionId: NATIVE_SESSION_ID
      })
    ).toBeUndefined();
    expect(
      parseClaimEvent({
        ticketId: "1".repeat(32),
        request: { operation: "status" },
        generation: 1,
        sessionId: NATIVE_SESSION_ID
      })
    ).toMatchObject({ ticketId: "1".repeat(32) });
    // A missing generation or session id is rejected outright.
    expect(
      parseClaimEvent({
        ticketId: "1".repeat(32),
        request: { operation: "status" },
        sessionId: NATIVE_SESSION_ID
      })
    ).toBeUndefined();
    expect(
      parseClaimEvent({
        ticketId: "1".repeat(32),
        request: { operation: "status" },
        generation: 1
      })
    ).toBeUndefined();
    // Malformed session metadata is rejected outright.
    expect(
      parseClaimEvent({
        ticketId: "1".repeat(32),
        request: { operation: "status" },
        generation: 1.5,
        sessionId: NATIVE_SESSION_ID
      })
    ).toBeUndefined();
    expect(
      parseClaimEvent({
        ticketId: "1".repeat(32),
        request: { operation: "status" },
        generation: 1,
        sessionId: 7
      })
    ).toBeUndefined();
    // A non-canonical / wrong-length session id is rejected.
    expect(
      parseClaimEvent({
        ticketId: "1".repeat(32),
        request: { operation: "status" },
        generation: 1,
        sessionId: "c2Vzc2lvbmlkMDAwMDAwMDAwMDA"
      })
    ).toBeUndefined();
    expect(isCanonicalNativeSessionId(NATIVE_SESSION_ID)).toBe(true);
    expect(isCanonicalNativeSessionId("A".repeat(21) + "B")).toBe(false);
  });

  test("a session is never started before pairing, and the credential never reaches JS", async () => {
    await writeRecord();
    mountHost();
    mockFns.getStatus.mockResolvedValueOnce({
      paired: false,
      sessionActive: false
    });
    const generation = await onHostAccountReady("account-A", CAPS);
    expect(generation).toBeUndefined();
    expect(mockState.hasGrants).toBe(false);

    // The pairing import is native-only: JS receives a redacted status, never
    // the credential, and only then may a session be started.
    const picked = await pickPairingFile();
    expect(picked.paired).toBe(true);
    expect(JSON.stringify(picked)).not.toContain("secret");
    expect(mockFns.setAppDidEnterBackgroundForAction).toHaveBeenCalledWith(true);
    expect(mockFns.setAppDidEnterBackgroundForAction).toHaveBeenLastCalledWith(
      false
    );
    await startSession("account-A");
    const args = mockFns.startSession.mock.calls[0];
    expect(args[0]).toBe("account-A");
    expect(JSON.stringify(args)).not.toMatch(/secret|Bearer/);
  });

  test("stopSession ends the session and disconnect clears grants", async () => {
    await writeRecord();
    mountHost();
    await onHostAccountReady("account-A", CAPS);
    await startSession("account-A");
    await stopSession();
    expect(mockFns.stopSession).toHaveBeenCalled();
    await disconnect();
    expect(mockFns.disconnect).toHaveBeenCalled();
    expect(mockState.hasGrants).toBe(false);
  });

  test("disconnect reports false when the durable record cannot be cleared", async () => {
    mountHost();
    await onHostAccountReady("account-A", CAPS);
    mockState.failDelete = true;
    const result = await disconnect();
    expect(result).toBe(false);
    // The teardown is still fenced even though the clear failed.
    expect(mockState.hasGrants).toBe(false);
    expect(getCurrentCapabilities().canRead).toBe(false);
  });

  test("stopSession fences the epoch synchronously, before the native stop resolves", async () => {
    mountHost();
    await onHostAccountReady("account-A", CAPS);
    const captured = currentHostIdentity();
    expect(isHostIdentityCurrent(captured)).toBe(true);
    const pending = stopSession();
    // The epoch is already invalid while the native stop is still in flight.
    expect(isHostIdentityCurrent(captured)).toBe(false);
    await pending;
    expect(getCurrentCapabilities().canRead).toBe(false);
  });

  test("persisted grants are not reinstalled for a different account", async () => {
    mockState.accountId = "account-C";
    const generation = await reinstallPersistedGrantsIfSameAccount();
    expect(generation).toBeUndefined();
  });

  test("a restored record never activates without pairing and an explicit start", async () => {
    // A record that "came back" (backup restore / reopen) for the same account
    // still installs nothing while no broker is paired...
    await writeLocalRecord({
      v: 1,
      accountId: "account-A",
      capabilities: CAPS
    });
    mountHost();
    mockFns.getStatus.mockResolvedValueOnce({
      paired: false,
      sessionActive: false
    });
    const generation = await reinstallPersistedGrantsIfSameAccount();
    expect(generation).toBeUndefined();
    expect(mockState.hasGrants).toBe(false);
    // ...and reading the record on its own installs nothing either.
    expect(getCurrentCapabilities().canRead).toBe(false);
  });

  // -------------------------------------------------------------- durable record

  test("a written local record is stored as JSON text and survives a reopen", async () => {
    const record = { v: 1 as const, accountId: "account-A", capabilities: CAPS };
    const written = await writeLocalRecord(record);
    expect(written).toBe(true);
    expect(mockState.persisted).toHaveLength(1);
    // The value is a string, exactly as a reopened SQLite row would hold it.
    expect(typeof mockState.persisted[0]).toBe("object");
    expect(typeof (mockState.persisted[0] as { value: unknown }).value).toBe(
      "string"
    );

    const readBack = readLocalRecord();
    expect(readBack).toMatchObject({ v: 1, accountId: "account-A" });
    expect(readBack?.capabilities).toEqual(CAPS);

    // A reopen reads the same string back: identical result.
    const reopened = readLocalRecord();
    expect(reopened).toEqual(readBack);
  });

  test("a rejected durable write fails closed and reports no success", async () => {
    mockState.failUpsert = true;
    const written = await writeLocalRecord({
      v: 1,
      accountId: "account-A",
      capabilities: CAPS
    });
    expect(written).toBe(false);
    expect(mockState.persisted).toHaveLength(0);
    expect(readLocalRecord()).toBeUndefined();
  });

  test("clearLocalRecord awaits the durable delete", async () => {
    await writeLocalRecord({
      v: 1,
      accountId: "account-A",
      capabilities: CAPS
    });
    expect(readLocalRecord()).toBeDefined();
    const cleared = await clearLocalRecord();
    expect(cleared).toBe(true);
    expect(readLocalRecord()).toBeUndefined();
  });

  test("a malformed, foreign or legacy local record is rejected", () => {
    // Wrong version.
    mockState.storedValue = JSON.stringify({
      v: 2,
      localOnly: true,
      accountId: "account-A",
      capabilities: {}
    });
    expect(readLocalRecord()).toBeUndefined();
    // Missing `localOnly`.
    mockState.storedValue = JSON.stringify({
      v: 1,
      accountId: "account-A",
      capabilities: {}
    });
    expect(readLocalRecord()).toBeUndefined();
    // Empty account id.
    mockState.storedValue = JSON.stringify({
      v: 1,
      localOnly: true,
      accountId: "",
      capabilities: {}
    });
    expect(readLocalRecord()).toBeUndefined();
    // Not JSON at all.
    mockState.storedValue = "{ not json";
    expect(readLocalRecord()).toBeUndefined();
    // Oversized.
    mockState.storedValue = "x".repeat(64 * 1024);
    expect(readLocalRecord()).toBeUndefined();
    // And the serializer refuses an invalid record outright.
    expect(
      serializeLocalRecord({ v: 1, accountId: "", capabilities: CAPS })
    ).toBeUndefined();
  });

  // --------------------------------------------------------- capability snapshot

  test("the capability snapshot is installed only after grants and cleared on lock", async () => {
    mountHost();
    expect(getCurrentCapabilities().canRead).toBe(false);
    await onHostAccountReady("account-A", CAPS);
    expect(getCurrentCapabilities().canRead).toBe(true);
    expect(getCurrentCapabilities().notebookIds).toEqual(["nb1"]);
    onHostLock();
    expect(getCurrentCapabilities().canRead).toBe(false);
    expect(getCurrentCapabilities().notebookIds).toEqual([]);
  });

  test("setCurrentCapabilities deep-copies, so callers cannot share or widen a snapshot", () => {
    const mutable = normalizeCapabilities({
      canRead: true,
      notebookIds: ["nb1"]
    });
    const returned = setCurrentCapabilities(mutable);
    mutable.notebookIds.push("nb-evil");
    expect(getCurrentCapabilities().notebookIds).toEqual(["nb1"]);
    // The returned value is a fresh copy too: mutating it cannot reach the
    // trusted snapshot, and it shares no array reference.
    expect(returned).not.toBe(mutable);
    returned.notebookIds.push("nb-also-evil");
    expect(getCurrentCapabilities().notebookIds).toEqual(["nb1"]);
    clearCurrentCapabilities();
  });

  test("startSession installs the persisted grants before the broker session opens", async () => {
    await writeLocalRecord({
      v: 1,
      accountId: "account-A",
      capabilities: CAPS
    });
    mountHost();
    const started = await startSession("account-A");
    expect(started).toBe(true);
    expect(mockState.hasGrants).toBe(true);
    expect(mockFns.startSession).toHaveBeenCalled();
  });

  test("an absent record never starts a session and never touches the native side", async () => {
    mountHost();
    const started = await startSession("account-A");
    expect(started).toBe(false);
    // Not one native call: no Keychain read (`getStatus`), no credential/session
    // handshake, no network.
    expect(mockFns.getStatus).not.toHaveBeenCalled();
    expect(mockFns.startSession).not.toHaveBeenCalled();
    expect(mockFns.activateSession).not.toHaveBeenCalled();
    expect(mockState.hasGrants).toBe(false);
    expect(mockState.executed).toHaveLength(0);
  });

  test("a record for a foreign account never starts a session (zero native calls)", async () => {
    await writeLocalRecord({
      v: 1,
      accountId: "account-B",
      capabilities: CAPS
    });
    mockState.accountId = "account-A";
    mountHost();
    const started = await startSession("account-A");
    // Truthful result: the record belongs to another account, so nothing is
    // installed, no native session opens and no success is reported.
    expect(started).toBe(false);
    expect(mockFns.getStatus).not.toHaveBeenCalled();
    expect(mockFns.startSession).not.toHaveBeenCalled();
    expect(mockFns.activateSession).not.toHaveBeenCalled();
    expect(mockState.hasGrants).toBe(false);
    // The foreign record is left untouched (never silently rewritten/cleared).
    expect(readLocalRecord()).toMatchObject({ accountId: "account-B" });
  });

  test("an unmount fences the adapter and stops the native poll loop", async () => {
    mountHost();
    await onHostAccountReady("account-A", CAPS);
    const cleanup = startConnectHost();
    const captured = currentHostIdentity();
    cleanup();
    expect(isHostIdentityCurrent(captured)).toBe(false);
    expect(mockFns.stopSession).toHaveBeenCalled();
    expect(getCurrentCapabilities().canRead).toBe(false);
    expect(currentActiveNativeSession()).toBeUndefined();
  });

  // ------------------------------------------------------ pairing import fence

  test("the picker fences the live JS session synchronously, before it opens", async () => {
    const cleanup = await adoptSession();
    expect(isSessionActive()).toBe(true);
    expect(getCurrentCapabilities().canRead).toBe(true);
    const flow = mockState.nativeFlowCounter;

    let release: (() => void) | undefined;
    mockFns.pickPairingFile.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { paired: true, brokerId: "b".repeat(32), port: 45999 };
    });
    const pending = pickPairingFile();
    await flush();

    // While the picker is open the JS session is *already* fenced: no adopted
    // identity, no capability snapshot, no live session, locked adapter.
    expect(isSessionActive()).toBe(false);
    expect(currentActiveNativeSession()).toBeUndefined();
    expect(getCurrentCapabilities().canRead).toBe(false);
    expect(hostAdapter()?.locked).toBe(true);
    expect(mockFns.stopSession).toHaveBeenCalled();

    // A claim queued under the fenced session can never execute.
    emitClaim("7".repeat(32), flow, NATIVE_SESSION_ID);
    await settle();
    expect(mockState.executed).toHaveLength(0);
    expect(mockFns.reply).not.toHaveBeenCalled();

    release!();
    const result = await pending;
    expect(result).toMatchObject({ paired: true });
    cleanup();
  });

  test("an old queued claim after a re-pair executes zero Core operations", async () => {
    const cleanup = await adoptSession();
    const oldFlow = mockState.nativeFlowCounter;

    // Retain the exact callback the adopted session registered *before* the
    // picker runs: the claim was queued under that listener, so it must be
    // delivered through it. That proves the host itself drops the stale context
    // (zero Core operations), not that the emitter stopped delivering.
    const listener = mockNativeListener;
    expect(typeof listener).toBe("function");

    // Re-pair from the picker, then start again on the new pairing.
    const picked = await pickPairingFile();
    expect(picked).toMatchObject({ paired: true });
    const started = await startSession("account-A");
    expect(started).toBe(true);
    const newFlow = mockState.nativeFlowCounter;
    expect(newFlow).not.toBe(oldFlow);

    // A claim queued under the *previous* session must never execute, even
    // though it is delivered through the retained original callback.
    listener!({
      ticketId: "8".repeat(32),
      request: { operation: "status" },
      generation: oldFlow,
      sessionId: NATIVE_SESSION_ID
    });
    await settle();
    expect(mockState.executed).toHaveLength(0);
    expect(mockFns.reply).not.toHaveBeenCalled();
    cleanup();
  });

  test("a lock while the picker is open never adopts the picked pairing", async () => {
    const cleanup = startConnectHost();
    await writeRecord();
    let release: (() => void) | undefined;
    mockFns.pickPairingFile.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { paired: true, brokerId: "b".repeat(32), port: 45999 };
    });
    const pending = pickPairingFile();
    await flush();
    onHostLock();
    release!();
    const result = await pending;
    expect(result).toEqual({ paired: false, cancelled: true, stale: true });
    expect(mockState.activations).toHaveLength(0);
    expect(currentActiveNativeSession()).toBeUndefined();
    expect(getCurrentCapabilities().canRead).toBe(false);
    cleanup();
  });

  test("an app-lock during the pick (with no lifecycle callback) is stale", async () => {
    const cleanup = startConnectHost();
    await writeRecord();
    let release: (() => void) | undefined;
    mockFns.pickPairingFile.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { paired: true, brokerId: "b".repeat(32), port: 45999 };
    });
    const pending = pickPairingFile();
    await flush();
    // The authoritative store changed while the picker was open, without any
    // seam running: the re-check of the captured eligibility state alone must
    // fence the completion.
    mockState.appLocked = true;
    release!();
    const result = await pending;
    expect(result).toEqual({ paired: false, cancelled: true, stale: true });
    expect(mockState.activations).toHaveLength(0);
    cleanup();
  });

  test("a disconnect while the picker is open never adopts the picked pairing", async () => {
    const cleanup = startConnectHost();
    await writeRecord();
    let release: (() => void) | undefined;
    mockFns.pickPairingFile.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { paired: true, brokerId: "b".repeat(32), port: 45999 };
    });
    const pending = pickPairingFile();
    await flush();
    const disconnected = await disconnect();
    expect(disconnected).toBe(true);
    release!();
    const result = await pending;
    expect(result.paired).toBe(false);
    expect(result.stale).toBe(true);
    // The teardown stays authoritative: the record is gone and nothing adopts.
    expect(readLocalRecord()).toBeUndefined();
    expect(currentActiveNativeSession()).toBeUndefined();
    expect(mockState.activations).toHaveLength(0);
    cleanup();
  });

  test("concurrent picks: only the newest completion is adopted", async () => {
    const cleanup = startConnectHost();
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    mockFns.pickPairingFile
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { paired: true, brokerId: "a".repeat(32), port: 45999 };
      })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
        return { paired: true, brokerId: "b".repeat(32), port: 45998 };
      });

    const first = pickPairingFile();
    await flush();
    const second = pickPairingFile();
    await flush();
    releaseSecond!();
    const secondResult = await second;
    expect(secondResult).toMatchObject({
      paired: true,
      brokerId: "b".repeat(32)
    });
    releaseFirst!();
    const firstResult = await first;
    // The first pick's late completion belongs to an invalidated flow.
    expect(firstResult).toEqual({
      paired: false,
      cancelled: true,
      stale: true
    });
    expect(currentActiveNativeSession()).toBeUndefined();
    expect(getCurrentCapabilities().canRead).toBe(false);
    cleanup();
  });

  test("a native stale completion is never reported as a pairing", async () => {
    const cleanup = startConnectHost();
    mockFns.pickPairingFile.mockResolvedValueOnce({
      paired: true,
      brokerId: "b".repeat(32),
      port: 45999,
      stale: true
    });
    const result = await pickPairingFile();
    expect(result).toEqual({ paired: false, cancelled: true, stale: true });
    cleanup();
  });

  test("a session started while the picker was open does not survive the import", async () => {
    const cleanup = startConnectHost();
    await writeRecord();
    let release: (() => void) | undefined;
    mockFns.pickPairingFile.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { paired: true, brokerId: "b".repeat(32), port: 45999 };
    });
    const pending = pickPairingFile();
    await flush();
    // A start that races the open picker (a programmatic caller, not the UI):
    // the import still owns the lifecycle when it completes.
    expect(await startSession("account-A")).toBe(true);
    expect(isSessionActive()).toBe(true);
    release!();
    expect(await pending).toMatchObject({ paired: true });
    expect(isSessionActive()).toBe(false);
    expect(currentActiveNativeSession()).toBeUndefined();
    expect(getCurrentCapabilities().canRead).toBe(false);
    cleanup();
  });

  test("a cancelled or invalid import preserves the credential and the record", async () => {
    const cleanup = startConnectHost();
    await writeRecord();
    mockFns.pickPairingFile.mockResolvedValueOnce({
      paired: false,
      cancelled: true
    });
    const cancelled = await pickPairingFile();
    expect(cancelled.paired).toBe(false);
    expect(cancelled.stale).toBeUndefined();
    // Nothing tears the existing pairing or the durable record down.
    expect(mockFns.disconnect).not.toHaveBeenCalled();
    expect(readLocalRecord()).toMatchObject({ accountId: "account-A" });

    mockFns.pickPairingFile.mockRejectedValueOnce(new Error("pairing_invalid"));
    await expect(pickPairingFile()).rejects.toThrow("pairing_invalid");
    expect(mockFns.disconnect).not.toHaveBeenCalled();
    expect(readLocalRecord()).toMatchObject({ accountId: "account-A" });
    cleanup();
  });

  // -------------------------------------------------------- stale execute fence

  test("a stale captured identity writes nothing (zero Core operations)", async () => {
    mountHost();
    await onHostAccountReady("account-A", CAPS);
    expect(mockState.hasGrants).toBe(true);
    const stale = currentHostIdentity();
    // A seam bumps the epoch after the caller captured it. The adapter is still
    // unlocked and the grants are still installed, so only the pre-execute
    // identity check can refuse this — and it must refuse *before* any write.
    invalidateHost();
    const outcome = await executeConnectRequest(
      { operation: "status" },
      CAPS,
      stale
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("INVALID_INPUT");
    expect(mockState.executed).toHaveLength(0);

    // A direct call that captures the *current* identity still executes.
    const fresh = await executeConnectRequest({ operation: "status" }, CAPS);
    expect(fresh.ok).toBe(true);
    expect(mockState.executed).toHaveLength(1);
  });
});

// The pure storage codec: capability normalization and the *byte* bound. These
// run without any mock state — they are exactly the forms the encrypted
// `settingitem` row holds.
describe("VeyraN Connect grant codec bounds", () => {
  test("an empty normalization never shares arrays with the frozen template", () => {
    const first = normalizeCapabilities(null);
    expect(first).toEqual(EMPTY_CAPABILITIES);

    // Mutating the returned empty must not poison the shared template...
    first.notebookIds.push("nb-poison");
    first.listIds.push("list-poison");
    first.noteIds.push("note-poison");
    expect(EMPTY_CAPABILITIES.notebookIds).toEqual([]);
    expect(EMPTY_CAPABILITIES.listIds).toEqual([]);
    expect(EMPTY_CAPABILITIES.noteIds).toEqual([]);
    expect(normalizeCapabilities(undefined)).toEqual(EMPTY_CAPABILITIES);

    // ...and every future trusted empty owns independent arrays.
    const second = normalizeCapabilities(undefined);
    expect(second.notebookIds).toEqual([]);
    expect(second.notebookIds).not.toBe(first.notebookIds);
    const third = emptyCapabilities();
    third.noteIds.push("note-poison");
    expect(emptyCapabilities().noteIds).toEqual([]);
    expect(EMPTY_CAPABILITIES.noteIds).toEqual([]);
  });

  test("the byte counter counts code points, not UTF-16 code units", () => {
    // One astral code point: two UTF-16 units, four UTF-8 bytes.
    expect("😀".length).toBe(2);
    expect(boundedUtf8ByteLength("😀")).toBe(4);
    expect(boundedUtf8ByteLength("a")).toBe(1);
    expect(boundedUtf8ByteLength("é")).toBe(2);
    expect(boundedUtf8ByteLength("€")).toBe(3);
    // Invalid lone surrogates are counted as their 3-byte replacement form;
    // the walk is total and never throws.
    expect(boundedUtf8ByteLength("\uD83D")).toBe(3);
    expect(boundedUtf8ByteLength("\uDC00")).toBe(3);
    expect(boundedUtf8ByteLength("\uD83Da")).toBe(4);
    // A small limit short-circuits: an over-bound value reports > limit.
    expect(boundedUtf8ByteLength("😀".repeat(100), 8) > 8).toBe(true);
  });

  test("an over-bound UTF-8 record is refused even when its length fits", () => {
    // 200 ids of 35 astral chars: ~14.3k UTF-16 units (under the bound) but
    // ~28k UTF-8 bytes (over it). A `length` check would admit this record.
    const astral = "😀".repeat(35);
    const ids = Array.from({ length: 200 }, (_value, index) => `${astral}${index}`);
    const value = JSON.stringify({
      v: 1,
      localOnly: true,
      accountId: "account-A",
      capabilities: { canRead: true, noteIds: ids }
    });
    expect(value.length <= LOCAL_RECORD_MAX_BYTES).toBe(true);
    expect(boundedUtf8ByteLength(value) > LOCAL_RECORD_MAX_BYTES).toBe(true);
    // Neither the codec path nor the stored-value path may accept it.
    expect(
      serializeLocalRecord({
        v: 1,
        accountId: "account-A",
        capabilities: normalizeCapabilities({ canRead: true, noteIds: ids })
      })
    ).toBeUndefined();
    expect(parseLocalRecordValue(value)).toBeUndefined();
  });

  test("a valid unicode record under the byte bound still round-trips", () => {
    const ids = Array.from({ length: 40 }, (_value, index) => `😀${index}`);
    const capabilities = normalizeCapabilities({ canRead: true, noteIds: ids });
    const serialized = serializeLocalRecord({
      v: 1,
      accountId: "account-A",
      capabilities
    });
    expect(typeof serialized).toBe("string");
    expect(boundedUtf8ByteLength(serialized!) <= LOCAL_RECORD_MAX_BYTES).toBe(
      true
    );
    const parsed = parseLocalRecordValue(serialized);
    expect(parsed?.accountId).toBe("account-A");
    expect(parsed?.capabilities.noteIds).toEqual(capabilities.noteIds);
  });
});
