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
  NOTE_THUMBNAIL_CACHE_DIR_NAME,
  NOTE_THUMBNAIL_FILE_EXTENSION,
  NOTE_THUMBNAIL_PIXEL_SIZE,
  NOTE_THUMBNAIL_SIZE,
  getThumbnailCacheDir,
  getThumbnailCachePath,
  getThumbnailFileUri,
  getThumbnailResizeTarget,
  isRasterImageMimeType,
  isThumbnailVaultBlocked
} from "./note-thumbnail";

describe("note thumbnail policy", () => {
  test("is 52 pt on screen", () => {
    expect(NOTE_THUMBNAIL_SIZE).toBe(52);
  });

  test("only raster image mime types are thumbnailable", () => {
    expect(isRasterImageMimeType("image/png")).toBe(true);
    expect(isRasterImageMimeType("image/jpeg")).toBe(true);
    expect(isRasterImageMimeType("IMAGE/WEBP")).toBe(true);
    expect(isRasterImageMimeType(" image/gif ")).toBe(true);

    expect(isRasterImageMimeType("image/svg+xml")).toBe(false);
    expect(isRasterImageMimeType("application/vnd.notesnook.web-clip")).toBe(
      false
    );
    expect(isRasterImageMimeType("application/pdf")).toBe(false);
    expect(isRasterImageMimeType("text/plain")).toBe(false);
    expect(isRasterImageMimeType("")).toBe(false);
    expect(isRasterImageMimeType(undefined)).toBe(false);
  });

  test("plaintext thumbnails live in their own cache directory", () => {
    expect(getThumbnailCacheDir("/cache")).toBe(
      `/cache/${NOTE_THUMBNAIL_CACHE_DIR_NAME}`
    );
    expect(getThumbnailCachePath("/cache", "abc123")).toBe(
      `/cache/${NOTE_THUMBNAIL_CACHE_DIR_NAME}/abc123.${NOTE_THUMBNAIL_FILE_EXTENSION}`
    );
    // The directory is a sibling of the encrypted ciphertext, not the root, so
    // a purge can delete only thumbnails.
    expect(getThumbnailCachePath("/cache", "abc123")).not.toBe("/cache/abc123");
  });

  test("downscales to the small thumbnail size without upscaling", () => {
    const landscape = getThumbnailResizeTarget(4000, 3000);
    expect(Math.max(landscape.width, landscape.height)).toBe(
      NOTE_THUMBNAIL_PIXEL_SIZE
    );
    expect(landscape.width / landscape.height).toBeCloseTo(4 / 3, 2);

    const portrait = getThumbnailResizeTarget(3000, 4000);
    expect(Math.max(portrait.width, portrait.height)).toBe(
      NOTE_THUMBNAIL_PIXEL_SIZE
    );
    expect(portrait.height).toBeGreaterThan(portrait.width);

    // A source smaller than the target is left as-is (onlyScaleDown).
    expect(getThumbnailResizeTarget(80, 40)).toEqual({ width: 80, height: 40 });

    // Unknown dimensions fall back to a square target.
    expect(getThumbnailResizeTarget(0, 0)).toEqual({
      width: NOTE_THUMBNAIL_PIXEL_SIZE,
      height: NOTE_THUMBNAIL_PIXEL_SIZE
    });
    expect(getThumbnailResizeTarget(undefined, undefined)).toEqual({
      width: NOTE_THUMBNAIL_PIXEL_SIZE,
      height: NOTE_THUMBNAIL_PIXEL_SIZE
    });
  });

  test("never produces a zero-sized target", () => {
    const target = getThumbnailResizeTarget(10000, 1);
    expect(target.width).toBeGreaterThanOrEqual(1);
    expect(target.height).toBeGreaterThanOrEqual(1);
  });

  test("a vault note is blocked only while the vault is locked", () => {
    // In the vault, vault locked: hidden.
    expect(isThumbnailVaultBlocked(true, false)).toBe(true);
    // In the vault, vault unlocked: allowed.
    expect(isThumbnailVaultBlocked(true, true)).toBe(false);
    // Not in the vault: always allowed.
    expect(isThumbnailVaultBlocked(false, false)).toBe(false);
    expect(isThumbnailVaultBlocked(false, true)).toBe(false);
    expect(isThumbnailVaultBlocked(undefined, false)).toBe(false);
  });

  test("builds a file:// uri and is idempotent", () => {
    expect(getThumbnailFileUri("/tmp/a.jpg")).toBe("file:///tmp/a.jpg");
    expect(getThumbnailFileUri("file:///tmp/a.jpg")).toBe("file:///tmp/a.jpg");
  });
});
