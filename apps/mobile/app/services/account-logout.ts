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

import { MMKV } from "../common/database/mmkv";
import { resetTabStore } from "../screens/editor/tiptap/use-tab-store";
import { clearAllStores } from "../stores";
import { refreshAllStores } from "../stores/create-db-collection-store";
import { useUserStore } from "../stores/use-user-store";
import { eAfterSync } from "../utils/events";
import BiometricService from "./biometrics";
import { eSendEvent } from "./event-manager";
import Navigation from "./navigation";
import SettingsService from "./settings";

/** Core has reset the profile; native cleanup failure cannot retain its UI. */
export async function resetMobileAccountSession() {
  try {
    await BiometricService.resetCredentials();
  } finally {
    useUserStore.getState().setUser(null);
    useUserStore.setState({ accountSetupRequired: false });
    useUserStore.getState().setSyncing(false);
    useUserStore.getState().setIsLoggingOut(false);
    MMKV.clearStore();
    resetTabStore();
    clearAllStores();
    setImmediate(() => refreshAllStores());
    Navigation.queueRoutesForUpdate();
    SettingsService.resetSettings();
    eSendEvent(eAfterSync);
  }
}
