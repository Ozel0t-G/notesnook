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
  GroupingByIdKey,
  GroupingKey,
  Item,
  VirtualizedGrouping
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import { LegendList, LegendListRenderItemProps } from "@legendapp/list";
import React, { useEffect, useRef } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  RefreshControl,
  View
} from "react-native";
import { notesnook } from "../../../e2e/test.ids";
import { showListOptions } from "../../hooks/use-mac-menu-commands";
import { useGroupOptions } from "../../hooks/use-group-options";
import {
  openEditor,
  setOnFirstSaveUnassigned
} from "../../screens/notes/common";
import { eSendEvent } from "../../services/event-manager";
import Sync from "../../services/sync";
import { RouteName } from "../../stores/use-navigation-store";
import { useSettingStore } from "../../stores/use-setting-store";
import { isMacCatalyst } from "../../utils/constants";
import { useMacListFocusStore } from "../../stores/use-mac-list-focus-store";
import { eScrollEvent } from "../../utils/events";
import { fluidTabsRef } from "../../utils/global-refs";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { Header } from "../list-items/headers/header";
import { ContextMenu, NativeMenuItem } from "../native-menu";
import { Empty, PlaceholderData } from "./empty";
import { ListItemWrapper } from "./list-item.wrapper";
import { ScrollView } from "react-native-actions-sheet";

type ListProps = {
  data: VirtualizedGrouping<Item> | undefined;
  dataType: Item["type"];
  mode?: "drawer" | "sheet";
  onRefresh?: () => void;
  loading?: boolean;
  headerTitle?: string;
  customAccentColor?: string;
  renderedInRoute?: RouteName;
  CustomLisHeader?: React.JSX.Element;
  isRenderedInActionSheet?: boolean;
  CustomListComponent?: React.JSX.ElementType;
  placeholder?: PlaceholderData;
  groupType: GroupingKey;
  id?: string;
  type?: GroupingByIdKey;
};

const onMomentumScrollEnd = () => {
  fluidTabsRef.current?.unlock();
};

export default function List(props: ListProps) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const scrollRef = useRef(null);
  const [notesListMode, notebooksListMode] = useSettingStore((state) => [
    state.settings.notesListMode,
    state.settings.notebooksListMode
  ]);
  const isTabletPane = useSettingStore(
    (state) => state.deviceMode === "tablet"
  );

  const isCompactModeEnabled =
    (props.dataType === "note" && notesListMode === "compact") ||
    props.dataType === "notebook" ||
    notebooksListMode === "compact";

  const groupOptions = useGroupOptions(props.groupType, props.id, props.type);

  const _onRefresh = async () => {
    Sync.run("global", false, "full", () => {
      props.onRefresh?.();
    });
  };

  const getItemType = React.useCallback(
    (item: number | boolean, index: number) => {
      return props.data?.type(index);
    },
    [props.data]
  );

  const renderItem = React.useCallback(
    (itemProps: LegendListRenderItemProps<any, any>) => {
      return (
        <ListItemWrapper
          index={itemProps.index}
          isSheet={props.isRenderedInActionSheet || false}
          items={props.data}
          groupId={props.id}
          groupOptions={groupOptions}
          group={props.groupType as GroupingKey}
          renderedInRoute={props.renderedInRoute}
          customAccentColor={props.customAccentColor}
          dataType={props.dataType}
          type={props.type}
          scrollRef={scrollRef}
        />
      );
    },
    [
      props.isRenderedInActionSheet,
      props.data,
      props.id,
      props.groupType,
      props.renderedInRoute,
      props.customAccentColor,
      props.dataType,
      groupOptions,
      props.type
    ]
  );

  const onListScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!event) return;
      eSendEvent(eScrollEvent, {
        y: event.nativeEvent.contentOffset.y,
        route: props.renderedInRoute,
        id: props.id || props.renderedInRoute
      });
    },
    [props.renderedInRoute, props.id]
  );

  // Mac keyboard navigation (WP07/N3): the focused note list publishes its data
  // so Up/Down/Return can move through it (hooks/use-mac-menu-commands.ts).
  useEffect(() => {
    if (
      !isMacCatalyst() ||
      props.dataType !== "note" ||
      props.isRenderedInActionSheet ||
      !props.renderedInRoute
    )
      return;
    const route = String(props.renderedInRoute);
    useMacListFocusStore.getState().setList(route, props.data);
    return () => useMacListFocusStore.getState().setList(route, undefined);
  }, [
    props.data,
    props.dataType,
    props.isRenderedInActionSheet,
    props.renderedInRoute
  ]);

  useEffect(() => {
    eSendEvent(eScrollEvent, {
      y: 0,
      route: props.renderedInRoute,
      id: props.id || props.renderedInRoute
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * C9: on Mac Catalyst the note list's empty area carries a right-click menu
   * with "New Note" (the compose / Cmd-N action) and "Sort By…" (the list's own
   * options, published by its header - hooks/use-mac-menu-commands.ts
   * showListOptions). Sheets keep their iOS behavior.
   */
  const macEmptyMenuItems: NativeMenuItem[] = [
    {
      id: "new-note",
      title: strings.newNoteTab(),
      symbol: "square.and.pencil"
    },
    {
      id: "list-options",
      title: strings.listSortBy(),
      symbol: "arrow.up.arrow.down"
    }
  ];
  const onMacEmptyMenuSelect = (id: string) => {
    if (id === "new-note") {
      setOnFirstSaveUnassigned();
      openEditor();
    } else if (id === "list-options") {
      showListOptions();
    }
  };
  const showMacEmptyMenu =
    isMacCatalyst() &&
    !props.isRenderedInActionSheet &&
    props.dataType === "note";
  const emptyComponent = (
    <View
      style={{
        flex: 1
      }}
    >
      <Empty
        loading={props.loading}
        title={props.headerTitle}
        dataType={props.dataType}
        color={props.customAccentColor}
        placeholder={props.placeholder}
        screen={props.renderedInRoute}
      />
    </View>
  );

  return (
    <>
      <View
        style={{
          flex: 1,
          backgroundColor:
            visual.ios && isTabletPane
              ? visual.contentSurface
              : visual.screenBackground
        }}
      >
        <LegendList
          ref={scrollRef}
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: visual.ios ? visual.sectionSpacing : 4,
            paddingBottom: visual.ios ? visual.sectionSpacing : 8
          }}
          extraData={props.data}
          testID={notesnook.list.id}
          data={props.data?.placeholders || []}
          renderScrollComponent={
            props.isRenderedInActionSheet
              ? (props) => <ScrollView {...props} />
              : undefined
          }
          renderItem={renderItem}
          onScroll={onListScroll}
          nestedScrollEnabled={true}
          onMomentumScrollEnd={onMomentumScrollEnd}
          getItemType={getItemType}
          estimatedItemSize={isCompactModeEnabled ? 60 : 120}
          directionalLockEnabled={true}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="interactive"
          ListEmptyComponent={
            showMacEmptyMenu ? (
              <ContextMenu
                items={macEmptyMenuItems}
                onSelect={onMacEmptyMenuSelect}
                style={{ flex: 1 }}
              >
                {emptyComponent}
              </ContextMenu>
            ) : (
              emptyComponent
            )
          }
          ListFooterComponent={
            <View
              style={{ height: props.data?.placeholders?.length ? 100 : 0 }}
            />
          }
          refreshControl={
            props.isRenderedInActionSheet ? (
              <></>
            ) : (
              <RefreshControl
                tintColor={colors.primary.accent}
                colors={[colors.primary.accent]}
                progressBackgroundColor={colors.secondary.background}
                onRefresh={_onRefresh}
                refreshing={false}
              />
            )
          }
          ListHeaderComponent={
            <>
              {props.CustomLisHeader ? (
                props.CustomLisHeader
              ) : !props.headerTitle ? null : (
                <Header
                  color={props.customAccentColor}
                  screen={props.renderedInRoute}
                />
              )}
            </>
          }
        />
      </View>
    </>
  );
}
