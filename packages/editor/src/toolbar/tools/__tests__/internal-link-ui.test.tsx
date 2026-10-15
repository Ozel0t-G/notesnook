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
 * Real-DOM (ReactDOM + happy-dom) coverage for the internal-link entry points.
 *
 * What is actually exercised here:
 * - the real `InsertBlock` (render -> real "+" button -> click -> `isOpen`),
 *   reading the first-level entries it hands to `ResponsivePresenter`;
 * - the real `AddInternalLink` / `EditLink` / `RemoveLink` / `OpenLink`
 *   toolbar tools and their real `ToolButton`/`Button` (theme-ui) leaf;
 * - the real `insertInternalLink` command against a real
 *   `@tiptap/starter-kit` + `Link` editor, asserting the resulting document.
 *
 * Bounded seams (deliberately mocked, and NOT claimed to be full runtime):
 * - `ResponsivePresenter` is replaced by a small presenter that renders the
 *   received `items` as real DOM menu buttons. The production presenters
 *   (MenuPresenter/ActionSheetPresenter via ReactModal portals) are heavier than
 *   this seam needs; the portal/menu *rendering* is therefore out of scope.
 *   The item list, its keys, titles and callbacks are the real ones.
 * - `showPopup` is a no-op: none of the internal-link paths use it.
 * - `Popup` (the `LinkPopup` chrome, reached only when `EditLink` takes the
 *   external form) is a passthrough: the edit *branch* and its `onDone` are the
 *   real ones, the themed popup surface itself is not rendered here.
 *
 * Theme seam (not a shipping theme object): the real toolbar leaves (`Icon`,
 * theme-ui `Button`) read `useTheme()`, so the view is rendered inside a real
 * `ThemeProvider` (`@theme-ui/core`) carrying a minimal `iconSizes` map typed
 * against the existing `Theme` from `@notesnook/theme` (the values mirror what
 * `ThemeFactory.construct` ships). Without it emotion hands back `{}` and the
 * icon lookup throws (`"medium" in undefined`).
 *
 * Localization seam (deliberately mocked, NOT the shipping catalog): the real
 * `@notesnook/intl` catalog is produced by lingui compile-time macros that this
 * vitest/happy-dom setup does not run, so `@notesnook/intl` is replaced by a
 * controlled mock that exposes one stable, non-empty, key-derived label per
 * accessed key (with explicit English labels for the keys asserted here).
 * Assertions therefore compare mock labels to mock labels and stay meaningful
 * and distinct; they do NOT validate the real shipping strings or I18n engine.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor, getMarkAttributes } from "@tiptap/core";
import { strings } from "@notesnook/intl";
import { InsertBlock } from "../block.js";
import {
  AddInternalLink,
  EditLink,
  RemoveLink,
  OpenLink
} from "../link.js";
import { LinkPopup } from "../../popups/link-popup.js";
import { HoverPopupContextProvider } from "../../floating-menus/hover-popup/context.js";
import { useToolbarStore } from "../../stores/toolbar-store.js";
import { Link } from "../../../extensions/link/index.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../../types.js";
import type { ToolProps } from "../../types.js";
import type { LinkAttributes } from "../../../extensions/link/index.js";
import type { LinkDefinition } from "../link.js";
import type { NodeWithOffset } from "../../../utils/prosemirror.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * Hoisted hand-off for the mocked presenter so the test can inspect exactly
 * what the real `InsertBlock` passed down (items + open state + titles).
 */
const responsive = vi.hoisted(() => ({
  lastProps: null as
    | {
        isOpen?: boolean;
        title?: string;
        mobile?: string;
        desktop?: string;
        items?: unknown[];
        children?: unknown;
        onClose?: () => void;
      }
    | null
}));

vi.mock("../../../components/responsive/index.js", () => {
  // Renders the real `MenuItem[]` the caller supplied as DOM buttons (mirrors
  // MenuButton: skips hidden items, exposes `title`, invokes onClick+onClose).
  function ResponsivePresenter(props: Record<string, unknown>) {
    responsive.lastProps = props as unknown as typeof responsive.lastProps;
    if (!props.isOpen) return null;
    const items = (props.items as Record<string, unknown>[] | undefined) ?? [];
    return (
      <div data-test-id="responsive-presenter">
        {props.title ? (
          <div data-test-id="presenter-title">{props.title as string}</div>
        ) : null}
        {items
          .filter((item) => !item.isHidden)
          .map((item) =>
            item.type === "button" ? (
              <button
                key={item.key as string}
                id={`menu-item-${item.key as string}`}
                data-test-id={`menu-button-${item.key as string}`}
                role="menuitem"
                title={(item.tooltip as string) || (item.title as string)}
                disabled={Boolean(item.isDisabled)}
                onClick={() => {
                  (item.onClick as (() => void) | undefined)?.();
                  (props.onClose as (() => void) | undefined)?.();
                }}
              >
                {item.title as string}
              </button>
            ) : null
          )}
        {props.children as React.ReactNode}
      </div>
    );
  }
  return {
    ResponsivePresenter,
    ResponsiveContainer: (props: { desktop?: React.ReactNode }) =>
      props.desktop ?? null,
    DesktopOnly: (props: { children?: React.ReactNode }) => (
      <>{props.children}</>
    ),
    MobileOnly: () => null
  };
});

vi.mock("../../../components/popup-presenter/index.js", () => ({
  showPopup: vi.fn(),
  PopupWrapper: (props: { children?: React.ReactNode }) => props.children ?? null
}));

/** Leaf seam of `LinkPopup` only (see the header); its `children` still render. */
vi.mock("../../components/popup.js", () => ({
  Popup: (props: { children?: React.ReactNode }) => props.children ?? null
}));

/**
 * Controlled localization mock (documented fixture seam; see the header).
 * Labels are stable per key so equality assertions between what the real
 * components render and what this file expects remain meaningful. Keys the
 * exercised code asks for but which are not listed fall back to `intl:<key>`,
 * which keeps the mock robust without pulling in the lingui build pipeline.
 */
vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    insert: "Insert",
    chooseBlockToInsert: "Choose a block to insert",
    newInternalLink: "Link to note",
    noteLink: "Add internal link",
    linkEdit: "Edit link",
    linkRemove: "Remove link",
    openLink: "Open link",
    editLink: "Edit",
    insertLink: "Insert link",
    loading: "Loading",
    horizontalRule: "Horizontal rule",
    codeBlock: "Code block",
    quote: "Quote",
    mathAndFormulas: "Math and formulas",
    callout: "Callout",
    image: "Image",
    insertImage: "Insert image",
    uploadFromDisk: "Upload from disk",
    takePhotoUsingCamera: "Take photo using camera",
    handwriting: "Handwriting",
    insertTemplate: "Insert template",
    table: "Table",
    insertTable: "Insert table",
    importCsv: "Import CSV",
    embed: "Embed",
    insertEmbed: "Insert embed",
    attachment: "Attachment",
    taskList: "Task list",
    outlineList: "Outline list",
    attachImageFromURL: "Attach image from URL"
  };
  const strings = new Proxy(labels, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      return () => target[key] ?? `intl:${key}`;
    }
  });
  return { strings };
});

/**
 * Minimal theme-ui theme so the real `Icon`/`Button` leaves can read
 * `useTheme()`. The `iconSizes` values are the existing `Theme` type from
 * `@notesnook/theme` (what the shipping `ThemeFactory.construct` produces); the
 * object itself is typed through the provider's own `theme` prop because a
 * hand-rolled fixture cannot be a full `@theme-ui/css` `Theme`.
 */
const shippingIconSizes: Theme["iconSizes"] = {
  small: 12,
  medium: 14,
  big: 16
};
type ThemeProviderTheme = Parameters<typeof ThemeProvider>[0]["theme"];
const testTheme = {
  iconSizes: shippingIconSizes
} as unknown as ThemeProviderTheme;

type Mounted = {
  container: HTMLElement;
  rerender: (ui: React.ReactElement) => void;
  unmount: () => void;
};
let mounted: Mounted[] = [];

function renderView(ui: React.ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  const render = (next: React.ReactElement) => {
    act(() => {
      root.render(<ThemeProvider theme={testTheme}>{next}</ThemeProvider>);
    });
  };
  act(() => {
    root = createRoot(container);
  });
  render(ui);
  const view: Mounted = {
    container,
    rerender: render,
    unmount() {
      act(() => root.unmount());
      container.remove();
    }
  };
  mounted.push(view);
  return view;
}

async function click(el: Element | null | undefined) {
  expect(el, "expected a rendered element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Flush pending microtasks/timers produced by the async link command. */
async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * The exact link extension the shipping editor builds (`index.ts`): the base
 * extension's `inclusive()` follows `autolink` (disabled in production), so the
 * mark is forced inclusive. Production additionally follows the platform for
 * `openOnClick`; that only toggles the click-handler plugin, which none of the
 * behaviour asserted here depends on, so it is pinned off like in the command
 * tests.
 */
const productionLink = () =>
  Link.extend({ inclusive: true }).configure({
    autolink: false,
    openOnClick: false,
    linkOnPaste: true,
    protocols: [{ scheme: "nn" }]
  });

/**
 * Every editor a test creates is tracked here with the element its view is
 * mounted in, so the fixture can destroy the editor and remove the element even
 * when an assertion throws halfway through: a real view needs a real DOM and
 * must never be left attached (or leak a `DOMObserver`) into the next test.
 */
const editorFixtures: { editor: TiptapEditor; element: HTMLElement }[] = [];

function makeEditor(
  content: string,
  picker?: (
    attributes?: LinkAttributes
  ) => Promise<LinkAttributes | undefined>
) {
  // A real, attached editor view: the React tool wrappers focus the editor and
  // read/write the real selection.
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new TiptapEditor({
    element,
    extensions: [StarterKit, productionLink()],
    content
  });
  if (picker)
    (editor.storage as Record<string, unknown>).createInternalLink = picker;
  editorFixtures.push({ editor, element });
  return editor;
}

afterEach(() => {
  for (const { editor, element } of editorFixtures)
    if (!editor.isDestroyed) editor.destroy();
  for (const { element } of editorFixtures) element.remove();
  editorFixtures.length = 0;
});

function toolProps(
  editor: TiptapEditor,
  icon: string,
  title: string
): ToolProps {
  return { editor: editor as unknown as Editor, icon, title } as ToolProps;
}

/** A real host picker: the entry is only offered when the host registered one. */
function internalLinkPicker() {
  return vi.fn(async (_attributes?: LinkAttributes) => ({
    href: "nn://note/abc"
  }));
}

/**
 * Creates an internal link through the real "+" menu: `Insert +` -> `Link to
 * note` -> the host picker. This is the operator's path and it leaves the
 * "normal ending caret" behind (the caret on the plain spacer after the link).
 */
async function createInternalLinkViaInsertMenu(editor: TiptapEditor) {
  const view = renderView(
    <InsertBlock
      editor={editor as unknown as Editor}
      icon="plus"
      title={strings.insert()}
    />
  );
  await click(view.container.querySelector("button"));
  await click(
    view.container.querySelector('[data-test-id="menu-button-internal-link"]')
  );
  await flushAsync();
  return view;
}

/** Text covered by a link mark, in document order (plain spacers excluded). */
function linkedText(editor: TiptapEditor): string {
  let text = "";
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === Link.name))
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
  const walk = (node: JsonNode) => {
    for (const mark of node.marks ?? [])
      if (mark.type === Link.name && mark.attrs) attrs.push(mark.attrs);
    for (const child of node.content ?? []) walk(child);
  };
  walk(editor.getJSON() as JsonNode);
  return attrs;
}

function menuItem(key: string) {
  const items = (responsive.lastProps?.items ?? []) as Record<string, unknown>[];
  return items.find((item) => item.key === key) as
    | {
        key: string;
        type: string;
        title: string;
        icon?: string;
        isHidden?: boolean;
        isDisabled?: boolean;
        onClick?: () => unknown;
      }
    | undefined;
}

beforeEach(() => {
  responsive.lastProps = null;
  useToolbarStore.setState({
    isMobile: false,
    macCatalyst: false,
    toolbarLocation: "top"
  });
});

afterEach(() => {
  for (const view of mounted) view.unmount();
  mounted = [];
});

describe("Insert (+) menu — real InsertBlock", () => {
  test("renders a real Insert button with the localized name and opens the presenter", async () => {
    const editor = makeEditor("<p>hello world</p>", internalLinkPicker());
    const view = renderView(
      <InsertBlock
        editor={editor as unknown as Editor}
        icon="plus"
        title={strings.insert()}
      />
    );

    const button = view.container.querySelector("button");
    expect(button).toBeTruthy();
    expect(button?.getAttribute("title")).toBe(strings.insert());
    expect(button?.getAttribute("aria-label")).toBe(strings.insert());
    expect(strings.insert().length).toBeGreaterThan(0);

    // Closed initially: the presenter is rendered with isOpen=false.
    expect(responsive.lastProps?.isOpen).toBe(false);

    await click(button);

    expect(responsive.lastProps?.isOpen).toBe(true);
    expect(responsive.lastProps?.title).toBe(strings.chooseBlockToInsert());
    expect(responsive.lastProps?.desktop).toBe("menu");
    expect(responsive.lastProps?.mobile).toBe("sheet");
    expect(
      view.container.querySelector('[data-test-id="presenter-title"]')
        ?.textContent
    ).toBe(strings.chooseBlockToInsert());

    editor.destroy();
  });

  test("exposes the internal-link entry as a first-level, localized menu action", async () => {
    const editor = makeEditor("<p>hello world</p>", internalLinkPicker());
    const view = renderView(
      <InsertBlock
        editor={editor as unknown as Editor}
        icon="plus"
        title={strings.insert()}
      />
    );
    await click(view.container.querySelector("button"));

    const item = menuItem("internal-link");
    expect(item).toBeTruthy();
    expect(item?.type).toBe("button");
    expect(item?.title).toBe(strings.newInternalLink());
    expect(item?.isHidden).toBeFalsy();
    expect(typeof item?.icon).toBe("string");
    expect(item?.icon).toBeTruthy();

    // ...and it is actually rendered as a clickable button by the presenter.
    const rendered = view.container.querySelector(
      '[data-test-id="menu-button-internal-link"]'
    );
    expect(rendered?.textContent).toBe(strings.newInternalLink());
    expect(rendered?.getAttribute("title")).toBe(strings.newInternalLink());

    editor.destroy();
  });

  test("mobile and desktop surface the same internal-link entry", async () => {
    for (const isMobile of [false, true]) {
      useToolbarStore.setState({ isMobile });
      const editor = makeEditor("<p>hello world</p>", internalLinkPicker());
      const view = renderView(
        <InsertBlock
          editor={editor as unknown as Editor}
          icon="plus"
          title={strings.insert()}
        />
      );
      await click(view.container.querySelector("button"));

      expect(responsive.lastProps?.mobile).toBe("sheet");
      expect(responsive.lastProps?.desktop).toBe("menu");
      const item = menuItem("internal-link");
      expect(item?.title).toBe(strings.newInternalLink());
      expect(
        view.container.querySelector('[data-test-id="menu-button-internal-link"]')
          ?.textContent
      ).toBe(strings.newInternalLink());

      view.unmount();
      editor.destroy();
    }
  });

  test("clicking the internal-link entry runs the host picker and the link command", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/abc"
    }));
    const editor = makeEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const view = renderView(
      <InsertBlock
        editor={editor as unknown as Editor}
        icon="plus"
        title={strings.insert()}
      />
    );
    await click(view.container.querySelector("button"));
    await click(
      view.container.querySelector('[data-test-id="menu-button-internal-link"]')
    );
    await flushAsync();

    expect(picker).toHaveBeenCalledTimes(1);
    // The "+" menu entry links the current selection: no prefill attributes.
    expect(picker.mock.calls[0][0]).toBeUndefined();
    expect(editor.getHTML()).toContain('href="nn://note/abc"');
    expect(editor.getHTML()).toContain(">hello</a>");
    expect(editor.getText()).toBe("hello world");

    editor.destroy();
  });

  test("hides the internal-link entry when the host provides no picker", async () => {
    // A visible entry that can never do anything is a lying affordance: without
    // `storage.createInternalLink` the item must not be offered at all.
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <InsertBlock
        editor={editor as unknown as Editor}
        icon="plus"
        title={strings.insert()}
      />
    );
    await click(view.container.querySelector("button"));

    const item = menuItem("internal-link");
    expect(item).toBeTruthy();
    expect(item?.isHidden).toBe(true);
    // The real presenters skip hidden items, so nothing clickable is rendered.
    expect(
      view.container.querySelector('[data-test-id="menu-button-internal-link"]')
    ).toBeNull();
    // The rest of the insert menu stays intact.
    expect(
      view.container.querySelector('[data-test-id="menu-button-tasklist"]')
    ).toBeTruthy();

    editor.destroy();
  });

  test("disables the internal-link entry while readonly and re-enables it on the same editor", async () => {
    // Regression (pre-integration review): the items were memoized on
    // `[editor, isMobile]`, so a readonly transition — or the host picker going
    // away — on the *same* editor kept the stale, enabled entry around.
    const picker = internalLinkPicker();
    const editor = makeEditor("<p>hello world</p>", picker);
    const props: ToolProps = {
      editor: editor as unknown as Editor,
      icon: "plus",
      title: strings.insert()
    };
    const view = renderView(<InsertBlock {...props} />);
    await click(view.container.querySelector("button"));

    expect(menuItem("internal-link")?.isHidden).toBeFalsy();
    expect(menuItem("internal-link")?.isDisabled).toBeFalsy();
    const enabled = view.container.querySelector(
      '[data-test-id="menu-button-internal-link"]'
    ) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);

    act(() => editor.setEditable(false));
    view.rerender(<InsertBlock {...props} />);

    expect(menuItem("internal-link")?.isHidden).toBeFalsy();
    expect(menuItem("internal-link")?.isDisabled).toBe(true);
    const disabled = view.container.querySelector(
      '[data-test-id="menu-button-internal-link"]'
    ) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);

    await click(disabled);
    await flushAsync();
    expect(picker).not.toHaveBeenCalled();
    expect(editor.getHTML()).not.toContain("<a");

    // Not latched: becoming editable again restores the action.
    act(() => editor.setEditable(true));
    view.rerender(<InsertBlock {...props} />);
    expect(menuItem("internal-link")?.isDisabled).toBe(false);

    editor.destroy();
  });

  test("hides the entry when the host picker disappears from the same editor", async () => {
    const editor = makeEditor("<p>hello world</p>", internalLinkPicker());
    const props: ToolProps = {
      editor: editor as unknown as Editor,
      icon: "plus",
      title: strings.insert()
    };
    const view = renderView(<InsertBlock {...props} />);
    await click(view.container.querySelector("button"));
    expect(menuItem("internal-link")?.isHidden).toBeFalsy();

    // The host re-registers (or drops) its picker on the same editor.
    (editor.storage as Record<string, unknown>).createInternalLink = undefined;
    view.rerender(<InsertBlock {...props} />);

    expect(menuItem("internal-link")?.isHidden).toBe(true);
    expect(
      view.container.querySelector('[data-test-id="menu-button-internal-link"]')
    ).toBeNull();

    editor.destroy();
  });
});

describe("addInternalLink tool — real button", () => {
  test("renders the real toolbar button and dispatches the link command on click", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/abc"
    }));
    const editor = makeEditor("<p>hello world</p>", picker);
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const view = renderView(
      <AddInternalLink {...toolProps(editor, "noteLink", strings.noteLink())} />
    );

    const button = view.container.querySelector("button");
    expect(button?.getAttribute("title")).toBe(strings.noteLink());
    expect((button as HTMLButtonElement)?.disabled).toBe(false);

    await click(button);
    await flushAsync();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0][0]).toBeUndefined();
    expect(editor.getHTML()).toContain('href="nn://note/abc"');
    expect(editor.getText()).toBe("hello world");

    editor.destroy();
  });

  test("is disabled and does not dispatch while the selection is already a link", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/abc"
    }));
    const editor = makeEditor(
      '<p><a href="nn://note/old" title="hello">hello</a> world</p>',
      picker
    );
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(editor.isActive("link")).toBe(true);

    const view = renderView(
      <AddInternalLink {...toolProps(editor, "noteLink", strings.noteLink())} />
    );
    const button = view.container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await click(button);
    await flushAsync();

    expect(picker).not.toHaveBeenCalled();
    expect(editor.getHTML()).toContain('href="nn://note/old"');

    editor.destroy();
  });
});

/**
 * The reported iPad flow: `Insert + -> Link to note -> Beta -> Create` leaves
 * the link at the paragraph start and the caret on the plain spacer after it,
 * where the editor still reports the link mark as active — so the bottom
 * `LinkSettings` menu immediately offers `editLink`/`removeLink` without any
 * hover popup range (`HoverPopupContext` is not provided here, exactly like the
 * real bottom toolbar).
 */
describe("edit/unlink at the creation ending caret — real buttons, no hover range", () => {
  test("EditLink right after creation re-targets the visible link, not the spacer", async () => {
    const picker = vi.fn(
      async (_attributes?: LinkAttributes): Promise<LinkAttributes> => ({
        href: "nn://note/beta",
        title: "Beta"
      })
    );
    const editor = makeEditor("<p></p>", picker);
    // Real "+" menu creation: the visible caption is the picked note's title.
    await createInternalLinkViaInsertMenu(editor);

    // The *actual* post-creation document state.
    expect(editor.getHTML()).toContain("<a");
    expect(editor.getText()).toBe("Beta ");
    expect(linkedText(editor)).toBe("Beta");
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(6); // one past the generated spacer
    const attrsBefore = jsonLinkAttrs(editor);
    expect(attrsBefore).toHaveLength(1);
    expect(attrsBefore[0].href).toBe("nn://note/beta");

    // Seam (documented): the supplied happy-dom editor leaves the caret after
    // the generated spacer, where the link is not the active mark, while the
    // iPad runtime reports the link at its inclusive end boundary (that is why
    // the bottom LinkSettings menu offers edit/unlink there). Model exactly
    // that supported boundary state with real Tiptap commands only — the caret
    // between the linked caption "Beta" [1, 5) and the spacer, plus the link's
    // own document attributes as a stored mark. No document content changes.
    const documentJSON = editor.getJSON();
    editor.commands.setTextSelection({ from: 5, to: 5 });
    editor.commands.setMark(Link.name, attrsBefore[0] as LinkAttributes);
    expect(editor.getJSON()).toEqual(documentJSON);
    // The precondition that makes LinkSettings offer edit/unlink.
    expect(editor.isActive("link")).toBe(true);
    expect(
      (getMarkAttributes(editor.state, Link.name) as LinkAttributes).href
    ).toBe("nn://note/beta");

    picker.mockResolvedValueOnce({ href: "nn://note/owner", title: "Owner" });
    const view = renderView(
      // No `HoverPopupContextProvider`: `selectedNode` is undefined and the
      // range falls back to `selectionToOffset` (the reported bug).
      <EditLink {...toolProps(editor, "linkEdit", strings.linkEdit())} />
    );
    const button = view.container.querySelector("button");
    expect(button?.getAttribute("title")).toBe(strings.linkEdit());

    await click(button);
    await flushAsync();

    // The internal branch was taken: the picker was pre-filled with the
    // existing href (the first call was the creation, without prefill).
    expect(picker).toHaveBeenCalledTimes(2);
    expect(picker.mock.calls[0][0]).toBeUndefined();
    expect((picker.mock.calls[1][0] as LinkAttributes | undefined)?.href).toBe(
      "nn://note/beta"
    );

    // Exactly one link, on the visible caption "Beta"; the trailing spacer is
    // still plain text and the caption is not duplicated or shifted.
    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="nn://note/owner"');
    expect(html).not.toContain("nn://note/beta");
    expect(html).toContain(">Beta</a> ");
    expect(editor.getText()).toBe("Beta ");
    expect(linkedText(editor)).toBe("Beta");

    // Exact serialized attributes: only the href changed.
    const attrsAfter = jsonLinkAttrs(editor);
    expect(attrsAfter).toHaveLength(1);
    expect(attrsAfter[0]).toEqual({
      ...attrsBefore[0],
      href: "nn://note/owner"
    });

    // What a real restart (serialize -> reopen) shows. The HTML parser drops
    // trailing whitespace at the end of a block, so the reopened text may lose
    // the generated spacer; the link and its caption must survive.
    const reopened = makeEditor(html);
    expect(reopened.getText()).toMatch(/^Beta ?$/);
    expect(linkedText(reopened)).toBe("Beta");
    expect(reopened.getHTML()).toContain('href="nn://note/owner"');
    expect(reopened.getHTML()).not.toContain("nn://note/beta");

    editor.destroy();
  });

  test("RemoveLink right after creation unlinks the visible link", async () => {
    const picker = vi.fn(
      async (_attributes?: LinkAttributes): Promise<LinkAttributes> => ({
        href: "nn://note/beta",
        title: "Beta"
      })
    );
    const editor = makeEditor("<p></p>", picker);
    await createInternalLinkViaInsertMenu(editor);

    // The actual post-creation document state (see the EditLink test above for
    // the documented reason the boundary state is modelled instead of asserted
    // on the raw happy-dom caret).
    expect(editor.getHTML()).toContain("<a");
    expect(editor.getText()).toBe("Beta ");
    expect(linkedText(editor)).toBe("Beta");
    const documentJSON = editor.getJSON();
    editor.commands.setTextSelection({ from: 5, to: 5 });
    editor.commands.setMark(Link.name, jsonLinkAttrs(editor)[0] as LinkAttributes);
    expect(editor.getJSON()).toEqual(documentJSON);
    expect(editor.isActive("link")).toBe(true);

    const view = renderView(
      // Same missing hover context as the LinkSettings menu.
      <RemoveLink {...toolProps(editor, "linkRemove", strings.linkRemove())} />
    );
    const button = view.container.querySelector("button");
    expect(button?.getAttribute("title")).toBe(strings.linkRemove());

    await click(button);
    await flushAsync();

    // The link the edit tool would target is the one that got removed; the
    // caption text is untouched.
    expect(editor.getHTML()).not.toContain("<a");
    expect(editor.getText()).toBe("Beta ");
    expect(editor.isActive("link")).toBe(false);
    expect(jsonLinkAttrs(editor)).toEqual([]);

    editor.destroy();
  });

  test("EditLink keeps the external form and setLink path for http(s) links", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/abc"
    }));
    const editor = makeEditor(
      '<p><a href="https://example.com" title="hello">hello</a> world</p>',
      picker
    );
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const view = renderView(
      <EditLink {...toolProps(editor, "linkEdit", strings.linkEdit())} />
    );
    await click(view.container.querySelector("button"));

    // External links never go through the internal-link picker.
    expect(picker).not.toHaveBeenCalled();
    const child = responsive.lastProps?.children as React.ReactElement<{
      onDone: (link: LinkDefinition) => void;
    }>;
    expect(child.type).toBe(LinkPopup);
    expect(typeof child.props.onDone).toBe("function");

    await act(async () => {
      child.props.onDone({ title: "hello", href: "https://example.org" });
    });
    await flushAsync();

    expect(picker).not.toHaveBeenCalled();
    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="https://example.org"');
    expect(html).not.toContain("https://example.com");
    expect(editor.getText()).toBe("hello world");

    editor.destroy();
  });
});

describe("edit/remove/open internal link — real buttons with hover context", () => {
  function hoverFixture(editor: TiptapEditor, from: number, to: number) {
    const node = editor.state.doc.nodeAt(from);
    const selectedNode: NodeWithOffset = { node: node ?? undefined, from, to };
    const hide = vi.fn();
    return { selectedNode, hide };
  }

  test("EditLink forwards the existing internal href and preserves the linked text", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => ({
      href: "nn://note/new"
    }));
    const editor = makeEditor(
      '<p><a href="nn://note/old" title="hello">hello</a> world</p>',
      picker
    );
    const { selectedNode, hide } = hoverFixture(editor, 1, 6);

    const view = renderView(
      <HoverPopupContextProvider value={{ selectedNode, hide }}>
        <EditLink {...toolProps(editor, "linkEdit", strings.linkEdit())} />
      </HoverPopupContextProvider>
    );

    const button = view.container.querySelector("button");
    expect(button?.getAttribute("title")).toBe(strings.linkEdit());

    await click(button);
    await flushAsync();

    // The host picker receives the pre-existing internal link attributes.
    expect(picker).toHaveBeenCalledTimes(1);
    const forwarded = picker.mock.calls[0][0] as LinkAttributes | undefined;
    expect(forwarded?.href).toBe("nn://note/old");

    // The new href is applied without duplicating or shifting the text.
    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="nn://note/new"');
    expect(html).toContain(">hello</a> world");
    expect(editor.getText()).toBe("hello world");
    expect(hide).toHaveBeenCalled();

    editor.destroy();
  });

  test("EditLink cancels cleanly: no document mutation when the picker resolves nothing", async () => {
    const picker = vi.fn(async (_attributes?: LinkAttributes) => undefined);
    const editor = makeEditor(
      '<p><a href="nn://note/old" title="hello">hello</a> world</p>',
      picker
    );
    const before = editor.getHTML();
    const { selectedNode, hide } = hoverFixture(editor, 1, 6);

    const view = renderView(
      <HoverPopupContextProvider value={{ selectedNode, hide }}>
        <EditLink {...toolProps(editor, "linkEdit", strings.linkEdit())} />
      </HoverPopupContextProvider>
    );

    await click(view.container.querySelector("button"));
    await flushAsync();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(editor.getHTML()).toBe(before);
    expect(hide).toHaveBeenCalled();

    editor.destroy();
  });

  test("RemoveLink selects the hovered internal link and runs unsetLink", async () => {
    const editor = makeEditor(
      '<p><a href="nn://note/abc" title="hello">hello</a> world</p>'
    );
    const { selectedNode, hide } = hoverFixture(editor, 1, 6);

    const view = renderView(
      <HoverPopupContextProvider value={{ selectedNode, hide }}>
        <RemoveLink {...toolProps(editor, "linkRemove", strings.linkRemove())} />
      </HoverPopupContextProvider>
    );

    const button = view.container.querySelector("button");
    expect(button?.getAttribute("title")).toBe(strings.linkRemove());

    await click(button);
    await flushAsync();

    expect(editor.getHTML()).not.toContain("<a");
    expect(editor.getText()).toBe("hello world");
    expect(hide).toHaveBeenCalled();

    editor.destroy();
  });

  test("OpenLink dispatches the host open action with the hovered href", async () => {
    const editor = makeEditor(
      '<p><a href="nn://note/abc" title="hello">hello</a> world</p>'
    );
    const openLink = vi.fn();
    (editor.storage as Record<string, unknown>).openLink = openLink;
    const { selectedNode, hide } = hoverFixture(editor, 1, 6);

    const view = renderView(
      <HoverPopupContextProvider value={{ selectedNode, hide }}>
        <OpenLink {...toolProps(editor, "openLink", strings.openLink())} />
      </HoverPopupContextProvider>
    );
    await flushAsync();

    const button = view.container.querySelector("button");
    expect(button?.getAttribute("title")).toBe(strings.openLink());

    await click(button);
    await flushAsync();

    expect(openLink).toHaveBeenCalledWith("nn://note/abc");
    expect(hide).toHaveBeenCalled();

    editor.destroy();
  });

  test("RemoveLink on a formatted fragment unlinks the link's full run only", async () => {
    const editor = makeEditor(
      '<p><a href="nn://note/to" title="T"><strong>Ta</strong>rget</a> tail</p>'
    );
    // Positions: "Ta" [1, 3), "rget" [3, 7), " tail" [7, 12).
    const before = jsonLinkAttrs(editor);
    expect(before).toHaveLength(2); // the caption is split over two nodes

    // The hover popup hands over only the hovered *fragment* node.
    const { selectedNode, hide } = hoverFixture(editor, 1, 3);
    expect(selectedNode.node?.textContent).toBe("Ta");

    const view = renderView(
      <HoverPopupContextProvider value={{ selectedNode, hide }}>
        <RemoveLink {...toolProps(editor, "linkRemove", strings.linkRemove())} />
      </HoverPopupContextProvider>
    );

    await click(view.container.querySelector("button"));
    await flushAsync();

    // The whole link run [1, 7) was unlinked: no fragment of the caption keeps
    // a link mark, the caption text and the neighbour survive.
    expect(jsonLinkAttrs(editor)).toEqual([]);
    expect(editor.getText()).toBe("Target tail");
    const html = editor.getHTML();
    expect(html).not.toContain("<a");
    expect(html).toContain("<strong>Ta</strong>rget tail");
    expect(hide).toHaveBeenCalled();

    editor.destroy();
  });

  test("RemoveLink without any link context is a no-op", async () => {
    const editor = makeEditor("<p>plain text</p>");
    editor.commands.setTextSelection({ from: 3, to: 3 });
    const jsonBefore = editor.getJSON();

    const view = renderView(
      <RemoveLink {...toolProps(editor, "linkRemove", strings.linkRemove())} />
    );
    await click(view.container.querySelector("button"));
    await flushAsync();

    expect(editor.getJSON()).toEqual(jsonBefore);
    expect(editor.getText()).toBe("plain text");
    expect(editor.getHTML()).not.toContain("<a");

    editor.destroy();
  });

  test("RemoveLink on an unresolved hovered text keeps the neighbouring link", async () => {
    const editor = makeEditor(
      '<p><a href="nn://note/x" title="One">One</a> plain</p>'
    );
    const before = editor.getJSON();
    // The hover popup hands over an *empty* range on the plain text, exactly at
    // the link's inclusive end boundary; the hovered node carries no link mark,
    // so there is no link context to resolve. Selecting that empty boundary and
    // calling `unsetLink` (whose empty mark range is extended) would unlink the
    // neighbouring link — this must be a no-op instead.
    const node = editor.state.doc.nodeAt(4);
    expect(node?.textContent).toBe(" plain");
    const selectedNode: NodeWithOffset = {
      node: node ?? undefined,
      from: 4,
      to: 4
    };
    const hide = vi.fn();

    const view = renderView(
      <HoverPopupContextProvider value={{ selectedNode, hide }}>
        <RemoveLink {...toolProps(editor, "linkRemove", strings.linkRemove())} />
      </HoverPopupContextProvider>
    );
    await click(view.container.querySelector("button"));
    await flushAsync();

    // Nothing was unlinked: the neighbouring link is byte-for-byte untouched.
    expect(editor.getJSON()).toEqual(before);
    expect(editor.getHTML()).toContain('href="nn://note/x"');
    expect(editor.getHTML()).toContain(">One</a>");
    expect(editor.getText()).toBe("One plain");

    editor.destroy();
  });
});

describe("production link fixture", () => {
  test("pins the shipping link configuration (inclusive, autolink off)", () => {
    // Guards the boundary contract the whole UI flow relies on: `.extend({
    // inclusive: true })` must win over `inclusive()` returning
    // `options.autolink` (disabled in production).
    const editor = makeEditor("<p>hello</p>");
    expect(editor.schema.marks.link.spec.inclusive).toBe(true);
    const link = editor.extensionManager.extensions.find(
      (extension) => extension.name === Link.name
    );
    expect(link?.options.autolink).toBe(false);
    expect(link?.options.linkOnPaste).toBe(true);
    expect(link?.options.openOnClick).toBe(false);

    editor.destroy();
  });
});
