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

import { ThemeDefinition } from "@notesnook/theme";
import { migrateLegacyDefaultThemes } from "../utils/veyran-theme-migration";

export type MigratableSettings = {
  settingsVersion?: number;
  appLockEnabled?: boolean;
  privacyScreen?: boolean;
  lighTheme?: ThemeDefinition;
  darkTheme?: ThemeDefinition;
};

/**
 * Applies every pending version-gated settings migration in sequence,
 * re-checking `settingsVersion` after each step rather than deciding all
 * steps off a version number captured once up front. A settings blob that
 * predates versioning entirely (`settingsVersion` 0/undefined) therefore
 * lands on the current version in a single call -- i.e. a single app
 * launch -- instead of advancing one version per launch.
 *
 * Kept dependency-free (no MMKV, no react-native, no ScreenGuard) so it can
 * be unit-tested directly; `services/settings.ts`'s `migrateSettings()`
 * applies the native side effects (persisting to MMKV, syncing the privacy
 * screen) around this pure step.
 */
export function migrateSettingsVersions<T extends MigratableSettings>(
  settings: T
): { settings: T; migrated: boolean } {
  let current = settings;
  let migrated = false;

  if (!current.settingsVersion) {
    current = {
      ...current,
      settingsVersion: 1,
      privacyScreen: current.appLockEnabled ? true : current.privacyScreen
    };
    migrated = true;
  }

  if (current.settingsVersion === 1) {
    current = {
      ...current,
      // migrateLegacyDefaultThemes() spreads its own input (`current`) into
      // its return value, which still carries the pre-bump settingsVersion
      // -- so `settingsVersion: 2` must come after this spread, not before,
      // or it gets silently clobbered back down to 1.
      ...migrateLegacyDefaultThemes(current),
      settingsVersion: 2
    };
    migrated = true;
  }

  return { settings: current, migrated };
}
