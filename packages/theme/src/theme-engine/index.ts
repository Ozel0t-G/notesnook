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

import { createContext, useContext, useMemo } from "react";
import { create } from "zustand";
import _ThemeDark from "./themes/default-dark.json";
import _ThemeLight from "./themes/default-light.json";
import _ThemeVeyranLight from "./veyran/veyran-light.json";
import _ThemeVeyranDark from "./veyran/veyran-dark.json";
import {
  ThemeCompatibilityVersion,
  ThemeDefinition,
  ThemeScopes,
  VariantsWithStaticColors
} from "./types.js";
import { buildVariants } from "./utils.js";

const ThemeLight = _ThemeLight as ThemeDefinition;
const ThemeDark = _ThemeDark as ThemeDefinition;
/**
 * The first-class VeyraN Light/Dark themes. These are plain `ThemeDefinition`s
 * like any other installable theme -- they are not wired as the engine's
 * fallback (see `ThemeLight` above, still used by `useThemeEngineStore`'s
 * initial state and by `buildVariants()`'s scope-merge fallback) so that
 * embedding contexts which don't go through an app-level theme store are
 * unaffected. Each app's theme store is responsible for choosing these as
 * the default for new installs / migrated old-default users while leaving
 * any explicit or custom theme selection untouched.
 */
const ThemeVeyranLight = _ThemeVeyranLight as ThemeDefinition;
const ThemeVeyranDark = _ThemeVeyranDark as ThemeDefinition;

type ThemeScope = {
  colors: VariantsWithStaticColors<true>;
  scope: keyof ThemeScopes;
  isDark: boolean;
};

type ThemeEngineState = {
  theme: ThemeDefinition;
  setTheme: (theme: ThemeDefinition) => void;
};
const useThemeEngineStore = create<ThemeEngineState>((set) => ({
  theme: globalThis.DEFAULT_THEME || ThemeLight,
  setTheme: (theme) => set({ theme })
}));

const ThemeScopeContext = createContext<keyof ThemeScopes>("base");

export function useThemeColors(scope?: keyof ThemeScopes): ThemeScope {
  const currentScope = useCurrentThemeScope();
  const theme = useThemeEngineStore((store) => store.theme);
  const themeScope = useMemo(
    () => theme.scopes[scope || currentScope] || theme.scopes.base,
    [currentScope, scope, theme.scopes]
  );

  const currentTheme = useMemo(
    () => ({
      colors: buildVariants(scope || currentScope || "base", theme, themeScope),
      isDark: theme.colorScheme === "dark",
      scope: currentScope
    }),
    [themeScope, theme, scope, currentScope]
  );

  return currentTheme;
}

export function getThemeScope(
  scope: keyof ThemeScopes,
  theme: ThemeDefinition
): ThemeScope {
  const themeScope = theme.scopes[scope] || theme.scopes.base;
  const currentTheme = {
    colors: buildVariants(scope, theme, themeScope),
    isDark: theme.colorScheme === "dark",
    scope
  };
  return currentTheme;
}

export const useCurrentThemeScope = () => useContext(ThemeScopeContext);
export const ScopedThemeProvider = ThemeScopeContext.Provider;
export const THEME_COMPATIBILITY_VERSION: ThemeCompatibilityVersion = 1;
export {
  ThemeLight,
  ThemeDark,
  ThemeVeyranLight,
  ThemeVeyranDark,
  useThemeEngineStore,
  type ThemeEngineState
};
export { getPreviewColors, themeToCSS } from "./utils.js";
export { getThemePresentation } from "./theme-presentation.js";
export { validateTheme } from "./validator.js";
