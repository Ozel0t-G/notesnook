// @vitest-environment happy-dom
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
 * Real-DOM (ReactDOM + happy-dom) coverage for the *mobile wrapper*
 * `TiptapEditorWrapper` (`editor-mobile/src/components/tiptap.tsx`).
 *
 * What is actually exercised here: the wrapper's INPUT (a native `Settings`
 * payload) and its ACTUAL rendered DOM output. The wrapper only wires settings
 * into the shared editor `Toolbar` (`tools={resolveToolbarGroups({...})}`,
 * `macCatalyst`, `noToolbar`, `locked`), so these tests mount the real wrapper
 * with the real, unmodified source `Toolbar` and assert the config semantics
 * that reach the DOM.
 *
 * Bounded seams (deliberately mocked, and NOT the full runtime):
 * - `@notesnook/editor` is forwarded to the ACTUAL editor *source* (`Toolbar`
 *   default export + `resolveToolbarGroups`); only the `useTiptap` hook is
 *   replaced, so no real Tiptap editor lifecycle is bootstrapped. The real
 *   `@tiptap/starter-kit` + production `Link` editor is handed to the toolbar.
 * - the production menu/sheet presenters (`ResponsivePresenter`/`Container`)
 *   are replaced by real item/children passthroughs (their ReactModal portals
 *   are chrome, out of scope);
 * - `PopupWrapper` honours the real toolbar-store popup state; `Popup` (the
 *   `LinkPopup` chrome) is a passthrough; `EditorFloatingMenus` renders nothing.
 * - `EmotionEditorToolbarTheme` is a documented passthrough; the view renders
 *   inside a real `ThemeProvider` (`@theme-ui/core`) carrying a minimal
 *   `iconSizes` map typed against the existing `Theme`.
 * - `@notesnook/intl` (lingui compile-time catalog) is replaced by a controlled
 *   mock exposing one stable, key-derived label per key.
 * - happy-dom has no layout: `offsetWidth`/`clientWidth` are 0 and
 *   `ResizeObserver` is stubbed, so nothing overflows into a "more" popup.
 *
 * Peer coverage note: the popup/overflow/readonly-command rules are already
 * asserted exhaustively by `editor/src/toolbar/__tests__/toolbar-render.test.tsx`
 * against the same real Toolbar; this suite only proves the wrapper's settings
 * -> DOM mapping and must not redo those.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor } from "@tiptap/core";
import { strings } from "@notesnook/intl";
import type { Theme } from "@notesnook/theme";

import TiptapEditorWrapper from "../src/components/tiptap";
import { useToolbarStore } from "../../editor/src/toolbar/stores/toolbar-store.js";
import {
  getDefaultPresets,
  resolveToolbarGroups
} from "../../editor/src/toolbar/tool-definitions.js";
import { Link } from "../../editor/src/extensions/link/index.js";
import type { Settings } from "../src/utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Controlled locale seam: one stable label per key (see the header). */
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

/**
 * The wrapper wraps the toolbar in the mobile-only emotion theme; here it is a
 * documented passthrough so the real Toolbar renders against the real
 * `ThemeProvider` below.
 */
vi.mock("../src/theme-factory", async () => {
  const React = await import("react");
  return {
    EmotionEditorToolbarTheme: (props: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, props.children ?? null)
  };
});

/** Bounded tab seam: a stable tab id and an explicit `locked` flag. */
vi.mock("../src/hooks/useTabStore", () => ({
  useTabContext: () =>
    (globalThis as unknown as { __testTab: unknown }).__testTab
}));

/** Real item/child passthrough for the production menu/sheet presenters. */
vi.mock("../../editor/src/components/responsive/index.js", () => ({
  ResponsivePresenter: (props: {
    isOpen?: boolean;
    children?: React.ReactNode;
  }) => (props.isOpen ? props.children ?? null : null),
  ResponsiveContainer: (props: { desktop?: React.ReactNode }) =>
    props.desktop ?? null,
  DesktopOnly: (props: { children?: React.ReactNode }) => props.children ?? null,
  MobileOnly: () => null
}));

/** Popup seam honouring the real toolbar-store popup state. */
vi.mock(
  "../../editor/src/components/popup-presenter/index.js",
  async () => {
    const React = await import("react");
    const { useToolbarStore } = await import(
      "../../editor/src/toolbar/stores/toolbar-store.js"
    );
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
  }
);

/** Leaf chrome of `LinkPopup` only; its children still render. */
vi.mock("../../editor/src/toolbar/components/popup.js", () => ({
  Popup: (props: { children?: React.ReactNode }) => props.children ?? null
}));

/** Bounded seam: the floating hover/search menus are irrelevant here. */
vi.mock("../../editor/src/toolbar/floating-menus/index.js", () => ({
  EditorFloatingMenus: () => null
}));

/**
 * Forward the ACTUAL source `Toolbar` + `resolveToolbarGroups` from
 * `@notesnook/editor`, replacing only the `useTiptap` hook with the real
 * Tiptap editor built by the test (no real editor bootstrap).
 *
 * The source `Toolbar` is wrapped only to record the props the wrapper hands
 * it: the host's compact-bar opt-in (`ios`) is a prop of the shared toolbar
 * with no standalone DOM marker, so the wrapper -> `Toolbar` seam is asserted
 * at the props boundary. The wrapper then renders the real `Toolbar`
 * unchanged, so the DOM assertions below still describe the actual bar.
 */
vi.mock("@notesnook/editor", async () => {
  const React = await import("react");
  const toolbarModule = await import(
    "../../editor/src/toolbar/index.js"
  );
  const definitions = await import(
    "../../editor/src/toolbar/tool-definitions.js"
  );
  const RealToolbar = toolbarModule.default;
  return {
    Toolbar: (props: Parameters<typeof RealToolbar>[0]) => {
      (
        globalThis as unknown as {
          __lastToolbarProps?: Record<string, unknown>;
        }
      ).__lastToolbarProps = props as unknown as Record<string, unknown>;
      return React.createElement(RealToolbar, props);
    },
    resolveToolbarGroups: definitions.resolveToolbarGroups,
    useTiptap: () =>
      (globalThis as unknown as { __testEditor: unknown }).__testEditor,
    // Type-only names the wrapper imports; harmless placeholders so a
    // non-elided type import cannot trip vitest's missing-export guard.
    Editor: undefined,
    TiptapOptions: undefined
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

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/** The exact link extension the shipping editor builds (`index.ts`). */
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

function makeSettings(overrides: Partial<Settings>): Settings {
  return {
    readonly: false,
    fullscreen: false,
    deviceMode: "mobile",
    isMacCatalyst: false,
    premium: false,
    tools: [],
    corsProxy: "https://cors.notesnook.com",
    fontSize: 16,
    fontFamily: "sans-serif",
    timeFormat: "12-hour",
    dateFormat: "DD-MM-YYYY",
    fontScale: 1,
    markdownShortcuts: true,
    features: {},
    loggedIn: true,
    defaultLineHeight: 1.2,
    dayFormat: "short",
    ...overrides
  };
}

const testGlobals = globalThis as unknown as {
  editors?: Record<string, unknown>;
  __PLATFORM__?: string;
  isMacCatalyst?: boolean;
  __lastToolbarProps?: {
    ios?: boolean;
    macCatalyst?: boolean;
    popupsVisible?: boolean;
  };
  __testEditor?: TiptapEditor;
  __testTab?: { id: string; session?: { locked?: boolean } };
};

/** Mount the real wrapper with an explicit settings payload. */
function renderWrapper(
  editor: TiptapEditor,
  overrides: Partial<Settings>,
  readingPresentation?: boolean
) {
  testGlobals.__testEditor = editor;
  return renderView(
    <TiptapEditorWrapper
      options={{}}
      onEditorUpdate={() => {}}
      settings={makeSettings(overrides)}
      readingPresentation={readingPresentation}
    />
  );
}

function wrapperUi(
  editor: TiptapEditor,
  overrides: Partial<Settings>,
  readingPresentation?: boolean
) {
  testGlobals.__testEditor = editor;
  return (
    <TiptapEditorWrapper
      options={{}}
      onEditorUpdate={() => {}}
      settings={makeSettings(overrides)}
      readingPresentation={readingPresentation}
    />
  );
}

afterEach(() => {
  for (const view of mounted) view.unmount();
  mounted = [];
  for (const { editor, element } of editorFixtures)
    if (!editor.isDestroyed) editor.destroy();
  for (const { element } of editorFixtures) element.remove();
  editorFixtures.length = 0;
  // The host fixture is per-test: restore the globals it drives so a later
  // suite never inherits a platform or a captured toolbar payload.
  delete testGlobals.__PLATFORM__;
  delete testGlobals.isMacCatalyst;
  delete testGlobals.__lastToolbarProps;
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
  // Explicit zero geometry seam: nothing overflows into the "more" popup.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 0
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 0
  });
  testGlobals.editors = {};
  // Explicit, per-test host fixture. The default is the *unknown* host
  // (`__PLATFORM__` unset, as in a plain web view): `"ios"` is not set, so the
  // wrapper's compact-bar opt-in stays `false` and every pre-existing case
  // below renders exactly the bar it rendered before this packet. A test that
  // needs the iOS host sets `__PLATFORM__ = "ios"` itself; `afterEach`
  // restores.
  delete testGlobals.__PLATFORM__;
  delete testGlobals.isMacCatalyst;
  delete testGlobals.__lastToolbarProps;
  testGlobals.__testTab = { id: "tab-1", session: {} };
  useToolbarStore.setState({
    isMobile: false,
    macCatalyst: false,
    toolbarLocation: "top",
    openedPopups: {},
    fontFamily: "sans-serif",
    fontSize: 14
  });
});

/** The `tool-<icon>` id a `ToolButton` assigns. */
function toolIds(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button[id]"))
    .map((button) => button.id)
    .filter((id) => id.startsWith("tool-"));
}

/** The Mac format menu is a `Dropdown`, not a `ToolButton`: it has no id. */
function aaButton(root: ParentNode) {
  return (
    Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Aa"
    ) ?? null
  );
}

/**
 * Tool ids whose rendered `ToolButton` id is not `tool-<ToolId>`.
 *
 * `addLink` renders through `LinkTool`, which derives its button id from the
 * icon (`link`), so the resolver's `addLink` shows up as `tool-link`.
 */
const TOOL_BUTTON_ID: Record<string, string> = { addLink: "tool-link" };

/**
 * Tool ids whose definition renders as a `SplitButton`: the resolver's single
 * entry becomes TWO real `ToolButton`s - the main control plus a trailing
 * colour-palette opener with its own `tool-<icon>` id - that the
 * static+resolver `ToolbarDefinition` mapping has no entry for. `highlight`
 * is the only one in scope for this bar (`chevronUp`, since this row anchors
 * at the bottom).
 */
const TOOL_SPLIT_BUTTON_SECONDARY_ID: Record<string, string> = {
  highlight: "tool-chevronUp"
};

/**
 * The *visible* top-level `ToolButton` ids a resolved toolbar definition
 * produces, in the resolver's own order. Derived from the shared
 * `resolveToolbarGroups` output rather than a second hardcoded list:
 * - a flat group keeps its tool ids;
 * - a nested group renders exactly one `tool-more` button (its inner tools live
 *   in the closed "more" popup);
 * - the id-less "Aa" `Dropdown` (`macFormat`) contributes no `tool-` id and is
 *   asserted through `aaButton` instead;
 * - a `SplitButton` tool (`highlight`) contributes its real secondary control
 *   id right after its own, via `TOOL_SPLIT_BUTTON_SECONDARY_ID`.
 */
function resolvedVisibleOrder(
  groups: ReturnType<typeof resolveToolbarGroups>
): string[] {
  return groups
    .flatMap((group): (string | string[])[] =>
      group.some((tool) => Array.isArray(tool)) ? ["more"] : group
    )
    .filter((tool): tool is string => typeof tool === "string")
    .flatMap((tool) => {
      const id = TOOL_BUTTON_ID[tool] ?? `tool-${tool}`;
      const secondary = TOOL_SPLIT_BUTTON_SECONDARY_ID[tool];
      return secondary ? [id, secondary] : [id];
    })
    .filter((id) => id !== "tool-macFormat");
}

describe("TiptapEditorWrapper - Mac Catalyst explicit default preset", () => {
  test("renders the Aa format menu plus the list buttons, never an inline Bold", () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderWrapper(editor, {
      isMacCatalyst: true,
      toolbarPreset: "default"
    });

    expect(view.container.querySelector(".editor-toolbar")).toBeTruthy();
    expect(aaButton(view.container)).toBeTruthy();
    const ids = toolIds(view.container);
    expect(ids).toContain("tool-checklist");
    expect(ids).toContain("tool-bulletList");
    expect(ids).toContain("tool-numberedList");
    // The Mac bar keeps inline formats inside the "Aa" popover.
    expect(ids).not.toContain("tool-bold");
  });
});

describe("TiptapEditorWrapper - minimal preset", () => {
  test("renders Bold without the Aa menu even on Mac", () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderWrapper(editor, {
      isMacCatalyst: true,
      toolbarPreset: "minimal"
    });

    expect(toolIds(view.container)).toContain("tool-bold");
    expect(aaButton(view.container)).toBeNull();
  });
});

describe("TiptapEditorWrapper - custom preset", () => {
  test("keeps the exact configured group order", () => {
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderWrapper(editor, {
      toolbarPreset: "custom",
      tools: [["italic"], ["bold"]]
    });

    expect(toolIds(view.container)).toEqual(["tool-italic", "tool-bold"]);
  });

  test("an empty custom preset shows only the fixed insert button", () => {
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderWrapper(editor, {
      toolbarPreset: "custom",
      tools: []
    });

    const ids = toolIds(view.container);
    expect(ids).not.toContain("tool-bold");
    expect(ids).not.toContain("tool-more");
    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe(strings.insert());
  });
});

describe("TiptapEditorWrapper - legacy payloads", () => {
  test("a payload without a preset keeps its exact web-default groups, never rewritten to Mac Aa", () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderWrapper(editor, {
      isMacCatalyst: true,
      // No `toolbarPreset`: a legacy payload that equals the built-in web
      // default must stay verbatim on Mac.
      tools: clone(getDefaultPresets().default)
    });

    const ids = toolIds(view.container);
    expect(ids).toContain("tool-bold");
    expect(ids).toContain("tool-link");
    expect(aaButton(view.container)).toBeNull();
  });
});

describe("TiptapEditorWrapper - non-Mac default preset", () => {
  test("an Android tablet with the default preset renders the web groups without Aa", () => {
    testGlobals.__PLATFORM__ = "android";
    const editor = makeEditor("<p>hello world</p>");
    const view = renderWrapper(editor, {
      isMacCatalyst: false,
      deviceMode: "tablet",
      toolbarPreset: "default"
    });

    const ids = toolIds(view.container);
    expect(ids).toContain("tool-bold");
    expect(ids).not.toContain("tool-macFormat");
    expect(aaButton(view.container)).toBeNull();
  });
});

describe("TiptapEditorWrapper - live settings changes", () => {
  test("a preset change swaps the rendered buttons without touching the document or selection", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const view = renderView(
      wrapperUi(editor, { isMacCatalyst: true, toolbarPreset: "default" })
    );
    expect(aaButton(view.container)).toBeTruthy();
    expect(toolIds(view.container)).toContain("tool-checklist");
    expect(toolIds(view.container)).not.toContain("tool-bold");

    const docBefore = JSON.stringify(editor.getJSON());
    const textBefore = editor.getText();
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };

    view.rerender(
      wrapperUi(editor, { isMacCatalyst: true, toolbarPreset: "minimal" })
    );

    expect(aaButton(view.container)).toBeNull();
    expect(toolIds(view.container)).toContain("tool-bold");
    expect(JSON.stringify(editor.getJSON())).toBe(docBefore);
    expect(editor.getText()).toBe(textBefore);
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);
  });
});

describe("TiptapEditorWrapper - locked / noToolbar", () => {
  test("a locked session renders no toolbar; noToolbar keeps it mounted but hidden", () => {
    const editor = makeEditor("<p>hello world</p>");

    testGlobals.__testTab = { id: "tab-1", session: { locked: true } };
    const locked = renderView(wrapperUi(editor, { toolbarPreset: "default" }));
    expect(locked.container.querySelector(".editor-toolbar")).toBeNull();

    testGlobals.__testTab = { id: "tab-1", session: {} };
    const hidden = renderView(
      wrapperUi(editor, { toolbarPreset: "default", noToolbar: true })
    );
    expect(hidden.container.querySelector(".editor-toolbar")).toBeTruthy();
  });
});

describe("TiptapEditorWrapper - iOS quiet reading presentation", () => {
  test("hides the mounted toolbar in CSS while reading, and shows it by default", () => {
    const editor = makeEditor("<p>hello world</p>");

    // The quiet presentation is a CSS state on the *mounted* toolbar ...
    const reading = renderWrapper(editor, { toolbarPreset: "default" }, true);
    const readingBar = reading.container.querySelector<HTMLElement>(
      ".editor-toolbar"
    );
    expect(readingBar).toBeTruthy();
    expect(getComputedStyle(readingBar!).display).toBe("none");

    // ... and the default (undefined) keeps the previous visible flex row.
    const normal = renderWrapper(editor, { toolbarPreset: "default" });
    const normalBar = normal.container.querySelector<HTMLElement>(
      ".editor-toolbar"
    );
    expect(normalBar).toBeTruthy();
    expect(getComputedStyle(normalBar!).display).toBe("flex");
  });

  test("a live reading -> writing flip changes the display without a remount or a document/selection change", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const docBefore = JSON.stringify(editor.getJSON());
    const textBefore = editor.getText();
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };

    const view = renderView(
      wrapperUi(editor, { toolbarPreset: "default" }, true)
    );
    const readingBar = view.container.querySelector<HTMLElement>(
      ".editor-toolbar"
    )!;
    expect(getComputedStyle(readingBar).display).toBe("none");

    view.rerender(wrapperUi(editor, { toolbarPreset: "default" }, false));

    const writingBar = view.container.querySelector<HTMLElement>(
      ".editor-toolbar"
    )!;
    // Same element: the quiet presentation never unmounts the toolbar, so its
    // stores, tools and lifecycle survive the flip.
    expect(writingBar).toBe(readingBar);
    expect(getComputedStyle(writingBar).display).toBe("flex");
    expect(JSON.stringify(editor.getJSON())).toBe(docBefore);
    expect(editor.getText()).toBe(textBefore);
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);
  });

  test("suppresses the automatic link-settings popup while reading, restores it on the same toolbar when writing", async () => {
    const editor = makeEditor(
      '<p><a href="https://example.com">example</a></p>'
    );
    // Select inside the link's text so `isActive("link")` is true and the
    // automatic popup would open for a real selection.
    editor.commands.setTextSelection({ from: 1, to: 4 });

    const view = renderView(
      wrapperUi(editor, { toolbarPreset: "default" }, true)
    );
    await act(async () => {});

    // Reading: the toolbar is still mounted, but no link-settings portal opens.
    const readingBar = view.container.querySelector(".editor-toolbar");
    expect(readingBar).toBeTruthy();
    expect(
      view.container.querySelector('[data-test-id="popup-linkSettings"]')
    ).toBeNull();

    // Writing: the SAME mounted toolbar regains the automatic popup.
    view.rerender(wrapperUi(editor, { toolbarPreset: "default" }, false));
    await act(async () => {});
    expect(view.container.querySelector(".editor-toolbar")).toBe(readingBar);
    const opened = view.container.querySelector(
      '[data-test-id="popup-linkSettings"]'
    );
    expect(opened).toBeTruthy();
    expect(opened!.querySelector("#tool-openLink")).toBeTruthy();
    expect(opened!.querySelector("#tool-linkEdit")).toBeTruthy();
    expect(opened!.querySelector("#tool-linkRemove")).toBeTruthy();
    expect(opened!.querySelector("#tool-copyLink")).toBeTruthy();

    // Reading again: the popup is gone once more.
    view.rerender(wrapperUi(editor, { toolbarPreset: "default" }, true));
    await act(async () => {});
    expect(
      view.container.querySelector('[data-test-id="popup-linkSettings"]')
    ).toBeNull();
  });

  test("never overrides the locked or noToolbar semantics", () => {
    const editor = makeEditor("<p>hello world</p>");

    // A locked session renders no toolbar at all, reading or not.
    testGlobals.__testTab = { id: "tab-1", session: { locked: true } };
    const locked = renderWrapper(editor, { toolbarPreset: "default" }, true);
    expect(locked.container.querySelector(".editor-toolbar")).toBeNull();

    // `noToolbar` keeps the previous behaviour - mounted but hidden - whichever
    // way the reading flag is set.
    testGlobals.__testTab = { id: "tab-1", session: {} };
    for (const reading of [true, false]) {
      const view = renderWrapper(
        editor,
        { toolbarPreset: "default", noToolbar: true },
        reading
      );
      const bar = view.container.querySelector<HTMLElement>(".editor-toolbar");
      expect(bar).toBeTruthy();
      expect(getComputedStyle(bar!).display).toBe("none");
    }
  });
});

describe("TiptapEditorWrapper - compact iOS host", () => {
  test("an iOS host renders the real Aa + inline formats + Highlight bar in the resolver's order and forwards the opt-in", () => {
    // The single OS global the native app injects before the bundle runs; the
    // wrapper derives its `ios` opt-in from it (`ios && !Mac`).
    testGlobals.__PLATFORM__ = "ios";
    // The shipping iOS presentation is the mobile bottom bar, not the
    // desktop-flow row the older cases use.
    useToolbarStore.setState({ isMobile: true });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderWrapper(editor, {
      isMacCatalyst: false,
      toolbarPreset: "default"
    });

    // The wrapper -> Toolbar prop boundary is the proof here: `ios` is a prop
    // of the shared Toolbar (no standalone DOM marker of its own today) and is
    // forwarded unconditionally as `ios && !Mac`.
    expect(testGlobals.__lastToolbarProps?.ios).toBe(true);
    expect(testGlobals.__lastToolbarProps?.macCatalyst).toBe(false);

    // The real source Toolbar renders the compact bar: the real "Aa" format
    // menu plus the individual inline formats and Highlight, uncollapsed (a
    // layout-less host never overflows into "more").
    expect(view.container.querySelector(".editor-toolbar")).toBeTruthy();
    expect(aaButton(view.container)).toBeTruthy();
    const ids = toolIds(view.container);
    expect(ids).toContain("tool-bold");
    expect(ids).toContain("tool-highlight");

    // The static "Insert" control (`MOBILE_STATIC_TOOLBAR_GROUPS`) renders a
    // real `Button` with no `id` of its own - only a `title`/`aria-label`
    // (`block.tsx`) - so it is asserted here by that label, never folded into
    // the id-based expectation below.
    const insertButton = Array.from(
      view.container.querySelectorAll("button")
    ).find((button) => button.getAttribute("aria-label") === strings.insert());
    expect(insertButton).toBeTruthy();

    // Exact order, not a filtered subset: the resolver's own "default" +
    // `ios` groups, in the same order `Toolbar` renders them. The static
    // prepended group's one real control is id-less (see above), so it is
    // excluded here rather than expanded into ids it never renders.
    const expected = resolvedVisibleOrder(
      resolveToolbarGroups({ toolbarPreset: "default", ios: true })
    );
    expect(ids).toEqual(expected);
  });

  test("iOS + Mac Catalyst keeps the Mac default row and never forwards the iOS opt-in", () => {
    testGlobals.__PLATFORM__ = "ios";
    const editor = makeEditor("<p>hello world</p>");
    const view = renderWrapper(editor, {
      isMacCatalyst: true,
      toolbarPreset: "default"
    });

    // Mac Catalyst wins over the iOS host: the wrapper normalizes the opt-in
    // off before it reaches either the resolver or the Toolbar.
    expect(testGlobals.__lastToolbarProps?.ios).toBe(false);
    expect(testGlobals.__lastToolbarProps?.macCatalyst).toBe(true);

    expect(aaButton(view.container)).toBeTruthy();
    const ids = toolIds(view.container);
    expect(ids).toContain("tool-checklist");
    expect(ids).toContain("tool-bulletList");
    expect(ids).toContain("tool-numberedList");
    // The Mac bar keeps inline formats inside "Aa": no inline Bold/Highlight.
    expect(ids).not.toContain("tool-bold");
    expect(ids).not.toContain("tool-highlight");
  });

  test("an absent platform global and Android both preserve the previous default bar", () => {
    const editor = makeEditor("<p>hello world</p>");

    delete testGlobals.__PLATFORM__;
    const noGlobal = renderWrapper(editor, {
      isMacCatalyst: false,
      toolbarPreset: "default"
    });
    expect(testGlobals.__lastToolbarProps?.ios).toBe(false);
    expect(toolIds(noGlobal.container)).toContain("tool-bold");
    expect(aaButton(noGlobal.container)).toBeNull();

    testGlobals.__PLATFORM__ = "android";
    const android = renderWrapper(editor, {
      isMacCatalyst: false,
      toolbarPreset: "default"
    });
    expect(testGlobals.__lastToolbarProps?.ios).toBe(false);
    expect(toolIds(android.container)).toContain("tool-bold");
    expect(aaButton(android.container)).toBeNull();
  });
});

describe("TiptapEditorWrapper - popupsVisible forwarding", () => {
  test("maps reading/writing/reading to popupsVisible false/true/false", () => {
    const editor = makeEditor("<p>hello world</p>");

    const view = renderView(
      wrapperUi(editor, { toolbarPreset: "default" }, true)
    );
    expect(testGlobals.__lastToolbarProps?.popupsVisible).toBe(false);

    view.rerender(wrapperUi(editor, { toolbarPreset: "default" }, false));
    expect(testGlobals.__lastToolbarProps?.popupsVisible).toBe(true);

    view.rerender(wrapperUi(editor, { toolbarPreset: "default" }, true));
    expect(testGlobals.__lastToolbarProps?.popupsVisible).toBe(false);
  });

  test("defaults popupsVisible to true on Mac Catalyst and Android when reading is not set", () => {
    const macEditor = makeEditor("<p>hello world</p>");
    renderWrapper(macEditor, {
      isMacCatalyst: true,
      toolbarPreset: "default"
    });
    expect(testGlobals.__lastToolbarProps?.popupsVisible).toBe(true);

    testGlobals.__PLATFORM__ = "android";
    const androidEditor = makeEditor("<p>hello world</p>");
    renderWrapper(androidEditor, {
      isMacCatalyst: false,
      toolbarPreset: "default"
    });
    expect(testGlobals.__lastToolbarProps?.popupsVisible).toBe(true);
  });
});
