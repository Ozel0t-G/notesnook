/* SPDX-License-Identifier: GPL-3.0-or-later */
import React, { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TableRow from "@tiptap/extension-table-row";
import { Table } from "../../extensions/table/index.js";
import TableCell from "../../extensions/table-cell/index.js";
import TableHeader from "../../extensions/table-header/index.js";
import { ThemeProvider } from "@theme-ui/core";
import { Toolbar } from "../toolbar.js";
import { showMacInsertMenu } from "../tools/block.js";
import { useToolbarStore } from "../stores/toolbar-store.js";
import {
  dismissPopupForOwner,
  getPopupDismissToken
} from "../../components/popup-presenter/index.js";
import type { Editor } from "../../types.js";

void Toolbar;
const presenterTestTheme = {
  colors: {},
  iconSizes: { medium: 18, small: 16, big: 24 }
};
vi.mock("@notesnook/intl", () => ({
  strings: new Proxy(
    {},
    {
      get:
        (_, key) =>
        (...args: unknown[]) =>
          `${String(key)}${args.length ? ` ${args.join("×")}` : ""}`
    }
  )
}));
vi.mock("@notesnook/theme", async (original) => ({
  ...(await original<any>()),
  EmotionThemeProvider: ({ children }: any) => (
    <ThemeProvider theme={presenterTestTheme}>{children}</ThemeProvider>
  )
}));
// Actual ResponsivePresenter, Menu, PopupPresenter, ReactModal, TablePopup and
// scrollbar-choice DOM run together. Theme colors and layout are not a pixel QA.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let editor: TiptapEditor;
let owner: HTMLElement;
const originalOffsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent"
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalOffsetParent)
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetParent",
      originalOffsetParent
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
  act(() => {
    const token = owner && getPopupDismissToken(owner);
    if (token !== undefined) dismissPopupForOwner(owner, token);
    editor?.destroy();
  });
  document.body.innerHTML = "";
  useToolbarStore.setState({ macCatalyst: false, isMobile: false });
});
test("real Mac presenter uses native scrolling and hands focus into the real table size fields", async () => {
  // happy-dom has no viewport scroll API; document mutations remain real.
  vi.stubGlobal("scrollBy", vi.fn());
  const tab = document.createElement("section");
  tab.className = "active";
  owner = document.createElement("div");
  owner.className = "dialogContainer";
  const mount = document.createElement("div");
  tab.append(owner, mount);
  document.body.append(tab);
  editor = new TiptapEditor({
    element: mount,
    extensions: [StarterKit, Table, TableRow, TableCell, TableHeader],
    content: "<p>Alpha Bravo</p>"
  });
  editor.storage.createInternalLink = vi.fn();
  editor.storage.handwritingEnabled = true;
  editor.storage.templatesEnabled = true;
  useToolbarStore.setState({ macCatalyst: true, isMobile: true });
  act(() => {
    expect(showMacInsertMenu(editor as Editor)).toBe(true);
  });
  const scroll = owner.querySelector<HTMLElement>(
    '[data-test-id="menu-scroll-container"]'
  );
  expect(scroll).not.toBeNull();
  expect(scroll?.style.overflowY).toBe("auto");
  expect(scroll?.querySelectorAll('[role="menuitem"]').length).toBe(15);
  // The actual narrow Mac failure: 220-wide root at x170, 340-wide Table
  // submenu, 561-wide editor pane. Its flyout must flip/clamp inside the pane.
  let viewportWidth = 561;
  vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(
    () => viewportWidth
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.querySelector("button[data-index]") ? 340 : 220;
    }
  );
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get: () => owner.querySelector(".ReactModal__Content")
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(170, 200, 220, 24)
  );
  // Reproduce a WebKit mount that ignores the initial autoFocus; the real
  // presenter must recover on the owned frame, rather than passing by chance.
  const focus = HTMLElement.prototype.focus;
  let ignoredInitialInputFocus = false;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions
  ) {
    if (
      this.matches('input[aria-label="tableColumns"]') &&
      !ignoredInitialInputFocus
    ) {
      ignoredInitialInputFocus = true;
      return;
    }
    focus.call(this, options);
  });
  act(() =>
    owner
      .querySelector<HTMLButtonElement>('[data-test-id="menu-button-table"]')!
      .click()
  );
  expect(ignoredInitialInputFocus).toBe(true);
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
  });
  const cells = [
    ...owner.querySelectorAll<HTMLButtonElement>("button[data-index]")
  ];
  expect(cells).toHaveLength(60);
  const submenu = [
    ...owner.querySelectorAll<HTMLElement>('[data-test-id="menu-container"]')
  ].find((node) => node.style.visibility === "visible")!;
  const viewportLeft = parseFloat(submenu.style.left) + 170;
  expect(
    submenu.querySelector('[data-test-id="menu-scroll-container"]')
  ).not.toBeNull();
  expect(viewportLeft).toBeGreaterThanOrEqual(0);
  expect(viewportLeft + 340).toBeLessThanOrEqual(561);
  viewportWidth = 900;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(parseFloat(submenu.style.left) + 170).toBe(390);
  viewportWidth = 480;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(parseFloat(submenu.style.left) + 170).toBe(0);
  const columns = owner.querySelector<HTMLInputElement>(
    'input[aria-label="tableColumns"]'
  )!;
  expect(document.activeElement).toBe(columns);
  // The actual ReactModal portal must not reset an interior legacy Tab move.
  const rowsForFocus = owner.querySelector<HTMLInputElement>(
    'input[aria-label="tableRows"]'
  )!;
  for (const delivery of [
    { key: "LegacyTab", code: "Tab" },
    { key: "LegacyTab", keyCode: 9 }
  ]) {
    act(() => columns.focus());
    const tab = new KeyboardEvent("keydown", {
      ...delivery,
      bubbles: true,
      cancelable: true
    });
    if ("keyCode" in delivery)
      Object.defineProperty(tab, "keyCode", { value: 9 });
    act(() => columns.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rowsForFocus);
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });
    expect(document.activeElement).toBe(rowsForFocus);
    expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
  }
  act(() => columns.focus());
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(columns, "0");
    columns.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const token = getPopupDismissToken(owner);
  act(() =>
    columns.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true
      })
    )
  );
  expect(getPopupDismissToken(owner)).toBe(token);
  expect(document.activeElement).toBe(columns);
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");

  // A valid keyboard submission must traverse the real presenter and command,
  // produce one table, dismiss the popup, and remain a single undoable change.
  const rows = owner.querySelector<HTMLInputElement>(
    'input[aria-label="tableRows"]'
  )!;
  for (const [input, value] of [
    [columns, "3"],
    [rows, "2"]
  ] as const) {
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true
  });
  act(() => rows.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(true);
  const tables = editor
    .getJSON()
    .content!.filter((node) => node.type === "table");
  expect(tables).toHaveLength(1);
  expect(tables[0].content).toHaveLength(2);
  expect(tables[0].content!.every((row) => row.content?.length === 3)).toBe(
    true
  );
  expect(owner.querySelector('input[aria-label="tableColumns"]')).toBeNull();
  expect(editor.getText()).toContain("Alpha Bravo");
  act(() => {
    expect(editor.commands.undo()).toBe(true);
  });
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
});
