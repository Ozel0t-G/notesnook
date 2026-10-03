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

import { Attachment, ImageAttributes, LinkAttributes } from "@notesnook/editor";
import { Settings } from ".";
import { editorDate } from "./editor-date";
import { insertTemplateContent } from "./template";

globalThis.commands = {
  clearContent: (tabId: string) => {
    try {
      const editor = editors[tabId];
      const editorController = editorControllers[tabId];
      const editorTitle = editorTitles[tabId];
      const statusBar = statusBars[tabId];

      if (editor) {
        editor?.commands.blur();
        editor?.commands.clearContent(false);
      }

      if (editorController) {
        editorController.content.current = "";
        editorController.onUpdate();
        editorController.setTitle("");
      }

      if (editorTitle?.current) {
        editorTitle.current?.blur();
        editorTitle.current.value = "";
      }

      if (statusBar) {
        statusBar.current.resetWords();
        statusBar.current.set({ date: "", saved: "" });
      }
      editorDate.set(tabId, "");
    } catch (error) {
      logger("error", "clearContent", error, (error as Error).stack);
    }
  },

  focus: (tabId: string, locked: boolean) => {
    const editorController = editorControllers[tabId];
    if (locked) {
      editorController?.focusPassInput();
    } else {
      editors[tabId]?.commands.focus();
    }
  },

  blur: (tabId: string) => {
    const editor = editors[tabId];
    const editorTitle = editorTitles[tabId];
    if (editor) editor.commands.blur();
    if (editorTitle?.current) editorTitle.current.blur();
    editorControllers[tabId]?.blurPassInput();
  },

  setSessionId: (id: string | undefined) => {
    globalThis.sessionId = id;
  },

  setStatus: (date: string | undefined, saved: string, tabId: string) => {
    const statusBar = statusBars[tabId];
    if (statusBar?.current) {
      statusBar.current.set({ date: date || "", saved });
    }
    // The Mac date line above the title reads this; other platforms ignore it.
    editorDate.set(tabId, date || "");
  },

  setLoading: (loading?: boolean, tabId?: string) => {
    if (tabId) {
      const editorController = editorControllers[tabId];
      editorController?.setLoading(loading || false);
      logger("info", editorController?.setLoading);
    }
  },

  setInsets: (insets: any) => {
    if (typeof safeAreaController !== "undefined") {
      safeAreaController.update(insets);
    }
  },

  updateSettings: (settings?: Partial<Settings>) => {
    if (typeof globalThis.settingsController !== "undefined") {
      globalThis.settingsController.update(settings as Settings);
    }
  },

  setSettings: (settings?: Partial<Settings>) => {
    if (typeof globalThis.settingsController !== "undefined") {
      globalThis.settingsController.update(settings as Settings);
    }
  },

  setTags: async (tabId: string, tags: any) => {
    const current = globalThis.editorTags[tabId];
    if (current?.current) {
      current.current.setTags(
        tags.map((tag: any) => ({
          title: tag.title,
          alias: tag.title,
          id: tag.id,
          type: tag.type
        }))
      );
    }
  },

  clearTags: (tabId: string) => {
    const tags = editorTags[tabId];
    if (tags?.current) {
      tags.current.setTags([]);
    }
  },

  insertAttachment: (attachment: Attachment, tabId: number) => {
    const editor = editors[tabId];
    if (editor) {
      editor.commands.insertAttachment(attachment);
    }
  },

  setAttachmentProgress: (
    attachmentProgress: Partial<Attachment>,
    tabId: number
  ) => {
    const editor = editors[tabId];
    if (editor) {
      editor.commands.updateAttachment(attachmentProgress, {
        preventUpdate: true,
        query: (attachment) => attachment.hash === attachmentProgress.hash
      });
    }
  },

  /**
   * Swaps the attributes of the image node identified by `oldHash` (used
   * when a handwriting is edited). The node keeps its position and alignment.
   */
  replaceImage: (
    oldHash: string,
    image: Partial<ImageAttributes>,
    tabId: number
  ) => {
    const editor = editors[tabId];
    if (!editor) return;
    editor.commands.updateAttachment({ ...image, src: undefined } as any, {
      query: (attachment) => attachment.hash === oldHash
    });
  },

  /**
   * Inserts an "Insert template" template (iOS only). Replaces the whole note
   * when it is still empty and keeps the insertion in a single undo step.
   */
  insertTemplate: (html: string, tabId: number) => {
    const editor = editors[tabId];
    if (!editor) return;
    insertTemplateContent(editor, html);
  },

  insertImage: (
    image: Omit<ImageAttributes, "bloburl"> & { dataurl: string },
    tabId: number
  ) => {
    const editor = editors[tabId];
    if (editor) {
      editor.commands.insertImage({
        ...image
      });
    }
  },

  handleBack: () => {
    return window.dispatchEvent(
      new Event("handleBackPress", { cancelable: true })
    );
  },

  keyboardShown: (keyboardShown: boolean) => {
    globalThis["keyboardShown"] = keyboardShown;
  },

  getTableOfContents: (tabId: string) => {
    return editorControllers[tabId]?.getTableOfContents() || [];
  },

  focusPassInput: (tabId: string) => {
    return editorControllers[tabId]?.focusPassInput() || [];
  },

  blurPassInput: (tabId: string) => {
    return editorControllers[tabId]?.blurPassInput() || [];
  },

  createInternalLink: (attributes: LinkAttributes, resolverId: string) => {
    if (globalThis.pendingResolvers[resolverId]) {
      globalThis.pendingResolvers[resolverId](attributes);
    }
  },

  dismissCreateInternalLinkRequest: (resolverId: string) => {
    if (globalThis.pendingResolvers[resolverId]) {
      globalThis.pendingResolvers[resolverId](undefined);
    }
  },

  scrollIntoViewById: (id: string, tabId: string) => {
    return editorControllers[tabId]?.scrollIntoView(id) || [];
  },
  scrollToSearchResult: (index: number, tabId: string) => {
    editorControllers[tabId]?.getContentDiv()?.classList.add("searching");
    editorControllers[tabId]?.scrollToSearchResult(index);
  },

  /**
   * Mac menu > Format (K2/E3), forwarded by the native menu bar through
   * apps/mobile/app/hooks/use-mac-menu-commands.ts. `name` is the suffix of
   * the menu command ("format:bold" -> "bold") and every case runs the very
   * command the editor toolbar's own button runs, so the result is identical
   * (including the paragraph styles, which clear a font size set through the
   * toolbar first, see toolbar/tools/headings.tsx).
   *
   * A no-op (false) when the tab has no editor, which is the case for a locked
   * note; the native items are greyed out without an open note anyway.
   */
  format: (name: string, tabId: string) => {
    const editor = editors[tabId];
    if (!editor) return false;
    try {
      const chain = editor.chain().focus();
      switch (name) {
        case "title":
          return chain
            .updateAttributes("textStyle", { fontSize: null, fontStyle: null })
            .setHeading({ level: 1 })
            .run();
        case "heading":
          return chain
            .updateAttributes("textStyle", { fontSize: null, fontStyle: null })
            .setHeading({ level: 2 })
            .run();
        case "subheading":
          return chain
            .updateAttributes("textStyle", { fontSize: null, fontStyle: null })
            .setHeading({ level: 3 })
            .run();
        case "body":
          return chain.setParagraph().run();
        case "bulletedList":
          return chain.toggleBulletList().run();
        case "numberedList":
          return chain.toggleOrderedList().run();
        case "checklist":
          return chain.toggleCheckList().run();
        case "blockquote":
          return chain.toggleBlockquote().run();
        case "codeBlock":
          return chain.toggleCodeBlock().run();
        case "bold":
          return chain.toggleBold().run();
        case "italic":
          return chain.toggleItalic().run();
        case "underline":
          return chain.toggleUnderline().run();
        case "strikethrough":
          return chain.toggleStrike().run();
        case "link":
          // Link has no plain command: the editor's Mod-k key binding opens
          // this popup (extensions/key-map/key-map.ts), so the menu runs the
          // same function.
          editor.view.dom.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "k",
              code: "KeyK",
              metaKey: true,
              bubbles: true,
              cancelable: true
            })
          );
          return true;
        case "clearFormatting":
          // Same as toolbar/tools/inline.tsx' ClearFormatting.
          return chain.unsetAllMarks().unsetMark("link").run();
        default:
          return false;
      }
    } catch (error) {
      logger("error", "format", name, error);
      return false;
    }
  },

  /**
   * Mac menu > Edit > Find (K3/E4), forwarded by
   * apps/mobile/app/hooks/use-mac-menu-commands.ts. "find" and "replace" open
   * the editor's own search-and-replace popup (the same `startSearch` the
   * header's magnifier and Mod-f call), "next"/"previous" move between the
   * matches. False without an editor (locked note) or before a search ran.
   */
  find: (mode: string, tabId: string) => {
    const editor = editors[tabId];
    if (!editor) return false;
    try {
      switch (mode) {
        case "find":
          return editor.commands.startSearch();
        case "replace":
          return editor.commands.startSearch(true);
        case "next":
          return editor.commands.moveToNextResult();
        case "previous":
          return editor.commands.moveToPreviousResult();
        default:
          return false;
      }
    } catch (error) {
      logger("error", "find", mode, error);
      return false;
    }
  }
};
