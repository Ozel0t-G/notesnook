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

import { Tag } from "@notesnook/core";
import { db } from "../common/database";
import { TEMPLATE_TAG } from "../services/templates";

/**
 * The `template` tag is an implementation detail of Note Templates: it is what
 * marks a note as a template, not something the user should see, search or
 * assign in any tag list. The app's tag lists ask here instead of `db.tags.all`
 * so exactly one place decides what a user-visible tag is.
 */

/** Same null/0 boolean encoding as `db.tags.all` uses for `deleted`. */
function isFalse(eb: any, column: string) {
  return eb.or([eb(column, "is", null), eb(column, "==", 0)]);
}

export function isHiddenTag(tag: { title?: string }): boolean {
  return tag.title === TEMPLATE_TAG;
}

export function filterHiddenTags<T extends { title?: string }>(tags: T[]): T[] {
  return tags.filter((tag) => !isHiddenTag(tag));
}

/**
 * `db.tags.all` with the internal template tag removed. Kept as a drop-in for
 * `db.tags.all` (the same `FilteredSelector<Tag>` methods) so the tag store and
 * the manage-tags screen can swap it in without changing their shape.
 */
export function visibleTags() {
  return db.tags.collection.createFilter<Tag>(
    (qb) =>
      qb
        .where((eb: any) => isFalse(eb, "deleted"))
        .where("title", "!=", TEMPLATE_TAG),
    db.options?.batchSize
  );
}
