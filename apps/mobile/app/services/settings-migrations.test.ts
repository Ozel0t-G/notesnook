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

// A settings blob that predates versioning entirely (settingsVersion 0 or
// undefined) must land on the current version in a single call to
// migrateSettingsVersions() -- i.e. a single app launch -- rather than
// advancing one version per launch. This file is dependency-free (no MMKV,
// no react-native) so it can exercise that directly.

import { ThemeDark, ThemeLight, ThemeVeyranDark, ThemeVeyranLight } from "@notesnook/theme";
import { migrateSettingsVersions } from "./settings-migrations";

describe("migrateSettingsVersions", () => {
  test("a version-0 profile reaches the latest version in a single call", () => {
    const { settings, migrated } = migrateSettingsVersions({
      settingsVersion: undefined,
      appLockEnabled: false,
      privacyScreen: false,
      lighTheme: ThemeLight,
      darkTheme: ThemeDark
    });

    expect(migrated).toBe(true);
    expect(settings.settingsVersion).toBe(2);
    // The v0->v1 step ran...
    expect(settings.privacyScreen).toBe(false);
    // ...and the v1->v2 theme migration ran in the very same call.
    expect(settings.lighTheme?.id).toBe("veyran-light");
    expect(settings.darkTheme?.id).toBe("veyran-dark");
  });

  test("the v0->v1 step turns on privacyScreen when appLockEnabled is set", () => {
    const { settings } = migrateSettingsVersions({
      settingsVersion: undefined,
      appLockEnabled: true,
      privacyScreen: false,
      lighTheme: ThemeLight,
      darkTheme: ThemeDark
    });

    expect(settings.privacyScreen).toBe(true);
  });

  test("a version-1 profile only runs the remaining theme migration step", () => {
    const { settings, migrated } = migrateSettingsVersions({
      settingsVersion: 1,
      lighTheme: ThemeLight,
      darkTheme: ThemeDark
    });

    expect(migrated).toBe(true);
    expect(settings.settingsVersion).toBe(2);
    expect(settings.lighTheme?.id).toBe("veyran-light");
    expect(settings.darkTheme?.id).toBe("veyran-dark");
  });

  test("an already-current profile is left untouched and reports no migration", () => {
    const customLight = { ...ThemeLight, id: "my-custom-light" };
    const input = {
      settingsVersion: 2,
      lighTheme: customLight,
      darkTheme: ThemeVeyranDark
    };

    const { settings, migrated } = migrateSettingsVersions(input);

    expect(migrated).toBe(false);
    expect(settings).toBe(input);
    expect(settings.lighTheme).toBe(customLight);
  });

  test("an explicit/custom theme is preserved even for a version-0 profile", () => {
    const customDark = { ...ThemeDark, id: "my-custom-dark" };
    const { settings } = migrateSettingsVersions({
      settingsVersion: undefined,
      lighTheme: ThemeLight,
      darkTheme: customDark
    });

    expect(settings.lighTheme?.id).toBe("veyran-light");
    expect(settings.darkTheme).toBe(customDark);
  });

  test("VeyraN-only input needs no migration but reports version already current", () => {
    const { settings, migrated } = migrateSettingsVersions({
      settingsVersion: 2,
      lighTheme: ThemeVeyranLight,
      darkTheme: ThemeVeyranDark
    });

    expect(migrated).toBe(false);
    expect(settings.lighTheme).toBe(ThemeVeyranLight);
    expect(settings.darkTheme).toBe(ThemeVeyranDark);
  });
});
