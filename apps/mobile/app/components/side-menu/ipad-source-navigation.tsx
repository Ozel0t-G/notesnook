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
import { Platform } from "react-native";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { Pressable } from "../ui/pressable";
import Paragraph from "../ui/typography/paragraph";

// Measurements belong to the embedded source rows, never to navigation or data.
export const IPadSourceRowMeasurement = React.createContext<
  ((id: string, height: number) => void) | undefined
>(undefined);

// Content presentation only: the existing workspace still owns width/pane mode.
export function isIPadSourceList() {
  return Platform?.OS === "ios" && Platform.isPad && !Platform.isMacCatalyst;
}

export function IPadSourceSymbol(props: {
  name: string;
  color: string;
  size?: number;
}) {
  // Only the gated iPad presentation loads the existing native symbol renderer.
  const { TaskSymbolView } = require("../task-symbol-view");
  return <TaskSymbolView {...props} />;
}

export function IPadSourceSection({
  title,
  expanded,
  onPress,
  testID,
  disabled = false
}: {
  title: string;
  disabled?: boolean;
  expanded: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const ipadSource = isIPadSourceList();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded, disabled }}
      disabled={disabled}
      onPress={onPress}
      type="transparent"
      noborder
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: visual.pagePadding,
        gap: DefaultAppStyles.GAP_SMALL
      }}
    >
      <Paragraph
        size={ipadSource ? AppFontSize.sm : AppFontSize.xs}
        color={visual.secondaryText}
        style={{ flexShrink: 1, fontWeight: "600" }}
      >
        {title}
      </Paragraph>
      <IPadSourceSymbol
        name={expanded ? "chevron.down" : "chevron.right"}
        size={AppFontSize.xs}
        color={visual.secondaryText}
      />
    </Pressable>
  );
}

/** A definite measurement frame only for embedded iPad sources. */
export function IPadSourceFrame({
  enabled,
  height,
  testID,
  children
}: {
  enabled: boolean;
  height: number;
  testID: string;
  children: React.ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  const { View } = require("react-native");
  return (
    <View
      testID={testID}
      style={{ height, overflow: height === 0 ? "hidden" : "visible" }}
    >
      {children}
    </View>
  );
}
