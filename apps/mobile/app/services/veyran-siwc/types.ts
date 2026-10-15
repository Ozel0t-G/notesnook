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
 * Pure types and fixed constants for the VeyraN SIWC provider.
 *
 * This module imports nothing from React Native, so it is safe to import from a
 * headless test. Every value here is a *fixed* contract; none of it is derived
 * from a model string, a token or a URL authority.
 */

/** The exact scope set that authorizes direct inference. */
export const REQUIRED_DIRECT_SCOPES: readonly string[] = [
  "resource.invoke",
  "chatgpt.tokens.use.direct"
];

/** The official, fixed usage-management link. */
export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

/**
 * A factual, neutral connected-account label shown near the model selector.
 *
 * It states only that a ChatGPT account is connected. It deliberately makes no
 * claim about *how* usage is billed or that a plan alone is used — the credits
 * notice below is the truthful cost statement.
 */
export const CONNECTED_ACCOUNT_LABEL = "Verbundenes ChatGPT-Konto";

/**
 * The visible, informative credits notice. It is *not* a confirmation gate and
 * makes no guarantee about plan-only usage.
 */
export const CREDITS_NOTICE =
  "Nutzung kann ChatGPT-Kontingent oder vorhandene Credits verbrauchen. " +
  "Reine Abo-Nutzung ist nicht garantiert.";

/** The explicit, human-initiated recovery action label. */
export const CONSENT_RECOVERY_LABEL = "ChatGPT-Nutzung freigeben";

/**
 * The truthful mobile-unavailable copy. It does not claim that OpenAI
 * universally forbids mobile SIWC.
 */
export const MOBILE_UNAVAILABLE_COPY =
  "In dieser VeyraN-Version nicht verfügbar; kein bestätigter mobiler " +
  "SIWC-Callbackweg.";

/** The bounded provider status surface (mirrors the native statuses). */
export type SIWCStatus =
  | "signedout"
  | "authenticating"
  | "missingpermission"
  | "ready"
  | "refreshing"
  | "limited"
  | "failed"
  | "canceled";

/** The auth modes the native side accepts. */
export type SIWCAuthMode = "fresh" | "returning" | "consent";

export type SIWCModel = { slug: string; displayName: string };

/**
 * The bounded, static failure category of one catalog read. It mirrors the
 * native `VeyraNSIWCError.code` allowlist that is relevant to a catalog read
 * and adds the JS-side outcomes. A raw native exception (which may carry a
 * provider body, a token or a URL) is never surfaced: only one of these fixed
 * tokens reaches the controller/UI/log.
 */
export type SIWCModelsErrorCode =
  | "unsupported"
  | "host_blocked"
  | "not_signed_in"
  | "keychain_failure"
  | "transport_unavailable"
  | "account_changed"
  | "canceled"
  | "usage_limit_exceeded"
  | "usage_unavailable"
  | "invalid_user"
  | "subscription_sharing_user_not_eligible"
  | "MISSING_PLAN_SCOPE"
  | "model_unavailable"
  | "token_invalid"
  | "identity_mismatch"
  | "stream_invalid"
  | "catalog_unavailable";

/**
 * The typed, bounded outcome of one catalog read.
 *
 * `ok: true` always carries the *actual* server catalog — including a
 * legitimately **empty** list (an authenticated account for which the provider
 * exposes no `visibility:list` rows). An empty catalog is therefore never
 * conflated with a failure, and a failure is never flattened into an empty
 * catalog: the exact bounded {@link SIWCErrorNotice} is preserved so the UI can
 * show a truthful error and offer an explicit retry.
 */
export type SIWCModelCatalog =
  | { ok: true; models: SIWCModel[] }
  | { ok: false; error: SIWCErrorNotice };

export type SIWCFunctionDefinition = {
  name: string;
  description: string;
  /** A strict JSON-schema object (type:object, all-required, no extra props). */
  parameters: Record<string, unknown>;
};

export type SIWCInputItem = Record<string, unknown>;

export type SIWCStatusSummary = {
  signedIn: boolean;
  status: SIWCStatus;
  subject?: string;
  clientId?: string;
  hasDirectScopes?: boolean;
  supported?: boolean;
  /**
   * The bounded, static error code behind `status: "failed"` — e.g.
   * `keychain_failure` when the stored record exists but cannot be read. An
   * unreadable store is therefore never reported as a plain "signed out".
   */
  error?: string;
};

export type SIWCStreamEmission =
  | {
      /**
       * The native handshake that names the request id and the *native* provider
       * generation. It is consumed internally to arm the adoption fence and is
       * never forwarded to a stream handler.
       */
      type: "start";
      requestId: string;
      providerGeneration: number;
    }
  | {
      type: "delta";
      requestId: string;
      providerGeneration: number;
      text: string;
    }
  | {
      type: "functionCall";
      requestId: string;
      providerGeneration: number;
      callId: string;
      name: string;
      arguments: string;
    };

export type SIWCErrorNotice = {
  code: string;
  message: string;
  /** An optional official link the UI may surface verbatim. */
  link?: string;
  /** True when the user can retry later without any guessed reset time. */
  retryable: boolean;
};

/**
 * The bounded, deterministic reason a host is *not* eligible. It is computed
 * from the same authoritative stores the fail-closed eligibility proof reads
 * (database readiness, app loading, app lock, logout, incomplete account setup
 * and a missing persisted account) and carries no account id, e-mail or any
 * other PII — only a fixed static token. `unknown` is reserved for a thrown
 * getter, i.e. an eligibility proof that could not be computed at all.
 */
export type SIWCHostBlockReason =
  | "db_uninitialized"
  | "app_loading"
  | "app_locked"
  | "logging_out"
  | "setup_required"
  | "no_account"
  | "unknown";

/**
 * The bounded, static failure code of one `beginAuth` attempt. A raw native
 * exception (which may carry a provider body, a token or a URL) is never
 * surfaced: only one of these fixed tokens reaches the controller/UI. They
 * mirror the native `VeyraNSIWCError.code` values (`VeyraNSIWCTypes.swift`) and
 * add the JS-side outcomes.
 */
export type SIWCBeginAuthError =
  | "unsupported"
  | "host_blocked"
  | "not_signed_in"
  | "keychain_failure"
  | "transport_unavailable"
  | "account_changed"
  | "canceled"
  | "flow_expired"
  | "callback_invalid"
  | "start_failed";
