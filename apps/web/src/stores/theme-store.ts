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

import createStore from "../common/store";
import BaseStore from "./index";
import Config from "../utils/config";
import { desktop } from "../common/desktop-bridge";
import {
  ThemeDark,
  ThemeDefinition,
  ThemeLight,
  ThemeVeyranDark,
  ThemeVeyranLight
} from "@notesnook/theme";

type ColorScheme = "dark" | "light";

/**
 * True only the very first time the app runs on this device/profile -- none
 * of the theme-related keys have ever been written. Used to pick System
 * appearance as the default for brand-new installs without ever touching an
 * existing install's `followSystemTheme`/`colorScheme` choice (explicit or
 * not).
 */
const IS_FRESH_THEME_INSTALL = !Config.has(
  (key) =>
    key === "theme:light" ||
    key === "theme:dark" ||
    key === "colorScheme" ||
    key === "followSystemTheme"
);

function prefersDarkOS(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/**
 * Migrate a user still on the shipped default theme (whether they never
 * touched theming, or explicitly re-picked the shipped default) to its
 * VeyraN equivalent. Anyone on a different theme -- a marketplace theme or a
 * hand-edited custom one -- is matched by `id` and left completely alone.
 */
export function migrateLegacyDefaultTheme(
  theme: ThemeDefinition,
  legacyId: string,
  replacement: ThemeDefinition
): ThemeDefinition {
  return theme.id === legacyId ? replacement : theme;
}

class ThemeStore extends BaseStore<ThemeStore> {
  colorScheme: "dark" | "light" = Config.get(
    "colorScheme",
    IS_FRESH_THEME_INSTALL && prefersDarkOS() ? "dark" : "light"
  );
  darkTheme = getTheme("dark");
  lightTheme = getTheme("light");
  followSystemTheme = Config.get("followSystemTheme", IS_FRESH_THEME_INSTALL);

  init = async () => {
    this.persistFreshInstallAndMigratedDefaults();
    const { darkTheme, lightTheme, colorScheme } = this.get();
    await changeDesktopTheme(
      colorScheme === "dark" ? darkTheme : lightTheme,
      this.get().followSystemTheme
    );
    this.set({
      darkTheme: await updateTheme(darkTheme),
      lightTheme: await updateTheme(lightTheme)
    });
  };

  /**
   * Writes the in-memory defaults chosen by the field initializers above
   * back to localStorage, so the next load (including the pre-hydration
   * flash-avoidance script in `src/index.ts`, which reads these keys
   * directly) sees the resolved value instead of re-deriving it. Safe to
   * call every session: it only ever writes a value that already matches
   * what's currently active in memory.
   */
  persistFreshInstallAndMigratedDefaults = () => {
    const { lightTheme, darkTheme, colorScheme, followSystemTheme } =
      this.get();
    if (lightTheme.id === ThemeVeyranLight.id)
      Config.set("theme:light", lightTheme);
    if (darkTheme.id === ThemeVeyranDark.id)
      Config.set("theme:dark", darkTheme);
    if (IS_FRESH_THEME_INSTALL) {
      Config.set("colorScheme", colorScheme);
      Config.set("followSystemTheme", followSystemTheme);
    }
  };

  setTheme = (theme: ThemeDefinition) => {
    changeDesktopTheme(theme, this.get().followSystemTheme);
    Config.set("colorScheme", theme.colorScheme);
    Config.set(`theme:${theme.colorScheme}`, theme);
    this.set({
      [getKey(theme)]: theme,
      colorScheme: theme.colorScheme
    });
  };

  setColorScheme = async (colorScheme: ColorScheme) => {
    const theme = getTheme(colorScheme);
    this.set({ colorScheme, [getKey(theme)]: theme });
    changeDesktopTheme(theme, this.get().followSystemTheme);

    updateTheme(theme).then((theme) => {
      changeDesktopTheme(theme, this.get().followSystemTheme);
      Config.set("colorScheme", colorScheme);
      Config.set(`theme:${theme.colorScheme}`, theme);
      this.set({ [getKey(theme)]: theme });
    });
  };

  toggleColorScheme = () => {
    const theme = this.get().colorScheme;
    this.setColorScheme(theme === "dark" ? "light" : "dark");
  };

  setFollowSystemTheme = async (followSystemTheme: boolean) => {
    this.set({ followSystemTheme });
    Config.set("followSystemTheme", followSystemTheme);
    await desktop?.integration.changeTheme.mutate({
      theme: followSystemTheme ? "system" : this.get().colorScheme
    });
  };

  toggleFollowSystemTheme = () => {
    const followSystemTheme = this.get().followSystemTheme;
    this.setFollowSystemTheme(!followSystemTheme);
  };

  isThemeCurrentlyApplied = (id: string) => {
    return this.get().darkTheme.id === id || this.get().lightTheme.id === id;
  };
}

const [useStore, store] = createStore<ThemeStore>(
  (set, get) => new ThemeStore(set, get)
);
export { useStore, store };

function getKey(theme: ThemeDefinition) {
  return theme.colorScheme === "dark" ? "darkTheme" : "lightTheme";
}

// Every call site of `getTheme()` (field initializers, `setColorScheme`,
// `init()`'s desktop-chrome sync) goes through the same migration check, so
// a user still on the shipped default theme never sees the old default
// again after switching scheme -- e.g. via System live-switching -- before
// `persistFreshInstallAndMigratedDefaults()` has had a chance to persist the
// migrated theme.
function getTheme(colorScheme: ColorScheme): ThemeDefinition {
  return colorScheme === "dark"
    ? migrateLegacyDefaultTheme(
        Config.get("theme:dark", ThemeDark),
        "default-dark",
        ThemeVeyranDark
      )
    : migrateLegacyDefaultTheme(
        Config.get("theme:light", ThemeLight),
        "default-light",
        ThemeVeyranLight
      );
}

// Installed custom themes retain their local definition. The upstream theme
// marketplace is not a production VeyraN service, so startup and appearance
// changes cannot refresh themes from it.
async function updateTheme(theme: ThemeDefinition) {
  return theme;
}

function changeDesktopTheme(theme: ThemeDefinition, system: boolean) {
  return desktop?.integration.changeTheme.mutate({
    theme: system ? "system" : theme.colorScheme,
    backgroundColor: theme.scopes.base.primary.background,
    windowControlsIconColor: theme.scopes.base.primary.icon
  });
}
