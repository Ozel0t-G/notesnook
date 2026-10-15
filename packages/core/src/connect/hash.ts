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

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/**
 * Collision-resistant, portable fingerprint used for Connect revisions and
 * idempotency request fingerprints.
 *
 * SparkMD5 (used by `utils/id.ts` for opaque local ids) is *not* collision
 * resistant, so it must never back optimistic concurrency or idempotency
 * decisions. SHA-256 from `@noble/hashes` is a reviewed, pure-JS dependency
 * that runs unchanged on web, React Native and Node (no Node-only modules).
 *
 * The output keeps the existing id convention of `makeId`: 32 lowercase hex
 * characters. That is a 128-bit truncation of SHA-256 — well beyond any
 * feasible collision attack — so stored revision strings stay the same shape.
 */
export const REVISION_HASH_LENGTH = 32;

export function hashId(text: string): string {
  if (typeof text !== "string")
    throw new Error("hashId expects a string input.");
  return bytesToHex(sha256(utf8ToBytes(text))).slice(0, REVISION_HASH_LENGTH);
}
