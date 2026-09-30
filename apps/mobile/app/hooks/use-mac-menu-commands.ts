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
import { useSettingStore } from "../stores/use-setting-store";
import {
  AppleSection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";
import { rootNavigatorRef } from "../utils/global-refs";
import { selectAppleSection } from "../navigation/navigation-stack";

/**
 * Root stack routes that iOS presents as sheets (see SETTINGS_SHEET_OPTIONS and
 * TASK_SHEET_OPTIONS in navigation-stack.tsx). Escape dismisses the topmost one
 * of these; the base screens inside FluidPanelsView have nothing to dismiss.
 */
const DISMISSABLE_ROUTES = new Set(["Settings", "TaskDetail", "AddReminder"]);

/**
 * Prefix of the commands the window toolbar's segmented control sends: the
 * section it switched to follows it ("section:library").
 */
const SECTION_COMMAND_PREFIX = "section:";

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
 * Handles the commands sent by the Mac Catalyst window chrome through the
 * VeyraNMacMenu native module: the menu bar (Cmd+N, Cmd+, and Escape) and the
 * window toolbar (the Library/Tasks/Search segmented control and New Note).
 * Inert on iPhone and iPad.
 *
 * The reverse direction is handled here too: the toolbar only knows about the
 * sections it switched to itself, so every change to the section store is
 * pushed back to it.
 */
export const useMacMenuCommands = () => {
  useEffect(() => {
    if (
      Platform.OS !== "ios" ||
      !Platform.isMacCatalyst ||
      !NativeModules.VeyraNMacMenu
    )
      return;

    const setToolbarSection = (section: AppleSection) =>
      NativeModules.VeyraNMacMenu.setSelectedSection(section);

    // The store may already have moved on (a deep link, the last session's
    // section) before this hook mounted.
    setToolbarSection(useAppleNavigationStore.getState().section);
    const sectionSubscription = useAppleNavigationStore.subscribe(
      (state, prevState) => {
        if (state.section !== prevState.section) {
          setToolbarSection(state.section);
        }
      }
    );

    const emitter = new NativeEventEmitter(NativeModules.VeyraNMacMenu);
    const subscription = emitter.addListener(
      "VeyraNMacMenuCommand",
      (body: { command?: string }) => {
        const command = body?.command;
        if (command?.startsWith(SECTION_COMMAND_PREFIX)) {
          if (!useSettingStore.getState().settings.introCompleted) {
            // There is no section to switch to before onboarding is done (the
            // iPhone/iPad bar is hidden for the same reason). Snap the segment
            // back to the section the app is actually on.
            setToolbarSection(useAppleNavigationStore.getState().section);
            return;
          }
          // Same handler the iPad tab bar uses, so switching sections behaves
          // identically (including the FluidPanels page it lands on).
          selectAppleSection(
            command.slice(SECTION_COMMAND_PREFIX.length) as AppleSection
          );
          return;
        }
        switch (command) {
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

    return () => {
      subscription.remove();
      sectionSubscription();
    };
  }, []);
};
