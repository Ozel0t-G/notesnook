/* SPDX-License-Identifier: GPL-3.0-or-later */
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { Toolbar } from "../toolbar.js";
import { TablePopup } from "../popups/table-popup.js";
import { useToolbarStore } from "../stores/toolbar-store.js";

void Toolbar;
vi.mock("@notesnook/intl", () => ({
  strings: {
    setTableSizeNotice: () => "Choose size",
    tableColumns: () => "Columns",
    tableRows: () => "Rows",
    insertTableOfSize: (rows: number, columns: number) =>
      `Insert ${rows} × ${columns}`
  }
}));
// Geometry/chrome only: actual table grid, state, focus and callbacks are real.
vi.mock("../components/popup.js", () => ({
  Popup: ({ children, action }: any) => (
    <section>
      {children}
      <button disabled={action.disabled} onClick={action.onClick}>
        {action.title}
      </button>
    </section>
  )
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  useToolbarStore.setState({ macCatalyst: false, isMobile: false });
});
function render(mac: boolean) {
  useToolbarStore.setState({ macCatalyst: mac, isMobile: true });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const insert = vi.fn();
  act(() => root.render(<TablePopup onInsertTable={insert} />));
  return { host, insert };
}
test("Mac grid keeps named pointer actions while keyboard starts in the size fields", () => {
  const { host, insert } = render(true);
  const cells = [
    ...host.querySelectorAll<HTMLButtonElement>("button[data-index]")
  ];
  expect(cells).toHaveLength(60);
  expect(document.activeElement).toBe(
    host.querySelector('input[aria-label="Columns"]')
  );
  expect(cells[0].type).toBe("button");
  expect(cells[11].getAttribute("aria-label")).toBe("Insert 2 × 2");
  expect(cells.every((cell) => cell.tabIndex === -1)).toBe(true);
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  act(() => cells[11].dispatchEvent(down));
  expect(down.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(
    host.querySelector('input[aria-label="Columns"]')
  );
  act(() => cells[11].click());
  expect(insert).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledWith({ rows: 2, columns: 2 });
});
test("Mac accessible click uses its own dimensions without requiring prior hover", () => {
  const { host, insert } = render(true);
  act(() =>
    host.querySelector<HTMLButtonElement>('[data-index="23"]')!.click()
  );
  expect(insert).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledWith({ rows: 3, columns: 4 });
});
test("iOS keeps its original touch grid rather than sixty new focus stops", () => {
  const { host, insert } = render(false);
  expect(host.querySelector("button[data-index]")).toBeNull();
  const cell = host.querySelector<HTMLElement>('[data-index="11"]')!;
  act(() => cell.dispatchEvent(new Event("touchstart", { bubbles: true })));
  const end = new Event("touchend", { bubbles: true, cancelable: true });
  act(() => cell.dispatchEvent(end));
  expect(end.defaultPrevented).toBe(true);
  const action = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Insert 2 × 2"
  )!;
  expect(action.disabled).toBe(false);
  act(() => action.click());
  expect(insert).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledWith({ rows: 2, columns: 2 });
});

function changeNumber(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
test("Mac size fields provide named keyboard entry and Enter inserts only valid dimensions", () => {
  const { host, insert } = render(true);
  const columns = host.querySelector<HTMLInputElement>(
    'input[aria-label="Columns"]'
  )!;
  const rows = host.querySelector<HTMLInputElement>(
    'input[aria-label="Rows"]'
  )!;
  expect(columns).not.toBeNull();
  expect(rows).not.toBeNull();
  expect(document.activeElement).toBe(columns);
  const outerMenu = vi.fn();
  window.addEventListener("keydown", outerMenu);
  try {
    changeNumber(columns, "3");
    changeNumber(rows, "2");
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true
    });
    act(() => rows.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({ columns: 3, rows: 2 });
    expect(outerMenu).not.toHaveBeenCalled();
    insert.mockClear();
    for (const invalid of ["", "0", "-1", "1.5", "21", "999"]) {
      changeNumber(columns, invalid);
      act(() =>
        columns.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true
          })
        )
      );
      expect(insert).not.toHaveBeenCalled();
    }
  } finally {
    window.removeEventListener("keydown", outerMenu);
  }
});
test("Catalyst pointer emulation does not cancel the grid click; iOS retains touch handling", () => {
  const { host } = render(true);
  const end = new Event("touchend", { bubbles: true, cancelable: true });
  act(() => host.querySelector('[data-index="11"]')!.dispatchEvent(end));
  expect(end.defaultPrevented).toBe(false);
});

test("Mac Tab transfers between size fields without swallowing boundary Tab or Escape", () => {
  const { host, insert } = render(true);
  const columns = host.querySelector<HTMLInputElement>(
    'input[aria-label="Columns"]'
  )!;
  const rows = host.querySelector<HTMLInputElement>(
    'input[aria-label="Rows"]'
  )!;
  const key = (target: HTMLInputElement, name: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", {
      key: name,
      shiftKey,
      bubbles: true,
      cancelable: true
    });
    act(() => target.dispatchEvent(event));
    return event;
  };
  expect(document.activeElement).toBe(columns);
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      [modifier]: true,
      bubbles: true,
      cancelable: true
    });
    act(() => columns.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(columns);
  }
  expect(key(columns, "Tab").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(rows);
  expect(key(rows, "Tab", true).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(columns);
  expect(key(columns, "Tab", true).defaultPrevented).toBe(false);
  act(() => rows.focus());
  expect(key(rows, "Tab").defaultPrevented).toBe(false);
  const outerMenu = vi.fn();
  window.addEventListener("keydown", outerMenu);
  try {
    expect(key(rows, "Escape").defaultPrevented).toBe(false);
    expect(outerMenu).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", outerMenu);
  }
});

test.each([
  { key: "LegacyTab", code: "Tab" },
  { key: "LegacyTab", keyCode: 9 }
])(
  "Mac legacy Tab delivery preserves interior, modifier and boundary routing: %j",
  (delivery) => {
    const { host, insert } = render(true);
    const columns = host.querySelector<HTMLInputElement>(
      'input[aria-label="Columns"]'
    )!;
    const rows = host.querySelector<HTMLInputElement>(
      'input[aria-label="Rows"]'
    )!;
    const key = (target: HTMLInputElement, extra: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        ...delivery,
        ...extra,
        bubbles: true,
        cancelable: true
      });
      if ("keyCode" in delivery)
        Object.defineProperty(event, "keyCode", { value: 9 });
      // A non-normalized key prevents React from deriving key=Tab from keyCode.
      expect(event.key).toBe("LegacyTab");
      act(() => target.dispatchEvent(event));
      return event;
    };
    for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
      expect(key(columns, { [modifier]: true }).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(columns);
    }
    expect(key(columns).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows);
    expect(key(rows, { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(columns);
    expect(key(columns, { shiftKey: true }).defaultPrevented).toBe(false);
    act(() => rows.focus());
    expect(key(rows).defaultPrevented).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  }
);
