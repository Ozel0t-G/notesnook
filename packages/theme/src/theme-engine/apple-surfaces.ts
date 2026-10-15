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

import type { ThemeDefinition } from "./types.js";

/*
 * The one shared resolution of the Apple (iPhone / iPad / Mac Catalyst) surface
 * roles: `windowBackground`, `sidebarSurface`, `listSurface`, `documentSurface`,
 * `elevatedSurface`, `fieldSurface`, `separator` and the interactive
 * `selectionFill` / `hoverFill` affordances.
 *
 * Both renderers of the writing workspace consume this module -- the React
 * Native app (`apps/mobile/app/utils/apple-visual-tokens.ts`,
 * `utils/mac-layout.ts`, `components/mac-glass-view.tsx`) and the editor WebView
 * (`packages/editor-mobile/src/App.tsx`, `components/editor.tsx`) -- so the
 * native panes and the page inside the WebView cannot drift apart.
 *
 * Two rules shape it (docs/APPLE_DESIGN_SYSTEM.md §2):
 *
 * 1. The big neutral surfaces never carry the app accent. Recoloring the accent
 *    must not re-tint the window, the source list, the note list, the reading
 *    canvas, or the cards above them. The accent reaches only the interactive
 *    affordances (selection fill here; hover/action states stay the theme's
 *    own), which is what `selectionFill` is for.
 * 2. The bundled VeyraN appearances are the only themes that resolve to the
 *    standard neutral palette above. Detection is by *theme identity* (`id`),
 *    never by "is this theme light/dark", so an imported or hand-written theme
 *    keeps the surfaces its author chose.
 */

/**
 * The bundled VeyraN appearance ids. Kept here (rather than imported from the
 * app) because the theme package is the shared dependency of every client;
 * `apps/mobile/app/utils/accent-theme.ts` carries the same ids for the accent
 * palette, which is an app-level concern.
 */
export const VEYRAN_THEME_IDS: readonly string[] = [
  "veyran-light",
  "veyran-dark"
];

export type AppleSurfaceAppearance = "light" | "dark";

/**
 * The standard neutral surfaces of the built-in VeyraN appearances
 * (docs/APPLE_DESIGN_SYSTEM.md §2, reference palette).
 *
 * The window chrome and the note list share one value on purpose: macOS Notes
 * keeps a single tone behind the toolbar and the list column, and in Catalyst
 * the note list column is painted by more than one component (the pane itself
 * and the list's own scroll view), so they have to agree. The source list has
 * its own tone, and the document its own, which is what makes the sidebar, the
 * list and the reading canvas three distinguishable surfaces.
 */
export const APPLE_SURFACE_NEUTRALS = {
  light: {
    windowBackground: "#F6F6F8",
    sidebarSurface: "#ECEDEF",
    listSurface: "#F6F6F8",
    documentSurface: "#FFFFFF",
    elevatedSurface: "#FFFFFF",
    separator: "#D9D9DE"
  },
  dark: {
    windowBackground: "#202023",
    sidebarSurface: "#252527",
    listSurface: "#202023",
    documentSurface: "#18181B",
    elevatedSurface: "#2B2B2F",
    separator: "#36363A"
  }
} as const;

/**
 * The neutral hover fill used when the theme does not author one. Hover is an
 * affordance, so it is a translucent wash (white in dark mode, black in light)
 * rather than an accent: it never re-tints a surface, it only lifts one.
 */
export const APPLE_NEUTRAL_HOVER = {
  light: "rgba(0, 0, 0, 0.05)",
  dark: "rgba(255, 255, 255, 0.07)"
} as const;

/**
 * How much of the app accent is blended into a selection fill, per appearance.
 *
 * Selection is the one surface-level place the accent is allowed to appear
 * (docs/APPLE_DESIGN_SYSTEM.md §2: "appAccent (interactive affordances ONLY)"),
 * so the fill is the neutral surface it sits on with a deliberate amount of the
 * accent mixed in - enough to be unmistakably the app accent in both
 * appearances, still light enough to keep body text readable on top of it.
 */
export const APPLE_SELECTION_ACCENT_MIX = {
  light: 0.22,
  dark: 0.34
} as const;

/**
 * The resolved theme colors the resolver reads. Accepts both
 * `VariantsWithStaticColors<true>` (React Native, `useThemeColors()`) and the
 * editor's scope colors (`getThemeScope().colors`); every field is optional
 * because a theme is allowed to inherit the rest.
 */
export type AppleSurfaceColors = {
  primary?: {
    background?: string;
    border?: string;
    separator?: string;
    hover?: string;
    accent?: string;
  } | null;
  secondary?: { background?: string } | null;
  selected?: { background?: string } | null;
} | null;

/**
 * The resolver input. Everything is explicit and safe to omit:
 *
 * - `theme` is the *identity* input. Only `id` and `colorScheme` are read, and
 *   only a bundled VeyraN id selects the standard neutrals. An absent,
 *   unknown or custom theme resolves to the authored colors below instead --
 *   never to the VeyraN palette, and never by guessing from a color.
 * - `colors` is the active (accent-applied) theme's resolved colors, the
 *   authored fallback and the source of the accent for the selection fill.
 * - `isDark` overrides the appearance; it defaults to the theme's own
 *   `colorScheme`.
 */
export type AppleSurfaceInput = {
  theme?: Pick<ThemeDefinition, "id" | "colorScheme"> | null;
  colors?: AppleSurfaceColors;
  isDark?: boolean;
};

export type AppleSurfaces = {
  appearance: AppleSurfaceAppearance;
  /** True when the standard VeyraN neutrals resolved (identity match). */
  usesVeyranNeutrals: boolean;
  /** Window root, toolbar band and the note list column. */
  windowBackground: string;
  /** The source list / sidebar surface. */
  sidebarSurface: string;
  /** The note list column. */
  listSurface: string;
  /** The reading canvas: the editor page and pane. */
  documentSurface: string;
  /** Cards, sheets and anything that floats above the window. */
  elevatedSurface: string;
  /**
   * Fields and secondary fills: the recessed fill in light mode, the raised one
   * in dark mode, which is the direction both macOS and iOS use.
   */
  fieldSurface: string;
  separator: string;
  /** Interactive affordances - the only accent-bearing surfaces here. */
  selectionFill: string;
  hoverFill: string;
  /** The active accent, for callers that need it for actions/icons. */
  accent?: string;
};

/** Whether the theme is one of the bundled VeyraN appearances. */
export function isVeyranBuiltInTheme(
  theme: Pick<ThemeDefinition, "id"> | undefined | null
): boolean {
  return !!theme && VEYRAN_THEME_IDS.includes(theme.id);
}

/** The appearance in effect: an explicit flag wins, else the theme's scheme. */
export function appleSurfaceAppearance(
  theme: Pick<ThemeDefinition, "colorScheme"> | undefined | null,
  isDark?: boolean
): AppleSurfaceAppearance {
  if (isDark !== undefined) return isDark ? "dark" : "light";
  return theme?.colorScheme === "dark" ? "dark" : "light";
}

/**
 * Resolve the Apple surface roles for the active theme.
 *
 * Pure and read-only: the theme definition, the resolved colors and the stored
 * note styles/highlights are never mutated, and the same input always produces
 * the same output (both the native app and the WebView rely on that).
 */
export function resolveAppleSurfaces(
  input: AppleSurfaceInput = {}
): AppleSurfaces {
  const theme = input.theme ?? null;
  const appearance = appleSurfaceAppearance(theme, input.isDark);
  const neutral = APPLE_SURFACE_NEUTRALS[appearance];
  const colors = input.colors ?? null;
  const primary = colors?.primary ?? null;
  const accent = primary?.accent;
  const hoverFill = primary?.hover ?? APPLE_NEUTRAL_HOVER[appearance];

  if (isVeyranBuiltInTheme(theme)) {
    return {
      appearance,
      usesVeyranNeutrals: true,
      windowBackground: neutral.windowBackground,
      sidebarSurface: neutral.sidebarSurface,
      listSurface: neutral.listSurface,
      documentSurface: neutral.documentSurface,
      elevatedSurface: neutral.elevatedSurface,
      fieldSurface:
        appearance === "dark" ? neutral.elevatedSurface : neutral.listSurface,
      separator: neutral.separator,
      selectionFill: selectionFill(neutral.listSurface, accent, appearance),
      hoverFill,
      accent
    };
  }

  // An imported, marketplace or hand-written theme: keep the colors its author
  // chose. No accent is blended into any of these surfaces (that was the old
  // 4-8% tint), and nothing here reads or writes the theme definition itself.
  const windowSurface =
    colors?.secondary?.background ??
    primary?.background ??
    neutral.windowBackground;
  const documentSurface = primary?.background ?? neutral.documentSurface;
  return {
    appearance,
    usesVeyranNeutrals: false,
    windowBackground: windowSurface,
    sidebarSurface: windowSurface,
    listSurface: windowSurface,
    documentSurface,
    elevatedSurface: documentSurface,
    fieldSurface: colors?.secondary?.background ?? documentSurface,
    separator: primary?.border ?? primary?.separator ?? neutral.separator,
    selectionFill: colors?.selected?.background ?? accent ?? documentSurface,
    hoverFill,
    accent
  };
}

/**
 * The selection fill: the neutral list surface with the accent mixed in, so
 * changing the accent changes the selection and nothing else. A theme whose
 * accent cannot be parsed keeps the plain neutral rather than throwing.
 */
function selectionFill(
  base: string,
  accent: string | undefined,
  appearance: AppleSurfaceAppearance
): string {
  if (!accent) return base;
  return mixHex(base, accent, APPLE_SELECTION_ACCENT_MIX[appearance]);
}

/**
 * Blends `amount` (0..1) of the `over` colour into the `base` colour and
 * returns an opaque `#RRGGBB` string.
 *
 * Plain string maths, no platform imports: the React Native tokens, the Mac
 * layout helpers and the editor WebView all resolve through this one
 * implementation, so the native panes and the page inside the WebView compute
 * the same colour. `#RGB`, `#RGBA`, `#RRGGBB` and `#RRGGBBAA` are accepted; any
 * alpha is dropped, because every surface it feeds is opaque. Anything it
 * cannot parse returns `base` unchanged, so an exotic theme colour degrades to
 * the previous flat surface instead of throwing.
 */
export const mixHex = (base: string, over: string, amount: number): string => {
  const from = parseHexChannels(base);
  const to = parseHexChannels(over);
  if (!from || !to) return base;
  const ratio = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const channel = (index: number) =>
    Math.round(from[index] + (to[index] - from[index]) * ratio)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`.toUpperCase();
};

/** `#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA` -> three 0-255 channels, else undefined. */
function parseHexChannels(color: string): [number, number, number] | undefined {
  if (typeof color !== "string") return undefined;
  const hex = color.trim().replace(/^#/, "");
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return undefined;
  const expanded =
    hex.length <= 4
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16)
  ];
}
