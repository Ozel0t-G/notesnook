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

import { db } from "../../common/database";
import { eSendEvent } from "../../services/event-manager";
import { clearMessage, setEmailVerifyMessage } from "../../services/message";
import SettingsService from "../../services/settings";
import Sync from "../../services/sync";
import { useUserStore } from "../../stores/use-user-store";
import { eUserLoggedIn } from "../../utils/events";

/** Publish only a verified, committed session to the mobile UI. */
export async function completeAccountBootstrap(
  onReady?: () => void | Promise<void>
) {
  const { user, lastSynced } = await db.user.assertAccountReady();
  const profile = db.settings.getProfile();
  SettingsService.set({
    sessionExpired: false,
    userEmailConfirmed: user.isEmailConfirmed,
    encryptedBackup: true,
    introCompleted: true
  });
  useUserStore.setState({
    user,
    profile,
    lastSynced: lastSynced ?? "Never",
    accountSetupRequired: false
  });
  clearMessage();
  if (!user.isEmailConfirmed) setEmailVerifyMessage();
  eSendEvent(eUserLoggedIn, true);
  await onReady?.();
  // The core commit initialized the encrypted keyset, device and checkpoint.
  // A later offline sync failure belongs to normal app sync, not registration.
  if (!useUserStore.getState().syncing) void Sync.run("global", false, "full");
  return user;
}

/**
 * A completed core transaction must not be repeated when UI hydration fails.
 * A failed core transaction is retried through core's retained signup state.
 */
export class SignupAttempt {
  private committed = false;
  private running?: Promise<void>;

  run(register: () => Promise<void>, complete: () => Promise<unknown>) {
    if (this.running) return this.running;
    this.running = (async () => {
      if (!this.committed) {
        await register();
        this.committed = true;
      }
      await complete();
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}

// This deadline changes presentation only. It never marks an unfinished
// transaction successful or permits a second operation to race the first.
export const ACCOUNT_SETUP_NOTICE_MS = 120_000;
