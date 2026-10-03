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

import { describe, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
// The helper lives in editor-mobile (the mobile editor bundle); it is pure and
// only depends on the tiptap Editor shape, so it is exercised here using the
// editor package's vitest harness.
import { insertTemplateContent } from "../../../../../editor-mobile/src/utils/template.js";

const TEMPLATE = "<h1>Title</h1><p>Body</p>";

function createEditor(content: string) {
  return new Editor({ extensions: [StarterKit], content });
}

describe("insertTemplateContent", () => {
  test("replaces an empty note instead of keeping an empty leading line", () => {
    const editor = createEditor("<p></p>");
    expect(insertTemplateContent(editor as any, TEMPLATE)).toBe(true);
    expect(editor.getHTML()).toBe(TEMPLATE);
    editor.destroy();
  });

  test("inserts at the current selection in a non-empty note", () => {
    const editor = createEditor("<p>existing</p>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(insertTemplateContent(editor as any, "<p>inserted</p>")).toBe(true);
    expect(editor.getHTML()).toBe("<p>existing</p><p>inserted</p>");
    editor.destroy();
  });

  test("is a single undoable step", () => {
    const editor = createEditor("<p></p>");
    insertTemplateContent(editor as any, TEMPLATE);
    expect(editor.can().undo()).toBe(true);
    editor.commands.undo();
    expect(editor.getHTML()).toBe("<p></p>");
    editor.destroy();
  });
});
