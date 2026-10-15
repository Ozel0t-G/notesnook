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
import { Pressable, View } from "react-native";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { AppFontSize } from "../utils/size";
import { DefaultAppStyles } from "../utils/styles";
import { TaskSymbolView } from "./task-symbol-view";
import Paragraph from "./ui/typography/paragraph";

type PrimarySelection = "library" | "tasks" | "search";

/** Presentation only; the workspace owns placement, width and navigation. */
export function IPadPrimaryDestinations({
  selection,
  onSelect
}: {
  selection: PrimarySelection;
  onSelect: (selection: PrimarySelection) => void;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const destinations = [
    {
      id: "library",
      title: strings.dataTypesPluralCamelCase.note(),
      symbol: "doc.text"
    },
    { id: "tasks", title: strings.tasksTitle(), symbol: "checkmark.circle" },
    { id: "search", title: strings.search(), symbol: "magnifyingglass" }
  ] as const;

  return (
    <View testID="ipad-primary-destinations">
      {destinations.map(({ id, title, symbol }) => {
        const selected = selection === id;
        const color = selected ? colors.primary.accent : visual.primaryText;
        return (
          <Pressable
            key={id}
            testID={`ipad-primary-${id}`}
            accessible
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityState={{ selected }}
            onPress={() => onSelect(id)}
            style={({ pressed }) => ({
              minHeight: 44,
              minWidth: 44,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: visual.pagePadding,
              paddingVertical: DefaultAppStyles.GAP_VERTICAL_SMALL,
              gap: DefaultAppStyles.GAP_SMALL,
              // Section status stays distinct from a filled notebook selection.
              backgroundColor: pressed ? visual.hoverSurface : "transparent"
            })}
          >
            <TaskSymbolView name={symbol} color={color} size={AppFontSize.lg} />
            <Paragraph
              size={AppFontSize.md}
              color={color}
              style={{
                flex: 1,
                flexShrink: 1,
                fontWeight: selected ? "600" : "400"
              }}
            >
              {title}
            </Paragraph>
          </Pressable>
        );
      })}
    </View>
  );
}
