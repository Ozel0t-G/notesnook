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

import { useEffect, useState } from "react";
import { Editor } from "../../types.js";
import { ImageAttributes } from "./image.js";

// Mirrors the filename convention used by the mobile app for Apple Pencil
// handwriting (handwriting-<UUID>.png).
const HANDWRITING_PNG =
  /^handwriting-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;

export function isHandwritingFilename(filename: string | undefined | null) {
  return !!filename && HANDWRITING_PNG.test(filename);
}

/**
 * Cheap, synchronous part of the "can this image be edited as handwriting"
 * decision: only the host app enables it (iPad), only for handwriting PNGs and
 * never in read-only mode. The async part (is the PKDrawing source known?) is
 * resolved by `useCanEditHandwriting`.
 */
export function isHandwritingEditEligible(
  editor: Pick<Editor, "isEditable" | "storage">,
  attrs: Pick<Partial<ImageAttributes>, "filename" | "hash"> | undefined | null
) {
  return (
    !!editor.isEditable &&
    !!editor.storage.handwritingEnabled &&
    !!attrs?.hash &&
    isHandwritingFilename(attrs.filename)
  );
}

/**
 * Whether the image is a handwriting whose editable source exists. Resolved
 * asynchronously by the host app; false until it answers "yes", so a missing
 * source never shows a dead edit button.
 */
export function useCanEditHandwriting(
  editor: Editor,
  attrs: Partial<ImageAttributes> | undefined | null
) {
  const eligible = isHandwritingEditEligible(editor, attrs);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setAvailable(false);
    if (!eligible || !attrs) return;
    let cancelled = false;
    Promise.resolve(
      editor.storage.hasHandwritingSource?.(attrs as ImageAttributes)
    )
      .then((result) => !cancelled && setAvailable(!!result))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, attrs?.hash, attrs?.filename]);

  return available;
}

/**
 * New handwritings are exported with a fully transparent page background while
 * old ones are opaque PNGs (white or a user-picked colour). The two must render
 * differently, so we tell them apart by sampling the page corners: the paper
 * template starts at least one spacing away from every edge and blank pages are
 * exported with 24pt padding, so the top-left and top-right pixels can only be
 * opaque when the page itself was filled.
 *
 * Whether both sampled page corners are fully transparent. `imageData` is the
 * RGBA output of a 2x1 canvas holding the top-left pixel (0,0) in the first
 * pixel and the top-right pixel (width-1, 0) in the second, so the alpha bytes
 * live at index 3 and 7. Anything shorter/missing counts as opaque (an old
 * drawing shows as few pixels due to cropping/corruption).
 *
 * Kept synchronous and free of DOM/theme imports so it can be unit-tested.
 */
export function isTransparentCorner(
  imageData: Uint8ClampedArray | number[] | undefined | null
): boolean {
  if (!imageData || imageData.length < 8) return false;
  const topLeftAlpha = imageData[3];
  const topRightAlpha = imageData[7];
  return topLeftAlpha === 0 && topRightAlpha === 0;
}

/**
 * How a handwriting image should be presented in the editor. `frameless` is
 * only for transparent (new) handwritings: they look like typed text and must
 * not get any chrome. `invertForDark` flips black ink to white in dark mode;
 * it is never applied to opaque images so old drawings keep their colours.
 */
export function getHandwritingPresentation({
  isHandwriting,
  transparent,
  isDark
}: {
  isHandwriting: boolean;
  transparent: boolean | undefined;
  isDark: boolean;
}): { frameless: boolean; invertForDark: boolean } {
  const frameless = isHandwriting && transparent === true;
  return { frameless, invertForDark: frameless && isDark };
}

/**
 * Detection runs once per attachment hash; the answer never changes for a
 * stored PNG. Only definite results are cached, so a transient failure (image
 * not decoded yet, tainted canvas) can be retried on the next mount.
 */
const transparencyCache = new Map<string, boolean>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new globalThis.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("failed to load image"));
    image.src = src;
  });
}

/**
 * Reads the top-left and top-right pixel of `image` into a 2x1 canvas and
 * reports whether both are transparent. The blob URL used here is same-origin,
 * so the canvas is readable; a remote/tainted source throws and is treated as
 * opaque (never adds the dark-mode filter to a photo).
 */
function sampleCorners(image: HTMLImageElement): boolean {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return false;

  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return false;

  context.imageSmoothingEnabled = false;
  // Top-left pixel (0,0) -> canvas pixel 0.
  context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
  // Top-right pixel (width-1,0) -> canvas pixel 1.
  context.drawImage(image, width - 1, 0, 1, 1, 1, 0, 1, 1);

  return isTransparentCorner(context.getImageData(0, 0, 2, 1).data);
}

export async function detectTransparentHandwriting(
  src: string,
  hash?: string
): Promise<boolean> {
  if (hash) {
    const cached = transparencyCache.get(hash);
    if (cached !== undefined) return cached;
  }

  let transparent = false;
  let definite = false;
  try {
    transparent = sampleCorners(await loadImage(src));
    definite = true;
  } catch {
    // Tainted canvas / decode failure: treat as an opaque old drawing.
    transparent = false;
  }
  if (hash && definite) transparencyCache.set(hash, transparent);
  return transparent;
}

/**
 * Whether a handwriting attachment has a transparent page background.
 * Returns `undefined` while unknown (outside handwriting, or the blob URL is
 * not ready yet), so callers never treat an unresolved image as transparent.
 */
export function useIsTransparentHandwriting(
  src: string | undefined,
  hash: string | undefined,
  enabled: boolean
): boolean | undefined {
  const [transparent, setTransparent] = useState<boolean | undefined>(() =>
    enabled && hash ? transparencyCache.get(hash) : undefined
  );

  useEffect(() => {
    if (!enabled || !hash || !src) {
      setTransparent(undefined);
      return;
    }
    const cached = transparencyCache.get(hash);
    if (cached !== undefined) {
      setTransparent(cached);
      return;
    }

    let cancelled = false;
    setTransparent(undefined);
    detectTransparentHandwriting(src, hash)
      .then((result) => {
        if (!cancelled) setTransparent(result);
      })
      .catch(() => {
        if (!cancelled) setTransparent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [src, hash, enabled]);

  return transparent;
}
