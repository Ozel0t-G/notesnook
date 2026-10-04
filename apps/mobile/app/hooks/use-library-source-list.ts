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
import { getTemplateCount } from "../services/templates";
import { useSettingStore } from "../stores/use-setting-store";
import { visibleTags } from "../utils/hidden-tags";

/** Max ids per notebook/tag count query (SQLite bound-parameter headroom). */
const COUNT_QUERY_CHUNK = 500;

export type LibrarySourceListData = {
  notebooks: Notebook[];
  tags: Tag[];
  counts: {
    allNotes?: number;
    inbox?: number;
    favorites?: number;
    archived?: number;
    templates?: number;
    trash?: number;
  };
  /**
   * Note count per notebook / tag. Requested by Mac's source list
   * (components/mac-sidebar.tsx) and by the iPhone/iPad Library screen
   * (screens/library/index.tsx), whose Notebooks and Tags rows show them; it is
   * opt-in, so callers that do not need them skip the extra query.
   */
  notebookCounts?: Record<string, number>;
  tagCounts?: Record<string, number>;
};

/**
 * The data behind the Library's source list - the notebooks, the tags and the
 * All Notes / Inbox / Favorites / Archive / Trash counts.
 *
 * Shared by the Library screen (iPhone/iPad, where the source list is the
 * screen itself) and Mac's source list pane (components/mac-sidebar.tsx), so
 * the queries and the database subscriptions that keep them fresh live in one
 * place only. Mac's sidebar is not a navigation screen, so `navigation` is
 * optional: it is only passed where there is a route to listen to. The
 * per-notebook / per-tag counts are opt-in for the same reason: only callers
 * whose rows render them ask for them.
 */
export function useLibrarySourceList(
  navigation?: NavigationProps<"Library">["navigation"],
  options?: { countsByNotebookAndTag?: boolean }
): LibrarySourceListData {
  const [notebooks, setNotebooks] = React.useState<Notebook[]>([]);
  const [tags, setTags] = React.useState<Tag[]>([]);
  const [counts, setCounts] = React.useState<{
    allNotes?: number;
    inbox?: number;
    favorites?: number;
    archived?: number;
    templates?: number;
    trash?: number;
  }>({});
  const [notebookCounts, setNotebookCounts] = React.useState<
    Record<string, number>
  >({});
  const [tagCounts, setTagCounts] = React.useState<Record<string, number>>({});
  const isAppLoading = useSettingStore((state) => state.isAppLoading);
  const countsByNotebookAndTag = !!options?.countsByNotebookAndTag;

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
        archivedCount,
        templatesCount
      ] = await Promise.all([
        db.notebooks.all.limit(2000).items(),
        visibleTags().limit(2000).items(),
        db.notes.all.count(),
        db.notes.unassigned.count(),
        db.notes.favorites.count(),
        db.notes.archived.count(),
        getTemplateCount()
      ]);
      // The Trash cache is kept in memory, so its count needs no query.
      const trashCount = db.trash.count();
      // Per-notebook / per-tag note counts are opt-in (the Library screen and
      // Mac's source list show them), so callers that do not ask for them skip
      // the query entirely.
      let nextNotebookCounts: Record<string, number> | undefined;
      let nextTagCounts: Record<string, number> | undefined;
      if (countsByNotebookAndTag) {
        // Chunked so an id list of up to `limit(2000)` items can never exceed
        // SQLite's bound-parameter limit.
        nextNotebookCounts = {};
        for (let i = 0; i < nextNotebooks.length; i += COUNT_QUERY_CHUNK) {
          const chunk = nextNotebooks.slice(i, i + COUNT_QUERY_CHUNK);
          const totals = await db.notebooks.totalNotes(
            ...chunk.map((notebook) => notebook.id)
          );
          chunk.forEach((notebook, index) => {
            nextNotebookCounts![notebook.id] = totals[index] || 0;
          });
        }
        nextTagCounts = {};
        for (let i = 0; i < nextTags.length; i += COUNT_QUERY_CHUNK) {
          const chunk = nextTags.slice(i, i + COUNT_QUERY_CHUNK);
          const relations = await db.relations
            .from({ ids: chunk.map((tag) => tag.id), type: "tag" }, "note")
            .get();
          for (const relation of relations) {
            nextTagCounts[relation.fromId] =
              (nextTagCounts[relation.fromId] || 0) + 1;
          }
        }
      }
      if (alive) {
        setNotebooks(nextNotebooks);
        setTags(nextTags);
        setCounts({
          allNotes: allNotesCount,
          inbox: inboxCount,
          favorites: favoritesCount,
          archived: archivedCount,
          templates: templatesCount,
          trash: trashCount
        });
        if (nextNotebookCounts && nextTagCounts) {
          setNotebookCounts(nextNotebookCounts);
          setTagCounts(nextTagCounts);
        }
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
  }, [navigation, isAppLoading, countsByNotebookAndTag]);

  return { notebooks, tags, counts, notebookCounts, tagCounts };
}

export default useLibrarySourceList;
