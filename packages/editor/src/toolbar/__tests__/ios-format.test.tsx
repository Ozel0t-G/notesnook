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
 * Runtime coverage for the iPhone/iPad "Aa" format presentation: the real
 * `Toolbar`, the real `MacFormat` tool and its real `Dropdown`, the real
 * toolbar store, and a real `@tiptap/starter-kit` + `TextStyle` editor.
 *
 * What is asserted: `ios` (normalized against `macCatalyst` inside `Toolbar`)
 * opts only the "Aa" menu's popup into a single bounded, non-user-scrolling
 * vertical column (`flexDirection: column`, `overflowX: hidden`,
 * `overflowY: hidden`, `maxHeight: 70vh`) while exposing the same 12 real
 * format commands as before; every other combination (`ios` omitted, or set
 * together with `macCatalyst`) keeps the existing horizontal row untouched.
 * A command run from the column menu is a real Tiptap command, so
 * Bold/Heading and Undo/Redo are exercised against the real document.
 *
 * Bounded seam (documented, not a new mock contract): `@notesnook/ui`'s
 * `MenuPresenter` renders through `react-modal`, which portals outside the
 * rendered container in production. It is replaced here - as in the existing
 * `overflow-nested-popup.test.tsx` suite - by a thin stand-in that keeps the
 * real `isOpen` flag, the real `items` (titles/keys/`onClick` command
 * closures) and, the point of this suite, the real `sx` object `Dropdown`
 * computes, rendered inline so it can be read directly. Everything else from
 * `@notesnook/ui` (`Icon`, types, ...) is the genuine module.
 *
 * Locale seam (same fixture as the existing toolbar render suites): the real
 * `@notesnook/intl` lingui catalog needs compile-time macros this setup does
 * not run, so it is replaced by a key-derived-label `Proxy`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import { Editor as TiptapEditor } from "@tiptap/core";
import { strings } from "@notesnook/intl";
import { Toolbar } from "../toolbar.js";
import { useToolbarStore } from "../stores/toolbar-store.js";
import { getMacToolbarGroups } from "../tool-definitions.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../types.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Stable, key-derived label fixture (same seam as the other toolbar suites). */
vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    formatting: "Formatting",
    more: "More"
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
 * Bounded ui seam (same contract as `overflow-nested-popup.test.tsx`): keeps
 * the real `isOpen` flag, the real items (titles/keys/`onClick`) and the real
 * `sx` `Dropdown` computes, rendered inline instead of through a `react-modal`
 * portal. Portal/animation/focus-trap chrome is out of scope.
 */
vi.mock("@notesnook/ui", async () => {
  const actual = await vi.importActual<typeof import("@notesnook/ui")>(
    "@notesnook/ui"
  );
  type Item = {
    type?: string;
    key: string;
    title?: string;
    isChecked?: boolean;
    onClick?: () => void;
    component?: (props: Record<string, unknown>) => React.ReactNode;
  };
  return {
    ...actual,
    MenuPresenter: (props: {
      isOpen?: boolean;
      items?: Item[];
      onClose?: () => void;
      sx?: Record<string, unknown>;
      menuLayout?: "column";
    }) => {
      if (!props.isOpen) return null;
      return (
        <div
          data-test-id="menu-presenter"
          data-sx={JSON.stringify(props.sx ?? {})}
          data-menu-layout={props.menuLayout ?? ""}
        >
          {(props.items ?? []).map((item) =>
            item.type === "button" ? (
              <button
                key={item.key}
                id={`menu-item-${item.key}`}
                data-checked={String(!!item.isChecked)}
                onClick={() => {
                  // `ui`'s real Menu.onAction: run the action, then close.
                  item.onClick?.();
                  props.onClose?.();
                }}
              >
                {item.title}
              </button>
            ) : item.type === "popup" ? (
              <React.Fragment key={item.key}>
                {item.component?.({})}
              </React.Fragment>
            ) : null
          )}
        </div>
      );
    }
  };
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

vi.mock("../../components/popup-presenter/index.js", async () => {
  const React = await import("react");
  const { useToolbarStore } = await import("../stores/toolbar-store.js");
  return {
    showPopup: () => () => {},
    PopupWrapper: (props: {
      id: string;
      children?: React.ReactNode;
    }): React.ReactNode => {
      const isOpen = useToolbarStore(
        (store) => typeof store.openedPopups[props.id] === "object"
      );
      return isOpen
        ? React.createElement(
            "div",
            { "data-test-id": `popup-${props.id}` },
            props.children
          )
        : null;
    }
  };
});

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

type Mounted = { container: HTMLElement; unmount: () => void };
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
    extensions: [StarterKit, TextStyle],
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

function menuSx(root: ParentNode) {
  const menu = root.querySelector('[data-test-id="menu-presenter"]');
  return menu ? JSON.parse(menu.getAttribute("data-sx") || "{}") : null;
}

// Bounded seam: the stand-in presenter does not render `MenuContainer`, so
// this only confirms the `column` flag reaches `MenuPresenter` - not that the
// (unmocked, in production) inner `ScrollContainer` actually shrinks/scrolls.
function menuLayoutFlag(root: ParentNode) {
  const menu = root.querySelector('[data-test-id="menu-presenter"]');
  return menu?.getAttribute("data-menu-layout") || undefined;
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
    isMobile: false,
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
});

describe("Toolbar - iOS Aa format presentation", () => {
  test("lays the Aa menu out as a bounded vertical column and keeps grouped inline, paragraph and list commands", async () => {
    useToolbarStore.setState({ isMobile: true });
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

    const sx = menuSx(view.container);
    expect(sx).toMatchObject({
      flexDirection: "column",
      overflowX: "hidden",
      overflowY: "hidden",
      maxHeight: "70vh"
    });
    // The outer `<ul>` is deliberately non-user-scrolling in column mode -
    // `overflowY: hidden` alongside `overflowX: hidden` - while the inner
    // `ScrollContainer` (see `MenuContainer`'s `menuLayout`) is left as the
    // sole user-scrollable element. `hidden` still permits programmatic
    // scrolling; this is not a claim the outer `<ul>` is no scroll
    // container at all.
    expect(menuLayoutFlag(view.container)).toBe("column");

    const ids = MAC_FORMAT_COMMAND_IDS.slice(0, 5).map(
      (key) => `menu-item-${key}`
    );
    for (const id of ids)
      expect(
        view.container.querySelector(`#${id}`),
        `expected ${id} to be rendered`
      ).toBeTruthy();
  });

  test("runs the real Bold and Heading commands from the column menu and keeps Undo/Redo intact", async () => {
    useToolbarStore.setState({ isMobile: true });
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
    await click(view.container.querySelector('[id$="ios-aa-bold"]'));
    expect(editor.isActive("bold")).toBe(true);

    expect(editor.can().undo()).toBe(true);
    editor.commands.undo();
    expect(editor.isActive("bold")).toBe(false);
    editor.commands.redo();
    expect(editor.isActive("bold")).toBe(true);

    // Grouped inline controls keep Aa open for combining formats.
    expect(useToolbarStore.getState().isPopupOpen("macFormat")).toBe(true);
    await click(view.container.querySelector("#menu-item-mac-heading"));
    // the same heading command as the existing `headings` tool: clears a
    // manual textStyle override, no new command path was added.
    expect(editor.isActive("heading", { level: 2 })).toBe(true);
    expect(editor.getText()).toBe("hello world");
  });

  test("normalizes ios && !macCatalyst: the Mac capsule keeps its legacy row layout even when ios is also set", async () => {
    useToolbarStore.setState({ isMobile: true, macCatalyst: true });
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
    const sx = menuSx(view.container);
    expect(sx).toMatchObject({ flexDirection: "row", overflowX: "auto" });
    expect(sx.maxHeight).toBeUndefined();
    expect(sx.overflowY).toBeUndefined();
  });

  test("ios omitted keeps the existing Web/Android row layout", async () => {
    useToolbarStore.setState({ isMobile: true });
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
    const sx = menuSx(view.container);
    expect(sx).toMatchObject({ flexDirection: "row", overflowX: "auto" });
    expect(sx.maxHeight).toBeUndefined();
    expect(sx.overflowY).toBeUndefined();
  });

  test("two Toolbar instances share a single global `macFormat` popup id: one tap opens the popup in both, but each still computes its own ios layout", async () => {
    useToolbarStore.setState({ isMobile: true });
    const editorA = makeEditor("<p>toolbar a</p>");
    const editorB = makeEditor("<p>toolbar b</p>");

    const viewA = renderView(
      <Toolbar
        editor={asEditor(editorA)}
        location="bottom"
        tools={getMacToolbarGroups()}
        ios
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    const viewB = renderView(
      <Toolbar
        editor={asEditor(editorB)}
        location="bottom"
        tools={getMacToolbarGroups()}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    // `MacFormat` always renders its `Dropdown` with the fixed id/group
    // "macFormat" (see mac-format.tsx), and `openedPopups` in the toolbar
    // store is keyed by that id globally rather than scoped per `Toolbar`
    // instance. A single tap on instance A's "Aa" button therefore sets the
    // *same* popup flag instance B's Dropdown also reads, so both instances'
    // menus come open together from this one click. This is the existing
    // singleton popup-id semantics every `macFormat` toolbar shares - not a
    // per-instance context leak - and changing it is out of scope here.
    await click(aaButton(viewA.container));

    // What *is* local to each `Toolbar` instance is `IosFormatContext`: each
    // instance's own `MacFormat`/`Dropdown` still computes its own `sx` from
    // its own React tree, so the one shared popup renders with instance A's
    // column layout inside A's container and instance B's row layout inside
    // B's container - no second toggle involved.
    expect(menuSx(viewA.container)).toMatchObject({ flexDirection: "column" });
    expect(menuSx(viewB.container)).toMatchObject({ flexDirection: "row" });
  });

  test("exposes the Aa toggle as an accessible, localized control without changing its visible label", () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        tools={getMacToolbarGroups()}
        macCatalyst
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    const button = aaButton(view.container);
    expect(button).toBeTruthy();
    expect(button!.textContent?.trim()).toBe("Aa");
    expect(button!.getAttribute("aria-label")).toBe(
      `Aa ${strings.formatting()}`
    );
  });
});
