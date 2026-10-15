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

import { Mutex } from "async-mutex";

/**
 * Single shared "note domain" write lock.
 *
 * Note content is written by several independent subsystems (the ordinary
 * editor/`Notes.add` path, the vault lock/unlock path, trash transitions,
 * readonly/archive transitions and the Connect adapter). `db.transaction` is a
 * pass-through in this codebase (it does not open a real SQL transaction), so
 * the only way to make a read-modify-write of a note atomic is to serialize
 * every writer on one mutex per `Database`.
 *
 * Design constraints (see `docs/veyran-connect/CORE.md`):
 *  - the lock is keyed by the live `Database` object in a `WeakMap`, so every
 *    collection/API instance that shares a database shares one critical
 *    section. Two separate `Database` objects over the same file are *not*
 *    covered (documented limitation);
 *  - re-entrancy is explicit: a holder that needs to call another writer
 *    passes the {@link DomainWriteToken} it received, and the nested call runs
 *    inline. This avoids both self-deadlock and "pretend" re-entrant locks;
 *  - a token is a *lease for one acquisition*: it is valid only for the
 *    database it was issued for and only while that critical section is still
 *    running. A token that leaked out of a finished section, was copied, or
 *    was forged is rejected instead of silently re-entering the lock (which
 *    would let a stale caller bypass a currently held lock).
 *
 * Keep critical sections short: run all conversions/parses *before* entering if
 * they do not need to observe the stored record.
 */

const LEASE_BRAND = Symbol("veyran.domain-write.lease");

/**
 * An opaque, single-acquisition lease. The brand symbol is intentionally not
 * exported, so a valid token cannot be constructed outside this module.
 */
export interface DomainWriteToken {
  readonly [LEASE_BRAND]: true;
}

interface DomainLockEntry {
  readonly mutex: Mutex;
  /** The lease whose critical section is currently executing, if any. */
  active?: DomainWriteToken;
}

const LOCKS = new WeakMap<object, DomainLockEntry>();

function entryFor(db: object): DomainLockEntry {
  let entry = LOCKS.get(db);
  if (!entry) {
    entry = { mutex: new Mutex() };
    LOCKS.set(db, entry);
  }
  return entry;
}

function isLease(token: unknown): token is DomainWriteToken {
  return (
    typeof token === "object" &&
    token !== null &&
    (token as Record<symbol, unknown>)[LEASE_BRAND] === true
  );
}

/**
 * True when `token` is the *currently active* lease for `db`.
 *
 * Deliberately identity-based: a lease minted for another database, a copied
 * token, or a token whose critical section already exited is not a token.
 */
export function isDomainWriteToken(
  db: object,
  token?: DomainWriteToken
): boolean {
  if (!isLease(token)) return false;
  return LOCKS.get(db)?.active === token;
}

/**
 * Assert that `token` is the *live* lease of `db`.
 *
 * The `*Locked` methods that bypass {@link withDomainWrite} (because their
 * caller already holds the critical section) must call this before their first
 * read or write: a stale, copied, foreign or forged token would otherwise let a
 * caller mutate rows outside the lock — or while an unrelated writer holds it —
 * and a partially applied write would be left behind before the failure.
 */
export function assertDomainWriteLease(
  db: object,
  token: DomainWriteToken
): void {
  if (!isDomainWriteToken(db, token))
    throw new Error(
      "Mutation requires the active domain write lease for this database."
    );
}

/**
 * Run `fn` inside the shared critical section for `db`.
 *
 * Pass the `token` received by an enclosing {@link withDomainWrite} call to
 * re-enter the same critical section (the nested call runs inline and never
 * waits on the mutex). Omitting the token while it is already held deadlocks
 * the caller, so every nested writer must thread it through.
 */
export async function withDomainWrite<T>(
  db: object,
  fn: (token: DomainWriteToken) => Promise<T>,
  token?: DomainWriteToken
): Promise<T> {
  if (token !== undefined) {
    // Re-entry is only legal with the live lease of *this* database; anything
    // else (stale, copied, foreign or forged) must fail instead of running the
    // callback outside — or "reentrantly" inside — the critical section.
    if (!isDomainWriteToken(db, token))
      throw new Error(
        "Domain write token is not an active lease for this database."
      );
    return fn(token);
  }
  const entry = entryFor(db);
  return entry.mutex.runExclusive(async () => {
    const lease = Object.freeze({
      [LEASE_BRAND]: true
    }) as DomainWriteToken;
    entry.active = lease;
    try {
      return await fn(lease);
    } finally {
      // The lease is dead the moment the critical section exits, so a token
      // that escaped cannot be used again (see `isDomainWriteToken`).
      if (entry.active === lease) entry.active = undefined;
    }
  });
}
