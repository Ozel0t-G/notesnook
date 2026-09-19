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

import Sodium from "@ammarahmed/react-native-sodium";
import { strings } from "@notesnook/intl";
import { dirname } from "pathe";
import { NativeModules, Platform } from "react-native";
import RNFetchBlob from "react-native-blob-util";
import { DatabaseLogger, db } from "../../common/database";
import downloadAttachment from "../../common/filesystem/download-attachment";
import { cacheDir } from "../../common/filesystem/utils";
import { attachFile } from "../../screens/editor/tiptap/picker";
import { useTabStore } from "../../screens/editor/tiptap/use-tab-store";
import { editorController } from "../../screens/editor/tiptap/utils";
import { ToastManager } from "../event-manager";
import {
  HandwritingResult,
  StoreDeps,
  StoredHandwriting,
  storeHandwriting
} from "./store";
import {
  findDrawingSource,
  getHandwritingFilename,
  HANDWRITING_PNG_MIME,
  isHandwritingSupported,
  parseHandwritingFilename
} from "./utils";

type NativeHandwriting = {
  create(): Promise<HandwritingResult>;
  edit(sourcePath: string, drawingId: string): Promise<HandwritingResult>;
};

const Native: NativeHandwriting | undefined = NativeModules.HandwritingModule;

type Target = { noteId?: string; tabId?: string };
type EditableImage = { hash: string; filename: string };

let busy = false;

export function isSupported() {
  return isHandwritingSupported(Platform as any) && !!Native;
}

function isCancelled(e: unknown) {
  return (e as { code?: string })?.code === "E_CANCELLED";
}

function showError(message: string) {
  ToastManager.show({
    heading: strings.failToOpen(),
    message,
    type: "error",
    context: "global"
  });
}

/** Opens PencilKit on an empty canvas and inserts the result at the cursor. */
export async function createHandwriting(target: Target) {
  if (!isSupported() || busy) return;
  busy = true;
  try {
    await db.attachments.generateKey();
    let result: HandwritingResult;
    try {
      result = await Native!.create();
    } catch (e) {
      if (!isCancelled(e)) {
        DatabaseLogger.error(e as Error, "Failed to open handwriting editor");
        showError((e as Error).message);
      }
      return;
    }
    await save(result, target);
  } finally {
    busy = false;
  }
}

/** Reopens the stored PKDrawing of a handwriting image and replaces the image. */
export async function editHandwriting(target: Target, image: EditableImage) {
  if (!isSupported() || busy) return;
  const parsed = parseHandwritingFilename(image.filename);
  if (!parsed || parsed.kind !== "png") return;

  busy = true;
  let sourcePath: string | undefined;
  try {
    await db.attachments.generateKey();
    const source = await findSource(image);
    if (!source) {
      // PNG stays visible, the note is not affected.
      showError("The editable handwriting source is not available.");
      return;
    }

    try {
      const uri = await downloadAttachment(source.hash, false, {
        silent: true,
        cache: true,
        throwError: true
      });
      if (!uri) throw new Error("Could not download the handwriting source.");
      sourcePath = `${cacheDir}/${uri}`;
    } catch (e) {
      DatabaseLogger.error(e as Error, "Failed to download handwriting source");
      showError((e as Error).message);
      return;
    }

    let result: HandwritingResult;
    try {
      result = await Native!.edit(sourcePath, parsed.id);
    } catch (e) {
      if (!isCancelled(e)) {
        DatabaseLogger.error(e as Error, "Failed to edit handwriting");
        showError((e as Error).message);
      }
      return;
    } finally {
      // decrypted copy of the old source must not stay in the cache
      RNFetchBlob.fs.unlink(sourcePath).catch(() => {});
      sourcePath = undefined;
    }

    await save(result, target, image.hash);
  } finally {
    if (sourcePath) RNFetchBlob.fs.unlink(sourcePath).catch(() => {});
    busy = false;
  }
}

async function findSource(image: EditableImage) {
  const png = await db.attachments.attachment(image.hash);
  const related = png
    ? await db.relations
        .from({ id: png.id, type: "attachment" }, "attachment")
        .resolve()
    : [];
  const parsed = parseHandwritingFilename(image.filename);
  const sameFilename = parsed
    ? await db.attachments.all
        .where((eb) =>
          eb("filename", "==", getHandwritingFilename(parsed.id, "drawing"))
        )
        .items()
    : [];
  return findDrawingSource(image.filename, related, sameFilename);
}

async function save(
  result: HandwritingResult,
  target: Target,
  replaceHash?: string
) {
  try {
    await storeHandwriting(createDeps(target, result, replaceHash), result);
  } catch (e) {
    DatabaseLogger.error(e as Error, "Failed to store handwriting");
    showError((e as Error).message);
  } finally {
    // per-run temp folder created by the native module
    RNFetchBlob.fs.unlink(dirname(result.pngPath)).catch(() => {});
  }
}

function createDeps(
  target: Target,
  result: HandwritingResult,
  replaceHash?: string
): StoreDeps {
  const isNewNote = target.noteId === undefined;
  return {
    hashFile: (path) => Sodium.hashFile({ uri: path, type: "url" }),
    fileSize: async (path) => Number((await RNFetchBlob.fs.stat(path)).size),
    hasAttachment: (hash) => db.attachments.exists(hash),
    attach: (path, hash, mime, filename) =>
      attachFile(path, hash, mime, filename, {
        type: "image",
        reupload: false
      }),
    getAttachmentId: async (hash) =>
      (await db.attachments.attachment(hash))?.id,
    link: (pngId, drawingId) =>
      db.relations.add(
        { id: pngId, type: "attachment" },
        { id: drawingId, type: "attachment" }
      ),
    applyToEditor: async (stored: StoredHandwriting) => {
      const currentNoteId =
        target.tabId !== undefined
          ? useTabStore.getState().getNoteIdForTab(target.tabId)
          : undefined;
      if (
        target.tabId === undefined ||
        !editorController.current ||
        !(currentNoteId === target.noteId || isNewNote)
      )
        throw new Error("The note is no longer open. Nothing was changed.");

      const image = {
        hash: stored.pngHash,
        mime: HANDWRITING_PNG_MIME,
        type: "image" as const,
        size: stored.pngSize,
        filename: getHandwritingFilename(result.id, "png"),
        width: result.width,
        height: result.height
      };
      if (replaceHash)
        await editorController.current.commands.replaceImage(
          replaceHash,
          image,
          target.tabId
        );
      else
        await editorController.current.commands.insertImage(
          { ...image, dataurl: "" },
          target.tabId
        );
    },
    removeAttachment: async (hash) => {
      await db.attachments.remove(hash, false);
    },
    deleteFile: async (path) => {
      await RNFetchBlob.fs.unlink(path);
    }
  };
}

export default { createHandwriting, editHandwriting, isSupported };
