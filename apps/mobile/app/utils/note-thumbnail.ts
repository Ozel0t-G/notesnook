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
 * Pure helpers for the Apple (iPhone/iPad/Mac Catalyst) note-list image
 * thumbnail. Kept free of React Native / native imports so the decisions that
 * matter for correctness and security (what is a raster image, where plaintext
 * thumbnails live, when a vault note must stay hidden, how far an image is
 * downscaled) can be unit tested in isolation.
 *
 * The *filesystem* side of the pipeline lives in `use-note-thumbnail.ts`; this
 * module only describes paths and policy.
 */

/** The on-screen size of the note-list thumbnail, in points. */
export const NOTE_THUMBNAIL_SIZE = 52;

/**
 * Maximum edge of the resized thumbnail. Plaintext thumbnails are small by
 * design: they are stored on disk, so keeping them close to the rendered size
 * limits how much decrypted data can ever be exposed.
 */
export const NOTE_THUMBNAIL_PIXEL_SIZE = NOTE_THUMBNAIL_SIZE * 3;

/**
 * Plaintext thumbnails live in their own directory inside the file cache so a
 * vault lock can delete *only* them. The encrypted attachment ciphertext (which
 * also lives in the cache, keyed by hash) must never be removed here.
 */
export const NOTE_THUMBNAIL_CACHE_DIR_NAME = "note-thumbnails";
// PNG preserves the transparent background of diagrams and other graphics.
export const NOTE_THUMBNAIL_FILE_EXTENSION = "png";

const NON_RASTER_IMAGE_MIME_TYPES = new Set([
  "image/svg+xml",
  "application/vnd.notesnook.web-clip"
]);

/** Whether a mime type can be decoded/extracted into a raster thumbnail. */
export function isRasterImageMimeType(mimeType?: string): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized.startsWith("image/")) return false;
  return !NON_RASTER_IMAGE_MIME_TYPES.has(normalized);
}

/** Directory holding plaintext note thumbnails for the given cache root. */
export function getThumbnailCacheDir(baseCacheDir: string): string {
  return `${baseCacheDir}/${NOTE_THUMBNAIL_CACHE_DIR_NAME}`;
}

/** Stable plaintext thumbnail path for an attachment hash. */
export function getThumbnailCachePath(
  baseCacheDir: string,
  hash: string
): string {
  return `${getThumbnailCacheDir(
    baseCacheDir
  )}/${hash}.${NOTE_THUMBNAIL_FILE_EXTENSION}`;
}

export type ThumbnailResizeTarget = { width: number; height: number };

/**
 * Target dimensions for the resized thumbnail. Images larger than the target
 * are scaled down (aspect ratio preserved); smaller images are left untouched
 * (`onlyScaleDown`), so we never upscale and re-encode a tiny source.
 */
export function getThumbnailResizeTarget(
  width?: number,
  height?: number,
  max = NOTE_THUMBNAIL_PIXEL_SIZE
): ThumbnailResizeTarget {
  if (!width || !height || width <= 0 || height <= 0) {
    return { width: max, height: max };
  }
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * Whether a note thumbnail must be hidden and must not be decrypted.
 *
 * `locked` is the *resolved* vault membership of the note: it is true even when
 * the vault is currently unlocked, so it alone must not hide the image. The
 * image is only blocked while the note is in the vault *and* the vault is
 * locked. Callers must re-evaluate this after every async step (download,
 * decrypt, resize) with a freshly read `db.vault.unlocked` so a lock that races
 * the pipeline cannot leave a decrypted image on screen.
 */
export function isThumbnailVaultBlocked(
  locked: boolean | undefined,
  vaultUnlocked: boolean
): boolean {
  return !!locked && !vaultUnlocked;
}

/** `file://` URI for an absolute filesystem path, for use as an Image source. */
export function getThumbnailFileUri(path: string): string {
  return path.startsWith("file://") ? path : `file://${path}`;
}
