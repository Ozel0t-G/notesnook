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

import { CONTENT_LIMITS } from "./limits.js";
import { ConnectError } from "./errors.js";

export type ConnectGrantsInput = {
  accountId: string;
  canCreate?: boolean;
  canRead?: boolean;
  canChange?: boolean;
  canTask?: boolean;
  notebookIDs?: readonly string[];
  noteIDs?: readonly string[];
  listIDs?: readonly string[];
};

/**
 * Immutable, deduplicated snapshot of the authorization grants.
 *
 * The snapshot copies every id collection so a later external mutation of the
 * caller's array (or a shared object) cannot widen the granted rights. Ids
 * present in a request never confer rights on their own; only this snapshot
 * decides authorization.
 */
export class GrantSnapshot {
  readonly accountId: string;
  readonly canCreate: boolean;
  readonly canRead: boolean;
  readonly canChange: boolean;
  readonly canTask: boolean;
  private readonly notebookIDs: ReadonlySet<string>;
  private readonly noteIDs: ReadonlySet<string>;
  private readonly listIDs: ReadonlySet<string>;

  constructor(input: ConnectGrantsInput) {
    if (typeof input.accountId !== "string" || !input.accountId)
      throw new ConnectError("DENIED");
    this.accountId = input.accountId;
    this.canCreate = input.canCreate === true;
    this.canRead = input.canRead === true;
    this.canChange = input.canChange === true;
    this.canTask = input.canTask === true;
    this.notebookIDs = freezeIds(input.notebookIDs);
    this.noteIDs = freezeIds(input.noteIDs);
    this.listIDs = freezeIds(input.listIDs);
  }

  hasNotebook(id: string): boolean {
    return this.notebookIDs.has(id);
  }

  hasNote(id: string): boolean {
    return this.noteIDs.has(id);
  }

  hasList(id: string): boolean {
    return this.listIDs.has(id);
  }

  /** Grant ids only; never used to authorize directly. */
  get grantedListIDCount(): number {
    return this.listIDs.size;
  }

  grantedListIDs(): string[] {
    return [...this.listIDs];
  }

  grantedNotebookIDs(): string[] {
    return [...this.notebookIDs];
  }

  grantedNoteIDs(): string[] {
    return [...this.noteIDs];
  }
}

/**
 * Copy, validate and bound a grant id list. Oversized input fails closed: a
 * grant set is never silently trimmed (silently dropping ids narrows rights,
 * silently keeping them widens the accepted work), and unbounded lists are
 * rejected so a caller cannot feed the adapter an unbounded amount of state.
 */
function freezeIds(ids: readonly string[] | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (ids === undefined) return set;
  if (!Array.isArray(ids) || ids.length > CONTENT_LIMITS.maxGrantIds)
    throw new ConnectError("INVALID_INPUT");
  for (const id of ids) {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > CONTENT_LIMITS.maxIdChars
    )
      throw new ConnectError("INVALID_INPUT");
    // Duplicates are collapsed: the effective grant set is unchanged.
    set.add(id);
  }
  return set;
}
