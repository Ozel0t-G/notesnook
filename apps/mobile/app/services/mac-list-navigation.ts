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
import type { NavigationProps } from "./navigation";
import useNavigationStore, { RouteName } from "../stores/use-navigation-store";
import { useAppleNavigationStore } from "../stores/use-apple-navigation-store";

/**
 * Bridge between Mac's sidebar and the note-list stack in the middle column.
 *
 * The sidebar is a pane of its own, next to (not inside) the `AppNavigation`
 * stack, so it cannot reach that stack's `navigation` object through
 * `useNavigation()` (which would resolve to the root navigator). Every screen
 * of that stack publishes its own `navigation` object here (see
 * `withMacListNavigation` in navigation/navigation-stack.tsx) - any of them
 * drives the same stack - and the sidebar opens a list with the same calls the
 * Library rows use (navigate / popToTop).
 *
 * Nothing here is read on iPhone or iPad: nothing publishes in that case and
 * only Mac mounts the sidebar.
 */
type MacListNavigation = NavigationProps<"Library">["navigation"];

let macListNavigation: MacListNavigation | undefined;

/** Called by the note-list stack's screens when they mount. */
export function setMacListNavigation(
  navigation: MacListNavigation | undefined
) {
  macListNavigation = navigation;
}

/**
 * Shows `screen` as the note list. The stack is popped back to its root first
 * so the middle column never grows a back stack (a `navigate` to a route
 * already in the stack pops back to it instead of pushing a duplicate): the
 * list the user picked becomes the top screen, and `goBack` is unreachable
 * anyway because the header hides its back button on Mac.
 */
export function openMacList(
  screen: RouteName,
  params: Record<string, unknown> = {},
  focusedRouteId?: string
) {
  if (focusedRouteId) {
    useNavigationStore.getState().setFocusedRouteId(focusedRouteId);
  }
  switchToLibrarySection();
  const navigation = macListNavigation;
  if (!navigation) return;
  navigation.popToTop();
  (navigation as any).navigate(screen, params);
}

/**
 * The sidebar stays mounted next to the Tasks and Search sections, but the
 * lists its Library rows open live in the Library section. Selecting such a row
 * from Tasks or Search therefore has to bring the Library section forward first
 * - with the same handler the sidebar's own section rows use - or the user
 * would drive a list that is not on screen. Already on Library: nothing to do.
 *
 * `selectAppleSection` lives in navigation-stack.tsx, which imports this module
 * (to publish the note-list stack's navigation object) and is imported by it
 * back, so it is required lazily to keep the module graph acyclic.
 */
function switchToLibrarySection() {
  if (useAppleNavigationStore.getState().section === "library") return;
  const { selectAppleSection } = require("../navigation/navigation-stack") as {
    selectAppleSection: (section: "library") => void;
  };
  // Mirror the section rows' own switch: the native toolbar tracks the section
  // separately and would otherwise keep showing Tasks/Search as selected.
  NativeModules?.VeyraNMacMenu?.setSelectedSection?.("library");
  selectAppleSection("library");
}
