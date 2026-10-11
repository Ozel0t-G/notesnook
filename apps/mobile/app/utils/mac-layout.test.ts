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

type MacLayout = typeof import("./mac-layout");

/**
 * `mac-layout` caches the first real toolbar inset at module scope, so every
 * case needs its own freshly loaded copy of the module (and of the mocked
 * native bridge it reads the measurement from).
 */
const loadMacLayout = (toolbarHeight?: number): MacLayout => {
  jest.resetModules();
  jest.doMock("react-native", () => ({
    NativeModules:
      toolbarHeight === undefined ? {} : { VeyraNMacMenu: { toolbarHeight } }
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./mac-layout") as MacLayout;
};

describe("Mac toolbar inset", () => {
  afterEach(() => {
    jest.dontMock("react-native");
    jest.resetModules();
  });

  test("falls back to the constant while nothing is measured yet", () => {
    const { macToolbarInset, MAC_TOOLBAR_HEIGHT } = loadMacLayout(0);

    expect(macToolbarInset(0)).toBe(MAC_TOOLBAR_HEIGHT);
    expect(macToolbarInset(0)).toBe(MAC_TOOLBAR_HEIGHT);
  });

  test("prefers the native measured height over the safe-area inset", () => {
    const { macToolbarInset } = loadMacLayout(48);

    expect(macToolbarInset(0)).toBe(48);
    expect(macToolbarInset(30)).toBe(48);
  });

  test("caches the first real safe-area inset and stops flipping", () => {
    const { macToolbarInset, MAC_TOOLBAR_HEIGHT } = loadMacLayout(0);

    // UIKit has not laid the toolbar out yet: the fallback applies.
    expect(macToolbarInset(0)).toBe(MAC_TOOLBAR_HEIGHT);
    // The first real value is cached...
    expect(macToolbarInset(32)).toBe(32);
    // ...so a later 0 no longer falls back to the constant (R20)...
    expect(macToolbarInset(0)).toBe(32);
    // ...and a changed inset cannot move the laid-out chrome either.
    expect(macToolbarInset(60)).toBe(32);
  });

  test("caches the native measurement when the constant is fresh", () => {
    const { macToolbarInset } = loadMacLayout(44);

    expect(macToolbarInset(0)).toBe(44);
    // The measurement is stable from then on.
    expect(macToolbarInset(32)).toBe(44);
  });

  test("keeps using the safe-area inset when the bridge is not linked", () => {
    const { macToolbarInset, MAC_TOOLBAR_HEIGHT } = loadMacLayout(undefined);

    expect(macToolbarInset(0)).toBe(MAC_TOOLBAR_HEIGHT);
    expect(macToolbarInset(28)).toBe(28);
    expect(macToolbarInset(0)).toBe(28);
  });
});

describe("Mac window background", () => {
  afterEach(() => {
    jest.dontMock("react-native");
    jest.resetModules();
  });

  const colors = { primary: { background: "#101012", accent: "#0A84FF" } };

  test("dark tints the theme's primary background with the accent", () => {
    const {
      macWindowBackground,
      macGlassPanelBackground,
      MAC_DARK_WINDOW_ACCENT_TINT,
      mixHex
    } = loadMacLayout(undefined);
    const window = mixHex(
      colors.primary.background,
      colors.primary.accent,
      MAC_DARK_WINDOW_ACCENT_TINT
    );

    expect(macWindowBackground(colors, true)).toBe(window);
    // The theme's base colour still shows through: only a few percent moved.
    expect(macWindowBackground(colors, true)).not.toBe(
      colors.primary.background
    );
    // The glass panel is documented as the dark window background, so it
    // follows the tint instead of drifting away from the surface it floats on.
    expect(macGlassPanelBackground(colors, true)).toBe(window);
  });

  test("a different accent re-tints the dark window but not the light one", () => {
    const {
      macWindowBackground,
      MAC_LIGHT_WINDOW_BACKGROUND
    } = loadMacLayout(undefined);
    const blue = { primary: { background: "#101012", accent: "#0A84FF" } };
    const orange = { primary: { background: "#101012", accent: "#FF9500" } };

    expect(macWindowBackground(blue, true)).not.toBe(
      macWindowBackground(orange, true)
    );
    // Light mode is a fixed off-white: the accent never reaches it.
    expect(macWindowBackground(blue, false)).toBe(MAC_LIGHT_WINDOW_BACKGROUND);
    expect(macWindowBackground(orange, false)).toBe(
      macWindowBackground(blue, false)
    );
  });

  test("falls back to the plain theme background when there is no accent", () => {
    const { macWindowBackground } = loadMacLayout(undefined);

    expect(
      macWindowBackground({ primary: { background: "#101012" } }, true)
    ).toBe("#101012");
  });

  test("light uses the soft off-white window, never pure white", () => {
    const {
      macWindowBackground,
      macGlassPanelBackground,
      MAC_LIGHT_WINDOW_BACKGROUND,
      MAC_LIGHT_SIDEBAR_BACKGROUND
    } = loadMacLayout(undefined);

    expect(macWindowBackground(colors, false)).toBe(MAC_LIGHT_WINDOW_BACKGROUND);
    expect(macWindowBackground(colors, false)).toBe("#F3F3F5");
    expect(macWindowBackground(colors, false)).not.toBe("#FFFFFF");
    // The glass panel/card is a step darker than the window in light mode.
    expect(macGlassPanelBackground(colors, false)).toBe(
      MAC_LIGHT_SIDEBAR_BACKGROUND
    );
    expect(macGlassPanelBackground(colors, false)).toBe("#E9E9EC");
  });
});

describe("mixHex", () => {
  afterEach(() => {
    jest.dontMock("react-native");
    jest.resetModules();
  });

  test("blends the requested percentage of one colour into another", () => {
    const { mixHex } = loadMacLayout(undefined);

    // The design mockup's Sky dark surfaces: the charcoal bases with 5-6% of
    // the accent blended in.
    expect(mixHex("#121517", "#73CEFF", 0.06)).toBe("#182025");
    expect(mixHex("#252A2C", "#73CEFF", 0.05)).toBe("#293237");
    expect(mixHex("#fff", "#000", 0.5)).toBe("#808080");
  });

  test("returns the base colour at both ends of the range", () => {
    const { mixHex } = loadMacLayout(undefined);

    expect(mixHex("#112233", "#445566", 0)).toBe("#112233");
    expect(mixHex("#112233", "#445566", 1)).toBe("#445566");
    // Out-of-range amounts are clamped, not extrapolated.
    expect(mixHex("#112233", "#FFFFFF", -1)).toBe("#112233");
    expect(mixHex("#000000", "#FFFFFF", 2)).toBe("#FFFFFF");
  });

  test("drops alpha and normalises the output case", () => {
    const { mixHex } = loadMacLayout(undefined);

    expect(mixHex("#11223344", "#000000", 0.5)).toBe("#09111A");
    expect(mixHex("#aabbcc", "#aabbcc", 0.5)).toBe("#AABBCC");
  });

  test("returns the base unchanged when a colour cannot be parsed", () => {
    const { mixHex } = loadMacLayout(undefined);

    // The dark Mac separator is an rgba() string: it must survive untouched.
    expect(mixHex("#112233", "rgba(1,2,3,0.5)", 0.5)).toBe("#112233");
    expect(mixHex("#112233", "not-a-colour", 0.5)).toBe("#112233");
    expect(mixHex("rgba(1,2,3,0.5)", "#112233", 0.5)).toBe("rgba(1,2,3,0.5)");
  });
});

describe("sidebar auto-collapse (R10)", () => {
  const {
    macSidebarAutoCollapsed,
    macSidebarEffectiveVisible,
    MAC_SIDEBAR_AUTO_COLLAPSE_WIDTH
  } = loadMacLayout(undefined);

  test("collapses below the breakpoint only", () => {
    expect(macSidebarAutoCollapsed(900)).toBe(true);
    expect(macSidebarAutoCollapsed(MAC_SIDEBAR_AUTO_COLLAPSE_WIDTH - 1)).toBe(
      true
    );
    expect(macSidebarAutoCollapsed(MAC_SIDEBAR_AUTO_COLLAPSE_WIDTH)).toBe(
      false
    );
    expect(macSidebarAutoCollapsed(1400)).toBe(false);
  });

  test("follows the window without a manual choice", () => {
    expect(macSidebarEffectiveVisible(900)).toBe(false);
    expect(macSidebarEffectiveVisible(1400)).toBe(true);
  });

  test("a manual choice holds on the side of the breakpoint it was made on", () => {
    // Opened by hand in a narrow window.
    const opened = { narrow: true, visible: true };
    expect(macSidebarEffectiveVisible(900, opened)).toBe(true);
    // Crossing the breakpoint hands control back to the automatic rule.
    expect(macSidebarEffectiveVisible(1400, opened)).toBe(true);
    // Hidden by hand in a wide window.
    const closed = { narrow: false, visible: false };
    expect(macSidebarEffectiveVisible(1400, closed)).toBe(false);
    expect(macSidebarEffectiveVisible(900, closed)).toBe(false);
  });

  test("an override from the other side is ignored", () => {
    expect(
      macSidebarEffectiveVisible(1400, { narrow: true, visible: false })
    ).toBe(true);
    expect(
      macSidebarEffectiveVisible(900, { narrow: false, visible: true })
    ).toBe(false);
  });
});
