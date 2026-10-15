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
 * iPad workspace behaviour of the Library column, with the real `Library`,
 * the real `NoteCollection` and the real `IPadWorkspaceProvider`.
 *
 * Only the peripheral edges are mocked: the database/refresh stores, the heavy
 * native list/header/selection widgets and the navigation service. The pane
 * logic under test (`utils/ipad-layout` + `components/ipad-workspace-context`)
 * is the production code.
 */

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";

let mockNotebooks: { id: string; title: string }[] = [];
let mockTags: { id: string; title: string }[] = [];
let mockOS = "ios";
let mockDeviceMode: string | undefined = "tablet";
const mockStrings: Record<string, string> = {};
const mockRoutes: Record<string, string> = {
  Library: "Library",
  Settings: "Settings",
  AllNotes: "All Notes",
  Inbox: "Inbox",
  Notebooks: "Notebooks",
  Tags: "Tags",
  Favorites: "Favorites",
  Monographs: "Monographs",
  Archive: "Archive",
  Templates: "Templates",
  Trash: "Trash"
};

jest.mock("@notesnook/intl", () => {
  const routes = new Proxy(
    {},
    {
      get: (_target, key) => {
        const route = mockRoutes[String(key)];
        return route === undefined ? undefined : () => route;
      }
    }
  );
  const strings = new Proxy(
    {},
    {
      get: (_target, key) => {
        const name = String(key);
        if (name === "routes") return routes;
        if (name === "selectedCode") return (n: number) => `${n} selected`;
        if (name === "searchInRoute")
          return (title: string) => `Search in ${title}`;
        if (name === "notes") return (n: number) => `${n} notes`;
        return () => mockStrings[name] ?? name;
      }
    }
  );
  return { strings };
});

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: { accent: "#0a84ff", heading: "#000", paragraph: "#000" },
      secondary: { icon: "#666", paragraph: "#666" },
      selected: { icon: "#0a84ff", paragraph: "#000" },
      static: { yellow: "#ffcc00" }
    },
    isDark: false
  })
}));

jest.mock("@notesnook/core", () => ({
  EVENTS: { databaseUpdated: "databaseUpdated", syncCompleted: "syncCompleted" }
}));

jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  FlatList: "FlatList",
  Platform: {
    get OS() {
      return mockOS;
    },
    isPad: true,
    isMacCatalyst: false
  },
  BackHandler: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) }
}));

jest.mock("../../utils/constants", () => ({
  isMacCatalyst: jest.fn(() => false)
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}));

jest.mock("../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: mockOS === "ios",
    screenBackground: "#ffffff",
    primaryText: "#000000",
    secondaryText: "#666666",
    tertiaryText: "#999999",
    separator: "#dddddd",
    contentSurface: "#f2f2f7",
    selectedSurface: "#e5e5ea",
    sectionSpacing: 20,
    pagePadding: 16,
    controlRadius: 10,
    sidebarBackground: "#f2f2f7",
    navigationSurface: "#ffffff",
    navigationMaterialOpacity: 1
  })
}));

jest.mock("../../utils/styles", () => ({
  DefaultAppStyles: {
    GAP: 12,
    GAP_VERTICAL: 8,
    GAP_VERTICAL_SMALL: 4,
    GAP_SMALL: 6
  }
}));

/**
 * The real event-manager is replaced by a *working* in-test bus, not by inert
 * spies: the collection under test subscribes to it and the suite then fires
 * the very events a save really produces (`EVENTS.databaseUpdated` through
 * `db.eventManager` for the notes/relations/notebooks writes and
 * `EVENTS.syncCompleted`), which is what makes the stale -> fresh assertions
 * below meaningful. There is no app-level note-edited event: nothing in the app
 * publishes one, so the suite does not invent one either.
 */
jest.mock("../../services/event-manager", () => {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    eSubscribeEvent: (name: string, callback: (payload?: unknown) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(callback);
      return { unsubscribe: () => handlers.get(name)?.delete(callback) };
    },
    eUnSubscribeEvent: (
      name: string,
      callback: (payload?: unknown) => void
    ) => {
      handlers.get(name)?.delete(callback);
    },
    eSendEvent: (name: string, payload?: unknown) => {
      handlers.get(name)?.forEach((callback) => callback(payload));
    },
    sendItemUpdateEvent: jest.fn(),
    subscribeToItemUpdate: jest.fn(),
    presentSheet: jest.fn(),
    ToastManager: { error: jest.fn(), show: jest.fn() }
  };
});

/**
 * The fake database: real rows a "save" mutates, plus a working event manager,
 * so the collection's own subscriptions receive exactly what the app publishes.
 */
jest.mock("../../common/database", () => {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  const rows: Record<
    string,
    { id: string; title: string; dateEdited: number }[]
  > = {
    "all-notes": [{ id: "alpha", title: "Alpha", dateEdited: 1000 }],
    inbox: [{ id: "beta", title: "Beta", dateEdited: 1000 }]
  };
  const db = {
    isInitialized: true,
    eventManager: {
      subscribe: (name: string, callback: (payload?: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(callback);
        return { unsubscribe: () => handlers.get(name)?.delete(callback) };
      },
      publish: (name: string, payload?: unknown) => {
        handlers.get(name)?.forEach((callback) => callback(payload));
        return true;
      }
    },
    notes: {
      all: { count: jest.fn(async () => rows["all-notes"].length) },
      unassigned: { count: jest.fn(async () => rows.inbox.length) }
    },
    settings: { setSideBarOrder: jest.fn(), setSideBarHiddenItems: jest.fn() }
  };
  return { db, __db: { rows } };
});

jest.mock("../../services/navigation", () => ({
  __esModule: true,
  default: {
    navigate: jest.fn(),
    push: jest.fn(),
    goBack: jest.fn(),
    openDrawer: jest.fn(),
    closeDrawer: jest.fn()
  }
}));

jest.mock("../../utils/events", () => ({
  eGroupOptionsUpdated: "eGroupOptionsUpdated",
  eScrollEvent: "eScrollEvent",
  eAfterSync: "eAfterSync",
  eMenuItemUpdate: "eMenuItemUpdate"
}));

jest.mock("../../navigation/navigation-stack", () => ({
  selectAppleSection: jest.fn()
}));

/**
 * The focused-route store keeps *state*, not a bare spy: the collection
 * publishes the id it shows and its cleanup may restore an older one, and the
 * ownership tests read exactly that value. A Notebook taking over (as
 * `screens/notebook` does after loading) is modelled by setting
 * `focusedRouteId` directly.
 */
jest.mock("../../stores/use-navigation-store", () => {
  const state = {
    focusedRouteId: "Library" as string | undefined,
    currentRoute: "Library",
    setFocusedRouteId: (id?: string) => {
      state.focusedRouteId = id;
    }
  };
  const useNavigationStore = Object.assign(
    jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    { getState: () => state }
  );
  return { __esModule: true, default: useNavigationStore, __navState: state };
});

jest.mock("../../stores/use-selection-store", () => {
  const state = { selectionMode: false, selectedItemsList: [] as string[] };
  const useSelectionStore = Object.assign(
    jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    { getState: () => state }
  );
  return { useSelectionStore };
});

jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: (selector: (s: unknown) => unknown) =>
    selector({
      deviceMode: mockDeviceMode,
      isAppLoading: false,
      settings: { introCompleted: true }
    })
}));

type MockRow = { id: string; title: string; dateEdited: number };

type MockCollectionStore = {
  state: { data: unknown; refreshes: number; listeners: Set<() => void> };
  reset: () => void;
  seed: () => void;
  refresh: () => void;
  subscribe: (listener: () => void) => () => void;
};

/**
 * The two collection-store mocks, built by one factory.
 *
 * They keep the real hook's shape - `[items, loading, refresh]` - but are backed
 * by the fake database rows above, so `refresh()` re-reads whatever a "save"
 * has written in the meantime, exactly like `createDBCollectionStore` re-reads
 * its selector. Like the real refresh, it emits `eMenuItemUpdate`; the Library
 * listens to nothing that the refresh emits, which is what keeps it from
 * looping.
 *
 * A function declaration (not a `const` arrow) because `jest.mock` factories are
 * hoisted above it and run while the test module's imports are being resolved.
 */
function mockCreateCollectionStoreModule(
  React: typeof import("react"),
  db: { rows: Record<string, MockRow[]> },
  kind: string,
  eSendEvent: (name: string, payload?: unknown) => void,
  eMenuItemUpdate: string,
  hookName: string
): Record<string, unknown> {
  const state: MockCollectionStore["state"] = {
    data: undefined,
    refreshes: 0,
    listeners: new Set<() => void>()
  };
  const build = () => {
    // A snapshot, like a fresh grouping's own rows: a row edited after this
    // build must not leak into it, or the "stale" state could not be asserted.
    const rows = db.rows[kind].slice();
    return {
      placeholders: rows.map((row) => ({ type: "note", id: row.id })),
      type: () => "note",
      length: rows.length,
      item: async (index: number) => rows[index]
    };
  };
  const store: MockCollectionStore = {
    state,
    reset: () => {
      state.data = undefined;
      state.refreshes = 0;
    },
    seed: () => {
      state.data = build();
    },
    refresh: () => {
      state.refreshes += 1;
      state.data = build();
      state.listeners.forEach((listener) => listener());
      eSendEvent(eMenuItemUpdate);
    },
    subscribe: (listener: () => void) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    }
  };
  const useCollection = () => {
    const data = React.useSyncExternalStore(store.subscribe, () => state.data);
    const refresh = React.useCallback(
      () => Promise.resolve(store.refresh()),
      []
    );
    return [data, false, refresh];
  };
  return { [hookName]: useCollection, __store: store };
}

jest.mock("../../stores/use-notes-store", () => {
  const React = require("react");
  const { __db } = require("../../common/database");
  const { eSendEvent } = require("../../services/event-manager");
  const { eMenuItemUpdate } = require("../../utils/events");
  return mockCreateCollectionStoreModule(
    React,
    __db,
    "all-notes",
    eSendEvent,
    eMenuItemUpdate,
    "useNotes"
  );
});

jest.mock("../../stores/use-inbox-store", () => {
  const React = require("react");
  const { __db } = require("../../common/database");
  const { eSendEvent } = require("../../services/event-manager");
  const { eMenuItemUpdate } = require("../../utils/events");
  return mockCreateCollectionStoreModule(
    React,
    __db,
    "inbox",
    eSendEvent,
    eMenuItemUpdate,
    "useInboxNotes"
  );
});

jest.mock("../../utils/size", () => ({ AppFontSize: { md: 16.5 } }));

jest.mock("../../hooks/use-library-source-list", () => ({
  useLibrarySourceList: () => ({
    notebooks: mockNotebooks,
    tags: mockTags,
    counts: { allNotes: 0, inbox: 0, templates: 0 },
    notebookCounts: {},
    tagCounts: {}
  })
}));

jest.mock("../../components/apple-tab-bar", () => ({
  APPLE_TAB_BAR_HEIGHT: 49,
  hasBottomTabBar: () => false
}));

jest.mock("../../components/task-symbol-view", () => ({
  TaskSymbolView: (props: unknown) => {
    const React = require("react");
    return React.createElement("TaskSymbolView", props);
  }
}));

jest.mock("../../components/ios-nav-bar", () => {
  const React = require("react");
  return {
    IosNavBar: (props: Record<string, unknown>) =>
      React.createElement("IosNavBar", props, props.leading, props.trailing),
    IosLargeTitle: (props: Record<string, unknown>) =>
      React.createElement("IosLargeTitle", props),
    IosBarButton: (props: Record<string, unknown>) =>
      React.createElement("IosBarButton", props)
  };
});

jest.mock("../../components/header/account-affordance", () => {
  const React = require("react");
  return {
    AccountAffordance: ({ testID }: { testID?: string }) =>
      React.createElement("AccountAffordance", { testID })
  };
});

jest.mock("../../components/sheets/add-notebook", () => ({
  AddNotebookSheet: { present: jest.fn() }
}));

/**
 * A probe in place of the heavy note-list header: it exposes exactly what
 * `NoteCollection` feeds it (the collection id, whether the leading account
 * affordance and the back/drawer action are wired) and counts its own mounts so
 * the suite can prove the list column is *retained*, not remounted, as widths
 * change.
 */
jest.mock("../../components/header", () => {
  const React = require("react");
  const state: {
    mounts: number;
    unmounts: number;
    renders: number;
    latest: Record<string, unknown> | null;
  } = { mounts: 0, unmounts: 0, renders: 0, latest: null };
  const Header = (props: Record<string, unknown>) => {
    state.renders += 1;
    state.latest = props;
    React.useEffect(() => {
      state.mounts += 1;
      return () => {
        state.unmounts += 1;
      };
    }, []);
    return React.createElement("HeaderProbe", props);
  };
  return { Header, __probeState: state };
});

jest.mock("../../components/delay-layout", () => ({
  __esModule: true,
  default: (props: { children?: React.ReactNode }) => {
    const React = require("react");
    return React.createElement("DelayLayout", null, props.children);
  }
}));

jest.mock("../../components/list", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("List", props);
  }
}));

jest.mock("../../components/selection-header", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("SelectionHeader", props);
  }
}));

jest.mock("../../components/container/floating-button", () => ({
  FloatingButton: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("FloatingButton", props);
  }
}));

/**
 * A *functional* first-save probe instead of inert spies: the production
 * helpers are the exact seam the defect ran through (a background collection
 * called `setOnFirstSaveUnassigned`, and its cleanup called `setOnFirstSave(null)`
 * over a Notebook's registration). The mock keeps the same single
 * "onNoteCreated" slot the real `editorState()` carries, so the suite can assert
 * what a note created from the header would be filed with - not merely that some
 * helper was called.
 */
jest.mock("../notes/common", () => {
  const state = {
    onNoteCreated: null as null | { type: string; id?: string },
    unassigned: false
  };
  return {
    openEditor: jest.fn(),
    setOnFirstSave: jest.fn((data: { type: string; id: string } | null) => {
      state.onNoteCreated = data;
      state.unassigned = false;
    }),
    setOnFirstSaveUnassigned: jest.fn(() => {
      state.onNoteCreated = { type: "unassigned" };
      state.unassigned = true;
    }),
    __firstSaveState: state
  };
});

import Library from "./index";
import { Platform } from "react-native";
import { useMacSidebarSectionsStore } from "../../stores/use-mac-sidebar-sections-store";
import { IPadWorkspaceProvider } from "../../components/ipad-workspace-context";
import type { IPadPaneMode } from "../../utils/ipad-layout";
import { isMacCatalyst } from "../../utils/constants";
import Navigation from "../../services/navigation";
import { db } from "../../common/database";
import { EVENTS } from "@notesnook/core";
import { eSendEvent } from "../../services/event-manager";
import { eMenuItemUpdate } from "../../utils/events";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeState = {
  mounts: number;
  unmounts: number;
  renders: number;
  latest: Record<string, unknown> | null;
};

const probeState = () =>
  (jest.requireMock("../../components/header") as { __probeState: ProbeState })
    .__probeState;

type FakeRow = { id: string; title: string; dateEdited: number };

/** The fake database rows the collection stores read (see the db mock). */
const fakeRows = () =>
  (
    jest.requireMock("../../common/database") as {
      __db: { rows: Record<"all-notes" | "inbox", FakeRow[]> };
    }
  ).__db.rows;

const allNotesStore = () =>
  (
    jest.requireMock("../../stores/use-notes-store") as {
      __store: MockCollectionStore;
    }
  ).__store;

const inboxStore = () =>
  (
    jest.requireMock("../../stores/use-inbox-store") as {
      __store: MockCollectionStore;
    }
  ).__store;

/**
 * The same event manager the collection subscribes through, so the suite fires
 * the events a save really fires instead of calling the refresh by hand.
 */
const databaseEvents = () =>
  db.eventManager as unknown as {
    publish: (name: string, payload?: unknown) => void;
  };

/**
 * The navigator's live focus, as `navigation.isFocused()` reports it. It is
 * mutable so a test can put the Library behind a Notebook; the production
 * screen reads it both for the initial ownership state and, later, in the
 * effect cleanup that must not clear a newer owner.
 */
let navigatorFocused = true;
/**
 * When true, registering the *focus* subscription flips `navigatorFocused` to
 * true without invoking the callback - i.e. focus changed between the render
 * and the subscription. The screen's post-subscribe re-check is what has to
 * reconcile it.
 */
let flipFocusedOnFocusSubscribe = false;
/**
 * When true, `navigation.isFocused()` reports `true` for its very first read
 * only, then falls back to `navigatorFocused`. The first read seeds the
 * Library's ownership snapshot, so this reproduces focus being lost between
 * that render and the child collection's passive effect - before the Library's
 * post-subscribe re-check can correct the snapshot.
 */
let focusedOnFirstReadOnly = false;
/** How many times `navigation.isFocused()` has been read this test. */
let navigatorFocusReads = 0;

const focusListeners: (() => void)[] = [];
const blurListeners: (() => void)[] = [];

const navigation = {
  navigate: jest.fn(),
  push: jest.fn(),
  goBack: jest.fn(),
  isFocused: () => {
    navigatorFocusReads += 1;
    if (focusedOnFirstReadOnly && navigatorFocusReads === 1) return true;
    return navigatorFocused;
  },
  addListener: jest.fn((name: string, callback: () => void) => {
    const listeners =
      name === "focus"
        ? focusListeners
        : name === "blur"
        ? blurListeners
        : undefined;
    if (name === "focus" && flipFocusedOnFocusSubscribe)
      navigatorFocused = true;
    listeners?.push(callback);
    return () => {
      if (!listeners) return;
      const index = listeners.indexOf(callback);
      if (index !== -1) listeners.splice(index, 1);
    };
  })
};

/** What `jest.requireMock("./../stores/use-navigation-store")` holds. */
const navState = () =>
  (
    jest.requireMock("../../stores/use-navigation-store") as {
      __navState: { focusedRouteId?: string };
    }
  ).__navState;

type FirstSaveState = {
  onNoteCreated: null | { type: string; id?: string };
  unassigned: boolean;
};

/** The production first-save slot the collection publishes into. */
const firstSave = () =>
  (jest.requireMock("../notes/common") as { __firstSaveState: FirstSaveState })
    .__firstSaveState;

/** The navigator focuses the Library again (the pushed screen was popped). */
const fireFocus = () =>
  act(() => {
    navigatorFocused = true;
    [...focusListeners].forEach((listener) => listener());
  });

/** The navigator blurs the Library (a Notebook was pushed over it). */
const fireBlur = () =>
  act(() => {
    navigatorFocused = false;
    [...blurListeners].forEach((listener) => listener());
  });

function workspaceValue(paneMode: IPadPaneMode, sidebarVisible: boolean) {
  return { paneMode, sidebarVisible };
}

describe("Library iPad column", () => {
  let tree: ReactTestRenderer | undefined;

  it("keeps Settings reachable through its separate named gear on the phone Library", () => {
    mockDeviceMode = "mobile";
    render(undefined, false);
    const gear = tree?.root.findAllByProps({ testID: "library-settings" })[0];
    expect(gear?.props.accessibilityLabel).toBe("Settings");
    const select =
      require("../../navigation/navigation-stack").selectAppleSection;
    select.mockClear();
    act(() => gear?.props.onPress());
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("settings");
  });

  it("gives phone sections 44pt targets, wraps labels and keeps notebook/tag routes through real collapse state", () => {
    if (Platform.OS === "ios") Platform.isPad = false;
    mockDeviceMode = "mobile";
    mockNotebooks = [
      {
        id: "book",
        title: "Ein langes Notebook mit mehreren sinnvollen Zeilen"
      }
    ];
    mockTags = [{ id: "tag", title: "Ein langes Schlagwort" }];
    render(undefined, false);
    const section = () =>
      tree!.root.findByProps({ accessibilityLabel: "Notebooks" });
    expect(section().props.style.minHeight).toBe(44);
    expect(section().props.accessibilityState).toEqual({ expanded: true });
    const notebook = () =>
      tree!.root.findByProps({
        accessibilityLabel: `${mockNotebooks[0].title}, 0 notes`
      });
    expect(
      notebook().findAllByType("Text" as never)[0].props.numberOfLines
    ).toBe(2);
    // Match the actual iOS pagePadding=16 token; both content starts are 32pt.
    expect(notebook().props.style.marginHorizontal).toBe(16);
    expect(notebook().props.style.paddingHorizontal).toBe(16);
    expect(section().parent!.props.style.marginLeft).toBe(32);
    expect(section().parent!.props.style.marginLeft).toBe(
      notebook().props.style.marginHorizontal +
        notebook().props.style.paddingHorizontal
    );
    act(() => notebook().props.onPress());
    expect(navigation.navigate).toHaveBeenLastCalledWith("Notebook", {
      id: "book",
      canGoBack: true
    });
    act(() => section().props.onPress());
    expect(section().props.accessibilityState).toEqual({ expanded: false });
    expect(
      tree!.root.findAllByProps({
        accessibilityLabel: `${mockNotebooks[0].title}, 0 notes`
      })
    ).toHaveLength(0);
    // Add remains separate and reachable when the notebook group is closed.
    const add = tree!.root.findAllByProps({
      testID: "library-new-notebook"
    })[0];
    const present = require("../../components/sheets/add-notebook")
      .AddNotebookSheet.present;
    present.mockClear();
    act(() => add.props.onPress());
    expect(present).toHaveBeenCalledWith(
      undefined,
      undefined,
      "global",
      undefined,
      false
    );
    act(() => section().props.onPress());
    expect(notebook()).toBeDefined();
    const tag = tree!.root.findByProps({
      accessibilityLabel: `${mockTags[0].title}, 0 notes`
    });
    act(() => tag.props.onPress());
    expect(navigation.navigate).toHaveBeenLastCalledWith("TaggedNotes", {
      type: "tag",
      id: "tag",
      canGoBack: true
    });
  });

  it("retains the iPad Library's single-line destinations and existing section geometry", () => {
    mockNotebooks = [{ id: "book", title: "Notebook" }];
    render("narrow", false);
    const section = tree!.root.findByProps({ accessibilityLabel: "Notebooks" });
    expect(section.props.style.minHeight).toBeUndefined();
    const notebook = tree!.root.findByProps({
      accessibilityLabel: "Notebook, 0 notes"
    });
    expect(notebook.findAllByType("Text" as never)[0].props.numberOfLines).toBe(
      1
    );
  });

  const sourceLabels = () =>
    tree!.root
      .findAllByType("Pressable" as never)
      .map((node) => node.props.accessibilityLabel);
  const secondaryLabels = [
    "Favorites",
    "Monographs",
    "Archive",
    "Templates, 0 notes",
    "Trash"
  ];
  const phoneSource = () => {
    if (Platform.OS === "ios") Platform.isPad = false;
    mockDeviceMode = "mobile";
  };
  it("puts notebooks immediately after phone collections and preserves duplicate-title IDs, tags and secondary actions", () => {
    phoneSource();
    mockNotebooks = [
      { id: "book-z", title: "Gleich" },
      { id: "book-a", title: "Gleich" }
    ];
    mockTags = [{ id: "tag", title: "Markierung" }];
    render(undefined, false);
    expect(sourceLabels()).toEqual([
      "All Notes, 0 notes",
      "Inbox, 0 notes",
      "Notebooks",
      "Gleich, 0 notes",
      "Gleich, 0 notes",
      ...secondaryLabels,
      "Tags",
      "Markierung, 0 notes"
    ]);
    const duplicates = tree!.root
      .findAllByType("Pressable" as never)
      .filter((node) => node.props.accessibilityLabel === "Gleich, 0 notes");
    act(() => duplicates[0].props.onPress());
    expect(navigation.navigate).toHaveBeenLastCalledWith("Notebook", {
      id: "book-z",
      canGoBack: true
    });
    act(() => duplicates[1].props.onPress());
    expect(navigation.navigate).toHaveBeenLastCalledWith("Notebook", {
      id: "book-a",
      canGoBack: true
    });
    const secondaryTargets = [
      ["Favorites", {}],
      ["Monographs", { type: "monograph", id: "monograph", canGoBack: true }],
      ["Archive", {}],
      ["Templates", {}],
      ["Trash", {}]
    ];
    secondaryLabels.forEach((label, index) => {
      act(() =>
        tree!.root.findByProps({ accessibilityLabel: label }).props.onPress()
      );
      expect(navigation.navigate).toHaveBeenLastCalledWith(
        ...secondaryTargets[index]
      );
    });
    act(() =>
      tree!.root
        .findByProps({ accessibilityLabel: "Markierung, 0 notes" })
        .props.onPress()
    );
    expect(navigation.navigate).toHaveBeenLastCalledWith("TaggedNotes", {
      type: "tag",
      id: "tag",
      canGoBack: true
    });
    act(() =>
      tree!.root
        .findByProps({ accessibilityLabel: "All Notes, 0 notes" })
        .props.onPress()
    );
    expect(activeCollection()).toBe("AllNotes");
    act(() => (header().onLeftMenuButtonPress as () => void)());
    expect(sourceLabels()[2]).toBe("Notebooks");
    act(() =>
      tree!.root
        .findByProps({ accessibilityLabel: "Inbox, 0 notes" })
        .props.onPress()
    );
    expect(activeCollection()).toBe("Inbox");
  });
  it("keeps the phone notebook header early and Add reachable while filled notebooks are collapsed", () => {
    phoneSource();
    mockNotebooks = [{ id: "book", title: "Notebook" }];
    render(undefined, false);
    const section = () =>
      tree!.root.findByProps({ accessibilityLabel: "Notebooks" });
    act(() => section().props.onPress());
    expect(section().props.accessibilityState.expanded).toBe(false);
    expect(sourceLabels()).toEqual([
      "All Notes, 0 notes",
      "Inbox, 0 notes",
      "Notebooks",
      ...secondaryLabels
    ]);
    const add = tree!.root.findAllByProps({
      testID: "library-new-notebook"
    })[0];
    const present = require("../../components/sheets/add-notebook")
      .AddNotebookSheet.present;
    present.mockClear();
    act(() => add.props.onPress());
    expect(present).toHaveBeenCalledWith(
      undefined,
      undefined,
      "global",
      undefined,
      false
    );
    act(() => section().props.onPress());
    expect(sourceLabels().slice(2, 5)).toEqual([
      "Notebooks",
      "Notebook, 0 notes",
      "Favorites"
    ]);
  });
  it("keeps empty-phone notebook creation in the early section and its plus reachable after collapse", () => {
    phoneSource();
    render(undefined, false);
    expect(sourceLabels()).toEqual([
      "All Notes, 0 notes",
      "Inbox, 0 notes",
      "Notebooks",
      "newNotebookRow",
      ...secondaryLabels
    ]);
    const present = require("../../components/sheets/add-notebook")
      .AddNotebookSheet.present;
    present.mockClear();
    const empty = tree!.root
      .findAllByType("Pressable" as never)
      .find((node) => node.props.accessibilityLabel === "newNotebookRow")!;
    act(() => empty.props.onPress());
    expect(present).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      "global",
      undefined,
      false
    );
    act(() =>
      tree!.root
        .findByProps({ accessibilityLabel: "Notebooks" })
        .props.onPress()
    );
    expect(sourceLabels()).not.toContain("newNotebookRow");
    act(() =>
      tree!.root
        .findAllByProps({ testID: "library-new-notebook" })[0]
        .props.onPress()
    );
    expect(present).toHaveBeenCalledTimes(2);
  });
  it.each(["iPad", "Android"])("keeps %s source ordering unchanged", (kind) => {
    if (kind === "Android") {
      mockOS = "android";
      mockDeviceMode = "mobile";
    }
    mockNotebooks = [{ id: "book", title: "Notebook" }];
    mockTags = [{ id: "tag", title: "Tag" }];
    render(kind === "iPad" ? "narrow" : undefined, false);
    expect(sourceLabels()).toEqual([
      "All Notes, 0 notes",
      "Inbox, 0 notes",
      ...secondaryLabels,
      "Notebooks",
      "Notebook, 0 notes",
      "Tags",
      "Tag, 0 notes"
    ]);
  });
  it("keeps Mac on its existing default collection instead of a reordered Library", () => {
    (isMacCatalyst as jest.Mock).mockReturnValue(true);
    render(undefined, false);
    expect(sourceList()).toBe(0);
    expect(activeCollection()).toBe("AllNotes");
  });

  const render = (
    paneMode: IPadPaneMode | undefined,
    sidebarVisible: boolean,
    params?: { initialCollection?: "all-notes" | "inbox" }
  ) => {
    const route = { key: "Library", name: "Library", params };
    act(() => {
      tree = create(
        <IPadWorkspaceProvider
          value={
            paneMode === undefined
              ? undefined
              : workspaceValue(paneMode, sidebarVisible)
          }
        >
          <Library navigation={navigation as never} route={route as never} />
        </IPadWorkspaceProvider>
      );
    });
    return route;
  };

  const update = (
    paneMode: IPadPaneMode | undefined,
    sidebarVisible: boolean,
    params?: { initialCollection?: "all-notes" | "inbox" }
  ) => {
    const route = { key: "Library", name: "Library", params };
    act(() => {
      tree?.update(
        <IPadWorkspaceProvider
          value={
            paneMode === undefined
              ? undefined
              : workspaceValue(paneMode, sidebarVisible)
          }
        >
          <Library navigation={navigation as never} route={route as never} />
        </IPadWorkspaceProvider>
      );
    });
    return route;
  };

  const header = () =>
    tree?.root.findByType("HeaderProbe" as never).props as Record<
      string,
      unknown
    >;

  const hasHeader = () =>
    (tree?.root.findAllByType("HeaderProbe" as never).length ?? 0) > 0;

  const sourceList = () =>
    tree?.root.findAllByProps({ testID: "library-scroll" }).length ?? 0;

  const activeCollection = () => header()?.id as string | undefined;

  /**
   * What the list renders from and what a row reads for its visible content:
   * `components/list` renders `data.placeholders` and each row calls
   * `data.item(index)`. The assertions below go through exactly these, so they
   * prove the *visible* list data changed, not that some callback ran.
   */
  const listData = () =>
    tree?.root.findByType("List" as never).props.data as
      | { item: (index: number) => Promise<FakeRow> }
      | undefined;

  const visibleTitle = async () => (await listData()!.item(0)).title;

  /** What the editor's save writes into the database. */
  const saveNote = (kind: "all-notes" | "inbox", title: string) => {
    fakeRows()[kind] = fakeRows()[kind].map((row, index) =>
      index === 0 ? { ...row, title, dateEdited: row.dateEdited + 1000 } : row
    );
  };

  const settleRefresh = async () => {
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockDeviceMode = "tablet";
    mockOS = "ios";
    if (Platform.OS === "ios") Platform.isPad = true;
    mockNotebooks = [];
    mockTags = [];
    useMacSidebarSectionsStore.setState({
      collapsed: {
        library: false,
        notebooks: false,
        tags: false,
        tasks: false,
        lists: false
      }
    });
    navigation.navigate.mockClear();
    // Every test but the pre-init one starts from an open database.
    (db as { isInitialized: boolean }).isInitialized = true;
    (isMacCatalyst as jest.Mock).mockReturnValue(false);
    const state = probeState();
    state.mounts = 0;
    state.unmounts = 0;
    state.renders = 0;
    state.latest = null;
    (Navigation.openDrawer as jest.Mock).mockClear();
    navigatorFocused = true;
    flipFocusedOnFocusSubscribe = false;
    focusedOnFirstReadOnly = false;
    navigatorFocusReads = 0;
    focusListeners.length = 0;
    blurListeners.length = 0;
    navigation.addListener.mockClear();
    navState().focusedRouteId = "Library";
    firstSave().onNoteCreated = null;
    firstSave().unassigned = false;
    fakeRows()["all-notes"] = [
      { id: "alpha", title: "Alpha", dateEdited: 1000 }
    ];
    fakeRows().inbox = [{ id: "beta", title: "Beta", dateEdited: 1000 }];
    allNotesStore().reset();
    allNotesStore().seed();
    inboxStore().reset();
    inboxStore().seed();
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
    jest.useRealTimers();
  });

  it("defaults wide and a closed medium drawer to the All Notes column", () => {
    render("wide", true);
    expect(activeCollection()).toBe("AllNotes");
    // The persistent sidebar carries the account affordance, so the column does
    // not duplicate it.
    expect(header().leading).toBeUndefined();

    update("medium", false);
    expect(activeCollection()).toBe("AllNotes");
    // Medium with the drawer closed still has a collection but no sidebar on
    // screen, so the column carries the account affordance itself.
    expect(header().leading).toBeTruthy();

    // The list column was retained, not rebuilt, across the width change.
    expect(probeState().mounts).toBe(1);
    expect(probeState().unmounts).toBe(0);
  });

  it("starts a narrow workspace on the source list and adopts All Notes when it widens", () => {
    render("narrow", false);
    expect(sourceList()).toBe(1);
    expect(hasHeader()).toBe(false);

    // Narrow has no sidebar, so the source list's own bar carries the account
    // affordance.
    const navBar = tree?.root.findByType("IosNavBar" as never).props as Record<
      string,
      unknown
    >;
    expect(navBar.leading).toBeTruthy();

    // Widening without an explicit selection gives the column the default
    // collection instead of a second copy of the source list.
    update("wide", true);
    expect(activeCollection()).toBe("AllNotes");
    expect(sourceList()).toBe(0);
  });

  it("re-applies an explicit Inbox selection after going back only when the params are new", () => {
    const params = { initialCollection: "inbox" as const };
    render("narrow", false, params);
    expect(activeCollection()).toBe("Inbox");

    // Narrow's leading button is the way back to the source categories.
    act(() => {
      (header().onLeftMenuButtonPress as () => void)();
    });
    expect(sourceList()).toBe(1);
    expect(hasHeader()).toBe(false);

    // A plain re-render carries the same params object: the user's undo must
    // not be reversed into a re-application of the old parameter.
    update("narrow", false, params);
    expect(sourceList()).toBe(1);
    expect(hasHeader()).toBe(false);

    // A real navigation to the same collection carries a fresh params object
    // with the same value; that must re-apply.
    update("narrow", false, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");
  });

  it("stores the fallback rather than deriving it when a stale param is left behind by a back", () => {
    const params = { initialCollection: "inbox" as const };
    render("narrow", false, params);
    expect(activeCollection()).toBe("Inbox");

    // Narrow's leading button returns to the source categories; the route keeps
    // its old `initialCollection` param because nothing replaced the object.
    act(() => {
      (header().onLeftMenuButtonPress as () => void)();
    });
    expect(sourceList()).toBe(1);
    expect(hasHeader()).toBe(false);

    // Widening with that same stale param object must still *write* the
    // column's default, not merely derive All Notes for this one render.
    update("wide", true, params);
    expect(activeCollection()).toBe("AllNotes");
    expect(sourceList()).toBe(0);
    const mountsOnWide = probeState().mounts;

    // Shrinking back keeps the very list that had been on screen: a derived-only
    // fallback would drop to the source categories here.
    update("narrow", false, params);
    expect(activeCollection()).toBe("AllNotes");
    expect(sourceList()).toBe(0);
    expect(hasHeader()).toBe(true);
    expect(probeState().mounts).toBe(mountsOnWide);
  });

  it("keeps a fresh Inbox selection that arrives together with the widening", () => {
    render("narrow", false);
    expect(sourceList()).toBe(1);
    expect(hasHeader()).toBe(false);

    // The explicit choice and the widening land in the same commit: the params
    // effect runs first and the fallback seeding must not overwrite it.
    update("wide", true, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");
    expect(sourceList()).toBe(0);
  });

  it("retains an explicit collection through wide -> medium -> narrow -> wide and fullscreen", () => {
    render("wide", true, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");

    update("medium", false, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");

    // Narrow has no column default, but the column keeps the collection that
    // was on screen instead of dropping back to the source categories.
    update("narrow", false, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");
    expect(sourceList()).toBe(0);

    // Fullscreen reports the sidebar as not visible whatever the width says.
    update("medium", false, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");
    expect(header().leading).toBeTruthy();

    update("wide", true, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");

    expect(probeState().mounts).toBe(1);
    expect(probeState().unmounts).toBe(0);
  });

  it("retains the default collection through wide -> medium -> narrow -> wide", () => {
    render("wide", true);
    expect(activeCollection()).toBe("AllNotes");

    update("medium", false);
    expect(activeCollection()).toBe("AllNotes");

    update("narrow", false);
    expect(activeCollection()).toBe("AllNotes");
    expect(sourceList()).toBe(0);

    update("wide", true);
    expect(activeCollection()).toBe("AllNotes");

    expect(probeState().mounts).toBe(1);
    expect(probeState().unmounts).toBe(0);
  });

  it("opens the source drawer from medium and returns to the sources from narrow", () => {
    render("medium", false);
    expect(activeCollection()).toBe("AllNotes");
    // Medium's leading control opens the swipe-in source drawer, so the bar
    // must label it with the sidebar affordance (the collection passes the
    // explicit `expandSidebar` string) instead of the "Library" back title the
    // header would otherwise fall back to for a screen that is not there.
    expect(header().canGoBack).toBe(true);
    expect(header().backTitle).toBe("expandSidebar");
    act(() => {
      (header().onLeftMenuButtonPress as () => void)();
    });
    expect(Navigation.openDrawer).toHaveBeenCalledTimes(1);
    // Opening the drawer does not change the collection.
    expect(activeCollection()).toBe("AllNotes");

    tree && act(() => tree?.unmount());
    tree = undefined;
    render("narrow", false, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");
    // Narrow keeps the real way back to the source categories: no explicit
    // label is passed, so the header keeps its own Library fallback, and the
    // action is the collection's own `onGoBack` - the drawer is not opened.
    expect(header().backTitle).toBeUndefined();
    act(() => {
      (header().onLeftMenuButtonPress as () => void)();
    });
    expect(sourceList()).toBe(1);
    expect(Navigation.openDrawer).toHaveBeenCalledTimes(1);
  });

  it("keeps the unchanged iPhone default and the Catalyst default without a workspace", () => {
    // iPad in iPhone-style landscape without the workspace provider: no
    // collection is forced, the source list stays, and the account affordance
    // moves into its bar.
    render(undefined, false);
    expect(sourceList()).toBe(1);
    expect(hasHeader()).toBe(false);

    // Mac Catalyst also reports `deviceMode === "tablet"`, but it is a Mac
    // list column and keeps All Notes regardless.
    update(undefined, false);
    (isMacCatalyst as jest.Mock).mockReturnValue(true);
    update(undefined, false);
    expect(activeCollection()).toBe("AllNotes");
    expect(header().leading).toBeUndefined();
  });

  /**
   * The stale-list regression: the column is retained while a note is edited, so
   * a save has to reach the list that is already on screen. The triggers below
   * are the ones a save and a re-entry really produce; the assertions go through
   * the list's own visible data (`data.item(index)`), not through a callback or
   * helper.
   */
  it("re-reads the visible All Notes list when the database reports the note write", async () => {
    render("wide", true);
    expect(await visibleTitle()).toBe("Alpha");
    const baseline = allNotesStore().state.refreshes;

    // The editor saved a new headline and body.
    saveNote("all-notes", "Alpha (edited)");
    act(() => {
      databaseEvents().publish(EVENTS.databaseUpdated, {
        collection: "notes",
        type: "update",
        ids: ["alpha"]
      });
    });
    await settleRefresh();

    expect(allNotesStore().state.refreshes).toBe(baseline + 1);
    expect(await visibleTitle()).toBe("Alpha (edited)");
    // The selected collection and the column itself are untouched.
    expect(activeCollection()).toBe("AllNotes");
  });

  it("re-reads the visible Inbox list when the database reports the note and relation writes", async () => {
    render("narrow", false, { initialCollection: "inbox" });
    expect(activeCollection()).toBe("Inbox");
    expect(await visibleTitle()).toBe("Beta");
    expect(header().count).toBe(1);
    const baseline = inboxStore().state.refreshes;

    // The editor saved a new headline and body: the notes table publishes a
    // `notes` write. Filing the note also writes a relation, so both real
    // events are fired here.
    saveNote("inbox", "Beta (edited)");
    fakeRows().inbox.push({ id: "gamma", title: "Gamma", dateEdited: 1000 });
    act(() => {
      databaseEvents().publish(EVENTS.databaseUpdated, {
        collection: "notes",
        type: "update",
        ids: ["beta"]
      });
      databaseEvents().publish(EVENTS.databaseUpdated, {
        collection: "relations",
        type: "update"
      });
    });
    await settleRefresh();

    // The Inbox list is the one that refreshes - the active collection's own
    // store, not the All Notes one (which is never read while Inbox is shown).
    expect(inboxStore().state.refreshes).toBe(baseline + 1);
    expect(allNotesStore().state.refreshes).toBe(0);
    // The visible rows are the freshly read ones: the edited headline and
    // edited time, and the count of the rows just re-read.
    const fresh = await listData()!.item(0);
    expect(fresh.title).toBe("Beta (edited)");
    expect(fresh.dateEdited).toBe(2000);
    expect(header().count).toBe(2);
  });

  it("re-reads the list when the sidebar re-selects the same collection (new params object)", async () => {
    render("wide", true, { initialCollection: "all-notes" });
    expect(await visibleTitle()).toBe("Alpha");

    // Edited in the editor while the column stayed mounted.
    saveNote("all-notes", "Alpha (edited)");
    expect(await visibleTitle()).toBe("Alpha");

    // Pressing the sidebar's All Notes row again carries a *fresh* params
    // object with the same value: the user is asking for that list now.
    update("wide", true, { initialCollection: "all-notes" });
    await settleRefresh();

    expect(await visibleTitle()).toBe("Alpha (edited)");
    expect(activeCollection()).toBe("AllNotes");
  });

  it("re-reads the list when the retained column is focused again", async () => {
    render("wide", true);
    expect(navigation.addListener).toHaveBeenCalledWith(
      "focus",
      expect.any(Function)
    );
    expect(await visibleTitle()).toBe("Alpha");

    saveNote("all-notes", "Alpha (edited)");
    act(() => {
      focusListeners.forEach((listener) => listener());
    });
    await settleRefresh();

    expect(await visibleTitle()).toBe("Alpha (edited)");
  });

  /**
   * A profile whose database is still opening: the collection getters throw
   * until `db.init()` finishes, so every trigger - the initial load and a later
   * re-entry alike - has to wait for the database. The wait must not read
   * before init, must read exactly once when init completes, and must leave no
   * timer behind after unmount.
   */
  it("waits for the database before reading, reads once, and stops after unmount", async () => {
    (db as { isInitialized: boolean }).isInitialized = false;
    const params = { initialCollection: "all-notes" as const };
    render("wide", true, params);

    // Mounted before init: the initial load is waiting, nothing has read.
    expect(allNotesStore().state.refreshes).toBe(0);

    // The user re-enters the retained column (focus) and re-selects the same
    // collection (a fresh params object) while the database is still opening.
    // Both triggers wait, and they coalesce into one pending read.
    act(() => {
      focusListeners.forEach((listener) => listener());
    });
    update("wide", true, { initialCollection: "all-notes" });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(allNotesStore().state.refreshes).toBe(0);

    // The database finishes opening: exactly one read follows.
    (db as { isInitialized: boolean }).isInitialized = true;
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(allNotesStore().state.refreshes).toBe(1);
    expect(await visibleTitle()).toBe("Alpha");

    // And only one: the wait ended, so no timer may read again.
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(allNotesStore().state.refreshes).toBe(1);

    // Nothing reads - or fires - after the column is gone.
    act(() => tree?.unmount());
    tree = undefined;
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(allNotesStore().state.refreshes).toBe(1);
  });

  it("does not refresh in a loop: the refresh's own eMenuItemUpdate is not a trigger", async () => {
    render("wide", true);
    expect(await visibleTitle()).toBe("Alpha");
    const baseline = allNotesStore().state.refreshes;

    saveNote("all-notes", "Alpha (edited)");
    act(() => {
      databaseEvents().publish(EVENTS.databaseUpdated, { collection: "notes" });
    });
    await settleRefresh();
    expect(allNotesStore().state.refreshes).toBe(baseline + 1);

    // `refresh` emits `eMenuItemUpdate` (the real store does); firing it again
    // must not set off another read.
    act(() => {
      eSendEvent(eMenuItemUpdate);
    });
    await settleRefresh();
    expect(allNotesStore().state.refreshes).toBe(baseline + 1);
  });

  it("unsubscribes from the events it listens to when the column unmounts", () => {
    render("wide", true);
    const publish = databaseEvents().publish;
    act(() => tree?.unmount());
    tree = undefined;
    const baseline = allNotesStore().state.refreshes;

    saveNote("all-notes", "Alpha (edited)");
    act(() => {
      publish(EVENTS.databaseUpdated, { collection: "notes" });
      publish(EVENTS.syncCompleted);
    });
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(allNotesStore().state.refreshes).toBe(baseline);
  });

  /**
   * The retained-column ownership regression: the iPad keeps the Library
   * column laid out while a Notebook is pushed over it. The collection mounted
   * there used to publish its own focused route id and an unassigned first-save
   * context unconditionally - and its cleanup cleared the Notebook's - so a note
   * created from the *foreground* Notebook's header landed in the Inbox.
   */
  describe("ownership of the header's New Note behaviour", () => {
    it("does not take a foreground Notebook's ownership while mounting in the background", () => {
      // The Notebook is in front: it published its id and first-save callback
      // atomically (screens/notebook syncWithNavigation).
      navState().focusedRouteId = "Notebook";
      firstSave().onNoteCreated = { type: "notebook", id: "book" };

      // The Library is retained behind it.
      navigatorFocused = false;
      render("narrow", false);
      expect(sourceList()).toBe(1);

      // The window widens behind the Notebook: the column derives All Notes ...
      update("wide", true);
      expect(activeCollection()).toBe("AllNotes");

      // ... but the Notebook keeps both halves of its ownership.
      expect(navState().focusedRouteId).toBe("Notebook");
      expect(firstSave().onNoteCreated).toEqual({
        type: "notebook",
        id: "book"
      });
    });

    it("takes ownership when focus arrives between the render and the subscription", () => {
      // The column renders believing it is background (its initial read) and
      // focus lands before the focus subscription is registered: the
      // post-subscribe re-check is the only thing that can see it.
      navigatorFocused = false;
      flipFocusedOnFocusSubscribe = true;

      render("wide", true);

      expect(activeCollection()).toBe("AllNotes");
      expect(navState().focusedRouteId).toBe("AllNotes");
      expect(firstSave().unassigned).toBe(true);
    });

    it("does not clear a newer Notebook's ownership when the column unmounts", () => {
      render("wide", true);
      expect(navState().focusedRouteId).toBe("AllNotes");
      expect(firstSave().unassigned).toBe(true);

      // A Notebook took over in front of the retained column meanwhile.
      navState().focusedRouteId = "Notebook";
      firstSave().onNoteCreated = { type: "notebook", id: "book" };

      act(() => tree?.unmount());
      tree = undefined;

      // Cleanup must not "restore" what it captured over the newer owner.
      expect(navState().focusedRouteId).toBe("Notebook");
      expect(firstSave().onNoteCreated).toEqual({
        type: "notebook",
        id: "book"
      });
    });

    it("leaves a newer owner untouched when the column merely loses focus", () => {
      render("wide", true);
      expect(navState().focusedRouteId).toBe("AllNotes");

      navState().focusedRouteId = "Notebook";
      firstSave().onNoteCreated = { type: "notebook", id: "book" };

      fireBlur();

      expect(navState().focusedRouteId).toBe("Notebook");
      expect(firstSave().onNoteCreated).toEqual({
        type: "notebook",
        id: "book"
      });
    });

    it("republishes when the active collection switches while focused", () => {
      render("wide", true);
      expect(navState().focusedRouteId).toBe("AllNotes");

      update("wide", true, { initialCollection: "inbox" });

      expect(activeCollection()).toBe("Inbox");
      expect(navState().focusedRouteId).toBe("Inbox");
      expect(firstSave().unassigned).toBe(true);
    });

    it("does not publish a stale ownership snapshot before the focus re-check", () => {
      // The first focus read - the one the render seeds the ownership snapshot
      // from - sees `true` ...
      focusedOnFirstReadOnly = true;
      // ... but the Notebook is already in front, so every later read returns
      // `false`, including the collection's passive effect. Child effects flush
      // before the Library's post-subscribe re-check, so the snapshot alone
      // would publish All Notes and the unassigned first-save over the Notebook
      // before that re-check could set `ownsForeground` to false.
      navigatorFocused = false;
      navState().focusedRouteId = "Notebook";
      firstSave().onNoteCreated = { type: "notebook", id: "book" };

      render("wide", true);
      // The column still renders the collection (the wide default), but it must
      // not publish it.
      expect(activeCollection()).toBe("AllNotes");

      // The foreground Notebook keeps both halves of its ownership.
      expect(navState().focusedRouteId).toBe("Notebook");
      expect(firstSave().onNoteCreated).toEqual({
        type: "notebook",
        id: "book"
      });
      expect(firstSave().unassigned).toBe(false);

      // Nothing was published, so unmounting must not undo anything either.
      act(() => tree?.unmount());
      tree = undefined;
      expect(navState().focusedRouteId).toBe("Notebook");
      expect(firstSave().onNoteCreated).toEqual({
        type: "notebook",
        id: "book"
      });
    });

    it("retries ownership on a real focus signal after the stale snapshot was skipped", () => {
      focusedOnFirstReadOnly = true;
      navigatorFocused = false;
      navState().focusedRouteId = "Notebook";
      firstSave().onNoteCreated = { type: "notebook", id: "book" };

      render("wide", true);
      expect(navState().focusedRouteId).toBe("Notebook");
      expect(firstSave().unassigned).toBe(false);

      // The user returns to the Library (the Notebook is popped). This is a
      // real focus signal, not a width change, and it must publish.
      fireFocus();
      expect(navState().focusedRouteId).toBe("AllNotes");
      expect(firstSave().unassigned).toBe(true);
    });
  });

  /**
   * A background column derives the wide/medium default for rendering, but must
   * not commit it into its own state: a narrow source list the user left behind
   * - widened while a Notebook is in front, then narrowed again - would
   * otherwise come back as All Notes and lose the source history.
   */
  describe("the background column's collection default", () => {
    it("does not commit a background width default, so the source history survives", () => {
      navigatorFocused = false;
      render("narrow", false);
      expect(sourceList()).toBe(1);

      // Widening behind the user derives All Notes for rendering ...
      update("wide", true);
      expect(activeCollection()).toBe("AllNotes");

      // ... but does not commit it: narrowing again returns to the sources.
      update("narrow", false);
      expect(sourceList()).toBe(1);
      expect(hasHeader()).toBe(false);

      // And re-entering the Library keeps the source list the user left.
      fireFocus();
      expect(sourceList()).toBe(1);
      expect(hasHeader()).toBe(false);
    });

    it("commits the derived default once the column is focused again", () => {
      navigatorFocused = false;
      render("narrow", false);
      update("wide", true);
      expect(activeCollection()).toBe("AllNotes");

      fireFocus();
      expect(activeCollection()).toBe("AllNotes");

      // Committed while foreground, narrowing now keeps the list.
      update("narrow", false);
      expect(activeCollection()).toBe("AllNotes");
      expect(sourceList()).toBe(0);
    });

    it("applies an explicit collection even when focus arrives after the render", () => {
      navigatorFocused = false;
      render("wide", true);

      update("wide", true, { initialCollection: "inbox" });
      expect(activeCollection()).toBe("Inbox");
      // Background: the selection is rendered but not published.
      expect(navState().focusedRouteId).toBe("Library");

      fireFocus();
      expect(navState().focusedRouteId).toBe("Inbox");
      expect(firstSave().unassigned).toBe(true);
    });
  });
});
