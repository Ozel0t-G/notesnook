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

import { NativeModules } from "react-native";
import { create } from "zustand";
import type { MacSystemState } from "../utils/mac-system-state";
import {
  normalizeMacSystemState,
  readMacSystemState
} from "../utils/mac-system-state";

type MacSystemStore = MacSystemState & {
  setAccent: (accent: string) => void;
  setActive: (active: boolean) => void;
  /** Applies a (partial) native payload, keeping the current value per field. */
  setSystemState: (state: Partial<MacSystemState> | null | undefined) => void;
};

/**
 * The Mac's own accent colour and key-window state, as the native
 * VeyraNMacMenu module reports them (F1, N4, S1).
 *
 * Initialised from the module's constants (`systemAccent`, `windowActive`) so
 * the first paint already uses the right colours, then kept up to date by
 * hooks/use-mac-system-state.ts (the `VeyraNMacSystemState` event and one
 * `getSystemState()` call). Without the native module - iPhone, iPad, older
 * builds - it holds the documented defaults, and nothing reads it off Mac.
 */
export const useMacSystemStore = create<MacSystemStore>((set) => ({
  ...readMacSystemState(NativeModules?.VeyraNMacMenu),
  setAccent: (accent) => set({ accent }),
  setActive: (active) => set({ active }),
  setSystemState: (state) =>
    set((current) => normalizeMacSystemState(state, current))
}));
