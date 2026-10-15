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
  resolveAppleSurfaces,
  ThemeDefinition,
  VariantsWithStaticColors
} from "@notesnook/theme";
import { Platform } from "react-native";
import { activeAppleThemeIdentity } from "./mac-layout";

/*
 * Presentation-only tokens for the iOS/iPadOS/Mac Catalyst visual layer.
 *
 * The surfaces (window, sidebar, list, document, elevated/field cards,
 * separators and the selection/hover affordances) come from the one shared
 * resolver in `@notesnook/theme`'s `theme-engine/apple-surfaces.ts`, which the
 * editor WebView calls too, so the native panes and the page inside the WebView
 * cannot disagree.
 *
 * What changed with the 2026 redesign (docs/APPLE_DESIGN_SYSTEM.md §2): the big
 * neutral surfaces no longer mix 5-8% of the theme accent into themselves. The
 * window, sidebar, note list, reading canvas and cards are neutral -- the
 * standard VeyraN palette for the bundled VeyraN appearances, the theme's own
 * authored colors for every imported/custom theme -- and the accent only
 * reaches the interactive affordances (`selectionBackground`/`selectedSurface`
 * here; hover stays the theme's own fill).
 *
 * The token *names* are unchanged: `screenBackground`, `sidebarBackground`,
 * `contentSurface`, `secondarySurface`, `elevatedSurface`, `toolbarSurface`,
 * `navigationSurface`, `editorSurround`, `surface`, `separator`,
 * `selectedSurface`, `selectionBackground` and `hoverSurface` keep their old
 * meaning and now resolve from the shared roles (`windowBackground`,
 * `sidebarSurface`, `elevatedSurface`, `fieldSurface`, `documentSurface`,
 * `selectionFill`, `hoverFill`), which are returned explicitly as well so the
 * actually rendered panes can name the surface they paint instead of picking an
 * alias.
 */

export const getAppleVisualTokens = (
  colors: VariantsWithStaticColors<true>,
  isDark = false,
  theme?: Pick<ThemeDefinition, "id" | "colorScheme"> | null
) => {
  // Catalyst is an iOS build, so `ios` stays true there: every Apple client
  // shares the resolved surface roles, and the layout branches that key off
  // `ios` (card radii, insets, the three-column reach) keep working.
  const ios = Platform.OS === "ios";

  // The Apple surface resolver only runs on Apple. Android and every other
  // client that never received the Apple surface redesign keep exactly the
  // theme-derived aliases they have always had (the `??` fallbacks below), so
  // their window, list, cards and text are byte-for-byte unchanged.
  //
  // On Apple, the theme identity decides between the standard VeyraN neutrals
  // and the theme's own authored surfaces; `activeAppleThemeIdentity` reads the
  // app's live, effective (accent-applied) theme, whose `id` the accent palette
  // never changes. Pass it explicitly in tests.
  const surfaces = ios
    ? resolveAppleSurfaces({
        theme: theme ?? activeAppleThemeIdentity(),
        colors,
        isDark
      })
    : undefined;

  return {
    ios,
    /** Window root, toolbar band and the note list column. */
    windowBackground: surfaces?.windowBackground ?? colors.primary.background,
    /** The source list / sidebar. */
    sidebarSurface: surfaces?.sidebarSurface ?? colors.primary.background,
    /** The note list column. */
    listSurface: surfaces?.listSurface ?? colors.primary.background,
    /** The reading canvas: the editor pane and the page inside the WebView. */
    documentSurface: surfaces?.documentSurface ?? colors.primary.background,

    // Compatibility aliases: same roles, the names the existing screens use.
    screenBackground: surfaces?.windowBackground ?? colors.primary.background,
    sidebarBackground: surfaces?.sidebarSurface ?? colors.primary.background,
    navigationSurface:
      surfaces?.sidebarSurface ?? colors.secondary.background,
    contentSurface: surfaces?.elevatedSurface ?? colors.primary.background,
    secondarySurface: surfaces?.fieldSurface ?? colors.secondary.background,
    elevatedSurface: surfaces?.elevatedSurface ?? colors.secondary.background,
    toolbarSurface: surfaces?.elevatedSurface ?? colors.secondary.background,
    editorSurround: surfaces?.documentSurface ?? colors.primary.background,
    surface: surfaces?.elevatedSurface ?? colors.primary.background,
    separator: surfaces?.separator ?? colors.primary.border,
    primaryText: colors.primary.heading,
    secondaryText: colors.secondary.paragraph,
    tertiaryText: colors.secondary.icon,
    mutedText: colors.secondary.icon,
    // Interactive affordances: the only place the accent reaches a surface.
    selectedSurface: surfaces?.selectionFill ?? colors.selected.background,
    selectionBackground: surfaces?.selectionFill ?? colors.selected.background,
    hoverSurface: surfaces?.hoverFill ?? colors.primary.hover,

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
};
