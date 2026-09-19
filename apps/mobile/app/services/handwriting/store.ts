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
  getHandwritingFilename,
  HANDWRITING_DRAWING_MIME,
  HANDWRITING_PNG_MIME
} from "./utils";

/** What the native module returns. All paths are temporary and unencrypted. */
export type HandwritingResult = {
  id: string;
  pngPath: string;
  drawingPath: string;
  width: number;
  height: number;
};

export type StoredHandwriting = {
  pngHash: string;
  pngSize: number;
  drawingHash: string;
};

/** Everything that touches the outside world, injected so this is testable. */
export type StoreDeps = {
  hashFile(path: string): Promise<string>;
  fileSize(path: string): Promise<number>;
  hasAttachment(hash: string): Promise<boolean>;
  /** Encrypts + registers the file through the existing attachment pipeline. */
  attach(
    path: string,
    hash: string,
    mime: string,
    filename: string
  ): Promise<boolean>;
  getAttachmentId(hash: string): Promise<string | undefined>;
  /** Hidden PNG -> PKDrawing relation. */
  link(pngAttachmentId: string, drawingAttachmentId: string): Promise<void>;
  /** Insert (create) or replace (edit) the image node. Runs last. */
  applyToEditor(stored: StoredHandwriting): Promise<void>;
  /** Best-effort removal of an attachment created by a failed run. */
  removeAttachment(hash: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
};

/**
 * Stores a saved drawing as an attachment pair and swaps it into the note.
 *
 * Order matters for data safety:
 *   1. store PNG + PKDrawing attachments (old ones are untouched)
 *   2. link PNG -> PKDrawing
 *   3. only then insert/replace the image node
 * If anything fails before step 3 the note still references the old image, the
 * old attachments are untouched, and attachments created by this run are
 * removed again. Temporary plaintext files are always deleted.
 */
export async function storeHandwriting(
  deps: StoreDeps,
  result: HandwritingResult
): Promise<StoredHandwriting> {
  const created: string[] = [];

  try {
    const pngName = getHandwritingFilename(result.id, "png");
    const drawingName = getHandwritingFilename(result.id, "drawing");
    const [pngHash, drawingHash] = await Promise.all([
      deps.hashFile(result.pngPath),
      deps.hashFile(result.drawingPath)
    ]);
    const pngSize = await deps.fileSize(result.pngPath);

    const files = [
      [result.pngPath, pngHash, HANDWRITING_PNG_MIME, pngName],
      [result.drawingPath, drawingHash, HANDWRITING_DRAWING_MIME, drawingName]
    ] as const;
    for (const [path, hash, mime, name] of files) {
      const existed = await deps.hasAttachment(hash);
      if (!(await deps.attach(path, hash, mime, name)))
        throw new Error(`Failed to store ${name}`);
      if (!existed) created.push(hash);
    }

    const [pngId, drawingId] = await Promise.all([
      deps.getAttachmentId(pngHash),
      deps.getAttachmentId(drawingHash)
    ]);
    if (!pngId || !drawingId)
      throw new Error("Stored handwriting attachments were not found");
    await deps.link(pngId, drawingId);

    const stored = { pngHash, pngSize, drawingHash };
    await deps.applyToEditor(stored);
    return stored;
  } catch (e) {
    for (const hash of created)
      await deps.removeAttachment(hash).catch(() => {});
    throw e;
  } finally {
    await Promise.all(
      [result.pngPath, result.drawingPath].map((p) =>
        deps.deleteFile(p).catch(() => {})
      )
    );
  }
}
