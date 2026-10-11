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

let mockIsMacCatalyst = true;

// The module under test only needs `Platform.OS` from react-native; the Mac
// branch is driven by the mocked isMacCatalyst() below. Platform.isMacCatalyst
// is deliberately left out: reading the `mock…` variable right here would run
// before its declaration (jest hoists this factory above it).
jest.mock("react-native", () => ({
  Platform: { OS: "ios" }
}));

jest.mock("./constants", () => ({
  isMacCatalyst: () => mockIsMacCatalyst
}));

import {
  getAppleVisualTokens,
  IOS_DARK,
  IOS_DARK_ACCENT_TINT,
  MAC_DARK,
  MAC_DARK_ACCENT_TINT,
  MAC_LIGHT
} from "./apple-visual-tokens";
import {
  MAC_DARK_WINDOW_ACCENT_TINT,
  macWindowBackground,
  mixHex
} from "./mac-layout";

type ThemeColors = Parameters<typeof getAppleVisualTokens>[0];

/**
 * A dark/light Notesnook theme whose own colors repeat no IOS_DARK value, so a
 * returned IOS_DARK color can only come from the token branch under test.
 */
const theme = (isDark: boolean) =>
  ({
    primary: {
      background: isDark ? "#121212" : "#FBFBFB",
      border: isDark ? "#1F1F1F" : "#E2E2E2",
      heading: isDark ? "#F2F2F2" : "#1A1A1A",
      paragraph: isDark ? "#E5E5E5" : "#2B2B2B",
      icon: isDark ? "#B0B0B0" : "#555555",
      hover: isDark ? "#1A1A1A" : "#EFEFEF",
      accent: "#0A84FF"
    },
    secondary: {
      background: isDark ? "#171717" : "#F2F2F2",
      paragraph: isDark ? "#C7C7C7" : "#4A4A4A",
      icon: isDark ? "#9A9A9A" : "#6E6E6E"
    },
    selected: {
      background: isDark ? "#1B1B1B" : "#E8E8E8",
      accent: "#0A84FF"
    }
  } as unknown as ThemeColors);

/**
 * The same theme with only the accent replaced, so a case can prove the dark
 * tokens follow `primary.accent` on their own - the rest of the palette
 * (including `primary.background`) is untouched.
 */
const withAccent = (colors: ThemeColors, accent: string): ThemeColors =>
  ({
    ...colors,
    primary: { ...colors.primary, accent },
    selected: { ...colors.selected, accent }
  } as ThemeColors);

/** The dark iOS tokens that are supposed to follow the accent. */
const IOS_ACCENT_TINTED_KEYS = [
  "screenBackground",
  "sidebarBackground",
  "navigationSurface",
  "toolbarSurface",
  "editorSurround",
  "contentSurface",
  "secondarySurface",
  "elevatedSurface",
  "surface",
  "separator",
  "selectedSurface",
  "selectionBackground"
] as const;

/**
 * The dark Mac tokens that follow the accent. `separator` is the one exception:
 * the dark Mac hairline is an `rgba()` string, so there is no hex to tint.
 */
const MAC_ACCENT_TINTED_KEYS = [
  "screenBackground",
  "sidebarBackground",
  "navigationSurface",
  "toolbarSurface",
  "editorSurround",
  "contentSurface",
  "secondarySurface",
  "elevatedSurface",
  "surface",
  "selectedSurface",
  "selectionBackground"
] as const;

/** Every string anywhere in the token object, lower-cased for comparison. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value.toLowerCase());
  else if (Array.isArray(value)) collectStrings(value, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

describe("Mac Catalyst visual tokens", () => {
  beforeEach(() => {
    mockIsMacCatalyst = true;
  });

  test("tints the theme's primary background for the whole window (dark)", () => {
    const themeColors = theme(true);
    const tokens = getAppleVisualTokens(themeColors, true);
    const accent = themeColors.primary.accent;
    const windowBackground = macWindowBackground(themeColors, true);

    // Catalyst is still an iOS build: the layout branches keyed off `ios`
    // (radii, insets, three-column reach) must not move.
    expect(tokens.ios).toBe(true);
    // One background across the window: the root, the note list, the editor
    // and the band behind the toolbar all resolve to the theme's primary
    // background with the accent blended in (macOS 26 Notes), not to a fixed
    // macOS grey.
    expect(windowBackground).toBe(
      mixHex(
        themeColors.primary.background,
        accent,
        MAC_DARK_WINDOW_ACCENT_TINT
      )
    );
    expect(tokens.screenBackground).toBe(windowBackground);
    expect(tokens.sidebarBackground).toBe(windowBackground);
    expect(tokens.navigationSurface).toBe(windowBackground);
    expect(tokens.toolbarSurface).toBe(windowBackground);
    expect(tokens.editorSurround).toBe(windowBackground);
    // The theme's base colour is only nudged, never replaced.
    expect(tokens.screenBackground).not.toBe(themeColors.primary.background);
    // Elevated surfaces are the macOS semantic greys with the same accent tint:
    // they float above the window, so they keep their own value.
    expect(tokens.contentSurface).toBe(
      mixHex(MAC_DARK.content, accent, MAC_DARK_ACCENT_TINT)
    );
    expect(tokens.secondarySurface).toBe(
      mixHex(MAC_DARK.secondarySurface, accent, MAC_DARK_ACCENT_TINT)
    );
    expect(tokens.elevatedSurface).toBe(tokens.contentSurface);
    expect(tokens.surface).toBe(tokens.contentSurface);
    // The dark Mac hairline is an rgba() string: nothing to tint.
    expect(tokens.separator).toBe("rgba(255,255,255,0.1)");
    expect(tokens.selectedSurface).toBe(
      mixHex(MAC_DARK.selected, accent, MAC_DARK_ACCENT_TINT)
    );
    expect(tokens.selectionBackground).toBe(tokens.selectedSurface);
  });

  test("a different accent re-tints the dark Mac surfaces only", () => {
    const blueTokens = getAppleVisualTokens(theme(true), true);
    const orangeTokens = getAppleVisualTokens(
      withAccent(theme(true), "#FF9500"),
      true
    );

    for (const key of MAC_ACCENT_TINTED_KEYS)
      expect(orangeTokens[key]).not.toBe(blueTokens[key]);

    // The light Mac window is a fixed off-white: the accent never reaches it.
    expect(
      getAppleVisualTokens(withAccent(theme(false), "#FF9500"), false)
    ).toEqual(getAppleVisualTokens(theme(false), false));
  });

  test("never uses pure white for the light Mac window", () => {
    const themeColors = theme(false);
    const tokens = getAppleVisualTokens(themeColors, false);

    expect(tokens.ios).toBe(true);
    // The light Mac window is the soft off-white, not the theme's near-white
    // (#FBFBFB here) and never #FFFFFF.
    expect(tokens.screenBackground).toBe("#F3F3F5");
    expect(tokens.sidebarBackground).toBe("#F3F3F5");
    expect(tokens.navigationSurface).toBe("#F3F3F5");
    expect(tokens.toolbarSurface).toBe("#F3F3F5");
    expect(tokens.editorSurround).toBe("#F3F3F5");
    expect(tokens.screenBackground).not.toBe("#FFFFFF");
    // Cards/fields/settings rows are a hair above the window, never #FFFFFF.
    expect(tokens.contentSurface).toBe("#FAFAFB");
    expect(tokens.secondarySurface).toBe("#FAFAFB");
    expect(tokens.elevatedSurface).toBe("#FAFAFB");
    expect(tokens.surface).toBe(MAC_LIGHT.content);
    expect(tokens.separator).toBe("#D9D9DE");
    expect(tokens.selectedSurface).toBe("#DCDCE0");
    expect(tokens.selectionBackground).toBe("#DCDCE0");
    expect(tokens.contentSurface).not.toBe("#FFFFFF");
  });

  test("never returns an IOS_DARK value on the Mac", () => {
    const groupedValues = Object.values(IOS_DARK).map((value) =>
      value.toLowerCase()
    );

    for (const isDark of [true, false]) {
      const tokens = collectStrings(getAppleVisualTokens(theme(isDark), isDark));
      for (const grouped of groupedValues) {
        expect(tokens).not.toContain(grouped);
      }
    }
  });

  test("keeps every spacing and radius token unchanged from iOS", () => {
    mockIsMacCatalyst = false;
    const iosDark = getAppleVisualTokens(theme(true), true);
    const iosLight = getAppleVisualTokens(theme(false), false);

    mockIsMacCatalyst = true;
    const macDark = getAppleVisualTokens(theme(true), true);
    const macLight = getAppleVisualTokens(theme(false), false);

    const layoutKeys = [
      "cardRadius",
      "buttonRadius",
      "controlRadius",
      "sectionRadius",
      "sheetRadius",
      "pagePadding",
      "sectionSpacing",
      "rowPadding",
      "sidebarPadding",
      "listInset",
      "rowInset",
      "rowSpacing"
    ] as const;

    for (const key of layoutKeys) {
      expect(macDark[key]).toBe(iosDark[key]);
      expect(macLight[key]).toBe(iosLight[key]);
    }
  });
});

describe("iOS visual tokens", () => {
  beforeEach(() => {
    mockIsMacCatalyst = false;
  });

  test("tints the dark Apple surfaces with the theme accent", () => {
    const themeColors = theme(true);
    const tokens = getAppleVisualTokens(themeColors, true);
    const accent = themeColors.primary.accent;

    expect(tokens.ios).toBe(true);
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

    expect(tokens.screenBackground).toBe(windowSurface);
    expect(tokens.sidebarBackground).toBe(windowSurface);
    expect(tokens.navigationSurface).toBe(windowSurface);
    expect(tokens.editorSurround).toBe(windowSurface);
    expect(tokens.contentSurface).toBe(contentSurface);
    expect(tokens.secondarySurface).toBe(contentSurface);
    expect(tokens.elevatedSurface).toBe(contentSurface);
    expect(tokens.toolbarSurface).toBe(contentSurface);
    expect(tokens.surface).toBe(contentSurface);
    expect(tokens.separator).toBe(
      mixHex(IOS_DARK.separator, accent, IOS_DARK_ACCENT_TINT.separator)
    );
    expect(tokens.selectedSurface).toBe(selectionSurface);
    expect(tokens.selectionBackground).toBe(selectionSurface);
    // The charcoal bases, not the old flat UIKit greys.
    expect(tokens.screenBackground).not.toBe(IOS_DARK.grouped);
    expect(tokens.contentSurface).not.toBe(IOS_DARK.card);
  });

  test("a different accent re-tints every dark iOS surface", () => {
    const blueTokens = getAppleVisualTokens(theme(true), true);
    const orangeTokens = getAppleVisualTokens(
      withAccent(theme(true), "#FF9500"),
      true
    );

    for (const key of IOS_ACCENT_TINTED_KEYS)
      expect(orangeTokens[key]).not.toBe(blueTokens[key]);

    // Light iOS stays theme-driven and ignores the accent entirely.
    expect(
      getAppleVisualTokens(withAccent(theme(false), "#FF9500"), false)
    ).toEqual(getAppleVisualTokens(theme(false), false));
  });

  test("keeps the light appearance theme-driven", () => {
    const themeColors = theme(false);
    const tokens = getAppleVisualTokens(themeColors, false);

    expect(tokens.ios).toBe(true);
    expect(tokens.screenBackground).toBe(themeColors.secondary.background);
    expect(tokens.sidebarBackground).toBe(themeColors.secondary.background);
    expect(tokens.contentSurface).toBe(themeColors.primary.background);
    expect(tokens.secondarySurface).toBe(themeColors.secondary.background);
    expect(tokens.separator).toBe(themeColors.primary.border);
    expect(tokens.selectedSurface).toBe(themeColors.selected.background);
    expect(tokens.selectionBackground).toBe(themeColors.selected.background);
  });
});
