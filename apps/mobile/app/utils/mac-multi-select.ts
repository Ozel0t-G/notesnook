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

import type { Item } from "@notesnook/core";
import { NativeModules } from "react-native";
import { useTabStore } from "../screens/editor/tiptap/use-tab-store";
import { useMacListFocusStore } from "../stores/use-mac-list-focus-store";
import useNavigationStore from "../stores/use-navigation-store";
import { useSelectionStore } from "../stores/use-selection-store";
import { isMacCatalyst } from "./constants";

type PointerModifiers = { cmd: boolean; shift: boolean; alt: boolean };

/**
 * The modifier keys held at the last pointer press (Mac Catalyst only; see
 * `getPointerModifiers` in ios/Notesnook/MacMenu/VeyraNMacMenu.m). React
 * Native's press events do not carry them.
 */
export function macPointerModifiers(): PointerModifiers {
  const none = { cmd: false, shift: false, alt: false };
  if (!isMacCatalyst()) return none;
  try {
    return (
      (NativeModules.VeyraNMacMenu?.getPointerModifiers?.() as
        | PointerModifiers
        | undefined) || none
    );
  } catch {
    return none;
  }
}

/**
 * Cmd-click toggles a note in the selection, Shift-click selects the range
 * from the last selected (or the open) note to the clicked one - the Finder
 * and Notes behaviour (WP07/N2). Answers true when the press was one of those
 * and is handled, false for a plain click, which then opens the note as before.
 */
export async function handleMacModifierPress(item: Item): Promise<boolean> {
  if (item.type !== "note") return false;
  const { cmd, shift } = macPointerModifiers();
  if (!cmd && !shift) return false;

  const selection = useSelectionStore.getState();
  if (shift) {
    const route = useNavigationStore.getState().focusedRouteId;
    const list = route
      ? useMacListFocusStore.getState().lists[route]
      : undefined;
    if (list) {
      const ids = await list.ids();
      const clicked = ids.indexOf(item.id);
      const anchorId =
        selection.selectedItemsList[selection.selectedItemsList.length - 1] ||
        useTabStore.getState().getCurrentNoteId();
      const anchor = anchorId ? ids.indexOf(anchorId) : -1;
      if (clicked >= 0) {
        const from = Math.min(anchor < 0 ? clicked : anchor, clicked);
        const to = Math.max(anchor < 0 ? clicked : anchor, clicked);
        if (selection.selectionMode !== "note")
          selection.setSelectionMode("note");
        selection.setAll(ids.slice(from, to + 1));
        return true;
      }
    }
  }

  if (selection.selectionMode !== "note") selection.setSelectionMode("note");
  selection.setSelectedItem(item.id);
  return true;
}
