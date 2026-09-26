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

import { db } from "../common/database";
import createDBCollectionStore from "./create-db-collection-store";
import { Platform } from "react-native";
import { homeNoteDateGroup } from "../utils/home-note-presentation";
import type { FilteredSelector, GroupOptions, Note } from "@notesnook/core";

/**
 * Group a notes selector the way the home list does it, so every screen built
 * on the home renderer shares the same sort, date grouping and counts.
 */
export function groupAsHomeNotes(notesSelector: FilteredSelector<Note>) {
  const options = db.settings.getGroupOptions("home");
  const useDateGroups =
    Platform.OS === "ios" &&
    options.groupBy === "default" &&
    (options.sortBy === "dateEdited" || options.sortBy === "dateCreated");
  const grouped = notesSelector.grouped as unknown as (
    options: GroupOptions,
    groupKeySelector?: (note: Note) => string
  ) => ReturnType<typeof notesSelector.grouped>;
  return grouped.call(
    notesSelector,
    options,
    useDateGroups ? (note: Note) => homeNoteDateGroup(note, options) : undefined
  );
}

const { useStore: useNoteStore, useCollection: useNotes } =
  createDBCollectionStore({
    getCollection: () => groupAsHomeNotes(db.notes.all),
    eagerlyFetchFirstBatch: true
  });

export { useNoteStore, useNotes };
