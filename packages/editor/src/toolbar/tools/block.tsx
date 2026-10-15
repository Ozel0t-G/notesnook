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

import { ToolProps } from "../types.js";
import { Editor, hasPermission } from "../../types.js";
import { Icons } from "../icons.js";
import { useMemo, useRef, useState } from "react";
import { EmbedPopup } from "../popups/embed-popup.js";
import { TablePopup } from "../popups/table-popup.js";
import { MenuItem, Icon } from "@notesnook/ui";
import {
  useIsMobile,
  useToolbarLocation,
  useToolbarStore
} from "../stores/toolbar-store.js";
import { getEditorDOM } from "../utils/dom.js";
import { ResponsivePresenter } from "../../components/responsive/index.js";
import { showPopup } from "../../components/popup-presenter/index.js";
import { ImageUploadPopup } from "../popups/image-upload.js";
import { Button } from "../../components/button.js";
import { strings } from "@notesnook/intl";
import { keybindings } from "@notesnook/common";
import { importCsvToTable } from "../../extensions/table/actions.js";
import { insertInternalLink } from "./internal-link-command.js";
import { showLinkPopup } from "../popups/link-popup.js";

export function InsertBlock(props: ToolProps) {
  const { editor } = props;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const toolbarLocation = useToolbarLocation();
  const isMobile = useIsMobile();

  // `isEditable` and the host provided `createInternalLink` are read while the
  // items are built, so a readonly transition or the same host re-registering
  // its picker on the *same* editor instance must invalidate the memo. With
  // only `[editor, isMobile]` the capability flags would stay cached and the
  // "+" menu would keep advertising an action that can no longer run.
  const menuItems = useMemo(
    () => getInsertMenuItems(editor, isMobile),
    [editor, isMobile, editor.isEditable, editor.storage.createInternalLink]
  );

  return (
    <>
      <Button
        ref={buttonRef}
        variant="secondary"
        sx={{
          p: 1,
          m: 0,
          bg: isOpen ? "var(--background-secondary)" : "transparent",
          mr: 1,
          display: "flex",
          alignItems: "center",
          ":last-of-type": {
            mr: 0
          }
        }}
        onMouseDown={(e) => {
          if (globalThis.keyboardShown) {
            e.preventDefault();
          }
        }}
        title={strings.insert()}
        aria-label={strings.insert()}
        onClick={() => setIsOpen((s) => !s)}
      >
        <Icon path={Icons.plus} size="medium" color={"accent"} />
      </Button>

      <ResponsivePresenter
        desktop="menu"
        mobile="sheet"
        title={strings.chooseBlockToInsert()}
        isOpen={isOpen}
        items={menuItems}
        onClose={() => setIsOpen(false)}
        position={{
          target: buttonRef.current || undefined,
          isTargetAbsolute: true,
          location: toolbarLocation === "bottom" ? "top" : "below",
          yOffset: 5
        }}
      />
    </>
  );
}

export function getInsertMenuItems(
  editor: Editor,
  isMobile: boolean
): MenuItem[] {
  return [
    tasklist(editor),
    outlinelist(editor),
    horizontalRule(editor),
    codeblock(editor),
    mathblock(editor),
    callout(editor),
    blockquote(editor),
    internalLink(editor),
    externalLink(editor),
    image(editor, isMobile),
    handwriting(editor),
    template(editor),
    attachment(editor),
    isMobile ? embedMobile(editor) : embedDesktop(editor),
    table(editor)
  ];
}

const macInsertMenus = new WeakMap<Editor, () => void>();

/** Native Mac + toggles one owned menu. True means handled, not "now open". */
export function showMacInsertMenu(editor: Editor): boolean {
  const existing = macInsertMenus.get(editor);
  if (existing) {
    existing();
    return true;
  }
  if (
    !useToolbarStore.getState().macCatalyst ||
    editor.isDestroyed ||
    !editor.isEditable ||
    !editor.view.dom.isConnected ||
    getEditorDOM() !== editor.view.dom
  )
    return false;
  const root = editor.view.dom.closest<HTMLElement>(".active");
  const owner = root?.querySelector<HTMLElement>(".dialogContainer");
  if (!root || !owner) return false;
  const doc = editor.state.doc;
  const selection = editor.state.selection;
  let closed = false;
  const isCurrent = () =>
    !closed &&
    !editor.isDestroyed &&
    editor.isEditable &&
    root.isConnected &&
    root.classList.contains("active") &&
    getEditorDOM() === editor.view.dom &&
    editor.state.doc === doc &&
    editor.state.selection.eq(selection);
  const guarded = (items: MenuItem[]): MenuItem[] =>
    items.map((item) => {
      if (item.type !== "button") return item;
      return {
        ...item,
        // Catalyst uses pointer density even inside the mobile editor host.
        styles: {
          ...item.styles,
          button: {
            ...item.styles?.button,
            height: "auto",
            minHeight: "2em",
            py: 0
          }
        },
        ...(item.onClick
          ? {
              onClick: () => {
                if (isCurrent()) return item.onClick?.();
              }
            }
          : {}),
        ...(item.menu
          ? { menu: { ...item.menu, items: guarded(item.menu.items) } }
          : {})
      };
    });
  let hide = () => {};
  const cleanup = () => {
    closed = true;
    if (macInsertMenus.get(editor) === close) macInsertMenus.delete(editor);
    observer.disconnect();
    editor.off("transaction", changed);
    editor.off("update", changed);
    editor.off("destroy", close);
  };
  const close = () => {
    cleanup();
    hide();
  };
  const changed = () => {
    if (!isCurrent()) close();
  };
  const observer = new MutationObserver(changed);
  editor.commands.focus(undefined, { scrollIntoView: false });
  hide = showPopup({
    popup: () => null,
    items: guarded(
      getInsertMenuItems(editor, useToolbarStore.getState().isMobile)
    ),
    title: strings.chooseBlockToInsert(),
    mobile: "menu",
    desktop: "menu",
    // The native column scroller remains visible in a short Inspector pane;
    // the legacy custom scrollbar can repaint its rows blank in WKWebView.
    menuLayout: "column",
    fitSubmenusToViewport: true,
    container: owner,
    position: {
      target: root,
      isTargetAbsolute: true,
      location: "top",
      align: "center",
      yOffset: -8
    },
    onClose: cleanup
  });
  if (closed) return true;
  macInsertMenus.set(editor, close);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  editor.on("transaction", changed);
  editor.on("update", changed);
  editor.on("destroy", close);
  return true;
}

const horizontalRule = (editor: Editor): MenuItem => ({
  key: "hr",
  type: "button",
  title: strings.horizontalRule(),
  icon: Icons.horizontalRule,
  isChecked: editor.isActive("horizontalRule"),
  onClick: () => editor.chain().focus().setHorizontalRule().run()
});

const codeblock = (editor: Editor): MenuItem => ({
  key: "codeblock",
  type: "button",
  title: strings.codeBlock(),
  icon: Icons.codeblock,
  isChecked: editor.isActive("codeBlock"),
  onClick: () => editor.chain().focus().toggleCodeBlock().run(),
  modifier: keybindings.toggleCodeBlock.keys
});

const blockquote = (editor: Editor): MenuItem => ({
  key: "blockquote",
  type: "button",
  title: strings.quote(),
  icon: Icons.blockquote,
  isChecked: editor.isActive("blockQuote"),
  onClick: () => editor.chain().focus().toggleBlockquote().run(),
  modifier: keybindings.insertBlockquote.keys
});

const mathblock = (editor: Editor): MenuItem => ({
  key: "math",
  type: "button",
  title: strings.mathAndFormulas(),
  icon: Icons.mathBlock,
  isChecked: editor.isActive("mathBlock"),
  onClick: () => editor.chain().focus().insertMathBlock().run(),
  modifier: keybindings.insertMathBlock.keys
});

const callout = (editor: Editor): MenuItem => ({
  key: "callout",
  type: "button",
  title: strings.callout(),
  icon: Icons.callout,
  menu: {
    items: [
      "Abstract",
      "Hint",
      "Info",
      "Success",
      "Warn",
      "Error",
      "Example",
      "Quote"
    ].map((type) => ({
      title: type,
      key: type,
      type: "button",
      isChecked: editor.isActive("callout", { type: type.toLowerCase() }),
      onClick: () =>
        editor
          .chain()
          .focus()
          .setCallout({ type: type.toLowerCase() as any })
          .run()
    }))
  }
});

/**
 * First-level shortcut: links the current selection to a note/notebook/tag
 * using the host provided internal link picker. Shared by every platform
 * (iPhone, iPad and Mac) because it lives in the Insert "+" menu, which is the
 * one entry point that is always present regardless of toolbar customization.
 *
 * The action is only reachable when it can actually do something:
 * - hidden when the host did not provide `createInternalLink` (there is no
 *   picker to show, so the entry would be a visible no-op);
 * - disabled on readonly documents, where the command refuses to mutate.
 */
const internalLink = (editor: Editor): MenuItem => ({
  key: "internal-link",
  type: "button",
  title: strings.newInternalLink(),
  icon: Icons.noteLink,
  isHidden: typeof editor.storage.createInternalLink !== "function",
  isDisabled: !editor.isEditable,
  onClick: () => {
    return insertInternalLink(editor);
  }
});

/**
 * First-level shortcut for a plain (external) link: reuses the exact same
 * `showLinkPopup` flow the hover/bottom toolbar link tools use, so legacy
 * selection/caption/editing semantics are unchanged. Unlike `internalLink`
 * this entry needs no host capability, so it is always shown and stays
 * reachable from the Insert "+" menu even when a custom/minimal toolbar
 * (`toolbar=[]`) hides the dedicated link tool, e.g. on iPhone/iPad/Mac.
 */
const externalLink = (editor: Editor): MenuItem => ({
  key: "external-link",
  type: "button",
  title: strings.insertLink(),
  icon: Icons.link,
  isDisabled: !editor.isEditable,
  onClick: () => {
    // The menu's own items are memoized; a readonly transition or a
    // destroy that happens while this entry is still mounted must not let a
    // stale closure run the popup/link commands on a dead or locked editor.
    if (!editor.isEditable || editor.isDestroyed) return;
    return showLinkPopup(editor);
  }
});

const image = (editor: Editor, isMobile: boolean): MenuItem => ({
  key: "image",
  type: "button",
  title: strings.image(),
  icon: Icons.image,
  menu: {
    title: strings.insertImage(),
    items: [
      {
        key: "upload-from-disk",
        type: "button",
        title: strings.uploadFromDisk(),
        icon: Icons.upload,
        onClick: () => editor.storage.openAttachmentPicker?.("image"),
        modifier: keybindings.addImage.keys
      },
      {
        key: "camera",
        type: "button",
        title: strings.takePhotoUsingCamera(),
        icon: Icons.camera,
        isHidden: !isMobile,
        onClick: () => editor.storage.openAttachmentPicker?.("camera")
      },
      isMobile ? uploadImageFromURLMobile(editor) : uploadImageFromURL(editor)
    ]
  }
});

/**
 * First-level shortcut (Apple Pencil on iPad): one tap from the insert menu,
 * instead of Image -> Handwriting. Hidden unless the host app enables it.
 */
const handwriting = (editor: Editor): MenuItem => ({
  key: "handwriting",
  type: "button",
  title: strings.handwriting(),
  icon: Icons.handwriting,
  isHidden: !editor.storage.handwritingEnabled,
  onClick: () => editor.storage.openAttachmentPicker?.("handwriting")
});

/**
 * First-level shortcut (iOS only): lets the user insert a saved note template
 * from the insert menu. Hidden unless the host app enables it.
 */
const template = (editor: Editor): MenuItem => ({
  key: "template",
  type: "button",
  title: strings.insertTemplate(),
  icon: Icons.template,
  isHidden: !editor.storage.templatesEnabled,
  onClick: () => editor.storage.openTemplatePicker?.()
});

const table = (editor: Editor): MenuItem => ({
  key: "table",
  type: "button",
  title: strings.table(),
  icon: Icons.table,
  menu: {
    title: strings.insertTable(),
    items: [
      {
        key: "import-csv",
        type: "button",
        title: strings.importCsv(),
        icon: Icons.csv,
        onClick: async () => {
          if (!hasPermission("importCsvToTable")) return;

          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".csv,text/csv";
          input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
              const text = await file.text();
              importCsvToTable(text, editor);
            } catch (error) {
              console.error("Error importing CSV:", error);
            }
          };

          input.click();
        }
      },
      {
        key: "sep",
        type: "separator"
      },
      {
        key: "table-size-selector",
        type: "popup",
        component: (props) => (
          <TablePopup
            onInsertTable={(size) => {
              editor
                ?.chain()
                .focus()
                .insertTable({
                  rows: size.rows,
                  cols: size.columns
                })
                .run();
              props.onClick?.();
            }}
          />
        )
      }
    ]
  }
});

const embedMobile = (editor: Editor): MenuItem => ({
  key: "embed",
  type: "button",
  title: strings.embed(),
  icon: Icons.embed,
  menu: {
    title: strings.insertEmbed(),
    items: [
      {
        key: "embed-popup",
        type: "popup",
        component: function ({ onClick }) {
          return (
            <EmbedPopup
              title={strings.insertEmbed()}
              onClose={(embed) => {
                if (!embed) return onClick?.();
                editor.chain().insertEmbed(embed).run();
                onClick?.();
              }}
            />
          );
        }
      }
    ]
  }
});

const embedDesktop = (editor: Editor): MenuItem => ({
  key: "embed",
  type: "button",
  title: strings.embed(),
  icon: Icons.embed,
  onClick: () => {
    if (!editor) return;
    showPopup({
      popup: (hide) => (
        <EmbedPopup
          title={strings.insertEmbed()}
          onClose={(embed) => {
            if (!embed) return hide();
            editor.chain().insertEmbed(embed).run();
            hide();
          }}
        />
      )
    });
  }
});

const attachment = (editor: Editor): MenuItem => ({
  key: "attachment",
  type: "button",
  title: strings.attachment(),
  icon: Icons.attachment,
  isChecked: editor.isActive("attachment"),
  onClick: () => editor.storage.openAttachmentPicker?.("file"),
  modifier: keybindings.addAttachment.keys
});

const tasklist = (editor: Editor): MenuItem => ({
  key: "tasklist",
  type: "button",
  title: strings.taskList(),
  icon: Icons.checkbox,
  isChecked: editor.isActive("taskList"),
  onClick: () => editor.chain().focus().toggleTaskList().run(),
  modifier: keybindings.toggleTaskList.keys
});

const outlinelist = (editor: Editor): MenuItem => ({
  key: "outlinelist",
  type: "button",
  title: strings.outlineList(),
  icon: Icons.outlineList,
  isChecked: editor.isActive("outlineList"),
  onClick: () => editor.chain().focus().toggleOutlineList().run(),
  modifier: keybindings.toggleOutlineList.keys
});

const uploadImageFromURLMobile = (editor: Editor): MenuItem => ({
  key: "upload-from-url",
  type: "button",
  title: strings.attachImageFromURL(),
  icon: Icons.link,
  menu: {
    title: strings.attachImageFromURL(),
    items: [
      {
        key: "attach-image",
        type: "popup",
        component: ({ onClick }) => (
          <ImageUploadPopup
            onInsert={(image) => {
              editor?.chain().focus().insertImage(image).run();
              onClick?.();
            }}
            onClose={() => {
              onClick?.();
            }}
          />
        )
      }
    ]
  }
});

const uploadImageFromURL = (editor: Editor): MenuItem => ({
  key: "upload-from-url",
  type: "button",
  title: strings.attachImageFromURL(),
  icon: Icons.link,
  onClick: () => {
    showPopup({
      popup: (hide) => (
        <ImageUploadPopup
          onInsert={(image) => {
            editor?.chain().focus().insertImage(image).run();
            hide();
          }}
          onClose={hide}
        />
      )
    });
  }
});
