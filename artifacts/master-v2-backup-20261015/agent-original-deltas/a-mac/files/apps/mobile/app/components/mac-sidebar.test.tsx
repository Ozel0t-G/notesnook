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

import React from "react";
import {
  act,
  create,
  ReactTestRenderer,
  ReactTestInstance
} from "react-test-renderer";
import { NativeModules, View } from "react-native";
import {
  NavigationRouteContext,
  BaseNavigationContainer,
  createNavigationContainerRef,
  createNavigatorFactory,
  StackRouter,
  CommonActions,
  useNavigationBuilder,
  ParamListBase
} from "@react-navigation/native";
import { withMacSidebar } from "./mac-section-layout";
import { MacSidebar } from "./mac-sidebar";
import { useAppleNavigationStore } from "../stores/use-apple-navigation-store";
import { useTasksSelectionStore } from "../stores/use-tasks-selection-store";
import { useMacSidebarSectionsStore } from "../stores/use-mac-sidebar-sections-store";
import useNavigationStore from "../stores/use-navigation-store";
import { selectAppleSection } from "../navigation/navigation-stack";
import { openMacList } from "../services/mac-list-navigation";
import { AddNotebookSheet } from "./sheets/add-notebook";
import { confirmEmptyTrash } from "../screens/trash";
import { openEditor, setOnFirstSaveUnassigned } from "../screens/notes/common";

let mockHostRoute = "FluidPanelsView";
let mockDark = false;
let mockAccent = "custom-accent";
let mockSystemAccent = "system-accent";
let mockEmpty = false;
jest.mock("@react-navigation/native", () =>
  jest.requireActual("@react-navigation/core")
);
jest.mock("@notesnook/common", () => ({ useTimeAgo: () => "3m" }));
jest.mock("../hooks/use-reduce-motion", () => ({
  useReduceMotion: () => true
}));
jest.mock("../stores/use-user-store", () => ({
  SyncStatus: { Failed: "failed" },
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: undefined,
      lastSyncStatus: "synced",
      lastSynced: "Never"
    })
}));
jest.mock("../services/navigation", () => ({
  __esModule: true,
  default: { navigate: jest.fn() }
}));
jest.mock("../screens/settings/mac-account-settings", () => ({
  openMacAccountSettings: jest.fn(),
  openMacSettings: jest.fn()
}));
jest.mock("./auth/common", () => ({ AuthMode: { login: "login" } }));
jest.mock("./ui/AppIcon", () => ({ __esModule: true, default: "Icon" }));
jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: (selector: (state: unknown) => unknown) =>
    selector({ dimensions: { width: 1200 } })
}));
jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  NativeModules: { VeyraNMacMenu: { setSelectedSection: jest.fn() } }
}));
jest.mock("@notesnook/intl", () => ({
  strings: {
    notLoggedIn: () => "Not logged in",
    synced: () => "Synced",
    routes: Object.fromEntries(
      [
        "Settings",
        "Library",
        "AllNotes",
        "Inbox",
        "Favorites",
        "Monographs",
        "Notebooks",
        "Tags",
        "Archive",
        "Templates",
        "Trash"
      ].map((x) => [x, () => x])
    ),
    dataTypesPluralCamelCase: { note: () => "Notes" },
    tasksTitle: () => "Tasks",
    tasksLists: () => "Lists",
    tasksAll: () => "All Tasks",
    tasksNewList: () => "New List",
    newNotebookRow: () => "New Notebook",
    newNoteTab: () => "New Note",
    clearTrash: () => "Empty Trash",
    notes: (n: number) => `${n} notes`
  }
}));
jest.mock("@notesnook/theme", () => ({
  resolveAppleSurfaces: () => ({ windowBackground: "window" }),
  ScopedThemeProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useThemeColors: () => ({
    colors: {
      primary: { accent: mockAccent },
      secondary: { background: "avatar" }
    },
    isDark: mockDark
  })
}));
jest.mock("../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    primaryText: mockDark ? "dark-text" : "light-text",
    secondaryText: "secondary",
    tertiaryText: "tertiary",
    separator: "separator",
    hoverSurface: "hover"
  })
}));
jest.mock("../hooks/use-library-source-list", () => ({
  useLibrarySourceList: () => ({
    notebooks: mockEmpty ? [] : [{ id: "book-a", title: "Book A" }],
    tags: mockEmpty ? [] : [{ id: "tag-a", title: "Tag A" }],
    counts: { allNotes: 5, inbox: 2, templates: 1 },
    notebookCounts: { "book-a": 3 },
    tagCounts: { "tag-a": 2 }
  })
}));
jest.mock("../hooks/use-task-smart-lists", () => ({
  taskSmartList: (id: string) => ({
    label: () => id,
    symbol: "checklist",
    color: "gray"
  }),
  useTaskSmartLists: () => ({
    lists: mockEmpty ? [] : [{ id: "list-a", name: "List A" }],
    counts: { today: 1 },
    listCounts: { "list-a": 2 }
  })
}));
jest.mock("../stores/use-mac-system-store", () => ({
  useMacSystemStore: (selector: (state: { accent: string }) => unknown) =>
    selector({ accent: mockSystemAccent })
}));
jest.mock("../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ top: 52 })
}));
jest.mock("../services/mac-list-navigation", () => ({
  openMacList: jest.fn()
}));
jest.mock("../navigation/navigation-stack", () => ({
  selectAppleSection: jest.fn((section) => {
    require("../stores/use-apple-navigation-store")
      .useAppleNavigationStore.getState()
      .setSection(section);
  })
}));
jest.mock("./sheets/add-notebook", () => ({
  AddNotebookSheet: { present: jest.fn() }
}));
jest.mock("./task-symbol-view", () => ({ TaskSymbolView: "Symbol" }));
jest.mock("./mac-glass-view", () => ({ MacGlassView: "Glass" }));
jest.mock("./item-actions-menu", () => ({
  ItemContextMenu: "ItemContextMenu"
}));
jest.mock("./native-menu", () => ({ ContextMenu: "ContextMenu" }));
jest.mock("../utils/constants", () => ({ isMacCatalyst: () => true }));
jest.mock("../screens/notes/common", () => ({
  openEditor: jest.fn(),
  setOnFirstSaveUnassigned: jest.fn()
}));
jest.mock("../screens/trash", () => ({ confirmEmptyTrash: jest.fn() }));
jest.mock("../utils/ios-system-colors", () => ({
  systemColor: () => "semantic-gray"
}));
jest.mock("../screens/tasks/list-appearance", () => ({
  taskListColor: () => "list-color",
  taskListSymbol: () => "list.bullet"
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Host primitives and data/native boundaries are mocked; the actual sidebar,
// hover component, metric helpers and Zustand selection/collapse stores render.
describe("Mac sidebar primary destinations", () => {
  let tree: ReactTestRenderer;
  const host = (testID: string) => {
    const node = tree.root
      .findAllByProps({ testID })
      .find((x) => typeof x.type === "string");
    if (!node) throw new Error(`Missing host: ${testID}`);
    return node;
  };
  const press = (node: ReactTestInstance) => act(() => node.props.onPress());
  const queryRow = (label: string) =>
    tree.root
      .findAllByType("Pressable" as never)
      .find((x) => x.props.accessibilityLabel === label);
  const row = (label: string) => {
    const node = queryRow(label);
    if (!node) throw new Error(`Missing row: ${label}`);
    return node;
  };
  const renderSidebar = () => (
    <NavigationRouteContext.Provider
      value={{ key: mockHostRoute, name: mockHostRoute }}
    >
      <MacSidebar />
    </NavigationRouteContext.Provider>
  );
  const render = () =>
    act(() => {
      tree = create(renderSidebar());
    });
  beforeEach(() => {
    jest.clearAllMocks();
    mockHostRoute = "FluidPanelsView";
    mockDark = false;
    mockAccent = "custom-accent";
    mockSystemAccent = "system-accent";
    mockEmpty = false;
    useAppleNavigationStore.setState({ section: "library" });
    useTasksSelectionStore.setState({
      selection: { kind: "smart", id: "today" },
      newListRequest: 0
    });
    useMacSidebarSectionsStore.setState({
      collapsed: {
        library: false,
        notebooks: false,
        tags: false,
        tasks: false,
        lists: false
      }
    });
    useNavigationStore.setState({
      focusedRouteId: "book-a",
      currentRoute: "Notebook"
    });
  });
  afterEach(() => act(() => tree?.unmount()));

  it("pins Notes and Tasks above independent retained source lists with parent/child selection", () => {
    render();
    const notes = host("library-scroll");
    const tasks = host("mac-sidebar-tasks-sources");
    expect(host("mac-sidebar-notes").props.accessibilityState).toEqual({
      selected: true
    });
    expect(host("mac-sidebar-tasks").props.accessibilityState).toEqual({
      selected: false
    });
    expect(row("Book A, 3 notes").props.accessibilityState.selected).toBe(true);
    expect(notes.props.style.opacity).toBe(1);
    expect(tasks.props.style.opacity).toBe(0);
    for (const testID of ["mac-sidebar-notes", "mac-sidebar-tasks"]) {
      let ancestor = host(testID).parent;
      while (ancestor) {
        expect(ancestor.type).not.toBe("ScrollView");
        ancestor = ancestor.parent;
      }
    }
    press(host("mac-sidebar-tasks"));
    expect(selectAppleSection).toHaveBeenLastCalledWith("tasks");
    expect(
      NativeModules.VeyraNMacMenu.setSelectedSection
    ).toHaveBeenLastCalledWith("tasks");
    expect(host("library-scroll")).toBe(notes);
    expect(host("mac-sidebar-tasks-sources")).toBe(tasks);
    expect(notes.props.style.opacity).toBe(0);
    expect(notes.props.accessibilityElementsHidden).toBe(true);
    expect(notes.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(notes.props.pointerEvents).toBe("none");
    expect(tasks.props.accessibilityElementsHidden).toBe(false);
    expect(row("today, 1 notes").props.accessibilityState.selected).toBe(true);
    press(host("mac-sidebar-notes"));
    expect(host("library-scroll")).toBe(notes);
    expect(row("Book A, 3 notes").props.accessibilityState.selected).toBe(true);
    expect(useTasksSelectionStore.getState().selection).toEqual({
      kind: "smart",
      id: "today"
    });
    expect(host("mac-sidebar-account-footer")).toBeDefined();
  });

  it("does not rerun section navigation when the current destination is pressed", () => {
    render();
    press(row("Book A, 3 notes"));
    jest.clearAllMocks();
    press(host("mac-sidebar-notes"));
    expect(selectAppleSection).not.toHaveBeenCalled();
    expect(
      NativeModules.VeyraNMacMenu.setSelectedSection
    ).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().focusedRouteId).toBe("book-a");
    press(host("mac-sidebar-tasks"));
    jest.clearAllMocks();
    press(host("mac-sidebar-tasks"));
    expect(selectAppleSection).not.toHaveBeenCalled();
  });

  it.each(["library", "tasks", "search"] as const)(
    "keeps both source scroll views laid out at the same size (section=%s)",
    (section) => {
      useAppleNavigationStore.setState({ section });
      render();
      const notes = host("library-scroll");
      const tasks = host("mac-sidebar-tasks-sources");
      for (const view of [notes, tasks]) {
        expect(view.props.style).toMatchObject({
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0
        });
        expect(view.props.style.display).toBeUndefined();
      }
      const active = section === "tasks" ? tasks : notes;
      const hidden = section === "tasks" ? notes : tasks;
      expect(active.props.style.opacity).toBe(1);
      expect(hidden.props.style.opacity).toBe(0);
      act(() => {
        useNavigationStore.setState({ currentRoute: "Settings" });
        mockHostRoute = "Settings";
        tree.update(renderSidebar());
      });
      expect(active.props.style.opacity).toBe(1);
      expect(hidden.props.style.opacity).toBe(0);
      const target =
        section === "tasks" ? "mac-sidebar-tasks" : "mac-sidebar-notes";
      press(host(target));
      expect(selectAppleSection).toHaveBeenLastCalledWith(
        section === "tasks" ? "tasks" : "library"
      );
    }
  );

  it("keeps all note collections, notebook/tag context menus and destructive confirmation reachable", () => {
    render();
    for (const label of [
      "AllNotes, 5 notes",
      "Inbox, 2 notes",
      "Favorites",
      "Monographs",
      "Archive",
      "Templates, 1 notes",
      "Trash",
      "#Tag A, 2 notes"
    ])
      expect(row(label)).toBeDefined();
    press(row("Book A, 3 notes"));
    expect(openMacList).toHaveBeenLastCalledWith(
      "Notebook",
      { id: "book-a", canGoBack: true },
      "book-a"
    );
    press(row("#Tag A, 2 notes"));
    expect(openMacList).toHaveBeenLastCalledWith(
      "TaggedNotes",
      { type: "tag", id: "tag-a", canGoBack: true },
      "tag-a"
    );
    expect(tree.root.findAllByType("ItemContextMenu" as never)).toHaveLength(2);
    const menus = tree.root.findAllByType("ContextMenu" as never);
    act(() =>
      menus
        .find((x) => x.props.items[0].id === "new-note")
        ?.props.onSelect("new-note")
    );
    expect(setOnFirstSaveUnassigned).toHaveBeenCalledTimes(1);
    expect(openEditor).toHaveBeenCalledTimes(1);
    act(() =>
      menus
        .find((x) => x.props.items[0].id === "empty-trash")
        ?.props.onSelect("empty-trash")
    );
    expect(confirmEmptyTrash).toHaveBeenCalledTimes(1);
    press(host("library-new-notebook"));
    expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
  });

  it("retains collapse state and selected task list across main destination switches", () => {
    render();
    press(row("Notebooks"));
    expect(queryRow("Book A, 3 notes")).toBeUndefined();
    press(host("mac-sidebar-tasks"));
    press(row("List A, 2 notes"));
    expect(useTasksSelectionStore.getState().selection).toEqual({
      kind: "list",
      id: "list-a"
    });
    expect(row("List A, 2 notes").props.accessibilityState.selected).toBe(true);
    press(host("mac-sidebar-new-list"));
    expect(useTasksSelectionStore.getState().newListRequest).toBe(1);
    press(host("mac-sidebar-notes"));
    expect(row("Notebooks").props.accessibilityState.expanded).toBe(false);
    press(row("Notebooks"));
    expect(row("Book A, 3 notes")).toBeDefined();
    press(host("mac-sidebar-tasks"));
    expect(row("List A, 2 notes").props.accessibilityState.selected).toBe(true);
  });

  it.each([true, false])(
    "keeps one visibly named notebook creation row after notebook items (empty=%s)",
    (empty) => {
      mockEmpty = empty;
      render();
      const createRows = tree.root
        .findAllByType("Pressable" as never)
        .filter((node) => node.props.accessibilityLabel === "New Notebook");
      expect(createRows).toHaveLength(1);
      const createRow = createRows[0];
      expect(
        createRow
          .findAllByType("Text" as never)
          .some((node) => node.props.children === "New Notebook")
      ).toBe(true);
      expect(createRow.props.accessibilityState).toEqual({ selected: false });
      const rows = tree.root.findAllByType("Pressable" as never);
      expect(rows.indexOf(createRow)).toBeGreaterThan(
        rows.indexOf(row("Notebooks"))
      );
      if (!empty) {
        expect(rows.indexOf(createRow)).toBeGreaterThan(
          rows.indexOf(row("Book A, 3 notes"))
        );
        expect(row("Book A, 3 notes").props.accessibilityState.selected).toBe(
          true
        );
      }
      expect(host("library-new-notebook")).toBe(createRow);
      press(createRow);
      expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
      expect(AddNotebookSheet.present).toHaveBeenCalledWith(
        undefined,
        undefined,
        "global",
        undefined,
        false
      );
      expect(useNavigationStore.getState().currentRoute).toBe("Notebook");
      expect(useNavigationStore.getState().focusedRouteId).toBe("book-a");
      expect(useAppleNavigationStore.getState().section).toBe("library");
      expect(openMacList).not.toHaveBeenCalled();
      expect(selectAppleSection).not.toHaveBeenCalled();
      expect(
        NativeModules.VeyraNMacMenu.setSelectedSection
      ).not.toHaveBeenCalled();
    }
  );

  it("retains the same single notebook creation action while collapsed without changing route or selection", () => {
    render();
    press(row("Notebooks"));
    expect(queryRow("Book A, 3 notes")).toBeUndefined();
    expect(row("Notebooks").props.accessibilityState.expanded).toBe(false);
    const createRows = tree.root
      .findAllByType("Pressable" as never)
      .filter((node) => node.props.accessibilityLabel === "New Notebook");
    expect(createRows).toHaveLength(1);
    expect(
      createRows[0]
        .findAllByType("Text" as never)
        .some((node) => node.props.children === "New Notebook")
    ).toBe(true);
    expect(host("library-new-notebook")).toBe(createRows[0]);
    press(createRows[0]);
    expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
    expect(AddNotebookSheet.present).toHaveBeenCalledWith(
      undefined,
      undefined,
      "global",
      undefined,
      false
    );
    expect(useMacSidebarSectionsStore.getState().collapsed.notebooks).toBe(
      true
    );
    expect(useNavigationStore.getState().currentRoute).toBe("Notebook");
    expect(useNavigationStore.getState().focusedRouteId).toBe("book-a");
    expect(useAppleNavigationStore.getState().section).toBe("library");
    expect(useTasksSelectionStore.getState().selection).toEqual({
      kind: "smart",
      id: "today"
    });
    expect(openMacList).not.toHaveBeenCalled();
    expect(selectAppleSection).not.toHaveBeenCalled();
    press(row("Notebooks"));
    expect(row("Book A, 3 notes").props.accessibilityState.selected).toBe(true);
    expect(row("New Notebook")).toBe(createRows[0]);
  });

  it("shows empty creation routes without inventing notebooks or task lists", () => {
    mockEmpty = true;
    render();
    press(row("New Notebook"));
    expect(AddNotebookSheet.present).toHaveBeenCalledTimes(1);
    expect(queryRow("Tags")).toBeUndefined();
    press(host("mac-sidebar-tasks"));
    press(host("mac-sidebar-new-list"));
    expect(useTasksSelectionStore.getState().newListRequest).toBe(1);
    expect(queryRow("List A, 2 notes")).toBeUndefined();
  });

  it.each(["Settings", "GlobalSearch"])(
    "does not advertise a source destination selected in %s",
    (route) => {
      render();
      act(() => {
        useNavigationStore.setState({ currentRoute: route });
        mockHostRoute = route;
        tree.update(renderSidebar());
        if (route === "GlobalSearch")
          useAppleNavigationStore.setState({ section: "search" });
      });
      expect(host("mac-sidebar-notes").props.accessibilityState.selected).toBe(
        false
      );
      expect(host("mac-sidebar-tasks").props.accessibilityState.selected).toBe(
        false
      );
      expect(row("Book A, 3 notes").props.accessibilityState.selected).toBe(
        false
      );
      press(host("mac-sidebar-notes"));
      expect(selectAppleSection).toHaveBeenLastCalledWith("library");
    }
  );

  it("uses the real enclosing route context after Settings returns, without rewriting the stale shared route store", () => {
    useNavigationStore.setState({ currentRoute: "Settings" });
    render();
    expect(host("mac-sidebar-notes").props.accessibilityState.selected).toBe(
      true
    );
    expect(row("Book A, 3 notes").props.accessibilityState.selected).toBe(true);
    act(() => {
      mockHostRoute = "Settings";
      tree.update(renderSidebar());
    });
    expect(host("mac-sidebar-notes").props.accessibilityState.selected).toBe(
      false
    );
    expect(row("Book A, 3 notes").props.accessibilityState.selected).toBe(
      false
    );
    act(() => {
      mockHostRoute = "FluidPanelsView";
      tree.update(renderSidebar());
    });
    expect(host("mac-sidebar-notes").props.accessibilityState.selected).toBe(
      true
    );
    expect(useNavigationStore.getState().currentRoute).toBe("Settings");
    jest.clearAllMocks();
    press(host("mac-sidebar-notes"));
    expect(selectAppleSection).not.toHaveBeenCalled();
    act(() => {
      useAppleNavigationStore.setState({ section: "tasks" });
      mockHostRoute = "Tasks";
      tree.update(renderSidebar());
    });
    expect(host("mac-sidebar-tasks").props.accessibilityState.selected).toBe(
      true
    );
    expect(row("today, 1 notes").props.accessibilityState.selected).toBe(true);
  });

  it.each([false, true])(
    "uses effective appearance/accent and hover without painting a second collection selection (dark=%s)",
    (dark) => {
      mockDark = dark;
      render();
      const primary = host("mac-sidebar-notes");
      const label = primary.findByType("Text" as never);
      expect(label.props.style.color).toBe("system-accent");
      expect(label.props.numberOfLines).toBe(1);
      expect(primary.props.accessibilityRole).toBe("button");
      expect(primary.props.style.backgroundColor).toBe("transparent");
      expect(primary.findAllByType("View" as never)).toHaveLength(0);
      act(() => primary.props.onHoverIn());
      expect(primary.findAllByType("View" as never)).toHaveLength(1);
      act(() => primary.props.onHoverOut());
      mockSystemAccent = "";
      act(() => tree.update(renderSidebar()));
      expect(
        host("mac-sidebar-notes").findByType("Text" as never).props.style.color
      ).toBe("custom-accent");
      expect(
        host("mac-sidebar-tasks").findByType("Text" as never).props.style.color
      ).toBe(dark ? "dark-text" : "light-text");
    }
  );
});

// Real router descriptors provide route contexts. Render every stacked host to
// check simultaneous sidebar instances; native retention/focus is not emulated.
function RouterView({
  children,
  initialRouteName
}: {
  children: React.ReactNode;
  initialRouteName?: string;
}) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(
    StackRouter,
    { children, initialRouteName }
  );
  return (
    <NavigationContent>
      {state.routes.map((route) => (
        <View key={route.key} testID={`router-host-${state.key}-${route.name}`}>
          {descriptors[route.key].render()}
        </View>
      ))}
    </NavigationContent>
  );
}
const HostStack = createNavigatorFactory(RouterView)();
const SettingsStack = createNavigatorFactory(RouterView)();
const EmptyScreen = () => null;
const SectionHost = withMacSidebar(EmptyScreen);
function SettingsScreen() {
  return (
    <SettingsStack.Navigator initialRouteName="SettingsHome">
      <SettingsStack.Screen name="SettingsHome" component={EmptyScreen} />
      <SettingsStack.Screen name="SettingsGroup" component={EmptyScreen} />
    </SettingsStack.Navigator>
  );
}
const SettingsHost = withMacSidebar(SettingsScreen);

describe("Mac Settings selection with real host navigation and production stores", () => {
  let tree: ReactTestRenderer;
  afterEach(() => act(() => tree?.unmount()));
  it.each([
    ["FluidPanelsView", "library", "mac-sidebar-notes", "Book A, 3 notes"],
    ["Tasks", "tasks", "mac-sidebar-tasks", "today, 1 notes"],
    ["GlobalSearch", "search", "mac-sidebar-notes", "Book A, 3 notes"]
  ] as const)(
    "returns from nested Settings to %s while legacy currentRoute stays Settings",
    (hostName, section, primary, source) => {
      mockEmpty = false;
      useAppleNavigationStore.setState({ section });
      useTasksSelectionStore.setState({
        selection: { kind: "smart", id: "today" }
      });
      useMacSidebarSectionsStore.setState({
        collapsed: {
          library: false,
          notebooks: false,
          tags: false,
          tasks: false,
          lists: false
        }
      });
      useNavigationStore.getState().setFocusedRouteId("book-a");
      useNavigationStore.getState().update("Notebook");
      const navigation = createNavigationContainerRef<ParamListBase>();
      const hostTree = (name?: string) => {
        const state = navigation.getRootState();
        return tree.root.findByProps({
          testID: `router-host-${state.key}-${
            name || state.routes[state.index].name
          }`
        });
      };
      const host = (testID: string, name?: string) => {
        const node = hostTree(name)
          .findAllByProps({ testID })
          .find((x) => typeof x.type === "string");
        if (!node) throw new Error(`Missing host: ${testID}`);
        return node;
      };
      const sourceRow = (name?: string) => {
        const node = hostTree(name)
          .findAllByType("Pressable" as never)
          .find((x) => x.props.accessibilityLabel === source);
        if (!node) throw new Error(`Missing source: ${source}`);
        return node;
      };
      const selected = (testID: string) =>
        host(testID).props.accessibilityState.selected;
      act(() => {
        tree = create(
          <BaseNavigationContainer ref={navigation}>
            <HostStack.Navigator initialRouteName={hostName}>
              <HostStack.Screen name={hostName} component={SectionHost} />
              <HostStack.Screen
                name="Settings"
                component={SettingsHost}
                listeners={{
                  focus: () => useNavigationStore.getState().update("Settings")
                }}
              />
            </HostStack.Navigator>
          </BaseNavigationContainer>
        );
      });
      expect(selected("mac-sidebar-settings")).toBe(false);
      expect(selected(primary)).toBe(section !== "search");
      const retainedPrimary = host(primary);
      act(() => navigation.navigate("Settings"));
      expect(navigation.getCurrentRoute()?.name).toBe("SettingsHome");
      expect(useNavigationStore.getState().currentRoute).toBe("Settings");
      expect(selected("mac-sidebar-settings")).toBe(true);
      expect(selected(primary)).toBe(false);
      expect(sourceRow().props.accessibilityState.selected).toBe(false);
      // The underlying host remains mounted and owns its own selection.
      expect(host(primary, hostName)).toBe(retainedPrimary);
      expect(
        host("mac-sidebar-settings", hostName).props.accessibilityState.selected
      ).toBe(false);
      expect(retainedPrimary.props.accessibilityState.selected).toBe(
        section !== "search"
      );
      expect(sourceRow(hostName).props.accessibilityState.selected).toBe(
        section !== "search"
      );
      act(() => navigation.navigate("Settings", { screen: "SettingsGroup" }));
      expect(navigation.getCurrentRoute()?.name).toBe("SettingsGroup");
      expect(selected("mac-sidebar-settings")).toBe(true);
      act(() => navigation.goBack());
      expect(navigation.getCurrentRoute()?.name).toBe("SettingsHome");
      expect(selected("mac-sidebar-settings")).toBe(true);
      // Target the outer host, as the native Settings dismissal does.
      act(() =>
        navigation.dispatch({
          ...CommonActions.goBack(),
          target: navigation.getRootState().key
        })
      );
      expect(
        navigation.getRootState().routes[navigation.getRootState().index].name
      ).toBe(hostName);
      expect(useNavigationStore.getState().currentRoute).toBe("Settings");
      expect(useNavigationStore.getState().focusedRouteId).toBe("book-a");
      expect(selected("mac-sidebar-settings")).toBe(false);
      expect(host(primary)).toBe(retainedPrimary);
      expect(selected(primary)).toBe(section !== "search");
      expect(sourceRow().props.accessibilityState.selected).toBe(
        section !== "search"
      );
    }
  );
});
