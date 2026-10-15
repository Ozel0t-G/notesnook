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

import { afterEach, describe, expect, test, vi } from "vitest";
import { Editor as TiptapEditor, getMarkAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { NodeSelection } from "@tiptap/pm/state";
import {
  insertInternalLink,
  resolveActiveInternalLinkRange
} from "../internal-link-command.js";
import { isInternalLink } from "../link.js";
import { Link } from "../../../extensions/link/index.js";
import { ImageNode } from "../../../extensions/image/index.js";
import { selectionToOffset } from "../../../utils/prosemirror.js";
import type { LinkAttributes } from "../../../extensions/link/index.js";
import type { Editor } from "../../../types.js";

const DOC_SIZE = 100;

/**
 * The exact link extension the shipping editor builds (`index.ts`): the base
 * extension's `inclusive()` would follow `autolink` and become `false`, so the
 * mark is forced inclusive and autolink is disabled, matching production.
 * Tests must exercise this configuration — the default `Link` changes real
 * boundary/`getMarkAttributes` behaviour.
 */
const productionLink = () =>
  Link.extend({ inclusive: true }).configure({
    autolink: false,
    openOnClick: false,
    linkOnPaste: true,
    protocols: [{ scheme: "nn" }]
  });

/**
 * Every editor created by a test is tracked here so the fixture can destroy it
 * even when an assertion throws halfway through, preventing leaked headless
 * views and late `DOMObserver` errors. Already-destroyed editors are skipped.
 */
const openEditors: TiptapEditor[] = [];
function track<T extends TiptapEditor>(editor: T): T {
  openEditors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of openEditors) if (!editor.isDestroyed) editor.destroy();
  openEditors.length = 0;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Minimal stand-in for a ProseMirror selection: only the bookkeeping
 * `insertInternalLink` needs (a bookmark that resolves back to the same
 * selection, mirroring how the real command preserves the selection *type*).
 */
type FakeSelection = {
  from: number;
  to: number;
  getBookmark(): { resolve(doc: unknown): FakeSelection };
};

function fakeSelection(from: number, to: number): FakeSelection {
  const selection: FakeSelection = {
    from,
    to,
    getBookmark: () => ({ resolve: () => selection })
  };
  return selection;
}

/**
 * Minimal hand-rolled editor double that records exactly which commands
 * `insertInternalLink` invokes. Keeps the guard/mutation matrix independent
 * from real tiptap chain internals.
 *
 * The chain mirrors the real one: `command` callbacks are queued and executed
 * against the chain's transaction on `run()`, so committing the captured
 * selection through `tr.setSelection` is observable.
 */
function fakeEditor(options: {
  picker?: (attributes?: LinkAttributes) => Promise<LinkAttributes | undefined>;
  text?: string;
  selection?: { from: number; to: number };
  isDestroyed?: boolean;
  isEditable?: boolean;
  noStorage?: boolean;
}) {
  const linkCalls: LinkAttributes[] = [];
  const chainLinkCalls: LinkAttributes[] = [];
  const chainSelectionCalls: { from: number; to: number }[] = [];
  /** Selections committed through the chain's `command` + `tr.setSelection`. */
  const committedSelections: FakeSelection[] = [];
  let runCalls = 0;

  type FakeTr = {
    doc: unknown;
    selection: FakeSelection;
    setSelection(selection: FakeSelection): FakeTr;
  };

  const selection = fakeSelection(
    options.selection?.from ?? 1,
    options.selection?.to ?? 6
  );
  const doc = {
    content: { size: DOC_SIZE },
    textBetween: vi.fn(() => options.text ?? "hello")
  };
  const tr: FakeTr = {
    doc,
    selection,
    setSelection(next) {
      committedSelections.push(next);
      tr.selection = next;
      return tr;
    }
  };

  function createChainable() {
    const pending: ((props: { tr: FakeTr }) => boolean)[] = [];
    const chainable: Record<string, unknown> = {};
    chainable.focus = () => chainable;
    chainable.setTextSelection = (range: { from: number; to: number }) => {
      chainSelectionCalls.push(range);
      return chainable;
    };
    chainable.command = (fn: (props: { tr: FakeTr }) => boolean) => {
      pending.push(fn);
      return chainable;
    };
    chainable.setLink = (attributes: LinkAttributes) => {
      chainLinkCalls.push(attributes);
      return chainable;
    };
    chainable.run = () => {
      runCalls++;
      for (const fn of pending) fn({ tr });
      return true;
    };
    return chainable;
  }

  const picker = options.picker;
  const setLinkCommand = vi.fn((attributes: LinkAttributes) => {
    linkCalls.push(attributes);
    return true;
  });
  const chain = vi.fn(() => createChainable());

  const editor = {
    isDestroyed: options.isDestroyed ?? false,
    isEditable: options.isEditable ?? true,
    storage: options.noStorage ? {} : { createInternalLink: picker },
    state: { doc, selection },
    chain,
    commands: {
      setLink: setLinkCommand
    }
  };

  return {
    editor: editor as unknown as Editor,
    raw: editor,
    doc,
    selection,
    picker,
    chain,
    linkCalls,
    chainLinkCalls,
    chainSelectionCalls,
    committedSelections,
    setLinkCommand,
    getRunCalls: () => runCalls
  };
}

describe("insertInternalLink — guard matrix", () => {
  test("is a no-op without an editor", async () => {
    await expect(insertInternalLink(undefined)).resolves.toBeUndefined();
  });

  test("is a no-op when the editor is destroyed", async () => {
    const picker = vi.fn(async () => ({ href: "nn://note/abc" }));
    const { editor, chain } = fakeEditor({ picker, isDestroyed: true });
    await expect(insertInternalLink(editor)).resolves.toBeUndefined();
    expect(picker).not.toHaveBeenCalled();
    expect(chain).not.toHaveBeenCalled();
  });

  test("is a no-op when the editor is readonly", async () => {
    const picker = vi.fn(async () => ({ href: "nn://note/abc" }));
    const { editor, chain } = fakeEditor({ picker, isEditable: false });
    await expect(insertInternalLink(editor)).resolves.toBeUndefined();
    expect(picker).not.toHaveBeenCalled();
    expect(chain).not.toHaveBeenCalled();
  });

  test("is a no-op when the host did not provide a picker", async () => {
    const { editor, chain } = fakeEditor({ noStorage: true });
    await expect(insertInternalLink(editor)).resolves.toBeUndefined();
    expect(chain).not.toHaveBeenCalled();
  });
});

describe("insertInternalLink — range validation", () => {
  const invalidRanges = [
    { from: -1, to: 2 },
    { from: 5, to: 2 },
    { from: 0, to: DOC_SIZE + 5 }
  ];

  test.each(invalidRanges)(
    "rejects out-of-bounds range %j before asking the host",
    async (range) => {
      const picker = vi.fn(async () => ({ href: "nn://note/abc" }));
      const { editor, chain } = fakeEditor({ picker });
      await expect(
        insertInternalLink(editor, { range })
      ).resolves.toBeUndefined();
      expect(picker).not.toHaveBeenCalled();
      expect(chain).not.toHaveBeenCalled();
    }
  );
});

describe("insertInternalLink — capture & forwarding", () => {
  test("forwards options.attributes to the host picker by identity", async () => {
    const returned: LinkAttributes = { href: "nn://note/abc" };
    const picker = vi.fn(async () => returned);
    const {
      editor,
      linkCalls,
      chainLinkCalls,
      setLinkCommand,
      selection,
      committedSelections
    } = fakeEditor({
      picker,
      text: "hello"
    });
    const attributes: LinkAttributes = {
      href: "nn://note/old",
      title: "Old"
    };

    const result = await insertInternalLink(editor, { attributes });

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0][0]).toBe(attributes);
    expect(result).toBe(returned);
    // The link is applied through `editor.commands.setLink` (a committed
    // command) so the extension sees the committed captured selection, which is
    // committed first as its own step.
    expect(setLinkCommand).toHaveBeenCalledTimes(1);
    expect(chainLinkCalls).toEqual([]);
    expect(selection.from).toBe(1);
    expect(selection.to).toBe(6);
    expect(committedSelections).toEqual([selection]);
    // Selected text wins over the host-provided title.
    expect(linkCalls).toEqual([{ href: "nn://note/abc", title: "hello" }]);
  });

  test("applies the captured range and restores the previous selection", async () => {
    const returned: LinkAttributes = { href: "nn://note/abc" };
    const picker = vi.fn(async () => returned);
    const {
      editor,
      doc,
      selection,
      chainSelectionCalls,
      committedSelections,
      setLinkCommand
    } = fakeEditor({
      picker,
      text: "hello",
      selection: { from: 20, to: 25 }
    });

    await insertInternalLink(editor, { range: { from: 1, to: 6 } });

    expect(doc.textBetween).toHaveBeenCalledWith(1, 6);
    // The explicit hovered range is committed as a text range, in its own chain
    // step, and the link command runs after it.
    expect(chainSelectionCalls).toEqual([{ from: 1, to: 6 }]);
    expect(setLinkCommand).toHaveBeenCalledTimes(1);
    // ...then the user's previous selection is restored, as it was.
    expect(committedSelections).toEqual([selection]);
    expect(selection.from).toBe(20);
    expect(selection.to).toBe(25);
  });

  test("does not restore any selection when no explicit range was given", async () => {
    const picker = vi.fn(async () => ({ href: "nn://note/abc" }));
    const { editor, selection, chainSelectionCalls, committedSelections } =
      fakeEditor({
        picker,
        text: "hello",
        selection: { from: 1, to: 6 }
      });

    await insertInternalLink(editor);

    // Creation keeps the live selection (no text range re-creation) and does
    // not move the caret afterwards.
    expect(chainSelectionCalls).toEqual([]);
    expect(committedSelections).toEqual([selection]);
    expect(selection.from).toBe(1);
    expect(selection.to).toBe(6);
  });

  const validHrefs = [
    "nn://note/abc",
    "veyran://note/abc",
    "veyran://note/x?blockId=block-1",
    "nn://note/abc?blockId=block-1"
  ];

  test.each(validHrefs)(
    "applies a valid host uri verbatim (%s)",
    async (href) => {
      const returned: LinkAttributes = { href };
      const picker = vi.fn(async () => returned);
      const { editor, linkCalls, setLinkCommand } = fakeEditor({
        picker,
        text: "hello"
      });

      const result = await insertInternalLink(editor);

      expect(result).toBe(returned);
      expect(setLinkCommand).toHaveBeenCalledTimes(1);
      expect(linkCalls).toEqual([{ href, title: "hello" }]);
    }
  );
});

describe("insertInternalLink — no mutation when cancelled or stale", () => {
  test("does nothing when the picker resolves to nothing", async () => {
    const picker = vi.fn(async () => undefined);
    const { editor, chain, getRunCalls, committedSelections } = fakeEditor({
      picker
    });

    await expect(insertInternalLink(editor)).resolves.toBeUndefined();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
    expect(getRunCalls()).toBe(0);
    expect(committedSelections).toEqual([]);
  });

  test("treats a rejected picker as a cancel", async () => {
    const picker = vi.fn(() => Promise.reject(new Error("picker failed")));
    const {
      editor,
      chain,
      getRunCalls,
      committedSelections,
      linkCalls,
      chainLinkCalls,
      chainSelectionCalls,
      setLinkCommand
    } = fakeEditor({ picker });

    await expect(insertInternalLink(editor)).resolves.toBeUndefined();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
    expect(getRunCalls()).toBe(0);
    expect(committedSelections).toEqual([]);
    expect(chainSelectionCalls).toEqual([]);
    expect(linkCalls).toEqual([]);
    expect(chainLinkCalls).toEqual([]);
    expect(setLinkCommand).not.toHaveBeenCalled();
  });

  test("treats a synchronously throwing picker as a cancel", async () => {
    // The picker throws before returning a promise, so a `.catch()` on the
    // returned promise would not help: only awaiting inside a try does.
    const picker = vi.fn((): Promise<LinkAttributes | undefined> => {
      throw new Error("picker threw");
    });
    const {
      editor,
      chain,
      getRunCalls,
      committedSelections,
      linkCalls,
      chainSelectionCalls,
      setLinkCommand
    } = fakeEditor({ picker });

    await expect(insertInternalLink(editor)).resolves.toBeUndefined();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
    expect(getRunCalls()).toBe(0);
    expect(committedSelections).toEqual([]);
    expect(chainSelectionCalls).toEqual([]);
    expect(linkCalls).toEqual([]);
    expect(setLinkCommand).not.toHaveBeenCalled();
  });

  const invalidPickerResults: LinkAttributes[] = [
    {} as LinkAttributes,
    { href: "" },
    { href: null } as unknown as LinkAttributes,
    { href: "", title: "not-a-link" } as LinkAttributes
  ];

  test.each(invalidPickerResults)(
    "ignores a truthy but unusable picker result %j",
    async (result) => {
      const picker = vi.fn(async () => result);
      const {
        editor,
        chain,
        getRunCalls,
        committedSelections,
        linkCalls,
        chainLinkCalls,
        chainSelectionCalls,
        setLinkCommand
      } = fakeEditor({ picker });

      await expect(insertInternalLink(editor)).resolves.toBeUndefined();

      expect(picker).toHaveBeenCalledTimes(1);
      expect(chain).not.toHaveBeenCalled();
      expect(getRunCalls()).toBe(0);
      expect(committedSelections).toEqual([]);
      expect(chainSelectionCalls).toEqual([]);
      expect(linkCalls).toEqual([]);
      expect(chainLinkCalls).toEqual([]);
      expect(setLinkCommand).not.toHaveBeenCalled();
    }
  );

  test("does not swallow errors raised after a valid picker result", async () => {
    // The catch must be scoped to the picker await: a failing link command is a
    // programming error and must still reject.
    const picker = vi.fn(async () => ({ href: "nn://note/abc" }));
    const { editor, raw } = fakeEditor({ picker });
    raw.commands.setLink = () => {
      throw new Error("setLink boom");
    };

    await expect(insertInternalLink(editor)).rejects.toThrow("setLink boom");
  });

  test("restores the previous selection when setLink refuses an explicit range", async () => {
    // A refused link command (the schema/document rejects the mark at that
    // range) must not leave the user's selection stuck on the hovered or
    // selection derived range the command was asked to edit.
    const picker = vi.fn(async () => ({ href: "nn://note/abc" }));
    const { editor, raw, selection, chainSelectionCalls, committedSelections } =
      fakeEditor({ picker, text: "hello", selection: { from: 20, to: 25 } });
    raw.commands.setLink = () => false;

    await expect(
      insertInternalLink(editor, { range: { from: 1, to: 6 } })
    ).resolves.toBeUndefined();

    expect(picker).toHaveBeenCalledTimes(1);
    // The explicit range was committed for `setLink`...
    expect(chainSelectionCalls).toEqual([{ from: 1, to: 6 }]);
    // ...and the user's own selection is restored after the refusal.
    expect(committedSelections).toEqual([selection]);
    expect(selection.from).toBe(20);
    expect(selection.to).toBe(25);
  });

  test("keeps the creation caret when setLink refuses (no explicit range)", async () => {
    const picker = vi.fn(async () => ({ href: "nn://note/abc" }));
    const { editor, raw, selection, committedSelections } = fakeEditor({
      picker
    });
    raw.commands.setLink = () => false;

    await expect(insertInternalLink(editor)).resolves.toBeUndefined();

    // Only the pre-`setLink` commit of the captured selection, no restore: the
    // creation path keeps `setLink`'s own caret handling.
    expect(committedSelections).toEqual([selection]);
  });

  test("bails out when the editor is destroyed while the picker is open", async () => {
    const gate = deferred<LinkAttributes | undefined>();
    const picker = vi.fn(() => gate.promise);
    const { editor, raw, chain, getRunCalls } = fakeEditor({ picker });

    const pending = insertInternalLink(editor);
    raw.isDestroyed = true;
    gate.resolve({ href: "nn://note/abc" });

    await expect(pending).resolves.toBeUndefined();
    expect(chain).not.toHaveBeenCalled();
    expect(getRunCalls()).toBe(0);
  });

  test("bails out when the editor becomes readonly while the picker is open", async () => {
    const gate = deferred<LinkAttributes | undefined>();
    const picker = vi.fn(() => gate.promise);
    const { editor, raw, chain, getRunCalls } = fakeEditor({ picker });

    const pending = insertInternalLink(editor);
    raw.isEditable = false;
    gate.resolve({ href: "nn://note/abc" });

    await expect(pending).resolves.toBeUndefined();
    expect(chain).not.toHaveBeenCalled();
    expect(getRunCalls()).toBe(0);
  });

  test("bails out when the document changed while the picker is open", async () => {
    const gate = deferred<LinkAttributes | undefined>();
    const picker = vi.fn(() => gate.promise);
    const { editor, raw, chain, getRunCalls, committedSelections } =
      fakeEditor({ picker });

    const pending = insertInternalLink(editor);
    raw.state = {
      doc: { content: { size: DOC_SIZE }, textBetween: vi.fn(() => "hello") },
      selection: { from: 1, to: 6 }
    };
    gate.resolve({ href: "nn://note/abc" });

    await expect(pending).resolves.toBeUndefined();
    expect(chain).not.toHaveBeenCalled();
    expect(getRunCalls()).toBe(0);
    expect(committedSelections).toEqual([]);
  });
});

describe("insertInternalLink — real editor (StarterKit + Link)", () => {
  function createEditor(
    content: string | Record<string, unknown>,
    internalLink?: () => Promise<LinkAttributes | undefined>
  ) {
    const editor = track(
      new TiptapEditor({
        extensions: [StarterKit, productionLink()],
        content
      })
    );
    if (internalLink)
      (editor.storage as Record<string, unknown>).createInternalLink =
        internalLink;
    return editor;
  }

  test("pins the production link configuration (inclusive, autolink off)", () => {
    // Guards the boundary contract the resolver relies on: `.extend({
    // inclusive: true })` must actually win over `inclusive()` returning
    // `options.autolink` (which production disables).
    const editor = createEditor("<p>hello</p>");
    expect(editor.schema.marks.link.spec.inclusive).toBe(true);
    const link = editor.extensionManager.extensions.find(
      (extension) => extension.name === Link.name
    );
    expect(link?.options.autolink).toBe(false);
    expect(link?.options.linkOnPaste).toBe(true);
  });

  test("applies the picker result as a nn:// link without altering the text", async () => {
    const editor = createEditor("<p>hello world</p>", async () => ({
      href: "nn://note/abc"
    }));
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const result = await insertInternalLink(editor as unknown as Editor);

    expect(result).toEqual({ href: "nn://note/abc" });
    const html = editor.getHTML();
    expect(html).toContain("<a");
    expect(html).toContain('href="nn://note/abc"');
    expect(html).toContain('title="hello"');
    expect(html).toContain(">hello</a>");
    // Highest-risk regression: no duplicated / shifted text.
    expect(editor.getText()).toBe("hello world");
    editor.destroy();
  });

  test("serialized link survives serialization + reopen", async () => {
    const editor = createEditor("<p>hello world</p>", async () => ({
      href: "nn://note/abc"
    }));
    editor.commands.setTextSelection({ from: 1, to: 6 });
    await insertInternalLink(editor as unknown as Editor);
    const html = editor.getHTML();
    editor.destroy();

    const reopened = track(
      new TiptapEditor({
        extensions: [StarterKit, productionLink()],
        content: html
      })
    );
    expect(reopened.getHTML()).toContain('href="nn://note/abc"');
    expect(reopened.getHTML()).toContain(">hello</a>");
    expect(reopened.getText()).toBe("hello world");
    reopened.destroy();
  });

  test("unsetLink removes the applied internal link", async () => {
    const editor = createEditor("<p>hello world</p>", async () => ({
      href: "nn://note/abc"
    }));
    editor.commands.setTextSelection({ from: 1, to: 6 });
    await insertInternalLink(editor as unknown as Editor);
    expect(editor.getHTML()).toContain("<a");

    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.unsetLink();

    expect(editor.getHTML()).not.toContain("<a");
    expect(editor.getText()).toBe("hello world");
    editor.destroy();
  });

  test("updates the href of a hovered linked range while the live caret is outside it", async () => {
    // Regression: `setLink` reads the *committed* selection. Editing a hovered
    // link passes an explicit `range`, but the live caret is somewhere else —
    // a single chain made the extension act on the stale caret and mangle the
    // surrounding text (duplicated word / extra space).
    const editor = createEditor(
      '<p><a href="nn://note/old" title="hello">hello</a> world</p>',
      async () => ({ href: "nn://note/abc" })
    );
    // Live caret at the end of " world" (position 12), i.e. outside the link.
    editor.commands.setTextSelection({ from: 12, to: 12 });
    expect(editor.state.selection.empty).toBe(true);

    const result = await insertInternalLink(editor as unknown as Editor, {
      attributes: { href: "nn://note/old", title: "hello" },
      range: { from: 1, to: 6 }
    });

    expect(result).toEqual({ href: "nn://note/abc" });
    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="nn://note/abc"');
    expect(html).toContain(">hello</a> world");
    // Every character is preserved: no duplicated word and no stray space.
    expect(editor.getText()).toBe("hello world");
    expect(editor.getText()).toHaveLength("hello world".length);
    // The caret is restored to where the user actually was.
    expect(editor.state.selection.from).toBe(12);
    expect(editor.state.selection.to).toBe(12);
    editor.destroy();
  });

  test("applies to the captured range when the caret drifts while the picker is open", async () => {
    // Regression: a selection-only change (same document) must not redirect
    // the pending link or inject text next to the drifted caret.
    const gate = deferred<LinkAttributes | undefined>();
    const editor = createEditor("<p>hello world</p>", () => gate.promise);

    // Live caret at the end of the paragraph, outside the captured range.
    editor.commands.setTextSelection({ from: 12, to: 12 });
    const pending = insertInternalLink(editor as unknown as Editor, {
      range: { from: 1, to: 6 }
    });

    // Selection-only drift: same doc instance, different caret.
    const docBefore = editor.state.doc;
    editor.commands.setTextSelection({ from: 8, to: 8 });
    expect(editor.state.doc).toBe(docBefore);

    gate.resolve({ href: "nn://note/abc" });
    await expect(pending).resolves.toEqual({ href: "nn://note/abc" });

    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="nn://note/abc"');
    expect(html).toContain(">hello</a> world");
    // Nothing was inserted next to the drifted caret (position 8).
    expect(editor.getText()).toBe("hello world");
    // The captured previous selection is restored, not the drifted caret.
    expect(editor.state.selection.from).toBe(12);
    expect(editor.state.selection.to).toBe(12);
    editor.destroy();
  });

  test("treats a rejected picker as a cancel", async () => {
    const editor = createEditor("<p>hello world</p>", () =>
      Promise.reject(new Error("picker failed"))
    );
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const htmlBefore = editor.getHTML();
    const jsonBefore = editor.getJSON();
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };

    await expect(
      insertInternalLink(editor as unknown as Editor)
    ).resolves.toBeUndefined();

    expect(editor.getHTML()).toBe(htmlBefore);
    expect(editor.getJSON()).toEqual(jsonBefore);
    expect(editor.getHTML()).not.toContain("<a");
    expect(editor.getText()).toBe("hello world");
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);
    editor.destroy();
  });

  test("treats a synchronously throwing picker as a cancel", async () => {
    const editor = createEditor(
      "<p>hello world</p>",
      (): Promise<LinkAttributes | undefined> => {
        throw new Error("picker threw");
      }
    );
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const htmlBefore = editor.getHTML();

    await expect(
      insertInternalLink(editor as unknown as Editor)
    ).resolves.toBeUndefined();

    expect(editor.getHTML()).toBe(htmlBefore);
    expect(editor.getHTML()).not.toContain("<a");
    expect(editor.getText()).toBe("hello world");
    editor.destroy();
  });

  const invalidResults: LinkAttributes[] = [
    {} as LinkAttributes,
    { href: "" }
  ];

  test.each(invalidResults)(
    "ignores a truthy but unusable picker result %j",
    async (result) => {
      const editor = createEditor("<p>hello world</p>", async () => result);
      editor.commands.setTextSelection({ from: 1, to: 6 });
      const htmlBefore = editor.getHTML();
      const jsonBefore = editor.getJSON();
      const selectionBefore = {
        from: editor.state.selection.from,
        to: editor.state.selection.to
      };

      await expect(
        insertInternalLink(editor as unknown as Editor)
      ).resolves.toBeUndefined();

      expect(editor.getHTML()).toBe(htmlBefore);
      expect(editor.getJSON()).toEqual(jsonBefore);
      expect(editor.getHTML()).not.toContain("<a");
      expect(editor.getText()).toBe("hello world");
      expect(editor.state.selection.from).toBe(selectionBefore.from);
      expect(editor.state.selection.to).toBe(selectionBefore.to);
      editor.destroy();
    }
  );

  test("applies a veyran:// picker result verbatim", async () => {
    const editor = createEditor("<p>hello world</p>", async () => ({
      href: "veyran://note/abc"
    }));
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const result = await insertInternalLink(editor as unknown as Editor);

    expect(result).toEqual({ href: "veyran://note/abc" });
    expect(editor.getHTML()).toContain('href="veyran://note/abc"');
    expect(editor.getHTML()).toContain(">hello</a>");
    expect(editor.getText()).toBe("hello world");
    editor.destroy();
  });
});

describe("insertInternalLink — real editor with a selected image node", () => {
  const IMAGE_HTML =
    '<img src="attachment://image-1.png" data-hash="hash-1" data-mime="image/png" width="120" height="80">';
  const PICKER_RESULT: LinkAttributes = {
    href: "nn://note/abc",
    title: "should-not-stick-to-the-image"
  };

  const placements: [string, string][] = [
    ["start of the document", `${IMAGE_HTML}<p>hello world</p>`],
    [
      "middle of the document",
      `<p>hello world</p>${IMAGE_HTML}<p>second paragraph</p>`
    ],
    ["end of the document", `<p>hello world</p>${IMAGE_HTML}`]
  ];

  function createImageEditor(
    content: string,
    internalLink?: () => Promise<LinkAttributes | undefined>
  ) {
    const editor = track(
      new TiptapEditor({
        extensions: [StarterKit, productionLink(), ImageNode],
        content
      })
    );
    if (internalLink)
      (editor.storage as Record<string, unknown>).createInternalLink =
        internalLink;
    return editor;
  }

  function imagePos(editor: TiptapEditor) {
    let pos = -1;
    editor.state.doc.descendants((node, nodePos) => {
      if (pos < 0 && node.type.name === ImageNode.name) pos = nodePos;
    });
    return pos;
  }

  function imageAttrs(editor: TiptapEditor) {
    const pos = imagePos(editor);
    if (pos < 0) return undefined;
    return editor.state.doc.nodeAt(pos)?.attrs;
  }

  function selectImage(editor: TiptapEditor) {
    const pos = imagePos(editor);
    expect(pos).toBeGreaterThanOrEqual(0);
    editor.commands.setNodeSelection(pos);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    return pos;
  }

  /**
   * The image toolbar link (`setLink` with an image node selected) is the
   * pre-existing behaviour to preserve: whatever it does — including doing
   * nothing, because a block image node accepts no marks — the internal-link
   * command must not do anything *different*. No new link format, no wrapping,
   * no schema/attribute change is expected here.
   */
  test.each(placements)(
    "matches a direct setLink on a NodeSelection (%s)",
    async (_label, content) => {
      const baseline = createImageEditor(content);
      selectImage(baseline);
      // `setLink` on a block image NodeSelection is not supported by the schema
      // (a block node accepts no marks); capture whatever the pre-existing
      // command actually returns so the assertion below mirrors it instead of
      // hard-coding a result the baseline never produced.
      const baselineApplied = baseline.commands.setLink(PICKER_RESULT);
      const baselineHTML = baseline.getHTML();
      const baselineJSON = baseline.getJSON();
      const baselineIsNodeSelection =
        baseline.state.selection instanceof NodeSelection;
      const baselineImageAttrs = imageAttrs(baseline);

      const picker = vi.fn(async () => PICKER_RESULT);
      const editor = createImageEditor(content, picker);
      const before = imageAttrs(editor);
      selectImage(editor);

      const result = await insertInternalLink(editor as unknown as Editor);

      expect(picker).toHaveBeenCalledTimes(1);
      // The helper must return exactly what the direct command would have
      // applied: the picker result when the baseline applied, `undefined` when
      // the baseline command refused (block image, no marks).
      expect(result).toEqual(baselineApplied ? PICKER_RESULT : undefined);
      // Same document as the existing direct command.
      expect(editor.getHTML()).toBe(baselineHTML);
      expect(editor.getJSON()).toEqual(baselineJSON);
      expect(editor.state.selection instanceof NodeSelection).toBe(
        baselineIsNodeSelection
      );
      // The image node and its supported attributes are untouched.
      expect(imageAttrs(editor)).toEqual(before);
      expect(imageAttrs(editor)).toEqual(baselineImageAttrs);
      expect(imageAttrs(editor)?.src).toBe("attachment://image-1.png");
      expect(imageAttrs(editor)?.hash).toBe("hash-1");
      expect(imageAttrs(editor)?.mime).toBe("image/png");
      expect(String(imageAttrs(editor)?.width)).toBe("120");
      expect(String(imageAttrs(editor)?.height)).toBe("80");
      // No stray text/space and no title injected.
      expect(editor.getText()).toBe(baseline.getText());
      expect(editor.getText()).not.toContain("should-not-stick-to-the-image");
      expect(editor.getHTML()).not.toContain("should-not-stick-to-the-image");

      baseline.destroy();
      editor.destroy();
    }
  );

  test("keeps the image selection untouched when the picker is canceled", async () => {
    const picker = vi.fn(async () => undefined);
    const editor = createImageEditor(placements[1][1], picker);
    const pos = selectImage(editor);
    const beforeJSON = editor.getJSON();

    await expect(
      insertInternalLink(editor as unknown as Editor)
    ).resolves.toBeUndefined();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(editor.getJSON()).toEqual(beforeJSON);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(pos);
    editor.destroy();
  });

  test("applies the captured image selection when the caret drifts while the picker is open", async () => {
    const content = placements[1][1];
    const baseline = createImageEditor(content);
    selectImage(baseline);
    // Same as above: capture what the direct command actually does on a block
    // image NodeSelection (it refuses) instead of assuming success.
    const baselineApplied = baseline.commands.setLink(PICKER_RESULT);
    const baselineHTML = baseline.getHTML();
    const baselineJSON = baseline.getJSON();
    const baselineIsNodeSelection =
      baseline.state.selection instanceof NodeSelection;
    const baselineImageAttrs = imageAttrs(baseline);

    const gate = deferred<LinkAttributes | undefined>();
    const editor = createImageEditor(content, () => gate.promise);
    const pos = selectImage(editor);
    const pending = insertInternalLink(editor as unknown as Editor);

    // Selection-only drift: same document instance, caret moved into the text.
    const docBefore = editor.state.doc;
    editor.commands.setTextSelection({ from: 3, to: 3 });
    expect(editor.state.doc).toBe(docBefore);

    gate.resolve(PICKER_RESULT);
    await expect(pending).resolves.toEqual(
      baselineApplied ? PICKER_RESULT : undefined
    );

    // The captured image selection was committed, not the drifted caret, and
    // the document is byte-for-byte what the direct command leaves behind.
    expect(editor.getHTML()).toBe(baselineHTML);
    expect(editor.getJSON()).toEqual(baselineJSON);
    expect(editor.state.selection instanceof NodeSelection).toBe(
      baselineIsNodeSelection
    );
    expect(imagePos(editor)).toBe(pos);
    // The image node and its supported attributes are untouched.
    const attrs = imageAttrs(editor);
    expect(attrs).toEqual(baselineImageAttrs);
    expect(attrs?.src).toBe("attachment://image-1.png");
    expect(attrs?.hash).toBe("hash-1");
    expect(attrs?.mime).toBe("image/png");
    expect(String(attrs?.width)).toBe("120");
    expect(String(attrs?.height)).toBe("80");
    expect(editor.getText()).toBe(baseline.getText());

    baseline.destroy();
    editor.destroy();
  });

  test("retains the image when the document is serialized and reopened", async () => {
    const picker = vi.fn(async () => PICKER_RESULT);
    const editor = createImageEditor(placements[0][1], picker);
    selectImage(editor);
    const attrsBefore = imageAttrs(editor);
    const textBefore = editor.getText();

    await insertInternalLink(editor as unknown as Editor);

    const html = editor.getHTML();
    editor.destroy();

    const reopened = track(
      new TiptapEditor({
        extensions: [StarterKit, productionLink(), ImageNode],
        content: html
      })
    );
    const attrsAfter = imageAttrs(reopened);
    expect(reopened.getHTML()).toContain('src="attachment://image-1.png"');
    expect(textBefore).toContain("hello world");
    expect(reopened.getText()).toBe(textBefore);
    expect(attrsAfter).toMatchObject({
      src: attrsBefore?.src,
      hash: "hash-1",
      mime: "image/png"
    });
    expect(String(attrsAfter?.width)).toBe("120");
    expect(String(attrsAfter?.height)).toBe("80");
    reopened.destroy();
  });
});

/**
 * The "normal ending caret" reported from the iPad: inserting a note link with
 * `Insert + -> Link to note -> Beta -> Create` leaves the caret on the plain
 * spacer *after* the link (`<a>Beta</a> `). `EditLink` without a hover popup
 * range then derives its range from `selectionToOffset(editor.state)`, which at
 * that caret is the paragraph start / the spacer — not the link — while
 * `getMarkAttributes` still reports the link. These tests cover the resolution
 * of the link that is actually there, on the real editor.
 */
describe("resolveActiveInternalLinkRange — active link at the creation ending caret", () => {
  function createEditor(
    content: string | Record<string, unknown>,
    internalLink?: () => Promise<LinkAttributes | undefined>
  ) {
    const editor = track(
      new TiptapEditor({
        // TextStyle + Color are the shipping inline marks used below to prove an
        // attribute edit preserves a formatted caption.
        extensions: [StarterKit, TextStyle, Color, productionLink()],
        content
      })
    );
    if (internalLink)
      (editor.storage as Record<string, unknown>).createInternalLink =
        internalLink;
    return editor;
  }

  function forked(editor: TiptapEditor) {
    return editor as unknown as Editor;
  }

  function linkAttrsAt(editor: TiptapEditor): LinkAttributes {
    return getMarkAttributes(editor.state, Link.name) as LinkAttributes;
  }

  /** Text covered by a link mark, in document order (plain spacers excluded). */
  function linkedText(editor: TiptapEditor): string {
    let text = "";
    editor.state.doc.descendants((node) => {
      if (
        node.isText &&
        node.marks.some((mark) => mark.type.name === Link.name)
      )
        text += node.text ?? "";
    });
    return text;
  }

  type JsonNode = {
    marks?: { type?: string; attrs?: Record<string, unknown> }[];
    content?: JsonNode[];
  };

  /** Link mark attributes of the serialized (`getJSON`) document. */
  function jsonLinkAttrs(editor: TiptapEditor): Record<string, unknown>[] {
    const attrs: Record<string, unknown>[] = [];
    walkJson(editor.getJSON() as JsonNode, (node) => {
      for (const mark of node.marks ?? [])
        if (mark.type === Link.name && mark.attrs) attrs.push(mark.attrs);
    });
    return attrs;
  }

  /** Depth-first walk over the serialized (`getJSON`) document. */
  function walkJson(json: JsonNode, visit: (node: JsonNode) => void) {
    visit(json);
    for (const child of json.content ?? []) walkJson(child, visit);
  }

  /**
   * Every mark type present in the serialized (`getJSON`) document, one entry
   * per mark on one per text node.
   */
  function collectMarkTypes(json: JsonNode): string[] {
    const types: string[] = [];
    walkJson(json, (node) => {
      for (const mark of node.marks ?? []) if (mark.type) types.push(mark.type);
    });
    return types;
  }

  /**
   * A canonical deep copy of the serialized document in which every link `href`
   * is replaced by a placeholder. Comparing the normalized `before`/`after`
   * documents proves that *nothing but the href* changed: the text, every
   * inline mark (its type and remaining attributes) and every neighbouring node
   * are byte-for-byte identical. Marks are sorted per node because ProseMirror
   * does not treat their array order as document content.
   */
  function normalizeLinkHref(json: JsonNode): JsonNode {
    const marks = json.marks
      ?.map((mark) =>
        mark.type === Link.name && mark.attrs
          ? { ...mark, attrs: { ...mark.attrs, href: "<href>" } }
          : { ...mark }
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      ...json,
      ...(marks ? { marks } : {}),
      ...(json.content
        ? { content: json.content.map((child) => normalizeLinkHref(child)) }
        : {})
    };
  }

  /**
   * The link attributes of the *document* (not of the live selection), used to
   * model the boundary state below without depending on `getMarkAttributes`.
   */
  function documentLinkAttrs(editor: TiptapEditor): LinkAttributes {
    return jsonLinkAttrs(editor)[0] as LinkAttributes;
  }

  test("resolves the fresh link when the derived range lands on the trailing spacer", async () => {
    const picker = vi.fn(
      async (_attributes?: LinkAttributes): Promise<LinkAttributes> => ({
        href: "nn://note/beta",
        title: "Beta"
      })
    );
    const editor = createEditor("<p></p>", picker);

    // Real creation path (`Insert + -> Link to note -> Beta -> Create`) and its
    // *actual* post-creation document state. The caret rests directly after the
    // generated plain spacer (the spacer is the paragraph's last character), so
    // the fresh link is *not* the active mark at that caret here — the supplied
    // `[StarterKit, Link]` happy-dom editor does not reproduce the iPad
    // runtime's boundary caret. Assert only what really is there.
    await insertInternalLink(forked(editor));
    expect(editor.getText()).toBe("Beta ");
    expect(linkedText(editor)).toBe("Beta");
    expect(editor.getHTML().match(/<a\b/g) ?? []).toHaveLength(1);
    expect(editor.getHTML()).toContain('href="nn://note/beta"');
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(6); // one past the spacer

    // Seam (documented): model the state the iPad runtime offers `EditLink` in —
    // the caret at the link's *inclusive* end boundary (between the linked
    // caption and the generated spacer), where the link mark is still active.
    // This is established with real Tiptap commands only: move the caret and
    // set the link's own document attributes as a stored mark. It changes no
    // document content.
    const documentJSON = editor.getJSON();
    const boundary = 5; // end of the linked caption "Beta" [1, 5)
    editor.commands.setTextSelection({ from: boundary, to: boundary });
    editor.commands.setMark(Link.name, documentLinkAttrs(editor));
    expect(editor.getJSON()).toEqual(documentJSON);

    // The precondition the `LinkSettings`/`EditLink` branch reads.
    const attrs = linkAttrsAt(editor);
    expect(editor.isActive(Link.name)).toBe(true);
    expect(attrs.href).toBe("nn://note/beta");
    const caretBefore = editor.state.selection.from;
    expect(caretBefore).toBe(boundary);

    // The range `EditLink` derives without a hover popup range: the spacer, not
    // the link.
    const fallback = selectionToOffset(editor.state);
    expect(fallback).toBeTruthy();
    expect({ from: fallback!.from, to: fallback!.to }).not.toEqual({
      from: 1,
      to: 5
    });

    picker.mockResolvedValueOnce({
      href: "nn://note/owner",
      title: "Owner"
    });
    const result = await insertInternalLink(forked(editor), {
      attributes: attrs,
      range: { from: fallback!.from, to: fallback!.to }
    });

    expect(result).toEqual({ href: "nn://note/owner", title: "Owner" });
    // The linked caption was edited, not the spacer or the paragraph start.
    expect(editor.getText()).toBe("Beta ");
    expect(linkedText(editor)).toBe("Beta");
    expect(editor.getHTML().match(/<a\b/g) ?? []).toHaveLength(1);
    expect(editor.getHTML()).toContain('href="nn://note/owner"');
    expect(editor.getHTML()).not.toContain("nn://note/beta");
    // Exact serialized attributes: everything but the href is preserved.
    const linkAttrs = jsonLinkAttrs(editor);
    expect(linkAttrs).toHaveLength(1);
    expect(linkAttrs[0]).toEqual({ ...attrs, href: "nn://note/owner" });
    // The caret stays where the user left it.
    expect(editor.state.selection.from).toBe(caretBefore);

    // ...and the result survives serialization + reopen. The HTML parser drops
    // the trailing whitespace at the end of a block, so the reopened text may
    // lose the generated spacer; the link itself is what must survive.
    const html = editor.getHTML();
    editor.destroy();
    const reopened = track(
      new TiptapEditor({
        extensions: [StarterKit, productionLink()],
        content: html
      })
    );
    expect(reopened.getText()).toMatch(/^Beta ?$/);
    expect(linkedText(reopened)).toBe("Beta");
    expect(reopened.getHTML()).toContain('href="nn://note/owner"');
    expect(reopened.getHTML()).not.toContain("nn://note/beta");
    reopened.destroy();
  });

  test("resolves the link for a caret inside it, at its start and at its end", () => {
    const editor = createEditor(
      '<p>xx <a href="nn://note/target" title="Target">Target</a> yy</p>'
    );
    const attributes = { href: "nn://note/target", title: "Target" };

    for (const [caret, label] of [
      [7, "inside the link"],
      [4, "at the start of the link"],
      [10, "at the end of the link"]
    ] as const) {
      editor.commands.setTextSelection({ from: caret, to: caret });
      const fallback = selectionToOffset(editor.state);
      expect(fallback, label).toBeTruthy();
      expect(
        resolveActiveInternalLinkRange(
          forked(editor),
          { from: fallback!.from, to: fallback!.to },
          attributes
        ),
        label
      ).toEqual({ from: 4, to: 10 });
    }

    editor.destroy();
  });

  test("resolves the link when the caret rests past it after a creation", async () => {
    const picker = vi.fn(
      async (_attributes?: LinkAttributes): Promise<LinkAttributes> => ({
        href: "nn://note/target",
        title: "Target"
      })
    );
    // A real JSON document (not `<p>xx </p>`): the HTML parser drops trailing
    // whitespace at the end of a block, so the "xx " prefix exists only as a
    // JSON text node here.
    const editor = createEditor(
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "xx " }] }
        ]
      },
      picker
    );
    expect(editor.getText()).toBe("xx ");
    editor.commands.setTextSelection({ from: 4, to: 4 });
    await insertInternalLink(forked(editor));

    // Actual post-creation document state: the link [4, 10) followed by the
    // generated spacer, with the caret directly after the spacer. The supplied
    // happy-dom editor does not reproduce the iPad runtime's boundary caret, so
    // only the real document state is asserted here.
    expect(editor.getText()).toBe("xx Target ");
    expect(linkedText(editor)).toBe("Target");
    expect(editor.getHTML().match(/<a\b/g) ?? []).toHaveLength(1);
    expect(editor.state.selection.from).toBe(11); // one past the spacer

    // Seam (documented): model the iPad runtime state — the caret at the link's
    // *inclusive* end boundary (between "Target" and the generated spacer) —
    // with real Tiptap commands; the document is not modified.
    const documentJSON = editor.getJSON();
    editor.commands.setTextSelection({ from: 10, to: 10 });
    editor.commands.setMark(Link.name, documentLinkAttrs(editor));
    expect(editor.getJSON()).toEqual(documentJSON);

    const attrs = linkAttrsAt(editor);
    expect(editor.isActive(Link.name)).toBe(true);
    expect(attrs.href).toBe("nn://note/target");

    const fallback = selectionToOffset(editor.state);
    expect(fallback).toBeTruthy();
    expect({ from: fallback!.from, to: fallback!.to }).not.toEqual({
      from: 4,
      to: 10
    });
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: fallback!.from, to: fallback!.to },
        attrs
      )
    ).toEqual({ from: 4, to: 10 });

    editor.destroy();
  });

  test("resolves only the requested target at a shared link boundary", () => {
    const editor = createEditor(
      '<p><a href="nn://note/a" title="A">A</a><a href="nn://note/b" title="B">B</a> </p>'
    );
    // Caret between the two links.
    editor.commands.setTextSelection({ from: 2, to: 2 });
    const fallback = selectionToOffset(editor.state);
    expect(fallback).toBeTruthy();
    const range = { from: fallback!.from, to: fallback!.to };

    // Actual contract at the shared inclusive boundary: `getMarkAttributes`
    // reports the *left* (previous) link. Pin the real value instead of
    // rewriting the boundary semantics to keep the old, wrong "B" expectation.
    const attrs = linkAttrsAt(editor);
    expect(attrs.href).toBe("nn://note/a");
    expect(resolveActiveInternalLinkRange(forked(editor), range, attrs)).toEqual(
      { from: 1, to: 2 }
    );

    // The requested target decides: only that link's own run is returned, the
    // two links are never merged into one range.
    expect(
      resolveActiveInternalLinkRange(forked(editor), range, {
        href: "nn://note/b"
      })
    ).toEqual({ from: 2, to: 3 });
    // A target that is not in the document is never guessed at.
    expect(
      resolveActiveInternalLinkRange(forked(editor), range, {
        href: "nn://note/c"
      })
    ).toBeUndefined();
    // Without a requested target the boundary touches two different links:
    // ambiguous, so nothing is resolved.
    expect(
      resolveActiveInternalLinkRange(forked(editor), range)
    ).toBeUndefined();

    editor.destroy();
  });

  test("keeps same-href/different-title adjacent links as separate runs", () => {
    const editor = createEditor(
      '<p><a href="nn://note/x" title="One">One</a><a href="nn://note/x" title="Two">Two</a> </p>'
    );
    const attributes = { href: "nn://note/x" };

    // Inside the first link (positions: "One" [1,4), "Two" [4,7)).
    editor.commands.setTextSelection({ from: 2, to: 2 });
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 2, to: 2 },
        attributes
      )
    ).toEqual({ from: 1, to: 4 });

    // Inside the second link.
    editor.commands.setTextSelection({ from: 5, to: 5 });
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 5, to: 5 },
        attributes
      )
    ).toEqual({ from: 4, to: 7 });

    // At the shared boundary the two runs stay two runs: the same href makes
    // them indistinguishable, so the boundary is ambiguous and never merged.
    editor.commands.setTextSelection({ from: 4, to: 4 });
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 4, to: 4 },
        attributes
      )
    ).toBeUndefined();

    editor.destroy();
  });

  test("never resolves a link across a paragraph gap or a different textblock", () => {
    const editor = createEditor(
      '<p><a href="nn://note/x" title="One">One</a></p><p>plain text <a href="nn://note/x" title="Two">Two</a></p>'
    );
    // Caret in the first paragraph, right after the link (position 4).
    editor.commands.setTextSelection({ from: 4, to: 4 });
    // Only the local link may resolve; the same-href link in the *next*
    // paragraph must never be picked.
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 4, to: 4 },
        { href: "nn://note/x" }
      )
    ).toEqual({ from: 1, to: 4 });

    // A position with no link anywhere near it resolves nothing, even though a
    // link exists elsewhere in the same block.
    editor.commands.setTextSelection({ from: 8, to: 8 });
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 8, to: 8 },
        { href: "nn://note/x" }
      )
    ).toBeUndefined();

    // No attributes at all and nothing under the caret: no target.
    expect(
      resolveActiveInternalLinkRange(forked(editor), { from: 8, to: 8 })
    ).toBeUndefined();

    editor.destroy();
  });

  test("rejects a derived range that touches two candidate links", () => {
    const editor = createEditor(
      '<p><a href="nn://note/a" title="A">A</a><a href="nn://note/b" title="B">B</a></p>'
    );
    // A range spanning both links touches both: ambiguous, so it is rejected
    // instead of silently snapping to the nearest one.
    expect(
      resolveActiveInternalLinkRange(forked(editor), { from: 1, to: 3 })
    ).toBeUndefined();
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 1, to: 3 },
        { href: "nn://note/a" }
      )
    ).toEqual({ from: 1, to: 2 });

    editor.destroy();
  });

  test("creates the link on an explicit range that has no existing link", () => {
    const picker = vi.fn(
      async (_attributes?: LinkAttributes): Promise<LinkAttributes> => ({
        href: "nn://note/new",
        title: "New"
      })
    );
    const editor = createEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });

    return insertInternalLink(forked(editor), {
      range: { from: 1, to: 6 }
    }).then((result) => {
      expect(result).toEqual({ href: "nn://note/new", title: "New" });
      expect(editor.getHTML()).toContain('href="nn://note/new"');
      expect(editor.getHTML()).toContain(">hello</a> world");
      expect(editor.getText()).toBe("hello world");
      editor.destroy();
    });
  });

  test("resolves a formatted caption split over several text nodes as one range", () => {
    const editor = createEditor(
      '<p><a href="nn://note/t" title="Target"><strong>Tar</strong>get</a> </p>'
    );
    editor.commands.setTextSelection({ from: 1, to: 1 });
    const fallback = selectionToOffset(editor.state);
    expect(fallback).toBeTruthy();
    const attrs = linkAttrsAt(editor);
    expect(attrs.href).toBe("nn://note/t");

    expect(linkedText(editor)).toBe("Target");
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: fallback!.from, to: fallback!.to },
        attrs
      )
    ).toEqual({ from: 1, to: 7 });

    editor.destroy();
  });

  test("editing a formatted caption preserves every inline mark (href-only change)", async () => {
    const picker = vi.fn(
      async (_attributes?: LinkAttributes): Promise<LinkAttributes> => ({
        href: "nn://note/new",
        title: "Target"
      })
    );
    const editor = createEditor(
      // A caption split across a colour/bold/italic text node and a plain one,
      // with a neighbour after the link.
      '<p><a href="nn://note/old" title="Target"><span style="color:#ff0000"><strong><em>Tar</em></strong></span>get</a> tail</p>',
      picker
    );

    const before = editor.getJSON();
    const linkAttrsBefore = jsonLinkAttrs(editor);
    // The fixture really carries the split marks we care about.
    expect(collectMarkTypes(before)).toEqual(
      expect.arrayContaining(["link", "textStyle", "bold", "italic"])
    );
    expect(linkAttrsBefore[0].href).toBe("nn://note/old");

    // Real `EditLink` flow on the existing link's own range.
    const result = await insertInternalLink(forked(editor), {
      attributes: { href: "nn://note/old", title: "Target" },
      range: { from: 1, to: 7 }
    });

    expect(result).toEqual({ href: "nn://note/new", title: "Target" });

    const after = editor.getJSON();
    // Nothing but the link href changed: the split bold/italic/colour marks, the
    // caption text and the neighbour all survive byte-for-byte. This compares
    // the *whole* serialized document, not just the resolver's return value.
    expect(normalizeLinkHref(after)).toEqual(normalizeLinkHref(before));
    expect(collectMarkTypes(after).sort()).toEqual(
      collectMarkTypes(before).sort()
    );
    // Both fragments of the split caption kept a link mark, with the new href
    // only.
    const linkAttrsAfter = jsonLinkAttrs(editor);
    expect(linkAttrsAfter.length).toBeGreaterThan(0);
    expect([...new Set(linkAttrsAfter.map((attrs) => attrs.href))]).toEqual([
      "nn://note/new"
    ]);
    expect(linkAttrsAfter[0]).toEqual({
      ...linkAttrsBefore[0],
      href: "nn://note/new"
    });
    expect(editor.getText()).toBe("Target tail");
    const html = editor.getHTML();
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
    expect(html).toContain("#ff0000");
    // The link element closes right before the untouched neighbour text.
    expect(html).toContain("</a> tail");
    expect(html).not.toContain("nn://note/old");

    editor.destroy();
  });

  test("edits only the hovered link while the live caret rests on another link with the same href", async () => {
    const picker = vi.fn(
      async (_attributes?: LinkAttributes): Promise<LinkAttributes> => ({
        href: "nn://note/new",
        title: "ignored"
      })
    );
    const editor = createEditor(
      '<p><a href="nn://note/x" title="Alpha"><strong>Al</strong>pha</a> mid <a href="nn://note/x" title="Beta">Beta</a> tail</p>',
      picker
    );
    // Positions: "Al" [1, 3), "pha" [3, 6), " mid " [6, 11),
    // "Beta" [11, 15), " tail" [15, 20).
    // The live caret rests inside the *second* link, which shares the href.
    editor.commands.setTextSelection({ from: 13, to: 13 });

    const attributes = documentLinkAttrs(editor);
    expect(attributes.href).toBe("nn://note/x");
    expect(attributes.title).toBe("Alpha");

    const linkAttrsBefore = jsonLinkAttrs(editor);
    expect(linkAttrsBefore).toHaveLength(3); // "Al", "pha" and "Beta"

    // The hover popup hands over only the hovered *fragment* of the first link.
    const result = await insertInternalLink(forked(editor), {
      attributes,
      range: { from: 1, to: 3 }
    });

    // The helper returns the *raw picker payload*, unchanged: the selected
    // text only ever becomes the *document* link title (asserted below), never
    // the return value.
    expect(result).toEqual({ href: "nn://note/new", title: "ignored" });
    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0][0]).toBe(attributes);

    // Regression: the live caret on the same-href link must not create a fake
    // ambiguity. Only the hovered (first) link changed; the second link is
    // byte-for-byte untouched.
    const linkAttrsAfter = jsonLinkAttrs(editor);
    expect(linkAttrsAfter).toHaveLength(3);
    expect(linkAttrsAfter[0]).toEqual({
      ...linkAttrsBefore[0],
      href: "nn://note/new"
    });
    expect(linkAttrsAfter[1]).toEqual({
      ...linkAttrsBefore[1],
      href: "nn://note/new"
    });
    expect(linkAttrsAfter[2]).toEqual(linkAttrsBefore[2]);

    // The formatted caption and the neighbour text survive.
    expect(editor.getText()).toBe("Alpha mid Beta tail");
    const html = editor.getHTML();
    expect(html).toContain("<strong>");
    expect(html).toContain(">Beta</a> tail");
    expect(html).toContain('href="nn://note/x"');
    // The user's own caret is restored, not moved into the edited link.
    expect(editor.state.selection.from).toBe(13);
    expect(editor.state.selection.to).toBe(13);

    editor.destroy();
  });

  test("edits exactly one of two adjacent same-href links with different titles", async () => {
    const picker = vi.fn(
      async (_attributes?: LinkAttributes): Promise<LinkAttributes> => ({
        href: "nn://note/new",
        title: "ignored"
      })
    );
    const editor = createEditor(
      '<p><a href="nn://note/x" title="One">One</a><a href="nn://note/x" title="Two">Two</a> </p>',
      picker
    );
    // Positions: "One" [1, 4), "Two" [4, 7), " " [7, 8).
    const attributes = documentLinkAttrs(editor);
    expect(attributes.title).toBe("One");

    const linkAttrsBefore = jsonLinkAttrs(editor);
    expect(linkAttrsBefore).toHaveLength(2);
    expect(linkAttrsBefore[1].title).toBe("Two");

    const result = await insertInternalLink(forked(editor), {
      attributes,
      range: { from: 1, to: 4 }
    });

    // The return value is the raw picker payload; the selected text "One" only
    // becomes the *document* title (asserted right below), never the return.
    expect(result).toEqual({ href: "nn://note/new", title: "ignored" });
    const linkAttrsAfter = jsonLinkAttrs(editor);
    expect(linkAttrsAfter).toHaveLength(2);
    expect(linkAttrsAfter[0]).toEqual({
      ...linkAttrsBefore[0],
      href: "nn://note/new"
    });
    // The adjacent link is a separate run: text, href and title are untouched.
    expect(linkAttrsAfter[1]).toEqual(linkAttrsBefore[1]);
    expect(editor.getText()).toBe("OneTwo");
    const html = editor.getHTML();
    expect(html).toContain(">One</a>");
    expect(html).toContain(">Two</a>");
    expect(html).toContain('href="nn://note/x"');

    editor.destroy();
  });

  test("refuses an edit whose explicit range misses every link, without asking the host", async () => {
    const picker = vi.fn(async () => ({ href: "nn://note/new" }));
    const editor = createEditor("<p>plain text</p>", picker);
    editor.commands.setTextSelection({ from: 3, to: 3 });
    const jsonBefore = editor.getJSON();
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };

    // `EditLink` was pre-filled with the attributes of an existing link...
    const result = await insertInternalLink(forked(editor), {
      attributes: { href: "nn://note/old", title: "Old" },
      range: { from: 1, to: 3 }
    });

    // ...but the range has no link behind it. Refusing beats falling back to
    // `setLink`, which would silently rewrite the plain text.
    expect(result).toBeUndefined();
    expect(picker).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(jsonBefore);
    expect(editor.getHTML()).not.toContain("<a");
    expect(editor.getText()).toBe("plain text");
    // A refused edit leaves the selection where it was.
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);

    editor.destroy();
  });

  test("refuses an ambiguous edit instead of guessing between same-href links", async () => {
    const picker = vi.fn(async () => ({ href: "nn://note/new" }));
    const editor = createEditor(
      '<p><a href="nn://note/x" title="One">One</a><a href="nn://note/x" title="Two">Two</a> </p>',
      picker
    );
    const jsonBefore = editor.getJSON();

    // A partial (href-only) attributes view matches both adjacent links at
    // their shared boundary: ambiguous, so the command must refuse rather than
    // rewrite either caption.
    const result = await insertInternalLink(forked(editor), {
      attributes: { href: "nn://note/x" },
      range: { from: 4, to: 4 }
    });

    expect(result).toBeUndefined();
    expect(picker).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(jsonBefore);
    expect(editor.getText()).toBe("OneTwo");
    expect(jsonLinkAttrs(editor)).toHaveLength(2);

    editor.destroy();
  });

  test("never bridges a link through more than one plain ASCII spacer", () => {
    // `insertLink` generates exactly one plain ASCII space after a creation.
    const fixture = (spacer: string) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "One",
              marks: [
                { type: "link", attrs: { href: "nn://note/x", title: "One" } }
              ]
            },
            { type: "text", text: spacer },
            { type: "text", text: "tail" }
          ]
        }
      ]
    });

    // Positive control: the link [1, 4) plus exactly one plain space, with the
    // caret right after it, resolves to the link.
    const oneSpace = createEditor(fixture(" "));
    expect(
      resolveActiveInternalLinkRange(
        forked(oneSpace),
        { from: 5, to: 5 },
        documentLinkAttrs(oneSpace)
      )
    ).toEqual({ from: 1, to: 4 });

    // A non-ASCII whitespace character is not the generated plain ASCII spacer.
    const nbsp = createEditor(fixture(" "));
    expect(
      resolveActiveInternalLinkRange(
        forked(nbsp),
        { from: 5, to: 5 },
        documentLinkAttrs(nbsp)
      )
    ).toBeUndefined();

    // Two spaces ([4, 6)) are not a generated spacer either: the caret after
    // both of them never bridges to the link behind them.
    const twoSpaces = createEditor(fixture("  "));
    expect(
      resolveActiveInternalLinkRange(
        forked(twoSpaces),
        { from: 6, to: 6 },
        documentLinkAttrs(twoSpaces)
      )
    ).toBeUndefined();

    oneSpace.destroy();
    nbsp.destroy();
    twoSpaces.destroy();
  });

  test("does not resolve without link context (no href)", () => {
    const editor = createEditor(
      '<p><a href="nn://note/x" title="One">One</a> </p>'
    );
    // The caret at the link's inclusive end boundary, but no link attributes
    // were handed over: no context, no resolution (e.g. a bottom toolbar unlink
    // without an active link).
    editor.commands.setTextSelection({ from: 4, to: 4 });
    expect(
      resolveActiveInternalLinkRange(forked(editor), { from: 4, to: 4 })
    ).toBeUndefined();
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 4, to: 4 },
        {} as LinkAttributes
      )
    ).toBeUndefined();

    editor.destroy();
  });

  test("resolves a single-character link that starts at a plain prefix boundary", () => {
    // Regression: a single-character link whose *start* is an exact child
    // boundary (plain text right before it) was the child the pinned
    // `getMarkRange` never reached from a childAfter-only probe.
    const editor = createEditor(
      '<p>xx <a href="nn://note/b" title="B">B</a> yy</p>'
    );
    // Positions: "xx " [1, 4), "B" [4, 5), " yy" [5, 9).
    const full = { href: "nn://note/b", title: "B" };

    // The link's start boundary.
    expect(
      resolveActiveInternalLinkRange(forked(editor), { from: 4, to: 4 }, full)
    ).toEqual({ from: 4, to: 5 });
    // Its inclusive end boundary and a position inside it agree.
    expect(
      resolveActiveInternalLinkRange(forked(editor), { from: 5, to: 5 }, full)
    ).toEqual({ from: 4, to: 5 });
    // A partial (href-only) attributes view still selects exactly this link.
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 4, to: 4 },
        { href: "nn://note/b" }
      )
    ).toEqual({ from: 4, to: 5 });
    // A different href is never guessed at that boundary.
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 4, to: 4 },
        { href: "nn://note/z" }
      )
    ).toBeUndefined();

    editor.destroy();
  });

  test("keeps two adjacent single-character same-href links ambiguous, and selects one with exact context", () => {
    const editor = createEditor(
      '<p><a href="nn://note/x" title="A">A</a><a href="nn://note/x" title="B">B</a></p>'
    );
    // Positions: "A" [1, 2), "B" [2, 3).
    // A partial href-only view matches both links at their shared boundary:
    // two distinct runs stay two, so nothing is resolved.
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 2, to: 2 },
        { href: "nn://note/x" }
      )
    ).toBeUndefined();
    // An exact href+title context selects the intended single-character link —
    // including the *right* one, whose start is the shared boundary.
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 2, to: 2 },
        { href: "nn://note/x", title: "B" }
      )
    ).toEqual({ from: 2, to: 3 });
    expect(
      resolveActiveInternalLinkRange(
        forked(editor),
        { from: 2, to: 2 },
        { href: "nn://note/x", title: "A" }
      )
    ).toEqual({ from: 1, to: 2 });

    editor.destroy();
  });

  test("never falls back to the live caret for an explicit range", () => {
    // Regression: an unrelated live caret (here: on a link) used to leak into
    // an explicit range that carries no link, resolving a fake target.
    const editor = createEditor(
      '<p><a href="nn://note/x" title="One">One</a> tail</p><p>plain text</p>'
    );
    // The live caret rests on the first paragraph's link...
    editor.commands.setTextSelection({ from: 2, to: 2 });
    const attrs = { href: "nn://note/x", title: "One" };

    // ...but the explicit range is plain text in the *same* textblock (the
    // " tail" right after the link): nothing there resolves.
    expect(
      resolveActiveInternalLinkRange(forked(editor), { from: 6, to: 6 }, attrs)
    ).toBeUndefined();

    // ...and the explicit range in *another* textblock resolves nothing either.
    expect(
      resolveActiveInternalLinkRange(forked(editor), { from: 12, to: 12 }, attrs)
    ).toBeUndefined();
    expect(
      resolveActiveInternalLinkRange(forked(editor), { from: 12, to: 16 }, attrs)
    ).toBeUndefined();

    editor.destroy();
  });

  test("never bridges through a spacer that itself carries a link mark", () => {
    const fixture = (spacerMark?: { href: string; title: string }) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "One",
              marks: [
                { type: "link", attrs: { href: "nn://note/x", title: "One" } }
              ]
            },
            {
              type: "text",
              text: " ",
              ...(spacerMark
                ? { marks: [{ type: "link", attrs: spacerMark }] }
                : {})
            },
            { type: "text", text: "tail" }
          ]
        }
      ]
    });

    // Positive control: the unmarked generated spacer still bridges.
    const plain = createEditor(fixture());
    expect(
      resolveActiveInternalLinkRange(
        forked(plain),
        { from: 5, to: 5 },
        documentLinkAttrs(plain)
      )
    ).toEqual({ from: 1, to: 4 });

    // A space that is *itself* part of another link is not a generated spacer:
    // the caret after it must not bridge to the link behind it.
    const marked = createEditor(
      fixture({ href: "nn://note/other", title: "Other" })
    );
    expect(
      resolveActiveInternalLinkRange(
        forked(marked),
        { from: 5, to: 5 },
        documentLinkAttrs(marked)
      )
    ).toBeUndefined();

    plain.destroy();
    marked.destroy();
  });
});

describe("isInternalLink", () => {
  test("recognizes nn:// hrefs only", () => {
    expect(isInternalLink("nn://note/abc")).toBe(true);
    expect(isInternalLink("nn://")).toBe(true);
    expect(isInternalLink("https://example.com")).toBe(false);
    expect(isInternalLink("")).toBe(false);
    expect(isInternalLink(undefined)).toBe(false);
    expect(isInternalLink(null)).toBe(false);
  });
});
