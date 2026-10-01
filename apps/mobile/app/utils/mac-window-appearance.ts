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

import { NativeModules } from "react-native";
import { isMacCatalyst } from "./constants";

/**
 * Keeps the Mac window chrome (NSToolbar, its search field, the traffic lights)
 * in the app's theme. On Mac Catalyst the window chrome follows the *system*
 * appearance unless the window overrides it, so a light app under a dark macOS
 * gets dark chrome around light content (and the other way round).
 *
 * `useSystemTheme` keeps the app theme in sync with the system, so the window
 * may follow the system too ("system" clears the override). Otherwise the
 * window is pinned to the app's `colorScheme`.
 *
 * No-op everywhere else, and when the native module is not linked (the JS side
 * is shared with iOS/Android and older builds).
 */
export function syncMacWindowAppearance(
  useSystemTheme: boolean,
  colorScheme: "light" | "dark"
): void {
  if (!isMacCatalyst()) return;
  const native = NativeModules.VeyraNMacMenu;
  if (!native || typeof native.setWindowAppearance !== "function") return;
  native.setWindowAppearance(useSystemTheme ? "system" : colorScheme);
}
