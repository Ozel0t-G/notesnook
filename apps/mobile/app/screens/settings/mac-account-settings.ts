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

import { StackActions } from "@react-navigation/native";
import { rootNavigatorRef } from "../../utils/global-refs";
import type { SettingSection } from "./types";

/**
 * Mac sidebar account navigation.
 *
 * The source list's account row (components/mac-sidebar-account-footer.tsx)
 * needs two actions that both live on the root stack: the gear opens Settings,
 * the e-mail row opens Settings directly on the Account group. The group's
 * `SettingSection` object is the same one Settings' home list renders and is
 * built in `settings-data.tsx`, so it is looked up here.
 *
 * `settings-data` is required lazily: the sidebar is mounted on every Mac
 * screen and pulling the whole settings module tree (services, sheets, notifee)
 * into that path would load far more than these two actions need.
 */
function findAccountSection(): SettingSection | undefined {
  const { settingsGroups } = require("./settings-data") as {
    settingsGroups: SettingSection[];
  };
  // The signed-in account group first, the signed-out one as the fallback:
  // only one of the two is ever visible (their `hidden` functions mirror each
  // other), so pressing the row opens whichever matches the current session.
  return (
    settingsGroups.find((section) => section.id === "account") ||
    settingsGroups.find((section) => section.id === "account-signed-out")
  );
}

/**
 * Opens Settings directly on the Account group (the e-mail row's action).
 *
 * Navigating with a nested `screen` param keeps this idempotent:
 * - Settings not open yet: the root stack pushes Settings and opens the group
 *   on top of the settings home (`initial: false` renders SettingsHome as the
 *   initial route so the group's Back button returns there instead of leaving
 *   Settings).
 * - Settings already open: React Navigation routes the nested param into the
 *   existing settings stack, so no second Settings route is pushed.
 */
export function openMacAccountSettings() {
  const navigation = rootNavigatorRef.current;
  if (!navigation) return;
  const section = findAccountSection();
  if (!section) return;
  const settingsGroupParams = {
    screen: "SettingsGroup",
    params: section,
    initial: false
  };
  navigation.navigate("Settings", settingsGroupParams as never);
}

/**
 * Opens the normal Settings home (the gear's action), mirroring the
 * `openSettings` menu command ("Settings…", ⌘,):
 * - Settings not open: push it, exactly like the menu command.
 * - Settings already open: bring its home page forward, popping a group page
 *   the user may be on. This is where the gear differs from the menu command,
 *   which is a no-op in that case.
 */
export function openMacSettings() {
  const navigation = rootNavigatorRef.current;
  if (!navigation) return;
  const routes = navigation.getState()?.routes;
  const settingsOnTop = routes?.[routes.length - 1]?.name === "Settings";
  if (!settingsOnTop) {
    navigation.dispatch(StackActions.push("Settings", {}));
    return;
  }
  const settingsHomeParams = { screen: "SettingsHome" };
  navigation.navigate("Settings", settingsHomeParams as never);
}
