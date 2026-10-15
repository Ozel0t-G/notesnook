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
 * Tests for the shared Apple surface resolver
 * (`@notesnook/theme`'s `theme-engine/apple-surfaces.ts`).
 *
 * The resolver is imported directly by its relative source path on purpose: it
 * is a pure, dependency-free module (only a type-only import), and the two
 * renderers that consume it -- the native app's `apple-visual-tokens.ts` and the
 * editor WebView (`packages/editor-mobile/src/App.tsx`,
 * `components/editor.tsx`) -- must agree byte for byte. Testing the source (not
 * the built package) also keeps this suite independent of the theme package's
 * build step, and uses the mobile app's existing Jest/ts-jest/babel setup with
 * no new dependency.
 */

import {
  APPLE_SELECTION_ACCENT_MIX,
  APPLE_SURFACE_NEUTRALS,
  isVeyranBuiltInTheme,
  mixHex,
  resolveAppleSurfaces
} from "../../../../packages/theme/src/theme-engine/apple-surfaces";
import type { AppleSurfaceColors } from "../../../../packages/theme/src/theme-engine/apple-surfaces";
import type { ThemeDefinition } from "../../../../packages/theme/src/theme-engine/types";

type ThemeIdentity = Pick<ThemeDefinition, "id" | "colorScheme">;

/** The bundled VeyraN appearances, identified exactly like the engine does. */
const VEYRAN_LIGHT: ThemeIdentity = { id: "veyran-light", colorScheme: "light" };
const VEYRAN_DARK: ThemeIdentity = { id: "veyran-dark", colorScheme: "dark" };

/**
 * The accent-applied colors of a built-in VeyraN theme. The app derives these
 * with `applyAccentChoice` (apps/mobile/app/utils/accent-theme.ts): the theme
 * definition keeps its `id`, only the brand accents change. Two extremes of the
 * palette are reproduced here (Mint and Violet).
 */
const MINT = { light: "#087C3E", dark: "#73DFA0" };
const VIOLET = { light: "#6B46C1", dark: "#B9A2FF" };

const veyranColors = (hex: string): AppleSurfaceColors => ({
  primary: { accent: hex },
  secondary: {},
  selected: {}
});

const SURFACE_ROLES = [
  "windowBackground",
  "sidebarSurface",
  "listSurface",
  "documentSurface",
  "elevatedSurface",
  "fieldSurface",
  "separator"
] as const;

describe("VeyraN built-in neutrals", () => {
  test("light resolves the standard neutral surfaces", () => {
    const surfaces = resolveAppleSurfaces({
      theme: VEYRAN_LIGHT,
      colors: veyranColors(MINT.light),
      isDark: false
    });

    expect(surfaces.usesVeyranNeutrals).toBe(true);
    expect(surfaces.appearance).toBe("light");
    expect(surfaces.sidebarSurface).toBe("#ECEDEF");
    expect(surfaces.listSurface).toBe("#F6F6F8");
    expect(surfaces.documentSurface).toBe("#FFFFFF");
    expect(surfaces.elevatedSurface).toBe("#FFFFFF");
    expect(surfaces.separator).toBe("#D9D9DE");
    // The window chrome behind the toolbar and the note list column are one
    // tone (macOS Notes), the source list and the document their own.
    expect(surfaces.windowBackground).toBe(surfaces.listSurface);
    expect(surfaces.sidebarSurface).not.toBe(surfaces.listSurface);
    expect(surfaces.listSurface).not.toBe(surfaces.documentSurface);
  });

  test("dark resolves the standard neutral surfaces", () => {
    const surfaces = resolveAppleSurfaces({
      theme: VEYRAN_DARK,
      colors: veyranColors(MINT.dark),
      isDark: true
    });

    expect(surfaces.usesVeyranNeutrals).toBe(true);
    expect(surfaces.appearance).toBe("dark");
    expect(surfaces.sidebarSurface).toBe("#252527");
    expect(surfaces.listSurface).toBe("#202023");
    expect(surfaces.documentSurface).toBe("#18181B");
    expect(surfaces.elevatedSurface).toBe("#2B2B2F");
    expect(surfaces.separator).toBe("#36363A");
    expect(surfaces.windowBackground).toBe(surfaces.listSurface);
    expect(surfaces.sidebarSurface).not.toBe(surfaces.listSurface);
    expect(surfaces.listSurface).not.toBe(surfaces.documentSurface);
  });

  test("the appearance is the theme identity unless an explicit flag wins", () => {
    // The identity alone decides light vs dark...
    expect(resolveAppleSurfaces({ theme: VEYRAN_LIGHT }).appearance).toBe(
      "light"
    );
    expect(resolveAppleSurfaces({ theme: VEYRAN_DARK }).appearance).toBe(
      "dark"
    );
    // ...and an explicit flag (the app follows the system appearance) overrides
    // it: a dark-scheme theme in a light system resolves light neutrals.
    const overridden = resolveAppleSurfaces({
      theme: VEYRAN_DARK,
      isDark: false
    });
    expect(overridden.appearance).toBe("light");
    expect(overridden.documentSurface).toBe(
      APPLE_SURFACE_NEUTRALS.light.documentSurface
    );
    // The same theme with no flag keeps its own dark neutrals.
    expect(
      resolveAppleSurfaces({ theme: VEYRAN_DARK }).documentSurface
    ).toBe(APPLE_SURFACE_NEUTRALS.dark.documentSurface);
  });

  test("the neutrals are the documented palette", () => {
    expect(APPLE_SURFACE_NEUTRALS.light).toEqual({
      windowBackground: "#F6F6F8",
      sidebarSurface: "#ECEDEF",
      listSurface: "#F6F6F8",
      documentSurface: "#FFFFFF",
      elevatedSurface: "#FFFFFF",
      separator: "#D9D9DE"
    });
    expect(APPLE_SURFACE_NEUTRALS.dark).toEqual({
      windowBackground: "#202023",
      sidebarSurface: "#252527",
      listSurface: "#202023",
      documentSurface: "#18181B",
      elevatedSurface: "#2B2B2F",
      separator: "#36363A"
    });
  });

  test("only the bundled VeyraN ids select the neutrals", () => {
    expect(isVeyranBuiltInTheme(VEYRAN_LIGHT)).toBe(true);
    expect(isVeyranBuiltInTheme(VEYRAN_DARK)).toBe(true);
    // A light theme is not automatically a VeyraN theme.
    expect(isVeyranBuiltInTheme({ id: "default-light" })).toBe(false);
    expect(isVeyranBuiltInTheme({ id: "my-theme" })).toBe(false);
    expect(isVeyranBuiltInTheme(undefined)).toBe(false);
    expect(isVeyranBuiltInTheme(null)).toBe(false);
  });
});

describe("accent isolation", () => {
  test("Mint and Violet leave every neutral role identical", () => {
    for (const [appearance, theme] of [
      ["light", VEYRAN_LIGHT],
      ["dark", VEYRAN_DARK]
    ] as const) {
      const mint = resolveAppleSurfaces({
        theme,
        colors: veyranColors(MINT[appearance])
      });
      const violet = resolveAppleSurfaces({
        theme,
        colors: veyranColors(VIOLET[appearance])
      });

      for (const role of SURFACE_ROLES)
        expect(violet[role]).toBe(mint[role]);

      // ...and the selection fill is the one place the accent shows up.
      expect(violet.selectionFill).not.toBe(mint.selectionFill);
      expect(violet.accent).toBe(VIOLET[appearance]);
    }
  });

  test("the selection fill is the neutral surface with the accent mixed in", () => {
    const mint = resolveAppleSurfaces({
      theme: VEYRAN_LIGHT,
      colors: veyranColors(MINT.light)
    });
    const violet = resolveAppleSurfaces({
      theme: VEYRAN_DARK,
      colors: veyranColors(VIOLET.dark),
      isDark: true
    });

    expect(mint.selectionFill).toBe(
      mixHex(
        APPLE_SURFACE_NEUTRALS.light.listSurface,
        MINT.light,
        APPLE_SELECTION_ACCENT_MIX.light
      )
    );
    expect(violet.selectionFill).toBe(
      mixHex(
        APPLE_SURFACE_NEUTRALS.dark.listSurface,
        VIOLET.dark,
        APPLE_SELECTION_ACCENT_MIX.dark
      )
    );
    // Never the plain neutral and never an opaque accent.
    expect(mint.selectionFill).not.toBe(
      APPLE_SURFACE_NEUTRALS.light.listSurface
    );
    expect(mint.selectionFill).not.toBe(MINT.light);
  });

  test("a theme without a usable accent keeps the neutral selection fill", () => {
    const surfaces = resolveAppleSurfaces({
      theme: VEYRAN_LIGHT,
      colors: { primary: { accent: "not-a-color" } }
    });

    expect(surfaces.selectionFill).toBe(
      APPLE_SURFACE_NEUTRALS.light.listSurface
    );
  });

  test("hover stays the theme's own (neutral) fill, never the accent", () => {
    const hover = "#00000010";
    const surfaces = resolveAppleSurfaces({
      theme: VEYRAN_LIGHT,
      colors: { primary: { accent: MINT.light, hover } }
    });

    expect(surfaces.hoverFill).toBe(hover);

    const withoutHover = resolveAppleSurfaces({ theme: VEYRAN_DARK });
    expect(withoutHover.hoverFill).toBe("rgba(255, 255, 255, 0.07)");
  });
});

describe("imported and custom themes", () => {
  /** A hand-written theme: its own surfaces, none of them a VeyraN neutral. */
  const customTheme: ThemeIdentity = {
    id: "my-custom-dark",
    colorScheme: "dark"
  };
  const customColors: AppleSurfaceColors = {
    primary: {
      background: "#101014",
      border: "#2A2A31",
      hover: "#ffffff12",
      accent: "#FF9500"
    },
    secondary: { background: "#16161B" },
    selected: { background: "#3A3A45" }
  };

  test("keeps the authored surfaces and never blends the accent into them", () => {
    const surfaces = resolveAppleSurfaces({
      theme: customTheme,
      colors: customColors,
      isDark: true
    });

    expect(surfaces.usesVeyranNeutrals).toBe(false);
    expect(surfaces.windowBackground).toBe("#16161B");
    expect(surfaces.sidebarSurface).toBe("#16161B");
    expect(surfaces.listSurface).toBe("#16161B");
    expect(surfaces.documentSurface).toBe("#101014");
    expect(surfaces.elevatedSurface).toBe("#101014");
    expect(surfaces.fieldSurface).toBe("#16161B");
    expect(surfaces.separator).toBe("#2A2A31");
    // The authored selection and hover are kept as they are.
    expect(surfaces.selectionFill).toBe("#3A3A45");
    expect(surfaces.hoverFill).toBe("#ffffff12");

    // No neutral leaked into any authored surface.
    for (const role of SURFACE_ROLES)
      expect(Object.values(APPLE_SURFACE_NEUTRALS.dark)).not.toContain(
        surfaces[role]
      );
    // ...and the accent was not mixed into the canvas either.
    expect(surfaces.documentSurface).not.toBe(
      mixHex("#101014", "#FF9500", 0.06)
    );
  });

  test("a custom light theme keeps its authored colors too", () => {
    const surfaces = resolveAppleSurfaces({
      theme: { id: "my-custom-light", colorScheme: "light" },
      colors: {
        primary: {
          background: "#FAFAF4",
          border: "#E4E4DC",
          accent: "#123456"
        },
        secondary: { background: "#F0F0E8" }
      },
      isDark: false
    });

    expect(surfaces.usesVeyranNeutrals).toBe(false);
    expect(surfaces.windowBackground).toBe("#F0F0E8");
    expect(surfaces.documentSurface).toBe("#FAFAF4");
    expect(surfaces.separator).toBe("#E4E4DC");
  });

  test("never mutates a frozen theme definition or a frozen palette", () => {
    // `Object.freeze` makes an accidental write throw in strict mode, so this
    // proves the resolver treats both inputs as read-only.
    const theme = Object.freeze({
      id: "my-frozen-theme",
      colorScheme: "dark" as const
    });
    const colors = Object.freeze({
      primary: Object.freeze({
        background: "#101014",
        border: "#2A2A31",
        accent: "#FF9500"
      }),
      secondary: Object.freeze({ background: "#16161B" }),
      selected: Object.freeze({ background: "#3A3A45" })
    });

    const surfaces = resolveAppleSurfaces({ theme, colors, isDark: true });

    expect(surfaces.usesVeyranNeutrals).toBe(false);
    expect(surfaces.documentSurface).toBe("#101014");
    expect(surfaces.windowBackground).toBe("#16161B");
    // The frozen inputs are untouched (a mutation would have thrown above).
    expect(theme.id).toBe("my-frozen-theme");
    expect(colors.primary.background).toBe("#101014");
    expect(colors.selected.background).toBe("#3A3A45");
  });

  test("an empty input degrades to the neutral surfaces, never to undefined", () => {
    const surfaces = resolveAppleSurfaces();

    expect(surfaces.usesVeyranNeutrals).toBe(false);
    expect(surfaces.windowBackground).toBe(
      APPLE_SURFACE_NEUTRALS.light.windowBackground
    );
    expect(surfaces.documentSurface).toBe(
      APPLE_SURFACE_NEUTRALS.light.documentSurface
    );
  });
});

describe("mixHex", () => {
  test("blends, clamps and drops alpha", () => {
    expect(mixHex("#121517", "#73CEFF", 0.06)).toBe("#182025");
    expect(mixHex("#252A2C", "#73CEFF", 0.05)).toBe("#293237");
    expect(mixHex("#112233", "#445566", 0)).toBe("#112233");
    expect(mixHex("#112233", "#445566", 1)).toBe("#445566");
    expect(mixHex("#000000", "#FFFFFF", 2)).toBe("#FFFFFF");
    expect(mixHex("#11223344", "#000000", 0.5)).toBe("#09111A");
    // An unparseable colour leaves the base untouched.
    expect(mixHex("#112233", "rgba(1,2,3,0.5)", 0.5)).toBe("#112233");
    expect(mixHex("#112233", "not-a-colour", 0.5)).toBe("#112233");
  });
});

/*
 * The consumer contract: the native app's `getAppleVisualTokens` runs the
 * resolver on Apple only, so Android and other untouched clients keep exactly
 * the theme aliases they have always had.
 */
type AppleTokens = typeof import("./apple-visual-tokens");
type TokenColors = Parameters<AppleTokens["getAppleVisualTokens"]>[0];

const tokenColors = (): TokenColors =>
  ({
    primary: {
      background: "#101014",
      border: "#2A2A31",
      heading: "#F5F5F5",
      paragraph: "#E0E0E0",
      icon: "#A0A0A0",
      hover: "#ffffff12",
      accent: "#FF9500"
    },
    secondary: {
      background: "#16161B",
      paragraph: "#C8C8C8",
      icon: "#909090"
    },
    selected: {
      background: "#3A3A45",
      accent: "#FF9500"
    }
  } as unknown as TokenColors);

/** Load `apple-visual-tokens` with a specific `Platform.OS`. */
const loadAppleTokens = (os: "ios" | "android"): AppleTokens => {
  jest.resetModules();
  jest.doMock("react-native", () => ({
    Platform: { OS: os },
    NativeModules: {}
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./apple-visual-tokens") as AppleTokens;
};

describe("Apple vs Android consumers (getAppleVisualTokens)", () => {
  afterEach(() => {
    jest.dontMock("react-native");
    jest.resetModules();
  });

  test("Android keeps the theme aliases; Apple takes the resolved roles", () => {
    const colors = tokenColors();
    const android = loadAppleTokens("android").getAppleVisualTokens(
      colors,
      false,
      VEYRAN_LIGHT
    );
    const apple = loadAppleTokens("ios").getAppleVisualTokens(
      colors,
      false,
      VEYRAN_LIGHT
    );

    expect(android.ios).toBe(false);
    expect(apple.ios).toBe(true);

    // Android: byte for byte the theme's own colors (the pre-redesign aliases).
    expect(android.screenBackground).toBe(colors.primary.background);
    expect(android.sidebarBackground).toBe(colors.primary.background);
    expect(android.documentSurface).toBe(colors.primary.background);
    expect(android.contentSurface).toBe(colors.primary.background);
    expect(android.editorSurround).toBe(colors.primary.background);
    expect(android.surface).toBe(colors.primary.background);
    expect(android.secondarySurface).toBe(colors.secondary.background);
    expect(android.elevatedSurface).toBe(colors.secondary.background);
    expect(android.toolbarSurface).toBe(colors.secondary.background);
    expect(android.navigationSurface).toBe(colors.secondary.background);
    expect(android.separator).toBe(colors.primary.border);
    expect(android.selectedSurface).toBe(colors.selected.background);
    expect(android.selectionBackground).toBe(colors.selected.background);
    expect(android.hoverSurface).toBe(colors.primary.hover);

    // Apple: the resolved neutral roles of the bundled VeyraN appearance.
    expect(apple.screenBackground).toBe(
      APPLE_SURFACE_NEUTRALS.light.windowBackground
    );
    expect(apple.documentSurface).toBe(
      APPLE_SURFACE_NEUTRALS.light.documentSurface
    );
    expect(apple.separator).toBe(APPLE_SURFACE_NEUTRALS.light.separator);

    // The difference the two consumers actually see.
    expect(apple.screenBackground).not.toBe(android.screenBackground);
    expect(apple.documentSurface).not.toBe(android.documentSurface);
    expect(apple.separator).not.toBe(android.separator);
    expect(apple.selectedSurface).not.toBe(android.selectedSurface);
  });

  test("an imported theme keeps its authored surfaces on Apple too", () => {
    const colors = tokenColors();
    const apple = loadAppleTokens("ios").getAppleVisualTokens(colors, true, {
      id: "my-custom-dark",
      colorScheme: "dark"
    });

    expect(apple.documentSurface).toBe(colors.primary.background);
    expect(apple.screenBackground).toBe(colors.secondary.background);
    expect(apple.selectionBackground).toBe(colors.selected.background);
  });
});
