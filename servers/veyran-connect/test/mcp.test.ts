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
 * The MCP server factory must be side-effect free: no profile read/write, no
 * pairing, no broker probe or start. This is what makes the SDK's default
 * legacy handshake and its disposable modern-probe sibling both safe.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { buildMcpServer } from "../src/mcp.js";
import { SERVER_VERSION } from "../src/mcp.js";
import { memoizeAttach } from "../src/tools.js";
import type { AttachResult } from "../src/attach.js";
import type { BrokerClient } from "../src/client.js";
import type { McpConfig } from "../src/config.js";

describe("MCP server factory", () => {
  it("creates nothing on disk and starts no broker", () => {
    const profile = path.join(
      os.tmpdir(),
      `veyran-connect-noside-${randomBytes(8).toString("hex")}`
    );
    expect(existsSync(profile)).toBe(false);
    const server = buildMcpServer({ profileDir: profile });
    expect(server).toBeTruthy();
    expect(existsSync(profile)).toBe(false);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("one caller instance per stdio process", () => {
  const config: McpConfig = {
    v: 1,
    brokerId: "0".repeat(32),
    port: 47821,
    client: { id: "0".repeat(32), secret: "A".repeat(43) },
    tls: {
      rootPem: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----",
      leafPin: "0".repeat(64)
    }
  };

  it("attaches (handshakes) once and reuses the instance across tool calls", async () => {
    let calls = 0;
    const ok = memoizeAttach(async (): Promise<AttachResult> => {
      calls += 1;
      return { ok: true, client: {} as unknown as BrokerClient, config };
    });
    await ok();
    await ok();
    await ok();
    // A single `hello` for the whole process: no per-call handshake churn that
    // could evict the app lease under the broker's bounded instance map.
    expect(calls).toBe(1);
  });

  it("never caches a failed attach, so a later call retries", async () => {
    let calls = 0;
    const unavailable = memoizeAttach(async (): Promise<AttachResult> => {
      calls += 1;
      return { ok: false, code: "BROKER_UNAVAILABLE" };
    });
    expect((await unavailable()).ok).toBe(false);
    expect((await unavailable()).ok).toBe(false);
    expect(calls).toBe(2);
  });
});
