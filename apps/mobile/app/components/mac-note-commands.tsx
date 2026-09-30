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

import { Note } from "@notesnook/core";
import React from "react";
import { ActionId, useActions } from "../hooks/use-actions";
import { useDBItem } from "../hooks/use-db-item";
import { useTabStore } from "../screens/editor/tiptap/use-tab-store";
import { isMacCatalyst } from "../utils/constants";

/**
 * Item actions (Pin, Add to Favorites, Move to Trash) of the note that is open
 * in the editor, for the Mac menu bar's "Note" menu
 * (ios/Notesnook/AppDelegate.mm) and its JavaScript half
 * (hooks/use-mac-menu-commands.ts).
 *
 * `useActions` is a hook and needs an item, so the note's action list has to
 * live in a component; this one renders nothing and publishes a runner for the
 * command handler through a module-level reference - the same pattern as
 * services/mac-list-navigation.ts. The actions themselves are the ones the
 * note list's context menu runs (components/item-actions-menu.tsx), so the menu
 * bar behaves exactly like right-clicking the row: the same publish/vault
 * checks, the same trash path and toasts.
 *
 * With no note open nothing is mounted and `runMacNoteAction` is a no-op, which
 * is what the menu bar items need to do then.
 */
let runner: ((id: ActionId) => void) | undefined;

/** Runs one item action of the open note; a no-op when no note is open. */
export function runMacNoteAction(id: ActionId) {
  runner?.(id);
}

/** Mounted only for a resolved note: `useActions` cannot take `undefined`. */
function MacNoteActionsHost({ note }: { note: Note }) {
  const actions = useActions({
    item: note,
    close: () => {},
    // No properties sheet around: dialogs and toasts use the global host.
    presentation: "menu"
  });
  // The runner is published from the effect and reads the actions through a
  // ref, not assigned while rendering: switching notes swaps this host for the
  // next one (key={note.id}), and React runs a deleted host's cleanup after
  // the new host has rendered - a runner assigned during the new render would
  // be cleared again by the old host's cleanup, leaving the menu bar's note
  // commands dead until the next render.
  const actionsRef = React.useRef(actions);
  actionsRef.current = actions;
  React.useEffect(() => {
    runner = (id) =>
      actionsRef.current.find((action) => action.id === id)?.onPress();
    return () => {
      runner = undefined;
    };
  }, []);
  return null;
}

/** Publishes the open note's actions; renders nothing. */
export function MacNoteCommands() {
  const enabled = isMacCatalyst();
  const noteId = useTabStore((state) =>
    enabled ? state.getTab(state.currentTab)?.session?.noteId : undefined
  );
  const [note] = useDBItem(noteId, "note");
  if (!note) return null;
  return <MacNoteActionsHost key={note.id} note={note} />;
}

export default MacNoteCommands;
