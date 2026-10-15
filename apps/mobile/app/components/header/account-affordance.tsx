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
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { SyncStatus, useUserStore } from "../../stores/use-user-store";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { getObfuscatedEmail } from "../../utils/functions";
import { TaskSymbolView } from "../task-symbol-view";
import { UserSheet } from "../sheets/user";

/**
 * The compact account/login-status bar item the iPad shows in the note list's
 * navigation bar while the source sidebar is *not* on screen (narrow, a closed
 * medium drawer, fullscreen). The sidebar carries its own account affordance
 * (`SettingsIcon` in components/side-menu/side-menu-header.tsx), so this is the
 * only reachable one in exactly those presentations - it opens the existing
 * `UserSheet` for login/sync/account and nothing moves or grows in the list.
 *
 * It is a bar item, not a card: the signed-in name (or obfuscated e-mail), a
 * sync/login dot and `notLoggedIn` when signed out. It is the same affordance
 * the Library's source list has always drawn; the note collections reuse it so
 * that "the sidebar is hidden" never means "the account is unreachable".
 */
export function AccountAffordance({ testID = "library-account" }: { testID?: string }) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const user = useUserStore((state) => state.user);
  const userProfile = useUserStore((state) => state.profile);
  const lastSyncStatus = useUserStore((state) => state.lastSyncStatus);
  const signedIn = !!user;
  const accountText = signedIn
    ? userProfile?.fullName || getObfuscatedEmail(user?.email || "")
    : strings.notLoggedIn();
  const accountDotColor =
    !signedIn || lastSyncStatus === SyncStatus.Failed
      ? colors.error.icon
      : colors.success.icon;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accountText}
      onPress={() => UserSheet.present()}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        // The leading slot shares the bar with the trailing buttons; keep the
        // label shrinkable so a long name/e-mail can never push them out.
        flexShrink: 1,
        maxWidth: "100%",
        minHeight: 44,
        paddingRight: 8,
        opacity: pressed ? 0.4 : 1
      })}
    >
      <TaskSymbolView
        name={signedIn ? "person.crop.circle.fill" : "person.crop.circle"}
        size={22}
        color={colors.primary.accent}
      />
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        style={{
          flexShrink: 1,
          color: visual.primaryText,
          fontSize: 15,
          marginLeft: 6
        }}
      >
        {accountText}
      </Text>
      <View
        testID={`${testID}-status`}
        style={{
          width: 9,
          height: 9,
          borderRadius: 4.5,
          marginLeft: 6,
          backgroundColor: accountDotColor
        }}
      />
    </Pressable>
  );
}
