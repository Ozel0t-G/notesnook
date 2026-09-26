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

import constants from "../utils/constants.js";
import { logger } from "../logger.js";
import Database from "./index.js";

/**
 * The backend a profile's local data originated from, before this client could
 * be pointed at a self-hosted deployment. Any profile that has a user but no
 * recorded affinity predates affinity tracking, so it can only have come from
 * here.
 */
export const LEGACY_BACKEND_ID = "api.notesnook.com";

export type BackendAffinityStatus =
  /** No user is logged in, so there is nothing to protect. */
  | "no-user"
  /** Stored affinity matches the configured sync host. Safe to proceed. */
  | "match"
  /**
   * Stored (or inferred legacy) affinity does not match the configured sync
   * host. The session belongs to a different backend: sync must not run and
   * local data must not be destroyed.
   */
  | "mismatch";

export type BackendAffinityResult = {
  status: BackendAffinityStatus;
  /** Affinity recorded for this profile, or the inferred legacy value. */
  stored?: string;
  /** Affinity implied by the currently configured API_HOST. */
  configured: string;
  /** True when `stored` was inferred rather than read back from storage. */
  inferred: boolean;
};

/**
 * Reduce a host URL to a stable identity. Comparison must not be defeated by a
 * trailing slash, a case difference, or an explicit default port, otherwise a
 * cosmetic difference would read as a backend change and lock the user out of
 * their own data.
 */
export function normalizeBackendId(host: string): string {
  if (!host) return "";
  try {
    const url = new URL(host.includes("//") ? host : `https://${host}`);
    const isDefaultPort =
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80");
    return `${url.hostname}${
      url.port && !isDefaultPort ? `:${url.port}` : ""
    }`.toLowerCase();
  } catch {
    return host.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export class BackendAffinity {
  private logger = logger.scope("BackendAffinity");

  constructor(private readonly db: Database) {}

  /** Affinity implied by the host the client is currently configured against. */
  current() {
    return normalizeBackendId(constants.API_HOST);
  }

  async get() {
    return await this.db.kv().read("backendAffinity");
  }

  /**
   * Bind this profile to the configured backend. Called on signup and on a
   * successful login, at which point the local data provably belongs to
   * whichever backend just authenticated us.
   */
  async record() {
    const id = this.current();
    this.logger.info("Recording backend affinity", { backend: id });
    await this.db.kv().write("backendAffinity", id);
    return id;
  }

  async clear() {
    await this.db.kv().delete("backendAffinity");
  }

  async check(): Promise<BackendAffinityResult> {
    const configured = this.current();

    // No account means no server-derived key material and nothing to push, so
    // there is nothing for affinity to protect.
    const user = await this.db.user.getUser();
    if (!user) return { status: "no-user", configured, inferred: false };

    const stored = await this.get();
    if (!stored) {
      // A logged-in profile with no recorded affinity predates this tracking.
      // Such data can only have come from Notesnook cloud.
      const inferredId = LEGACY_BACKEND_ID;
      return {
        status: inferredId === configured ? "match" : "mismatch",
        stored: inferredId,
        configured,
        inferred: true
      };
    }

    return {
      status: stored === configured ? "match" : "mismatch",
      stored,
      configured,
      inferred: false
    };
  }

  /**
   * True when the logged-in session belongs to a different backend than the one
   * configured. Callers must treat this as "stop", never as "reset".
   */
  async isMismatched() {
    const { status } = await this.check();
    return status === "mismatch";
  }
}
