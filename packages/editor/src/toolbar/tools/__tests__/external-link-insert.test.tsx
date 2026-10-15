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
 * Real-DOM (ReactDOM + happy-dom) coverage for the Insert "+" menu's
 * first-level `external-link` entry (the point of this change: a plain link
 * reachable even with a custom/minimal toolbar on iPhone/iPad/Mac).
 *
 * Exercised for real: `InsertBlock` / `getInsertMenuItems`, the real
 * `showLinkPopup` (`toolbar/popups/link-popup.tsx`) and the real `LinkPopup`
 * component, against a real `@tiptap/starter-kit` + production `Link` (+
 * `TextStyle`/`Color`) editor. No business logic of `showLinkPopup` or the
 * link commands is reimplemented or spied on; only the DOM is driven.
 *
 * Mocked seams (named, bounded):
 * - `ResponsivePresenter` (`components/responsive`): renders the real
 *   `MenuItem[]` as plain DOM buttons. The themed menu/portal presentation is
 *   out of scope here, same as the sibling internal-link suite.
 * - `showPopup` (`components/popup-presenter`): captures the `{ popup }`
 *   option `showLinkPopup` builds instead of mounting it through the real
 *   (portal-based) popup presenter. The captured `popup(close)` factory is
 *   the real one and is invoked by the test to obtain the real `LinkPopup`
 *   element, which is then mounted and driven like a user would.
 * - `Popup` (`toolbar/components/popup.js`, the `LinkPopup` chrome only): a
 *   passthrough so its `children` - the real title/url `Input`s - render.
 * - `@notesnook/intl`: a controlled, key-derived label map (lingui macros do
 *   not run under vitest/happy-dom), identical in spirit to the sibling
 *   internal-link suite.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { Editor as TiptapEditor } from "@tiptap/core";
import { strings } from "@notesnook/intl";
// Import order matches the shipping entry point: `toolbar/index.ts` imports
// the tools registry (`findTool`) before any leaf tool module runs, so this
// suite imports the real `Toolbar` before the leaf `InsertBlock` too, instead
// of a test-only import-order cycle that left `findTool` undefined for
// `ToolbarGroup`.
import { Toolbar } from "../../toolbar.js";
import { InsertBlock } from "../block.js";
import { LinkPopup } from "../../popups/link-popup.js";
import { useToolbarStore } from "../../stores/toolbar-store.js";
import { Link } from "../../../extensions/link/index.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../../types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const responsive = vi.hoisted(() => ({
  lastProps: null as
    | {
        isOpen?: boolean;
        items?: Record<string, unknown>[];
        onClose?: () => void;
      }
    | null
}));

vi.mock("../../../components/responsive/index.js", () => {
  function ResponsivePresenter(props: Record<string, unknown>) {
    responsive.lastProps = props as unknown as typeof responsive.lastProps;
    if (!props.isOpen) return null;
    const items = (props.items as Record<string, unknown>[] | undefined) ?? [];
    return (
      <div data-test-id="responsive-presenter">
        {items
          .filter((item) => !item.isHidden)
          .map((item) =>
            item.type === "button" ? (
              <button
                key={item.key as string}
                data-test-id={`menu-button-${item.key as string}`}
                title={item.title as string}
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

type CapturedShowPopupOptions = {
  popup: (close: () => void) => React.ReactElement;
  mobile?: string;
  desktop?: string;
};
const popupPresenter = vi.hoisted(() => ({
  options: null as null | CapturedShowPopupOptions
}));

vi.mock("../../../components/popup-presenter/index.js", () => ({
  showPopup: (options: CapturedShowPopupOptions) => {
    popupPresenter.options = options;
  },
  PopupWrapper: (props: { children?: React.ReactNode }) =>
    props.children ?? null
}));

/** Leaf seam of `LinkPopup`'s chrome only (see header); its `children` render. */
vi.mock("../../components/popup.js", () => ({
  Popup: (props: { children?: React.ReactNode }) => props.children ?? null
}));

/**
 * The real `Toolbar` (mounted below for the mobile/Mac Catalyst Insert "+"
 * coverage) also renders `EditorFloatingMenus`, whose search/hover-popup
 * geometry is unrelated to the Insert menu under test here; replaced with a
 * no-op, same bounded seam as the sibling `ios-format.test.tsx` suite.
 */
vi.mock("../../floating-menus/index.js", () => ({
  EditorFloatingMenus: () => null
}));

vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    insert: "Insert",
    chooseBlockToInsert: "Choose a block to insert",
    insertLink: "Insert link",
    editLink: "Edit",
    linkText: "Link text",
    url: "URL",
    save: "Save"
  };
  const strings = new Proxy(labels, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      return () => target[key] ?? `intl:${key}`;
    }
  });
  return { strings };
});

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

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Mirrors RTL's `fireEvent.change` for an uncontrolled native input. */
function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** `LinkPopup` submits on Enter (`onKeyUp`), exactly like clicking "Insert". */
function pressEnter(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", bubbles: true })
    );
  });
}

const productionLink = () =>
  Link.extend({ inclusive: true }).configure({
    autolink: false,
    openOnClick: false,
    linkOnPaste: true,
    protocols: [{ scheme: "nn" }]
  });

const editorFixtures: { editor: TiptapEditor; element: HTMLElement }[] = [];
function makeEditor(content: string) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new TiptapEditor({
    element,
    extensions: [StarterKit, productionLink(), TextStyle, Color],
    content
  });
  editorFixtures.push({ editor, element });
  return editor;
}

async function openInsertMenu(editor: TiptapEditor) {
  const view = renderView(
    <InsertBlock
      editor={editor as unknown as Editor}
      icon="plus"
      title={strings.insert()}
    />
  );
  await click(view.container.querySelector("button"));
  return view;
}

function menuItem(key: string) {
  const items = (responsive.lastProps?.items ?? []) as Record<
    string,
    unknown
  >[];
  return items.find((item) => item.key === key) as
    | {
        key: string;
        type: string;
        title: string;
        icon?: string;
        isHidden?: boolean;
        isDisabled?: boolean;
        onClick?: () => unknown;
        menu?: unknown;
      }
    | undefined;
}

/**
 * happy-dom has no layout engine: the real `Toolbar`'s row-measurement effect
 * (mobile/Mac Catalyst) observes this and reads a 0 `clientWidth`, so it
 * keeps every group instead of collapsing into "more" - same bounded seam as
 * the sibling `ios-format.test.tsx`/`quiet-link-settings.test.tsx` suites.
 */
class ResizeObserverStub {
  observe() {
    /* no layout to observe */
  }
  unobserve() {
    /* no-op */
  }
  disconnect() {
    /* no-op */
  }
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
  responsive.lastProps = null;
  popupPresenter.options = null;
  useToolbarStore.setState({
    isMobile: false,
    macCatalyst: false,
    toolbarLocation: "top"
  });
});

afterEach(() => {
  for (const view of mounted) view.unmount();
  mounted = [];
  for (const { editor, element } of editorFixtures) {
    if (!editor.isDestroyed) editor.destroy();
    element.remove();
  }
  editorFixtures.length = 0;
});

describe("Insert (+) menu — external-link first-level entry", () => {
  test("is always shown and localized, even without a createInternalLink host", async () => {
    const editor = makeEditor("<p>hello world</p>");
    await openInsertMenu(editor);

    const item = menuItem("external-link");
    expect(item).toBeTruthy();
    expect(item?.type).toBe("button");
    expect(item?.title).toBe(strings.insertLink());
    expect(item?.isHidden).toBeFalsy();
    expect(typeof item?.icon).toBe("string");
    expect(item?.icon).toBeTruthy();

    // The sibling internal-link entry is hidden (no host picker was given);
    // the external-link entry needs no such capability and stays reachable.
    expect(menuItem("internal-link")?.isHidden).toBe(true);

    // First-level, real-rendered assertion: the entry is a direct top-level
    // item (no nested `menu`, unlike e.g. "image") and the actual DOM button
    // carries its real title and is not disabled.
    expect(item?.menu).toBeUndefined();
    const rendered = document.querySelector(
      '[data-test-id="menu-button-external-link"]'
    ) as HTMLButtonElement;
    expect(rendered).toBeTruthy();
    expect(rendered.title).toBe(strings.insertLink());
    expect(rendered.disabled).toBe(false);
  });

  test("disables the entry while readonly and aborts the invocation even if called directly", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = await openInsertMenu(editor);
    expect(menuItem("external-link")?.isDisabled).toBeFalsy();

    act(() => editor.setEditable(false));
    view.rerender(
      <InsertBlock
        editor={editor as unknown as Editor}
        icon="plus"
        title={strings.insert()}
      />
    );

    expect(menuItem("external-link")?.isDisabled).toBe(true);
    const disabled = view.container.querySelector(
      '[data-test-id="menu-button-external-link"]'
    ) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);

    // Direct invocation (bypassing the disabled DOM attribute entirely) must
    // still be refused by the handler's own readonly guard.
    menuItem("external-link")?.onClick?.();
    await flushAsync();

    expect(popupPresenter.options).toBeNull();
    expect(editor.getHTML()).not.toContain("<a");
  });

  test("aborts the invocation when the editor is destroyed", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = await openInsertMenu(editor);
    const button = view.container.querySelector(
      '[data-test-id="menu-button-external-link"]'
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    editor.destroy();
    await click(button);
    await flushAsync();

    expect(popupPresenter.options).toBeNull();
  });

  test("opens the real LinkPopup and applies toggleLink on Enter for a plain selection", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    await openInsertMenu(editor);
    await click(
      document.querySelector('[data-test-id="menu-button-external-link"]')
    );
    await flushAsync();

    expect(popupPresenter.options).toBeTruthy();
    const element = popupPresenter.options!.popup(() => {});
    expect(element.type).toBe(LinkPopup);
    expect((element.props as { isEditing?: boolean }).isEditing).toBeFalsy();

    const popupView = renderView(element);
    const urlInput = popupView.container.querySelector(
      'input[type="url"]'
    ) as HTMLInputElement;
    expect(urlInput).toBeTruthy();
    setInputValue(urlInput, "https://example.org");
    pressEnter(urlInput);

    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain(">hello</a>");
    // Same existing `toggleLink` semantics: the selected text is preserved.
    expect(editor.getText()).toBe("hello world");
  });

  test("leaves unrelated formatting (bold) untouched when creating a new link", async () => {
    const editor = makeEditor("<p><strong>Keep</strong> hello world</p>");
    // "Keep" occupies [1, 5); " hello world" follows, so "hello" is [6, 11).
    editor.commands.setTextSelection({ from: 6, to: 11 });

    await openInsertMenu(editor);
    await click(
      document.querySelector('[data-test-id="menu-button-external-link"]')
    );
    await flushAsync();

    const element = popupPresenter.options!.popup(() => {});
    const popupView = renderView(element);
    const urlInput = popupView.container.querySelector(
      'input[type="url"]'
    ) as HTMLInputElement;
    setInputValue(urlInput, "https://example.org");
    pressEnter(urlInput);

    const html = editor.getHTML();
    expect(html).toContain("<strong>Keep</strong>");
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain(">hello</a>");
    expect(editor.getText()).toBe("Keep hello world");
  });

  test("supports undo/redo and survives serialization + reopen", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    await openInsertMenu(editor);
    await click(
      document.querySelector('[data-test-id="menu-button-external-link"]')
    );
    await flushAsync();

    const element = popupPresenter.options!.popup(() => {});
    const popupView = renderView(element);
    const urlInput = popupView.container.querySelector(
      'input[type="url"]'
    ) as HTMLInputElement;
    setInputValue(urlInput, "https://example.org");
    pressEnter(urlInput);

    expect(editor.getHTML()).toContain("<a");

    editor.commands.undo();
    expect(editor.getHTML()).not.toContain("<a");

    editor.commands.redo();
    expect(editor.getHTML()).toContain("<a");
    expect(editor.getHTML()).toContain('href="https://example.org"');

    const html = editor.getHTML();
    const reopened = new TiptapEditor({
      extensions: [StarterKit, productionLink(), TextStyle, Color],
      content: html
    });
    expect(reopened.getHTML()).toContain('href="https://example.org"');
    expect(reopened.getHTML()).toContain(">hello</a>");
    expect(reopened.getText()).toBe("hello world");
    reopened.destroy();
  });

  test("cancel (onClose) performs no document mutation", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const before = editor.getHTML();

    await openInsertMenu(editor);
    await click(
      document.querySelector('[data-test-id="menu-button-external-link"]')
    );
    await flushAsync();

    const closeSpy = vi.fn();
    const element = popupPresenter.options!.popup(closeSpy);
    (element.props as { onClose: () => void }).onClose();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(editor.getHTML()).toBe(before);
    expect(editor.getText()).toBe("hello world");
  });

  test("an active external link takes the edit path: simple href change, caption preserved", async () => {
    const editor = makeEditor(
      '<p><a href="https://example.com" title="hello">hello</a> world</p>'
    );
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(editor.isActive(Link.name)).toBe(true);

    await openInsertMenu(editor);
    await click(
      document.querySelector('[data-test-id="menu-button-external-link"]')
    );
    await flushAsync();

    expect(popupPresenter.options).toBeTruthy();
    const element = popupPresenter.options!.popup(() => {});
    expect(element.type).toBe(LinkPopup);
    expect((element.props as { isEditing?: boolean }).isEditing).toBe(true);

    const popupView = renderView(element);
    const urlInput = popupView.container.querySelector(
      'input[type="url"]'
    ) as HTMLInputElement;
    expect(urlInput.value).toBe("https://example.com");
    setInputValue(urlInput, "https://example.org");
    pressEnter(urlInput);

    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="https://example.org"');
    expect(html).not.toContain("example.com");
    expect(html).toContain(">hello</a> world");
    expect(editor.getText()).toBe("hello world");
  });
});

describe("production link fixture", () => {
  test("pins the shipping link configuration (inclusive, autolink off)", () => {
    const editor = makeEditor("<p>hello</p>");
    expect(editor.schema.marks.link.spec.inclusive).toBe(true);
    const link = editor.extensionManager.extensions.find(
      (extension) => extension.name === Link.name
    );
    expect(link?.options.autolink).toBe(false);
    expect(link?.options.openOnClick).toBe(false);
  });
});

describe("Insert (+) menu via the real mobile Toolbar — iOS and Mac Catalyst", () => {
  function renderMobileToolbar(editor: TiptapEditor, macCatalyst: boolean) {
    return renderView(
      <Toolbar
        editor={editor as unknown as Editor}
        location="bottom"
        tools={[]}
        macCatalyst={macCatalyst}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
  }

  test("iPhone/iPad (tools=[]): the static Plus still renders and reaches the real first-level external-link entry", async () => {
    useToolbarStore.setState({ isMobile: true, macCatalyst: false });
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const view = renderMobileToolbar(editor, false);

    const plus = view.container.querySelector(
      `[title="${strings.insert()}"]`
    ) as HTMLButtonElement;
    expect(plus).toBeTruthy();
    await click(plus);

    // No `createInternalLink` capability was given: the sibling entry stays
    // out of the rendered menu entirely.
    expect(
      view.container.querySelector(
        '[data-test-id="menu-button-internal-link"]'
      )
    ).toBeNull();

    const external = view.container.querySelector(
      '[data-test-id="menu-button-external-link"]'
    ) as HTMLButtonElement;
    expect(external).toBeTruthy();
    expect(external.disabled).toBe(false);

    await click(external);
    await flushAsync();

    expect(popupPresenter.options).toBeTruthy();
    const element = popupPresenter.options!.popup(() => {});
    expect(element.type).toBe(LinkPopup);
  });

  test("Mac Catalyst (tools=[]): the static Plus renders under isMobile+macCatalyst, exposes internal-link once the host supplies the capability, and still reaches external-link", async () => {
    useToolbarStore.setState({ isMobile: true, macCatalyst: true });
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.storage.createInternalLink = vi.fn();
    const view = renderMobileToolbar(editor, true);

    const plus = view.container.querySelector(
      `[title="${strings.insert()}"]`
    ) as HTMLButtonElement;
    expect(plus).toBeTruthy();
    await click(plus);

    const internal = view.container.querySelector(
      '[data-test-id="menu-button-internal-link"]'
    ) as HTMLButtonElement;
    expect(internal).toBeTruthy();
    expect(internal.disabled).toBe(false);

    const external = view.container.querySelector(
      '[data-test-id="menu-button-external-link"]'
    ) as HTMLButtonElement;
    expect(external).toBeTruthy();
    expect(external.disabled).toBe(false);

    await click(external);
    await flushAsync();

    expect(popupPresenter.options).toBeTruthy();
    const element = popupPresenter.options!.popup(() => {});
    expect(element.type).toBe(LinkPopup);
  });
});
