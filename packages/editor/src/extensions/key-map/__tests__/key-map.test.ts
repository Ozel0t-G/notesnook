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
  createEditor,
  h,
  p,
  ul,
  li,
  outlineList,
  outlineListItem
} from "../../../../test-utils/index.js";
import { test, expect, describe, vi } from "vitest";
import { Editor as TiptapEditor } from "@tiptap/core";
import { KeyMap } from "../key-map.js";
import { OutlineList } from "../../outline-list/outline-list.js";
import { OutlineListItem } from "../../outline-list-item/outline-list-item.js";
import { BulletList } from "../../bullet-list/bullet-list.js";
import { ListItem } from "../../list-item/list-item.js";
import { Heading } from "../../heading/heading.js";
import { Link } from "../../link/index.js";
import type { LinkAttributes } from "../../link/index.js";

describe("key-map", () => {
  test("move paragraph up", async () => {
    const el = h("div", [p(["para 1"]), p(["para 2"]), p(["para 3"])]);
    const editorElement = h("div");
    const { editor } = createEditor({
      element: editorElement,
      initialContent: el.outerHTML,
      extensions: {
        KeyMap: KeyMap
      }
    });

    editor.commands.setTextSelection({ from: 10, to: 10 });
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true
    });
    editor.view.dom.dispatchEvent(event);

    expect(editor.getHTML()).toBe(`<p>para 2</p><p>para 1</p><p>para 3</p>`);
  });

  test("move paragraph down", async () => {
    const el = h("div", [p(["para 1"]), p(["para 2"]), p(["para 3"])]);
    const editorElement = h("div");
    const { editor } = createEditor({
      element: editorElement,
      initialContent: el.outerHTML,
      extensions: {
        KeyMap: KeyMap
      }
    });

    editor.commands.setTextSelection(0);
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true
    });
    editor.view.dom.dispatchEvent(event);

    expect(editor.getHTML()).toBe(`<p>para 2</p><p>para 1</p><p>para 3</p>`);
  });

  test("move outline list item up", async () => {
    const el = outlineList(
      outlineListItem(["item 1"]),
      outlineListItem(["item 2"]),
      outlineListItem(["item 3"])
    );
    const editorElement = h("div");
    const { editor } = createEditor({
      element: editorElement,
      initialContent: el.outerHTML,
      extensions: {
        KeyMap: KeyMap,
        outlineList: OutlineList,
        outlineListItem: OutlineListItem
      }
    });

    editor.commands.setTextSelection({ from: 15, to: 15 });
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true
    });
    editor.view.dom.dispatchEvent(event);

    const expectedHTML = outlineList(
      outlineListItem(["item 2"]),
      outlineListItem(["item 1"]),
      outlineListItem(["item 3"])
    ).outerHTML;
    expect(editor.getHTML()).toBe(expectedHTML);
  });

  test("move outline list item down", async () => {
    const el = outlineList(
      outlineListItem(["item 1"]),
      outlineListItem(["item 2"]),
      outlineListItem(["item 3"])
    );
    const editorElement = h("div");
    const { editor } = createEditor({
      element: editorElement,
      initialContent: el.outerHTML,
      extensions: {
        KeyMap: KeyMap,
        outlineList: OutlineList,
        outlineListItem: OutlineListItem
      }
    });

    editor.commands.setTextSelection(0);
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true
    });
    editor.view.dom.dispatchEvent(event);

    const expectedHTML = outlineList(
      outlineListItem(["item 2"]),
      outlineListItem(["item 1"]),
      outlineListItem(["item 3"])
    ).outerHTML;
    expect(editor.getHTML()).toBe(expectedHTML);
  });

  test("move entire bullet list down", async () => {
    const el = h("div", [
      p(["para 1"]),
      ul([li([p(["list item 1"])]), li([p(["list item 2"])])]),
      p(["para 2"])
    ]);
    const editorElement = h("div");
    const { editor } = createEditor({
      element: editorElement,
      initialContent: el.innerHTML,
      extensions: {
        KeyMap: KeyMap,
        bulletList: BulletList,
        listItem: ListItem
      }
    });

    editor.commands.setTextSelection({ from: 10, to: 10 });
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true
    });
    editor.view.dom.dispatchEvent(event);

    expect(editor.getHTML()).toBe(
      `<p>para 1</p><p>para 2</p><ul><li><p>list item 1</p></li><li><p>list item 2</p></li></ul>`
    );
  });

  test("clearing collapsed heading should clear heading and unhide content", async () => {
    const el = h("div", [
      h("h1", ["Collapsed heading"], { "data-collapsed": "true" }),
      p(["Hidden content"], { "data-hidden": "true" })
    ]);
    const editorElement = h("div");
    const { editor } = createEditor({
      element: editorElement,
      initialContent: el.innerHTML,
      extensions: {
        KeyMap: KeyMap,
        Heading: Heading.configure({ levels: [1, 2, 3, 4, 5, 6] })
      }
    });

    editor.commands.setTextSelection(5);
    const event = new KeyboardEvent("keydown", {
      key: "l",
      ctrlKey: true
    });
    editor.view.dom.dispatchEvent(event);

    expect(editor.getHTML()).toBe(`<p>Hidden content</p>`);
  });
});

/**
 * The internal-link shortcut (`Mod-Shift-K`) now routes through the shared
 * `insertInternalLink` command instead of an inline `createInternalLink().then`.
 * These tests dispatch a *real* `KeyboardEvent` on the real ProseMirror view —
 * exactly like the pre-existing key-map tests — and assert the same safety
 * guards the other entry points already have. `Mod` resolves to Ctrl in this
 * (non-Mac) happy-dom environment, matching the existing `Mod-l` test above.
 */
describe("key-map — internal link shortcut (Mod-Shift-K)", () => {
  function createInternalLinkEditor(
    content: string,
    picker?: (
      attributes?: LinkAttributes
    ) => Promise<LinkAttributes | undefined>
  ) {
    const editorElement = h("div");
    const { editor } = createEditor({
      element: editorElement,
      initialContent: content,
      extensions: {
        KeyMap: KeyMap,
        link: Link
      }
    });
    if (picker)
      (editor.storage as Record<string, unknown>).createInternalLink = picker;
    return editor;
  }

  function pressInsertInternalLink(editor: TiptapEditor) {
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "K",
        code: "KeyK",
        ctrlKey: true,
        shiftKey: true
      })
    );
  }

  /** Flush the fire-and-forget async command started by the shortcut. */
  async function flushAsync() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("links the selected text through the host picker and preserves it", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/abc"
    }));
    const editor = createInternalLinkEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });

    pressInsertInternalLink(editor);
    await flushAsync();

    expect(picker).toHaveBeenCalledTimes(1);
    // The shortcut creates a new link from the live selection: no prefill.
    expect(picker.mock.calls[0][0]).toBeUndefined();
    const html = editor.getHTML();
    expect(html).toContain("<a");
    expect(html).toContain('href="nn://note/abc"');
    expect(html).toContain('title="hello"');
    expect(html).toContain(">hello</a>");
    // Highest-risk regression: no duplicated / shifted text.
    expect(editor.getText()).toBe("hello world");
    editor.destroy();
  });

  test("does not mutate the document when the picker is canceled", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => undefined);
    const editor = createInternalLinkEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const before = editor.getHTML();

    pressInsertInternalLink(editor);
    await flushAsync();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(editor.getHTML()).toBe(before);
    expect(editor.getHTML()).not.toContain("<a");
    editor.destroy();
  });

  test("is a no-op while the editor is readonly", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/abc"
    }));
    const editor = createInternalLinkEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.setEditable(false);

    pressInsertInternalLink(editor);
    await flushAsync();

    expect(picker).not.toHaveBeenCalled();
    expect(editor.getHTML()).not.toContain("<a");
    editor.destroy();
  });

  test("bails out when the document changed while the picker is open", async () => {
    let resolve!: (value: LinkAttributes | undefined) => void;
    const gate = new Promise<LinkAttributes | undefined>((r) => {
      resolve = r;
    });
    const picker = vi.fn(() => gate);
    const editor = createInternalLinkEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });

    pressInsertInternalLink(editor);
    // The picker is still open; the user edits the note before confirming.
    editor.commands.insertContent("X");
    resolve({ href: "nn://note/abc" });
    await flushAsync();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(editor.getHTML()).not.toContain("<a");
    editor.destroy();
  });

  test("stores the host href verbatim, including veyran:// aliases", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "veyran://note/abc"
    }));
    const editor = createInternalLinkEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });

    pressInsertInternalLink(editor);
    await flushAsync();

    // No URI is invented: the exact host-produced href is what lands in the doc.
    const html = editor.getHTML();
    expect(html).toContain('href="veyran://note/abc"');
    expect(html).toContain(">hello</a>");
    expect(html).not.toContain("nn://");
    expect(editor.getText()).toBe("hello world");
    editor.destroy();
  });
});
