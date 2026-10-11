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

import type {
  PartialVariants,
  ThemeDefinition,
  ThemeScopes,
  Variants
} from "@notesnook/theme";

/*
 * The accent palette Settings > Themes offers.
 *
 * The app's appearance is still a `ThemeDefinition` (built-in VeyraN, an
 * imported theme, a hand-edited custom one). The palette never edits that
 * definition: it is the user's own file, and it has to stay byte-for-byte
 * intact so it still applies cleanly on another device. Instead this module
 * *derives* an effective theme from it -- a new, immutable object graph with
 * every accent in the brand scopes replaced -- and the app renders that.
 *
 * That is why the palette is an independent setting and not a theme edit: the
 * choice survives switching between light and dark, survives system
 * light/dark changes, and survives applying a completely different theme.
 */

/** The palette entry that keeps the active theme's own accent. */
export const THEME_COLOR_ACCENT_ID = "theme";

export type AccentChoice = {
  id: string;
  /** The literal label. Kept short so a swatch row reads at a glance. */
  label: string;
  /**
   * The accent this choice paints with on a light surface, and on a dark one.
   * Both are `undefined` for the "theme color" entry, which keeps whatever
   * accent the active theme already has. A single bright hex cannot be legible
   * on both surfaces, so every preset carries an explicit, contrast-safe pair
   * and the effective theme's `colorScheme` picks which one applies.
   */
  light?: string;
  dark?: string;
};

/**
 * The mockup's fresh mint green, split into the light- and dark-surface pair.
 *
 * These are the mockup's exact hexes: the light surface uses the deepened
 * `#087C3E`, which stays legible on white where the previously shipped bright
 * `#34D399` did not, and the dark surface uses the mockup's `#73DFA0`. These are
 * the default for the built-in VeyraN appearance: a new default applied by the
 * app, so the bundled theme files stay exactly as published.
 */
export const MINT_ACCENT_LIGHT = "#087C3E";
export const MINT_ACCENT_DARK = "#73DFA0";

/**
 * The palette, mint first. Every entry is an explicit light/dark pair, each an
 * opaque six-digit RGB hex that clears WCAG AA against its intended surface.
 */
export const ACCENT_CHOICES: readonly AccentChoice[] = [
  {
    id: "mint",
    label: "Mint",
    light: MINT_ACCENT_LIGHT,
    dark: MINT_ACCENT_DARK
  },
  { id: "sky", label: "Sky", light: "#006A9B", dark: "#73CEFF" },
  { id: "violet", label: "Violet", light: "#6B46C1", dark: "#B9A2FF" },
  { id: "rose", label: "Rose", light: "#B83256", dark: "#FF8FA8" },
  { id: "amber", label: "Amber", light: "#8A5900", dark: "#FFD26E" },
  { id: "graphite", label: "Graphite", light: "#475569", dark: "#C0CBD6" },
  { id: THEME_COLOR_ACCENT_ID, label: "Theme color" }
];

export const DEFAULT_ACCENT_CHOICE_ID = "mint";

const ACCENT_CHOICE_BY_ID = new Map(ACCENT_CHOICES.map((c) => [c.id, c]));

/**
 * German palette labels.
 *
 * UI text normally lives in the translation catalogue, but the bundled
 * catalogue ships English only, so it cannot produce German for this screen.
 * The labels are therefore resolved from the device locale (the same source
 * the Mac note dates use), which is what a German person actually has set.
 * The widget's deliberately untranslated names -- "Overview" and "Focus" --
 * are not part of the palette and are left exactly as requested.
 */
const GERMAN_ACCENT_CHOICES: Record<string, string> = {
  mint: "Minze",
  sky: "Himmelblau",
  violet: "Violett",
  rose: "Rosé",
  amber: "Bernstein",
  graphite: "Graphit",
  [THEME_COLOR_ACCENT_ID]: "Themenfarbe"
};

const ACCENT_PALETTE_HEADINGS = {
  en: "Accent color",
  de: "Akzentfarbe"
} as const;

/** Whether a locale is German (`de`, `de-DE`, `de_AT`, ...). */
export function isGermanLocale(locale: string | undefined | null): boolean {
  return !!locale && locale.toLowerCase().startsWith("de");
}

/**
 * The device locale, the same source `utils/mac-note-date` uses. Feature-checked
 * and never throwing, because it runs while rendering settings.
 */
export function currentLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "en";
  } catch {
    return "en";
  }
}

/** The palette heading ("Accent color"/"Akzentfarbe") for a locale. */
export function accentPaletteHeading(locale: string = currentLocale()): string {
  return isGermanLocale(locale)
    ? ACCENT_PALETTE_HEADINGS.de
    : ACCENT_PALETTE_HEADINGS.en;
}

/**
 * The bundled appearances the mint default belongs to. A user on a different
 * theme -- an imported one, a marketplace one, a hand-edited custom one -- has
 * already made an explicit color decision, so their fallback is the theme's
 * own accent instead.
 */
export const VEYRAN_BUILT_IN_THEME_IDS: readonly string[] = [
  "veyran-light",
  "veyran-dark"
];

/**
 * Scopes that carry a brand accent. `navigationMenu` and `list` are scopes;
 * `primary`, `secondary` and `selected` are the variants within each. Semantic
 * `error`/`success` (and the deliberately muted `disabled`) are never touched:
 * a palette pick must not make an error look selected or a success look
 * disabled.
 */
const ACCENT_VARIANTS: readonly (keyof Variants)[] = [
  "primary",
  "secondary",
  "selected"
];

/** Near-black and white accent foregrounds; the readable one is chosen. */
const DARK_ACCENT_FOREGROUND = "#0B1114";
const LIGHT_ACCENT_FOREGROUND = "#FFFFFF";

/** WCAG 2.1 AA for normal text. */
const MIN_CONTRAST_RATIO = 4.5;

export function isVeyranBuiltInTheme(
  theme: Pick<ThemeDefinition, "id"> | undefined | null
): boolean {
  return !!theme && VEYRAN_BUILT_IN_THEME_IDS.includes(theme.id);
}

/**
 * Coerce anything that may have been persisted (including values written by an
 * older or newer build) into a palette id, or `undefined` for "automatic".
 * Never throws and never guesses: an unknown value falls back to automatic,
 * which is the safe, always-applicable choice.
 */
export function normalizeAccentChoiceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return ACCENT_CHOICE_BY_ID.has(value) ? value : undefined;
}

/**
 * Sanitize a persisted accent value for storage WITHOUT "fixing" it.
 *
 * Unlike `normalizeAccentChoiceId` -- a render-boundary normalizer that maps
 * unknown ids to `undefined` -- a palette id written by another build must
 * survive a downgrade + re-upgrade byte-for-byte. So every nonempty string,
 * including ids this build does not know, is returned verbatim. Only genuinely
 * corrupt values (a non-string or an empty string) are dropped to `undefined`.
 */
export function sanitizePersistedAccentChoiceId(
  value: unknown
): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The palette entry actually in effect.
 *
 * An explicit, known selection always wins. `undefined` means automatic: the
 * mint default on the built-in VeyraN appearance, and the theme's own accent
 * ("Theme color") everywhere else, so an imported theme is never silently
 * repainted.
 */
export function resolveAccentChoiceId(
  choiceId: unknown,
  theme: Pick<ThemeDefinition, "id"> | undefined | null
): string {
  const explicit = normalizeAccentChoiceId(choiceId);
  if (explicit) return explicit;
  return isVeyranBuiltInTheme(theme)
    ? DEFAULT_ACCENT_CHOICE_ID
    : THEME_COLOR_ACCENT_ID;
}

/**
 * The theme shape the palette needs: its id (which decides automatic vs. theme
 * color) and the surface it paints (which decides the light or dark pair).
 */
type AccentTheme = Pick<ThemeDefinition, "id"> & {
  colorScheme?: ThemeDefinition["colorScheme"];
};

/**
 * The pair half a surface uses. Light wins whenever the scheme is absent or not
 * exactly "dark", so an unknown scheme degrades to the surface the app's
 * authored themes default to rather than to an illegible bright accent.
 */
function accentHexForScheme(
  choice: AccentChoice,
  colorScheme: ThemeDefinition["colorScheme"] | undefined
): string | undefined {
  return colorScheme === "dark" ? choice.dark : choice.light;
}

/**
 * The accent hex a choice paints with on this theme's surface, or `undefined`
 * to keep the theme's own accent (the "theme color" entry, or automatic outside
 * the built-in VeyraN appearance).
 */
export function accentHexForChoice(
  choiceId: unknown,
  theme: AccentTheme | undefined | null
): string | undefined {
  const resolved = resolveAccentChoiceId(choiceId, theme);
  const choice = ACCENT_CHOICE_BY_ID.get(resolved);
  if (!choice) return undefined;
  return accentHexForScheme(choice, theme?.colorScheme);
}

/**
 * What a swatch should show: the pair half matching the theme's own surface, or
 * the theme's own accent for the "theme color" entry.
 */
export function accentSwatchColor(
  choice: AccentChoice,
  theme: ThemeDefinition
): string {
  return (
    accentHexForScheme(choice, theme.colorScheme) ??
    theme.scopes.base.primary.accent
  );
}

/**
 * The readable label for a choice id, in the given locale (device locale by
 * default). Unknown ids (old settings) resolve to the automatic entry so the
 * palette can always render a selection.
 */
export function accentChoiceLabel(
  choiceId: unknown,
  theme: Pick<ThemeDefinition, "id"> | undefined | null,
  locale: string = currentLocale()
): string {
  const resolved = resolveAccentChoiceId(choiceId, theme);
  const choice = ACCENT_CHOICE_BY_ID.get(resolved);
  if (!choice) return "";
  if (isGermanLocale(locale))
    return GERMAN_ACCENT_CHOICES[resolved] ?? choice.label;
  return choice.label;
}

/** The screen-reader label for a swatch, localized like its visible label. */
export function accentChoiceAccessibilityLabel(
  choiceId: unknown,
  theme: Pick<ThemeDefinition, "id"> | undefined | null,
  locale: string = currentLocale()
): string {
  const label = accentChoiceLabel(choiceId, theme, locale);
  return isGermanLocale(locale) ? `${label} Akzent` : `${label} accent`;
}

/**
 * WCAG relative luminance of an opaque hex color. Accepts `#rgb` and `#rrggbb`;
 * an unparseable value is treated as white (worst case for a dark foreground),
 * which keeps `contrastForeground` conservative.
 */
export function relativeLuminance(hex: string): number {
  const rgb = parseHexRgb(hex);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque hex colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The accent foreground (text/icons *on* an accent fill) with the best
 * contrast against `hex`. This is what keeps a pale mint accent readable and a
 * dark accent readable too, without the theme author having to supply one.
 */
export function contrastForeground(hex: string): string {
  const withDark = contrastRatio(hex, DARK_ACCENT_FOREGROUND);
  const withLight = contrastRatio(hex, LIGHT_ACCENT_FOREGROUND);
  return withDark >= withLight
    ? DARK_ACCENT_FOREGROUND
    : LIGHT_ACCENT_FOREGROUND;
}

/**
 * A new theme with `hex` as the accent of every brand variant, in every scope
 * that already declares one. The input is never mutated and every unrelated
 * color is preserved: unchanged sub-objects are shared by reference, changed
 * ones are copied. Returns the input unchanged when there is nothing to do, so
 * callers can use identity to skip work.
 */
export function withAccent(theme: ThemeDefinition, hex: string): ThemeDefinition {
  if (!isHexColor(hex)) return theme;
  const foreground = contrastForeground(hex);
  const scopes = { ...theme.scopes } as ThemeScopes;
  let changed = false;

  for (const scopeKey of Object.keys(theme.scopes) as (keyof ThemeScopes)[]) {
    const scope = theme.scopes[scopeKey];
    if (!scope) continue;
    const nextScope = withAccentInScope(scope, hex, foreground);
    if (nextScope === scope) continue;
    // Scopes have different variant shapes; the loop guarantees the value
    // written is the very object read from the same key.
    (scopes as Record<keyof ThemeScopes, unknown>)[scopeKey] = nextScope;
    changed = true;
  }

  return changed ? { ...theme, scopes } : theme;
}

function withAccentInScope(
  scope: PartialVariants,
  hex: string,
  foreground: string
): PartialVariants {
  let next: PartialVariants | undefined;
  for (const variantKey of ACCENT_VARIANTS) {
    const variant = scope[variantKey];
    if (!variant || variant.accent === undefined) continue;
    if (variant.accent === hex && variant.accentForeground === foreground) {
      continue;
    }
    next = next ?? { ...scope };
    next[variantKey] = {
      ...variant,
      accent: hex,
      accentForeground: foreground
    };
  }
  return next ?? scope;
}

/**
 * The effective theme for a palette selection: the theme itself for "Theme
 * color" (or automatic outside the built-in VeyraN appearance), otherwise the
 * theme with the chosen accent derived across its brand scopes.
 */
export function applyAccentChoice(
  theme: ThemeDefinition,
  choiceId: unknown
): ThemeDefinition {
  const hex = accentHexForChoice(choiceId, theme);
  if (!hex) return theme;
  return withAccent(theme, hex);
}

/** Whether an accent/foreground pair clears the AA contrast threshold. */
export function isContrastSafe(background: string, foreground: string): boolean {
  return contrastRatio(background, foreground) >= MIN_CONTRAST_RATIO;
}

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function parseHexRgb(hex: string): [number, number, number] | undefined {
  if (typeof hex !== "string") return undefined;
  const value = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    return [
      parseInt(value[0] + value[0], 16),
      parseInt(value[1] + value[1], 16),
      parseInt(value[2] + value[2], 16)
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(value)) {
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16)
    ];
  }
  if (/^[0-9a-fA-F]{8}$/.test(value)) {
    // `#rrggbbaa`: the alpha is irrelevant to a ratio between opaque values.
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16)
    ];
  }
  return undefined;
}
