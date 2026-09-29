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

import React, { useCallback, useEffect, useRef } from "react";
import {
  AppStateStatus,
  Image,
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from "react-native";
import { useBiometry } from "../../hooks/use-biometry";
import { TaskSymbolView } from "../task-symbol-view";
//@ts-ignore
import { useThemeColors } from "@notesnook/theme";
import { DatabaseLogger } from "../../common/database";
import {
  decrypt,
  encrypt,
  getCryptoKey,
  getDatabaseKey,
  setAppLockVerificationCipher,
  validateAppLockPassword
} from "../../common/database/encryption";
import { MMKV } from "../../common/database/mmkv";
import { useAppState } from "../../hooks/use-app-state";
import BiometricService from "../../services/biometrics";
import { ToastManager } from "../../services/event-manager";
import SettingsService from "../../services/settings";
import { useSettingStore } from "../../stores/use-setting-store";
import { useUserStore } from "../../stores/use-user-store";
import { NotesnookModule } from "../../utils/notesnook-module";
import { Toast } from "../toast";
import { Button } from "../ui/button";
import Input from "../ui/input";
import Heading from "../ui/typography/heading";
import Paragraph from "../ui/typography/paragraph";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import { strings } from "@notesnook/intl";
import { editorController } from "../../screens/editor/tiptap/utils";
import { useTabStore } from "../../screens/editor/tiptap/use-tab-store";

const getUser = () => {
  const user = MMKV.getString("user");
  if (user) {
    return JSON.parse(user);
  }
};

const verifyUserPassword = async (password: string) => {
  try {
    await getDatabaseKey();
    const key = await getCryptoKey();
    const user = getUser();
    const cipher = await encrypt(
      {
        key: key,
        salt: user.salt
      },
      "notesnook"
    );
    const plainText = await decrypt({ password }, cipher);
    return plainText === "notesnook";
  } catch (e) {
    DatabaseLogger.error(e as Error);
    return false;
  }
};

const AppLocked = () => {
  const initialLaunchBiometricRequest = useRef(true);
  const { colors } = useThemeColors();
  const user = getUser();
  const appLocked = useUserStore((state) => state.appLocked);
  const lockApp = useUserStore((state) => state.lockApp);
  const deviceMode = useSettingStore((state) => state.deviceMode);
  const passwordInputRef = useRef<TextInput>(null);
  const password = useRef<string>(undefined);
  const appState = useAppState();
  const lastAppState = useRef<AppStateStatus>(appState);
  const biometricUnlockAwaitingUserInput = useRef(false);
  const { height } = useWindowDimensions();
  const biometry = useBiometry();
  const keyboardType = useSettingStore(
    (state) => state.settings.applockKeyboardType
  );
  const appLockHasPasswordSecurity = useSettingStore(
    (state) => state.settings.appLockHasPasswordSecurity
  );
  const biometricsAuthEnabled = useSettingStore(
    (state) =>
      state.settings.biometricsAuthEnabled === true ||
      (state.settings.biometricsAuthEnabled === undefined &&
        !state.settings.appLockHasPasswordSecurity)
  );

  const onUnlockAppRequested = useCallback(async () => {
    editorController.current?.commands.blur(useTabStore.getState().currentTab);
    editorController.current?.commands.blurPassInput();

    if (
      !biometricsAuthEnabled ||
      !(await BiometricService.isBiometryAvailable())
    ) {
      return;
    }

    biometricUnlockAwaitingUserInput.current = true;

    if (Platform.OS === "android") {
      const activityName = await NotesnookModule.getActivityName();
      if (
        activityName !== "MainActivity" &&
        activityName !== "NotePreviewConfigureActivity"
      )
        return;
    }
    useSettingStore.getState().setRequestBiometrics(true);

    const unlocked = await BiometricService.validateUser(
      strings.unlockNotes(),
      ""
    );
    if (unlocked) {
      lockApp(false);
      password.current = undefined;
    }
    biometricUnlockAwaitingUserInput.current = false;
    setTimeout(() => {
      if (biometricUnlockAwaitingUserInput.current) return;
      useSettingStore.getState().setRequestBiometrics(false);
    }, 500);
  }, [biometricsAuthEnabled, lockApp]);

  const onSubmit = async () => {
    if (!password.current) return;
    try {
      const unlocked = appLockHasPasswordSecurity
        ? await validateAppLockPassword(password.current)
        : await verifyUserPassword(password.current);
      if (unlocked) {
        if (!appLockHasPasswordSecurity) {
          await setAppLockVerificationCipher(password.current);
          SettingsService.set({
            appLockHasPasswordSecurity: true,
            applockKeyboardType: "default"
          });
          DatabaseLogger.info("App lock migrated to password security");
        }

        lockApp(false);
        password.current = undefined;
      } else {
        ToastManager.show({
          heading: strings.invalid(keyboardType),
          type: "error",
          context: "local"
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    const prevState = lastAppState.current;
    lastAppState.current = appState;

    if (
      appState === "active" &&
      (prevState === "background" || initialLaunchBiometricRequest.current)
    ) {
      if (SettingsService.shouldLockAppOnEnterForeground()) {
        if (useSettingStore.getState().appDidEnterBackgroundForAction) {
          useSettingStore.getState().setAppDidEnterBackgroundForAction(false);
          return;
        }

        DatabaseLogger.info("Locking app on entering foreground");

        useUserStore.getState().lockApp(true);
      }
      if (
        !(
          biometricUnlockAwaitingUserInput.current ||
          useUserStore.getState().disableAppLockRequests ||
          !appLocked ||
          useSettingStore.getState().requestBiometrics ||
          useSettingStore.getState().appDidEnterBackgroundForAction
        )
      ) {
        initialLaunchBiometricRequest.current = false;
        DatabaseLogger.info("Biometric unlock request");
        onUnlockAppRequested();
      }
    } else if (appState === "background") {
      SettingsService.appEnteredBackground();
    }
  }, [appState, onUnlockAppRequested, appLocked]);

  const passwordField = user || appLockHasPasswordSecurity;

  return appLocked ? (
    <KeyboardAwareScrollView
      style={{
        backgroundColor: colors.primary.background,
        width: "100%",
        height: "100%",
        position: "absolute",
        zIndex: 999
      }}
      contentContainerStyle={{
        minHeight: height
      }}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <Toast context="local" />
      <View
        style={{
          flex: 1,
          // Content sits in the upper third: the system Face ID animation
          // appears in the middle of the screen and must not cover the title.
          paddingTop: Math.max(72, height * 0.12),
          width:
            deviceMode !== "mobile"
              ? "50%"
              : Platform.OS == "ios"
                ? "90%"
                : "100%",
          alignSelf: "center",
          alignItems: "center"
        }}
      >
        <Image
          source={require("../../assets/images/veyran-icon.png")}
          accessibilityIgnoresInvertColors
          style={{ width: 72, height: 72, borderRadius: 16 }}
        />
        <Heading
          color={colors.primary.heading}
          style={{
            marginTop: 20,
            textAlign: "center"
          }}
        >
          {strings.appLockLockedTitle()}
        </Heading>

        <Paragraph
          style={{
            marginTop: 6,
            textAlign: "center",
            maxWidth: "90%"
          }}
        >
          {biometricsAuthEnabled && biometry.kind !== "none"
            ? strings.appLockBiometryDesc(biometry.name)
            : strings.verifyItsYou()}
        </Paragraph>

        <View style={{ width: "100%", marginTop: 32 }}>
          {passwordField ? (
            <Input
              fwdRef={passwordInputRef}
              secureTextEntry
              keyboardType={
                appLockHasPasswordSecurity ? keyboardType : "default"
              }
              onLayout={async () => {
                if (
                  !biometricsAuthEnabled ||
                  !(await BiometricService.isBiometryAvailable())
                ) {
                  setTimeout(() => {
                    passwordInputRef.current?.focus();
                  }, 32);
                }
              }}
              placeholder={
                appLockHasPasswordSecurity
                  ? keyboardType === "numeric"
                    ? strings.enterApplockPassword()
                    : strings.enterApplockPin()
                  : strings.enterAccountPassword()
              }
              onChangeText={(v) => (password.current = v)}
              onSubmit={() => {
                onSubmit();
              }}
            />
          ) : null}

          {passwordField ? (
            <Button
              title={strings.continue()}
              type="accent"
              onPress={onSubmit}
              width="100%"
              height={50}
              style={{
                borderRadius: 14,
                marginTop: 16
              }}
            />
          ) : null}

          {biometricsAuthEnabled ? (
            <Pressable
              testID="app-lock-biometry"
              onPress={onUnlockAppRequested}
              accessibilityRole="button"
              accessibilityLabel={biometry.unlockTitle}
              style={({ pressed }) => ({
                marginTop: 12,
                minHeight: 50,
                borderRadius: 14,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                backgroundColor: passwordField
                  ? "transparent"
                  : colors.primary.accent,
                opacity: pressed ? 0.7 : 1
              })}
            >
              <TaskSymbolView
                name={biometry.symbol}
                size={22}
                color={passwordField ? colors.primary.accent : "#FFFFFF"}
              />
              <Text
                style={{
                  color: passwordField ? colors.primary.accent : "#FFFFFF",
                  fontSize: 17,
                  fontWeight: "600"
                }}
              >
                {biometry.unlockTitle}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </KeyboardAwareScrollView>
  ) : null;
};

export default AppLocked;
