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
import { Linking, NativeModules, Platform } from "react-native";

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
      if (!native) throw new Error("NotificationSettingsModule is unavailable.");
      return await Promise.race([
        native.openNotificationSettings(),
        new Promise<never>((_, reject) =>
          (timeout = setTimeout(
            () => reject(new Error("Opening iOS Settings timed out.")),
            3000
          ))
        )
      ]);
    } catch {
      // Use React Native's public app Settings API if the native notification
      // destination rejects or its completion handler never returns.
      await Linking.openSettings();
      return "settings";
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  await notifee.openNotificationSettings(channelId);
  return "android";
}
