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
import { groupAsHomeNotes } from "./use-notes-store";

/**
 * The Library "Inbox": active notes that are not filed in any notebook. It is
 * presented with the exact same renderer, sort and grouping as the notes list.
 */
const { useStore: useInboxStore, useCollection: useInboxNotes } =
  createDBCollectionStore({
    getCollection: () => groupAsHomeNotes(db.notes.unassigned),
    eagerlyFetchFirstBatch: true
  });

export { useInboxStore, useInboxNotes };
