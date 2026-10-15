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
 * The editor status bar's character-count selection listener.
 *
 * Pressing the status line toggles a live character count that follows the
 * editor's `selectionUpdate` event. The status bar owns exactly one such
 * listener at a time: it must register it while the count is shown, take it
 * back with the same handler identity when the count is hidden, the tab
 * changes or the component unmounts, and never touch a listener it did not
 * register.
 *
 * Everything peripheral is mocked inside this file (the intl strings and the
 * editor package's word helper). The tab is supplied through the production
 * `TabContext` and the editor through the real `globalThis.editors` seam, so
 * the component under test is the production `StatusBar`, exercised through a
 * real DOM with `react-dom` (React 18, the version this package ships).
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach
} from "@jest/globals";
import React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

jest.mock("@notesnook/editor", () => ({
  // A fixed non-zero total keeps the preserved word path observable.
  getTotalWords: () => 3,
  Editor: class {}
}));

jest.mock("@notesnook/intl", () => ({
  strings: {
    totalWords: (n: number) => `${n} words`,
    charactersCount: (n: number) => `${n} chars`
  }
}));

import StatusBar from "./statusbar";
import { TabContext } from "../hooks/useTabStore";
import type { TabItem } from "../hooks/useTabStore";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (event: unknown) => void;

/** The statusBar ref shape the callers (`commands.ts`, controllers) rely on. */
type StatusBarRef = {
  current: {
    set: (value: unknown) => void;
    updateWords: () => void;
    resetWords: () => void;
  };
};

const globalStore = () =>
  globalThis as unknown as {
    editors: Record<string, unknown>;
    statusBars: Record<string, StatusBarRef | undefined>;
  };

/**
 * A minimal stand-in for the tiptap editor's event emitter plus the
 * `extensionStorage.characterCount.characters()` reading the status bar uses.
 * `on`/`off` record the exact handler references and key the live listener set
 * by identity, exactly as the real emitter does.
 */
class FakeEditor {
  readonly onCalls: { event: string; handler: Handler }[] = [];
  readonly offCalls: { event: string; handler: Handler }[] = [];
  private readonly listeners = new Map<string, Set<Handler>>();
  private chars: number;

  constructor(chars: number) {
    this.chars = chars;
  }

  extensionStorage = {
    characterCount: {
      characters: () => this.chars
    }
  };

  on(event: string, handler: Handler) {
    this.onCalls.push({ event, handler });
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
  }

  off(event: string, handler: Handler) {
    this.offCalls.push({ event, handler });
    this.listeners.get(event)?.delete(handler);
  }

  emit(event: string) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler({ editor: this });
    }
  }

  active(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }

  setChars(chars: number) {
    this.chars = chars;
  }
}

const tabOne: TabItem = { id: "tab-1" };
const tabTwo: TabItem = { id: "tab-2" };

describe("editor status bar character count", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  const containerRef = React.createRef<HTMLDivElement>();

  const render = (tab: TabItem, loading: boolean) => {
    act(() => {
      root.render(
        <TabContext.Provider value={tab}>
          <StatusBar container={containerRef} loading={loading} />
        </TabContext.Provider>
      );
    });
  };

  const statusLine = () => container.querySelector("p")!;

  /** The production activation: the status line toggles on `mousedown`. */
  const toggle = () => {
    act(() => {
      statusLine().dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
    });
  };

  beforeEach(() => {
    globalStore().editors = {};
    globalStore().statusBars = {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    container.remove();
  });

  it("shows the word count until toggled, then one listener and the character count", () => {
    const editor = new FakeEditor(5);
    globalStore().editors = { [tabOne.id]: editor };

    render(tabOne, false);
    expect(container.textContent).toBe("0 words");
    expect(editor.onCalls).toEqual([]);

    toggle();

    expect(container.textContent).toBe("5 chars");
    expect(editor.onCalls).toHaveLength(1);
    expect(editor.onCalls[0].event).toBe("selectionUpdate");
    expect(editor.active("selectionUpdate")).toBe(1);
  });

  it("unsubscribes with the exact registered handler identity when toggled off", () => {
    const editor = new FakeEditor(2);
    globalStore().editors = { [tabOne.id]: editor };

    render(tabOne, false);
    toggle();

    const registered = editor.onCalls[0].handler;
    expect(editor.active("selectionUpdate")).toBe(1);

    toggle();

    expect(editor.offCalls).toHaveLength(1);
    expect(editor.offCalls[0].event).toBe("selectionUpdate");
    expect(editor.offCalls[0].handler).toBe(registered);
    expect(editor.active("selectionUpdate")).toBe(0);
    expect(container.textContent).toBe("0 words");
  });

  it("balances on/off across repeated toggles without accumulating listeners", () => {
    const editor = new FakeEditor(0);
    globalStore().editors = { [tabOne.id]: editor };

    render(tabOne, false);

    for (let i = 1; i <= 3; i++) {
      toggle();
      // Each toggle-on leaves exactly one live listener: an emit updates the
      // line once, not once per historical toggle.
      expect(editor.active("selectionUpdate")).toBe(1);
      editor.setChars(i);
      act(() => editor.emit("selectionUpdate"));
      expect(container.textContent).toBe(`${i} chars`);

      toggle();
      expect(editor.active("selectionUpdate")).toBe(0);
    }

    expect(editor.onCalls).toHaveLength(3);
    expect(editor.offCalls).toHaveLength(3);
  });

  it("removes the listener and clears the global ref on unmount", () => {
    const editor = new FakeEditor(4);
    globalStore().editors = { [tabOne.id]: editor };

    render(tabOne, false);
    toggle();
    const registered = editor.onCalls[0].handler;

    act(() => root.unmount());
    mounted = false;

    expect(editor.offCalls.map((call) => call.handler)).toContain(registered);
    expect(editor.active("selectionUpdate")).toBe(0);
    expect(globalStore().statusBars[tabOne.id]).toBeUndefined();
  });

  it("moves the subscription to the new editor on a tab change", () => {
    const oldEditor = new FakeEditor(6);
    globalStore().editors = { [tabOne.id]: oldEditor };

    render(tabOne, false);
    toggle();
    const registered = oldEditor.onCalls[0].handler;

    const newEditor = new FakeEditor(7);
    globalStore().editors = { [tabOne.id]: oldEditor, [tabTwo.id]: newEditor };
    // The loading flag flips with a real tab switch; it also makes the render
    // deterministic through the memoized component.
    render(tabTwo, true);

    expect(oldEditor.offCalls.map((call) => call.handler)).toContain(
      registered
    );
    expect(oldEditor.active("selectionUpdate")).toBe(0);
    expect(newEditor.onCalls).toHaveLength(1);
    expect(newEditor.active("selectionUpdate")).toBe(1);
    expect(globalStore().statusBars[tabOne.id]).toBeUndefined();
    expect(globalStore().statusBars[tabTwo.id]).toBeDefined();
    expect(container.textContent).toBe("7 chars");
  });

  it("never registers or removes a listener while the count is hidden", () => {
    const editor = new FakeEditor(1);
    globalStore().editors = { [tabOne.id]: editor };

    render(tabOne, false);

    expect(editor.onCalls).toHaveLength(0);
    expect(editor.offCalls).toHaveLength(0);

    act(() => root.unmount());
    mounted = false;

    expect(editor.onCalls).toHaveLength(0);
    expect(editor.offCalls).toHaveLength(0);
  });

  it("only ever removes listeners it registered, leaving foreign ones intact", () => {
    const editor = new FakeEditor(0);
    globalStore().editors = { [tabOne.id]: editor };

    const foreign = jest.fn();
    editor.on("selectionUpdate", foreign);

    render(tabOne, false);
    toggle();
    toggle();

    // The foreign listener survives; only the component's own registration is
    // removed (exact handler identity, not a blanket event removal).
    expect(editor.active("selectionUpdate")).toBe(1);
    act(() => editor.emit("selectionUpdate"));
    expect(foreign).toHaveBeenCalledTimes(1);

    const ownHandlers = new Set(
      editor.onCalls
        .filter((call) => call.handler !== foreign)
        .map((call) => call.handler)
    );
    expect(editor.offCalls.length).toBeGreaterThan(0);
    for (const call of editor.offCalls) {
      expect(call.event).toBe("selectionUpdate");
      expect(ownHandlers.has(call.handler)).toBe(true);
    }
  });

  it("keeps the updateWords/resetWords ref contract for the callers", () => {
    const editor = new FakeEditor(0);
    globalStore().editors = { [tabOne.id]: editor };

    render(tabOne, false);
    const ref = globalStore().statusBars[tabOne.id];
    expect(ref).toBeDefined();
    expect(typeof ref!.current.set).toBe("function");
    expect(typeof ref!.current.updateWords).toBe("function");
    expect(typeof ref!.current.resetWords).toBe("function");

    expect(container.textContent).toBe("0 words");
    act(() => ref!.current.updateWords());
    expect(container.textContent).toBe("3 words");
    act(() => ref!.current.resetWords());
    expect(container.textContent).toBe("0 words");

    act(() => root.unmount());
    mounted = false;
    expect(globalStore().statusBars[tabOne.id]).toBeUndefined();
  });
});
