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
import { notesnook } from "../../e2e/test.ids";
import {
  AppleSection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import {
  MAC_TITLEBAR_CONTROL_HEIGHT,
  MAC_TITLEBAR_CONTROL_LEFT
} from "../utils/mac-layout";
import { TaskSymbolView } from "./task-symbol-view";

const SECTIONS: {
  section: AppleSection;
  symbol: string;
  title: () => string;
  testID: string;
}[] = [
  {
    section: "library",
    symbol: "books.vertical",
    title: () => strings.routes.Library(),
    testID: notesnook.tabbar.itemIds.library
  },
  {
    section: "tasks",
    symbol: "checklist",
    title: () => strings.tasksTitle(),
    testID: notesnook.tabbar.itemIds.tasks
  },
  {
    section: "search",
    symbol: "magnifyingglass",
    title: () => strings.routes.Search(),
    testID: notesnook.tabbar.itemIds.search
  }
];

/**
 * Mac Catalyst's replacement for the floating iPad tab bar: the three
 * top-level sections as a segmented control inside the window's title bar row.
 * It reports through the same selection handler the native bar uses, so
 * Library/Tasks/Search switching is identical on both.
 *
 * `width` is the control's own width (see `macSectionControlWidth`). The
 * control is laid out at `MAC_TITLEBAR_CONTROL_LEFT` so it clears the window's
 * traffic lights, and it is vertically centered by the 52 pt title bar row it
 * is mounted in.
 */
export function MacSectionControl({
  width,
  onSelect
}: {
  width: number;
  onSelect: (section: AppleSection) => void;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const selected = useAppleNavigationStore((state) => state.section);

  return (
    <View
      testID={notesnook.tabbar.id}
      style={{
        width,
        marginLeft: MAC_TITLEBAR_CONTROL_LEFT,
        flexDirection: "row",
        height: MAC_TITLEBAR_CONTROL_HEIGHT,
        borderRadius: 6,
        backgroundColor: visual.secondarySurface,
        overflow: "hidden"
      }}
    >
      {SECTIONS.map((item) => {
        const active = item.section === selected;
        return (
          <Pressable
            key={item.section}
            testID={item.testID}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={item.title()}
            onPress={() => onSelect(item.section)}
            style={{
              flex: 1,
              height: MAC_TITLEBAR_CONTROL_HEIGHT,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              borderRadius: 6
            }}
          >
            {/* Accent at low opacity: a layer of its own so custom themes
                (and their non-hex colors) keep working. */}
            {active ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  borderRadius: 6,
                  backgroundColor: colors.primary.accent,
                  opacity: 0.2
                }}
              />
            ) : null}
            <TaskSymbolView
              name={item.symbol}
              size={12}
              color={active ? colors.primary.accent : visual.secondaryText}
            />
            <Text
              numberOfLines={1}
              style={{
                color: active ? visual.primaryText : visual.secondaryText,
                fontSize: 12,
                fontWeight: active ? "600" : "400"
              }}
            >
              {item.title()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default MacSectionControl;
