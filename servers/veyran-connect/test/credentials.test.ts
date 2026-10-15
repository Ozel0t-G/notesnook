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

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  authenticate,
  constantTimeEqual,
  createCredential,
  credentialSchema,
  formatBearerToken,
  parseBearerToken
} from "../src/credentials.js";
import {
  brokerConfigSchema,
  connectionExportSchema,
  mcpConfigSchema
} from "../src/config.js";
import {
  assertSecureDir,
  ensureSecureDir,
  fileMode,
  InsecureFileError,
  readSecureFile,
  writeSecureFileAtomic
} from "../src/secure-files.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-connect-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("operator profile permissions", () => {
  it("creates a 0700 directory and a 0600 file with round-trippable contents", async () => {
    const base = await tempDir();
    const profile = path.join(base, "profile");
    await ensureSecureDir(profile);
    await assertSecureDir(profile);
    const file = path.join(profile, "broker.credentials.json");
    const bytes = Buffer.from(JSON.stringify({ v: 1 }), "utf8");
    await writeSecureFileAtomic(file, bytes, 64 * 1024);
    const stats = await fs.lstat(file);
    expect(fileMode(stats)).toBe(0o600);
    const read = await readSecureFile(file, 64 * 1024);
    expect(read.equals(bytes)).toBe(true);
  });

  it("refuses a symlinked credential file", async () => {
    const base = await tempDir();
    const profile = path.join(base, "profile");
    await ensureSecureDir(profile);
    const target = path.join(profile, "real.json");
    await writeSecureFileAtomic(target, Buffer.from("{}"), 1024);
    const link = path.join(profile, "link.json");
    await fs.symlink(target, link);
    await expect(readSecureFile(link, 1024)).rejects.toBeInstanceOf(InsecureFileError);
    await expect(readSecureFile(link, 1024)).rejects.toMatchObject({
      reason: "is_symlink"
    });
  });

  it("refuses world/group readable files and empty files", async () => {
    const base = await tempDir();
    const profile = path.join(base, "profile");
    await ensureSecureDir(profile);
    const file = path.join(profile, "f.json");
    await writeSecureFileAtomic(file, Buffer.from('{"a":1}'), 1024);
    await fs.chmod(file, 0o644);
    await expect(readSecureFile(file, 1024)).rejects.toMatchObject({
      reason: "insecure_mode"
    });
    const empty = path.join(profile, "empty.json");
    await fs.writeFile(empty, "", { mode: 0o600 });
    await fs.chmod(empty, 0o600);
    await expect(readSecureFile(empty, 1024)).rejects.toMatchObject({ reason: "empty" });
  });

  it("refuses oversized files and rejects an insecure directory mode", async () => {
    const base = await tempDir();
    const profile = path.join(base, "profile");
    await ensureSecureDir(profile);
    const file = path.join(profile, "big.json");
    await writeSecureFileAtomic(
      file,
      Buffer.from(randomBytes(2048).toString("hex")),
      2048 * 4
    );
    await expect(readSecureFile(file, 128)).rejects.toMatchObject({
      reason: "oversized"
    });
    await fs.chmod(profile, 0o755);
    await expect(assertSecureDir(profile)).rejects.toMatchObject({
      reason: "insecure_mode"
    });
  });

  it("replaces atomically and keeps the final file 0600", async () => {
    const base = await tempDir();
    const profile = path.join(base, "profile");
    await ensureSecureDir(profile);
    const file = path.join(profile, "f.json");
    await writeSecureFileAtomic(file, Buffer.from('{"v":1}'), 1024);
    await writeSecureFileAtomic(file, Buffer.from('{"v":2}'), 1024);
    expect((await readSecureFile(file, 1024)).toString()).toBe('{"v":2}');
    expect(fileMode(await fs.lstat(file))).toBe(0o600);
  });
});

describe("broker credentials", () => {
  it("generates exactly 256-bit credentials with a 32-hex id", () => {
    const app = createCredential();
    const mcp = createCredential();
    expect(app.secret).not.toBe(mcp.secret);
    expect(Buffer.from(app.secret, "base64url").length).toBe(32);
    expect(Buffer.from(mcp.secret, "base64url").length).toBe(32);
    expect(app.secret).toHaveLength(43);
    expect(app.id).toMatch(/^[0-9a-f]{32}$/);
    expect(credentialSchema.safeParse(app).success).toBe(true);
  });

  it("rejects a secret that is not exactly 256 bits", () => {
    expect(
      credentialSchema.safeParse({ id: "a".repeat(32), secret: "b".repeat(32) }).success
    ).toBe(false);
    expect(
      credentialSchema.safeParse({ id: "a".repeat(32), secret: "b".repeat(64) }).success
    ).toBe(false);
    expect(
      credentialSchema.safeParse({ id: "a".repeat(16), secret: "b".repeat(43) }).success
    ).toBe(false);
  });

  it("authenticates only the exact credential, constant-time", () => {
    const app = createCredential();
    const mcp = createCredential();
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    const header = formatBearerToken(app);
    expect(parseBearerToken(header)).toEqual(app);
    expect(authenticate(header, app)).toBe(true);
    expect(authenticate(header, mcp)).toBe(false);
    expect(authenticate(undefined, app)).toBe(false);
    expect(authenticate("Bearer ../../etc/passwd", app)).toBe(false);
    expect(authenticate(`Bearer ${app.id}.${"x".repeat(42)}`, app)).toBe(false);
  });
});

describe("persisted documents are strict and TLS-consistent", () => {
  const tls = {
    rootPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    leafPin: "a".repeat(64)
  };

  it("requires a leaf pin in the broker config", () => {
    expect(
      brokerConfigSchema.safeParse({
        v: 1,
        brokerId: "b".repeat(32),
        port: 47821,
        createdAt: 1,
        leafPin: "a".repeat(64)
      }).success
    ).toBe(true);
    expect(
      brokerConfigSchema.safeParse({
        v: 1,
        brokerId: "b".repeat(32),
        port: 47821,
        createdAt: 1
      }).success
    ).toBe(false);
  });

  it("requires the public root + pin in the caller config and the export", () => {
    const credential = createCredential();
    expect(
      mcpConfigSchema.safeParse({
        v: 1,
        brokerId: "b".repeat(32),
        port: 47821,
        client: credential,
        tls
      }).success
    ).toBe(true);
    expect(
      mcpConfigSchema.safeParse({
        v: 1,
        brokerId: "b".repeat(32),
        port: 47821,
        client: credential
      }).success
    ).toBe(false);
    expect(
      connectionExportSchema.safeParse({
        v: 1,
        service: "veyran-connect",
        brokerId: "b".repeat(32),
        port: 47821,
        app: credential,
        tls
      }).success
    ).toBe(true);
  });

  it("rejects a malformed pin", () => {
    expect(
      mcpConfigSchema.safeParse({
        v: 1,
        brokerId: "b".repeat(32),
        port: 47821,
        client: createCredential(),
        tls: { rootPem: tls.rootPem, leafPin: "not-a-pin" }
      }).success
    ).toBe(false);
  });
});
