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
import { useSettingStore } from "../../../stores/use-setting-store";
import { DefaultAppStyles } from "../../../utils/styles";
import { getAppleVisualTokens } from "../../../utils/apple-visual-tokens";
import { Pressable } from "../../ui/pressable";
import { Platform, View } from "react-native";
import { Note } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { db } from "../../../common/database";
import Navigation from "../../../services/navigation";
import { deleteItems } from "../../../utils/functions";
import { systemColor } from "../../../utils/ios-system-colors";
import { ItemContextMenu } from "../../item-actions-menu";
import { SwipeRow } from "../../swipe-row";

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
  homeNote?: boolean;
}>;

const SelectionWrapper = ({
  item,
  onPress,
  testID,
  isSheet,
  children,
  color,
  homeNote = false,
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
  const isTabletPane = useSettingStore(
    (state) => state.deviceMode === "tablet"
  );

  if (item.id !== itemId.current) {
    itemId.current = item.id;
  }

  const selectionMode = useSelectionStore((state) => state.selectionMode);
  // iOS: long press opens the native context menu (selection lives in the
  // list's "…" menu). Notes also get swipe actions like in Notes.
  const nativeMenus =
    Platform.OS === "ios" &&
    !isSheet &&
    (item.type === "note" || item.type === "notebook" || item.type === "tag");
  // The open note is only marked where the editor is visible next to the
  // list (iPad). On iPhone a selection must not stay behind after going back.
  const showEditing = isEditingNote && isTabletPane;

  const onLongPress = () => {
    if (isSheet) return;
    if (useSelectionStore.getState().selectionMode !== item.type) {
      useSelectionStore.getState().setSelectionMode(item.type);
    }
    useSelectionStore.getState().setSelectedItem(item.id);
  };

  const row = (
    <Pressable
      customColor={
        showEditing || isSelected
          ? visual.selectionBackground
          : isSheet
          ? colors.primary.hover
          : visual.elevatedSurface
      }
      testID={testID}
      onLongPress={nativeMenus && !selectionMode ? undefined : onLongPress}
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
        paddingVertical: compactMode
          ? visual.ios
            ? 8
            : 6
          : homeNote
          ? 15
          : visual.rowPadding,
        borderRadius:
          visual.ios && isTabletPane && !isSheet
            ? 0
            : visual.ios && !isSheet
            ? homeNote
              ? 17
              : 10
            : visual.cardRadius,
        marginHorizontal: isSheet ? 0 : visual.listInset,
        marginBottom: isSheet
          ? DefaultAppStyles.GAP_VERTICAL
          : visual.ios
          ? isTabletPane
            ? 0
            : homeNote
            ? 7
            : 2
          : visual.rowSpacing,
        borderWidth: isSheet || visual.ios ? 0 : 0.5,
        borderBottomWidth: visual.ios && isTabletPane && !isSheet ? 0.5 : 0,
        borderColor: visual.separator,
        ...(isSheet || visual.ios ? {} : visual.subtleShadow)
      }}
    >
      {showEditing ? (
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

  if (!nativeMenus) return row;

  const menu = (
    <ItemContextMenu
      item={item}
      enabled={!selectionMode}
      previewCornerRadius={10}
    >
      {row}
    </ItemContextMenu>
  );
  if (item.type !== "note") return menu;
  const note = item as Note;
  return (
    <SwipeRow
      enabled={!selectionMode}
      leading={[
        {
          key: "pin",
          label: note.pinned ? strings.unpin() : strings.pin(),
          symbol: note.pinned ? "pin.slash.fill" : "pin.fill",
          color: systemColor("orange", isDark),
          onPress: async () => {
            await db.notes.pin(!note.pinned, note.id);
            Navigation.queueRoutesForUpdate();
          }
        }
      ]}
      trailing={[
        {
          key: "trash",
          label: strings.delete(),
          symbol: "trash.fill",
          color: systemColor("red", isDark),
          onPress: () => void deleteItems("note", [note.id])
        },
        {
          key: "notebook",
          label: strings.dataTypesPluralCamelCase.notebook(),
          symbol: "folder.fill",
          color: systemColor("indigo", isDark),
          onPress: () =>
            Navigation.navigate("LinkNotebooks", { noteIds: [note.id] })
        }
      ]}
    >
      {menu}
    </SwipeRow>
  );
};

export default SelectionWrapper;
