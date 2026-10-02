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
  Text,
  View,
  ViewStyle
} from "react-native";
import { useReduceMotion } from "../hooks/use-reduce-motion";
import Navigation from "../services/navigation";
import useNavigationStore from "../stores/use-navigation-store";
import { SyncStatus, useUserStore } from "../stores/use-user-store";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { systemColor } from "../utils/ios-system-colors";
import {
  MAC_ACCOUNT_CARD_HEIGHT,
  MAC_ACCOUNT_CARD_MARGIN,
  MAC_ACCOUNT_CARD_RADIUS,
  MAC_SIDEBAR_ROW_RADIUS,
  macSidebarSelectionFill
} from "../utils/mac-layout";
import {
  openMacAccountSettings,
  openMacSettings
} from "../screens/settings/mac-account-settings";
import { AuthMode } from "./auth/common";
import { MacGlassView } from "./mac-glass-view";
import { MacHoverHighlight, useMacHover } from "./mac-hover";
import AppIcon from "./ui/AppIcon";

/**
 * Mac source-list footer (WP10.1): the account row macOS apps keep pinned to
 * the bottom of their sidebar. On the glass sidebar it is a floating glass card
 * of its own (`VeyraNGlassView` variant "card"), inset from the panel's edges,
 * with a round avatar initial on the leading edge. It sits below the ScrollView,
 * so it stays put while the Library list scrolls.
 *
 * Signed in: the avatar initial, the account e-mail (13 pt, single line) with a
 * status line below it ("Signed in" plus a pulsing sync dot) and a gear on the
 * trailing edge. Tapping the account opens Settings on the Account group; the
 * gear opens the Settings home. Signed out: "Not logged in" opens the login
 * flow, the gear still opens Settings, and there is no sync dot.
 */

/** E-mail text size (matches a source-list row's label). */
const EMAIL_FONT_SIZE = 13;
/** Status line size (matches the sidebar's section headers). */
const STATUS_FONT_SIZE = 11;
/** Sync dot diameter. */
const DOT_SIZE = 9;
/** Gear hit area. */
const GEAR_SIZE = 24;
/** Round avatar diameter: the account line + status fit next to it in 46 pt. */
const AVATAR_SIZE = 28;
/** Corner radius of the row/button highlight inside the card: the row's 9 pt. */
const INNER_RADIUS = MAC_SIDEBAR_ROW_RADIUS;
/** Horizontal padding that keeps the content off the card's own edges. */
const CARD_PADDING = 9;

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
  const selection = macSidebarSelectionFill(isDark);

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
        height: MAC_ACCOUNT_CARD_HEIGHT,
        // The card floats inside the sidebar panel with its own margins. It is
        // the last child of the panel's flex column, so it must never be
        // squeezed by the scrolling list above it.
        flexShrink: 0,
        margin: MAC_ACCOUNT_CARD_MARGIN
      }}
    >
      <MacGlassView
        variant="card"
        cornerRadius={MAC_ACCOUNT_CARD_RADIUS}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: CARD_PADDING
        }}
      >
        <MacFooterPressable
          testID="mac-sidebar-account"
          accessibilityLabel={accountLabel}
          onPress={onPressAccount}
          style={{
            flex: 1,
            minWidth: 0,
            paddingHorizontal: 7,
            height: 34,
            // The avatar is part of the account target, so the row keeps its
            // content at the leading edge instead of the base style's center.
            justifyContent: "flex-start"
          }}
        >
          <AccountAvatar signedIn={signedIn} email={email} />
          <View style={{ flex: 1, minWidth: 0, marginLeft: 8 }}>
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
                  marginTop: 1
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
                borderRadius: INNER_RADIUS,
                backgroundColor: selection.color,
                opacity: selection.opacity
              }}
            />
          ) : null}
          <AppIcon
            name="cog-outline"
            size={16}
            color={
              settingsSelected ? colors.primary.accent : visual.secondaryText
            }
          />
        </MacFooterPressable>
      </MacGlassView>
    </View>
  );
}

/**
 * The round avatar at the leading edge of the account card: the first letter of
 * the signed-in e-mail, or a person glyph while signed out. Its fill is the
 * theme's secondary surface so it reads as a disc on the glass.
 */
function AccountAvatar({
  signedIn,
  email
}: {
  signedIn: boolean;
  email?: string;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const initial = signedIn && email ? email.trim().charAt(0).toUpperCase() : "";
  return (
    <View
      style={{
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
        backgroundColor: colors.secondary.background,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden"
      }}
    >
      {signedIn && initial ? (
        <Text
          style={{
            color: visual.primaryText,
            fontSize: 13,
            fontWeight: "600"
          }}
        >
          {initial}
        </Text>
      ) : (
        <AppIcon
          name="account-outline"
          size={16}
          color={visual.secondaryText}
        />
      )}
    </View>
  );
}

/**
 * A pressable footer row/button with the same pointer feedback as the sidebar's
 * MacRow: a rounded hover highlight under the content.
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
          borderRadius: INNER_RADIUS,
          overflow: "hidden"
        },
        style
      ]}
    >
      <MacHoverHighlight
        visible={hovered && !hideHover}
        radius={INNER_RADIUS}
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
