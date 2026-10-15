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

/** Render the real NotebookHeader, iPad information row, Pressable and typography.
 * Native host/symbol, database/presenter/navigation and semantic resolver are seams.
 * Shared Header + NotebookHeader composition asserts the single title/count in
 * normal/selection modes. Layout, width permutations and visuals need Root runtime QA.
 */
import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { Platform } from "react-native";
import type { Notebook } from "@notesnook/core";
import { NotebookHeader } from "./notebook-header";
import { Header } from "../../header";
import { useSelectionStore } from "../../../stores/use-selection-store";

let mockDark = false;
let mockWidth = 512;
let mockFontScale = 1;
const mockLookup = jest.fn();
const mockNavigate = jest.fn();
const mockProperties = jest.fn();
const mockColors = () => ({
  primary: {
    background: mockDark ? "#18181b" : "#ffffff",
    heading: mockDark ? "#f2f2f4" : "#18181b",
    paragraph: mockDark ? "#acacb4" : "#64646b",
    accent: mockDark ? "#86dba2" : "#087c3e",
    hover: "#dddddd",
    shade: "#dddddd",
    border: "#dddddd",
    icon: "#888888"
  },
  secondary: { background: "#777777", paragraph: "#888888", icon: "#999999" },
  selected: { background: "#dddddd", accent: "#087c3e" },
  error: { background: "#ff0000", paragraph: "#ff0000", icon: "#ff0000" },
  static: { white: "#ffffff", black: "#000000", orange: "#ff8800" }
});

jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "NativePressable",
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
  useWindowDimensions: () => ({
    width: mockWidth,
    height: 1000,
    fontScale: mockFontScale
  })
}));
jest.mock("@notesnook/common", () => ({
  getFormattedDate: () => "modified-date"
}));
jest.mock("@notesnook/intl", () => ({
  strings: {
    routes: { Library: () => "Library" },
    selectedCode: (n: number) => `${n} selected`,
    done: () => "Done",
    searchInRoute: (title: string) => `Search in ${title}`,
    search: () => "Search",
    notebookOptions: () => "Notebook Options",
    more: () => "More",
    listSelect: () => "Select",
    listViewAsCards: () => "Cards",
    listViewAsCompact: () => "Compact",
    listSortBy: () => "Sort By",
    listAscending: () => "Ascending",
    listDescending: () => "Descending",
    listGroupBy: () => "Group By",
    sortByStrings: {},
    groupByStrings: {},
    notes: (n: number) => `${n} notes`
  }
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({ colors: mockColors(), isDark: mockDark })
}));
jest.mock("../../../utils/constants", () => ({
  isMacCatalyst: () => Platform.OS === "ios" && Platform.isMacCatalyst,
  SORT: { dateCreated: "dateCreated" },
  GROUP: { default: "default" }
}));
jest.mock("../../../stores/use-theme-store", () => ({
  useThemeStore: {
    getState: () => ({ colorScheme: mockDark ? "dark" : "light" })
  }
}));
jest.mock("../../../utils/size", () => ({
  AppFontSize: { xs: 14, xxs: 12, sm: 15, lg: 20, xl: 22, xxl: 25 },
  defaultBorderRadius: 8
}));
jest.mock("../../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: (
    colors: ReturnType<typeof mockColors>,
    isDark: boolean
  ) => ({
    ios: true,
    screenBackground: "#ffffff",
    primaryText: colors.primary.heading,
    controlRadius: 10,
    pagePadding: 16,
    listSurface: isDark ? "#202023" : "#f6f6f8",
    secondaryText: colors.secondary.paragraph
  })
}));
jest.mock("../../../common/database", () => ({
  db: { notebooks: { notebook: (...args: unknown[]) => mockLookup(...args) } }
}));
jest.mock("../../../screens/notebook", () => ({
  __esModule: true,
  default: { navigate: (...args: unknown[]) => mockNavigate(...args) }
}));
jest.mock("../../properties", () => ({
  Properties: { present: (...args: unknown[]) => mockProperties(...args) }
}));
jest.mock("../../task-symbol-view", () => ({ TaskSymbolView: "NativeSymbol" }));
jest.mock("../../ui/AppIcon", () => ({ __esModule: true, default: "AppIcon" }));
jest.mock("../../ui/icon-button", () => ({ IconButton: "IconButton" }));

jest.mock("@react-navigation/core", () => ({
  NavigationContext: require("react").createContext(undefined)
}));
jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => ({
  __esModule: true,
  default: "Icon"
}));
jest.mock("../../mac-hover", () => ({
  useMacHover: () => ({ hovered: false, hoverProps: {} }),
  MacHoverHighlight: () => null
}));
jest.mock("../../native-menu", () => ({ MenuButton: "MenuButton" }));
jest.mock("../../header/left-menus", () => ({ LeftMenus: () => null }));
jest.mock("../../header/right-menus", () => ({ RightMenus: () => null }));
// Keep the real menu builder/dispatch; only data-store boundaries are mocked.
jest.mock("../../../stores/use-notebook-store", () => ({
  useNotebookStore: { getState: () => ({ refresh: jest.fn() }) }
}));
jest.mock("../../../stores/use-tag-store", () => ({
  useTagStore: { getState: () => ({ refresh: jest.fn() }) }
}));
jest.mock("../../sheets/sort", () => ({
  __esModule: true,
  default: () => null
}));
jest.mock("../../../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}));
jest.mock("../../../hooks/use-group-options", () => ({
  useGroupOptions: () => ({}),
  getGroupOptions: () => ({}),
  setGroupOptionsById: jest.fn()
}));
jest.mock("../../../hooks/use-is-compact-mode-enabled", () => ({
  useIsCompactModeEnabled: () => false
}));
jest.mock("../../../services/event-manager", () => ({
  eSubscribeEvent: jest.fn(),
  eUnSubscribeEvent: jest.fn()
}));
jest.mock("../../../services/navigation", () => ({
  __esModule: true,
  default: { goBack: jest.fn() }
}));
jest.mock("../../../services/settings", () => ({
  __esModule: true,
  default: { set: jest.fn() }
}));
jest.mock("../../../stores/use-user-store", () => ({
  SyncStatus: { Failed: "failed" },
  useUserStore: (selector: (state: unknown) => unknown) => selector({})
}));
jest.mock("../../sheets/user", () => ({ UserSheet: { present: jest.fn() } }));
jest.mock("../../../utils/functions", () => ({
  getObfuscatedEmail: (email: string) => email
}));
jest.mock("../../../utils/mac-layout", () => ({
  MAC_TOOLBAR_HEIGHT: 52,
  macToolbarInset: (top: number) => top
}));
jest.mock("../../../utils/mac-window-title", () => ({
  useMacListTitleStore: Object.assign(() => undefined, {
    getState: () => ({ setListTitle: jest.fn() })
  })
}));
jest.mock("../../../stores/use-mac-window-store", () => ({
  useMacWindowStore: Object.assign(() => undefined, {
    getState: () => ({}),
    subscribe: () => () => undefined
  })
}));
jest.mock("../../../stores/use-apple-navigation-store", () => ({
  useAppleNavigationStore: Object.assign(() => undefined, {
    getState: () => ({ section: "library" }),
    subscribe: () => () => undefined
  })
}));

const notebook = {
  id: "book",
  type: "notebook",
  title: "Langer deutscher Notebook-Titel für die Dokumentation",
  description: "Beschreibung bleibt in Notebook-Informationen",
  dateCreated: 1,
  dateModified: 2
} as Notebook;
const parent = { id: "parent", title: "Übergeordnetes Notebook" };
let tree: ReactTestRenderer;
function render(
  item = notebook,
  breadcrumbs: { id: string; title: string }[] = []
) {
  act(() => {
    tree = create(
      <NotebookHeader
        notebook={item}
        totalNotes={7}
        breadcrumbs={breadcrumbs}
      />
    );
  });
  return tree.root;
}
function visibleText() {
  return tree.root
    .findAllByType("Text" as never)
    .map((node) => node.children.join(" "))
    .join(" ");
}
function hostButton(id: string) {
  const button = tree.root
    .findAllByType("NativePressable" as never)
    .find((node) => node.props.testID === id);
  if (!button) throw new Error(`Missing button ${id}`);
  return button;
}
function styleFor(id: string) {
  return Object.assign({}, ...hostButton(id).props.style({ pressed: false }));
}
beforeEach(() => {
  jest.clearAllMocks();
  useSelectionStore.getState().clearSelection();
  mockDark = false;
  mockWidth = 512;
  mockFontScale = 1;
  Object.assign(Platform, { OS: "ios", isPad: true, isMacCatalyst: false });
});
afterEach(() => {
  if (tree) act(() => tree.unmount());
});

it.each([false, true])(
  "renders no normal top-level context or reserved row, dark=%s",
  (dark) => {
    mockDark = dark;
    render();
    expect(tree.toJSON()).toBeNull();
    expect(visibleText()).toBe("");
    expect(mockProperties).not.toHaveBeenCalled();
  }
);

it.each([false, true])(
  "retains nested breadcrumbs without the duplicate information row, dark=%s",
  (dark) => {
    mockDark = dark;
    render(notebook, [parent]);
    expect(visibleText()).toBe(parent.title);
    expect(
      tree.root.findAllByProps({ testID: "ipad-notebook-properties" })
    ).toHaveLength(0);
    expect(
      tree.root.findByProps({ testID: "ipad-notebook-information" }).props.style
        .backgroundColor
    ).toBe(dark ? "#202023" : "#f6f6f8");
    expect(hostButton("ipad-notebook-ancestor-parent")).toBeDefined();
  }
);

it.each([false, true])(
  "retains the labeled 44pt information action during selection, dark=%s",
  (dark) => {
    mockDark = dark;
    useSelectionStore.getState().setSelectionMode("note");
    render();
    const button = hostButton("ipad-notebook-properties");
    expect(button.props.accessibilityRole).toBe("button");
    expect(button.props.accessibilityLabel).toBe(
      `Notebook Options: ${notebook.title}`
    );
    expect(styleFor("ipad-notebook-properties").minHeight).toBe(44);
    expect(styleFor("ipad-notebook-properties").minWidth).toBe(44);
    expect(visibleText()).toContain(notebook.title);
    expect(visibleText()).toContain("7 notes");
    act(() => button.props.onPress({}));
    expect(mockProperties).toHaveBeenCalledWith(notebook);
    expect(mockNavigate).not.toHaveBeenCalled();
  }
);

it("keeps the primary title and live count exactly once through selection and return", () => {
  const compose = (totalNotes: number) => (
    <>
      <Header
        renderedInRoute="Notebook"
        id={notebook.id}
        title={notebook.title}
        count={totalNotes}
        hasSearch
        menu={{
          group: "notes",
          dataType: "note",
          groupId: notebook.id,
          groupType: "notebook",
          selectable: true
        }}
      />
      <NotebookHeader
        notebook={notebook}
        totalNotes={totalNotes}
        breadcrumbs={[]}
      />
    </>
  );
  act(() => {
    tree = create(compose(7));
  });
  const expectIdentity = (count: number) => {
    const text = tree.root
      .findAllByType("Text" as never)
      .map((node) => node.children.join(" "));
    expect(text.filter((value) => value === notebook.title)).toHaveLength(1);
    expect(text.filter((value) => value === `${count} notes`)).toHaveLength(1);
  };
  expectIdentity(7);
  expect(
    tree.root.findAllByProps({ testID: "ipad-notebook-information" })
  ).toHaveLength(0);
  act(() => useSelectionStore.getState().setSelectionMode("note"));
  expectIdentity(7);
  act(() => tree.update(compose(8)));
  expectIdentity(8);
  act(() => hostButton("ipad-notebook-properties").props.onPress({}));
  expect(mockProperties).toHaveBeenCalledWith(notebook);
  act(() => useSelectionStore.getState().clearSelection());
  expectIdentity(8);
  expect(
    tree.root.findAllByProps({ testID: "ipad-notebook-information" })
  ).toHaveLength(0);
  expect(
    tree.root.findAllByProps({ testID: "ipad-notebook-properties" })
  ).toHaveLength(0);
});

it("keeps ancestor navigation and fetches the current ancestor before using the existing return route", async () => {
  const ancestor = { ...notebook, ...parent };
  mockLookup.mockResolvedValue(ancestor);
  render(notebook, [parent]);
  const button = hostButton("ipad-notebook-ancestor-parent");
  expect(button.props.accessibilityRole).toBe("button");
  expect(button.props.accessibilityLabel).toBe(parent.title);
  expect(styleFor("ipad-notebook-ancestor-parent").minHeight).toBe(44);
  await act(async () => {
    button.props.onPress({});
  });
  expect(mockLookup).toHaveBeenCalledWith(parent.id);
  expect(mockNavigate).toHaveBeenCalledWith(ancestor, true);
  expect(mockProperties).not.toHaveBeenCalled();
});

it("retains nested context through selection and returns to breadcrumbs only", () => {
  render(notebook, [parent]);
  act(() => useSelectionStore.getState().setSelectionMode("note"));
  expect(visibleText()).toContain(notebook.title);
  expect(visibleText()).toContain(parent.title);
  expect(hostButton("ipad-notebook-properties")).toBeDefined();
  act(() => useSelectionStore.getState().clearSelection());
  expect(visibleText()).toBe(parent.title);
  expect(hostButton("ipad-notebook-ancestor-parent")).toBeDefined();
  expect(
    tree.root.findAllByProps({ testID: "ipad-notebook-properties" })
  ).toHaveLength(0);
});

it("does not navigate to a deleted ancestor", async () => {
  mockLookup.mockResolvedValue(undefined);
  render(notebook, [parent]);
  await act(async () => {
    hostButton("ipad-notebook-ancestor-parent").props.onPress({});
  });
  expect(mockNavigate).not.toHaveBeenCalled();
});

it("updates selection information to the current notebook, then restores empty context", () => {
  useSelectionStore.getState().setSelectionMode("note");
  render();
  const next = {
    ...notebook,
    id: "next",
    title: "Anderes Notebook"
  } as Notebook;
  act(() =>
    tree.update(
      <NotebookHeader notebook={next} totalNotes={0} breadcrumbs={[]} />
    )
  );
  act(() => hostButton("ipad-notebook-properties").props.onPress({}));
  expect(mockProperties).toHaveBeenCalledTimes(1);
  expect(mockProperties).toHaveBeenCalledWith(next);
  expect(
    hostButton("ipad-notebook-properties").props.accessibilityLabel
  ).toContain(next.title);
  expect(visibleText()).toContain("0 notes");
  expect(visibleText()).not.toContain(notebook.title);
  act(() => useSelectionStore.getState().clearSelection());
  expect(tree.toJSON()).toBeNull();
});

it("supports long ancestor labels and scaled text without fixed row heights or line clamps", () => {
  mockFontScale = 2;
  render(notebook, [
    parent,
    { id: "grandparent", title: "Weiterer sehr langer übergeordneter Titel" }
  ]);
  expect(visibleText()).toContain(parent.title);
  for (const id of [
    "ipad-notebook-ancestor-parent",
    "ipad-notebook-ancestor-grandparent"
  ]) {
    expect(styleFor(id).height).toBeUndefined();
    expect(styleFor(id).maxHeight).toBeUndefined();
  }
  for (const text of tree.root.findAllByType("Text" as never)) {
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.allowFontScaling).not.toBe(false);
  }
});

it.each([
  ["iPhone", "ios", false, false],
  ["Catalyst Mac idiom", "ios", false, true],
  ["Catalyst iPad idiom", "ios", true, true],
  ["Android tablet", "android", true, false]
])(
  "preserves the existing full header on %s",
  (_name, os, isPad, isMacCatalyst) => {
    Object.assign(Platform, { OS: os, isPad, isMacCatalyst });
    render(notebook, [parent]);
    expect(visibleText()).toContain(notebook.title);
    expect(visibleText()).toContain(notebook.description);
    expect(visibleText()).toContain("7 notes");
    expect(visibleText()).toContain("modified-date");
    expect(visibleText()).toContain(parent.title);
    expect(tree.root.findAllByType("AppIcon" as never)).toHaveLength(1);
    expect(
      tree.root.findAllByProps({ testID: "ipad-notebook-properties" })
    ).toHaveLength(0);
  }
);

// Consumer-shaped props mirror the inspected NotebookScreen menu.extra/onExtra.
// This renders the actual Header, useListViewMenu and IosMoreMenu, not the full
// NotebookScreen or native menu/sheet; Root owns that runtime roundtrip.
it("forwards notebook actions through the real Header More and restores it after selection", () => {
  const onExtra = jest.fn();
  const compose = (item: Notebook) => (
    <>
      <Header
        renderedInRoute="Notebook"
        id={item.id}
        title={item.title}
        count={7}
        hasSearch
        menu={{
          group: "notes",
          dataType: "note",
          groupId: item.id,
          groupType: "notebook",
          selectable: true,
          extra: [
            {
              id: "notebook-options",
              title: "Notebook Options",
              symbol: "folder.badge.gearshape"
            },
            {
              id: "notebook-tree",
              title: "Notebooks",
              symbol: "list.bullet.indent"
            }
          ],
          onExtra: (id) => onExtra(id, item)
        }}
      />
      <NotebookHeader notebook={item} totalNotes={7} breadcrumbs={[]} />
    </>
  );
  act(() => {
    tree = create(compose(notebook));
  });
  const more = () => tree.root.findByType("MenuButton" as never);
  expect(more().props.testID).toBe("header-more-menu");
  expect(more().props.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        children: expect.arrayContaining([
          {
            id: "notebook-options",
            title: "Notebook Options",
            symbol: "folder.badge.gearshape"
          },
          {
            id: "notebook-tree",
            title: "Notebooks",
            symbol: "list.bullet.indent"
          }
        ])
      })
    ])
  );
  act(() => more().props.onSelect("notebook-options"));
  expect(onExtra).toHaveBeenLastCalledWith("notebook-options", notebook);
  act(() => more().props.onSelect("notebook-tree"));
  expect(onExtra).toHaveBeenLastCalledWith("notebook-tree", notebook);
  expect(
    tree.root.findAllByProps({ testID: "ipad-notebook-properties" })
  ).toHaveLength(0);
  const next = { ...notebook, id: "next", title: "Aktuelles Notebook" };
  act(() => tree.update(compose(next)));
  act(() => more().props.onSelect("notebook-options"));
  expect(onExtra).toHaveBeenLastCalledWith("notebook-options", next);
  act(() => more().props.onSelect("list:select"));
  expect(tree.root.findAllByType("MenuButton" as never)).toHaveLength(0);
  act(() => hostButton("ipad-notebook-properties").props.onPress({}));
  expect(mockProperties).toHaveBeenCalledWith(next);
  const done = tree.root
    .findAllByType("NativePressable" as never)
    .find((node) => node.props.accessibilityLabel === "Done");
  if (!done) throw new Error("Missing Done selection action");
  expect(done.props.onPress).toEqual(expect.any(Function));
  act(() => done.props.onPress({}));
  expect(more().props.testID).toBe("header-more-menu");
  expect(
    tree.root.findAllByProps({ testID: "ipad-notebook-information" })
  ).toHaveLength(0);
});
