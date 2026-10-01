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

import { create } from "zustand";
import type { NativeMenuItem } from "../components/native-menu";

/**
 * The list's "Sort & View" menu, as the list header builds it (see
 * components/list-view-menu.ts). The Mac window toolbar has no room for the
 * header's own "…" button, so the header publishes the menu here and the
 * toolbar's `listOptions` command opens it (see
 * hooks/use-mac-menu-commands.ts and components/sheets/mac-list-options).
 */
export type MacListMenu = {
  items: NativeMenuItem[];
  onSelect: (id: string) => void;
};

type MacWindowState = {
  /**
   * Title of the note open in the editor (published by
   * components/mac-note-commands.tsx), or undefined with no note open.
   */
  noteTitle?: string;
  listMenu?: MacListMenu;
  setNoteTitle: (noteTitle?: string) => void;
  setListMenu: (listMenu?: MacListMenu) => void;
};

/**
 * Mac Catalyst window chrome state that several, otherwise unrelated panes
 * have to agree on: the open note's title (the editor) and the focused list's
 * menu (the list header), both read by the window's native toolbar. Empty on
 * iPhone/iPad, which never publish into it.
 */
export const useMacWindowStore = create<MacWindowState>((set) => ({
  noteTitle: undefined,
  listMenu: undefined,
  setNoteTitle: (noteTitle) => set({ noteTitle }),
  setListMenu: (listMenu) => set({ listMenu })
}));
