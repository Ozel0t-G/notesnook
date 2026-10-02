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
import type { TaskSmartListId } from "../hooks/use-task-smart-lists";

/** The list a Tasks section is showing: a smart list or a user Task List. */
export type TaskSelection =
  | { kind: "smart"; id: TaskSmartListId }
  | { kind: "list"; id: string };

type TasksSelectionState = {
  selection: TaskSelection;
  /**
   * Bumped by Mac's sidebar "Lists" + button (`requestNewList`). The Tasks
   * screen consumes it with `takeNewListRequest` and opens the New List sheet,
   * which is the screen's own action and state - so the sidebar only has to ask
   * for it, never reach into the screen.
   */
  newListRequest: number;
  setSelection: (selection: TaskSelection) => void;
  requestNewList: () => void;
  /** True once per pending request; clears it as it is taken. */
  takeNewListRequest: () => boolean;
};

/**
 * Which list the Tasks screen shows, kept outside the screen so Mac's source
 * list can drive it: a task row (Today, Scheduled, ..., a user List) switches
 * to the Tasks section and selects that list here, and the screen follows.
 *
 * Presentation state only. On iPhone/iPad the Tasks screen keeps its own local
 * selection and never reads or writes this store.
 */
export const useTasksSelectionStore = create<TasksSelectionState>((set, get) => ({
  selection: { kind: "smart", id: "today" },
  newListRequest: 0,
  setSelection: (selection) => set({ selection }),
  requestNewList: () =>
    set((state) => ({ newListRequest: state.newListRequest + 1 })),
  takeNewListRequest: () => {
    if (get().newListRequest === 0) return false;
    set({ newListRequest: 0 });
    return true;
  }
}));
