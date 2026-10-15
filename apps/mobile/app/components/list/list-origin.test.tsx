// SPDX-License-Identifier: GPL-3.0-or-later
/** Real list row wrappers and openNote. Only DB, native UI and peripheral stores
 * are doubled; origin must cross both wrappers and survive an awaited lookup. */
import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mockLookup = jest.fn(
  async (_id: string): Promise<any> => ({ id: "note-1", type: "note" })
);
const mockSend = jest.fn();
const mockSelect = jest.fn(() => false);
jest.mock("react-native", () => ({
  View: ({ children }: any) => children,
  Platform: { OS: "ios" }
}));
jest.mock("@notesnook/common", () => ({
  isNoteResolvedData: () => true,
  resolveItems: jest.fn()
}));
jest.mock("@notesnook/core", () => ({ getSortValue: () => 0 }));
jest.mock("../../common/database", () => ({
  db: {
    notes: { note: (id: string) => mockLookup(id) },
    content: { get: jest.fn() }
  }
}));
jest.mock("../../hooks/use-group-options", () => ({
  getGroupOptions: () => ({})
}));
jest.mock("../../hooks/use-is-compact-mode-enabled", () => ({
  useIsCompactModeEnabled: () => false
}));
jest.mock("../../services/event-manager", () => ({
  eSendEvent: (...args: unknown[]) => mockSend(...args),
  hideSheet: jest.fn(),
  presentSheet: jest.fn()
}));
jest.mock("../../services/device-detection", () => ({ DDS: { isTab: true } }));
jest.mock("../../utils/global-refs", () => ({
  fluidTabsRef: { current: null }
}));
jest.mock("../../utils/events", () => ({
  eOnLoadNote: "load-note",
  eShowMergeDialog: "merge-note"
}));
jest.mock("../../screens/editor/tiptap/use-tab-store", () => ({
  useTabStore: { getState: () => ({ hasTabForNote: () => true }) }
}));
jest.mock("../../screens/editor/tiptap/utils", () => ({
  editorController: { current: { commands: { setLoading: jest.fn() } } }
}));
jest.mock("../list-items/selection-wrapper", () => ({
  __esModule: true,
  default: (props: any) =>
    React.createElement("row", { onPress: props.onPress }, props.children),
  selectItem: () => mockSelect()
}));
jest.mock("../list-items/note", () => ({
  __esModule: true,
  default: () => null
}));
jest.mock("../note-history/preview", () => ({
  __esModule: true,
  default: () => null
}));
jest.mock("../list-items/headers/section-header", () => ({
  SectionHeader: () => null
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
import { ListItemWrapper } from "./list-item.wrapper";
import { openNote } from "../list-items/note/wrapper";
const note = { id: "note-1", type: "note", dateModified: 1 };
const items = {
  cacheItem: () => ({ item: note, data: {} }),
  item: async () => ({ item: note, data: {} })
};
let tree: ReactTestRenderer;
const props = {
  group: "dateEdited",
  items,
  isSheet: false,
  index: 0,
  groupOptions: {},
  dataType: "note",
  scrollRef: null
} as any;
beforeEach(() => {
  jest.useFakeTimers();
  mockSend.mockClear();
  mockSelect.mockReturnValue(false);
  mockLookup.mockReset().mockResolvedValue(note);
});
afterEach(() => {
  act(() => tree?.unmount());
  jest.useRealTimers();
});
it("carries the chosen collection through both real row wrappers and captures it before lookup", async () => {
  const origin = { id: "book-selected", title: "Selected collection" };
  let resolve!: (value: any) => void;
  mockLookup.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    })
  );
  act(() => {
    tree = create(<ListItemWrapper {...props} origin={origin} />);
  });
  let operation!: Promise<void>;
  act(() => {
    operation = tree.root.findByType("row" as any).props.onPress();
  });
  origin.title = "Changed while opening";
  await act(async () => {
    resolve(note);
    await operation;
  });
  expect(mockSend).toHaveBeenCalledWith("load-note", {
    item: note,
    origin: { id: "book-selected", title: "Selected collection" }
  });
});
it("refreshes a memoized row's origin when the same note is selected from another collection", async () => {
  act(() => {
    tree = create(
      <ListItemWrapper {...props} origin={{ id: "book-a", title: "A" }} />
    );
  });
  act(() => {
    tree.update(
      <ListItemWrapper {...props} origin={{ id: "book-b", title: "B" }} />
    );
  });
  await act(async () => {
    await tree.root.findByType("row" as any).props.onPress();
  });
  expect(mockSend).toHaveBeenCalledWith("load-note", {
    item: note,
    origin: { id: "book-b", title: "B" }
  });
});
it("explicitly clears collection context for a non-list entry", async () => {
  await openNote(note as any);
  expect(mockSend).toHaveBeenCalledWith("load-note", {
    item: note,
    origin: null
  });
});
it("preserves row selection without opening or replacing the editor context", async () => {
  mockSelect.mockReturnValue(true);
  act(() => {
    tree = create(
      <ListItemWrapper {...props} origin={{ id: "book-a", title: "A" }} />
    );
  });
  await act(async () => {
    await tree.root.findByType("row" as any).props.onPress();
  });
  expect(mockSend).not.toHaveBeenCalled();
});
