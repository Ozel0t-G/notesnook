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

import notifee from "@notifee/react-native";
import { AppState, Linking, NativeModules, Platform } from "react-native";

/**
 * Where the user actually landed after requesting notification settings.
 * "notifications" - the app's notification settings screen (iOS 16+).
 * "settings" - the app's general Settings page (older iOS, or fallback).
 * "android" - handled natively by notifee's Android implementation.
 */
export type NotificationSettingsDestination =
  | "notifications"
  | "settings"
  | "android";

type NotificationSettingsNative = {
  openNotificationSettings(): Promise<"notifications" | "settings">;
};

// A cold Settings launch can take several seconds on a simulator or older
// device. Keep the native bridge's two verified URL attempts inside this cap.
const SETTINGS_BACKGROUND_TIMEOUT_MS = 6000;
const NATIVE_SETTINGS_TIMEOUT_MS = 15000;

/** A successful URL completion alone does not prove Settings became visible. */
function waitForSettingsToOpen(): Promise<void> {
  if (AppState.currentState === "background") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      subscription.remove();
      if (timer) clearTimeout(timer);
      resolve();
    });
    timer = setTimeout(() => {
      subscription.remove();
      reject(new Error("The Settings app did not open."));
    }, SETTINGS_BACKGROUND_TIMEOUT_MS);
  });
}

/**
 * Opens the platform's notification settings for this app.
 * Throws if no destination could be opened, so callers can surface a
 * visible failure instead of a silent no-op.
 */
export async function openAppNotificationSettings(
  channelId?: string
): Promise<NotificationSettingsDestination> {
  if (Platform.OS === "ios") {
    // Notifee's iOS openNotificationSettings() is a documented no-op: it
    // only calls native code on Android and silently resolves on iOS
    // without opening anything. This bridges Apple's public
    // UIApplication settings URLs instead.
    const native = NativeModules.NotificationSettingsModule as
      | NotificationSettingsNative
      | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!native)
        throw new Error("NotificationSettingsModule is unavailable.");
      // The native module resolves only after UIApplication actually enters
      // the background, so this result has already been verified there.
      return await Promise.race([
        native.openNotificationSettings(),
        new Promise<never>(
          (_, reject) =>
            (timeout = setTimeout(
              () => reject(new Error("Opening iOS Settings timed out.")),
              NATIVE_SETTINGS_TIMEOUT_MS
            ))
        )
      ]);
    } catch (error) {
      // The native bridge has already tried both public Settings URLs. When
      // neither actually backgrounds the app, report failure to the caller.
      if ((error as { code?: string })?.code === "notification_settings_failed")
        throw error;
      // Use React Native's public app Settings API if the native notification
      // destination rejects or its completion handler never returns.
      await Linking.openSettings();
      await waitForSettingsToOpen();
      return "settings";
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  await notifee.openNotificationSettings(channelId);
  return "android";
}
