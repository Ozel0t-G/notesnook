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

/**
 * Pure logic for the Mac Catalyst system accent and key-window state (F1, N4,
 * S1). Deliberately free of React Native imports so it can be unit tested
 * without the native bridge; the store that feeds it lives in
 * stores/use-mac-system-store.ts and the bridge subscription in
 * hooks/use-mac-system-state.ts.
 */

/**
 * Accent the app falls back to when the native bridge has none: the dark
 * variant of UIColor.systemBlue, which is also Notesnook's stock blue.
 */
export const FALLBACK_SYSTEM_ACCENT = "#0A84FF";

export type MacSystemState = {
  /** System accent colour as "#RRGGBB". */
  accent: string;
  /** Whether the window is key/active. */
  active: boolean;
};

export const DEFAULT_MAC_SYSTEM_STATE: MacSystemState = {
  accent: FALLBACK_SYSTEM_ACCENT,
  active: true
};

/**
 * Validates whatever the native module hands over (its constants, the
 * `getSystemState()` promise, or the `VeyraNMacSystemState` event body). Each
 * field falls back individually, so a half-filled payload cannot wipe the
 * other one; invalid/missing values keep the fallback (the store passes its
 * current state, so a bad event leaves it untouched).
 */
export function normalizeMacSystemState(
  raw: Partial<MacSystemState> | null | undefined,
  fallback: MacSystemState = DEFAULT_MAC_SYSTEM_STATE
): MacSystemState {
  const accent =
    typeof raw?.accent === "string" && raw.accent.trim().length > 0
      ? raw.accent
      : fallback.accent;
  const active =
    typeof raw?.active === "boolean" ? raw.active : fallback.active;
  return { accent, active };
}

/**
 * Reads the constants the native VeyraNMacMenu module exposes. Missing module
 * (iPhone/iPad, or an older build without the Mac bridge) returns the
 * documented defaults: system blue and an active window.
 */
export function readMacSystemState(nativeModule?: unknown): MacSystemState {
  const module = nativeModule as
    | { systemAccent?: unknown; windowActive?: unknown }
    | undefined;
  return normalizeMacSystemState({
    accent: module?.systemAccent as string | undefined,
    active: module?.windowActive as boolean | undefined
  });
}

export type MacSelectionFill = {
  /** Fill colour, applied with `opacity` on a layer of its own. */
  color: string;
  opacity: number;
};

/** "Unemphasized" selection: macOS greys the selection out when the window is
 * not key (N4, S1). */
const MAC_UNEMPHASIZED_GRAY = "rgba(128,128,128,1)";
/** Strength of the accent fill (what the sidebar and list rows use today). */
const MAC_SELECTION_OPACITY = 0.22;
/** The grey reads weaker than the accent on the dark window, so it is a touch
 * stronger there (macOS' unemphasizedSelectedContentBackgroundColor). */
const MAC_UNEMPHASIZED_OPACITY = { light: 0.22, dark: 0.28 } as const;

/**
 * Row-selection fill for the Mac source list and note list. Active window: the
 * system accent at low opacity. Inactive window: neutral grey.
 */
export function macSelectionFill(
  accent: string,
  active: boolean,
  isDark: boolean
): MacSelectionFill {
  if (active) {
    return {
      color: accent || FALLBACK_SYSTEM_ACCENT,
      opacity: MAC_SELECTION_OPACITY
    };
  }
  return {
    color: MAC_UNEMPHASIZED_GRAY,
    opacity: isDark
      ? MAC_UNEMPHASIZED_OPACITY.dark
      : MAC_UNEMPHASIZED_OPACITY.light
  };
}

/**
 * Accent used for Mac selection highlights. macOS' own accent is the default;
 * a user-chosen custom accent (`override`) always wins, and the Notesnook theme
 * accent is only the last resort when the bridge has no system accent at all.
 *
 * Selection highlights only: the theme itself is never recoloured, so a custom
 * theme keeps looking the way its author intended everywhere else.
 */
export function macAccent(
  themeAccent: string,
  systemAccent: string,
  override?: string
): string {
  if (override) return override;
  if (systemAccent) return systemAccent;
  return themeAccent;
}
