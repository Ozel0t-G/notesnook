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
import {
  isDecryptedContent,
  isEncryptedContent,
  Note,
  NoteContent
} from "@notesnook/core";
import { db } from "../common/database";

/**
 * Ephemeral, native-only sender fence.
 *
 * The callback is invoked with the note id this operation was *started* for and
 * must return `true` while that sender is still the active one. Any other
 * return value (`false` or `undefined`) means the fence could not confirm the
 * sender and the operation must abort without exposing any note content. A
 * thrown error is not converted into `undefined` and is not evidence that the
 * sender changed on its own: it propagates as a rejection.
 *
 * This is a routing guard only: it is never persisted, serialized or sent over
 * the wire, and it never unlocks a vault or opens the OS share sheet.
 */
export type NoteSenderGuard = (candidateNoteId: string) => boolean | undefined;

type NoteWithContent = Note & { content?: NoteContent<boolean> };

/**
 * Returns the caller's already-decrypted note content, or `undefined` when the
 * note carries no trusted plaintext content.
 *
 * This is a *structural* check only, via Core's
 * `isDecryptedContent(content) === !isCipher(content.data)`: a "decrypted"
 * verdict just means the data is not shaped like a recognized cipher
 * (`cipher`/`iv`/`salt`). It performs no decryption, proves nothing about
 * unknown/malformed cipher shapes, and is not an authorization decision. It is
 * used by the guarded (primary Share) branch, which only hands structurally
 * decrypted content (`NoteContent<false>`) to `db.notes.export` as
 * `contentItem`, trusting the caller to have supplied the real Vault plaintext.
 * The unguarded legacy branch deliberately does not call it: it trusts vault
 * membership and forwards the caller's `note.content` unchanged.
 */
function getDecryptedNoteContent(note: Note): NoteContent<false> | undefined {
  const content = (note as NoteWithContent).content;
  if (!content || typeof content !== "object") return undefined;
  return isDecryptedContent(content) ? content : undefined;
}

/**
 * The shared *eligibility* gate: a note is treated as locked for export when it
 * is a vault member (membership first) **or**, as a fallback only, when its
 * stored content row is encrypted.
 *
 * This is available for both lock checks but is not yet wired into the note
 * actions hook or the vault dialog; those still call `convertNoteToText` only.
 *
 * A supplied `guard` must be callable. A non-`undefined` but non-callable guard
 * fails closed: the call resolves `undefined` before any database lookup and
 * never degrades to the unguarded path.
 *
 * Returns:
 * - `true` — locked: a decrypted `contentItem` must be supplied to export,
 * - `false` — not locked: export reads the content itself,
 * - `undefined` — the optional `guard` reported a stale/unconfirmed sender (or
 *   was supplied as a non-callable value); callers must abort without exporting
 *   and must not treat this as an empty note.
 *
 * With no `guard` the call shape and options match the legacy membership-first
 * check, but the encrypted-content fallback above is a deliberate change, so
 * the result is not exactly legacy.
 */
export async function isNoteLockedForExport(
  note: Note,
  guard?: NoteSenderGuard
): Promise<boolean | undefined> {
  // Fail closed: a supplied but non-callable guard is a caller error and must
  // never be silently skipped, so it aborts before any database access.
  if (guard !== undefined && typeof guard !== "function") return undefined;

  if (guard !== undefined && guard(note.id) !== true) return undefined;

  const lockedByVault = await db.vaults.itemExists(note);
  if (guard !== undefined && guard(note.id) !== true) return undefined;
  if (lockedByVault) return true;

  const content = await db.content.findByNoteId(note.id);
  if (guard !== undefined && guard(note.id) !== true) return undefined;
  if (content && isEncryptedContent(content)) return true;

  return false;
}

/**
 * Converts a note to plain text for copy/share. Two branches are selected by
 * whether a `guard` is supplied; neither unlocks a vault nor opens the OS share
 * sheet.
 *
 * Unguarded (legacy callers, `guard === undefined`): preserves the exact
 * pre-existing behavior. Vault membership is checked and the export is
 * delegated to Core; for a member the caller's `note.content` is forwarded as
 * `contentItem` (Core reads the stored content row itself only when no
 * `contentItem` is supplied). There is no plaintext validation and no
 * `undefined` outcome: the result is exactly what Core returns (`""` for a
 * legitimately empty note, the exported text, or `false` when Core declines),
 * and database/export errors propagate unchanged.
 *
 * Guarded (primary Share path): the sender must still be the active one at
 * every await. A locked note is exported from the caller's trusted,
 * already-decrypted `note.content`; a locked note whose supplied content is not
 * recognized as decrypted plaintext (Core's structural `isCipher` check)
 * returns `undefined` without exporting. This is not a proof that arbitrary
 * malformed/unknown cipher shapes are impossible — the guarded branch relies on
 * the trusted caller supplying the actual Vault plaintext whenever the note is
 * locked. `undefined` also means a stale or unconfirmed sender: before export,
 * or after a completed export whose text is then discarded. It must never be
 * masked as an empty note. A thrown error from `guard` is not swallowed or
 * turned into `undefined`; it propagates as a rejection (which does not by
 * itself prove the sender changed).
 *
 * A supplied but non-callable `guard` fails closed: the call resolves
 * `undefined` before any database access and never falls back to the unguarded
 * legacy branch.
 *
 * `disableTemplate` and the legacy `{ format: "txt", disableTemplate }` export
 * options are preserved for existing callers.
 */
export async function convertNoteToText(
  note: Note,
  disableTemplate?: boolean
): Promise<string | false>;
export async function convertNoteToText(
  note: Note,
  disableTemplate: boolean | undefined,
  guard: NoteSenderGuard | undefined
): Promise<string | false | undefined>;
export async function convertNoteToText(
  note: Note,
  disableTemplate?: boolean,
  guard?: NoteSenderGuard
): Promise<string | false | undefined> {
  // Fail closed: a supplied but non-callable guard must not be mistaken for "no
  // guard" (which would fall back to the unguarded legacy branch) and must not
  // reach the database. Abort with `undefined` before any lookup.
  if (guard !== undefined && typeof guard !== "function") return undefined;

  // Legacy branch: no guard supplied. Keep the pre-change implementation
  // verbatim so existing callers that coerce `false`/`undefined` to an empty
  // string keep working unchanged.
  if (guard === undefined) {
    const lockedByVault = await db.vaults.itemExists(note);
    if (lockedByVault) {
      return await db.notes.export(note.id, {
        contentItem: (note as Note & { content: NoteContent<false> }).content,
        disableTemplate,
        format: "txt"
      });
    }

    return await db.notes.export(note.id, {
      disableTemplate,
      format: "txt"
    });
  }

  // Guarded branch: strict, guard-fenced export.
  const locked = await isNoteLockedForExport(note, guard);
  if (locked === undefined) return undefined;

  if (locked) {
    const contentItem = getDecryptedNoteContent(note);
    if (!contentItem) return undefined;

    if (guard(note.id) !== true) return undefined;
    const result = await db.notes.export(note.id, {
      contentItem,
      disableTemplate,
      format: "txt"
    });
    if (guard(note.id) !== true) return undefined;
    return result;
  }

  if (guard(note.id) !== true) return undefined;
  const result = await db.notes.export(note.id, {
    disableTemplate,
    format: "txt"
  });
  if (guard(note.id) !== true) return undefined;
  return result;
}
