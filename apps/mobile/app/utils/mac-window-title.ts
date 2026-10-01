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

import { NativeModules } from "react-native";
import { create } from "zustand";

/**
 * The focused list's own title. Mac's window toolbar replaces the list column's
 * 44 pt nav bar, so the name that bar used to show has to come from somewhere:
 * the Library list header (components/header/index.tsx) publishes the focused
 * note list's name, the Tasks screen publishes the selected task list's label,
 * and hooks/use-mac-window-title.ts folds it into the window's title/subtitle.
 * Each publisher only clears the value it set, so the two never overwrite each
 * other's title. Undefined while there is no such list on screen.
 */
type MacListTitleState = {
  listTitle?: string;
  setListTitle: (listTitle?: string) => void;
};

export const useMacListTitleStore = create<MacListTitleState>((set) => ({
  listTitle: undefined,
  setListTitle: (listTitle) => set({ listTitle })
}));

/** What the window's title/subtitle describe (W4). */
export type MacWindowTitle = {
  title: string;
  subtitle: string;
};

/**
 * The window title of the Mac Catalyst window, derived from the state the
 * window shows:
 *
 * - the Task section shows the selected task list ("Today", a List's name) as
 *   the title with "Tasks" as the subtitle, and names itself when no list is
 *   selected (the listTitle it publishes is guarded against a stale Library
 *   list, see the Tasks screen and components/header/index.tsx);
 * - the Search section names itself (the list behind it keeps its own title,
 *   but it is not what the window shows);
 * - with a note open in the editor, the note is the title and the list it
 *   came from is the subtitle, like Notes shows the note and its folder;
 * - otherwise the focused list names the window.
 *
 * Returns undefined when there is nothing meaningful to show, so the caller
 * leaves the last title alone instead of blanking the window.
 */
export function resolveMacWindowTitle({
  section,
  sectionTitle,
  listTitle,
  noteTitle
}: {
  section: "library" | "tasks" | "search";
  sectionTitle: string;
  listTitle?: string;
  noteTitle?: string;
}): MacWindowTitle | undefined {
  if (section === "tasks") {
    // The Tasks screen publishes the selected task list; the window says which
    // one it is and falls back to the section name without a selection.
    if (listTitle) return { title: listTitle, subtitle: sectionTitle };
    return sectionTitle ? { title: sectionTitle, subtitle: "" } : undefined;
  }
  if (section !== "library") {
    return sectionTitle ? { title: sectionTitle, subtitle: "" } : undefined;
  }
  if (noteTitle) {
    return { title: noteTitle, subtitle: listTitle || "" };
  }
  if (listTitle) return { title: listTitle, subtitle: "" };
  return undefined;
}

/**
 * Pushes title/subtitle to the native window (VeyraNMacMenu.setWindowTitle).
 * A no-op when the bridge is not linked, so the util is safe to call on any
 * platform.
 */
export function setMacWindowTitle(title: string, subtitle = "") {
  NativeModules?.VeyraNMacMenu?.setWindowTitle?.(title, subtitle);
}

/**
 * Resolves and pushes the title in one step; returns false (and calls
 * nothing) when there is no title to show.
 */
export function applyMacWindowTitle(options: {
  section: "library" | "tasks" | "search";
  sectionTitle: string;
  listTitle?: string;
  noteTitle?: string;
}) {
  const resolved = resolveMacWindowTitle(options);
  if (!resolved) return false;
  setMacWindowTitle(resolved.title, resolved.subtitle);
  return true;
}
