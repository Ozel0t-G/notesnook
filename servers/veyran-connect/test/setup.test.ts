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
 * `setup` is fail-closed.
 *
 * It is idempotent only for a *fully consistent* profile and never silently
 * overwrites or rotates a partial/corrupt/insecure one: a rejected profile is
 * left byte-for-byte unchanged, including the case where the credentials file
 * exists but the broker config is missing (or vice versa) — a previous
 * candidate generated a whole new credential bundle *before* noticing that the
 * config was gone. No file is written until every check has passed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli.js";
import { operatorPaths } from "../src/paths.js";
import { freePort } from "./harness.js";

const dirs: string[] = [];

async function tempProfile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-connect-setup-"));
  dirs.push(dir);
  return path.join(dir, "profile");
}

async function snapshot(files: string[]): Promise<Map<string, Buffer | undefined>> {
  const result = new Map<string, Buffer | undefined>();
  for (const file of files)
    result.set(file, await fs.readFile(file).catch(() => undefined));
  return result;
}

function assertUnchanged(
  before: Map<string, Buffer | undefined>,
  after: Map<string, Buffer | undefined>
): void {
  for (const [file, value] of before) {
    const next = after.get(file);
    if (value === undefined) expect(next).toBeUndefined();
    else expect(next?.equals(value)).toBe(true);
  }
}

afterEach(async () => {
  // `fail()` sets process.exitCode; never let a rejected-profile test leak it.
  process.exitCode = 0;
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("setup fail-closed", () => {
  it("creates both files on a fresh profile and preserves them on re-run", async () => {
    const profile = await tempProfile();
    await main(["setup", "--profile", profile, "--port", String(await freePort())]);
    const paths = operatorPaths(profile);
    const before = await snapshot([paths.credentials, paths.config, paths.mcpConfig]);
    expect(before.get(paths.credentials)).toBeTruthy();
    expect(before.get(paths.config)).toBeTruthy();

    // A second run is a no-op: identical bytes, no rotation, no port re-probe.
    await main(["setup", "--profile", profile]);
    assertUnchanged(before, await snapshot([paths.credentials, paths.config, paths.mcpConfig]));
  });

  it("refuses a credentials-without-config partial profile and changes nothing", async () => {
    const profile = await tempProfile();
    await main(["setup", "--profile", profile, "--port", String(await freePort())]);
    const paths = operatorPaths(profile);
    await fs.rm(paths.config);

    const before = await snapshot([paths.credentials, paths.config, paths.mcpConfig]);
    await main(["setup", "--profile", profile, "--port", String(await freePort())]);
    expect(process.exitCode).toBe(1);
    // Not only the credentials: the missing config must NOT be regenerated.
    assertUnchanged(before, await snapshot([paths.credentials, paths.config, paths.mcpConfig]));
  });

  it("refuses a config-without-credentials partial profile and changes nothing", async () => {
    const profile = await tempProfile();
    await main(["setup", "--profile", profile, "--port", String(await freePort())]);
    const paths = operatorPaths(profile);
    await fs.rm(paths.credentials);

    const before = await snapshot([paths.credentials, paths.config, paths.mcpConfig]);
    await main(["setup", "--profile", profile]);
    expect(process.exitCode).toBe(1);
    assertUnchanged(before, await snapshot([paths.credentials, paths.config, paths.mcpConfig]));
  });

  it("refuses an inconsistent MCP caller config instead of rotating it", async () => {
    const profile = await tempProfile();
    await main(["setup", "--profile", profile, "--port", String(await freePort())]);
    const paths = operatorPaths(profile);
    const mcp = JSON.parse(await fs.readFile(paths.mcpConfig, "utf8")) as {
      client: { id: string };
    };
    mcp.client.id = "0".repeat(32);
    await fs.writeFile(paths.mcpConfig, JSON.stringify(mcp, null, 2), { mode: 0o600 });

    const before = await snapshot([paths.credentials, paths.config, paths.mcpConfig]);
    await main(["setup", "--profile", profile]);
    expect(process.exitCode).toBe(1);
    assertUnchanged(before, await snapshot([paths.credentials, paths.config, paths.mcpConfig]));
  });
});
