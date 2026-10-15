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
import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { useTotalNotes } from "../../hooks/use-db-item";

import { db } from "../../common/database";
import {
  eSubscribeEvent,
  subscribeToItemUpdate
} from "../../services/event-manager";
import Navigation from "../../services/navigation";
import { getTemplateCount } from "../../services/templates";
import useNavigationStore, {
  RouteParams
} from "../../stores/use-navigation-store";
import { eAfterSync, eMenuItemUpdate } from "../../utils/events";
import { SideMenuItem } from "../../utils/menu-items";
import { AppFontSize, defaultBorderRadius } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { Pressable } from "../ui/pressable";
import Paragraph from "../ui/typography/paragraph";
import { useSideBarDraggingStore } from "./dragging-store";
import {
  IPadSourceRowMeasurement,
  IPadSourceSymbol,
  isIPadSourceList
} from "./ipad-source-navigation";
import { useRelationStore } from "../../stores/use-relation-store";

export function MenuItem({
  item,
  index,
  testID,
  renderIcon
}: {
  /**
   * The shared side-menu row. `focusedId` is the iPad sidebar's addition (see
   * `resolveIPadSideMenuItem`): the row keeps its id - the stored order, hidden
   * state and count are keyed by it - but is highlighted while the collection it
   * opens reports a different focused route id (`Notes` opens All Notes, which
   * reports `AllNotes`).
   */
  item: SideMenuItem & { focusedId?: string };
  index?: number;
  testID?: string;
  renderIcon?: (item: SideMenuItem, size: number) => React.ReactNode;
}) {
  const [itemCount, setItemCount] = useState(0);
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const ipadSource = isIPadSourceList();
  const measureSourceRow = React.useContext(IPadSourceRowMeasurement);
  const isFocused = useNavigationStore(
    (state) => state.focusedRouteId === (item.focusedId || item.id)
  );
  const totalNotes = useTotalNotes(
    item.dataType as "notebook" | "tag" | "color"
  );
  const update = useRelationStore((state) => state.updater);
  const getTotalNotesRef = useRef(totalNotes.getTotalNotes);
  getTotalNotesRef.current = totalNotes.getTotalNotes;
  const menuItemCount = !item.data
    ? itemCount
    : totalNotes.totalNotes(item.data.id);

  useEffect(() => {
    if (item.data) {
      getTotalNotesRef.current([item.data?.id]);
    }
  }, [item.data, update]);

  useEffect(() => {
    const onSyncComplete = async () => {
      try {
        if (!item.data) {
          switch (item.id) {
            case "Notes":
              setItemCount(await db.notes.all.count());
              break;
            case "Inbox":
              // The Library's Inbox is exactly the notes that are in no
              // notebook, so the count is the truthful unassigned count - not
              // the total, which would make the row claim the whole library.
              setItemCount(await db.notes.unassigned.count());
              break;
            case "Favorites":
              setItemCount(await db.notes.favorites.count());
              break;
            case "Reminders":
              setItemCount(
                (await db.reminders.all.ids()).filter(
                  (id) => !db.tasks.isMigratedReminder(id)
                ).length
              );
              break;
            case "Tasks":
              setItemCount((await db.tasks.smartList("all")).length);
              break;
            case "Monographs":
              setItemCount(await db.monographs.all.count());
              break;
            case "Archive":
              setItemCount(await db.notes.archived.count());
              break;
            case "Templates":
              setItemCount(await getTemplateCount());
              break;
            case "Trash":
              {
                setItemCount((await db.trash.all()).length);
              }
              break;
          }
        } else {
          getTotalNotesRef.current?.([item.data.id]);
        }
      } catch (e) {
        /** Empty */
      }
    };
    const events = [eSubscribeEvent(eAfterSync, onSyncComplete)];

    if (!item.data) {
      events.push(eSubscribeEvent(eMenuItemUpdate, onSyncComplete));
    }

    if (item.data?.id) {
      events.push(
        subscribeToItemUpdate(item?.data?.id, item?.data?.type, onSyncComplete)
      );
    }
    onSyncComplete();
    return () => {
      events?.forEach((e) => e?.unsubscribe());
    };
  }, [item.data, item.id]);

  const _onPress = () => {
    if (useSideBarDraggingStore.getState().dragging) return;
    if (item.onPress) return item.onPress(item);
    Navigation.closeDrawer();
    if (useNavigationStore.getState().currentRoute !== item.id) {
      Navigation.navigate(item.id as keyof RouteParams, {
        canGoBack: false
      });
    }
  };

  return (
    <Pressable
      testID={testID}
      onLayout={
        ipadSource && measureSourceRow
          ? (event) =>
              measureSourceRow(item.id, event.nativeEvent.layout.height)
          : undefined
      }
      key={item.id}
      onPress={_onPress}
      onLongPress={() => item.onLongPress?.(item)}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      // The row's own "selected" state: a VoiceOver user hears which list the
      // bar is showing, the same fact the filled background paints.
      accessibilityState={{ selected: isFocused }}
      // The visible trailing count is otherwise announcable-impossible: the
      // label alone would hide it, so expose the same number as the row's
      // generic value (no "notes" wording - the field serves every row).
      accessibilityValue={{ text: String(menuItemCount) }}
      type={isFocused ? "selected" : "plain"}
      style={{
        width: "100%",
        alignSelf: "center",
        borderRadius: ipadSource
          ? defaultBorderRadius
          : visual.ios
          ? visual.controlRadius
          : defaultBorderRadius,
        flexDirection: "row",
        paddingHorizontal: visual.ios
          ? visual.sidebarPadding
          : DefaultAppStyles.GAP_SMALL,
        justifyContent: "space-between",
        alignItems: "center",
        minHeight: ipadSource ? 44 : undefined,
        paddingVertical: ipadSource
          ? DefaultAppStyles.GAP_VERTICAL
          : visual.ios
          ? 11
          : DefaultAppStyles.GAP_VERTICAL_SMALL,
        backgroundColor:
          visual.ios && isFocused ? visual.selectedSurface : undefined
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: DefaultAppStyles.GAP_SMALL,
          flexShrink: 1
        }}
      >
        {renderIcon ? (
          renderIcon(item, AppFontSize.md)
        ) : ipadSource ? (
          <IPadSourceSymbol
            name={
              (
                {
                  Notes: "doc",
                  Inbox: "tray",
                  Favorites: "star",
                  Tasks: "checkmark.circle",
                  Monographs: "doc.text",
                  Archive: "archivebox",
                  Templates: "doc.on.doc",
                  Trash: "trash"
                } as Record<string, string>
              )[item.id] ||
              (item.dataType === "notebook"
                ? "book.closed"
                : item.dataType === "tag"
                ? "number"
                : "doc")
            }
            size={AppFontSize.md}
            color={isFocused ? colors.primary.accent : colors.primary.icon}
          />
        ) : (
          <Icon
            style={{
              textAlignVertical: "center",
              textAlign: "left"
            }}
            allowFontScaling
            name={item.icon}
            color={
              item.icon === "crown"
                ? colors.static.yellow
                : isFocused
                ? colors.selected.icon
                : colors.secondary.icon
            }
            size={AppFontSize.md}
          />
        )}

        <Paragraph
          color={
            isFocused ? colors.selected.paragraph : colors.primary.paragraph
          }
          size={ipadSource ? AppFontSize.md : AppFontSize.sm}
          style={{ flexShrink: 1 }}
        >
          {item.title}
        </Paragraph>
      </View>

      <Paragraph
        size={ipadSource ? AppFontSize.sm : AppFontSize.xxs}
        color={
          isFocused ? colors.primary.paragraph : colors.secondary.paragraph
        }
        style={{
          marginLeft: DefaultAppStyles.GAP_SMALL,
          ...(ipadSource ? { flexShrink: 0 } : {})
        }}
      >
        {menuItemCount}
      </Paragraph>
    </Pressable>
  );
}
