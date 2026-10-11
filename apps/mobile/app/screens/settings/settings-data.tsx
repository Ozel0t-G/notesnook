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

import { formatBytes } from "@notesnook/common";
import { User } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import notifee from "@notifee/react-native";
import React from "react";
import { Appearance, Platform } from "react-native";
import { getVersion } from "react-native-device-info";
import { DatabaseLogger, db } from "../../common/database";
import { MMKV } from "../../common/database/mmkv";
import filesystem from "../../common/filesystem";
import { presentDialog } from "../../components/dialog/functions";
import { AppLockPassword } from "../../components/dialogs/applock-password";
import ExportNotesSheet from "../../components/sheets/export-notes";
import { Progress } from "../../components/sheets/progress";
import { VaultStatusType, useVaultStatus } from "../../hooks/use-vault-status";
import { BackgroundSync } from "../../services/background-sync";
import BackupService from "../../services/backup";
import BiometricService from "../../services/biometrics";
import {
  ToastManager,
  VaultRequestType,
  eSendEvent,
  eSubscribeEvent,
  openVault
} from "../../services/event-manager";
import Navigation from "../../services/navigation";
import { openAppNotificationSettings } from "../../services/notification-settings";
import Notifications from "../../services/notifications";
import PremiumService from "../../services/premium";
import { ReminderWidget } from "../../services/reminder-widget";
import SettingsService from "../../services/settings";
import Sync from "../../services/sync";
import { clearAllStores } from "../../stores";
import { refreshAllStores } from "../../stores/create-db-collection-store";
import { useSettingStore } from "../../stores/use-setting-store";
import { useThemeStore } from "../../stores/use-theme-store";
import { useUserStore } from "../../stores/use-user-store";
import { EDITOR_LINE_HEIGHT, isMacCatalyst } from "../../utils/constants";
import {
  eAfterSync,
  eCloseSheet,
  eOpenRecoveryKeyDialog
} from "../../utils/events";
import { showAlert } from "../../utils/mac-alert";
import { sleep } from "../../utils/time";
import { resetTabStore } from "../editor/tiptap/use-tab-store";
import { MFARecoveryCodes, MFASheet } from "./2fa";
import { useDragState } from "./editor/state";
import { verifyUser, verifyUserWithApplock } from "./functions";
import { logoutUser } from "./logout";
import { SettingSection } from "./types";
import {
  cachedBiometryLockTitle,
  cachedBiometryName
} from "../../hooks/use-biometry";
import { useNotificationAlarmStatus } from "./notification-alarm-status";
import { AuthMode } from "../../components/auth/common";
import {
  createAccountSection,
  createLocalDataSection,
  createSignedOutAccountSection
} from "./account-section";

export const settingsGroups: SettingSection[] = [
  createSignedOutAccountSection(() => {
    Navigation.navigate("Auth", { mode: AuthMode.login });
  }),
  createAccountSection(
    [
      {
        id: "account-settings",
        type: "screen",
        name: strings.manageAccount(),
        icon: "account-cog",
        description: strings.manageAccountDesc(),
        sections: [
          {
            id: "remove-profile-picture",
            name: strings.removeProfilePicture(),
            description: strings.removeProfilePictureDesc(),
            useHook: () =>
              useUserStore((state) => state.profile?.profilePicture),
            hidden: () => !useUserStore.getState().profile?.profilePicture,
            modifer: () => {
              presentDialog({
                title: strings.removeProfilePicture(),
                paragraph: strings.removeProfilePictureConfirmation(),
                positiveText: strings.remove(),
                positivePress: async () => {
                  db.settings
                    .setProfile({
                      profilePicture: undefined
                    })
                    .then(async () => {
                      useUserStore.setState({
                        profile: db.settings.getProfile()
                      });
                    });
                }
              });
            }
          },
          {
            id: "remove-name",
            name: strings.removeFullName(),
            description: strings.removeFullNameDesc(),
            useHook: () => useUserStore((state) => state.profile?.fullName),
            hidden: () => !useUserStore.getState().profile?.fullName,
            modifer: () => {
              presentDialog({
                title: strings.removeFullName(),
                paragraph: strings.removeFullNameConfirmation(),
                positiveText: strings.remove(),
                positivePress: async () => {
                  db.settings
                    .setProfile({
                      fullName: undefined
                    })
                    .then(async () => {
                      useUserStore.setState({
                        profile: db.settings.getProfile()
                      });
                    });
                }
              });
            }
          },
          {
            id: "recovery-key",
            name: strings.saveDataRecoveryKey(),
            modifer: async () => {
              verifyUser(null, async () => {
                await sleep(300);
                eSendEvent(eOpenRecoveryKeyDialog);
              });
            },
            description: strings.saveDataRecoveryKeyDesc(),
            icon: "key"
          },
          {
            id: "manage-attachments",
            name: strings.manageAttachments(),
            icon: "attachment",
            type: "screen",
            component: "attachments-manager",
            description: strings.manageAttachmentsDesc(),
            hideHeader: true
          },
          {
            id: "2fa-settings",
            type: "screen",
            name: strings.twoFactorAuth(),
            description: strings.twoFactorAuthDesc(),
            icon: "two-factor-authentication",
            sections: [
              {
                id: "enable-2fa",
                name: strings.change2faMethod(),
                modifer: () => {
                  verifyUser("global", async () => {
                    MFASheet.present();
                  });
                },
                useHook: () => useUserStore((state) => state.user),
                description: strings.change2faMethodDesc()
              },
              {
                id: "2fa-fallback",
                name: strings.addFallback2faMethod(),
                useHook: () => useUserStore((state) => state.user),
                hidden: (user) => {
                  return (
                    !!(user as User)?.mfa?.secondaryMethod ||
                    !(user as User)?.mfa?.isEnabled
                  );
                },
                modifer: () => {
                  verifyUser("global", async () => {
                    MFASheet.present(true);
                  });
                },
                description: strings.addFallback2faMethodDesc()
              },
              {
                id: "change-2fa-method",
                name: strings.change2faFallbackMethod(),
                useHook: () => useUserStore((state) => state.user),
                hidden: (user) => {
                  return (
                    !(user as User)?.mfa?.secondaryMethod ||
                    !(user as User)?.mfa?.isEnabled
                  );
                },
                modifer: () => {
                  verifyUser("global", async () => {
                    MFASheet.present(true);
                  });
                },
                description: strings.change2faFallbackMethod()
              },
              {
                id: "view-2fa-codes",
                name: strings.viewRecoveryCodes(),
                modifer: () => {
                  verifyUser("global", async () => {
                    MFARecoveryCodes.present("sms");
                  });
                },
                useHook: () => useUserStore((state) => state.user),
                hidden: (user) => {
                  return !(user as User)?.mfa?.isEnabled;
                },
                description: strings.viewRecoveryCodesDesc()
              }
            ]
          },
          {
            id: "clear-cache",
            name: strings.clearCache(),
            icon: "delete",
            modifer: async () => {
              presentDialog({
                title: strings.clearCacheConfirm(),
                paragraph: strings.clearMobileCacheConfirmDesc(),
                positiveText: strings.clear(),
                positivePress: async () => {
                  await filesystem.clearCache();
                  ToastManager.show({
                    heading: strings.cacheCleared(),
                    message: strings.mobileCacheClearedDesc(),
                    type: "success"
                  });
                }
              });
            },
            description(current) {
              return strings.clearMobileCacheDesc(current as number);
            },
            useHook: () => {
              const [cacheSize, setCacheSize] = React.useState(0);
              React.useEffect(() => {
                filesystem
                  .getCacheSize()
                  .then(setCacheSize)
                  .catch(() => {
                    /* empty */
                  });
                const sub = eSubscribeEvent("cache-cleared", () => {
                  // Pending-upload ciphertext is intentionally kept by
                  // clearCache, so recompute the real remaining size instead of
                  // assuming the cache is empty.
                  filesystem
                    .getCacheSize()
                    .then(setCacheSize)
                    .catch(() => {
                      /* empty */
                    });
                });
                return () => {
                  sub?.unsubscribe();
                };
              }, []);
              return formatBytes(cacheSize);
            }
          }
        ]
      },
      {
        id: "sync-settings",
        name: strings.syncSettings(),
        description: strings.syncSettingsDesc(),
        type: "screen",
        icon: "autorenew",
        component: "offline-mode-progress",
        sections: [
          {
            id: "offline-mode",
            icon: "download-multiple",
            name: strings.fullOfflineMode(),
            description: strings.fullOfflineModeDesc(),
            type: "switch",
            property: "offlineMode",
            featureId: "fullOfflineMode",
            modifer: () => {
              const current = SettingsService.get().offlineMode;
              if (current) {
                SettingsService.setProperty("offlineMode", false);
                db.fs().cancel("offline-mode");
                return;
              }
              SettingsService.setProperty("offlineMode", true);
              db.attachments.cacheAttachments().catch(() => {
                /* empty */
              });
            }
          },
          {
            id: "auto-sync",
            name: strings.disableAutoSync(),
            description: strings.disableAutoSyncDesc(),
            type: "switch",
            property: "disableAutoSync",
            featureId: "syncControls",
            icon: "sync-off"
          },
          {
            id: "disable-realtime-sync",
            name: strings.disableRealtimeSync(),
            description: strings.disableRealtimeSyncDesc(),
            type: "switch",
            property: "disableRealtimeSync",
            featureId: "syncControls"
          },
          {
            id: "disable-sync",
            name: strings.disableSync(),
            description: strings.disableSyncDesc(),
            type: "switch",
            property: "disableSync",
            featureId: "syncControls",
            icon: "cloud-off-outline"
          },
          {
            id: "background-sync",
            name: strings.backgroundSync(),
            description: strings.backgroundSyncDesc(),
            type: "switch",
            property: "backgroundSync",
            icon: "cloud-upload-outline",
            onChange: (value) => {
              if (value) {
                BackgroundSync.start();
              } else {
                BackgroundSync.stop();
              }
            }
          },
          {
            id: "pull-sync",
            name: strings.forcePullChanges(),
            description: strings.forcePullChangesDesc(),
            icon: "download",
            modifer: () => {
              presentDialog({
                title: strings.forcePullChanges(),
                paragraph: strings.forceSyncNotice(),
                negativeText: strings.cancel(),
                positiveText: strings.start(),
                positivePress: async () => {
                  eSendEvent(eCloseSheet);
                  await sleep(300);
                  Progress.present();
                  Sync.run("global", true, "fetch", () => {
                    eSendEvent(eCloseSheet);
                  });
                }
              });
            }
          },
          {
            id: "push-sync",
            name: strings.forcePushChanges(),
            description: strings.forcePushChangesDesc(),
            icon: "upload",
            modifer: () => {
              presentDialog({
                title: strings.forcePushChanges(),
                paragraph: strings.forceSyncNotice(),
                negativeText: strings.cancel(),
                positiveText: strings.start(),
                positivePress: async () => {
                  eSendEvent(eCloseSheet);
                  await sleep(300);
                  Progress.present();
                  Sync.run("global", true, "send", () => {
                    eSendEvent(eCloseSheet);
                  });
                }
              });
            }
          }
        ]
      },
      // Notesnook Circle is Notesnook's own partner-offer marketplace,
      // reached through the billing host VeyraN does not use (see
      // packages/core/src/api/veyran-billing-policy.ts and
      // artifacts/veyran-brand-entitlement-audit.md), so its settings entry
      // is not registered here.
      {
        id: "inbox-api",
        name: strings.inboxAPI(),
        icon: "inbox",
        type: "screen",
        description: strings.inboxAPIDesc(),
        sections: [
          {
            id: "toggle-inbox-api",
            name: strings.enableInboxAPI(),
            description: strings.enableInboxAPIDesc(),
            type: "switch",
            useHook: () => {
              return useSettingStore((state) => state.inboxEnabled);
            },
            getter: (current) => current,
            modifer: async (current) => {
              if (current) {
                return new Promise((resolve) => {
                  presentDialog({
                    title: strings.disableInboxAPI(),
                    paragraph: strings.disableInboxAPIDesc(),
                    positiveText: strings.disable(),
                    onClose: () => {
                      resolve();
                    },
                    positivePress: async () => {
                      try {
                        await db.inboxItemsHistory.deleteFailed();
                        await db.user.discardInboxKeys();
                        useSettingStore.setState({
                          inboxEnabled: false
                        });
                        resolve();
                        return true;
                      } catch (e) {
                        ToastManager.show({
                          message: (e as Error).message,
                          context: "local"
                        });
                        DatabaseLogger.error(e);
                        return false;
                      }
                    }
                  });
                });
              }

              try {
                Navigation.push("SettingsGroup", {
                  id: "setup-inbox-keys",
                  name: strings.setupInboxKeys(),
                  type: "screen",
                  component: "setup-inbox-keys"
                } as any);
              } catch (e) {
                console.log(e);
              }
            }
          },
          {
            id: "manage-inbox-keys",
            name: strings.manageInboxKeys(),
            useHook: () => useSettingStore((state) => state.inboxEnabled),
            hidden: (current) => !current,
            description: strings.manageInboxKeysDesc(),
            onVerify: async () => {
              return new Promise((resolve) => {
                verifyUser(
                  "global",
                  () => {
                    resolve(true);
                  },
                  false,
                  () => resolve(false)
                );
              });
            },
            type: "screen",
            component: "manage-inbox-keys"
          },
          {
            id: "inbox-keys",
            name: strings.viewAPIKeys(),
            description: strings.viewAPIKeysDesc(),
            useHook: () => useSettingStore((state) => state.inboxEnabled),
            hidden: (current) => !current,
            type: "screen",
            component: "inbox-keys"
          },
          {
            id: "failed-inbox-items",
            name: strings.failedInboxItems(),
            description: strings.failedInboxItemsDesc(),
            useHook: () => useSettingStore((state) => state.inboxEnabled),
            hidden: (current) => !current,
            type: "screen",
            component: "failed-inbox-items",
            hideHeader: true
          }
        ]
      }
    ],
    logoutUser
  ),
  {
    id: "customize",
    name: strings.customization(),
    sections: [
      {
        id: "personalization",
        type: "screen",
        name: strings.appearance(),
        description: strings.appearanceDesc(),
        icon: "shape",
        sections: [
          {
            id: "theme-picker",
            type: "screen",
            name: strings.themes(),
            description: strings.themesDesc(),
            component: "theme-selector",
            icon: "shape"
          },
          {
            id: "use-system-theme",
            type: "switch",
            name: strings.useSystemTheme(),
            description: strings.useSystemThemeDesc(),
            property: "useSystemTheme",
            icon: "circle-half",
            modifer: () => {
              const current = SettingsService.get().useSystemTheme;
              SettingsService.set({
                useSystemTheme: !current
              });
              if (!current) {
                useThemeStore
                  .getState()
                  .setColorScheme(Appearance.getColorScheme() as any);
              }
            }
          },
          {
            id: "enable-dark-mode",
            type: "switch",
            name: strings.darkMode(),
            description: strings.darkModeDesc(),
            property: "colorScheme",
            icon: "brightness-6",
            modifer: () => {
              useThemeStore.getState().setColorScheme();
            },
            getter: () => useThemeStore.getState().colorScheme === "dark"
          }
        ]
      },
      {
        id: "behaviour",
        type: "screen",
        icon: "brain",
        name: strings.behavior(),
        description: strings.behaviorDesc(),
        sections: [
          {
            id: "default-sidebar-view",
            type: "component",
            name: strings.defaultSidebarTab(),
            description: strings.defaultSidebarTabDesc(),
            component: "sidebar-tab-selector"
          },
          {
            id: "date-format",
            name: strings.dateFormat(),
            description: strings.dateFormatDesc(),
            type: "component",
            component: "date-format-selector",
            icon: "calendar-blank"
          },
          {
            id: "day-format",
            name: strings.dayFormat(),
            description: strings.dayFormatDesc(),
            type: "component",
            component: "day-format-selector",
            icon: "calendar-today"
          },
          {
            id: "week-format",
            name: strings.weekFormat(),
            description: strings.weekFormatDesc(),
            type: "component",
            component: "week-format-selector",
            icon: "calendar"
          },
          {
            id: "time-format",
            name: strings.timeFormat(),
            description: strings.timeFormatDesc(),
            type: "component",
            component: "time-format-selector",
            icon: "clock-digital"
          },
          {
            id: "notebook-date-grouping",
            type: "screen",
            name: strings.notebooks(),
            description: strings.groupBy(),
            component: "notebook-date-grouping",
            icon: "calendar"
          },
          {
            id: "clear-trash-interval",
            type: "component",
            name: strings.clearTrashInterval(),
            description: strings.clearTrashIntervalDesc(),
            component: "trash-interval-selector",
            icon: "delete"
          },
          {
            id: "default-notebook",
            name: strings.clearDefaultNotebook(),
            description: strings.clearDefaultNotebookDesc(),
            modifer: () => {
              db.settings.setDefaultNotebook(undefined);
              ToastManager.show({
                heading: strings.defaultNotebookCleared(),
                type: "success"
              });
            },
            disabled: () => !db.settings.getDefaultNotebook(),
            icon: "notebook-minus"
          },
          {
            id: "keep-screen-on",
            type: "switch",
            name: strings.keepScreenOn(),
            description: strings.keepScreenOnDesc(),
            property: "keepScreenOn",
            icon: "cellphone-screenshot"
          },
          {
            id: "image-compression",
            type: "component",
            name: strings.imageCompression(),
            description: strings.imageCompressionDesc(),
            component: "image-compression-picker",
            icon: "image-area"
          }
        ]
      },
      {
        id: "editor",
        name: strings.editor(),
        type: "screen",
        icon: "note-edit-outline",
        description: strings.editorDesc(),
        sections: [
          {
            id: "configure-toolbar",
            type: "screen",
            name: strings.customizeToolbar(),
            description: strings.customizeToolbarDesc(),
            component: "configuretoolbar"
          },
          {
            id: "reset-toolbar",
            name: strings.resetToolbar(),
            description: strings.resetToolbarDesc(),
            modifer: () => {
              useDragState.getState().setPreset("default");
              ToastManager.show({
                heading: strings.toolbarReset(),
                type: "success"
              });
            }
          },
          {
            id: "double-spaced-lines",
            name: strings.doubleSpacedLines(),
            description: strings.doubleSpacedLinesDesc(),
            type: "switch",
            property: "doubleSpacedLines",
            icon: "format-line-spacing",
            onChange: () => {
              ToastManager.show({
                heading: strings.lineSpacingChanged(),
                type: "success"
              });
            }
          },
          {
            id: "default-font-size",
            name: strings.defaultFontSize(),
            description: strings.defaultFontSizeDesc(),
            type: "input-selector",
            minInputValue: 8,
            maxInputValue: 120,
            icon: "format-size",
            property: "defaultFontSize"
          },
          {
            id: "default-font-family",
            name: strings.defaultFontFamily(),
            description: strings.defaultFontFamilyDesc(),
            type: "component",
            icon: "format-font",
            property: "defaultFontFamily",
            component: "font-selector"
          },
          {
            id: "default-line-height",
            name: strings.lineHeight(),
            description: strings.lineHeightDesc(),
            type: "input-selector",
            property: "defaultLineHeight",
            icon: "format-line-spacing",
            minInputValue: EDITOR_LINE_HEIGHT.MIN,
            maxInputValue: EDITOR_LINE_HEIGHT.MAX
          },
          {
            id: "title-format",
            name: strings.titleFormat(),
            component: "title-format",
            description: strings.titleFormatDesc(),
            type: "component"
          },
          {
            id: "toggle-markdown",
            name: strings.mardownShortcuts(),
            property: "markdownShortcuts",
            description: strings.mardownShortcutsDesc(),
            type: "switch",
            featureId: "markdownShortcuts"
          }
        ]
      },
      {
        id: "servers",
        type: "screen",
        name: strings.servers(),
        description:
          Platform.OS === "ios"
            ? undefined
            : strings.serversConfigurationDesc(),
        icon: "server",
        component: "server-config",
        hidden: () =>
          !__DEV__ &&
          Object.keys(SettingsService.getProperty("serverUrls") || {})
            .length === 0
      }
    ]
  },
  {
    id: "privacy-security",
    name: strings.privacyAndSecurity(),
    sections: [
      {
        id: "marketing-emails",
        type: "switch",
        icon: "email-newsletter",
        name: strings.marketingEmails(),
        description: strings.marketingEmailsDesc(),
        modifer: async () => {
          try {
            await db.user?.changeMarketingConsent(
              !useUserStore.getState().user?.marketingConsent
            );
            useUserStore.getState().setUser(await db.user?.fetchUser());
          } catch (e) {
            ToastManager.error(e as Error);
          }
        },
        getter: (current: any) => current?.marketingConsent,
        useHook: () => useUserStore((state) => state.user),
        hidden: (current) => !current
      },
      {
        id: "vault",
        type: "screen",
        name: strings.vault(),
        description: strings.vaultDesc(),
        icon: "key",
        sections: [
          {
            id: "create-vault",
            name: strings.createVault(),
            description: strings.createVaultDesc(),
            icon: "key",
            useHook: useVaultStatus,
            hidden: (current) => (current as VaultStatusType)?.exists,
            modifer: () => {
              openVault({
                requestType: VaultRequestType.CreateVault,
                title: strings.createVault(),
                buttonTitle: strings.create()
              });
            }
          },
          {
            id: "lock-vault-after",
            type: "component",
            useHook: useVaultStatus,
            name: strings.lockVaultAfter(),
            description: strings.lockVaultAfterDesc(),
            hidden: (current) => !(current as VaultStatusType)?.exists,
            component: "vault-lock-timer",
            icon: "clock-outline"
          },
          {
            id: "change-vault-password",
            useHook: useVaultStatus,
            name: strings.changeVaultPassword(),
            description: strings.changeVaultPasswordDesc(),
            hidden: (current) => !(current as VaultStatusType)?.exists,
            modifer: () =>
              openVault({
                requestType: VaultRequestType.ChangePassword,
                title: strings.changeVaultPassword(),
                buttonTitle: strings.change()
              })
          },
          {
            id: "clear-vault",
            useHook: useVaultStatus,
            description: strings.clearVaultDesc(),
            name: strings.clearVault(),
            hidden: (current) => !(current as VaultStatusType)?.exists,
            modifer: () => {
              openVault({
                requestType: VaultRequestType.ClearVault,
                title: strings.clearVault() + "?",
                buttonTitle: strings.clear(),
                positiveButtonType: "errorShade"
              });
            }
          },
          {
            id: "delete-vault",
            name: strings.deleteVault(),
            description: strings.deleteVaultDesc(),
            useHook: useVaultStatus,
            hidden: (current) => !(current as VaultStatusType)?.exists,
            modifer: () => {
              openVault({
                requestType: VaultRequestType.DeleteVault,
                title: strings.deleteVault() + "?",
                buttonTitle: strings.delete(),
                positiveButtonType: "errorShade"
              });
            }
          },
          {
            id: "biometric-unlock",
            type: "switch",
            name: strings.biometricUnlock(),
            icon: "fingerprint",
            useHook: useVaultStatus,
            description: strings.biometricUnlockDesc(),
            hidden: (current) => {
              const _current = current as VaultStatusType;
              return !_current?.exists || !_current?.isBiometryAvailable;
            },
            getter: (current) => (current as VaultStatusType)?.biometryEnrolled,
            modifer: (current) => {
              const _current = current as VaultStatusType;
              const isRevoking = _current.biometryEnrolled;
              openVault({
                requestType: isRevoking
                  ? VaultRequestType.RevokeFingerprint
                  : VaultRequestType.EnableFingerprint,
                title: isRevoking
                  ? strings.revokeBiometricUnlock()
                  : strings.vaultEnableBiometrics(),
                buttonTitle: isRevoking ? strings.revoke() : strings.enable()
              });
            }
          }
        ]
      },
      {
        id: "privacy-mode",
        type: "switch",
        icon: "eye-off-outline",
        name: strings.privacyMode(),
        description: strings.privacyModeDesc(),
        modifer: () => {
          const settings = SettingsService.get();
          SettingsService.setPrivacyScreen(!settings.privacyScreen);
          SettingsService.set({ privacyScreen: !settings.privacyScreen });
        },
        property: "privacyScreen"
      },
      {
        id: "app-lock",
        name: Platform.OS === "ios" ? cachedBiometryLockTitle : strings.appLock(),
        type: "screen",
        description: strings.appLockDesc(),
        icon: "lock",
        featureId: "appLock",
        sections: [
          {
            id: "app-lock-mode",
            name: strings.enableAppLock(),
            description: () =>
              Platform.OS === "ios" && cachedBiometryName()
                ? strings.appLockBiometryDesc(cachedBiometryName())
                : strings.appLockDesc(),
            icon: "lock",
            type: "switch",
            property: "appLockEnabled",
            featureId: "appLock",
            onChange: (property) => {
              if (property) {
                SettingsService.set({
                  privacyScreen: true
                });
                SettingsService.setPrivacyScreen(true);
              }
            },
            onVerify: async () => {
              const verified = await verifyUserWithApplock();
              if (!verified) return false;

              if (!SettingsService.getProperty("appLockEnabled")) {
                if (
                  !SettingsService.getProperty("appLockHasPasswordSecurity") &&
                  (await BiometricService.isBiometryAvailable())
                ) {
                  SettingsService.setProperty("biometricsAuthEnabled", true);
                }

                if (
                  !(await BiometricService.isBiometryAvailable()) &&
                  !SettingsService.getProperty("appLockHasPasswordSecurity")
                ) {
                  ToastManager.show({
                    heading: strings.biometricsNotEnrolled(),
                    type: "error",
                    message: strings.biometricsNotEnrolledDesc()
                  });
                  return false;
                }
              }

              return verified;
            }
          },
          {
            id: "app-lock-timer",
            name: strings.appLockTimeout(),
            description: strings.appLockTimeoutDesc(),
            type: "component",
            component: "applock-timer"
          },
          {
            id: "app-lock-pin",
            name: () =>
              SettingsService.getProperty("applockKeyboardType") === "numeric"
                ? strings.setupAppLockPin()
                : strings.setupAppLockPassword(),

            description: () =>
              SettingsService.getProperty("applockKeyboardType") === "numeric"
                ? strings.setupAppLockPinDesc()
                : strings.setupAppLockPasswordDesc(),
            hidden: () => {
              return !!SettingsService.getProperty(
                "appLockHasPasswordSecurity"
              );
            },
            onVerify: () => {
              return verifyUserWithApplock();
            },
            property: "appLockHasPasswordSecurity",
            modifer: () => {
              AppLockPassword.present("create");
            }
          },
          {
            id: "app-lock-pin-change",
            name: () =>
              SettingsService.getProperty("applockKeyboardType") === "numeric"
                ? strings.changeAppLockPin()
                : strings.changeAppLockPassword(),
            description: () =>
              SettingsService.getProperty("applockKeyboardType") === "numeric"
                ? strings.changeAppLockPinDesc()
                : strings.changeAppLockPasswordDesc(),
            hidden: () => {
              return !SettingsService.getProperty("appLockHasPasswordSecurity");
            },
            property: "appLockHasPasswordSecurity",
            modifer: () => {
              AppLockPassword.present("change");
            }
          },
          {
            id: "app-lock-pin-remove",
            name: () =>
              SettingsService.getProperty("applockKeyboardType") === "numeric"
                ? strings.removeAppLockPin()
                : strings.removeAppLockPassword(),
            description: () =>
              SettingsService.getProperty("applockKeyboardType") === "numeric"
                ? strings.removeAppLockPinDesc()
                : strings.removeAppLockPasswordDesc(),
            hidden: () => {
              return !SettingsService.getProperty("appLockHasPasswordSecurity");
            },
            property: "appLockHasPasswordSecurity",
            modifer: () => {
              AppLockPassword.present("remove");
            }
          },
          {
            id: "app-lock-fingerprint",
            name: () =>
              cachedBiometryName()
                ? strings.unlockWithBiometryName(cachedBiometryName())
                : strings.unlockWithBiometrics(),
            description: strings.unlockWithBiometricsDesc(),
            type: "switch",
            property: "biometricsAuthEnabled",
            onVerify: async () => {
              const verified = await verifyUserWithApplock();
              if (!verified) return false;

              if (SettingsService.getProperty("biometricsAuthEnabled")) {
                if (
                  !SettingsService.getProperty("appLockHasPasswordSecurity")
                ) {
                  SettingsService.setProperty("appLockEnabled", false);
                  ToastManager.show({
                    heading: strings.appLockDisabled(),
                    type: "success"
                  });
                }
              }

              return verified;
            },
            icon: "fingerprint"
          }
        ]
      }
    ]
  },
  createLocalDataSection(() => {
    presentDialog({
      title: strings.deleteLocalData(),
      paragraph: strings.deleteLocalDataDesc(),
      positiveType: "errorShade",
      positiveText: strings.deleteLocalData(),
      positivePress: async () => {
        // The confirmation may outlive a login transition. A local-only
        // wipe must never clear an authenticated profile by accident.
        if (await db.user.getUser()) return false;
        await ReminderWidget.clear();
        await PremiumService.setPremiumStatus();
        await BiometricService.resetCredentials();
        MMKV.clearStore();
        resetTabStore();
        clearAllStores();
        Navigation.queueRoutesForUpdate();
        SettingsService.resetSettings();
        await db.reset();

        setImmediate(() => {
          refreshAllStores();
          eSendEvent(eAfterSync);
        });
        return true;
      }
    });
  }),
  {
    id: "back-restore",
    name: strings.backupRestore(),
    sections: [
      {
        id: "backups",
        type: "screen",
        name: strings.backups(),
        icon: "backup-restore",
        description: strings.backupsDesc(),
        sections: [
          {
            id: "backup-now",
            name: strings.backupNow(),
            description: strings.backupNowDesc(),
            modifer: async () => {
              const user = useUserStore.getState().user;
              if (!user || SettingsService.getProperty("encryptedBackup")) {
                await BackupService.run(true);
                return;
              }

              verifyUser(null, () => BackupService.run(true));
            }
          },
          {
            id: "backup-now-with-attachments",
            name: strings.backupNowWithAttachments(),
            description: strings.backupNowWithAttachmentsDesc(),
            hidden: () => !useUserStore.getState().user,
            modifer: async () => {
              const user = useUserStore.getState().user;
              if (!user || SettingsService.getProperty("encryptedBackup")) {
                await BackupService.run(true, undefined, "full");
                return;
              }

              verifyUser(null, () =>
                BackupService.run(true, undefined, "full")
              );
            }
          },
          {
            id: "auto-backups",
            type: "component",
            name: strings.automaticBackups(),
            description: strings.automaticBackupsDesc(),
            component: "autobackups"
          },
          {
            id: "auto-backups-with-attachments",
            type: "component",
            hidden: () => !useUserStore.getState().user,
            name: strings.automaticBackupsWithAttachments(),
            description: [
              ...strings.automaticBackupsWithAttachmentsDesc()
            ].join("\n"),
            component: "autobackupsattachments"
          },
          {
            id: "select-backup-dir",
            name: strings.selectBackupDir(),
            description: () => {
              const desc = strings.selectBackupDirDesc(
                SettingsService.get().backupDirectoryAndroid?.path || ""
              );
              return desc[0] + " " + desc[1];
            },
            icon: "folder",
            hidden: () =>
              !!SettingsService.get().backupDirectoryAndroid ||
              Platform.OS !== "android",
            property: "backupDirectoryAndroid",
            modifer: async () => {
              let dir;
              try {
                dir = await BackupService.checkBackupDirExists(true);
              } catch (e) {
                console.error(e);
              } finally {
                if (!dir) {
                  ToastManager.show({
                    heading: strings.noDirectorySelected(),
                    type: "error"
                  });
                }
              }
            }
          },
          {
            id: "change-backup-dir",
            name: strings.changeBackupDir(),
            description: () => {
              const name = SettingsService.get().backupDirectoryAndroid?.name;
              return name?.includes("Notesnook backups")
                ? strings.existingBackupFolder()
                : name || "";
            },
            icon: "folder",
            hidden: () =>
              !SettingsService.get().backupDirectoryAndroid ||
              Platform.OS !== "android",
            property: "backupDirectoryAndroid",
            modifer: async () => {
              let dir;
              try {
                dir = await BackupService.checkBackupDirExists(true);
              } catch (e) {
                console.error(e);
              } finally {
                if (!dir) {
                  ToastManager.show({
                    heading: strings.noDirectorySelected(),
                    type: "error"
                  });
                }
              }
            }
          },
          {
            id: "enable-backup-encryption",
            type: "switch",
            name: strings.backupEncryption(),
            description: strings.backupEncryptionDesc(),
            icon: "lock",
            property: "encryptedBackup",
            modifer: async () => {
              const user = useUserStore.getState().user;
              const settings = SettingsService.get();
              if (!user) {
                ToastManager.show({
                  heading: strings.loginRequired(),
                  type: "error"
                });
                return;
              }
              if (settings.encryptedBackup) {
                await verifyUser(null, () => {
                  SettingsService.set({
                    encryptedBackup: false
                  });
                });
              } else {
                SettingsService.set({
                  encryptedBackup: true
                });
              }
            }
          }
        ]
      },
      {
        id: "restore-backup",
        name: strings.restoreBackup(),
        description: strings.restoreBackupDesc(),
        icon: "restore",
        type: "screen",
        component: "backuprestore"
      },
      {
        id: "export-notes",
        name: strings.exportAllNotes(),
        icon: "export",
        description: strings.exportAllNotesDesc(),
        modifer: () => {
          verifyUser(null, () => {
            ExportNotesSheet.present(undefined, true);
          });
        }
      }
    ]
  },
  {
    id: "productivity",
    name: strings.productivity(),
    sections: [
      {
        id: "notification-notes",
        type: "switch",
        name: strings.quickNoteNotification(),
        description: strings.quickNoteNotificationDesc(),
        property: "notifNotes",
        icon: "form-textbox",
        modifer: async () => {
          const settings = SettingsService.get();
          if (settings.notifNotes) {
            Notifications.unpinQuickNote();
          } else {
            Notifications.pinQuickNote();
          }
          SettingsService.set({
            notifNotes: !settings.notifNotes
          });
        },
        hidden: () => Platform.OS !== "android",
        featureId: "createNoteFromNotificationDrawer"
      },
      {
        id: "task-notifications-ios",
        name: strings.notificationsAndAlarms(),
        value: (current) => (current as string) || "",
        icon: "format-list-checks",
        // Mac Catalyst opens System Settings > Notifications, not the iOS
        // Settings app the shared @notesnook/intl string names.
        description: isMacCatalyst()
          ? "Opens System Settings › Notifications"
          : strings.notificationsAndAlarmsDesc(),
        useHook: useNotificationAlarmStatus,
        hidden: () => Platform.OS !== "ios",
        showActionProgress: true,
        modifer: async () => {
          try {
            await openAppNotificationSettings();
          } catch (e) {
            DatabaseLogger.error(e as Error, "openAppNotificationSettings");
            showAlert(
              strings.notificationsAndAlarms(),
              strings.tasksNotificationsSettingsError()
            );
          }
        }
      },
      {
        id: "reminders",
        type: "screen",
        name: strings.reminders(),
        icon: "bell",
        description: strings.remindersDesc(),
        hidden: () => Platform.OS === "ios",
        sections: [
          {
            id: "enable-reminders",
            property: "reminderNotifications",
            type: "switch",
            name: strings.reminderNotification(),
            icon: "bell-outline",
            onChange: (property) => {
              if (property) {
                Notifications.setupReminders();
              } else {
                Notifications.clearAllTriggers();
              }
            },
            description: strings.reminderNotificationDesc()
          },
          {
            id: "snooze-time",
            property: "defaultSnoozeTime",
            type: "input",
            name: strings.defaultSnoozeTime(),
            description: strings.defaultSnoozeTimeDesc(),
            inputProperties: {
              keyboardType: "decimal-pad",
              defaultValue: 5 + "",
              placeholder: strings.setSnoozeTimePlaceholder(),
              onSubmitEditing: () => {
                Notifications.setupReminders();
              }
            }
          },
          {
            id: "reminder-sound-ios",
            type: "screen",
            name: strings.changeNotificationSound(),
            description: strings.changeNotificationSoundDesc(),
            component: "sound-picker",
            icon: "bell-ring",
            hidden: () =>
              Platform.OS === "ios" ||
              (Platform.OS === "android" && Platform.Version > 25)
          },
          {
            id: "reminder-sound-android",
            name: strings.changeNotificationSound(),
            description: strings.changeNotificationSoundDesc(),
            icon: "bell-ring",
            hidden: () =>
              Platform.OS === "ios" ||
              (Platform.OS === "android" && Platform.Version < 26),
            modifer: async () => {
              const id = await Notifications.getChannelId("urgent");
              if (id) {
                await notifee.openNotificationSettings(id);
              }
            }
          }
        ]
      }
    ]
  },
  {
    // Developer options live here, not next to privacy settings.
    id: "advanced",
    name: strings.advanced(),
    sections: [
      {
        id: "cors-bypass",
        type: "input",
        name: strings.corsBypass(),
        description: strings.corsBypassDesc(),
        inputProperties: {
          defaultValue: "",
          autoCorrect: false,
          keyboardType: "url"
        },
        property: "corsProxy",
        icon: "arrow-decision-outline",
        hidden: () => !__DEV__ && !SettingsService.getProperty("corsProxy")
      }
    ]
  },
  {
    id: "help-support",
    name: strings.helpAndSupport(),
    sections: [
      {
        id: "debugging",
        name: strings.debugging(),
        description: strings.debuggingDesc(),
        type: "screen",
        icon: "bug",
        sections: [
          {
            id: "debug-logs",
            type: "screen",
            name: strings.debugLogs(),
            description: strings.debugLogsDesc(),
            component: "debug-logs"
          }
        ]
      }
    ]
  },
  {
    id: "legal",
    name: strings.legal(),
    sections: [
      {
        id: "licenses",
        name: strings.licenses(),
        type: "screen",
        component: "licenses",
        description: strings.ossLibs(),
        icon: "open-source-initiative"
      }
    ]
  },
  {
    id: "about",
    name: "About VeyraN",
    sections: [
      {
        id: "app-version",
        name: strings.appVersion(),
        icon: "alpha-v",
        description: getVersion()
      }
    ]
  }
];
