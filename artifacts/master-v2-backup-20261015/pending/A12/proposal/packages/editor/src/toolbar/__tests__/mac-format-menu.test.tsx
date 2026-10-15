/* SPDX-License-Identifier: GPL-3.0-or-later */
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { BulletList } from "../../extensions/bullet-list/index.js";
import { OrderedList } from "../../extensions/ordered-list/index.js";
import CheckList from "../../extensions/check-list/index.js";
import CheckListItem from "../../extensions/check-list-item/index.js";
import TextStyle from "@tiptap/extension-text-style";
import FontFamily from "@tiptap/extension-font-family";
import { Link } from "../../extensions/link/index.js";
import Color from "@tiptap/extension-color";
import { Highlight } from "../../extensions/highlight/index.js";
import { ThemeProvider } from "@theme-ui/core";
import { Box } from "@theme-ui/components";
import { ThemeFactory } from "@notesnook/theme";
import { AdvancedFormattingSections } from "../tools/mac-format.js";
import { Toolbar } from "../toolbar.js";
import { ToolbarGroup } from "../components/toolbar-group.js";
import { showMacFormattingMenu } from "../tools/mac-format-menu.js";
import { PopupParentContext, useToolbarStore } from "../stores/toolbar-store.js";
import {
  dismissPopupForOwner,
  getPopupDismissToken
} from "../../components/popup-presenter/index.js";
import type { Editor } from "../../types.js";
void Toolbar;
const theme = { colors: {}, iconSizes: { medium: 18, small: 16, big: 24 } };
let popupTheme: React.ComponentProps<typeof ThemeProvider>["theme"] = theme;
vi.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_, key) => () => String(key) })
}));
vi.mock("@notesnook/theme", async (original) => ({
  ...(await original<any>()),
  EmotionThemeProvider: ({ children, ...props }: any) => (
    <ThemeProvider theme={popupTheme}><Box {...props}>{children}</Box></ThemeProvider>
  )
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let editor: TiptapEditor;
let owner: HTMLElement;
let tab: HTMLElement;
let custom: Root;
function setup(nextTheme = theme) {
  popupTheme = nextTheme;
  vi.stubGlobal("scrollBy", vi.fn());
  tab = document.createElement("section");
  tab.className = "active";
  owner = document.createElement("div");
  owner.className = "dialogContainer";
  const mount = document.createElement("div");
  const tools = document.createElement("div");
  tab.append(owner, mount, tools);
  document.body.append(tab);
  editor = new TiptapEditor({
    element: mount,
    extensions: [
      StarterKit.configure({ bulletList: false, orderedList: false }),
      BulletList, OrderedList, CheckList, CheckListItem.configure({ nested: true }),
      TextStyle, FontFamily, Color, Highlight, Link
    ],
    content: "<p>Alpha Bravo</p>"
  });
  editor.storage.createInternalLink = vi.fn();
  useToolbarStore.setState({
    macCatalyst: true,
    isMobile: true,
    toolbarLocation: "bottom",
    openedPopups: {}
  });
  custom = createRoot(tools);
  act(() =>
    custom.render(
      <ThemeProvider theme={nextTheme}>
        <ToolbarGroup
          editor={editor as Editor}
          groupId="custom"
          tools={["fontFamily", "highlight", "textColor"]}
        />
      </ThemeProvider>
    )
  );
  return tools;
}
const host = () =>
  owner.querySelector<HTMLElement>('[data-test-id="mac-advanced-formatting"]');
function open() {
  act(() => {
    expect(showMacFormattingMenu(editor as Editor)).toBe(true);
  });
}
afterEach(() => {
  act(() => {
    editor?.destroy();
    custom?.unmount();
  });
  document.body.innerHTML = "";
  useToolbarStore.setState({
    macCatalyst: false,
    isMobile: false,
    toolbarLocation: "top",
    openedPopups: {}
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  popupTheme = theme;
});
test("real host scopes actual color and font tools, preserves pinned custom palette and closes child before parent", () => {
  const tools = setup();
  act(() =>
    useToolbarStore
      .getState()
      .openPopup({ id: "highlight", group: "color", pinned: true })
  );
  const pinned = useToolbarStore.getState().openedPopups.highlight;
  act(() => editor.commands.setTextSelection({ from: 1, to: 6 }));
  open();
  const initialPalettes = document.querySelectorAll(
    ".ReactModal__Content"
  ).length;
  const palette = host()!.querySelector<HTMLButtonElement>(
    'button[aria-label="highlight color"]'
  )!;
  expect(palette.tabIndex).toBe(0);
  act(() => palette.click());
  const store = useToolbarStore.getState();
  const child = Object.values(store.openedPopups).find(
    (p) => p && p.id.endsWith(":highlight")
  );
  expect(child && child.parent).toMatch(/^mac-native-format-/);
  expect(store.openedPopups.highlight).toBe(pinned);
  const swatches = owner.querySelectorAll<HTMLButtonElement>(
    'button[title="#F7C88B"]'
  );
  expect(swatches.length).toBe(2);
  act(() => swatches[swatches.length - 1].click());
  expect(editor.getHTML()).toContain("background-color: #F7C88B");
  expect(
    child && useToolbarStore.getState().openedPopups[child.id]
  ).toBeTruthy();
  expect(host()).not.toBeNull();
  // The custom instance remains singly mounted/open; exactly one new palette.
  expect(document.querySelectorAll(".ReactModal__Content").length).toBe(
    initialPalettes + 1
  );
  expect(tools.querySelectorAll("#tool-highlight")).toHaveLength(1);
  const token = getPopupDismissToken(owner)!;
  act(() => {
    expect(dismissPopupForOwner(owner, token)).toBe(true);
  });
  expect(host()).not.toBeNull();
  expect(getPopupDismissToken(owner)).toBe(token);
  expect(
    child && useToolbarStore.getState().openedPopups[child.id]
  ).toBeUndefined();
  // Real font Dropdown is scoped too and does not open its custom sibling.
  const font = [...host()!.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.includes("Sans-serif")
  )!;
  act(() => font.click());
  expect(
    Object.values(useToolbarStore.getState().openedPopups).some(
      (p) => p && p.id.endsWith(":fontFamily")
    )
  ).toBe(true);
  expect(useToolbarStore.getState().openedPopups.fontFamily).toBeUndefined();
  act(() => {
    dismissPopupForOwner(owner, token);
    dismissPopupForOwner(owner, token);
  });
  expect(host()).toBeNull();
  expect(useToolbarStore.getState().openedPopups.highlight).toBe(pinned);
  expect(
    Object.values(useToolbarStore.getState().openedPopups).filter(Boolean)
  ).toEqual([pinned]);
});
test("actual formatting and undo keep the host open; visible Close removes its palette only", () => {
  setup();
  act(() => editor.commands.setTextSelection({ from: 1, to: 6 }));
  open();
  const strike = host()!.querySelector<HTMLButtonElement>(
    'button[id$="strikethrough"]'
  )!;
  act(() => strike.click());
  expect(editor.getHTML()).toContain("<s>Alpha</s>");
  expect(host()).not.toBeNull();
  act(() => editor.commands.undo());
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
  act(() =>
    host()!
      .querySelector<HTMLButtonElement>('button[aria-label="highlight color"]')!
      .click()
  );
  act(() =>
    host()!
      .querySelector<HTMLButtonElement>('button[aria-label="close"]')!
      .click()
  );
  expect(host()).toBeNull();
  expect(
    Object.values(useToolbarStore.getState().openedPopups).filter(Boolean)
  ).toHaveLength(0);
});
test.each(["readonly", "background", "destroy"])(
  "rejects stale actions and disposes the host on %s",
  async (reason) => {
    setup();
    open();
    const strike = host()!.querySelector<HTMLButtonElement>(
      'button[id$="strikethrough"]'
    )!;
    await act(async () => {
      if (reason === "readonly") editor.setEditable(false);
      else if (reason === "background") tab.classList.remove("active");
      else editor.destroy();
      strike.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
    expect(host()).toBeNull();
    expect(
      Object.values(useToolbarStore.getState().openedPopups).filter(Boolean)
    ).toHaveLength(0);
  }
);
test("requires a private current editable Mac owner and toggles one host", () => {
  setup();
  useToolbarStore.setState({ macCatalyst: false });
  expect(showMacFormattingMenu(editor as Editor)).toBe(false);
  useToolbarStore.setState({ macCatalyst: true });
  owner.remove();
  expect(showMacFormattingMenu(editor as Editor)).toBe(false);
  tab.append(owner);
  editor.setEditable(false);
  expect(showMacFormattingMenu(editor as Editor)).toBe(false);
  editor.setEditable(true);
  open();
  open();
  expect(host()).toBeNull();
});

test("external Link reuses the owned Mac dialog; Escape returns to formatting", () => {
  setup();
  open();
  const parentToken = getPopupDismissToken(owner)!;
  act(() =>
    host()!
      .querySelector<HTMLButtonElement>('button[aria-label="insertLink"]')!
      .click()
  );
  const childToken = getPopupDismissToken(owner)!;
  expect(childToken).not.toBe(parentToken);
  act(() => {
    expect(dismissPopupForOwner(owner, childToken)).toBe(true);
  });
  expect(getPopupDismissToken(owner)).toBe(parentToken);
  expect(host()).not.toBeNull();
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
});

test("destroying a format owner also removes its independently portaled link dialog", () => {
  setup();
  open();
  act(() =>
    host()!
      .querySelector<HTMLButtonElement>('button[aria-label="insertLink"]')!
      .click()
  );
  expect(owner.querySelectorAll(".ReactModal__Content").length).toBe(2);
  act(() => editor.destroy());
  expect(getPopupDismissToken(owner)).toBeUndefined();
  expect(owner.querySelectorAll(".ReactModal__Content")).toHaveLength(0);
});

test("logical note identity closes the host, while a stale portaled palette cannot format", () => {
  setup();
  act(() => editor.commands.setTextSelection({ from: 1, to: 6 }));
  let current = true;
  let changed: (() => void) | undefined;
  const unsubscribe = vi.fn();
  act(() => {
    expect(
      showMacFormattingMenu(editor as Editor, {
        isCurrent: () => current,
        subscribe: (callback) => {
          changed = callback;
          return unsubscribe;
        }
      })
    ).toBe(true);
  });
  act(() =>
    host()!
      .querySelector<HTMLButtonElement>('button[aria-label="highlight color"]')!
      .click()
  );
  const swatch = owner.querySelector<HTMLButtonElement>(
    'button[title="#F7C88B"]'
  )!;
  // No observer tick: this actual React portal must still cross host capture.
  current = false;
  act(() => swatch.click());
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
  expect(host()).toBeNull();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  current = true;
  act(() =>
    showMacFormattingMenu(editor as Editor, {
      isCurrent: () => current,
      subscribe: (callback) => {
        changed = callback;
        return unsubscribe;
      }
    })
  );
  current = false;
  act(() => changed!());
  expect(host()).toBeNull();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

function requireElement<T extends Element>(value: T | null | undefined): T {
  if (!value) throw new Error("Expected rendered formatting element");
  return value;
}

function appearanceTheme(mode: "light" | "dark") {
  const dark = mode === "dark";
  const scope = {
    primary: {
      background: dark ? "#18181b" : "#ffffff",
      border: dark ? "#36363a" : "#dddde3",
      heading: dark ? "#f2f2f4" : "#18181b",
      paragraph: dark ? "#f2f2f4" : "#18181b"
    },
    secondary: { paragraph: dark ? "#acacb4" : "#64646b" }
  } as unknown as Parameters<typeof ThemeFactory.construct>[0]["scope"];
  return ThemeFactory.construct({ colorScheme: mode, scope });
}

test.each(["light", "dark"] as const)(
  "Mac host resolves framed, bounded, readable presentation in %s",
  (mode) => {
    const currentTheme = appearanceTheme(mode);
    setup(currentTheme);
    open();
    const content = requireElement(host());
    const frame = requireElement(content.parentElement);
    const frameStyle = getComputedStyle(frame);
    expect(frameStyle.borderTopWidth).toBe("1px");
    expect(frameStyle.borderTopStyle).toBe("solid");
    expect(frameStyle.borderRadius).toBe("10px");
    expect(frameStyle.boxShadow).toBe(currentTheme.shadows.menu);
    expect(frameStyle.backgroundColor).toBe(currentTheme.colors.background);
    expect(parseFloat(frameStyle.maxHeight)).toBeCloseTo(window.innerHeight * 0.7);
    expect(frameStyle.overflowY).toBe("auto");
    expect(getComputedStyle(content).padding).toBe("10px");
    const label = requireElement([...content.querySelectorAll("span")].find((node) => node.textContent === "highlight · textColor"));
    expect(getComputedStyle(label).fontSize).toBe(currentTheme.fontSizes.body);
    expect(getComputedStyle(label).fontWeight).toBe(String(currentTheme.fontWeights.medium));
    const close = requireElement(content.querySelector<HTMLButtonElement>('button[aria-label="close"]'));
    expect(getComputedStyle(close).minHeight).toBe("28px");
    expect(content.querySelector('button[id$="strikethrough"]')).not.toBeNull();
    expect(content.querySelector('button[aria-label="insertLink"]')).not.toBeNull();
    expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
  }
);

test.each([false, true])(
  "shared advanced sections retain default/touch typography (touch=%s)",
  (touch) => {
    const currentTheme = appearanceTheme("light");
    const tools = setup(currentTheme);
    act(() => custom.render(
      <ThemeProvider theme={currentTheme}>
        <AdvancedFormattingSections editor={editor as Editor} groupId="default" touch={touch} />
      </ThemeProvider>
    ));
    const label = requireElement([...tools.querySelectorAll("span")].find((node) => node.textContent === "highlight · textColor"));
    expect(getComputedStyle(label).fontSize).toBe(currentTheme.fontSizes.subBody);
    const strike = requireElement(tools.querySelector<HTMLButtonElement>('button[id$="strikethrough"]'));
    expect(getComputedStyle(strike).minHeight).toBe(touch ? "44px" : "28px");
  }
);


function listButton(id: string, container: ParentNode = requireElement(host())) {
  return requireElement(container.querySelector<HTMLButtonElement>(`button[id$="${id}"]`));
}
function styleChoices() {
  return [...owner.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.querySelector("ul > li"));
}

test.each([
  ["bulletList", "bulletList", "square", 2, 3],
  ["numberedList", "orderedList", "upper-roman", 3, 6]
] as const)("Mac upper lists apply genuine %s style, preserve selection and owned child-first Escape", async (tool, node, style, index, count) => {
  setup();
  act(() => editor.commands.setTextSelection({ from: 1, to: 6 }));
  open();
  const token = getPopupDismissToken(owner);
  expect(token).toBeDefined();
  const trigger = listButton(`${tool}-palette`);
  const anchor = requireElement(trigger.parentElement);
  const anchorRect = vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(90, 140, 60, 28));
  const lower = document.createElement("div");
  lower.className = "editor-toolbar";
  tab.append(lower);
  const lowerRect = vi.spyOn(lower, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 700, 600, 40));
  act(() => trigger.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  const child = Object.values(useToolbarStore.getState().openedPopups).find((popup) => popup && popup.id.endsWith(`:${tool}`));
  expect(child && child.parent).toMatch(/^mac-native-format-/);
  expect(child && child.id).toMatch(/^mac-native-format-\d+:/);
  expect(anchorRect).toHaveBeenCalled();
  expect(lowerRect).not.toHaveBeenCalled();
  expect(styleChoices()).toHaveLength(count);
  act(() => requireElement(styleChoices()[index]).click());
  expect(editor.isActive(node, { listType: style })).toBe(true);
  expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("Alpha");
  expect(child && useToolbarStore.getState().openedPopups[child.id]).toBeUndefined();
  expect(host()).not.toBeNull();
  act(() => trigger.click());
  act(() => { expect(dismissPopupForOwner(owner, Number(token))).toBe(true); });
  expect(host()).not.toBeNull();
  expect(styleChoices()).toHaveLength(0);
  act(() => { expect(dismissPopupForOwner(owner, Number(token))).toBe(true); });
  expect(host()).toBeNull();
  vi.restoreAllMocks();
});

test.each(["bottom", "top"] as const)("Mac upper lists refresh active indent/outdent and run real transactions at %s", (toolbarLocation) => {
  setup();
  act(() => useToolbarStore.setState({ toolbarLocation }));
  open();
  expect(host()?.querySelector('button[id$="indent"]')).toBeNull();
  act(() => editor.commands.setContent("<p>First</p><p>Second</p>"));
  act(() => editor.commands.setTextSelection({ from: 1, to: 13 }));
  act(() => listButton("bulletList").click());
  expect(editor.isActive("bulletList")).toBe(true);
  act(() => editor.commands.setTextSelection(12));
  const flat = editor.getJSON();
  expect(editor.state.selection.$from.depth).toBe(3);
  act(() => listButton("indent").click());
  expect(editor.state.selection.$from.depth).toBe(5);
  expect(editor.getHTML()).toContain("<li><p>First</p><ul>");
  act(() => listButton("outdent").click());
  expect(editor.getJSON()).toEqual(flat);
  expect(editor.state.selection.$from.depth).toBe(3);
  expect(host()).not.toBeNull();
  act(() => editor.commands.undo());
  expect(host()).not.toBeNull();
});

test("Mac upper checklist uses the existing genuine checklist transaction", () => {
  setup();
  open();
  act(() => listButton("checklist").click());
  expect(editor.isActive("checkList")).toBe(true);
  expect(editor.getHTML()).toContain('class="simple-checklist"');
  expect(editor.state.doc.textContent).toBe("Alpha Bravo");
  act(() => listButton("checklist").click());
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
});

test.each([
  { mac: true, touch: false, presentation: undefined },
  { mac: true, touch: true, presentation: "mac" as const },
  { mac: false, touch: false, presentation: "mac" as const }
])("upper list presentation stays absent for default/touch/non-Mac $mac/$touch/$presentation", ({ mac, touch, presentation }) => {
  const tools = setup();
  act(() => useToolbarStore.setState({ macCatalyst: mac }));
  act(() => custom.render(<ThemeProvider theme={theme}>
    <AdvancedFormattingSections editor={editor as Editor} groupId="negative" touch={touch} presentation={presentation} />
  </ThemeProvider>));
  for (const id of ["checklist", "bulletList", "numberedList", "indent", "outdent"]) {
    expect(tools.querySelector(`button[id$="${id}"]`)).toBeNull();
  }
  expect(tools.querySelector('button[id$="strikethrough"]')).not.toBeNull();
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
});

test.each([false, true])("existing bottom list popup keeps root anchor or nested owned anchor (nested=%s)", async (nested) => {
  const tools = setup();
  act(() => useToolbarStore.setState({ macCatalyst: false }));
  tools.className = "editor-toolbar";
  if (nested) act(() => useToolbarStore.getState().openPopup({ id: "existing-more", group: "mobile" }));
  act(() => custom.render(<ThemeProvider theme={theme}>
    <PopupParentContext.Provider value={nested ? "existing-more" : undefined}>
      <ToolbarGroup editor={editor as Editor} groupId="existing" tools={["bulletList"]} />
    </PopupParentContext.Provider>
  </ThemeProvider>));
  const primary = listButton("bulletList", tools);
  const anchor = requireElement(primary.parentElement);
  const anchorRect = vi.spyOn(anchor, "getBoundingClientRect");
  const lowerRect = vi.spyOn(tools, "getBoundingClientRect");
  const trigger = requireElement(tools.querySelector<HTMLButtonElement>('button[id$="chevronUp"]'));
  act(() => trigger.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  const child = useToolbarStore.getState().openedPopups.bulletList;
  expect(child && child.parent).toBe(nested ? "existing-more" : undefined);
  expect(nested ? anchorRect : lowerRect).toHaveBeenCalled();
  expect(nested ? lowerRect : anchorRect).not.toHaveBeenCalled();
  act(() => requireElement(styleChoices()[1]).click());
  expect(editor.isActive("bulletList", { listType: "circle" })).toBe(true);
  expect(useToolbarStore.getState().openedPopups.bulletList).toBeUndefined();
  if (nested) expect(useToolbarStore.getState().openedPopups["existing-more"]).toBeTruthy();
  vi.restoreAllMocks();
});


test("stale owned Mac list palette cannot change another logical note", () => {
  setup();
  let current = true;
  act(() => { expect(showMacFormattingMenu(editor as Editor, { isCurrent: () => current, subscribe: () => () => {} })).toBe(true); });
  act(() => listButton("bulletList-palette").click());
  const square = requireElement(styleChoices()[2]);
  const before = editor.getJSON();
  current = false;
  act(() => square.click());
  expect(editor.getJSON()).toEqual(before);
  expect(host()).toBeNull();
  expect(Object.values(useToolbarStore.getState().openedPopups).filter(Boolean)).toHaveLength(0);
});
