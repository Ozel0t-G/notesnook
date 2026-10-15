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
 * The real default-export `Editor`, rendered by `react-test-renderer`.
 *
 * Only the peripheral edges are mocked: RN primitives, the WebView native
 * module, the tiptap editor/event hooks, the theme/intl globals and the
 * database/biometrics/loading singletons. The `hideKeyboardAccessoryView`
 * prop read off the rendered WebView, and the tab store that feeds it, are
 * produced by the production component itself.
 *
 * `useTabStore` is mocked as a real subscribable store (backed by
 * `useSyncExternalStore`), not a getState-only callable, so that mutating it
 * from the test re-renders the already-mounted `Editor` exactly as the real
 * store would. `Editor` is wrapped in `React.memo(() => true)`, which only
 * blocks re-renders triggered by a parent passing new props - it has no say
 * over a re-render the component triggers itself through its own store
 * subscription, which is what every reactive test below relies on.
 */

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { Platform } from "react-native";

jest.mock("react-native", () => ({
  Platform: { OS: "ios", isPad: false }
}));

jest.mock("react-native-webview", () => "WebView");
jest.mock("react-native-webview/lib/WebViewTypes", () => ({}));

jest.mock("../../../e2e/test.ids", () => ({
  notesnook: { editor: { id: "editor-webview" } }
}));

jest.mock("../../common/database", () => ({
  db: {
    vault: {
      open: jest.fn(),
      unlock: jest.fn()
    }
  }
}));

jest.mock("../../services/biometrics", () => ({
  __esModule: true,
  default: {
    getCredentials: jest.fn(),
    storeCredentials: jest.fn(),
    isBiometryAvailable: jest.fn(),
    hasInternetCredentials: jest.fn()
  }
}));

jest.mock("../../services/event-manager", () => ({
  ToastManager: { show: jest.fn() },
  eSendEvent: jest.fn(),
  eSubscribeEvent: jest.fn(() => ({ unsubscribe: jest.fn() }))
}));

jest.mock("../../utils/events", () => ({
  eEditorReset: "eEditorReset",
  eOnLoadNote: "eOnLoadNote",
  eUnlockNote: "eUnlockNote",
  eUnlockWithBiometrics: "eUnlockWithBiometrics",
  eUnlockWithPassword: "eUnlockWithPassword"
}));

jest.mock("../../utils/functions", () => ({
  openLinkInBrowser: jest.fn()
}));

jest.mock("../../utils/global-refs", () => ({
  fluidTabsRef: { current: null }
}));

jest.mock("../../utils/constants", () => ({
  isMacCatalyst: jest.fn(() => false)
}));

jest.mock("../../hooks/use-vault-status", () => ({
  useVaultStatus: jest.fn(() => ({
    isBiometryAvailable: false,
    biometryEnrolled: false
  }))
}));

jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => ({ deviceMode: "mobile" })
  }
}));

jest.mock("../../services/handwriting/utils", () => ({
  isHandwritingSupported: jest.fn(() => false)
}));

jest.mock("@notesnook/theme", () => ({
  useThemeEngineStore: (selector: (s: { theme: Record<string, unknown> }) => unknown) =>
    selector({ theme: {} })
}));

jest.mock("@lingui/core", () => ({
  i18n: { locale: "en", messages: {} }
}));

jest.mock("@notesnook/intl", () => ({
  strings: {
    passwordNotEntered: () => "password-not-entered",
    passwordIncorrect: () => "password-incorrect",
    biometricUnlockEnabled: () => "biometric-unlock-enabled"
  }
}));

jest.mock("@notesnook/editor-mobile/src/utils/native-events", () => ({
  NativeEvents: { resolve: "resolve" }
}));

jest.mock("./source", () => ({
  EDITOR_URI: "test://editor"
}));

jest.mock("./loading", () => ({
  __esModule: true,
  default: () => null
}));

jest.mock("./tiptap/utils", () => ({
  editorController: { current: null },
  editorState: jest.fn(() => ({ movedAway: false })),
  openInternalLink: jest.fn(),
  randId: (prefix: string) => `${prefix}-test`
}));

/**
 * `useEditor` is mocked to return the same object for the lifetime of a
 * single component instance (via `useRef`), and to count real mount/unmount
 * effect runs. That gives the reactive tests an honest "no remount" signal:
 * a remount would show up as a second mount (and an unmount) here, whereas a
 * store-driven re-render of the same instance leaves the counters untouched.
 */
jest.mock("./tiptap/use-editor", () => {
  const ReactLib = require("react") as typeof import("react");
  let mounts = 0;
  let unmounts = 0;

  const useEditor = () => {
    const ref = ReactLib.useRef<{
      state: { current: { ready: boolean; initialLoadCalled: boolean } };
      loading: boolean;
      setLoading: (...args: unknown[]) => void;
      ref: { current: unknown };
    } | null>(null);

    if (!ref.current) {
      ref.current = {
        state: { current: { ready: true, initialLoadCalled: true } },
        loading: false,
        setLoading: jest.fn(),
        ref: { current: null }
      };
    }

    ReactLib.useEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);

    return ref.current;
  };

  return {
    __esModule: true,
    useEditor,
    __mountStats: () => ({ mounts, unmounts }),
    __resetMountStats: () => {
      mounts = 0;
      unmounts = 0;
    }
  };
});

jest.mock("./tiptap/use-editor-events", () => ({
  __esModule: true,
  useEditorEvents: jest.fn(() => undefined)
}));

/**
 * A real subscribable tab store: `useTabStore` runs through
 * `useSyncExternalStore`, so `Editor`'s own subscription re-renders it when
 * the store changes, independently of its memo comparator. `getTab`/
 * `updateTab` are stable closures over the mutable `state` variable (not
 * baked into a stale snapshot), matching how the production store behaves,
 * and sub-objects (tabs, sessions) keep their identity across snapshots that
 * didn't change them, so the selectors used by `Editor` don't spin.
 */
jest.mock("./tiptap/use-tab-store", () => {
  const ReactLib = require("react");

  type Session = {
    noteId?: string;
    locked?: boolean;
    readonly?: boolean;
    noteLocked?: boolean;
  };
  type Tab = { id: string; session?: Session };
  type Snapshot = {
    currentTab: string;
    tabs: Tab[];
    biometryAvailable: boolean;
    biometryEnrolled: boolean;
    getTab: (id: string) => Tab | undefined;
    updateTab: (id: string, patch: { session?: Partial<Session> }) => void;
  };

  let state: { currentTab: string; tabs: Tab[]; biometryAvailable: boolean; biometryEnrolled: boolean } = {
    currentTab: "tab-1",
    tabs: [{ id: "tab-1" }],
    biometryAvailable: false,
    biometryEnrolled: false
  };

  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const getTab = (id: string) => state.tabs.find((t) => t.id === id);
  const updateTab = (id: string, patch: { session?: Partial<Session> }) => {
    state = {
      ...state,
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, session: { ...t.session, ...patch.session } } : t
      )
    };
    notify();
  };

  const getState = (): Snapshot => ({ ...state, getTab, updateTab });

  const useTabStore = <T,>(selector: (s: Snapshot) => T): T =>
    ReactLib.useSyncExternalStore(subscribe, () => selector(getState()));

  useTabStore.getState = getState;
  useTabStore.setState = (
    patch: Partial<Pick<typeof state, "biometryAvailable" | "biometryEnrolled">>
  ) => {
    state = { ...state, ...patch };
    notify();
  };
  useTabStore.__reset = (config: { tabs: Tab[]; currentTab: string }) => {
    state = {
      currentTab: config.currentTab,
      tabs: config.tabs,
      biometryAvailable: false,
      biometryEnrolled: false
    };
    notify();
  };
  useTabStore.__setCurrentTab = (id: string) => {
    state = { ...state, currentTab: id };
    notify();
  };
  useTabStore.__setSession = (tabId: string, session: Session | undefined) => {
    state = {
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, session } : t))
    };
    notify();
  };

  return { __esModule: true, useTabStore, syncTabs: jest.fn() };
});

import Editor from "./index";
import { isMacCatalyst } from "../../utils/constants";
import { useTabStore } from "./tiptap/use-tab-store";
import type { EditorProps, useEditorType } from "./tiptap/types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Session = {
  noteId?: string;
  locked?: boolean;
  readonly?: boolean;
  noteLocked?: boolean;
};
type Tab = { id: string; session?: Session };
type TabStoreSnapshot = {
  currentTab: string;
  tabs: Tab[];
  biometryAvailable: boolean;
  biometryEnrolled: boolean;
  getTab: (id: string) => Tab | undefined;
  updateTab: (id: string, patch: { session?: Partial<Session> }) => void;
};
type TabStoreMock = {
  <T>(selector: (s: TabStoreSnapshot) => T): T;
  getState: () => TabStoreSnapshot;
  setState: (
    patch: Partial<Pick<TabStoreSnapshot, "biometryAvailable" | "biometryEnrolled">>
  ) => void;
  __reset: (config: { tabs: Tab[]; currentTab: string }) => void;
  __setCurrentTab: (id: string) => void;
  __setSession: (tabId: string, session: Session | undefined) => void;
};

type UseEditorMockModule = {
  __mountStats: () => { mounts: number; unmounts: number };
  __resetMountStats: () => void;
};

const tabStore = useTabStore as unknown as TabStoreMock;
const mockIsMacCatalyst = isMacCatalyst as unknown as ReturnType<typeof jest.fn>;

const EDITOR_TEST_ID = "editor-webview";

const setPlatform = (os: string) => {
  (Platform as unknown as { OS: string }).OS = os;
};

const mountStats = () =>
  (jest.requireMock("./tiptap/use-editor") as UseEditorMockModule).__mountStats();
const resetMountStats = () =>
  (jest.requireMock("./tiptap/use-editor") as UseEditorMockModule).__resetMountStats();

const baseTab = (overrides: Partial<Session> = {}): Tab[] => [
  {
    id: "tab-1",
    session: {
      noteId: "note-1",
      locked: false,
      readonly: false,
      noteLocked: false,
      ...overrides
    }
  }
];

type EditorRef = { get: () => useEditorType };

let tree: ReactTestRenderer | undefined;

afterEach(() => {
  if (tree) {
    act(() => {
      tree?.unmount();
    });
  }
  tree = undefined;
});

beforeEach(() => {
  setPlatform("ios");
  mockIsMacCatalyst.mockReturnValue(false);
  tabStore.__reset({ tabs: baseTab(), currentTab: "tab-1" });
  resetMountStats();
});

const renderEditor = (
  props: Partial<EditorProps> = {},
  ref: React.RefObject<EditorRef | null> = React.createRef<EditorRef | null>()
) => {
  const devGlobal = globalThis as typeof globalThis & { __DEV__?: boolean };
  const previousDev = devGlobal.__DEV__;
  devGlobal.__DEV__ = false;
  act(() => {
    tree = create(<Editor ref={ref} {...props} />);
  });
  devGlobal.__DEV__ = previousDev;
  return { tree: tree as ReactTestRenderer, ref };
};

const getWebView = (t: ReactTestRenderer) =>
  t.root.findByProps({ testID: EDITOR_TEST_ID });

const hideAccessory = (t: ReactTestRenderer) =>
  getWebView(t).props.hideKeyboardAccessoryView as boolean;

describe("Editor hideKeyboardAccessoryView - static conditions", () => {
  it("is true for the editable main editor on iOS, on both iPhone and iPad shapes", () => {
    (Platform as unknown as { isPad: boolean }).isPad = false;
    const { tree: iphone } = renderEditor();
    expect(hideAccessory(iphone)).toBe(true);
    act(() => iphone.unmount());

    (Platform as unknown as { isPad: boolean }).isPad = true;
    const { tree: ipad } = renderEditor();
    expect(hideAccessory(ipad)).toBe(true);
  });

  it("is false on Android", () => {
    setPlatform("android");
    const { tree } = renderEditor();
    expect(hideAccessory(tree)).toBe(false);
  });

  it("is false under Mac Catalyst even though the OS still reports ios", () => {
    mockIsMacCatalyst.mockReturnValue(true);
    const { tree } = renderEditor();
    expect(hideAccessory(tree)).toBe(false);
  });

  it("is false when the editor itself is opened readonly", () => {
    const { tree } = renderEditor({ readonly: true });
    expect(hideAccessory(tree)).toBe(false);
  });

  it("is false when the session is readonly", () => {
    tabStore.__reset({ tabs: baseTab({ readonly: true }), currentTab: "tab-1" });
    const { tree } = renderEditor();
    expect(hideAccessory(tree)).toBe(false);
  });

  it("is false when the session is locked", () => {
    tabStore.__reset({ tabs: baseTab({ locked: true }), currentTab: "tab-1" });
    const { tree } = renderEditor();
    expect(hideAccessory(tree)).toBe(false);
  });

  it("is false when the current tab has no session yet", () => {
    tabStore.__reset({ tabs: [{ id: "tab-1" }], currentTab: "tab-1" });
    const { tree } = renderEditor();
    expect(hideAccessory(tree)).toBe(false);
  });

  it("is false when the header is suppressed", () => {
    const { tree } = renderEditor({ noHeader: true });
    expect(hideAccessory(tree)).toBe(false);
  });

  it("is false when the editor does not own the controller", () => {
    const { tree } = renderEditor({ withController: false });
    expect(hideAccessory(tree)).toBe(false);
  });

  it("is false for a secondary editor identified by a non-empty editorId", () => {
    const { tree } = renderEditor({ editorId: "secondary" });
    expect(hideAccessory(tree)).toBe(false);
  });
});

describe("Editor hideKeyboardAccessoryView - reactive store updates on the mounted editor", () => {
  it("relocks a noteLocked session at mount, which leaves the prop false", () => {
    tabStore.__reset({
      tabs: baseTab({ noteLocked: true, locked: false }),
      currentTab: "tab-1"
    });
    const { tree } = renderEditor();

    // The legacy relock effect in useLockedNoteHandler (left untouched) has
    // already forced a noteLocked session back to locked inside this act().
    expect(tabStore.getState().getTab("tab-1")?.session?.locked).toBe(true);
    expect(hideAccessory(tree)).toBe(false);
    // Its sibling biometry-sync effect (also untouched) ran alongside it.
    expect(tabStore.getState().biometryAvailable).toBe(false);
    expect(mountStats().mounts).toBe(1);
  });

  it("flips true to false and back when the current tab's session locks and unlocks, without remounting", () => {
    const { tree, ref } = renderEditor();
    expect(hideAccessory(tree)).toBe(true);
    const editorInstance = ref.current?.get();

    act(() => {
      tabStore.__setSession("tab-1", {
        noteId: "note-1",
        locked: true,
        readonly: false,
        noteLocked: false
      });
    });

    expect(hideAccessory(tree)).toBe(false);
    expect(ref.current?.get()).toBe(editorInstance);
    expect(mountStats().mounts).toBe(1);
    expect(mountStats().unmounts).toBe(0);

    act(() => {
      tabStore.__setSession("tab-1", {
        noteId: "note-1",
        locked: false,
        readonly: false,
        noteLocked: false
      });
    });

    expect(hideAccessory(tree)).toBe(true);
    expect(ref.current?.get()).toBe(editorInstance);
    expect(mountStats().mounts).toBe(1);
  });

  it("flips true to false when the current tab's session turns readonly, without remounting", () => {
    const { tree, ref } = renderEditor();
    expect(hideAccessory(tree)).toBe(true);
    const editorInstance = ref.current?.get();

    act(() => {
      tabStore.__setSession("tab-1", {
        noteId: "note-1",
        locked: false,
        readonly: true,
        noteLocked: false
      });
    });

    expect(hideAccessory(tree)).toBe(false);
    expect(ref.current?.get()).toBe(editorInstance);
    expect(mountStats().mounts).toBe(1);
    expect(mountStats().unmounts).toBe(0);
  });

  it("follows the active tab when currentTab switches to a locked tab and back, without remounting", () => {
    tabStore.__reset({
      tabs: [
        {
          id: "tab-1",
          session: { noteId: "note-1", locked: false, readonly: false, noteLocked: false }
        },
        {
          id: "tab-2",
          session: { noteId: "note-2", locked: true, readonly: false, noteLocked: false }
        }
      ],
      currentTab: "tab-1"
    });
    const { tree, ref } = renderEditor();
    expect(hideAccessory(tree)).toBe(true);
    const editorInstance = ref.current?.get();

    act(() => {
      tabStore.__setCurrentTab("tab-2");
    });

    expect(hideAccessory(tree)).toBe(false);
    expect(ref.current?.get()).toBe(editorInstance);
    expect(mountStats().mounts).toBe(1);
    expect(mountStats().unmounts).toBe(0);

    act(() => {
      tabStore.__setCurrentTab("tab-1");
    });

    expect(hideAccessory(tree)).toBe(true);
    expect(ref.current?.get()).toBe(editorInstance);
    expect(mountStats().mounts).toBe(1);
  });

  it("is false when the current tab has no session at mount, then becomes true once a known unlocked, read-write session is delivered, without remounting", () => {
    tabStore.__reset({ tabs: [{ id: "tab-1" }], currentTab: "tab-1" });
    const { tree, ref } = renderEditor();
    expect(hideAccessory(tree)).toBe(false);
    const editorInstance = ref.current?.get();

    act(() => {
      tabStore.__setSession("tab-1", {
        noteId: "note-1",
        locked: false,
        readonly: false,
        noteLocked: false
      });
    });

    expect(hideAccessory(tree)).toBe(true);
    expect(ref.current?.get()).toBe(editorInstance);
    expect(mountStats().mounts).toBe(1);
    expect(mountStats().unmounts).toBe(0);
  });

  it("stays true once the legacy relock hook's noteLocked session is superseded post-mount by an unlocked session, without remounting", () => {
    tabStore.__reset({
      tabs: baseTab({ noteLocked: true, locked: false }),
      currentTab: "tab-1"
    });
    const { tree, ref } = renderEditor();
    expect(tabStore.getState().getTab("tab-1")?.session?.locked).toBe(true);
    expect(hideAccessory(tree)).toBe(false);
    const editorInstance = ref.current?.get();

    act(() => {
      tabStore.__setSession("tab-1", {
        noteId: "note-1",
        locked: false,
        readonly: false,
        noteLocked: true
      });
    });

    expect(hideAccessory(tree)).toBe(true);
    expect(ref.current?.get()).toBe(editorInstance);
    expect(mountStats().mounts).toBe(1);
    expect(mountStats().unmounts).toBe(0);
  });
});
