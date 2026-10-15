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

/** Combined RootNavigation -> mocked NavigationContainer/native stack -> minimal
 * workspace adapter -> REAL SideMenu/REAL C4 controls. Root providers, selection
 * handler, source composition, Home and notebook rows are real. Tags/colors/pins
 * and virtualizers are seams. Adapter reads the shared measured
 * dimension store; it does not render FluidPanelsView, editor or Tasks/Search
 * screens. Native hosts/virtualizers, DB/data stores, theme and presenters are seams.
 * No Yoga, real navigation/scroll/keyboard or native acceptance is implied.
 * The medium open-drawer/pager path and Settings-screen hop beyond UserSheet
 * remain UNVERIFIED; the account/settings affordance itself is exercised.
 */
import React from "react";
import { Platform } from "react-native";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { RootNavigation } from "./navigation-stack";
import { useSettingStore } from "../stores/use-setting-store";
import { useAppleNavigationStore } from "../stores/use-apple-navigation-store";
import { getTopTabBarHeight } from "../components/apple-tab-bar-layout";
import Navigation from "../services/navigation";
import { AddNotebookSheet } from "../components/sheets/add-notebook";
import { UserSheet } from "../components/sheets/user";
import { ToastManager } from "../services/event-manager";
let mockDark = false,
  mockDefault = 0,
  mockAllowed = true,
  mockEmpty = false,
  mockLoading = false,
  mockFocused = "book",
  mockTagMounts = 0;
const mockBook = {
  id: "book",
  title: "Langes Notebook mit Dokumentation",
  type: "notebook",
  dateModified: 1
};
const mockItem = { notebook: mockBook, depth: 0, hasChildren: true };
const mockGroup = {
  placeholders: ["book"],
  item: jest.fn(async () => ({ item: mockBook }))
};
const mockEmptyGroup = { placeholders: [], item: jest.fn() };
const mockOpenNotebook = jest.fn(),
  mockTheme = jest.fn();
const mockFeature = jest.fn(async (_feature?: string) => ({
  isAllowed: mockAllowed,
  error: "Not available"
}));
let mockContainerChange: (state: unknown) => void = () => {};
let mockAdapterMounts = 0,
  mockAdapterUnmounts = 0;
const mockNavigate = jest.fn(),
  mockPagerHome = jest.fn();

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    isDark: mockDark,
    colors: {
      primary: {
        icon: "#222222",
        background: "#ffffff",
        paragraph: "#111111",
        accent: "#087c3e",
        heading: "#111111",
        separator: "#dddddd",
        placeholder: "#777777"
      },
      secondary: {
        background: "#eeeeee",
        icon: "#777777",
        paragraph: "#666666"
      },
      selected: { paragraph: "#111111", icon: "#087c3e" },
      static: { yellow: "#ffff00" }
    }
  })
}));

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

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy(
    {},
    {
      get: (_t, key) => {
        if (
          key === "routes" ||
          key === "dataTypes" ||
          key === "dataTypesPluralCamelCase"
        )
          return new Proxy(
            {},
            {
              get: (_o, name) => () =>
                name === "AllNotes"
                  ? "All Notes"
                  : name === "notebook"
                  ? "Notebook"
                  : String(name)
            }
          );
        if (key === "notes") return (n: number) => `${n} notes`;
        if (key === "addNotebook") return () => "New Notebook";
        if (key === "settings") return () => "Settings";
        if (key === "more") return () => "More";
        if (key === "select") return () => "Select";
        return () => String(key);
      }
    }
  )
}));

jest.mock("@notesnook/common", () => ({
  isFeatureAvailable: (...args: unknown[]) => mockFeature(args[0] as string)
}));

jest.mock("@notesnook/core", () => ({
  EVENTS: {
    databaseUpdated: "databaseUpdated",
    syncCompleted: "syncCompleted"
  },
  isInternalLink: jest.fn(() => false),
  parseInternalLink: jest.fn(() => undefined)
}));

jest.mock("../utils/constants", () => ({
  isMacCatalyst: jest.fn(() => false)
}));

jest.mock("../hooks/use-tooltip", () => ({ hideAllTooltips: jest.fn() }));

jest.mock("../hooks/use-shortcut-manager", () => ({
  launchNewNoteTab: jest.fn()
}));

jest.mock("../services/settings", () => ({
  __esModule: true,
  default: { getProperty: () => mockDefault }
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
  eSubscribeEvent: () => ({ unsubscribe: jest.fn() }),
  eUnSubscribeEvent: jest.fn(),
  subscribeToItemUpdate: () => ({ unsubscribe: jest.fn() }),
  presentSheet: jest.fn(),
  ToastManager: { show: jest.fn() }
}));

jest.mock("../services/navigation", () => ({
  __esModule: true,
  default: {
    navigate: jest.fn(),
    resetRootState: jest.fn(),
    closeDrawer: jest.fn(),
    routeNeedsUpdate: jest.fn(),
    routeUpdateFunctions: { Notebooks: jest.fn(), Tags: jest.fn() }
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

jest.mock("../components/apple-tab-bar", () => {
  const React = require("react");
  const actual = jest.requireActual("../components/apple-tab-bar");
  return {
    ...actual,
    AppleTabBar: (props: Record<string, unknown>) =>
      React.createElement("AppleTabBar", props)
  };
});

jest.mock("../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: Platform.OS === "ios",
    sidebarBackground: mockDark ? "#252527" : "#ecedef",
    sidebarPadding: 12,
    pagePadding: 16,
    sectionSpacing: 20,
    separator: "#dddddd",
    controlRadius: 16,
    selectedSurface: "#ddf0e4",
    navigationSurface: "#ecedef",
    secondaryText: "#666666"
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
    notes: {
      all: { count: async () => 10 },
      unassigned: { count: async () => 3 },
      favorites: { count: async () => 2 },
      archived: { count: async () => 1 }
    },
    settings: { setSideBarOrder: jest.fn(), setSideBarHiddenItems: jest.fn() },
    notebooks: {
      notebook: jest.fn(async () => mockBook),
      all: { items: jest.fn(async () => [mockBook]) }
    },
    tasks: { smartList: async () => [], isMigratedReminder: () => false },
    monographs: { all: { count: async () => 0 } },
    trash: { all: async () => [] },
    tags: { add: jest.fn() }
  }
}));

jest.mock("../components/task-symbol-view", () => ({
  TaskSymbolView: "NativeSymbol"
}));

jest.mock("../components/sheets/add-notebook", () => ({
  AddNotebookSheet: { present: jest.fn() }
}));

jest.mock("@legendapp/list", () => ({
  LegendList: (props: {
    data: unknown[];
    renderItem: (info: unknown) => unknown;
    ListHeaderComponent?: React.ReactNode;
    ListEmptyComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
  }) => {
    const React = require("react");
    return React.createElement(
      "LegendList",
      props,
      props.ListHeaderComponent,
      props.data.length
        ? props.data.map((item, index) =>
            React.createElement(
              React.Fragment,
              { key: index },
              props.renderItem({ item, index })
            )
          )
        : props.ListEmptyComponent,
      props.ListFooterComponent
    );
  }
}));

jest.mock("react-native-drax", () => ({
  DraxProvider: ({ children }: { children?: React.ReactNode }) => children,
  DraxScrollView: "DraxScrollView"
}));

jest.mock("../utils/size", () => ({
  AppFontSize: { lg: 20, md: 17, xs: 14, sm: 15, xxs: 12, xxxs: 11 },
  defaultBorderRadius: 8
}));

jest.mock("../components/ui/pressable", () => ({
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
    require("react").createElement("Pressable", props, children)
}));

jest.mock("../components/ui/icon-button", () => ({ IconButton: "IconButton" }));

jest.mock("../components/ui/button", () => ({ Button: "Button" }));

jest.mock("../components/ui/AppIcon", () => ({
  __esModule: true,
  default: "AppIcon"
}));

jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => ({
  __esModule: true,
  default: "LegacyIcon"
}));

jest.mock("../assets/images/veyran-icon.png", () => 1);

jest.mock("../components/side-menu/sync-status-button", () => ({
  __esModule: true,
  default: "SyncStatusButton"
}));

jest.mock("../components/sheets/user", () => ({
  UserSheet: { present: jest.fn() }
}));

jest.mock("../components/sheets/sort", () => ({
  __esModule: true,
  default: "Sort"
}));

jest.mock("../components/dialog/functions", () => ({
  presentDialog: jest.fn()
}));

jest.mock("../components/properties", () => ({
  Properties: { present: jest.fn() }
}));

jest.mock("../components/sheets/menu-item-properties", () => ({
  MenuItemProperties: { present: jest.fn() }
}));

jest.mock("../hooks/use-group-options", () => ({
  useGroupOptions: () => ({ sortDirection: "asc" })
}));

jest.mock("../hooks/use-db-item", () => ({
  useTotalNotes: () => ({ getTotalNotes: jest.fn(), totalNotes: () => 7 })
}));

jest.mock("../stores/use-user-store", () => ({
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({ profile: undefined })
}));

jest.mock("../stores/use-notebook-store", () => ({
  useNotebooks: () => [
    mockLoading ? undefined : mockEmpty ? mockEmptyGroup : mockGroup,
    mockLoading
  ]
}));

jest.mock("../stores/use-menu-store", () => ({
  useMenuStore: (selector: (state: unknown) => unknown) =>
    selector({ order: { routes: [] }, hiddenItems: { routes: [] } })
}));

jest.mock("../stores/use-theme-store", () => ({
  useThemeStore: { getState: () => ({ setColorScheme: mockTheme }) }
}));

jest.mock("../stores/use-relation-store", () => ({
  useRelationStore: (selector: (state: unknown) => unknown) =>
    selector({ updater: 0 })
}));

jest.mock("../stores/use-tag-store", () => ({
  useTagStore: { getState: () => ({ refresh: jest.fn() }) }
}));

jest.mock("../services/templates", () => ({
  getTemplateCount: async () => 0
}));

jest.mock("../utils/functions", () => ({ deleteItems: jest.fn() }));

jest.mock("../screens/notebook", () => ({
  __esModule: true,
  default: { navigate: (...args: unknown[]) => mockOpenNotebook(...args) }
}));

jest.mock("../utils/menu-items", () => ({
  MenuItemsList: [
    {
      id: "Notes",
      title: "Notes",
      icon: "note-outline",
      type: "side-menu-item"
    },
    ...[
      "Favorites",
      "Tasks",
      "Monographs",
      "Archive",
      "Templates",
      "Trash"
    ].map((id) => ({
      id,
      title: id,
      icon: "note-outline",
      type: "side-menu-item"
    }))
  ]
}));

jest.mock("../components/list/reorderable-list", () => ({
  __esModule: true,
  default: (props: {
    data: { id: string }[];
    itemOrder?: string[];
    hiddenItems?: string[];
    renderDraggableItem: (info: unknown) => unknown;
  }) => {
    const React = require("react");
    return React.createElement(
      "ReorderableList",
      props,
      props.data
        .filter((item) => !props.hiddenItems?.includes(item.id))
        .map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: item.id },
            props.renderDraggableItem({ item, index })
          )
        )
    );
  }
}));

jest.mock("../components/side-menu/color-section", () => ({
  ColorSection: "ColorSection"
}));

jest.mock("../components/side-menu/pinned-section", () => ({
  PinnedSection: "PinnedSection"
}));

jest.mock("../components/side-menu/side-menu-tags", () => ({
  SideMenuTags: () => {
    const React = require("react");
    const [value, setValue] = React.useState("");
    React.useEffect(() => {
      mockTagMounts += 1;
    }, []);
    return React.createElement("TagsProbe", { value, onChange: setValue });
  }
}));

jest.mock("../components/side-menu/dragging-store", () => ({
  useSideBarDraggingStore: require("zustand").create(() => ({
    dragging: false
  }))
}));

jest.mock("../components/side-menu/stores", () => {
  const { create } = require("zustand");
  const selection = () =>
    create(
      (
        set: (state: unknown) => void,
        get: () => { selection: Record<string, string> }
      ) => ({
        enabled: false,
        selection: {},
        multiSelect: true,
        initialState: {},
        markAs: (item: { id: string }, value: string) =>
          set({ selection: { ...get().selection, [item.id]: value } }),
        setSelection: (selection: unknown) => set({ selection }),
        getSelectedItemIds: () =>
          Object.keys(get().selection).filter(
            (id) => get().selection[id] === "selected"
          )
      })
    );
  return {
    useSideMenuNotebookSelectionStore: selection(),
    useSideMenuTagsSelectionStore: selection(),
    useSideMenuNotebookExpandedStore: create(
      (set: (state: unknown) => void) => ({
        expanded: {},
        setExpanded: (id: string) => set({ expanded: { [id]: true } })
      })
    ),
    useSideMenuNotebookTreeStore: create(() => ({
      tree: [
        {
          notebook: {
            id: "book",
            title: "Langes Notebook mit Dokumentation",
            type: "notebook",
            dateModified: 1
          },
          depth: 0,
          hasChildren: true
        }
      ],
      isSearching: false,
      addNotebooks: async () => [mockItem],
      setTree: jest.fn(),
      fetchAndAdd: jest.fn(async () => [mockItem]),
      removeChildren: jest.fn(),
      updateItem: jest.fn(),
      removeItem: jest.fn()
    }))
  };
});
jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Image: "Image",
  TextInput: "TextInput",
  Pressable: "NativePressable",
  ScrollView: "ScrollView",
  FlatList: "FlatList",
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
  Keyboard: { dismiss: jest.fn() },
  Dimensions: {
    get: () => ({ width: 1376, height: 1024, scale: 2, fontScale: 1 })
  },
  PixelRatio: {
    get: () => 2,
    getFontScale: () => 1,
    roundToNearestPixel: (v: number) => v
  },
  BackHandler: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  requireNativeComponent: () => "NativeTabBarView",
  StyleSheet: { create: (s: unknown) => s, absoluteFill: {} }
}));
jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: require("zustand").create((set: (s: unknown) => void) => ({
    isAppLoading: false,
    deviceMode: "tablet",
    fullscreen: false,
    dimensions: { width: 1376, height: 1024 },
    settings: { introCompleted: true, homepageV2: undefined },
    initialUrl: undefined,
    pendingShortcut: null,
    setDimensions: (dimensions: unknown) => set({ dimensions })
  }))
}));
// The primary section is the production Zustand store, not a parallel test owner.
jest.mock("../utils/global-refs", () => ({
  rootNavigatorRef: {
    current: {
      navigate: (...args: unknown[]) => mockNavigate(...args),
      getCurrentRoute: () => ({ name: "FluidPanelsView" }),
      getState: () => ({ routes: [] })
    },
    isReady: () => true
  },
  fluidTabsRef: {
    current: { goToPage: (...args: unknown[]) => mockPagerHome(...args) }
  },
  appNavigatorRef: { current: null },
  editorRef: { current: null },
  inputRef: { current: null }
}));
jest.mock("../stores/use-navigation-store", () => {
  const state = () => ({
    focusedRouteId: mockFocused,
    currentRoute: "Notebook",
    setFocusedRouteId: (id: string) => {
      mockFocused = id;
    },
    update: jest.fn()
  });
  return {
    __esModule: true,
    default: Object.assign(
      (selector: (s: unknown) => unknown) => selector(state()),
      { getState: state }
    )
  };
});
jest.mock("../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: function useTestGlobalSafeAreaInsets() {
    return require("react").useContext(
      require("react-native-safe-area-context").SafeAreaInsetsContext
    );
  }
}));
jest.mock("@react-navigation/native", () => ({
  NavigationContainer: (props: {
    children?: React.ReactNode;
    onReady?: () => void;
    onStateChange?: (s: unknown) => void;
  }) => {
    mockContainerChange = props.onStateChange || (() => {});
    require("react").useEffect(() => {
      props.onReady?.();
    }, []);
    return require("react").createElement(
      "NavigationContainer",
      null,
      props.children
    );
  },
  createNavigationContainerRef: () => ({ current: null, isReady: () => true }),
  useRoute: () => ({ name: "Notebook", params: { id: "book" } })
}));
jest.mock("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: () => ({
    Navigator: (props: {
      children?: React.ReactNode;
      initialRouteName?: string;
    }) => {
      const React = require("react");
      const screens = React.Children.toArray(
        props.children
      ) as React.ReactElement<{
        name: string;
        getComponent: () => React.ComponentType;
      }>[];
      const route = screens.find(
        (s) => s.props.name === props.initialRouteName
      );
      if (!route) return null;
      const Screen = route.props.getComponent();
      return React.createElement(
        "NativeStackAdapter",
        { route: route.props.name },
        React.createElement(Screen)
      );
    },
    Screen: () => null
  })
}));
jest.mock("./fluid-panels-view", () => {
  const React = require("react");
  const { View } = require("react-native");
  const { useSettingStore } = require("../stores/use-setting-store");
  const {
    IPadWorkspaceProvider
  } = require("../components/ipad-workspace-context");
  const { resolveIPadPaneMode } = require("../utils/ipad-layout");
  const { SafeAreaInsetsContext } = require("react-native-safe-area-context");
  const {
    AppleTabBarOffsetContext
  } = require("../components/apple-tab-bar-layout");
  const { SideMenu } = require("../components/side-menu");
  function MeasuredWorkspaceAdapter() {
    const width = useSettingStore(
      (s: { dimensions: { width: number } }) => s.dimensions.width
    );
    const fullscreen = useSettingStore(
      (s: { fullscreen: boolean }) => s.fullscreen
    );
    const insets = React.useContext(SafeAreaInsetsContext),
      offset = React.useContext(AppleTabBarOffsetContext);
    const paneMode = resolveIPadPaneMode(width),
      sidebarVisible = paneMode === "wide" && !fullscreen;
    React.useEffect(() => {
      mockAdapterMounts++;
      return () => {
        mockAdapterUnmounts++;
      };
    }, []);
    return React.createElement(
      View,
      {
        testID: "measured-workspace-adapter",
        top: insets.top,
        offset,
        width,
        onLayout: (e: {
          nativeEvent: { layout: { width: number; height: number } };
        }) => useSettingStore.getState().setDimensions(e.nativeEvent.layout)
      },
      React.createElement(
        IPadWorkspaceProvider,
        { value: { paneMode, sidebarVisible } },
        React.createElement(SideMenu)
      )
    );
  }
  return { __esModule: true, default: MeasuredWorkspaceAdapter };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer;
const controls = () => [
  ...tree.root.findAllByType("NativePressable" as never),
  ...tree.root.findAllByType("Pressable" as never)
];
const button = (id: string) => {
  const b = controls().find((n) => n.props.testID === id);
  if (!b) throw new Error(`Missing ${id}`);
  return b;
};
const primary = () =>
  controls().filter((n) =>
    /^ipad-primary-(library|tasks|search)$/.test(n.props.testID || "")
  );
const adapter = () =>
  tree.root.findByProps({ testID: "measured-workspace-adapter" });
const strip = () => tree.root.findAllByType("AppleTabBar" as never);
const layout = (width: number) =>
  act(() =>
    adapter().props.onLayout({
      nativeEvent: { layout: { width, height: 1024 } }
    })
  );
const reportRoute = (name: string) =>
  act(() => mockContainerChange({ routes: [{ name }], index: 0 }));
async function render() {
  await act(async () => {
    tree = create(<RootNavigation />);
  });
}
beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ["nextTick", "queueMicrotask", "setImmediate"]
  });
  mockDefault = 0;
  mockDark = false;
  mockAllowed = true;
  mockEmpty = false;
  mockLoading = false;
  mockFocused = "book";
  mockTagMounts = 0;
  mockAdapterMounts = 0;
  mockAdapterUnmounts = 0;
  jest.clearAllMocks();
  useSettingStore.setState({
    isAppLoading: false,
    deviceMode: "tablet",
    fullscreen: false,
    dimensions: { width: 1376, height: 1024 },
    settings: { introCompleted: true } as never
  });
  useAppleNavigationStore.setState({
    section: "library",
    settingsVisible: false,
    editorVisible: false
  });
});
afterEach(() => {
  act(() => tree?.unmount());
  jest.clearAllTimers();
  jest.useRealTimers();
});

it("wires the real Root provider through NavigationContainer to real SideMenu and C4, with existing gated actions", async () => {
  await render();
  expect(tree.root.findAllByType("NavigationContainer" as never)).toHaveLength(
    1
  );
  expect(primary().map((n) => n.props.testID)).toEqual([
    "ipad-primary-library",
    "ipad-primary-tasks",
    "ipad-primary-search"
  ]);
  expect(strip()).toHaveLength(0);
  expect(adapter().props.top).toBe(24);
  expect(adapter().props.offset).toBe(0);
  expect(button("ipad-primary-library").props.accessibilityState.selected).toBe(
    true
  );
  expect(button("notebook-item-0-0").props.accessibilityState.selected).toBe(
    true
  );
  act(() => button("ipad-primary-library").props.onPress());
  expect(mockNavigate).toHaveBeenLastCalledWith("FluidPanelsView");
  expect(mockPagerHome).not.toHaveBeenCalled();
  for (const section of ["tasks", "search", "library"] as const) {
    act(() => useAppleNavigationStore.getState().setSection(section));
    expect(
      button(`ipad-primary-${section}`).props.accessibilityState.selected
    ).toBe(true);
    expect(
      primary().filter((node) => node.props.accessibilityState.selected)
    ).toHaveLength(1);
  }
  await act(async () => button("notebook-item-0-0").props.onPress());
  expect(mockOpenNotebook).toHaveBeenCalledWith(mockBook, false);
  expect(Navigation.closeDrawer).toHaveBeenCalledTimes(1);
  act(() => button("sidemenu-settings-icon").props.onPress());
  expect(UserSheet.present).toHaveBeenCalledTimes(1);
  await act(async () => button("ipad-source-new-notebook").props.onPress());
  expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
  mockAllowed = false;
  await act(async () => button("ipad-source-new-notebook").props.onPress());
  expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
  expect(ToastManager.show).toHaveBeenCalled();
});

it.each([1032, 512])(
  "uses measured width %s for strip/sidebar ownership and restores the same source-scene instance",
  async (width) => {
    await render();
    act(() => button("ipad-source-tags").props.onPress());
    const tags = () => tree.root.findByType("TagsProbe" as never);
    act(() => tags().props.onChange("retained source filter"));
    expect(mockTagMounts).toBe(1);
    layout(width);
    expect(adapter().props.width).toBe(width);
    expect(primary()).toHaveLength(0);
    expect(strip()).toHaveLength(1);
    expect(adapter().props.top).toBe(0);
    expect(adapter().props.offset).toBe(getTopTabBarHeight(24));
    expect(tags().props.value).toBe("retained source filter");
    layout(1376);
    expect(primary()).toHaveLength(3);
    expect(strip()).toHaveLength(0);
    expect(adapter().props.top).toBe(24);
    expect(adapter().props.offset).toBe(0);
    expect(tags().props.value).toBe("retained source filter");
    expect(mockTagMounts).toBe(1);
    expect(mockAdapterMounts).toBe(1);
    expect(mockAdapterUnmounts).toBe(0);
    expect(mockFocused).toBe("book");
  }
);

it("changes provider value in fullscreen without replacing the source subtree", async () => {
  await render();
  act(() => button("ipad-source-tags").props.onPress());
  const tags = () => tree.root.findByType("TagsProbe" as never);
  act(() => tags().props.onChange("fullscreen filter"));
  act(() => useSettingStore.setState({ fullscreen: true }));
  expect(primary()).toHaveLength(0);
  expect(strip()).toHaveLength(1);
  expect(adapter().props.offset).toBe(getTopTabBarHeight(24));
  act(() => useSettingStore.setState({ fullscreen: false }));
  expect(primary()).toHaveLength(3);
  expect(strip()).toHaveLength(0);
  expect(tags().props.value).toBe("fullscreen filter");
  expect(mockTagMounts).toBe(1);
  expect(mockAdapterMounts).toBe(1);
  expect(mockAdapterUnmounts).toBe(0);
});

it.each(["tasks", "search"] as const)(
  "delegates%s through the actual section handler, uses covering-route fallback, and dispatches context-preserving Notes return",
  async (section) => {
    await render();
    act(() => button(`ipad-primary-${section}`).props.onPress());
    expect(useAppleNavigationStore.getState().section).toBe(section);
    const route = section === "tasks" ? "Tasks" : "GlobalSearch";
    expect(mockNavigate).toHaveBeenCalledWith(route);
    reportRoute(route);
    expect(primary()).toHaveLength(0);
    expect(strip()).toHaveLength(1);
    act(() => strip()[0].props.onSelect("library"));
    expect(mockNavigate).toHaveBeenLastCalledWith("FluidPanelsView");
    expect(mockPagerHome).not.toHaveBeenCalled();
    expect(mockFocused).toBe("book");
    reportRoute("FluidPanelsView");
    expect(primary()).toHaveLength(3);
    expect(strip()).toHaveLength(0);
    expect(
      button("ipad-primary-library").props.accessibilityState.selected
    ).toBe(true);
    expect(button("notebook-item-0-0").props.accessibilityState.selected).toBe(
      true
    );
    expect(mockAdapterMounts).toBe(1);
    expect(mockAdapterUnmounts).toBe(0);
  }
);

it("returns narrow Notes via pager home without a nested Library reset", async () => {
  await render();
  layout(512);
  reportRoute("Tasks");
  act(() => strip()[0].props.onSelect("library"));
  expect(mockPagerHome).toHaveBeenCalledWith("home", true);
  expect(mockNavigate).toHaveBeenLastCalledWith("FluidPanelsView");
  expect(
    mockNavigate.mock.calls.some(
      (call) => call.length > 1 && call[1]?.screen === "Library"
    )
  ).toBe(false);
  expect(mockFocused).toBe("book");
});
