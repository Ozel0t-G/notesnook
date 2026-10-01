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

type MacLayout = typeof import("./mac-layout");

/**
 * `mac-layout` caches the first real toolbar inset at module scope, so every
 * case needs its own freshly loaded copy of the module (and of the mocked
 * native bridge it reads the measurement from).
 */
const loadMacLayout = (toolbarHeight?: number): MacLayout => {
  jest.resetModules();
  jest.doMock("react-native", () => ({
    NativeModules:
      toolbarHeight === undefined
        ? {}
        : { VeyraNMacMenu: { toolbarHeight } }
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./mac-layout") as MacLayout;
};

describe("Mac toolbar inset", () => {
  afterEach(() => {
    jest.dontMock("react-native");
    jest.resetModules();
  });

  test("falls back to the constant while nothing is measured yet", () => {
    const { macToolbarInset, MAC_TOOLBAR_HEIGHT } = loadMacLayout(0);

    expect(macToolbarInset(0)).toBe(MAC_TOOLBAR_HEIGHT);
    expect(macToolbarInset(0)).toBe(MAC_TOOLBAR_HEIGHT);
  });

  test("prefers the native measured height over the safe-area inset", () => {
    const { macToolbarInset } = loadMacLayout(48);

    expect(macToolbarInset(0)).toBe(48);
    expect(macToolbarInset(30)).toBe(48);
  });

  test("caches the first real safe-area inset and stops flipping", () => {
    const { macToolbarInset, MAC_TOOLBAR_HEIGHT } = loadMacLayout(0);

    // UIKit has not laid the toolbar out yet: the fallback applies.
    expect(macToolbarInset(0)).toBe(MAC_TOOLBAR_HEIGHT);
    // The first real value is cached...
    expect(macToolbarInset(32)).toBe(32);
    // ...so a later 0 no longer falls back to the constant (R20)...
    expect(macToolbarInset(0)).toBe(32);
    // ...and a changed inset cannot move the laid-out chrome either.
    expect(macToolbarInset(60)).toBe(32);
  });

  test("caches the native measurement when the constant is fresh", () => {
    const { macToolbarInset } = loadMacLayout(44);

    expect(macToolbarInset(0)).toBe(44);
    // The measurement is stable from then on.
    expect(macToolbarInset(32)).toBe(44);
  });

  test("keeps using the safe-area inset when the bridge is not linked", () => {
    const { macToolbarInset, MAC_TOOLBAR_HEIGHT } = loadMacLayout(undefined);

    expect(macToolbarInset(0)).toBe(MAC_TOOLBAR_HEIGHT);
    expect(macToolbarInset(28)).toBe(28);
    expect(macToolbarInset(0)).toBe(28);
  });
});
