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
import dayjs from "dayjs";
import React from "react";
import { FlatList, Platform, View } from "react-native";
import { DraxProvider, DraxScrollView } from "react-native-drax";
import { db } from "../../common/database";
import Navigation from "../../services/navigation";
import useNavigationStore from "../../stores/use-navigation-store";
import { useMenuStore } from "../../stores/use-menu-store";
import { useSettingStore } from "../../stores/use-setting-store";
import { MenuItemsList, SideMenuItem } from "../../utils/menu-items";
import { DefaultAppStyles } from "../../utils/styles";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { useIPadWorkspace } from "../ipad-workspace-context";
import {
  IPAD_ALL_NOTES_MENU_ITEM_ID,
  IPAD_ALL_NOTES_ROUTE_ID,
  IPAD_INBOX_MENU_ITEM_ID,
  IPAD_INBOX_ROUTE_ID,
  resolveIPadSideMenuItem
} from "../../utils/ipad-layout";
import ReorderableList from "../list/reorderable-list";
import { MenuItemProperties } from "../sheets/menu-item-properties";
import { Button } from "../ui/button";
import { ColorSection } from "./color-section";
import { MenuItem } from "./menu-item";
import { PinnedSection } from "./pinned-section";
import {
  IPadSourceFrame,
  IPadSourceRowMeasurement,
  IPadSourceSection,
  isIPadSourceList
} from "./ipad-source-navigation";
import { useSideBarDraggingStore } from "./dragging-store";
import { SideMenuHeader } from "./side-menu-header";

export function SideMenuHome({
  showHeader = true,
  embedded = false,
  sourceLocked = false
}: { showHeader?: boolean; embedded?: boolean; sourceLocked?: boolean } = {}) {
  const [showMore, setShowMore] = React.useState(false);
  const dragging = useSideBarDraggingStore((state) => state.dragging);
  const compactSources = embedded && isIPadSourceList();
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const [isAppLoading, introCompleted] = useSettingStore((state) => [
    state.isAppLoading,
    state.settings.introCompleted
  ]);
  const [order, hiddensItems, colorNotes, menuPins, hiddenColors] =
    useMenuStore(
      (state) =>
        [
          state.order["routes"],
          state.hiddenItems["routes"],
          state.colorNotes,
          state.menuPins,
          state.hiddenItems["colors"]
        ] as const
    );
  const [rowHeights, setRowHeights] = React.useState<Record<string, number>>(
    {}
  );
  const measureRow = React.useCallback((id: string, height: number) => {
    if (!Number.isFinite(height) || height < 44) return;
    setRowHeights((previous) =>
      Math.abs((previous[id] || 0) - height) < 0.5
        ? previous
        : { ...previous, [id]: height }
    );
  }, []);
  const ipad = useIPadWorkspace();

  /**
   * The iPad sidebar's rows.
   *
   * In the iPad workspace the source list *is* the list column's switcher, so
   * its note-list row opens the All Notes collection directly on the Library
   * route (`initialCollection: "all-notes"`) instead of the legacy `Notes`
   * route, which on iOS only redirects itself to exactly that - a duplicate
   * route that never draws anything. The Inbox collection, which the note list
   * header and the Library's own source list offer, gets its own direct row
   * under it.
   *
   * The shared `MenuItemsList` is never mutated: its rows keep their ids (the
   * order, hidden state and counts are all stored under them) and every row
   * other than the note list is passed through untouched by reference, so the
   * saved order and hidden rows keep working exactly as before. Anything other
   * than the iPad workspace - iPhone and Android drawers - keeps the untouched
   * list.
   */
  const menuItems = React.useMemo<
    (SideMenuItem & { focusedId?: string })[]
  >(() => {
    if (!ipad) return MenuItemsList;
    const openCollection = (initialCollection: "all-notes" | "inbox") => () => {
      // The collection's own mount effect only publishes its focused route id
      // when it mounts. A retained Library/NoteCollection (it can stay mounted
      // behind the Notebook screen) re-opened with the same `initialCollection`
      // never re-runs that effect, so this row has to state the selection
      // itself or the sidebar keeps highlighting the previous collection.
      useNavigationStore
        .getState()
        .setFocusedRouteId(
          initialCollection === "inbox"
            ? IPAD_INBOX_ROUTE_ID
            : IPAD_ALL_NOTES_ROUTE_ID
        );
      Navigation.closeDrawer();
      Navigation.navigate("Library", { initialCollection });
    };
    const allNotesLabel = strings.routes.AllNotes();
    const items: (SideMenuItem & { focusedId?: string })[] = MenuItemsList.map(
      (item) => {
        const resolved = resolveIPadSideMenuItem(item, allNotesLabel);
        if (resolved.id !== IPAD_ALL_NOTES_MENU_ITEM_ID) return resolved;
        return { ...resolved, onPress: openCollection("all-notes") };
      }
    );
    const notesIndex = items.findIndex(
      (item) => item.id === IPAD_ALL_NOTES_MENU_ITEM_ID
    );
    items.splice(notesIndex + 1, 0, {
      id: IPAD_INBOX_MENU_ITEM_ID,
      title: strings.routes.Inbox(),
      icon: "email-outline",
      type: "side-menu-item",
      focusedId: IPAD_INBOX_ROUTE_ID,
      onPress: openCollection("inbox")
    });
    return items;
  }, [ipad]);

  const sourceRows =
    compactSources && !showMore && !dragging
      ? menuItems.filter(
          (item) =>
            item.id === IPAD_ALL_NOTES_MENU_ITEM_ID ||
            item.id === IPAD_INBOX_MENU_ITEM_ID
        )
      : menuItems;
  // Drax's flex container needs a definite parent inside a LegendList header.
  // Start from the touch minimum and grow to real row measurements (including DT).
  const measuredHeight = (ids: string[], hidden: string[] = []) =>
    ids
      .filter((id) => dragging || !hidden.includes(id))
      .reduce((height, id) => height + Math.max(44, rowHeights[id] || 44), 0);
  const sourceHeight = measuredHeight(
    sourceRows.map((item) => item.id),
    hiddensItems
  );
  const colorHeight = measuredHeight(
    (colorNotes || []).map((item) => item.id),
    hiddenColors
  );
  const pinCount = (menuPins || []).length;
  const pinHeight =
    measuredHeight((menuPins || []).map((item) => item.id)) +
    (pinCount ? DefaultAppStyles.GAP_SMALL * 2 + 1 : 0);

  const renderContent = () => (
    <>
      <IPadSourceFrame
        enabled={compactSources}
        testID="ipad-source-routes-frame"
        height={sourceHeight}
      >
        <ReorderableList
          onListOrderChanged={(data) => {
            db.settings.setSideBarOrder("routes", data);
          }}
          onHiddenItemsChanged={(data) => {
            db.settings.setSideBarHiddenItems("routes", data);
          }}
          itemOrder={order}
          hiddenItems={hiddensItems}
          alwaysBounceVertical={false}
          data={sourceRows}
          style={{
            width: "100%"
          }}
          scrollEnabled={!embedded}
          disableDefaultDrag
          showsVerticalScrollIndicator={false}
          renderDraggableItem={({ item, index }) => {
            return (
              <MenuItem
                key={item.title}
                item={{
                  ...item,
                  title:
                    item.id === "Tasks"
                      ? strings.tasksTitle()
                      : strings.routes[
                          item.title as keyof typeof strings.routes
                        ]?.() || item.title,
                  onLongPress: () => {
                    MenuItemProperties.present(item);
                  }
                }}
                testID={item.title}
                index={index}
              />
            );
          }}
        />
      </IPadSourceFrame>
      {compactSources ? (
        <IPadSourceSection
          title={strings.more()}
          disabled={dragging || sourceLocked}
          expanded={showMore || dragging}
          onPress={() => setShowMore((value) => !value)}
          testID="ipad-source-more"
        />
      ) : null}
      <IPadSourceFrame
        enabled={compactSources}
        testID="ipad-source-colors-frame"
        height={colorHeight}
      >
        <ColorSection />
      </IPadSourceFrame>
      <IPadSourceFrame
        enabled={compactSources}
        testID="ipad-source-pins-frame"
        height={pinHeight}
      >
        <PinnedSection />
      </IPadSourceFrame>
    </>
  );

  return (
    <View
      style={{
        height: embedded ? undefined : "100%",
        width: "100%",
        backgroundColor: visual.sidebarBackground,
        gap: showHeader
          ? visual.ios
            ? visual.sectionSpacing
            : DefaultAppStyles.GAP
          : 0,
        paddingTop: !showHeader
          ? 0
          : visual.ios
          ? visual.pagePadding
          : DefaultAppStyles.GAP_VERTICAL
      }}
    >
      {showHeader ? <SideMenuHeader /> : null}

      {!isAppLoading && introCompleted ? (
        <DraxProvider>
          {embedded ? (
            <IPadSourceRowMeasurement.Provider value={measureRow}>
              <View style={{ paddingHorizontal: DefaultAppStyles.GAP }}>
                {renderContent()}
              </View>
            </IPadSourceRowMeasurement.Provider>
          ) : (
            <FlatList
              renderScrollComponent={(props) => <DraxScrollView {...props} />}
              data={[0]}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              keyExtractor={() => "scroll-items"}
              bounces={false}
              renderItem={renderContent}
              style={{
                paddingHorizontal: DefaultAppStyles.GAP
              }}
              nestedScrollEnabled={false}
            />
          )}
        </DraxProvider>
      ) : null}

      {Platform.OS === "ios" ? null : (
        <View
          style={{
            paddingHorizontal: DefaultAppStyles.GAP,
            paddingVertical: DefaultAppStyles.GAP_VERTICAL
          }}
        >
          {dayjs().month() === 11 ? (
            <Button
              title={`Wrapped ${dayjs().year()} 🎉`}
              style={{
                width: "100%"
              }}
              bold
              type="secondaryAccented"
              onPress={() => {
                Navigation.navigate("Wrapped");
              }}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}
