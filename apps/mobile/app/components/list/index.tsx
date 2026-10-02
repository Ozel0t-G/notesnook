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
import useGlobalSafeAreaInsets from "../../hooks/use-global-safe-area-insets";
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
import { MAC_TOOLBAR_HEIGHT, macToolbarInset } from "../../utils/mac-layout";
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
  const insets = useGlobalSafeAreaInsets();
  /**
   * Mac's list column (not a sheet): the list fills the column from the
   * window's top edge and pads its own scroll content by the toolbar inset, so
   * it clears the borderless toolbar at rest but still scrolls under it (the
   * column's fade overlay - see navigation/fluid-panels-view.tsx - dissolves
   * whatever reaches the top).
   */
  const isMacListColumn = isMacCatalyst() && !props.isRenderedInActionSheet;
  /**
   * The toolbar inset is floored at the known toolbar height: `macToolbarInset`
   * caches the first real measurement it sees, and a not-yet-measured safe area
   * must never leave the first row under the toolbar. The 8 pt on top is the
   * gap between the toolbar and the list's first row (the date header). Read
   * only for the Mac list column: a sheet has its own (smaller) safe area and
   * must not be the call that `macToolbarInset` caches.
   */
  const macListTopInset = isMacListColumn
    ? Math.max(macToolbarInset(insets.top), MAC_TOOLBAR_HEIGHT) + 8
    : 0;
  /**
   * Mac's list column only: UIKit's automatic content-inset adjustment adds the
   * toolbar's safe-area top as `contentInset.top` on top of our `paddingTop`
   * while the initial content offset still starts at 0, so the column opens
   * ~a toolbar-height scrolled down with the first row clipped under the
   * toolbar until the user scrolls up. Turning the adjustment off leaves
   * `macListTopInset` (the `paddingTop` above) as the only top inset.
   *
   * LegendList spreads the remaining ScrollView props onto its underlying
   * Animated.ScrollView (only `contentOffset`, `contentInset`,
   * `maintainVisibleContentPosition`, `stickyHeaderIndices`,
   * `removeClippedSubviews`, `children` and `onScroll` are stripped), so both
   * props reach it. On iOS 11+ `contentInsetAdjustmentBehavior="never"` is the
   * one that takes effect - it is honored on both the old and Fabric
   * architectures; `automaticallyAdjustContentInsets={false}` is the deprecated
   * equivalent (Fabric drops it) kept for the old-architecture fallback. This
   * must stay a no-op for iPhone/iPad and sheets, which keep the platform
   * default.
   */
  const macListScrollInsetProps = isMacListColumn
    ? {
        contentInsetAdjustmentBehavior: "never" as const,
        automaticallyAdjustContentInsets: false
      }
    : {};
  const scrollRef = useRef(null);
  /**
   * Mac's list column only: the toolbar inset is painted by the scroll content
   * (`contentContainerStyle.paddingTop` above), so the launch content offset
   * must stay at 0 for the first row to open below the toolbar. LegendList
   * aligns its first row to the top of the scroll view on the first data pass
   * - the equivalent of `scrollToIndex(0, { viewPosition: 0 })` with no
   * `viewOffset` - which eats exactly that `paddingTop` and leaves the first
   * row (the open note at launch) clipped under the toolbar until the user
   * scrolls up. The two corrections below put that offset back to 0; they never
   * go below 0 (the inset is painted by `paddingTop`, not by a negative offset),
   * only run in a short window around the first data pass, and stop for good as
   * soon as the user scrolls. iPhone/iPad and sheets never run them.
   */
  const macListUserScrolled = useRef(false);
  const macListLaunchUntil = useRef(0);
  const macListCorrectionAttempts = useRef(0);
  const snapMacListToTop = React.useCallback(() => {
    if (!isMacListColumn || macListUserScrolled.current) return;
    const list = scrollRef.current as unknown as {
      scrollToOffset?: (options: {
        offset: number;
        animated?: boolean;
      }) => void;
    } | null;
    if (!list?.scrollToOffset) return;
    // The inset is painted by `paddingTop`, so the correct launch position is
    // exactly the top - never a negative offset.
    list.scrollToOffset({ offset: 0, animated: false });
  }, [isMacListColumn]);
  const correctMacListLaunchScroll = React.useCallback(
    (y: number) => {
      if (!isMacListColumn || macListUserScrolled.current) return;
      // Only during the launch window around the first data pass.
      if (Date.now() > macListLaunchUntil.current) return;
      if (y > macListTopInset + 1) {
        // Past the top inset: a real scroll (user or "jump to section"), so the
        // list belongs to the user from here on.
        macListUserScrolled.current = true;
        return;
      }
      // Only the launch artifact (offset == the top inset) is corrected; the
      // initial 0 and any overscroll are already correct.
      if (y <= 0) return;
      // A few tries cover the list re-asserting its alignment while it lays out.
      if (macListCorrectionAttempts.current >= 5) return;
      macListCorrectionAttempts.current += 1;
      snapMacListToTop();
    },
    [isMacListColumn, macListTopInset, snapMacListToTop]
  );
  const onListScrollBeginDrag = React.useCallback(() => {
    macListUserScrolled.current = true;
  }, []);
  /**
   * Open the launch window when the list gets its rows and also snap once after
   * layout: LegendList emits no `onScroll` while the loading list is too short
   * to move, so the offset its first data pass leaves behind would otherwise
   * survive until the first user scroll. After the user has scrolled the window
   * never re-opens.
   */
  useEffect(() => {
    if (!isMacListColumn || macListUserScrolled.current) return;
    macListLaunchUntil.current = Date.now() + 1200;
    const timer = setTimeout(snapMacListToTop, 400);
    return () => clearTimeout(timer);
    // `props.data` only re-arms the window when the rows finally arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMacListColumn, props.data, snapMacListToTop]);
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
          // Mac's "jump to section" (the date header) scrolls the list, so it
          // has to clear the same top inset the rows do: the group header is
          // aligned below the toolbar instead of under it. 0 everywhere else,
          // so iPhone/iPad keep their existing jump position.
          scrollViewOffset={macListTopInset}
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
      props.type,
      macListTopInset
    ]
  );

  const onListScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!event) return;
      correctMacListLaunchScroll(event.nativeEvent.contentOffset.y);
      eSendEvent(eScrollEvent, {
        y: event.nativeEvent.contentOffset.y,
        route: props.renderedInRoute,
        id: props.id || props.renderedInRoute
      });
    },
    [props.renderedInRoute, props.id, correctMacListLaunchScroll]
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
          // Mac's note list column is the theme's primary background, the same
          // colour as the editor and the rest of the window (macOS 26 Notes).
          backgroundColor: isMacListColumn
            ? colors.primary.background
            : visual.ios && isTabletPane
            ? visual.contentSurface
            : visual.screenBackground
        }}
      >
        <LegendList
          ref={scrollRef}
          contentContainerStyle={{
            flexGrow: 1,
            // Mac: the toolbar inset lives inside the scroll view (the column
            // itself no longer reserves a band - see `isMacListColumn`), so the
            // first row - the date header with the sort/view buttons - starts
            // below the toolbar but scrolled rows can pass under it and fade
            // out.
            paddingTop: isMacListColumn
              ? macListTopInset
              : visual.ios
              ? visual.sectionSpacing
              : 4,
            paddingBottom: visual.ios ? visual.sectionSpacing : 8
          }}
          {...macListScrollInsetProps}
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
          // Any user scroll disarms the launch correction above.
          onScrollBeginDrag={onListScrollBeginDrag}
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
