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

// Task IDs are either Notesnook object IDs or deterministic MD5 IDs from
// migration and recurring occurrences. Widget URLs are untrusted input.
export function isValidTaskWidgetId(value: unknown): value is string {
  return (
    typeof value === "string" && /^(?:[0-9a-f]{24}|[0-9a-f]{32})$/i.test(value)
  );
}

export function canReplayTaskWidgetCompletion(state: {
  databaseReady: boolean;
  appLoading: boolean;
  appLocked: boolean;
  loggingOut: boolean;
}): boolean {
  return (
    state.databaseReady &&
    !state.appLoading &&
    !state.appLocked &&
    !state.loggingOut
  );
}

const STORAGE_KEY = "taskWidgetPendingCompletions:v1";
const MAX_PENDING = 50;
const MAX_INTENT_AGE_MS = 24 * 60 * 60 * 1000;

export interface TaskCompletionIntentStorage {
  getString(key: string): string | null | undefined;
  setString(key: string, value: string): void;
  removeItem(key: string): void;
}

type PendingEntry = {
  id: string;
  accountId: string | null;
  enqueuedAt: number;
};

function isPendingEntry(value: unknown): value is PendingEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    isValidTaskWidgetId(entry.id) &&
    typeof entry.enqueuedAt === "number" &&
    Number.isSafeInteger(entry.enqueuedAt) &&
    entry.enqueuedAt > 0 &&
    (entry.accountId === null ||
      (typeof entry.accountId === "string" &&
        entry.accountId.length > 0 &&
        entry.accountId.length <= 256))
  );
}

export class PendingTaskCompletions {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly recentlyTaken = new Map<string, number>();

  constructor(private readonly storage?: TaskCompletionIntentStorage) {
    if (!storage) return;
    try {
      const raw = storage.getString(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length > MAX_PENDING) {
        storage.removeItem(STORAGE_KEY);
        return;
      }
      let clockAdjusted = false;
      for (const item of parsed) {
        if (!isPendingEntry(item)) {
          this.pending.clear();
          storage.removeItem(STORAGE_KEY);
          return;
        }
        const normalized = {
          ...item,
          enqueuedAt: Math.min(item.enqueuedAt, Date.now())
        };
        if (normalized.enqueuedAt !== item.enqueuedAt) clockAdjusted = true;
        if (Date.now() - normalized.enqueuedAt <= MAX_INTENT_AGE_MS)
          this.pending.set(item.id, normalized);
      }
      if (this.pending.size !== parsed.length || clockAdjusted)
        this.persist(this.pending);
    } catch {
      // A damaged local queue is not trusted as an instruction to mutate data.
      this.pending.clear();
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        // The intent remains unusable in memory until storage recovers.
      }
    }
  }

  private persist(next: Map<string, PendingEntry>): boolean {
    if (!this.storage) return true;
    try {
      if (next.size === 0) this.storage.removeItem(STORAGE_KEY);
      else {
        const entries = [...next.values()];
        this.storage.setString(STORAGE_KEY, JSON.stringify(entries));
      }
      return true;
    } catch {
      return false;
    }
  }

  enqueue(id: string, accountId: string | null, now = Date.now()): boolean {
    if (!isValidTaskWidgetId(id)) return false;
    if (this.pending.size >= MAX_PENDING && !this.pending.has(id)) return false;
    const previous = this.recentlyTaken.get(id);
    if (previous !== undefined && now - previous < 5000) return false;
    const next = new Map(this.pending);
    if ([...next.values()].some((value) => value.accountId !== accountId))
      next.clear();
    next.set(id, {
      id,
      accountId,
      enqueuedAt: next.get(id)?.enqueuedAt ?? now
    });
    if (!this.persist(next)) return false;
    this.pending.clear();
    for (const [key, entry] of next) this.pending.set(key, entry);
    return true;
  }

  peekNext(accountId: string | null, now = Date.now()): string | undefined {
    const expired = [...this.pending].filter(
      ([, entry]) =>
        now - entry.enqueuedAt > MAX_INTENT_AGE_MS
    );
    if (expired.length) {
      for (const [id] of expired) this.pending.delete(id);
      this.persist(this.pending);
    }
    const next = this.pending.entries().next().value;
    if (!next) return;
    const [id, entry] = next;
    if (entry.accountId !== accountId) {
      this.clear();
      return;
    }
    return id;
  }

  belongsToAccount(accountId: string | null): boolean {
    return [...this.pending.values()].every(
      (entry) => entry.accountId === accountId
    );
  }

  acknowledge(id: string, now = Date.now()): boolean {
    if (!this.pending.has(id)) return false;
    const next = new Map(this.pending);
    next.delete(id);
    if (!this.persist(next)) return false;
    this.pending.delete(id);
    this.recentlyTaken.set(id, now);
    for (const [oldId, time] of this.recentlyTaken) {
      if (now - time >= 5000) this.recentlyTaken.delete(oldId);
    }
    return true;
  }

  clear(): boolean {
    if (!this.persist(new Map())) return false;
    this.pending.clear();
    this.recentlyTaken.clear();
    return true;
  }
}
