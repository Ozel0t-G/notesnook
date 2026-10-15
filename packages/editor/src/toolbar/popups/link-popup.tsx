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

import { Input, Text } from "@theme-ui/components";
import { Flex } from "@theme-ui/components";
import { useRefValue } from "../../hooks/use-ref-value.js";
import { Popup } from "../components/popup.js";
import { isInternalLink, LinkDefinition } from "../tools/link.js";
import { showPopup } from "../../components/popup-presenter/index.js";
import Link, { LinkAttributes } from "../../extensions/link/index.js";
import { ImageNode } from "../../extensions/image/index.js";
import { findMark, selectionToOffset } from "../../utils/prosemirror.js";
import { Editor, getMarkAttributes } from "@tiptap/core";
import { insertInternalLink } from "../tools/internal-link-command.js";
import type { Editor as ForkedEditor } from "../../types.js";
import { strings } from "@notesnook/intl";

import { useToolbarStore } from "../stores/toolbar-store.js";
import { getEditorContainer, getEditorDOM } from "../utils/dom.js";

export type LinkPopupProps = {
  link?: LinkDefinition;
  isEditing?: boolean;
  onDone: (link: LinkDefinition) => void;
  onClose: () => void;
  isImageActive?: boolean;
};
export function LinkPopup(props: LinkPopupProps) {
  const {
    link: _link = { title: "", href: "" },
    isEditing = false,
    onDone,
    onClose,
    isImageActive
  } = props;
  const link = useRefValue(_link);

  return (
    <Popup
      title={isEditing ? strings.editLink() : strings.insertLink()}
      onClose={onClose}
      action={{
        title: isEditing ? strings.save() : strings.insert(),
        onClick: () => onDone(link.current)
      }}
    >
      <Flex
        sx={{ p: 1, flexDirection: "column", width: ["auto", 250] }}
        onKeyUp={(e) => {
          if (e.key === "Enter") {
            onDone(link.current);
          }
        }}
      >
        {!isImageActive && (
          <>
            <Text
              sx={{
                mb: 1,
                ml: 1,
                fontSize: "body",
                color: "paragraph"
              }}
            >
              {strings.linkText()}
            </Text>
            <Input
              type="text"
              placeholder={strings.linkText()}
              defaultValue={link.current?.title}
              sx={{ mb: 2 }}
              onChange={(e) =>
                (link.current = {
                  ...link.current,
                  title: e.target.value
                })
              }
            />
          </>
        )}
        <Text
          sx={{
            mb: 1,
            ml: 1,
            fontSize: "body",
            color: "paragraph"
          }}
        >
          {strings.url()}
        </Text>
        <Input
          type="url"
          autoFocus
          placeholder="https://example.com/"
          defaultValue={link.current?.href}
          onChange={(e) =>
            (link.current = { ...link.current, href: e.target.value })
          }
        />
      </Flex>
    </Popup>
  );
}

export async function showLinkPopup(editor: Editor) {
  const isActive = editor.isActive(Link.name);
  const isImageActive = editor.isActive(ImageNode.name);
  const selectedNode = selectionToOffset(editor.state);
  const link = selectedNode?.node
    ? findMark(selectedNode.node, Link.name)
    : null;
  const attrs = link?.attrs || getMarkAttributes(editor.state, Link.name);
  const selectedText = editor.state.doc.textBetween(
    editor.state.selection.from,
    editor.state.selection.to
  );
  if (isInternalLink(attrs.href)) {
    // Existing internal link (or an empty selection inside one): reuse the
    // shared guarded command so the picker result is applied with the exact
    // same readonly/destroyed/document-identity guarantees as the other entry
    // points. The hovered link range is preserved and the custom linked text is
    // kept (`insertInternalLink` prefers the selected text as the title).
    await insertInternalLink(editor as unknown as ForkedEditor, {
      attributes: attrs as LinkAttributes,
      range:
        selectedNode && isActive
          ? { from: selectedNode.from, to: selectedNode.to }
          : undefined
    });
    return;
  }

  const isMac = useToolbarStore.getState().macCatalyst;
  const restoreMacFocus = () => {
    if (
      isMac &&
      !editor.isDestroyed &&
      editor.isEditable &&
      editor.view.dom.isConnected &&
      getEditorDOM() === editor.view.dom
    ) {
      editor.commands.focus(undefined, { scrollIntoView: false });
    }
  };
  showPopup({
    popup: (close) => (
      <LinkPopup
        link={
          selectedNode && selectedNode.node
            ? {
                title: isActive ? selectedNode.node.textContent : selectedText,
                href: link?.attrs.href || ""
              }
            : undefined
        }
        onClose={() => {
          close();
          restoreMacFocus();
        }}
        onDone={(link) => {
          if (isActive) {
            if (selectedNode)
              editor.chain().focus().setTextSelection(selectedNode).run();
            editor.commands.setLink(link);
          } else editor.commands.toggleLink(link);
          close();
          restoreMacFocus();
        }}
        isEditing={isActive}
        isImageActive={isImageActive}
      />
    ),
    mobile: isMac ? "popup" : "sheet",
    desktop: "popup",
    ...(isMac
      ? {
          position: {
            target:
              getEditorDOM().closest<HTMLElement>(".active") ||
              getEditorContainer(),
            isTargetAbsolute: true,
            location: "top" as const,
            align: "center" as const,
            yOffset: -8
          },
          onClose: restoreMacFocus
        }
      : {}),
    title: isActive ? strings.editLink() : strings.insertLink(),
    focusOnRender: false
  });
}
