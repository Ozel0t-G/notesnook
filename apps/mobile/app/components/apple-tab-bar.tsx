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
import { strings } from "@notesnook/intl";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppleTabBarSelection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";
import { notesnook } from "../../e2e/test.ids";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { isMacCatalyst } from "../utils/constants";

type NativeTabBarProps = {
  selectedSection: AppleTabBarSelection;
  itemTitles: Record<"library" | "tasks" | "settings", string>;
  tint: string;
  onSelect: (event: { nativeEvent: { section: AppleTabBarSelection } }) => void;
  style: ViewStyle;
};

const NativeTabBar =
  Platform.OS === "ios"
    ? requireNativeComponent<NativeTabBarProps>("VeyraNTabBarView")
    : undefined;

/** Height of a standard UITabBar, excluding the home indicator inset. */
export const APPLE_TAB_BAR_HEIGHT = 49;
/** On iPad the tab bar floats at the top (iPadOS 18+), centered. */
export const IPAD_TAB_BAR_WIDTH = 380;

/**
 * iPadOS 18 floats the tab bar at the top of the window. Mac Catalyst does not
 * show the native bar at all - its sections live in the Mac section control at
 * the top of the Library/list column - so nothing is "top" there.
 */
export function isTopTabBar() {
  return Platform.OS === "ios" && Platform.isPad && !isMacCatalyst();
}

/**
 * Whether a screen has to reserve room at the bottom of its scroll view for
 * the floating tab bar: only iPhone docks the bar at the bottom. iPad floats
 * it at the top and Mac shows no bar at all, so neither reserves anything.
 */
export function hasBottomTabBar() {
  return Platform.OS === "ios" && !Platform.isPad && !isMacCatalyst();
}

/**
 * The floating tab bar. It is laid over the content (content scrolls beneath
 * it) instead of reserving an opaque strip: on iPhone at the bottom, on iPad
 * at the top.
 */
export function AppleTabBar({
  onSelect
}: {
  onSelect: (selection: AppleTabBarSelection) => void;
}) {
  const section = useAppleNavigationStore((state) => state.section);
  const settingsVisible = useAppleNavigationStore(
    (state) => state.settingsVisible
  );
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);

  // While the Settings sheet is open the Settings item is the selected one;
  // `section` underneath is untouched so dismissing returns to it.
  const selectedSection: AppleTabBarSelection = settingsVisible
    ? "settings"
    : section;

  if (!NativeTabBar) return null;
  if (isTopTabBar()) {
    // iPad: a bar of its own above the content, centered like iPadOS's
    // floating tab bar. The screens below start under it.
    return (
      <View
        testID={notesnook.tabbar.id}
        style={{
          paddingTop: insets.top + 4,
          paddingBottom: 4,
          alignItems: "center",
          backgroundColor: visual.screenBackground
        }}
      >
        <View style={{ width: IPAD_TAB_BAR_WIDTH, height: APPLE_TAB_BAR_HEIGHT }}>
          <NativeTabBar
            selectedSection={selectedSection}
            itemTitles={{
              library: strings.routes.Library(),
              tasks: strings.tasksTitle(),
              settings: strings.routes.Settings()
            }}
            tint={colors.primary.accent}
            onSelect={({ nativeEvent }) => onSelect(nativeEvent.section)}
            style={StyleSheet.absoluteFill}
          />
        </View>
      </View>
    );
  }
  return (
    <View
      testID={notesnook.tabbar.id}
      pointerEvents="box-none"
      style={[
        styles.container,
        {
          bottom: 0,
          height: APPLE_TAB_BAR_HEIGHT + insets.bottom
        }
      ]}
    >
      <NativeTabBar
        selectedSection={selectedSection}
        itemTitles={{
          library: strings.routes.Library(),
          tasks: strings.tasksTitle(),
          settings: strings.routes.Settings()
        }}
        tint={colors.primary.accent}
        onSelect={({ nativeEvent }) => onSelect(nativeEvent.section)}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: "transparent"
  }
});
