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

// RUN this session with `npx jest app/utils/veyran-theme-migration.test.ts`
// from `apps/mobile`, against a real `npm install`/`@notesnook/theme` build
// (see artifacts/veyran-theme-audit.md for exactly what was and wasn't
// possible to install/run). All tests below passed. It stays dependency-free
// by design (no react-native mocking needed, unlike most of this
// directory's tests).

import {
  ThemeDark,
  ThemeLight,
  ThemeVeyranDark,
  ThemeVeyranLight
} from "@notesnook/theme";
import {
  BUILT_IN_THEMES,
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES_BY_ID,
  visibleLocalThemes,
  migrateLegacyDefaultTheme,
  migrateLegacyDefaultThemes
} from "./veyran-theme-migration";

describe("migrateLegacyDefaultTheme", () => {
  test("replaces the shipped default dark theme with VeyraN Dark", () => {
    expect(
      migrateLegacyDefaultTheme(ThemeDark, "default-dark", ThemeVeyranDark)
    ).toBe(ThemeVeyranDark);
  });

  test("leaves a marketplace/custom theme id untouched", () => {
    const custom = { ...ThemeDark, id: "my-custom-dark" };
    expect(
      migrateLegacyDefaultTheme(custom, "default-dark", ThemeVeyranDark)
    ).toBe(custom);
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

describe("built-in theme bookkeeping", () => {
  test("lists every built-in theme, including both VeyraN themes", () => {
    const ids = BUILT_IN_THEMES.map((theme) => theme.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "veyran-light",
        "veyran-dark",
        "default-light",
        "default-dark"
      ])
    );
  });

  test("BUILT_IN_THEME_IDS matches BUILT_IN_THEMES exactly", () => {
    expect(BUILT_IN_THEME_IDS.has("veyran-light")).toBe(true);
    expect(BUILT_IN_THEME_IDS.has("veyran-dark")).toBe(true);
    expect(BUILT_IN_THEME_IDS.has("some-marketplace-theme")).toBe(false);
  });

  test("resolves a built-in by id for a local apply path", () => {
    expect(BUILT_IN_THEMES_BY_ID.get("veyran-light")?.id).toBe("veyran-light");
    expect(BUILT_IN_THEMES_BY_ID.get("veyran-dark")?.id).toBe("veyran-dark");
    expect(BUILT_IN_THEMES_BY_ID.get("some-marketplace-theme")).toBeUndefined();
  });

  test("offline search finds VeyraN built-ins even when neither is active", () => {
    const customLight = { ...ThemeLight, id: "custom-light" };
    const customDark = { ...ThemeDark, id: "custom-dark" };
    expect(
      visibleLocalThemes(customDark, customLight, "vEyRaN").map(
        (theme) => theme.id
      )
    ).toEqual(["veyran-light", "veyran-dark"]);
    expect(
      visibleLocalThemes(customDark, customLight, "veyRan", "dark").map(
        (theme) => theme.id
      )
    ).toEqual(["veyran-dark"]);
  });

  test("fresh offline picker includes both VeyraN built-ins and an active custom theme", () => {
    const custom = { ...ThemeLight, id: "custom-light" };
    const ids = visibleLocalThemes(ThemeVeyranDark, custom).map(
      (theme) => theme.id
    );
    expect(ids).toEqual(
      expect.arrayContaining(["veyran-light", "veyran-dark", "custom-light"])
    );
    expect(ids.filter((id) => id === "veyran-dark")).toHaveLength(1);
  });
});
