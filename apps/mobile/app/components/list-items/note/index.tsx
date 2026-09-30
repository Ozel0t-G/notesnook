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
  BaseTrashItem,
  Color,
  Note,
  Reminder,
  TrashItem
} from "@notesnook/core";
import { useThemeColors } from "@notesnook/theme";
import { EntityLevel, decode } from "entities";
import React from "react";
import { View } from "react-native";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { useIsCompactModeEnabled } from "../../../hooks/use-is-compact-mode-enabled";
import useNavigationStore, {
  RouteParams
} from "../../../stores/use-navigation-store";
import { useRelationStore } from "../../../stores/use-relation-store";
import { AppFontSize } from "../../../utils/size";

import {
  getFormattedDate,
  NotebooksWithDateEdited,
  TagsWithDateEdited
} from "@notesnook/common";
import { strings } from "@notesnook/intl";
import { notesnook } from "../../../../e2e/test.ids";
import useIsSelected from "../../../hooks/use-selected";
import { useTabStore } from "../../../screens/editor/tiptap/use-tab-store";
import { useSelectionStore } from "../../../stores/use-selection-store";
import { DefaultAppStyles } from "../../../utils/styles";
import { getAppleVisualTokens } from "../../../utils/apple-visual-tokens";
import { isMacCatalyst } from "../../../utils/constants";
import { Properties } from "../../properties";
import AppIcon from "../../ui/AppIcon";
import { IconButton } from "../../ui/icon-button";
import { TimeSince } from "../../ui/time-since";
import Heading from "../../ui/typography/heading";
import Paragraph from "../../ui/typography/paragraph";
import dayjs from "dayjs";
import { ExpiryDate } from "../../ui/expiry-date";
import {
  homeNoteDisplaySnippet,
  homeNoteDisplayTitle,
  isHomeNoteRoute
} from "../../../utils/home-note-presentation";

/** Mac note row typography (see SelectionWrapper for the row metrics). */
const MAC_NOTE_TITLE_SIZE = 13;
const MAC_NOTE_PREVIEW_SIZE = 12;

type NoteItemProps = {
  item: Note | BaseTrashItem<Note>;
  index: number;
  tags?: TagsWithDateEdited;
  notebooks?: NotebooksWithDateEdited;
  color?: Color;
  reminder?: Reminder;
  attachmentsCount: number;
  date: number;
  isTrash?: boolean;
  noOpen?: boolean;
  locked?: boolean;
  renderedInRoute?: keyof RouteParams;
};

const NoteItem = ({
  item,
  isTrash,
  date,
  color,
  notebooks,
  tags,
  attachmentsCount,
  locked,
  noOpen = false,
  renderedInRoute
}: NoteItemProps) => {
  const isEditingNote = useTabStore(
    (state) =>
      state.tabs.find((t) => t.id === state.currentTab)?.session?.noteId ===
      item.id
  );
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const isHomeIOS = visual.ios && isHomeNoteRoute(renderedInRoute);
  // Mac's source list rows are compact: a 13 pt title with an 11-12 pt
  // secondary preview/date underneath.
  const isMac = isMacCatalyst();
  // The first line is the title, everywhere (list, editor, search).
  const displayTitle =
    visual.ios && !isTrash ? homeNoteDisplayTitle(item as Note) : item.title;
  const displayHeadline = item.headline
    ? decode(item.headline, { level: EntityLevel.HTML })
    : "";
  const homeSnippet = isHomeIOS ? homeNoteDisplaySnippet(item as Note) : "";
  const compactMode = useIsCompactModeEnabled(
    (item as TrashItem).itemType || item.type
  );
  const _update = useRelationStore((state) => state.updater);
  const primaryColors = isEditingNote ? colors.selected : colors.primary;
  const selectionMode = useSelectionStore((state) => state.selectionMode);
  const [selected] = useIsSelected(item);
  return (
    <>
      <View
        style={{
          flexGrow: 1,
          flexShrink: 1
        }}
      >
        {!visual.ios && !compactMode ? (
          <Paragraph
            style={{
              fontSize: AppFontSize.xxxs,
              color: colors.secondary.paragraph
            }}
          >
            {getFormattedDate(
              date,
              dayjs(date).isBefore(dayjs().subtract(1, "day").hour(23))
                ? "date"
                : "time"
            )}
          </Paragraph>
        ) : null}
        {compactMode ? (
          <Paragraph
            numberOfLines={1}
            color={color?.colorCode || primaryColors.heading}
            size={AppFontSize.sm}
            style={{
              paddingRight: 10
            }}
          >
            {displayTitle}
          </Paragraph>
        ) : (
          <Heading
            numberOfLines={1}
            color={color?.colorCode || primaryColors.heading}
            size={isHomeIOS ? AppFontSize.md : AppFontSize.sm}
            style={{
              paddingRight: 10,
              // 13 pt semibold: Heading already carries the 600 weight.
              ...(isMac ? { fontSize: MAC_NOTE_TITLE_SIZE } : {})
            }}
          >
            {displayTitle}
          </Heading>
        )}

        {item.headline && !compactMode && !isHomeIOS ? (
          <Paragraph
            style={{
              flexWrap: "wrap",
              color: visual.secondaryText,
              fontSize: isMac ? MAC_NOTE_PREVIEW_SIZE : undefined,
              marginTop: visual.ios ? 4 : 0
            }}
            color={visual.secondaryText}
            numberOfLines={2}
          >
            {displayHeadline}
          </Paragraph>
        ) : null}

        {compactMode || !visual.ios ? null : (
          <Paragraph
            numberOfLines={isHomeIOS ? 1 : undefined}
            style={{
              fontSize: isMac
                ? MAC_NOTE_PREVIEW_SIZE
                : isHomeIOS
                ? AppFontSize.xs
                : AppFontSize.xxxs,
              color:
                isMac || isHomeIOS
                  ? visual.secondaryText
                  : visual.tertiaryText,
              marginTop: isHomeIOS ? 5 : 7
            }}
          >
            {getFormattedDate(
              date,
              dayjs(date).isBefore(dayjs().subtract(1, "day").hour(23))
                ? "date"
                : "time"
            )}
            {isHomeIOS && homeSnippet ? `  ·  ${homeSnippet}` : null}
          </Paragraph>
        )}

        {compactMode ? null : (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-start",
              alignItems: "center",
              width: "100%",
              marginTop: DefaultAppStyles.GAP_VERTICAL_SMALL,
              columnGap: 8,
              rowGap: 4,
              flexWrap: "wrap"
            }}
          >
            {!isTrash ? (
              <>
                {item.conflicted ? (
                  <Icon
                    name="alert-circle"
                    size={AppFontSize.sm}
                    color={colors.error.accent}
                  />
                ) : null}

                {item.localOnly ? (
                  <Icon
                    testID="sync-off"
                    name="sync-off"
                    size={AppFontSize.sm}
                    color={primaryColors.icon}
                  />
                ) : null}

                {item.readonly ? (
                  <Icon
                    testID="pencil-lock"
                    name="pencil-lock"
                    size={AppFontSize.sm}
                    color={primaryColors.icon}
                  />
                ) : null}

                {attachmentsCount > 0 ? (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 2
                    }}
                  >
                    <Icon
                      name="attachment"
                      size={AppFontSize.sm}
                      color={primaryColors.icon}
                    />
                    <Paragraph
                      color={colors.secondary.paragraph}
                      size={AppFontSize.xxs}
                    >
                      {attachmentsCount}
                    </Paragraph>
                  </View>
                ) : null}

                {item.pinned ? (
                  <Icon
                    testID="icon-pinned"
                    name="pin-outline"
                    size={AppFontSize.sm}
                    color={color?.colorCode || primaryColors.accent}
                  />
                ) : null}

                {locked ? (
                  <Icon
                    name="lock"
                    testID="note-locked-icon"
                    size={AppFontSize.sm}
                    color={primaryColors.icon}
                  />
                ) : null}

                {item.favorite ? (
                  <Icon
                    testID="icon-star"
                    name="star-outline"
                    size={AppFontSize.sm}
                    color="orange"
                  />
                ) : null}

                {item.expiryDate?.value ? (
                  <ExpiryDate
                    note={item as Note}
                    color={color?.colorCode}
                    textStyle={{ fontSize: AppFontSize.xxs }}
                    short
                    iconSize={AppFontSize.xxs}
                    style={{
                      justifyContent: "flex-start",
                      paddingVertical: DefaultAppStyles.GAP_VERTICAL_SMALL / 2,
                      alignSelf: "flex-start"
                    }}
                  />
                ) : null}

                {!isHomeIOS &&
                  notebooks?.items
                    ?.filter(
                      (item) =>
                        renderedInRoute !== "Notebook" ||
                        item.id !== useNavigationStore.getState().focusedRouteId
                    )
                    .map((item) => (
                      <View
                        key={item.id}
                        style={{
                          borderRadius: visual.buttonRadius,
                          backgroundColor: visual.elevatedSurface,
                          paddingHorizontal: DefaultAppStyles.GAP_SMALL / 2,
                          borderWidth: 0,
                          paddingVertical: 3,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: DefaultAppStyles.GAP_SMALL / 2
                        }}
                      >
                        <AppIcon
                          name="book-outline"
                          size={AppFontSize.xxxs}
                          color={colors.secondary.icon}
                        />
                        <Paragraph
                          size={AppFontSize.xxxs}
                          color={colors.secondary.paragraph}
                        >
                          {item.title}
                        </Paragraph>
                      </View>
                    ))}

                {!isHomeIOS && !isTrash && !compactMode && tags
                  ? tags.items?.map((item) =>
                      item.id ? (
                        <View
                          key={item.id}
                          style={{
                            borderRadius: visual.buttonRadius,
                            backgroundColor: visual.elevatedSurface,
                            paddingHorizontal: DefaultAppStyles.GAP_SMALL / 2,
                            borderWidth: 0,
                            paddingVertical: 3
                          }}
                        >
                          <Paragraph
                            size={AppFontSize.xxxs}
                            color={colors.secondary.paragraph}
                          >
                            #{item.title}
                          </Paragraph>
                        </View>
                      ) : null
                    )
                  : null}
              </>
            ) : (
              <>
                <Paragraph
                  color={colors.secondary.paragraph}
                  size={AppFontSize.xxs}
                  style={{
                    marginRight: 6
                  }}
                >
                  {item && item.dateDeleted
                    ? strings.deletedOn(
                        new Date(item.dateDeleted).toISOString().slice(0, 10)
                      )
                    : null}
                </Paragraph>

                <Paragraph
                  color={primaryColors.accent}
                  size={AppFontSize.xxs}
                  style={{
                    marginRight: 6
                  }}
                >
                  {strings.note()}
                </Paragraph>
              </>
            )}
          </View>
        )}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center"
        }}
      >
        {compactMode ? (
          <>
            {item.conflicted ? (
              <Icon
                name="alert-circle"
                style={{
                  marginRight: 6
                }}
                size={AppFontSize.sm}
                color={colors.error.accent}
              />
            ) : null}

            {locked ? (
              <Icon
                name="lock"
                testID="note-locked-icon"
                size={AppFontSize.sm}
                style={{
                  marginRight: 6
                }}
                color={primaryColors.icon}
              />
            ) : null}

            {item.favorite ? (
              <Icon
                testID="icon-star"
                name="star-outline"
                size={AppFontSize.sm}
                style={{
                  marginRight: 6
                }}
                color={colors.static.orange}
              />
            ) : null}

            <TimeSince
              style={{
                fontSize: AppFontSize.xxs,
                color: colors.secondary.paragraph,
                marginRight: 6
              }}
              time={date}
              updateFrequency={Date.now() - date < 60000 ? 2000 : 60000}
            />
          </>
        ) : null}

        {selectionMode === "note" || selectionMode === "trash" ? (
          <>
            <View
              style={{
                height: 35,
                width: 35,
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              <AppIcon
                name={selected ? "checkbox-outline" : "checkbox-blank-outline"}
                color={selected ? colors.selected.icon : colors.primary.icon}
                size={AppFontSize.lg}
              />
            </View>
          </>
        ) : visual.ios && !isTrash ? null : (
          <IconButton
            testID={notesnook.listitem.menu}
            color={colors.secondary.icon}
            name="dots-horizontal"
            size={AppFontSize.lg}
            onPress={() => !noOpen && Properties.present(item)}
            style={{
              justifyContent: "center",
              height: 35,
              width: 35,
              borderRadius: 100,
              alignItems: "center"
            }}
          />
        )}
      </View>
    </>
  );
};

export default NoteItem;
