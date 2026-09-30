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
import { Platform, StyleSheet, View } from "react-native";
import { Note } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { db } from "../../../common/database";
import Navigation from "../../../services/navigation";
import { isMacCatalyst } from "../../../utils/constants";
import { deleteItems } from "../../../utils/functions";
import { systemColor } from "../../../utils/ios-system-colors";
import { MAC_SOURCE_LIST_INSET } from "../../../utils/mac-layout";
import { ItemContextMenu } from "../../item-actions-menu";
import { MacHoverHighlight, useMacHover } from "../../mac-hover";
import { SwipeRow } from "../../swipe-row";

/** Mac note list row metrics (same shape as the Library source list). */
const MAC_NOTE_ROW_PADDING = 8;
const MAC_NOTE_ROW_PADDING_VERTICAL = 10;
const MAC_NOTE_ROW_RADIUS = 6;

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
  const isNoteItem = ((item as TrashItem).itemType || item.type) === "note";
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
  /**
   * Mac's note list rows are source-list rows: no card background, 10 pt of
   * vertical padding, a hairline separator between rows, and the open note
   * marked with the accent at 20% instead of the iPad's 5 pt side bar.
   */
  const macRow = isMacCatalyst() && isNoteItem && !isSheet;
  const macHighlighted = macRow && (showEditing || isSelected);
  // Pointer feedback for the Mac rows only: iPhone/iPad rows have no pointer
  // to hover with, and a sheet's rows keep the iOS look.
  const { hovered, hoverProps } = useMacHover(macRow);

  const onLongPress = () => {
    if (isSheet) return;
    if (useSelectionStore.getState().selectionMode !== item.type) {
      useSelectionStore.getState().setSelectionMode(item.type);
    }
    useSelectionStore.getState().setSelectedItem(item.id);
  };

  const row = (
    <Pressable
      {...hoverProps}
      customColor={
        macRow
          ? "transparent"
          : showEditing || isSelected
          ? visual.selectionBackground
          : isSheet
          ? colors.primary.hover
          : visual.elevatedSurface
      }
      testID={testID}
      onLongPress={nativeMenus && !selectionMode ? undefined : onLongPress}
      onPress={onPress}
      customSelectedColor={
        macRow ? visual.hoverSurface : visual.selectionBackground
      }
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
        paddingHorizontal: macRow ? MAC_NOTE_ROW_PADDING : visual.rowInset,
        paddingVertical: macRow
          ? MAC_NOTE_ROW_PADDING_VERTICAL
          : compactMode
          ? visual.ios
            ? 8
            : 6
          : homeNote
          ? 15
          : visual.rowPadding,
        borderRadius: macRow
          ? MAC_NOTE_ROW_RADIUS
          : visual.ios && isTabletPane && !isSheet
          ? 0
          : visual.ios && !isSheet
          ? homeNote
            ? 17
            : 10
          : visual.cardRadius,
        // Mac rows sit in the source list's 10 pt margin: without it the row
        // runs edge to edge and its rounded highlight touches the window.
        marginHorizontal: isSheet
          ? 0
          : macRow
          ? MAC_SOURCE_LIST_INSET
          : visual.listInset,
        marginBottom: macRow
          ? 0
          : isSheet
          ? DefaultAppStyles.GAP_VERTICAL
          : visual.ios
          ? isTabletPane
            ? 0
            : homeNote
            ? 7
            : 2
          : visual.rowSpacing,
        borderWidth: macRow ? 0 : isSheet || visual.ios ? 0 : 0.5,
        borderBottomWidth: macRow
          ? StyleSheet.hairlineWidth
          : visual.ios && isTabletPane && !isSheet
          ? 0.5
          : 0,
        borderColor: visual.separator,
        ...(isSheet || visual.ios ? {} : visual.subtleShadow)
      }}
    >
      {/* Pointer feedback under the selection highlight, so hovering a row
          never hides the note that is actually open. */}
      <MacHoverHighlight
        visible={hovered && !macHighlighted}
        radius={MAC_NOTE_ROW_RADIUS}
      />
      {macHighlighted ? (
        /* Accent at low opacity: a layer of its own so custom themes (and
           their non-hex colors) keep working. */
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: MAC_NOTE_ROW_RADIUS,
            backgroundColor: colors.primary.accent,
            opacity: 0.2
          }}
        />
      ) : null}
      {showEditing && !macRow ? (
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
