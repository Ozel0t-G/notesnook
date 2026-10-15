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
 * The `inbox-key` CLI command — fail closed, never in argv, never echoed.
 *
 * The real command reads a key from a hidden foreground TTY prompt; a test
 * process has no TTY, so what is provable here is exactly the *refusal* half:
 * a key can never be entered through argv, a pipe, or a redirected stdin, and an
 * existing (valid or corrupt) key file is never overwritten. The hidden prompt
 * itself is covered by direct unit tests in `inbox-profile.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli.js";
import { operatorPaths } from "../src/paths.js";
import { ensureSecureDir } from "../src/secure-files.js";
import { loadInboxApiKey, saveInboxApiKey } from "../src/inbox-profile.js";

const TEST_KEY = "nn_inbox_testkey_0123456789abcdef";
const dirs: string[] = [];

afterEach(async () => {
  process.exitCode = 0;
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function tempProfile(withProfile = true): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-inbox-cli-"));
  dirs.push(base);
  const profile = path.join(base, "profile");
  if (withProfile) await ensureSecureDir(profile);
  return profile;
}

/** Capture everything the CLI writes while `run` executes. */
async function captureOutput(run: () => Promise<void>): Promise<string> {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return captured;
}

describe("inbox-key CLI", () => {
  it("refuses without an existing profile and writes nothing", async () => {
    const profile = await tempProfile(false);
    const output = await captureOutput(() => main(["inbox-key", "--profile", profile]));
    expect(process.exitCode).toBe(1);
    expect(output).toMatch(/run "setup" first/);
    expect(await fs.readdir(path.dirname(profile))).toEqual([]);
  });

  it("never accepts a key from argv", async () => {
    const profile = await tempProfile();
    const paths = operatorPaths(profile);
    const output = await captureOutput(() =>
      main(["inbox-key", "--profile", profile, "--key", TEST_KEY])
    );
    expect(process.exitCode).toBe(1);
    expect(output).toMatch(/never accepted in argv/);
    // The key never reaches a file, and never appears in any output.
    expect(output).not.toContain(TEST_KEY);
    await expect(loadInboxApiKey(paths.inboxKey)).rejects.toMatchObject({
      code: "INBOX_NOT_CONFIGURED"
    });
  });

  it("refuses a piped/non-TTY entry and writes nothing", async () => {
    const profile = await tempProfile();
    const paths = operatorPaths(profile);
    // A vitest worker has no TTY: the hidden prompt must refuse outright.
    expect(process.stdin.isTTY).toBeFalsy();
    const output = await captureOutput(() => main(["inbox-key", "--profile", profile]));
    expect(process.exitCode).toBe(1);
    expect(output).toMatch(/foreground TTY is required/);
    expect(output).not.toContain(TEST_KEY);
    await expect(loadInboxApiKey(paths.inboxKey)).rejects.toMatchObject({
      code: "INBOX_NOT_CONFIGURED"
    });
  });

  it("preserves an existing key unless --replace is passed", async () => {
    const profile = await tempProfile();
    const paths = operatorPaths(profile);
    await saveInboxApiKey(paths.inboxKey, TEST_KEY);
    const before = await fs.readFile(paths.inboxKey);

    const output = await captureOutput(() => main(["inbox-key", "--profile", profile]));
    expect(process.exitCode).toBe(1);
    expect(output).toMatch(/already configured/);
    expect(output).toMatch(/--replace/);
    expect(output).not.toContain(TEST_KEY);
    expect((await fs.readFile(paths.inboxKey)).equals(before)).toBe(true);

    // `--replace` still requires the hidden TTY prompt: the old key stays.
    const replaceOutput = await captureOutput(() =>
      main(["inbox-key", "--profile", profile, "--replace"])
    );
    expect(process.exitCode).toBe(1);
    expect(replaceOutput).toMatch(/foreground TTY is required/);
    expect((await fs.readFile(paths.inboxKey)).equals(before)).toBe(true);
  });

  it("never overwrites a corrupt or permission-unsafe key file", async () => {
    for (const setup of ["corrupt", "insecure"] as const) {
      const profile = await tempProfile();
      const paths = operatorPaths(profile);
      await fs.writeFile(
        paths.inboxKey,
        setup === "corrupt"
          ? "{not json"
          : JSON.stringify({ v: 1, createdAt: 1, apiKey: TEST_KEY }),
        { mode: 0o600 }
      );
      if (setup === "insecure") await fs.chmod(paths.inboxKey, 0o644);
      const before = await fs.readFile(paths.inboxKey);

      const output = await captureOutput(() =>
        main(["inbox-key", "--profile", profile, "--replace"])
      );
      expect(process.exitCode).toBe(1);
      expect(output).toMatch(/refusing to overwrite/);
      expect((await fs.readFile(paths.inboxKey)).equals(before)).toBe(true);
    }
  });

  it("reports the key file state without reading the key into the report", async () => {
    const profile = await tempProfile();
    const paths = operatorPaths(profile);

    const missing = await captureOutput(() => main(["status", "--profile", profile]));
    expect(missing).toContain('"inboxKey": "missing"');

    await saveInboxApiKey(paths.inboxKey, TEST_KEY);
    const present = await captureOutput(() => main(["status", "--profile", profile]));
    expect(present).toContain('"inboxKey": "ok"');
    expect(present).not.toContain(TEST_KEY);
    expect(present).not.toContain(TEST_KEY.slice(0, 12));
  });

  it("lists the command in its usage text", async () => {
    const output = await captureOutput(() => main([]));
    expect(output).toContain("inbox-key");
    expect(output).not.toContain(TEST_KEY);
  });
});
