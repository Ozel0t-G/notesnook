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

import { MenuItem } from "@notesnook/ui";
import { ToolProps } from "../types.js";
import { Dropdown } from "../components/dropdown.js";
import { strings } from "@notesnook/intl";
import { CodeBlock } from "../../extensions/code-block/index.js";

/**
 * Mac Catalyst "Aa" format button (WP08 R6).
 *
 * macOS Notes has no font-size stepper or font-family dropdown: paragraph
 * styles, inline styles and lists all live behind a single "Aa" button. This
 * tool reuses the toolbar's existing dropdown/popup mechanism and runs exactly
 * the commands the individual mobile tools run, so it stays consistent with
 * them (including clearing a manual `textStyle` override when a heading is
 * applied, the way the `headings` tool does).
 *
 * Only rendered when the Mac toolbar definition is active; iPhone, iPad and
 * Android keep the regular toolbar definitions.
 */
export function MacFormat(props: ToolProps) {
  const { editor } = props;

  const items: MenuItem[] = [
    {
      type: "button",
      key: "mac-title",
      title: strings.formatTitle(),
      isChecked: editor.isActive("heading", { level: 1 }),
      onClick: () => setHeading(1)
    },
    {
      type: "button",
      key: "mac-heading",
      title: strings.formatHeading(),
      isChecked: editor.isActive("heading", { level: 2 }),
      onClick: () => setHeading(2)
    },
    {
      type: "button",
      key: "mac-subheading",
      title: strings.formatSubheading(),
      isChecked: editor.isActive("heading", { level: 3 }),
      onClick: () => setHeading(3)
    },
    {
      type: "button",
      key: "mac-body",
      title: strings.formatBody(),
      isChecked:
        !editor.isActive("heading") &&
        !editor.isActive("code") &&
        !editor.isActive(CodeBlock.name),
      onClick: () => editor.chain().focus().setParagraph().run()
    },
    {
      type: "button",
      key: "mac-monospaced",
      title: strings.formatMonospaced(),
      isChecked: editor.isActive("code"),
      onClick: () => editor.chain().focus().toggleCode().run()
    },
    { type: "separator", key: "mac-separator-inline" },
    {
      type: "button",
      key: "mac-bold",
      title: strings.bold(),
      isChecked: editor.isActive("bold"),
      onClick: () => editor.chain().focus().toggleBold().run()
    },
    {
      type: "button",
      key: "mac-italic",
      title: strings.italic(),
      isChecked: editor.isActive("italic"),
      onClick: () => editor.chain().focus().toggleItalic().run()
    },
    {
      type: "button",
      key: "mac-underline",
      title: strings.underline(),
      isChecked: editor.isActive("underline"),
      onClick: () => editor.chain().focus().toggleUnderline().run()
    },
    {
      type: "button",
      key: "mac-strikethrough",
      title: strings.strikethrough(),
      isChecked: editor.isActive("strike"),
      onClick: () => editor.chain().focus().toggleStrike().run()
    },
    { type: "separator", key: "mac-separator-lists" },
    {
      type: "button",
      key: "mac-bullet-list",
      title: strings.bulletList(),
      isChecked: editor.isActive("bulletList"),
      onClick: () => editor.chain().focus().toggleBulletList().run()
    },
    {
      type: "button",
      key: "mac-numbered-list",
      title: strings.numberedList(),
      isChecked: editor.isActive("orderedList"),
      onClick: () => editor.chain().focus().toggleOrderedList().run()
    },
    {
      type: "button",
      key: "mac-checklist",
      title: strings.checklist(),
      isChecked: editor.isActive("checkList"),
      onClick: () => editor.chain().focus().toggleCheckList().run()
    }
  ];

  return (
    <Dropdown
      id="macFormat"
      group="macFormat"
      selectedItem="Aa"
      items={items}
      menuWidth={200}
    />
  );

  function setHeading(level: 1 | 2 | 3) {
    editor
      ?.chain()
      .focus()
      .updateAttributes("textStyle", { fontSize: null, fontStyle: null })
      .setHeading({ level })
      .run();
  }
}
