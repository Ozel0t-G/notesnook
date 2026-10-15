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
 * Real-DOM (ReactDOM + happy-dom) coverage for the *rendered* toolbar.
 *
 * What is actually exercised here:
 * - the real `Toolbar`, `ToolbarGroup`, `ToolButton` and the real tool leaves
 *   (`Bold`, `Strikethrough`, `CheckList`, `MacFormat`'s `Dropdown`, ...), each
 *   against a real `@tiptap/starter-kit` + `Link` editor;
 * - the real `resolveToolbarGroups` contract as it reaches the DOM: Mac
 *   `default` is the "Aa" + lists bar, `minimal` never renders "Aa", a custom
 *   list keeps its exact group/subgroup order, a legacy payload is honoured
 *   verbatim (even when byte-identical to a built-in), an empty custom shows
 *   only the fixed insert group, and a live `tools` change swaps the rendered
 *   buttons without touching the document or the selection.
 * - a real Bold/Strikethrough document command driven from a rendered button.
 * - the readonly mobile toolbar: hidden with no active node, the fixed readonly
 *   context group when a link is selected.
 * - the non-Mac mobile row's measured overflow (explicit geometry seam): the
 *   groups that do not fit the real pane collapse into the *existing* localized
 *   "more" popup, flattened in static -> custom -> nested order; a real command
 *   still runs from that popup with the selection kept, a pane resize
 *   re-measures live (grow and shrink), the desktop web row is never collapsed,
 *   and the Mac capsule still reserves its More button exactly once.
 *
 * Bounded seams (deliberately mocked, and NOT claimed to be the full runtime):
 * - `ResponsivePresenter`/`ResponsiveContainer` (the production menu/sheet
 *   presenters use ReactModal portals) are replaced by small presenters that
 *   render the real received items/children. The item lists, keys, titles and
 *   callbacks are the real ones; the portal *chrome* is out of scope.
 * - `PopupWrapper` honours the real toolbar-store popup state so "more" and
 *   split-button popups open exactly when the real popup manager says so; the
 *   themed portal surface itself is not rendered.
 * - `Popup` (the `LinkPopup` chrome) is a passthrough.
 * - `EditorFloatingMenus` (the hover popup + search/replace menus) renders
 *   nothing: none of the assertions below involve them.
 * - Geometry: happy-dom has no layout, so `offsetWidth`/`clientWidth` and
 *   `ResizeObserver` are faked as an explicit seam (a pane width plus a natural
 *   width per top-level group) for the overflow assertions. The tests assert
 *   the real measurement/flattening/`MoreTools` item order and the real command
 *   routes; they never claim a real Mac/iPad/phone pixel width.
 *
 * Theme seam (not a shipping theme object): the real leaves read `useTheme()`,
 * so the view renders inside a real `ThemeProvider` (`@theme-ui/core`) carrying
 * a minimal `iconSizes` map typed against the existing `Theme`.
 *
 * Localization seam (deliberately mocked, NOT the shipping catalog): the real
 * `@notesnook/intl` catalog is produced by lingui compile-time macros this
 * setup does not run, so it is replaced by a controlled mock exposing one
 * stable, key-derived label per key.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor } from "@tiptap/core";
import { strings } from "@notesnook/intl";
import { Toolbar } from "../toolbar.js";
import { useToolbarStore } from "../stores/toolbar-store.js";
import {
  getDefaultPresets,
  getMacToolbarGroups,
  resolveToolbarGroups
} from "../tool-definitions.js";
import { Link } from "../../extensions/link/index.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../types.js";
import type { ToolbarDefinition } from "../types.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A stable, distinct label per key (see the header: a documented fixture seam). */
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
    checklist: "Checklist",
    bulletList: "Bullet list",
    numberedList: "Numbered list",
    more: "More",
    fontFamily: "Font family",
    fontSize: "Font size",
    alignment: "Alignment",
    ltr: "Text direction",
    highlight: "Highlight",
    textColor: "Text color",
    mathInline: "Math",
    subscript: "Subscript",
    superscript: "Superscript",
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

/** Real item/child passthrough for the production menu/sheet presenters. */
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

/**
 * Popup seam that honours the *real* toolbar-store popup state, so a "more" or
 * split-button popup only renders its children once the real popup manager
 * opened it (clicking the trigger button). The store instance is shared with
 * production code.
 */
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

/** Leaf seam of `LinkPopup` only; its children still render. */
vi.mock("../components/popup.js", () => ({
  Popup: (props: { children?: React.ReactNode }) => props.children ?? null
}));

/** Bounded seam: the floating hover/search menus are irrelevant to this suite. */
vi.mock("../floating-menus/index.js", () => ({
  EditorFloatingMenus: () => null
}));

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

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * The exact link extension the shipping editor builds (`index.ts`): the base
 * extension's `inclusive()` follows `autolink` (disabled in production), so the
 * mark is forced inclusive, matching the command tests.
 */
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

/**
 * happy-dom never fires a real `ResizeObserver`, so this seam records the
 * measure callback the toolbar registers and lets a test drive a pane resize
 * explicitly. Only the *real* callback is used; nothing here asserts layout.
 */
class TriggerableResizeObserver {
  static active: TriggerableResizeObserver[] = [];
  readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    TriggerableResizeObserver.active.push(this);
  }
  observe() {
    /* the explicit seam decides when to fire */
  }
  unobserve() {
    /* no-op */
  }
  disconnect() {
    TriggerableResizeObserver.active = TriggerableResizeObserver.active.filter(
      (observer) => observer !== this
    );
  }
  /** Re-run the latest registered measure, as a pane resize would. */
  static fire() {
    const observer =
      TriggerableResizeObserver.active[
        TriggerableResizeObserver.active.length - 1
      ];
    if (!observer) throw new Error("expected the toolbar to observe a resize");
    act(() => {
      observer.callback();
    });
  }
}

/**
 * Explicit geometry seam for the measured toolbar row: the pane width and the
 * natural width of each top-level group. The trailing "more" group reports its
 * own width so the reservation settles the way it does in the real DOM. Both
 * descriptors are always restored, and no real pixel width is claimed.
 */
type MeasuredLayout = {
  /** `clientWidth` reported for every element (the pane the row fits into). */
  paneWidth: number;
  /** Natural width of the top-level group at each render position. */
  groupWidths: number[];
  /** Width of the trailing "more" group once it is rendered. */
  moreWidth?: number;
};

async function withMeasuredLayout<T>(
  layout: MeasuredLayout,
  run: () => Promise<T>
): Promise<T> {
  const originalOffset = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth"
  );
  const originalClient = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  );

  const isTopLevelGroup = (el: HTMLElement) =>
    el.classList?.contains("toolbar-group") &&
    !!el.parentElement?.classList?.contains("editor-toolbar");

  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      const el = this as HTMLElement;
      if (!isTopLevelGroup(el)) return 0;
      const buttons = Array.from(el.children).filter(
        (child) => (child as HTMLElement).tagName === "BUTTON"
      ) as HTMLElement[];
      // Everything that does not fit is merged into one trailing "more" group;
      // it is that real button which decides the reservation.
      if (buttons.length === 1 && buttons[0].id === "tool-more")
        return layout.moreWidth ?? 40;
      const siblings = Array.from(el.parentElement!.children).filter((child) =>
        child.classList.contains("toolbar-group")
      );
      return layout.groupWidths[siblings.indexOf(el)] ?? 0;
    }
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return layout.paneWidth;
    }
  });

  try {
    return await run();
  } finally {
    if (originalOffset)
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetWidth",
        originalOffset
      );
    else
      delete (HTMLElement.prototype as { offsetWidth?: unknown }).offsetWidth;
    if (originalClient)
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClient
      );
    else
      delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
  }
}

beforeEach(() => {
  TriggerableResizeObserver.active = [];
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

/** The `tool-<icon>` id a `ToolButton` assigns, or its aria-label/title. */
function buttonKey(button: Element) {
  return (
    button.id ||
    button.getAttribute("aria-label") ||
    button.getAttribute("title") ||
    ""
  );
}

function toolIds(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button[id]"))
    .map((button) => button.id)
    .filter((id) => id.startsWith("tool-"));
}

function aaButton(root: ParentNode) {
  return (
    Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Aa"
    ) ?? null
  );
}

/** Marks present on any text node of the serialized document. */
function docMarkTypes(editor: TiptapEditor): string[] {
  type JsonNode = { marks?: { type?: string }[]; content?: JsonNode[] };
  const marks = new Set<string>();
  const walk = (node: JsonNode) => {
    for (const mark of node.marks ?? []) if (mark.type) marks.add(mark.type);
    for (const child of node.content ?? []) walk(child);
  };
  walk(editor.getJSON() as JsonNode);
  return Array.from(marks);
}

const MAC_CUSTOM: ToolbarDefinition = [
  ["clearformatting"],
  ["headings", ["strikethrough", "bold"]],
  ["addLink", "addInternalLink"]
];

const BOLD_ONLY: ToolbarDefinition = [["bold"]];
const ITALIC_ONLY: ToolbarDefinition = [["italic"]];
const LEGACY_WITH_LISTS: ToolbarDefinition = [["bold"], ["checkList"]];
const LEGACY_OVERFLOW: ToolbarDefinition = [["bold", "italic"], ["checkList"]];
/** Two flat custom groups: static insert + bold/italic + checklist. */
const MOBILE_FLAT: ToolbarDefinition = [["bold", "italic"], ["checkList"]];
/** Flat groups plus a nested subgroup that must flatten into the More popup. */
const MOBILE_NESTED: ToolbarDefinition = [
  ["bold"],
  ["italic"],
  ["underline", ["code", "strikethrough"]]
];

describe("Toolbar - default preset rendering", () => {
  test("renders the Mac Catalyst Aa format menu plus the list buttons", () => {
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

    expect(view.container.querySelector(".editor-toolbar")).toBeTruthy();
    expect(aaButton(view.container)).toBeTruthy();
    const ids = toolIds(view.container);
    expect(ids).toContain("tool-checklist");
    expect(ids).toContain("tool-bulletList");
    expect(ids).toContain("tool-numberedList");
    // The Mac bar keeps the inline formats inside the Aa popover.
    expect(ids).not.toContain("tool-bold");
  });

  test("renders the minimal preset without the Aa format menu", () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        tools={getDefaultPresets().minimal}
        macCatalyst
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    const ids = toolIds(view.container);
    expect(ids).toContain("tool-bold");
    expect(ids).toContain("tool-italic");
    expect(ids).toContain("tool-underline");
    expect(ids).toContain("tool-strikethrough");
    expect(ids).toContain("tool-code");
    expect(ids).toContain("tool-link");
    expect(ids).toContain("tool-formatClear");
    // No Aa even on Mac: minimal is the built-in minimal preset everywhere.
    expect(aaButton(view.container)).toBeNull();
  });
});

describe("Toolbar - custom preset rendering", () => {
  test("keeps the exact group order and reaches nested tools through the more button", async () => {
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        tools={clone(MAC_CUSTOM)}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    // Outer tool buttons, in order: the custom flat tools and the nested "more"
    // group that ask for the "strikethrough"/"bold" subgroup. A `ToolButton` is
    // identified by its *icon* (`tool-${id || icon}`), so the `clearformatting`
    // definition (icon `formatClear`) renders as `tool-formatClear` - the tool
    // id the preset names is not the leaf's DOM id.
    expect(toolIds(view.container)).toEqual([
      "tool-formatClear",
      "tool-more",
      "tool-link",
      "tool-noteLink"
    ]);

    // The nested subgroup is not in the DOM until the more button is clicked.
    expect(view.container.querySelector('[data-test-id^="popup-"]')).toBeNull();
    await click(view.container.querySelector("#tool-more"));

    const popup = view.container.querySelector('[data-test-id^="popup-"]');
    expect(popup).toBeTruthy();
    const nestedKeys = Array.from(
      popup!.querySelectorAll(".toolbar-group button")
    ).map(buttonKey);
    expect(nestedKeys).toEqual(["tool-strikethrough", "tool-bold"]);

    // A real document command through the rendered button.
    editor.commands.selectAll();
    await click(popup!.querySelector("#tool-bold"));
    expect(docMarkTypes(editor)).toContain("bold");
  });
});

describe("Toolbar - legacy payloads", () => {
  test("honours stored groups without a preset verbatim", () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        tools={resolveToolbarGroups({
          tools: clone(LEGACY_WITH_LISTS),
          macCatalyst: true
        })}
        macCatalyst
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    const ids = toolIds(view.container);
    expect(ids).toContain("tool-bold");
    expect(ids).toContain("tool-checklist");
    expect(aaButton(view.container)).toBeNull();
  });

  test("does not swap a custom payload that equals the web default for the Mac bar", () => {
    // No preset + tools identical to the built-in web default: it must render
    // as stored (bold, font size, headings...), never rewritten to Mac's "Aa".
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        tools={resolveToolbarGroups({
          tools: clone(getDefaultPresets().default),
          macCatalyst: true
        })}
        macCatalyst
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    const ids = toolIds(view.container);
    expect(ids).toContain("tool-bold");
    expect(ids).toContain("tool-link");
    expect(aaButton(view.container)).toBeNull();
  });
});

describe("Toolbar - empty custom preset", () => {
  test("shows only the fixed insert group", () => {
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        tools={resolveToolbarGroups({ toolbarPreset: "custom", tools: [] })}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    const ids = toolIds(view.container);
    expect(ids).not.toContain("tool-bold");
    expect(ids).not.toContain("tool-more");
    // The static mobile insert group is the only thing left; its button has no
    // `tool-` id, it carries the localized label.
    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe(strings.insert());
  });
});

describe("Toolbar - live tools changes", () => {
  test("swaps the rendered buttons without touching the document or selection", () => {
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        tools={BOLD_ONLY}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    expect(toolIds(view.container)).toContain("tool-bold");

    const docBefore = JSON.stringify(editor.getJSON());
    const textBefore = editor.getText();
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };

    view.rerender(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        tools={ITALIC_ONLY}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    expect(toolIds(view.container)).not.toContain("tool-bold");
    expect(toolIds(view.container)).toContain("tool-italic");
    expect(JSON.stringify(editor.getJSON())).toBe(docBefore);
    expect(editor.getText()).toBe(textBefore);
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);
  });
});

describe("Toolbar - readonly mobile context", () => {
  test("renders nothing when no readonly node is active", () => {
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor("<p>hello world</p>", false);
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getDefaultPresets().default}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    expect(editor.isEditable).toBe(false);
    expect(view.container.querySelector(".editor-toolbar")).toBeNull();
  });

  test("renders only the fixed readonly context group when a link is selected", () => {
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor(
      '<p><a href="https://example.com">hi</a></p>',
      false
    );
    editor.commands.selectAll();
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        tools={getDefaultPresets().default}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );

    expect(view.container.querySelector(".editor-toolbar")).toBeTruthy();
    expect(toolIds(view.container)).toContain("tool-linkSettings");
    expect(toolIds(view.container)).not.toContain("tool-bold");
  });
});

describe("Toolbar - Mac overflow geometry (explicit seam)", () => {
  test("collapses every group into the more popup, in flattened order", async () => {
    useToolbarStore.setState({ isMobile: true });

    const originalOffset = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth"
    );
    const originalClient = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth"
    );
    // Fake layout: the pane is far narrower than any group, so nothing fits.
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return this.classList?.contains("toolbar-group") ? 10000 : 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 300;
      }
    });

    try {
      const editor = makeEditor("<p>hello world</p>");
      const view = renderView(
        <Toolbar
          editor={asEditor(editor)}
          location="bottom"
          tools={clone(LEGACY_OVERFLOW)}
          macCatalyst
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
        />
      );

      // Everything overflowed into a single real "more" group.
      expect(view.container.querySelector("#tool-more")).toBeTruthy();
      expect(toolIds(view.container)).toEqual(["tool-more"]);

      await click(view.container.querySelector("#tool-more"));
      const popup = view.container.querySelector('[data-test-id^="popup-"]');
      expect(popup).toBeTruthy();
      const keys = Array.from(
        popup!.querySelectorAll(".toolbar-group button")
      ).map(buttonKey);
      // Static insert first, then the legacy groups flattened in order. The
      // conditional static tools render nothing, and this is a mocked layout:
      // no real Mac/iPad width is being claimed.
      expect(keys).toEqual([
        strings.insert(),
        "tool-bold",
        "tool-italic",
        "tool-checklist"
      ]);
    } finally {
      if (originalOffset)
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetWidth",
          originalOffset
        );
      else
        delete (HTMLElement.prototype as { offsetWidth?: unknown }).offsetWidth;
      if (originalClient)
        Object.defineProperty(
          HTMLElement.prototype,
          "clientWidth",
          originalClient
        );
      else
        delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
    }
  });
});

describe("Toolbar - mobile measured overflow (explicit seam)", () => {
  test("collapses the groups that do not fit into the existing localized More", async () => {
    useToolbarStore.setState({ isMobile: true });
    const layout: MeasuredLayout = {
      paneWidth: 250,
      groupWidths: [60, 120, 120],
      moreWidth: 40
    };

    await withMeasuredLayout(layout, async () => {
      const editor = makeEditor("<p>hello world</p>");
      const view = renderView(
        <Toolbar
          editor={asEditor(editor)}
          location="bottom"
          tools={clone(MOBILE_FLAT)}
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
        />
      );

      // The static insert group and bold/italic fit next to the More button;
      // the checklist group does not. A `ToolButton` is identified by its icon
      // (`tool-${id || icon}`); the static insert button has no `tool-` id.
      expect(toolIds(view.container)).toEqual([
        "tool-bold",
        "tool-italic",
        "tool-more"
      ]);

      // Exactly one More trigger, and it is the localized one
      // (`ToolbarGroup` passes `strings.more()` as its title/accessible name).
      const moreButtons = view.container.querySelectorAll("#tool-more");
      expect(moreButtons).toHaveLength(1);
      expect(moreButtons[0].getAttribute("title")).toBe(strings.more());

      await click(moreButtons[0]);
      const popup = view.container.querySelector('[data-test-id^="popup-"]');
      expect(popup).toBeTruthy();
      expect(
        Array.from(popup!.querySelectorAll(".toolbar-group button")).map(
          buttonKey
        )
      ).toEqual(["tool-checklist"]);
    });
  });

  test("flattens static, custom and nested groups into the More popup in order", async () => {
    useToolbarStore.setState({ isMobile: true });
    const layout: MeasuredLayout = {
      paneWidth: 150,
      groupWidths: [60, 100, 100, 200],
      moreWidth: 40
    };

    await withMeasuredLayout(layout, async () => {
      const editor = makeEditor("<p>hello world</p>");
      const view = renderView(
        <Toolbar
          editor={asEditor(editor)}
          location="bottom"
          tools={clone(MOBILE_NESTED)}
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
        />
      );

      // Only the static insert group fits next to More; every custom group -
      // the nested subgroup flattened, in order - is inside the popup.
      expect(toolIds(view.container)).toEqual(["tool-more"]);
      await click(view.container.querySelector("#tool-more"));
      const popup = view.container.querySelector('[data-test-id^="popup-"]');
      expect(popup).toBeTruthy();
      expect(
        Array.from(popup!.querySelectorAll(".toolbar-group button")).map(
          buttonKey
        )
      ).toEqual([
        "tool-bold",
        "tool-italic",
        "tool-underline",
        "tool-code",
        "tool-strikethrough"
      ]);
    });
  });

  test("runs a real rendered command from the More popup and keeps the selection", async () => {
    useToolbarStore.setState({ isMobile: true });
    const layout: MeasuredLayout = {
      paneWidth: 150,
      groupWidths: [60, 100, 100],
      moreWidth: 40
    };

    await withMeasuredLayout(layout, async () => {
      const editor = makeEditor("<p>hello world</p>");
      editor.commands.setTextSelection({ from: 1, to: 6 });
      const view = renderView(
        <Toolbar
          editor={asEditor(editor)}
          location="bottom"
          tools={clone(MOBILE_FLAT)}
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
        />
      );

      // Only the static insert group fits, so Bold lives inside More.
      expect(toolIds(view.container)).toEqual(["tool-more"]);
      const selectionBefore = {
        from: editor.state.selection.from,
        to: editor.state.selection.to
      };
      const docBefore = JSON.stringify(editor.getJSON());
      expect(selectionBefore).toEqual({ from: 1, to: 6 });

      await click(view.container.querySelector("#tool-more"));
      // Opening the collapsed popup must not touch the document or selection.
      expect(JSON.stringify(editor.getJSON())).toBe(docBefore);
      expect(editor.state.selection.from).toBe(selectionBefore.from);
      expect(editor.state.selection.to).toBe(selectionBefore.to);

      const popup = view.container.querySelector('[data-test-id^="popup-"]');
      await click(popup!.querySelector("#tool-bold"));
      // The command ran through the real rendered button; the range stayed.
      expect(docMarkTypes(editor)).toContain("bold");
      expect(editor.state.selection.from).toBe(selectionBefore.from);
      expect(editor.state.selection.to).toBe(selectionBefore.to);
    });
  });

  test("re-measures live when the pane grows and shrinks", async () => {
    useToolbarStore.setState({ isMobile: true });
    const originalObserver = (globalThis as { ResizeObserver?: unknown })
      .ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      TriggerableResizeObserver;
    const layout: MeasuredLayout = {
      paneWidth: 600,
      groupWidths: [60, 120, 120],
      moreWidth: 40
    };

    try {
      await withMeasuredLayout(layout, async () => {
        const editor = makeEditor("<p>hello world</p>");
        const view = renderView(
          <Toolbar
            editor={asEditor(editor)}
            location="bottom"
            tools={clone(MOBILE_FLAT)}
            defaultFontFamily="sans-serif"
            defaultFontSize={14}
          />
        );

        // Wide pane: every group fits and nothing is collapsed.
        expect(toolIds(view.container)).toEqual([
          "tool-bold",
          "tool-italic",
          "tool-checklist"
        ]);
        expect(view.container.querySelector("#tool-more")).toBeNull();

        // Narrow pane: the checklist group no longer fits.
        layout.paneWidth = 250;
        TriggerableResizeObserver.fire();
        expect(toolIds(view.container)).toEqual([
          "tool-bold",
          "tool-italic",
          "tool-more"
        ]);

        // The same narrow pane again: the count is stable (no measure loop).
        TriggerableResizeObserver.fire();
        expect(toolIds(view.container)).toEqual([
          "tool-bold",
          "tool-italic",
          "tool-more"
        ]);

        // Wide again: the cached natural width restores the checklist group.
        layout.paneWidth = 600;
        TriggerableResizeObserver.fire();
        expect(toolIds(view.container)).toEqual([
          "tool-bold",
          "tool-italic",
          "tool-checklist"
        ]);
        expect(view.container.querySelector("#tool-more")).toBeNull();
      });
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        originalObserver;
    }
  });

  test("never collapses the desktop web row, then measures once it becomes the mobile row", async () => {
    const layout: MeasuredLayout = {
      paneWidth: 100,
      groupWidths: [60, 10000, 10000],
      moreWidth: 40
    };

    await withMeasuredLayout(layout, async () => {
      const editor = makeEditor("<p>hello world</p>");
      const view = renderView(
        <Toolbar
          editor={asEditor(editor)}
          location="top"
          tools={clone(MOBILE_FLAT)}
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
        />
      );

      // Desktop web wraps instead of collapsing: no group is measured away,
      // even though the pane is far narrower than the groups.
      expect(toolIds(view.container)).toEqual([
        "tool-bold",
        "tool-italic",
        "tool-checklist"
      ]);
      expect(view.container.querySelector("#tool-more")).toBeNull();

      // The same mounted toolbar becomes the mobile row: it measures from the
      // real pane (and forgets the desktop state) instead of wrapping again.
      act(() => {
        useToolbarStore.setState({ isMobile: true });
      });
      expect(toolIds(view.container)).toEqual(["tool-more"]);
      expect(view.container.querySelectorAll("#tool-more")).toHaveLength(1);
    });
  });

  test("reserves the More button exactly once on the Mac capsule", async () => {
    useToolbarStore.setState({ isMobile: true });
    // The Mac budget is pane - 40 (capsule margin) - 28 (row padding) - 2, so
    // this pane leaves 300 pt. With 100 pt groups, an 18 pt gap and the More
    // button reserved once, two groups plus More cost 200 + 36 + 40 = 276 and
    // still fit; a double-counted reservation (316) would not.
    const layout: MeasuredLayout = {
      paneWidth: 370,
      groupWidths: [100, 100, 100],
      moreWidth: 40
    };

    await withMeasuredLayout(layout, async () => {
      const editor = makeEditor("<p>hello world</p>");
      const view = renderView(
        <Toolbar
          editor={asEditor(editor)}
          location="bottom"
          tools={clone(LEGACY_OVERFLOW)}
          macCatalyst
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
        />
      );

      // The static insert group and bold/italic stay on the capsule; only the
      // checklist group collapses into the existing More.
      expect(toolIds(view.container)).toEqual([
        "tool-bold",
        "tool-italic",
        "tool-more"
      ]);

      await click(view.container.querySelector("#tool-more"));
      const popup = view.container.querySelector('[data-test-id^="popup-"]');
      expect(popup).toBeTruthy();
      expect(
        Array.from(popup!.querySelectorAll(".toolbar-group button")).map(
          buttonKey
        )
      ).toEqual(["tool-checklist"]);
    });
  });

  test("keeps every unequal group when the complete row fits without a More", async () => {
    useToolbarStore.setState({ isMobile: true });
    // 60 + 120 + 10 = 190 <= pane 200: the *whole* row fits, so no group may be
    // collapsed merely because the More button would not also fit beside the
    // first two (60 + 120 + 40 = 220 > 200). The decision is taken on the
    // rendered DOM, not on a recomputed budget.
    const layout: MeasuredLayout = {
      paneWidth: 200,
      groupWidths: [60, 120, 10],
      moreWidth: 40
    };

    await withMeasuredLayout(layout, async () => {
      const editor = makeEditor("<p>hello world</p>");
      const view = renderView(
        <Toolbar
          editor={asEditor(editor)}
          location="bottom"
          tools={clone(MOBILE_FLAT)}
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
        />
      );

      // The static insert group (no `tool-` id), bold/italic and the narrow
      // checklist group all stay on the row; nothing collapses into a spurious
      // More. If the row were broken at the first overflowing pair, only
      // `["tool-more"]` would be left.
      expect(toolIds(view.container)).toEqual([
        "tool-bold",
        "tool-italic",
        "tool-checklist"
      ]);
      expect(view.container.querySelector("#tool-more")).toBeNull();
    });
  });
});

describe("REF-03 iOS standard writing tools", () => {
  test("renders Aa, list, one Insert, Undo/Redo and Done in the active standard surface", () => {
    useToolbarStore.setState({ isMobile: true, toolbarLocation: "bottom" });
    const editor = makeEditor("<p>synthetic words</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        ios
        tools={resolveToolbarGroups({ toolbarPreset: "default", ios: true })}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    expect(aaButton(view.container)).toBeTruthy();
    const ids = toolIds(view.container);
    expect(ids).toContain("tool-checklist");
    expect(ids).toContain("tool-undo");
    expect(ids).toContain("tool-redo");
    expect(ids).toContain("tool-closeKeyboard");
    expect(view.container.querySelectorAll('[title="Insert"]')).toHaveLength(1);
    expect(ids).not.toContain("tool-bold");
    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(
      buttons.indexOf(aaButton(view.container) as HTMLButtonElement)
    ).toBeLessThan(buttons.findIndex((button) => button.title === "Insert"));
  });
  test("opens grouped Aa controls, keeps advanced formatting reachable and runs the existing history", async () => {
    useToolbarStore.setState({ isMobile: true, toolbarLocation: "bottom" });
    const editor = makeEditor("<p>synthetic words</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        ios
        tools={resolveToolbarGroups({ toolbarPreset: "default", ios: true })}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    await click(aaButton(view.container));
    const bold = document.querySelector(
      '[aria-label="Bold"]'
    ) as HTMLButtonElement;
    expect(bold).toBeTruthy();
    expect(bold.tabIndex).toBe(0);
    expect(document.querySelector('[aria-label="Bullet list"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="Numbered list"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="Checklist"]')).toBeTruthy();
    await click(document.querySelector('button[title="Formatting"]'));
    expect(document.querySelector('button[title="Highlight"]')).toBeTruthy();
    expect(document.querySelector('button[title="Link to note"]')).toBeTruthy();
    expect(document.querySelector('button[title="Link"]')).toBeTruthy();
    await click(document.querySelector('[id$="ios-aa-back"]'));
    editor.commands.setTextSelection({ from: 1, to: 10 });
    await click(document.querySelector('[aria-label="Bold"]'));
    expect(editor.getHTML()).toContain("<strong>");
    // Re-render exactly as the shipping parent does on editor updates.
    view.rerender(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        ios
        tools={resolveToolbarGroups({ toolbarPreset: "default", ios: true })}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    await click(view.container.querySelector("#tool-undo"));
    expect(editor.getHTML()).not.toContain("<strong>");
    view.rerender(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        ios
        tools={resolveToolbarGroups({ toolbarPreset: "default", ios: true })}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    await click(view.container.querySelector("#tool-redo"));
    expect(editor.getHTML()).toContain("<strong>");
  });
});

describe("iOS custom configuration and popup ownership", () => {
  test("renders a nested configured Insert exactly once", async () => {
    useToolbarStore.setState({ isMobile: true, toolbarLocation: "bottom" });
    const editor = makeEditor("<p>synthetic words</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        ios
        tools={[["bold", ["insertBlock", "italic"]]]}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    expect(document.querySelectorAll('button[title="Insert"]')).toHaveLength(0);
    await click(view.container.querySelector('button[title="More"]'));
    expect(document.querySelectorAll('button[title="Insert"]')).toHaveLength(1);
  });
  test.each([{ tools: [["italic", "bold"]] }, { tools: [["bold"]] }])(
    "preserves configured order and supplies accessible iOS hit targets: %j",
    ({ tools }) => {
      useToolbarStore.setState({ isMobile: true, toolbarLocation: "bottom" });
      const editor = makeEditor("<p>synthetic words</p>");
      const view = renderView(
        <Toolbar
          editor={asEditor(editor)}
          location="bottom"
          ios
          tools={tools as ToolbarDefinition}
          defaultFontFamily="sans-serif"
          defaultFontSize={14}
        />
      );
      const buttons = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>(
          "#tool-bold, #tool-italic"
        )
      );
      expect(buttons.map((button) => button.id)).toEqual(
        (tools as string[][]).flat().map((id) => `tool-${id}`)
      );
      buttons.forEach((button) => {
        expect(button.tabIndex).toBe(0);
        expect(getComputedStyle(button).minHeight).toBe("44px");
      });
    }
  );
  test("closes the row's More before opening Aa and keeps advanced tool ids unique", async () => {
    useToolbarStore.setState({ isMobile: true, toolbarLocation: "bottom" });
    const editor = makeEditor("<p>synthetic words</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        ios
        tools={resolveToolbarGroups({ toolbarPreset: "default", ios: true })}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    await click(view.container.querySelector('button[title="More"]'));
    expect(document.querySelector('button[title="Highlight"]')).toBeTruthy();
    await click(aaButton(view.container));
    expect(document.querySelector('button[title="Highlight"]')).toBeNull();
    await click(document.querySelector('button[title="Formatting"]'));
    expect(document.querySelector('button[title="Highlight"]')).toBeTruthy();
    const ids = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[id^="tool-"]')
    ).map((button) => button.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });
});

test("keeps pinned advanced tools reachable alongside Aa without duplicate DOM ids", async () => {
  useToolbarStore.setState({ isMobile: true, toolbarLocation: "bottom" });
  const editor = makeEditor("<p>synthetic words</p>");
  const view = renderView(
    <Toolbar
      editor={asEditor(editor)}
      location="bottom"
      ios
      tools={resolveToolbarGroups({ toolbarPreset: "default", ios: true })}
      defaultFontFamily="sans-serif"
      defaultFontSize={14}
    />
  );
  await click(view.container.querySelector('button[title="More"]'));
  const row = Object.values(useToolbarStore.getState().openedPopups).find(
    (ref) => !!ref && ref.id.startsWith("more-")
  );
  expect(row).toBeTruthy();
  if (!row) throw new Error("Expected the opened More popup");
  act(() => {
    useToolbarStore.setState((state) => ({
      openedPopups: {
        ...state.openedPopups,
        [row!.id]: { ...row!, pinned: true }
      }
    }));
  });
  await click(aaButton(view.container));
  expect(useToolbarStore.getState().openedPopups[row!.id]).toBeTruthy();
  await click(document.querySelector('button[title="Formatting"]'));
  expect(document.querySelectorAll('button[title="Highlight"]')).toHaveLength(
    2
  );
  const ids = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[id^="tool-"]')
  ).map((button) => button.id);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
});

test("makes the visible Aa formatting label part of the working button", async () => {
  useToolbarStore.setState({ isMobile: true, toolbarLocation: "bottom" });
  const editor = makeEditor("<p>synthetic words</p>");
  const view = renderView(
    <Toolbar
      editor={asEditor(editor)}
      location="bottom"
      ios
      tools={resolveToolbarGroups({ toolbarPreset: "default", ios: true })}
      defaultFontFamily="sans-serif"
      defaultFontSize={14}
    />
  );
  await click(aaButton(view.container));
  const label = Array.from(
    document.querySelectorAll('[id$="ios-more-formatting"] span')
  ).find((element) => element.textContent === "Formatting");
  const button = label?.closest("button");
  expect(button).toBeTruthy();
  expect(getComputedStyle(button!).display).toBe("flex");
  expect(getComputedStyle(button!).flexDirection).toBe("row-reverse");
  expect(button?.getAttribute("aria-expanded")).toBe("false");
  expect(button?.getAttribute("aria-controls")).toBe("ios-aa-advanced");
  await click(label);
  expect(document.getElementById("ios-aa-advanced")?.getAttribute("role")).toBe(
    "group"
  );
  expect(document.querySelector('[id$="ios-more-formatting"]')).toBeNull();
  expect(document.querySelector('[id$="ios-aa-back"]')).toBeTruthy();
  expect(document.querySelector('button[title="Highlight"]')).toBeTruthy();
});

test("preserves iOS selection with a delayed keyboard flag and still runs one pointer command", () => {
  const previousKeyboard = globalThis.keyboardShown;
  globalThis.keyboardShown = false;
  try {
    useToolbarStore.setState({ isMobile: true, toolbarLocation: "bottom" });
    const editor = makeEditor("<p>synthetic selection</p>");
    editor.commands.setTextSelection({ from: 1, to: 10 });
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="bottom"
        ios
        tools={[["bold"]]}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    const button = view.container.querySelector('button[title="Bold"]')!;
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true
    });
    act(() => button.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(10);
    expect(editor.getText()).toBe("synthetic selection");
    act(() =>
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 1 })
      )
    );
    // A swallowed click or a duplicate toggle would both leave this false.
    expect(editor.isActive("bold")).toBe(true);
  } finally {
    globalThis.keyboardShown = previousKeyboard;
  }
});

test.each([
  { name: "non-iOS", ios: false, macCatalyst: false },
  { name: "Mac Catalyst even with ios flag", ios: true, macCatalyst: true }
])("retains pointer focus behavior for $name", ({ ios, macCatalyst }) => {
  const previousKeyboard = globalThis.keyboardShown;
  globalThis.keyboardShown = false;
  try {
    const editor = makeEditor("<p>synthetic selection</p>");
    const view = renderView(
      <Toolbar
        editor={asEditor(editor)}
        location="top"
        ios={ios}
        macCatalyst={macCatalyst}
        tools={[["bold"]]}
        defaultFontFamily="sans-serif"
        defaultFontSize={14}
      />
    );
    const button = view.container.querySelector('button[title="Bold"]')!;
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true
    });
    act(() => button.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(false);
    expect(button.getAttribute("tabindex")).toBe("-1");
  } finally {
    globalThis.keyboardShown = previousKeyboard;
  }
});
