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
 * The shared side-menu row, with the real `MenuItem`.
 *
 * The suite covers the two iPad additions the source rows depend on: the
 * `focusedId` selection highlight (the note-list row reports `AllNotes` while
 * keeping the persisted `Notes` id) and the Inbox row's truthful count
 * (`db.notes.unassigned`), plus the existing press/accessibility contract.
 */

import React from "react";
import { Platform } from "react-native";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { IPadSourceRowMeasurement } from "./ipad-source-navigation";
import { act, create, ReactTestRenderer } from "react-test-renderer";

let mockFocusedRouteId = "Library";
let mockDragging = false;
let mockDark = false;

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      selected: { icon: "#0a84ff", paragraph: mockDark ? "#f2f2f4" : "#000" },
      primary: { paragraph: mockDark ? "#f2f2f4" : "#000" },
      secondary: { icon: "#666", paragraph: mockDark ? "#acacb4" : "#666" },
      static: { yellow: "#ffcc00" }
    },
    isDark: mockDark
  })
}));

jest.mock("../ui/pressable", () => {
  const React = require("react");
  return {
    Pressable: (props: Record<string, unknown>) => {
      const { children, ...rest } = props;
      return React.createElement("Pressable", rest, children);
    }
  };
});

jest.mock("../task-symbol-view", () => ({ TaskSymbolView: "NativeSymbol" }));

// Real Paragraph renders Text so token choices reach native text styles.
jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false }
}));

jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("Icon", props);
  }
}));

jest.mock("../../hooks/use-db-item", () => ({
  useTotalNotes: () => ({
    getTotalNotes: jest.fn(),
    totalNotes: () => 0
  })
}));

jest.mock("../../common/database", () => ({
  db: {
    notes: {
      all: { count: jest.fn(async () => 3) },
      unassigned: { count: jest.fn(async () => 7) }
    }
  }
}));

jest.mock("../../services/event-manager", () => ({
  eSubscribeEvent: jest.fn(() => ({ unsubscribe: jest.fn() })),
  eUnSubscribeEvent: jest.fn(),
  subscribeToItemUpdate: jest.fn(() => ({ unsubscribe: jest.fn() }))
}));

jest.mock("../../services/navigation", () => ({
  __esModule: true,
  default: { closeDrawer: jest.fn(), navigate: jest.fn(), goBack: jest.fn() }
}));

jest.mock("../../services/templates", () => ({
  getTemplateCount: jest.fn(async () => 0)
}));

jest.mock("../../stores/use-navigation-store", () => {
  const selectorHook = (selector: (state: unknown) => unknown) =>
    selector({ focusedRouteId: mockFocusedRouteId, currentRoute: "Library" });
  return {
    __esModule: true,
    default: Object.assign(selectorHook, {
      getState: () => ({
        focusedRouteId: mockFocusedRouteId,
        currentRoute: "Library"
      })
    })
  };
});

jest.mock("../../stores/use-relation-store", () => ({
  useRelationStore: (selector: (state: unknown) => unknown) =>
    selector({ updater: 0 })
}));

jest.mock("../../utils/events", () => ({
  eAfterSync: "eAfterSync",
  eMenuItemUpdate: "eMenuItemUpdate"
}));

jest.mock("../../utils/size", () => ({
  AppFontSize: { sm: 14, xxs: 11, xs: 13, md: 16 },
  defaultBorderRadius: 6
}));

jest.mock("../../utils/styles", () => ({
  DefaultAppStyles: { GAP_SMALL: 6, GAP_VERTICAL_SMALL: 4, GAP_VERTICAL: 10 }
}));

jest.mock("../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: true,
    controlRadius: 10,
    sidebarPadding: 12,
    selectedSurface: "#e5e5ea"
  })
}));

jest.mock("./dragging-store", () => ({
  useSideBarDraggingStore: Object.assign(jest.fn(), {
    getState: () => ({ dragging: mockDragging })
  })
}));

import { MenuItem } from "./menu-item";
import Navigation from "../../services/navigation";
import type { SideMenuItem } from "../../utils/menu-items";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The real `MenuItem` prop (a `SideMenuItem` plus the sidebar's focus marker),
// so `dataType` keeps the `ItemType | "monograph"` literal union.
type TestItem = SideMenuItem & { focusedId?: string };

const allNotesRow: TestItem = {
  id: "Notes",
  title: "All Notes",
  icon: "note-outline",
  type: "side-menu-item",
  dataType: "note",
  focusedId: "AllNotes"
};

const inboxRow: TestItem = {
  id: "Inbox",
  title: "Inbox",
  icon: "email-outline",
  type: "side-menu-item",
  focusedId: "Inbox"
};

describe("side menu MenuItem", () => {
  let tree: ReactTestRenderer | undefined;

  const render = async (
    item: TestItem,
    measure?: (id: string, height: number) => void
  ) => {
    await act(async () => {
      tree = create(
        <IPadSourceRowMeasurement.Provider value={measure}>
          <MenuItem item={item} testID={item.id} index={0} />
        </IPadSourceRowMeasurement.Provider>
      );
    });
    // The row's count is read from the database in an async effect, so let the
    // resolved count settle before assertions.
    await act(async () => {
      await Promise.resolve();
    });
  };

  const pressable = () =>
    tree?.root.findByType("Pressable" as never).props as Record<
      string,
      unknown
    >;

  const count = () => {
    const paragraphs = tree?.root.findAllByType("Text" as never) ?? [];
    return paragraphs[paragraphs.length - 1]?.props.children;
  };

  // The count is also exposed as the row's accessibility value, so VoiceOver
  // announces the number that sighted users see next to the title.
  const value = () => pressable().accessibilityValue;

  beforeEach(() => {
    mockFocusedRouteId = "Library";
    mockDragging = false;
    mockDark = false;
    Object.assign(Platform, { OS: "ios", isPad: true, isMacCatalyst: false });
    (Navigation.closeDrawer as jest.Mock).mockClear();
    (Navigation.navigate as jest.Mock).mockClear();
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
  });

  it("highlights the All Notes row from its focusedId while keeping its Notes id", async () => {
    mockFocusedRouteId = "AllNotes";
    await render(allNotesRow);
    expect(pressable().accessibilityState).toEqual({ selected: true });
    expect(pressable().accessibilityLabel).toBe("All Notes");
    // The value is the count the row paints, independent of the selected state.
    expect(value()).toEqual({ text: "3" });
  });

  it("highlights the Inbox row and counts the unassigned notes", async () => {
    mockFocusedRouteId = "Inbox";
    await render(inboxRow);
    expect(pressable().accessibilityState).toEqual({ selected: true });
    expect(pressable().accessibilityLabel).toBe("Inbox");
    // The Inbox collection is exactly the notes in no notebook.
    expect(count()).toBe(7);
    expect(value()).toEqual({ text: "7" });
  });

  it("counts All Notes from the whole library", async () => {
    await render({ ...allNotesRow, focusedId: undefined, id: "Notes" });
    expect(count()).toBe(3);
    expect(value()).toEqual({ text: "3" });
  });

  it("leaves rows unselected when the focused route does not match", async () => {
    mockFocusedRouteId = "Library";
    await render(allNotesRow);
    expect(pressable().accessibilityState).toEqual({ selected: false });
  });

  it("runs the row's own action instead of closing the drawer", async () => {
    const onPress = jest.fn();
    const item = { ...inboxRow, onPress };
    await render(item);
    act(() => {
      (pressable().onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledWith(item);
    expect(Navigation.closeDrawer).not.toHaveBeenCalled();
  });

  it("closes the drawer for a plain row and ignores presses while dragging", async () => {
    await render({ ...inboxRow, onPress: undefined });
    act(() => {
      (pressable().onPress as () => void)();
    });
    expect(Navigation.closeDrawer).toHaveBeenCalledTimes(1);

    (Navigation.closeDrawer as jest.Mock).mockClear();
    mockDragging = true;
    act(() => {
      (pressable().onPress as () => void)();
    });
    expect(Navigation.closeDrawer).not.toHaveBeenCalled();
  });
  const renderedTexts = () => {
    if (!tree) throw new Error("Missing rendered MenuItem");
    return tree.root.findAllByType("Text" as never);
  };
  const fontStyle = (index: number) =>
    Object.assign({}, ...renderedTexts()[index].props.style);

  it.each([false, true])(
    "uses readable iPad label/count tokens and preserves measured row height, dark=%s",
    async (dark) => {
      mockDark = dark;
      const measure = jest.fn();
      await render(inboxRow, measure);
      expect(fontStyle(0).fontSize).toBe(AppFontSize.md);
      expect(fontStyle(1).fontSize).toBe(AppFontSize.sm);
      expect(fontStyle(0).color).toBe(dark ? "#f2f2f4" : "#000");
      expect(fontStyle(1).color).toBe(dark ? "#acacb4" : "#666");
      expect(fontStyle(1).fontSize).toBeLessThan(fontStyle(0).fontSize);
      expect(fontStyle(1).flexShrink).toBe(0);
      expect(pressable().style).toMatchObject({
        minHeight: 44,
        paddingVertical: DefaultAppStyles.GAP_VERTICAL
      });
      act(() =>
        (pressable().onLayout as (event: unknown) => void)({
          nativeEvent: { layout: { height: 72 } }
        })
      );
      expect(measure).toHaveBeenCalledWith("Inbox", 72);
      expect(count()).toBe(7);
    }
  );

  it.each([
    ["iPhone", "ios", false, false],
    ["CatalystMac", "ios", false, true],
    ["CatalystPad", "ios", true, true],
    ["Android", "android", true, false]
  ])(
    "keeps legacy row typography and measurement behavior on %s",
    async (_name, OS, isPad, isMacCatalyst) => {
      Object.assign(Platform, { OS, isPad, isMacCatalyst });
      await render(allNotesRow, jest.fn());
      expect(fontStyle(0).fontSize).toBe(AppFontSize.sm);
      expect(fontStyle(1).fontSize).toBe(AppFontSize.xxs);
      expect(fontStyle(0)).toEqual({
        fontSize: AppFontSize.sm,
        color: "#000",
        fontWeight: "400",
        fontFamily: "Inter-Regular",
        flexShrink: 1
      });
      expect(fontStyle(1)).toEqual({
        fontSize: AppFontSize.xxs,
        color: "#666",
        fontWeight: "400",
        fontFamily: "Inter-Regular",
        marginLeft: DefaultAppStyles.GAP_SMALL
      });
      expect(pressable().onLayout).toBeUndefined();
      expect(
        (pressable().style as { minHeight?: number }).minHeight
      ).toBeUndefined();
      expect(count()).toBe(3);
    }
  );

  it("retains the long-label shrink contract, count and callback without claiming native wrapping", async () => {
    const onLongPress = jest.fn();
    const item = {
      ...inboxRow,
      title: "Sehr langer Quellenname ohne verlorene Wörter oder Aktion",
      onLongPress
    };
    await render(item);
    const label = renderedTexts()[0];
    expect(label.props.children).toBe(item.title);
    expect(label.props.numberOfLines).toBeUndefined();
    expect(fontStyle(0).flexShrink).toBe(1);
    if (!tree) throw new Error("Missing rendered MenuItem");
    expect(tree.root.findByType("View" as never).props.style.flexShrink).toBe(
      1
    );
    expect(fontStyle(1).flexShrink).toBe(0);
    expect((pressable().style as { height?: number }).height).toBeUndefined();
    act(() => (pressable().onLongPress as () => void)());
    expect(onLongPress).toHaveBeenCalledWith(item);
    expect(value()).toEqual({ text: "7" });
  });
});
