// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "@jest/globals";
import { useTabStore } from "./useTabStore";

describe("transient collection caption", () => {
  it("keeps the active caption in memory while preserving the persisted tab without its title", () => {
    const previous = useTabStore.getState();
    try {
      useTabStore.setState({
        currentTab: "qa-tab",
        tabs: [
          {
            id: "qa-tab",
            session: {
              id: "qa-session",
              noteId: "qa-note",
              spellCheckDisabled: false,
              origin: { id: "qa-book", title: "Synthetic collection caption" }
            }
          }
        ]
      });
      expect(useTabStore.getState().tabs[0].session?.origin?.title).toBe(
        "Synthetic collection caption"
      );
      const stored = JSON.parse(localStorage.getItem("tab-storage-v5")!);
      expect(stored.state.tabs[0].session.noteId).toBe("qa-note");
      expect(stored.state.tabs[0].session.id).toBe("qa-session");
      expect(stored.state.tabs[0].session.origin).toBeUndefined();
      expect(localStorage.getItem("tab-storage-v5")).not.toContain(
        "Synthetic collection caption"
      );
    } finally {
      useTabStore.setState(previous);
    }
  });
});
