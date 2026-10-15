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
 * Real-DOM contract coverage for `MoreTools` (the C3 mobile-overflow popup),
 * scoped to the style/forwarding contract added in this change, not pixel
 * geometry.
 *
 * STATUS: provenance is source-only. This test file was authored in an
 * isolated sandbox without the project toolchain; execution is performed by
 * the coordinator against the real toolchain, and the resulting execution
 * evidence is recorded in the external QA/report rather than as a claim in
 * this file. Nothing here makes any native, portal/positioning or
 * pixel/layout coverage claim.
 *
 * Real (not mocked): `MoreTools`, the real `PopupWrapper`
 * (`components/popup-presenter/index.tsx`), the real `ToolbarGroup`,
 * `ToolButton`, the real tool leaves resolved from a `tools: ToolId[]` list,
 * and a real `@tiptap/starter-kit` + `Editor`. A real Bold command is driven
 * end-to-end through a rendered button to prove the popup uses the genuine
 * tool leaves/command pipeline, not a parallel/duplicated renderer.
 *
 * Bounded, explicitly-mocked seam: `@notesnook/ui`'s `PopupPresenter` (the
 * themed portal/positioning primitive) is replaced by a thin component that
 * still renders a real `@theme-ui/components` `Box` (that's the package that
 * actually exports `Box`; `@theme-ui/core` only exports the context/provider
 * primitives such as `ThemeProvider`), forwards the *actual* `isOpen` it was
 * given, and forwards the real `sx` object both as the `Box`'s `sx` prop and
 * as a serialized `data-sx` attribute. Every other `@notesnook/ui` export
 * (`Icon`, `CommonButton`, etc.) used by the real `ToolButton`/`ToolbarGroup`
 * tree is the genuine module: it's loaded with `vi.importActual` and spread
 * into the mock's return value before `PopupPresenter` is overridden, so no
 * leaf of the real tree is mocked. This file makes NO portal and NO
 * pixel/layout claim: happy-dom has no CSS engine, so the `data-sx`
 * attribute is read back as a plain contract check of the values `MoreTools`
 * authored (wrap/box-sizing/overflow/max-height keys, or their absence), not
 * an arithmetic/computed-geometry proof. The handful of `getComputedStyle`
 * reads against the real (unmocked) `ToolbarGroup` root below are a
 * best-effort smoke check of the same flat, non-responsive style keys for
 * the same reason, and are likewise not a native/viewport validation -
 * that remains pending real-device QA per the design-system doc.
 *
 * Locale seam (copied, not imported, from `toolbar-render.test.tsx`): the
 * real `@notesnook/intl` lingui catalog needs compile-time macros this setup
 * doesn't run, so it's replaced by the same key-derived-label `Proxy` fixture
 * used there. Any key this suite doesn't enumerate still resolves to a
 * stable `intl:<key>` fallback instead of throwing, which is why the tool
 * labels below are asserted by id, not by exact text.
 *
 * Test-title capability note: "renders"/"keeps"/"forwards" below describe
 * what the real component tree produces through the documented seam, not a
 * claim about the unmocked `@notesnook/ui` implementation or native chrome.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, type ThemeUIStyleObject } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor } from "@tiptap/core";
import { MoreTools } from "../components/more-tools.js";
import { useToolbarStore } from "../stores/toolbar-store.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Same stable, key-derived label fixture as `toolbar-render.test.tsx`. */
vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    bold: "Bold",
    italic: "Italic",
    underline: "Underline",
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
 * Explicit, documented seam: replaces only `@notesnook/ui`'s `PopupPresenter`.
 * Every other export of the real module (`Icon`, `CommonButton`, etc., which
 * the real `ToolButton`/`ToolbarGroup` leaves resolve through) is the
 * genuine implementation, loaded via `vi.importActual` and spread into the
 * returned module before the single override. The replacement renders a
 * real `@theme-ui/components` `Box` so `sx` genuinely flows through a themed
 * component, forwards the real `isOpen`, and mirrors the forwarded props as
 * data attributes so the test can read them back without relying on
 * happy-dom's (absent) CSS engine. No portal, animation or positioning is
 * claimed.
 */
vi.mock("@notesnook/ui", async () => {
  const actual =
    await vi.importActual<typeof import("@notesnook/ui")>("@notesnook/ui");
  const { Box } = await import("@theme-ui/components");
  return {
    ...actual,
    PopupPresenter: (props: {
      isOpen?: boolean;
      children?: React.ReactNode;
      sx?: ThemeUIStyleObject;
      className?: string;
      focusOnRender?: boolean;
      blocking?: boolean;
    }) => {
      const { isOpen, children, sx, className, focusOnRender, blocking } = props;
      if (!isOpen) return null;
      return (
        <Box
          sx={sx}
          className={className}
          data-test-id="popup-presenter"
          data-open={String(!!isOpen)}
          data-focus-on-render={String(!!focusOnRender)}
          data-blocking={String(!!blocking)}
          data-sx={JSON.stringify(sx ?? {})}
        >
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

type Mounted = {
  container: HTMLElement;
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

function popupSx(container: HTMLElement) {
  const popup = container.querySelector('[data-test-id="popup-presenter"]');
  expect(popup, "expected the popup to be open").toBeTruthy();
  return {
    popup: popup as HTMLElement,
    sx: JSON.parse(popup!.getAttribute("data-sx") || "{}")
  };
}

afterEach(() => {
  for (const view of mounted) view.unmount();
  mounted = [];
  for (const { editor, element } of editorFixtures) {
    if (!editor.isDestroyed) editor.destroy();
    element.remove();
  }
  editorFixtures.length = 0;
});

beforeEach(() => {
  useToolbarStore.setState({
    isMobile: false,
    macCatalyst: false,
    toolbarLocation: "top",
    openedPopups: {},
    fontFamily: "sans-serif",
    fontSize: 14
  });
});

describe("MoreTools popup - mobile, non-Mac wrap contract", () => {
  test("wraps the popup and inner group with an explicit 4px row gap, keeps exact tool order, and exposes a reachable trigger/pin", async () => {
    useToolbarStore.setState({ isMobile: true, macCatalyst: false });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="more-tools-mobile"
        tools={["bold", "italic", "underline"]}
        icon="more"
        title="More"
      />
    );

    expect(
      view.container.querySelector('[data-test-id="popup-presenter"]')
    ).toBeNull();

    const trigger = view.container.querySelector("#tool-more");
    expect(trigger?.tagName).toBe("BUTTON");
    const accessibleName =
      trigger?.getAttribute("aria-label") ?? trigger?.getAttribute("title");
    expect(accessibleName).toBe("More");
    await click(trigger);

    const { popup, sx } = popupSx(view.container);
    expect(popup.getAttribute("data-open")).toBe("true");
    expect(sx.flexWrap).toBe("wrap");
    expect(sx.boxSizing).toBe("border-box");
    expect(sx.overflowX).toBe("hidden");
    expect(sx.overflowY).toBe("auto");
    expect(sx.maxHeight).toBe("70vh");
    expect(sx.maxWidth).toBe("95vw");
    expect(sx.gap).toBe("4px");

    const group = popup.querySelector(".toolbar-group") as HTMLElement | null;
    expect(group).toBeTruthy();
    const groupStyle = getComputedStyle(group!);
    expect(groupStyle.flexWrap).toBe("wrap");
    expect(Number.parseFloat(groupStyle.minWidth || "0")).toBe(0);
    expect(groupStyle.flexShrink).toBe("1");
    expect(groupStyle.gap || groupStyle.rowGap).toBe("4px");

    const ids = Array.from(
      group!.querySelectorAll<HTMLButtonElement>("button[id]")
    ).map((button) => button.id);
    expect(ids).toEqual(["tool-bold", "tool-italic", "tool-underline"]);

    const pin = popup.querySelector("#tool-pin");
    expect(pin?.tagName).toBe("BUTTON");
    await click(pin);
    // pinning must not close the popup it lives in
    expect(
      view.container.querySelector('[data-test-id="popup-presenter"]')
    ).toBeTruthy();
  });
});

describe("MoreTools popup - desktop keeps the old horizontal contract", () => {
  test("forwards the unchanged overflow-x/max-width sx and blocking=false/focusOnRender=false, with no new wrap/max-height keys", async () => {
    useToolbarStore.setState({ isMobile: false, macCatalyst: false });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="more-tools-desktop"
        tools={["bold"]}
        icon="more"
        title="More"
      />
    );

    await click(view.container.querySelector("#tool-more"));
    const { popup, sx } = popupSx(view.container);

    expect(sx.overflowX).toBe("auto");
    expect(sx.maxWidth).toBe("95vw");
    expect(sx.gap).toEqual([0, 0, "small"]);
    expect(sx.flexWrap).toBeUndefined();
    expect(sx.maxHeight).toBeUndefined();
    expect(sx.overflowY).toBeUndefined();
    expect(sx.boxSizing).toBeUndefined();

    expect(popup.getAttribute("data-focus-on-render")).toBe("false");
    expect(popup.getAttribute("data-blocking")).toBe("false");
  });
});

describe("MoreTools popup - mobile + Mac Catalyst bypasses the mobile wrap", () => {
  test("keeps the old horizontal contract even though isMobile is true, with the same pin/focusOnRender/blocking forwarding", async () => {
    useToolbarStore.setState({ isMobile: true, macCatalyst: true });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="more-tools-mobile-mac"
        tools={["bold"]}
        icon="more"
        title="More"
      />
    );

    await click(view.container.querySelector("#tool-more"));
    const { popup, sx } = popupSx(view.container);

    expect(sx.overflowX).toBe("auto");
    expect(sx.maxWidth).toBe("95vw");
    expect(sx.flexWrap).toBeUndefined();
    expect(sx.maxHeight).toBeUndefined();
    expect(sx.overflowY).toBeUndefined();
    expect(sx.boxSizing).toBeUndefined();

    expect(popup.getAttribute("data-focus-on-render")).toBe("false");
    expect(popup.getAttribute("data-blocking")).toBe("false");
  });
});

describe("MoreTools popup - real command pipeline", () => {
  test("a real Bold command applies through the popup's ToolbarGroup/ToolButton, proving the real tool leaves are used and not a duplicated renderer", async () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.selectAll();
    const textBefore = editor.getText();
    const { from: fromBefore, to: toBefore } = editor.state.selection;

    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="more-tools-command"
        tools={["bold"]}
        icon="more"
        title="More"
      />
    );

    await click(view.container.querySelector("#tool-more"));
    const { popup } = popupSx(view.container);
    expect(docMarkTypes(editor)).not.toContain("bold");
    // opening the popup must not disturb the editor's existing selection
    expect(editor.state.selection.from).toBe(fromBefore);
    expect(editor.state.selection.to).toBe(toBefore);

    await click(popup.querySelector("#tool-bold"));

    expect(docMarkTypes(editor)).toContain("bold");
    expect(editor.getText()).toBe(textBefore);
    expect(editor.state.selection.from).toBe(fromBefore);
    expect(editor.state.selection.to).toBe(toBefore);
  });
});
