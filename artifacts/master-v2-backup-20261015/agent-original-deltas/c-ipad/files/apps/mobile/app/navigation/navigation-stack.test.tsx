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
 * The real `AppNavigationStack` seeded as the app seeds it, with the *real*
 * `Library` screen (and therefore the real `NoteCollection`) as the initial
 * route's component and the *real* `IPadWorkspaceProvider` above it.
 *
 * This is the parent/child regression the wide and medium iPad hit: the home
 * effect seeds the Library column's focused route id, and because effects run
 * child-first the collection publishes its own id ("AllNotes"/"Inbox") first.
 * Seeding the plain route name there overwrote it, so the sidebar showed no
 * selected row even though the column was showing All Notes. The navigator is a
 * minimal but faithful stand-in for the native stack (it renders the initial
 * route and hands it the props a real stack navigation object has); the store
 * the app highlights its sidebar rows from is the production one.
 *
 * Only the peripheral edges are mocked: the native primitives, the theme,
 * navigation libraries, the database and the heavy list/header widgets.
 */

import React from "react";
import { Platform } from "react-native";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { notesnook } from "../../e2e/test.ids";

jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  FlatList: "FlatList",
  Keyboard: { dismiss: jest.fn() },
  Dimensions: { get: () => ({ width: 512, height: 1024, scale: 2, fontScale: 1 }) },
  PixelRatio: { get: () => 2, getFontScale: () => 1, roundToNearestPixel: (value: number) => value },
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
  BackHandler: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  // Only reached through `components/apple-tab-bar`, which is loaded for real
  // (see its mock): the native tab bar view itself is never rendered here.
  requireNativeComponent: jest.fn(() => "NativeTabBarView"),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} }
}));

/** The iOS class the mocked native modules report (`isTopTabBar()` reads it). */
const mockPlatform = Platform as unknown as { OS: "ios" | "android"; isPad: boolean };

/** The focused route the container mock reports once mounted, if any. */
const mockNavigationState: {
  state?: { routes: { name: string }[]; index: number };
} = { state: undefined };

type MockSettingState = {
  isAppLoading: boolean;
  deviceMode: "mobile" | "tablet";
  fullscreen: boolean;
  dimensions: { width: number; height: number };
  pendingShortcut: unknown;
  settings: { homepageV2: unknown; introCompleted: boolean };
  initialUrl: string | undefined;
};

type MockAppleNavigationState = {
  section: string;
  settingsVisible: boolean;
  editorVisible: boolean;
  setSection: jest.Mock;
  setSettingsVisible: jest.Mock;
};

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: {
        accent: "#0a84ff",
        heading: "#000",
        paragraph: "#000",
        background: "#fff",
        backdrop: "#000"
      },
      secondary: { icon: "#666", paragraph: "#666", background: "#fff" },
      selected: { icon: "#0a84ff", paragraph: "#000" },
      static: { yellow: "#ffcc00" }
    },
    isDark: false
  })
}));

/**
 * The native stack, reduced to what this suite needs: a real navigator that
 * renders the initial route's component with the props a stack screen gets.
 */
jest.mock("@react-navigation/native-stack", () => {
  const React = require("react");
  return {
    createNativeStackNavigator: () => ({
      Navigator: (props: {
        children?: React.ReactNode;
        initialRouteName?: string;
      }) => {
        const screens = React.Children.toArray(
          props.children
        ) as unknown as React.ReactElement<{
          name?: string;
          initialParams?: unknown;
          getComponent: () => React.ComponentType<Record<string, unknown>>;
        }>[];
        const initial =
          screens.find(
            (screen) => screen.props.name === props.initialRouteName
          ) ?? screens[0];
        if (!initial) return null;
        const Screen = initial.props.getComponent();
        return React.createElement(
          "NativeStackNavigator",
          { name: initial.props.name },
          React.createElement(Screen, {
            navigation: mockStackNavigation,
            route: {
              key: initial.props.name,
              name: initial.props.name,
              params: initial.props.initialParams
            }
          })
        );
      },
      Screen: () => null
    })
  };
});

/** What the stack's screens call back into (the sidebar's list navigation). */
const mockStackNavigation = {
  navigate: jest.fn(),
  push: jest.fn(),
  goBack: jest.fn(),
  replace: jest.fn(),
  dispatch: jest.fn(),
  // A real stack screen's navigation reports its focus; the Library column
  // reads it to decide whether it owns the header's New Note behaviour. The
  // route this suite renders is the focused one.
  isFocused: jest.fn(() => true),
  addListener: jest.fn(() => jest.fn()),
  setOptions: jest.fn()
};

jest.mock("@react-navigation/native", () => {
  const React = require("react");
  return {
    NavigationContainer: (props: {
      children?: React.ReactNode;
      onReady?: () => void;
      onStateChange?: (state: unknown) => void;
    }) => {
      React.useEffect(() => {
        props.onReady?.();
        // The real container reports the focused route the same way; only the
        // cases that need the root to leave its initial route ask for it.
        if (mockNavigationState.state)
          props.onStateChange?.(mockNavigationState.state);
      }, []);
      return React.createElement("NavigationContainer", null, props.children);
    },
    createNavigationContainerRef: () => ({
      current: null,
      isReady: () => true,
      navigate: jest.fn(),
      getCurrentRoute: () => undefined,
      getState: () => undefined,
      reset: jest.fn()
    }),
    useRoute: () => ({ name: "Library", params: undefined })
  };
});

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  return {
    useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }),
    SafeAreaInsetsContext: React.createContext({
      top: 24,
      bottom: 20,
      left: 0,
      right: 0
    })
  };
});

jest.mock("@notesnook/intl", () => {
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
        if (name === "dataTypesPluralCamelCase") return { note: () => "Notes" };
        if (name === "selectedCode") return (n: number) => `${n} selected`;
        if (name === "searchInRoute")
          return (title: string) => `Search in ${title}`;
        if (name === "notes") return (n: number) => `${n} notes`;
        return () => name;
      }
    }
  );
  return { strings };
});

jest.mock("@notesnook/common", () => ({
  isFeatureAvailable: jest.fn(async () => ({ isAllowed: true }))
}));

jest.mock("@notesnook/core", () => ({
  EVENTS: { databaseUpdated: "databaseUpdated", syncCompleted: "syncCompleted" },
  isInternalLink: jest.fn(() => false),
  parseInternalLink: jest.fn(() => undefined)
}));

jest.mock("../utils/constants", () => ({
  isMacCatalyst: jest.fn(() => false)
}));

jest.mock("../utils/global-refs", () => ({
  rootNavigatorRef: {
    current: null,
    isReady: () => true,
    navigate: jest.fn(),
    getCurrentRoute: () => undefined,
    getState: () => undefined,
    goBack: jest.fn(),
    reset: jest.fn(),
    dispatch: jest.fn()
  },
  appNavigatorRef: { current: null },
  fluidTabsRef: { current: null },
  editorRef: { current: null },
  inputRef: { current: null }
}));

jest.mock("../hooks/use-tooltip", () => ({ hideAllTooltips: jest.fn() }));

jest.mock("../hooks/use-shortcut-manager", () => ({
  launchNewNoteTab: jest.fn()
}));

jest.mock("../services/settings", () => ({
  __esModule: true,
  default: { setProperty: jest.fn(), getProperty: jest.fn() }
}));

jest.mock("../services/reminder-widget-links", () => ({
  parseReminderWidgetLink: jest.fn(() => undefined)
}));

jest.mock("../services/device-detection", () => ({
  DDS: { isTab: false }
}));

jest.mock("../services/mac-list-navigation", () => ({
  setMacListNavigation: jest.fn()
}));

jest.mock("../services/event-manager", () => ({
  eSendEvent: jest.fn(),
  eSubscribeEvent: jest.fn(() => ({ unsubscribe: jest.fn() })),
  eUnSubscribeEvent: jest.fn(),
  presentSheet: jest.fn()
}));

jest.mock("../services/navigation", () => ({
  __esModule: true,
  default: {
    navigate: jest.fn(),
    push: jest.fn(),
    goBack: jest.fn(),
    replace: jest.fn(),
    popToTop: jest.fn(),
    openDrawer: jest.fn(),
    closeDrawer: jest.fn(),
    queueRoutesForUpdate: jest.fn(),
    routeNeedsUpdate: jest.fn(),
    routeUpdateFunctions: {},
    resetRootState: jest.fn()
  }
}));

jest.mock("../utils/events", () => ({
  eOnLoadNote: "eOnLoadNote",
  eOnExitEditor: "eOnExitEditor",
  eCloseFullscreenEditor: "eCloseFullscreenEditor",
  eOpenFullscreenEditor: "eOpenFullscreenEditor",
  eGroupOptionsUpdated: "eGroupOptionsUpdated",
  eMenuItemUpdate: "eMenuItemUpdate"
}));

jest.mock("../screens/editor/tiptap/utils", () => ({
  editorState: () => ({ movedAway: false })
}));

jest.mock("../screens/notes/common", () => ({
  openEditor: jest.fn(),
  setOnFirstSave: jest.fn(),
  setOnFirstSaveUnassigned: jest.fn()
}));

/**
 * The module is the production one - above all `isTopTabBar()`, the hardware
 * half of the root's bar gate, which must be exercised for real. Only the bar's
 * own view is replaced by an observable leaf, so a test can assert whether the
 * bar is mounted at all.
 */
jest.mock("../components/apple-tab-bar", () => {
  const React = require("react");
  const actual = jest.requireActual("../components/apple-tab-bar");
  return {
    ...actual,
    AppleTabBar: (props: Record<string, unknown>) =>
      React.createElement("AppleTabBar", props)
  };
});

/**
 * The root's initial route is the only screen the navigator mock mounts, so a
 * probe stands in for `FluidPanelsView`. It is a real consumer of the
 * `SafeAreaInsetsContext` the root publishes: the top inset it reads is the one
 * the panes below actually get (0 while the iPad top strip is drawn in the flow
 * above them, the window inset otherwise).
 */
jest.mock("./fluid-panels-view", () => {
  const React = require("react");
  const { SafeAreaInsetsContext } = require("react-native-safe-area-context");
  const {
    AppleTabBarOffsetContext
  } = require("../components/apple-tab-bar-layout");
  const FluidPanelsProbe = () => {
    const { IPadPrimaryNavigationContext } = require("../components/ipad-primary-navigation-context");
    const primary = React.useContext(IPadPrimaryNavigationContext);
    const insets = React.useContext(SafeAreaInsetsContext);
    const tabBarOffset = React.useContext(AppleTabBarOffsetContext);
    return React.createElement("FluidPanelsProbe", {
      top: insets?.top,
      tabBarOffset,
      primary
    });
  };
  return { __esModule: true, default: FluidPanelsProbe };
});

/**
 * The intro screen is not under test - only the route it is mounted for is. It
 * stands under the same root `SafeAreaInsetsContext.Provider` as the panes, so
 * it is a real consumer of it too: the top inset it reads is the one the
 * provider actually published (24 while there is no iPad top strip above it).
 */
jest.mock("../components/intro", () => {
  const React = require("react");
  const { SafeAreaInsetsContext } = require("react-native-safe-area-context");
  return {
    __esModule: true,
    default: () => {
      const insets = React.useContext(SafeAreaInsetsContext);
      return React.createElement("IntroProbe", { top: insets?.top });
    }
  };
});

jest.mock("../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: true,
    screenBackground: "#ffffff",
    listSurface: "#ffffff",
    primaryText: "#000000",
    secondaryText: "#666666",
    tertiaryText: "#999999",
    separator: "#dddddd",
    contentSurface: "#f2f2f7",
    selectedSurface: "#e5e5ea",
    sectionSpacing: 20,
    pagePadding: 20,
    controlRadius: 10,
    sidebarBackground: "#f2f2f7",
    navigationSurface: "#ffffff",
    navigationMaterialOpacity: 1
  })
}));

jest.mock("../utils/mac-layout", () => ({
  macToolbarInset: () => 0,
  macWindowBackground: () => "#ffffff"
}));

jest.mock("../utils/styles", () => ({
  DefaultAppStyles: {
    GAP: 12,
    GAP_VERTICAL: 8,
    GAP_VERTICAL_SMALL: 4,
    GAP_SMALL: 6
  }
}));

jest.mock("../stores/use-apple-navigation-store", () => {
  const state: MockAppleNavigationState = {
    section: "library",
    settingsVisible: false,
    editorVisible: false,
    setSection: jest.fn(),
    setSettingsVisible: jest.fn()
  };
  const useAppleNavigationStore = Object.assign(
    jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    { getState: () => state }
  );
  return {
    useAppleNavigationStore,
    AppleTabBarSelection: {},
    // The fixture's own handle on the state above (not a production export).
    __state: state
  };
});

jest.mock("../stores/use-setting-store", () => {
  const state: MockSettingState = {
    isAppLoading: false,
    deviceMode: "tablet",
    fullscreen: false,
    dimensions: { width: 512, height: 1024 },
    pendingShortcut: null,
    settings: { homepageV2: undefined, introCompleted: true },
    initialUrl: undefined as string | undefined
  };
  const useSettingStore = Object.assign(
    jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    {
      getState: () => state,
      setState: jest.fn(),
      subscribe: jest.fn(() => jest.fn())
    }
  );
  return { useSettingStore, __settingState: state };
});

jest.mock("../stores/use-selection-store", () => {
  const state = { selectionMode: false };
  const useSelectionStore = Object.assign(
    jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    { getState: () => state }
  );
  return { useSelectionStore };
});

jest.mock("../common/database", () => ({
  db: {
    isInitialized: true,
    eventManager: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
    notes: {
      all: { count: jest.fn(async () => 0) },
      unassigned: { count: jest.fn(async () => 0) }
    },
    settings: { setSideBarOrder: jest.fn(), setSideBarHiddenItems: jest.fn() }
  }
}));

jest.mock("../stores/use-notes-store", () => ({
  useNotes: () => [undefined, false, jest.fn(async () => undefined)]
}));

jest.mock("../stores/use-inbox-store", () => ({
  useInboxNotes: () => [undefined, false, jest.fn(async () => undefined)]
}));

jest.mock("../hooks/use-library-source-list", () => ({
  useLibrarySourceList: () => ({
    notebooks: [],
    tags: [],
    counts: { allNotes: 0, inbox: 0, templates: 0 },
    notebookCounts: {},
    tagCounts: {}
  })
}));

jest.mock("../stores/use-mac-sidebar-sections-store", () => ({
  useMacSidebarSectionCollapsed: () => false,
  useMacSidebarSectionsStore: (selector: (s: unknown) => unknown) =>
    selector({ toggle: jest.fn() })
}));

jest.mock("../components/task-symbol-view", () => ({
  TaskSymbolView: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("TaskSymbolView", props);
  }
}));

jest.mock("../components/ios-nav-bar", () => {
  const React = require("react");
  return {
    IosNavBar: (props: Record<string, unknown>) =>
      React.createElement("IosNavBar", props),
    IosLargeTitle: (props: Record<string, unknown>) =>
      React.createElement("IosLargeTitle", props),
    IosBarButton: (props: Record<string, unknown>) =>
      React.createElement("IosBarButton", props)
  };
});

jest.mock("../components/header/account-affordance", () => {
  const React = require("react");
  return {
    AccountAffordance: ({ testID }: { testID?: string }) =>
      React.createElement("AccountAffordance", { testID })
  };
});

jest.mock("../components/sheets/add-notebook", () => ({
  AddNotebookSheet: { present: jest.fn() }
}));

/**
 * A probe in place of the heavy note-list header: it exposes the collection
 * `NoteCollection` is driving (its id), which is the same id it publishes as the
 * focused route.
 */
jest.mock("../components/header", () => {
  const React = require("react");
  const Header = (props: Record<string, unknown>) =>
    React.createElement("HeaderProbe", props);
  return { Header };
});

jest.mock("../components/delay-layout", () => ({
  __esModule: true,
  default: (props: { children?: React.ReactNode }) => {
    const React = require("react");
    return React.createElement("DelayLayout", null, props.children);
  }
}));

jest.mock("../components/list", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("List", props);
  }
}));

jest.mock("../components/selection-header", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("SelectionHeader", props);
  }
}));

jest.mock("../components/container/floating-button", () => ({
  FloatingButton: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("FloatingButton", props);
  }
}));

import { AppNavigationStack, RootNavigation, selectAppleSection } from "./navigation-stack";
import useNavigationStore from "../stores/use-navigation-store";
import { IPadWorkspaceProvider } from "../components/ipad-workspace-context";
import type { IPadPaneMode } from "../utils/ipad-layout";
import { isMacCatalyst } from "../utils/constants";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function workspaceValue(paneMode: IPadPaneMode, sidebarVisible: boolean) {
  return { paneMode, sidebarVisible };
}

describe("AppNavigationStack's Library seed", () => {
  let tree: ReactTestRenderer | undefined;

  const render = (
    workspace: { paneMode: IPadPaneMode; sidebarVisible: boolean } | undefined
  ) => {
    act(() => {
      tree = create(
        <IPadWorkspaceProvider value={workspace}>
          <AppNavigationStack />
        </IPadWorkspaceProvider>
      );
    });
  };

  const updateWorkspace = (
    workspace: { paneMode: IPadPaneMode; sidebarVisible: boolean } | undefined
  ) => {
    act(() => {
      tree?.update(
        <IPadWorkspaceProvider value={workspace}>
          <AppNavigationStack />
        </IPadWorkspaceProvider>
      );
    });
  };

  const focusedRouteId = () => useNavigationStore.getState().focusedRouteId;

  const collectionIdOnScreen = () =>
    tree?.root.findAllByType("HeaderProbe" as never)[0]?.props.id as
      | string
      | undefined;

  const sourceListShown = () =>
    (tree?.root.findAllByProps({ testID: "library-scroll" }).length ?? 0) > 0;

  beforeEach(() => {
    (isMacCatalyst as jest.Mock).mockReturnValue(false);
    useNavigationStore.setState({
      focusedRouteId: "Notes",
      currentRoute: "Notes"
    });
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
  });

  it("seeds the wide Library with the collection it opens on, not the route name", () => {
    render(workspaceValue("wide", true));

    // The real column mounted the real collection ...
    expect(collectionIdOnScreen()).toBe("AllNotes");
    // ... and the id the sidebar highlights its All Notes row from is that same
    // collection, not the generic "Library" route name the home effect used to
    // write after the child had already published its own.
    expect(focusedRouteId()).toBe("AllNotes");
  });

  it("seeds a medium Library the same way (the sidebar is the drawer there)", () => {
    render(workspaceValue("medium", false));

    expect(collectionIdOnScreen()).toBe("AllNotes");
    expect(focusedRouteId()).toBe("AllNotes");
  });

  it("keeps the narrow Library on the source list and the plain route id", () => {
    render(workspaceValue("narrow", false));

    // Narrow has no column of its own: the Library *is* the source list, so
    // there is no collection to report and the route keeps its own name.
    expect(sourceListShown()).toBe(true);
    expect(collectionIdOnScreen()).toBeUndefined();
    expect(focusedRouteId()).toBe("Library");
  });

  it("adopts the collection the column publishes when a narrow Library widens", () => {
    render(workspaceValue("narrow", false));
    expect(focusedRouteId()).toBe("Library");

    updateWorkspace(workspaceValue("wide", true));

    expect(collectionIdOnScreen()).toBe("AllNotes");
    expect(focusedRouteId()).toBe("AllNotes");
  });

  it("keeps the iPhone behaviour and the Mac default without a workspace", () => {
    // iPhone: no workspace provider above the stack, so the Library keeps the
    // route name and nothing is forced.
    render(undefined);
    expect(sourceListShown()).toBe(true);
    expect(focusedRouteId()).toBe("Library");

    // Mac Catalyst has no iPad workspace either, but its Library route *is* the
    // note list column and opens on All Notes (unchanged behaviour). The seed
    // is a mount-time decision, so this is a fresh mount.
    act(() => tree?.unmount());
    tree = undefined;
    (isMacCatalyst as jest.Mock).mockReturnValue(true);
    useNavigationStore.setState({ focusedRouteId: "Notes", currentRoute: "Notes" });
    render(undefined);
    expect(collectionIdOnScreen()).toBe("AllNotes");
    expect(focusedRouteId()).toBe("AllNotes");
  });

  it("does not re-seed - and so cannot overwrite a live selection - on a workspace change", () => {
    render(workspaceValue("wide", true));
    expect(focusedRouteId()).toBe("AllNotes");

    // Whatever the user (or another screen) has selected meanwhile ...
    act(() => {
      useNavigationStore.getState().setFocusedRouteId("Notebook");
    });

    // ... survives a width change: the seeding effect is keyed on the resolved
    // home alone, so a wide -> medium update must not run it again.
    updateWorkspace(workspaceValue("medium", false));
    expect(focusedRouteId()).toBe("Notebook");
    // And the column itself is untouched by the change: still All Notes.
    expect(collectionIdOnScreen()).toBe("AllNotes");
  });
});

/**
 * The fixture's typed handles on the state the mocked stores answer selectors
 * from, the device class `isTopTabBar()` reads and the focused route the
 * container mock reports. (`__state`/`__settingState` are the mocks' own
 * exports, not production ones.)
 */
const rootSettingState = (
  jest.requireMock("../stores/use-setting-store") as {
    __settingState: MockSettingState;
  }
).__settingState;
const rootAppleNavigationState = (
  jest.requireMock("../stores/use-apple-navigation-store") as {
    __state: MockAppleNavigationState;
  }
).__state;

/**
 * The bar gate of the *real* exported root: the whole tree as the app mounts
 * it, with the real `showTabBar`/`topTabBar` conditions, the real
 * `SafeAreaInsetsContext` it publishes to the panes below, the real
 * `isTopTabBar()` (`Platform.isPad`, not a width) and the real screens the
 * navigator mock mounts for the initial route.
 */
describe("RootNavigation's bar gate", () => {
  let tree: ReactTestRenderer | undefined;
  let workspace:
    | { paneMode: IPadPaneMode; sidebarVisible: boolean }
    | undefined;

  const render = (
    value?: { paneMode: IPadPaneMode; sidebarVisible: boolean }
  ) => {
    workspace = value;
    act(() => {
      tree = create(
        <IPadWorkspaceProvider value={workspace}>
          <RootNavigation />
        </IPadWorkspaceProvider>
      );
    });
  };

  /** Re-renders the same tree, so the stores are read again with new state. */
  const update = () => {
    act(() => {
      tree?.update(
        <IPadWorkspaceProvider value={workspace}>
          <RootNavigation />
        </IPadWorkspaceProvider>
      );
    });
  };

  const unmount = () => {
    act(() => tree?.unmount());
    tree = undefined;
  };

  /** Whether the bar itself is mounted (`showTabBar`/`topTabBar` decide it). */
  const barMounted = () =>
    (tree?.root.findAllByType("AppleTabBar" as never).length ?? 0) > 0;

  /**
   * The top inset the route below the root actually receives. The initial
   * route is either the panes (`FluidPanelsProbe`) or, on the intro/loading
   * routes, the intro screen (`IntroProbe`); both are real consumers of the
   * root's `SafeAreaInsetsContext`, so either one reports the same value.
   */
  const topInsetSeenByPanes = () =>
    (tree?.root.findAllByType("FluidPanelsProbe" as never)[0]?.props.top ??
      tree?.root.findAllByType("IntroProbe" as never)[0]?.props.top) as
      | number
      | undefined;

  /**
   * The iPad top tab bar strip's actual published offset. There is no
   * `FluidPanelsProbe` on the intro route, so this is `undefined` there.
   */
  const tabBarOffsetSeenByPanes = () =>
    tree?.root.findAllByType("FluidPanelsProbe" as never)[0]?.props
      .tabBarOffset as number | undefined;

  /** Whether the root is still on the intro route rather than a section. */
  const introMounted = () =>
    (tree?.root.findAllByType("IntroProbe" as never).length ?? 0) > 0;

  beforeEach(() => {
    mockPlatform.OS = "ios";
    mockPlatform.isPad = true;
    rootSettingState.isAppLoading = false;
    rootSettingState.deviceMode = "mobile";
    rootSettingState.fullscreen = false;
    rootSettingState.dimensions = { width: 512, height: 1024 };
    rootSettingState.pendingShortcut = null;
    rootSettingState.settings = { homepageV2: undefined, introCompleted: true };
    rootSettingState.initialUrl = undefined;
    rootAppleNavigationState.section = "library";
    rootAppleNavigationState.settingsVisible = false;
    rootAppleNavigationState.editorVisible = false;
    mockNavigationState.state = undefined;
    (isMacCatalyst as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    unmount();
  });

  it("keeps the iPad top bar open on the mobile-classified width", () => {
    // The measured 512 pt iPad: DDS calls it `mobile` (512 / 100 < 5.5), so the
    // previous `deviceMode !== "mobile" || !editorVisible` rule took the whole
    // top strip down as soon as the editor was visible - and the header's Back
    // affordance, which lives in that strip, with it.
    rootAppleNavigationState.editorVisible = true;

    render(workspaceValue("narrow", false));

    expect(barMounted()).toBe(true);
    // The strip is drawn in the flow above the navigator, so the panes below
    // start under it: a consumer of the context sees a zero top inset.
    expect(topInsetSeenByPanes()).toBe(0);
    // The strip's actual rendered height (24 top inset + 4 + 49 + 4), not a
    // hardware guess, is what the editor's keyboard avoidance reads.
    expect(tabBarOffsetSeenByPanes()).toBe(81);
  });

  it("moves primary ownership and both insets together across actual iPad widths", () => {
    rootSettingState.dimensions.width = 1376;
    render(); // Root is above, not inside, the workspace provider in the app.
    const probe = () => tree!.root.findByType("FluidPanelsProbe" as never).props;
    expect(barMounted()).toBe(false);
    expect(probe().primary.selection).toBe("library");
    expect(topInsetSeenByPanes()).toBe(24);
    expect(tabBarOffsetSeenByPanes()).toBe(0);
    for (const width of [1032, 512, 699, 700, 1099]) {
      rootSettingState.dimensions.width = width;
      update();
      expect(barMounted()).toBe(true);
      expect(probe().primary).toBeNull();
      expect(topInsetSeenByPanes()).toBe(0);
      expect(tabBarOffsetSeenByPanes()).toBe(81);
    }
    rootSettingState.dimensions.width = 1100;
    update();
    expect(barMounted()).toBe(false);
    expect(probe().primary).not.toBeNull();
    rootSettingState.fullscreen = true;
    update();
    expect(barMounted()).toBe(true);
    expect(probe().primary).toBeNull();
    expect(tabBarOffsetSeenByPanes()).toBe(81);
    rootSettingState.fullscreen = false;
    update();
    expect(barMounted()).toBe(false);
    expect(topInsetSeenByPanes()).toBe(24);
  });

  it.each(["Tasks", "GlobalSearch", "Settings"])("retains the primary return strip on covering %s at wide width", (route) => {
    rootSettingState.dimensions.width = 1376;
    mockNavigationState.state = { routes: [{ name: route }], index: 0 };
    render();
    expect(barMounted()).toBe(true);
    expect(tree!.root.findByType("FluidPanelsProbe" as never).props.primary).toBeNull();
    expect(tabBarOffsetSeenByPanes()).toBe(81);
    expect(topInsetSeenByPanes()).toBe(0);
  });

  it("resumes the iPad notebook workspace without a child-route reset or pager move", () => {
    const { rootNavigatorRef, fluidTabsRef } = jest.requireMock("../utils/global-refs");
    const previousRoot = rootNavigatorRef.current;
    const previousPager = fluidTabsRef.current;
    const notebook = { name: "Notebook", params: { id: "qa-book" } };
    const navigate = jest.fn();
    const goToPage = jest.fn();
    rootNavigatorRef.current = { navigate, getCurrentRoute: () => notebook };
    fluidTabsRef.current = { goToPage };
    try {
      rootSettingState.dimensions.width = 1376;
      render();
      const primary = tree!.root.findByType("FluidPanelsProbe" as never).props.primary;
      expect(primary.onSelect).toBe(selectAppleSection);
      for (const destination of ["library", "tasks", "library", "search", "library"])
        act(() => primary.onSelect(destination));
      expect(navigate.mock.calls).toEqual([
        ["FluidPanelsView"], ["Tasks"], ["FluidPanelsView"], ["GlobalSearch"], ["FluidPanelsView"]
      ]);
      expect(goToPage).not.toHaveBeenCalled();
      expect(notebook).toEqual({ name: "Notebook", params: { id: "qa-book" } });
      expect(rootAppleNavigationState.setSection).toHaveBeenLastCalledWith("library");
      rootSettingState.dimensions.width = 512;
      act(() => selectAppleSection("library"));
      expect(goToPage).toHaveBeenCalledTimes(1);
      expect(goToPage).toHaveBeenLastCalledWith("home", true);
      expect(navigate).toHaveBeenLastCalledWith("FluidPanelsView");
      expect(navigate.mock.calls.every((args: unknown[]) => args.length === 1)).toBe(true);
    } finally {
      rootNavigatorRef.current = previousRoot;
      fluidTabsRef.current = previousPager;
    }
  });

  it("keeps the bar for the tablet-classified iPad widths, note open or not", () => {
    // The 688 pt iPad ("small tablet") and the medium/wide ones were never
    // affected; the gate must not start depending on the width class either.
    rootSettingState.deviceMode = "tablet";
    rootAppleNavigationState.editorVisible = true;

    render(workspaceValue("narrow", false));
    expect(barMounted()).toBe(true);
    expect(topInsetSeenByPanes()).toBe(0);
    expect(tabBarOffsetSeenByPanes()).toBe(81);

    // The overview hides nothing on iPad: the strip is window chrome.
    rootAppleNavigationState.editorVisible = false;
    update();
    expect(barMounted()).toBe(true);
    expect(topInsetSeenByPanes()).toBe(0);
    expect(tabBarOffsetSeenByPanes()).toBe(81);
  });

  it("hides the iPhone bottom bar for an open note and restores the overview", () => {
    mockPlatform.isPad = false;
    rootAppleNavigationState.editorVisible = true;

    render(undefined);
    expect(barMounted()).toBe(false);
    // No top strip on iPhone: the panes keep the window's own top inset.
    expect(topInsetSeenByPanes()).toBe(24);
    // iPhone has no top strip, so the published offset stays zero.
    expect(tabBarOffsetSeenByPanes()).toBe(0);

    // The overview is where the iPhone bar belongs.
    rootAppleNavigationState.editorVisible = false;
    update();
    expect(barMounted()).toBe(true);
    expect(topInsetSeenByPanes()).toBe(24);
    expect(tabBarOffsetSeenByPanes()).toBe(0);
  });

  it("keeps Android and Mac Catalyst without a bar", () => {
    rootAppleNavigationState.editorVisible = true;

    mockPlatform.OS = "android";
    render(undefined);
    expect(barMounted()).toBe(false);
    expect(topInsetSeenByPanes()).toBe(24);
    expect(tabBarOffsetSeenByPanes()).toBe(0);
    unmount();

    // Mac shows no bar at all, and keeps the Mac toolbar inset instead (0 in
    // this fixture, where UIKit reports no top inset) - never the strip's zero.
    mockPlatform.OS = "ios";
    (isMacCatalyst as jest.Mock).mockReturnValue(true);
    render(undefined);
    expect(barMounted()).toBe(false);
    expect(topInsetSeenByPanes()).toBe(0);
    expect(tabBarOffsetSeenByPanes()).toBe(0);
  });

  it("keeps the intro and loading gates in front of the bar", () => {
    rootAppleNavigationState.editorVisible = true;

    // The bar is a root-section affordance; the intro is not a section.
    rootSettingState.settings.introCompleted = false;
    render(undefined);
    expect(introMounted()).toBe(true);
    expect(barMounted()).toBe(false);
    expect(topInsetSeenByPanes()).toBe(24);
    unmount();

    // ... and neither is a root that is still loading.
    rootSettingState.settings.introCompleted = true;
    rootSettingState.isAppLoading = true;
    render(undefined);
    expect(barMounted()).toBe(false);
    expect(topInsetSeenByPanes()).toBe(24);
    expect(tabBarOffsetSeenByPanes()).toBe(0);
  });

  it("keeps the bar off routes that are not root sections", () => {
    rootAppleNavigationState.editorVisible = true;

    // A stack route with no section of its own, reported the way the container
    // reports the focused route. The iPad + open-note tuple is the one from the
    // fixed case, so only the route can explain the missing bar.
    mockNavigationState.state = { routes: [{ name: "MoveNotebook" }], index: 0 };
    render(workspaceValue("narrow", false));
    expect(barMounted()).toBe(false);
    expect(topInsetSeenByPanes()).toBe(24);
    expect(tabBarOffsetSeenByPanes()).toBe(0);
    unmount();

    // ... while the same tuple on a section route does mount the bar.
    mockNavigationState.state = { routes: [{ name: "Tasks" }], index: 0 };
    render(workspaceValue("narrow", false));
    expect(barMounted()).toBe(true);
    expect(topInsetSeenByPanes()).toBe(0);
    expect(tabBarOffsetSeenByPanes()).toBe(81);
  });
});

describe("apple-tab-bar top strip geometry matches getTopTabBarHeight", () => {
  it("keeps the rendered strip's padding + native bar height equal to the shared helper", () => {
    const { AppleTabBar: RealAppleTabBar, APPLE_TAB_BAR_HEIGHT } =
      jest.requireActual("../components/apple-tab-bar");
    const { getTopTabBarHeight } = jest.requireActual(
      "../components/apple-tab-bar-layout"
    );
    mockPlatform.OS = "ios";
    mockPlatform.isPad = true;
    (isMacCatalyst as jest.Mock).mockReturnValue(false);

    let geometryTree: ReactTestRenderer | undefined;
    act(() => {
      geometryTree = create(<RealAppleTabBar onSelect={jest.fn()} />);
    });

    const strip = geometryTree?.root.findByProps({
      testID: notesnook.tabbar.id
    });
    const style = strip?.props.style as {
      paddingTop: number;
      paddingBottom: number;
    };

    expect(
      style.paddingTop + style.paddingBottom + APPLE_TAB_BAR_HEIGHT
    ).toBe(getTopTabBarHeight(24));

    act(() => geometryTree?.unmount());
  });
});
