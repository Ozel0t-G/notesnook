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
 * Runtime coverage for the warm-orange marker swatch: the real `ColorTool`
 * (`Highlight`/`TextColor`), the real `ColorPicker`, the real toolbar store
 * and a real `@tiptap/starter-kit` + `TextStyle` + the actual `Highlight`
 * extension. `ColorTool`'s own commands/store/palette are left real -
 * nothing about it is mocked.
 *
 * Bounded seams (same contract as `color-list-popup-parent.test.tsx`):
 * `@notesnook/ui`'s `PopupPresenter` is replaced with a thin stand-in that
 * still forwards the real `isOpen` flag and real children (happy-dom has no
 * layout engine); `@notesnook/intl` is replaced with a key-derived-label
 * `Proxy`. Nothing else - no theme accent/chrome override.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { colord } from "colord";
import { ThemeProvider, type ThemeUIStyleObject } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { Editor as TiptapEditor } from "@tiptap/core";
import { Highlight as HighlightMark } from "../../../extensions/highlight/highlight.js";
import {
  editorHighlight,
  editorHighlightForeground
} from "../../../extensions/highlight/editor-highlight-tokens.js";
import { DEFAULT_COLORS, Highlight, TextColor } from "../colors.js";
import { useToolbarStore } from "../../stores/toolbar-store.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../../types.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    highlight: "Highlight",
    textColor: "Text color",
    save: "Save",
    clear: "Clear",
    deleteMode: "Delete",
    chooseCustomColor: "Custom color",
    clickToRemove: "Click to remove"
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
  const { Box } = await import("@theme-ui/components");
  return {
    ...actual,
    PopupPresenter: (props: {
      isOpen?: boolean;
      children?: React.ReactNode;
      sx?: ThemeUIStyleObject;
      className?: string;
      scope?: string;
      onClose?: () => void;
    }) => {
      const { isOpen, children, sx, className, scope, onClose } = props;
      if (!isOpen) return null;
      return (
        <Box
          sx={sx}
          className={className}
          data-test-id="popup-presenter"
          data-scope={scope ?? ""}
        >
          <button data-test-id="popup-close" onClick={() => onClose?.()}>
            close
          </button>
          {children}
        </Box>
      );
    }
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

// Real theme-role fixtures: `MDIIconWrapper`/`isThemeColor` resolve `"icon"`
// through `theme.colors.icon`, so the symbols below are what actually reaches
// the rendered `<path style="fill: …">` in each appearance.
const DARK_THEME_ICON = "#EDEDED";
const LIGHT_THEME_ICON = "#1B1B1B";
const darkTheme = {
  iconSizes: shippingIconSizes,
  colors: { icon: DARK_THEME_ICON }
} as unknown as ThemeProviderTheme;
const lightTheme = {
  iconSizes: shippingIconSizes,
  colors: { icon: LIGHT_THEME_ICON }
} as unknown as ThemeProviderTheme;

type Mounted = { container: HTMLElement; unmount: () => void };
let mounted: Mounted[] = [];

function renderView(
  ui: React.ReactElement,
  theme: ThemeProviderTheme = testTheme
): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
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
    extensions: [StarterKit, TextStyle, Color, HighlightMark],
    content,
    editable: true
  });
  editorFixtures.push({ editor, element });
  return editor;
}

const asEditor = (editor: TiptapEditor) => editor as unknown as Editor;

function chevron(container: ParentNode) {
  return (
    container.querySelector("#tool-chevronDown") ??
    container.querySelector("#tool-chevronUp")
  );
}

function popupButtons(container: ParentNode) {
  return Array.from(
    container.querySelectorAll('[data-test-id="popup-presenter"] button')
  );
}

function colorSwatchButtons(container: ParentNode) {
  return popupButtons(container).filter((button) =>
    /^#[0-9a-fA-F]{3,8}$/.test(button.getAttribute("title") ?? "")
  );
}

const WARM_FOREGROUND = colord(editorHighlightForeground).toHex();

type GlyphPath = Element & {
  style?: { fill?: string; getPropertyValue?: (name: string) => string };
};

/**
 * The glyph color only ever reaches the DOM as `MDIIcon`'s `<path
 * style="fill: …">`, so read it back from the inline style (attribute first,
 * then the style object) and normalize through `colord` - happy-dom may
 * serialize hex as `rgb()` or leave React's direct property assignment in
 * place.
 */
function glyphFill(container: ParentNode, toolId: string): string | null {
  const path = container.querySelector(`#tool-${toolId} svg path`);
  if (!path) return null;
  const inline = path.getAttribute("style") ?? "";
  const fromAttribute = /(?:^|;)\s*fill:\s*([^;]+)/i.exec(inline)?.[1]?.trim();
  if (fromAttribute) return fromAttribute;
  const style = (path as GlyphPath).style;
  const viaGetter = style?.getPropertyValue?.("fill");
  if (viaGetter) return viaGetter.trim();
  return style?.fill?.trim() || null;
}

/**
 * The single CSS keyword the real `ColorTool` can hand to `MDIIcon`: the dark
 * appearance's legacy non-warm glyph (`colors.tsx`:
 * `activeColor && tColor?.isDark() ? "white" : "icon"`). `colord` is used in
 * this repo WITHOUT the `names` plugin, so `colord("white")` is invalid and
 * `toHex()` would silently fall back to `#000000`. Normalize exactly this
 * known legacy role explicitly; do NOT `colord.extend(namesPlugin)` here,
 * because that would change production's legacy glyph selection and every
 * other named-color test.
 */
const LEGACY_GLYPH_WHITE = "#ffffff";

/**
 * Fixture normalization of a color value: either a glyph fill read back from
 * the DOM or an expectation. Only the literal legacy `white` keyword is
 * accepted as a non-colord value; every other value must be parseable by
 * `colord`. An unparseable color means the fixture is wrong, so fail loudly
 * instead of silently collapsing it to `#000000`.
 */
function normalizeFill(raw: string): string {
  if (raw.trim().toLowerCase() === "white") return LEGACY_GLYPH_WHITE;
  const parsed = colord(raw);
  expect(
    parsed.isValid(),
    `rendered glyph fill / expectation is not a valid color: ${raw}`
  ).toBe(true);
  return parsed.toHex();
}

function normalizedGlyphFill(
  container: ParentNode,
  toolId: string
): string | null {
  const raw = glyphFill(container, toolId);
  return raw ? normalizeFill(raw) : null;
}

function expectGlyphFill(
  container: ParentNode,
  toolId: string,
  expectedHex: string
) {
  const fill = normalizedGlyphFill(container, toolId);
  expect(fill, `expected a rendered glyph for #tool-${toolId}`).not.toBeNull();
  expect(fill).toBe(normalizeFill(expectedHex));
  return fill;
}

function makeWarmHighlightEditor(backgroundColor: string = editorHighlight) {
  const editor = makeEditor("<p>hello world</p>");
  editor.commands.setTextSelection({ from: 1, to: 6 });
  editor.commands.setHighlight(backgroundColor);
  return editor;
}

function renderHighlight(
  editor: TiptapEditor,
  theme: ThemeProviderTheme = testTheme
): Mounted {
  return renderView(
    <Highlight editor={asEditor(editor)} icon="highlight" title="Highlight" />,
    theme
  );
}

beforeEach(() => {
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
});

describe("warm orange marker swatch", () => {
  test("DEFAULT_COLORS only gains the orange swatch on background; text and border palettes are unchanged", () => {
    expect(DEFAULT_COLORS.background[0]?.toLowerCase()).toBe(
      editorHighlight.toLowerCase()
    );
    expect(
      DEFAULT_COLORS.text.some(
        (color) => color.toLowerCase() === editorHighlight.toLowerCase()
      )
    ).toBe(false);
    expect(
      DEFAULT_COLORS.border.some(
        (color) => color.toLowerCase() === editorHighlight.toLowerCase()
      )
    ).toBe(false);
  });

  test("the Highlight palette exposes the orange swatch first among its color swatches, reachable on a horizontally-scrolling phone row", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Highlight editor={asEditor(editor)} icon="highlight" title="Highlight" />
    );
    await click(chevron(view.container));

    const colorButtons = colorSwatchButtons(view.container);
    expect(colorButtons.length).toBeGreaterThan(0);
    expect(colorButtons[0]?.getAttribute("title")?.toLowerCase()).toBe(
      editorHighlight.toLowerCase()
    );
  });

  test("clicking the orange swatch runs the real setHighlight command", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const view = renderView(
      <Highlight editor={asEditor(editor)} icon="highlight" title="Highlight" />
    );
    await click(chevron(view.container));

    const warm = colorSwatchButtons(view.container).find(
      (button) =>
        button.getAttribute("title")?.toLowerCase() ===
        editorHighlight.toLowerCase()
    );
    await click(warm);

    expect(
      editor.getAttributes("textStyle").backgroundColor?.toLowerCase()
    ).toBe(editorHighlight.toLowerCase());
  });

  test("the orange swatch is not added to TextColor's own palette", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <TextColor
        editor={asEditor(editor)}
        icon="textColor"
        title="Text color"
      />
    );
    await click(chevron(view.container));

    const warm = colorSwatchButtons(view.container).find(
      (button) =>
        button.getAttribute("title")?.toLowerCase() ===
        editorHighlight.toLowerCase()
    );
    expect(warm).toBeFalsy();
  });

  test("existing palette chrome (clear/delete/custom color) is untouched", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Highlight editor={asEditor(editor)} icon="highlight" title="Highlight" />
    );
    await click(chevron(view.container));

    const titles = popupButtons(view.container).map((button) =>
      button.getAttribute("title")
    );
    expect(titles).toContain("Clear");
    expect(titles).toContain("Delete");
    expect(titles).toContain("Custom color");
  });

  test("the primary Highlight button exposes an accessible, localized title after the SplitButton fix", () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Highlight editor={asEditor(editor)} icon="highlight" title="ignored" />
    );

    const button = view.container.querySelector("#tool-highlight");
    expect(
      button,
      "expected the primary color button to render with id tool-highlight"
    ).toBeTruthy();
    const accessibleName =
      button!.getAttribute("title") ?? button!.getAttribute("aria-label");
    expect(accessibleName).toBe("Highlight");
  });
});

describe("selected warm marker glyph foreground", () => {
  test("dark theme: the selected warm marker glyph uses the fixed semantic foreground instead of the dark theme's light icon", () => {
    const editor = makeWarmHighlightEditor();
    const view = renderHighlight(editor, darkTheme);

    const fill = expectGlyphFill(
      view.container,
      "highlight",
      editorHighlightForeground
    );
    expect(fill).not.toBe(LEGACY_GLYPH_WHITE);
    expect(fill).not.toBe(colord(DARK_THEME_ICON).toHex());
  });

  test("light theme: the same fixed foreground is used, so the warm glyph does not depend on the appearance", () => {
    const editor = makeWarmHighlightEditor();
    const view = renderHighlight(editor, lightTheme);

    const fill = expectGlyphFill(
      view.container,
      "highlight",
      editorHighlightForeground
    );
    expect(fill).not.toBe(colord(LIGHT_THEME_ICON).toHex());
    expect(fill).not.toBe(LEGACY_GLYPH_WHITE);
  });

  test("dark theme: a dark non-warm swatch keeps the legacy white glyph", () => {
    const editor = makeWarmHighlightEditor("#3f51b5");
    const view = renderHighlight(editor, darkTheme);

    const fill = expectGlyphFill(view.container, "highlight", "white");
    expect(fill).not.toBe(WARM_FOREGROUND);
  });

  test("dark theme: a light non-warm swatch keeps resolving the theme icon role", () => {
    const editor = makeWarmHighlightEditor("#fff176");
    const view = renderHighlight(editor, darkTheme);

    const fill = expectGlyphFill(view.container, "highlight", DARK_THEME_ICON);
    expect(fill).not.toBe(WARM_FOREGROUND);
  });

  test("the secondary chevron glyph keeps its legacy theme icon role while the warm marker is selected", () => {
    const editor = makeWarmHighlightEditor();
    const view = renderHighlight(editor, darkTheme);

    expectGlyphFill(view.container, "chevronDown", DARK_THEME_ICON);
  });

  test.each(["#f7c88b", "#F7C88B", "rgb(247, 200, 139)"])(
    "an opaque colord-equivalent warm encoding (%s) selects the fixed foreground",
    (value) => {
      const editor = makeWarmHighlightEditor(value);
      const view = renderHighlight(editor, darkTheme);

      expectGlyphFill(view.container, "highlight", editorHighlightForeground);
    }
  );

  test.each([
    "#F7C88BAA", // 8-digit hex (alpha)
    "rgba(247, 200, 139, 0.6)", // rgba(), non-opaque
    "#F7C88C" // near-miss
  ])("a non-exact warm encoding (%s) keeps the legacy glyph", (value) => {
    const editor = makeWarmHighlightEditor(value);
    const view = renderHighlight(editor, darkTheme);

    const fill = expectGlyphFill(view.container, "highlight", DARK_THEME_ICON);
    expect(fill).not.toBe(WARM_FOREGROUND);
  });

  test("baseline: an unsupported CSS color name (moccasin) keeps the legacy white glyph, not the warm marker foreground", () => {
    // `colord` runs here WITHOUT the `names` plugin, so `moccasin` is not a
    // color it can parse. `ColorTool` therefore takes its legacy dark-theme
    // branch (an unparseable color is treated as black => dark) and the glyph
    // falls back to the literal CSS `white` keyword. This documents the
    // fixture's actual dependency and preserves the unsupported-name
    // baseline: it is neither the warm-marker foreground nor the theme icon
    // role.
    expect(colord("moccasin").isValid()).toBe(false);

    const editor = makeWarmHighlightEditor("moccasin");
    const view = renderHighlight(editor, darkTheme);

    const fill = expectGlyphFill(view.container, "highlight", "white");
    expect(fill).toBe(LEGACY_GLYPH_WHITE);
    expect(fill).not.toBe(WARM_FOREGROUND);
    expect(fill).not.toBe(colord(DARK_THEME_ICON).toHex());
  });

  test("a warm text color (TextColor) is not forced to the marker foreground", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setColor(editorHighlight);

    const view = renderView(
      <TextColor
        editor={asEditor(editor)}
        icon="textColor"
        title="Text color"
      />,
      darkTheme
    );

    const fill = expectGlyphFill(view.container, "textColor", DARK_THEME_ICON);
    expect(fill).not.toBe(WARM_FOREGROUND);
  });

  test("rendering the warm selection changes neither the document, the selection nor the serialized content", () => {
    const editor = makeWarmHighlightEditor();
    const jsonBefore = JSON.stringify(editor.getJSON());
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };

    const view = renderHighlight(editor, darkTheme);

    expect(
      JSON.stringify(editor.getJSON()),
      "mounting the toolbar must not mutate the document"
    ).toBe(jsonBefore);
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);
    expect(editor.getHTML()).toContain(`background-color: ${editorHighlight}`);
    expect(editor.getHTML()).not.toContain(editorHighlightForeground);
    expect(editor.getHTML()).not.toContain(
      editorHighlightForeground.toLowerCase()
    );
    expect(normalizedGlyphFill(view.container, "highlight")).toBe(
      WARM_FOREGROUND
    );
  });
});
