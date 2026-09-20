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
  HANDWRITING_METADATA_MIME,
  HANDWRITING_PNG_MIME
} from "./utils";

/** What the native module returns. All paths are temporary and unencrypted. */
export type HandwritingResult = {
  id: string;
  pngPath: string;
  drawingPath: string;
  metadataPath: string;
  width: number;
  height: number;
};

export type StoredHandwriting = {
  pngHash: string;
  pngSize: number;
  drawingHash: string;
  metadataHash: string;
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
  /** Hidden relation PNG -> PKDrawing / PNG -> metadata. */
  link(pngAttachmentId: string, hiddenAttachmentId: string): Promise<void>;
  /** Insert (create) or replace (edit) the image node. Runs last. */
  applyToEditor(stored: StoredHandwriting): Promise<void>;
  /** Best-effort removal of an attachment created by a failed run. */
  removeAttachment(hash: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
};

/**
 * Stores a saved drawing as an attachment set (PNG + PKDrawing + metadata) and
 * swaps it into the note.
 *
 * Order matters for data safety:
 *   1. store PNG, PKDrawing and metadata attachments (old ones are untouched)
 *   2. link PNG -> PKDrawing and PNG -> metadata
 *   3. only then insert/replace the image node
 * The image node is what makes the new set visible, so the note never points
 * at a new PNG whose PKDrawing/metadata are missing or still the old ones. If
 * anything fails before step 3 the note still references the old image, the
 * old attachments are untouched, and attachments created by this run are
 * removed again (which also drops their relations). Temporary plaintext files
 * are always deleted.
 *
 * Old revisions are deliberately not deleted here: they can still be
 * referenced by the note's version history. They are collected by Notesnook's
 * normal orphan cleanup once nothing refers to the old PNG anymore.
 */
export async function storeHandwriting(
  deps: StoreDeps,
  result: HandwritingResult
): Promise<StoredHandwriting> {
  const created: string[] = [];
  const paths = [result.pngPath, result.drawingPath, result.metadataPath];

  try {
    const files = [
      [
        result.pngPath,
        HANDWRITING_PNG_MIME,
        getHandwritingFilename(result.id, "png")
      ],
      [
        result.drawingPath,
        HANDWRITING_DRAWING_MIME,
        getHandwritingFilename(result.id, "drawing")
      ],
      [
        result.metadataPath,
        HANDWRITING_METADATA_MIME,
        getHandwritingFilename(result.id, "metadata")
      ]
    ] as const;

    const hashes = await Promise.all(
      files.map(([path]) => deps.hashFile(path))
    );
    const pngSize = await deps.fileSize(result.pngPath);

    for (let i = 0; i < files.length; i++) {
      const [path, mime, name] = files[i];
      const hash = hashes[i];
      const existed = await deps.hasAttachment(hash);
      if (!(await deps.attach(path, hash, mime, name)))
        throw new Error(`Failed to store ${name}`);
      if (!existed) created.push(hash);
    }

    const [pngHash, drawingHash, metadataHash] = hashes;
    const [pngId, drawingId, metadataId] = await Promise.all(
      hashes.map((hash) => deps.getAttachmentId(hash))
    );
    if (!pngId || !drawingId || !metadataId)
      throw new Error("Stored handwriting attachments were not found");
    await deps.link(pngId, drawingId);
    await deps.link(pngId, metadataId);

    const stored = { pngHash, pngSize, drawingHash, metadataHash };
    await deps.applyToEditor(stored);
    return stored;
  } catch (e) {
    for (const hash of created)
      await deps.removeAttachment(hash).catch(() => {});
    throw e;
  } finally {
    await Promise.all(paths.map((p) => deps.deleteFile(p).catch(() => {})));
  }
}
