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

import { useEffect } from "react";
import { NativeEventEmitter, NativeModules } from "react-native";
import { useMacSystemStore } from "../stores/use-mac-system-store";
import { isMacCatalyst } from "../utils/constants";
import type { MacSystemState } from "../utils/mac-system-state";

/**
 * The native VeyraNMacMenu module emits the system accent / key-window state
 * under this event (the same module and NativeEventEmitter pattern as the
 * `VeyraNMacMenuCommand` menu commands in hooks/use-mac-menu-commands.ts).
 */
const MAC_SYSTEM_STATE_EVENT = "VeyraNMacSystemState";

/**
 * Keeps useMacSystemStore in sync with the Mac's accent colour and window
 * activity (F1, N4, S1). Mounted once from app.tsx, next to the other Mac
 * hooks (useMacMenuCommands, useMacWindowTitle), and inert on iPhone/iPad.
 *
 * The store already starts from the module's constants, so the only thing left
 * to do here is catch up on anything that changed between the bridge being
 * built and this hook mounting, and follow the native event afterwards.
 */
export const useMacSystemState = () => {
  const enabled = isMacCatalyst();

  useEffect(() => {
    const nativeModule = NativeModules?.VeyraNMacMenu;
    if (!enabled || !nativeModule) return;

    let cancelled = false;
    if (typeof nativeModule.getSystemState === "function") {
      Promise.resolve(nativeModule.getSystemState())
        .then((state: Partial<MacSystemState> | null | undefined) => {
          if (cancelled || !state) return;
          useMacSystemStore.getState().setSystemState(state);
        })
        .catch(() => {
          // The constants are already in the store; a failed catch-up (the
          // bridge not ready yet) is not worth surfacing.
        });
    }

    const emitter = new NativeEventEmitter(nativeModule);
    const subscription = emitter.addListener(
      MAC_SYSTEM_STATE_EVENT,
      (body: Partial<MacSystemState> | null | undefined) => {
        useMacSystemStore.getState().setSystemState(body);
      }
    );

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [enabled]);
};

export default useMacSystemState;
