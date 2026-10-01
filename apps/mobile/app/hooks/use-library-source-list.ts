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

import { EVENTS, Notebook, Tag } from "@notesnook/core";
import React from "react";
import { db } from "../common/database";
import type { NavigationProps } from "../services/navigation";
import { useSettingStore } from "../stores/use-setting-store";

export type LibrarySourceListData = {
  notebooks: Notebook[];
  tags: Tag[];
  counts: {
    allNotes?: number;
    inbox?: number;
    favorites?: number;
    archived?: number;
    trash?: number;
  };
};

/**
 * The data behind the Library's source list - the notebooks, the tags and the
 * All Notes / Inbox / Favorites / Archive / Trash counts.
 *
 * Shared by the Library screen (iPhone/iPad, where the source list is the
 * screen itself) and Mac's source list pane (components/mac-sidebar.tsx), so
 * the queries and the database subscriptions that keep them fresh live in one
 * place only. Mac's sidebar is not a navigation screen, so `navigation` is
 * optional: it is only passed where there is a route to listen to.
 */
export function useLibrarySourceList(
  navigation?: NavigationProps<"Library">["navigation"]
): LibrarySourceListData {
  const [notebooks, setNotebooks] = React.useState<Notebook[]>([]);
  const [tags, setTags] = React.useState<Tag[]>([]);
  const [counts, setCounts] = React.useState<{
    allNotes?: number;
    inbox?: number;
    favorites?: number;
    archived?: number;
    trash?: number;
  }>({});
  const isAppLoading = useSettingStore((state) => state.isAppLoading);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!db.isInitialized) return;
      const [
        nextNotebooks,
        nextTags,
        allNotesCount,
        inboxCount,
        favoritesCount,
        archivedCount
      ] = await Promise.all([
        db.notebooks.all.limit(2000).items(),
        db.tags.all.limit(2000).items(),
        db.notes.all.count(),
        db.notes.unassigned.count(),
        db.notes.favorites.count(),
        db.notes.archived.count()
      ]);
      // The Trash cache is kept in memory, so its count needs no query.
      const trashCount = db.trash.count();
      if (alive) {
        setNotebooks(nextNotebooks);
        setTags(nextTags);
        setCounts({
          allNotes: allNotesCount,
          inbox: inboxCount,
          favorites: favoritesCount,
          archived: archivedCount,
          trash: trashCount
        });
      }
    };
    void load();

    // The Library route has no entry in `Navigation.routeUpdateFunctions`, so
    // follow the database directly to keep the counts honest after a note is
    // created, deleted, archived, restored or (un)filed in a notebook.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    };
    const subscriptions = [
      db.eventManager.subscribe(EVENTS.databaseUpdated, (event) => {
        if (
          event?.collection === "notes" ||
          event?.collection === "notebooks" ||
          event?.collection === "relations" ||
          event?.collection === "tags"
        )
          schedule();
      }),
      db.eventManager.subscribe(EVENTS.syncCompleted, schedule)
    ];
    const unsubscribe = navigation?.addListener("focus", () => void load());
    return () => {
      alive = false;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      unsubscribe?.();
    };
  }, [navigation, isAppLoading]);

  return { notebooks, tags, counts };
}

export default useLibrarySourceList;
