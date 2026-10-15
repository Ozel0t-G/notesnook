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
 * Focused coverage for `showLinkPopup`'s internal-link branch.
 *
 * Exercised for real:
 * - the real `showLinkPopup` command (the branch decision + the shared
 *   `insertInternalLink` call), against a real `@tiptap/starter-kit` + `Link`
 *   editor with a real host picker (`editor.storage.createInternalLink`);
 * - the resulting document, its serialization/reopen round-trip and the
 *   restored selection;
 * - the `isInternalLink` predicate used by `EditLink` to route internal links.
 *
 * Bounded seams (deliberately mocked, and NOT claimed to be full runtime):
 * - `showPopup` (the confirmation presenter leaf) is a `vi.fn`, so the external
 *   branch can be observed without mounting the responsive popup portal. The
 *   `LinkPopup` element it produces is inspected (not rendered) to prove the
 *   link is only applied on `onDone` confirmation.
 * - `Popup` and `@notesnook/intl` are leaf seams of `LinkPopup` itself: the
 *   presenters are never rendered here and the lingui catalog is not built in
 *   this vitest setup. Neither is involved in the internal-branch logic.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor } from "@tiptap/core";
import type { ReactElement } from "react";
import { Link } from "../../../extensions/link/index.js";
import { showLinkPopup, LinkPopup } from "../link-popup.js";
import { isInternalLink } from "../../tools/link.js";
import { showPopup } from "../../../components/popup-presenter/index.js";
import type { LinkAttributes } from "../../../extensions/link/index.js";
import type { LinkDefinition } from "../../tools/link.js";

vi.mock("../../../components/popup-presenter/index.js", () => ({
  showPopup: vi.fn(),
  PopupWrapper: (props: { children?: unknown }) => props.children ?? null
}));

vi.mock("../../components/popup.js", () => ({
  Popup: (props: { children?: unknown }) => props.children ?? null
}));

vi.mock("@notesnook/intl", () => {
  const strings = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        return () => `intl:${key}`;
      }
    }
  );
  return { strings };
});

function makeEditor(
  content: string,
  picker?: (
    attributes?: LinkAttributes
  ) => Promise<LinkAttributes | undefined>
) {
  const editor = new TiptapEditor({ extensions: [StarterKit, Link], content });
  if (picker)
    (editor.storage as Record<string, unknown>).createInternalLink = picker;
  return editor;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("showLinkPopup — internal link branch", () => {
  test("applies the picker result to the hovered internal link (nn://) and restores the selection", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/new"
    }));
    const editor = makeEditor(
      '<p><a href="nn://note/old" title="hello">hello</a> world</p>',
      picker
    );
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(editor.isActive(Link.name)).toBe(true);

    await showLinkPopup(editor);

    // The host picker receives the existing internal-link attributes...
    expect(picker).toHaveBeenCalledTimes(1);
    const forwarded = picker.mock.calls[0][0] as LinkAttributes | undefined;
    expect(forwarded?.href).toBe("nn://note/old");

    // ...and the new href is applied without duplicating or shifting the text.
    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="nn://note/new"');
    expect(html).toContain(">hello</a> world");
    expect(editor.getText()).toBe("hello world");
    // The pre-existing (hovered) selection is restored.
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    // No confirmation presenter is used for the internal branch.
    expect(showPopup).not.toHaveBeenCalled();

    editor.destroy();
  });

  test("treats veyran:// as internal and keeps the link across serialization/reopen", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "veyran://note/new"
    }));
    const editor = makeEditor(
      '<p><a href="veyran://note/old" title="hello">hello</a> world</p>',
      picker
    );
    editor.commands.setTextSelection({ from: 1, to: 6 });

    await showLinkPopup(editor);

    expect(picker).toHaveBeenCalledTimes(1);
    expect((picker.mock.calls[0][0] as LinkAttributes | undefined)?.href).toBe(
      "veyran://note/old"
    );
    const html = editor.getHTML();
    expect(html).toContain('href="veyran://note/new"');
    expect(html).toContain(">hello</a> world");
    expect(showPopup).not.toHaveBeenCalled();
    editor.destroy();

    // The serialized link survives a reopen unchanged.
    const reopened = new TiptapEditor({
      extensions: [StarterKit, Link],
      content: html
    });
    expect(reopened.getHTML()).toContain('href="veyran://note/new"');
    expect(reopened.getText()).toBe("hello world");
    reopened.destroy();
  });
});

describe("showLinkPopup — external link branch", () => {
  test("opens the confirmation presenter without immediately mutating the document", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/abc"
    }));
    const editor = makeEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const before = editor.getHTML();

    await showLinkPopup(editor);

    // The internal picker must not be consulted for a plain text selection.
    expect(picker).not.toHaveBeenCalled();
    expect(showPopup).toHaveBeenCalledTimes(1);
    // Nothing is written until the user confirms in the presenter.
    expect(editor.getHTML()).toBe(before);
    expect(editor.getHTML()).not.toContain("<a");

    const options = vi.mocked(showPopup).mock.calls[0][0];
    expect(options.mobile).toBe("sheet");
    expect(options.desktop).toBe("popup");

    // The presenter produces a LinkPopup whose `onDone` is the only path that
    // applies the link (confirmation, not eager mutation).
    const close = vi.fn();
    const element = options.popup(close) as unknown as ReactElement<{
      onDone?: (link: LinkDefinition) => void;
    }>;
    expect(element.type).toBe(LinkPopup);
    expect(typeof element.props.onDone).toBe("function");

    editor.destroy();
  });

  test("rejects external http(s) links from the internal branch", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/abc"
    }));
    const editor = makeEditor(
      '<p><a href="https://example.com" title="hello">hello</a></p>',
      picker
    );
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const before = editor.getHTML();

    await showLinkPopup(editor);

    expect(picker).not.toHaveBeenCalled();
    expect(showPopup).toHaveBeenCalledTimes(1);
    expect(editor.getHTML()).toBe(before);
    expect(editor.getHTML()).toContain('href="https://example.com"');

    editor.destroy();
  });
});

describe("isInternalLink — protocol aliases", () => {
  test("accepts nn:// and veyran:// case-insensitively and rejects external URLs", () => {
    expect(isInternalLink("nn://note/abc")).toBe(true);
    expect(isInternalLink("NN://note/abc")).toBe(true);
    expect(isInternalLink("veyran://note/abc")).toBe(true);
    expect(isInternalLink("VEYRAN://note/abc")).toBe(true);
    expect(isInternalLink("https://example.com")).toBe(false);
    expect(isInternalLink("http://example.com")).toBe(false);
    expect(isInternalLink("")).toBe(false);
    expect(isInternalLink(undefined)).toBe(false);
    expect(isInternalLink(null)).toBe(false);
  });
});
