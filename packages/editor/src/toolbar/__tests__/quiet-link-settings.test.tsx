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
 * Real-DOM (ReactDOM + happy-dom) coverage for the `linkSettingsAutoOpen` gate
 * on the *rendered* toolbar, i.e. the iOS quiet reading presentation's fix.
 *
 * What is actually exercised here:
 * - the real `Toolbar`, the real `LinkSettings` and the real popup store,
 *   against a real `@tiptap/starter-kit` + production `Link` editor with a real
 *   link selection and `location="bottom"`;
 * - `linkSettingsAutoOpen={false}`: the automatic `linkSettings` popup stays
 *   closed after `act` (store record undefined and no portal in the DOM);
 * - the default (prop omitted) and `true`: the popup opens with the existing
 *   Open/Edit/Unlink/Copy commands - the exact same tool ids as before, none
 *   added;
 * - a live `true -> false` flip closes the popup again (through the existing
 *   `autoCloseOnUnmount` cleanup), and a `false -> true` flip re-opens it;
 * - the document, its HTML, the selection and the history availability never
 *   change across the flips, and `EditorFloatingMenus` (Search) stays mounted;
 * - the readonly mobile pathway keeps working, gated and defaulted.
 *
 * Bounded seams are identical to `toolbar-render.test.tsx` (see its header for
 * the full rationale): the production menu/sheet presenters, `PopupWrapper`
 * (honours the real toolbar-store popup state), the `Popup` label chrome, the
 * floating menus (here a marker, so their reachability is observable) and the
 * compile-time lingui catalog are replaced. Geometry is not claimed: happy-dom
 * has no layout.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor } from "@tiptap/core";
import { Toolbar } from "../toolbar.js";
import { useToolbarStore } from "../stores/toolbar-store.js";
import { getDefaultPresets } from "../tool-definitions.js";
import { Link } from "../../extensions/link/index.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** A stable, distinct label per key (documented fixture seam). */
vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    insert: "Insert",
    bold: "Bold",
    italic: "Italic",
    underline: "Underline",
    strikethrough: "Strikethrough",
    code: "Code",
    formatClear: "Clear formatting",
    paragraph: "Paragraph",
    headings: "Headings",
    link: "Link",
    noteLink: "Link to note",
    linkSettings: "Link settings",
    linkEdit: "Edit link",
    linkRemove: "Remove link",
    openLink: "Open link",
    copyLink: "Copy link",
    checklist: "Checklist",
    bulletList: "Bullet list",
    numberedList: "Numbered list",
    more: "More",
    loading: "Loading"
  };
  const strings = new Proxy(labels, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      return () => target[key] ?? `intl:${key}`;
    }
  });
  return { strings };
});

/** Real item/child passthrough for the production menu/sheet presenters. */
vi.mock("../../components/responsive/index.js", () => ({
  ResponsivePresenter: (props: {
    isOpen?: boolean;
    children?: React.ReactNode;
  }) => (props.isOpen ? props.children ?? null : null),
  ResponsiveContainer: (props: { desktop?: React.ReactNode }) =>
    props.desktop ?? null,
  DesktopOnly: (props: { children?: React.ReactNode }) => props.children ?? null,
  MobileOnly: () => null
}));

/**
 * Popup seam that honours the *real* toolbar-store popup state, so the
 * `linkSettings` popup only renders once the real popup manager opened it (the
 * automatic `autoOpen` effect), and the real `autoCloseOnUnmount` cleanup
 * (`closePopup(id)` on unmount) - the same rules as the production
 * `PopupWrapper`. The store instance is shared with production.
 */
vi.mock("../../components/popup-presenter/index.js", async () => {
  const React = await import("react");
  const { useToolbarStore } = await import("../stores/toolbar-store.js");
  return {
    showPopup: () => () => {},
    PopupWrapper: (props: {
      id: string;
      autoCloseOnUnmount?: boolean;
      children?: React.ReactNode;
    }): React.ReactNode => {
      const isOpen = useToolbarStore(
        (store) => typeof store.openedPopups[props.id] === "object"
      );
      React.useEffect(() => {
        if (!props.autoCloseOnUnmount) return;
        return () => {
          useToolbarStore.getState().closePopup(props.id);
        };
      }, [props.autoCloseOnUnmount, props.id]);
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

/** Leaf seam of `LinkPopup` only; its children still render. */
vi.mock("../components/popup.js", () => ({
  Popup: (props: { children?: React.ReactNode }) => props.children ?? null
}));

/**
 * Floating-menu seam: a marker instead of `null`, so the tests can prove the
 * fix touches only the LinkSettings popup and leaves Search reachable.
 */
vi.mock("../floating-menus/index.js", async () => {
  const React = await import("react");
  return {
    EditorFloatingMenus: () =>
      React.createElement("div", { "data-test-id": "floating-menus" })
  };
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

/** The production link extension the shipping editor builds (`index.ts`). */
const productionLink = () =>
  Link.extend({ inclusive: true }).configure({
    autolink: false,
    openOnClick: false,
    linkOnPaste: true,
    protocols: [{ scheme: "nn" }]
  });

const editorFixtures: { editor: TiptapEditor; element: HTMLElement }[] = [];

function makeEditor(content: string, editable = true) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new TiptapEditor({
    element,
    extensions: [StarterKit, productionLink()],
    content,
    editable
  });
  editorFixtures.push({ editor, element });
  return editor;
}

afterEach(() => {
  for (const view of mounted) view.unmount();
  mounted = [];
  for (const { editor, element } of editorFixtures)
    if (!editor.isDestroyed) editor.destroy();
  for (const { element } of editorFixtures) element.remove();
  editorFixtures.length = 0;
});

/** happy-dom has no layout engine: the overflow measurement is an explicit seam. */
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
  useToolbarStore.setState({
    isMobile: false,
    macCatalyst: false,
    toolbarLocation: "top",
    openedPopups: {},
    fontFamily: "sans-serif",
    fontSize: 14
  });
});

const asEditor = (editor: TiptapEditor) => editor as unknown as Editor;

/** The `tool-<icon>` id a `ToolButton` assigns. */
function toolIds(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button[id]"))
    .map((button) => button.id)
    .filter((id) => id.startsWith("tool-"));
}

function popup(view: Mounted) {
  return view.container.querySelector('[data-test-id="popup-linkSettings"]');
}

function floatingMenus(view: Mounted) {
  return view.container.querySelector('[data-test-id="floating-menus"]');
}

/**
 * A real editor with a link, its text selected (so `isActive("link")` is true
 * and the popup's Open/Copy commands resolve the mark through the real
 * selection -> node path).
 */
function linkEditor(editable = true) {
  const editor = makeEditor(
    '<p><a href="https://example.com">example</a></p>',
    editable
  );
  editor.commands.setTextSelection({ from: 1, to: 4 });
  return editor;
}

function renderToolbar(editor: TiptapEditor, autoOpen?: boolean) {
  return renderView(
    <Toolbar
      editor={asEditor(editor)}
      location="bottom"
      tools={getDefaultPresets().default}
      defaultFontFamily="sans-serif"
      defaultFontSize={14}
      {...(autoOpen === undefined ? {} : { linkSettingsAutoOpen: autoOpen })}
    />
  );
}

describe("Toolbar - quiet reading suppresses the automatic LinkSettings popup", () => {
  test("linkSettingsAutoOpen={false} opens no popup; the default opens the existing commands", async () => {
    const quiet = linkEditor();
    const quietView = renderToolbar(quiet, false);
    await act(async () => {});

    expect(
      useToolbarStore.getState().openedPopups["linkSettings"]
    ).toBeUndefined();
    expect(popup(quietView)).toBeNull();

    const normal = linkEditor();
    const normalView = renderToolbar(normal);
    await act(async () => {});

    const opened = popup(normalView);
    expect(opened).toBeTruthy();
    // The exact, pre-existing command ids - none added.
    expect(toolIds(opened!)).toEqual([
      "tool-openLink",
      "tool-linkEdit",
      "tool-linkRemove",
      "tool-copyLink"
    ]);
  });

  test("a live true -> false flip closes the popup again, false -> true re-opens it", async () => {
    const editor = linkEditor();
    const mountedView = renderToolbar(editor, true);
    await act(async () => {});
    expect(popup(mountedView)).toBeTruthy();

    mountedView.rerender(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getDefaultPresets().default}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
        linkSettingsAutoOpen={false}
      />
    );
    await act(async () => {});
    expect(popup(mountedView)).toBeNull();
    // The existing `autoCloseOnUnmount` cleanup closed the popup in the store.
    expect(
      useToolbarStore.getState().openedPopups["linkSettings"]
    ).toBeUndefined();

    mountedView.rerender(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getDefaultPresets().default}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
        linkSettingsAutoOpen
      />
    );
    await act(async () => {});
    expect(popup(mountedView)).toBeTruthy();
  });

  test("the flag never touches the document, the selection, the history or the floating menus", async () => {
    const editor = linkEditor();
    const jsonBefore = JSON.stringify(editor.getJSON());
    const htmlBefore = editor.getHTML();
    const textBefore = editor.getText();
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };
    const canUndoBefore = editor.can().undo();

    const mountedView = renderToolbar(editor, false);
    await act(async () => {});
    // Search stays reachable regardless of the flag.
    expect(floatingMenus(mountedView)).toBeTruthy();

    mountedView.rerender(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getDefaultPresets().default}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
        linkSettingsAutoOpen
      />
    );
    await act(async () => {});
    expect(floatingMenus(mountedView)).toBeTruthy();

    expect(JSON.stringify(editor.getJSON())).toBe(jsonBefore);
    expect(editor.getHTML()).toBe(htmlBefore);
    expect(editor.getText()).toBe(textBefore);
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);
    expect(editor.can().undo()).toBe(canUndoBefore);
  });
});

describe("Toolbar - quiet reading keeps the readonly pathway intact", () => {
  test("readonly mobile honours the flag and the default alike", async () => {
    useToolbarStore.setState({ isMobile: true });

    const quietEditor = linkEditor(false);
    const quietView = renderToolbar(quietEditor, false);
    await act(async () => {});
    expect(popup(quietView)).toBeNull();

    const normalEditor = linkEditor(false);
    const normalView = renderToolbar(normalEditor);
    await act(async () => {});

    const opened = popup(normalView);
    expect(opened).toBeTruthy();
    expect(toolIds(opened!)).toEqual(["tool-openLink", "tool-copyLink"]);
  });
});
