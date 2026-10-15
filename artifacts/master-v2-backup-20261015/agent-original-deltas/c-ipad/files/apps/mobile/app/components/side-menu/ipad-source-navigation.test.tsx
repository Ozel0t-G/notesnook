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

/** Real SideMenu, Home, Notebooks/tree wrapper, NotebookItem, native-source sections,
 * header/settings and MenuItem. Native hosts/virtualizers, DB/store data, tag scene,
 * theme resolver, sheets and global navigation are explicit test seams.
 * No Yoga/width/device/VoiceOver certification is implied.
 */
import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { Platform } from "react-native";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { IPadSourceSection } from "./ipad-source-navigation";
import { SideMenu } from "./index";
import { NotebookItem } from "./notebook-item";
import type { TreeItem } from "../../stores/create-notebook-tree-stores";
import { IPadWorkspaceProvider } from "../ipad-workspace-context";
import { IPadPrimaryNavigationContext } from "../ipad-primary-navigation-context";
import {
  useSideMenuNotebookSelectionStore,
  useSideMenuTagsSelectionStore,
  useSideMenuNotebookTreeStore
} from "./stores";
import { useSideBarDraggingStore } from "./dragging-store";
import { db } from "../../common/database";
import Navigation from "../../services/navigation";
import { AddNotebookSheet } from "../sheets/add-notebook";
import { UserSheet } from "../sheets/user";
import { Properties } from "../properties";
import { presentSheet, ToastManager } from "../../services/event-manager";
import { useThemeStore } from "../../stores/use-theme-store";
import { deleteItems } from "../../utils/functions";

let mockDark = false;
let mockDefault = 0;
let mockAllowed = true;
let mockEmpty = false;
let mockLoading = false;
let mockFocused = "book";
let mockTagMounts = 0;
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
const mockOpenNotebook = jest.fn();
const mockFeature = jest.fn(async (_feature?: string) => ({
  isAllowed: mockAllowed,
  error: "Not available"
}));

jest.mock("react-native", () => {
  const React = require("react");
  return {
    View: "View",
    Text: "Text",
    Image: "Image",
    TextInput: "TextInput",
    Pressable: "NativePressable",
    Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
    FlatList: ({
      data,
      renderItem,
      ...props
    }: {
      data: unknown[];
      renderItem: (info: unknown) => unknown;
    }) =>
      React.createElement(
        "FlatList",
        props,
        data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: index },
            renderItem({ item, index })
          )
        )
      )
  };
});
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
jest.mock("@notesnook/common", () => ({
  isFeatureAvailable: (...args: unknown[]) => mockFeature(args[0] as string)
}));
jest.mock("@notesnook/intl", () => ({
  strings: new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "routes" || key === "dataTypes" || key === "dataTypesPluralCamelCase")
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
jest.mock("../../utils/apple-visual-tokens", () => ({
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
    secondaryText: mockDark ? "#acacb4" : "#666666"
  })
}));
jest.mock("../../utils/size", () => ({
  AppFontSize: { lg: 20, md: 17, xs: 14, sm: 15, xxs: 12, xxxs: 11 },
  defaultBorderRadius: 8
}));
jest.mock("../ui/pressable", () => ({
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
    require("react").createElement("Pressable", props, children)
}));
jest.mock("../ui/icon-button", () => ({ IconButton: "IconButton" }));
jest.mock("../ui/button", () => ({ Button: "Button" }));
jest.mock("../ui/AppIcon", () => ({ __esModule: true, default: "AppIcon" }));
jest.mock("../task-symbol-view", () => ({ TaskSymbolView: "NativeSymbol" }));
jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => ({
  __esModule: true,
  default: "LegacyIcon"
}));
jest.mock("../../assets/images/veyran-icon.png", () => 1);
jest.mock("./sync-status-button", () => ({
  __esModule: true,
  default: "SyncStatusButton"
}));
jest.mock("../sheets/user", () => ({ UserSheet: { present: jest.fn() } }));
jest.mock("../sheets/add-notebook", () => ({
  AddNotebookSheet: { present: jest.fn() }
}));
jest.mock("../sheets/sort", () => ({ __esModule: true, default: "Sort" }));
jest.mock("../dialog/functions", () => ({ presentDialog: jest.fn() }));
jest.mock("../properties", () => ({ Properties: { present: jest.fn() } }));
jest.mock("../sheets/menu-item-properties", () => ({
  MenuItemProperties: { present: jest.fn() }
}));
jest.mock("../../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}));
jest.mock("../../hooks/use-group-options", () => ({
  useGroupOptions: () => ({ sortDirection: "asc" })
}));
jest.mock("../../hooks/use-db-item", () => ({
  useTotalNotes: () => ({ getTotalNotes: jest.fn(), totalNotes: () => 7 })
}));
jest.mock("../../stores/use-user-store", () => ({
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({ profile: undefined })
}));
jest.mock("../../stores/use-notebook-store", () => ({
  useNotebooks: () => [
    mockLoading ? undefined : mockEmpty ? mockEmptyGroup : mockGroup,
    mockLoading
  ]
}));
jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: (selector: (state: unknown) => unknown) =>
    selector({ isAppLoading: false, settings: { introCompleted: true } })
}));
jest.mock("../../stores/use-menu-store", () => ({
  useMenuStore: (selector: (state: unknown) => unknown) =>
    selector({ order: { routes: [] }, hiddenItems: { routes: [] } })
}));
jest.mock("../../stores/use-theme-store", () => ({
  useThemeStore: { getState: () => ({ setColorScheme: mockTheme }) }
}));
const mockTheme = jest.fn();
jest.mock("../../stores/use-relation-store", () => ({
  useRelationStore: (selector: (state: unknown) => unknown) =>
    selector({ updater: 0 })
}));
jest.mock("../../stores/use-tag-store", () => ({
  useTagStore: { getState: () => ({ refresh: jest.fn() }) }
}));
jest.mock("../../services/templates", () => ({
  getTemplateCount: async () => 0
}));
jest.mock("../../services/settings", () => ({
  __esModule: true,
  default: { getProperty: () => mockDefault }
}));
jest.mock("../../services/event-manager", () => ({
  eSubscribeEvent: () => ({ unsubscribe: jest.fn() }),
  eUnSubscribeEvent: jest.fn(),
  subscribeToItemUpdate: () => ({ unsubscribe: jest.fn() }),
  presentSheet: jest.fn(),
  ToastManager: { show: jest.fn() }
}));
jest.mock("../../services/navigation", () => ({
  __esModule: true,
  default: {
    navigate: jest.fn(),
    closeDrawer: jest.fn(),
    routeNeedsUpdate: jest.fn(),
    routeUpdateFunctions: { Notebooks: jest.fn(), Tags: jest.fn() }
  }
}));
jest.mock("../../stores/use-navigation-store", () => {
  const state = () => ({
    focusedRouteId: mockFocused,
    currentRoute: "Library",
    setFocusedRouteId: (id: string) => {
      mockFocused = id;
    }
  });
  return {
    __esModule: true,
    default: Object.assign(
      (selector: (state: unknown) => unknown) => selector(state()),
      { getState: state }
    )
  };
});
jest.mock("../../utils/functions", () => ({ deleteItems: jest.fn() }));
jest.mock("../../screens/notebook", () => ({
  __esModule: true,
  default: { navigate: (...args: unknown[]) => mockOpenNotebook(...args) }
}));
jest.mock("../../common/database", () => ({
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
jest.mock("../../utils/menu-items", () => ({
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
jest.mock("../list/reorderable-list", () => ({
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
jest.mock("./color-section", () => ({ ColorSection: "ColorSection" }));
jest.mock("./pinned-section", () => ({ PinnedSection: "PinnedSection" }));
jest.mock("./side-menu-tags", () => ({
  SideMenuTags: () => {
    const React = require("react");
    const [value, setValue] = React.useState("");
    React.useEffect(() => {
      mockTagMounts += 1;
    }, []);
    return React.createElement("TagsProbe", { value, onChange: setValue });
  }
}));
jest.mock("./dragging-store", () => ({
  useSideBarDraggingStore: require("zustand").create(() => ({
    dragging: false
  }))
}));
jest.mock("./stores", () => {
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
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer;
async function render(primary: React.ContextType<typeof IPadPrimaryNavigationContext> = null) {
  await act(async () => {
    tree = create(
      <IPadWorkspaceProvider
        value={
          Platform.OS === "ios" && Platform.isPad && !Platform.isMacCatalyst
            ? { paneMode: "wide", sidebarVisible: true }
            : undefined
        }
      >
        <IPadPrimaryNavigationContext.Provider value={primary}>
          <SideMenu />
        </IPadPrimaryNavigationContext.Provider>
      </IPadWorkspaceProvider>
    );
  });
}
function buttons() {
  return tree.root.findAllByType("Pressable" as never);
}

it.each([false, true])("mounts the real wide primary controls with their existing sources in dark=%s", async (dark) => {
  mockDark = dark;
  const onSelect = jest.fn();
  await render({ selection: "library", onSelect });
  for (const id of ["library", "tasks", "search"]) {
    const row = tree.root.findAllByType("NativePressable" as never).find(node => node.props.testID === `ipad-primary-${id}`)!;
    expect(row.props.accessibilityRole).toBe("button");
    expect(row.props.accessibilityState.selected).toBe(id === "library");
    await act(async () => row.props.onPress());
    expect(onSelect).toHaveBeenLastCalledWith(id);
  }
  expect(onSelect).toHaveBeenCalledTimes(3);
  expect(mockOpenNotebook).not.toHaveBeenCalled();
  expect(mockFocused).toBe("book");
  expect(tree.root.findAllByProps({ testID: "ipad-primary-destinations" })).toHaveLength(1);
});

it("leaves primary controls to the top strip when Root grants no sidebar ownership", async () => {
  await render();
  expect(tree.root.findAllByProps({ testID: "ipad-primary-destinations" })).toHaveLength(0);
});
function button(id: string) {
  const value = buttons().find((node) => node.props.testID === id);
  if (!value) throw new Error(`Missing ${id}`);
  return value;
}
function activeButton(id: string) {
  const value = buttons().find((node) => {
    if (node.props.testID !== id) return false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        parent.props.accessibilityElementsHidden ||
        parent.props.style?.display === "none"
      )
        return false;
    }
    return true;
  });
  if (!value) throw new Error(`Missing visible ${id}`);
  return value;
}

function text() {
  return tree.root
    .findAllByType("Text" as never)
    .map((node) => node.children.join(" "));
}
beforeEach(() => {
  jest.clearAllMocks();
  mockDark = false;
  mockDefault = 0;
  mockAllowed = true;
  mockEmpty = false;
  mockLoading = false;
  useSideMenuNotebookTreeStore.setState({ tree: [mockItem as TreeItem] });
  mockFocused = "book";
  mockTagMounts = 0;
  Object.assign(Platform, { OS: "ios", isPad: true, isMacCatalyst: false });
  useSideMenuNotebookSelectionStore.setState({ enabled: false, selection: {} });
  useSideMenuTagsSelectionStore.setState({ enabled: false, selection: {} });
  useSideBarDraggingStore.setState({ dragging: false });
});
afterEach(() => {
  if (tree) act(() => tree.unmount());
});

it.each([false, true])(
  "renders simultaneous Library/notebook hierarchy without icon tabs, dark=%s",
  async (dark) => {
    mockDark = dark;
    await render();
    expect(button("ipad-source-home").props.accessibilityLabel).toBe("Library");
    expect(button("All Notes")).toBeDefined();
    expect(button("Inbox")).toBeDefined();
    expect(button("notebook-item-0-0").props.accessibilityState.selected).toBe(
      true
    );
    expect(button("ipad-source-new-notebook").props.accessibilityLabel).toBe(
      "New Notebook"
    );
    expect(button("sidemenu-settings-icon").props.accessibilityLabel).toBe(
      "Settings"
    );
    expect(
      buttons().filter((node) => String(node.props.testID).startsWith("tab-"))
    ).toHaveLength(0);
    expect(text().filter((value) => value === "VeyraN")).toHaveLength(1);
    expect(
      button("ipad-source-home").props.accessibilityState.selected
    ).toBeUndefined();
  }
);
it("keeps all secondary sources reachable through More and current collection navigation", async () => {
  await render();
  expect(buttons().some((node) => node.props.testID === "Favorites")).toBe(
    false
  );
  act(() => button("ipad-source-more").props.onPress());
  for (const id of [
    "Favorites",
    "Tasks",
    "Monographs",
    "Archive",
    "Templates",
    "Trash"
  ])
    expect(button(id)).toBeDefined();
  act(() => button("Inbox").props.onPress());
  expect(Navigation.navigate).toHaveBeenCalledWith("Library", {
    initialCollection: "inbox"
  });
  expect(mockFocused).toBe("Inbox");
  act(() => button("Favorites").props.onPress());
  expect(Navigation.navigate).toHaveBeenCalledWith("Favorites", {
    canGoBack: false
  });
  expect(tree.root.findAllByType("ColorSection" as never)).toHaveLength(1);
  expect(tree.root.findAllByType("PinnedSection" as never)).toHaveLength(1);
});
it("opens the existing notebook route and independently expands its children", async () => {
  await render();
  await act(async () => button("notebook-item-0-0").props.onPress());
  expect(mockOpenNotebook).toHaveBeenCalledWith(mockBook, false);
  expect(Navigation.closeDrawer).toHaveBeenCalled();
  mockOpenNotebook.mockClear();
  await act(async () => button("expand-notebook-0").props.onPress());
  expect(
    useSideMenuNotebookTreeStore.getState().fetchAndAdd
  ).toHaveBeenCalledWith("book", 1);
  expect(mockOpenNotebook).not.toHaveBeenCalled();
});
it("uses the existing gated New Notebook action and respects refusal", async () => {
  await render();
  await act(async () => button("ipad-source-new-notebook").props.onPress());
  expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
  mockAllowed = false;
  await act(async () => button("ipad-source-new-notebook").props.onPress());
  expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
  expect(ToastManager.show).toHaveBeenCalledWith({
    message: "Not available",
    type: "info"
  });
});
it("retains Properties selection, batch actions and locks source switches while selecting", async () => {
  await render();
  act(() => button("notebook-item-0-0").props.onLongPress());
  const args = (Properties.present as jest.Mock).mock.calls[0];
  expect(args[0]).toEqual(mockBook);
  act(() => args[2][0].onPress());
  expect(useSideMenuNotebookSelectionStore.getState().enabled).toBe(true);
  expect(button("ipad-source-tags").props.disabled).toBe(true);
  expect(button("ipad-source-new-notebook").props.disabled).toBe(true);
  expect(button("ipad-source-more").props.disabled).toBe(true);
  const libraryMove = buttons().find((node) =>
    node
      .findAllByType("Text" as never)
      .some((text) => text.children.join(" ") === "Move")
  );
  expect(libraryMove).toBeDefined();
  await act(async () => libraryMove?.props.onPress());
  expect(Navigation.navigate).toHaveBeenCalledWith("MoveNotebook", {
    selectedNotebooks: [mockBook]
  });
  const footer = (title: string) =>
    buttons().find((node) =>
      node
        .findAllByType("Text" as never)
        .some((t) => t.children.join(" ") === title)
    );
  await act(async () => footer("Select all")?.props.onPress());
  expect(
    useSideMenuNotebookSelectionStore.getState().getSelectedItemIds()
  ).toEqual([]);
  await act(async () => footer("Select all")?.props.onPress());
  expect(db.notebooks.all.items).toHaveBeenCalled();
  await act(async () => footer("Delete")?.props.onPress());
  expect(deleteItems).toHaveBeenCalledWith("notebook", ["book"]);
  await act(async () => footer("Close")?.props.onPress());
  expect(useSideMenuNotebookSelectionStore.getState().enabled).toBe(false);
  expect(button("ipad-source-tags").props.disabled).toBe(false);
});
it("preserves tag-scene local state and hides retained offscreen panes from accessibility", async () => {
  await render();
  act(() => button("ipad-source-tags").props.onPress());
  const tag = tree.root.findByType("TagsProbe" as never);
  act(() => tag.props.onChange("filter retained"));
  expect(
    tree.root.findByProps({ testID: "ipad-source-library-pane" }).props
      .accessibilityElementsHidden
  ).toBe(true);
  act(() => activeButton("ipad-source-home-return").props.onPress());
  expect(
    tree.root.findByProps({ testID: "ipad-source-tags-pane" }).props
      .accessibilityElementsHidden
  ).toBe(true);
  act(() => button("ipad-source-tags").props.onPress());
  expect(tree.root.findByType("TagsProbe" as never).props.value).toBe(
    "filter retained"
  );
  expect(mockTagMounts).toBe(1);
});
it("keeps labeled Settings and theme actions reachable", async () => {
  await render();
  act(() => button("sidemenu-settings-icon").props.onPress());
  expect(UserSheet.present).toHaveBeenCalledTimes(1);
  act(() => button("sidebar-theme-button").props.onPress());
  expect(useThemeStore.getState().setColorScheme).toHaveBeenCalledTimes(1);
});
it("respects default Notebook view and preserves existing sort and move routes", async () => {
  mockDefault = 1;
  await render();
  expect(button("ipad-source-home").props.accessibilityState.expanded).toBe(
    false
  );
  act(() => button("sidebar-sort-button").props.onPress());
  expect(presentSheet).toHaveBeenCalled();
  act(() =>
    useSideMenuNotebookSelectionStore.setState({
      enabled: true,
      selection: { book: "selected" }
    })
  );
  const move = buttons().find((node) =>
    node
      .findAllByType("Text" as never)
      .some((t) => t.children.join(" ") === "Move")
  );
  await act(async () => move?.props.onPress());
  expect(Navigation.navigate).toHaveBeenCalledWith("MoveNotebook", {
    selectedNotebooks: [mockBook]
  });
});
it("retains labeled sources and New Notebook in an empty collection", async () => {
  mockEmpty = true;
  await render();
  const scrollSurface = tree.root.findByType("LegendList" as never);
  expect(scrollSurface.props.data).toEqual([]);
  expect(scrollSurface.props.keyboardShouldPersistTaps).toBe("handled");
  expect(scrollSurface.props.ListHeaderComponent).toBeDefined();
  expect(scrollSurface.props.ListEmptyComponent).toBeDefined();
  expect(button("ipad-source-home")).toBeDefined();
  expect(button("ipad-source-new-notebook")).toBeDefined();
  expect(text().filter((value) => value === "VeyraN")).toHaveLength(1);
});
it.each([
  ["iPhone", "ios", false, false],
  ["CatalystMac", "ios", false, true],
  ["CatalystPad", "ios", true, true],
  ["Android", "android", true, false]
])(
  "keeps legacy source tabs on %s",
  async (_name, OS, isPad, isMacCatalyst) => {
    Object.assign(Platform, { OS, isPad, isMacCatalyst });
    await render();
    expect(
      tree.root.findAllByProps({ testID: "ipad-sidebar-footer" })
    ).toHaveLength(0);
    expect(button("tab-home")).toBeDefined();
    expect(button("tab-notebooks")).toBeDefined();
    expect(button("tab-tags")).toBeDefined();
    expect(
      buttons().some((node) => node.props.testID === "ipad-source-home")
    ).toBe(false);
  }
);

it("exposes separate notebook open/disclosure/add actions and current count to accessibility", async () => {
  const open = jest.fn(),
    expand = jest.fn(),
    add = jest.fn(),
    properties = jest.fn();
  await act(async () => {
    tree = create(
      <NotebookItem
        sourceList
        item={mockItem as TreeItem}
        index={2}
        selectionStore={useSideMenuNotebookSelectionStore}
        onItemUpdate={jest.fn()}
        focused
        expanded
        onPress={open}
        onToggleExpanded={expand}
        onAddNotebook={add}
        onLongPress={properties}
      />
    );
  });
  const row = button("notebook-item-0-2");
  expect(row.props.accessibilityRole).toBe("button");
  expect(row.props.accessibilityValue.text).toBe("7 notes");
  expect(row.props.accessibilityState.selected).toBe(true);
  expect(row.props.style.minHeight).toBe(44);
  const disclosure = button("expand-notebook-2");
  expect(disclosure.props.accessibilityState.expanded).toBe(true);
  expect(disclosure.props.style.width).toBe(44);
  expect(disclosure.props.hitSlop).toBeUndefined();
  act(() => disclosure.props.onPress());
  expect(expand).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  act(() => button("add-notebook-2").props.onPress());
  expect(add).toHaveBeenCalledTimes(1);
  await act(async () => row.props.onPress());
  expect(open).toHaveBeenCalledTimes(1);
  act(() => row.props.onLongPress());
  expect(properties).toHaveBeenCalledTimes(1);
});
it("keeps notebook multi-selection semantics and lets long labels grow without fixed height", async () => {
  const item = {
    ...mockItem,
    depth: 9,
    hasChildren: false,
    notebook: {
      ...mockBook,
      title:
        "Sehr langer deutscher Titel mit vielen Wörtern und mehreren Unterebenen"
    }
  } as TreeItem;
  const compose = (selected: boolean) => (
    <NotebookItem
      sourceList
      item={item}
      index={0}
      selectionStore={useSideMenuNotebookSelectionStore}
      onItemUpdate={jest.fn()}
      selectionEnabled
      selected={selected}
    />
  );
  await act(async () => {
    tree = create(compose(false));
  });
  await act(async () => button("notebook-item-9-0").props.onPress());
  expect(useSideMenuNotebookSelectionStore.getState().selection.book).toBe(
    "selected"
  );
  act(() => tree.update(compose(true)));
  expect(button("notebook-item-9-0").props.accessibilityState.selected).toBe(
    true
  );
  await act(async () => button("notebook-item-9-0").props.onPress());
  expect(useSideMenuNotebookSelectionStore.getState().selection.book).toBe(
    "deselected"
  );
  expect(
    buttons().some((node) => node.props.testID === "expand-notebook-0")
  ).toBe(false);
  expect(button("notebook-item-9-0").props.style.height).toBeUndefined();
  for (const node of tree.root.findAllByType("Text" as never)) {
    expect(node.props.numberOfLines).toBeUndefined();
    expect(node.props.allowFontScaling).not.toBe(false);
  }
});
it("keeps shared non-sidebar iPad NotebookItem consumers on the legacy rendering", async () => {
  await act(async () => {
    tree = create(
      <NotebookItem
        item={mockItem as TreeItem}
        index={0}
        selectionStore={useSideMenuNotebookSelectionStore}
        onItemUpdate={jest.fn()}
      />
    );
  });
  expect(tree.root.findAllByType("IconButton" as never).length).toBeGreaterThan(
    0
  );
  expect(tree.root.findAllByType("NativeSymbol" as never)).toHaveLength(0);
});

it("preserves reorder mode, shows all secondary sources and exposes the existing Done action", async () => {
  await render();
  act(() => useSideBarDraggingStore.setState({ dragging: true }));
  expect(button("ipad-source-more").props.accessibilityState.expanded).toBe(
    true
  );
  expect(button("ipad-source-more").props.disabled).toBe(true);
  expect(button("Trash")).toBeDefined();
  expect(button("ipad-source-tags").props.disabled).toBe(true);
  act(() => button("sidemenu-settings-icon").props.onPress());
  expect(UserSheet.present).not.toHaveBeenCalled();
  const done = tree.root.findByType("Button" as never);
  expect(done.props.testID).toBe("check");
  act(() => done.props.onPress());
  expect(useSideBarDraggingStore.getState().dragging).toBe(false);
  expect(button("ipad-source-tags").props.disabled).toBe(false);
});

it("bounds embedded list frames and grows to actual native row measurements", async () => {
  await render();
  const frame = (id: string) => {
    const node = tree.root
      .findAllByType("View" as never)
      .find((view) => view.props.testID === id);
    if (!node) throw new Error(id);
    return node;
  };
  expect(frame("ipad-source-routes-frame").props.style.height).toBe(88);
  act(() =>
    button("All Notes").props.onLayout({
      nativeEvent: { layout: { height: 84 } }
    })
  );
  expect(frame("ipad-source-routes-frame").props.style.height).toBe(128);
  expect(frame("ipad-source-colors-frame").props.style.height).toBe(0);
  expect(frame("ipad-source-pins-frame").props.style.height).toBe(0);
  act(() => button("ipad-source-more").props.onPress());
  expect(frame("ipad-source-routes-frame").props.style.height).toBe(
    84 + 7 * 44
  );
});
it("uses one Add Notebook affordance in focused mode and unique source ids in default Tags", async () => {
  mockDefault = 1;
  await render();
  expect(
    buttons().filter((node) => node.props.accessibilityLabel === "New Notebook")
  ).toHaveLength(1);
  act(() => tree.unmount());
  mockDefault = 2;
  await render();
  expect(activeButton("ipad-source-home-return")).toBeDefined();
  expect(activeButton("ipad-source-notebooks-return")).toBeDefined();
  const ids = buttons()
    .map((node) => node.props.testID)
    .filter((id) => typeof id === "string" && id.startsWith("ipad-source-"));
  expect(new Set(ids).size).toBe(ids.length);
  expect(mockTagMounts).toBe(1);
  act(() => activeButton("ipad-source-home-return").props.onPress());
  expect(button("All Notes")).toBeDefined();
});

// C3 delta: reuse the same real Sidebar and actions; only placement/density changes.
it.each(["populated", "empty", "loading"])(
  "places exactly one gated Add after the notebook data in the same scroll owner: %s",
  async (state) => {
    mockEmpty = state === "empty";
    mockLoading = state === "loading";
    if (state === "populated")
      useSideMenuNotebookTreeStore.setState({
        tree: [
          mockItem as TreeItem,
          {
            ...mockItem,
            notebook: {
              ...mockBook,
              id: "child",
              title: "Untergeordnetes Notebook"
            },
            depth: 1,
            hasChildren: false,
            parentId: "book"
          } as TreeItem
        ]
      });
    await render();
    const scroll = tree.root.findByType("LegendList" as never);
    expect(scroll.props.ListFooterComponent).toBeTruthy();
    expect(scroll.props.ListFooterComponent.props.children.props.testID).toBe(
      "ipad-source-new-notebook"
    );
    const controls = scroll
      .findAllByType("Pressable" as never)
      .map((node) => node.props.testID);
    expect(
      controls.filter((id) => id === "ipad-source-new-notebook")
    ).toHaveLength(1);
    expect(controls[controls.length - 1]).toBe("ipad-source-new-notebook");
    if (state === "populated")
      expect(controls.indexOf("ipad-source-new-notebook")).toBeGreaterThan(
        controls.indexOf("notebook-item-1-1")
      );
    await act(async () => button("ipad-source-new-notebook").props.onPress());
    expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
    mockAllowed = false;
    await act(async () => button("ipad-source-new-notebook").props.onPress());
    expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
    expect(ToastManager.show).toHaveBeenCalledWith({
      message: "Not available",
      type: "info"
    });
  }
);
it.each([0, 1, 2])(
  "uses one normal footer row with leading Settings and a separate named44pt Theme target, view=%s",
  async (index) => {
    mockDefault = index;
    await render();
    const footer = tree.root
      .findAllByType("View" as never)
      .find((node) => node.props.testID === "ipad-sidebar-footer");
    expect(footer).toBeDefined();
    expect(footer?.props.style.flexDirection).toBe("row");
    expect(footer?.props.style.paddingVertical).toBe(0);
    const controls = footer?.findAllByType("Pressable" as never) || [];
    expect(controls[0].props.testID).toBe("sidemenu-settings-icon");
    expect(controls[0].props.accessibilityLabel).toBe("Settings");
    expect(controls[0].props.style.flex).toBe(1);
    expect(controls[0].props.style.minHeight).toBe(44);
    expect(
      buttons().filter((node) => node.props.testID === "sidemenu-settings-icon")
    ).toHaveLength(1);
    const theme = button("sidebar-theme-button");
    expect(controls).toContain(theme);
    expect(theme.props.accessibilityLabel).toBeTruthy();
    expect(theme.props.accessibilityRole).toBe("button");
    expect(theme.props.style.width).toBe(44);
    expect(theme.props.style.minHeight).toBe(44);
    expect(theme.findAllByType("Text" as never)).toHaveLength(0);
    act(() => theme.props.onPress());
    expect(useThemeStore.getState().setColorScheme).toHaveBeenCalledTimes(1);
    act(() => controls[0].props.onPress());
    expect(UserSheet.present).toHaveBeenCalledTimes(1);
    if (index > 0) {
      const sort = button("sidebar-sort-button");
      expect(controls).toContain(sort);
      expect(sort.props.style.width).toBe(44);
      act(() => sort.props.onPress());
      const sheet = (presentSheet as jest.Mock).mock.calls[0][0];
      expect(sheet.component.props.group).toBe(
        index === 1 ? "notebooks" : "tags"
      );
    }
    if (index === 2)
      expect(button("sidebar-add-button").props.style.width).toBe(44);
  }
);
it.each(["selection", "drag"])(
  "retains the existing %s footer and Settings access, then restores the compact row",
  async (mode) => {
    await render();
    act(() =>
      mode === "selection"
        ? useSideMenuNotebookSelectionStore.setState({
            enabled: true,
            selection: { book: "selected" }
          })
        : useSideBarDraggingStore.setState({ dragging: true })
    );
    expect(
      tree.root.findAllByProps({ testID: "ipad-sidebar-footer" })
    ).toHaveLength(0);
    expect(button("sidemenu-settings-icon")).toBeDefined();
    expect(button("ipad-source-new-notebook").props.disabled).toBe(true);
    if (mode === "selection") {
      const action = (title: string) =>
        buttons().find((node) =>
          node
            .findAllByType("Text" as never)
            .some((text) => text.children.join(" ") === title)
        );
      for (const title of ["Select all", "Delete", "Move", "Close"])
        expect(action(title)).toBeDefined();
      await act(async () => action("Close")?.props.onPress());
    } else {
      const done = tree.root.findByType("Button" as never);
      expect(done.props.testID).toBe("check");
      act(() => done.props.onPress());
    }
    expect(
      tree.root.findAllByProps({ testID: "ipad-sidebar-footer" })
    ).toHaveLength(1);
    expect(button("sidebar-theme-button")).toBeDefined();
    expect(button("ipad-source-new-notebook").props.disabled).toBe(false);
  }
);

it.each([false, true])(
  "enlarges only Library rows/section headings, with notebook body outside C8 scope, dark=%s",
  async (dark) => {
    mockDark = dark;
    await render();
    const sourceText = button("All Notes").findAllByType("Text" as never);
    const style = (node: (typeof sourceText)[number]) =>
      Object.assign({}, ...node.props.style);
    expect(style(sourceText[0]).fontSize).toBe(AppFontSize.md);
    expect(style(sourceText[sourceText.length - 1]).fontSize).toBe(
      AppFontSize.sm,
    );
    const section = button("ipad-source-home");
    expect(style(section.findAllByType("Text" as never)[0]).fontSize).toBe(
      AppFontSize.sm,
    );
    const sectionStyle = style(section.findAllByType("Text" as never)[0]);
    expect(sectionStyle.color).toBe(dark ? "#acacb4" : "#666666");
    expect(sectionStyle.fontSize).toBeLessThan(style(sourceText[0]).fontSize);
    expect(section.props.style.minHeight).toBe(44);
    expect(section.props.accessibilityState.expanded).toBe(true);
    act(() => section.props.onPress());
    expect(button("ipad-source-home").props.accessibilityState.expanded).toBe(
      false,
    );
    act(() => button("ipad-source-home").props.onPress());
    expect(button("All Notes")).toBeDefined();
    expect(button("sidemenu-settings-icon")).toBeDefined();
    expect(button("ipad-source-tags")).toBeDefined();
  },
);

it.each([
  ["iPhone", "ios", false, false],
  ["CatalystMac", "ios", false, true],
  ["CatalystPad", "ios", true, true],
  ["Android", "android", true, false],
])(
  "keeps a directly rendered source section on its legacy token outside hardware iPad: %s",
  async (_name, OS, isPad, isMacCatalyst) => {
    Object.assign(Platform, { OS, isPad, isMacCatalyst });
    const onPress = jest.fn();
    await act(async () => {
      tree = create(
        <IPadSourceSection
          title="Library"
          expanded
          onPress={onPress}
          testID="section-probe"
        />,
      );
    });
    const row = button("section-probe");
    const label = row.findAllByType("Text" as never)[0];
    expect(Object.assign({}, ...label.props.style).fontSize).toBe(
      AppFontSize.xs,
    );
    act(() => row.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  },
);

// C9 covers notebook bodies and the one labeled hardware-iPad source action.
const notebookTextStyles = (row: ReturnType<typeof button>) =>
  row.findAllByType("Text" as never).map((node) => ({
    text: node.children.join(" "),
    style: Object.assign({}, ...node.props.style)
  }));

it.each([false, true])(
  "uses readable notebook/action tokens in hardware-iPad sidebar, dark=%s",
  async (dark) => {
    mockDark = dark;
    await render();
    const row = button("notebook-item-0-0");
    const texts = notebookTextStyles(row);
    expect(texts.map(({ text }) => text)).toEqual([mockBook.title, "7"]);
    expect(texts[0].style.fontSize).toBe(AppFontSize.md);
    expect(texts[1].style.fontSize).toBe(AppFontSize.sm);
    expect(texts[1].style.fontSize).toBeLessThan(texts[0].style.fontSize);
    expect(texts[1].style.color).toBe(dark ? "#acacb4" : "#666666");
    expect(row.props.style.minHeight).toBe(44);
    const add = button("ipad-source-new-notebook");
    expect(notebookTextStyles(add)[0].style.fontSize).toBe(AppFontSize.md);
    expect(add.props.style.minHeight).toBe(44);
    expect(add.props.style.minWidth).toBe(44);
    expect(notebookTextStyles(button("sidebar-theme-button"))).toHaveLength(0);
    await act(async () => add.props.onPress());
    expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
  }
);

it.each([
  ["iPhone source", "ios", false, false, true],
  ["CatalystMac source", "ios", false, true, true],
  ["CatalystPad source", "ios", true, true, true],
  ["Android source", "android", true, false, true],
  ["non-sidebar iPad", "ios", true, false, false]
])(
  "retains legacy notebook typography outside the hardware-iPad source branch: %s",
  async (_name, OS, isPad, isMacCatalyst, sourceList) => {
    Object.assign(Platform, { OS, isPad, isMacCatalyst });
    const open = jest.fn();
    await act(async () => {
      tree = create(
        <NotebookItem
          sourceList={sourceList}
          item={mockItem as TreeItem}
          index={0}
          selectionStore={useSideMenuNotebookSelectionStore}
          onItemUpdate={jest.fn()}
          onPress={open}
        />
      );
    });
    const texts = notebookTextStyles(button("notebook-item-0-0"));
    expect(texts[0].style.fontSize).toBe(AppFontSize.sm);
    expect(texts[1].style.fontSize).toBe(AppFontSize.xxs);
    expect(tree.root.findAllByType("NativeSymbol" as never)).toHaveLength(0);
    await act(async () => button("notebook-item-0-0").props.onPress());
    expect(open).toHaveBeenCalledTimes(1);
  }
);

it("keeps notebook indentation clamp, current label/count and independent actions with md text", async () => {
  const open = jest.fn(),
    expand = jest.fn(),
    add = jest.fn(),
    properties = jest.fn();
  const next = {
    ...mockItem,
    depth: 9,
    notebook: {
      ...mockBook,
      id: "current",
      title: "Aktuelles langes Notebook mit unveränderten Aktionen"
    }
  } as TreeItem;
  await act(async () => {
    tree = create(
      <NotebookItem
        sourceList
        item={next}
        index={2}
        focused
        expanded
        selectionStore={useSideMenuNotebookSelectionStore}
        onItemUpdate={jest.fn()}
        onPress={open}
        onToggleExpanded={expand}
        onAddNotebook={add}
        onLongPress={properties}
      />
    );
  });
  const row = button("notebook-item-9-2");
  expect(notebookTextStyles(row)[0].text).toBe(next.notebook.title);
  expect(notebookTextStyles(row)[0].style.fontSize).toBe(AppFontSize.md);
  expect(row.props.accessibilityValue.text).toBe("7 notes");
  expect(row.props.style.height).toBeUndefined();
  const wrapper = tree.root
    .findAllByType("View" as never)
    .find((node) => node.props.style?.paddingLeft !== undefined);
  expect(wrapper?.props.style.paddingLeft).toBe(
    5 * DefaultAppStyles.GAP_SMALL * 2
  );
  const disclosure = button("expand-notebook-2");
  const childAdd = button("add-notebook-2");
  expect(disclosure.props.style).toMatchObject({ width: 44, minHeight: 44 });
  expect(childAdd.props.style).toMatchObject({ width: 44, minHeight: 44 });
  act(() => disclosure.props.onPress());
  act(() => childAdd.props.onPress());
  expect(expand).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  await act(async () => row.props.onPress());
  act(() => row.props.onLongPress());
  expect(open).toHaveBeenCalledTimes(1);
  expect(properties).toHaveBeenCalledTimes(1);
});
