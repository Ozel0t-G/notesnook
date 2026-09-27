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

import { extractHostname } from "./hostname.js";

const COMPATIBLE_SERVER_VERSION = 1;

export function isServerCompatible(version: number) {
  return COMPATIBLE_SERVER_VERSION === version;
}

function isProduction() {
  return (
    process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test"
  );
}

/**
 * VeyraN-owned backends. Verified 2026-09-26 by read-only probe: the auth host
 * serves an IdentityServer4 discovery document advertising exactly the scopes
 * and custom grant types this client uses, and the sync and events hosts report
 * `version: 1`, which is what `isServerCompatible` requires.
 *
 * There is deliberately no files host: attachment traffic is presigned through
 * `API_HOST/s3` and the object store is never addressed directly by the client.
 *
 * Legacy billing, issue reporting, and marketing host keys are retained only
 * for API compatibility. Production values are inert, and their call sites
 * fail closed before any network request.
 */
export const hosts = {
  API_HOST: isProduction()
    ? "https://api.veyran.northcore.space"
    : "http://localhost:5264",
  AUTH_HOST: isProduction()
    ? "https://auth.veyran.northcore.space"
    : "http://localhost:8264",
  SSE_HOST: isProduction()
    ? "https://events.veyran.northcore.space"
    : "http://localhost:7264",
  SUBSCRIPTIONS_HOST: isProduction()
    ? "https://billing-disabled.veyran.invalid"
    : "http://localhost:9264",
  ISSUES_HOST: isProduction()
    ? "https://issues-disabled.veyran.invalid"
    : "http://localhost:2624",
  MONOGRAPH_HOST: isProduction()
    ? "https://share.veyran.northcore.space"
    : "http://localhost:6264",
  NOTESNOOK_HOST: isProduction()
    ? "https://commerce-disabled.veyran.invalid"
    : "http://localhost:8787"
};

export default hosts;

export type HostId = keyof typeof hosts;

/**
 * The subset of hosts the user (or an integrator) explicitly persisted, as
 * opposed to the values this build shipped as defaults.
 *
 * This matters for profiles that predate backend-affinity tracking: a saved
 * server configuration is reliable evidence of which backend such a profile's
 * data came from, whereas a default cannot be reconstructed after the fact
 * because it varies per build. Set by `Database.host()`; never populated from a
 * network response.
 */
let persistedHostOverrides: Partial<Record<HostId, string>> | undefined;

export function setPersistedHostOverrides(
  overrides?: Partial<Record<HostId, string>>
) {
  persistedHostOverrides =
    overrides && Object.keys(overrides).length > 0
      ? { ...overrides }
      : undefined;
}

export function getPersistedHostOverrides() {
  return persistedHostOverrides;
}

const HOSTNAMES = {
  [extractHostname(hosts.API_HOST)]: "Sync service",
  [extractHostname(hosts.AUTH_HOST)]: "Authentication service",
  [extractHostname(hosts.SSE_HOST)]: "Events service",
  [extractHostname(hosts.SUBSCRIPTIONS_HOST)]: "Legacy billing service",
  [extractHostname(hosts.ISSUES_HOST)]: "Legacy issue service",
  [extractHostname(hosts.MONOGRAPH_HOST)]: "Sharing service"
};

export const getServerNameFromHost = (host: string) => {
  return HOSTNAMES[host];
};
