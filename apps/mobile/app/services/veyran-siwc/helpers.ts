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
 * Pure, dependency-free helpers for the VeyraN SIWC provider. No React Native,
 * no database, no network: everything here is deterministic and directly
 * unit-testable, and the RN-facing `index.ts` calls exactly these functions.
 */

import {
  CONNECTED_ACCOUNT_LABEL,
  MANAGE_USAGE_URL,
  REQUIRED_DIRECT_SCOPES,
  type SIWCBeginAuthError,
  type SIWCErrorNotice,
  type SIWCFunctionDefinition,
  type SIWCModelsErrorCode,
  type SIWCStatus,
  type SIWCStreamEmission
} from "./types";

const STATUSES: readonly SIWCStatus[] = [
  "signedout",
  "authenticating",
  "missingpermission",
  "ready",
  "refreshing",
  "limited",
  "failed",
  "canceled"
];

/** A bounded, canonical namespace name; never taken from user input. */
export const SIWC_NAMESPACE = "veyran";

const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** True only when every required direct scope is present. */
export function hasDirectScopes(scopes: readonly string[]): boolean {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  return REQUIRED_DIRECT_SCOPES.every((scope) => scopes.includes(scope));
}

export function isSIWCStatus(value: unknown): value is SIWCStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/** A static, bounded error notice for a native/provider error code. */
export function errorNotice(code: unknown): SIWCErrorNotice {
  switch (code) {
    case "subscription_sharing_user_not_eligible":
      return {
        code: "subscription_sharing_user_not_eligible",
        message:
          "Dieses Konto ist für die direkte ChatGPT-Nutzung nicht berechtigt.",
        // Never loop OAuth for this; a fresh sign-in will not change it.
        retryable: false
      };
    case "usage_limit_exceeded":
    case "subscription_sharing_usage_limit_exceeded":
      return {
        code: "usage_limit_exceeded",
        message: "Nutzungslimit erreicht. Kein geschätzter Reset bekannt.",
        link: MANAGE_USAGE_URL,
        // Never retried implicitly: a usage limit is not a transient fault.
        retryable: false
      };
    case "usage_unavailable":
    case "subscription_sharing_usage_unavailable":
      return {
        code: "usage_unavailable",
        message:
          "Die ChatGPT-Nutzung ist vorübergehend nicht verfügbar. Anmeldedaten bleiben erhalten.",
        retryable: true
      };
    case "invalid_user":
    case "subscription_sharing_invalid_user":
      return {
        code: "invalid_user",
        message: "Die Anmeldung ist nicht mehr gültig. Erneut anmelden.",
        retryable: false
      };
    case "MISSING_PLAN_SCOPE":
      return {
        code: "MISSING_PLAN_SCOPE",
        message:
          "Die direkte ChatGPT-Nutzung ist für dieses Konto nicht freigegeben.",
        retryable: false
      };
    // --- bounded native catalog/stream codes (a real diagnostic, never raw) --
    // Every one of these is a fixed native `VeyraNSIWCError.code` that a model
    // metadata read can actually surface. They are preserved distinctly (instead
    // of collapsing to a generic failure) so the user sees the real, actionable
    // cause — while the message stays a static allowlisted string and the raw
    // native payload is discarded.
    case "model_unavailable":
      return {
        code: "model_unavailable",
        message:
          "Dieses Modell ist nicht verfügbar. Lade die Modelle neu und wähle " +
          "ein anderes.",
        retryable: true
      };
    case "token_invalid":
      return {
        code: "token_invalid",
        message:
          "Die ChatGPT-Anmeldung ist abgelaufen oder ungültig. Bitte erneut " +
          "anmelden.",
        retryable: false
      };
    case "identity_mismatch":
      return {
        code: "identity_mismatch",
        message:
          "Das angemeldete ChatGPT-Konto passt nicht zum gespeicherten Konto. " +
          "Bitte erneut anmelden.",
        retryable: false
      };
    case "stream_invalid":
      return {
        code: "stream_invalid",
        message:
          "Die Antwort des Modells war ungültig und wurde verworfen. Bitte " +
          "erneut versuchen.",
        retryable: true
      };
    // --- bounded native start failures (never a raw exception/token/URL) ----
    case "not_signed_in":
      return {
        code: "not_signed_in",
        message:
          "Die ChatGPT-Anmeldung ist nicht vorhanden oder abgelaufen. Bitte " +
          "erneut anmelden.",
        retryable: true
      };
    case "keychain_failure":
      return {
        code: "keychain_failure",
        message:
          "Die gespeicherten Anmeldedaten konnten nicht gelesen werden. Es " +
          "wurde nichts gelöscht; bitte erneut versuchen.",
        retryable: true
      };
    case "transport_unavailable":
      return {
        code: "transport_unavailable",
        message:
          "Die Anmeldung ist derzeit nicht erreichbar. Anmeldedaten bleiben " +
          "erhalten.",
        retryable: true
      };
    case "auth_canceled":
    case "canceled":
      return {
        code: "canceled",
        message: "Die Anmeldung wurde abgebrochen.",
        retryable: true
      };
    case "host_blocked":
      return {
        code: "host_blocked",
        message:
          "Die Anmeldung ist in diesem Zustand nicht möglich (gesperrt, " +
          "abgemeldet oder Konto-Setup offen).",
        retryable: true
      };
    case "unsupported":
      return {
        code: "unsupported",
        message: "Die ChatGPT-Anmeldung ist auf diesem Gerät nicht verfügbar.",
        retryable: false
      };
    case "account_changed":
      return {
        code: "account_changed",
        message:
          "Das Konto hat sich während der Anmeldung geändert. Bitte erneut " +
          "versuchen.",
        retryable: true
      };
    case "start_failed":
      return {
        code: "start_failed",
        message:
          "Die ChatGPT-Anmeldung konnte nicht gestartet werden. " +
          "Anmeldedaten bleiben erhalten.",
        retryable: true
      };
    case "callback_invalid":
      return {
        code: "callback_invalid",
        message: "Die Anmeldung konnte wegen einer ungültigen lokalen Konfiguration nicht gestartet werden.",
        retryable: false
      };
    case "flow_expired":
      return {
        code: "flow_expired",
        message: "Der Anmeldeversuch ist abgelaufen. Bitte starte die Anmeldung erneut.",
        retryable: true
      };
    default:
      return {
        code: "unknown",
        message: "Die Anfrage konnte nicht abgeschlossen werden.",
        retryable: true
      };
  }
}

/**
 * Map one caught native `beginAuth` rejection to a bounded, static code. Only
 * the exact whitelisted native codes are ever echoed; everything else — a raw
 * provider body, a token, a URL, a non-object rejection — collapses to
 * `start_failed`. The result is safe to log and to surface.
 *
 * `not_signed_in` is deliberately distinct: the native lifecycle returns it
 * *only* when there is no verified own registration at all (an unreadable
 * record fails as `keychain_failure` instead — see `VeyraNSIWCLifecycle
 * .authMode`), so it is the one code that may justify a first-registration
 * fallback.
 */
export function beginAuthErrorCode(error: unknown): SIWCBeginAuthError {
  let raw: unknown;
  try {
    raw = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  } catch {
    return "start_failed";
  }
  switch (raw) {
    case "not_signed_in":
      return "not_signed_in";
    case "keychain_failure":
      return "keychain_failure";
    case "transport_unavailable":
      return "transport_unavailable";
    case "account_changed":
      return "account_changed";
    case "auth_canceled":
    case "canceled":
      return "canceled";
    case "host_blocked":
      return "host_blocked";
    case "start_failed":
      return "start_failed";
    case "flow_expired":
      return "flow_expired";
    case "unsupported":
      return "unsupported";
    case "callback_invalid":
      return "callback_invalid";
    default:
      return "start_failed";
  }
}

/**
 * The bounded, static catalog failure used when a caught native rejection does
 * not match the allowlist (or is not an object at all). It never echoes the raw
 * value, so an unknown native code, a provider body, a token or a URL can never
 * reach the UI or the log.
 */
export const MODEL_CATALOG_UNAVAILABLE_NOTICE: SIWCErrorNotice = {
  code: "catalog_unavailable",
  message:
    "Der Modell-Katalog konnte nicht geladen werden. Anmeldedaten bleiben " +
    "erhalten; bitte erneut versuchen.",
  retryable: true
};

/**
 * Map one caught native catalog rejection to a bounded, static code.
 *
 * Only the exact allowlisted native `VeyraNSIWCError.code` values are echoed;
 * every other value — a raw provider body, a token, an unknown/future code or a
 * non-object rejection — collapses to `catalog_unavailable`. The result is safe
 * to log and to surface verbatim.
 */
export function modelsErrorCode(error: unknown): SIWCModelsErrorCode {
  let raw: unknown;
  try {
    raw =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
  } catch {
    return "catalog_unavailable";
  }
  switch (raw) {
    case "unsupported":
      return "unsupported";
    case "host_blocked":
      return "host_blocked";
    case "not_signed_in":
      return "not_signed_in";
    case "keychain_failure":
      return "keychain_failure";
    case "transport_unavailable":
      return "transport_unavailable";
    case "account_changed":
      return "account_changed";
    case "auth_canceled":
    case "canceled":
      return "canceled";
    case "usage_limit_exceeded":
    case "subscription_sharing_usage_limit_exceeded":
      return "usage_limit_exceeded";
    case "usage_unavailable":
    case "subscription_sharing_usage_unavailable":
      return "usage_unavailable";
    case "invalid_user":
    case "subscription_sharing_invalid_user":
      return "invalid_user";
    case "subscription_sharing_user_not_eligible":
      return "subscription_sharing_user_not_eligible";
    case "MISSING_PLAN_SCOPE":
      return "MISSING_PLAN_SCOPE";
    // A metadata read can legitimately surface these four native codes; keeping
    // them distinct preserves the real diagnostic instead of flattening it into
    // the generic `catalog_unavailable`.
    case "model_unavailable":
      return "model_unavailable";
    case "token_invalid":
      return "token_invalid";
    case "identity_mismatch":
      return "identity_mismatch";
    case "stream_invalid":
      return "stream_invalid";
    default:
      return "catalog_unavailable";
  }
}

/**
 * The bounded, static, allowlisted notice for one catalog failure. It reuses the
 * shared [`errorNotice`] copy for the allowlisted catalog codes and the fixed
 * `catalog_unavailable` notice otherwise — never a raw exception or native
 * payload.
 */
export function modelsErrorNotice(error: unknown): SIWCErrorNotice {
  const code = modelsErrorCode(error);
  if (code === "catalog_unavailable") return MODEL_CATALOG_UNAVAILABLE_NOTICE;
  if (code === "model_unavailable") return {
    code,
    message: "Der Modell-Katalog konnte nicht verarbeitet werden. Bitte lade die Modelle erneut.",
    retryable: true
  };
  if (code === "stream_invalid") return {
    code,
    message: "OpenAI hat keine gültige Antwort auf die Modellabfrage geliefert.",
    retryable: true
  };
  if (code === "transport_unavailable") return {
    code,
    message: "Der Modell-Katalog ist derzeit nicht erreichbar. Deine Anmeldung bleibt erhalten.",
    retryable: true
  };
  return errorNotice(code);
}

/**
 * The factual route label for a status. `missingpermission` exposes the
 * explicit, human-initiated recovery action; ordinary states never force
 * consent.
 */
export function statusLabel(status: SIWCStatus): string {
  switch (status) {
    case "ready":
      return CONNECTED_ACCOUNT_LABEL;
    case "missingpermission":
      return "ChatGPT-Nutzung freigeben";
    case "refreshing":
      return "Anmeldung wird erneuert";
    case "limited":
      return "Nutzung eingeschränkt";
    case "failed":
      return "Fehlgeschlagen";
    case "canceled":
      return "Abgebrochen";
    case "authenticating":
      return "Anmeldung läuft";
    default:
      return "Nicht angemeldet";
  }
}

/**
 * Build the strict function namespace from validated definitions. Every
 * deviation (an invalid name, a non-strict schema, more than 32 functions)
 * returns `undefined` so nothing invalid ever reaches the wire.
 */
export function buildFunctionTools(
  functions: readonly SIWCFunctionDefinition[]
): Record<string, unknown> | undefined {
  if (!Array.isArray(functions) || functions.length === 0) return undefined;
  if (functions.length > 32) return undefined;
  const names = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  for (const fn of functions) {
    if (!fn || typeof fn.name !== "string" || !FUNCTION_NAME.test(fn.name)) {
      return undefined;
    }
    if (names.has(fn.name)) return undefined;
    names.add(fn.name);
    if (typeof fn.description !== "string" || fn.description.length === 0) {
      return undefined;
    }
    if (!isStrictSchema(fn.parameters)) return undefined;
    entries.push({
      type: "function",
      name: fn.name,
      description: fn.description,
      strict: true,
      parameters: fn.parameters
    });
  }
  return { type: "namespace", name: SIWC_NAMESPACE, tools: entries };
}

/** A strict JSON-schema object: type:object, all properties required, no extras. */
export function isStrictSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const object = schema as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.join(",") !== "additionalProperties,properties,required,type") {
    return false;
  }
  if (object.type !== "object") return false;
  if (object.additionalProperties !== false) return false;
  const properties = object.properties;
  const required = object.required;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return false;
  }
  if (!Array.isArray(required)) return false;
  const propNames = Object.keys(properties as Record<string, unknown>).sort();
  const requiredNames = [...required].map(String).sort();
  if (propNames.length !== requiredNames.length) return false;
  return propNames.every((name, index) => name === requiredNames[index]);
}

/**
 * Adopt a streaming emission only when it belongs to the exact request id and
 * the exact provider generation the JS side captured before the stream started.
 * A stale A -> B -> A result is therefore never adopted.
 */
export function isAdoptableEmission(
  emission: SIWCStreamEmission,
  expected: { requestId: string; providerGeneration: number }
): boolean {
  if (!emission || typeof emission !== "object") return false;
  if (emission.requestId !== expected.requestId) return false;
  if (emission.providerGeneration !== expected.providerGeneration) return false;
  if (emission.type === "delta") {
    return typeof emission.text === "string" && emission.text.length > 0;
  }
  if (emission.type === "functionCall") {
    return (
      typeof emission.callId === "string" &&
      emission.callId.length > 0 &&
      typeof emission.name === "string" &&
      emission.name.length > 0 &&
      typeof emission.arguments === "string"
    );
  }
  return false;
}

/**
 * Normalize a raw native stream event. Returns `undefined` for anything that is
 * not a bounded, well-typed emission, so JS never adopts an unbounded payload.
 */
export function parseNativeStreamEvent(
  payload: unknown
): SIWCStreamEmission | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    return undefined;
  }
  if (typeof value.providerGeneration !== "number") return undefined;
  if (value.type === "start") {
    return {
      type: "start",
      requestId: value.requestId,
      providerGeneration: value.providerGeneration
    };
  }
  if (value.type === "delta") {
    if (typeof value.text !== "string" || value.text.length === 0) {
      return undefined;
    }
    return {
      type: "delta",
      requestId: value.requestId,
      providerGeneration: value.providerGeneration,
      text: value.text
    };
  }
  if (value.type === "functionCall") {
    if (
      typeof value.callId !== "string" ||
      typeof value.name !== "string" ||
      typeof value.arguments !== "string"
    ) {
      return undefined;
    }
    return {
      type: "functionCall",
      requestId: value.requestId,
      providerGeneration: value.providerGeneration,
      callId: value.callId,
      name: value.name,
      arguments: value.arguments
    };
  }
  return undefined;
}

/**
 * Reject a `system` role and any non-object input item before the request is
 * sent. This mirrors the native builder; the model is a separate, catalogued
 * value and is never carried in the input.
 */
export function validateInputItems(input: unknown): boolean {
  if (!Array.isArray(input) || input.length === 0 || input.length > 256) {
    return false;
  }
  return input.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const role = (item as Record<string, unknown>).role;
    return role !== "system";
  });
}
