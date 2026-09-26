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

/** Persistent bottom bar sections. "New Note" is an action, not a section. */
export type AppleSection = "library" | "tasks" | "search";

/** What the native bar can report: a section, or the compose action. */
export type AppleTabBarSelection = AppleSection | "compose";

type AppleNavigationState = {
  section: AppleSection;
  editorVisible: boolean;
  setSection: (section: AppleSection) => void;
  setEditorVisible: (visible: boolean) => void;
};

/** Presentation state only. React Navigation and the editor pane remain authoritative. */
export const useAppleNavigationStore = create<AppleNavigationState>((set) => ({
  section: "library",
  editorVisible: false,
  setSection: (section) => set({ section }),
  setEditorVisible: (editorVisible) => set({ editorVisible })
}));
