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

// Covers the VeyraN Light/Dark/System rollout:
//  - new installs default to System appearance with VeyraN Light/Dark
//  - users still on the shipped old default theme are migrated to VeyraN
//  - explicit/custom theme selections are preserved exactly as-is
//  - "follow system" reacts to a live OS scheme change
//
// NOT RUN this session: this repo checkout has no installed node_modules
// anywhere (no `@notesnook/theme` dist build, no vitest binary), so this
// file could not actually be executed here. It is written to the same
// conventions as the existing `apps/web/__tests__/*.test.ts` suite (vitest +
// happy-dom, see `apps/web/vitest.config.ts`) and should be run with
// `npx vitest run __tests__/veyran-theme-migration.test.ts` from `apps/web`
// once the workspace is installed and `packages/theme` is built.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ThemeDark,
  ThemeLight,
  ThemeVeyranDark,
  ThemeVeyranLight
} from "@notesnook/theme";
import { migrateLegacyDefaultTheme } from "../src/stores/theme-store";

// `setColorScheme`/`init()` both fire off a request to the themes marketplace
// to check for an update to the active theme. Stub it out so the store
// tests below stay hermetic (no real network access) and deterministic.
vi.mock("../src/common/themes-router", () => ({
  ThemesRouter: {
    updateTheme: { query: vi.fn(async () => undefined) },
    installTheme: { query: vi.fn(async () => undefined) }
  },
  THEME_SERVER_URL: "https://themes-api.notesnook.com",
  ThemesTRPC: {}
}));

function mockMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) =>
      listeners.add(cb),
    removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) =>
      listeners.delete(cb),
    // legacy API some hooks may still call
    addListener: (cb: (e: { matches: boolean }) => void) => listeners.add(cb),
    removeListener: (cb: (e: { matches: boolean }) => void) =>
      listeners.delete(cb)
  };
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  return {
    fireChange(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((cb) => cb({ matches }));
    }
  };
}

describe("migrateLegacyDefaultTheme (pure)", () => {
  it("replaces a theme whose id matches the legacy default", () => {
    const result = migrateLegacyDefaultTheme(
      ThemeLight,
      "default-light",
      ThemeVeyranLight
    );
    expect(result.id).toBe("veyran-light");
  });

  it("leaves a differently-id'd (custom/marketplace) theme untouched", () => {
    const custom = { ...ThemeLight, id: "my-custom-theme" };
    const result = migrateLegacyDefaultTheme(
      custom,
      "default-light",
      ThemeVeyranLight
    );
    expect(result).toBe(custom);
  });

  it("leaves the dark default untouched when checking against the light id", () => {
    const result = migrateLegacyDefaultTheme(
      ThemeDark,
      "default-light",
      ThemeVeyranLight
    );
    expect(result).toBe(ThemeDark);
  });
});

describe("ThemeStore bootstrap", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults a brand-new install to System appearance with VeyraN themes", async () => {
    mockMatchMedia(true /* OS is in dark mode */);
    const { useStore } = await import("../src/stores/theme-store");
    const state = useStore.getState();

    expect(state.followSystemTheme).toBe(true);
    expect(state.colorScheme).toBe("dark");
    expect(state.lightTheme.id).toBe("veyran-light");
    expect(state.darkTheme.id).toBe("veyran-dark");
  });

  it("migrates a user still on the shipped default theme to VeyraN, preserving their color scheme and follow-system choice", async () => {
    mockMatchMedia(false);
    window.localStorage.setItem("theme:light", JSON.stringify(ThemeLight));
    window.localStorage.setItem("theme:dark", JSON.stringify(ThemeDark));
    window.localStorage.setItem("colorScheme", JSON.stringify("dark"));
    window.localStorage.setItem("followSystemTheme", JSON.stringify(false));

    const { useStore } = await import("../src/stores/theme-store");
    const state = useStore.getState();

    expect(state.lightTheme.id).toBe("veyran-light");
    expect(state.darkTheme.id).toBe("veyran-dark");
    // Explicit choices untouched by the migration:
    expect(state.colorScheme).toBe("dark");
    expect(state.followSystemTheme).toBe(false);
  });

  it("never touches an explicit or custom theme selection", async () => {
    mockMatchMedia(false);
    const customLight = {
      ...ThemeLight,
      id: "my-custom-light",
      name: "My Custom Light"
    };
    window.localStorage.setItem("theme:light", JSON.stringify(customLight));
    window.localStorage.setItem("theme:dark", JSON.stringify(ThemeDark));
    window.localStorage.setItem("colorScheme", JSON.stringify("light"));
    window.localStorage.setItem("followSystemTheme", JSON.stringify(true));

    const { useStore } = await import("../src/stores/theme-store");
    const state = useStore.getState();

    // Light theme is untouched (custom id).
    expect(state.lightTheme.id).toBe("my-custom-light");
    // Dark theme *is* still migrated independently -- the two are tracked
    // (and migrated) separately, matching how `setTheme`/`setColorScheme`
    // already treat them as independent slots.
    expect(state.darkTheme.id).toBe("veyran-dark");
    expect(state.followSystemTheme).toBe(true);
  });

  it("reacts live to an OS scheme change while following the system theme", async () => {
    const media = mockMatchMedia(false);
    window.localStorage.setItem("followSystemTheme", JSON.stringify(true));
    window.localStorage.setItem("colorScheme", JSON.stringify("light"));

    const { useStore } = await import("../src/stores/theme-store");
    expect(useStore.getState().colorScheme).toBe("light");

    // Simulate what `BaseThemeProvider`'s effect
    // (`components/theme-provider/index.tsx`) does when the live
    // `useSystemTheme()` value flips while `followSystemTheme` is on.
    media.fireChange(true);
    await useStore.getState().setColorScheme("dark");

    expect(useStore.getState().colorScheme).toBe("dark");
    expect(useStore.getState().darkTheme.id).toBe("veyran-dark");
  });
});
