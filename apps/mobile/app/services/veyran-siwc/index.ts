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
 * VeyraN SIWC provider host (JavaScript side).
 *
 * The native `VeyraNSIWCModule` owns the credential (never exposed to JS), the
 * loopback callback listener, the system-browser hand-off and the dedicated SSE
 * Responses stream. This module is the lifecycle half: it reads the
 * *authoritative* eligibility stores, opens and fences the host at every
 * account seam (synchronously, before any await) and integrates the bounded
 * native status/stream events.
 *
 * Safety shape:
 *  - every credential/network method is gated on the real lifecycle stores and a
 *    persisted account (`hostEligibility`);
 *  - a monotonic host epoch is bumped synchronously at every seam and stamped
 *    onto every stream/auth adoption, so an A -> B -> A result can never be
 *    adopted;
 *  - the native `fence()` is invoked as the *first* line of every lock / logout
 *    / account-change / migration path, before any await;
 *  - each stream invocation owns a JS-generated request id and an owner token.
 *    Nothing is emitted until the native `start` handshake echoes *that exact*
 *    request id (carrying the native provider generation), and only the exact
 *    owner may clear or complete an invocation — a canceled or superseded
 *    invocation always reports `canceled`, never a late success;
 *  - each auth event must match the exact authorized flow (native generation +
 *    owner account + unchanged host identity and eligibility) before it can be
 *    surfaced;
 *  - no token, model or URL authority is ever supplied to the native side: only
 *    a bounded function-name/description/schema set and content items.
 */

import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import { DatabaseLogger, db } from "../../common/database";
import { useSettingStore } from "../../stores/use-setting-store";
import { useUserStore } from "../../stores/use-user-store";
import {
  MODEL_CATALOG_UNAVAILABLE_NOTICE,
  beginAuthErrorCode,
  buildFunctionTools,
  errorNotice,
  hasDirectScopes,
  isAdoptableEmission,
  isSIWCStatus,
  modelsErrorNotice,
  parseNativeStreamEvent,
  statusLabel,
  validateInputItems
} from "./helpers";
import {
  CONNECTED_ACCOUNT_LABEL,
  CREDITS_NOTICE,
  MANAGE_USAGE_URL,
  MOBILE_UNAVAILABLE_COPY,
  REQUIRED_DIRECT_SCOPES,
  type SIWCAuthMode,
  type SIWCBeginAuthError,
  type SIWCErrorNotice,
  type SIWCFunctionDefinition,
  type SIWCHostBlockReason,
  type SIWCInputItem,
  type SIWCModel,
  type SIWCModelCatalog,
  type SIWCStatus,
  type SIWCStatusSummary,
  type SIWCStreamEmission
} from "./types";

export * from "./helpers";
export * from "./types";

// --------------------------------------------------------------- native bridge

/**
 * The exact, truthful outcome of one logout attempt, as both the native module
 * and this host report it. Every field is always present: `noActiveConnection`
 * distinguishes "there was no local credential to revoke at all" from an
 * attempted-but-unconfirmed revocation, so an absent record is never reported
 * as a confirmed revocation.
 */
export type SIWCLogoutOutcome = {
  cleared: boolean;
  revocationConfirmed: boolean;
  /** True when there was no local credential to revoke at all. */
  noActiveConnection: boolean;
};

type SIWCNativeModule = {
  getStatus(): Promise<{ supported?: boolean }>;
  statusForAccount(ownerAccountId: string): Promise<SIWCStatusSummary>;
  beginAuth(
    mode: string,
    ownerAccountId: string,
    loginHint?: string | null
  ): Promise<{
    started: boolean;
    port: number;
    redirectUri: string;
    /**
     * The exact native flow generation and owner of the listener this call
     * opened: every auth event is correlated against them before it is
     * surfaced, so a late event for a superseded flow is dropped.
     */
    generation?: number;
    ownerAccountId?: string;
    /** The exact native provider epoch the flow was opened under. */
    providerEpoch?: number;
  }>;
  cancelAuth(): Promise<void>;
  logout(ownerAccountId: string): Promise<SIWCLogoutOutcome>;
  clearCredential(): Promise<{ cleared: boolean }>;
  refresh(ownerAccountId: string): Promise<{ refreshed: boolean }>;
  getModels(ownerAccountId: string): Promise<{ models: SIWCModel[] }>;
  streamInvoke(
    ownerAccountId: string,
    model: string,
    input: unknown[],
    functions: unknown[],
    instructions: string | null,
    /**
     * The JS-owned request id. The native side echoes exactly this value in its
     * `start` handshake (with the native provider generation), so JS never has
     * to adopt an arbitrary first emission.
     */
    requestId: string
  ): Promise<{ completed: boolean; text: string }>;
  cancelStream(): Promise<void>;
  fence(): Promise<void>;
};

function nativeModule(): SIWCNativeModule | undefined {
  if (Platform.OS !== "ios") return undefined;
  const module = NativeModules.VeyraNSIWCModule as SIWCNativeModule | undefined;
  return module || undefined;
}

/** Mac Catalyst is the only platform where the SIWC provider is functional. */
export function isSIWCPlatformSupported(): boolean {
  return (
    Platform.OS === "ios" &&
    (Platform as { isMacCatalyst?: boolean }).isMacCatalyst === true
  );
}

/**
 * A static, bounded failure category. A raw caught error can carry a provider
 * body or a token and is never handed to the shared logger.
 */
function logSIWCFailure(category: string, fallback?: string): void {
  DatabaseLogger.error(undefined, fallback ? `${category}: ${fallback}` : category);
}

// ----------------------------------------------------- authoritative lifecycle

export type SIWCHostEligibility = {
  eligible: boolean;
  accountId: string | null;
  /**
   * The bounded, deterministic reason the host is ineligible. Absent exactly
   * when `eligible` is true. Never carries PII (no account id, no e-mail).
   */
  reason?: SIWCHostBlockReason;
};

/**
 * The single, fail-closed eligibility proof. It reads the authoritative stores
 * (`db.isInitialized`, `SettingStore.isAppLoading`, `UserStore.appLocked` /
 * `isLoggingOut` / `accountSetupRequired`) and a persisted account id. Any
 * thrown getter denies as `unknown`.
 *
 * The gates are evaluated in a fixed order so exactly one bounded reason is
 * reported; the boolean outcome is unchanged (still fail-closed).
 */
export function siwcHostEligibility(): SIWCHostEligibility {
  try {
    const user = useUserStore.getState();
    const settings = useSettingStore.getState();
    const accountId = user?.user?.id ?? null;
    let reason: SIWCHostBlockReason | undefined;
    if (db.isInitialized !== true) reason = "db_uninitialized";
    else if (settings?.isAppLoading === true) reason = "app_loading";
    else if (user?.appLocked === true) reason = "app_locked";
    else if (user?.isLoggingOut === true) reason = "logging_out";
    else if (user?.accountSetupRequired === true) reason = "setup_required";
    else if (!accountId) reason = "no_account";
    return { eligible: reason === undefined, accountId, reason };
  } catch {
    return { eligible: false, accountId: null, reason: "unknown" };
  }
}

// -------------------------------------------------------------- host identity

let hostUUID = "";
let hostEpoch = 0;
let siwcSubscription: { remove(): void } | undefined;

/** The one auth flow whose events may be surfaced right now. */
type SIWCAuthFlow = {
  /** The exact native flow generation returned by `beginAuth`. */
  generation: number;
  /** The exact native provider epoch the flow was opened under. */
  providerEpoch: number;
  /** The Notes account that opened the flow. */
  accountId: string;
  /** The host identity the flow was opened under (ABA-safe). */
  identity: SIWCHostIdentity;
};
let activeAuthFlow: SIWCAuthFlow | undefined;

/**
 * The monotonic ownership token of the newest `beginAuth` attempt.
 *
 * The native `cancelAuth` carries no request id and is process-global, so an
 * attempt that has already been superseded (a newer attempt, or an explicit
 * cancel) must never fire it — otherwise it would kill the newer listener. The
 * newest attempt is therefore the only one allowed to cancel, and an attempt
 * whose token is stale can never arm `activeAuthFlow`.
 */
let authAttemptToken = 0;
let authAttemptCanceled = false;

/**
 * The one stream invocation that owns the adoption fence right now.
 *
 * `token` is the per-invocation owner token: only the invocation that still
 * owns the active stream may clear it, and an invocation that lost its token
 * (cancel, fence, or a newer stream) is always reported as canceled — a late
 * `{completed:true}` can therefore never be adopted or auto-acted upon.
 */
type SIWCStreamInvocation = {
  token: number;
  identity: SIWCHostIdentity;
  ownerAccountId: string;
  /** The JS-owned request id handed to the native side. */
  requestId: string;
  /** The native provider generation, learned from the `start` handshake only. */
  providerGeneration?: number;
  canceled: boolean;
};
let activeStream: SIWCStreamInvocation | undefined;
let streamOwnerToken = 0;

/** A bounded, JS-owned request id (the native side validates it again). */
function makeRequestId(): string {
  return `siwc-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e9
  ).toString(36)}`;
}

export type SIWCHostIdentity = { hostUUID: string; epoch: number };

export function currentSIWCHostIdentity(): SIWCHostIdentity {
  return { hostUUID, epoch: hostEpoch };
}

export function isSIWCHostIdentityCurrent(captured: SIWCHostIdentity): boolean {
  return captured.hostUUID === hostUUID && captured.epoch === hostEpoch;
}

/** Mount the provider host for the running process. */
export function mountSIWC(): void {
  hostUUID = `siwc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  hostEpoch += 1;
}

/** Bump the epoch: everything captured before this call is invalid. */
export function invalidateSIWC(): number {
  hostEpoch += 1;
  return hostEpoch;
}

function isSIWCMounted(): boolean {
  return hostUUID.length > 0;
}

// ------------------------------------------------------------------- lifecycle

/**
 * The single synchronous lifecycle seam. It is the *first* line of every lock,
 * logout, account-change and migration path, before any await, so no in-flight
 * auth/refresh/stream can adopt a credential or emit a result afterwards.
 */
export function fenceSIWC(): void {
  invalidateSIWC();
  // The fenced invocation is marked canceled *before* it is dropped, so a late
  // completion can never be reported as a success (and can never clear a newer
  // invocation's stream).
  if (activeStream) activeStream.canceled = true;
  activeStream = undefined;
  activeAuthFlow = undefined;
  const native = nativeModule();
  if (native) {
    // Fire-and-forget: the native fence is synchronous, and the epoch bump
    // above already invalidates every JS-side capture.
    void native.fence().catch(() => {});
  }
}

export function onSIWCLock(): void {
  fenceSIWC();
}

export function onSIWCTearDown(): void {
  fenceSIWC();
}

export function onSIWCAccountChanging(): void {
  fenceSIWC();
}

export function onSIWCMigrationStarted(): void {
  fenceSIWC();
}

// --------------------------------------------------------------------- host

function emitToHandler(payload: unknown): void {
  const emission = parseNativeStreamEvent(payload);
  if (!emission) return;
  const stream = activeStream;
  if (!stream || stream.canceled) return;
  // The exact invocation *and* the exact host identity must still be current:
  // an A -> B -> A result can never be adopted.
  if (!isSIWCHostIdentityCurrent(stream.identity)) return;
  // Only the exact JS-owned request id is ever considered. A stale event can
  // never poison the fence by arriving first.
  if (emission.requestId !== stream.requestId) return;
  if (emission.type === "start") {
    // The native side is the authority for the *provider generation*, and only
    // the handshake may teach it to us — and only for the request id JS itself
    // generated. Nothing is emitted before this handshake.
    stream.providerGeneration = emission.providerGeneration;
    return;
  }
  if (stream.providerGeneration === undefined) return;
  if (
    !isAdoptableEmission(emission, {
      requestId: stream.requestId,
      providerGeneration: stream.providerGeneration
    })
  ) {
    return;
  }
  streamHandler?.(emission);
}

let streamHandler: ((emission: SIWCStreamEmission) => void) | undefined;
let authHandler:
  | ((event: { type: string; code?: string; subject?: string }) => void)
  | undefined;

/**
 * Surface one native auth event only when it belongs to the exact, still-current
 * authorized flow: the same native flow generation, the same owner account, an
 * unchanged host identity (so an A -> B -> A result can never be adopted) and an
 * unchanged host eligibility. A late or foreign event changes zero UI state and
 * performs zero credential work.
 */
function emitAuthToHandler(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const flow = activeAuthFlow;
  if (!flow) return;
  if (!isSIWCHostIdentityCurrent(flow.identity)) return;
  const value = payload as {
    type?: unknown;
    code?: unknown;
    subject?: unknown;
    generation?: unknown;
    ownerAccountId?: unknown;
    providerEpoch?: unknown;
  };
  if (
    typeof value.generation !== "number" ||
    value.generation !== flow.generation
  ) {
    return;
  }
  if (
    typeof value.providerEpoch !== "number" ||
    value.providerEpoch !== flow.providerEpoch
  ) {
    return;
  }
  if (
    typeof value.ownerAccountId !== "string" ||
    value.ownerAccountId !== flow.accountId
  ) {
    return;
  }
  const eligibility = siwcHostEligibility();
  if (!eligibility.eligible || eligibility.accountId !== flow.accountId) return;
  if (value.type === "authenticated") {
    authHandler?.({
      type: "authenticated",
      subject: typeof value.subject === "string" ? value.subject : undefined
    });
  } else if (value.type === "authError") {
    authHandler?.({
      type: "authError",
      code: typeof value.code === "string" ? value.code : "unknown"
    });
  }
}

/**
 * Start the provider host for this process. Off Mac Catalyst nothing is
 * mounted and the cleanup is a no-op, so no host identity and no database access
 * is ever created on an unsupported platform.
 */
export function startSIWCHost(): () => void {
  if (!isSIWCPlatformSupported()) return () => {};
  const native = nativeModule();
  if (!native) return () => {};
  mountSIWC();
  let subscription = siwcSubscription;
  if (!subscription) {
    const emitter = new NativeEventEmitter(native as never);
    const eventSubscription = emitter.addListener(
      "siwcEvent",
      (payload: unknown) => emitAuthToHandler(payload)
    );
    const streamSubscription = emitter.addListener("siwcStream", emitToHandler);
    subscription = {
      remove() {
        eventSubscription.remove();
        streamSubscription.remove();
      }
    };
    siwcSubscription = subscription;
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (siwcSubscription === subscription) {
      subscription?.remove();
      siwcSubscription = undefined;
    }
    fenceSIWC();
    hostUUID = "";
  };
}

export function setSIWCStreamHandler(
  handler: ((emission: SIWCStreamEmission) => void) | undefined
): void {
  streamHandler = handler;
}

export function setSIWCAuthHandler(
  handler:
    | ((event: { type: string; code?: string; subject?: string }) => void)
    | undefined
): void {
  authHandler = handler;
}

// --------------------------------------------------------------------- status

export async function siwcStatus(
  ownerAccountId: string
): Promise<SIWCStatusSummary> {
  const native = nativeModule();
  if (!native || !isSIWCPlatformSupported()) {
    return { signedIn: false, status: "signedout", supported: false };
  }
  const eligibility = siwcHostEligibility();
  if (!eligibility.eligible || eligibility.accountId !== ownerAccountId) {
    return { signedIn: false, status: "signedout" };
  }
  try {
    const summary = await native.statusForAccount(ownerAccountId);
    if (!isSIWCStatus(summary?.status)) {
      return { signedIn: false, status: "signedout" };
    }
    return summary;
  } catch {
    logSIWCFailure("VeyraNSIWC.status", "read failed");
    return { signedIn: false, status: "failed" };
  }
}

// ----------------------------------------------------------------- auth flow

export type SIWCBeginAuthResult = {
  started: boolean;
  port?: number;
  redirectUri?: string;
  supported?: boolean;
  /**
   * The bounded, static failure code when `started` is false. A raw native
   * exception (which may carry a token/provider body/URL) is never surfaced.
   */
  error?: SIWCBeginAuthError;
  /**
   * Set when an ordinary `returning` start was retried exactly once as a fresh
   * first registration because the native side confirmed no verified own
   * registration exists.
   */
  fallback?: "fresh_registration";
};

type SIWCBeginAuthAttempt =
  | { kind: "started"; result: SIWCBeginAuthResult }
  | { kind: "not_signed_in" }
  | { kind: "failed"; result: SIWCBeginAuthResult };

/**
 * Cancel the native listener opened by *this* attempt only. The native
 * `cancelAuth` is process-global (it carries no flow id), so an attempt that has
 * already been superseded by a newer one must never cancel it — that would tear
 * down the newer flow's listener.
 */
function cancelAuthAttempt(
  native: SIWCNativeModule,
  attemptToken: number
): void {
  if (attemptToken !== authAttemptToken || authAttemptCanceled) return;
  authAttemptCanceled = true;
  void native.cancelAuth().catch(() => {});
}

/**
 * One native start. After the only await it revalidates *both* the exact host
 * identity (ABA-safe) and the current account eligibility, and arms
 * `activeAuthFlow` only for a fully identified, still-current flow. Every stale
 * variant fails closed: it never reports `started` and never adopts a flow
 * (canceling the native listener only while this attempt still owns it).
 *
 * A rejection is classified into a bounded static code; a resolved
 * `{started:false}` is a bounded `start_failed`, and a `started:true` result
 * with a missing/mismatched generation, provider epoch or owner is a static
 * failure too — an unidentified flow is never surfaced as started.
 */
async function startSIWCAuthAttempt(
  native: SIWCNativeModule,
  mode: SIWCAuthMode,
  accountId: string,
  captured: SIWCHostIdentity,
  attemptToken: number,
  loginHint?: string
): Promise<SIWCBeginAuthAttempt> {
  try {
    const result = await native.beginAuth(mode, accountId, loginHint ?? null);
    // A superseded attempt (a newer start, or an explicit cancel) owns nothing:
    // it must not adopt a flow and must not fire the global native cancel.
    if (attemptToken !== authAttemptToken) {
      return { kind: "failed", result: { started: false, error: "canceled" } };
    }
    // Re-prove the exact host identity *and* the current account eligibility
    // after the await: a lock/logout/account/ABA change in between forbids
    // adoption, fail closed.
    if (!isSIWCHostIdentityCurrent(captured)) {
      cancelAuthAttempt(native, attemptToken);
      return {
        kind: "failed",
        result: { started: false, error: "account_changed" }
      };
    }
    const eligibility = siwcHostEligibility();
    if (!eligibility.eligible) {
      cancelAuthAttempt(native, attemptToken);
      return {
        kind: "failed",
        result: { started: false, error: "host_blocked" }
      };
    }
    if (eligibility.accountId !== accountId) {
      cancelAuthAttempt(native, attemptToken);
      return {
        kind: "failed",
        result: { started: false, error: "account_changed" }
      };
    }
    if (result?.started !== true) {
      return { kind: "failed", result: { started: false, error: "start_failed" } };
    }
    // Only a *fully identified* flow may receive auth events: without the exact
    // native generation, provider epoch and owner, nothing is adopted (fail
    // closed) and the flow is never reported as started.
    if (
      typeof result.generation === "number" &&
      Number.isSafeInteger(result.generation) &&
      result.generation > 0 &&
      typeof result.providerEpoch === "number" &&
      Number.isSafeInteger(result.providerEpoch) &&
      result.providerEpoch >= 0 &&
      typeof result.ownerAccountId === "string" &&
      result.ownerAccountId === accountId
    ) {
      activeAuthFlow = {
        generation: result.generation,
        providerEpoch: result.providerEpoch,
        accountId: result.ownerAccountId,
        identity: captured
      };
      return {
        kind: "started",
        result: {
          started: true,
          port: result.port,
          redirectUri: result.redirectUri
        }
      };
    }
    cancelAuthAttempt(native, attemptToken);
    return { kind: "failed", result: { started: false, error: "start_failed" } };
  } catch (error) {
    const code = beginAuthErrorCode(error);
    if (code === "not_signed_in") return { kind: "not_signed_in" };
    // Category-only: a raw caught error is never logged or surfaced.
    logSIWCFailure("VeyraNSIWC.beginAuth", code);
    return { kind: "failed", result: { started: false, error: code } };
  }
}

/**
 * Begin an authorization flow. `mode` selects fresh registration, returning
 * sign-in, or the explicit consent recovery. Never forces consent for an
 * ordinary/returning sign-in.
 *
 * First registration: an ordinary `returning` start rejects with the exact
 * native code `not_signed_in` only when the Keychain read succeeded and there is
 * no verified own registration at all (`VeyraNSIWCLifecycle.authMode`); an
 * unreadable record fails as `keychain_failure` instead. Only that exact code
 * (and only for `returning`) may retry once as `fresh`, and only after the host
 * identity and the account eligibility are re-proven. Every other
 * keychain/transport/unknown rejection is surfaced and performs zero fallback,
 * so a failed or unreadable verified registration is never treated as absence.
 */
export async function beginSIWCAuth(
  mode: SIWCAuthMode,
  loginHint?: string
): Promise<SIWCBeginAuthResult> {
  const native = nativeModule();
  if (!native || !isSIWCPlatformSupported()) {
    return { started: false, supported: false, error: "unsupported" };
  }
  const eligibility = siwcHostEligibility();
  if (!eligibility.eligible || !eligibility.accountId) {
    return { started: false, error: "host_blocked" };
  }
  const accountId = eligibility.accountId;
  const captured = currentSIWCHostIdentity();
  // A new attempt supersedes any previous authorized flow immediately, and
  // owns the (process-global) native cancel from here on.
  activeAuthFlow = undefined;
  const attemptToken = ++authAttemptToken;
  authAttemptCanceled = false;

  const first = await startSIWCAuthAttempt(
    native,
    mode,
    accountId,
    captured,
    attemptToken,
    loginHint
  );
  // The wrapper's await is another scheduling boundary. An earlier attempt
  // must never cancel or clear the flow belonging to a newer caller.
  if (attemptToken !== authAttemptToken) {
    return { started: false, error: "canceled" };
  }
  const afterFirst = siwcHostEligibility();
  if (
    !isSIWCHostIdentityCurrent(captured) ||
    !afterFirst.eligible ||
    afterFirst.accountId !== accountId
  ) {
    activeAuthFlow = undefined;
    cancelAuthAttempt(native, attemptToken);
    return {
      started: false,
      error: !isSIWCHostIdentityCurrent(captured) || afterFirst.accountId !== accountId
        ? "account_changed"
        : "host_blocked"
    };
  }
  if (first.kind === "started") return first.result;
  if (first.kind === "failed") return first.result;

  // `not_signed_in`: the native side confirmed no verified own registration.
  // Only an ordinary returning sign-in is retried, never an explicit fresh
  // request (which is already a registration) and never a consent flow.
  if (mode !== "returning") return { started: false, error: "not_signed_in" };

  // Re-prove the exact host identity *and* the current account eligibility
  // before the fallback: a lock/account/ABA change in between forbids it.
  if (attemptToken !== authAttemptToken) {
    return { started: false, error: "canceled" };
  }
  if (!isSIWCHostIdentityCurrent(captured)) {
    cancelAuthAttempt(native, attemptToken);
    return { started: false, error: "account_changed" };
  }
  const beforeFallback = siwcHostEligibility();
  if (!beforeFallback.eligible) {
    cancelAuthAttempt(native, attemptToken);
    return { started: false, error: "host_blocked" };
  }
  if (beforeFallback.accountId !== accountId) {
    cancelAuthAttempt(native, attemptToken);
    return { started: false, error: "account_changed" };
  }

  const fresh = await startSIWCAuthAttempt(
    native,
    "fresh",
    accountId,
    captured,
    attemptToken
  );
  if (fresh.kind === "failed") return fresh.result;
  if (fresh.kind === "not_signed_in") {
    // The fresh registration attempt also reported no verified registration:
    // a bounded, static outcome — never an implicit third attempt.
    return { started: false, error: "not_signed_in" };
  }

  // Re-prove again after the fallback await: a stale adoption is impossible.
  if (attemptToken !== authAttemptToken) {
    return { started: false, error: "canceled" };
  }
  if (!isSIWCHostIdentityCurrent(captured)) {
    activeAuthFlow = undefined;
    cancelAuthAttempt(native, attemptToken);
    return { started: false, error: "account_changed" };
  }
  const afterFallback = siwcHostEligibility();
  if (!afterFallback.eligible) {
    activeAuthFlow = undefined;
    cancelAuthAttempt(native, attemptToken);
    return { started: false, error: "host_blocked" };
  }
  if (afterFallback.accountId !== accountId) {
    activeAuthFlow = undefined;
    cancelAuthAttempt(native, attemptToken);
    return { started: false, error: "account_changed" };
  }
  return { ...fresh.result, fallback: "fresh_registration" };
}

export async function cancelSIWCAuth(): Promise<void> {
  const native = nativeModule();
  // Supersede every in-flight attempt: a start that resolves after this cancel
  // must not arm a flow (and must not re-fire the cancel we already issued).
  authAttemptToken += 1;
  activeAuthFlow = undefined;
  if (!native) return;
  try {
    await native.cancelAuth();
  } catch {
    logSIWCFailure("VeyraNSIWC.cancelAuth", "cancel failed");
  }
}

/** A truthful, always-available description of the mobile limitation. */
export function siwcMobileUnavailableCopy(): string {
  return MOBILE_UNAVAILABLE_COPY;
}

// ----------------------------------------------------------------- credential

/**
 * Log out: local clear is immediate and a single best-effort revocation is
 * attempted. The host and the registrations survive so a returning sign-in can
 * reuse the issued client id.
 */
export async function logoutSIWC(
  ownerAccountId: string
): Promise<SIWCLogoutOutcome> {
  const native = nativeModule();
  if (!native) {
    return { cleared: true, revocationConfirmed: false, noActiveConnection: true };
  }
  fenceSIWC();
  try {
    const outcome = await native.logout(ownerAccountId);
    return {
      cleared: outcome?.cleared === true,
      // Unknown is never reported as confirmed.
      revocationConfirmed: outcome?.revocationConfirmed === true,
      noActiveConnection: outcome?.noActiveConnection === true
    };
  } catch {
    logSIWCFailure("VeyraNSIWC.logout", "logout failed");
    return { cleared: false, revocationConfirmed: false, noActiveConnection: false };
  }
}

export async function refreshSIWC(ownerAccountId: string): Promise<boolean> {
  const native = nativeModule();
  if (!native) return false;
  const eligibility = siwcHostEligibility();
  if (!eligibility.eligible || eligibility.accountId !== ownerAccountId) {
    return false;
  }
  const captured = currentSIWCHostIdentity();
  try {
    const result = await native.refresh(ownerAccountId);
    if (!isSIWCHostIdentityCurrent(captured)) return false;
    return result?.refreshed === true;
  } catch {
    logSIWCFailure("VeyraNSIWC.refresh", "refresh failed");
    return false;
  }
}

// --------------------------------------------------------------------- models

/** A usable catalog row: a non-empty slug and a textual display name. */
function isSIWCModelRow(model: unknown): model is SIWCModel {
  if (!model || typeof model !== "object") return false;
  const { slug, displayName } = model as {
    slug?: unknown;
    displayName?: unknown;
  };
  return (
    typeof slug === "string" &&
    /^[A-Za-z0-9_./:-]{1,200}$/.test(slug) &&
    typeof displayName === "string" &&
    displayName.trim().length > 0 &&
    displayName.length <= 200
  );
}

/**
 * Read the live, provider-owned model catalog.
 *
 * The outcome is typed and bounded. A native rejection is *not* dropped: it is
 * mapped through a strict allowlist to a static {@link SIWCErrorNotice}, so the
 * caller can show a truthful, retryable error instead of silently rendering an
 * empty catalog. A legitimately empty server list is reported as
 * `{ ok: true, models: [] }` and is therefore never conflated with a failure.
 *
 * The server's `visibility:list` ordering is preserved verbatim (no sorting, no
 * hardcoded entries, no default model). Only the bounded static code ever
 * reaches the shared log.
 */
export async function fetchSIWCModels(
  ownerAccountId: string
): Promise<SIWCModelCatalog> {
  const native = nativeModule();
  if (!native) return { ok: false, error: errorNotice("unsupported") };
  const eligibility = siwcHostEligibility();
  if (!eligibility.eligible || eligibility.accountId !== ownerAccountId) {
    return { ok: false, error: errorNotice("host_blocked") };
  }
  const captured = currentSIWCHostIdentity();
  try {
    const result = await native.getModels(ownerAccountId);
    if (!isSIWCHostIdentityCurrent(captured)) {
      return { ok: false, error: errorNotice("account_changed") };
    }
    const current = siwcHostEligibility();
    if (!current.eligible || current.accountId !== ownerAccountId) {
      return { ok: false, error: errorNotice("host_blocked") };
    }
    if (!result || !Array.isArray(result.models) || result.models.length > 512 ||
      !result.models.every(isSIWCModelRow)) {
      return { ok: false, error: MODEL_CATALOG_UNAVAILABLE_NOTICE };
    }
    return { ok: true, models: result.models };
  } catch (error) {
    const notice = modelsErrorNotice(error);
    logSIWCFailure("VeyraNSIWC.models", notice.code);
    return { ok: false, error: notice };
  }
}

// ---------------------------------------------------------------- streaming

export type SIWCInvokeResult = {
  completed: boolean;
  text?: string;
  error?: SIWCErrorNotice;
};

/**
 * Start a streaming Responses invocation. Only the *content* and the bounded
 * function definitions cross the bridge; the model is validated natively
 * against the live catalog and no token is ever supplied from JS.
 */
export async function streamSIWC(
  ownerAccountId: string,
  model: string,
  input: SIWCInputItem[],
  functions: SIWCFunctionDefinition[],
  instructions?: string
): Promise<SIWCInvokeResult> {
  const native = nativeModule();
  if (!native) return { completed: false, error: errorNotice("unsupported") };
  const eligibility = siwcHostEligibility();
  if (!eligibility.eligible || eligibility.accountId !== ownerAccountId) {
    return { completed: false, error: errorNotice("account_changed") };
  }
  if (typeof model !== "string" || model.length === 0) {
    return { completed: false, error: errorNotice("model_unavailable") };
  }
  if (!validateInputItems(input)) {
    return { completed: false, error: errorNotice("invalid_input") };
  }
  // A tool-less text stream is allowed; a *non-empty* function list must build
  // into the strict `veyran` namespace or the request is refused.
  if (!Array.isArray(functions)) {
    return { completed: false, error: errorNotice("function_call_denied") };
  }
  if (functions.length > 0 && !buildFunctionTools(functions)) {
    return { completed: false, error: errorNotice("function_call_denied") };
  }
  // The JS host owns the request id: the native handshake must echo exactly this
  // value before any delta (or function call) is adopted.
  const requestId = makeRequestId();
  const token = ++streamOwnerToken;
  const identity = currentSIWCHostIdentity();
  activeStream = { token, identity, ownerAccountId, requestId, canceled: false };
  try {
    const result = await native.streamInvoke(
      ownerAccountId,
      model,
      input,
      functions as unknown[],
      instructions ?? null,
      requestId
    );
    const stream = activeStream;
    if (!stream || stream.token !== token || stream.canceled) {
      // This invocation no longer owns the stream: a late completion is always
      // reported as canceled, so zero automatic actions can run for it.
      return { completed: false, error: errorNotice("canceled") };
    }
    if (!isSIWCHostIdentityCurrent(identity)) {
      return { completed: false, error: errorNotice("account_changed") };
    }
    return { completed: result?.completed === true, text: result?.text };
  } catch (error) {
    const stream = activeStream;
    if (!stream || stream.token !== token || stream.canceled) {
      return { completed: false, error: errorNotice("canceled") };
    }
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    return { completed: false, error: errorNotice(code) };
  } finally {
    const stream = activeStream;
    // Only the exact owner may clear the fence: an old invocation's `finally`
    // can never clear a newer invocation's stream.
    if (stream && stream.token === token) activeStream = undefined;
  }
}

export async function cancelSIWCStream(): Promise<void> {
  const native = nativeModule();
  const stream = activeStream;
  // Only the *current* invocation is canceled and cleared; a newer stream
  // started afterwards is untouched.
  if (stream) stream.canceled = true;
  activeStream = undefined;
  if (!native) return;
  try {
    await native.cancelStream();
  } catch {
    logSIWCFailure("VeyraNSIWC.cancelStream", "cancel failed");
  }
}

/**
 * True only while a *confirmed* direct grant authorizes inference.
 *
 * The grant is deliberately fail-closed: a missing signal is **not** treated as
 * an allow. It requires an explicit `signedIn === true`, the exact `ready`
 * status and an explicit `hasDirectScopes === true`; a `missingpermission` (or
 * any non-ready) status, a missing grant field and any malformed value all
 * deny. The native scope gate itself is unchanged.
 */
export function siwcCanInvoke(summary: SIWCStatusSummary): boolean {
  if (!summary || summary.signedIn !== true) return false;
  if (summary.status !== "ready") return false;
  return summary.hasDirectScopes === true;
}

export { hasDirectScopes, statusLabel, beginAuthErrorCode };
export type {
  SIWCAuthMode,
  SIWCBeginAuthError,
  SIWCFunctionDefinition,
  SIWCHostBlockReason,
  SIWCInputItem,
  SIWCErrorNotice,
  SIWCModel,
  SIWCStatus,
  SIWCStatusSummary,
  SIWCStreamEmission
};

/** The visible, informative credits notice (not a confirmation gate). */
export const SIWC_CREDITS_NOTICE = CREDITS_NOTICE;
export const SIWC_MANAGE_USAGE_URL = MANAGE_USAGE_URL;
export const SIWC_CONNECTED_ACCOUNT_LABEL = CONNECTED_ACCOUNT_LABEL;
export const SIWC_REQUIRED_DIRECT_SCOPES = REQUIRED_DIRECT_SCOPES;

// A narrow, testable surface.
export const VeyraNSIWC = {
  isSIWCPlatformSupported,
  siwcHostEligibility,
  currentSIWCHostIdentity,
  isSIWCHostIdentityCurrent,
  mountSIWC,
  invalidateSIWC,
  fenceSIWC,
  startSIWCHost,
  setSIWCStreamHandler,
  setSIWCAuthHandler,
  siwcStatus,
  beginSIWCAuth,
  cancelSIWCAuth,
  logoutSIWC,
  refreshSIWC,
  fetchSIWCModels,
  streamSIWC,
  cancelSIWCStream,
  siwcCanInvoke,
  siwcMobileUnavailableCopy,
  hasDirectScopes,
  statusLabel,
  errorNotice,
  beginAuthErrorCode,
  buildFunctionTools,
  parseNativeStreamEvent,
  isAdoptableEmission,
  validateInputItems,
  SIWC_CREDITS_NOTICE,
  SIWC_MANAGE_USAGE_URL,
  SIWC_CONNECTED_ACCOUNT_LABEL,
  SIWC_REQUIRED_DIRECT_SCOPES
};

export default VeyraNSIWC;
