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
import {
  Pressable,
  StyleProp,
  Text,
  TextStyle,
  View,
  ViewStyle
} from "react-native";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { MenuButton, NativeMenuItem } from "./native-menu";
import { TaskSymbolView } from "./task-symbol-view";

/**
 * The navigation bar row above a large title, laid out like UINavigationBar:
 * "‹ Previous" on the leading side, bar buttons on the trailing side, an
 * optional centered inline title.
 */
export function IosNavBar({
  backTitle,
  onBack,
  leading,
  title,
  trailing,
  style
}: {
  backTitle?: string;
  onBack?: () => void;
  leading?: React.ReactNode;
  title?: string;
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useThemeColors();
  const tint = colors.primary.accent;
  return (
    <View
      style={[
        {
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 8
        },
        style
      ]}
    >
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={backTitle}
            hitSlop={6}
            testID="ios-nav-back"
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              minHeight: 44,
              paddingRight: 8,
              opacity: pressed ? 0.4 : 1
            })}
          >
            <TaskSymbolView name="chevron.backward" size={22} color={tint} />
            {backTitle ? (
              <Text
                numberOfLines={1}
                style={{ color: tint, fontSize: 17, marginLeft: 3, maxWidth: 160 }}
              >
                {backTitle}
              </Text>
            ) : null}
          </Pressable>
        ) : (
          leading
        )}
      </View>
      {title ? (
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            flexShrink: 1,
            fontSize: 17,
            fontWeight: "600",
            color: colors.primary.heading
          }}
        >
          {title}
        </Text>
      ) : null}
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4
        }}
      >
        {trailing}
      </View>
    </View>
  );
}

/** A bar button showing an SF Symbol or a text label in the tint color. */
export function IosBarButton({
  symbol,
  label,
  onPress,
  accessibilityLabel,
  bold,
  disabled,
  testID,
  iconSize = 23
}: {
  symbol?: string;
  label?: string;
  onPress: () => void;
  accessibilityLabel?: string;
  bold?: boolean;
  disabled?: boolean;
  testID?: string;
  /** SF Symbol size. Mac's title bar row uses the 16 pt toolbar size. */
  iconSize?: number;
}) {
  const { colors } = useThemeColors();
  const tint = disabled ? colors.secondary.icon : colors.primary.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={6}
      style={({ pressed }) => ({
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: label ? 8 : 0,
        opacity: pressed ? 0.4 : 1
      })}
    >
      {symbol ? (
        <TaskSymbolView name={symbol} size={iconSize} color={tint} />
      ) : (
        <Text
          style={{
            color: tint,
            fontSize: 17,
            fontWeight: bold ? "600" : "400"
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** The "…" bar button that opens a native pull-down menu. */
export function IosMoreMenu({
  items,
  onSelect,
  accessibilityLabel,
  symbol = "ellipsis.circle",
  testID
}: {
  items: (NativeMenuItem | false | null | undefined)[];
  onSelect: (id: string) => void;
  accessibilityLabel: string;
  symbol?: string;
  testID?: string;
}) {
  const { colors } = useThemeColors();
  return (
    <MenuButton
      items={items}
      onSelect={onSelect}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={{
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      <TaskSymbolView name={symbol} size={23} color={colors.primary.accent} />
    </MenuButton>
  );
}

/** The large title below the navigation bar (34 pt bold). */
export function IosLargeTitle({
  title,
  subtitle,
  color,
  style,
  testID
}: {
  title: string;
  subtitle?: string;
  color?: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  return (
    <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
      <Text
        testID={testID}
        accessibilityRole="header"
        style={[
          {
            color: color || visual.primaryText,
            fontSize: 34,
            fontWeight: "700"
          },
          style
        ]}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          style={{ color: visual.secondaryText, fontSize: 15, marginTop: 2 }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/** The rounded search field that sits under a large title. */
export function IosSearchField({
  placeholder,
  onPress,
  testID
}: {
  placeholder: string;
  onPress: () => void;
  testID?: string;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="search"
      accessibilityLabel={placeholder}
      style={{
        marginHorizontal: 16,
        marginBottom: 10,
        minHeight: 36,
        borderRadius: 10,
        paddingHorizontal: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: isDark ? "#1C1C1E" : "rgba(118,118,128,0.12)"
      }}
    >
      <TaskSymbolView
        name="magnifyingglass"
        size={16}
        color={visual.tertiaryText}
      />
      <Text style={{ color: visual.tertiaryText, fontSize: 17 }}>
        {placeholder}
      </Text>
    </Pressable>
  );
}
