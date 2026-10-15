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
 * Permission- and symlink-hardened file access for the operator profile.
 *
 * Every read validates, in order: `lstat` (regular file, not a symlink, owned by
 * this uid, mode `0600`, bounded size), then opens with `O_NOFOLLOW` and
 * `fstat`s the *same* descriptor (dev/ino must match the `lstat`, mode and uid
 * re-checked, size re-bounded). A swap between the two checks is therefore
 * detected, and a symlinked credential/config file is refused outright.
 *
 * Every write is atomic: a `0600` temp file created with `O_EXCL|O_WRONLY` in
 * the `0700` profile directory, written, `fsync`ed, re-`fstat`ed, `rename`d
 * over the destination, and the directory `fsync`ed. A partially written or
 * world-readable file never becomes the live one. No secret is ever passed
 * through argv, the environment, stdout, stderr or a log line.
 */
import {
  constants as fsConstants,
  promises as fs,
  type Stats
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type InsecureReason =
  | "missing"
  | "not_a_file"
  | "is_symlink"
  | "foreign_owner"
  | "insecure_mode"
  | "oversized"
  | "empty"
  | "changed"
  | "unreadable";

export class InsecureFileError extends Error {
  readonly reason: InsecureReason;
  constructor(reason: InsecureReason) {
    super(`insecure operator file: ${reason}`);
    this.name = "InsecureFileError";
    this.reason = reason;
  }
}

export function posixUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export function fileMode(stats: Stats): number {
  return stats.mode & 0o777;
}

/**
 * Validate a directory: exists, is a real directory (not a symlink), owned by
 * this uid, mode exactly `0700`.
 */
export async function assertSecureDir(dir: string): Promise<void> {
  const stats = await fs.lstat(dir);
  if (stats.isSymbolicLink()) throw new InsecureFileError("is_symlink");
  if (!stats.isDirectory()) throw new InsecureFileError("not_a_file");
  const uid = posixUid();
  if (uid !== undefined && typeof stats.uid === "number" && stats.uid !== uid)
    throw new InsecureFileError("foreign_owner");
  if (fileMode(stats) !== 0o700)
    throw new InsecureFileError("insecure_mode");
}

/** Create the `0700` operator profile directory if it does not exist. */
export async function ensureSecureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
  }
  await assertSecureDir(dir);
}

/**
 * Read a bounded, `0600`, non-symlinked file. Throws `InsecureFileError` on any
 * violation so callers fail closed instead of trusting a foreign file.
 */
export async function readSecureFile(
  file: string,
  maxBytes: number
): Promise<Buffer> {
  let linkStats: Stats;
  try {
    linkStats = await fs.lstat(file);
  } catch {
    throw new InsecureFileError("missing");
  }
  if (linkStats.isSymbolicLink()) throw new InsecureFileError("is_symlink");
  if (!linkStats.isFile()) throw new InsecureFileError("not_a_file");
  const uid = posixUid();
  if (uid !== undefined && typeof linkStats.uid === "number" && linkStats.uid !== uid)
    throw new InsecureFileError("foreign_owner");
  if (fileMode(linkStats) !== 0o600)
    throw new InsecureFileError("insecure_mode");
  if (linkStats.size > maxBytes) throw new InsecureFileError("oversized");
  if (linkStats.size === 0) throw new InsecureFileError("empty");

  let handle: FileHandle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
  } catch {
    throw new InsecureFileError("unreadable");
  }
  try {
    const fdStats = await handle.stat();
    if (!fdStats.isFile()) throw new InsecureFileError("not_a_file");
    if (
      typeof linkStats.dev === "number" &&
      typeof linkStats.ino === "number" &&
      (fdStats.dev !== linkStats.dev || fdStats.ino !== linkStats.ino)
    )
      throw new InsecureFileError("changed");
    if (uid !== undefined && typeof fdStats.uid === "number" && fdStats.uid !== uid)
      throw new InsecureFileError("foreign_owner");
    if (fileMode(fdStats) !== 0o600)
      throw new InsecureFileError("insecure_mode");
    if (fdStats.size > maxBytes) throw new InsecureFileError("oversized");
    if (fdStats.size === 0) throw new InsecureFileError("empty");
    const buffer = Buffer.alloc(fdStats.size);
    let offset = 0;
    while (offset < fdStats.size) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        fdStats.size - offset,
        offset
      );
      if (bytesRead <= 0) throw new InsecureFileError("changed");
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readSecureJson<T>(
  file: string,
  maxBytes: number
): Promise<T> {
  const buffer = await readSecureFile(file, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new InsecureFileError("unreadable");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new InsecureFileError("unreadable");
  }
}

/**
 * Atomically create/replace a `0600` file inside an existing `0700` directory.
 * The destination is *not* followed if it is a symlink: `rename` replaces the
 * link itself (never its target), and the temp file is created `O_EXCL`.
 */
export async function writeSecureFileAtomic(
  file: string,
  data: Buffer,
  maxBytes: number,
  options: { ensurePrivateDir?: boolean } = {}
): Promise<void> {
  if (data.byteLength > maxBytes) throw new InsecureFileError("oversized");
  const dir = path.dirname(file);
  if (options.ensurePrivateDir === false) {
    // The caller-chosen export directory must already exist; we never create
    // arbitrary directories and never require foreign dirs to be 0700. The
    // file itself is still created `0600` with `O_EXCL`.
    const dirStats = await fs.lstat(dir);
    if (!dirStats.isDirectory() || dirStats.isSymbolicLink())
      throw new InsecureFileError("not_a_file");
  } else {
    await ensureSecureDir(dir);
  }
  const temp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${randomBytes(8).toString("hex")}`
  );
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      temp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    );
    await handle.writeFile(data);
    await handle.sync();
    const stats = await handle.stat();
    if (!stats.isFile() || fileMode(stats) !== 0o600)
      throw new InsecureFileError("insecure_mode");
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    // Best-effort directory durability; the file itself is already fsynced.
    const dirHandle = await fs.open(dir, fsConstants.O_RDONLY).catch(() => undefined);
    if (dirHandle) {
      await dirHandle.sync().catch(() => undefined);
      await dirHandle.close().catch(() => undefined);
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function writeSecureJsonAtomic<T>(
  file: string,
  value: T,
  maxBytes: number,
  options: { ensurePrivateDir?: boolean } = {}
): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  await writeSecureFileAtomic(file, Buffer.from(text, "utf8"), maxBytes, options);
}

/** Non-throwing probe used by the status CLI. */
export async function inspectSecureFile(
  file: string,
  maxBytes: number
): Promise<{ ok: true } | { ok: false; reason: InsecureReason }> {
  try {
    await readSecureFile(file, maxBytes);
    return { ok: true };
  } catch (error) {
    if (error instanceof InsecureFileError) return { ok: false, reason: error.reason };
    return { ok: false, reason: "unreadable" };
  }
}
