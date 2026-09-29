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

import type { Note } from "@notesnook/core";
import { db, DatabaseLogger } from "../common/database";
import { MMKV } from "../common/database/mmkv";
import { homeNoteDisplayTitle } from "../utils/home-note-presentation";

/** The upstream default that produced titles like "Note 29-09-2026 01:00 PM". */
export const LEGACY_TITLE_FORMAT = "Note $date$ $time$";
/** Apple Notes behaviour: the first line of the note is its title. */
export const HEADLINE_TITLE_FORMAT = "$headline$";
const MIGRATION_KEY = "veyran.noteTitles.firstLine.v1";

/**
 * Titles that were generated from the date become the note's first line, so
 * the list, the editor and search all show the same title. Titles the user
 * typed (`isGeneratedTitle` false) are never touched, and neither is the
 * modification date.
 */
export function generatedTitleUpdate(
  note: Pick<Note, "title" | "headline" | "isGeneratedTitle">
): string | undefined {
  if (!note.isGeneratedTitle || !note.headline) return undefined;
  const next = homeNoteDisplayTitle(note as Note);
  return next && next !== note.title ? next : undefined;
}

export async function migrateGeneratedNoteTitles() {
  try {
    if (MMKV.getString(MIGRATION_KEY) === "done") return;
    if (db.settings.getTitleFormat() === LEGACY_TITLE_FORMAT)
      await db.settings.setTitleFormat(HEADLINE_TITLE_FORMAT);
    if (!db.settings.getTitleFormat().includes(HEADLINE_TITLE_FORMAT)) {
      MMKV.setString(MIGRATION_KEY, "done");
      return;
    }
    const notes = await db
      .sql()
      .selectFrom("notes")
      .select(["id", "title", "headline", "isGeneratedTitle"])
      .where("isGeneratedTitle", "==", true)
      .where("type", "==", "note")
      .execute();
    for (const note of notes) {
      const title = generatedTitleUpdate(note as unknown as Note);
      if (!title) continue;
      await db.notes.collection.update(
        [note.id],
        { title, isGeneratedTitle: true },
        { modify: false, sendEvent: false }
      );
    }
    MMKV.setString(MIGRATION_KEY, "done");
  } catch (error) {
    DatabaseLogger.error(error as Error, "Migrate generated note titles");
  }
}
