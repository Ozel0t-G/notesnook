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
 * The iPad sidebar's source rows, with the real `SideMenuHome`, the real
 * `MenuItem` and the real `utils/ipad-layout` helpers - the whole
 * `SideMenuHome` -> `MenuItem` prop contract, not a probe.
 *
 * Only the peripheral edges are mocked: the drag/reorder rendering, the native
 * primitives, the shared row data, the database facets and the navigation
 * service. What the suite reads (row ids, labels, focused ids, counts,
 * accessibility state, press actions) is produced by the production rows.
 */

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";

let mockFocusedRouteId = "Library";
const mockSetFocusedRouteId = jest.fn();

const mockRoutes: Record<string, string> = {
  AllNotes: "All Notes",
  Inbox: "Inbox",
  Favorites: "Favorites",
  Library: "Library",
  Notes: "Notes"
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
  return {
    strings: new Proxy(
      {},
      {
        get: (_target, key) => {
          const name = String(key);
          if (name === "routes") return routes;
          if (name === "tasksTitle") return () => "Tasks";
          return () => name;
        }
      }
    )
  };
});

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: { accent: "#0a84ff", paragraph: "#000000" },
      secondary: { icon: "#666666", paragraph: "#666666" },
      selected: { icon: "#0a84ff", paragraph: "#000000" },
      static: { yellow: "#ffcc00" }
    },
    isDark: false
  })
}));

jest.mock("react-native", () => {
  const React = require("react");
  return {
    View: "View",
    FlatList: (props: { renderItem?: (info: unknown) => React.ReactNode }) =>
      React.createElement(
        "FlatList",
        null,
        props.renderItem ? props.renderItem({ item: 0, index: 0 }) : null
      ),
    Platform: { OS: "ios", isPad: true, isMacCatalyst: false }
  };
});

jest.mock("react-native-drax", () => {
  const React = require("react");
  return {
    DraxProvider: (props: { children?: React.ReactNode }) =>
      React.createElement("DraxProvider", null, props.children),
    DraxScrollView: (props: Record<string, unknown>) =>
      React.createElement("DraxScrollView", props)
  };
});

jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("Icon", props);
  }
}));

jest.mock("../../common/database", () => ({
  db: {
    notes: {
      all: { count: jest.fn(async () => 3) },
      unassigned: { count: jest.fn(async () => 7) },
      favorites: { count: jest.fn(async () => 0) }
    },
    settings: {
      setSideBarOrder: jest.fn(),
      setSideBarHiddenItems: jest.fn()
    }
  }
}));

jest.mock("../../services/navigation", () => ({
  __esModule: true,
  default: { navigate: jest.fn(), closeDrawer: jest.fn() }
}));

jest.mock("../../stores/use-menu-store", () => ({
  useMenuStore: (selector: (state: unknown) => unknown) =>
    selector({ order: { routes: [] }, hiddenItems: { routes: [] } })
}));

jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: (selector: (state: unknown) => unknown) =>
    selector({ isAppLoading: false, settings: { introCompleted: true } })
}));

jest.mock("../../stores/use-navigation-store", () => {
  const React = require("react");
  // A subscribable store, so a `setFocusedRouteId` call actually re-renders the
  // real `MenuItem` rows instead of only being recorded.
  const listeners = new Set<() => void>();
  const getState = () => ({
    focusedRouteId: mockFocusedRouteId,
    currentRoute: "Library",
    setFocusedRouteId: (id?: string) => {
      mockSetFocusedRouteId(id);
      mockFocusedRouteId = id as string;
      listeners.forEach((listener) => listener());
    }
  });
  const useStore = (selector: (state: unknown) => unknown) =>
    React.useSyncExternalStore(
      (onChange: () => void) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      () => selector(getState()),
      () => selector(getState())
    );
  return {
    __esModule: true,
    default: Object.assign(useStore, { getState })
  };
});

jest.mock("../../stores/use-relation-store", () => ({
  useRelationStore: (selector: (state: unknown) => unknown) =>
    selector({ updater: 0 })
}));

jest.mock("../../utils/menu-items", () => ({
  MenuItemsList: [
    {
      dataType: "note",
      id: "Notes",
      title: "Notes",
      icon: "note-outline",
      type: "side-menu-item"
    },
    {
      dataType: "note",
      id: "Favorites",
      title: "Favorites",
      icon: "star-outline",
      type: "side-menu-item"
    },
    {
      id: "Tasks",
      title: "Tasks",
      icon: "format-list-checks",
      type: "side-menu-item"
    }
  ]
}));

jest.mock("../../utils/styles", () => ({
  DefaultAppStyles: { GAP: 12, GAP_VERTICAL: 8, GAP_VERTICAL_SMALL: 4 }
}));

jest.mock("../../utils/size", () => ({
  AppFontSize: { md: 16, sm: 14, xxs: 11 },
  defaultBorderRadius: 6
}));

jest.mock("../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: true,
    sidebarBackground: "#f2f2f7",
    sidebarPadding: 12,
    selectedSurface: "#e5e5ea",
    controlRadius: 10,
    sectionSpacing: 20,
    pagePadding: 20
  })
}));

jest.mock("../../utils/events", () => ({
  eAfterSync: "eAfterSync",
  eMenuItemUpdate: "eMenuItemUpdate"
}));

jest.mock("../../hooks/use-db-item", () => ({
  useTotalNotes: () => ({
    getTotalNotes: jest.fn(),
    totalNotes: () => 0
  })
}));

jest.mock("../../services/event-manager", () => ({
  eSubscribeEvent: jest.fn(() => ({ unsubscribe: jest.fn() })),
  eUnSubscribeEvent: jest.fn(),
  subscribeToItemUpdate: jest.fn(() => ({ unsubscribe: jest.fn() }))
}));

jest.mock("../../services/templates", () => ({
  getTemplateCount: jest.fn(async () => 0)
}));

jest.mock("../list/reorderable-list", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: ({
      data,
      renderDraggableItem
    }: {
      data: unknown[];
      renderDraggableItem: (info: { item: unknown; index: number }) => unknown;
    }) =>
      React.createElement(
        "ReorderableList",
        null,
        data.map((item, index) => renderDraggableItem({ item, index }))
      )
  };
});

jest.mock("../sheets/menu-item-properties", () => ({
  MenuItemProperties: { present: jest.fn() }
}));

jest.mock("../ui/button", () => {
  const React = require("react");
  return {
    Button: (props: Record<string, unknown>) =>
      React.createElement("Button", props)
  };
});

jest.mock("../ui/pressable", () => {
  const React = require("react");
  return {
    Pressable: (props: Record<string, unknown>) => {
      const { children, ...rest } = props;
      return React.createElement("Pressable", rest, children);
    }
  };
});

jest.mock("../ui/typography/paragraph", () => {
  const React = require("react");
  const Paragraph = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("Paragraph", null, children);
  return { __esModule: true, default: Paragraph };
});

jest.mock("./color-section", () => {
  const React = require("react");
  return {
    ColorSection: () => React.createElement("ColorSection")
  };
});

jest.mock("./pinned-section", () => {
  const React = require("react");
  return {
    PinnedSection: () => React.createElement("PinnedSection")
  };
});

jest.mock("./side-menu-header", () => {
  const React = require("react");
  return {
    SideMenuHeader: () => React.createElement("SideMenuHeader")
  };
});

jest.mock("./dragging-store", () => ({
  useSideBarDraggingStore: Object.assign(jest.fn(), {
    getState: () => ({ dragging: false })
  })
}));

import { SideMenuHome } from "./side-menu-home";
import { IPadWorkspaceProvider } from "../ipad-workspace-context";
import { MenuItemsList } from "../../utils/menu-items";
import type { SideMenuItem } from "../../utils/menu-items";
import { db } from "../../common/database";
import Navigation from "../../services/navigation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("SideMenuHome iPad source rows", () => {
  let tree: ReactTestRenderer | undefined;

  const render = async (ipad: boolean) => {
    await act(async () => {
      tree = create(
        <IPadWorkspaceProvider
          value={ipad ? { paneMode: "wide", sidebarVisible: true } : undefined}
        >
          <SideMenuHome />
        </IPadWorkspaceProvider>
      );
    });
    // The rows read their counts from the database in an async effect, so let
    // the resolved counts settle before the assertions read them.
    await act(async () => {
      await Promise.resolve();
    });
  };

  /** The real `MenuItem` rows, in the order `SideMenuHome` renders them. */
  const rows = () =>
    (tree?.root.findAllByType("Pressable" as never) ?? []).map(
      (node) => node.props as Record<string, unknown>
    );

  const row = (testID: string) =>
    rows().find((props) => props.testID === testID);

  /** The row's count paragraph is its last `Paragraph` child. */
  const count = (testID: string) => {
    if (!tree) return undefined;
    const node = tree.root.findAllByProps({ testID })[0];
    const paragraphs = node.findAllByType("Paragraph" as never);
    return paragraphs[paragraphs.length - 1]?.props.children;
  };

  beforeEach(() => {
    mockFocusedRouteId = "Library";
    mockSetFocusedRouteId.mockClear();
    (db.notes.all.count as jest.Mock).mockClear();
    (db.notes.unassigned.count as jest.Mock).mockClear();
    (Navigation.navigate as jest.Mock).mockClear();
    (Navigation.closeDrawer as jest.Mock).mockClear();
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
  });

  it("routes All Notes and the new Inbox row to the Library and closes the drawer", async () => {
    await render(true);

    // The note-list row keeps its persisted id and is labelled with the
    // existing localized All Notes string - the draggable-row label lookup in
    // SideMenuHome must not translate it back to the legacy "Notes" title.
    expect(rows().map((props) => props.testID)).toEqual([
      "All Notes",
      "Inbox",
      "Favorites",
      "Tasks"
    ]);
    expect(rows().map((props) => props.accessibilityLabel)).toEqual([
      "All Notes",
      "Inbox",
      "Favorites",
      "Tasks"
    ]);

    act(() => {
      (row("All Notes")?.onPress as () => void)();
    });
    expect(Navigation.closeDrawer).toHaveBeenCalledTimes(1);
    expect(Navigation.navigate).toHaveBeenCalledWith("Library", {
      initialCollection: "all-notes"
    });

    (Navigation.closeDrawer as jest.Mock).mockClear();
    (Navigation.navigate as jest.Mock).mockClear();
    act(() => {
      (row("Inbox")?.onPress as () => void)();
    });
    expect(Navigation.closeDrawer).toHaveBeenCalledTimes(1);
    expect(Navigation.navigate).toHaveBeenCalledWith("Library", {
      initialCollection: "inbox"
    });
  });

  it("publishes the opened collection's focused route id before navigating, so the sidebar selection follows", async () => {
    // A retained Library/NoteCollection re-opened with the same collection never
    // re-runs its mount effect, so the row itself must state the selection.
    mockFocusedRouteId = "notebook-1";
    await render(true);

    expect(row("All Notes")?.accessibilityState).toEqual({ selected: false });
    expect(row("Inbox")?.accessibilityState).toEqual({ selected: false });

    act(() => {
      (row("All Notes")?.onPress as () => void)();
    });

    expect(mockSetFocusedRouteId).toHaveBeenCalledWith("AllNotes");
    // The selection is stated before the navigation runs, never after it. The
    // last entry of `invocationCallOrder` is this press's call (the counter is
    // not reset by `mockClear`, so the first entry may belong to an earlier
    // test).
    const last = (mock: jest.Mock) => {
      const order = mock.mock.invocationCallOrder;
      return order[order.length - 1];
    };
    expect(last(mockSetFocusedRouteId)).toBeLessThan(
      last(Navigation.closeDrawer as jest.Mock)
    );
    expect(last(mockSetFocusedRouteId)).toBeLessThan(
      last(Navigation.navigate as jest.Mock)
    );
    expect(row("All Notes")?.accessibilityState).toEqual({ selected: true });
    expect(row("Inbox")?.accessibilityState).toEqual({ selected: false });

    (Navigation.closeDrawer as jest.Mock).mockClear();
    (Navigation.navigate as jest.Mock).mockClear();
    mockSetFocusedRouteId.mockClear();

    act(() => {
      (row("Inbox")?.onPress as () => void)();
    });
    expect(mockSetFocusedRouteId).toHaveBeenCalledWith("Inbox");
    expect(row("Inbox")?.accessibilityState).toEqual({ selected: true });
    expect(row("All Notes")?.accessibilityState).toEqual({ selected: false });
  });

  it("highlights the focused All Notes row and leaves the others unselected", async () => {
    mockFocusedRouteId = "AllNotes";
    await render(true);

    expect(row("All Notes")?.accessibilityState).toEqual({ selected: true });
    expect(row("Inbox")?.accessibilityState).toEqual({ selected: false });
    expect(row("Favorites")?.accessibilityState).toEqual({ selected: false });
  });

  it("highlights the Inbox row and counts the notes that are in no notebook", async () => {
    mockFocusedRouteId = "Inbox";
    await render(true);

    expect(row("Inbox")?.accessibilityState).toEqual({ selected: true });
    expect(row("All Notes")?.accessibilityState).toEqual({ selected: false });

    // The Inbox collection is exactly the notes in no notebook, so the row's
    // count comes from the unassigned notes, not from the whole library.
    expect(db.notes.unassigned.count).toHaveBeenCalled();
    expect(count("Inbox")).toBe(7);
    expect(count("All Notes")).toBe(3);

    // The neighbouring rows keep the untouched shared ids/icons/labels so the
    // saved order and hidden state keep working.
    expect(MenuItemsList[1].id).toBe("Favorites");
    expect(row("Favorites")?.accessibilityLabel).toBe("Favorites");
  });

  it("leaves the shared menu list untouched on every other client", async () => {
    await render(false);

    expect(rows().map((props) => props.testID)).toEqual([
      "Notes",
      "Favorites",
      "Tasks"
    ]);
    expect(rows().map((props) => props.accessibilityLabel)).toEqual([
      "Notes",
      "Favorites",
      "Tasks"
    ]);
    // No Inbox row and no rewritten labels/actions outside the iPad workspace.
    expect(rows()).toHaveLength(3);
    // The shared list itself is never mutated by the iPad mapping.
    expect(MenuItemsList[0].title).toBe("Notes");
    expect(MenuItemsList[0].onPress).toBeUndefined();
    // `focusedId` belongs to the sidebar's typed extension of `SideMenuItem`,
    // not the shared list's own type.
    expect(
      (MenuItemsList[0] as SideMenuItem & { focusedId?: string }).focusedId
    ).toBeUndefined();
    expect(MenuItemsList).toHaveLength(3);
    // Nothing outside the iPad workspace publishes a sidebar selection.
    expect(mockSetFocusedRouteId).not.toHaveBeenCalled();
  });
});
