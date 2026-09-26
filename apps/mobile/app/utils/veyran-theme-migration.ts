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

import {
  ThemeDefinition,
  ThemeVeyranDark,
  ThemeVeyranLight
} from "@notesnook/theme";

/**
 * Migrate a user still on the shipped default theme (whether they never
 * touched theming, or explicitly re-picked the shipped default) to its
 * VeyraN equivalent. Anyone on a different theme -- a marketplace theme or a
 * hand-edited custom one -- is matched by `id` and left completely alone.
 *
 * Kept dependency-free (no `react-native`, no MMKV, no stores) so it can be
 * unit-tested directly, and shared between `services/settings.ts`'s
 * version-gated migration and `share/store.ts`'s share-extension fallback.
 */
export function migrateLegacyDefaultTheme(
  theme: ThemeDefinition | undefined,
  legacyId: string,
  replacement: ThemeDefinition
): ThemeDefinition | undefined {
  return theme?.id === legacyId ? replacement : theme;
}

export function migrateLegacyDefaultThemes<
  T extends { lighTheme?: ThemeDefinition; darkTheme?: ThemeDefinition }
>(settings: T): T {
  return {
    ...settings,
    lighTheme: migrateLegacyDefaultTheme(
      settings.lighTheme,
      "default-light",
      ThemeVeyranLight
    ),
    darkTheme: migrateLegacyDefaultTheme(
      settings.darkTheme,
      "default-dark",
      ThemeVeyranDark
    )
  };
}
