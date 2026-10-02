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

import { EVENTS, Task, TaskFavorite, TaskList } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import React from "react";
import { AppState } from "react-native";
import { db } from "../common/database";
import type { NavigationProps } from "../services/navigation";
import { useSettingStore } from "../stores/use-setting-store";
import type { SystemColorName } from "../utils/ios-system-colors";

export type TaskSmartListId =
  | "today"
  | "scheduled"
  | "all"
  | "flagged"
  | "completed";

export type TaskSmartList = {
  id: TaskSmartListId;
  symbol: string;
  color: SystemColorName;
  label: () => string;
};

/**
 * Reminders-style smart lists: one colored circle each, found without reading.
 *
 * Shared by the Tasks screen (the iPhone/iPad tiles, the Mac favourites
 * overview) and Mac's source list (components/mac-sidebar.tsx), so the labels,
 * the colors and the database queries that feed their counts live in one place
 * only - the sidebar does not re-implement the Tasks screen's queries.
 */
export const TASK_SMART_LISTS: TaskSmartList[] = [
  {
    id: "today",
    symbol: "calendar",
    color: "blue",
    label: strings.tasksToday
  },
  {
    id: "scheduled",
    symbol: "calendar",
    color: "red",
    label: strings.tasksScheduled
  },
  { id: "all", symbol: "tray.fill", color: "darkGray", label: strings.tasksAll },
  {
    id: "flagged",
    symbol: "flag.fill",
    color: "orange",
    label: strings.tasksFlagged
  },
  {
    id: "completed",
    symbol: "checkmark",
    color: "gray",
    label: strings.tasksCompleted
  }
];

/** "Completed" is a filter of every list, not a tile of its own. */
export const TILE_SMART_LISTS = new Set<TaskSmartListId>([
  "today",
  "scheduled",
  "all",
  "flagged"
]);

/** The definition of one smart list, by id. */
export function taskSmartList(id: TaskSmartListId) {
  return TASK_SMART_LISTS.find((item) => item.id === id);
}

const EMPTY_SMART_LISTS: Record<TaskSmartListId, Task[]> = {
  today: [],
  scheduled: [],
  all: [],
  flagged: [],
  completed: []
};

export type TaskSmartListsData = {
  lists: TaskList[];
  allTasks: Task[];
  favorites: TaskFavorite[];
  defaultListId?: string;
  /** The raw Tasks of each smart list (selection-independent). */
  smartLists: Record<TaskSmartListId, Task[]>;
  /** Smart-list counts, ready for a sidebar row or a tile. */
  counts: Record<TaskSmartListId, number>;
  /** Open (not completed) Task count per Task List id. */
  listCounts: Record<string, number>;
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
};

/**
 * The data behind the Tasks screen and Mac's task source list: the Task Lists,
 * every Task, the favourites, the default List and the smart lists with their
 * counts.
 *
 * The screen keeps its selection-dependent filtering (see screens/tasks), but
 * the queries themselves and the subscriptions that keep them fresh live here
 * so Mac's sidebar (components/mac-sidebar.tsx) reuses them instead of
 * duplicating them. Mac's sidebar is not a navigation screen, so `navigation`
 * is optional: it is only passed where there is a route to listen to.
 */
export function useTaskSmartLists(
  navigation?: NavigationProps<"Tasks">["navigation"]
): TaskSmartListsData {
  const [lists, setLists] = React.useState<TaskList[]>([]);
  const [allTasks, setAllTasks] = React.useState<Task[]>([]);
  const [favorites, setFavorites] = React.useState<TaskFavorite[]>([]);
  const [defaultListId, setDefaultListId] = React.useState<string>();
  const [smartLists, setSmartLists] =
    React.useState<Record<TaskSmartListId, Task[]>>(EMPTY_SMART_LISTS);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const refreshGeneration = React.useRef(0);
  const isAppLoading = useSettingStore((state) => state.isAppLoading);

  const refresh = React.useCallback(async () => {
    if (!db.isInitialized) return;
    const generation = ++refreshGeneration.current;
    try {
      const [
        taskLists,
        allTasks,
        today,
        scheduled,
        all,
        flagged,
        completed,
        favoriteRefs
      ] = await Promise.all([
        db.taskLists.list(),
        db.tasks.list(),
        db.tasks.smartList("today"),
        db.tasks.smartList("scheduled"),
        db.tasks.smartList("all"),
        db.tasks.smartList("flagged"),
        db.tasks.smartList("completed"),
        db.taskFavorites.list()
      ]);
      const defaultList = await db.taskLists.default();
      if (generation !== refreshGeneration.current) return;
      setLists(taskLists);
      setAllTasks(allTasks);
      setFavorites(favoriteRefs);
      setDefaultListId(defaultList.id);
      setSmartLists({ today, scheduled, all, flagged, completed });
      setError(false);
    } catch {
      if (generation !== refreshGeneration.current) return;
      setError(true);
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const generationRef = refreshGeneration;
    refresh();
    const focus = navigation?.addListener("focus", refresh);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const clock = setInterval(refresh, 60_000);
    const update = db.eventManager.subscribe(
      EVENTS.databaseUpdated,
      (event) => {
        if (event.collection === "settings" || event.collection === "reminders")
          refresh();
      }
    );
    const sync = db.eventManager.subscribe(EVENTS.syncCompleted, refresh);
    return () => {
      generationRef.current++;
      focus?.();
      appState.remove();
      clearInterval(clock);
      update.unsubscribe();
      sync.unsubscribe();
    };
  }, [navigation, refresh, isAppLoading]);

  const counts = React.useMemo<Record<TaskSmartListId, number>>(
    () => ({
      today: smartLists.today.length,
      scheduled: smartLists.scheduled.length,
      all: smartLists.all.length,
      flagged: smartLists.flagged.length,
      completed: smartLists.completed.length
    }),
    [smartLists]
  );

  const listCounts = React.useMemo(() => {
    const next: Record<string, number> = {};
    for (const task of allTasks) {
      if (task.completed) continue;
      next[task.listId] = (next[task.listId] || 0) + 1;
    }
    return next;
  }, [allTasks]);

  return {
    lists,
    allTasks,
    favorites,
    defaultListId,
    smartLists,
    counts,
    listCounts,
    loading,
    error,
    refresh
  };
}

export default useTaskSmartLists;
