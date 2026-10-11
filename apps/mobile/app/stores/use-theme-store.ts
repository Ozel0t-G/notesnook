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

import {
  ThemeDefinition,
  ThemeVeyranDark,
  ThemeVeyranLight
} from "@notesnook/theme";
import { Appearance, StatusBar } from "react-native";
import { create } from "zustand";
import SettingsService from "../services/settings";
import switchTheme from "react-native-theme-switch-animation";

import changeNavigationBarColor from "react-native-navigation-bar-color";
import {
  applyAccentChoice,
  normalizeAccentChoiceId
} from "../utils/accent-theme";

export interface ThemeStore {
  /**
   * The themes the app renders. These are the user's own theme definitions with
   * the accent palette applied (`utils/accent-theme`), so every consumer --
   * the theme engine, the widget snapshot writer -- sees the effective colors.
   * The user's untouched definitions live in `baseLightTheme`/`baseDarkTheme`
   * and are what gets persisted.
   */
  lightTheme: ThemeDefinition;
  darkTheme: ThemeDefinition;
  /** The user's own light theme, exactly as chosen/imported. */
  baseLightTheme: ThemeDefinition;
  /** The user's own dark theme, exactly as chosen/imported. */
  baseDarkTheme: ThemeDefinition;
  /**
   * The accent palette selection. `undefined` means automatic: the mint default
   * on the built-in VeyraN appearance, and the theme's own accent otherwise.
   */
  accentColor?: string;
  colorScheme: "dark" | "light";
  setDarkTheme: (theme: ThemeDefinition) => void;
  setLightTheme: (theme: ThemeDefinition) => void;
  setAccentColor: (accentColor?: string) => void;
  setColorScheme: (colorScheme?: "dark" | "light") => void;
}

/**
 * The currently active, accent-applied theme. Used by anything that needs the
 * effective colors outside of React, e.g. the widget snapshot writer.
 */
export function getEffectiveTheme(state?: ThemeStore): ThemeDefinition {
  const current = state ?? useThemeStore.getState();
  return current.colorScheme === "dark" ? current.darkTheme : current.lightTheme;
}

const initialSettings = SettingsService.get();
// A settings blob from before theming (or with a corrupt entry) must still
// boot: fall back to the shipped appearances rather than reading `scopes` off
// `undefined`.
const initialBaseLightTheme = initialSettings.lighTheme ?? ThemeVeyranLight;
const initialBaseDarkTheme = initialSettings.darkTheme ?? ThemeVeyranDark;

export function changeSystemBarColors() {
  const change = () => {
    const state = useThemeStore.getState();
    const isDark = state.colorScheme === "dark";
    // Read the store so a settings blob from before theming still resolves to
    // a real theme instead of `undefined.scopes`.
    const currTheme = getEffectiveTheme(state);
    changeNavigationBarColor(
      currTheme.scopes.base.primary.background,
      !isDark,
      false
    );
    StatusBar.setBackgroundColor("transparent" as any);
    StatusBar.setTranslucent(true);
    StatusBar.setBarStyle(isDark ? "light-content" : "dark-content");
  };
  change();
  setTimeout(change, 400);
  setTimeout(change, 1000);
}

function switchThemeWithAnimation(fn: () => void) {
  switchTheme({
    switchThemeFunction: fn,
    animationConfig: {
      type: "circular",
      duration: 500,
      startingPoint: {
        cxRatio: 0,
        cyRatio: 0
      }
    }
  });
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  baseLightTheme: initialBaseLightTheme,
  baseDarkTheme: initialBaseDarkTheme,
  lightTheme: applyAccentChoice(
    initialBaseLightTheme,
    initialSettings.accentColor
  ),
  darkTheme: applyAccentChoice(
    initialBaseDarkTheme,
    initialSettings.accentColor
  ),
  accentColor: normalizeAccentChoiceId(initialSettings.accentColor),
  colorScheme: initialSettings.useSystemTheme
    ? (Appearance.getColorScheme() as "dark" | "light")
    : initialSettings.colorScheme,
  setDarkTheme: (darkTheme) => {
    // The store keeps the effective, accent-applied theme so every consumer
    // recolors, while the untouched definition is what gets persisted.
    set((state) => ({
      baseDarkTheme: darkTheme,
      darkTheme: applyAccentChoice(darkTheme, state.accentColor)
    }));
    changeSystemBarColors();
    SettingsService.setProperty("darkTheme", darkTheme);
  },
  setLightTheme: (lightTheme) => {
    set((state) => ({
      baseLightTheme: lightTheme,
      lightTheme: applyAccentChoice(lightTheme, state.accentColor)
    }));
    changeSystemBarColors();
    SettingsService.setProperty("lighTheme", lightTheme);
  },
  setAccentColor: (accentColor) => {
    const normalized = normalizeAccentChoiceId(accentColor);
    set((state) => ({
      accentColor: normalized,
      lightTheme: applyAccentChoice(state.baseLightTheme, normalized),
      darkTheme: applyAccentChoice(state.baseDarkTheme, normalized)
    }));
    changeSystemBarColors();
    SettingsService.setProperty("accentColor", normalized);
  },
  setColorScheme: (colorScheme) => {
    switchThemeWithAnimation(() => {
      const nextColorScheme =
        colorScheme === undefined
          ? get().colorScheme === "dark"
            ? "light"
            : "dark"
          : colorScheme;
      set({
        colorScheme: nextColorScheme
      });
      changeSystemBarColors();
      if (!SettingsService.getProperty("useSystemTheme")) {
        SettingsService.set({
          colorScheme: nextColorScheme
        });
      }
    });
  }
}));
