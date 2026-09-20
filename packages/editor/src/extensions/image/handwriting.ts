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
