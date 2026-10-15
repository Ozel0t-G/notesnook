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
 * The operator profile's Inbox files — **separate** from every broker file:
 *
 *  - `inbox.key.json` — the user's own Notesnook Inbox API key. A *different*
 *    secret from the broker's app/MCP credentials, in its own file, written
 *    only by the explicit `inbox-key` CLI command behind a hidden TTY prompt.
 *    It is never accepted in argv, the environment, or a tool argument, never
 *    echoed, logged or telemetered, and never copied into `mcp.config.json`.
 *  - `inbox.receipts.json` — bounded *local* write receipts for `capture_note`:
 *    `{ operationId, payloadHash, state, at }`. A receipt records only what this
 *    process observed locally (an accepted 200, or an unknown outcome); it never
 *    claims a remote status the Inbox API cannot report, and never contains any
 *    part of the captured text.
 *
 * Both files are read with the same `lstat` + `O_NOFOLLOW` + `fstat` validation
 * as every other profile file (0600, owned by this uid, not a symlink, bounded
 * size) and written atomically. A missing key is `INBOX_NOT_CONFIGURED`; a
 * corrupt key is `CONFIG_INVALID`; a permission-unsafe key is `CONFIG_INSECURE`.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { INBOX_LIMITS } from "./limits.js";
import {
  assertSecureDir,
  fileMode,
  InsecureFileError,
  posixUid,
  readSecureJson,
  writeSecureJsonAtomic
} from "./secure-files.js";
import { OPERATION_ID_PATTERN } from "./inbox-format.js";

export type InboxProfileErrorCode =
  | "INBOX_NOT_CONFIGURED"
  | "INBOX_BUSY"
  | "CONFIG_INVALID"
  | "CONFIG_INSECURE";

export class InboxProfileError extends Error {
  readonly code: InboxProfileErrorCode;
  constructor(code: InboxProfileErrorCode) {
    super(code);
    this.name = "InboxProfileError";
    this.code = code;
  }
}

function keyFileBudget(): number {
  return INBOX_LIMITS.maxKeyFileBytes;
}

function receiptsFileBudget(): number {
  return INBOX_LIMITS.maxReceiptsFileBytes;
}

/**
 * Map a hardened-file failure onto the bounded tool surface. `missing` is
 * `INBOX_NOT_CONFIGURED` for the key (the operator's one missing setup step) and
 * simply "no receipts yet" for the receipt file; permission violations stay
 * distinguishable from corruption.
 */
export function toInboxProfileError(
  error: unknown,
  missing: InboxProfileErrorCode = "CONFIG_INVALID"
): InboxProfileError {
  if (error instanceof InboxProfileError) return error;
  if (error instanceof InsecureFileError) {
    switch (error.reason) {
      case "missing":
        return new InboxProfileError(missing);
      case "insecure_mode":
      case "is_symlink":
      case "foreign_owner":
        return new InboxProfileError("CONFIG_INSECURE");
      default:
        return new InboxProfileError("CONFIG_INVALID");
    }
  }
  return new InboxProfileError("CONFIG_INVALID");
}

// --------------------------------------------------------------- the API key

/**
 * The Inbox API key shape. The documented endpoint takes the key verbatim in
 * the `Authorization` header and documents no format, so the bound is strict
 * but format-agnostic: printable ASCII only (no whitespace, no control
 * character, no non-ASCII), 16..1024 characters. A wrong or over-long value is
 * refused before it can ever reach a socket or a file.
 */
export const inboxApiKeySchema = z
  .string()
  .min(INBOX_LIMITS.minKeyChars)
  .max(INBOX_LIMITS.maxKeyChars)
  .regex(/^[\x21-\x7E]+$/, "the key must be printable ASCII without spaces");

export const inboxKeyFileSchema = z.strictObject({
  v: z.literal(1),
  createdAt: z.number().int().min(0),
  apiKey: inboxApiKeySchema
});

export type InboxKeyFile = z.infer<typeof inboxKeyFileSchema>;

/** Load and validate the operator's Inbox API key; fails closed on any doubt. */
export async function loadInboxApiKey(file: string): Promise<string> {
  try {
    const raw = await readSecureJson<unknown>(file, keyFileBudget());
    const parsed = inboxKeyFileSchema.safeParse(raw);
    if (!parsed.success) throw new InboxProfileError("CONFIG_INVALID");
    return parsed.data.apiKey;
  } catch (error) {
    throw toInboxProfileError(error, "INBOX_NOT_CONFIGURED");
  }
}

/**
 * A one-way binding between local repeat receipts and the configured recipient
 * credential. The Inbox API key itself is never written to receipts. This
 * prevents a receipt accepted for one Notesnook account from being replayed as
 * if it belonged to a different account after the operator rotates the key.
 */
export function inboxRecipientBinding(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

/** Write the key file atomically (0600, inside the existing 0700 profile). */
export async function saveInboxApiKey(file: string, apiKey: string): Promise<void> {
  const document = inboxKeyFileSchema.parse({
    v: 1,
    createdAt: Date.now(),
    apiKey
  });
  await writeSecureJsonAtomic(file, document, keyFileBudget());
}

/**
 * Serialize capture receipt transactions across independent stdio MCP
 * processes. The profile's 0700 directory and an exclusive 0600 marker make
 * acquisition atomic. A crash can leave a stale marker; we deliberately do
 * not guess whether another process is alive or remove it on a timer. The
 * caller then fails closed with INBOX_BUSY until the operator verifies all
 * Connect processes are stopped and removes the marker manually.
 */
export async function withInboxReceiptFileLock<T>(
  file: string,
  work: () => Promise<T>
): Promise<T> {
  await assertSecureDir(path.dirname(file));
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created = false;
  let identity: { dev: number; ino: number } | undefined;
  try {
    try {
      handle = await fs.open(file, "wx", 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new InboxProfileError("INBOX_BUSY");
      throw error;
    }
    const stats = await handle.stat();
    const uid = posixUid();
    if (
      !stats.isFile() ||
      fileMode(stats) !== 0o600 ||
      (uid !== undefined && stats.uid !== uid)
    ) {
      throw new InboxProfileError("CONFIG_INSECURE");
    }
    identity = { dev: stats.dev, ino: stats.ino };
    await handle.writeFile(
      JSON.stringify({ v: 1, pid: process.pid, createdAt: Date.now() }),
      "utf8"
    );
    await handle.sync();
    return await work();
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (created && identity) {
      try {
        const current = await fs.lstat(file);
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          fileMode(current) === 0o600 &&
          current.dev === identity.dev &&
          current.ino === identity.ino
        ) {
          await fs.unlink(file);
        }
      } catch {
        // Never replace the operation outcome with a lock-cleanup diagnostic.
      }
    } else if (created) {
      // Acquisition failed after exclusive creation but before identity was
      // captured; remove only a regular 0600 file at the owned profile path.
      try {
        const current = await fs.lstat(file);
        if (current.isFile() && !current.isSymbolicLink() && fileMode(current) === 0o600)
          await fs.unlink(file);
      } catch {
        // Fail closed on the next operation if cleanup was not possible.
      }
    }
  }
}

// ------------------------------------------------------------- the TTY prompt

export interface HiddenPromptInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: "data", listener: (chunk: string) => void) => unknown;
  removeListener: (event: "data", listener: (chunk: string) => void) => unknown;
}

export interface HiddenPromptOutput {
  isTTY?: boolean;
  write: (text: string) => unknown;
}

export type HiddenPromptFailure = "not_a_tty" | "aborted";

export class HiddenPromptError extends Error {
  readonly reason: HiddenPromptFailure;
  constructor(reason: HiddenPromptFailure) {
    super(`hidden prompt refused: ${reason}`);
    this.name = "HiddenPromptError";
    this.reason = reason;
  }
}

/**
 * Read one line from a foreground TTY with echo disabled. The typed characters
 * are never written to any stream (no echo, no asterisks), never buffered
 * beyond the bounded key length, and the terminal is always restored — even on
 * Ctrl-C, which rejects with `aborted`. A non-TTY (a pipe, a file, a
 * redirected stdin, a CI runner) is refused outright: an unhidden key entry can
 * never be piped in.
 */
export function promptHiddenKey(
  streams: { input: HiddenPromptInput; output: HiddenPromptOutput },
  prompt: string
): Promise<string> {
  const { input, output } = streams;
  if (!input.isTTY || !output.isTTY)
    return Promise.reject(new HiddenPromptError("not_a_tty"));

  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;

    const cleanup = (): void => {
      input.removeListener("data", onData);
      try {
        input.setRawMode?.(false);
      } catch {
        // Restoring the terminal must never mask the outcome.
      }
      try {
        input.pause();
      } catch {
        // Same: a pause failure is not a reason to keep the process alive.
      }
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          const result = value;
          settle(() => resolve(result));
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          // Ctrl-C / Ctrl-D: abort without revealing anything.
          settle(() => reject(new HiddenPromptError("aborted")));
          return;
        }
        if (character === "\u007F" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character < " ") continue;
        // Bounded: one character past the maximum is enough to fail validation
        // later, without buffering an unbounded paste in memory.
        if (value.length <= INBOX_LIMITS.maxKeyChars) value += character;
      }
    };

    try {
      input.setEncoding("utf8");
      input.setRawMode?.(true);
      input.on("data", onData);
      input.resume();
      output.write(prompt);
    } catch {
      settle(() => reject(new HiddenPromptError("not_a_tty")));
    }
  });
}

// ------------------------------------------------------------- write receipts

export const INBOX_RECEIPT_STATES = ["accepted", "uncertain"] as const;
export type InboxReceiptState = (typeof INBOX_RECEIPT_STATES)[number];

/**
 * One local write receipt. `accepted` means *this process saw a documented
 * `200 {"success":true}`* (the Inbox server encrypted and queued the item) —
 * never that a note exists on any device. `uncertain` means the request may
 * have reached the endpoint without such an acceptance; it is deliberately
 * **not** retried automatically.
 */
export const inboxReceiptSchema = z.strictObject({
  operationId: z
    .string()
    .min(1)
    .max(INBOX_LIMITS.maxOperationIdChars)
    .regex(OPERATION_ID_PATTERN),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  recipientBinding: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(INBOX_RECEIPT_STATES),
  at: z.number().int().min(0)
});

export type InboxReceipt = z.infer<typeof inboxReceiptSchema>;

export const inboxReceiptsFileSchema = z.strictObject({
  v: z.literal(2),
  receipts: z.array(inboxReceiptSchema).max(INBOX_LIMITS.maxReceipts)
});

export type InboxReceiptsFile = z.infer<typeof inboxReceiptsFileSchema>;

/**
 * A bounded, keyed receipt history (one entry per stable `operationId`). The
 * whole file is small and read-modify-written atomically; the oldest entry is
 * dropped once the bounded capacity is reached, so the file can never grow
 * without limit.
 */
export class InboxReceiptStore {
  constructor(private readonly file: string) {}

  async list(): Promise<InboxReceipt[]> {
    try {
      const raw = await readSecureJson<unknown>(this.file, receiptsFileBudget());
      const parsed = inboxReceiptsFileSchema.safeParse(raw);
      if (!parsed.success) throw new InboxProfileError("CONFIG_INVALID");
      return parsed.data.receipts;
    } catch (error) {
      // A genuinely absent receipt file is simply an empty history; every other
      // failure fails closed.
      if (error instanceof InsecureFileError && error.reason === "missing")
        return [];
      throw toInboxProfileError(error);
    }
  }

  async get(operationId: string): Promise<InboxReceipt | undefined> {
    const receipts = await this.list();
    return receipts.find((receipt) => receipt.operationId === operationId);
  }

  async put(receipt: InboxReceipt): Promise<void> {
    const receipts = await this.list();
    const kept = receipts.filter(
      (entry) => entry.operationId !== receipt.operationId
    );
    kept.push(receipt);
    const bounded = kept
      .slice()
      .sort((left, right) => left.at - right.at)
      .slice(-INBOX_LIMITS.maxReceipts);
    const document: InboxReceiptsFile = { v: 2, receipts: bounded };
    await writeSecureJsonAtomic(this.file, document, receiptsFileBudget());
  }

  async remove(operationId: string): Promise<void> {
    const receipts = await this.list();
    const kept = receipts.filter((entry) => entry.operationId !== operationId);
    if (kept.length === receipts.length) return;
    const document: InboxReceiptsFile = { v: 2, receipts: kept };
    await writeSecureJsonAtomic(this.file, document, receiptsFileBudget());
  }
}

/**
 * Serialize work per key inside one process, so two concurrent calls with the
 * same `operationId` can never both reach the endpoint: the second waits, then
 * re-reads the receipt store and replays the first outcome without a request.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Run after the previous holder (success or failure), then chain the next.
    const result = previous.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      // Only the last holder clears the entry, so the map stays bounded by the
      // number of *in-flight* operation ids.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
