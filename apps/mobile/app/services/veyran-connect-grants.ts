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
 * The device-local VeyraN Connect grant record: capability shape and the
 * *canonical* storage codec.
 *
 * This module is deliberately pure: it imports **nothing** — no React Native,
 * no database, no Core. Production (`veyran-connect.ts`) and the headless Core
 * persistence test therefore share the exact same parse/serialize/build path,
 * so the shape proven against a real encrypted SQLite reopen is the shape the
 * app writes.
 *
 * Storage contract:
 *  - the record is one encrypted `SettingItem` row, `localOnly: true`, whose
 *    `value` is a **JSON string** (never an object). The `settingitem`
 *    DataMapper only `JSON.parse`s a fixed set of known key prefixes, so a
 *    non-listed key would otherwise hold an object in a warm cache while a
 *    reopened SQLite row holds a string;
 *  - `parseLocalRecordValue` accepts the canonical string (and an already
 *    parsed object, for a warm in-memory cache) and rejects everything else —
 *    including a foreign account-, version- or size-mismatched value.
 */

// ------------------------------------------------------------ capability model

export type ConnectCapabilities = {
  canRead: boolean;
  canCreate: boolean;
  canChange: boolean;
  canTask: boolean;
  notebookIds: string[];
  listIds: string[];
  noteIds: string[];
  defaultNotebookId?: string;
};

export const EMPTY_CAPABILITIES: ConnectCapabilities = Object.freeze({
  canRead: false,
  canCreate: false,
  canChange: false,
  canTask: false,
  notebookIds: [],
  listIds: [],
  noteIds: [],
  defaultNotebookId: undefined
}) as ConnectCapabilities;

/**
 * A *fresh* empty capability set with independent arrays.
 *
 * `Object.freeze` is shallow, so spreading `EMPTY_CAPABILITIES` would share its
 * mutable id arrays: one caller pushing into the result would poison the frozen
 * template for every future trusted empty set. Every empty produced here (and
 * by `normalizeCapabilities`) therefore allocates its own arrays.
 */
export function emptyCapabilities(): ConnectCapabilities {
  return {
    canRead: false,
    canCreate: false,
    canChange: false,
    canTask: false,
    notebookIds: [],
    listIds: [],
    noteIds: [],
    defaultNotebookId: undefined
  };
}

/** Copy and bound an id list; never widens, never silently trims. */
export function sanitizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string") continue;
    if (id.length === 0 || id.length > 200) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 200) break;
  }
  return out;
}

/** Deep-copy and bound a capability set: the result never shares an array. */
export function normalizeCapabilities(value: unknown): ConnectCapabilities {
  if (!value || typeof value !== "object") return emptyCapabilities();
  const record = value as Record<string, unknown>;
  const defaultNotebookId =
    typeof record.defaultNotebookId === "string" &&
    record.defaultNotebookId.length > 0 &&
    record.defaultNotebookId.length <= 200
      ? record.defaultNotebookId
      : undefined;
  return {
    canRead: record.canRead === true,
    canCreate: record.canCreate === true,
    canChange: record.canChange === true,
    canTask: record.canTask === true,
    notebookIds: sanitizeIds(record.notebookIds),
    listIds: sanitizeIds(record.listIds),
    noteIds: sanitizeIds(record.noteIds),
    defaultNotebookId
  };
}

// ------------------------------------------------- device-local grants record

export const LOCAL_RECORD_ID = "veyran-connect:local-v1";
export const LOCAL_RECORD_KEY = "veyranConnectLocal";
/** A bounded record; anything larger is a foreign/corrupt value. */
export const LOCAL_RECORD_MAX_BYTES = 16 * 1024;

/**
 * The UTF-8 byte length of `value`, counted one code point at a time and
 * short-circuited as soon as `limit` is exceeded.
 *
 * The storage bound is expressed in *bytes*, but `String.prototype.length` is
 * UTF-16 code units: an astral character is 2 units and 4 bytes, so a
 * `length`-based check would admit values up to twice the declared bound. A
 * lone surrogate (invalid UTF-16) is counted as its 3-byte replacement
 * character so the walk is total and never throws.
 *
 * Deliberately does not use `TextEncoder`: it is not guaranteed to exist in
 * every React Native runtime, and this module stays pure and dependency-free.
 * When the true length exceeds `limit`, any value `> limit` is returned (the
 * caller only compares against the bound), so a hostile string never costs
 * more than a bounded scan.
 */
export function boundedUtf8ByteLength(
  value: string,
  limit: number = LOCAL_RECORD_MAX_BYTES
): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next =
        index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return bytes;
  }
  return bytes;
}

export type ConnectLocalRecord = {
  v: 1;
  accountId: string;
  capabilities: ConnectCapabilities;
};

function validAccountId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/**
 * Parse a stored record value: the canonical JSON string, or the object shape
 * a warm in-memory cache may still hold. Anything else — wrong version, a
 * missing `localOnly` marker, an empty/oversized account id, a non-object, a
 * non-JSON string or an oversized string — is rejected.
 */
export function parseLocalRecordValue(
  value: unknown
): ConnectLocalRecord | undefined {
  let raw: unknown = value;
  if (typeof raw === "string") {
    if (raw.length === 0 || boundedUtf8ByteLength(raw) > LOCAL_RECORD_MAX_BYTES)
      return undefined;
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (record.localOnly !== true) return undefined;
  const accountId = record.accountId;
  if (!validAccountId(accountId)) return undefined;
  const capabilities = record.capabilities;
  if (!capabilities || typeof capabilities !== "object") return undefined;
  return {
    v: 1,
    accountId,
    capabilities: normalizeCapabilities(capabilities)
  };
}

/** Serialize a validated record, or `undefined` when it is not a valid record. */
export function serializeLocalRecord(
  record: ConnectLocalRecord
): string | undefined {
  if (!record || record.v !== 1) return undefined;
  if (!validAccountId(record.accountId)) return undefined;
  const payload = {
    v: 1 as const,
    localOnly: true as const,
    accountId: record.accountId,
    capabilities: normalizeCapabilities(record.capabilities)
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return undefined;
  }
  if (boundedUtf8ByteLength(serialized) > LOCAL_RECORD_MAX_BYTES)
    return undefined;
  return serialized;
}

/**
 * The exact `settingitem` row to persist, or `undefined` when the record is not
 * valid. Kept in this module so a test writes the *production* row shape.
 */
export function buildLocalRecordItem(
  record: ConnectLocalRecord,
  existing?: { dateCreated?: number }
): Record<string, unknown> | undefined {
  const serialized = serializeLocalRecord(record);
  if (serialized === undefined) return undefined;
  return {
    id: LOCAL_RECORD_ID,
    key: LOCAL_RECORD_KEY,
    value: serialized,
    type: "settingitem",
    localOnly: true,
    dateCreated: existing?.dateCreated ?? Date.now(),
    dateModified: Date.now()
  };
}

/**
 * Read the record through a `settings.collection`-shaped accessor (the real
 * encrypted Core collection, or a test double with the same `get`). A missing
 * row, a foreign shape or any thrown accessor yields `undefined` — never a
 * default grant.
 */
export function readLocalRecordFrom(collection: {
  get(id: string): unknown;
}): ConnectLocalRecord | undefined {
  try {
    const item = collection.get(LOCAL_RECORD_ID) as
      | { value?: unknown }
      | undefined;
    if (!item) return undefined;
    return parseLocalRecordValue(item.value);
  } catch {
    return undefined;
  }
}
