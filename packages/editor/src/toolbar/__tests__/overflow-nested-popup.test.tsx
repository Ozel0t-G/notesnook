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
 * Runtime coverage for the *nested* popup path of the collapsed mobile "More"
 * group: on a phone the bottom toolbar forces every popup into the same
 * `"mobile"` store group, so a menu opened from inside More used to
 * `closePopupGroup` its own parent (measured QA defect: "the footer More shows
 * Paragraph, tapping Paragraph closes More together with the child"). These
 * tests pin the retained parent association and the closing cascades that go
 * with it, and they are written so they fail against the pre-patch source
 * (where the child's `open()` closes More).
 *
 * Real (not mocked): `MoreTools`, the real `PopupWrapper`
 * (`components/popup-presenter/index.tsx`) and its real `usePopupHandler`
 * effect, the real `ToolbarGroup`, the real `Dropdown`, the real tool leaves
 * resolved from a `tools` list (`Headings`, `MacFormat`, `Bold`), the real
 * toolbar store (`toolbar-store.ts`, including the parent/ancestry protocol),
 * and a real `@tiptap/starter-kit` + `TextStyle` editor. The menu items the
 * assertions click are the real items (real titles, real `onClick` command
 * closures) produced by the real tools.
 *
 * Bounded, explicitly-mocked seams (the same order the existing
 * `more-tools-popup.test.tsx` suite uses):
 * - `@notesnook/ui`'s positioning presenters are replaced with thin
 *   components that still receive and forward the *actual* `isOpen` flag and
 *   the *actual* children/items, and that mirror the real presenter's close
 *   route: the `PopupPresenter` stand-in exposes a `popup-close` trigger that
 *   invokes the real `onClose` (ESC/backdrop), and the `MenuPresenter`
 *   stand-in runs each real item's `onClick` and then the real `onClose`,
 *   exactly like `ui`'s `Menu.onAction`. The portal/modal chrome, animation,
 *   focus trapping and pixel positioning are out of scope (happy-dom has no
 *   layout engine), and nothing here makes a native/viewport claim.
 * - `@theme-ui/components`' `Box` is still used for the popup stand-in, so the
 *   authored `sx` genuinely flows through a themed component.
 *
 * Locale seam (the same fixture as `toolbar-render.test.tsx`): the real
 * `@notesnook/intl` lingui catalog needs compile-time macros this setup does
 * not run, so it is replaced by a key-derived-label `Proxy`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, type ThemeUIStyleObject } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import { Editor as TiptapEditor } from "@tiptap/core";
import { strings } from "@notesnook/intl";
import { MoreTools } from "../components/more-tools.js";
import { ToolbarGroup } from "../components/toolbar-group.js";
import { useToolbarStore } from "../stores/toolbar-store.js";
import type { ToolId } from "../tools/index.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Stable, key-derived label fixture (same seam as `toolbar-render.test.tsx`). */
vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    more: "More",
    paragraph: "Paragraph",
    headings: "Headings",
    formatting: "Formatting",
    insert: "Insert",
    bold: "Bold",
    italic: "Italic"
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
 * Positioning-presenter seam. Everything else from the real module (`Icon`,
 * `MenuItem` types, ...) is the genuine implementation, spread into the mock
 * before the two overrides. Both stand-ins keep the real open flags and the
 * real item/command wiring:
 * - `PopupPresenter` mirrors the real "closed presenters render nothing"
 *   contract and exposes the real `onClose` so the ESC/backdrop route is
 *   reachable;
 * - `MenuPresenter` mirrors `ui`'s menu action order
 *   (`item.onClick()` then `onClose()`).
 */
vi.mock("@notesnook/ui", async () => {
  const actual =
    await vi.importActual<typeof import("@notesnook/ui")>("@notesnook/ui");
  const { Box } = await import("@theme-ui/components");
  type Item = {
    type?: string;
    key: string;
    title?: string;
    onClick?: () => void;
  };
  return {
    ...actual,
    PopupPresenter: (props: {
      isOpen?: boolean;
      children?: React.ReactNode;
      sx?: ThemeUIStyleObject;
      className?: string;
      scope?: string;
      onClose?: () => void;
      focusOnRender?: boolean;
      blocking?: boolean;
    }) => {
      const {
        isOpen,
        children,
        sx,
        className,
        scope,
        onClose,
        focusOnRender,
        blocking
      } = props;
      if (!isOpen) return null;
      return (
        <Box
          sx={sx}
          className={className}
          data-test-id="popup-presenter"
          data-scope={scope ?? ""}
          data-open={String(!!isOpen)}
          data-focus-on-render={String(!!focusOnRender)}
          data-blocking={String(!!blocking)}
          data-sx={JSON.stringify(sx ?? {})}
        >
          {/* the real presenter's ESC/backdrop/overlay close route */}
          <button data-test-id="popup-close" onClick={() => onClose?.()}>
            close
          </button>
          {children}
        </Box>
      );
    },
    MenuPresenter: (props: {
      isOpen?: boolean;
      items?: Item[];
      onClose?: () => void;
    }) => {
      if (!props.isOpen) return null;
      return (
        <div data-test-id="menu-presenter" data-open="true">
          {(props.items ?? []).map((item) =>
            item.type === "button" ? (
              <button
                key={item.key}
                data-test-id={`menu-item-${item.key}`}
                onClick={() => {
                  // `ui`'s Menu.onAction: run the action, then close.
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
    // `TextStyle` is what the real editor ships: the heading/format menu items
    // clear the manual `textStyle` override before applying their style.
    extensions: [StarterKit, TextStyle],
    content,
    editable: true
  });
  editorFixtures.push({ editor, element });
  return editor;
}

const asEditor = (editor: TiptapEditor) => editor as unknown as Editor;

type PopupRecord = { id: string; group: string; parent?: string; pinned?: boolean };

/** The real store record for a popup id, or `undefined`/`false` when closed. */
function popupRecord(id: string) {
  return useToolbarStore.getState().openedPopups[id] as
    | PopupRecord
    | false
    | undefined;
}

function isOpen(id: string) {
  return typeof popupRecord(id) === "object";
}

/** The recorded `parent` of a popup, or `undefined` when it has none / is closed. */
function parentOf(id: string) {
  const ref = popupRecord(id);
  return typeof ref === "object" ? ref.parent : undefined;
}

/** Popup ids that are still recorded as open (a store leak smells like this). */
function leakedPopups() {
  return Object.entries(useToolbarStore.getState().openedPopups)
    .filter(([, ref]) => !!ref)
    .map(([id]) => id);
}

function popupEl(container: HTMLElement | ParentNode) {
  return container.querySelector('[data-test-id="popup-presenter"]');
}

function menuEl(container: HTMLElement | ParentNode) {
  return container.querySelector('[data-test-id="menu-presenter"]');
}

function menuItem(container: ParentNode, key: string) {
  return container.querySelector(`[data-test-id="menu-item-${key}"]`);
}

/** A `Dropdown`'s trigger is its labelled button (the dropdown has no id). */
function dropdownTrigger(container: ParentNode, label: string) {
  return (
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === label
    ) ?? null
  );
}

/** One footer "More" group whose only nested tool is the Headings dropdown. */
function renderFooterMore(editor: TiptapEditor) {
  return renderView(
    <MoreTools
      editor={asEditor(editor)}
      popupId="more-tools"
      tools={["headings"] as ToolId[]}
      icon="more"
      title={strings.more()}
    />
  );
}

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

afterEach(() => {
  for (const view of mounted) view.unmount();
  mounted = [];
  for (const { editor, element } of editorFixtures) {
    if (!editor.isDestroyed) editor.destroy();
    element.remove();
  }
  editorFixtures.length = 0;
});

describe("nested popup on the phone footer toolbar", () => {
  test("opening the Headings menu from More keeps More (and its record) open, twice in a row", async () => {
    useToolbarStore.setState({
      isMobile: true,
      macCatalyst: false,
      toolbarLocation: "bottom"
    });
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const view = renderFooterMore(editor);

    for (let round = 1; round <= 2; round++) {
      const more = view.container.querySelector("#tool-more");
      await click(more);

      // The bottom toolbar puts every popup in the shared "mobile" group: that
      // shared group is exactly what used to make the child close its parent.
      expect(popupRecord("more-tools")).toMatchObject({ group: "mobile" });
      expect(popupEl(view.container)).toBeTruthy();

      // More shows "Paragraph" (the same node the QA report describes).
      await click(dropdownTrigger(popupEl(view.container)!, strings.paragraph()));

      // The child menu renders and its record points at the popup it lives in.
      expect(menuEl(view.container)).toBeTruthy();
      expect(popupRecord("headings")).toMatchObject({
        group: "mobile",
        parent: "more-tools"
      });
      // ...and More survived opening it.
      expect(isOpen("more-tools")).toBe(true);
      expect(popupEl(view.container)).toBeTruthy();

      const selectionBefore = {
        from: editor.state.selection.from,
        to: editor.state.selection.to
      };
      await click(menuItem(view.container, "paragraph"));

      // the real Paragraph command ran and the selection was untouched
      expect(editor.getText()).toBe("hello world");
      expect(editor.state.selection.from).toBe(selectionBefore.from);
      expect(editor.state.selection.to).toBe(selectionBefore.to);

      // only the child closed; More is still there
      expect(menuEl(view.container)).toBeNull();
      expect(isOpen("headings")).toBe(false);
      expect(isOpen("more-tools")).toBe(true);
      expect(leakedPopups()).toEqual(["more-tools"]);

      // closing More leaves no record behind at all
      await click(view.container.querySelector("#tool-more"));
      expect(isOpen("more-tools")).toBe(false);
      expect(leakedPopups()).toEqual([]);
    }
  });

  test("a heading picked from the nested menu runs the real command and closes only the child", async () => {
    useToolbarStore.setState({
      isMobile: true,
      macCatalyst: false,
      toolbarLocation: "bottom"
    });
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.selectAll();
    const textBefore = editor.getText();
    const view = renderFooterMore(editor);

    await click(view.container.querySelector("#tool-more"));
    await click(dropdownTrigger(popupEl(view.container)!, strings.paragraph()));
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    };

    await click(menuItem(view.container, "heading-1"));

    expect(editor.isActive("heading", { level: 1 })).toBe(true);
    expect(editor.getText()).toBe(textBefore);
    expect(editor.state.selection.from).toBe(selectionBefore.from);
    expect(editor.state.selection.to).toBe(selectionBefore.to);
    expect(isOpen("headings")).toBe(false);
    expect(isOpen("more-tools")).toBe(true);
    expect(menuEl(view.container)).toBeNull();
  });

  test("closing More through the presenter (ESC/backdrop) closes its open descendant too", async () => {
    useToolbarStore.setState({
      isMobile: true,
      macCatalyst: false,
      toolbarLocation: "bottom"
    });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderFooterMore(editor);

    await click(view.container.querySelector("#tool-more"));
    await click(dropdownTrigger(popupEl(view.container)!, strings.paragraph()));
    expect(isOpen("headings")).toBe(true);

    await click(view.container.querySelector('[data-test-id="popup-close"]'));

    // No stale descendant record: reopening More must not resurrect the menu.
    expect(isOpen("more-tools")).toBe(false);
    expect(isOpen("headings")).toBe(false);
    expect(leakedPopups()).toEqual([]);

    await click(view.container.querySelector("#tool-more"));
    expect(isOpen("more-tools")).toBe(true);
    expect(menuEl(view.container)).toBeNull();
    expect(leakedPopups()).toEqual(["more-tools"]);
  });

  test("opening a second nested menu closes the first sibling but never More", async () => {
    useToolbarStore.setState({
      isMobile: true,
      macCatalyst: false,
      toolbarLocation: "bottom"
    });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="more-tools"
        tools={["headings", "macFormat"] as ToolId[]}
        icon="more"
        title={strings.more()}
      />
    );

    await click(view.container.querySelector("#tool-more"));
    const popup = popupEl(view.container)!;

    await click(dropdownTrigger(popup, strings.paragraph()));
    expect(isOpen("headings")).toBe(true);

    // The Mac "Aa" menu is a sibling in the same (mobile) group.
    await click(dropdownTrigger(popupEl(view.container)!, "Aa"));
    expect(isOpen("macFormat")).toBe(true);
    expect(isOpen("headings")).toBe(false);
    // the parent is not a sibling: it stays open
    expect(isOpen("more-tools")).toBe(true);
    expect(menuEl(view.container)).toBeTruthy();

    await click(view.container.querySelector("#tool-more"));
    expect(isOpen("more-tools")).toBe(false);
    expect(isOpen("macFormat")).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });

  test("a menu opened inside a pinned More inherits the pin and cannot close it", async () => {
    useToolbarStore.setState({
      isMobile: true,
      macCatalyst: false,
      toolbarLocation: "bottom"
    });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderFooterMore(editor);

    await click(view.container.querySelector("#tool-more"));
    await click(popupEl(view.container)!.querySelector("#tool-pin"));
    expect(popupRecord("more-tools")).toMatchObject({ pinned: true });

    await click(dropdownTrigger(popupEl(view.container)!, strings.paragraph()));

    // pin inheritance (existing protocol) and a pinned parent that survives
    expect(popupRecord("headings")).toMatchObject({
      parent: "more-tools",
      pinned: true
    });
    expect(popupRecord("more-tools")).toMatchObject({ pinned: true });

    // closing the child leaves the pinned parent open
    await click(menuItem(view.container, "paragraph"));
    expect(isOpen("headings")).toBe(false);
    expect(popupRecord("more-tools")).toMatchObject({ pinned: true });
    expect(popupEl(view.container)).toBeTruthy();
  });

  test("a three-deep chain (More > nested More > menu) keeps every ancestor open", async () => {
    useToolbarStore.setState({
      isMobile: true,
      macCatalyst: false,
      toolbarLocation: "bottom"
    });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="outer"
        tools={[["bold", "headings"]] as unknown as ToolId[]}
        icon="more"
        title={strings.more()}
      />
    );

    // The outer trigger is the row button; the inner one lives inside the
    // outer popup (both are `tool-more`, as in the real flattened toolbar).
    await click(view.container.querySelector("#tool-more"));
    const outerPopup = popupEl(view.container)!;
    const innerTrigger = outerPopup.querySelector("#tool-more");
    expect(innerTrigger).toBeTruthy();
    await click(innerTrigger);

    // The inner "more" popup is namespaced by `ToolbarGroup` with the reserved
    // `more-` prefix, so it cannot collide with the leaf ids it contains.
    expect(popupRecord("more-boldheadings")).toMatchObject({ parent: "outer" });
    const innerPopup = popupEl(outerPopup)!;
    expect(innerPopup).toBeTruthy();

    await click(dropdownTrigger(innerPopup, strings.paragraph()));

    // Opening the leaf must not have dropped the grandparent.
    expect(popupRecord("headings")).toMatchObject({
      parent: "more-boldheadings"
    });
    expect(isOpen("more-boldheadings")).toBe(true);
    expect(isOpen("outer")).toBe(true);
    expect(menuEl(view.container)).toBeTruthy();

    // Closing the outermost popup cascades through the whole chain.
    await click(view.container.querySelector("#tool-more"));
    expect(leakedPopups()).toEqual([]);
  });

  test("the desktop top row keeps its toolbarGroup popup and its nested-menu behavior", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderFooterMore(editor);

    await click(view.container.querySelector("#tool-more"));
    expect(popupRecord("more-tools")).toMatchObject({ group: "toolbarGroup" });

    await click(dropdownTrigger(popupEl(view.container)!, strings.paragraph()));
    // a nested dropdown still records its parent on desktop
    expect(popupRecord("headings")).toMatchObject({ parent: "more-tools" });
    expect(isOpen("more-tools")).toBe(true);

    await click(view.container.querySelector("#tool-more"));
    expect(leakedPopups()).toEqual([]);
  });

  test("mobile Mac Catalyst keeps the mobile group and the unwrapped popup contract", async () => {
    useToolbarStore.setState({ isMobile: true, macCatalyst: true });
    const editor = makeEditor("<p>hello world</p>");
    const view = renderFooterMore(editor);

    await click(view.container.querySelector("#tool-more"));
    const popup = popupEl(view.container)!;
    expect(popupRecord("more-tools")).toMatchObject({ group: "mobile" });
    // Mac Catalyst is mobile but must not get the phone wrap contract.
    expect(
      JSON.parse(popup.getAttribute("data-sx") || "{}").flexWrap
    ).toBeUndefined();

    await click(dropdownTrigger(popup, strings.paragraph()));
    expect(isOpen("more-tools")).toBe(true);
    expect(menuEl(view.container)).toBeTruthy();

    await click(menuItem(view.container, "paragraph"));
    expect(isOpen("more-tools")).toBe(true);
    expect(leakedPopups()).toEqual(["more-tools"]);
  });

  test("a phantom self-parent group id is ignored: More records no parent and pin/unpin terminate", async () => {
    // Reproduces the collapsed single-tool group: `Toolbar` merges the
    // overflow into `[[tool]]`, so `groupId === tools.join("")` equals the
    // "more" popup's own id (`"bold"`). The tool-group id is handed to
    // `MoreTools` as `parentGroup`; treating it as the parent would record the
    // popup as its own parent, and the first pin toggle would recurse forever.
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="bold"
        tools={["bold"] as ToolId[]}
        parentGroup="bold"
        icon="more"
        title={strings.more()}
      />
    );

    await click(view.container.querySelector("#tool-more"));
    // The phantom `parentGroup` must be ignored: a top-level "more" has no
    // parent. This assertion is what fails first against the pre-fix source.
    expect(parentOf("bold")).toBeUndefined();
    expect(popupRecord("bold")).toMatchObject({ group: "toolbarGroup" });

    // Pinning (and un-pinning) a self-parented popup used to recurse without a
    // base case; both toggles must terminate and flip the pin.
    await click(popupEl(view.container)!.querySelector("#tool-pin"));
    expect(popupRecord("bold")).toMatchObject({ pinned: true });
    await click(popupEl(view.container)!.querySelector("#tool-pin"));
    expect(popupRecord("bold")).toMatchObject({ pinned: false });

    // Closing terminates and leaks nothing.
    await click(view.container.querySelector("#tool-more"));
    expect(isOpen("bold")).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });

  test("a collapsed single-tool group namespaces its More popup so it never collides with the leaf popup", async () => {
    // The shipping renderer for the real overflow path: a group whose only
    // tool is the Headings dropdown. Before the fix its "more" popup reused the
    // leaf id `"headings"`, so opening "more" auto-opened Headings and the two
    // could not be toggled independently.
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <ToolbarGroup
        tools={[["headings"] as ToolId[]]}
        groupId="headings"
        editor={asEditor(editor)}
      />
    );

    expect(isOpen("more-headings")).toBe(false);
    expect(isOpen("headings")).toBe(false);

    await click(view.container.querySelector("#tool-more"));

    // The "more" popup is namespaced and parentless; the real Headings leaf
    // popup is not opened by the id collision.
    expect(popupRecord("more-headings")).toMatchObject({
      group: "toolbarGroup"
    });
    expect(parentOf("more-headings")).toBeUndefined();
    expect(isOpen("headings")).toBe(false);
    expect(menuEl(view.container)).toBeNull();

    // The child opens only when asked, and records the namespaced parent.
    await click(dropdownTrigger(popupEl(view.container)!, strings.paragraph()));
    expect(popupRecord("headings")).toMatchObject({ parent: "more-headings" });
    expect(menuEl(view.container)).toBeTruthy();

    // The real heading command runs through the nested menu.
    await click(menuItem(view.container, "heading-1"));
    expect(editor.isActive("heading", { level: 1 })).toBe(true);
    expect(isOpen("headings")).toBe(false);
    expect(isOpen("more-headings")).toBe(true);

    // Closing the parent clears the whole chain.
    await click(view.container.querySelector("#tool-more"));
    expect(isOpen("more-headings")).toBe(false);
    expect(isOpen("headings")).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });
});
