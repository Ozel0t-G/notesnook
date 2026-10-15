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
 * The real `useEditorEvents` hook, rendered, driven through the exact messages
 * the editor WebView posts and through the real iPad workspace context.
 *
 * Only the peripheral edges are mocked: the native primitives, the sheets and
 * dialogs the message switch opens, the filesystem/clipboard packages, the
 * stores that feed the hook and the tiptap controller/utils module. What the
 * suite asserts is produced by the hook itself - the `setSettings` payload the
 * WebView receives, and the real `onBackPress` chain behind
 * `EditorEvents.back` (blur -> `movedAway` -> the pager's `goToPage("home")` ->
 * the route refresh), which is exactly the chain the header's Back button
 * triggers.
 *
 * The two things this suite pins down:
 *
 * - `pagedPresentation` is additive and default-editor-only: it reaches the
 *   WebView as one extra settings field, and `deviceMode` and the tool set stay
 *   exactly what the store supplied.
 * - the narrow iPad's back is the *page* back (`fluidTabsRef.goToPage("home")`)
 *   even though `deviceMode` is the tablet classification there, so the header's
 *   Back button works without any device-mode rewrite. It must not fire for a
 *   subeditor, without a workspace, in fullscreen, or when the editor cancels
 *   the back.
 */

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";

/**
 * The app's runtime globals: the native host defines `post`, `logger`,
 * `editors` and `editorControllers` and nothing imports them. The hook reads
 * `logger` in the back path, so the suite supplies them the way the app does.
 */
const mockPost = jest.fn();
const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

/** The pager the hook commands; `page()` is the page it believes it is on. */
const mockPager = {
  page: jest.fn(() => "editor"),
  goToPage: jest.fn(),
  goToIndex: jest.fn(),
  openDrawer: jest.fn(),
  closeDrawer: jest.fn()
};

/** The editor's own state, exactly the fields the back path touches. */
const mockEditorState = {
  movedAway: false,
  currentlyEditing: true,
  isFocused: true,
  isAwaitingResult: false
};

/** The setting store's state, read through the hook's own selectors. */
const mockSettingState = {
  deviceMode: "tablet" as string | undefined,
  fullscreen: false,
  isAppLoading: false,
  dateFormat: "MM/DD/YYYY",
  timeFormat: "hh:mm A",
  dayFormat: "dddd",
  settings: {
    corsProxy: "",
    defaultLineHeight: 1.5,
    defaultFontSize: 16,
    defaultFontFamily: "Inter",
    markdownShortcuts: true,
    doubleSpacedLines: false
  }
};

const mockTabState = {
  tabs: [] as { id: string; session?: { id?: string; noteId?: string } }[],
  currentTab: "tab-1" as string,
  getTab: (id: string) => mockTabState.tabs.find((tab) => tab.id === id),
  getNoteIdForTab: (id?: string) =>
    mockTabState.tabs.find((tab) => tab.id === id)?.session?.noteId,
  updateTab: jest.fn()
};

const mockTabListeners = new Set<
  (next: typeof mockTabState, previous: typeof mockTabState) => void
>();
const mockShare = jest.fn(
  async (_options: unknown): Promise<void> => undefined
);
const mockExport = jest.fn(
  async (_id: string, _options: unknown): Promise<string | false> =>
    "saved body"
);
const mockNote = jest.fn(
  async (_id: string): Promise<any> => ({ id: "note-1", title: "Sender note" })
);
const mockContent = jest.fn(
  async (_id: string): Promise<any> => ({ data: "saved body" })
);
const mockMembership = jest.fn(async (_note: unknown) => false);
const mockOpenVault = jest.fn();
jest.mock("react-native-share", () => ({
  __esModule: true,
  default: { open: (options: unknown) => mockShare(options) }
}));

/** The tool set the toolbar drag store hands the hook (a tablet's). */
const mockTools = [{ id: "bold", type: "button" }];

/**
 * The drag store the hook reads, with a *mutable* preset: the toolbar preset is
 * sent to the WebView alongside the tools, and a preset-only change (identical
 * tools) must still reach it.
 */
const mockDragState = {
  data: mockTools as unknown,
  preset: "default" as "default" | "minimal" | "custom"
};

/** Everything published on the event bus, in order. */
const mockBus = {
  handlers: new Map<string, Set<(...args: unknown[]) => void>>(),
  published: [] as { name: string; args: unknown[] }[],
  reset: () => {
    mockBus.handlers.clear();
    mockBus.published.length = 0;
  },
  publish: (name: string, ...args: unknown[]) => {
    mockBus.published.push({ name, args });
    mockBus.handlers.get(name)?.forEach((handler) => handler(...args));
  }
};

/** The hardware-back subscriptions the hook installed, in order. */
const mockBackHandlers: ((...args: unknown[]) => unknown)[] = [];

/**
 * The real `EditorEvents` wire names for the messages this suite drives, with
 * every other key resolving to a distinct name of its own: the hook's switch
 * reads dozens of them, and none of them may collide (or be `undefined`) for
 * the cases below to be the real ones.
 */
const mockEditorEvents: Record<string, string> = {
  back: "editor-event:back",
  load: "editor-events:load",
  newNote: "editor-events:new-note",
  logger: "native:logger",
  shareNote: "editor-events:share-note",
  content: "editor-events:content",
  title: "editor-events:title",
  contentchange: "editor-events:content-change"
};

jest.mock("react-native", () => ({
  BackHandler: {
    addEventListener: jest.fn(
      (_name: string, handler: (...a: unknown[]) => unknown) => {
        mockBackHandlers.push(handler);
        return {
          remove: () => {
            const index = mockBackHandlers.indexOf(handler);
            if (index !== -1) mockBackHandlers.splice(index, 1);
          }
        };
      }
    )
  },
  Keyboard: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
  useWindowDimensions: () => ({
    width: 600,
    height: 1024,
    fontScale: 1,
    scale: 2
  })
}));

// Type-only import in the hook; mocked so the package path never has to be
// transformed for this suite.
jest.mock("react-native-webview", () => ({}));

jest.mock("@notesnook/common", () => {
  const features = { callout: true, outlineList: true, taskList: true };
  return {
    useAreFeaturesAvailable: () => features,
    isFeatureAvailable: jest.fn(async () => ({ isAllowed: true }))
  };
});

jest.mock("@notesnook/core", () => ({
  parseInternalLink: jest.fn(() => ({ type: "note", id: "note-1" })),
  isDeleted: (note: { deleted?: boolean }) => !!note.deleted,
  isTrashItem: (note: { trashed?: boolean }) => !!note.trashed,
  isEncryptedContent: (content: { data: any }) =>
    !!content.data &&
    typeof content.data === "object" &&
    "cipher" in content.data &&
    "iv" in content.data &&
    "salt" in content.data,
  isDecryptedContent: (content: { data: any }) =>
    !(
      content.data &&
      typeof content.data === "object" &&
      "cipher" in content.data &&
      "iv" in content.data &&
      "salt" in content.data
    )
}));

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy(
    {},
    {
      // Every access is a call returning a renderable string: the hook renders
      // no copy itself, but the header/menu helpers it opens do.
      get: (_target, key) => () => String(key)
    }
  )
}));

jest.mock("@notesnook/editor-mobile/src/utils/editor-events", () => ({
  EditorEvents: new Proxy(mockEditorEvents, {
    get: (target, key) => target[String(key)] ?? `editor-event:${String(key)}`
  })
}));

jest.mock("@notesnook/editor-mobile/src/utils/native-events", () => ({
  NativeEvents: new Proxy(
    {},
    { get: (_target, key) => `native:${String(key)}` }
  )
}));

jest.mock("@notesnook/editor/dist/cjs/toolbar/tool-definitions", () => ({
  getDefaultPresets: () => ({ default: [{ id: "default-tool" }] })
}));

jest.mock("@react-native-clipboard/clipboard", () => ({
  __esModule: true,
  default: { setString: jest.fn() }
}));

jest.mock("react-native-scoped-storage", () => ({
  createDocument: jest.fn(async () => undefined)
}));

jest.mock("react-native-blob-util", () => ({
  __esModule: true,
  default: {
    fs: {
      exists: jest.fn(async () => false),
      writeFile: jest.fn(async () => undefined)
    }
  }
}));

jest.mock("../../../common/database", () => ({
  DatabaseLogger: { log: jest.fn(), info: jest.fn(), error: jest.fn() },
  db: {
    isInitialized: true,
    notes: {
      note: (id: string) => mockNote(id),
      export: (id: string, options: unknown) => mockExport(id, options)
    },
    vaults: { itemExists: (note: unknown) => mockMembership(note) },
    content: { findByNoteId: (id: string) => mockContent(id) },
    relations: { unlink: jest.fn(async () => undefined) },
    eventManager: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
    settings: {}
  }
}));

jest.mock("../../../common/filesystem/download-attachment", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined)
}));

jest.mock("../../../common/filesystem", () => ({
  __esModule: true,
  default: { checkAndCreateDir: jest.fn(async () => "/tmp/") }
}));

jest.mock("../../../components/auth/common", () => ({
  AuthMode: { login: "login", signup: "signup" }
}));

jest.mock("../../../components/properties", () => ({
  Properties: { present: jest.fn() }
}));

jest.mock("../../../components/sheets/editor-tabs", () => ({
  __esModule: true,
  default: { present: jest.fn() }
}));

jest.mock("../../../components/sheets/link-note", () => ({
  __esModule: true,
  default: { present: jest.fn() }
}));

jest.mock("../../../components/sheets/toc", () => ({
  __esModule: true,
  default: { present: jest.fn() }
}));

jest.mock("../../../components/sheets/export-notes/share", () => ({
  ShareComponent: () => null
}));

jest.mock("../../add-reminder", () => ({
  __esModule: true,
  default: { present: jest.fn() }
}));

jest.mock("../../manage-tags", () => ({
  __esModule: true,
  default: { present: jest.fn() }
}));

jest.mock("../../relations-list", () => ({
  __esModule: true,
  default: { present: jest.fn() }
}));

jest.mock("../../settings/editor/state", () => ({
  useDragState: (selector: (state: typeof mockDragState) => unknown) =>
    selector(mockDragState)
}));

jest.mock("../../../services/device-detection", () => ({
  DDS: {
    isTab: true,
    isSmallTab: false,
    isLargeTablet: () => true,
    width: 600,
    orientation: "PORTRAIT"
  }
}));

jest.mock("../../../services/event-manager", () => ({
  eSendEvent: (name: string, ...args: unknown[]) =>
    mockBus.publish(name, ...args),
  eSubscribeEvent: (name: string, handler: (...args: unknown[]) => void) => {
    if (!mockBus.handlers.has(name)) mockBus.handlers.set(name, new Set());
    mockBus.handlers.get(name)!.add(handler);
    return { unsubscribe: () => mockBus.handlers.get(name)?.delete(handler) };
  },
  eUnSubscribeEvent: (name: string, handler: (...args: unknown[]) => void) => {
    mockBus.handlers.get(name)?.delete(handler);
  },
  ToastManager: { show: jest.fn(), error: jest.fn() },
  presentSheet: jest.fn(),
  openVault: (options: unknown) => mockOpenVault(options),
  VaultRequestType: { ShareNote: "ShareNote" }
}));

jest.mock("../../../services/navigation", () => ({
  __esModule: true,
  default: {
    navigate: jest.fn(),
    push: jest.fn(),
    goBack: jest.fn(),
    openDrawer: jest.fn(),
    closeDrawer: jest.fn(),
    queueRoutesForUpdate: jest.fn()
  }
}));

jest.mock("../../../services/settings", () => ({
  __esModule: true,
  default: {
    get: () => ({ defaultFontFamily: "Inter" }),
    set: jest.fn()
  }
}));

jest.mock("../../../stores/use-navigation-store", () => {
  const state = { currentRoute: "None", focusedRouteId: "None" };
  const useNavigationStore = Object.assign(
    jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    { getState: () => state }
  );
  return { __esModule: true, default: useNavigationStore };
});

jest.mock("../../../stores/use-relation-store", () => ({
  useRelationStore: { getState: () => ({ update: jest.fn() }) }
}));

jest.mock("../../../stores/use-setting-store", () => ({
  useSettingStore: Object.assign(
    (selector: (state: typeof mockSettingState) => unknown) =>
      selector(mockSettingState),
    { getState: () => mockSettingState }
  )
}));

jest.mock("../../../stores/use-tag-store", () => ({
  useTagStore: { getState: () => ({ refresh: jest.fn() }) }
}));

jest.mock("../../../stores/use-user-store", () => ({
  useUserStore: Object.assign(
    (selector: (state: { user: unknown }) => unknown) =>
      selector({ user: null }),
    { getState: () => ({ user: null }) }
  )
}));

jest.mock("../../../utils/constants", () => ({
  isMacCatalyst: jest.fn(() => false)
}));

jest.mock("../../../utils/events", () => ({
  eClearEditor: "eClearEditor",
  eCloseFullscreenEditor: "eCloseFullscreenEditor",
  eEditorTabFocused: "eEditorTabFocused",
  eOnEnterEditor: "eOnEnterEditor",
  eOnExitEditor: "eOnExitEditor",
  eOnLoadNote: "eOnLoadNote",
  eOpenFullscreenEditor: "eOpenFullscreenEditor",
  eOpenPublishNoteDialog: "eOpenPublishNoteDialog",
  eUnlockWithBiometrics: "eUnlockWithBiometrics",
  eUnlockWithPassword: "eUnlockWithPassword"
}));

jest.mock("../../../utils/functions", () => ({
  openLinkInBrowser: jest.fn()
}));

jest.mock("../../../utils/global-refs", () => ({
  fluidTabsRef: { current: mockPager },
  editorRef: { current: null }
}));

jest.mock("../../../utils/time", () => ({
  sleep: jest.fn(async () => undefined)
}));

jest.mock("./use-tab-store", () => ({
  useTabStore: Object.assign(jest.fn(), {
    getState: () => mockTabState,
    setState: jest.fn(),
    subscribe: (
      listener: (
        next: typeof mockTabState,
        previous: typeof mockTabState
      ) => void
    ) => {
      mockTabListeners.add(listener);
      return () => mockTabListeners.delete(listener);
    }
  })
}));

jest.mock("./utils", () => ({
  editorState: () => mockEditorState,
  openInternalLink: jest.fn()
}));

import { useEditorEvents } from "./use-editor-events";
import { EditorEvents } from "@notesnook/editor-mobile/src/utils/editor-events";
import { IPadWorkspaceProvider } from "../../../components/ipad-workspace-context";
import type { IPadWorkspaceState } from "../../../components/ipad-workspace-context";
import Navigation from "../../../services/navigation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const applyGlobals = () => {
  const target = globalThis as unknown as Record<string, unknown>;
  target.post = mockPost;
  target.logger = mockLogger;
  target.editors = {};
  target.editorControllers = {};
};

type Editor = Parameters<typeof useEditorEvents>[0];
type EditorMessageEvent = { nativeEvent: { data: string } };

const makeEditor = (editorId = ""): Editor =>
  ({
    editorId,
    sessionId: { current: "transport-1" },
    currentLoadingNoteId: { current: undefined },
    flushSaves: jest.fn(async () => ({ status: "nothing-pending" })),
    isSavePending: jest.fn(() => false),
    getSaveRevision: jest.fn(() => 1),
    loading: false,
    note: { current: {} },
    state: { current: {} },
    commands: {
      setSettings: jest.fn(),
      handleBack: jest.fn(async () => true),
      blur: jest.fn(),
      focus: jest.fn(),
      keyboardShown: jest.fn(),
      clear: jest.fn(),
      setTags: jest.fn(),
      updateSettings: jest.fn()
    },
    postMessage: jest.fn(),
    post: jest.fn(),
    onLoad: jest.fn(),
    onContentChanged: jest.fn(),
    saveContent: jest.fn()
  } as unknown as Editor);

const editorCommands = (editor: Editor) =>
  (editor as unknown as { commands: Record<string, jest.Mock> }).commands;

/** The WebView message a native editor event arrives as. */
const message = (payload: Record<string, unknown>): EditorMessageEvent => ({
  nativeEvent: { data: JSON.stringify(payload) }
});

/** The editor under test and the message handler the hook returned. */
const harness: {
  editor: Editor;
  onMessage?: (event: EditorMessageEvent) => Promise<void>;
} = { editor: makeEditor() };

/**
 * One stable component type for the whole suite: a width change must *re-render*
 * the hook (through the workspace context) instead of remounting it, which is
 * what makes the callback-identity assertion below meaningful.
 */
function Harness() {
  harness.onMessage = useEditorEvents(harness.editor, {}) as unknown as (
    event: EditorMessageEvent
  ) => Promise<void>;
  return null;
}

describe("useEditorEvents on the paged iPad", () => {
  let tree: ReactTestRenderer | undefined;

  const render = (editor: Editor, workspace?: IPadWorkspaceState) => {
    harness.editor = editor;
    harness.onMessage = undefined;
    act(() => {
      tree = create(
        <IPadWorkspaceProvider value={workspace}>
          <Harness />
        </IPadWorkspaceProvider>
      );
    });
  };

  const updateWorkspace = (workspace?: IPadWorkspaceState) => {
    act(() => {
      tree?.update(
        <IPadWorkspaceProvider value={workspace}>
          <Harness />
        </IPadWorkspaceProvider>
      );
    });
  };

  /** Posts one real WebView message and lets the hook's async path settle. */
  const send = async (payload: Record<string, unknown>) => {
    await act(async () => {
      await harness.onMessage?.(message(payload));
    });
  };

  const settingsPayload = (editor: Editor) => {
    const calls = editorCommands(editor).setSettings.mock.calls;
    return calls[calls.length - 1][0] as Record<string, unknown>;
  };

  const published = (name: string) =>
    mockBus.published.filter((entry) => entry.name === name);

  const narrow: IPadWorkspaceState = {
    paneMode: "narrow",
    sidebarVisible: false
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    applyGlobals();
    mockBus.reset();
    mockBackHandlers.length = 0;
    mockEditorState.movedAway = false;
    mockEditorState.currentlyEditing = true;
    mockSettingState.deviceMode = "tablet";
    mockSettingState.fullscreen = false;
    mockTabState.currentTab = "tab-1";
    mockTabState.tabs = [];
    mockSettingState.isAppLoading = false;
    mockPager.page.mockReturnValue("editor");
    mockDragState.data = mockTools;
    mockDragState.preset = "default";
    harness.editor = makeEditor();
    harness.onMessage = undefined;
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
    jest.useRealTimers();
  });

  it("sends the narrow iPad's paged presentation without touching the device mode or tools", () => {
    const editor = makeEditor();
    render(editor, narrow);

    const settings = settingsPayload(editor);
    expect(settings.pagedPresentation).toBe(true);
    // Additive: the real device-mode classification and the tablet tool set are
    // exactly what the store supplied.
    expect(settings.deviceMode).toBe("tablet");
    expect(settings.tools).toBe(mockTools);
    expect(settings.fullscreen).toBe(false);
  });

  it("leaves every client without the paged workspace unchanged", () => {
    // iPhone: no workspace at all.
    mockSettingState.deviceMode = "mobile";
    const iphone = makeEditor();
    render(iphone, undefined);
    expect(settingsPayload(iphone).pagedPresentation).toBe(false);
    expect(settingsPayload(iphone).deviceMode).toBe("mobile");

    act(() => tree?.unmount());
    tree = undefined;

    // A tablet-width workspace that is not narrow has no paged document.
    mockSettingState.deviceMode = "tablet";
    const wide = makeEditor();
    render(wide, { paneMode: "wide", sidebarVisible: true });
    expect(settingsPayload(wide).pagedPresentation).toBe(false);
    expect(settingsPayload(wide).deviceMode).toBe("tablet");
  });

  it("never gives a subeditor the paged presentation, whatever the width", () => {
    const subeditor = makeEditor("tab-2");
    render(subeditor, narrow);

    expect(settingsPayload(subeditor).pagedPresentation).toBe(false);
  });

  it("re-renders the settings for a width change without rebuilding the callback", () => {
    const editor = makeEditor();
    render(editor, { paneMode: "wide", sidebarVisible: true });
    expect(settingsPayload(editor).pagedPresentation).toBe(false);
    const firstOnMessage = harness.onMessage;

    updateWorkspace(narrow);

    // The same callback instance: the page is read through a ref precisely so a
    // width change cannot re-create the message handler (nor its back chain).
    expect(harness.onMessage).toBe(firstOnMessage);
    // And the WebView was told about the new affordance.
    expect(settingsPayload(editor).pagedPresentation).toBe(true);
  });

  it("blurs, marks the editor away and pages home on a narrow iPad back", async () => {
    const editor = makeEditor();
    render(editor, narrow);

    await send({ type: EditorEvents.back });
    // The pager's move happens on the hook's own 1 ms timer, after the blur.
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(editorCommands(editor).blur).toHaveBeenCalledWith("tab-1");
    expect(mockEditorState.movedAway).toBe(true);
    // `deviceMode` is the tablet classification here: only the paged
    // presentation can reach the page change.
    expect(mockSettingState.deviceMode).toBe("tablet");
    expect(mockPager.goToPage).toHaveBeenCalledTimes(1);
    expect(mockPager.goToPage).toHaveBeenCalledWith("home");

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(Navigation.queueRoutesForUpdate).toHaveBeenCalledTimes(1);
  });

  it("closes fullscreen first instead of paging", async () => {
    mockSettingState.fullscreen = true;
    const editor = makeEditor();
    render(editor, narrow);

    await send({ type: EditorEvents.back });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(published("eCloseFullscreenEditor")).toHaveLength(1);
    expect(mockPager.goToPage).not.toHaveBeenCalled();
    expect(mockEditorState.movedAway).toBe(false);
  });

  it("does nothing when the editor cancels the back", async () => {
    const editor = makeEditor();
    editorCommands(editor).handleBack.mockResolvedValueOnce(false);
    render(editor, narrow);

    await send({ type: EditorEvents.back });
    act(() => {
      jest.advanceTimersByTime(1);
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(editorCommands(editor).blur).not.toHaveBeenCalled();
    expect(mockEditorState.movedAway).toBe(false);
    expect(mockPager.goToPage).not.toHaveBeenCalled();
    expect(Navigation.queueRoutesForUpdate).not.toHaveBeenCalled();
  });

  it("does not page for a subeditor or without the paged workspace", async () => {
    // A subeditor never has the paged presentation, so its back cannot page.
    const subeditor = makeEditor("tab-2");
    render(subeditor, narrow);
    await send({ type: EditorEvents.back });
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(editorCommands(subeditor).blur).toHaveBeenCalledWith("tab-1");
    expect(mockPager.goToPage).not.toHaveBeenCalled();

    act(() => tree?.unmount());
    tree = undefined;

    // The default editor of a tablet-width workspace without the paged context
    // (an iPhone-style iPad, Mac Catalyst, Android) keeps its previous back.
    const plain = makeEditor();
    render(plain, undefined);
    await send({ type: EditorEvents.back });
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(editorCommands(plain).blur).toHaveBeenCalledWith("tab-1");
    expect(mockPager.goToPage).not.toHaveBeenCalled();
  });

  it("marks the editor's own new-note load as editor-origin", async () => {
    const editor = makeEditor();
    render(editor, narrow);

    await send({ type: EditorEvents.newNote, tabId: "tab-1" });

    expect(published("eOnLoadNote")).toEqual([
      {
        name: "eOnLoadNote",
        args: [
          {
            tabId: "tab-1",
            newNote: true,
            loadedFromEditor: true
          }
        ]
      }
    ]);
  });
  describe("primary Share through the actual WebView message handler", () => {
    const packet = (overrides: Record<string, unknown> = {}) => ({
      type: EditorEvents.shareNote,
      tabId: "tab-1",
      noteId: "note-1",
      sessionId: "transport-1",
      value: { logicalSessionId: "logical-1" },
      ...overrides
    });
    const transition = (
      currentTab: string,
      noteId = "note-1",
      logicalId = "logical-1"
    ) => {
      const previous = {
        ...mockTabState,
        tabs: mockTabState.tabs.map((tab) => ({
          ...tab,
          session: { ...tab.session }
        }))
      };
      mockTabState.currentTab = currentTab;
      mockTabState.tabs = [
        { id: "tab-1", session: { id: logicalId, noteId } },
        { id: "tab-2", session: { id: "logical-2", noteId: "note-2" } }
      ];
      mockTabListeners.forEach((listener) => listener(mockTabState, previous));
    };
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const settle = async () => {
      await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
    };
    const field = (name: keyof Editor): jest.Mock =>
      harness.editor[name] as unknown as jest.Mock;
    beforeEach(() => {
      mockShare.mockReset().mockResolvedValue(undefined);
      mockExport.mockReset().mockResolvedValue("saved body");
      mockNote
        .mockReset()
        .mockResolvedValue({ id: "note-1", title: "Sender note" });
      mockContent.mockReset().mockResolvedValue({ data: "saved body" });
      mockMembership.mockReset().mockResolvedValue(false);
      mockOpenVault.mockReset();
      transition("tab-1");
      render(makeEditor(), narrow);
    });
    it("shares the resolved sender note after the native save barrier, using the existing TXT format", async () => {
      const saved = deferred<any>();
      field("flushSaves").mockReturnValue(saved.promise);
      const operation = harness.onMessage!(message(packet()));
      await settle();
      expect(mockNote).not.toHaveBeenCalled();
      expect(mockShare).not.toHaveBeenCalled();
      await act(async () => {
        saved.resolve({ status: "saved", id: "note-1", pendingAfter: false });
        await operation;
      });
      expect(field("flushSaves")).toHaveBeenCalledWith("tab-1", "note-1");
      expect(mockExport).toHaveBeenCalledWith("note-1", {
        format: "txt",
        disableTemplate: undefined
      });
      expect(mockShare).toHaveBeenCalledWith({
        title: "Sender note",
        message: "saved body",
        failOnCancel: false
      });
    });
    it.each([
      { noteId: undefined },
      { noteId: "" },
      { tabId: "tab-2" },
      { sessionId: "foreign" },
      { value: { logicalSessionId: "foreign" } }
    ])(
      "rejects an ambiguous or foreign sender %j without falling back to the active note",
      async (overrides) => {
        await send(packet(overrides));
        expect(field("flushSaves")).not.toHaveBeenCalled();
        expect(mockExport).not.toHaveBeenCalled();
        expect(mockShare).not.toHaveBeenCalled();
      }
    );
    it("rejects subeditor share messages", async () => {
      harness.editor.editorId = "child";
      await send(packet());
      expect(mockNote).not.toHaveBeenCalled();
    });
    it.each([
      { status: "busy" },
      { status: "failed" },
      { status: "aborted" },
      { status: "saved", id: "note-2", pendingAfter: false },
      { status: "saved", id: "note-1", pendingAfter: true }
    ])("does not export after an unsuccessful save %j", async (result) => {
      field("flushSaves").mockResolvedValue(result);
      await send(packet());
      expect(mockNote).not.toHaveBeenCalled();
      expect(mockShare).not.toHaveBeenCalled();
    });
    it.each([
      undefined,
      { id: "note-2" },
      { id: "note-1", deleted: true },
      { id: "note-1", trashed: true }
    ])(
      "does not export a missing, wrong, deleted or trashed note %j",
      async (note) => {
        mockNote.mockResolvedValue(note);
        await send(packet());
        expect(mockExport).not.toHaveBeenCalled();
        expect(mockShare).not.toHaveBeenCalled();
      }
    );
    it("cancels a delayed lookup after A to B to A", async () => {
      const lookup = deferred<any>();
      mockNote.mockReturnValue(lookup.promise);
      const operation = harness.onMessage!(message(packet()));
      await settle();
      transition("tab-2");
      transition("tab-1");
      await act(async () => {
        lookup.resolve({ id: "note-1" });
        await operation;
      });
      expect(mockExport).not.toHaveBeenCalled();
      expect(mockShare).not.toHaveBeenCalled();
    });
    it.each([
      EditorEvents.content,
      EditorEvents.title,
      EditorEvents.contentchange
    ])(
      "invalidates Share on new editor input %s while preserving the normal save route",
      async (type) => {
        const exported = deferred<string>();
        mockExport.mockReturnValue(exported.promise);
        const operation = harness.onMessage!(message(packet()));
        await settle();
        await send({
          ...packet(),
          type,
          value: { html: "new body", title: "new title" }
        });
        await act(async () => {
          exported.resolve("old body");
          await operation;
        });
        expect(mockShare).not.toHaveBeenCalled();
        if (type !== EditorEvents.contentchange)
          expect(harness.editor.saveContent).toHaveBeenCalled();
        else
          expect(harness.editor.onContentChanged).toHaveBeenCalledWith(
            "note-1"
          );
      }
    );
    it("discards an export if the native save revision changes", async () => {
      const exported = deferred<string>();
      mockExport.mockReturnValue(exported.promise);
      const operation = harness.onMessage!(message(packet()));
      await settle();
      field("getSaveRevision").mockReturnValue(2);
      await act(async () => {
        exported.resolve("old body");
        await operation;
      });
      expect(mockShare).not.toHaveBeenCalled();
    });
    it("discards an export if another save becomes pending", async () => {
      const exported = deferred<string>();
      mockExport.mockReturnValue(exported.promise);
      const operation = harness.onMessage!(message(packet()));
      await settle();
      field("isSavePending").mockReturnValue(true);
      await act(async () => {
        exported.resolve("old body");
        await operation;
      });
      expect(mockShare).not.toHaveBeenCalled();
    });
    it("discards an export after unmount", async () => {
      const exported = deferred<string>();
      mockExport.mockReturnValue(exported.promise);
      const operation = harness.onMessage!(message(packet()));
      await settle();
      act(() => tree?.unmount());
      tree = undefined;
      exported.resolve("old body");
      await operation;
      expect(mockShare).not.toHaveBeenCalled();
    });
    it("keeps one native share flight through sheet cancellation and then allows retry", async () => {
      const sheet = deferred<void>();
      mockShare.mockReturnValueOnce(sheet.promise);
      const operation = harness.onMessage!(message(packet()));
      await settle();
      await send(packet());
      expect(mockShare).toHaveBeenCalledTimes(1);
      await act(async () => {
        sheet.resolve(undefined);
        await operation;
      });
      await send(packet());
      expect(mockShare).toHaveBeenCalledTimes(2);
    });
    it("treats an empty export as a legitimate empty note", async () => {
      mockExport.mockResolvedValue("");
      await send(packet());
      expect(mockShare).toHaveBeenCalledWith(
        expect.objectContaining({ message: "" })
      );
    });
    it("does not launch a sheet when Core refuses export", async () => {
      mockExport.mockResolvedValue(false);
      await send(packet());
      expect(mockShare).not.toHaveBeenCalled();
    });
    it.each(["membership", "encrypted fallback"])(
      "routes a locked note via the existing Vault flow: %s",
      async (mode) => {
        if (mode === "membership") mockMembership.mockResolvedValue(true);
        else
          mockContent.mockResolvedValue({
            data: { cipher: "synthetic", iv: "iv", salt: "salt" }
          });
        await send(packet());
        expect(mockExport).not.toHaveBeenCalled();
        expect(mockShare).not.toHaveBeenCalled();
        const request = mockOpenVault.mock.calls[0][0];
        expect(request.item.id).toBe("note-1");
        expect(request.shareGuard("note-1")).toBe(true);
        expect(request.shareGuard("note-2")).toBe(false);
        await send(packet());
        expect(mockOpenVault).toHaveBeenCalledTimes(1);
        transition("tab-2");
        transition("tab-1");
        expect(request.shareGuard("note-1")).toBe(false);
        request.onShareComplete();
        await send(packet());
        expect(mockOpenVault).toHaveBeenCalledTimes(2);
        request.onShareComplete();
        await send(packet());
        expect(mockOpenVault).toHaveBeenCalledTimes(2);
      }
    );
  });
});

/**
 * The toolbar preset travels with the tools: the WebView is the only client
 * that knows the host platform, so it resolves the effective groups from
 * `toolbarPreset` (see `resolveToolbarGroups`). A preset-only change - the
 * tools array byte-identical - must still be pushed to the WebView.
 */
describe("useEditorEvents toolbar settings", () => {
  let tree: ReactTestRenderer | undefined;

  const settingsPayload = (editor: Editor) => {
    const calls = editorCommands(editor).setSettings.mock.calls;
    return calls[calls.length - 1][0] as Record<string, unknown>;
  };

  const render = (editor: Editor) => {
    harness.editor = editor;
    harness.onMessage = undefined;
    act(() => {
      tree = create(
        <IPadWorkspaceProvider value={undefined}>
          <Harness />
        </IPadWorkspaceProvider>
      );
    });
  };

  const rerender = () => {
    act(() => {
      tree?.update(
        <IPadWorkspaceProvider value={undefined}>
          <Harness />
        </IPadWorkspaceProvider>
      );
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    applyGlobals();
    mockBus.reset();
    mockBackHandlers.length = 0;
    mockSettingState.deviceMode = "tablet";
    mockSettingState.fullscreen = false;
    mockDragState.data = mockTools;
    mockDragState.preset = "default";
    harness.editor = makeEditor();
    harness.onMessage = undefined;
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
    jest.useRealTimers();
  });

  it("sends both the tools and the stored preset for default, minimal and custom", () => {
    const editor = makeEditor();
    render(editor);

    expect(settingsPayload(editor).toolbarPreset).toBe("default");
    expect(settingsPayload(editor).tools).toBe(mockTools);

    mockDragState.preset = "minimal";
    rerender();
    expect(settingsPayload(editor).toolbarPreset).toBe("minimal");
    expect(settingsPayload(editor).tools).toBe(mockTools);

    mockDragState.preset = "custom";
    rerender();
    expect(settingsPayload(editor).toolbarPreset).toBe("custom");
    expect(settingsPayload(editor).tools).toBe(mockTools);
  });

  it("re-sends settings for a preset-only change with identical tools", () => {
    const editor = makeEditor();
    render(editor);
    const callsBefore = editorCommands(editor).setSettings.mock.calls.length;

    // Same tools array identity, only the preset changed.
    mockDragState.preset = "minimal";
    rerender();

    const calls = editorCommands(editor).setSettings.mock.calls;
    expect(calls.length).toBeGreaterThan(callsBefore);
    const last = calls[calls.length - 1][0] as Record<string, unknown>;
    expect(last.tools).toBe(mockTools);
    expect(last.toolbarPreset).toBe("minimal");
  });
});
