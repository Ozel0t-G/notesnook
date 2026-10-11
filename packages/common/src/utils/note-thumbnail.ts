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

import type { Attachment } from "@notesnook/core";

/**
 * The first raster image attached to a note, used to render the Apple
 * (iPhone/iPad/Mac Catalyst) note-list thumbnail. Only the minimum data the
 * thumbnail pipeline needs is carried around; the full attachment is fetched
 * lazily and the bytes are decrypted on demand.
 *
 * Kept in a module of its own (no `@notesnook/core` runtime imports, only the
 * type) so the attachment selection can be unit tested without pulling in the
 * database.
 */
export type NoteThumbnail = {
  id: string;
  hash: string;
  mimeType: string;
};

/**
 * Webclips and vector images are not raster images: they cannot be handed to
 * the image resizer, and a webclip is not an image at all (it is a saved web
 * page rendered as text).
 */
const NON_RASTER_IMAGE_MIME_TYPES = new Set([
  "image/svg+xml",
  "application/vnd.notesnook.web-clip"
]);
const SAFE_ATTACHMENT_HASH = /^[a-zA-Z0-9_-]{1,128}$/;

/** A hash is also a cache filename, so it must contain no path separators. */
export function isSafeAttachmentHash(hash: string): boolean {
  return SAFE_ATTACHMENT_HASH.test(hash);
}

/**
 * Whether a mime type can be decoded into a raster thumbnail. Mirrors the
 * mobile pipeline's check so both sides agree on what is renderable.
 */
export function isRasterImageMimeType(mimeType?: string): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized.startsWith("image/")) return false;
  return !NON_RASTER_IMAGE_MIME_TYPES.has(normalized);
}

/**
 * Whether an attachment can be rendered as a raster image thumbnail. Failed
 * attachments are excluded because they have no (re)downloadable ciphertext.
 */
export function isRasterImageAttachment(
  attachment?: Attachment
): attachment is Attachment {
  return (
    !!attachment &&
    !attachment.failed &&
    isSafeAttachmentHash(attachment.hash) &&
    isRasterImageMimeType(attachment.mimeType)
  );
}

/**
 * Picks the first raster image from an ordered list of resolved attachments.
 * Used on the already bulk-resolved attachment relation so the note list does
 * not issue an extra query per row.
 */
export function getFirstRasterImageThumbnail(
  attachments: (Attachment | undefined)[]
): NoteThumbnail | undefined {
  for (const attachment of attachments) {
    if (!isRasterImageAttachment(attachment)) continue;
    return {
      id: attachment.id,
      hash: attachment.hash,
      mimeType: attachment.mimeType
    };
  }
  return undefined;
}
