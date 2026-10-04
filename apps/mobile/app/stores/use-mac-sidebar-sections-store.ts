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

/** The collapsible groups of Mac's source list and the iPhone/iPad Library. */
export type MacSidebarSectionId =
  | "library"
  | "notebooks"
  | "tags"
  | "tasks"
  | "lists";

type MacSidebarSectionsState = {
  collapsed: Record<MacSidebarSectionId, boolean>;
  toggle: (id: MacSidebarSectionId) => void;
};

/**
 * Which source-list sections have been collapsed through their header
 * chevrons. Every section starts expanded; the state is presentation-only and
 * lives for the session, as macOS source lists do.
 *
 * Shared by Mac's sidebar (components/mac-sidebar.tsx) and the iPhone/iPad
 * Library screen (screens/library/index.tsx), which collapses its Notebooks
 * and Tags sections with the same "notebooks"/"tags" ids.
 */
export const useMacSidebarSectionsStore = create<MacSidebarSectionsState>(
  (set) => ({
    collapsed: {
      library: false,
      notebooks: false,
      tags: false,
      tasks: false,
      lists: false
    },
    toggle: (id) =>
      set((state) => ({
        collapsed: { ...state.collapsed, [id]: !state.collapsed[id] }
      }))
  })
);

/** Whether one section of Mac's source list is collapsed. */
export const useMacSidebarSectionCollapsed = (id: MacSidebarSectionId) =>
  useMacSidebarSectionsStore((state) => state.collapsed[id]);
