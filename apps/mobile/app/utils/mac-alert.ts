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
  ActionSheetIOS,
  Alert,
  AlertButton,
  AlertOptions,
  Platform
} from "react-native";
import { isMacCatalyst } from "./constants";

/**
 * Thin wrapper around `Alert.alert`. On Mac Catalyst UIKit renders this as a
 * native macOS alert, so every alert in the app should go through it instead of
 * calling `Alert.alert` directly.
 */
export function showAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions
) {
  Alert.alert(title, message, buttons, options);
}

export type ConfirmActionOptions = {
  title: string;
  message?: string;
  confirmText: string;
  cancelText: string;
  destructive?: boolean;
  anchor?: number;
  isDark?: boolean;
  onConfirm: () => void;
};

/**
 * Confirmation dialog that keeps the familiar iOS action sheet on iPhone/iPad,
 * while Mac Catalyst (and every non-iOS platform) gets a native `Alert.alert`
 * instead — action sheets are an iOS-only idiom and are not rendered natively
 * on the Mac.
 *
 * The action sheet has a single title line: prefer the alert body (the actual
 * question) when one is given so the on-device wording is unchanged.
 */
export function confirmAction({
  title,
  message,
  confirmText,
  cancelText,
  destructive,
  anchor,
  isDark,
  onConfirm
}: ConfirmActionOptions) {
  if (Platform.OS === "ios" && !isMacCatalyst()) {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: message || title,
        options: [confirmText, cancelText],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
        ...(Platform.isPad ? { anchor } : {}),
        userInterfaceStyle: isDark ? "dark" : "light"
      },
      (index) => {
        if (index === 0) onConfirm();
      }
    );
    return;
  }

  showAlert(title, message, [
    { text: cancelText, style: "cancel" },
    {
      text: confirmText,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm
    }
  ]);
}
