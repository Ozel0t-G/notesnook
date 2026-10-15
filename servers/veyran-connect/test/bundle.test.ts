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
 * Static bundle-purity checks plus a real isolated handshake for the built
 * `dist/server.mjs` and the plugin's `plugin/veyran-connect/dist/server.mjs`
 * (run after a build; a missing bundle **fails**, it never skips). Proves the
 * bundle carries no DOM, database, SQL or content-pipeline module, never
 * invokes a package manager at runtime, and that the plugin's standalone copy
 * completes an SDK stdio handshake with no repository dependencies on its path.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ensureSecureDir } from "../src/secure-files.js";
import { saveMcpConfig } from "../src/config.js";
import { makeProfile } from "./harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../dist/server.mjs");
const pluginPath = path.resolve(here, "../../../plugin/veyran-connect/dist/server.mjs");
const built = existsSync(serverPath);
const pluginBuilt = existsSync(pluginPath);

const FORBIDDEN = [
  "better-sqlite3",
  "better-sqlite3-multiple-ciphers",
  "@streetwriters/kysely",
  "dompurify",
  "linkedom",
  "jsdom",
  "showdown",
  "@notesnook/core"
];

/**
 * Scan the *module specifiers* the bundle actually references (import / require
 * / dynamic import), not raw substrings: an explanatory comment may legitimately
 * name a module the bundle must never load. The esbuild purity guard already
 * fails the build if such a module enters the graph; this is the static proof of
 * that premise.
 */
function referencedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from|require\(|import\()\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) specifiers.push(match[1]);
  return specifiers;
}

function assertPure(file: string): void {
  const source = readFileSync(file, "utf8");
  const specifiers = referencedSpecifiers(source);
  for (const specifier of specifiers) {
    for (const name of FORBIDDEN)
      expect(specifier === name || specifier.startsWith(`${name}/`)).toBe(false);
    expect(specifier).not.toBe("child_process");
    expect(specifier).not.toBe("node:child_process");
  }
  expect(source).not.toMatch(/\bnpx\b/);
  expect(source).not.toMatch(/npm (install|exec|run)/);
}

describe("standalone bundle purity", () => {
  // Critical: a missing dist must fail the suite, never skip it.
  beforeAll(() => {
    if (!built)
      throw new Error(
        `dist/server.mjs is missing (${serverPath}); run "npm run build" before the tests.`
      );
  });

  it("contains no DOM/database/SQL/content-pipeline module", () => {
    assertPure(serverPath);
  });
});

describe("plugin bundle purity + isolated handshake", () => {
  beforeAll(() => {
    if (!pluginBuilt)
      throw new Error(
        `plugin dist/server.mjs is missing (${pluginPath}); run "npm run build" (which also emits the plugin bundle) before the tests.`
      );
  });

  it("is pure and self-contained", () => {
    assertPure(pluginPath);
  });

  it("answers a real SDK stdio handshake outside the repo dependency graph", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-connect-plugin-"));
    try {
      const profile = path.join(dir, "profile");
      await ensureSecureDir(profile);
      const material = await makeProfile();
      await saveMcpConfig(path.join(profile, "mcp.config.json"), {
        v: 1,
        brokerId: material.credentials.app.id,
        port: 47831,
        client: material.credentials.mcp,
        tls: { rootPem: material.tls.rootPem, leafPin: material.tls.leafPin }
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [pluginPath, "--profile", profile],
        cwd: path.dirname(pluginPath)
      });
      const client = new Client({ name: "veyran-connect-plugin-test", version: "1.0.0" });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        // The twelve Core operations plus the non-Core `capture_note`
        // (official Notesnook Inbox API), which needs no broker and no app.
        expect(tools).toHaveLength(13);
        expect(tools.map((tool) => tool.name)).toContain("capture_note");
        const status = await client.callTool({ name: "status", arguments: {} });
        expect(status.isError).toBe(true);
        expect((status.structuredContent as { code?: string } | undefined)?.code).toBe(
          "BROKER_UNAVAILABLE"
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
