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

import constants, { getPersistedHostOverrides } from "../utils/constants.js";
import { logger } from "../logger.js";
import Database from "./index.js";

/**
 * Which backend a profile's local data belongs to.
 *
 * Both the sync host and the identity host are recorded. The identity host is
 * the trust boundary for the session: a token minted by one identity server is
 * meaningless to another, and presenting it can trigger a destructive logout.
 * Recording only the sync host would let an API/auth pair be recombined without
 * detection.
 */
export type BackendIdentity = {
  /** Normalized API_HOST, including scheme and any base path. */
  api: string;
  /** Normalized AUTH_HOST, including scheme and any base path. */
  auth: string;
};

export type StoredAffinity = BackendIdentity & {
  /** Record format version, so a future change can migrate rather than guess. */
  v: 1;
  recordedAt: number;
};

export type BackendAffinityStatus =
  /** No account on this profile. Nothing server-derived to protect. */
  | "no-user"
  /** Recorded identity matches the configured one. Safe to proceed. */
  | "match"
  /** Recorded identity differs. Must not sync, must not be logged out. */
  | "mismatch"
  /**
   * An account exists but we cannot establish which backend its data came
   * from, and there is no reliable persisted endpoint configuration to settle
   * it. Treated exactly as conservatively as a mismatch: local data stays
   * readable, but nothing may leave this device and nothing may be destroyed.
   */
  | "unknown";

export type BackendAffinityResult = {
  status: BackendAffinityStatus;
  /** Recorded (or evidence-derived) identity, when one could be established. */
  stored?: BackendIdentity;
  /** Identity implied by the current host configuration. */
  configured: BackendIdentity;
  /** Which field(s) disagree, for diagnostics and for UI messaging. */
  mismatched?: ("api" | "auth")[];
  /**
   * How `stored` was established. "record" is a first-class recorded value;
   * "persisted-config" is derived from the user's own saved server URLs;
   * "none" means it could not be established at all.
   */
  evidence: "record" | "persisted-config" | "none";
};

/** A configuration problem that makes the host set untrustworthy. */
export type EndpointValidationError = {
  host: string;
  value: string;
  reason: string;
};

function isLoopbackOrPrivate(hostname: string) {
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  )
    return true;
  // IPv4 loopback and RFC1918 ranges, used by the existing LAN dev overrides.
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
  return false;
}

/**
 * Reduce an endpoint URL to a stable identity.
 *
 * Scheme is significant: `http://host` and `https://host` are different trust
 * levels, and treating them as one identity would let a downgrade pass as a
 * match. A base path is significant too, because a deployment may be mounted
 * under a prefix. A trailing slash, letter case, and an explicit default port
 * are not significant.
 *
 * Returns an empty string for input that is not a usable absolute URL, which
 * callers must treat as unusable rather than as a wildcard match.
 */
export function normalizeEndpoint(url: string): string {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (!parsed.hostname) return "";

  const isDefaultPort =
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80");
  const port = parsed.port && !isDefaultPort ? `:${parsed.port}` : "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}`;
}

/**
 * Validate a single endpoint. Plaintext HTTP is rejected except on loopback or
 * private addresses, which is what the existing local and LAN development
 * overrides use.
 */
export function validateEndpoint(
  host: string,
  value: string
): EndpointValidationError | undefined {
  if (!value || !value.trim())
    return { host, value, reason: "must not be empty" };

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { host, value, reason: "is not an absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return {
      host,
      value,
      reason: `uses unsupported scheme ${parsed.protocol}`
    };
  if (!parsed.hostname) return { host, value, reason: "has no hostname" };
  if (parsed.username || parsed.password)
    return { host, value, reason: "must not embed credentials" };
  if (parsed.search || parsed.hash)
    return { host, value, reason: "must not include a query or fragment" };
  if (parsed.protocol === "http:" && !isLoopbackOrPrivate(parsed.hostname))
    return {
      host,
      value,
      reason: "must use https outside loopback and private addresses"
    };
  return undefined;
}

/**
 * Validate the endpoints that carry account data and session credentials. Only
 * these three are checked: the remaining hosts are ancillary (billing, issue
 * reporting, marketing) and are not part of the data trust boundary.
 */
export function validateBackendConfiguration(hosts: {
  API_HOST: string;
  AUTH_HOST: string;
  SSE_HOST: string;
}): EndpointValidationError[] {
  return (["API_HOST", "AUTH_HOST", "SSE_HOST"] as const)
    .map((key) => validateEndpoint(key, hosts[key]))
    .filter((e): e is EndpointValidationError => !!e);
}

export function currentBackendIdentity(): BackendIdentity {
  return {
    api: normalizeEndpoint(constants.API_HOST),
    auth: normalizeEndpoint(constants.AUTH_HOST)
  };
}

function identityIsUsable(identity: BackendIdentity) {
  return !!identity.api && !!identity.auth;
}

function diff(a: BackendIdentity, b: BackendIdentity): ("api" | "auth")[] {
  const fields: ("api" | "auth")[] = [];
  if (a.api !== b.api) fields.push("api");
  if (a.auth !== b.auth) fields.push("auth");
  return fields;
}

/**
 * Raised when an operation would cross a backend boundary. Callers must treat
 * this as "stop": never as a reason to reset, log out, or clear local data.
 */
export class BackendMismatchError extends Error {
  readonly result: BackendAffinityResult;
  constructor(result: BackendAffinityResult, operation: string) {
    super(
      result.status === "unknown"
        ? `${operation} is blocked because this profile's data cannot be attributed to a backend. Log in again to confirm which server this account belongs to. Local notes remain available.`
        : `${operation} is blocked because this profile's data belongs to a different server (api ${result.stored?.api}, auth ${result.stored?.auth}) than the one configured (api ${result.configured.api}, auth ${result.configured.auth}). Local notes remain available.`
    );
    this.name = "BackendMismatchError";
    this.result = result;
  }
}

export class BackendAffinity {
  private logger = logger.scope("BackendAffinity");
  private quarantined = false;

  constructor(private readonly db: Database) {}

  current() {
    return currentBackendIdentity();
  }

  /** A failed local rollback must stop all account traffic in this process. */
  quarantine() {
    this.quarantined = true;
  }

  /**
   * Read the stored record. A value written by an earlier build of this branch
   * was a bare hostname string with no scheme and no identity host; it carries
   * too little information to authorise anything, so it is reported as absent
   * rather than upgraded by guesswork.
   */
  async get(): Promise<StoredAffinity | undefined> {
    const raw = await this.db.kv().read("backendAffinity");
    if (!raw) return undefined;
    if (typeof raw === "string") {
      this.logger.warn(
        "Discarding pre-release affinity record: too little information to trust.",
        { raw }
      );
      return undefined;
    }
    if (typeof raw !== "object" || (raw as StoredAffinity).v !== 1)
      return undefined;
    const record = raw as StoredAffinity;
    if (!record.api || !record.auth) return undefined;
    return record;
  }

  /**
   * Bind this profile to the configured backend.
   *
   * Refuses to overwrite a record that names a different backend: relabelling
   * existing data is what would let it be uploaded somewhere it does not
   * belong. Changing backends is a migration, not a side effect of logging in,
   * so it must go through `adoptCurrentBackend`.
   */
  async record(): Promise<
    | { ok: true; identity: BackendIdentity; changed: boolean }
    | { ok: false; conflict: BackendAffinityResult }
  > {
    const configured = this.current();
    if (!identityIsUsable(configured))
      throw new Error(
        "Cannot record backend affinity: the configured hosts are not valid absolute URLs."
      );

    // Consult the full evidence chain, not just the stored record. A profile
    // that predates affinity tracking has no record, but may still have
    // explicitly saved server URLs naming a different backend; writing over
    // that would rebind existing data on the strength of a fresh login.
    const result = await this.check();

    switch (result.status) {
      case "no-user":
        // Nothing server-derived exists yet, so there is nothing to endanger.
        await this.write(configured);
        return { ok: true, identity: configured, changed: true };

      case "match":
        // Agreement. Persist it if it was only implied by configuration, so the
        // attribution survives a later change to those settings.
        if (result.evidence !== "record") {
          await this.write(configured);
          return { ok: true, identity: configured, changed: true };
        }
        return { ok: true, identity: configured, changed: false };

      case "mismatch":
        return { ok: false, conflict: result };

      case "unknown":
        // An account exists but cannot be attributed. Adopting it here would be
        // exactly the silent rebinding this guard exists to prevent; it must go
        // through `adoptCurrentBackend` with explicit user intent.
        return { ok: false, conflict: result };
    }
  }

  private async write(identity: BackendIdentity) {
    this.logger.info("Recording backend affinity", identity);
    await this.db.kv().write("backendAffinity", {
      v: 1,
      api: identity.api,
      auth: identity.auth,
      recordedAt: Date.now()
    });
  }

  async clear() {
    await this.db.kv().delete("backendAffinity");
  }

  /**
   * Derive an identity from the user's own persisted server configuration.
   *
   * A profile that predates affinity tracking has no record, but if the user
   * had explicitly saved server URLs then that saved configuration is reliable
   * evidence of which backend the data came from. Absent that, we do not guess:
   * an unrecorded profile could have synced against either the shipped default
   * of whatever build it ran, or a custom one, and assuming either direction
   * risks moving data across a boundary.
   */
  private persistedIdentity(): BackendIdentity | undefined {
    const overrides = getPersistedHostOverrides();
    if (!overrides) return undefined;
    const api = normalizeEndpoint(overrides.API_HOST || "");
    const auth = normalizeEndpoint(overrides.AUTH_HOST || "");
    // Both must be explicitly configured for this to settle the question. A
    // half-configured override leaves the other half at a default we cannot
    // reconstruct after the fact.
    if (!api || !auth) return undefined;
    return { api, auth };
  }

  /** A saved explicit endpoint is authoritative even if only one was saved. */
  private persistedConflict(configured: BackendIdentity) {
    const overrides = getPersistedHostOverrides();
    if (!overrides) return undefined;
    const fields: ("api" | "auth")[] = [];
    const api = overrides.API_HOST && normalizeEndpoint(overrides.API_HOST);
    const auth = overrides.AUTH_HOST && normalizeEndpoint(overrides.AUTH_HOST);
    if (overrides.API_HOST && api !== configured.api) fields.push("api");
    if (overrides.AUTH_HOST && auth !== configured.auth) fields.push("auth");
    if (!fields.length) return undefined;
    return {
      status: "mismatch" as const,
      stored: { api: api || "", auth: auth || "" },
      configured,
      mismatched: fields,
      evidence: "persisted-config" as const
    };
  }

  async check(): Promise<BackendAffinityResult> {
    const configured = this.current();
    if (this.quarantined)
      return { status: "unknown", configured, evidence: "none" };
    // A previous local rollback may have failed while SQLite or the key store
    // was unavailable. Keep the network blocked after restart as well.
    try {
      if (await this.db.storage().read<boolean>("backendRecoveryRequired"))
        return { status: "unknown", configured, evidence: "none" };
    } catch {
      return { status: "unknown", configured, evidence: "none" };
    }

    // A recorded affinity is never permission to silently ignore a user's
    // explicitly saved server selection. Require the configuration to agree.
    const savedConflict = this.persistedConflict(configured);
    if (savedConflict) return savedConflict;

    const user = await this.db.user.getUser();
    if (!user) return { status: "no-user", configured, evidence: "none" };

    const stored = await this.get();
    if (stored) {
      const identity = { api: stored.api, auth: stored.auth };
      const fields = diff(identity, configured);
      return {
        status: fields.length === 0 ? "match" : "mismatch",
        stored: identity,
        configured,
        mismatched: fields.length ? fields : undefined,
        evidence: "record"
      };
    }

    const persisted = this.persistedIdentity();
    if (persisted) {
      const fields = diff(persisted, configured);
      return {
        status: fields.length === 0 ? "match" : "mismatch",
        stored: persisted,
        configured,
        mismatched: fields.length ? fields : undefined,
        evidence: "persisted-config"
      };
    }

    // An account with no record and no persisted configuration. Fail safe.
    return { status: "unknown", configured, evidence: "none" };
  }

  /** True when an operation must not be allowed to reach the network. */
  async isBlocked() {
    const { status } = await this.check();
    return status === "mismatch" || status === "unknown";
  }

  /**
   * Throw unless the configured backend is the one this profile's data belongs
   * to. Used as a preflight by every account-scoped network call, so a request
   * cannot reach a foreign backend before the boundary is noticed.
   */
  async assertAllowed(operation: string) {
    const result = await this.check();
    if (result.status === "mismatch" || result.status === "unknown") {
      this.logger.error(
        new BackendMismatchError(result, operation),
        `${operation} blocked by backend affinity`,
        { ...result, stored: result.stored, configured: result.configured }
      );
      throw new BackendMismatchError(result, operation);
    }
    return result;
  }

  /**
   * Explicitly adopt the configured backend for a profile whose data could not
   * be attributed (`unknown`).
   *
   * Deliberately narrow. It refuses when a record already names a different
   * backend, because that is a data migration and cannot be settled by a
   * checkbox. It also cannot prove that the local data is *rightfully* this
   * account's data on this server; no such proof is available to the client.
   * What it does require is that the caller pass explicit user confirmation and
   * that the configured backend has just authenticated this account.
   */
  async adoptCurrentBackend(options: {
    confirmedByUser: boolean;
    verifiedAgainstBackend: boolean;
  }) {
    if (!options.confirmedByUser)
      throw new Error(
        "Adopting a backend requires explicit user confirmation."
      );
    if (!options.verifiedAgainstBackend)
      throw new Error(
        "Adopting a backend requires a verified response from the configured backend."
      );

    const result = await this.check();
    if (result.status === "match") return result;
    if (result.status === "mismatch")
      throw new Error(
        "This profile is already bound or explicitly configured for a different backend. Migrating its data between backends is not supported here."
      );

    await this.write(this.current());
    this.logger.info("Backend adopted after explicit user confirmation", {
      previous: result.stored,
      adopted: this.current()
    });
    return await this.check();
  }
}
