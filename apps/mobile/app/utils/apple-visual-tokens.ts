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
  cardRadius: 18,
  buttonRadius: 14,
  sectionRadius: 18,
  materialOpacity: isDark ? 0.94 : 0.98,
  // These values are deliberately large enough to create a distinct grouped
  // surface on a phone, while leaving the existing controls and touch targets
  // in place.
  listInset: 12,
  rowInset: 18,
  rowSpacing: 6,
  subtleShadow: {
    elevation: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: isDark ? 0.24 : 0.1,
    shadowRadius: 5
  }
});
