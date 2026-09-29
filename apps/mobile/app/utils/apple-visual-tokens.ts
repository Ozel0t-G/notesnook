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
import { Platform } from "react-native";

/*
 * Presentation-only tokens for the iOS/iPadOS visual layer.
 *
 * Values intentionally resolve from the active Notesnook theme so custom
 * themes, dark mode, and the user-selected accent remain authoritative.
 */
/** UIKit dark grouped colors (systemGroupedBackground and friends). */
export const IOS_DARK = {
  grouped: "#000000",
  card: "#1C1C1E",
  selected: "#3A3A3C",
  separator: "#38383A"
} as const;

export const getAppleVisualTokens = (
  colors: VariantsWithStaticColors<true>,
  isDark = false
) => {
  const ios = Platform.OS === "ios";
  // iOS dark mode layers get *lighter* towards the front: black grouped
  // background, cards one step up (secondarySystemGroupedBackground). The
  // theme's dark colors are the other way round and made cards look like holes.
  const iosDark = ios && isDark;
  const base = {
    ios,
    screenBackground: ios
      ? colors.secondary.background
      : colors.primary.background,
    sidebarBackground: ios
      ? colors.secondary.background
      : colors.primary.background,
    contentSurface: colors.primary.background,
    secondarySurface: colors.secondary.background,
    elevatedSurface: ios
      ? colors.primary.background
      : colors.secondary.background,
    toolbarSurface: ios
      ? colors.primary.background
      : colors.secondary.background,
    navigationSurface: ios
      ? colors.primary.background
      : colors.secondary.background,
    editorSurround: ios
      ? colors.secondary.background
      : colors.primary.background,
    surface: colors.primary.background,
    separator: colors.primary.border,
    primaryText: colors.primary.heading,
    secondaryText: colors.secondary.paragraph,
    tertiaryText: colors.secondary.icon,
    mutedText: colors.secondary.icon,
    selectedSurface: colors.selected.background,
    selectionBackground: colors.selected.background,
    hoverSurface: colors.primary.hover,
    cardRadius: ios ? 20 : 18,
    buttonRadius: ios ? 16 : 14,
    controlRadius: ios ? 16 : 14,
    sectionRadius: ios ? 22 : 18,
    sheetRadius: ios ? 24 : 15,
    pagePadding: ios ? 16 : 12,
    sectionSpacing: ios ? 20 : 10,
    rowPadding: ios ? 16 : 12,
    sidebarPadding: ios ? 12 : 8,
    materialOpacity: isDark ? 0.96 : 0.98,
    navigationMaterialOpacity: ios
      ? isDark
        ? 0.96
        : 0.94
      : isDark
      ? 0.94
      : 0.98,
    listInset: ios ? 16 : 12,
    rowInset: ios ? 18 : 18,
    rowSpacing: ios ? 0 : 6,
    subtleShadow: {
      elevation: ios ? 0 : 1,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: ios ? 0 : isDark ? 0.24 : 0.1,
      shadowRadius: ios ? 0 : 5
    },
    floatingShadow: {
      elevation: ios ? 4 : 1,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: isDark ? 0.3 : 0.12,
      shadowRadius: 14
    }
  };
  if (!iosDark) return base;
  return {
    ...base,
    screenBackground: IOS_DARK.grouped,
    sidebarBackground: IOS_DARK.grouped,
    contentSurface: IOS_DARK.card,
    secondarySurface: IOS_DARK.card,
    elevatedSurface: IOS_DARK.card,
    toolbarSurface: IOS_DARK.card,
    navigationSurface: IOS_DARK.grouped,
    editorSurround: IOS_DARK.grouped,
    surface: IOS_DARK.card,
    separator: IOS_DARK.separator,
    selectedSurface: IOS_DARK.selected,
    selectionBackground: IOS_DARK.selected
  };
};
