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

// Pure helper tests: no react-native, no MMKV, no stores. `@notesnook/theme` is
// imported for the real bundled appearances so the suite proves the palette
// behaves on the themes people actually have, not just on a fixture.

import { ThemeDefinition, ThemeVeyranDark, ThemeVeyranLight } from "@notesnook/theme";
import {
  ACCENT_CHOICES,
  DEFAULT_ACCENT_CHOICE_ID,
  MINT_ACCENT_DARK,
  MINT_ACCENT_LIGHT,
  THEME_COLOR_ACCENT_ID,
  accentChoiceAccessibilityLabel,
  accentChoiceLabel,
  accentHexForChoice,
  accentPaletteHeading,
  accentSwatchColor,
  applyAccentChoice,
  contrastForeground,
  contrastRatio,
  isContrastSafe,
  isGermanLocale,
  isVeyranBuiltInTheme,
  normalizeAccentChoiceId,
  relativeLuminance,
  sanitizePersistedAccentChoiceId,
  resolveAccentChoiceId,
  withAccent
} from "./accent-theme";
import { migrateLegacyDefaultTheme } from "./veyran-theme-migration";

/** A compact theme shaped like a real imported one. */
function customTheme(id = "my-imported-theme"): ThemeDefinition {
  return {
    ...ThemeVeyranDark,
    id,
    name: "My imported theme",
    scopes: {
      ...ThemeVeyranDark.scopes,
      base: {
        ...ThemeVeyranDark.scopes.base,
        primary: {
          ...ThemeVeyranDark.scopes.base.primary,
          accent: "#C58AF9",
          accentForeground: "#1B0A2A",
          background: "#101014"
        }
      },
      list: {
        ...ThemeVeyranDark.scopes.list,
        primary: {
          ...ThemeVeyranDark.scopes.list?.primary,
          accent: "#C58AF9",
          accentForeground: "#1B0A2A"
        }
      },
      navigationMenu: {
        ...ThemeVeyranDark.scopes.navigationMenu,
        primary: {
          ...ThemeVeyranDark.scopes.navigationMenu?.primary,
          accent: "#C58AF9"
        }
      },
      sheet: {
        ...ThemeVeyranDark.scopes.sheet,
        selected: {
          ...ThemeVeyranDark.scopes.sheet?.selected,
          accent: "#C58AF9",
          accentForeground: "#1B0A2A"
        }
      }
    }
  };
}

/** The same imported shape on a light surface, to prove pair selection. */
function customLightTheme(id = "my-imported-light-theme"): ThemeDefinition {
  return { ...customTheme(id), colorScheme: "light" };
}

describe("accent palette definitions", () => {
  test("leads with the fresh mint default as a light/dark pair", () => {
    expect(ACCENT_CHOICES[0].id).toBe(DEFAULT_ACCENT_CHOICE_ID);
    expect(ACCENT_CHOICES[0].light).toBe(MINT_ACCENT_LIGHT);
    expect(ACCENT_CHOICES[0].dark).toBe(MINT_ACCENT_DARK);
    expect(MINT_ACCENT_LIGHT).toBe("#087C3E");
    expect(MINT_ACCENT_DARK).toBe("#73DFA0");
    // The old single bright hex is gone: it was illegible on a white surface.
    expect(MINT_ACCENT_LIGHT).not.toBe(MINT_ACCENT_DARK);
  });

  test("offers several tasteful choices plus exactly one theme-color fallback", () => {
    const colors = ACCENT_CHOICES.filter((choice) => !!choice.light);
    expect(colors.length).toBeGreaterThanOrEqual(5);
    expect(
      ACCENT_CHOICES.filter((choice) => !choice.light).map((choice) => choice.id)
    ).toEqual([THEME_COLOR_ACCENT_ID]);
  });

  test("has unique ids and only opaque six-digit hex colors, light and dark", () => {
    const ids = ACCENT_CHOICES.map((choice) => choice.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const choice of ACCENT_CHOICES) {
      // A preset always carries both halves of its pair, or neither.
      expect(!!choice.light).toBe(!!choice.dark);
      for (const hex of [choice.light, choice.dark]) {
        if (!hex) continue;
        expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });
});

describe("selection resolution", () => {
  test("defaults to mint on the built-in VeyraN appearance", () => {
    expect(isVeyranBuiltInTheme(ThemeVeyranLight)).toBe(true);
    expect(isVeyranBuiltInTheme(ThemeVeyranDark)).toBe(true);
    expect(resolveAccentChoiceId(undefined, ThemeVeyranDark)).toBe("mint");
    expect(resolveAccentChoiceId(undefined, ThemeVeyranLight)).toBe("mint");
  });

  test("falls back to the theme's own color for imported/custom themes", () => {
    const custom = customTheme();
    expect(isVeyranBuiltInTheme(custom)).toBe(false);
    expect(resolveAccentChoiceId(undefined, custom)).toBe(
      THEME_COLOR_ACCENT_ID
    );
    expect(accentHexForChoice(undefined, custom)).toBeUndefined();
    // The fallback is the theme itself, untouched.
    expect(applyAccentChoice(custom, undefined)).toBe(custom);
  });

  test("an explicit choice wins on every theme", () => {
    const custom = customTheme();
    expect(resolveAccentChoiceId("violet", custom)).toBe("violet");
    expect(accentHexForChoice("violet", custom)).toBe("#B9A2FF");
    expect(applyAccentChoice(custom, "violet")).not.toBe(custom);
  });

  test("picks the pair half matching the theme's own colorScheme", () => {
    const light = customLightTheme();
    const dark = customTheme();
    // accentHexForChoice follows the theme, not a caller-supplied scheme.
    expect(accentHexForChoice("mint", light)).toBe("#087C3E");
    expect(accentHexForChoice("mint", dark)).toBe("#73DFA0");
    expect(accentHexForChoice("sky", light)).toBe("#006A9B");
    expect(accentHexForChoice("sky", dark)).toBe("#73CEFF");
    expect(accentHexForChoice("violet", light)).toBe("#6B46C1");
    expect(accentHexForChoice("violet", dark)).toBe("#B9A2FF");
    expect(accentHexForChoice("rose", light)).toBe("#B83256");
    expect(accentHexForChoice("rose", dark)).toBe("#FF8FA8");
    expect(accentHexForChoice("amber", light)).toBe("#8A5900");
    expect(accentHexForChoice("amber", dark)).toBe("#FFD26E");
    expect(accentHexForChoice("graphite", light)).toBe("#475569");
    expect(accentHexForChoice("graphite", dark)).toBe("#C0CBD6");
    // An absent scheme degrades to the light half, never to an unknown color.
    expect(accentHexForChoice("mint", { id: "veyran-dark" })).toBe("#087C3E");
  });

  test("accepts only known palette ids, so old/corrupt settings load safely", () => {
    expect(normalizeAccentChoiceId("mint")).toBe("mint");
    expect(normalizeAccentChoiceId(THEME_COLOR_ACCENT_ID)).toBe(
      THEME_COLOR_ACCENT_ID
    );
    for (const junk of [
      undefined,
      null,
      0,
      1,
      "",
      "MINT",
      "bogus",
      {},
      [],
      "#34D399"
    ])
      expect(normalizeAccentChoiceId(junk)).toBeUndefined();
    // Unknown values resolve to automatic, never to a guessed color.
    expect(resolveAccentChoiceId("bogus", ThemeVeyranDark)).toBe("mint");
    expect(resolveAccentChoiceId("bogus", customTheme())).toBe(
      THEME_COLOR_ACCENT_ID
    );
  });

  test("persists unknown ids byte-for-byte but drops only corrupt accent values", () => {
    expect(sanitizePersistedAccentChoiceId("mint")).toBe("mint");
    expect(sanitizePersistedAccentChoiceId("future-palette-id")).toBe(
      "future-palette-id"
    );
    // No trim/normalize/case-fold: the string is preserved exactly.
    expect(sanitizePersistedAccentChoiceId(" vibe ")).toBe(" vibe ");
    expect(sanitizePersistedAccentChoiceId(THEME_COLOR_ACCENT_ID)).toBe(
      THEME_COLOR_ACCENT_ID
    );
    for (const junk of [undefined, null, 0, 1, true, "", {}, []])
      expect(sanitizePersistedAccentChoiceId(junk)).toBeUndefined();
  });

  test("labels and swatches always render a selection", () => {
    expect(accentChoiceLabel("bogus", ThemeVeyranDark, "en")).toBe("Mint");
    expect(accentChoiceLabel(undefined, customTheme(), "en-US")).toBe(
      "Theme color"
    );
    expect(accentChoiceLabel("rose", customTheme(), "en")).toBe("Rose");
    const themeColor = ACCENT_CHOICES.find(
      (choice) => choice.id === THEME_COLOR_ACCENT_ID
    )!;
    expect(accentSwatchColor(themeColor, ThemeVeyranDark)).toBe(
      ThemeVeyranDark.scopes.base.primary.accent
    );
    expect(accentSwatchColor(themeColor, ThemeVeyranLight)).toBe(
      ThemeVeyranLight.scopes.base.primary.accent
    );
    // The mint swatch follows the theme's own surface.
    expect(accentSwatchColor(ACCENT_CHOICES[0], ThemeVeyranDark)).toBe(
      MINT_ACCENT_DARK
    );
    expect(accentSwatchColor(ACCENT_CHOICES[0], ThemeVeyranLight)).toBe(
      MINT_ACCENT_LIGHT
    );
  });

  test("renders the palette in German on a German locale", () => {
    expect(isGermanLocale("de")).toBe(true);
    expect(isGermanLocale("de-DE")).toBe(true);
    expect(isGermanLocale("de_AT")).toBe(true);
    expect(isGermanLocale("en")).toBe(false);
    expect(isGermanLocale("en-US")).toBe(false);
    expect(isGermanLocale(undefined)).toBe(false);

    expect(accentPaletteHeading("de-DE")).toBe("Akzentfarbe");
    expect(accentPaletteHeading("en-US")).toBe("Accent color");

    expect(accentChoiceLabel("mint", ThemeVeyranDark, "de")).toBe("Minze");
    expect(accentChoiceLabel("sky", ThemeVeyranDark, "de-DE")).toBe(
      "Himmelblau"
    );
    expect(accentChoiceLabel("violet", ThemeVeyranDark, "de-DE")).toBe(
      "Violett"
    );
    expect(accentChoiceLabel("rose", ThemeVeyranDark, "de-DE")).toBe("Rosé");
    expect(accentChoiceLabel("amber", ThemeVeyranDark, "de-DE")).toBe(
      "Bernstein"
    );
    expect(accentChoiceLabel("graphite", ThemeVeyranDark, "de-DE")).toBe(
      "Graphit"
    );
    // The "theme color" entry and an automatic fallback both localize.
    expect(
      accentChoiceLabel(THEME_COLOR_ACCENT_ID, ThemeVeyranDark, "de")
    ).toBe("Themenfarbe");
    expect(accentChoiceLabel(undefined, customTheme(), "de-DE")).toBe(
      "Themenfarbe"
    );
    expect(accentChoiceAccessibilityLabel("mint", ThemeVeyranDark, "de")).toBe(
      "Minze Akzent"
    );
    expect(
      accentChoiceAccessibilityLabel("mint", ThemeVeyranDark, "en")
    ).toBe("Mint accent");
    // Every entry has a German label, so no choice ever falls back to English.
    for (const choice of ACCENT_CHOICES)
      expect(accentChoiceLabel(choice.id, ThemeVeyranDark, "de")).not.toBe("");
  });
});

describe("deriving the effective theme", () => {
  test("recolors every brand variant the theme declares", () => {
    const themed = applyAccentChoice(ThemeVeyranDark, "mint");
    expect(themed.scopes.base.primary.accent).toBe(MINT_ACCENT_DARK);
    expect(themed.scopes.base.secondary.accent).toBe(MINT_ACCENT_DARK);
    expect(themed.scopes.base.selected.accent).toBe(MINT_ACCENT_DARK);
    // The same choice on a light surface paints the light half of the pair.
    const lightThemed = applyAccentChoice(ThemeVeyranLight, "mint");
    expect(lightThemed.scopes.base.primary.accent).toBe(MINT_ACCENT_LIGHT);
    expect(lightThemed.scopes.base.secondary.accent).toBe(MINT_ACCENT_LIGHT);
    expect(lightThemed.scopes.base.selected.accent).toBe(MINT_ACCENT_LIGHT);
    // Scopes without their own accent (VeyraN's list/navigationMenu) inherit
    // the recolored base accent through the engine's own fallback.
    expect(themed.scopes.list?.primary?.accent).toBeUndefined();
    expect(themed.scopes.navigationMenu?.primary?.accent).toBeUndefined();
    for (const scope of Object.keys(themed.scopes) as (keyof typeof themed.scopes)[]) {
      const variants = themed.scopes[scope];
      if (!variants) continue;
      for (const variant of ["primary", "secondary", "selected"] as const) {
        const colors = variants[variant];
        if (!colors?.accent) continue;
        expect(colors.accent).toBe(MINT_ACCENT_DARK);
      }
    }
  });

  test("recolors navigation and list scopes too when the theme declares them", () => {
    const themed = applyAccentChoice(customTheme(), "sky");
    expect(themed.scopes.list?.primary?.accent).toBe("#73CEFF");
    expect(themed.scopes.list?.primary?.accentForeground).toBe(
      contrastForeground("#73CEFF")
    );
    expect(themed.scopes.navigationMenu?.primary?.accent).toBe("#73CEFF");
    expect(themed.scopes.navigationMenu?.primary?.accentForeground).toBeDefined();
    // A `selected` variant in a partial scope is covered as well.
    expect(themed.scopes.sheet?.selected?.accent).toBe("#73CEFF");
    // The same choice on the light fixture uses the light half everywhere.
    const lightThemed = applyAccentChoice(customLightTheme(), "sky");
    expect(lightThemed.scopes.base.primary.accent).toBe("#006A9B");
    expect(lightThemed.scopes.list?.primary?.accent).toBe("#006A9B");
    expect(lightThemed.scopes.navigationMenu?.primary?.accent).toBe("#006A9B");
    expect(lightThemed.scopes.sheet?.selected?.accent).toBe("#006A9B");
  });

  test("sets a contrast-safe accentForeground wherever it sets an accent", () => {
    const themed = applyAccentChoice(customTheme(), "amber");
    const foregrounds = [
      themed.scopes.base.primary,
      themed.scopes.base.secondary,
      themed.scopes.base.selected,
      themed.scopes.list?.primary,
      themed.scopes.navigationMenu?.primary
    ];
    for (const colors of foregrounds) {
      const accent = colors?.accent;
      const foreground = colors?.accentForeground;
      expect(accent).toBe("#FFD26E");
      expect(foreground).toBeDefined();
      expect(isContrastSafe(accent as string, foreground as string)).toBe(true);
    }
  });

  test("never touches semantic error/success or the muted disabled accent", () => {
    const themed = applyAccentChoice(ThemeVeyranLight, "rose");
    expect(themed.scopes.base.error).toEqual(ThemeVeyranLight.scopes.base.error);
    expect(themed.scopes.base.success).toEqual(
      ThemeVeyranLight.scopes.base.success
    );
    expect(themed.scopes.base.disabled).toEqual(
      ThemeVeyranLight.scopes.base.disabled
    );
    expect(themed.scopes.base.error.accent).toBe(
      ThemeVeyranLight.scopes.base.error.accent
    );
    expect(themed.scopes.base.success.accent).toBe(
      ThemeVeyranLight.scopes.base.success.accent
    );
  });

  test("preserves everything else: identity, background, other colors and the author's definitions", () => {
    const theme = customTheme();
    const before = JSON.stringify(theme);
    const themed = applyAccentChoice(theme, "sky");
    expect(JSON.stringify(theme)).toBe(before);
    expect(themed).not.toBe(theme);
    expect(themed.id).toBe(theme.id);
    expect(themed.name).toBe(theme.name);
    expect(themed.colorScheme).toBe(theme.colorScheme);
    expect(themed.scopes.base.primary.background).toBe(
      theme.scopes.base.primary.background
    );
    expect(themed.scopes.base.primary.paragraph).toBe(
      theme.scopes.base.primary.paragraph
    );
    expect(themed.scopes.base.error).toEqual(theme.scopes.base.error);
    // Unchanged scopes/variants are shared by reference, not cloned.
    expect(themed.scopes.base.disabled).toBe(theme.scopes.base.disabled);
  });

  test("does not mutate a frozen theme either", () => {
    const theme = customTheme("frozen-theme");
    const deepFreeze = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    };
    deepFreeze(theme);
    expect(() => applyAccentChoice(theme, "violet")).not.toThrow();
    expect(applyAccentChoice(theme, "violet").scopes.base.primary.accent).toBe(
      "#B9A2FF"
    );
    // A frozen light theme takes the light half, still without mutating.
    const lightTheme = Object.freeze(customLightTheme("frozen-light-theme"));
    expect(
      applyAccentChoice(lightTheme, "violet").scopes.base.primary.accent
    ).toBe("#6B46C1");
  });

  test("is idempotent and ignores an unparseable accent, on both pair halves", () => {
    const dark = withAccent(ThemeVeyranDark, MINT_ACCENT_DARK);
    expect(withAccent(dark, MINT_ACCENT_DARK)).toBe(dark);
    const light = withAccent(ThemeVeyranLight, MINT_ACCENT_LIGHT);
    expect(withAccent(light, MINT_ACCENT_LIGHT)).toBe(light);
    expect(withAccent(ThemeVeyranDark, "not-a-color")).toBe(ThemeVeyranDark);
    expect(withAccent(ThemeVeyranDark, "#12345")).toBe(ThemeVeyranDark);
  });
});

describe("share extension theme derivation", () => {
  // The share extension composes the same two steps as the app: migrate a
  // legacy shipped default to VeyraN, then fold in the persisted accent choice.
  // The order matters: running the accent first would leave the legacy id in
  // place and resolve to "theme color" instead of the mint default.
  const derive = (base: ThemeDefinition | undefined, accentColor: unknown) =>
    applyAccentChoice(
      migrateLegacyDefaultTheme(base, "default-dark", ThemeVeyranDark) ??
        ThemeVeyranDark,
      accentColor
    );

  const deriveLight = (
    base: ThemeDefinition | undefined,
    accentColor: unknown
  ) =>
    applyAccentChoice(
      migrateLegacyDefaultTheme(base, "default-light", ThemeVeyranLight) ??
        ThemeVeyranLight,
      accentColor
    );

  test("gives a migrated legacy default the mint accent, not the theme's own", () => {
    const legacy = { ...ThemeVeyranDark, id: "default-dark" };
    const derived = derive(legacy, undefined);
    expect(derived.id).toBe("veyran-dark");
    expect(derived.scopes.base.primary.accent).toBe(MINT_ACCENT_DARK);

    // A legacy light default migrates to VeyraN light and the light half.
    const legacyLight = { ...ThemeVeyranLight, id: "default-light" };
    const derivedLight = deriveLight(legacyLight, undefined);
    expect(derivedLight.id).toBe("veyran-light");
    expect(derivedLight.scopes.base.primary.accent).toBe(MINT_ACCENT_LIGHT);
  });

  test("applies an explicit choice and preserves an imported theme with none", () => {
    expect(derive(undefined, "sky").scopes.base.primary.accent).toBe("#73CEFF");
    expect(deriveLight(undefined, "sky").scopes.base.primary.accent).toBe(
      "#006A9B"
    );
    const imported = customTheme();
    expect(derive(imported, undefined)).toBe(imported);
    expect(derive(imported, "violet").scopes.base.primary.accent).toBe("#B9A2FF");
  });
});

describe("contrast", () => {
  // The two surfaces the palette actually paints on: the light app background
  // and the widget card's dark surface (NotesWidget.swift). A preset must be
  // legible on the half it is used for, which is the whole point of the pair.
  const LIGHT_SURFACE = "#FFFFFF";
  const DARK_SURFACE = "#182328";

  test("every preset clears WCAG AA on both of its surfaces", () => {
    for (const choice of ACCENT_CHOICES) {
      if (!choice.light || !choice.dark) continue;
      expect(contrastRatio(choice.light, LIGHT_SURFACE)).toBeGreaterThanOrEqual(
        4.5
      );
      expect(contrastRatio(choice.dark, DARK_SURFACE)).toBeGreaterThanOrEqual(
        4.5
      );
    }
  });

  test("the old single bright mint would have failed on white", () => {
    // Regression pin: the pre-fix palette used this one hex for both surfaces.
    expect(contrastRatio("#34D399", LIGHT_SURFACE)).toBeLessThan(4.5);
    expect(
      contrastRatio(MINT_ACCENT_LIGHT, LIGHT_SURFACE)
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("every palette hex clears WCAG AA against its derived foreground", () => {
    for (const choice of ACCENT_CHOICES) {
      for (const hex of [choice.light, choice.dark]) {
        if (!hex) continue;
        const foreground = contrastForeground(hex);
        expect(contrastRatio(hex, foreground)).toBeGreaterThanOrEqual(4.5);
        expect(isContrastSafe(hex, foreground)).toBe(true);
      }
    }
  });

  test("picks a dark foreground for the pale dark-surface mint and white for the deep light-surface one", () => {
    expect(contrastForeground(MINT_ACCENT_DARK)).toBe("#0B1114");
    expect(contrastForeground(MINT_ACCENT_LIGHT)).toBe("#FFFFFF");
    expect(contrastForeground("#0E1E24")).toBe("#FFFFFF");
    expect(contrastForeground("#FFFFFF")).toBe("#0B1114");
    expect(contrastForeground("#000000")).toBe("#FFFFFF");
  });

  test("relative luminance and ratio behave like WCAG", () => {
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(relativeLuminance("nonsense")).toBe(1);
  });
});
