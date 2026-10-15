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
 * Attach-or-honest-unavailable.
 *
 * The stdio server never spawns the broker, never scans ports, never takes over
 * an existing listener and never probes a foreign process: it reads its own
 * `0600` caller config, then performs **one pinned-TLS authenticated health
 * probe** to exactly the persisted loopback port. The pinned handshake verifies
 * the exact leaf DER *before* the credential is sent, so no bearer token can
 * reach a foreign listener. Only a `veyran-connect` service whose `brokerId`
 * and `port` match the persisted config is accepted. Anything else —
 * connection refused, foreign certificate, identity mismatch, bad credential —
 * is reported as an honest, static `BROKER_UNAVAILABLE` (or a config error).
 */
import { BrokerClient } from "./client.js";
import { loadMcpConfig, type McpConfig } from "./config.js";
import { operatorPaths } from "./paths.js";
import { BrokerError, type BrokerErrorCode } from "./errors.js";
import { reportDiagnostic } from "./logging.js";

export type AttachResult =
  | { ok: true; client: BrokerClient; config: McpConfig }
  | {
      ok: false;
      code: Extract<
        BrokerErrorCode,
        "BROKER_UNAVAILABLE" | "CONFIG_INVALID" | "CONFIG_INSECURE"
      >;
    };

export async function attachBroker(profileDir?: string): Promise<AttachResult> {
  const paths = operatorPaths(profileDir);
  let config: McpConfig;
  try {
    config = await loadMcpConfig(paths.mcpConfig);
  } catch (error) {
    const code =
      error instanceof BrokerError && error.code === "CONFIG_INSECURE"
        ? "CONFIG_INSECURE"
        : "CONFIG_INVALID";
    reportDiagnostic(code === "CONFIG_INSECURE" ? "CONFIG_INSECURE" : "CONFIG_INVALID");
    return { ok: false, code };
  }
  const client = new BrokerClient({
    port: config.port,
    credential: config.client,
    rootPem: config.tls.rootPem,
    leafPin: config.tls.leafPin
  });
  const health = await client.health().then(
    (value) => value,
    () => undefined
  );
  if (
    !health ||
    health.service !== "veyran-connect" ||
    health.port !== config.port ||
    health.brokerId !== config.brokerId
  ) {
    reportDiagnostic("BROKER_ATTACH_FAILED");
    return { ok: false, code: "BROKER_UNAVAILABLE" };
  }
  reportDiagnostic("BROKER_ATTACHED");
  return { ok: true, client, config };
}
