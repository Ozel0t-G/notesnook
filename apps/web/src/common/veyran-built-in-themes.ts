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
  ThemeDark,
  ThemeDefinition,
  ThemeLight,
  ThemeVeyranDark,
  ThemeVeyranLight
} from "@notesnook/theme";

/**
 * The themes bundled with the app itself. They must always be selectable --
 * regardless of what the active pair is, whether the themes-api marketplace
 * is reachable, or whether the marketplace even lists them at all (VeyraN's
 * themes never will) -- and applying one must never depend on the network.
 *
 * Kept in its own module (only depending on `@notesnook/theme`, not on the
 * rest of `themes-selector.tsx`'s UI/query stack) so it can be unit-tested
 * directly without needing a full build of `@notesnook/intl`/`@notesnook/core`
 * just to resolve the picker component's other imports.
 */
export const BUILT_IN_THEMES: ThemeDefinition[] = [
  ThemeVeyranLight,
  ThemeVeyranDark,
  ThemeLight,
  ThemeDark
];
export const BUILT_IN_THEME_IDS = new Set(
  BUILT_IN_THEMES.map((theme) => theme.id)
);
export const BUILT_IN_THEMES_BY_ID = new Map(
  BUILT_IN_THEMES.map((theme) => [theme.id, theme])
);

export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
