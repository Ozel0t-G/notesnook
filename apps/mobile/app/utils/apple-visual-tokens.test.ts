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
  MAC_DARK,
  MAC_LIGHT
} from "./apple-visual-tokens";

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

  test("uses the theme's primary background for the whole window (dark)", () => {
    const themeColors = theme(true);
    const tokens = getAppleVisualTokens(themeColors, true);

    // Catalyst is still an iOS build: the layout branches keyed off `ios`
    // (radii, insets, three-column reach) must not move.
    expect(tokens.ios).toBe(true);
    // One background across the window: the root, the note list, the editor
    // and the band behind the toolbar all resolve to the theme's primary
    // background (macOS 26 Notes), not to a fixed macOS grey.
    expect(tokens.screenBackground).toBe(themeColors.primary.background);
    expect(tokens.sidebarBackground).toBe(themeColors.primary.background);
    expect(tokens.navigationSurface).toBe(themeColors.primary.background);
    expect(tokens.toolbarSurface).toBe(themeColors.primary.background);
    expect(tokens.editorSurround).toBe(themeColors.primary.background);
    // Elevated surfaces keep their macOS semantic greys: they are supposed to
    // float above the window, not merge with it.
    expect(tokens.contentSurface).toBe("#1E1E1E");
    expect(tokens.secondarySurface).toBe("#2A2A2C");
    expect(tokens.separator).toBe("rgba(255,255,255,0.1)");
    expect(tokens.selectedSurface).toBe("#3A3A3D");
    expect(tokens.selectionBackground).toBe("#3A3A3D");
    expect(tokens.surface).toBe(MAC_DARK.content);
  });

  test("uses the theme's primary background for the whole window (light)", () => {
    const themeColors = theme(false);
    const tokens = getAppleVisualTokens(themeColors, false);

    expect(tokens.ios).toBe(true);
    expect(tokens.screenBackground).toBe(themeColors.primary.background);
    expect(tokens.sidebarBackground).toBe(themeColors.primary.background);
    expect(tokens.navigationSurface).toBe(themeColors.primary.background);
    expect(tokens.toolbarSurface).toBe(themeColors.primary.background);
    expect(tokens.editorSurround).toBe(themeColors.primary.background);
    expect(tokens.contentSurface).toBe("#FFFFFF");
    expect(tokens.secondarySurface).toBe("#F5F5F7");
    expect(tokens.separator).toBe("#D8D8DA");
    expect(tokens.selectedSurface).toBe("#DCDCE0");
    expect(tokens.selectionBackground).toBe("#DCDCE0");
    expect(tokens.surface).toBe(MAC_LIGHT.content);
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

describe("iOS visual tokens (unchanged)", () => {
  beforeEach(() => {
    mockIsMacCatalyst = false;
  });

  test("keeps the UIKit grouped colors in the dark appearance", () => {
    const tokens = getAppleVisualTokens(theme(true), true);

    expect(tokens.ios).toBe(true);
    expect(tokens.screenBackground).toBe("#000000");
    expect(tokens.sidebarBackground).toBe("#000000");
    expect(tokens.contentSurface).toBe("#1C1C1E");
    expect(tokens.secondarySurface).toBe("#1C1C1E");
    expect(tokens.elevatedSurface).toBe("#1C1C1E");
    expect(tokens.toolbarSurface).toBe("#1C1C1E");
    expect(tokens.navigationSurface).toBe("#000000");
    expect(tokens.editorSurround).toBe("#000000");
    expect(tokens.surface).toBe("#1C1C1E");
    expect(tokens.separator).toBe("#38383A");
    expect(tokens.selectedSurface).toBe("#3A3A3C");
    expect(tokens.selectionBackground).toBe("#3A3A3C");
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
