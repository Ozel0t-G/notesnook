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
 * first-level `external-link` entry driven through the *real* mobile presenter
 * chain — no presenter seam is mocked here:
 *
 *   Toolbar -> InsertBlock -> ResponsivePresenter -> ActionSheetPresenter
 *   (react-modal) -> MenuButton (`#menu-item-external-link`)
 *   -> showLinkPopup -> showPopup (fresh React root) -> LinkPopup
 *   -> mobile `Popup` chrome (the `Insert` action button).
 *
 * This mirrors the app on iPhone/iPad with a minimal/custom toolbar
 * (`tools=[]`, so only the static "+" remains) and is asserted against the
 * *rendered* DOM — a live URL field, caption field and `Insert` action — never
 * against a captured factory or a spy. A "factory was called" assertion would
 * stay green while the sheet renders nothing, which is precisely the regression
 * this suite has to catch.
 *
 * Bounded, leaf-only seams (none of them on the presenter path):
 * - `@notesnook/intl`: a key-derived label map (lingui macros do not run under
 *   vitest/happy-dom), identical in spirit to the sibling insert-menu suite.
 * - `EditorFloatingMenus`: the toolbar's hover/search geometry, unrelated to
 *   the Insert menu, the same bounded seam the sibling toolbar suites use.
 * - `ResizeObserver`: happy-dom has no layout engine, so the real toolbar's row
 *   measurement is a leaf no-op — it keeps every group instead of collapsing
 *   them into "more".
 *
 * `ResponsivePresenter`, `ActionSheetPresenter`, `MenuButton`, `showPopup`,
 * `LinkPopup`, the `Popup` chrome and `react-modal` are all real.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import { EmotionThemeProvider } from "@notesnook/theme";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { Editor as TiptapEditor } from "@tiptap/core";
import { strings } from "@notesnook/intl";
// Import order matches the shipping entry point: `toolbar/index.ts` imports the
// tools registry (`findTool`) before any leaf tool module runs, so this suite
// imports the real `Toolbar` (and through it the registry) first instead of a
// test-only import-order cycle.
import { Toolbar } from "../../toolbar.js";
import { useToolbarStore } from "../../stores/toolbar-store.js";
import { Link } from "../../../extensions/link/index.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../../types.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Leaf seam only: the real `Toolbar` also renders `EditorFloatingMenus`, whose
 * search/hover-popup geometry is unrelated to the Insert menu under test.
 */
vi.mock("../../floating-menus/index.js", () => ({
  EditorFloatingMenus: () => null
}));

vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    insert: "Insert",
    chooseBlockToInsert: "Choose a block to insert",
    insertLink: "Insert link",
    link: "Link",
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
/**
 * The sibling suite's minimal theme plus the one thing the *real*
 * `ActionSheetPresenter` reads off the Emotion theme on every render:
 * `theme?.shadows.menu` (an unguarded `.menu` on `theme?.shadows`). Without a
 * real `shadows.menu` the sheet throws the moment it mounts.
 */
const testTheme = {
  iconSizes: shippingIconSizes,
  shadows: { menu: "0px 0px 0px 0px rgba(0, 0, 0, 0)" }
} as unknown as ThemeProviderTheme;

type Mounted = {
  container: HTMLElement;
  unmount: () => void;
};
let mounted: Mounted[] = [];
/**
 * `showPopup`'s root container (`getPopupRoot`) and react-modal's portals are
 * appended straight to `document.body` and are never removed by unmounting the
 * React tree, so each case removes exactly the body children it added.
 */
let bodyChildrenBefore: Element[] = [];

function renderView(ui: React.ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
  });
  act(() => {
    root.render(
      // The real theme providers (never mocked): a full, constructed
      // `@notesnook/theme` context for Emotion consumers, and the minimal
      // theme-ui theme on top, exactly like the sibling insert-menu suite.
      <EmotionThemeProvider scope="editorToolbar" injectCssVars={false}>
        <ThemeProvider theme={testTheme}>{ui}</ThemeProvider>
      </EmotionThemeProvider>
    );
  });
  const view: Mounted = {
    container,
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

/** Advances only the presenter's own timers (fake `setTimeout`/`clearTimeout`). */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
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

/** No layout engine in happy-dom: a leaf stub keeps the real toolbar intact. */
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

type ToolbarTools = Parameters<typeof Toolbar>[0]["tools"];
function renderMobileToolbar(
  editor: TiptapEditor,
  tools: ToolbarTools
): Mounted {
  return renderView(
    <Toolbar
      editor={editor as unknown as Editor}
      location="bottom"
      tools={tools}
      ios
      defaultFontFamily="sans-serif"
      defaultFontSize={14}
    />
  );
}

/**
 * Reads the real, *rendered* link popup out of the DOM. All three parts must
 * exist as connected elements inside the same react-modal sheet: the URL field,
 * the caption field next to the "Link text" label, and the persistent `Insert`
 * action button. Asserting existence here (not a captured factory) is the whole
 * point of this suite.
 */
function renderedLinkPopup() {
  const urlInput =
    document.querySelector<HTMLInputElement>('input[type="url"]');
  const insertButton = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.textContent?.trim() === strings.insert());
  if (!urlInput || !insertButton) return null;
  // Walk up to the smallest ancestor that holds both the fields and the action
  // button, so the caption/sheet assertions cannot match another mounted tree.
  let content: HTMLElement | null = urlInput;
  while (content && !content.contains(insertButton))
    content = content.parentElement;
  if (!content) return null;
  return {
    urlInput,
    insertButton,
    content,
    captionInput: content.querySelector<HTMLInputElement>('input[type="text"]')
  };
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
  // Only the presenter's own scheduling is faked; React, emotion, tiptap and
  // happy-dom keep their real timers/microtasks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  bodyChildrenBefore = Array.from(document.body.children);
  useToolbarStore.setState({
    isMobile: false,
    macCatalyst: false,
    toolbarLocation: "bottom"
  });
});

afterEach(() => {
  for (const view of mounted) {
    try {
      view.unmount();
    } catch {
      // A root that already threw while rendering may rethrow on unmount; the
      // case's own failure is the meaningful one, so cleanup stays quiet.
    }
  }
  mounted = [];
  for (const { editor, element } of editorFixtures) {
    if (!editor.isDestroyed) editor.destroy();
    element.remove();
  }
  editorFixtures.length = 0;
  for (const node of Array.from(document.body.children)) {
    if (!bodyChildrenBefore.includes(node)) node.remove();
  }
  bodyChildrenBefore = [];
  vi.useRealTimers();
});

describe("Insert (+) -> external-link through the real mobile presenters", () => {
  test("iPhone/iPad (tools=[]): the static Plus opens the real sheet, whose external-link entry renders the real LinkPopup and the sheet's Insert action, and cancelling mutates nothing", async () => {
    useToolbarStore.setState({ isMobile: true, macCatalyst: false });
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const before = editor.getJSON();
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };

    const view = renderMobileToolbar(editor, []);

    // The static "+" is the one and only Insert affordance left with tools=[].
    const plus = view.container.querySelector('[aria-label="Insert"]');
    expect(plus).toBeTruthy();
    await click(plus);

    // Real `ActionSheetPresenter` + real `MenuButton` render the first-level
    // entry; the sibling internal-link entry needs a host picker we did not
    // supply, so it must be absent from the rendered sheet entirely.
    const externalLink = document.getElementById("menu-item-external-link");
    expect(externalLink).toBeTruthy();
    expect(externalLink?.getAttribute("role")).toBe("menuitem");
    expect(document.getElementById("menu-item-internal-link")).toBeNull();

    await click(externalLink);
    // The sheet closes immediately; the entry's own invocation is handed off
    // after the presenter's 300 ms exit animation.
    expect(document.getElementById("menu-item-external-link")).toBeNull();
    await advance(300);

    const popup = renderedLinkPopup();
    expect(
      popup,
      "the real link popup (URL field, caption field and Insert action) must be in the DOM after the hand-off"
    ).toBeTruthy();
    expect(popup!.urlInput.placeholder).toBe("https://example.com/");
    expect(popup!.captionInput).toBeTruthy();
    expect(popup!.captionInput!.placeholder).toBe(strings.linkText());
    expect(popup!.insertButton.disabled).toBe(false);
    // The Insert menu is really gone; only the popup sheet remains. This is
    // what makes the header assertion below unambiguous: the unmounted
    // `external-link` entry is *itself* labelled "Insert link", so asserting
    // the title only after that node is gone rules out that false positive.
    expect(document.getElementById("menu-item-external-link")).toBeNull();

    // The hand-off opens its own real mobile sheet: the sheet header must carry
    // the localized "Insert link" title (the desktop `Popup` chrome's title is
    // never rendered on mobile, so this can only come from the presenter prop),
    // and the URL field must own focus so the on-screen keyboard opens.
    const sheet = popup!.urlInput.closest(".bottom-sheet-presenter");
    expect(
      sheet,
      "the popup must live inside the real mobile sheet"
    ).toBeTruthy();
    expect(sheet!.querySelector("#header")?.textContent?.trim()).toBe(
      strings.insertLink()
    );
    expect(document.activeElement).toBe(popup!.urlInput);

    // Cancel via the presenter's own back/close path: it must close without
    // touching the document or the selection.
    act(() => {
      window.dispatchEvent(new Event("handleBackPress"));
    });
    await advance(300);

    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);
  });

  test("iPhone/iPad: the dedicated addLink tool renders the same real LinkPopup in-tree and its Insert action really applies the link", async () => {
    useToolbarStore.setState({ isMobile: true, macCatalyst: false });
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const view = renderMobileToolbar(editor, [["addLink"]]);

    const linkTool =
      view.container.querySelector<HTMLButtonElement>("#tool-link");
    expect(linkTool).toBeTruthy();
    expect(linkTool!.title).toBe(strings.link());
    await click(linkTool);

    const popup = renderedLinkPopup();
    expect(
      popup,
      "the dedicated link tool must render the same real LinkPopup (URL field, caption field and Insert action)"
    ).toBeTruthy();
    expect(popup!.captionInput).toBeTruthy();
    expect(popup!.captionInput!.placeholder).toBe(strings.linkText());

    // The direct tool's sheet is the reference behavior this suite aligns the
    // Insert-menu hand-off with: same localized title header, same URL focus.
    const sheet = popup!.urlInput.closest(".bottom-sheet-presenter");
    expect(
      sheet,
      "the popup must live inside the real mobile sheet"
    ).toBeTruthy();
    expect(sheet!.querySelector("#header")?.textContent?.trim()).toBe(
      strings.insertLink()
    );
    expect(document.activeElement).toBe(popup!.urlInput);

    setInputValue(popup!.urlInput, "https://example.org");
    await click(popup!.insertButton);

    const html = editor.getHTML();
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain(">hello</a>");
    expect(editor.getText()).toBe("hello world");
  });
});
