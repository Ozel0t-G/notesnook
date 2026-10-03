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

import { Note } from "@notesnook/core";
import { db } from "../common/database";
import { getTemplateTagId } from "../services/templates";
import createDBCollectionStore from "./create-db-collection-store";

/** Same null/0 boolean encoding as the core `isFalse` helper. */
function isFalse(eb: any, column: string) {
  return eb.or([eb(column, "is", null), eb(column, "==", 0)]);
}

const { useStore: useArchivedStore, useCollection: useArchived } =
  createDBCollectionStore({
    /**
     * Archive == `db.notes.archived` minus the note templates. A template is a
     * normal archived note marked with the internal "template" tag (see
     * services/templates), so without the exclusion every template would also
     * show up in Archive. The filter is only built when that tag exists to keep
     * the common (no templates) case on the plain `db.notes.archived` path.
     */
    getCollection: async () => {
      const templateTagId = await getTemplateTagId(false);
      if (templateTagId) {
        return db.notes.collection
          .createFilter<Note>(
            (qb) =>
              qb
                .where((eb: any) => isFalse(eb, "dateDeleted"))
                .where((eb: any) => isFalse(eb, "deleted"))
                .where("archived", "==", true)
                .where("id", "not in", (eb: any) =>
                  eb
                    .selectFrom("relations")
                    .select("toId")
                    .where("fromType", "==", "tag")
                    .where("fromId", "==", templateTagId)
                    .where("toType", "==", "note")
                ),
            db.options?.batchSize
          )
          .grouped(db.settings.getGroupOptions("archive"));
      }
      return db.notes.archived.grouped(db.settings.getGroupOptions("archive"));
    },
    eagerlyFetchFirstBatch: true
  });

export { useArchivedStore, useArchived };
