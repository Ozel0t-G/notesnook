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
 * The real `useEditor` hook, rendered, driven through its own `saveContent`
 * and through the additive `flushSaves` barrier.
 *
 * Only the peripheral edges are mocked (the native primitives, the tiptap
 * commands, the stores the hook reads and the database). The save queue, the
 * 150 ms debounce, the coalescing, the guards and the barrier itself stay the
 * real ones, so what this suite asserts is produced by the hook:
 *
 * - the exact payloads (and their order) that reach `db.notes.add`,
 * - that a flush awaits the sender's *in-flight* save as well as the saves it
 *   forced itself, instead of a single promise slot,
 * - that a foreign tab's queued save for the same note is never run by another
 *   sender's flush,
 * - that stale/gone/inactive/changed senders abort, and locked/loading
 *   editors report busy instead of exporting prematurely,
 * - that a queued save on a readonly, source-mismatched, conflicted or
 *   db-rejected note is reported as failed instead of as written.
 */

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type AddCall = {
  note: any;
  deferred: ReturnType<typeof deferred<string>>;
  settled: boolean;
  id: string;
};

/** Every `db.notes.add` invocation, in order, with its own unresolved id. */
const mockAdds: AddCall[] = [];
const mockSubscriptions: {
  event: string;
  handler: (...args: any[]) => void;
}[] = [];

const mockNoteFor = (id: string) => ({
  id,
  title: "Old title",
  headline: "",
  dateEdited: 1000,
  readonly: false,
  conflicted: false
});

type MockTab = {
  id: string;
  session?: {
    id?: string;
    origin?: { id: string; title: string } | null;
    noteId?: string;
    readonly?: boolean;
    locked?: boolean;
    noteLocked?: boolean;
  };
};

const mockTabState = {
  currentTab: "tab-1" as string,
  tabs: [
    { id: "tab-1", session: { id: "session-1", noteId: "note-1" } }
  ] as MockTab[],
  getTab: (id: string) => mockTabState.tabs.find((tab) => tab.id === id),
  getNoteIdForTab: (id: string) =>
    mockTabState.tabs.find((tab) => tab.id === id)?.session?.noteId,
  getTabForNote: (noteId: string) =>
    mockTabState.tabs.find((tab) => tab.session?.noteId === noteId)?.id,
  hasTabForNote: (noteId: string) =>
    !!mockTabState.tabs.find((tab) => tab.session?.noteId === noteId),
  getTabsForNote: (noteId: string) =>
    mockTabState.tabs.filter((tab) => tab.session?.noteId === noteId),
  getCurrentNoteId: () =>
    mockTabState.tabs.find((tab) => tab.id === mockTabState.currentTab)?.session
      ?.noteId,
  forEachNoteTab: jest.fn(),
  updateTab: jest.fn(),
  newTab: jest.fn(),
  newTabSession: jest.fn(),
  focusTab: jest.fn(),
  removeTab: jest.fn()
};

const mockSettingState = { isAppLoading: false, theme: "light" };
const mockSettingListeners = new Set<
  (state: typeof mockSettingState) => void
>();

const mockPager = {
  page: jest.fn(() => "editor"),
  goToPage: jest.fn(),
  goToIndex: jest.fn(),
  openDrawer: jest.fn(),
  closeDrawer: jest.fn()
};

const mockDb = {
  isInitialized: true,
  notes: { note: jest.fn(), add: jest.fn() },
  content: { get: jest.fn() },
  vaults: { itemExists: jest.fn() },
  vault: { unlocked: true, save: jest.fn() },
  settings: { getDefaultNotebook: jest.fn(), getDefaultTag: jest.fn() },
  fs: jest.fn(),
  eventManager: { subscribe: jest.fn() }
};

jest.mock("react-native", () => ({
  Linking: { getInitialURL: jest.fn(async () => null) },
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
  BackHandler: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Keyboard: { addListener: jest.fn(() => ({ remove: jest.fn() })) }
}));

// Type-only import in the hook; mocked so the package never has to be loaded.
jest.mock("react-native-webview", () => ({}));

jest.mock("@notesnook/common", () => ({
  getFormattedDate: (value: unknown) => String(value)
}));

jest.mock("@notesnook/core", () => ({
  EVENTS: { syncItemMerged: "event:sync-item-merged" },
  isDeleted: () => false,
  isTrashItem: () => false,
  isEncryptedContent: (content: any) => !!content?.encrypted
}));

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_target, key) => () => String(key) })
}));

jest.mock("@notesnook/theme", () => ({
  useThemeEngineStore: (selector: (state: { theme: string }) => unknown) =>
    selector({ theme: "light" })
}));

jest.mock("@notesnook/editor-mobile/src/utils/editor-events", () => ({
  EditorEvents: new Proxy(
    {},
    { get: (_target, key) => `editor-event:${String(key)}` }
  )
}));

jest.mock("@notesnook/editor-mobile/src/utils/native-events", () => ({
  NativeEvents: new Proxy(
    {},
    { get: (_target, key) => `native:${String(key)}` }
  )
}));

jest.mock("../../../common/database", () => ({
  DatabaseLogger: { log: jest.fn(), info: jest.fn(), error: jest.fn() },
  db: mockDb
}));

jest.mock("../../../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}));

jest.mock("../../../services/event-manager", () => ({
  eSendEvent: jest.fn((name: string, ...args: unknown[]) =>
    (mockEventBus.get(name) ?? []).forEach((handler) => handler(...args))
  ),
  eSubscribeEvent: jest.fn(
    (name: string, handler: (...args: unknown[]) => void) => {
      const handlers = mockEventBus.get(name) ?? [];
      handlers.push(handler);
      mockEventBus.set(name, handlers);
      return {
        unsubscribe: () => {
          const current = mockEventBus.get(name) ?? [];
          const index = current.indexOf(handler);
          if (index !== -1) current.splice(index, 1);
        }
      };
    }
  ),
  eUnSubscribeEvent: jest.fn(),
  ToastManager: { show: jest.fn(), error: jest.fn() },
  presentSheet: jest.fn()
}));

jest.mock("../../../services/navigation", () => ({
  __esModule: true,
  default: {
    navigate: jest.fn(),
    push: jest.fn(),
    goBack: jest.fn(),
    queueRoutesForUpdate: jest.fn()
  }
}));

jest.mock("../../../services/note-preview-widget", () => ({
  NotePreviewWidget: { updateNote: jest.fn() }
}));

jest.mock("../../../services/notifications", () => ({
  __esModule: true,
  default: { isNotePinned: jest.fn(() => false), pinNote: jest.fn() }
}));

jest.mock("../../../services/settings", () => ({
  __esModule: true,
  default: { get: () => ({ disableRealtimeSync: false }), set: jest.fn() }
}));

jest.mock("../../../stores/use-setting-store", () => ({
  useSettingStore: Object.assign(
    (selector: (state: typeof mockSettingState) => unknown) =>
      selector(mockSettingState),
    {
      getState: () => mockSettingState,
      subscribe: (listener: (state: typeof mockSettingState) => void) => {
        mockSettingListeners.add(listener);
        return () => mockSettingListeners.delete(listener);
      },
      setState: (patch: Partial<typeof mockSettingState>) => {
        Object.assign(mockSettingState, patch);
        mockSettingListeners.forEach((listener) => listener(mockSettingState));
      }
    }
  )
}));

jest.mock("../../../stores/use-tag-store", () => ({
  useTagStore: Object.assign(
    (selector: (state: { items: unknown }) => unknown) =>
      selector({ items: undefined }),
    { getState: () => ({ items: undefined }) }
  )
}));

jest.mock("../../../utils/constants", () => ({
  isMacCatalyst: jest.fn(() => false),
  EDITOR_LINE_HEIGHT: { DEFAULT: 1.5 }
}));

jest.mock("../../../utils/events", () => ({
  eEditorReset: "eEditorReset",
  eEditorTabFocused: "eEditorTabFocused",
  eOnLoadNote: "eOnLoadNote",
  eShowMergeDialog: "eShowMergeDialog",
  eUpdateNoteInEditor: "eUpdateNoteInEditor"
}));

jest.mock("../../../utils/global-refs", () => ({
  fluidTabsRef: { current: mockPager },
  editorRef: { current: null }
}));

jest.mock("../../../utils/time", () => ({
  sleep: jest.fn(async () => undefined)
}));

jest.mock("../../../utils/unlock-vault", () => ({
  unlockVault: jest.fn(async () => true)
}));

jest.mock("../../notes/common", () => ({
  onNoteCreated: jest.fn()
}));

jest.mock("./commands", () => ({
  __esModule: true,
  default: class MockCommands {
    setInsets = jest.fn();
    setStatus = jest.fn(async () => undefined);
    setLoading = jest.fn(async () => undefined);
    setSettings = jest.fn(async () => undefined);
    setTags = jest.fn();
    clearContent = jest.fn(async () => undefined);
    clearTags = jest.fn(async () => undefined);
    clear = jest.fn();
    focus = jest.fn();
    blur = jest.fn();
    keyboardShown = jest.fn();
    handleBack = jest.fn(async () => true);
    updateSettings = jest.fn();
    scrollIntoViewById = jest.fn();
    scrollToSearchResult = jest.fn();
    insertTemplate = jest.fn(async () => true);
    doAsync = jest.fn();
  }
}));

jest.mock("./use-tab-store", () => ({
  useTabStore: { getState: () => mockTabState, setState: jest.fn() },
  syncTabs: jest.fn()
}));

jest.mock("./utils", () => ({
  defaultState: { movedAway: true },
  isEditorLoaded: jest.fn(async () => true),
  isContentInvalid: (content?: string) =>
    !content ||
    content === "" ||
    content.trim() === "" ||
    content === "<p></p>" ||
    content === "<p><br></p>" ||
    content === "<p>&nbsp;</p>",
  post: jest.fn(async () => true),
  getResponse: jest.fn(async () => false),
  randId: (prefix = "fn_") => `${prefix}test`,
  makeSessionId: (id?: string) => `${id}session`,
  textInput: { current: null },
  editorController: { current: undefined },
  openInternalLink: jest.fn()
}));

import { useEditor } from "./use-editor";
import { EditorEvents } from "@notesnook/editor-mobile/src/utils/editor-events";
import type { SaveFlushResult } from "./save-barrier";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const mockEventBus = new Map<string, ((...args: unknown[]) => void)[]>();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Editor = ReturnType<typeof useEditor>;

const harness: { editor: Editor } = { editor: undefined as unknown as Editor };

function Harness({
  readonly,
  onChange
}: {
  readonly?: boolean;
  onChange?: (html: string) => void;
}) {
  harness.editor = useEditor("", readonly, onChange);
  return null;
}

const render = (readonly?: boolean, onChange?: (html: string) => void) => {
  act(() => {
    tree = create(<Harness readonly={readonly} onChange={onChange} />);
  });
};

let tree: ReactTestRenderer | undefined;

/** Lets every pending microtask of the hook's async save path run. */
const settleMicrotasks = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
};

const fireDebounce = async () => {
  await act(async () => {
    jest.advanceTimersByTime(150);
  });
  await settleMicrotasks();
};

const save = (payload: {
  type?: string;
  content?: string;
  title?: string;
  noteId?: string;
  tabId?: string;
  pendingChanges?: boolean;
  sourceNoteId?: string;
  pendingChangesAt?: number;
}) =>
  act(() => {
    harness.editor.saveContent({
      type: EditorEvents.content,
      tabId: "tab-1",
      ...payload
    });
  });

const settleAdd = (index: number) => {
  const call = mockAdds[index];
  if (!call || call.settled) return;
  call.settled = true;
  call.deferred.resolve(call.id);
};

const settleAllAdds = () =>
  mockAdds.forEach((_call, index) => settleAdd(index));

const flush = async (tabId = "tab-1", noteId = "note-1") => {
  let result: SaveFlushResult | undefined;
  await act(async () => {
    const pending = harness.editor.flushSaves(tabId, noteId);
    // Let the forced saves reach `db.notes.add`, then let them finish.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    settleAllAdds();
    result = await pending;
  });
  return result as SaveFlushResult;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockAdds.length = 0;
  mockSubscriptions.length = 0;
  mockSettingListeners.clear();
  mockEventBus.clear();

  mockSettingState.isAppLoading = false;
  mockTabState.currentTab = "tab-1";
  mockTabState.tabs = [
    { id: "tab-1", session: { id: "session-1", noteId: "note-1" } }
  ];
  mockPager.page.mockReturnValue("editor");

  mockDb.notes.note.mockImplementation(async (id: string) => mockNoteFor(id));
  mockDb.notes.add.mockImplementation((note: any) => {
    const id = note?.id ?? "note-1";
    const call: AddCall = {
      note,
      deferred: deferred<string>(),
      settled: false,
      id
    };
    mockAdds.push(call);
    return call.deferred.promise;
  });
  mockDb.content.get.mockImplementation(async () => undefined);
  mockDb.vaults.itemExists.mockImplementation(async () => false);
  mockDb.vault.save.mockImplementation(async () => undefined);
  mockDb.settings.getDefaultNotebook.mockReturnValue(undefined);
  mockDb.settings.getDefaultTag.mockReturnValue(undefined);
  mockDb.fs.mockReturnValue({ cancel: jest.fn() });
  mockDb.eventManager.subscribe.mockImplementation(
    (event: string, handler: (...args: any[]) => void) => {
      mockSubscriptions.push({ event, handler });
      return { unsubscribe: jest.fn() };
    }
  );

  const target = globalThis as unknown as Record<string, unknown>;
  target.post = jest.fn();
  target.logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
  target.editors = {};
  target.editorControllers = {};

  render();
});

afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("useEditor save barrier", () => {
  it("awaits the in-flight save and every overlapping queued save of the sender", async () => {
    // One content save is already in flight (its db write is unresolved).
    save({ content: "<p>v1</p>", noteId: "note-1" });
    await fireDebounce();
    expect(mockAdds).toHaveLength(1);
    expect(mockAdds[0].note.content.data).toBe("<p>v1</p>");

    // A newer content save and a title save are queued, not fired yet.
    save({ content: "<p>v2</p>", noteId: "note-1" });
    save({ title: "Latest title", noteId: "note-1", type: EditorEvents.title });

    let result: SaveFlushResult | undefined;
    let settled = false;
    act(() => {
      const pending = harness.editor.flushSaves("tab-1", "note-1");
      void pending.then((value: SaveFlushResult) => {
        settled = true;
        result = value;
      });
    });
    await settleMicrotasks();

    // The flush forced both queued saves itself, without any timer advance.
    expect(mockAdds).toHaveLength(3);
    expect(
      mockAdds.map((call) => call.note.content?.data ?? call.note.title)
    ).toEqual(["<p>v1</p>", "<p>v2</p>", "Latest title"]);

    // It is still waiting while *any* of them is unresolved - the earlier
    // in-flight save included, not just the last one.
    settleAdd(0);
    await settleMicrotasks();
    expect(settled).toBe(false);
    settleAdd(1);
    await settleMicrotasks();
    expect(settled).toBe(false);

    settleAdd(2);
    await settleMicrotasks();
    expect(settled).toBe(true);
    expect(result).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
  });

  it("keeps the legacy debounce: rapid edits write once, with the latest payload", async () => {
    save({ content: "<p>v1</p>", noteId: "note-1" });
    save({ content: "<p>v2</p>", noteId: "note-1" });
    save({ content: "<p>v3</p>", noteId: "note-1" });

    await settleMicrotasks();
    expect(mockAdds).toHaveLength(0);

    await fireDebounce();
    expect(mockAdds).toHaveLength(1);
    expect(mockAdds[0].note.content.data).toBe("<p>v3</p>");
    settleAllAdds();
  });

  it("reports edits that arrived while the flush was awaiting", async () => {
    save({ content: "<p>first</p>", noteId: "note-1" });
    await fireDebounce();

    let result: SaveFlushResult | undefined;
    act(() => {
      void harness.editor
        .flushSaves("tab-1", "note-1")
        .then((value: SaveFlushResult) => {
          result = value;
        });
    });
    await settleMicrotasks();
    expect(mockAdds).toHaveLength(1);

    // A new edit lands while the flush is still waiting for the save.
    save({ content: "<p>second</p>", noteId: "note-1" });
    settleAllAdds();
    await settleMicrotasks();

    expect(result).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: true
    });
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(true);
  });

  it("does not run another tab's queued save for the same note", async () => {
    mockTabState.tabs = [
      { id: "tab-1", session: { id: "session-1", noteId: "note-1" } },
      { id: "tab-2", session: { id: "session-2", noteId: "note-1" } }
    ];
    mockTabState.currentTab = "tab-1";

    save({ content: "<p>foreign</p>", noteId: "note-1", tabId: "tab-2" });

    // tab-1 has no work of its own, so it must neither wait for nor run the
    // foreign sender's queued save.
    let result: SaveFlushResult | undefined;
    await act(async () => {
      result = await harness.editor.flushSaves("tab-1", "note-1");
    });
    expect(result).toEqual({ status: "nothing-pending" });
    expect(mockAdds).toHaveLength(0);

    // The foreign save is still queued and fires on its own debounce.
    await fireDebounce();
    expect(mockAdds).toHaveLength(1);
    expect(mockAdds[0].note.content.data).toBe("<p>foreign</p>");
    settleAllAdds();
  });

  it("resolves a first save's note id at fire time and flushes it", async () => {
    save({ content: "<p>new</p>", noteId: undefined, tabId: "tab-1" });

    const result = await flush();
    expect(mockAdds).toHaveLength(1);
    expect(mockAdds[0].note.id).toBe("note-1");
    expect(result).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
  });

  it("reports a stale restored pending change as saved without writing", async () => {
    mockDb.notes.note.mockImplementation(async (id: string) => ({
      ...mockNoteFor(id),
      contentId: "content-1"
    }));
    mockDb.content.get.mockImplementation(async () => ({
      id: "content-1",
      data: "<p>db</p>",
      type: "tiptap",
      dateEdited: 5000
    }));

    save({
      content: "<p>restored</p>",
      noteId: "note-1",
      tabId: "tab-1",
      pendingChanges: true,
      pendingChangesAt: 100
    });

    const result = await flush();
    // The legacy saveNote discards the older restored change and returns the
    // note id: the flush reports what the database state really is.
    expect(mockAdds).toHaveLength(0);
    expect(result).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
  });

  it("returns nothing-pending for a clean sender, readonly included", async () => {
    expect(await flush()).toEqual({ status: "nothing-pending" });
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(false);

    act(() => tree?.unmount());
    tree = undefined;
    // A persisted readonly note with nothing queued may proceed: there is no
    // write to fabricate, so the barrier reports the readable state.
    render(true);
    expect(await flush()).toEqual({ status: "nothing-pending" });
  });

  it("scopes isSavePending to the exact sender", async () => {
    expect(harness.editor.isSavePending("tab-1", "note-2")).toBe(false);
    expect(harness.editor.isSavePending("", "note-1")).toBe(false);

    save({ content: "<p>queued</p>", noteId: "note-1" });
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(true);
    expect(harness.editor.isSavePending("tab-2", "note-1")).toBe(false);

    await fireDebounce();
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(true);
    settleAllAdds();
    await settleMicrotasks();
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(false);
  });
});

describe("useEditor save barrier guards", () => {
  it("aborts for a missing, unknown, stale or inactive sender", async () => {
    await expect(flush("tab-1", "")).resolves.toEqual({
      status: "aborted",
      reason: "invalid-sender"
    });
    await expect(flush("", "note-1")).resolves.toEqual({
      status: "aborted",
      reason: "invalid-sender"
    });
    await expect(flush("tab-9", "note-1")).resolves.toEqual({
      status: "aborted",
      reason: "unknown-tab"
    });

    // The tab moved on to another note.
    mockTabState.tabs[0].session = { id: "session-1", noteId: "note-2" };
    expect(await flush()).toEqual({
      status: "aborted",
      reason: "stale-sender"
    });

    // Same note, but no longer the active tab.
    mockTabState.tabs = [
      { id: "tab-1", session: { id: "session-1", noteId: "note-1" } },
      { id: "tab-2", session: { id: "session-2", noteId: "note-2" } }
    ];
    mockTabState.currentTab = "tab-2";
    expect(await flush()).toEqual({
      status: "aborted",
      reason: "inactive-sender"
    });
  });

  it("aborts when the sender changed while the flush was awaiting", async () => {
    save({ content: "<p>x</p>", noteId: "note-1" });

    let result: SaveFlushResult | undefined;
    act(() => {
      void harness.editor
        .flushSaves("tab-1", "note-1")
        .then((value: SaveFlushResult) => {
          result = value;
        });
    });
    await settleMicrotasks();
    expect(mockAdds).toHaveLength(1);

    // The tab was remounted (new session id) before the save finished.
    mockTabState.tabs[0].session = { id: "session-2", noteId: "note-1" };
    settleAllAdds();
    await settleMicrotasks();

    expect(result).toEqual({ status: "aborted", reason: "sender-changed" });
  });

  it("aborts when the tab moved to another note while the flush was awaiting", async () => {
    save({ content: "<p>x</p>", noteId: "note-1" });

    let result: SaveFlushResult | undefined;
    act(() => {
      void harness.editor
        .flushSaves("tab-1", "note-1")
        .then((value: SaveFlushResult) => {
          result = value;
        });
    });
    await settleMicrotasks();

    mockTabState.tabs[0].session = { id: "session-1", noteId: "note-2" };
    settleAllAdds();
    await settleMicrotasks();

    expect(result).toEqual({ status: "aborted", reason: "sender-changed" });
  });

  it("returns busy while the editor is locked and never loses the dropped edit", async () => {
    const itemExists = deferred<boolean>();
    mockDb.vaults.itemExists.mockImplementation(() => itemExists.promise);

    // A sync merge locks the editor until it is done.
    const sync = mockSubscriptions.find(
      (subscription) => subscription.event === "event:sync-item-merged"
    );
    expect(sync).toBeDefined();
    await act(async () => {
      void sync!.handler({ id: "note-1", type: "note", title: "T" });
    });

    // The edit cannot be queued while the editor is locked.
    save({ content: "<p>dropped</p>", noteId: "note-1" });
    expect(mockAdds).toHaveLength(0);
    expect(await flush()).toEqual({ status: "busy", reason: "editor-locked" });

    itemExists.resolve(false);
    await settleMicrotasks();

    // Once unlocked, the dropped edit must not be silently reported as clean.
    expect(await flush()).toEqual({
      status: "failed",
      reason: "dropped-while-guarded"
    });
  });

  it("returns busy while the app is loading and saves when it finishes", async () => {
    mockSettingState.isAppLoading = true;

    save({ content: "<p>deferred</p>", noteId: "note-1" });
    await fireDebounce();

    // The legacy deferral queued nothing yet: the barrier must not export.
    expect(mockAdds).toHaveLength(0);
    expect(await flush()).toEqual({ status: "busy", reason: "app-loading" });

    // The old isAppLoading subscription still performs the deferred save.
    await act(async () => {
      Object.assign(mockSettingState, { isAppLoading: false });
      mockSettingListeners.forEach((listener) => listener(mockSettingState));
    });
    await settleMicrotasks();
    expect(mockAdds).toHaveLength(1);
    expect(mockAdds[0].note.content.data).toBe("<p>deferred</p>");

    expect(await flush()).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
  });

  it("does not report a readonly note's queued save as written", async () => {
    act(() => tree?.unmount());
    tree = undefined;
    render(true);

    save({ content: "<p>readonly</p>", noteId: "note-1" });

    const result = await flush();
    expect(mockAdds).toHaveLength(0);
    expect(result).toEqual({ status: "failed", reason: "save-failed" });
  });

  it("reports source mismatches, conflicts and rejected writes as failed", async () => {
    // The hook logs a rejected save the way it always has.
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    // The content came from another note: saveNote refuses it.
    save({
      content: "<p>other</p>",
      noteId: "note-1",
      sourceNoteId: "note-2"
    });
    expect(await flush()).toEqual({ status: "failed", reason: "save-failed" });
    expect(mockAdds).toHaveLength(0);

    // A conflicted note opens the merge dialog instead of writing.
    mockDb.notes.note.mockImplementation(async (id: string) => ({
      ...mockNoteFor(id),
      conflicted: true
    }));
    save({ content: "<p>conflict</p>", noteId: "note-1" });
    expect(await flush()).toEqual({ status: "failed", reason: "save-failed" });

    // The database rejects the write.
    mockDb.notes.note.mockImplementation(async (id: string) => mockNoteFor(id));
    mockDb.notes.add.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    save({ content: "<p>rejected</p>", noteId: "note-1" });
    expect(await flush()).toEqual({ status: "failed", reason: "save-failed" });
  });

  it("keeps a subeditor's onChange path unsupported for the barrier", async () => {
    act(() => tree?.unmount());
    tree = undefined;
    const onChange = jest.fn();
    render(undefined, onChange);

    save({ content: "<p>sub</p>", noteId: "note-1" });
    await fireDebounce();

    expect(onChange).toHaveBeenCalledWith("<p>sub</p>");
    expect(mockAdds).toHaveLength(0);
    expect(await flush()).toEqual({
      status: "aborted",
      reason: "unsupported-editor"
    });
  });
});

describe("useEditor save barrier kinds, busy truthfulness and revision", () => {
  it("keeps a failed content write failed when the title save succeeds", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    save({ content: "<p>body</p>", noteId: "note-1" });
    save({ title: "New title", noteId: "note-1", type: EditorEvents.title });

    let result: SaveFlushResult | undefined;
    await act(async () => {
      const pending = harness.editor.flushSaves("tab-1", "note-1");
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(mockAdds).toHaveLength(2);
      // The body write fails, the title write succeeds.
      mockAdds[0].deferred.reject(new Error("content write failed"));
      mockAdds[1].deferred.resolve("note-1");
      result = await pending;
    });

    // The title's id must not mask the failed body write.
    expect(result).toEqual({ status: "failed", reason: "save-failed" });

    // Only a newer successful *content* save supersedes it.
    save({ content: "<p>body v2</p>", noteId: "note-1" });
    expect(await flush()).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
    expect(mockAdds).toHaveLength(3);
  });

  it("keeps a failed content write failed when the title succeeds first", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    save({ content: "<p>body</p>", noteId: "note-1" });
    save({ title: "New title", noteId: "note-1", type: EditorEvents.title });

    let result: SaveFlushResult | undefined;
    await act(async () => {
      const pending = harness.editor.flushSaves("tab-1", "note-1");
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(mockAdds).toHaveLength(2);
      // This time the title succeeds *before* the body write fails.
      mockAdds[1].deferred.resolve("note-1");
      for (let i = 0; i < 4; i++) await Promise.resolve();
      mockAdds[0].deferred.reject(new Error("content write failed"));
      result = await pending;
    });

    expect(result).toEqual({ status: "failed", reason: "save-failed" });
  });

  it("does not let a content success clear a failed title save", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    save({ content: "<p>body</p>", noteId: "note-1" });
    save({ title: "New title", noteId: "note-1", type: EditorEvents.title });

    let result: SaveFlushResult | undefined;
    await act(async () => {
      const pending = harness.editor.flushSaves("tab-1", "note-1");
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(mockAdds).toHaveLength(2);
      mockAdds[1].deferred.reject(new Error("title write failed"));
      mockAdds[0].deferred.resolve("note-1");
      result = await pending;
    });
    expect(result).toEqual({ status: "failed", reason: "save-failed" });

    // A newer *content* save still does not clear the failed title.
    save({ content: "<p>body v2</p>", noteId: "note-1" });
    expect(await flush()).toEqual({ status: "failed", reason: "save-failed" });
    expect(mockAdds).toHaveLength(3);

    // A newer successful *title* save does.
    save({ title: "Newer title", noteId: "note-1", type: EditorEvents.title });
    expect(await flush()).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
    expect(mockAdds).toHaveLength(4);
  });

  it("ignores a late older failure after a newer content success", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    // The first content save is already in flight...
    save({ content: "<p>v1</p>", noteId: "note-1" });
    await fireDebounce();
    expect(mockAdds).toHaveLength(1);

    // ...and a newer content save is queued behind it.
    save({ content: "<p>v2</p>", noteId: "note-1" });

    let result: SaveFlushResult | undefined;
    await act(async () => {
      const pending = harness.editor.flushSaves("tab-1", "note-1");
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(mockAdds).toHaveLength(2);
      // The newer body write succeeds first; the older one fails late.
      mockAdds[1].deferred.resolve("note-1");
      for (let i = 0; i < 4; i++) await Promise.resolve();
      mockAdds[0].deferred.reject(new Error("stale content write failed"));
      result = await pending;
    });

    // The newer content write persisted the body: the superseded failure must
    // not contaminate the sender.
    expect(result).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(false);
  });

  it("reports a first save that came from another note as failed, not clean", async () => {
    save({ content: "<p>other</p>", sourceNoteId: "note-2" });

    expect(await flush()).toEqual({ status: "failed", reason: "save-failed" });
    // Nothing was written: the content does not belong to this note.
    expect(mockAdds).toHaveLength(0);
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(true);
  });

  it("reports a clean sender as busy while the editor is locked", async () => {
    const itemExists = deferred<boolean>();
    mockDb.vaults.itemExists.mockImplementation(() => itemExists.promise);

    // A sync merge locks the editor until it is done.
    const sync = mockSubscriptions.find(
      (subscription) => subscription.event === "event:sync-item-merged"
    );
    expect(sync).toBeDefined();
    await act(async () => {
      void sync!.handler({ id: "note-1", type: "note", title: "T" });
    });

    // No queued work at all, but the sender must not read clean.
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(false);
    expect(await flush()).toEqual({ status: "busy", reason: "editor-locked" });

    itemExists.resolve(false);
    await settleMicrotasks();

    // Clean again once the lock is gone.
    expect(await flush()).toEqual({ status: "nothing-pending" });
  });

  it("reports a clean sender as busy while its note is loading", async () => {
    harness.editor.currentLoadingNoteId.current = "note-1";

    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(false);
    expect(await flush()).toEqual({ status: "busy", reason: "note-loading" });

    harness.editor.currentLoadingNoteId.current = undefined;
    expect(await flush()).toEqual({ status: "nothing-pending" });
  });

  it("reports a clean sender as busy while the app is loading", async () => {
    mockSettingState.isAppLoading = true;

    expect(await flush()).toEqual({ status: "busy", reason: "app-loading" });

    mockSettingState.isAppLoading = false;
    expect(await flush()).toEqual({ status: "nothing-pending" });
  });

  it("does not treat a vault-locked tab session as a busy hook", async () => {
    mockTabState.tabs[0].session = {
      id: "session-1",
      noteId: "note-1",
      locked: true,
      noteLocked: true,
      readonly: true
    };

    // No queued work and no hook-level lock/loading: still clean, not busy.
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(false);
    expect(await flush()).toEqual({ status: "nothing-pending" });
  });

  it("exposes a monotonic revision that changes only for this sender", async () => {
    const start = harness.editor.getSaveRevision("tab-1", "note-1");

    // A clean flush fabricates nothing.
    expect(await flush()).toEqual({ status: "nothing-pending" });
    expect(harness.editor.getSaveRevision("tab-1", "note-1")).toBe(start);

    save({ content: "<p>v1</p>", noteId: "note-1" });
    await fireDebounce();
    settleAllAdds();
    await settleMicrotasks();
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(false);

    // Fully settled, yet the revision still shows the edit happened.
    const afterFirst = harness.editor.getSaveRevision("tab-1", "note-1");
    expect(afterFirst).toBeGreaterThan(start);

    // A foreign tab on the *same note* keeps its own revision.
    mockTabState.tabs = [
      { id: "tab-1", session: { id: "session-1", noteId: "note-1" } },
      { id: "tab-2", session: { id: "session-2", noteId: "note-1" } }
    ];
    mockTabState.currentTab = "tab-1";

    save({ content: "<p>foreign</p>", noteId: "note-1", tabId: "tab-2" });
    await fireDebounce();
    settleAllAdds();
    await settleMicrotasks();

    expect(harness.editor.getSaveRevision("tab-1", "note-1")).toBe(afterFirst);
    const foreignRevision = harness.editor.getSaveRevision("tab-2", "note-1");
    expect(foreignRevision).toBeGreaterThan(start);
  });

  it("flags pendingAfter when an edit settles while the flush was awaiting", async () => {
    save({ content: "<p>first</p>", noteId: "note-1" });
    await fireDebounce();
    expect(mockAdds).toHaveLength(1);

    let result: SaveFlushResult | undefined;
    let revision: number | undefined;
    act(() => {
      revision = harness.editor.getSaveRevision("tab-1", "note-1");
      void harness.editor
        .flushSaves("tab-1", "note-1")
        .then((value: SaveFlushResult) => {
          result = value;
        });
    });
    await settleMicrotasks();

    // A new edit queues and *completely settles* before the awaited save does.
    save({ content: "<p>second</p>", noteId: "note-1" });
    await fireDebounce();
    settleAllAdds();
    await settleMicrotasks();

    // Nothing is pending anymore, but the flush's snapshot is stale.
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(false);
    const afterEdit = harness.editor.getSaveRevision("tab-1", "note-1");
    expect(afterEdit).not.toBe(revision);
    expect(result).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: true
    });
  });
});

describe("useEditor save barrier final races", () => {
  it("does not let an older queued edit clear a drop the guard recorded after it", async () => {
    const itemExists = deferred<boolean>();
    mockDb.vaults.itemExists.mockImplementation(() => itemExists.promise);

    // A content edit is queued and its debounce has not fired yet.
    save({ content: "<p>older</p>", noteId: "note-1" });

    // A sync merge then locks the editor, and a newer edit is dropped.
    const sync = mockSubscriptions.find(
      (subscription) => subscription.event === "event:sync-item-merged"
    );
    expect(sync).toBeDefined();
    await act(async () => {
      void sync!.handler({ id: "note-1", type: "note", title: "T" });
    });
    save({ content: "<p>dropped</p>", noteId: "note-1" });
    expect(mockAdds).toHaveLength(0);

    itemExists.resolve(false);
    await settleMicrotasks();

    // The flush forces the *older* queued save. Its success carries that
    // older registration ordinal, so it must not clear the newer drop.
    expect(await flush()).toEqual({
      status: "failed",
      reason: "dropped-while-guarded"
    });
    expect(mockAdds).toHaveLength(1);
    expect(mockAdds[0].note.content.data).toBe("<p>older</p>");

    // Only a genuinely newer content write clears it.
    save({ content: "<p>newer</p>", noteId: "note-1" });
    expect(await flush()).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
  });

  it("does not report an in-flight save as saved when the app starts loading while it awaits", async () => {
    save({ content: "<p>inflight</p>", noteId: "note-1" });
    await fireDebounce();
    expect(mockAdds).toHaveLength(1);

    let result: SaveFlushResult | undefined;
    await act(async () => {
      const pending = harness.editor.flushSaves("tab-1", "note-1");
      for (let i = 0; i < 12; i++) await Promise.resolve();
      // The app went back to loading while the save was still in flight.
      mockSettingState.isAppLoading = true;
      settleAllAdds();
      result = await pending;
    });

    expect(result).toEqual({ status: "busy", reason: "app-loading" });
    mockSettingState.isAppLoading = false;
  });

  it("reports a tab whose queued save was evicted by another tab on the same note as failed", async () => {
    mockTabState.tabs = [
      { id: "tab-1", session: { id: "session-1", noteId: "note-1" } },
      { id: "tab-2", session: { id: "session-2", noteId: "note-1" } }
    ];
    mockTabState.currentTab = "tab-1";

    // Two tabs open on the same note share the single debounce timer key.
    save({ content: "<p>from tab-1</p>", noteId: "note-1", tabId: "tab-1" });
    save({ content: "<p>from tab-2</p>", noteId: "note-1", tabId: "tab-2" });

    // tab-1's payload was silently evicted: it must not read clean.
    expect(await flush("tab-1", "note-1")).toEqual({
      status: "failed",
      reason: "dropped-while-guarded"
    });
    expect(mockAdds).toHaveLength(0);

    // The physical debounce still fires the *latest* payload (tab-2's).
    await fireDebounce();
    expect(mockAdds).toHaveLength(1);
    expect(mockAdds[0].note.content.data).toBe("<p>from tab-2</p>");

    // A fresh, genuinely newer content write for tab-1 clears its failure.
    save({
      content: "<p>tab-1 again</p>",
      noteId: "note-1",
      tabId: "tab-1"
    });
    expect(await flush("tab-1", "note-1")).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
    expect(mockAdds).toHaveLength(2);
    expect(mockAdds[1].note.content.data).toBe("<p>tab-1 again</p>");
  });

  it("fails closed for an ambiguous first-save payload whose source is the requested note", async () => {
    // No note id, but a source note id: the payload would resolve under an
    // unknown token, so it must never be forced and never read clean.
    save({ content: "<p>ambiguous</p>", sourceNoteId: "note-1" });

    expect(await flush()).toEqual({ status: "failed", reason: "save-failed" });
    expect(mockAdds).toHaveLength(0);
    expect(harness.editor.isSavePending("tab-1", "note-1")).toBe(true);
  });
});

describe("accepted note load collection context", () => {
  const load = async (event: Record<string, unknown>) => {
    harness.editor.state.current.ready = true;
    (mockEventBus.get("eOnLoadNote") ?? []).forEach((handler) =>
      handler(event)
    );
    await settleMicrotasks();
  };
  it("stores the captured collection on the accepted native session", async () => {
    await load({
      item: mockNoteFor("note-1"),
      origin: { id: "book-b", title: "Chosen collection" }
    });
    expect(mockTabState.updateTab).toHaveBeenCalledWith("tab-1", {
      session: expect.objectContaining({
        noteId: "note-1",
        origin: { id: "book-b", title: "Chosen collection" }
      })
    });
  });
  it("clears merged session context for a direct unrelated entry", async () => {
    mockTabState.tabs[0].session!.origin = {
      id: "book-a",
      title: "Old collection"
    };
    await load({ item: mockNoteFor("note-1") });
    expect(mockTabState.updateTab).toHaveBeenCalledWith("tab-1", {
      session: expect.objectContaining({ origin: null })
    });
  });
  it("preserves context on a refresh of the same saved note", async () => {
    mockTabState.tabs[0].session!.origin = {
      id: "book-a",
      title: "Chosen collection"
    };
    await load({ item: mockNoteFor("note-1"), refresh: true });
    expect(mockTabState.updateTab).toHaveBeenCalledWith("tab-1", {
      session: expect.objectContaining({
        origin: { id: "book-a", title: "Chosen collection" }
      })
    });
  });
  it("preserves the same list origin when the currently open locked note is unlocked", async () => {
    mockTabState.tabs[0].session!.origin = {
      id: "book-a",
      title: "Chosen collection"
    };
    mockTabState.tabs[0].session!.locked = true;
    await load({
      item: {
        ...mockNoteFor("note-1"),
        content: { data: "synthetic unlocked body", type: "tiptap" }
      }
    });
    expect(mockTabState.updateTab).toHaveBeenCalledWith("tab-1", {
      session: expect.objectContaining({
        origin: { id: "book-a", title: "Chosen collection" },
        locked: false
      })
    });
  });
  it("restores the history session's own origin rather than the current note's collection", async () => {
    mockTabState.tabs[0].session!.origin = { id: "book-a", title: "A" };
    await load({
      item: mockNoteFor("note-2"),
      session: {
        id: "historic",
        noteId: "note-2",
        origin: { id: "book-b", title: "B" }
      }
    });
    expect(mockTabState.newTabSession).toHaveBeenCalledWith(
      "tab-1",
      expect.objectContaining({ origin: { id: "book-b", title: "B" } })
    );
  });
  it("updates an already-open background tab's origin before focusing it", async () => {
    mockTabState.tabs.push({
      id: "tab-2",
      session: { id: "logical-2", noteId: "note-2" }
    });
    await load({
      item: mockNoteFor("note-2"),
      origin: { id: "book-b", title: "B" }
    });
    expect(mockTabState.updateTab).toHaveBeenCalledWith("tab-2", {
      session: { origin: { id: "book-b", title: "B" } }
    });
    expect(mockTabState.focusTab).toHaveBeenCalledWith("tab-2");
  });
});
