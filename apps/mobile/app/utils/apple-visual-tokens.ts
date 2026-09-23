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

import { VariantsWithStaticColors } from "@notesnook/theme";

/*
 * Presentation-only tokens for the iOS/iPadOS visual layer.
 *
 * Values intentionally resolve from the active Notesnook theme so custom
 * themes, dark mode, and the user-selected accent remain authoritative.
 */
export const getAppleVisualTokens = (
  colors: VariantsWithStaticColors<true>,
  isDark = false
) => ({
  surface: colors.primary.background,
  elevatedSurface: colors.secondary.background,
  separator: colors.primary.border,
  primaryText: colors.primary.heading,
  secondaryText: colors.secondary.paragraph,
  mutedText: colors.secondary.icon,
  selectionBackground: colors.selected.background,
  cardRadius: 14,
  buttonRadius: 12,
  sectionRadius: 14,
  materialOpacity: isDark ? 0.9 : 0.96,
  rowInset: 16,
  subtleShadow: {
    elevation: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: isDark ? 0.18 : 0.06,
    shadowRadius: 3
  }
});
