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
 * Runtime coverage for the iOS quiet-toolbar popup fix: a `Toolbar` whose
 * (still mounted) row is hidden in CSS must also hide any popup that was
 * already open before that happened, since the popup is rendered through its
 * own portal, outside the toolbar's own (hidden) DOM subtree.
 *
 * Real (not mocked): `Toolbar`, `MoreTools`, `Dropdown`/`MacFormat` ("Aa"),
 * the real `PopupWrapper` (`components/popup-presenter/index.tsx`, including
 * its new `ToolbarPopupVisibilityContext` consumption), the real toolbar
 * store (`toolbar-store.ts`) and a real `@tiptap/starter-kit` editor.
 *
 * Bounded seam: `@notesnook/ui`'s `PopupPresenter`/`MenuPresenter` are the
 * only things replaced, with thin leaf stand-ins that still forward the real
 * `isOpen` flag `PopupWrapper`/`Dropdown` compute (`data-open`, children only
 * rendered while open) - the genuine store -> context -> presenter wiring is
 * exercised end to end without needing `react-modal`'s portal (chrome, out of
 * scope) or a layout engine (happy-dom has none). `EditorFloatingMenus` is
 * replaced by a marker so its reachability outside the new gate is
 * observable. `@notesnook/intl` is a controlled, key-derived-label mock,
 * matching every other toolbar test in this directory.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor } from "@tiptap/core";
import { Toolbar } from "../toolbar.js";
import { MoreTools } from "../components/more-tools.js";
import {
  IosFormatContext,
  ToolbarPopupVisibilityContext,
  useToolbarStore
} from "../stores/toolbar-store.js";
import { getMacToolbarGroups } from "../tool-definitions.js";
import type { ToolbarDefinition } from "../types.js";
import type { ToolId } from "../tools/index.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../types.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    more: "More",
    formatting: "Formatting"
  };
  const strings = new Proxy(labels, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      return () => target[key] ?? `intl:${key}`;
    }
  });
  return { strings };
});

vi.mock("@notesnook/ui", async () => {
  const actual = await vi.importActual<typeof import("@notesnook/ui")>(
    "@notesnook/ui"
  );
  type Item = {
    type?: string;
    key: string;
    title?: string;
    onClick?: () => void;
  };
  return {
    ...actual,
    // Leaf seam: records the real `isOpen` `PopupWrapper` computes
    // (`isPopupOpen && popupsVisible`) and only renders children while open -
    // the same contract the real blocking presenter has - so the genuine
    // `PopupWrapper` -> store -> context wiring is exercised end to end.
    PopupPresenter: (props: {
      isOpen?: boolean;
      children?: React.ReactNode;
      scope?: string;
    }) => (
      <div
        data-test-id="popup-presenter"
        data-open={String(!!props.isOpen)}
        data-scope={props.scope ?? ""}
      >
        {props.isOpen ? props.children : null}
      </div>
    ),
    MenuPresenter: (props: {
      isOpen?: boolean;
      items?: Item[];
      onClose?: () => void;
    }) => {
      if (!props.isOpen) return null;
      return (
        <div data-test-id="menu-presenter">
          {(props.items ?? []).map((item) =>
            item.type === "button" ? (
              <button
                key={item.key}
                data-test-id={`menu-item-${item.key}`}
                onClick={() => {
                  item.onClick?.();
                  props.onClose?.();
                }}
              >
                {item.title}
              </button>
            ) : null
          )}
        </div>
      );
    }
  };
});

vi.mock("../floating-menus/index.js", async () => {
  const React = await import("react");
  return {
    EditorFloatingMenus: () =>
      React.createElement("div", { "data-test-id": "floating-menus" })
  };
});

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

const editorFixtures: { editor: TiptapEditor; element: HTMLElement }[] = [];

function makeEditor(content: string) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new TiptapEditor({
    element,
    extensions: [StarterKit],
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
  vi.restoreAllMocks();
});

/** A single top-level group that collapses into one "more" popup. */
const CUSTOM_TOOLS: ToolbarDefinition = [[["bold", "italic"]]];
const TOOLS_A = CUSTOM_TOOLS;
const TOOLS_B: ToolbarDefinition = [[["underline", "code"]]];

function renderToolbar(editor: TiptapEditor, popupsVisible?: boolean) {
  return renderView(
    <Toolbar
      editor={asEditor(editor)}
      location="top"
      tools={CUSTOM_TOOLS}
      defaultFontFamily="sans-serif"
      defaultFontSize={14}
      {...(popupsVisible === undefined ? {} : { popupsVisible })}
    />
  );
}

function Harness1(props: { editor: TiptapEditor; popupsVisible?: boolean }) {
  return (
    <Toolbar
      editor={asEditor(props.editor)}
      location="top"
      tools={CUSTOM_TOOLS}
      defaultFontFamily="sans-serif"
      defaultFontSize={14}
      {...(props.popupsVisible === undefined
        ? {}
        : { popupsVisible: props.popupsVisible })}
    />
  );
}

function NestedMoreHarness(props: {
  editor: TiptapEditor;
  popupsVisible: boolean;
  ios: boolean;
}) {
  return (
    <ToolbarPopupVisibilityContext.Provider value={props.popupsVisible}>
      <IosFormatContext.Provider value={props.ios}>
        <MoreTools
          editor={asEditor(props.editor)}
          popupId="more-nested"
          tools={["macFormat"] as ToolId[]}
          icon="more"
          title="More"
        />
      </IosFormatContext.Provider>
    </ToolbarPopupVisibilityContext.Provider>
  );
}

describe("Toolbar - quiet popupsVisible gates an already-open popup's presenter, never the store", () => {
  test("defaults to true: an open MoreTools popup renders through the real presenter with isOpen true", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderToolbar(editor);

    let popup = view.container.querySelector(
      '[data-test-id="popup-presenter"]'
    )!;
    expect(popup.getAttribute("data-open")).toBe("false");

    await click(view.container.querySelector('[id="tool-more"]'));
    expect(
      useToolbarStore.getState().openedPopups["more-bolditalic"]
    ).toBeTruthy();

    popup = view.container.querySelector('[data-test-id="popup-presenter"]')!;
    expect(popup.getAttribute("data-open")).toBe("true");
    expect(popup.querySelector('[id="tool-bold"]')).toBeTruthy();
  });

  test("toggling popupsVisible false/true hides and restores the SAME open popup without changing its store record", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(<Harness1 editor={editor} popupsVisible />);

    await click(view.container.querySelector('[id="tool-more"]'));
    expect(
      useToolbarStore.getState().openedPopups["more-bolditalic"]
    ).toBeTruthy();

    let popup = view.container.querySelector(
      '[data-test-id="popup-presenter"]'
    )!;
    expect(popup.getAttribute("data-open")).toBe("true");

    view.rerender(<Harness1 editor={editor} popupsVisible={false} />);
    popup = view.container.querySelector('[data-test-id="popup-presenter"]')!;
    expect(popup.getAttribute("data-open")).toBe("false");
    expect(popup.querySelector('[id="tool-bold"]')).toBeNull();
    // The store's open record is untouched by the quiet gate.
    expect(
      useToolbarStore.getState().openedPopups["more-bolditalic"]
    ).toBeTruthy();

    view.rerender(<Harness1 editor={editor} popupsVisible />);
    popup = view.container.querySelector('[data-test-id="popup-presenter"]')!;
    expect(popup.getAttribute("data-open")).toBe("true");
    expect(popup.querySelector('[id="tool-bold"]')).toBeTruthy();
    expect(
      useToolbarStore.getState().openedPopups["more-bolditalic"]
    ).toBeTruthy();
  });

  test("a pinned nested More->Aa popup keeps its open/pinned/parent records while hidden, restores unchanged, and never calls closeAllPopups", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <NestedMoreHarness editor={editor} popupsVisible ios />
    );

    await click(view.container.querySelector('[id="tool-more"]'));
    expect(useToolbarStore.getState().openedPopups["more-nested"]).toBeTruthy();

    let outerPopup = view.container.querySelector(
      '[data-test-id="popup-presenter"]'
    )!;
    expect(outerPopup.getAttribute("data-open")).toBe("true");

    await click(aaButton(outerPopup));
    expect(useToolbarStore.getState().openedPopups["macFormat"]).toMatchObject({
      parent: "more-nested"
    });

    await click(view.container.querySelector('[id="tool-more-nested-pin"]'));
    expect(
      useToolbarStore.getState().openedPopups["more-nested"]
    ).toMatchObject({ pinned: true });
    expect(useToolbarStore.getState().openedPopups["macFormat"]).toMatchObject({
      pinned: true
    });

    const closeAllPopupsSpy = vi.spyOn(
      useToolbarStore.getState(),
      "closeAllPopups"
    );

    view.rerender(
      <NestedMoreHarness editor={editor} popupsVisible={false} ios />
    );
    outerPopup = view.container.querySelector(
      '[data-test-id="popup-presenter"]'
    )!;
    expect(outerPopup.getAttribute("data-open")).toBe("false");
    expect(outerPopup.querySelector("button")).toBeNull();
    // Both presenters are gated: the outer `More` `PopupPresenter` and the
    // nested `Aa` `MenuPresenter` it would otherwise render inside it.
    expect(
      outerPopup.querySelector('[data-test-id="menu-presenter"]')
    ).toBeNull();
    expect(
      useToolbarStore.getState().openedPopups["more-nested"]
    ).toMatchObject({ pinned: true });
    expect(useToolbarStore.getState().openedPopups["macFormat"]).toMatchObject({
      pinned: true,
      parent: "more-nested"
    });
    expect(closeAllPopupsSpy).not.toHaveBeenCalled();

    view.rerender(<NestedMoreHarness editor={editor} popupsVisible ios />);
    outerPopup = view.container.querySelector(
      '[data-test-id="popup-presenter"]'
    )!;
    expect(outerPopup.getAttribute("data-open")).toBe("true");
    expect(aaButton(outerPopup)).toBeTruthy();
    expect(
      outerPopup.querySelector('[data-test-id="menu-presenter"]')
    ).toBeTruthy();
    expect(
      useToolbarStore.getState().openedPopups["more-nested"]
    ).toMatchObject({ pinned: true });
    expect(useToolbarStore.getState().openedPopups["macFormat"]).toMatchObject({
      pinned: true
    });
    expect(closeAllPopupsSpy).not.toHaveBeenCalled();
  });

  test("EditorFloatingMenus stays mounted and reachable outside the popupsVisible gate", () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderToolbar(editor, false);
    expect(
      view.container.querySelector('[data-test-id="floating-menus"]')
    ).toBeTruthy();
  });
});

describe("Toolbar - popupsVisible is scoped per Toolbar instance", () => {
  test("two Toolbar instances with distinct popup ids: hiding one instance's popups never hides the other instance's open popup", async () => {
    const editorA = makeEditor("<p>toolbar a</p>");
    const editorB = makeEditor("<p>toolbar b</p>");

    function Harness(props: { popupsVisibleA: boolean }) {
      return (
        <>
          <Toolbar
            editor={asEditor(editorA)}
            location="top"
            tools={TOOLS_A}
            defaultFontFamily="sans-serif"
            defaultFontSize={14}
            popupsVisible={props.popupsVisibleA}
          />
          <Toolbar
            editor={asEditor(editorB)}
            location="top"
            tools={TOOLS_B}
            defaultFontFamily="sans-serif"
            defaultFontSize={14}
          />
        </>
      );
    }

    const view = renderView(<Harness popupsVisibleA />);
    const moreButtons = view.container.querySelectorAll('[id="tool-more"]');
    expect(moreButtons).toHaveLength(2);

    // Pin A's popup through the real pin button *before* opening B: both
    // "more" popups share the toolbar's own top-level group
    // (`closePopupGroup`'s "toolbarGroup"), so without pinning, opening B's
    // popup would intentionally close A's unpinned one - the same same-group
    // semantics a single Toolbar's own "more" buttons already have, not a
    // cross-instance leak. Only A is open at this point, so its pin button
    // (the trailing `tool-pin` `ToolButton` `MoreTools` renders inside the
    // open popup) is unambiguous.
    await click(moreButtons[0]);
    expect(
      useToolbarStore.getState().openedPopups["more-bolditalic"]
    ).toBeTruthy();
    await click(view.container.querySelector('[id="tool-pin"]'));
    expect(
      useToolbarStore.getState().openedPopups["more-bolditalic"]
    ).toMatchObject({ pinned: true });

    await click(moreButtons[1]);

    expect(
      useToolbarStore.getState().openedPopups["more-bolditalic"]
    ).toMatchObject({ pinned: true });
    expect(
      useToolbarStore.getState().openedPopups["more-underlinecode"]
    ).toBeTruthy();

    let popups = Array.from(
      view.container.querySelectorAll('[data-test-id="popup-presenter"]')
    );
    expect(popups).toHaveLength(2);
    expect(popups[0].getAttribute("data-open")).toBe("true");
    expect(popups[1].getAttribute("data-open")).toBe("true");

    // document order matches render order: instance A's popup is the first
    // match, instance B's the second.
    view.rerender(<Harness popupsVisibleA={false} />);

    popups = Array.from(
      view.container.querySelectorAll('[data-test-id="popup-presenter"]')
    );
    expect(popups).toHaveLength(2);
    expect(popups[0].getAttribute("data-open")).toBe("false");
    expect(popups[1].getAttribute("data-open")).toBe("true");

    expect(
      useToolbarStore.getState().openedPopups["more-bolditalic"]
    ).toBeTruthy();
    expect(
      useToolbarStore.getState().openedPopups["more-underlinecode"]
    ).toBeTruthy();
  });

  test("the real Dropdown/MenuPresenter seam (Aa) honours popupsVisible: open by default, hidden on false, restored on true, without touching its store record", async () => {
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor("<p>toolbar a</p>");

    function Harness(props: { popupsVisible?: boolean }) {
      return (
        <Toolbar
          editor={asEditor(editor)}
          location="bottom"
          tools={getMacToolbarGroups()}
          macCatalyst
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
          {...(props.popupsVisible === undefined
            ? {}
            : { popupsVisible: props.popupsVisible })}
        />
      );
    }

    // Default (no `popupsVisible` prop): the same `true` the toolbar has
    // always had.
    const view = renderView(<Harness />);
    await click(aaButton(view.container));
    expect(useToolbarStore.getState().openedPopups["macFormat"]).toBeTruthy();
    expect(
      view.container.querySelector('[data-test-id="menu-presenter"]')
    ).toBeTruthy();

    // `Dropdown` now reads `ToolbarPopupVisibilityContext` unconditionally,
    // same as `PopupWrapper`: the rendered `MenuPresenter` is gated, but the
    // store's open record is left completely alone.
    view.rerender(<Harness popupsVisible={false} />);
    expect(
      view.container.querySelector('[data-test-id="menu-presenter"]')
    ).toBeNull();
    expect(useToolbarStore.getState().openedPopups["macFormat"]).toBeTruthy();

    view.rerender(<Harness popupsVisible />);
    expect(
      view.container.querySelector('[data-test-id="menu-presenter"]')
    ).toBeTruthy();
    expect(useToolbarStore.getState().openedPopups["macFormat"]).toBeTruthy();
  });
});
