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
import { macWindowBackground, mixHex } from "./mac-layout";

/*
 * Presentation-only tokens for the iOS/iPadOS visual layer.
 *
 * Values intentionally resolve from the active Notesnook theme so custom
 * themes, dark mode, and the user-selected accent remain authoritative.
 */

/**
 * Dark Apple surface *bases*, before the active accent is blended in.
 *
 * These used to be the plain UIKit grouped greys - pure black grouped
 * background with `#1C1C1E` cards - which made the dark layer react to nothing
 * but the appearance. The dark layer is now a soft charcoal (the design
 * mockup's `#121517` window and `#252A2C` cards) and every token built from it
 * is tinted with the theme's `primary.accent` (see `IOS_DARK_ACCENT_TINT`), so
 * changing the accent re-tints the whole dark app while the base stays a
 * neutral Apple surface rather than a coloured one.
 *
 * Still exported (and still named IOS_DARK) because the Mac guard test asserts
 * that none of these values ever reaches the Mac branch below.
 */
export const IOS_DARK = {
  grouped: "#121517",
  card: "#252A2C",
  selected: "#3A3A3C",
  separator: "#38383A"
} as const;

/**
 * How much of the active accent is blended into each dark iOS surface base.
 *
 * Kept in the 4-8% band: enough that changing `primary.accent` visibly
 * re-tints the dark layer, small enough that the surfaces still read as
 * Apple's neutral dark greys.
 */
export const IOS_DARK_ACCENT_TINT = {
  /** Window-level surfaces: screen, sidebar, navigation and editor surround. */
  window: 0.06,
  /** Cards, sheets, fields and the toolbar band. */
  content: 0.05,
  /** Hairlines. */
  separator: 0.06,
  /** Selection/hover fills. */
  selected: 0.08
} as const;

/** How much accent is blended into the dark Mac *elevated* surfaces. */
export const MAC_DARK_ACCENT_TINT = 0.05;

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
 *
 * The elevated values below are bases too: in the dark appearance each one is
 * blended with a few percent of the theme's `primary.accent` before it is
 * returned (see `MAC_DARK_ACCENT_TINT`), so the cards pick up the accent as
 * well instead of staying a fixed grey.
 */
export const MAC_DARK = {
  content: "#1E1E1E",
  secondarySurface: "#2A2A2C",
  separator: "rgba(255,255,255,0.1)",
  /** NSColor.selectedContentBackgroundColor (dark). */
  selected: "#3A3A3D"
} as const;

/**
 * macOS semantic surface colors for the light appearance (F2, R8).
 *
 * The light Mac window never uses pure white: cards/fields/settings rows are
 * `#FAFAFB` (a hair above the `#F3F3F5` window) and hairlines are `#D9D9DE`.
 * The window-level surfaces are not here - they resolve from
 * `macWindowBackground` in the `withMacSemanticColors` branch below.
 */
export const MAC_LIGHT = {
  content: "#FAFAFB",
  secondarySurface: "#FAFAFB",
  separator: "#D9D9DE",
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
  // iOS dark mode layers get *lighter* towards the front: a charcoal window,
  // cards one step up (secondarySystemGroupedBackground). The theme's dark
  // colors are the other way round and made cards look like holes. Both layers
  // are then tinted with the active accent, so the dark app follows the theme's
  // accent without giving up the neutral Apple surfaces.
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
  const accent = colors.primary.accent;
  const windowSurface = mixHex(
    IOS_DARK.grouped,
    accent,
    IOS_DARK_ACCENT_TINT.window
  );
  const contentSurface = mixHex(
    IOS_DARK.card,
    accent,
    IOS_DARK_ACCENT_TINT.content
  );
  const selectionSurface = mixHex(
    IOS_DARK.selected,
    accent,
    IOS_DARK_ACCENT_TINT.selected
  );
  return {
    ...base,
    screenBackground: windowSurface,
    sidebarBackground: windowSurface,
    contentSurface,
    secondarySurface: contentSurface,
    elevatedSurface: contentSurface,
    toolbarSurface: contentSurface,
    navigationSurface: windowSurface,
    editorSurround: windowSurface,
    surface: contentSurface,
    separator: mixHex(
      IOS_DARK.separator,
      accent,
      IOS_DARK_ACCENT_TINT.separator
    ),
    selectedSurface: selectionSurface,
    selectionBackground: selectionSurface
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
 * `primary.background` tinted with its accent (`macWindowBackground`), so
 * switching themes - or just the accent - re-tints the whole window instead of
 * leaving a fixed grey. All window-level surfaces stay the one colour, so the
 * panes never drift apart.
 *
 * `contentSurface`, `secondarySurface` and `surface` keep their macOS greys:
 * those are elevated cards, sheets and fields that are supposed to float above
 * the window, not the window itself. In the dark appearance they carry the same
 * accent tint (`MAC_DARK_ACCENT_TINT`); the light set is returned untouched.
 */
function withMacSemanticColors<T extends object>(
  base: T,
  isDark: boolean,
  colors: VariantsWithStaticColors<true>
) {
  const tokens = isDark ? MAC_DARK : MAC_LIGHT;
  // Dark: the theme's own primary background, accent-tinted. Light: the soft
  // off-white Mac window surface (`macWindowBackground`), never the theme's
  // pure white.
  const windowBackground = macWindowBackground(colors, isDark);
  // Dark elevated surfaces are the macOS semantic greys tinted with the accent;
  // in light mode this is the identity, so MAC_LIGHT comes back byte for byte.
  const elevatedSurface = (value: string) =>
    isDark ? mixHex(value, colors.primary.accent, MAC_DARK_ACCENT_TINT) : value;
  const contentSurface = elevatedSurface(tokens.content);
  const secondarySurface = elevatedSurface(tokens.secondarySurface);
  const selectedSurface = elevatedSurface(tokens.selected);
  return {
    ...base,
    screenBackground: windowBackground,
    sidebarBackground: windowBackground,
    contentSurface,
    secondarySurface,
    elevatedSurface: contentSurface,
    toolbarSurface: windowBackground,
    navigationSurface: windowBackground,
    editorSurround: windowBackground,
    surface: contentSurface,
    // `rgba()` in the dark set, so the tint is a no-op there; the light hairline
    // is returned as-is.
    separator: elevatedSurface(tokens.separator),
    selectedSurface,
    selectionBackground: selectedSurface
  };
}
