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

import type { Item, VirtualizedGrouping } from "@notesnook/core";
import { create } from "zustand";

/**
 * The note lists that are currently on screen, by the route that renders them
 * (WP07/N3). The Mac keyboard commands (Up/Down/Return, see
 * hooks/use-mac-menu-commands.ts) drive "the list the user is looking at", and
 * only the list itself knows its items, so every note list publishes its data
 * here on Mac and the command handler picks the one of the focused route.
 *
 * Presentation state, Mac only: iPhone and iPad never write or read it.
 */
type MacListFocusState = {
  lists: Record<string, VirtualizedGrouping<Item> | undefined>;
  setList: (route: string, data: VirtualizedGrouping<Item> | undefined) => void;
};

export const useMacListFocusStore = create<MacListFocusState>((set) => ({
  lists: {},
  setList: (route, data) =>
    set((state) => ({ lists: { ...state.lists, [route]: data } }))
}));

/**
 * The index to move to from `current` (-1 when nothing is open yet): Down
 * starts at the first row, Up at the last, and the ends do not wrap, like the
 * Finder and Notes lists.
 */
export function nextListIndex(
  current: number,
  delta: 1 | -1,
  length: number
): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}
