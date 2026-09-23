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

import { Item, TrashItem } from "@notesnook/core";
import { useThemeColors } from "@notesnook/theme";
import React, { PropsWithChildren, useRef } from "react";
import { useIsCompactModeEnabled } from "../../../hooks/use-is-compact-mode-enabled";
import useIsSelected from "../../../hooks/use-selected";
import { useTabStore } from "../../../screens/editor/tiptap/use-tab-store";
import { useSelectionStore } from "../../../stores/use-selection-store";
import { DefaultAppStyles } from "../../../utils/styles";
import { getAppleVisualTokens } from "../../../utils/apple-visual-tokens";
import { Pressable } from "../../ui/pressable";
import { View } from "react-native";

export function selectItem(item: Item) {
  if (useSelectionStore.getState().selectionMode === item.type) {
    const { selectionMode, clearSelection, setSelectedItem } =
      useSelectionStore.getState();

    if (selectionMode === item.type) {
      setSelectedItem(item.id);
    }

    if (useSelectionStore.getState().selectedItemsList.length === 0) {
      clearSelection();
    }
    return true;
  }
  return false;
}

type SelectionWrapperProps = PropsWithChildren<{
  item: Item;
  onPress: () => void;
  testID?: string;
  isSheet?: boolean;
  color?: string;
  index?: number;
}>;

const SelectionWrapper = ({
  item,
  onPress,
  testID,
  isSheet,
  children,
  color,
  index: _index = 0
}: SelectionWrapperProps) => {
  const itemId = useRef(item.id);
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const isEditingNote = useTabStore(
    (state) =>
      state.tabs.find((t) => t.id === state.currentTab)?.session?.noteId ===
      item.id
  );
  const compactMode = useIsCompactModeEnabled(
    (item as TrashItem).itemType || item.type
  );
  const [isSelected] = useIsSelected(item);

  if (item.id !== itemId.current) {
    itemId.current = item.id;
  }

  const onLongPress = () => {
    if (isSheet) return;
    if (useSelectionStore.getState().selectionMode !== item.type) {
      useSelectionStore.getState().setSelectionMode(item.type);
    }
    useSelectionStore.getState().setSelectedItem(item.id);
  };

  return (
    <Pressable
      customColor={
        isEditingNote || isSelected
          ? visual.selectionBackground
          : isSheet
          ? colors.primary.hover
          : visual.elevatedSurface
      }
      testID={testID}
      onLongPress={onLongPress}
      onPress={onPress}
      customSelectedColor={visual.selectionBackground}
      customAlpha={!isDark ? -0.03 : 0.03}
      customOpacity={1}
      hitSlop={
        isSheet
          ? undefined
          : {
              left: visual.listInset,
              right: visual.listInset
            }
      }
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        width: isSheet ? "100%" : "auto",
        alignSelf: "center",
        overflow: "hidden",
        paddingHorizontal: visual.rowInset,
        paddingVertical: compactMode ? 6 : 12,
        borderRadius: visual.cardRadius,
        marginHorizontal: isSheet ? 0 : visual.listInset,
        marginBottom: isSheet
          ? DefaultAppStyles.GAP_VERTICAL
          : visual.rowSpacing,
        borderWidth: isSheet ? 0 : 0.5,
        borderColor: visual.separator,
        ...(isSheet ? {} : visual.subtleShadow)
      }}
    >
      {isEditingNote ? (
        <View
          style={{
            backgroundColor: color || colors.selected.accent,
            position: "absolute",
            bottom: 0,
            top: 0,
            left: 0,
            width: 5
          }}
        />
      ) : null}
      {children}
    </Pressable>
  );
};

export default SelectionWrapper;
