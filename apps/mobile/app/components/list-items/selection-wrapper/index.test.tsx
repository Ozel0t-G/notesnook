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
import { act, create, ReactTestRenderer } from "react-test-renderer";
import type { Item, Note } from "@notesnook/core";
import SelectionWrapper from "./index";

let mockPad = false;
let mockMac = false;
let mockOS = "ios";
let mockCompact = false;
let mockSelected = false;
let mockSelectionMode: string | undefined;
let mockDark = false;
const mockSetMode = jest.fn();
const mockSetSelected = jest.fn();

jest.mock("react-native", () => ({
  View: "View",
  Platform: {
    get OS() {
      return mockOS;
    },
    get isPad() {
      return mockPad;
    }
  }
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: { primary: { accent: "#008844" }, selected: { accent: "#008844" } },
    isDark: mockDark
  })
}));
jest.mock("@notesnook/intl", () => ({
  strings: {
    pin: () => "Pin",
    unpin: () => "Unpin",
    delete: () => "Delete",
    dataTypesPluralCamelCase: { notebook: () => "Notebooks" }
  }
}));
jest.mock("../../../hooks/use-is-compact-mode-enabled", () => ({
  useIsCompactModeEnabled: () => mockCompact
}));
jest.mock("../../../hooks/use-selected", () => ({
  __esModule: true,
  default: () => [mockSelected]
}));
jest.mock("../../../screens/editor/tiptap/use-tab-store", () => ({
  useTabStore: (select: (state: unknown) => unknown) => select({ tabs: [] })
}));
jest.mock("../../../stores/use-selection-store", () => {
  const state = () => ({
    selectionMode: mockSelectionMode,
    selectedItemsList: ["note"],
    setSelectionMode: mockSetMode,
    setSelectedItem: mockSetSelected
  });
  return {
    useSelectionStore: Object.assign(
      (select: (state: unknown) => unknown) => select(state()),
      {
        getState: state
      }
    )
  };
});
jest.mock("../../../stores/use-setting-store", () => ({
  useSettingStore: (select: (state: unknown) => unknown) =>
    select({ deviceMode: mockPad || mockMac ? "tablet" : "mobile" })
}));
jest.mock("../../../stores/use-mac-system-store", () => ({
  useMacSystemStore: (select: (state: unknown) => unknown) =>
    select({ accent: "blue", active: true })
}));
jest.mock("../../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: mockOS === "ios",
    rowInset: 18,
    listInset: 16,
    rowPadding: 16,
    contentSurface: mockDark ? "dark-content" : "light-content",
    separator: mockDark ? "dark-separator" : "light-separator",
    selectionBackground: "selection",
    controlRadius: 16
  })
}));
jest.mock("../../../utils/mac-system-state", () => ({
  macAccent: () => "#008844",
  macSelectionFill: () => ({ color: "#008844", opacity: 0.2 })
}));
jest.mock("../../../utils/constants", () => ({ isMacCatalyst: () => mockMac }));
jest.mock("../../../utils/mac-layout", () => ({ MAC_SOURCE_LIST_INSET: 10 }));
jest.mock("../../../utils/mac-multi-select", () => ({
  macPointerModifiers: () => ({ cmd: false, shift: false }),
  handleMacModifierPress: jest.fn()
}));
jest.mock("../../../utils/ios-system-colors", () => ({
  systemColor: (name: string) => name
}));
jest.mock("../../../utils/functions", () => ({ deleteItems: jest.fn() }));
jest.mock("../../../common/database", () => ({
  db: { notes: { pin: jest.fn(async () => undefined) } }
}));
jest.mock("../../../services/navigation", () => ({
  __esModule: true,
  default: { navigate: jest.fn(), queueRoutesForUpdate: jest.fn() }
}));
// The row under test is real; only native/gesture/paint boundaries are hosts.
jest.mock("../../ui/pressable", () => ({ Pressable: "Pressable" }));
jest.mock("../../item-actions-menu", () => ({
  ItemContextMenu: "ItemContextMenu"
}));
jest.mock("../../swipe-row", () => ({ SwipeRow: "SwipeRow" }));
jest.mock("../../mac-hover", () => ({
  MacHoverHighlight: "MacHoverHighlight",
  macNoteRowHoverFill: () => ({}),
  useMacHover: () => ({ hovered: false, hoverProps: {} })
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const note = { id: "synthetic-note", type: "note", title: "Synthetic" } as Note;

describe("rendered phone row actions and platform exclusions", () => {
  let tree: ReactTestRenderer;
  beforeEach(() => {
    mockPad = mockMac = mockCompact = mockSelected = mockDark = false;
    mockOS = "ios";
    mockSelectionMode = undefined;
    jest.clearAllMocks();
  });
  afterEach(() => act(() => tree?.unmount()));
  const render = (
    props: Partial<React.ComponentProps<typeof SelectionWrapper>> = {}
  ) =>
    act(() => {
      tree = create(
        <SelectionWrapper item={note} onPress={jest.fn()} {...props}>
          <React.Fragment>Title</React.Fragment>
        </SelectionWrapper>
      );
    });
  const row = () => tree.root.findByType("Pressable" as never);

  it.each([false, true])(
    "insets a semantic separator without intercepting touch in dark=%s",
    (dark) => {
      mockDark = dark;
      mockCompact = true;
      render();
      expect(row().props.style).toMatchObject({
        minHeight: 44,
        borderBottomWidth: 0,
        marginBottom: 0
      });
      expect(row().props.accessibilityRole).toBe("button");
      expect(row().props.customColor).toBe(
        dark ? "dark-content" : "light-content"
      );
      const separator = tree.root.findByProps({
        testID: "phone-note-separator"
      });
      expect(separator.props.pointerEvents).toBe("none");
      expect(separator.props.style).toMatchObject({
        left: 18,
        right: 0,
        backgroundColor: dark ? "dark-separator" : "light-separator"
      });
    }
  );
  it.each([
    [true, false],
    [false, false],
    [false, true],
    [true, true]
  ])(
    "rounds only group edges first=%s last=%s and removes final separators",
    (first, last) => {
      mockSelected = true;
      mockSelectionMode = "note";
      render({ groupEdges: { first, last } });
      expect(row().props.style).toMatchObject({
        borderRadius: 0,
        borderTopLeftRadius: first ? 16 : 0,
        borderTopRightRadius: first ? 16 : 0,
        borderBottomLeftRadius: last ? 16 : 0,
        borderBottomRightRadius: last ? 16 : 0
      });
      expect(
        tree.root.findAllByProps({ testID: "phone-note-separator" })
      ).toHaveLength(last ? 0 : 1);
      expect(row().props.accessibilityState).toEqual({ selected: true });
    }
  );
  it("preserves opening, native context and real pin/notebook/delete callback wiring", async () => {
    const open = jest.fn();
    render({ onPress: open });
    act(() => row().props.onPress());
    expect(open).toHaveBeenCalledTimes(1);
    expect(row().props.onLongPress).toBeUndefined();
    expect(
      tree.root.findByType("ItemContextMenu" as never).props
    ).toMatchObject({ enabled: true, item: note });
    const swipe = tree.root.findByType("SwipeRow" as never);
    expect(swipe.props.enabled).toBe(true);
    await act(async () => swipe.props.leading[0].onPress());
    const { db } = require("../../../common/database");
    const nav = require("../../../services/navigation").default;
    expect(db.notes.pin).toHaveBeenCalledWith(true, note.id);
    expect(nav.queueRoutesForUpdate).toHaveBeenCalledTimes(1);
    act(() => swipe.props.trailing[1].onPress());
    expect(nav.navigate).toHaveBeenCalledWith("LinkNotebooks", {
      noteIds: [note.id]
    });
    act(() => swipe.props.trailing[0].onPress());
    expect(
      require("../../../utils/functions").deleteItems
    ).toHaveBeenCalledWith("note", [note.id]);
  });
  it("announces batch selection and disables context/swipe while keeping selection long press", () => {
    mockSelectionMode = "note";
    mockSelected = true;
    render();
    expect(row().props.accessibilityState).toEqual({ selected: true });
    expect(row().props.customColor).toBe("selection");
    expect(tree.root.findByType("ItemContextMenu" as never).props.enabled).toBe(
      false
    );
    expect(tree.root.findByType("SwipeRow" as never).props.enabled).toBe(false);
    act(() => row().props.onLongPress());
    expect(mockSetSelected).toHaveBeenCalledWith(note.id);
    mockSelected = false;
    act(() => tree.unmount());
    render();
    expect(row().props.accessibilityState).toEqual({ selected: false });
  });
  it.each(["iPad", "Mac", "Android", "sheet", "trash", "notebook"])(
    "keeps %s out of phone layout and accessibility changes",
    (kind) => {
      mockPad = kind === "iPad";
      mockMac = kind === "Mac";
      mockOS = kind === "Android" ? "android" : "ios";
      render({
        isSheet: kind === "sheet",
        item:
          kind === "trash"
            ? ({ ...note, type: "trash", itemType: "note" } as unknown as Item)
            : kind === "notebook"
            ? ({ ...note, type: "notebook" } as unknown as Item)
            : note
      });
      expect(
        tree.root.findAllByProps({ testID: "phone-note-separator" })
      ).toHaveLength(0);
      expect(row().props.style.minHeight).toBeUndefined();
      expect(row().props.accessibilityRole).toBeUndefined();
      if (kind === "iPad")
        expect(row().props.style.borderBottomWidth).toBe(0.5);
      if (kind === "Mac") {
        expect(row().props.style).toMatchObject({
          paddingHorizontal: 8,
          paddingVertical: 10,
          marginBottom: 4,
          borderRadius: 12
        });
        expect(tree.root.findAllByType("SwipeRow" as never)).toHaveLength(0);
      }
    }
  );
});
