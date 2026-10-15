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

import {
  describe,
  it,
  expect,
  jest,
  afterEach,
  beforeAll,
  afterAll
} from "@jest/globals";
const { JSDOM } = require("jsdom");

const mockGetPopupToken = jest.fn();
const mockDismissOwnedPopup = jest.fn();
const mockShowMacFormattingMenu = jest.fn();
const mockShowMacInsertMenu = jest.fn();
let mockWebTab = "a";
jest.mock("@notesnook/editor", () => {
  (globalThis as any).__macCommandEditorModuleLoads =
    ((globalThis as any).__macCommandEditorModuleLoads || 0) + 1;
  return {
    getPopupDismissToken: (...args: unknown[]) => mockGetPopupToken(...args),
    dismissPopupForOwner: (...args: unknown[]) => mockDismissOwnedPopup(...args)
  };
});

import { registerEditorPopupCommands } from "./commands";

const makeEditor = (editable = true) => {
  const chain = {
    focus: jest.fn().mockReturnThis(),
    toggleCheckList: jest.fn().mockReturnThis(),
    toggleBold: jest.fn().mockReturnThis(),
    run: jest.fn().mockReturnValue(true)
  };
  return { isEditable: editable, chain: jest.fn(() => chain), calls: chain };
};

describe("native Mac formatting command ownership", () => {
  it("does not load the editor runtime before loadApp initializes locale and polyfills", () => {
    expect((globalThis as any).__macCommandEditorModuleLoads).toBeUndefined();
    expect(globalThis.commands.getPopupDismissToken("a")).toBeNull();
    expect(globalThis.commands.dismissPopup("a", 17)).toBe(false);
    expect((globalThis as any).__macCommandEditorModuleLoads).toBeUndefined();
  });
  it("formats only the explicitly addressed editor and retains its chain result", () => {
    const first = makeEditor();
    const second = makeEditor();
    globalThis.editors = { first, second } as any;
    expect(globalThis.commands.format("checklist", "second")).toBe(true);
    expect(first.chain).not.toHaveBeenCalled();
    expect(second.calls.focus).toHaveBeenCalledTimes(1);
    expect(second.calls.toggleCheckList).toHaveBeenCalledTimes(1);
    expect(second.calls.run).toHaveBeenCalledTimes(1);
  });

  it("never dispatches a mutation to a readonly or absent/locked editor", () => {
    const readonly = makeEditor(false);
    globalThis.editors = { readonly } as any;
    expect(globalThis.commands.format("bold", "readonly")).toBe(false);
    expect(globalThis.commands.format("checklist", "locked")).toBe(false);
    expect(readonly.chain).not.toHaveBeenCalled();
  });
});

describe("Web Escape popup ownership", () => {
  let dom: { window: { document: Document; close: () => void } };
  beforeAll(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: dom.window.document
    });
  });
  afterAll(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, "document");
  });
  afterEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
  });
  const setup = () => {
    registerEditorPopupCommands({
      getPopupDismissToken: mockGetPopupToken as any,
      dismissPopupForOwner: mockDismissOwnedPopup as any,
      showMacInsertMenu: mockShowMacInsertMenu as any,
      showMacFormattingMenu: mockShowMacFormattingMenu as any
    });
    globalThis.tabStore = { getState: () => ({ currentTab: mockWebTab }) };
    document.body.innerHTML =
      '<section class="active" id="a"><div class="ProseMirror"></div><div class="dialogContainer"></div></section><section id="b"><div class="ProseMirror"></div><div class="dialogContainer"></div></section>';
    const a = document.querySelector<HTMLElement>("#a")!;
    const b = document.querySelector<HTMLElement>("#b")!;
    globalThis.editors = {
      a: {
        isDestroyed: false,
        view: { dom: a.querySelector(".ProseMirror")! }
      },
      b: { isDestroyed: false, view: { dom: b.querySelector(".ProseMirror")! } }
    } as any;
    globalThis.editorControllers = {};
    mockWebTab = "a";
    mockGetPopupToken.mockReturnValue(17);
    mockDismissOwnedPopup.mockReturnValue(true);
    mockShowMacInsertMenu.mockReturnValue(true);
    mockShowMacFormattingMenu.mockReturnValue(true);
    return { a, b, owner: a.querySelector(".dialogContainer") };
  };
  it("queries and confirms only the explicitly addressed active owner and token", () => {
    const { owner } = setup();
    expect(globalThis.commands.getPopupDismissToken("a")).toBe(17);
    expect(mockGetPopupToken).toHaveBeenCalledWith(owner);
    expect(globalThis.commands.dismissPopup("a", 17)).toBe(true);
    expect(mockDismissOwnedPopup).toHaveBeenCalledWith(owner, 17);
  });
  it("opens the native Insert entry only for the live editable current tab", () => {
    setup();
    Object.assign(globalThis.editors.a!, { isEditable: true });
    expect(globalThis.commands.openInsert("a")).toBe(true);
    expect(mockShowMacInsertMenu).toHaveBeenCalledWith(globalThis.editors.a);
    expect(globalThis.commands.openInsert("b")).toBe(false);
    Object.assign(globalThis.editors.a!, { isEditable: false });
    expect(globalThis.commands.openInsert("a")).toBe(false);
    expect(mockShowMacInsertMenu).toHaveBeenCalledTimes(1);
  });
  it("opens the native Formatting entry only for the live editable current tab", () => {
    setup();
    Object.assign(globalThis.editors.a!, { isEditable: true });
    expect(globalThis.commands.openFormatting("a")).toBe(true);
    expect(mockShowMacFormattingMenu).toHaveBeenCalledWith(
      globalThis.editors.a,
      expect.objectContaining({ isCurrent: expect.any(Function), subscribe: expect.any(Function) })
    );
    expect(globalThis.commands.openFormatting("b")).toBe(false);
    Object.assign(globalThis.editors.a!, { isEditable: false });
    expect(globalThis.commands.openFormatting("a")).toBe(false);
    expect(mockShowMacFormattingMenu).toHaveBeenCalledTimes(1);
  });
  it("returns unavailable for an incomplete popup registration instead of throwing", () => {
    setup();
    Object.assign(globalThis.editors.a!, { isEditable: true });
    registerEditorPopupCommands({} as any);
    expect(globalThis.commands.openInsert("a")).toBe(false);
    expect(globalThis.commands.openFormatting("a")).toBe(false);
    expect(mockShowMacInsertMenu).not.toHaveBeenCalled();
    expect(mockShowMacFormattingMenu).not.toHaveBeenCalled();
  });
  it("rejects a stale tab even when its old editor remains mounted", () => {
    const { a, b } = setup();
    a.classList.remove("active");
    b.classList.add("active");
    mockWebTab = "b";
    expect(globalThis.commands.getPopupDismissToken("a")).toBeNull();
    expect(globalThis.commands.dismissPopup("a", 17)).toBe(false);
    expect(mockDismissOwnedPopup).not.toHaveBeenCalled();
  });
  it("never uses a shared body fallback", () => {
    const { owner } = setup();
    owner!.remove();
    expect(globalThis.commands.getPopupDismissToken("a")).toBeNull();
    expect(globalThis.commands.dismissPopup("a", 17)).toBe(false);
    expect(mockGetPopupToken).not.toHaveBeenCalled();
    expect(mockDismissOwnedPopup).not.toHaveBeenCalled();
  });
  it("rejects a destroyed active editor", () => {
    setup();
    Object.assign(globalThis.editors.a!, { isDestroyed: true });
    expect(globalThis.commands.getPopupDismissToken("a")).toBeNull();
    expect(globalThis.commands.dismissPopup("a", 17)).toBe(false);
    expect(mockGetPopupToken).not.toHaveBeenCalled();
    expect(mockDismissOwnedPopup).not.toHaveBeenCalled();
  });
});

describe("format popup logical note ownership", () => {
  const ownDom = new JSDOM("<!doctype html><html><body></body></html>");
  beforeAll(() => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: ownDom.window.document
    });
  });
  afterAll(() => {
    ownDom.window.close();
    Reflect.deleteProperty(globalThis, "document");
  });
  it("does not confuse formatting transactions with a same-tab note/session replacement", () => {
    document.body.innerHTML =
      '<section class="active"><div class="ProseMirror"></div><div class="dialogContainer"></div></section>';
    let session = {
      id: "session-a",
      noteId: "note-a",
      spellCheckDisabled: false
    };
    const listeners = new Set<() => void>();
    globalThis.tabStore = {
      getState: () => ({ currentTab: "a", tabs: [{ id: "a", session }] }),
      subscribe: (callback: () => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      }
    } as any;
    globalThis.editorControllers = {};
    globalThis.editors = {
      a: {
        isDestroyed: false,
        isEditable: true,
        view: { dom: document.querySelector(".ProseMirror") }
      }
    } as any;
    registerEditorPopupCommands({
      showMacFormattingMenu: mockShowMacFormattingMenu
    } as any);
    mockShowMacFormattingMenu.mockReturnValue(true);
    expect(globalThis.commands.openFormatting("a")).toBe(true);
    const scope = mockShowMacFormattingMenu.mock.calls.at(-1)![1] as {
      isCurrent: () => boolean;
      subscribe: (callback: () => void) => () => void;
    };
    expect(scope.isCurrent()).toBe(true);
    const changed = jest.fn();
    const unsub = scope.subscribe(changed);
    session = { ...session, noteId: "note-b" };
    listeners.forEach((listener) => listener());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(scope.isCurrent()).toBe(false);
    unsub();
    expect(listeners.size).toBe(0);
  });
});
