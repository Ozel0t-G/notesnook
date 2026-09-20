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
 * Pure helpers for Apple Pencil handwriting. A drawing is stored as a pair of
 * attachments that share one UUID:
 *
 *   handwriting-<UUID>.png        image/png                (inline image)
 *   handwriting-<UUID>.pkdrawing  application/octet-stream (hidden source)
 *   handwriting-<UUID>.json       application/json         (hidden metadata)
 *
 * Both hidden files are bound to the PNG by relations (see metadata.ts).
 *
 * Do not import React Native here so this stays unit-testable.
 */

export const HANDWRITING_PREFIX = "handwriting-";
export const HANDWRITING_PNG_EXT = "png";
export const HANDWRITING_DRAWING_EXT = "pkdrawing";
export const HANDWRITING_PNG_MIME = "image/png";
export const HANDWRITING_DRAWING_MIME = "application/octet-stream";
export const HANDWRITING_METADATA_EXT = "json";
export const HANDWRITING_METADATA_MIME = "application/json";

export type HandwritingKind = "png" | "drawing" | "metadata";

const EXTENSIONS: Record<HandwritingKind, string> = {
  png: HANDWRITING_PNG_EXT,
  drawing: HANDWRITING_DRAWING_EXT,
  metadata: HANDWRITING_METADATA_EXT
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FILENAME_REGEX = new RegExp(
  `^${HANDWRITING_PREFIX}(${UUID})\\.(${HANDWRITING_PNG_EXT}|${HANDWRITING_DRAWING_EXT}|${HANDWRITING_METADATA_EXT})$`,
  "i"
);

export function isValidHandwritingId(id: unknown): id is string {
  return typeof id === "string" && new RegExp(`^${UUID}$`, "i").test(id);
}

export function getHandwritingFilename(id: string, kind: HandwritingKind) {
  if (!isValidHandwritingId(id))
    throw new Error(`Invalid handwriting id: ${id}`);
  return `${HANDWRITING_PREFIX}${id.toLowerCase()}.${EXTENSIONS[kind]}`;
}

export function parseHandwritingFilename(
  filename: string | undefined | null
): { id: string; kind: HandwritingKind } | undefined {
  if (!filename) return;
  const match = FILENAME_REGEX.exec(filename);
  if (!match) return;
  const ext = match[2].toLowerCase();
  const kind = (Object.keys(EXTENSIONS) as HandwritingKind[]).find(
    (k) => EXTENSIONS[k] === ext
  ) as HandwritingKind;
  return { id: match[1].toLowerCase(), kind };
}

/** True if an image node's filename identifies a handwriting PNG. */
export function isHandwritingImage(
  filename: string | undefined | null
): boolean {
  return parseHandwritingFilename(filename)?.kind === "png";
}

/** Handwriting is only offered on iPad. iPhone and Android are untouched. */
export function isHandwritingSupported(platform: {
  OS: string;
  isPad?: boolean;
}): boolean {
  return platform.OS === "ios" && platform.isPad === true;
}

export type AttachmentLike = {
  id: string;
  hash: string;
  filename: string;
  dateCreated?: number;
};

const newestFirst = <T extends AttachmentLike>(a: T, b: T) =>
  (b.dateCreated || 0) - (a.dateCreated || 0);

function findSibling<T extends AttachmentLike>(
  pngFilename: string,
  kind: "drawing" | "metadata",
  related: T[],
  sameFilename: T[]
): T | undefined {
  const parsed = parseHandwritingFilename(pngFilename);
  if (!parsed || parsed.kind !== "png") return;
  const expected = getHandwritingFilename(parsed.id, kind);
  const matches = (list: T[]) =>
    list.filter((a) => a.filename.toLowerCase() === expected).sort(newestFirst);

  return matches(related)[0] || matches(sameFilename)[0];
}

/**
 * Picks the PKDrawing that belongs to a handwriting PNG.
 *
 * 1. `related`: attachments reached through the hidden PNG -> PKDrawing
 *    relation. Preferred, because it is bound to exactly this PNG revision.
 * 2. `sameFilename`: attachments found by the `handwriting-<UUID>.pkdrawing`
 *    filename (newest first). Fallback when the relation is missing (e.g. not
 *    synced yet).
 *
 * Returns undefined when there is no source; callers must then keep showing
 * the PNG and disable editing instead of failing.
 */
export function findDrawingSource<T extends AttachmentLike>(
  pngFilename: string,
  related: T[],
  sameFilename: T[]
): T | undefined {
  return findSibling(pngFilename, "drawing", related, sameFilename);
}

/**
 * Same as `findDrawingSource` for `handwriting-<UUID>.json`. Drawings from
 * before metadata existed have none; callers then use the legacy defaults.
 */
export function findMetadataSource<T extends AttachmentLike>(
  pngFilename: string,
  related: T[],
  sameFilename: T[]
): T | undefined {
  return findSibling(pngFilename, "metadata", related, sameFilename);
}
