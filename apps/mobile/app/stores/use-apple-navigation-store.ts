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

/**
 * What the native bar can report or highlight: a persistent section, the
 * compose action, or the Settings action. "settings" is deliberately not part
 * of `AppleSection`: it is not a place the app stays in, it opens the Settings
 * sheet over the section underneath, which stays selected (Mac's section
 * maps/consumers stay keyed by `AppleSection`).
 */
export type AppleTabBarSelection = AppleSection | "compose" | "settings";

type AppleNavigationState = {
  section: AppleSection;
  /**
   * The Settings sheet is open. While it is, the bar highlights Settings (see
   * `apple-tab-bar.tsx`) and `section` keeps the value the sheet was opened
   * over, so dismissing it returns there.
   */
  settingsVisible: boolean;
  editorVisible: boolean;
  setSection: (section: AppleSection) => void;
  setSettingsVisible: (visible: boolean) => void;
  setEditorVisible: (visible: boolean) => void;
};

/** Presentation state only. React Navigation and the editor pane remain authoritative. */
export const useAppleNavigationStore = create<AppleNavigationState>((set) => ({
  section: "library",
  settingsVisible: false,
  editorVisible: false,
  setSection: (section) => set({ section }),
  setSettingsVisible: (settingsVisible) => set({ settingsVisible }),
  setEditorVisible: (editorVisible) => set({ editorVisible })
}));
