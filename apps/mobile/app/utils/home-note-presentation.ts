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

import { getSortValue, GroupOptions, Note } from "@notesnook/core";
import { EntityLevel, decode } from "entities";

/** A list-only title: the stored title and editor content are never changed. */
export function homeNoteDisplayTitle(note: Note): string {
  if (!note.isGeneratedTitle || !note.headline) return note.title;
  const firstLine = headlineLines(note)[0];
  return firstLine?.slice(0, 140) || note.title;
}

export function homeNoteDisplaySnippet(note: Note): string {
  const lines = headlineLines(note);
  return (note.isGeneratedTitle ? lines.slice(1) : lines).join(" ");
}

function headlineLines(note: Note): string[] {
  if (!note.headline) return [];
  return decode(note.headline.replace(/<[^>]*>/g, " "), {
    level: EntityLevel.HTML
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Group only the home list's default date sort; other user groupings stay intact. */
export function homeNoteDateGroup(
  note: Note,
  options: GroupOptions,
  now = Date.now()
): string {
  if (note.pinned) return "Pinned";
  if (note.conflicted) return "Conflicted";

  const value = getSortValue(options, note);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Older";
  const current = new Date(now);
  const today = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate()
  );
  const yesterday = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() - 1
  );
  const sevenDaysAgo = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() - 6
  );

  if (date >= today) return capitalizeRelativeDay(0);
  if (date >= yesterday) return capitalizeRelativeDay(-1);
  if (date >= sevenDaysAgo) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric"
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric"
  }).format(date);
}

function capitalizeRelativeDay(offset: number): string {
  const label = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto"
  }).format(offset, "day");
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
}

/**
 * Routes that render the iOS home notes list: the retained internal Notes
 * route and the Library's "All Notes" and "Inbox" collections.
 */
const HOME_NOTE_ROUTES = ["Notes", "AllNotes", "Inbox"];

export function isHomeNoteRoute(route?: string | number): boolean {
  return typeof route === "string" && HOME_NOTE_ROUTES.includes(route);
}
