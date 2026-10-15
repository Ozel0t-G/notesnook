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
 * Real-DOM coverage for the outbound save pipeline of `useEditorController`
 * and for its additive `flushOutboundSaves` dependency (the seam the editor
 * header/Share flow will wait on).
 *
 * What is exercised here is the *production* hook: it is mounted through
 * `createRoot`/`act` exactly like the editor mounts it, it publishes a freshly
 * built controller object into `globalThis.editorControllers` on every render
 * (that is what `editor.tsx` does, and it is what the ownership check has to
 * survive), and the flush, its callbacks and the whole save task are the real
 * ones. Nothing about the hook is mocked.
 *
 * Only periphery is mocked:
 * - `../utils`: the native transport (`post` / `postAsyncWithTimeout`) and
 *   `isReactNative`, plus the globals the WebView normally installs. The
 *   acknowledgements are *transport* receipts here - never a database commit -
 *   which is exactly the contract the flush reports on.
 * - `../utils/pending-saves`: the offline pending-request store, so the
 *   pending-request lookup can be deferred and the ids it returns observed.
 * - `./useTabStore`, `@notesnook/editor`, `@notesnook/theme`,
 *   `@notesnook/intl`, `../utils/css`: the tab/editor/theme/CSS periphery.
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

/**
 * The tab the mounted hook renders for. A module singleton, so a test can move
 * the tab to another note (or another session) between renders the same way the
 * real tab store does.
 */
const mockTab: {
  id: string;
  session: {
    id?: string;
    noteId?: string;
    readonly?: boolean;
    locked?: boolean;
    spellCheckDisabled?: boolean;
  };
} = {
  id: "tab-1",
  session: { id: "logical-1", noteId: "note-1", spellCheckDisabled: false }
};

/**
 * The tab store the controller reads structurally for its active-tab
 * eligibility check. `currentTab` is a *live* field: a test that moves the
 * active tab reassigns it (and `beforeEach` puts it back).
 */
const mockTabStoreState = {
  currentTab: mockTab.id,
  tabs: [mockTab],
  getCurrentNoteId: () => mockTab.session.noteId
};

jest.mock("../utils", () => ({
  getRoot: jest.fn(() => null),
  isReactNative: jest.fn(() => true),
  post: jest.fn(),
  postAsyncWithTimeout: jest.fn(),
  saveTheme: jest.fn()
}));

jest.mock("../utils/css", () => ({
  injectCss: jest.fn(),
  transform: jest.fn(() => ({}))
}));

jest.mock("../utils/pending-saves", () => ({
  pendingSaveRequests: {
    getPendingContent: jest.fn(),
    getPendingTitles: jest.fn(),
    getPendingContentIds: jest.fn(),
    getPendingTitleIds: jest.fn(),
    setContent: jest.fn(),
    setTitle: jest.fn(),
    removePendingContentsById: jest.fn(),
    removePendingTitlesById: jest.fn(),
    postPendingRequests: jest.fn()
  }
}));

jest.mock("@notesnook/editor", () => ({
  Editor: class Editor {},
  scrollIntoViewById: jest.fn()
}));

jest.mock("@notesnook/editor/extensions/keep-in-view/keep-in-view.js", () => ({
  keepLastLineInView: jest.fn()
}));

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_target, key) => () => String(key) })
}));

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({ colors: {}, isDark: false }),
  useThemeEngineStore: (
    selector: (store: { setTheme: () => void }) => unknown
  ) => selector({ setTheme: () => {} })
}));

jest.mock("./useTabStore", () => ({
  useTabContext: () => mockTab,
  useTabStore: { getState: () => mockTabStoreState }
}));

import * as utils from "../utils";
import { pendingSaveRequests } from "../utils/pending-saves";
import { EditorEvents } from "../utils/editor-events";
import { useEditorController } from "./useEditorController";
import type {
  EditorController,
  OutboundSaveResult
} from "./useEditorController";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const testGlobals = globalThis as unknown as Record<string, unknown>;
type MockFunction = ReturnType<typeof jest.fn>;

const postMock = utils.post as unknown as MockFunction;
const postAsyncMock = utils.postAsyncWithTimeout as unknown as MockFunction;
const pendingContentIdsMock =
  pendingSaveRequests.getPendingContentIds as unknown as MockFunction;
const pendingTitleIdsMock =
  pendingSaveRequests.getPendingTitleIds as unknown as MockFunction;

/** Every `post` the hook made, in order. */
const mockPostLog: unknown[][] = [];
/** Every transport call (`postAsyncWithTimeout`), in order. */
const mockTransportLog: unknown[][] = [];

const postsOf = (type: string) =>
  mockPostLog.filter((call) => call[0] === type);

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type DeferredQueue<T> = Deferred<T>[];
type SaveQueues<T> = { content: DeferredQueue<T>; title: DeferredQueue<T> };

/**
 * The pending-request lookups and the native acknowledgements are handed out
 * per call. A queue with more than one entry feeds one entry per call (so two
 * overlapping saves can be settled independently); a single entry is reused for
 * every call; an empty queue settles with the fallback immediately.
 */
const mockPendingQueue: SaveQueues<string[]> = { content: [], title: [] };
const mockAckQueue: SaveQueues<void> = { content: [], title: [] };

function takeNext<T>(queue: DeferredQueue<T>, settledValue: T): Deferred<T> {
  if (queue.length > 1) return queue.shift() as Deferred<T>;
  if (queue.length === 1) return queue[0];
  const fallback = deferred<T>();
  fallback.resolve(settledValue);
  return fallback;
}

function takePendingContentIds() {
  return takeNext(mockPendingQueue.content, []).promise;
}

function takePendingTitleIds() {
  return takeNext(mockPendingQueue.title, []).promise;
}

type MockEditor = {
  getHTML: MockFunction;
  isFocused: boolean;
  state: { selection: { from: number; to: number } };
  commands: Record<string, MockFunction>;
};

/** The editor the hook saves from. Only the surface the hook touches exists. */
const mockEditor = (html: string): MockEditor => ({
  getHTML: jest.fn(() => html),
  isFocused: true,
  state: { selection: { from: 0, to: 0 } },
  commands: {
    setContent: jest.fn(),
    setTextSelection: jest.fn(),
    blur: jest.fn(),
    focus: jest.fn()
  }
});

const asEditor = (value: MockEditor) =>
  value as unknown as Parameters<EditorController["contentChange"]>[0];

/** The mounted hook's latest published controller. */
const mockHarness: { controller?: EditorController } = {};

/**
 * The editor DOM the mounted hook belongs to. It mirrors the real structure
 * `editor.tsx` builds for *one* editor: the ProseMirror content node lives in
 * `.theme-scope-editor` inside `#editor-container-scroller`, and the failure
 * overlay (`#editor-saving-failed-overlay`) is a direct child of the outer
 * editor root - i.e. a sibling of the scroller, three levels above the content
 * node. The hook is handed this root's content node through `getContentDiv`, so
 * its recovery must resolve exactly *this* overlay and never a document-wide
 * first match.
 */
type OwnEditorDom = {
  root: HTMLDivElement;
  scroller: HTMLDivElement;
  scope: HTMLDivElement;
  contentDiv: HTMLDivElement;
  overlay: HTMLDivElement;
};

function createOwnEditorDom(): OwnEditorDom {
  const root = document.createElement("div");
  const overlay = document.createElement("div");
  overlay.id = "editor-saving-failed-overlay";
  overlay.tabIndex = -1;
  overlay.style.display = "none";
  const scroller = document.createElement("div");
  scroller.id = "editor-container-scroller";
  const scope = document.createElement("div");
  scope.className = "theme-scope-editor";
  const contentDiv = document.createElement("div");
  contentDiv.className = "main-editor";
  scope.appendChild(contentDiv);
  scroller.appendChild(scope);
  root.appendChild(overlay);
  root.appendChild(scroller);
  document.body.appendChild(root);
  return { root, scroller, scope, contentDiv, overlay };
}

/** The own editor DOM of the currently mounted hook. */
const mockDom: { current?: OwnEditorDom } = {};

function Harness({ version }: { version: number }) {
  const controller = useEditorController({
    update: () => {},
    getTableOfContents: () => [],
    scrollTo: () => {},
    scrollTop: () => 0,
    getContentDiv: () => mockDom.current?.contentDiv ?? null
  });
  // The production editor does exactly this, and it does it with a controller
  // object that is rebuilt on every single render.
  globalThis.editorControllers[mockTab.id] = controller;
  mockHarness.controller = controller;
  return <div data-version={version} />;
}

const drainMicrotasks = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

/** The failure overlay of the mounted hook's *own* editor DOM. */
const overlay = () => mockDom.current?.overlay as HTMLDivElement;

/** The tab editor's commands, so a test can assert blur/focus were untouched. */
const tabEditorCommands = (tabId = "tab-1") => {
  const editors = testGlobals.editors as Record<
    string,
    { commands: Record<string, MockFunction> }
  >;
  return editors[tabId].commands;
};

describe("useEditorController outbound flush", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted = false;
  /**
   * A React root cannot be reused after `unmount()`; only a fresh root may be
   * created for a remount. An ordinary re-render (no unmount in between) keeps
   * the very same root, so the hook instance - and its stable methods - survive.
   */
  let rootAlive = true;

  const render = (version = 0) => {
    if (!rootAlive) {
      root = createRoot(container);
      rootAlive = true;
    }
    mounted = true;
    act(() => {
      root.render(<Harness version={version} />);
    });
  };

  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => root.unmount());
    rootAlive = false;
  };

  const controller = () => mockHarness.controller as EditorController;

  /** Starts the flush without awaiting it, so a test can settle its awaits. */
  const startFlush = () => {
    let promise: Promise<OutboundSaveResult> | undefined;
    act(() => {
      promise = controller().flushOutboundSaves();
    });
    return promise as Promise<OutboundSaveResult>;
  };

  /** A body edit through the real `contentChange` callback. */
  const edit = (editor: MockEditor) => {
    act(() => {
      controller().contentChange(asEditor(editor));
    });
  };

  const titleEdit = (title: string) => {
    act(() => {
      controller().titleChange(title);
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockTab.id = "tab-1";
    mockTab.session.id = "logical-1";
    mockTab.session.noteId = "note-1";
    delete mockTab.session.readonly;
    delete mockTab.session.locked;
    mockTabStoreState.currentTab = "tab-1";
    mockTabStoreState.tabs = [mockTab];
    mockHarness.controller = undefined;

    testGlobals.sessionId = "session-1";
    testGlobals.logger = jest.fn();
    testGlobals.dbLogger = jest.fn();
    testGlobals.pendingResolvers = {};
    testGlobals.statusBars = {};
    testGlobals.editorControllers = {};
    testGlobals.editors = {
      "tab-1": {
        commands: {
          blur: jest.fn(),
          setContent: jest.fn(),
          setTextSelection: jest.fn()
        }
      }
    };

    mockPostLog.length = 0;
    mockTransportLog.length = 0;
    mockPendingQueue.content = [];
    mockPendingQueue.title = [];
    mockAckQueue.content = [];
    mockAckQueue.title = [];

    postMock.mockImplementation((...args: unknown[]) => {
      mockPostLog.push(args);
    });
    postAsyncMock.mockImplementation((...args: unknown[]) => {
      mockTransportLog.push(args);
      return args[0] === EditorEvents.title
        ? takeNext(mockAckQueue.title, undefined).promise
        : takeNext(mockAckQueue.content, undefined).promise;
    });
    pendingContentIdsMock.mockImplementation(takePendingContentIds);
    pendingTitleIdsMock.mockImplementation(takePendingTitleIds);

    mockDom.current = createOwnEditorDom();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rootAlive = true;
    jest.useFakeTimers();
  });

  afterEach(() => {
    unmount();
    container.remove();
    mockDom.current?.root.remove();
    mockDom.current = undefined;
    delete (window as unknown as { ReactNativeWebView?: unknown })
      .ReactNativeWebView;
    jest.useRealTimers();
  });

  it.each(["note-1", undefined])(
    "keeps rapid title entry focused during 1500ms real transport delay (note %s)",
    async (noteId) => {
      mockTab.session.noteId = noteId;
      // Use the production timer/resolver implementation, not a deferred mock.
      // Loading utils installs WebView globals; restore this test's identity.
      const transport = jest.requireActual(
        "../utils"
      ) as typeof import("../utils");
      testGlobals.sessionId = "session-1";
      testGlobals.logger = jest.fn();
      testGlobals.dbLogger = jest.fn();
      const received: { value: { title: string }; resolverId: string }[] = [];
      window.ReactNativeWebView = {
        postMessage: (message: string) => {
          const request = JSON.parse(message);
          if (request.type !== EditorEvents.title) return;
          received.push(request);
          setTimeout(
            () => globalThis.pendingResolvers[request.resolverId]?.({}),
            1500
          );
        }
      };
      postAsyncMock.mockImplementation((...args: unknown[]) =>
        transport.postAsyncWithTimeout(
          ...(args as Parameters<typeof transport.postAsyncWithTimeout>)
        )
      );
      render();
      const titleField = document.createElement("textarea");
      mockDom.current?.scope.appendChild(titleField);
      titleField.focus();
      const title = "QA rapid title " + "full text ".repeat(14) + "END-XYZ987";
      for (let index = 1; index <= title.length; index++) {
        titleField.value = title.slice(0, index);
        titleEdit(titleField.value);
      }
      await drainMicrotasks();
      if (!noteId) {
        // Native assigns the first-save identity while the outbound receipts
        // are still pending; the logical edit session must stay correlated.
        mockTab.session.noteId = "note-1";
        render(1);
      }
      const flush = startFlush();
      let settled = false;
      void flush.then(() => {
        settled = true;
      });
      await act(async () => {
        jest.advanceTimersByTime(1001);
        await drainMicrotasks();
      });
      expect(overlay().style.display).toBe("none");
      expect(settled).toBe(false);
      expect(document.activeElement).toBe(titleField);
      expect(tabEditorCommands().blur).not.toHaveBeenCalled();
      expect(pendingSaveRequests.setTitle).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(500);
        await drainMicrotasks();
      });
      expect((await flush).status).toBe("delivered");
      expect(received).toHaveLength(title.length);
      expect(received[received.length - 1].value.title).toBe(title);
      expect(titleField.value).toBe(title);
      expect(document.activeElement).toBe(titleField);
      delete (window as unknown as { ReactNativeWebView?: unknown })
        .ReactNativeWebView;
    }
  );

  it.each(["note-1", undefined])(
    "reports absent title ACK with the existing offline limitation (note %s)",
    async (noteId) => {
      mockTab.session.noteId = noteId;
      const transport = jest.requireActual(
        "../utils"
      ) as typeof import("../utils");
      testGlobals.sessionId = "session-1";
      testGlobals.logger = jest.fn();
      testGlobals.dbLogger = jest.fn();
      window.ReactNativeWebView = { postMessage: () => {} };
      postAsyncMock.mockImplementation((...args: unknown[]) =>
        transport.postAsyncWithTimeout(
          ...(args as Parameters<typeof transport.postAsyncWithTimeout>)
        )
      );
      render();
      titleEdit("Full unsent title END-XYZ987");
      await drainMicrotasks();
      const flush = startFlush();
      await act(async () => {
        jest.advanceTimersByTime(4999);
        await drainMicrotasks();
      });
      expect(overlay().style.display).toBe("none");
      await act(async () => {
        jest.advanceTimersByTime(1);
        await drainMicrotasks();
      });
      // Unsaved notes are not Share-eligible: this flush intentionally skips
      // them even though their asynchronous title transport can still fail.
      expect((await flush).status).toBe(noteId ? "failed" : "nothing-pending");
      expect(overlay().style.display).toBe("flex");
      if (noteId) {
        expect(pendingSaveRequests.setTitle).toHaveBeenCalledWith(
          [
            { title: "Full unsent title END-XYZ987" },
            "tab-1",
            noteId,
            "session-1",
            5000
          ],
          expect.any(Number)
        );
      } else {
        // Known first-save limitation: without an ID there is no offline record.
        expect(pendingSaveRequests.setTitle).not.toHaveBeenCalled();
        mockTab.session.noteId = "note-1";
        render(1);
        expect((await controller().flushOutboundSaves()).status).toBe("failed");
      }
      delete (window as unknown as { ReactNativeWebView?: unknown })
        .ReactNativeWebView;
    }
  );

  it("delivers a debounced edit immediately: latest HTML, once, no leftover timer", async () => {
    render();
    const editor = mockEditor("<p>first</p>");
    mockAckQueue.content = [deferred<void>()];

    edit(editor);
    // Inside the 100ms debounce window: nothing has been sent yet.
    expect(mockTransportLog).toHaveLength(0);

    const flush = startFlush();
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);
    mockAckQueue.content[0].resolve(undefined);

    const result = await flush;
    expect(result.status).toBe("delivered");
    expect(result.revision).toBe(1);
    expect(result.snapshot).toEqual({
      tabId: "tab-1",
      noteId: "note-1",
      sessionId: "session-1"
    });
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>first</p>" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );
    // The drained timer was cleared *and* nulled: advancing time must not save
    // the same edit a second time.
    act(() => {
      jest.advanceTimersByTime(200);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);
    expect(postsOf(EditorEvents.contentchange)).toHaveLength(1);
  });

  it("keeps the default coalescing: rapid edits save the latest HTML once", async () => {
    render();
    mockAckQueue.content = [deferred<void>()];

    edit(mockEditor("<p>v1</p>"));
    edit(mockEditor("<p>v2</p>"));
    expect(postsOf(EditorEvents.content)).toHaveLength(0);

    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();

    expect(mockTransportLog).toHaveLength(1);
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>v2</p>" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );
    // The existing contentchange notification is untouched: once per edit.
    expect(postsOf(EditorEvents.contentchange)).toHaveLength(2);

    mockAckQueue.content[0].resolve(undefined);
    await drainMicrotasks();
    expect(pendingSaveRequests.removePendingContentsById).toHaveBeenCalledWith(
      []
    );
  });

  it("waits for the deferred pending lookups and for both acknowledgements", async () => {
    render();
    const pendingContent = deferred<string[]>();
    const pendingTitle = deferred<string[]>();
    mockPendingQueue.content = [pendingContent];
    mockPendingQueue.title = [pendingTitle];
    const contentAck = deferred<void>();
    const titleAck = deferred<void>();
    mockAckQueue.content = [contentAck];
    mockAckQueue.title = [titleAck];

    titleEdit("My title");
    edit(mockEditor("<p>body</p>"));

    let settled = false;
    const flush = startFlush();
    flush.then(() => {
      settled = true;
    });
    await drainMicrotasks();
    // Neither save may start before its pending-request lookup resolved.
    expect(mockTransportLog).toHaveLength(0);
    expect(settled).toBe(false);

    pendingContent.resolve(["pending-content-1"]);
    pendingTitle.resolve(["pending-title-1"]);
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(2);
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>body</p>" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.title,
      { title: "My title" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );

    // Only the body acknowledgement arrived: the flush still waits.
    contentAck.resolve(undefined);
    await drainMicrotasks();
    expect(settled).toBe(false);

    titleAck.resolve(undefined);
    const result = await flush;
    expect(result.status).toBe("delivered");
    expect(pendingSaveRequests.removePendingContentsById).toHaveBeenCalledWith([
      "pending-content-1"
    ]);
    expect(pendingSaveRequests.removePendingTitlesById).toHaveBeenCalledWith([
      "pending-title-1"
    ]);
  });

  it("awaits an older overlapping body save as well as the new one", async () => {
    render();
    const olderAck = deferred<void>();
    const newerAck = deferred<void>();
    mockAckQueue.content = [olderAck, newerAck];

    // A save for the same note is already in flight.
    edit(mockEditor("<p>old</p>"));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);

    // A newer edit lands while the older save is still unanswered.
    edit(mockEditor("<p>new</p>"));

    let settled = false;
    const flush = startFlush();
    flush.then(() => {
      settled = true;
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(2);

    newerAck.resolve(undefined);
    await drainMicrotasks();
    // The older save is still unanswered: the flush must not report success.
    expect(settled).toBe(false);

    olderAck.resolve(undefined);
    const result = await flush;
    expect(result.status).toBe("delivered");
  });

  it("reports stale when the tab moved to another note while waiting", async () => {
    render();
    const pendingContent = deferred<string[]>();
    mockPendingQueue.content = [pendingContent];
    mockAckQueue.content = [deferred<void>()];

    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();

    // The user switched notes while the save was waiting.
    mockTab.session.noteId = "note-2";
    render(1);

    pendingContent.resolve([]);
    mockAckQueue.content[0].resolve(undefined);

    const result = await flush;
    expect(result.status).toBe("stale");
    // The snapshot is the one the flush was performed for, not the new note.
    expect(result.snapshot).toEqual({
      tabId: "tab-1",
      noteId: "note-1",
      sessionId: "session-1"
    });
  });

  it("reports stale when the session changed while waiting", async () => {
    render();
    const pendingContent = deferred<string[]>();
    mockPendingQueue.content = [pendingContent];
    mockAckQueue.content = [deferred<void>()];

    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();

    testGlobals.sessionId = "session-2";
    pendingContent.resolve([]);
    mockAckQueue.content[0].resolve(undefined);

    const result = await flush;
    expect(result.status).toBe("stale");
    expect(result.snapshot.sessionId).toBe("session-1");
  });

  it("reports busy while the controller is loading and posts nothing", async () => {
    render();
    act(() => {
      controller().setLoading(true);
    });

    edit(mockEditor("<p>body</p>"));
    const result = await controller().flushOutboundSaves();

    expect(result.status).toBe("busy");
    expect(mockTransportLog).toHaveLength(0);
    expect(mockPostLog).toHaveLength(0);
    act(() => {
      jest.advanceTimersByTime(200);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(0);
  });

  it("keeps the offline pending save and the overlay when an acknowledgement rejects", async () => {
    render();
    const ack = deferred<void>();
    mockAckQueue.content = [ack];

    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);

    ack.reject(new Error("offline"));
    const result = await flush;

    expect(result.status).toBe("failed");
    // The existing recovery path is unchanged: the params are persisted and the
    // existing failure overlay is shown, and nothing is removed.
    expect(pendingSaveRequests.setContent).toHaveBeenCalledTimes(1);
    expect(
      pendingSaveRequests.removePendingContentsById
    ).not.toHaveBeenCalled();
    expect(overlay().style.display).toBe("flex");
  });

  it("does not let a title delivery mask a body failure", async () => {
    render();
    const contentAck = deferred<void>();
    const titleAck = deferred<void>();
    mockAckQueue.content = [contentAck];
    mockAckQueue.title = [titleAck];

    titleEdit("Title");
    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();

    titleAck.resolve(undefined);
    contentAck.reject(new Error("offline"));

    const result = await flush;
    expect(result.status).toBe("failed");
    // The title really was delivered...
    expect(pendingSaveRequests.removePendingTitlesById).toHaveBeenCalledTimes(
      1
    );
    // ...and that must not erase the body failure.
    expect(pendingSaveRequests.setContent).toHaveBeenCalledTimes(1);
    expect(
      pendingSaveRequests.removePendingContentsById
    ).not.toHaveBeenCalled();
  });

  it("ignores an ignoreEdit update: no job, no synthetic save", async () => {
    render();

    act(() => {
      controller().contentChange(asEditor(mockEditor("<p>body</p>")), true);
    });
    const result = await controller().flushOutboundSaves();

    expect(result.status).toBe("nothing-pending");
    expect(mockPostLog).toHaveLength(0);
    expect(mockTransportLog).toHaveLength(0);
    act(() => {
      jest.advanceTimersByTime(200);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(0);
  });

  it("rejects the flush for a note without an id and keeps the first-save path", async () => {
    mockTab.session.noteId = undefined;
    render();

    edit(mockEditor("<p>brand new</p>"));
    const result = await controller().flushOutboundSaves();

    expect(result.status).toBe("nothing-pending");
    expect(result.snapshot.noteId).toBeUndefined();
    expect(mockTransportLog).toHaveLength(0);

    // The untouched first-save path still runs on its own timer, with the same
    // payload it always had.
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>brand new</p>" },
      "tab-1",
      undefined,
      "session-1",
      5000
    );
    expect(postsOf(EditorEvents.contentchange)).toHaveLength(1);
  });

  it("reports nothing-pending for an untouched read-only note across re-renders", async () => {
    mockTab.session.readonly = true;
    render();

    const first = await controller().flushOutboundSaves();
    expect(first.status).toBe("nothing-pending");
    expect(first.revision).toBe(0);

    render(1);
    const second = await controller().flushOutboundSaves();
    expect(second.status).toBe("nothing-pending");
    expect(mockPostLog).toHaveLength(0);
    expect(mockTransportLog).toHaveLength(0);
  });

  it("reports stale when a new edit settles while the flush waits", async () => {
    render();
    const ack = deferred<void>();
    mockAckQueue.content = [ack];

    edit(mockEditor("<p>v1</p>"));
    const flush = startFlush();
    await drainMicrotasks();

    // A new edit lands while the flush is waiting, and it settles completely.
    edit(mockEditor("<p>v2</p>"));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(2);

    ack.resolve(undefined);
    await drainMicrotasks();

    const result = await flush;
    expect(result.status).toBe("stale");
    expect(result.revision).toBe(2);
    // The new edit kept its own, normal save path.
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>v2</p>" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );
  });

  it("does not drain another note's work and never replays the offline queue", async () => {
    render();

    edit(mockEditor("<p>other note</p>"));
    // The tab moves on before the debounce elapsed.
    mockTab.session.noteId = "note-2";
    render(1);

    const result = await controller().flushOutboundSaves();
    expect(result.status).toBe("nothing-pending");
    expect(mockTransportLog).toHaveLength(0);
    // No lookup of the (foreign) offline queue, and no replay of it.
    expect(pendingContentIdsMock).not.toHaveBeenCalled();
    expect(pendingSaveRequests.postPendingRequests).not.toHaveBeenCalled();

    // The discarded job is not replayed onto the note that is open now either.
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(0);
    expect(postsOf(EditorEvents.content)).toHaveLength(0);
  });

  it("keeps ownership across an ordinary re-render", async () => {
    render();
    const pendingContent = deferred<string[]>();
    mockPendingQueue.content = [pendingContent];
    mockAckQueue.content = [deferred<void>()];

    edit(mockEditor("<p>body</p>"));
    const published = globalThis.editorControllers[mockTab.id];
    const flush = startFlush();
    await drainMicrotasks();

    // A theme change / keystroke re-renders the editor: a *new* controller
    // object is published for the same hook instance.
    render(1);
    const republished = globalThis.editorControllers[mockTab.id];
    expect(republished).not.toBe(published);
    expect(republished?.flushOutboundSaves).toBe(published?.flushOutboundSaves);

    pendingContent.resolve([]);
    mockAckQueue.content[0].resolve(undefined);

    const result = await flush;
    expect(result.status).toBe("delivered");
  });

  it("rejects a flush whose controller instance was replaced", async () => {
    render();
    const pendingContent = deferred<string[]>();
    mockPendingQueue.content = [pendingContent];
    mockAckQueue.content = [deferred<void>()];

    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();

    // Another editor instance takes the tab over while this flush waits.
    globalThis.editorControllers[mockTab.id] = {
      ...controller(),
      flushOutboundSaves: jest.fn()
    } as unknown as EditorController;

    pendingContent.resolve([]);
    mockAckQueue.content[0].resolve(undefined);

    const result = await flush;
    expect(result.status).toBe("stale");
  });

  it("rejects a flush after a remount, and the new instance still works", async () => {
    render();
    const pendingContent = deferred<string[]>();
    mockPendingQueue.content = [pendingContent];
    mockAckQueue.content = [deferred<void>()];

    edit(mockEditor("<p>body</p>"));
    const replacing = controller();
    const flush = replacing.flushOutboundSaves();
    await drainMicrotasks();

    unmount();
    render(1);
    expect(controller()).not.toBe(replacing);

    pendingContent.resolve([]);
    mockAckQueue.content[0].resolve(undefined);

    const result = await flush;
    expect(result.status).toBe("stale");
    expect((await controller().flushOutboundSaves()).status).toBe(
      "nothing-pending"
    );
  });

  it("uses the existing HTML capture and never reserializes or blurs on success", async () => {
    render();
    mockAckQueue.content = [deferred<void>()];
    const editor = mockEditor("<p>captured</p>");

    edit(editor);
    const flush = startFlush();
    mockAckQueue.content[0].resolve(undefined);
    const result = await flush;

    expect(result.status).toBe("delivered");
    expect(editor.getHTML).toHaveBeenCalledTimes(1);
    expect(editor.commands.setContent).not.toHaveBeenCalled();
    expect(editor.commands.setTextSelection).not.toHaveBeenCalled();
    expect(editor.commands.blur).not.toHaveBeenCalled();
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>captured</p>" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );
  });

  it("cleans up on unmount: no delivery, no stale post, foreign resolvers untouched", async () => {
    render();
    const foreignResolver = jest.fn();
    globalThis.pendingResolvers["foreign"] = foreignResolver;
    const pendingContent = deferred<string[]>();
    mockPendingQueue.content = [pendingContent];
    mockAckQueue.content = [deferred<void>()];

    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();

    unmount();

    pendingContent.resolve([]);
    mockAckQueue.content[0].resolve(undefined);

    const result = await flush;
    expect(result.status).toBe("stale");
    // Nothing was reported as saved and the failure overlay was not touched.
    expect(overlay().style.display).toBe("none");
    // A foreign resolver belongs to the app, not to this hook.
    expect(globalThis.pendingResolvers["foreign"]).toBe(foreignResolver);
  });

  it("retains the owned unsent body save after unmount and refuses a stale flush", async () => {
    render();
    const ack = deferred<void>();
    mockAckQueue.content = [ack];
    edit(mockEditor("<p>unsent</p>"));

    const owner = controller();
    unmount();

    // A flush belonging to the unmounted instance can never be Share-eligible.
    const result = await owner.flushOutboundSaves();
    expect(result.status).toBe("stale");
    expect(mockTransportLog).toHaveLength(0);

    // The captured edit is not thrown away with the instance: its own normal
    // timer still delivers the exact payload, with its own explicit metadata.
    act(() => {
      jest.advanceTimersByTime(200);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>unsent</p>" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );

    ack.resolve(undefined);
    await drainMicrotasks();
  });

  it("does not drain a background tab's save but keeps its own normal delivery", async () => {
    render();
    const ack = deferred<void>();
    mockAckQueue.content = [ack];
    edit(mockEditor("<p>background</p>"));

    // The user moved to another tab before the debounce elapsed.
    mockTabStoreState.currentTab = "tab-2";
    render(1);

    const result = await controller().flushOutboundSaves();
    // Only the active tab is Share-eligible; a background tab is never drained.
    expect(result.status).toBe("stale");
    expect(mockTransportLog).toHaveLength(0);

    // Its own 100ms timer still runs and posts to *its own* note, never to B.
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>background</p>" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );

    ack.resolve(undefined);
    await drainMicrotasks();
  });

  it("does not cancel a background tab's own title save", async () => {
    render();
    const titleAck = deferred<void>();
    mockAckQueue.title = [titleAck];

    // The user moved to another tab before the title change was made.
    mockTabStoreState.currentTab = "tab-2";
    render(1);

    const result = await controller().flushOutboundSaves();
    expect(result.status).toBe("stale");

    // The title change still belongs to tab A and posts its own metadata: an
    // eligibility abort is never a cancellation of owned data.
    titleEdit("Background title");
    await drainMicrotasks();
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.title,
      { title: "Background title" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );

    titleAck.resolve(undefined);
    await drainMicrotasks();
  });

  it("reports stale when the active tab changes while the flush waits, but the own save still delivers", async () => {
    render();
    const ack = deferred<void>();
    mockAckQueue.content = [ack];

    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);

    // The user switched to another tab while the acknowledgement was pending.
    mockTabStoreState.currentTab = "tab-2";
    render(1);

    ack.resolve(undefined);
    const result = await flush;

    expect(result.status).toBe("stale");
    // The own save was not cancelled - it was delivered with its own metadata.
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>body</p>" },
      "tab-1",
      "note-1",
      "session-1",
      5000
    );
    expect(pendingSaveRequests.removePendingContentsById).toHaveBeenCalled();
  });

  it("reports busy when the editor starts loading while the flush waits", async () => {
    render();
    const ack = deferred<void>();
    mockAckQueue.content = [ack];

    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);

    act(() => {
      controller().setLoading(true);
    });

    ack.resolve(undefined);
    const result = await flush;
    // Loading turned true before a positive result: never claim the note saved.
    expect(result.status).toBe("busy");
  });

  it("keeps a failure for its own note and never lets another note's delivery erase it", async () => {
    render();
    const aAck = deferred<void>();
    mockAckQueue.content = [aAck];

    edit(mockEditor("<p>A</p>"));
    const flushA = startFlush();
    await drainMicrotasks();
    aAck.reject(new Error("offline"));
    expect((await flushA).status).toBe("failed");

    // The tab moves to another note in its own logical edit session.
    mockTab.session.noteId = "note-2";
    mockTab.session.id = "logical-2";
    render(1);

    const bAck = deferred<void>();
    mockAckQueue.content = [bAck];
    edit(mockEditor("<p>B</p>"));
    const flushB = startFlush();
    await drainMicrotasks();
    bAck.resolve(undefined);
    expect((await flushB).status).toBe("delivered");

    // Back on note A: the failure is still remembered, B is not poisoned.
    mockTab.session.noteId = "note-1";
    mockTab.session.id = "logical-1";
    render(1);
    expect((await controller().flushOutboundSaves()).status).toBe("failed");

    mockTab.session.noteId = "note-2";
    mockTab.session.id = "logical-2";
    render(1);
    expect((await controller().flushOutboundSaves()).status).toBe(
      "nothing-pending"
    );

    // A new successful save of A clears only A's failure.
    mockTab.session.noteId = "note-1";
    mockTab.session.id = "logical-1";
    render(1);
    const a2Ack = deferred<void>();
    mockAckQueue.content = [a2Ack];
    edit(mockEditor("<p>A2</p>"));
    const flushA2 = startFlush();
    await drainMicrotasks();
    a2Ack.resolve(undefined);
    expect((await flushA2).status).toBe("delivered");
    expect((await controller().flushOutboundSaves()).status).toBe(
      "nothing-pending"
    );
  });

  it("keeps a pre-id body failure when native assigns the note id in the same edit session", async () => {
    mockTab.session.noteId = undefined;
    mockTab.session.id = "logical-new";
    render();

    const ack = deferred<void>();
    mockAckQueue.content = [ack];

    edit(mockEditor("<p>first</p>"));
    // The debounced save starts while the note still has no id.
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);
    expect(postAsyncMock).toHaveBeenCalledWith(
      EditorEvents.content,
      { html: "<p>first</p>" },
      "tab-1",
      undefined,
      "session-1",
      5000
    );

    // Native assigns the id of the very same (logical) edit session.
    mockTab.session.noteId = "note-new";
    render(1);

    const flush = startFlush();
    await drainMicrotasks();
    ack.reject(new Error("offline"));

    // The in-flight, pre-id save belongs to this note: it is awaited and its
    // failure reported, instead of a false clean.
    expect((await flush).status).toBe("failed");
  });

  it("keeps a pre-id title failure when the note id is assigned in the same edit session", async () => {
    mockTab.session.noteId = undefined;
    mockTab.session.id = "logical-new";
    render();

    const titleAck = deferred<void>();
    mockAckQueue.title = [titleAck];

    titleEdit("Title");
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);
    titleAck.reject(new Error("offline"));
    await drainMicrotasks();

    mockTab.session.noteId = "note-new";
    render(1);

    const result = await controller().flushOutboundSaves();
    expect(result.status).toBe("failed");
  });

  it("reports a failed body save instead of rejecting when the HTML capture throws", async () => {
    render();
    const editor = mockEditor("<p>throw</p>");
    editor.getHTML.mockImplementation(() => {
      throw new Error("editor torn down");
    });

    edit(editor);
    const result = await controller().flushOutboundSaves();

    expect(result.status).toBe("failed");
    expect(mockTransportLog).toHaveLength(0);
    // No recovery path was invented for a capture that produced nothing: no
    // offline request and no misleading "pending request" log.
    expect(pendingSaveRequests.setContent).not.toHaveBeenCalled();
    const dbLog = testGlobals.dbLogger as unknown as MockFunction;
    expect(dbLog.mock.calls.some((call) => call[0] === "log")).toBe(false);
    expect(overlay().style.display).toBe("none");
  });

  it("never forgets an unresolved failure after more than the record limit", async () => {
    render();
    const failFor = async (index: number) => {
      mockTab.session.noteId = `note-${index}`;
      mockTab.session.id = `logical-${index}`;
      render(index + 1);
      const ack = deferred<void>();
      mockAckQueue.content = [ack];
      edit(mockEditor(`<p>${index}</p>`));
      act(() => {
        jest.advanceTimersByTime(100);
      });
      await drainMicrotasks();
      ack.reject(new Error("offline"));
      await drainMicrotasks();
    };

    // One more distinct failed note than the clean-record cap allows.
    for (let i = 0; i < 65; i += 1) await failFor(i);

    // A clean delivery of another note is kept as its own record and must not
    // erase any of the failures either.
    mockTab.session.noteId = "note-1";
    mockTab.session.id = "logical-1";
    render(200);
    const okAck = deferred<void>();
    mockAckQueue.content = [okAck];
    edit(mockEditor("<p>ok</p>"));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    okAck.resolve(undefined);
    await drainMicrotasks();

    // The oldest failure is still remembered instead of a false clean.
    mockTab.session.noteId = "note-0";
    mockTab.session.id = "logical-0";
    render(201);
    expect((await controller().flushOutboundSaves()).status).toBe("failed");
  });

  it("keeps an unsaved failure distinct from another unsaved note of the same tab", async () => {
    mockTab.session.noteId = undefined;
    mockTab.session.id = "logical-1";
    render();

    // The first unsaved note fails.
    const ackA = deferred<void>();
    mockAckQueue.content = [ackA];
    edit(mockEditor("<p>A</p>"));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    ackA.reject(new Error("offline"));
    await drainMicrotasks();

    // A *different* unsaved note in the same tab (its own logical session) is
    // delivered.
    mockTab.session.id = "logical-2";
    render(1);
    const ackB = deferred<void>();
    mockAckQueue.content = [ackB];
    edit(mockEditor("<p>B</p>"));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    await drainMicrotasks();
    ackB.resolve(undefined);
    await drainMicrotasks();

    // Once the first note gets its id its failure must still be known: the
    // delivery of the other unsaved note must not have merged into it.
    mockTab.session.noteId = "note-A";
    mockTab.session.id = "logical-1";
    render(2);
    expect((await controller().flushOutboundSaves()).status).toBe("failed");
  });

  it("does not blur or focus a tab that moved on when a deferred title failure lands", async () => {
    render();
    const titleAck = deferred<void>();
    mockAckQueue.title = [titleAck];

    titleEdit("Title A");
    await drainMicrotasks();
    expect(mockTransportLog).toHaveLength(1);

    // The same tab moved to another note in its own logical session before the
    // acknowledgement of the old note landed.
    mockTab.session.noteId = "note-2";
    mockTab.session.id = "logical-2";
    render(1);

    const blur = tabEditorCommands().blur;
    titleAck.reject(new Error("offline"));
    await drainMicrotasks();

    // The old failure is retained offline and as a failed outcome ...
    expect(pendingSaveRequests.setTitle).toHaveBeenCalledTimes(1);
    // ... but the note the user is on now is neither blurred nor focused.
    expect(blur).not.toHaveBeenCalled();
    expect(overlay().style.display).toBe("none");
    expect(document.activeElement).not.toBe(overlay());

    // Back on the original note the failure is still known.
    mockTab.session.noteId = "note-1";
    mockTab.session.id = "logical-1";
    render(2);
    expect((await controller().flushOutboundSaves()).status).toBe("failed");
  });

  it("recovers only the owning editor's overlay when duplicate overlay ids exist", async () => {
    // A second editor root mounted *before* this one carries the same overlay
    // id (two tabs mount the same editor). A document-wide lookup would grab
    // this wrong, inactive root.
    const decoy = createOwnEditorDom();
    document.body.insertBefore(
      decoy.root,
      (mockDom.current as OwnEditorDom).root
    );

    render();
    const ack = deferred<void>();
    mockAckQueue.content = [ack];
    edit(mockEditor("<p>body</p>"));
    const flush = startFlush();
    await drainMicrotasks();
    ack.reject(new Error("offline"));
    await flush;

    expect(overlay().style.display).toBe("flex");
    expect(document.activeElement).toBe(overlay());
    // The wrong root (which comes first in the document) is left untouched.
    expect(decoy.overlay.style.display).toBe("none");

    decoy.root.remove();
  });
});
