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
 * Runtime coverage for `ColorTool` (`Highlight`) and `ListTool` (`BulletList`,
 * `NumberedList`) resolving their popup's `parent` the same way `MoreTools`
 * already does: prefer the real enclosing popup from `PopupParentContext`,
 * and only fall back to the `parentGroup` prop (the enclosing `ToolbarGroup`'s
 * joined-tool id, not a popup id) when it names a *currently open* popup
 * other than the tool's own id. Against the pre-patch source, which fed
 * `parentGroup` straight into `usePopupManager({ parent: parentGroup })`, a
 * singleton group (`parentGroup === own id`) records the popup as its own
 * parent, so `parentOf("highlight")` resolves to `"highlight"` itself. These
 * tests fail against that source on the plain
 * `expect(parentOf("highlight")).toBeUndefined()` assertion right after the
 * popup is opened - a normal, synchronous mismatch - well before any
 * pin/unpin/close call runs. Separately, source inspection shows `close()`
 * and `togglePinned()` both walk `parent` pointers with no cycle guard
 * (`toggleChildState` in `toolbar-store.ts`), so a self-record would also
 * recurse without a base case if those calls were ever reached with it in
 * place; that historical hazard is not what these tests exercise, since the
 * earlier assertion already fails first, and the pin/unpin/close assertions
 * below it only run once the parent-is-undefined precondition holds (i.e.
 * against the fixed source).
 *
 * Real (not mocked): `ColorTool`/`Highlight`, `ListTool`/`BulletList`/
 * `NumberedList`, `MoreTools`, the real `Popup` chrome
 * (`toolbar/components/popup.tsx`), the real `PopupWrapper`
 * (`components/popup-presenter/index.tsx`), the real `DesktopOnly`/
 * `MobileOnly` responsive seam (`components/responsive/index.tsx`), the real
 * toolbar store (`toolbar-store.ts`, including the ancestry/pin/close
 * protocol under test), and a real `@tiptap/starter-kit` editor - the
 * assertions that depend on editor commands (`toggleBulletList`/
 * `toggleOrderedList` + `updateAttributes`) exercise the genuine chain built
 * into `lists.tsx`. `Highlight`'s own color-apply path (`setHighlight`/
 * `unsetHighlight`) is a custom mark command defined outside the files this
 * patch may touch, so these tests only ever open/close/pin it and never
 * click its primary apply-color button.
 *
 * Bounded, explicitly-mocked seams (same seams as `overflow-nested-popup.test.tsx`):
 * - `@notesnook/ui`'s `PopupPresenter`/`MenuPresenter` are replaced with thin
 *   stand-ins that still forward the real `isOpen` flag and real children, so
 *   the genuine `PopupWrapper` → presenter wiring is exercised end to end
 *   without needing a layout engine (happy-dom has none). `@notesnook/ui`'s
 *   `Icon` export is left real, since the root popup's pin button is located
 *   by its real rendered SVG path (see below).
 * - `@notesnook/intl` is replaced with a key-derived-label `Proxy`, matching
 *   the existing compile-time-macro seam used by the other toolbar tests.
 *
 * Geometry seam this file leans on but does not re-verify: `ToolButton` is
 * assumed to render `id={\`tool-${icon}\`}` for its icon buttons - the same
 * convention `overflow-nested-popup.test.tsx` already relies on for
 * `#tool-more`/`#tool-pin` (both genuine `ToolButton`s, e.g. `MoreTools`'
 * own pin control, which lives outside any nested popup header). The root
 * `Highlight`/`ListTool` popup chrome, by contrast, is the shared `Popup`
 * component (`toolbar/components/popup.tsx`): its pin control is a plain
 * ThemeUI `Button` rendering `Icon path={Icons.pin}` inside the popup's
 * `className="movable"` header - not a `ToolButton`, and with no `id` at
 * all - so this file locates it by that real header DOM plus the real
 * exported `Icons.pin` path value, rather than by a fabricated id or by
 * assuming it is a `ToolButton`. That header (and its pin button) is itself
 * gated by the real `DesktopOnly`/`MobileOnly` responsive seam, which reads
 * `isMobile` from the real toolbar store; `beforeEach` below sets
 * `isMobile: false`, so that seam is genuinely exercised rather than mocked
 * or bypassed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, type ThemeUIStyleObject } from "@theme-ui/core";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import { Editor as TiptapEditor } from "@tiptap/core";
import { Highlight } from "../tools/colors.js";
import { BulletList, NumberedList } from "../tools/lists.js";
import { MoreTools } from "../components/more-tools.js";
import { Icons } from "../icons.js";
import {
  PopupParentContext,
  useToolbarStore
} from "../stores/toolbar-store.js";
import type { ToolId } from "../tools/index.js";
import type { Theme } from "@notesnook/theme";
import type { Editor } from "../../types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@notesnook/intl", () => {
  const labels: Record<string, string> = {
    more: "More",
    backgroundColor: "Highlight",
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
      const { isOpen, children, sx, className, scope, onClose } = props;
      if (!isOpen) return null;
      return (
        <Box
          sx={sx}
          className={className}
          data-test-id="popup-presenter"
          data-scope={scope ?? ""}
          data-open={String(!!isOpen)}
        >
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

type PopupRecord = {
  id: string;
  group: string;
  parent?: string;
  pinned?: boolean;
};

function popupRecord(id: string) {
  return useToolbarStore.getState().openedPopups[id] as
    | PopupRecord
    | false
    | undefined;
}

function isOpen(id: string) {
  return typeof popupRecord(id) === "object";
}

function parentOf(id: string) {
  const ref = popupRecord(id);
  return typeof ref === "object" ? ref.parent : undefined;
}

function leakedPopups() {
  return Object.entries(useToolbarStore.getState().openedPopups)
    .filter(([, ref]) => !!ref)
    .map(([id]) => id);
}

function popupEl(container: ParentNode) {
  return container.querySelector('[data-test-id="popup-presenter"]');
}

/** The chevron half of a `SplitButton` - the real popup open/close trigger. */
function chevron(container: ParentNode) {
  return (
    container.querySelector("#tool-chevronDown") ??
    container.querySelector("#tool-chevronUp")
  );
}

/**
 * `MoreTools` renders its own pin control as a genuine `ToolButton`
 * (`icon="pin"`), which - per the shared `overflow-nested-popup.test.tsx`
 * convention - gets `id="tool-pin"`. This selector only applies to that
 * `MoreTools` pin control, not to the root `Popup` chrome's pin button
 * (see `rootPinButton` below), which is a different component with no id.
 */
function pinButton(container: ParentNode) {
  return container.querySelector("#tool-pin");
}

/**
 * The root popup chrome's pin button, as actually rendered by the real
 * `Popup` component (`toolbar/components/popup.tsx`): a plain ThemeUI
 * `Button` inside the popup's `className="movable"` header, identified by
 * its real rendered `Icon path={Icons.pin}` SVG `<path d="...">`. This is
 * deliberately not `#tool-pin`, since that component is not a `ToolButton`
 * and renders no id.
 */
function rootPinButton(popup: Element) {
  const header = popup.querySelector(".movable");
  if (!header) return null;
  return (
    Array.from(header.querySelectorAll("button")).find((button) =>
      Array.from(button.querySelectorAll("path")).some(
        (path) => path.getAttribute("d") === Icons.pin
      )
    ) ?? null
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

describe("ColorTool / ListTool popup parent resolution", () => {
  test("a phantom self-referencing parentGroup is ignored for ColorTool; pin toggles terminate", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Highlight
        editor={asEditor(editor)}
        icon="highlight"
        title="Highlight"
        parentGroup="highlight"
      />
    );

    await click(chevron(view.container));
    expect(isOpen("highlight")).toBe(true);
    // The phantom `parentGroup` (equal to this popup's own id) must be
    // ignored; this is the assertion that recurses forever on the old source.
    expect(parentOf("highlight")).toBeUndefined();

    const popup = popupEl(view.container)!;
    await click(rootPinButton(popup));
    expect(popupRecord("highlight")).toMatchObject({ pinned: true });
    await click(rootPinButton(popup));
    expect(popupRecord("highlight")).toMatchObject({ pinned: false });

    await click(chevron(view.container));
    expect(isOpen("highlight")).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });

  test("a phantom self-referencing parentGroup is ignored for ListTool; open/close terminates and the real bulletList command still runs", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <BulletList
        editor={asEditor(editor)}
        icon="more"
        title="Bullet list"
        parentGroup="Bullet list"
      />
    );

    await click(chevron(view.container));
    expect(isOpen("Bullet list")).toBe(true);
    expect(parentOf("Bullet list")).toBeUndefined();

    const popup = popupEl(view.container)!;
    const discButton = Array.from(popup.querySelectorAll("button")).find((b) =>
      b.querySelector('li[style*="list-item"]') || b.querySelector("li")
    );
    await click(discButton);
    expect(editor.isActive("bulletList")).toBe(true);
    // `close()` also walks `toggleChildState` from this id - a self-parent
    // record would recurse here too, even though lists have no pin button.
    expect(isOpen("Bullet list")).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });

  test("a phantom self-referencing parentGroup is ignored for NumberedList too; open/close terminates and the real orderedList command still runs", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <NumberedList
        editor={asEditor(editor)}
        icon="more"
        title="Numbered list"
        parentGroup="Numbered list"
      />
    );

    await click(chevron(view.container));
    expect(isOpen("Numbered list")).toBe(true);
    expect(parentOf("Numbered list")).toBeUndefined();

    const popup = popupEl(view.container)!;
    const decimalButton = Array.from(popup.querySelectorAll("button")).find(
      (b) => b.querySelector("li")
    );
    await click(decimalButton);
    expect(editor.isActive("orderedList")).toBe(true);
    expect(isOpen("Numbered list")).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });

  test("a parentGroup naming an unrelated, currently-open popup is accepted as a valid fallback and cascades on close", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const highlightView = renderView(
      <Highlight
        editor={asEditor(editor)}
        icon="highlight"
        title="Highlight"
      />
    );
    await click(chevron(highlightView.container));
    expect(isOpen("highlight")).toBe(true);

    const listView = renderView(
      <BulletList
        editor={asEditor(editor)}
        icon="more"
        title="Bullet list"
        parentGroup="highlight"
      />
    );
    await click(chevron(listView.container));
    expect(isOpen("Bullet list")).toBe(true);
    expect(parentOf("Bullet list")).toBe("highlight");

    // Closing the fallback-adopted parent cascades to the child, exactly like
    // a real `PopupParentContext` ancestor would.
    await click(chevron(highlightView.container));
    expect(isOpen("highlight")).toBe(false);
    expect(isOpen("Bullet list")).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });

  test("a parentGroup naming nothing currently open is ignored; the popup records no parent", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <Highlight
        editor={asEditor(editor)}
        icon="highlight"
        title="Highlight"
        parentGroup="does-not-exist"
      />
    );

    await click(chevron(view.container));
    expect(isOpen("highlight")).toBe(true);
    expect(parentOf("highlight")).toBeUndefined();
  });

  test("PopupParentContext takes precedence over a conflicting-but-valid parentGroup fallback", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const anchorView = renderView(
      <Highlight
        editor={asEditor(editor)}
        icon="highlight"
        title="Highlight"
      />
    );
    await click(chevron(anchorView.container));
    expect(isOpen("highlight")).toBe(true);

    // Two `ColorTool`s are mounted simultaneously here, and `ColorTool`
    // already keys its popup id off `props.icon` - so the child needs a
    // second *real* `IconNames` value distinct from the anchor's "highlight".
    // `textColor` is used purely as that distinct id; this test never
    // exercises `TextColor`'s own text-color-apply behavior, only its (shared
    // `ColorTool`) parent-resolution logic.
    const contextView = renderView(
      <PopupParentContext.Provider value="context-parent">
        <Highlight
          editor={asEditor(editor)}
          icon="textColor"
          title="Highlight"
          parentGroup="highlight"
        />
      </PopupParentContext.Provider>
    );
    await click(chevron(contextView.container));
    expect(isOpen("textColor")).toBe(true);
    expect(parentOf("textColor")).toBe("context-parent");
  });

  test("a real Highlight nested inside MoreTools keeps More open, cascades close, and inherits the pin", async () => {
    // Assumes `"highlight"` is the registered `ToolId` for the `Highlight`
    // component (the same convention `overflow-nested-popup.test.tsx` relies
    // on for `"headings"`/`"macFormat"`/`"bold"`); `findTool`/`getToolDefinition`
    // are not exported for direct inspection here.
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="more-color"
        tools={["highlight"] as ToolId[]}
        icon="more"
        title="More"
      />
    );

    await click(view.container.querySelector("#tool-more"));
    expect(isOpen("more-color")).toBe(true);
    const morePopup = popupEl(view.container)!;

    await click(chevron(morePopup));
    expect(isOpen("highlight")).toBe(true);
    expect(parentOf("highlight")).toBe("more-color");
    // opening the nested color popup must not have closed its own parent
    expect(isOpen("more-color")).toBe(true);

    // `MoreTools`' own pin control is a genuine `ToolButton` (`icon="pin"`),
    // so `#tool-pin` is the correct selector here - unlike the root `Popup`
    // chrome's pin button used above.
    await click(pinButton(morePopup));
    expect(popupRecord("more-color")).toMatchObject({ pinned: true });
    // pinning the ancestor cascades the pin down to the already-open child
    expect(popupRecord("highlight")).toMatchObject({ pinned: true });

    await click(view.container.querySelector("#tool-more"));
    expect(isOpen("more-color")).toBe(false);
    expect(isOpen("highlight")).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });

  test("a real BulletList nested inside MoreTools has no pin button but its ancestry still cascades on close", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const view = renderView(
      <MoreTools
        editor={asEditor(editor)}
        popupId="more-list"
        tools={["bulletList"] as ToolId[]}
        icon="more"
        title="More"
      />
    );

    await click(view.container.querySelector("#tool-more"));
    const morePopup = popupEl(view.container)!;
    await click(chevron(morePopup));

    // The real tool definition's title is the popup id; this suite does not
    // assume its exact translated string, so it is looked up from the store.
    const nestedId = Object.keys(useToolbarStore.getState().openedPopups).find(
      (id) => parentOf(id) === "more-list"
    );
    expect(nestedId).toBeTruthy();
    expect(isOpen("more-list")).toBe(true);

    await click(view.container.querySelector("#tool-more"));
    expect(isOpen("more-list")).toBe(false);
    expect(isOpen(nestedId as string)).toBe(false);
    expect(leakedPopups()).toEqual([]);
  });
});
