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
import React from "react";
import {
  Platform,
  requireNativeComponent,
  StyleSheet,
  View,
  ViewStyle
} from "react-native";
import { useThemeColors } from "@notesnook/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppleTabBarSelection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";

type NativeTabBarProps = {
  selectedSection: AppleTabBarSelection;
  onSelect: (event: { nativeEvent: { section: AppleTabBarSelection } }) => void;
  style: ViewStyle;
};

const NativeTabBar =
  Platform.OS === "ios"
    ? requireNativeComponent<NativeTabBarProps>("VeyraNTabBarView")
    : undefined;

/** Height of a standard UITabBar, excluding the home indicator inset. */
export const APPLE_TAB_BAR_HEIGHT = 49;

export function AppleTabBar({
  onSelect
}: {
  onSelect: (selection: AppleTabBarSelection) => void;
}) {
  const section = useAppleNavigationStore((state) => state.section);
  const insets = useSafeAreaInsets();
  const { colors } = useThemeColors();

  if (!NativeTabBar) return null;
  return (
    <View
      style={[
        styles.container,
        {
          // The bar floats; the inset area below it must paint the screen
          // background or it reads as a black strip above the home indicator.
          height: APPLE_TAB_BAR_HEIGHT + insets.bottom,
          backgroundColor: colors.primary.background
        }
      ]}
    >
      <NativeTabBar
        selectedSection={section}
        onSelect={({ nativeEvent }) => onSelect(nativeEvent.section)}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%"
  }
});
