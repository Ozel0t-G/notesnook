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

type MacSidebarState = {
  /** Whether the Mac source-list sidebar is part of the layout. */
  visible: boolean;
  toggle: () => void;
};

/**
 * Whether the Mac sidebar (the Library source list) is shown. Written by the
 * View > Toggle Sidebar command (see hooks/use-mac-menu-commands.ts), read by
 * the Mac layout (see navigation/fluid-panels-view.tsx): hidden means the
 * sidebar pane is 0 pt wide and the note list and editor take the space.
 *
 * Presentation state only, and Mac only - iPhone and iPad never read or write
 * it, so they keep the panes they always had.
 */
export const useMacSidebarStore = create<MacSidebarState>((set) => ({
  visible: true,
  toggle: () => set((state) => ({ visible: !state.visible }))
}));
