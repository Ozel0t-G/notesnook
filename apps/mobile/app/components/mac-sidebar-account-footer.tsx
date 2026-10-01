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

import { useTimeAgo } from "@notesnook/common";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle
} from "react-native";
import { useReduceMotion } from "../hooks/use-reduce-motion";
import Navigation from "../services/navigation";
import useNavigationStore from "../stores/use-navigation-store";
import { SyncStatus, useUserStore } from "../stores/use-user-store";
import { useMacSystemStore } from "../stores/use-mac-system-store";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { systemColor } from "../utils/ios-system-colors";
import { MAC_SOURCE_LIST_INSET } from "../utils/mac-layout";
import { macAccent, macSelectionFill } from "../utils/mac-system-state";
import {
  openMacAccountSettings,
  openMacSettings
} from "../screens/settings/mac-account-settings";
import { AuthMode } from "./auth/common";
import { MacHoverHighlight, useMacHover } from "./mac-hover";
import AppIcon from "./ui/AppIcon";

/**
 * Mac source-list footer (WP10.1): the account row macOS apps keep pinned to
 * the bottom of their sidebar. It sits below the ScrollView, so it stays put
 * while the Library list scrolls.
 *
 * Signed in: the account e-mail (13 pt, single line) with a status line below
 * it ("Signed in" plus a pulsing sync dot) and a gear on the trailing edge.
 * Tapping the e-mail opens Settings on the Account group; the gear opens the
 * Settings home. Signed out: "Not logged in" opens the login flow, the gear
 * still opens Settings, and there is no sync dot.
 */

/** Footer height: source lists use a touch more than a 28 pt row here. */
const FOOTER_HEIGHT = 56;
/** E-mail text size (matches a source-list row's label). */
const EMAIL_FONT_SIZE = 13;
/** Status line size (matches the sidebar's section headers). */
const STATUS_FONT_SIZE = 11;
/** Sync dot diameter. */
const DOT_SIZE = 9;
/** Gear hit area. */
const GEAR_SIZE = 24;
/** Corner radius of the row/button highlight: the sidebar's own 6 pt. */
const FOOTER_RADIUS = 6;
/**
 * The footer's rows sit in the same gutter as the source-list rows: the pane
 * inset plus the row's own 8 pt padding puts the e-mail exactly where a MacRow
 * label starts (`MAC_LIST_TEXT_LEFT` in mac-sidebar.tsx).
 */
const FOOTER_HORIZONTAL_PADDING = MAC_SOURCE_LIST_INSET;

export function MacSidebarAccountFooter() {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const user = useUserStore((state) => state.user);
  const lastSyncStatus = useUserStore((state) => state.lastSyncStatus);
  const lastSynced = useUserStore((state) => state.lastSynced);
  const currentRoute = useNavigationStore((state) => state.currentRoute);

  // The gear is the selected row while Settings is on screen (this also stops
  // the sidebar from keeping a Library row highlighted behind Settings, WP05).
  const settingsSelected = currentRoute === "Settings";
  const systemAccent = useMacSystemStore((state) => state.accent);
  const windowActive = useMacSystemStore((state) => state.active);
  const selection = macSelectionFill(
    macAccent(colors.primary.accent, systemAccent),
    windowActive,
    isDark
  );

  const email = user?.email;
  const signedIn = !!user && !!email;
  const syncFailed = lastSyncStatus === SyncStatus.Failed;
  const hasSyncedBefore = lastSynced !== "Never" && !!lastSynced;
  // Human-readable for the accessibility label, refreshed while it is on
  // screen ("Synced, 3m ago"); the visible status line stays "Signed in".
  const lastSyncedAgo = useTimeAgo(lastSynced, {
    locale: "en_short",
    interval: 60000
  });
  const syncLabel = syncFailed
    ? strings.syncFailed()
    : hasSyncedBefore
    ? `${strings.synced()}, ${lastSyncedAgo}`
    : strings.synced();
  const accountLabel = signedIn
    ? `${email}, ${strings.loginSuccess()}, ${syncLabel}`
    : strings.notLoggedIn();

  const onPressAccount = () => {
    if (signedIn) openMacAccountSettings();
    else Navigation.navigate("Auth", { mode: AuthMode.login });
  };

  return (
    <View
      testID="mac-sidebar-account-footer"
      style={{
        height: FOOTER_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: FOOTER_HORIZONTAL_PADDING,
        paddingRight: FOOTER_HORIZONTAL_PADDING,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: visual.separator,
        backgroundColor: visual.sidebarBackground
      }}
    >
      <MacFooterPressable
        testID="mac-sidebar-account"
        accessibilityLabel={accountLabel}
        onPress={onPressAccount}
        // 8 pt of inner padding on top of the pane inset puts the e-mail on
        // the same line as a MacRow's label (see FOOTER_HORIZONTAL_PADDING).
        style={{ flex: 1, minWidth: 0, paddingHorizontal: 8 }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            testID="mac-sidebar-account-email"
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              color: visual.primaryText,
              fontSize: EMAIL_FONT_SIZE
            }}
          >
            {signedIn ? email : strings.notLoggedIn()}
          </Text>
          {signedIn ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginTop: 2
              }}
            >
              <SyncDot
                failed={syncFailed}
                isDark={isDark}
                accessibilityLabel={syncLabel}
              />
              <Text
                numberOfLines={1}
                style={{
                  color: visual.secondaryText,
                  fontSize: STATUS_FONT_SIZE,
                  marginLeft: 5
                }}
              >
                {strings.loginSuccess()}
              </Text>
            </View>
          ) : null}
        </View>
      </MacFooterPressable>

      <MacFooterPressable
        testID="mac-sidebar-settings"
        accessibilityLabel={strings.routes.Settings()}
        accessibilityState={{ selected: settingsSelected }}
        hideHover={settingsSelected}
        onPress={openMacSettings}
        style={{
          width: GEAR_SIZE,
          height: GEAR_SIZE,
          marginLeft: 4
        }}
      >
        {settingsSelected ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: FOOTER_RADIUS,
              backgroundColor: selection.color,
              opacity: selection.opacity
            }}
          />
        ) : null}
        <AppIcon
          name="cog-outline"
          size={16}
          color={settingsSelected ? selection.color : visual.secondaryText}
        />
      </MacFooterPressable>
    </View>
  );
}

/**
 * A pressable footer row/button with the same pointer feedback as the sidebar's
 * MacRow: a 6 pt rounded hover highlight under the content.
 */
function MacFooterPressable({
  testID,
  accessibilityLabel,
  accessibilityState,
  hideHover,
  onPress,
  style,
  children
}: {
  testID: string;
  accessibilityLabel: string;
  accessibilityState?: { selected?: boolean };
  hideHover?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const { hovered, hoverProps } = useMacHover();
  return (
    <Pressable
      {...hoverProps}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      hitSlop={4}
      onPress={onPress}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: FOOTER_RADIUS,
          overflow: "hidden"
        },
        style
      ]}
    >
      <MacHoverHighlight
        visible={hovered && !hideHover}
        radius={FOOTER_RADIUS}
      />
      {children}
    </Pressable>
  );
}

/**
 * The continuous sync indicator: a coloured dot that breathes (opacity and
 * scale) in its colour. Static while "Reduce Motion" is on. The animation is
 * stopped on unmount.
 */
function SyncDot({
  failed,
  isDark,
  accessibilityLabel
}: {
  failed: boolean;
  isDark: boolean;
  accessibilityLabel: string;
}) {
  const reduceMotion = useReduceMotion();
  const pulse = React.useRef(new Animated.Value(0)).current;
  const color = systemColor(failed ? "red" : "green", isDark);

  React.useEffect(() => {
    if (reduceMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        })
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, reduceMotion]);

  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.35]
  });
  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.25]
  });

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID="mac-sidebar-sync-dot"
      style={{
        width: DOT_SIZE,
        height: DOT_SIZE,
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      <Animated.View
        style={{
          width: DOT_SIZE,
          height: DOT_SIZE,
          borderRadius: DOT_SIZE / 2,
          backgroundColor: color,
          opacity,
          transform: [{ scale }]
        }}
      />
    </View>
  );
}

export default MacSidebarAccountFooter;
