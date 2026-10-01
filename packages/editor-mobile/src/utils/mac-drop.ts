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

import { EditorEvents } from "./editor-events";

/**
 * Finder drag & drop of files into the Mac editor (WP08 E7).
 *
 * WKWebView has no default drop handling, so a dropped file would otherwise
 * navigate the WebView to the file. The handlers here sit on `document` (the
 * whole WebView is the editor pane on Mac) and hand the files over to React
 * Native, which runs the same attachment flow as the file/image picker.
 *
 * Only installed on Mac Catalyst; iPhone/iPad/Android never call into this
 * file.
 */

/**
 * Files bigger than this are not read in the WebView: base64 is ~4/3 of the
 * file and travels out as a single JSON string. Their name and size are still
 * sent so the native side can show the "file too big" toast.
 */
export const MAX_DROP_FILE_SIZE = 50 * 1024 * 1024;

/** One dropped file, handed to React Native as base64. */
export type DroppedFile = {
  name: string;
  type: string;
  size: number;
  /** base64 payload without the `data:` prefix; absent when the file was skipped. */
  data?: string;
};

export type DropContext = {
  tabId?: string;
  noteId?: string;
};

let installed = false;
let getContext: (() => DropContext) | undefined;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = `${reader.result}`;
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () =>
      reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function readFile(file: File): Promise<DroppedFile> {
  const type = file.type || "application/octet-stream";
  const dropped: DroppedFile = { name: file.name, type, size: file.size };
  // Native shows the toast, the WebView never buffers a file this big.
  if (file.size > MAX_DROP_FILE_SIZE) return dropped;
  try {
    dropped.data = await readAsBase64(file);
  } catch (e) {
    logger("error", "drop", e);
  }
  return dropped;
}

function onDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  // Without preventDefault WKWebView treats the drop as a navigation.
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}

async function onDrop(event: DragEvent) {
  const transfer = event.dataTransfer;
  if (!transfer?.files?.length) return;
  event.preventDefault();
  const files = Array.from(transfer.files);
  const dropped: DroppedFile[] = [];
  // Sequentially, so a multi-file drop does not peak memory with all files at
  // once.
  for (const file of files) {
    dropped.push(await readFile(file));
  }
  const { tabId, noteId } = getContext?.() || {};
  post(EditorEvents.dropFiles, dropped, tabId, noteId);
}

/**
 * Installs the drop handlers once per document. Safe to call from every
 * mounted editor: `getContext` is refreshed on each call and read at drop
 * time, so the files always land in the note the user is looking at.
 */
export function setupMacFileDrop(context: () => DropContext): void {
  getContext = context;
  if (installed) return;
  installed = true;
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
}
