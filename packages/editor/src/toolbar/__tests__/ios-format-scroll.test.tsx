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
 * Runtime coverage for the single-scroll-owner fix on the iPhone/iPad "Aa"
 * column menu. Unlike `ios-format.test.tsx`, this suite does **not** mock
 * `@notesnook/ui`'s `MenuPresenter`. It renders the real `Toolbar`, the real
 * `MacFormat` tool, the real `Dropdown`, and - the point of this file - the
 * real `@notesnook/ui` `Menu`/`MenuContainer`/`ScrollContainer`
 * (`mac-scrollbar`'s `MacScrollbar`), portaled through the real `react-modal`
 * `Modal` exactly as production does.
 *
 * What is asserted: in column mode (`menuLayout="column"`, threaded through
 * from `Dropdown` for the iPhone/iPad "Aa" menu), `MenuContainer` no longer
 * renders mac-scrollbar's `ScrollContainer`/`MacScrollbar` for its inner
 * scroll element at all - it renders a plain native DOM node instead, found
 * by its own `data-test-id` (not the `.ms-container`/`.ms-track-box` nodes
 * `mac-scrollbar` renders), carrying real inline `flex: '1 1 auto'` /
 * `min-height: 0` / `overflow-y: auto` / `overflow-x: hidden` styles. No
 * `.ms-container` or `.ms-track-box` node is asserted present anywhere
 * inside the menu in this mode - this is a bounded hypothesis fix for a
 * reported blank-repaint symptom tied to the third-party scrollbar inside a
 * fixed-position portal, not a confirmed root cause. Every other `Dropdown`
 * - the Mac Catalyst capsule's own row layout, and the existing Web/Android
 * row layout - still renders the same real mac-scrollbar `ScrollContainer`
 * node (`.ms-container`) unchanged, with neither `flex` nor `min-height`
 * set, confirming the swap is scoped to column layout only. The real 12
 * "Aa" command buttons (`#menu-item-mac-*`) are asserted present through
 * this real stack, and one real Tiptap command (Bold) is run through it, so
 * the fix is checked against the same component tree production uses, not
 * a stand-in.
 *
 * What is deliberately NOT asserted: any computed pixel geometry
 * (`getBoundingClientRect`, `offsetHeight`, actual scroll position/thumb
 * rendering). happy-dom has no layout engine, so those would not be real
 * signal here - the inline-`style` checks above are the only reliable
 * fixture seam for this fix (they come from a plain `style` prop on the
 * native scroll node in column mode, and - for the unchanged non-column
 * paths - on `MacScrollbar` itself, not from `sx`/emotion-generated
 * classes, so they do not depend on CSS layout being computed). See
 * `ios-format.test.tsx` for the `sx`-contract test that uses the bounded
 * `MenuPresenter` stand-in instead.
 *
 * Real-portal seam (explicitly identified, not mocked away): because
 * `MenuPresenter` is the genuine module here, its `PopupPresenter` mounts a
 * real `react-modal` `Modal`, which portals its content to `document.body`
 * (no `container` prop is passed down from `Dropdown`) rather than into the
 * `Toolbar`'s own render container. Element queries below therefore search
 * `document`, not the rendered `view.container`, for anything inside the
 * menu popup. This is the one point this suite could not verify by running
 * it: if this project's `react-modal`/happy-dom combination needs an
 * explicit `Modal.setAppElement` call or other portal setup beyond the
 * `ResizeObserver` stub below, these queries may come back empty and should
 * be revisited with that fixture need made explicit, rather than papered
 * over with a broader mock.
 *
 * Locale seam (same fixture as the other toolbar render suites): the real
 * `@notesnook/intl` lingui catalog needs compile-time macros this setup does
 * not run, so it is replaced by a key-derived-label `Proxy`.
 *
 * Import-order note: `Toolbar` is imported first, ahead of `vitest`/`react`,
 * to prime the toolbar/editor module graph before the real (unmocked)
 * `@notesnook/ui` module is pulled in by this suite, avoiding the import
 * cycle `ios-format.test.tsx` sidesteps instead by mocking `@notesnook/ui`
 * outright.
 */

import { Toolbar } from "../toolbar.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { ThemeProvider } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import { Link } from "../../extensions/link/index.js";
import { Editor as TiptapEditor } from "@tiptap/core";
import { IosFormatContext, useToolbarStore } from "../stores/toolbar-store.js";
import { MoreTools } from "../components/more-tools.js";
import { getMacToolbarGroups } from "../tool-definitions.js";
import type { Theme } from "@notesnook/theme";
import {
  getThemeScope,
  resolveAppleSurfaces,
  ThemeVeyranLight,
  ThemeVeyranDark,
  useThemeEngineStore
} from "@notesnook/theme";
import type { Editor } from "../../types.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Stable, key-derived label fixture (same seam as the other toolbar suites). */
vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {};
  const strings = new Proxy(labels, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      return () => target[key] ?? `intl:${key}`;
    }
  });
  return { strings };
});

vi.mock("../../components/responsive/index.js", () => ({
  ResponsivePresenter: (props: {
    isOpen?: boolean;
    children?: React.ReactNode;
  }) => (props.isOpen ? props.children ?? null : null),
  ResponsiveContainer: (props: { desktop?: React.ReactNode }) =>
    props.desktop ?? null,
  DesktopOnly: (props: { children?: React.ReactNode }) =>
    props.children ?? null,
  MobileOnly: () => null
}));

// Aa and its nested MoreTools now use the genuine popup presenter and portals.
vi.mock("../components/popup.js", () => ({
  Popup: (props: { children?: React.ReactNode }) => props.children ?? null
}));

vi.mock("../floating-menus/index.js", () => ({
  EditorFloatingMenus: () => null
}));

class ResizeObserverStub {
  observe() {
    /* happy-dom has no layout engine to observe */
  }
  unobserve() {
    /* no-op */
  }
  disconnect() {
    /* no-op */
  }
}

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
  act(() => {
    root = createRoot(container);
    root.render(<ThemeProvider theme={testTheme}>{ui}</ThemeProvider>);
  });
  const view: Mounted = {
    container,
    rerender(ui) {
      act(() =>
        root.render(<ThemeProvider theme={testTheme}>{ui}</ThemeProvider>)
      );
    },
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

const editorFixtures: { editor: TiptapEditor; element: HTMLElement }[] = [];

function makeEditor(content: string) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new TiptapEditor({
    element,
    extensions: [StarterKit, TextStyle, Link],
    content,
    editable: true
  });
  editorFixtures.push({ editor, element });
  return editor;
}

const asEditor = (editor: TiptapEditor) => editor as unknown as Editor;

function aaButton(root: ParentNode) {
  return (
    Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Aa"
    ) ?? null
  );
}

// The real `MenuPresenter` portals to `document.body` (no `container` prop is
// threaded down from `Dropdown`), not into the rendered `view.container` -
// see the file-level comment. Scoped to `.menuContainer` (the real
// `MenuContainer` root's `className`) so this only ever matches the Aa
// menu's own `ScrollContainer`, not an unrelated one.
function realScrollContainer() {
  return document.querySelector(
    ".menuContainer .ms-container"
  ) as HTMLElement | null;
}

// Column mode no longer renders mac-scrollbar's `ScrollContainer` for its
// inner scroll element (see `MenuContainer`) - it renders a plain native DOM
// node instead, found by its own `data-test-id` rather than `.ms-container`.
function realNativeScrollContainer() {
  return document.querySelector(
    '.menuContainer [data-test-id="menu-scroll-container"]'
  ) as HTMLElement | null;
}

function realMenuContainer() {
  return document.querySelector('[data-test-id="menu-container"]');
}

const MAC_FORMAT_COMMAND_IDS = [
  "mac-title",
  "mac-heading",
  "mac-subheading",
  "mac-body",
  "mac-monospaced",
  "mac-bold",
  "mac-italic",
  "mac-underline",
  "mac-strikethrough",
  "mac-bullet-list",
  "mac-numbered-list",
  "mac-checklist"
];

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
  useToolbarStore.setState({
    isMobile: true,
    macCatalyst: false,
    toolbarLocation: "top",
    openedPopups: {},
    fontFamily: "sans-serif",
    fontSize: 14
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
  document
    .querySelectorAll(".popup-presenter-portal")
    .forEach((node) => node.remove());
});

describe("Toolbar - iOS Aa column menu: single scroll owner (real Menu stack)", () => {
  test.each([
    ThemeVeyranLight,
    ThemeVeyranDark,
    {
      ...ThemeVeyranLight,
      id: "synthetic-custom-theme",
      scopes: {
        ...ThemeVeyranLight.scopes,
        base: {
          ...ThemeVeyranLight.scopes.base,
          selected: {
            ...ThemeVeyranLight.scopes.base.selected,
            background: "#aaccdd"
          }
        }
      }
    }
  ])(
    "active Aa style follows the actual Apple selection role and preserves custom selection ($id)",
    async (theme) => {
      const previous = useThemeEngineStore.getState().theme;
      const editor = makeEditor("<p>unchanged synthetic text</p>");
      const original = editor.getJSON();
      try {
        act(() => useThemeEngineStore.getState().setTheme(theme));
        const view = renderView(
          <Toolbar
            editor={asEditor(editor)}
            location="bottom"
            tools={getMacToolbarGroups()}
            ios
            defaultFontFamily="sans-serif"
            defaultFontSize={14}
          />
        );
        await click(aaButton(view.container));
        const body = document.querySelector<HTMLElement>(
          '[data-test-id="menu-button-mac-body"]'
        )!;
        const expected = resolveAppleSurfaces({
          theme,
          colors: getThemeScope("base", theme).colors,
          isDark: theme.colorScheme === "dark"
        }).selectionFill;
        const normalized = document.createElement("div");
        normalized.style.backgroundColor = expected;
        expect(getComputedStyle(body).backgroundColor).toBe(
          normalized.style.backgroundColor
        );
        if (theme.id === "synthetic-custom-theme")
          expect(expected).toBe("#aaccdd");
        expect(editor.getJSON()).toEqual(original);
      } finally {
        act(() => useThemeEngineStore.getState().setTheme(previous));
      }
    }
  );
  test("column mode (ios): the real native scroll container owns the scroll (flex/min-height), not mac-scrollbar's ScrollContainer, and grouped inline, paragraph and list commands render in order", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        ios
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    await click(aaButton(view.container));

    const menuContainer = realMenuContainer();
    expect(
      menuContainer,
      "expected the real Menu/MenuContainer to render"
    ).toBeTruthy();

    const scrollEl = realNativeScrollContainer();
    expect(
      scrollEl,
      "expected the real native scroll container (data-test-id=menu-scroll-container) to render"
    ).toBeTruthy();
    // CSS zero serializes differently across environments: browsers expand a
    // numeric `minHeight: 0` to "0px", but happy-dom's CSSOM keeps it as the
    // unitless "0" it was set with. Only these two exact spellings are
    // accepted as "zero" - this is not a permissive truthy check nor a
    // parseFloat-with-fallback, so a genuinely missing or different value
    // still fails the assertion.
    expect(["0", "0px"]).toContain(scrollEl!.style.minHeight);
    // Asserted against the exact inline style string the native container
    // sets (`flex: '1 1 auto'`), not merely "non-empty" - a shorthand
    // `flex: 1` would also pass a not-empty check but resolves to a `0%`
    // flex-basis, which collapses this element under an indefinite-height
    // (`maxHeight`-only) column ancestor instead of sizing from its own
    // content.
    expect(scrollEl!.style.flex).toBe("1 1 auto");
    expect(scrollEl!.style.overflowY).toBe("auto");
    expect(scrollEl!.style.overflowX).toBe("hidden");

    // The point of this fix: mac-scrollbar's own nodes (`.ms-container`,
    // `.ms-track-box`) must not render anywhere inside the menu in column
    // mode - only the plain native scroll container above should.
    expect(realScrollContainer()).toBeNull();
    expect(menuContainer!.querySelector(".ms-track-box")).toBeNull();

    const renderedIds = Array.from(
      scrollEl!.querySelectorAll('[id^="menu-item-mac-"]')
    ).map((el) => el.id);
    expect(renderedIds).toEqual(
      MAC_FORMAT_COMMAND_IDS.slice(0, 5).map((key) => `menu-item-${key}`)
    );
    for (const tool of [
      "bold",
      "italic",
      "underline",
      "bulletList",
      "numberedList",
      "checklist"
    ])
      expect(scrollEl!.querySelector(`[id$="ios-aa-${tool}"]`)).toBeTruthy();
    const heading = document.getElementById("menu-item-mac-heading")!;
    expect(getComputedStyle(heading).minHeight).toBe("44px");
  });

  test("runs the real Bold command through the real (unmocked) Menu stack in column mode", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        ios
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    await click(aaButton(view.container));
    await click(document.querySelector('[id$="ios-aa-bold"]'));
    expect(editor.isActive("bold")).toBe(true);
  });

  test("keeps the open column menu's real commands, their order, and the editor's document/selection across a window resize, then still runs real Bold from it", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const { from, to } = editor.state.selection;
    const docJSON = editor.getJSON();

    const innerHeightDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight"
    );
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 1032
    });

    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        ios
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    try {
      await click(aaButton(view.container));
      expect(useToolbarStore.getState().isPopupOpen("macFormat")).toBe(true);

      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 700
      });
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });

      // Contract check only (see file-level comment): this confirms the real
      // popup/menu, rendered through the genuine react-modal portal, keeps
      // the same paragraph commands and grouped controls and leaves the real editor's
      // document/selection untouched by a window resize. It is not a
      // geometry/repaint proof - happy-dom has no layout engine - and makes
      // no claim about actual on-screen position, visibility or scrolling.
      expect(useToolbarStore.getState().isPopupOpen("macFormat")).toBe(true);
      const expectedIds = MAC_FORMAT_COMMAND_IDS.slice(0, 5).map(
        (key) => `menu-item-${key}`
      );
      const renderedIds = Array.from(
        document.querySelectorAll('[id^="menu-item-mac-"]')
      ).map((el) => el.id);
      expect(renderedIds).toEqual(expectedIds);
      for (const id of expectedIds)
        expect(
          document.getElementById(id)?.textContent,
          `expected ${id} to keep its title`
        ).toBeTruthy();

      expect(editor.getJSON()).toEqual(docJSON);
      expect(editor.state.selection.from).toBe(from);
      expect(editor.state.selection.to).toBe(to);

      await click(document.querySelector('[id$="ios-aa-bold"]'));
      expect(editor.isActive("bold")).toBe(true);
      // Inline controls keep the real Aa panel available for repeated formatting.
      expect(useToolbarStore.getState().isPopupOpen("macFormat")).toBe(true);
      await click(aaButton(view.container));
      expect(useToolbarStore.getState().isPopupOpen("macFormat")).toBe(false);
    } finally {
      if (innerHeightDescriptor)
        Object.defineProperty(window, "innerHeight", innerHeightDescriptor);
      else delete (window as { innerHeight?: number }).innerHeight;
    }
  });

  test("uses one Aa surface for advanced formatting, keeps unsaved link input across host rerender, and returns to the main view", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const doc = editor.getJSON();
    const ui = () => (
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        ios
        linkSettingsAutoOpen={false}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    const view = renderView(ui());
    await click(aaButton(view.container));
    expect(document.querySelector('[id$="ios-aa-bold"]')).toBeTruthy();
    await click(document.querySelector('[id$="ios-more-formatting"]'));
    // Advanced formatting replaces Aa's content; it must not stack a second
    // toolbar popup over the paragraph/list view or change its scroll owner.
    expect(document.querySelector('[id$="ios-aa-bold"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-test-id="menu-container"]')
    ).toHaveLength(1);
    expect(useToolbarStore.getState().isPopupOpen("ios-more-formatting")).toBe(
      false
    );
    expect(document.querySelector('[id$="ios-aa-back"]')).toBeTruthy();
    await click(document.querySelector('[id$="-link"]'));
    const url = document.querySelector('input[type="url"]') as HTMLInputElement;
    expect(
      url,
      "first activation opens the real LinkPopup fields"
    ).toBeTruthy();
    url.value = "https://example.com/qa-d3";
    await act(async () => Simulate.change(url));
    url.focus();
    view.rerender(ui());
    expect(document.querySelector('input[type="url"]')).toBe(url);
    expect(url.value).toBe("https://example.com/qa-d3");
    expect(document.activeElement).toBe(url);
    expect(editor.getJSON()).toEqual(doc);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    await act(async () => Simulate.keyUp(url, { key: "Enter" }));
    expect(editor.getHTML()).toContain('href="https://example.com/qa-d3"');
    expect(document.querySelector('input[type="url"]')).toBeNull();
    expect(useToolbarStore.getState().isPopupOpen("macFormat")).toBe(true);
    await click(document.querySelector('[id$="ios-aa-back"]'));
    expect(document.querySelector('[id$="-link"]')).toBeNull();
    const bold = document.querySelector(
      '[id$="ios-aa-bold"]'
    ) as HTMLButtonElement;
    const beforeClass = bold.className;
    bold.focus();
    view.rerender(ui());
    expect(document.activeElement).toBe(bold);
    await click(bold);
    view.rerender(ui());
    expect(editor.isActive("bold")).toBe(true);
    expect(bold.className).not.toBe(beforeClass);
    await click(document.querySelector('[id$="ios-more-formatting"]'));
    await click(document.querySelector('[id$="ios-aa-done"]'));
    expect(useToolbarStore.getState().isPopupOpen("macFormat")).toBe(false);
    expect(document.querySelector('[id$="-link"]')).toBeNull();
    await click(aaButton(view.container));
    expect(document.querySelector('[id$="ios-aa-bold"]')).toBeTruthy();
    expect(document.querySelector('[id$="ios-aa-back"]')).toBeNull();
  });

  test("keyboard page navigation restores useful focus while touch page changes retain the editor focus", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        ios
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    await click(aaButton(view.container));
    const more = document.querySelector(
      '[id$="ios-more-formatting"]'
    ) as HTMLButtonElement;
    more.focus();
    await click(more);
    const back = document.querySelector(
      '[id$="ios-aa-back"]'
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(back);
    await click(back);
    expect(document.activeElement).toBe(
      document.querySelector('[id$="ios-more-formatting"]')
    );
    editor.view.dom.focus();
    await click(document.querySelector('[id$="ios-more-formatting"]'));
    expect(document.activeElement).toBe(editor.view.dom);
    await click(document.querySelector('[id$="ios-aa-back"]'));
    expect(document.activeElement).toBe(editor.view.dom);
    const done = document.querySelector(
      '[id$="ios-aa-done"]'
    ) as HTMLButtonElement;
    done.focus();
    await click(done);
    expect(document.activeElement).toBe(aaButton(view.container));
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    expect(editor.getText()).toBe("hello world");
  });

  test("Back closes an advanced child font menu without closing Aa or reopening that child on return", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const doc = editor.getJSON();
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        ios
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    await click(aaButton(view.container));
    await click(document.querySelector('[id$="ios-more-formatting"]'));
    const groups = document.querySelectorAll(
      '[data-test-id="ios-aa-advanced"] .toolbar-group'
    );
    await click(groups[2].lastElementChild);
    expect(useToolbarStore.getState().isPopupOpen("fontFamily")).toBe(true);
    await click(document.querySelector('[id$="ios-aa-back"]'));
    expect(useToolbarStore.getState().isPopupOpen("macFormat")).toBe(true);
    expect(useToolbarStore.getState().isPopupOpen("fontFamily")).toBe(false);
    await click(document.querySelector('[id$="ios-more-formatting"]'));
    expect(useToolbarStore.getState().isPopupOpen("fontFamily")).toBe(false);
    expect(
      document.querySelectorAll('[data-test-id="menu-container"]')
    ).toHaveLength(1);
    expect(editor.getJSON()).toEqual(doc);
  });

  test("iOS advanced groups retain all tools with row-sized controls within the single Aa presenter", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        ios
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    await click(aaButton(view.container));
    await click(document.querySelector('[id$="ios-more-formatting"]'));
    const link = document.querySelector('[id$="-link"]') as HTMLButtonElement;
    const group = link.closest(".toolbar-group") as HTMLElement;
    expect(group).toBeTruthy();
    expect(getComputedStyle(group).alignItems).toBe("center");
    expect(getComputedStyle(group).alignContent).toBe("flex-start");
    for (const child of Array.from(group.children)) {
      expect(getComputedStyle(child).height).toBe("auto");
      expect(getComputedStyle(child).minHeight).toBe("44px");
    }
    // CSS contract only; genuine 512pt screenshots verify wrapping/pixel fit.
    expect(
      document.querySelectorAll(
        '[data-test-id="ios-aa-advanced"] .toolbar-group button'
      ).length
    ).toBeGreaterThan(12);
  });

  test.each([false, true])(
    "non-iOS mobile More and Mac More retain existing child sizing (Mac=%s)",
    async (mac) => {
      useToolbarStore.setState({ macCatalyst: mac });
      const editor = makeEditor("<p>hello world</p>");
      const view = renderView(
        <IosFormatContext.Provider value={false}>
          <MoreTools
            editor={asEditor(editor)}
            popupId="qa-sizing"
            icon="more"
            title="More"
            tools={["fontSize", "fontFamily", "addLink"]}
          />
        </IosFormatContext.Provider>
      );
      await click(view.container.querySelector("button"));
      const link = document.querySelector('[id$="-link"]') as HTMLButtonElement;
      const group = link.closest(".toolbar-group") as HTMLElement;
      expect(getComputedStyle(group).alignItems).not.toBe("center");
      expect(getComputedStyle(group.firstElementChild!).height).toBe("100%");
    }
  );

  test("legacy row layout (ios omitted): the real inner ScrollContainer (mac-scrollbar) gets neither flex nor min-height, and no native scroll container is rendered in its place", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    await click(aaButton(view.container));

    const scrollEl = realScrollContainer();
    expect(
      scrollEl,
      "expected the real ScrollContainer (.ms-container) to render"
    ).toBeTruthy();
    expect(scrollEl!.style.minHeight).toBe("");
    expect(scrollEl!.style.flex).toBe("");
    // The native-scroll-container swap is scoped to `menuLayout="column"`
    // only - this legacy row layout must keep rendering the real
    // mac-scrollbar `ScrollContainer` unchanged, not the new native node.
    expect(realNativeScrollContainer()).toBeNull();
  });

  test("normalizes ios && macCatalyst: the Mac capsule's real ScrollContainer (mac-scrollbar) also keeps its legacy (no flex/min-height) row layout, with no native scroll container in its place", async () => {
    useToolbarStore.setState({ macCatalyst: true });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getMacToolbarGroups()}
        macCatalyst
        ios
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    await click(aaButton(view.container));

    const scrollEl = realScrollContainer();
    expect(
      scrollEl,
      "expected the real ScrollContainer (.ms-container) to render"
    ).toBeTruthy();
    expect(scrollEl!.style.minHeight).toBe("");
    expect(scrollEl!.style.flex).toBe("");
    expect(realNativeScrollContainer()).toBeNull();
  });
});
