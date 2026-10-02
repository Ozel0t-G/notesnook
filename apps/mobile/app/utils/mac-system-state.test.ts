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
  DEFAULT_MAC_SYSTEM_STATE,
  FALLBACK_SYSTEM_ACCENT,
  macAccent,
  macSelectionFill,
  normalizeMacSystemState,
  readMacSystemState
} from "./mac-system-state";

describe("Mac native system state", () => {
  test("reads the VeyraNMacMenu constants", () => {
    expect(
      readMacSystemState({ systemAccent: "#FF375F", windowActive: false })
    ).toEqual({ accent: "#FF375F", active: false });
  });

  test("falls back when the native module is missing", () => {
    expect(readMacSystemState(undefined)).toEqual(DEFAULT_MAC_SYSTEM_STATE);
    expect(readMacSystemState(undefined)).toEqual({
      accent: "#0A84FF",
      active: true
    });
    expect(DEFAULT_MAC_SYSTEM_STATE.accent).toBe(FALLBACK_SYSTEM_ACCENT);
  });

  test("falls back per field on a half-filled payload", () => {
    expect(readMacSystemState({ systemAccent: "#30D158" })).toEqual({
      accent: "#30D158",
      active: true
    });
    expect(readMacSystemState({ windowActive: true })).toEqual({
      accent: FALLBACK_SYSTEM_ACCENT,
      active: true
    });
  });

  test("rejects malformed values instead of storing them", () => {
    expect(
      readMacSystemState({ systemAccent: "", windowActive: "yes" })
    ).toEqual(DEFAULT_MAC_SYSTEM_STATE);
    expect(
      normalizeMacSystemState({ accent: "  ", active: 0 as unknown as boolean })
    ).toEqual(DEFAULT_MAC_SYSTEM_STATE);
  });

  test("keeps the given fallback when an update names no field", () => {
    const current = { accent: "#FF9F0A", active: false };
    expect(normalizeMacSystemState({}, current)).toEqual(current);
    expect(normalizeMacSystemState(undefined, current)).toEqual(current);
    expect(normalizeMacSystemState({ active: true }, current)).toEqual({
      accent: "#FF9F0A",
      active: true
    });
  });
});

describe("Mac selection fill", () => {
  test("uses the accent at low opacity while the window is active", () => {
    // Dark window: 0.22; light Mac window: 0.18, so the fill is not a
    // saturated block on the soft off-white surface.
    expect(macSelectionFill("#FF375F", true, true)).toEqual({
      color: "#FF375F",
      opacity: 0.22
    });
    expect(macSelectionFill("#FF375F", true, false)).toEqual({
      color: "#FF375F",
      opacity: 0.18
    });
  });

  test("goes neutral grey while the window is not active", () => {
    expect(macSelectionFill("#FF375F", false, false)).toEqual({
      color: "rgba(128,128,128,1)",
      opacity: 0.22
    });
    expect(macSelectionFill("#FF375F", false, true)).toEqual({
      color: "rgba(128,128,128,1)",
      opacity: 0.28
    });
  });

  test("never returns the accent for an inactive window", () => {
    const fill = macSelectionFill("#FF375F", false, true);
    expect(fill.color).not.toBe("#FF375F");
  });

  test("falls back to the blue accent when the bridge has no accent", () => {
    expect(macSelectionFill("", true, true).color).toBe(FALLBACK_SYSTEM_ACCENT);
  });
});

describe("Mac accent", () => {
  test("prefers the macOS system accent over the theme accent", () => {
    expect(macAccent("#0A84FF", "#FF375F")).toBe("#FF375F");
  });

  test("lets a user-chosen accent override the system one", () => {
    expect(macAccent("#0A84FF", "#FF375F", "#30D158")).toBe("#30D158");
  });

  test("falls back to the theme accent without a system accent", () => {
    expect(macAccent("#0A84FF", "")).toBe("#0A84FF");
  });
});
