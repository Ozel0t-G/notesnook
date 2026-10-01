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

let mockIsMacCatalyst = true;

const mockSetWindowAppearance = jest.fn();

jest.mock("react-native", () => ({
  NativeModules: {
    VeyraNMacMenu: {
      setWindowAppearance: (style: string) => mockSetWindowAppearance(style)
    }
  }
}));

jest.mock("./constants", () => ({
  isMacCatalyst: () => mockIsMacCatalyst
}));

import { NativeModules } from "react-native";
import { syncMacWindowAppearance } from "./mac-window-appearance";

describe("Mac window appearance", () => {
  beforeEach(() => {
    mockIsMacCatalyst = true;
    mockSetWindowAppearance.mockClear();
  });

  test("pins the window to the app theme when the system theme is off", () => {
    syncMacWindowAppearance(false, "light");
    syncMacWindowAppearance(false, "dark");

    expect(mockSetWindowAppearance.mock.calls).toEqual([["light"], ["dark"]]);
  });

  test("lets the window follow the system when the app follows it too", () => {
    syncMacWindowAppearance(true, "dark");

    expect(mockSetWindowAppearance).toHaveBeenCalledWith("system");
  });

  test("does nothing outside Mac Catalyst", () => {
    mockIsMacCatalyst = false;

    syncMacWindowAppearance(false, "dark");

    expect(mockSetWindowAppearance).not.toHaveBeenCalled();
  });

  test("does nothing when the native module is not linked", () => {
    const native = NativeModules as unknown as Record<string, unknown>;
    const nativeModule = native.VeyraNMacMenu;
    native.VeyraNMacMenu = undefined;
    try {
      syncMacWindowAppearance(false, "dark");
    } finally {
      native.VeyraNMacMenu = nativeModule;
    }

    expect(mockSetWindowAppearance).not.toHaveBeenCalled();
  });
});
