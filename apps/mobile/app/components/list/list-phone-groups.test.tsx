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
import { ListItemWrapper } from "./list-item.wrapper";
import { VirtualizedGrouping } from "@notesnook/core";

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
    },
    get isMacCatalyst() {
      return mockMac;
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
jest.mock("../../hooks/use-is-compact-mode-enabled", () => ({
  useIsCompactModeEnabled: () => mockCompact
}));
jest.mock("../../hooks/use-selected", () => ({
  __esModule: true,
  default: () => [mockSelected]
}));
jest.mock("../../screens/editor/tiptap/use-tab-store", () => ({
  useTabStore: (select: (state: unknown) => unknown) => select({ tabs: [] })
}));
jest.mock("../../stores/use-selection-store", () => {
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
jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: (select: (state: unknown) => unknown) =>
    select({ deviceMode: mockPad || mockMac ? "tablet" : "mobile" })
}));
jest.mock("../../stores/use-mac-system-store", () => ({
  useMacSystemStore: (select: (state: unknown) => unknown) =>
    select({ accent: "blue", active: true })
}));
jest.mock("../../utils/apple-visual-tokens", () => ({
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
jest.mock("../../utils/mac-system-state", () => ({
  macAccent: () => "#008844",
  macSelectionFill: () => ({ color: "#008844", opacity: 0.2 })
}));
jest.mock("../../utils/constants", () => ({ isMacCatalyst: () => mockMac }));
jest.mock("../../utils/mac-layout", () => ({ MAC_SOURCE_LIST_INSET: 10 }));
jest.mock("../../utils/mac-multi-select", () => ({
  macPointerModifiers: () => ({ cmd: false, shift: false }),
  handleMacModifierPress: jest.fn()
}));
jest.mock("../../utils/ios-system-colors", () => ({
  systemColor: (name: string) => name
}));
jest.mock("../../utils/functions", () => ({ deleteItems: jest.fn() }));
jest.mock("../../common/database", () => ({
  db: { notes: { pin: jest.fn(async () => undefined) } }
}));
jest.mock("../../services/navigation", () => ({
  __esModule: true,
  default: { navigate: jest.fn(), queueRoutesForUpdate: jest.fn() }
}));
// The row under test is real; only native/gesture/paint boundaries are hosts.
jest.mock("../ui/pressable", () => ({ Pressable: "Pressable" }));
jest.mock("../item-actions-menu", () => ({
  ItemContextMenu: "ItemContextMenu"
}));
jest.mock("../swipe-row", () => ({ SwipeRow: "SwipeRow" }));
jest.mock("../mac-hover", () => ({
  MacHoverHighlight: "MacHoverHighlight",
  macNoteRowHoverFill: () => ({}),
  useMacHover: () => ({ hovered: false, hoverProps: {} })
}));

jest.mock("@notesnook/core", () => ({
  VirtualizedGrouping: jest.requireActual(
    "../../../../../packages/core/src/utils/virtualized-grouping"
  ).VirtualizedGrouping,
  getSortValue: () => 1000
}));
jest.mock("@notesnook/common", () => ({
  isNoteResolvedData: (data: unknown) => !!data,
  resolveItems: async (_ids: string[], rows: unknown[]) =>
    rows.map(() => ({ attachments: { total: 0 } }))
}));
jest.mock("../../hooks/use-group-options", () => ({
  getGroupOptions: () => ({ sortBy: "dateEdited", sortDirection: "desc" })
}));
jest.mock("../../services/event-manager", () => ({
  eSendEvent: jest.fn(),
  hideSheet: jest.fn(),
  presentSheet: jest.fn()
}));
jest.mock("../../services/device-detection", () => ({ DDS: { isTab: false } }));
jest.mock("../../utils/events", () => ({
  eOpenJumpToDialog: "jump",
  eOnLoadNote: "load",
  eShowMergeDialog: "merge"
}));
jest.mock("../../utils/global-refs", () => ({
  fluidTabsRef: { current: null }
}));
jest.mock("../../screens/editor/tiptap/utils", () => ({
  editorController: { current: null }
}));
jest.mock("../note-history/preview", () => ({
  __esModule: true,
  default: () => null
}));
jest.mock("../list-items/note", () => ({
  __esModule: true,
  default: "NoteBody"
}));
jest.mock("../list-items/headers/section-header", () => ({
  SectionHeader: "SectionHeader"
}));
jest.mock("../list-items/notebook/wrapper", () => ({
  NotebookWrapper: () => null
}));
jest.mock("../list-items/reminder", () => ({
  __esModule: true,
  default: () => null
}));
jest.mock("../list-items/search-result", () => ({ SearchResult: () => null }));
jest.mock("../list-items/tag", () => ({
  __esModule: true,
  default: () => null
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
type TestNote = Note & { fixtureGroup: string };
function makeGrouping(
  starts: number[],
  length = 6,
  prefix = "row",
  delayedGroups?: Promise<
    { index: number; group: { type: "header"; id: string; title: string } }[]
  >,
  labels?: string[]
) {
  const rows = Array.from(
    { length },
    (_, index) =>
      ({
        id: `${prefix}-${index}`,
        type: "note",
        title: `Synthetic ${index}`,
        dateModified: 1,
        fixtureGroup:
          labels?.[starts.filter((start) => start <= index).length - 1] ||
          String(starts.filter((start) => start <= index).length - 1)
      } as TestNote)
  );
  const query = jest.fn(
    () =>
      delayedGroups ||
      Promise.resolve(
        starts.map((index) => ({
          index,
          group: {
            type: "header" as const,
            id: rows[index].fixtureGroup,
            title: rows[index].fixtureGroup
          }
        }))
      )
  );
  const fetch = jest.fn(async (start: number, end: number) => ({
    ids: rows.slice(start, end).map((row) => row.id),
    items: rows.slice(start, end)
  }));
  const items = new VirtualizedGrouping<Item>(
    length,
    2,
    async () => rows.map((row) => row.id),
    fetch,
    (batch) => {
      const groups = new Map();
      batch.forEach((row, index) => {
        const title = (row as TestNote).fixtureGroup;
        if (!index || title !== (batch[index - 1] as TestNote).fixtureGroup)
          groups.set(index, {
            index,
            group: { type: "header", id: title, title }
          });
      });
      return groups;
    },
    query
  );
  return { items, query, fetch, rows };
}

describe("real virtual grouping -> NoteWrapper -> SelectionWrapper Phone edges", () => {
  let tree: ReactTestRenderer;
  beforeEach(() => {
    jest.useFakeTimers();
    mockPad = mockMac = mockCompact = mockSelected = mockDark = false;
    mockOS = "ios";
    mockSelectionMode = undefined;
    jest.clearAllMocks();
  });
  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
  });
  const element = (
    items: VirtualizedGrouping<Item>,
    index: number,
    sheet = false,
    dataType = "note",
    groupBy: "default" | "none" = "default"
  ) => (
    <ListItemWrapper
      items={items}
      index={index}
      group="notes"
      groupOptions={{
        groupBy,
        sortBy: "dateEdited",
        sortDirection: "desc"
      }}
      dataType={dataType}
      isSheet={sheet}
      scrollRef={null}
    />
  );
  const settle = async () => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(110);
    });
  };
  const row = () => tree.root.findByType("Pressable" as never);
  const check = (first: boolean, last: boolean) => {
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
  };
  it.each([
    [0, true, true],
    [1, true, false],
    [2, false, false],
    [4, false, true],
    [5, true, true]
  ] as const)(
    "pins index %s first=%s last=%s across singleton/pinned and batch-spanning groups",
    async (index, first, last) => {
      const source = makeGrouping([0, 1, 5]);
      act(() => {
        tree = create(element(source.items, index));
      });
      await settle();
      check(first, last);
      expect(source.query).toHaveBeenCalledTimes(1);
      expect(tree.root.findAllByType("SwipeRow" as never)).toHaveLength(1);
      expect(
        tree.root.findByType("ItemContextMenu" as never).props.enabled
      ).toBe(true);
    }
  );
  it("shares one metadata query across rows and retains caps after cache eviction/recycling", async () => {
    const source = makeGrouping([0, 3]);
    act(() => {
      tree = create(
        <>
          {element(source.items, 0)}
          {element(source.items, 3)}
        </>
      );
    });
    await settle();
    expect(source.query).toHaveBeenCalledTimes(1);
    act(() => {
      tree.update(element(source.items, 5));
    });
    await settle();
    check(false, true);
    act(() => {
      tree.update(element(source.items, 2));
    });
    await settle();
    check(false, true);
    act(() => {
      tree.update(element(source.items, 0));
    });
    await settle();
    check(true, false);
    expect(source.query).toHaveBeenCalledTimes(1);
  });
  it("treats ungrouped notes as one rounded group and keeps a selected middle continuous", async () => {
    const source = makeGrouping([0]);
    mockSelectionMode = "note";
    mockSelected = true;
    act(() => {
      tree = create(element(source.items, 2, false, "note", "none"));
    });
    await settle();
    check(false, false);
    expect(row().props.customColor).toBe("selection");
    expect(tree.root.findByType("SwipeRow" as never).props.enabled).toBe(false);
    act(() => {
      tree.update(element(source.items, 5, false, "note", "none"));
    });
    await settle();
    check(false, true);
  });
  it("replaces a same-index source immediately and rejects late old group metadata", async () => {
    let complete!: (
      groups: {
        index: number;
        group: { type: "header"; id: string; title: string };
      }[]
    ) => void;
    const old = makeGrouping(
      [0, 1],
      2,
      "old",
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    const next = makeGrouping([0], 2, "new");
    act(() => {
      tree = create(element(old.items, 0));
    });
    await settle();
    act(() => {
      tree.update(element(next.items, 0));
    });
    await settle();
    check(true, false);
    expect(tree.root.findByType("NoteBody" as never).props.item.id).toBe(
      "new-0"
    );
    await act(async () => {
      complete([
        { index: 0, group: { type: "header", id: "0", title: "0" } },
        { index: 1, group: { type: "header", id: "1", title: "1" } }
      ]);
    });
    check(true, false);
    expect(tree.root.findByType("NoteBody" as never).props.item.id).toBe(
      "new-0"
    );
  });
  it("keeps Pinned separate from the ungrouped All notes block", async () => {
    const source = makeGrouping([0, 1], 3, "pin", undefined, ["Pinned", "All"]);
    act(() => {
      tree = create(element(source.items, 0, false, "note", "none"));
    });
    await settle();
    check(true, true);
    expect(
      tree.root.findByType("SectionHeader" as never).props.item.title
    ).toBe("Pinned");
    act(() => {
      tree.update(element(source.items, 1, false, "note", "none"));
    });
    await settle();
    check(true, false);
    const header = tree.root.findByType("SectionHeader" as never);
    expect(header.props.item.title).toBe("All");
    expect(header.props.groupOptions.groupBy).toBe("none");
    const send = require("../../services/event-manager").eSendEvent;
    send.mockClear();
    act(() => header.props.onOpenJumpToDialog());
    expect(send).toHaveBeenCalledWith("jump", {
      ref: null,
      data: source.items,
      viewOffset: 0
    });
  });
  it("does not let an older same-index row lookup replace a new source", async () => {
    const old = makeGrouping([0, 1], 2, "old");
    const next = makeGrouping([0], 2, "new");
    let complete!: (result: { ids: string[]; items: TestNote[] }) => void;
    old.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    act(() => {
      tree = create(element(old.items, 0));
    });
    await settle();
    act(() => {
      tree.update(element(next.items, 0));
    });
    await settle();
    expect(tree.root.findByType("NoteBody" as never).props.item.id).toBe(
      "new-0"
    );
    await act(async () => {
      complete({ ids: old.rows.map((row) => row.id), items: old.rows });
    });
    expect(tree.root.findByType("NoteBody" as never).props.item.id).toBe(
      "new-0"
    );
    check(true, false);
  });
  it("keeps readable rows on the prior flat fallback if group metadata fails", async () => {
    const source = makeGrouping([0]);
    source.query.mockRejectedValueOnce(new Error("synthetic metadata error"));
    act(() => {
      tree = create(element(source.items, 0));
    });
    await settle();
    expect(tree.root.findByType("NoteBody" as never).props.item.id).toBe(
      "row-0"
    );
    expect(row().props.style.borderTopLeftRadius).toBeUndefined();
    expect(
      tree.root.findAllByProps({ testID: "phone-note-separator" })
    ).toHaveLength(1);
  });
  it.each(["iPad", "Mac", "Android", "sheet", "trash"])(
    "leaves %s geometry and group-query behavior unchanged",
    async (kind) => {
      mockPad = kind === "iPad";
      mockMac = kind === "Mac";
      mockOS = kind === "Android" ? "android" : "ios";
      const source = makeGrouping([0]);
      act(() => {
        tree = create(
          element(
            source.items,
            0,
            kind === "sheet",
            kind === "trash" ? "trash" : "note"
          )
        );
      });
      await settle();
      expect(source.query).not.toHaveBeenCalled();
      expect(row().props.style.borderTopLeftRadius).toBeUndefined();
    }
  );
});
