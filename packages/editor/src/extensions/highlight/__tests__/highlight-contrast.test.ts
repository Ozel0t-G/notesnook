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

/**
 * Runtime coverage for the real `Highlight` extension's ProseMirror plugin
 * (`addProseMirrorPlugins` in `highlight.ts`): no mocks here - a genuine
 * `@tiptap/core` editor built from `StarterKit`, `TextStyle` and `Color`
 * (for the authored-foreground case) plus the actual `Highlight` extension,
 * rendered into a real happy-dom `editor.view.dom`. The plugin itself is
 * exercised through its public surface only: the rendered decoration DOM,
 * `getHTML`/`getJSON`/a real `DOMSerializer` pass (standing in for a
 * clipboard copy) and the exported `highlightContrastPluginKey` (used only
 * to prove the "rebuild only on `docChanged`" contract, not to reach into
 * any other internal).
 */

import { afterEach, describe, expect, test } from "vitest";
import { Editor as TiptapEditor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { Highlight, highlightContrastPluginKey } from "../highlight.js";
import {
  editorHighlight,
  editorHighlightForeground
} from "../editor-highlight-tokens.js";

const openEditors: TiptapEditor[] = [];
function track<T extends TiptapEditor>(editor: T): T {
  openEditors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of openEditors) if (!editor.isDestroyed) editor.destroy();
  openEditors.length = 0;
});

function createEditor(content: string) {
  return track(
    new TiptapEditor({
      extensions: [StarterKit, TextStyle, Color, Highlight],
      content
    })
  );
}

function decorationSpans(editor: TiptapEditor): HTMLElement[] {
  return Array.from(editor.view.dom.querySelectorAll("span")).filter((span) =>
    (span.getAttribute("style") ?? "").includes(
      `color: ${editorHighlightForeground}`
    )
  );
}

describe("Highlight extension - contrast decoration", () => {
  test("decorates a run carrying the normalized warm background with no authored color", () => {
    const editor = createEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setHighlight(editorHighlight);

    const spans = decorationSpans(editor);
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe("hello");
  });

  test("the decoration stays on the marked run regardless of the current selection, and unmarked text is untouched", () => {
    const editor = createEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setHighlight(editorHighlight);

    editor.commands.setTextSelection({ from: 8, to: 8 });
    const spans = decorationSpans(editor);
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe("hello");
    expect(editor.getText()).toBe("hello world");
  });

  const rejected = [
    "#f7c88c", // near-miss
    "#F7C88BAA", // 8-digit hex (alpha)
    "rgba(247, 200, 139, 1)", // rgba(), even fully opaque
    "rgba(247, 200, 139, 0.6)", // rgba(), non-opaque
    "rgb(247, 200, 139, 1)", // 4-arg rgb() alpha form
    "moccasin" // named color
  ];

  test.each(rejected)("rejects %s and applies no decoration", (value) => {
    const editor = createEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setHighlight(value);
    expect(decorationSpans(editor)).toHaveLength(0);
  });

  const accepted = [
    "#f7c88b",
    "#F7C88B",
    "rgb(247,200,139)",
    "rgb(247, 200, 139)"
  ];

  test.each(accepted)(
    "accepts the exact warm color in a valid encoding (%s)",
    (value) => {
      const editor = createEditor("<p>hello world</p>");
      editor.commands.setTextSelection({ from: 1, to: 6 });
      editor.commands.setHighlight(value);
      expect(decorationSpans(editor)).toHaveLength(1);
    }
  );

  test("an authored textStyle.color on the same run is byte-preserved and the run is not decorated", () => {
    const editor = createEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setHighlight(editorHighlight);
    editor.commands.setColor("#123456");

    expect(decorationSpans(editor)).toHaveLength(0);
    const html = editor.getHTML();
    expect(html).toContain("color: #123456");
    expect(html).not.toContain(editorHighlightForeground);
    expect(editor.getAttributes("textStyle").backgroundColor).toBe(
      editorHighlight
    );
  });

  test("serialization, a DOMSerializer clipboard pass and reopen never inject the decoration's foreground into content", () => {
    const editor = createEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setHighlight(editorHighlight);

    const html = editor.getHTML();
    const json = editor.getJSON();
    expect(html).not.toContain(editorHighlightForeground);
    expect(JSON.stringify(json)).not.toContain(editorHighlightForeground);
    expect(html).toContain(`background-color: ${editorHighlight}`);

    const slice = editor.state.selection.content();
    const serializer = DOMSerializer.fromSchema(editor.schema);
    const fragment = serializer.serializeFragment(slice.content);
    const container = document.createElement("div");
    container.appendChild(fragment);
    expect(container.innerHTML).not.toContain(editorHighlightForeground);
    expect(container.innerHTML.toLowerCase()).toContain(
      editorHighlight.toLowerCase()
    );

    const reopened = track(
      new TiptapEditor({
        extensions: [StarterKit, TextStyle, Color, Highlight],
        content: html
      })
    );
    expect(reopened.getHTML()).toBe(html);
    expect(decorationSpans(reopened)).toHaveLength(1);
  });

  test("clearing the highlight removes the decoration; undo restores it, redo clears it again", () => {
    const editor = createEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setHighlight(editorHighlight);
    expect(decorationSpans(editor)).toHaveLength(1);

    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.unsetHighlight();
    expect(decorationSpans(editor)).toHaveLength(0);

    editor.commands.undo();
    expect(decorationSpans(editor)).toHaveLength(1);

    editor.commands.redo();
    expect(decorationSpans(editor)).toHaveLength(0);
  });

  test("typing before and inside the marked run keeps the decoration anchored to the right text", () => {
    const editor = createEditor("<p>AA hello world</p>");
    editor.commands.setTextSelection({ from: 4, to: 9 }); // "hello"
    editor.commands.setHighlight(editorHighlight);
    expect(decorationSpans(editor).map((s) => s.textContent)).toEqual([
      "hello"
    ]);

    editor.commands.setTextSelection({ from: 1, to: 1 });
    editor.commands.insertContent("ZZ");
    expect(editor.getText()).toBe("ZZAA hello world");
    expect(decorationSpans(editor).map((s) => s.textContent)).toEqual([
      "hello"
    ]);

    editor.commands.setTextSelection({ from: 8, to: 8 }); // inside "hello"
    editor.commands.insertContent("X");
    expect(editor.getText()).toBe("ZZAA heXllo world");
    expect(decorationSpans(editor).map((s) => s.textContent)).toEqual([
      "heXllo"
    ]);
  });

  test("a selection-only transaction reuses the same decoration set; a doc-changing transaction rebuilds it", () => {
    const editor = createEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setHighlight(editorHighlight);

    const before = highlightContrastPluginKey.getState(editor.state);
    editor.commands.setTextSelection({ from: 8, to: 8 });
    const afterSelectionOnly = highlightContrastPluginKey.getState(
      editor.state
    );
    expect(afterSelectionOnly).toBe(before);

    editor.commands.insertContent(" more");
    const afterDocChange = highlightContrastPluginKey.getState(editor.state);
    expect(afterDocChange).not.toBe(before);
  });

  test("remains correct across a long document without relying on timing", () => {
    const paragraphs = Array.from(
      { length: 200 },
      (_, i) => `<p>paragraph ${i} plain marked tail</p>`
    ).join("");
    const editor = createEditor(paragraphs);

    const ranges: { from: number; to: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text) {
        const idx = node.text.indexOf("marked");
        if (idx >= 0)
          ranges.push({ from: pos + idx, to: pos + idx + "marked".length });
      }
    });
    expect(ranges).toHaveLength(200);

    for (const range of ranges) {
      editor.commands.setTextSelection(range);
      editor.commands.setHighlight(editorHighlight);
    }

    const spans = decorationSpans(editor);
    expect(spans).toHaveLength(200);
    for (const span of spans) expect(span.textContent).toBe("marked");
  });
});
