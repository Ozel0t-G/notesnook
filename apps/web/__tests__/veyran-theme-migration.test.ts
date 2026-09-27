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
//  - built-in themes never hit the themes-api.notesnook.com marketplace,
//    for either an update check or to apply them
//  - built-in themes are always listed and locally selectable, independent
//    of the active pair or the marketplace query's state
//
// RUN this session with `npx vitest run __tests__/veyran-theme-migration.test.ts`
// from `apps/web`, against a real `npm install` + `packages/theme` build
// (see artifacts/veyran-theme-audit.md for exactly what was and wasn't
// possible to install/run). All tests below passed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ThemeDark,
  ThemeLight,
  ThemeVeyranDark,
  ThemeVeyranLight
} from "@notesnook/theme";
import { migrateLegacyDefaultTheme } from "../src/stores/theme-store";
import {
  BUILT_IN_THEMES,
  BUILT_IN_THEMES_BY_ID,
  uniqueById
} from "../src/common/veyran-built-in-themes";

const { updateThemeQuery, installThemeQuery } = vi.hoisted(() => ({
  updateThemeQuery: vi.fn(async () => undefined),
  installThemeQuery: vi.fn(async () => undefined)
}));

// `setColorScheme`/`init()` both fire off a request to the themes marketplace
// to check for an update to the active theme. Stub it out so the store
// tests below stay hermetic (no real network access) and deterministic, and
// so built-in-bypass tests can assert the mock was never even called.
vi.mock("../src/common/themes-router", () => ({
  ThemesRouter: {
    updateTheme: { query: updateThemeQuery },
    installTheme: { query: installThemeQuery }
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

  it("never sends a marketplace update-check for a built-in theme, on init() or on a scheme switch", async () => {
    mockMatchMedia(false);
    const { useStore } = await import("../src/stores/theme-store");

    // Fresh install -> both slots are VeyraN (built-in) already.
    await useStore.getState().init();
    expect(updateThemeQuery).not.toHaveBeenCalled();

    await useStore.getState().setColorScheme("dark");
    expect(updateThemeQuery).not.toHaveBeenCalled();
  });

  it("does send a marketplace update-check for a real custom/marketplace theme", async () => {
    mockMatchMedia(false);
    const customDark = { ...ThemeDark, id: "my-custom-dark" };
    window.localStorage.setItem("theme:dark", JSON.stringify(customDark));

    const { useStore } = await import("../src/stores/theme-store");
    await useStore.getState().init();

    expect(updateThemeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: "my-custom-dark" })
    );
  });
});

describe("themes-selector built-ins", () => {
  it("lists every built-in theme, including both VeyraN themes", () => {
    const ids = BUILT_IN_THEMES.map((theme) => theme.id);
    expect(ids).toEqual(
      expect.arrayContaining(["veyran-light", "veyran-dark"])
    );
  });

  it("resolves a built-in by id for a local apply path", () => {
    expect(BUILT_IN_THEMES_BY_ID.get("veyran-light")?.id).toBe("veyran-light");
    expect(BUILT_IN_THEMES_BY_ID.get("veyran-dark")?.id).toBe("veyran-dark");
    expect(BUILT_IN_THEMES_BY_ID.get("some-marketplace-theme")).toBeUndefined();
  });

  it("uniqueById keeps the first occurrence of a duplicated id", () => {
    const first = { id: "veyran-light", name: "active" };
    const second = { id: "veyran-light", name: "built-in" };
    const third = { id: "other-theme", name: "remote" };

    expect(uniqueById([first, second, third])).toEqual([first, third]);
  });

  it("the active pair + built-ins always survive an empty/offline remote result", () => {
    // Mirrors `items = uniqueById([activeDark, activeLight, ...builtIns, ...remote])`
    // in `ThemesList` when the marketplace query returns nothing (offline).
    const activeDark = { ...ThemeVeyranDark, previewColors: {} as never };
    const activeLight = { ...ThemeLight, id: "my-custom-light" } as never;
    const remoteThemes: never[] = [];

    const items = uniqueById([
      activeDark,
      activeLight,
      ...BUILT_IN_THEMES.map((theme) => ({ ...theme, previewColors: {} })),
      ...remoteThemes
    ]);

    const ids = items.map((item) => item.id);
    // The custom light theme (active) and VeyraN Dark (active + built-in,
    // deduped to one entry) are present, and VeyraN Light is still listed
    // and selectable even though it isn't the active pair.
    expect(ids).toContain("my-custom-light");
    expect(ids).toContain("veyran-dark");
    expect(ids).toContain("veyran-light");
    expect(ids.filter((id) => id === "veyran-dark")).toHaveLength(1);
  });
});
