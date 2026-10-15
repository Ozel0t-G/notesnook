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
  NotebooksWithDateEdited,
  TagsWithDateEdited,
  isNoteResolvedData,
  resolveItems
} from "@notesnook/common";
import type { NoteThumbnail as NoteThumbnailInfo } from "@notesnook/common";
import {
  Color,
  GroupHeader,
  GroupOptions,
  GroupingByIdKey,
  GroupingKey,
  HighlightedResult,
  Item,
  ItemType,
  Note,
  Notebook,
  Reminder,
  Tag,
  TrashItem,
  VirtualizedGrouping,
  getSortValue
} from "@notesnook/core";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { getGroupOptions } from "../../hooks/use-group-options";
import { useIsCompactModeEnabled } from "../../hooks/use-is-compact-mode-enabled";
import { eSendEvent } from "../../services/event-manager";
import { RouteName } from "../../stores/use-navigation-store";
import { eOpenJumpToDialog } from "../../utils/events";
import { SectionHeader } from "../list-items/headers/section-header";
import { NoteWrapper } from "../list-items/note/wrapper";
import { NotebookWrapper } from "../list-items/notebook/wrapper";
import ReminderItem from "../list-items/reminder";
import { SearchResult } from "../list-items/search-result";
import TagItem from "../list-items/tag";

type ListItemWrapperProps<TItem = Item> = {
  group: GroupingKey;
  items: VirtualizedGrouping<TItem> | undefined;
  isSheet: boolean;
  index: number;
  renderedInRoute?: RouteName;
  customAccentColor?: string;
  dataType: string;
  scrollRef: any;
  /**
   * Mac's list column: the top inset the "jump to section" dialog's item
   * scrolls must clear (components/list/index.tsx passes the same
   * `macListTopInset` the rows are padded by). 0 on iPhone/iPad and sheets.
   */
  scrollViewOffset?: number;
  groupOptions: GroupOptions;
  origin?: { id: string; title: string };
  groupId?: string;
  type?: GroupingByIdKey;
};

// Header indices are metadata from the existing grouping API, not a second
// note list. Share one request across visible rows; a refreshed grouping gets
// its own entry and old instances can be collected.
const phoneGroupStarts = new WeakMap<
  VirtualizedGrouping<Item>,
  Promise<ReadonlySet<number> | undefined>
>();
function getPhoneGroupStarts(items: VirtualizedGrouping<Item>) {
  let pending = phoneGroupStarts.get(items);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => items.groups?.() || [])
      .then((groups) => new Set([0, ...groups.map((group) => group.index)]))
      .catch(() => undefined);
    phoneGroupStarts.set(items, pending);
  }
  return pending;
}

export function ListItemWrapper(props: ListItemWrapperProps) {
  const { items, group, isSheet, index, groupOptions } = props;
  const scrollViewOffset = props.scrollViewOffset ?? 0;
  // Catalyst may report either pad idiom: keep its explicit exclusion.
  const phoneNoteList =
    Platform.OS === "ios" &&
    !Platform.isPad &&
    !Platform.isMacCatalyst &&
    !isSheet &&
    props.dataType === "note";
  const [edges, setEdges] = useState<{
    items: VirtualizedGrouping<Item>;
    index: number;
    first: boolean;
    last: boolean;
  }>();
  useEffect(() => {
    if (!phoneNoteList || !items) return;
    let cancelled = false;
    void getPhoneGroupStarts(items).then((starts) => {
      if (!cancelled && starts)
        setEdges({
          items,
          index,
          first: starts.has(index),
          last: index === items.length - 1 || starts.has(index + 1)
        });
    });
    return () => {
      cancelled = true;
    };
  }, [phoneNoteList, items, index]);
  const groupEdges =
    phoneNoteList && edges && edges.items === items && edges.index === index
      ? { first: edges.first, last: edges.last }
      : undefined;
  const [item, setItem] = useState<Item>();
  const tags = useRef<TagsWithDateEdited>(undefined);
  const notebooks = useRef<NotebooksWithDateEdited>(undefined);
  const reminder = useRef<Reminder>(undefined);
  const color = useRef<Color>(undefined);
  const totalNotes = useRef<number>(0);
  const attachmentsCount = useRef(0);
  const [groupHeader, setGroupHeader] = useState<GroupHeader>();
  const previousIndex = useRef<number>(undefined);
  const previousItems = useRef(items);
  const refreshTimeout = useRef<NodeJS.Timeout>(undefined);
  const currentItemId = useRef<string>(undefined);
  const locked = useRef(false);
  const thumbnail = useRef<NoteThumbnailInfo>(undefined);
  const compactMode = useIsCompactModeEnabled(props.dataType as ItemType);

  const refreshItem = useCallback((resolvedItem: any) => {
    if (!resolvedItem || !resolvedItem.data) {
      tags.current = undefined;
      notebooks.current = undefined;
      reminder.current = undefined;
      color.current = undefined;
      attachmentsCount.current = 0;
      totalNotes.current = 0;
      locked.current = false;
      thumbnail.current = undefined;
    }

    if (resolvedItem && resolvedItem.item) {
      const data = resolvedItem.data;
      if (resolvedItem.item.type === "note" && isNoteResolvedData(data)) {
        tags.current = data.tags;
        notebooks.current = data.notebooks;
        reminder.current = data.reminder;
        color.current = data.color;
        attachmentsCount.current = data.attachments?.total || 0;
        locked.current = data.locked || false;
        // Keyed to the resolved item, so a recycled row never keeps the
        // previous note's image.
        thumbnail.current = data.thumbnail;
      } else if (
        resolvedItem.item.type === "note" &&
        !isNoteResolvedData(data)
      ) {
        tags.current = undefined;
        notebooks.current = undefined;
        reminder.current = undefined;
        color.current = undefined;
        attachmentsCount.current = 0;
        totalNotes.current = 0;
        locked.current = false;
        thumbnail.current = undefined;
      } else if (
        resolvedItem.item.type === "notebook" &&
        typeof data === "number"
      ) {
        totalNotes.current = data;
      } else if (resolvedItem.item.type === "tag" && typeof data === "number") {
        totalNotes.current = data;
      }
      currentItemId.current = resolvedItem.item.id;
      setItem(resolvedItem.item);
    }

    if (resolvedItem?.group) {
      setGroupHeader(resolvedItem.group);
    } else {
      setGroupHeader(undefined);
    }
  }, []);

  if (
    previousIndex.current !== index ||
    (phoneNoteList && previousItems.current !== items)
  ) {
    previousIndex.current = index;
    previousItems.current = items;
    const resolvedItem = items?.cacheItem(index);
    if (resolvedItem) {
      refreshItem(resolvedItem);
    } else {
      setItem(undefined);
      setGroupHeader(undefined);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async function () {
      try {
        clearTimeout(refreshTimeout.current);
        const idx = index;
        refreshTimeout.current = setTimeout(
          async () => {
            if ((phoneNoteList && cancelled) || idx !== previousIndex.current)
              return;
            const resolvedItem = await items?.item(idx, resolveItems);
            if ((phoneNoteList && cancelled) || idx !== previousIndex.current)
              return;
            refreshItem(resolvedItem);
          },
          items?.cacheItem(index) ? 100 : 0
        );
      } catch (e) {
        /** empty */
      }
    })();
    return () => {
      cancelled = true;
      if (phoneNoteList) clearTimeout(refreshTimeout.current);
    };
  }, [index, items, refreshItem, phoneNoteList]);

  if (!item)
    return (
      <View
        style={{
          height: compactMode ? 50 : 120,
          width: "100%"
        }}
      />
    );

  const type = ((item as TrashItem).itemType || item.type) as ItemType;
  switch (type) {
    case "note": {
      return (
        <>
          {groupHeader && previousIndex.current === index && !isSheet ? (
            <SectionHeader
              screen={props.renderedInRoute}
              item={groupHeader}
              index={index}
              dataType={item.type}
              group={group}
              groupId={props.groupId}
              type={props.type}
              color={props.customAccentColor}
              groupOptions={groupOptions}
              onOpenJumpToDialog={() => {
                eSendEvent(eOpenJumpToDialog, {
                  ref: props.scrollRef,
                  data: items,
                  viewOffset: scrollViewOffset
                });
              }}
            />
          ) : null}

          <NoteWrapper
            item={item as Note}
            tags={tags.current}
            color={color.current}
            notebooks={notebooks.current}
            reminder={reminder.current}
            attachmentsCount={attachmentsCount.current}
            date={getDate(item as Note, group)}
            isRenderedInActionSheet={isSheet}
            index={index}
            locked={locked.current}
            renderedInRoute={props.renderedInRoute}
            origin={props.origin}
            thumbnail={thumbnail.current}
            groupEdges={item.type === "note" ? groupEdges : undefined}
          />
        </>
      );
    }
    case "notebook":
      return (
        <>
          {groupHeader && previousIndex.current === index && !isSheet ? (
            <SectionHeader
              screen={props.renderedInRoute}
              item={groupHeader}
              index={index}
              dataType={item.type}
              group={group}
              groupId={props.groupId}
              type={props.type}
              color={props.customAccentColor}
              groupOptions={groupOptions}
              onOpenJumpToDialog={() => {
                eSendEvent(eOpenJumpToDialog, {
                  ref: props.scrollRef,
                  data: items,
                  viewOffset: scrollViewOffset
                });
              }}
            />
          ) : null}
          <NotebookWrapper
            item={item as Notebook}
            totalNotes={totalNotes.current}
            date={getDate(item as Notebook, group)}
            index={index}
          />
        </>
      );

    case "reminder":
      return (
        <>
          {groupHeader && previousIndex.current === index && !isSheet ? (
            <SectionHeader
              screen={props.renderedInRoute}
              item={groupHeader}
              index={index}
              group={group}
              dataType={item.type}
              color={props.customAccentColor}
              type={props.type}
              groupId={props.groupId}
              groupOptions={groupOptions}
              onOpenJumpToDialog={() => {
                eSendEvent(eOpenJumpToDialog, {
                  ref: props.scrollRef,
                  data: items,
                  viewOffset: scrollViewOffset
                });
              }}
            />
          ) : null}
          <ReminderItem
            item={item as Reminder}
            index={index}
            isSheet={isSheet}
          />
        </>
      );
    case "tag":
      return (
        <>
          {groupHeader && previousIndex.current === index && !isSheet ? (
            <SectionHeader
              screen={props.renderedInRoute}
              item={groupHeader}
              index={index}
              group={group}
              dataType={item.type}
              groupId={props.groupId}
              type={props.type}
              color={props.customAccentColor}
              groupOptions={groupOptions}
              onOpenJumpToDialog={() => {
                eSendEvent(eOpenJumpToDialog, {
                  ref: props.scrollRef,
                  data: items,
                  viewOffset: scrollViewOffset
                });
              }}
            />
          ) : null}
          <TagItem
            item={item as Tag}
            index={index}
            totalNotes={totalNotes.current}
          />
        </>
      );
    case "searchResult":
      return (
        <>
          {groupHeader && previousIndex.current === index && !isSheet ? (
            <SectionHeader
              screen={props.renderedInRoute}
              item={groupHeader}
              index={index}
              group={group}
              dataType={item.type}
              groupId={props.groupId}
              type={props.type}
              color={props.customAccentColor}
              groupOptions={groupOptions}
              itemCount={items?.placeholders.length}
              onOpenJumpToDialog={() => {
                eSendEvent(eOpenJumpToDialog, {
                  ref: props.scrollRef,
                  data: items,
                  viewOffset: scrollViewOffset
                });
              }}
            />
          ) : null}
          <SearchResult item={item as HighlightedResult} />
        </>
      );
    default:
      return null;
  }
}

function getDate(
  item: Notebook | Note,
  groupType?: GroupingKey,
  id?: string,
  type?: GroupingByIdKey
): number {
  return (
    getSortValue(
      groupType
        ? getGroupOptions(groupType, id, type)
        : {
            sortBy: "dateEdited",
            sortDirection: "desc"
          },
      item
    ) || 0
  );
}
