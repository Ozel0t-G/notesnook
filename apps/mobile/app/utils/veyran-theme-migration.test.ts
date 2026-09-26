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

// NOT RUN this session: this repo checkout has no installed node_modules
// (no jest binary, no `@notesnook/theme` dist build), so this file could not
// actually be executed here. It is dependency-free by design (no
// react-native mocking needed, unlike most of this directory's tests) and
// should run under the project's existing jest setup once installed.

import { ThemeDark, ThemeLight, ThemeVeyranDark, ThemeVeyranLight } from "@notesnook/theme";
import {
  migrateLegacyDefaultTheme,
  migrateLegacyDefaultThemes
} from "./veyran-theme-migration";

describe("migrateLegacyDefaultTheme", () => {
  test("replaces the shipped default dark theme with VeyraN Dark", () => {
    expect(migrateLegacyDefaultTheme(ThemeDark, "default-dark", ThemeVeyranDark)).toBe(
      ThemeVeyranDark
    );
  });

  test("leaves a marketplace/custom theme id untouched", () => {
    const custom = { ...ThemeDark, id: "my-custom-dark" };
    expect(migrateLegacyDefaultTheme(custom, "default-dark", ThemeVeyranDark)).toBe(
      custom
    );
  });

  test("passes through an undefined theme (settings blob predates theming)", () => {
    expect(
      migrateLegacyDefaultTheme(undefined, "default-dark", ThemeVeyranDark)
    ).toBeUndefined();
  });
});

describe("migrateLegacyDefaultThemes", () => {
  test("migrates a user still on both shipped defaults, preserving other settings fields", () => {
    const result = migrateLegacyDefaultThemes({
      lighTheme: ThemeLight,
      darkTheme: ThemeDark,
      colorScheme: "dark" as const,
      useSystemTheme: false
    });

    expect(result.lighTheme).toBe(ThemeVeyranLight);
    expect(result.darkTheme).toBe(ThemeVeyranDark);
    // Explicit, unrelated preferences are preserved untouched.
    expect(result.colorScheme).toBe("dark");
    expect(result.useSystemTheme).toBe(false);
  });

  test("never touches an explicit/custom light or dark theme", () => {
    const customLight = { ...ThemeLight, id: "my-custom-light" };
    const result = migrateLegacyDefaultThemes({
      lighTheme: customLight,
      darkTheme: ThemeDark
    });

    expect(result.lighTheme).toBe(customLight);
    // The dark theme is still migrated independently.
    expect(result.darkTheme).toBe(ThemeVeyranDark);
  });
});
