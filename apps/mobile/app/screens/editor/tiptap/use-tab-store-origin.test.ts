// SPDX-License-Identifier: GPL-3.0-or-later
/** Actual native tab/session storage paths; only MMKV and peripheral edges are
 * doubled. This is persistence/routing evidence, not a crypto test. */
const mockMaps = new Map<string, unknown>();
const mockStorage = new Map<string, string>();
const mockSetMap = jest.fn((id: string, value: unknown) =>
  mockMaps.set(id, value)
);
const mockSend = jest.fn();
jest.mock("@notesnook/core", () => ({ getId: () => "synthetic-session" }));
jest.mock("@notesnook/common", () => ({
  TabSessionHistory: jest.requireActual(
    "../../../../../../packages/common/src/utils/tab-session-history"
  ).TabSessionHistory
}));
jest.mock("react-native-mmkv-storage", () => ({
  MMKVLoader: class {
    withInstanceID() {
      return this;
    }
    disableIndexing() {
      return this;
    }
    initialize() {
      return {
        getMap: (id: string) => mockMaps.get(id),
        setMap: mockSetMap,
        removeItem: (id: string) => mockMaps.delete(id),
        clearStore: () => mockMaps.clear()
      };
    }
  }
}));
jest.mock("../../../common/database/mmkv", () => ({
  MMKV: {
    getItem: (key: string) => mockStorage.get(key) ?? null,
    setItem: (key: string, value: string) => mockStorage.set(key, value),
    removeItem: (key: string) => mockStorage.delete(key)
  }
}));
jest.mock("../../../common/database", () => ({
  db: {
    notes: { note: async (id: string) => ({ id }) },
    vaults: { itemExists: async () => false }
  }
}));
jest.mock("../../../services/event-manager", () => ({
  eSendEvent: (...args: unknown[]) => mockSend(...args)
}));
jest.mock("../../../utils/events", () => ({ eOnLoadNote: "load-note" }));
jest.mock("./utils", () => ({
  editorController: { current: { commands: { doAsync: jest.fn() } } }
}));
import { resetTabStore, useTabStore } from "./use-tab-store";
beforeEach(() => {
  resetTabStore();
  mockMaps.clear();
  mockSetMap.mockClear();
  mockSend.mockClear();
});
it("keeps the collection in memory while both native persistent stores omit its title", () => {
  const state = useTabStore.getState();
  const tabId = state.currentTab;
  state.updateTab(tabId, {
    session: {
      noteId: "qa-note",
      origin: { id: "qa-book", title: "Synthetic caption" },
      scrollTop: 47
    }
  });
  const session = useTabStore.getState().getTab(tabId)!.session!;
  expect(session.origin?.title).toBe("Synthetic caption");
  expect(mockMaps.get(session.id!)).toEqual(
    expect.objectContaining({ noteId: "qa-note", scrollTop: 47 })
  );
  expect(mockMaps.get(session.id!)).not.toHaveProperty("origin");
  expect(mockStorage.get("tabs-storage-v5")).not.toContain("Synthetic caption");
  expect(mockStorage.get("tabs-storage-v5")).toContain("qa-note");
});
it("preserves in-memory origin during ordinary session updates and explicitly clears it for a different entry", () => {
  const state = useTabStore.getState();
  const tabId = state.currentTab;
  state.updateTab(tabId, {
    session: {
      noteId: "qa-note",
      origin: { id: "qa-book", title: "Synthetic caption" }
    }
  });
  state.updateTab(tabId, { session: { scrollTop: 92 } });
  expect(useTabStore.getState().getTab(tabId)?.session?.origin?.title).toBe(
    "Synthetic caption"
  );
  state.updateTab(tabId, { session: { origin: null } });
  expect(useTabStore.getState().getTab(tabId)?.session?.origin).toBeNull();
});
it("passes the history session's own in-memory origin to the normal note loader", async () => {
  const state = useTabStore.getState();
  const tabId = state.currentTab;
  state.updateTab(tabId, {
    session: {
      noteId: "qa-note",
      origin: { id: "qa-book", title: "Synthetic caption" }
    }
  });
  const sessionId = useTabStore.getState().getTab(tabId)!.session!.id!;
  expect(await state.loadSession(sessionId)).toBe(true);
  expect(mockSend).toHaveBeenCalledWith(
    "load-note",
    expect.objectContaining({
      session: expect.objectContaining({
        origin: { id: "qa-book", title: "Synthetic caption" }
      })
    })
  );
});
it("keeps the newly selected collection when reusing a history session and then updating the caret", () => {
  const state = useTabStore.getState();
  const tabId = state.currentTab;
  state.updateTab(tabId, {
    session: {
      noteId: "qa-note-a",
      origin: { id: "book-a", title: "Old collection" }
    }
  });
  state.newTabSession(tabId, {
    noteId: "qa-note-b",
    origin: { id: "book-b", title: "Other collection" }
  });
  state.newTabSession(tabId, {
    noteId: "qa-note-a",
    origin: { id: "book-c", title: "New selected collection" }
  });
  expect(useTabStore.getState().getTab(tabId)?.session?.origin?.title).toBe(
    "New selected collection"
  );
  state.updateTab(tabId, {
    session: { scrollTop: 321, selection: { from: 2, to: 8 } }
  });
  expect(useTabStore.getState().getTab(tabId)?.session?.origin?.title).toBe(
    "New selected collection"
  );
});
