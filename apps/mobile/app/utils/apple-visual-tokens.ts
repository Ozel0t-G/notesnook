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
import { isMacCatalyst } from "./constants";

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

/**
 * macOS semantic surface colors for the dark appearance (F2, R8), used only for
 * genuinely *elevated* surfaces on Mac: cards, sheets and the secondary fill.
 *
 * The window itself is no longer one of these greys. Mac Catalyst follows the
 * macOS 26 Notes design and paints one background across the whole window (the
 * source list, the note list, the editor and the band behind the toolbar), and
 * that background is the active theme's `primary.background`, not a semantic
 * grey - see `withMacSemanticColors` below. No value here may repeat an
 * IOS_DARK value.
 */
export const MAC_DARK = {
  content: "#1E1E1E",
  secondarySurface: "#2A2A2C",
  separator: "rgba(255,255,255,0.1)",
  /** NSColor.selectedContentBackgroundColor (dark). */
  selected: "#3A3A3D"
} as const;

/** macOS semantic surface colors for the light appearance (F2, R8). */
export const MAC_LIGHT = {
  content: "#FFFFFF",
  secondarySurface: "#F5F5F7",
  separator: "#D8D8DA",
  selected: "#DCDCE0"
} as const;

export const getAppleVisualTokens = (
  colors: VariantsWithStaticColors<true>,
  isDark = false
) => {
  const ios = Platform.OS === "ios";
  // Catalyst is an iOS build, so `ios` stays true there: the layout branches
  // that key off it (card radii, insets, the three-column reach) must not
  // change. Only the *colors* get a Mac branch below.
  const mac = isMacCatalyst();
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
  if (mac) return withMacSemanticColors(base, isDark, colors);
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

/**
 * The Mac Catalyst overrides (F2, R8): the macOS semantic surface greys replace
 * the UIKit grouped ones, so no IOS_DARK value is ever returned on the Mac, and
 * the text/hover/radius/spacing tokens stay theme-driven.
 *
 * The window-level surfaces are theme-driven, not grey. The Mac window is one
 * background from edge to edge (macOS 26 Notes): the note list column, the
 * editor pane and the band behind the native toolbar all use the active theme's
 * `primary.background`, so switching themes re-tints the whole window instead
 * of leaving a fixed grey. `contentSurface`, `secondarySurface` and `surface`
 * keep their macOS greys: those are elevated cards, sheets and fields that are
 * supposed to float above the window, not the window itself.
 */
function withMacSemanticColors<T extends object>(
  base: T,
  isDark: boolean,
  colors: VariantsWithStaticColors<true>
) {
  const tokens = isDark ? MAC_DARK : MAC_LIGHT;
  const windowBackground = colors.primary.background;
  return {
    ...base,
    screenBackground: windowBackground,
    sidebarBackground: windowBackground,
    contentSurface: tokens.content,
    secondarySurface: tokens.secondarySurface,
    elevatedSurface: tokens.content,
    toolbarSurface: windowBackground,
    navigationSurface: windowBackground,
    editorSurround: windowBackground,
    surface: tokens.content,
    separator: tokens.separator,
    selectedSurface: tokens.selected,
    selectionBackground: tokens.selected
  };
}
