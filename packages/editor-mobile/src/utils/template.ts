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

import type { Editor } from "@notesnook/editor";

/**
 * Inserts an "Insert template" template's HTML into the current note.
 *
 * The template is inserted at the current selection. When the note is still
 * empty (a single empty paragraph, the state of a freshly created note) the
 * whole content is selected first so the template replaces the empty line
 * instead of being prepended to it. Both paths run as a single chain, i.e. one
 * undoable transaction: a single undo removes the inserted template.
 */
export function insertTemplateContent(editor: Editor, html: string): boolean {
  const doc = editor.state.doc;
  const isEmpty =
    doc.childCount === 1 &&
    doc.firstChild?.type.name === "paragraph" &&
    doc.firstChild.content.size === 0;

  if (isEmpty) {
    return editor.chain().focus().selectAll().insertContent(html).run();
  }

  return editor.chain().focus().insertContent(html).run();
}
