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
import { strings } from "@notesnook/intl";
import { AlertButton, AppState, NativeEventSubscription } from "react-native";
import { EVENTS, EventManagerSubscription } from "@notesnook/core";
import { DatabaseLogger, db } from "../../common/database";
import { AuthMode } from "../../components/auth/common";
import {
  endProgress,
  startProgress,
  updateProgress
} from "../../components/dialogs/progress";
import BackupService from "../../services/backup";
import { ToastManager } from "../../services/event-manager";
import Navigation from "../../services/navigation";
import { useUserStore } from "../../stores/use-user-store";
import { showAlert } from "../../utils/mac-alert";

let logoutInProgress = false;

function confirmSignOut(
  hasUnsyncedChanges: boolean,
  backupRequired: boolean
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const buttons: AlertButton[] = [
      { text: strings.cancel(), style: "cancel", onPress: () => resolve(null) },
      {
        text: strings.signOutWithBackup(),
        isPreferred: true,
        onPress: () => resolve(true)
      }
    ];
    if (!backupRequired)
      buttons.push({
        text: strings.signOutWithoutBackup(),
        style: "destructive",
        onPress: () => resolve(false)
      });
    showAlert(
      strings.signOut(),
      [
        strings.signOutLocalDataWarning(),
        backupRequired ? strings.signOutBackupRequired() : undefined,
        hasUnsyncedChanges ? strings.unsyncedChangesWarning() : undefined
      ]
        .filter(Boolean)
        .join("\n\n"),
      buttons,
      { cancelable: true, onDismiss: () => resolve(null) }
    );
  });
}

function confirmSignOutAfterBackupFailure(
  backupRequired: boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    const buttons: AlertButton[] = [
      { text: strings.cancel(), style: "cancel", onPress: () => resolve(false) }
    ];
    if (!backupRequired)
      buttons.push({
        text: strings.signOutWithoutBackup(),
        style: "destructive",
        onPress: () => resolve(true)
      });
    showAlert(
      strings.failedToTakeBackup(),
      backupRequired
        ? strings.signOutBackupRequired()
        : strings.signOutLocalDataWarning(),
      buttons,
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

export async function logoutUser(): Promise<boolean> {
  if (logoutInProgress) return false;
  logoutInProgress = true;
  let started = false;
  let syncPaused = false;
  let lifecycleSubscription: NativeEventSubscription | undefined;
  let leftForeground = false;
  let mutationSubscription: EventManagerSubscription | undefined;
  let dataChanged = false;
  const requireUnchangedData = () => {
    if (leftForeground || AppState.currentState !== "active")
      throw new Error(strings.signOutDataChanged());
    if (dataChanged) throw new Error(strings.signOutDataChanged());
  };
  try {
    const [hasUnsyncedChanges, affinityBlocked] = await Promise.all([
      db.hasUnsyncedChanges(),
      db.user.backendAffinity.isBlocked()
    ]);
    const backupRequired = hasUnsyncedChanges || affinityBlocked;
    const takeBackup = await confirmSignOut(hasUnsyncedChanges, backupRequired);
    if (takeBackup === null) return false;

    lifecycleSubscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") leftForeground = true;
    });
    useUserStore.getState().setIsLoggingOut(true);
    mutationSubscription = db.eventManager.subscribe(
      EVENTS.databaseUpdated,
      () => {
        dataChanged = true;
      }
    );
    started = true;
    startProgress({
      fillBackground: true,
      title: strings.loggingOut(),
      canHideProgress: false,
      paragraph: strings.loggingOutDesc()
    });

    db.syncer.sync.autoSync.stop();
    syncPaused = true;
    await Promise.all([db.syncer.stop(), db.fs().cancel("sync-uploads")]);

    return await db.withAccountDataWriteBarrier(async (assertUnchanged) => {
      const assertBarrierUnchanged = () => {
        try {
          assertUnchanged();
        } catch {
          throw new Error(strings.signOutDataChanged());
        }
      };
      let backupSaved = false;
      if (takeBackup) {
        updateProgress({ progress: strings.backingUpData() });
        try {
          const result = await BackupService.run(false, "local", "full", {
            requireLocalAttachments: true
          });
          if (result.error) throw result.error;
          // A concurrent/skipped backup returns {}. It is not a saved backup.
          if (!result.path) throw new Error(strings.backupFailed());
          backupSaved = true;
        } catch (error) {
          DatabaseLogger.error(error);
          endProgress();
          const [stillUnsynced, stillBlocked] = await Promise.all([
            db.hasUnsyncedChanges(),
            db.user.backendAffinity.isBlocked()
          ]);
          const stillRequiresBackup = stillUnsynced || stillBlocked;
          if (!(await confirmSignOutAfterBackupFailure(stillRequiresBackup)))
            return false;
          startProgress({
            fillBackground: true,
            title: strings.loggingOut(),
            canHideProgress: false,
            paragraph: strings.loggingOutDesc()
          });
        }
      }

      // Affinity/recovery state may change while the native dialog is open.
      const [stillUnsynced, stillBlocked] = await Promise.all([
        db.hasUnsyncedChanges(),
        db.user.backendAffinity.isBlocked()
      ]);
      if (!backupSaved && (stillUnsynced || stillBlocked)) {
        ToastManager.show({
          message: strings.signOutBackupRequired(),
          type: "info"
        });
        return false;
      }
      updateProgress({ progress: strings.loggingOut() });
      requireUnchangedData();
      assertBarrierUnchanged();
      await db.user.logout(true, undefined, {
        beforeClearLocalData: () => {
          requireUnchangedData();
          assertBarrierUnchanged();
        }
      });
      Navigation.navigate("Auth", { mode: AuthMode.login });
      return true;
    });
  } catch (error) {
    DatabaseLogger.error(error);
    ToastManager.error(error as Error, strings.logoutError());
    if (started && !useUserStore.getState().user)
      Navigation.navigate("Auth", { mode: AuthMode.login });
    return false;
  } finally {
    lifecycleSubscription?.remove();
    mutationSubscription?.unsubscribe();
    if (started) {
      endProgress();
      useUserStore.getState().setIsLoggingOut(false);
    }
    if (syncPaused && useUserStore.getState().user) {
      void db.syncer.sync.autoSync.start().catch(DatabaseLogger.error);
    }
    logoutInProgress = false;
  }
}
