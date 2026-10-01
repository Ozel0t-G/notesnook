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

import { create } from "zustand";
import { MMKV } from "../common/database/mmkv";
import {
  addRecentSearch,
  sanitizeRecentSearches
} from "../screens/global-search/search-recents";

/** MMKV key the Search section's recent terms are persisted under. */
const RECENT_SEARCHES_KEY = "globalSearchRecents";

function loadRecentSearches(): string[] {
  try {
    return sanitizeRecentSearches(MMKV.getArray<string>(RECENT_SEARCHES_KEY));
  } catch {
    // Recents are a convenience: a missing or unreadable entry must not keep
    // the Search section from rendering.
    return [];
  }
}

export type GlobalSearchState = {
  /**
   * The Search section's query. It lives outside the screen because the Mac
   * window toolbar's search field is the query's real input there: the field
   * is part of the window chrome, not of any React tree, so the toolbar's
   * "search"/"searchSubmit" commands write it here (see
   * hooks/use-mac-menu-commands.ts) and the screen reads it back.
   *
   * The screen keeps working on iPhone and iPad too, where it is the only
   * writer; nothing clears it when another section takes over, so the query
   * is still there when the Search section comes back.
   */
  query: string;
  /**
   * Bumped by Return in the Mac toolbar's search field. The screen watches it
   * so Return runs the current query at once instead of waiting out the
   * typing debounce.
   */
  submitToken: number;
  /**
   * The Mac Search section's recent terms, newest first (max
   * MAX_RECENT_SEARCHES). Only the Mac empty state shows them; they are
   * recorded by the screen when a search runs.
   */
  recentQueries: string[];
  setQuery: (query: string) => void;
  submitQuery: () => void;
  addRecentQuery: (query: string) => void;
};

export const useGlobalSearchStore = create<GlobalSearchState>((set) => ({
  query: "",
  submitToken: 0,
  recentQueries: loadRecentSearches(),
  setQuery: (query) => set({ query }),
  submitQuery: () => set((state) => ({ submitToken: state.submitToken + 1 })),
  addRecentQuery: (query) =>
    set((state) => {
      const recentQueries = addRecentSearch(state.recentQueries, query);
      // An empty query does not change the list (same reference): skip both
      // the state update and the write.
      if (recentQueries === state.recentQueries) return state;
      try {
        MMKV.setArray(RECENT_SEARCHES_KEY, recentQueries);
      } catch {
        // Failing to persist a convenience list is not fatal.
      }
      return { recentQueries };
    })
}));
