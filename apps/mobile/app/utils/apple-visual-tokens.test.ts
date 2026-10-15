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

/*
 * The native Apple tokens under the 2026 neutral-surface contract
 * (docs/APPLE_DESIGN_SYSTEM.md §2): the big surfaces are neutral (the standard
 * VeyraN palette for the bundled appearances, the theme's own authored colors
 * for anything imported) and the accent reaches only the interactive
 * affordances. Android and other clients are untouched: they keep the aliases
 * the theme itself provides.
 */

import {
  APPLE_SELECTION_ACCENT_MIX,
  APPLE_SURFACE_NEUTRALS,
  mixHex
} from "@notesnook/theme";

type AppleTokens = typeof import("./apple-visual-tokens");

/**
 * Load the token module with a specific `Platform.OS`. The module caches
 * nothing at import time, but every platform gets its own freshly loaded copy
 * (and its own mocked native bridge) so a case cannot leak a Platform into the
 * next one.
 */
const loadAppleTokens = (os: "ios" | "android"): AppleTokens => {
  jest.resetModules();
  jest.doMock("react-native", () => ({
    Platform: { OS: os },
    NativeModules: {}
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./apple-visual-tokens") as AppleTokens;
};

type ThemeColors = Parameters<
  AppleTokens["getAppleVisualTokens"]
>[0];

/** The bundled VeyraN appearances, identified exactly like the engine does. */
const VEYRAN_LIGHT = { id: "veyran-light", colorScheme: "light" as const };
const VEYRAN_DARK = { id: "veyran-dark", colorScheme: "dark" as const };

/**
 * A dark/light theme whose own colors repeat no neutral value, so a returned
 * neutral can only come from the resolved Apple role under test.
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

/** The same theme with only the accent replaced. */
const withAccent = (colors: ThemeColors, accent: string): ThemeColors =>
  ({
    ...colors,
    primary: { ...colors.primary, accent },
    selected: { ...colors.selected, accent }
  } as ThemeColors);

/** The neutral roles: no accent is allowed to move any of these. */
const NEUTRAL_KEYS = [
  "screenBackground",
  "sidebarBackground",
  "navigationSurface",
  "contentSurface",
  "secondarySurface",
  "elevatedSurface",
  "toolbarSurface",
  "editorSurround",
  "surface",
  "separator",
  "hoverSurface"
] as const;

/** The interactive affordances: the accent-bearing surfaces. */
const AFFORDANCE_KEYS = ["selectedSurface", "selectionBackground"] as const;

describe("Apple visual tokens (bundled VeyraN appearance)", () => {
  afterEach(() => {
    jest.dontMock("react-native");
    jest.resetModules();
  });

  test("light resolves the neutral surfaces, not the theme's own colors", () => {
    const colors = theme(false);
    const tokens = loadAppleTokens("ios").getAppleVisualTokens(
      colors,
      false,
      VEYRAN_LIGHT
    );

    expect(tokens.ios).toBe(true);
    expect(tokens.screenBackground).toBe("#F6F6F8");
    expect(tokens.sidebarBackground).toBe("#ECEDEF");
    expect(tokens.navigationSurface).toBe("#ECEDEF");
    expect(tokens.listSurface).toBe("#F6F6F8");
    expect(tokens.documentSurface).toBe("#FFFFFF");
    // Cards/fields/settings rows float above the canvas.
    expect(tokens.contentSurface).toBe("#FFFFFF");
    expect(tokens.elevatedSurface).toBe("#FFFFFF");
    expect(tokens.toolbarSurface).toBe("#FFFFFF");
    expect(tokens.editorSurround).toBe("#FFFFFF");
    expect(tokens.surface).toBe("#FFFFFF");
    // The light field fill is the recessed list tone.
    expect(tokens.secondarySurface).toBe("#F6F6F8");
    expect(tokens.separator).toBe("#D9D9DE");

    // The theme's own near-white was replaced, not merely nudged.
    expect(tokens.screenBackground).not.toBe(colors.primary.background);
    expect(tokens.documentSurface).not.toBe(colors.primary.background);

    // Selection is the one place the accent reaches a surface.
    expect(tokens.selectedSurface).toBe(
      mixHex(
        APPLE_SURFACE_NEUTRALS.light.listSurface,
        colors.primary.accent as string,
        APPLE_SELECTION_ACCENT_MIX.light
      )
    );
    expect(tokens.selectionBackground).toBe(tokens.selectedSurface);
    expect(tokens.selectedSurface).not.toBe(colors.selected.background);
    // Hover stays the theme's own fill.
    expect(tokens.hoverSurface).toBe(colors.primary.hover);
  });

  test("dark resolves the neutral surfaces too", () => {
    const colors = theme(true);
    const tokens = loadAppleTokens("ios").getAppleVisualTokens(
      colors,
      true,
      VEYRAN_DARK
    );

    expect(tokens.screenBackground).toBe("#202023");
    expect(tokens.sidebarBackground).toBe("#252527");
    expect(tokens.navigationSurface).toBe("#252527");
    expect(tokens.listSurface).toBe("#202023");
    expect(tokens.documentSurface).toBe("#18181B");
    expect(tokens.contentSurface).toBe("#2B2B2F");
    expect(tokens.elevatedSurface).toBe("#2B2B2F");
    expect(tokens.toolbarSurface).toBe("#2B2B2F");
    expect(tokens.editorSurround).toBe("#18181B");
    expect(tokens.surface).toBe("#2B2B2F");
    // The dark field fill is the raised elevated tone.
    expect(tokens.secondarySurface).toBe("#2B2B2F");
    expect(tokens.separator).toBe("#36363A");

    expect(tokens.screenBackground).not.toBe(colors.primary.background);
    expect(tokens.selectedSurface).toBe(
      mixHex(
        APPLE_SURFACE_NEUTRALS.dark.listSurface,
        colors.primary.accent as string,
        APPLE_SELECTION_ACCENT_MIX.dark
      )
    );
    // ...and the seam between the old tinted window and the neutral one: the
    // window is no longer the theme background blended with the accent.
    expect(tokens.screenBackground).not.toBe(
      mixHex(colors.primary.background, colors.primary.accent as string, 0.06)
    );
  });

  test("a different accent moves only the interactive affordances", () => {
    const blue = loadAppleTokens("ios").getAppleVisualTokens(
      theme(true),
      true,
      VEYRAN_DARK
    );
    const orange = loadAppleTokens("ios").getAppleVisualTokens(
      withAccent(theme(true), "#FF9500"),
      true,
      VEYRAN_DARK
    );

    for (const key of NEUTRAL_KEYS) expect(orange[key]).toBe(blue[key]);
    for (const key of AFFORDANCE_KEYS)
      expect(orange[key]).not.toBe(blue[key]);
  });

  test("an imported theme keeps its authored surfaces", () => {
    const colors = theme(true);
    const tokens = loadAppleTokens("ios").getAppleVisualTokens(colors, true, {
      id: "my-custom-dark",
      colorScheme: "dark"
    });

    expect(tokens.ios).toBe(true);
    expect(tokens.screenBackground).toBe(colors.secondary.background);
    expect(tokens.sidebarBackground).toBe(colors.secondary.background);
    expect(tokens.navigationSurface).toBe(colors.secondary.background);
    expect(tokens.documentSurface).toBe(colors.primary.background);
    expect(tokens.editorSurround).toBe(colors.primary.background);
    expect(tokens.contentSurface).toBe(colors.primary.background);
    expect(tokens.surface).toBe(colors.primary.background);
    expect(tokens.secondarySurface).toBe(colors.secondary.background);
    expect(tokens.separator).toBe(colors.primary.border);
    expect(tokens.selectedSurface).toBe(colors.selected.background);
    expect(tokens.selectionBackground).toBe(colors.selected.background);
    expect(tokens.hoverSurface).toBe(colors.primary.hover);
    // No neutral leaked into a custom theme.
    expect(tokens.screenBackground).not.toBe(
      APPLE_SURFACE_NEUTRALS.dark.windowBackground
    );
    expect(tokens.documentSurface).not.toBe(
      APPLE_SURFACE_NEUTRALS.dark.documentSurface
    );
  });
});

describe("Android and other non-Apple clients", () => {
  afterEach(() => {
    jest.dontMock("react-native");
    jest.resetModules();
  });

  test("keeps the theme aliases, byte for byte", () => {
    const colors = theme(true);
    const tokens = loadAppleTokens("android").getAppleVisualTokens(
      colors,
      true,
      VEYRAN_DARK
    );

    expect(tokens.ios).toBe(false);
    expect(tokens.screenBackground).toBe(colors.primary.background);
    expect(tokens.sidebarBackground).toBe(colors.primary.background);
    expect(tokens.navigationSurface).toBe(colors.secondary.background);
    expect(tokens.documentSurface).toBe(colors.primary.background);
    expect(tokens.contentSurface).toBe(colors.primary.background);
    expect(tokens.editorSurround).toBe(colors.primary.background);
    expect(tokens.elevatedSurface).toBe(colors.secondary.background);
    expect(tokens.toolbarSurface).toBe(colors.secondary.background);
    expect(tokens.surface).toBe(colors.primary.background);
    expect(tokens.secondarySurface).toBe(colors.secondary.background);
    expect(tokens.separator).toBe(colors.primary.border);
    expect(tokens.selectedSurface).toBe(colors.selected.background);
    expect(tokens.selectionBackground).toBe(colors.selected.background);
    expect(tokens.hoverSurface).toBe(colors.primary.hover);
    // The resolver never ran: no Apple neutral shows up on Android.
    for (const key of NEUTRAL_KEYS) {
      expect(Object.values(APPLE_SURFACE_NEUTRALS.dark)).not.toContain(
        tokens[key]
      );
      expect(Object.values(APPLE_SURFACE_NEUTRALS.light)).not.toContain(
        tokens[key]
      );
    }
  });
});

describe("layout geometry", () => {
  afterEach(() => {
    jest.dontMock("react-native");
    jest.resetModules();
  });

  const iosGeometry = {
    cardRadius: 20,
    buttonRadius: 16,
    controlRadius: 16,
    sectionRadius: 22,
    sheetRadius: 24,
    pagePadding: 16,
    sectionSpacing: 20,
    rowPadding: 16,
    sidebarPadding: 12,
    listInset: 16,
    rowInset: 18,
    rowSpacing: 0
  } as const;

  test("Apple keeps the iOS metrics whatever the theme or appearance", () => {
    const colors = theme(false);
    const veyranLight = loadAppleTokens("ios").getAppleVisualTokens(
      colors,
      false,
      VEYRAN_LIGHT
    );
    const custom = loadAppleTokens("ios").getAppleVisualTokens(colors, true, {
      id: "my-custom-dark",
      colorScheme: "dark"
    });

    for (const [key, value] of Object.entries(iosGeometry)) {
      expect(veyranLight[key as keyof typeof iosGeometry]).toBe(value);
      expect(custom[key as keyof typeof iosGeometry]).toBe(value);
    }
    // The layout numbers follow the platform, never the surface resolution.
    expect(veyranLight.cardRadius).toBe(custom.cardRadius);
  });

  test("Android keeps its own (smaller) metrics", () => {
    const tokens = loadAppleTokens("android").getAppleVisualTokens(
      theme(true),
      true
    );

    expect(tokens.cardRadius).toBe(18);
    expect(tokens.buttonRadius).toBe(14);
    expect(tokens.controlRadius).toBe(14);
    expect(tokens.sectionRadius).toBe(18);
    expect(tokens.sheetRadius).toBe(15);
    expect(tokens.pagePadding).toBe(12);
    expect(tokens.sectionSpacing).toBe(10);
    expect(tokens.rowPadding).toBe(12);
    expect(tokens.sidebarPadding).toBe(8);
    expect(tokens.listInset).toBe(12);
    expect(tokens.rowSpacing).toBe(6);
  });
});
