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

import { strings } from "@notesnook/intl";
import { useEffect } from "react";
import { NativeModules } from "react-native";
import {
  AppleSection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";
import { isMacCatalyst } from "../utils/constants";
import {
  applyMacWindowTitle,
  useMacListTitleStore
} from "../utils/mac-window-title";

/**
 * Human name of each top-level section, for the window title (W4): the Library
 * and Search sections name themselves, the Task section is the fallback title
 * while no task list is selected (a selected list is the title itself, see
 * resolveMacWindowTitle). The names match the iPad tab bar and the Mac sidebar.
 */
const SECTION_TITLES: Record<AppleSection, () => string> = {
  library: () => strings.routes.Library(),
  tasks: () => strings.tasksTitle(),
  search: () => strings.routes.Search()
};

/**
 * The window subtitle of a task list: "4 tasks" / "1 task". The app's shared
 * strings only pluralise notes (strings.notes), and the intl package is outside
 * the Mac files' reach here, so the task line is pluralised locally; the count
 * itself comes from the Tasks screen (useTaskSmartLists).
 */
function taskCountLabel(count: number) {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

/**
 * The count line for the section's list, or an empty string when there is
 * nothing to count (the Search section has no list behind it, the count is not
 * known yet, or the section publishes no count at all). Notes use the app's own
 * pluralised string, so "1 note" / "12 notes" reads like the rest of the app.
 */
function countLabelFor(section: AppleSection, count?: number) {
  if (count === undefined || section === "search") return "";
  return section === "tasks" ? taskCountLabel(count) : strings.notes(count);
}

/**
 * Resolves the title from the parts several, otherwise unrelated panes own -
 * the section (useAppleNavigationStore) and the focused list's name and item
 * count (published by the list header through useMacListTitleStore) - and
 * pushes it to the native window. The title is always that list/section name,
 * so an open note never takes it over. Reads the stores outside React so it can
 * double as a zustand subscriber.
 */
function refreshMacWindowTitle() {
  const section = useAppleNavigationStore.getState().section;
  applyMacWindowTitle({
    section,
    sectionTitle: SECTION_TITLES[section](),
    listTitle: useMacListTitleStore.getState().listTitle,
    countLabel: countLabelFor(
      section,
      useMacListTitleStore.getState().listCount
    )
  });
}

/**
 * Keeps the Mac Catalyst window's title/subtitle in sync with what the window
 * shows (W4). Mounted once from app.tsx, next to useMacMenuCommands, and inert
 * on iPhone/iPad.
 */
export const useMacWindowTitle = () => {
  const enabled = isMacCatalyst();

  useEffect(() => {
    if (!enabled || !NativeModules?.VeyraNMacMenu) return;
    // The stores may already hold state by the time this mounts (a restored
    // session, a deep link): publish the title once up front, then follow every
    // change of its two inputs.
    refreshMacWindowTitle();
    const unsubscribers = [
      useAppleNavigationStore.subscribe(refreshMacWindowTitle),
      useMacListTitleStore.subscribe(refreshMacWindowTitle)
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [enabled]);
};

export default useMacWindowTitle;
