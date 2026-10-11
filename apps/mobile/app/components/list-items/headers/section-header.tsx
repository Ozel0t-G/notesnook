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

import {
  GroupHeader,
  GroupingByIdKey,
  GroupingKey,
  GroupOptions,
  ItemType
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { Text, View } from "react-native";
import { useIsCompactModeEnabled } from "../../../hooks/use-is-compact-mode-enabled";
import { presentSheet } from "../../../services/event-manager";
import SettingsService from "../../../services/settings";
import { RouteName } from "../../../stores/use-navigation-store";
import { AppFontSize } from "../../../utils/size";
import { DefaultAppStyles } from "../../../utils/styles";
import { getAppleVisualTokens } from "../../../utils/apple-visual-tokens";
import { isMacCatalyst } from "../../../utils/constants";
import { isHomeNoteRoute } from "../../../utils/home-note-presentation";
import Sort from "../../sheets/sort";
import { IconButton } from "../../ui/icon-button";
import { Pressable } from "../../ui/pressable";
import Heading from "../../ui/typography/heading";

type SectionHeaderProps = {
  item: GroupHeader;
  index: number;
  dataType: ItemType;
  color?: string;
  screen?: RouteName;
  groupOptions: GroupOptions;
  group: GroupingKey;
  groupId?: string;
  type?: GroupingByIdKey;
  onOpenJumpToDialog: () => void;
  itemCount?: number;
};

export const SectionHeader = React.memo<
  React.FunctionComponent<SectionHeaderProps>
>(
  function SectionHeader({
    item,
    index,
    dataType,
    color,
    screen,
    groupOptions,
    group,
    onOpenJumpToDialog,
    itemCount,
    groupId,
    type
  }: SectionHeaderProps) {
    const { colors, isDark } = useThemeColors();
    const visual = getAppleVisualTokens(colors, isDark);
    const isCompactModeEnabled = useIsCompactModeEnabled(
      dataType as "note" | "notebook" | "searchResult"
    );

    /**
     * The list's sort sheet + compact/view toggle, exactly the IconButtons the
     * iPhone/iPad header shows. Mac Catalyst shows them in the first group
     * header too (N7/C10); the handlers are the shared ones (presentSheet's
     * Sort sheet and SettingsService), so no Mac-only menu is duplicated.
     *
     * Mac's pair is the 16 pt, background-less toolbar glyph size the pointer
     * draws a hover highlight under (IconButton's plain type + mac-hover), the
     * same treatment the window toolbar's buttons get.
     */
    const sortAndViewButtons = (
      <>
        <IconButton
          name={
            groupOptions.sortDirection === "asc"
              ? "sort-ascending"
              : "sort-descending"
          }
          color={colors.secondary.icon}
          testID="icon-sort"
          onPress={() => {
            if (!screen) return;
            presentSheet({
              component: (
                <Sort
                  screen={screen}
                  dataType={dataType}
                  type={type}
                  group={group}
                  groupId={groupId}
                  hideGroupOptions={
                    screen === "Reminders" || screen === "Search"
                  }
                />
              )
            });
          }}
          style={{
            width: 25,
            height: 25
          }}
          size={isMacCatalyst() ? 16 : AppFontSize.lg - 2}
        />
        <IconButton
          hidden={
            dataType !== "note" &&
            dataType !== "notebook" &&
            screen !== "Notes" &&
            screen !== "Search"
          }
          style={{
            width: 25,
            height: 25
          }}
          testID="icon-compact-mode"
          color={colors.secondary.icon}
          name={isCompactModeEnabled ? "view-list" : "view-list-outline"}
          onPress={() => {
            SettingsService.set({
              [dataType === "notebook"
                ? "notebooksListMode"
                : dataType === "searchResult"
                ? "searchListMode"
                : "notesListMode"]: !isCompactModeEnabled
                ? "compact"
                : "normal"
            });
          }}
          size={isMacCatalyst() ? 16 : AppFontSize.lg - 2}
        />
      </>
    );

    /**
     * Mac: a plain source-list section header - an 11 pt semibold label in the
     * secondary color, 8 pt above the group it starts, with no background. The
     * iPhone/iPad header is a rounded bar (the "Today"/"Yesterday" pill) that
     * would drown the 260-360 pt note list column. The first header also shows
     * the sort/view buttons (N7/C10), right-aligned like in the toolbar.
     */
    if (isMacCatalyst()) {
      return (
        <View
          style={{
            width: "100%",
            paddingHorizontal: visual.listInset,
            paddingTop: 8
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between"
            }}
          >
            <Pressable
              onPress={() => {
                onOpenJumpToDialog();
              }}
              hitSlop={{ top: 8, left: 10, right: 30, bottom: 8 }}
              // The shared Pressable centers itself by default (it is a row
              // between two spacers in the iPhone/iPad header); a source-list
              // section header starts at the column's leading edge.
              style={{
                flexDirection: "row",
                width: "auto"
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: visual.secondaryText,
                  fontSize: 11,
                  fontWeight: "600"
                }}
              >
                {!item.title || item.title === ""
                  ? screen === "Search"
                    ? strings.results(itemCount || 0)
                    : strings.pinned()
                  : item.title}
              </Text>
            </Pressable>
            {index === 0 ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: DefaultAppStyles.GAP_SMALL
                }}
              >
                {sortAndViewButtons}
              </View>
            ) : null}
          </View>
        </View>
      );
    }

    /**
     * iPhone/iPad note lists (Notes/Inbox, Favorites, Archive, a notebook,
     * ...): the date sections ("Pinned", "Today", "Yesterday", ...) are plain
     * text headings instead of the accent-colored, uppercase pill the other
     * lists draw. Their sort/view actions now live in the screen's top header
     * (which shows the note count and the trio right under the large title; the
     * Home note list already owned its own), so the pair is not repeated here.
     * The press that opens the jump-to-section dialog and the grouped list
     * spacing are kept. Android and every non-note list keep the pill below.
     */
    if (visual.ios && dataType === "note") {
      const isHomeNote = isHomeNoteRoute(screen);
      const title =
        !item.title || item.title === ""
          ? screen === "Search"
            ? strings.results(itemCount || 0)
            : strings.pinned()
          : item.title;
      // An ungrouped note list still emits the literal "All" section from the
      // grouping selector; that single, meaningless header is redundant, so
      // drop it. "Pinned"/"Conflicted" are emitted even when ungrouped and
      // must stay. Only this iOS/iPad note branch is affected; the Mac
      // Catalyst header (above) and the Android pill (below) are untouched.
      if (groupOptions.groupBy === "none" && item.title === "All") return null;
      return (
        <View
          style={{
            width: "100%",
            // The note row's own text starts at the list inset plus its row
            // inset; the heading keeps that same leading edge so the sections
            // line up with the notes they group.
            paddingHorizontal: visual.listInset + visual.rowInset,
            paddingTop: index === 0 ? DefaultAppStyles.GAP : 0,
            marginBottom: 8,
            marginTop: index > 0 ? visual.sectionSpacing : 0
          }}
        >
          <Pressable
            onPress={() => {
              onOpenJumpToDialog();
            }}
            hitSlop={{ top: 10, left: 10, right: 30, bottom: 10 }}
            style={{
              justifyContent: "flex-start",
              flexDirection: "row",
              alignItems: "center",
              width: "auto"
            }}
          >
            <Heading
              numberOfLines={1}
              size={17}
              style={{
                alignSelf: "center",
                textAlignVertical: "center"
              }}
              color={isHomeNote ? visual.primaryText : visual.secondaryText}
            >
              {title}
            </Heading>
          </Pressable>
        </View>
      );
    }

    return (
      <View
        style={{
          width: "100%",
          paddingHorizontal: visual.listInset,
          marginBottom: visual.ios ? 8 : DefaultAppStyles.GAP_VERTICAL_SMALL,
          marginTop: visual.ios && index > 0 ? visual.sectionSpacing : 0
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            width: "100%",
            alignSelf: "center",
            justifyContent: "space-between",
            borderBottomWidth: visual.ios ? 0 : 0.5,
            borderColor: visual.separator,
            borderRadius: visual.sectionRadius,
            backgroundColor: visual.ios
              ? visual.screenBackground
              : visual.elevatedSurface,
            paddingHorizontal: visual.rowInset,
            paddingBottom: DefaultAppStyles.GAP_VERTICAL_SMALL,
            paddingTop:
              index === 0
                ? DefaultAppStyles.GAP
                : DefaultAppStyles.GAP_VERTICAL,
            ...(visual.ios ? {} : visual.subtleShadow)
          }}
        >
          <Pressable
            onPress={() => {
              onOpenJumpToDialog();
            }}
            hitSlop={{ top: 10, left: 10, right: 30, bottom: 15 }}
            style={{
              justifyContent: "flex-start",
              flexDirection: "row",
              width: "auto"
            }}
          >
            <Heading
              size={
                visual.ios && isHomeNoteRoute(screen)
                  ? AppFontSize.lg
                  : AppFontSize.xxs
              }
              style={{
                alignSelf: "center",
                textAlignVertical: "center"
              }}
              color={
                visual.ios && isHomeNoteRoute(screen)
                  ? visual.primaryText
                  : color || colors.primary.accent
              }
            >
              {!item.title || item.title === ""
                ? screen === "Search"
                  ? strings.results(itemCount || 0)
                  : strings.pinned().toUpperCase()
                : visual.ios && isHomeNoteRoute(screen)
                ? item.title
                : item.title.toUpperCase()}
            </Heading>
          </Pressable>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: DefaultAppStyles.GAP_SMALL
            }}
          >
            {index === 0 && !(visual.ios && isHomeNoteRoute(screen))
              ? sortAndViewButtons
              : null}

            {/* <IconButton
              style={{
                width: 25,
                height: 25
              }}
              color={colors.secondary.icon}
              name={"chevron-down"}
              size={SIZE.lg - 2}
            /> */}
          </View>
        </View>
      </View>
    );
  },
  (prev, next) => {
    if (prev.item.title !== next.item.title) return false;
    if (prev.itemCount !== next.itemCount) return false;
    if (prev.groupOptions?.groupBy !== next.groupOptions.groupBy) return false;
    if (prev.groupOptions?.sortDirection !== next.groupOptions.sortDirection)
      return false;
    if (prev.groupOptions?.sortBy !== next.groupOptions.sortBy) return false;

    return true;
  }
);
