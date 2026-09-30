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

import { useEffect } from "react";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import { hideDialog } from "../components/dialog/functions";
import { openEditor, setOnFirstSaveUnassigned } from "../screens/notes/common";
import { hideSheet } from "../services/event-manager";
import Navigation from "../services/navigation";
import { rootNavigatorRef } from "../utils/global-refs";

/**
 * Root stack routes that iOS presents as sheets (see SETTINGS_SHEET_OPTIONS and
 * TASK_SHEET_OPTIONS in navigation-stack.tsx). Escape dismisses the topmost one
 * of these; the base screens inside FluidPanelsView have nothing to dismiss.
 */
const DISMISSABLE_ROUTES = new Set(["Settings", "TaskDetail", "AddReminder"]);

/**
 * Mirrors pressing Escape on iOS: close the topmost sheet or modal. Sheets and
 * dialogs are closed through the same events the rest of the app uses, and
 * both helpers are no-ops when nothing is open.
 */
function closeTopmostSheetOrModal() {
  hideSheet();
  hideDialog();

  // The root stack state, not the focused route: Settings contains its own
  // nested stack, which must not hide the sheet around it.
  const routes = rootNavigatorRef.current?.getState()?.routes;
  if (!routes?.length) return;
  const currentRoute = routes[routes.length - 1]?.name;
  if (!currentRoute || !DISMISSABLE_ROUTES.has(currentRoute)) return;
  Navigation.goBack();
}

/**
 * Handles the commands sent by the Mac Catalyst menu bar (Cmd+N, Cmd+, and
 * Escape) through the VeyraNMacMenu native module. Inert on iPhone and iPad.
 */
export const useMacMenuCommands = () => {
  useEffect(() => {
    if (
      Platform.OS !== "ios" ||
      !Platform.isMacCatalyst ||
      !NativeModules.VeyraNMacMenu
    )
      return;

    const emitter = new NativeEventEmitter(NativeModules.VeyraNMacMenu);
    const subscription = emitter.addListener(
      "VeyraNMacMenuCommand",
      (body: { command?: string }) => {
        switch (body?.command) {
          case "newNote":
            // Same action as the compose button in the Library nav bar.
            setOnFirstSaveUnassigned();
            openEditor();
            break;
          case "openSettings":
            // Same action as the Settings button in the Library nav bar.
            Navigation.push("Settings", {});
            break;
          case "escape":
            closeTopmostSheetOrModal();
            break;
          default:
            break;
        }
      }
    );

    return () => subscription.remove();
  }, []);
};
