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

import { Note } from "../types.js";
import { Task } from "../collections/tasks.js";
import { hashId } from "./hash.js";

/**
 * Content + metadata fingerprint for a note.
 *
 * A bare `dateEdited` would miss two manual edits within the same millisecond,
 * so the content hash is part of the revision. The hash is SHA-256 (see
 * `hash.ts`) because MD5-level collisions would let a stale holder of an
 * expected revision be accepted as current.
 */
export function noteRevision(
  note: Pick<
    Note,
    | "id"
    | "title"
    | "headline"
    | "contentId"
    | "dateEdited"
    | "dateCreated"
    | "dateModified"
    | "readonly"
    | "pinned"
    | "favorite"
    | "archived"
    | "conflicted"
    | "localOnly"
  >,
  content?: {
    type: string;
    dateEdited?: number | null;
    locked?: boolean;
    // Accepts the stored row type too (which may hold an encrypted payload);
    // only string payloads take part in the fingerprint.
    data?: unknown;
  }
): string {
  const contentFingerprint = content
    ? content.locked
      ? ["locked"]
      : [
          content.type,
          content.dateEdited,
          typeof content.data === "string" ? hashId(content.data) : null
        ]
    : null;
  return `note:${hashId(
    JSON.stringify([
      note.id,
      note.title,
      note.headline ?? null,
      note.contentId ?? null,
      note.dateEdited ?? null,
      note.dateCreated ?? null,
      note.dateModified ?? null,
      note.readonly ? 1 : 0,
      note.pinned ? 1 : 0,
      note.favorite ? 1 : 0,
      note.archived ? 1 : 0,
      note.conflicted ? 1 : 0,
      note.localOnly ? 1 : 0,
      contentFingerprint
    ])
  )}`;
}

/** Canonical (unambiguous) content hash: SHA-256 over a JSON tuple. */
export function noteContentHash(type: string, data: string): string {
  return hashId(canonicalize([type, data]));
}

export function taskRevision(task: Task): string {
  return `task:${hashId(
    JSON.stringify([
      task.id,
      task.title,
      task.description ?? null,
      task.listId,
      task.completed ? 1 : 0,
      task.completedAt ?? null,
      task.completedWallDate ?? null,
      task.completedWallTime ?? null,
      task.dueDate ?? null,
      task.dueTime ?? null,
      task.reminderAt ?? null,
      task.reminderDate ?? null,
      task.reminderTime ?? null,
      task.urgent ? 1 : 0,
      task.scheduleVersion ?? null,
      task.recurrenceRule ?? null,
      task.priority,
      task.flagged ? 1 : 0,
      task.createdAt,
      task.updatedAt,
      task.seriesId ?? null,
      task.seriesStartDate ?? null,
      task.seriesStartTime ?? null,
      task.occurrenceKey ?? null,
      // Fields a Connect patch can set *indirectly* (via calendar/list moves)
      // or that change the external visibility of the record. They are part of
      // the fingerprint so a stale `expectedRevision` cannot be accepted after
      // one of them changed.
      task.schemaVersion ?? null,
      task.reminderLeadMinutes ?? null,
      task.legacyReminderId ?? null,
      task.localOnly ? 1 : 0
    ])
  )}`;
}

/** Deterministic JSON for request fingerprints (stable key order). */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortValue(v);
    return out;
  }
  return value;
}

/** Collision-resistant request fingerprint (SHA-256, stable key order). */
export function fingerprintOf(value: unknown): string {
  return hashId(canonicalize(value));
}
