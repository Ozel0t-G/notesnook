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

/**
 * VeyraN Connect host (JavaScript side).
 *
 * The native `VeyraNConnectModule` is the *outgoing* loopback broker client: it
 * holds the paired credential, verifies the pinned TLS certificate and polls
 * one correlated claim at a time, emitting each validated request to JS. This
 * module is the other half: it validates the request against the pure Core wire
 * schema, executes it against the encrypted Core domain through a single
 * `ConnectAdapter`, and answers the exact correlated ticket.
 *
 * Safety shape:
 *  - explicit, opt-in capability switches (all default off); no right is ever
 *    inferred from a request id;
 *  - `can_create` additionally requires a chosen, live default notebook, and an
 *    omitted `create_note.notebookId` is normalized to a default that is still a
 *    member of the immutable granted set;
 *  - every authorization/unlock is gated by one *authoritative*, fail-closed
 *    eligibility proof (`hostEligibility`) read from the real lifecycle stores
 *    (`db.isInitialized`, `SettingStore.isAppLoading`, `UserStore.appLocked` /
 *    `isLoggingOut` / `accountSetupRequired`) and a persisted account — never
 *    from an assumed default or a comment;
 *  - grants are installed only for a *persisted, validated* account and are
 *    snapshotted immutably by Core; the JS-side snapshot is deep-copied and
 *    cleared synchronously at every lifecycle seam so a stale default can never
 *    be used;
 *  - a session is started in two phases: the native side establishes it and
 *    returns the exact `(sessionId, coreGrantsGeneration, nativeLeaseGeneration)`
 *    context without polling, JS adopts that context immutably, then calls
 *    `activateSession(flow, session)` and only then does polling begin. Every
 *    emitted event must carry a canonical session id and the matching native
 *    lease generation, rechecked before and after every await, so a queued
 *    Stop -> Start or A -> B -> A event can never execute;
 *  - the adapter is locked/cleared/closed synchronously at the account
 *    lifecycle seams, and a monotonic host epoch invalidates any in-flight
 *    request so a stale reply can never touch a different account/session;
 *  - the local grants record is an encrypted `SettingItem` (`localOnly: true`):
 *    it is excluded from Sync content and never carries a credential. Its ids
 *    and capability metadata can, however, appear in a user-created backup under
 *    the existing export rules, so a restored record is *never* auto-activated.
 */

import {
  ConnectAdapter,
  ConnectError,
  isConnectError,
  errorEnvelope,
  requestWireSchema,
  transportWireResponseSchema,
  wireResponseSchemaFor,
  type ConnectGrantsInput,
  type ConnectOperation,
  type ConnectRequest
} from "@notesnook/core";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import { DatabaseLogger, db } from "../common/database";
import Navigation from "./navigation";
import { NotePreviewWidget } from "./note-preview-widget";
import { TaskNotifications } from "./task-notifications";
import { refreshAllStores } from "../stores/create-db-collection-store";
import { useRelationStore } from "../stores/use-relation-store";
import { useSettingStore } from "../stores/use-setting-store";
import { useUserStore } from "../stores/use-user-store";
import {
  EMPTY_CAPABILITIES,
  LOCAL_RECORD_ID,
  LOCAL_RECORD_MAX_BYTES,
  boundedUtf8ByteLength,
  buildLocalRecordItem,
  emptyCapabilities,
  normalizeCapabilities,
  parseLocalRecordValue,
  readLocalRecordFrom,
  serializeLocalRecord,
  type ConnectCapabilities,
  type ConnectLocalRecord
} from "./veyran-connect-grants";

export { requestWireSchema, transportWireResponseSchema, wireResponseSchemaFor, errorEnvelope };
export type { ConnectGrantsInput, ConnectOperation, ConnectRequest };
// The capability model and the canonical record codec live in a pure module
// (no React Native, no database) so the headless Core persistence test drives
// the *same* parse/serialize path this service uses.
export {
  EMPTY_CAPABILITIES,
  LOCAL_RECORD_ID,
  LOCAL_RECORD_MAX_BYTES,
  boundedUtf8ByteLength,
  buildLocalRecordItem,
  emptyCapabilities,
  normalizeCapabilities,
  parseLocalRecordValue,
  readLocalRecordFrom,
  serializeLocalRecord
};
export type { ConnectCapabilities, ConnectLocalRecord };

// --------------------------------------------------------------- native bridge

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
/** A bounded, non-authorizing caller label (6..200 chars). */
export const CONNECT_CLIENT_ID = "veyran-connect-host";

export type ConnectNativeStatus = {
  paired: boolean;
  sessionActive: boolean;
  brokerId?: string;
  port?: number;
  bootId?: string;
  sessionId?: string;
  grantsGeneration?: number;
  supported?: boolean;
};

type ConnectNativeModule = {
  pickPairingFile(): Promise<{
    paired: boolean;
    brokerId?: string;
    port?: number;
    cancelled?: boolean;
    /** Set by the native side when it fenced the pick before any store. */
    stale?: boolean;
    supported?: boolean;
  }>;
  getStatus(): Promise<ConnectNativeStatus>;
  startSession(
    accountId: string,
    grantsGeneration: number,
    clientId: string
  ): Promise<{
    sessionId: string;
    grantsGeneration: number;
    /** The native session-engine lease generation this session belongs to. */
    nativeLeaseGeneration: number;
  }>;
  /**
   * Phase two of the start handshake: the native side re-checks the exact
   * (nativeLeaseGeneration, sessionId) tuple and only then begins polling. No
   * event is emitted before this resolves.
   */
  activateSession(
    nativeLeaseGeneration: number,
    sessionId: string
  ): Promise<void>;
  stopSession(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Answer exactly one correlated ticket, but only while the native session
   * still belongs to the expected lease generation and session id.
   */
  reply(
    ticketId: string,
    response: unknown,
    expectedLeaseGeneration: number,
    expectedSessionId: string
  ): Promise<{ accepted: true }>;
};

function nativeModule(): ConnectNativeModule | undefined {
  if (Platform.OS !== "ios") return undefined;
  const module = NativeModules.VeyraNConnectModule as
    | ConnectNativeModule
    | undefined;
  return module || undefined;
}

/** Mac Catalyst is the only platform where the native client is functional. */
export function isConnectPlatformSupported(): boolean {
  return (
    Platform.OS === "ios" &&
    (Platform as { isMacCatalyst?: boolean }).isMacCatalyst === true
  );
}

// ----------------------------------------------------- authoritative lifecycle

/**
 * Log a *static, bounded* category for a caught failure. The shared logger
 * prints an `Error`'s stack verbatim when one is passed, so a raw caught error
 * (which can carry a note payload, a provider body or a native error string)
 * must never be handed to it. Passing `undefined` as the error makes the logger
 * print exactly the fallback message; no payload, id or body is ever included.
 */
function logConnectFailure(category: string, fallback?: string): void {
  DatabaseLogger.error(undefined, fallback ? `${category}: ${fallback}` : category);
}

/**
 * A canonical, unpadded, 16-byte base64url value (exactly 22 chars). The low
 * unused bits of the final character must be zero — mirroring the native
 * `VeyraNConnectBase64URL.decodeCanonical`, so JS and the native transport
 * agree on what a valid session id is and a "long enough" id is never accepted.
 */
export function isCanonicalNativeSessionId(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 22) return false;
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) return false;
  const index =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(
      value[21]
    );
  return index >= 0 && index % 16 === 0;
}

export type HostEligibility = {
  /** True only when the host may authorize *or* unlock anything right now. */
  eligible: boolean;
  /** The persisted Notes account id, or `null` when none is proven. */
  accountId: string | null;
};

/**
 * The single, fail-closed eligibility proof.
 *
 * It reads the *authoritative* lifecycle stores — not a comment and not an
 * assumed default — and denies unless every precondition holds:
 *   - the encrypted database is initialized (`db.isInitialized`);
 *   - the app is not still hydrating (`SettingStore.isAppLoading`);
 *   - the user is not App Locked (`UserStore.appLocked`);
 *   - no logout is in progress (`UserStore.isLoggingOut`);
 *   - no account (re)setup is pending (`UserStore.accountSetupRequired`);
 *   - a persisted account id is actually present.
 *
 * Any thrown getter (a store not yet created, an unsupported platform) denies
 * without enumerating the database or touching the Keychain.
 */
export function hostEligibility(): HostEligibility {
  try {
    const user = useUserStore.getState();
    const settings = useSettingStore.getState();
    const accountId = user?.user?.id ?? null;
    const eligible =
      db.isInitialized === true &&
      settings?.isAppLoading !== true &&
      user?.appLocked !== true &&
      user?.isLoggingOut !== true &&
      user?.accountSetupRequired !== true &&
      !!accountId;
    return { eligible, accountId };
  } catch {
    return { eligible: false, accountId: null };
  }
}

/** True only while the host is mounted (a host UUID exists). */
function isHostMounted(): boolean {
  return hostUUID.length > 0;
}

// ------------------------------------------------- device-local grants record

/**
 * Read the device-local grants record. It is a single encrypted `SettingItem`
 * row marked `localOnly: true`: excluded from Sync content and never carrying a
 * credential. It stores ids and booleans only.
 *
 * The codec itself lives in the pure `veyran-connect-grants` module, so the
 * headless Core persistence test parses a *real* reopened encrypted row through
 * this exact path.
 */
export function readLocalRecord(): ConnectLocalRecord | undefined {
  try {
    return readLocalRecordFrom(db.settings.collection);
  } catch {
    return undefined;
  }
}

/**
 * Persist the record durably. Returns `true` only after the encrypted row has
 * actually been written (the Core `upsert` is asynchronous): a rejected write is
 * caught, logged statically and reported as a failure, never as success. The
 * value is always the canonical JSON *string* (§ `veyran-connect-grants`).
 */
export async function writeLocalRecord(
  record: ConnectLocalRecord
): Promise<boolean> {
  try {
    const existing = db.settings.collection.get(LOCAL_RECORD_ID) as
      | { dateCreated?: number }
      | undefined;
    const item = buildLocalRecordItem(record, existing);
    if (!item) return false;
    await db.settings.collection.upsert(item as never);
    return true;
  } catch {
    logConnectFailure("VeyraNConnect.localRecord", "write failed");
    return false;
  }
}

/** Remove the record, awaiting the durable delete. */
export async function clearLocalRecord(): Promise<boolean> {
  try {
    await db.settings.collection.delete([LOCAL_RECORD_ID]);
    return true;
  } catch {
    logConnectFailure("VeyraNConnect.localRecord", "clear failed");
    return false;
  }
}

// -------------------------------------------------------------- host identity

export type HostIdentity = {
  hostUUID: string;
  epoch: number;
  generation: number;
};

/** A per-host-process id. It changes when the host is (re)mounted. */
let hostUUID = "";
/** Monotonic host epoch, bumped at every lifecycle seam. */
let hostEpoch = 0;
/** Increments whenever the adapter is (re)created. */
let adapterGeneration = 0;
/** The single Core adapter. */
let connectAdapter: ConnectAdapter | undefined;

export function currentHostIdentity(): HostIdentity {
  return { hostUUID, epoch: hostEpoch, generation: adapterGeneration };
}

export function isHostIdentityCurrent(captured: HostIdentity): boolean {
  return (
    captured.hostUUID === hostUUID &&
    captured.epoch === hostEpoch &&
    captured.generation === adapterGeneration &&
    connectAdapter != null &&
    !connectAdapter.closed
  );
}

/**
 * The single adapter for this process. Created lazily so importing this module
 * never touches the database before it exists.
 */
export function connectAdapterOnce(): ConnectAdapter {
  if (!connectAdapter || connectAdapter.closed) {
    connectAdapter = new ConnectAdapter(db, { maxJournalEntries: 1000 });
    adapterGeneration += 1;
  }
  return connectAdapter;
}

/** Mount the host for the running process. */
export function mountHost(): void {
  // A (re)mount owns a fresh pair flow: any pick that was pending under a
  // previous mount is stale and can never be adopted.
  fencePairFlow();
  hostUUID = `host-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  hostEpoch += 1;
  connectAdapterOnce();
}

/** Bump the epoch: everything captured before this call is now invalid. */
export function invalidateHost(): number {
  hostEpoch += 1;
  return hostEpoch;
}

// ---------------------------------------------------------------- grants flow

/** A rebuilt, immutable grants input for the current account. */
export function buildGrantsInput(
  accountId: string,
  capabilities: ConnectCapabilities
): ConnectGrantsInput {
  const defaultNotebookId = capabilities.defaultNotebookId;
  return {
    accountId,
    canRead: capabilities.canRead,
    canChange:
      capabilities.canChange &&
      (capabilities.notebookIds.length > 0 ||
        capabilities.noteIds.length > 0),
    canCreate: capabilities.canCreate && !!defaultNotebookId,
    canTask: capabilities.canTask && capabilities.listIds.length > 0,
    notebookIDs: [...capabilities.notebookIds],
    noteIDs: [...capabilities.noteIds],
    listIDs: [...capabilities.listIds]
  };
}

async function currentAccountId(): Promise<string | null> {
  const user = await db.user.getUser();
  return user?.id ?? null;
}

/**
 * Install fresh grants for the current account, but only when the account is
 * persisted and validated and only while the host epoch is unchanged across
 * every await. Returns the new Core grants generation, or `undefined` when
 * nothing was installed.
 */
export async function installGrants(
  accountId: string,
  capabilities: ConnectCapabilities
): Promise<number | undefined> {
  if (!accountId) return undefined;
  if (!isHostMounted()) return undefined;
  const eligibility = hostEligibility();
  if (!eligibility.eligible || eligibility.accountId !== accountId)
    return undefined;
  const adapter = connectAdapterOnce();
  const generation = adapter.generation;
  const captured = currentHostIdentity();
  const confirmed = await currentAccountId();
  if (!isHostIdentityCurrent(captured)) return undefined;
  if (!confirmed || confirmed !== accountId) return undefined;
  if (!hostEligibility().eligible) return undefined;
  try {
    const next = await adapter.setGrants(
      buildGrantsInput(accountId, capabilities)
    );
    // Revalidate *after* the write: an account switch/lock that landed while
    // the grants were being installed must not leave a live snapshot behind.
    const stillCurrent = isHostIdentityCurrent(captured);
    const stillAccount = stillCurrent ? await currentAccountId() : null;
    const stillEligible = stillCurrent ? hostEligibility() : undefined;
    if (
      !isHostIdentityCurrent(captured) ||
      !stillEligible?.eligible ||
      stillEligible.accountId !== accountId ||
      !stillAccount ||
      stillAccount !== accountId
    ) {
      adapter.clearGrants();
      clearCurrentCapabilities();
      return undefined;
    }
    if (next <= generation) return undefined;
    // A grant change invalidates any previously adopted native session: its
    // identity embeds the old grants generation, so a claim from that session
    // must no longer execute even before the explicit stop lands.
    if (activeNativeSession) {
      clearActiveNativeSession();
      sessionActive = false;
    }
    setCurrentCapabilities(capabilities);
    return next;
  } catch {
    logConnectFailure("VeyraNConnect.installGrants", "install failed");
    clearCurrentCapabilities();
    return undefined;
  }
}

/**
 * Reinstall the *persisted* grants if (and only if) they belong to the current,
 * still-valid account. Used on unlock so a fresh install only ever reappears
 * for the same actual Notes account.
 */
export async function reinstallPersistedGrantsIfSameAccount(): Promise<
  number | undefined
> {
  const record = readLocalRecord();
  if (!record) {
    clearCurrentCapabilities();
    return undefined;
  }
  const accountId = await currentAccountId();
  if (!accountId || accountId !== record.accountId) {
    connectAdapterOnce().clearGrants();
    clearCurrentCapabilities();
    return undefined;
  }
  return onHostAccountReady(accountId, record.capabilities);
}

// ------------------------------------------------------------ request handling

/**
 * Normalize an inbound request *before* it is executed.
 *
 * `create_note` with an omitted `notebookId` is bound to the chosen default
 * notebook only when that notebook is still a member of the immutable granted
 * set, so a stale default can never be injected and an unfiled note can never be
 * created through a capability that requires a default notebook. An explicitly
 * named notebook is left untouched and is authorized by Core against the grants.
 */
export function normalizeInboundRequest(
  request: ConnectRequest,
  capabilities: ConnectCapabilities
): ConnectRequest {
  if (request.operation !== "create_note") return request;
  if (request.notebookId) return request;
  const chosen = capabilities.defaultNotebookId;
  if (!chosen) return request;
  if (!capabilities.notebookIds.includes(chosen)) return request;
  return { ...request, notebookId: chosen };
}

export type ParsedClaim = {
  ticketId: string;
  request: unknown;
  /** The native session-engine lease generation the event belongs to. */
  generation: number;
  /** The canonical native session id the event belongs to. */
  sessionId: string;
};

/**
 * Parse a native `connectRequest` event.
 *
 * The event context is *mandatory*: both the native flow generation and the
 * canonical session id must be present and strictly shaped. A missing or
 * malformed context is rejected outright (`undefined`) instead of defaulting to
 * "current", so an old queued event can never be treated as a live one.
 */
export function parseClaimEvent(payload: unknown): ParsedClaim | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as {
    ticketId?: unknown;
    request?: unknown;
    generation?: unknown;
    sessionId?: unknown;
  };
  if (typeof record.ticketId !== "string") return undefined;
  if (!/^[0-9a-f]{32}$/.test(record.ticketId)) return undefined;
  if (!record.request || typeof record.request !== "object") return undefined;
  if (
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 0
  )
    return undefined;
  if (!isCanonicalNativeSessionId(record.sessionId)) return undefined;
  return {
    ticketId: record.ticketId,
    request: record.request,
    generation: record.generation,
    sessionId: record.sessionId
  };
}

type ExecuteOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: ReturnType<typeof errorEnvelope> };

export function invalidInputEnvelope(): {
  ok: false;
  error: ReturnType<typeof errorEnvelope>;
} {
  return { ok: false, error: errorEnvelope("INVALID_INPUT") };
}

/**
 * Execute one validated request against Core. Never throws: any failure becomes
 * a static, catalogued wire error. The host identity captured *before* the write
 * is rechecked before it *and* after it, so a lock/logout mid-write invalidates
 * both the reply and the surface refresh.
 */
export async function executeConnectRequest(
  raw: unknown,
  capabilities: ConnectCapabilities,
  captured?: HostIdentity,
  active?: ActiveNativeSession
): Promise<ExecuteOutcome> {
  // Fail closed on the authoritative lifecycle state *before* parsing or
  // executing anything, so a direct caller can never authorize against a
  // locked / loading / logging-out / setup-pending / account-less app.
  if (!hostEligibility().eligible) return invalidInputEnvelope();
  if (active && !isActiveNativeSession(active)) return invalidInputEnvelope();
  const parsed = requestWireSchema.safeParse(raw);
  if (!parsed.success) return invalidInputEnvelope();
  const adapter = connectAdapterOnce();
  const requestEpoch = captured ?? currentHostIdentity();
  // The captured identity must *already* be current when execution starts: a
  // caller that captured an old epoch (e.g. `invalidateHost()` landed between
  // the capture and this call) must not reach Core at all — zero writes, not a
  // write followed by a refused reply.
  if (!isHostIdentityCurrent(requestEpoch)) return invalidInputEnvelope();
  if (active && !isActiveNativeSession(active)) return invalidInputEnvelope();
  const operation = parsed.data.operation as ConnectOperation;
  const request = normalizeInboundRequest(parsed.data, capabilities);
  try {
    const result = await adapter.execute(request);
    // Recheck *before* any refresh or reply: the write may have happened, but a
    // lock/account switch that landed while it ran must fence everything else.
    if (!isHostIdentityCurrent(requestEpoch)) return invalidInputEnvelope();
    if (!hostEligibility().eligible) return invalidInputEnvelope();
    if (active && !isActiveNativeSession(active)) return invalidInputEnvelope();
    // Validate our own output against the correlated wire schema before it is
    // handed back, so a malformed result can never be relayed as success.
    const checked = wireResponseSchemaFor(operation).safeParse({
      ok: true,
      result
    });
    if (!checked.success) return invalidInputEnvelope();
    if (!checked.data.ok) {
      // The correlated union's failure member: relay its catalogued error
      // exactly, never inventing a success.
      return { ok: false, error: checked.data.error };
    }
    if (isWriteOperation(operation))
      await afterConfirmedWrite(requestEpoch, active);
    return { ok: true, result: checked.data.result };
  } catch (error) {
    if (isConnectError(error)) {
      return { ok: false, error: errorEnvelope(error.code) };
    }
    logConnectFailure("VeyraNConnect.execute", "execute failed");
    return { ok: false, error: errorEnvelope("INVALID_INPUT") };
  }
}

function isWriteOperation(operation: ConnectOperation): boolean {
  return (
    operation === "create_note" ||
    operation === "append_to_note" ||
    operation === "update_note" ||
    operation === "create_task" ||
    operation === "update_task" ||
    operation === "complete_task"
  );
}

/**
 * After a *confirmed* Core write: refresh the existing surfaces and reconcile
 * the existing Task notifications. A refresh failure is swallowed and logged
 * statically, so it can never turn a stored success into a failure/retry. It
 * never forces an editor reload over an unsaved draft and never emits
 * `syncCompleted`/`appRefreshRequested`.
 */
export async function afterConfirmedWrite(
  captured?: HostIdentity,
  active?: ActiveNativeSession
): Promise<void> {
  const epoch = captured ?? currentHostIdentity();
  // A refresh must never run for a session that is no longer the live one.
  if (active && !isActiveNativeSession(active)) return;
  if (!hostEligibility().eligible) return;
  try {
    Navigation.queueRoutesForUpdate();
    useRelationStore.getState().update();
    refreshAllStores();
    NotePreviewWidget.updateNotes();
  } catch {
    logConnectFailure("VeyraNConnect.refresh", "surface refresh failed");
  }
  if (!isHostIdentityCurrent(epoch)) return;
  if (active && !isActiveNativeSession(active)) return;
  try {
    await TaskNotifications.reconcile();
  } catch {
    logConnectFailure("VeyraNConnect.taskReconcile", "reconcile failed");
  }
}

// --------------------------------------------------------------- native session

let nativeSubscription: { remove(): void } | undefined;
/**
 * The JS-side snapshot of the grants currently installed in Core. It is a deep
 * copy and is cleared *synchronously* at every seam, so a stale default can
 * never be used to normalize a request.
 */
let currentCapabilities: ConnectCapabilities = emptyCapabilities();
let sessionActive = false;

export function setCurrentCapabilities(
  capabilities: ConnectCapabilities
): ConnectCapabilities {
  currentCapabilities = normalizeCapabilities(capabilities);
  // Return a fresh deep copy: the caller must never hold a mutable alias to the
  // trusted snapshot that Core is authorizing against.
  return normalizeCapabilities(currentCapabilities);
}

export function clearCurrentCapabilities(): void {
  currentCapabilities = emptyCapabilities();
}

export function getCurrentCapabilities(): ConnectCapabilities {
  return normalizeCapabilities(currentCapabilities);
}

export function isSessionActive(): boolean {
  return sessionActive;
}

// ------------------------------------------------------ active native session

/**
 * The immutable identity of the one native session this host has adopted.
 *
 * `nativeFlowGeneration` is the native session-engine *lease* generation — a
 * distinct counter from the Core grants generation (the two are never compared).
 * It is stamped onto every emitted event together with `nativeSessionId`; both
 * must match exactly, and the host epoch/mount must still be current, before a
 * request is executed or a reply is sent.
 */
export type ActiveNativeSession = {
  jsEpoch: number;
  hostUUID: string;
  accountId: string;
  coreGrantsGeneration: number;
  nativeFlowGeneration: number;
  nativeSessionId: string;
};

let activeNativeSession: ActiveNativeSession | undefined;

/** Synchronously drop the adopted native identity (never awaits). */
function clearActiveNativeSession(): void {
  activeNativeSession = undefined;
}

/**
 * True only while `active` is the current, live native session and the host
 * epoch/mount still match. Rechecked after every await so a Stop -> Start or
 * A -> B -> A cycle can never resurrect a stale event.
 */
export function isActiveNativeSession(active: ActiveNativeSession): boolean {
  return (
    sessionActive === true &&
    activeNativeSession === active &&
    hostUUID.length > 0 &&
    hostUUID === active.hostUUID &&
    hostEpoch === active.jsEpoch
  );
}

export function currentActiveNativeSession(): ActiveNativeSession | undefined {
  return activeNativeSession;
}

/** Fire-and-forget native stop; never awaited by a synchronous seam. */
function fenceNativeStop(): void {
  const native = nativeModule();
  if (!native) return;
  void native.stopSession().catch(() => {});
}

function handleNativeRequest(payload: unknown): void {
  // Require an adopted, live native session before any request may be authored.
  // An event that arrives with no session (or the wrong context) is discarded.
  if (!sessionActive || !activeNativeSession) return;
  const active = activeNativeSession;
  const parsed = parseClaimEvent(payload);
  if (!parsed) return;
  // Both mandatory context fields must match the adopted session exactly.
  if (
    parsed.generation !== active.nativeFlowGeneration ||
    parsed.sessionId !== active.nativeSessionId
  )
    return;
  const captured = currentHostIdentity();
  if (!isActiveNativeSession(active) || !isHostIdentityCurrent(captured)) return;
  const eligibility = hostEligibility();
  if (!eligibility.eligible || eligibility.accountId !== active.accountId)
    return;
  void respondToClaim(parsed, captured, active);
}

async function respondToClaim(
  claim: ParsedClaim,
  captured: HostIdentity,
  active: ActiveNativeSession
): Promise<void> {
  if (!isActiveNativeSession(active)) return;
  const capabilities = getCurrentCapabilities();
  const outcome = await executeConnectRequest(
    claim.request,
    capabilities,
    captured,
    active
  );
  // Recheck *after* every await: a lock/logout/account switch/repair/disconnect
  // that landed while the request executed must invalidate the reply.
  if (!isActiveNativeSession(active)) return;
  if (!isHostIdentityCurrent(captured)) return;
  const eligibility = hostEligibility();
  if (!eligibility.eligible || eligibility.accountId !== active.accountId)
    return;
  const native = nativeModule();
  if (!native) return;
  try {
    await native.reply(
      claim.ticketId,
      outcome,
      active.nativeFlowGeneration,
      active.nativeSessionId
    );
  } catch {
    logConnectFailure("VeyraNConnect.reply", "reply rejected");
  }
}

/**
 * Start the native session in two explicit phases:
 *
 *  1. `startSession` verifies the broker identity and establishes the session
 *     but does **not** poll, returning the exact session context (session id,
 *     Core grants generation and native lease generation);
 *  2. JS adopts that context immutably and calls `activateSession`, which the
 *     native side re-checks against the exact (flow, session) tuple before any
 *     poll begins.
 *
 * Because polling starts only after activation resolves, no event can be
 * emitted before JS owns the context — the previous "first legitimate claim"
 * gap is closed by construction, not by a racy flag.
 *
 * The account-bound persisted record is *mandatory*. Grants are only ever
 * installed from that record, so without one (or with one that belongs to a
 * different account) there is nothing to install: the call returns `false`
 * **before** any native credential read, session or network operation.
 */
export async function startSession(accountId: string): Promise<boolean> {
  const native = nativeModule();
  if (!native || !isConnectPlatformSupported()) return false;
  if (!accountId) return false;
  if (!isHostMounted()) return false;
  const startEligibility = hostEligibility();
  if (!startEligibility.eligible || startEligibility.accountId !== accountId)
    return false;
  const captured = currentHostIdentity();
  if (!isHostIdentityCurrent(captured)) return false;
  // An absent or foreign record is refused here, before `nativeStatus()` (which
  // reads the Keychain) and long before `native.startSession` (which opens the
  // TLS session). A session can never run without grants that were explicitly
  // chosen for this exact account.
  const record = readLocalRecord();
  if (!record || record.accountId !== accountId) return false;
  // Reinstall the persisted grants for THIS account *before* the broker session
  // opens: a grant set before pairing must not be lost on the first start.
  const installed = await onHostAccountReady(accountId, record.capabilities);
  if (!isHostIdentityCurrent(captured)) return false;
  // A matching record that cannot be applied (not paired, locked, account
  // changed, db not ready) must not open a native session and report success.
  if (installed === undefined) return false;
  const generation = connectAdapterOnce().generation;
  try {
    const started = await native.startSession(
      accountId,
      Number.isSafeInteger(generation) ? generation : 0,
      CONNECT_CLIENT_ID
    );
    // Fail closed on a stale epoch, a changed account or an ineligible app
    // *before* adopting the returned session.
    if (!isHostIdentityCurrent(captured)) {
      void native.stopSession().catch(() => {});
      return false;
    }
    const postEligibility = hostEligibility();
    if (
      !postEligibility.eligible ||
      postEligibility.accountId !== accountId ||
      !started ||
      typeof started !== "object" ||
      !isCanonicalNativeSessionId(started.sessionId) ||
      typeof started.nativeLeaseGeneration !== "number" ||
      !Number.isSafeInteger(started.nativeLeaseGeneration) ||
      started.nativeLeaseGeneration < 0
    ) {
      clearCurrentCapabilities();
      clearActiveNativeSession();
      await native.stopSession().catch(() => {});
      return false;
    }
    const adopted: ActiveNativeSession = {
      jsEpoch: captured.epoch,
      hostUUID: captured.hostUUID,
      accountId,
      coreGrantsGeneration:
        typeof started.grantsGeneration === "number" &&
        Number.isSafeInteger(started.grantsGeneration)
          ? started.grantsGeneration
          : 0,
      nativeFlowGeneration: started.nativeLeaseGeneration,
      nativeSessionId: started.sessionId
    };
    // Adopt before activating: no event can arrive until activation resolves,
    // and any event that does arrive is fenced against this exact context.
    activeNativeSession = adopted;
    sessionActive = true;
    if (!isActiveNativeSession(adopted)) {
      clearActiveNativeSession();
      sessionActive = false;
      return false;
    }
    try {
      await native.activateSession(
        adopted.nativeFlowGeneration,
        adopted.nativeSessionId
      );
    } catch {
      // Activation failed: revoke the adopted context entirely, no success.
      if (activeNativeSession === adopted) {
        clearActiveNativeSession();
        sessionActive = false;
        clearCurrentCapabilities();
      }
      await native.stopSession().catch(() => {});
      return false;
    }
    if (!isActiveNativeSession(adopted) || !isHostIdentityCurrent(captured)) {
      if (activeNativeSession === adopted) {
        clearActiveNativeSession();
        sessionActive = false;
        clearCurrentCapabilities();
      }
      await native.stopSession().catch(() => {});
      return false;
    }
    DatabaseLogger.info("VeyraNConnect session started");
    return true;
  } catch {
    logConnectFailure("VeyraNConnect.startSession", "start failed");
    clearActiveNativeSession();
    sessionActive = false;
    clearCurrentCapabilities();
    return false;
  }
}

// --------------------------------------------------------------- pair-flow fence

/**
 * The single pair-flow counter.
 *
 * Every pairing pick owns exactly one flow. A lock, disconnect, unmount,
 * account switch or a *concurrent* pick bumps it, so a picker completion that
 * belongs to an earlier flow is stale: it is never adopted, never reported as
 * paired, and never written to the encrypted grants record. The native side
 * performs the matching generation check on its pending picker *before* the
 * atomic Keychain store, so a stale completion cannot even replace the stored
 * credential.
 */
let pairFlowGeneration = 0;

function fencePairFlow(): void {
  pairFlowGeneration += 1;
}

/**
 * Stop the native poll loop and invalidate the session. The epoch, the adapter,
 * the capability snapshot, the adopted native identity *and any pending pairing
 * pick* are fenced *synchronously* before the native stop is awaited, so a
 * queued event from the previous session can never run.
 */
export async function stopSession(): Promise<void> {
  fencePairFlow();
  sessionActive = false;
  clearActiveNativeSession();
  clearCurrentCapabilities();
  invalidateHost();
  connectAdapter?.lock();
  const native = nativeModule();
  if (!native) return;
  try {
    await native.stopSession();
  } catch {
    logConnectFailure("VeyraNConnect.stopSession", "stop failed");
  }
}

/**
 * Pair from the native file picker. Returns a redacted status.
 *
 * The live JS session is fenced **synchronously, before the picker opens**: the
 * adopted native identity and capability snapshot are dropped, the host epoch is
 * bumped, the adapter is locked and the native poll loop is stopped — so a claim
 * queued under the previous session can never execute while (and after) a file
 * is being imported. The exact mounted account/host epoch/pair flow is captured
 * and re-checked after the await; a result that belongs to an invalidated flow
 * is never adopted and never reported as a new pairing (`stale: true`).
 */
export async function pickPairingFile(): Promise<{
  paired: boolean;
  brokerId?: string;
  port?: number;
  cancelled?: boolean;
  stale?: boolean;
  supported?: boolean;
}> {
  const native = nativeModule();
  if (!native || !isConnectPlatformSupported()) return { paired: false };
  // No host, no import: the native credential store is only ever reachable from
  // a mounted host whose lifecycle seams can fence it. Refusing here (before the
  // picker opens) keeps "not paired" a truthful answer.
  if (!isHostMounted()) return { paired: false };

  // 1. Fence *synchronously*, before the picker can suspend the app.
  fencePairFlow();
  sessionActive = false;
  clearActiveNativeSession();
  clearCurrentCapabilities();
  invalidateHost();
  connectAdapter?.lock();
  fenceNativeStop();

  // 2. Claim the flow this pick owns and capture the exact mounted context that
  //    must still hold when the picker resolves.
  const flow = pairFlowGeneration;
  const captured = currentHostIdentity();
  const capturedEligibility = hostEligibility();

  // The document picker makes the key window inactive. That is not an auth
  // lock: scope the existing "action in progress" flag around the picker and
  // restore whatever value it had, so background-lock never fires from a pick.
  const previous =
    useSettingStore.getState().appDidEnterBackgroundForAction;
  useSettingStore.getState().setAppDidEnterBackgroundForAction(true);
  try {
    const result = await native.pickPairingFile();
    // Re-check everything after the await: a lock / disconnect / unmount /
    // account switch / concurrent pick that landed while the picker was open
    // owns the state now, so this completion is stale.
    const now = currentHostIdentity();
    const nowEligibility = hostEligibility();
    const stale =
      flow !== pairFlowGeneration ||
      !isHostMounted() ||
      now.hostUUID !== captured.hostUUID ||
      now.epoch !== captured.epoch ||
      nowEligibility.accountId !== capturedEligibility.accountId ||
      nowEligibility.eligible !== capturedEligibility.eligible;
    if (stale || result?.stale === true) {
      // Fence, never adopt: report no new pairing and never a success.
      return { paired: false, cancelled: true, stale: true };
    }
    // A start that raced the import must not survive it: the session it adopted
    // belongs to the *pre-import* pairing (the native store, when it landed,
    // already replaced and invalidated that engine), so any adopted identity is
    // revoked here and the native poll loop is stopped — no claim can be
    // answered under a session the import just replaced.
    if (sessionActive || activeNativeSession) await stopSession();
    return {
      paired: result?.paired === true,
      brokerId: result?.brokerId,
      port: result?.port,
      cancelled: result?.cancelled,
      supported: result?.supported
    };
  } finally {
    useSettingStore
      .getState()
      .setAppDidEnterBackgroundForAction(previous);
  }
}

export async function nativeStatus(): Promise<ConnectNativeStatus> {
  const native = nativeModule();
  if (!native || !isConnectPlatformSupported())
    return { paired: false, sessionActive: false, supported: false };
  try {
    return await native.getStatus();
  } catch {
    return { paired: false, sessionActive: false };
  }
}

/**
 * Forget the paired broker (deletes only this module's Keychain record).
 *
 * The durable, encrypted local grants record is cleared *first* and awaited.
 * When that clear fails the teardown is still fenced, but the call reports
 * `false` (a truthful, fail-closed result) instead of claiming success over a
 * record that may still exist.
 */
export async function disconnect(): Promise<boolean> {
  await stopSession();
  connectAdapterOnce().clearGrants();
  invalidateHost();
  clearCurrentCapabilities();
  const cleared = await clearLocalRecord();
  if (!isConnectPlatformSupported()) return cleared;
  const native = nativeModule();
  if (!native) return cleared;
  try {
    await native.disconnect();
    return cleared;
  } catch {
    logConnectFailure("VeyraNConnect.disconnect", "disconnect failed");
    return false;
  }
}

// ---------------------------------------------------------------- lifecycle

/**
 * Fence the mounted host: drop the native identity + capability snapshot, bump
 * the epoch, lock the adapter and stop the native poll loop. Never touches the
 * database or Keychain, so it is always safe to run.
 */
function unmountHost(): void {
  fencePairFlow();
  sessionActive = false;
  clearActiveNativeSession();
  clearCurrentCapabilities();
  invalidateHost();
  connectAdapter?.lock();
  hostUUID = "";
  fenceNativeStop();
}

/**
 * Install the native event listener. Called from the mounted app hook (never
 * headless): the Connect host does not auto-start. The returned cleanup fences
 * the host, the adapter and the native poll loop, not just the JS listener.
 *
 * Off Mac Catalyst there is no listener to own: nothing is mounted and the
 * returned cleanup is a no-op, so no host identity (and no database access) is
 * ever created on an unsupported platform.
 */
export function startConnectHost(): () => void {
  if (!isConnectPlatformSupported()) return () => {};
  const native = nativeModule();
  if (!native) return () => {};
  mountHost();
  let subscription = nativeSubscription;
  if (!subscription) {
    const emitter = new NativeEventEmitter(native as never);
    subscription = emitter.addListener("connectRequest", handleNativeRequest);
    nativeSubscription = subscription;
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (nativeSubscription === subscription) {
      subscription?.remove();
      nativeSubscription = undefined;
    }
    unmountHost();
  };
}

/** Lock: refuse new work and invalidate in-flight requests (synchronously). */
export function onHostLock(): void {
  fencePairFlow();
  connectAdapter?.clearGrants();
  connectAdapter?.lock();
  invalidateHost();
  sessionActive = false;
  clearActiveNativeSession();
  clearCurrentCapabilities();
  fenceNativeStop();
}

/**
 * The first-line seam for logout / session-expired / migration-start: close or
 * fence the adapter *before* any `await` in the caller so no in-flight Connect
 * request can execute against a session that is being torn down.
 */
export function onHostTearDown(): void {
  fencePairFlow();
  connectAdapter?.close();
  invalidateHost();
  sessionActive = false;
  clearActiveNativeSession();
  clearCurrentCapabilities();
  fenceNativeStop();
}

export function onHostAccountChanging(): void {
  fencePairFlow();
  connectAdapter?.clearGrants();
  connectAdapter?.lock();
  invalidateHost();
  sessionActive = false;
  clearActiveNativeSession();
  clearCurrentCapabilities();
  fenceNativeStop();
}

export function onHostMigrationStarted(): void {
  fencePairFlow();
  connectAdapter?.clearGrants();
  connectAdapter?.lock();
  invalidateHost();
  sessionActive = false;
  clearActiveNativeSession();
  clearCurrentCapabilities();
  fenceNativeStop();
}

/**
 * Called once the persisted account and bootstrap are valid *and* a broker is
 * paired. Never installs grants before login or before pairing, and re-checks
 * the *authoritative* mounted/account/epoch/locked/hydrating state on both
 * sides of every await so a lock or logout that races the native status read can
 * never resurrect a grant.
 */
export async function onHostAccountReady(
  accountId: string,
  capabilities: ConnectCapabilities
): Promise<number | undefined> {
  if (!accountId) return undefined;
  if (!isHostMounted()) return undefined;
  const before = hostEligibility();
  if (!before.eligible || before.accountId !== accountId) return undefined;
  const captured = currentHostIdentity();
  const status = await nativeStatus();
  if (!isHostIdentityCurrent(captured)) return undefined;
  const afterStatus = hostEligibility();
  if (!afterStatus.eligible || afterStatus.accountId !== accountId)
    return undefined;
  if (!status.paired) return undefined;
  const confirmed = await currentAccountId();
  if (!isHostIdentityCurrent(captured)) return undefined;
  if (!confirmed || confirmed !== accountId) return undefined;
  // The lock/logout that matters most is the one that landed while the reads
  // above were in flight; deny *before* the unconditional unlock.
  const beforeUnlock = hostEligibility();
  if (!beforeUnlock.eligible || beforeUnlock.accountId !== accountId)
    return undefined;
  const adapter = connectAdapterOnce();
  if (adapter.closed) return undefined;
  adapter.unlock();
  if (!isHostIdentityCurrent(captured)) {
    adapter.lock();
    return undefined;
  }
  if (!capabilitiesAreInstalled(accountId)) {
    adapter.lock();
    return undefined;
  }
  return installGrants(accountId, capabilities);
}

/** True only while the host is still mounted and eligible for `accountId`. */
function capabilitiesAreInstalled(accountId: string): boolean {
  const eligibility = hostEligibility();
  return eligibility.eligible && eligibility.accountId === accountId;
}

export function hostAdapter(): ConnectAdapter | undefined {
  return connectAdapter;
}

// A narrow, testable surface. Everything else stays module-private.
export const VeyraNConnect = {
  isConnectPlatformSupported,
  normalizeCapabilities,
  buildGrantsInput,
  normalizeInboundRequest,
  parseClaimEvent,
  executeConnectRequest,
  invalidInputEnvelope,
  readLocalRecord,
  serializeLocalRecord,
  buildLocalRecordItem,
  readLocalRecordFrom,
  writeLocalRecord,
  clearLocalRecord,
  currentHostIdentity,
  isHostIdentityCurrent,
  connectAdapterOnce,
  mountHost,
  invalidateHost,
  installGrants,
  reinstallPersistedGrantsIfSameAccount,
  setCurrentCapabilities,
  clearCurrentCapabilities,
  getCurrentCapabilities,
  isSessionActive,
  isCanonicalNativeSessionId,
  hostEligibility,
  isActiveNativeSession,
  currentActiveNativeSession,
  startSession,
  stopSession,
  pickPairingFile,
  nativeStatus,
  disconnect,
  startConnectHost,
  onHostLock,
  onHostTearDown,
  onHostAccountChanging,
  onHostMigrationStarted,
  onHostAccountReady,
  afterConfirmedWrite,
  hostAdapter,
  EMPTY_CAPABILITIES,
  CONNECT_CLIENT_ID,
  ConnectError,
  errorEnvelope,
  MAX_SAFE_INTEGER
};

export default VeyraNConnect;
