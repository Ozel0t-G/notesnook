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

import Database from "../api/index.js";
import { makeId } from "../utils/id.js";
import { SettingItem } from "../types.js";
import { ConnectError } from "./errors.js";

export const RECEIPT_PREFIX = "veyranConnect:v1:receipt:";
const RECEIPT_VERSION = 1;

export type JournalState = "reserved" | "committed" | "aborted" | "uncertain";

export interface JournalRecord {
  v: typeof RECEIPT_VERSION;
  operationId: string;
  operation: string;
  accountId: string;
  fingerprint: string;
  reservedId: string;
  state: JournalState;
  createdAt: number;
  updatedAt: number;
  /** Bounded verification metadata (never note/task contents). */
  expect?: Record<string, unknown>;
  /** Bounded result metadata for replay. */
  result?: Record<string, unknown>;
}

export type BeginResult =
  | { kind: "reserved"; record: JournalRecord }
  | { kind: "replay"; record: JournalRecord }
  | { kind: "resume"; record: JournalRecord };

/**
 * Durable idempotency journal persisted as metadata-only encrypted settings
 * records (settings records are end-to-end encrypted on sync; only ids,
 * operation names, short fingerprints and bounded result metadata are stored).
 *
 * Failure policy is always fail-closed:
 *  - an unreadable/invalid/unknown-version or tombstoned receipt aborts the
 *    operation as `uncertain` (it is never silently skipped);
 *  - a full journal rejects new operations instead of evicting history.
 *
 * All public methods must be called while holding the database-scoped
 * operation mutex (see `mutex.ts`).
 */
export class IdempotencyJournal {
  constructor(
    private readonly db: Database,
    private readonly maxEntries = 1000
  ) {}

  private recordKey(operationId: string): string {
    return `${RECEIPT_PREFIX}${operationId}`;
  }

  private recordId(operationId: string): string {
    return makeId(this.recordKey(operationId));
  }

  private parse(raw: unknown): JournalRecord | undefined {
    if (typeof raw !== "string") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      record.v !== RECEIPT_VERSION ||
      typeof record.operationId !== "string" ||
      typeof record.operation !== "string" ||
      typeof record.accountId !== "string" ||
      typeof record.fingerprint !== "string" ||
      typeof record.reservedId !== "string" ||
      typeof record.state !== "string" ||
      !["reserved", "committed", "aborted", "uncertain"].includes(
        record.state as string
      ) ||
      typeof record.createdAt !== "number"
    )
      return undefined;
    return parsed as JournalRecord;
  }

  /**
   * Read a receipt through raw SQL so a soft-deleted (tombstoned) row is still
   * detected and can fail the operation closed.
   */
  private async readRaw(
    operationId: string
  ): Promise<{ record?: JournalRecord; corrupt: boolean } | undefined> {
    const row = (await this.db
      .sql()
      .selectFrom("settings")
      .select(["key", "value", "deleted"])
      .where("id", "=", this.recordId(operationId))
      .executeTakeFirst()) as
      | { key: string; value: string; deleted: number | boolean }
      | undefined;
    if (!row) return undefined;
    if (row.deleted) return { corrupt: true };
    if (row.key !== this.recordKey(operationId)) return { corrupt: true };
    const record = this.parse(row.value);
    if (!record) return { corrupt: true };
    if (record.operationId !== operationId) return { corrupt: true };
    return { record, corrupt: false };
  }

  async read(operationId: string): Promise<JournalRecord | undefined> {
    const raw = await this.readRaw(operationId);
    if (!raw) return undefined;
    if (raw.corrupt || !raw.record) throw new ConnectError("JOURNAL_CORRUPT");
    return raw.record;
  }

  count(): number {
    let total = 0;
    for (const item of this.db.settings.collection.items()) {
      if (item.key?.startsWith(RECEIPT_PREFIX)) total++;
    }
    return total;
  }

  /**
   * Bounded capacity of the journal. Exposing it (with {@link count}) lets the
   * status operation report non-sensitive journal pressure without reading any
   * note/task content.
   */
  get capacity(): number {
    return this.maxEntries;
  }

  private async write(record: JournalRecord): Promise<void> {
    record.updatedAt = Date.now();
    await this.db.settings.collection.upsert({
      id: this.recordId(record.operationId),
      type: "settingitem",
      key: this.recordKey(record.operationId),
      value: JSON.stringify(record),
      dateCreated: record.createdAt
    } as unknown as SettingItem);
  }

  /**
   * Reserve or resolve the durable receipt for `operationId`. Must be awaited
   * while holding the database-scoped operation mutex: the reservation is
   * persisted (awaited) before the caller may attempt any mutation.
   */
  async begin(input: {
    operationId: string;
    operation: string;
    accountId: string;
    fingerprint: string;
    /**
     * Called only when a brand new reservation must be persisted, so a replay
     * never has to read private note/task state just to allocate an id.
     */
    createReservation: () => Promise<{
      reservedId: string;
      expect?: Record<string, unknown>;
    }>;
  }): Promise<BeginResult> {
    const raw = await this.readRaw(input.operationId);
    if (raw?.corrupt) throw new ConnectError("JOURNAL_CORRUPT");

    if (raw?.record) {
      const existing = raw.record;
      if (
        existing.operation !== input.operation ||
        existing.accountId !== input.accountId ||
        existing.fingerprint !== input.fingerprint
      )
        throw new ConnectError("IDEMPOTENCY_CONFLICT");
      if (existing.state === "committed" || existing.state === "aborted")
        return { kind: "replay", record: existing };
      // "reserved" and "uncertain" records are both recoverable: the caller
      // must verify the recorded target (fail closed) before doing anything
      // with them. Verification may resolve either to `applied` (commit),
      // `not_applied` (reopen + perform) or `ambiguous` (stay uncertain).
      return { kind: "resume", record: existing };
    }

    if (this.count() >= this.maxEntries)
      throw new ConnectError("JOURNAL_FULL");

    const { reservedId, expect } = await input.createReservation();
    const now = Date.now();
    const record: JournalRecord = {
      v: RECEIPT_VERSION,
      operationId: input.operationId,
      operation: input.operation,
      accountId: input.accountId,
      fingerprint: input.fingerprint,
      reservedId,
      state: "reserved",
      createdAt: now,
      updatedAt: now,
      expect
    };
    await this.write(record);
    return { kind: "reserved", record };
  }

  async commit(
    operationId: string,
    result: Record<string, unknown>
  ): Promise<void> {
    const record = await this.read(operationId);
    if (!record) throw new ConnectError("JOURNAL_CORRUPT");
    record.state = "committed";
    record.result = result;
    await this.write(record);
  }

  /** Deterministically reject this operationId on every later replay. */
  async abort(operationId: string, errorCode: string): Promise<void> {
    const record = await this.read(operationId);
    if (!record) throw new ConnectError("JOURNAL_CORRUPT");
    record.state = "aborted";
    record.result = { error: errorCode };
    await this.write(record);
  }

  async markUncertain(operationId: string): Promise<void> {
    const record = await this.read(operationId);
    if (!record) return;
    record.state = "uncertain";
    await this.write(record);
  }

  /**
   * Return an `uncertain` receipt to `reserved`.
   *
   * Only allowed after verification *proved* that the mutation did not land
   * (`not_applied`): the operation may then be attempted again with the same
   * reservation. Never call this to "retry" a receipt that may have persisted.
   */
  async reopen(operationId: string): Promise<void> {
    const record = await this.read(operationId);
    if (!record) throw new ConnectError("JOURNAL_CORRUPT");
    if (record.state !== "uncertain") return;
    record.state = "reserved";
    record.result = undefined;
    await this.write(record);
  }
}
