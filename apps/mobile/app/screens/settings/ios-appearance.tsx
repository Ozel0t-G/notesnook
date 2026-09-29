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

import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { Text, View } from "react-native";
import { cachedBiometryName } from "../../hooks/use-biometry";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { SystemColorName } from "../../utils/ios-system-colors";

/**
 * iOS Settings look: every row gets a white SF Symbol on a colored rounded
 * square, like the rows of the iOS Settings app.
 */
const SYMBOLS: Record<string, [string, SystemColorName]> = {
  "veyran-sign-in": ["person.crop.circle.fill", "blue"],
  "veyran-account-identity": ["person.crop.circle", "blue"],
  "veyran-account-session": ["checkmark.shield.fill", "green"],
  logout: ["rectangle.portrait.and.arrow.right", "gray"],
  "delete-data": ["trash.fill", "red"],
  "account-settings": ["person.text.rectangle", "blue"],
  "remove-profile-picture": ["person.crop.circle.badge.minus", "gray"],
  "remove-name": ["person.badge.minus", "gray"],
  "recovery-key": ["key.fill", "yellow"],
  "manage-attachments": ["paperclip", "gray"],
  "2fa-settings": ["lock.shield.fill", "green"],
  "enable-2fa": ["lock.rotation", "green"],
  "2fa-fallback": ["plus.circle", "green"],
  "change-2fa-method": ["arrow.triangle.2.circlepath", "green"],
  "view-2fa-codes": ["list.number", "green"],
  "clear-cache": ["xmark.bin.fill", "gray"],
  "sync-settings": ["arrow.triangle.2.circlepath", "green"],
  "offline-mode": ["arrow.down.circle.fill", "blue"],
  "auto-sync": ["arrow.triangle.2.circlepath", "green"],
  "disable-realtime-sync": ["bolt.horizontal.fill", "orange"],
  "disable-sync": ["icloud.slash.fill", "gray"],
  "background-sync": ["icloud.and.arrow.up.fill", "blue"],
  "pull-sync": ["icloud.and.arrow.down", "blue"],
  "push-sync": ["icloud.and.arrow.up", "blue"],
  "inbox-api": ["tray.and.arrow.down.fill", "indigo"],
  "toggle-inbox-api": ["tray.and.arrow.down", "indigo"],
  "setup-inbox-keys": ["key", "indigo"],
  "manage-inbox-keys": ["key.horizontal", "indigo"],
  "inbox-keys": ["key.viewfinder", "indigo"],
  "failed-inbox-items": ["exclamationmark.triangle.fill", "orange"],
  personalization: ["paintbrush.fill", "blue"],
  "theme-picker": ["paintpalette.fill", "purple"],
  "use-system-theme": ["circle.lefthalf.filled", "gray"],
  "enable-dark-mode": ["moon.fill", "indigo"],
  behaviour: ["gearshape.2.fill", "gray"],
  "default-sidebar-view": ["sidebar.left", "gray"],
  "date-format": ["calendar", "red"],
  "day-format": ["calendar.day.timeline.left", "red"],
  "week-format": ["calendar", "red"],
  "time-format": ["clock.fill", "blue"],
  "clear-trash-interval": ["trash", "gray"],
  "default-notebook": ["folder.badge.minus", "gray"],
  "keep-screen-on": ["iphone", "gray"],
  "image-compression": ["photo.fill", "teal"],
  editor: ["square.and.pencil", "orange"],
  "configure-toolbar": ["slider.horizontal.3", "orange"],
  "reset-toolbar": ["arrow.counterclockwise", "orange"],
  "double-spaced-lines": ["text.alignleft", "orange"],
  "default-font-size": ["textformat.size", "orange"],
  "default-font-family": ["textformat", "orange"],
  "default-line-height": ["arrow.up.and.down.text.horizontal", "orange"],
  "title-format": ["textformat.abc", "orange"],
  "toggle-markdown": ["number", "orange"],
  servers: ["server.rack", "gray"],
  "marketing-emails": ["envelope.fill", "blue"],
  "cors-bypass": ["arrow.triangle.branch", "gray"],
  vault: ["lock.rectangle.stack.fill", "indigo"],
  "create-vault": ["plus.rectangle.on.rectangle", "indigo"],
  "lock-vault-after": ["timer", "indigo"],
  "change-vault-password": ["key.fill", "indigo"],
  "clear-vault": ["xmark.bin", "red"],
  "delete-vault": ["trash.fill", "red"],
  "biometric-unlock": ["faceid", "green"],
  "privacy-mode": ["eye.slash.fill", "blue"],
  "app-lock": ["faceid", "green"],
  "app-lock-mode": ["lock.fill", "green"],
  "app-lock-timer": ["timer", "green"],
  "app-lock-pin": ["key.fill", "gray"],
  "app-lock-pin-change": ["key.fill", "gray"],
  "app-lock-pin-remove": ["key.slash", "gray"],
  "app-lock-fingerprint": ["faceid", "green"],
  backups: ["externaldrive.fill", "teal"],
  "backup-now": ["arrow.clockwise.icloud", "teal"],
  "backup-now-with-attachments": ["paperclip.circle", "teal"],
  "auto-backups": ["clock.arrow.circlepath", "teal"],
  "auto-backups-with-attachments": ["clock.arrow.circlepath", "teal"],
  "select-backup-dir": ["folder.fill", "blue"],
  "change-backup-dir": ["folder.fill", "blue"],
  "enable-backup-encryption": ["lock.fill", "teal"],
  "restore-backup": ["arrow.counterclockwise.circle.fill", "teal"],
  "export-notes": ["square.and.arrow.up.fill", "blue"],
  "notification-notes": ["note.text.badge.plus", "orange"],
  "task-notifications-ios": ["bell.badge.fill", "red"],
  reminders: ["bell.fill", "red"],
  "enable-reminders": ["bell", "red"],
  "snooze-time": ["zzz", "indigo"],
  "reminder-sound-ios": ["speaker.wave.2.fill", "pink"],
  "reminder-sound-android": ["speaker.wave.2.fill", "pink"],
  debugging: ["ladybug.fill", "gray"],
  "debug-logs": ["doc.text.magnifyingglass", "gray"],
  licenses: ["doc.plaintext.fill", "gray"],
  "app-version": ["info.circle.fill", "gray"]
};

export function iosSettingSymbol(id: string): [string, SystemColorName] {
  const entry = SYMBOLS[id] || ["gearshape.fill", "gray"];
  // Face ID rows follow the device: Touch ID phones get the fingerprint.
  if (entry[0] === "faceid" && cachedBiometryName() === "Touch ID")
    return ["touchid", entry[1]];
  return entry;
}

type FooterRegistry = (id: string, text?: string) => void;
const FooterContext = React.createContext<FooterRegistry | undefined>(
  undefined
);

/** Rows report their explanation here so the group shows it as a footer. */
export function useSettingsFooter() {
  return React.useContext(FooterContext);
}

/**
 * A grouped card whose rows' descriptions are shown once, as a footer under
 * the group (iOS Settings), instead of under every row.
 */
export function IosSettingsCard({
  header,
  children
}: {
  header?: string;
  children: React.ReactNode;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const [footers, setFooters] = React.useState<Record<string, string>>({});
  const register = React.useCallback<FooterRegistry>((id, text) => {
    setFooters((current) => {
      if ((current[id] || undefined) === (text || undefined)) return current;
      const next = { ...current };
      if (text) next[id] = text;
      else delete next[id];
      return next;
    });
  }, []);
  const footer = Object.values(footers).join("\n\n");
  return (
    <FooterContext.Provider value={register}>
      <View style={{ marginBottom: 22 }}>
        {header ? (
          <Text
            accessibilityRole="header"
            style={{
              color: visual.secondaryText,
              fontSize: 13,
              marginLeft: 16,
              marginBottom: 7,
              textTransform: "uppercase"
            }}
          >
            {header}
          </Text>
        ) : null}
        <View
          style={{
            backgroundColor: visual.contentSurface,
            borderRadius: 12,
            overflow: "hidden"
          }}
        >
          {children}
        </View>
        {footer ? (
          <Text
            style={{
              color: visual.secondaryText,
              fontSize: 13,
              marginTop: 7,
              marginHorizontal: 16
            }}
          >
            {footer}
          </Text>
        ) : null}
      </View>
    </FooterContext.Provider>
  );
}
