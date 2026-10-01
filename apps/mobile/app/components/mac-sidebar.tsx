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
import React from "react";
import { NativeModules, Pressable, ScrollView, Text, View } from "react-native";
import { Item } from "@notesnook/core";
import { TaskSymbolView } from "./task-symbol-view";
import { IosBarButton } from "./ios-nav-bar";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { useLibrarySourceList } from "../hooks/use-library-source-list";
import { openMacList } from "../services/mac-list-navigation";
import useNavigationStore from "../stores/use-navigation-store";
import { useMacSystemStore } from "../stores/use-mac-system-store";
import {
  AppleSection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";
import { macAccent, macSelectionFill } from "../utils/mac-system-state";
import { AddNotebookSheet } from "./sheets/add-notebook";
import useGlobalSafeAreaInsets from "../hooks/use-global-safe-area-insets";
import { MAC_SOURCE_LIST_INSET, macToolbarInset } from "../utils/mac-layout";
import { ItemContextMenu } from "./item-actions-menu";
import { MacHoverHighlight, useMacHover } from "./mac-hover";
import { selectAppleSection } from "../navigation/navigation-stack";
import { MacSidebarAccountFooter } from "./mac-sidebar-account-footer";
import { isMacCatalyst } from "../utils/constants";

type LibraryDestination = {
  key: string;
  label: string;
  symbol: string;
  count?: number;
  onPress: () => void;
  /**
   * The notebook/tag a row stands for. Rows backed by an item get the same
   * right-click menu as their equivalents in the note list (see
   * components/item-actions-menu.tsx); the plain Library destinations (All
   * Notes, Inbox, Favorites, ...) have no item to act on.
   */
  item?: Item;
};

/**
 * Mac source list: the `focusedRouteId` that marks each destination as the one
 * on screen. Notebook and tag rows compare their own id instead, since they go
 * through the shared Notes screen and set the id they were opened with.
 */
const MAC_SELECTED_ROUTE_ID: Record<string, string> = {
  "all-notes": "AllNotes",
  inbox: "Inbox",
  favorites: "Favorites",
  monographs: "monograph",
  archive: "Archive",
  trash: "Trash"
};

/**
 * Mac source list metrics (see `mac-layout.ts` for the window chrome and for
 * `MAC_SOURCE_LIST_INSET`, the 10 pt margin the rows sit in).
 */
const MAC_ROW_HEIGHT = 28;
/** Style of the pane's own heading row (was IosNavBar's 13 pt leading label). */
const MAC_HEADING_FONT_SIZE = 13;
const MAC_ROW_RADIUS = 6;
const MAC_ROW_FONT_SIZE = 13;
const MAC_ROW_ICON_SIZE = 16;
/** Inner padding of a row: the icon/text inset inside the highlight. */
const MAC_ROW_PADDING = 8;
/** Text of a row/section header, measured from the column's edge. */
const MAC_LIST_TEXT_LEFT = MAC_SOURCE_LIST_INSET + MAC_ROW_PADDING;

const presentNewNotebook = () =>
  AddNotebookSheet.present(undefined, undefined, "global", undefined, false);

/**
 * Mac's sidebar pane: a persistent source list (Library, in Notes' terms) at
 * the left edge of the window. It is the Library screen's source-list rendering
 * lifted out of the navigation stack, so iPhone/iPad keep the card-style list of
 * screens/library and Mac gets the 28 pt source rows.
 *
 * Selecting a row opens that list in the middle column through
 * `openMacList` (services/mac-list-navigation.ts), which drives the note-list
 * stack the same way the Library rows used to; the selected row follows
 * `focusedRouteId`, so it stays in sync with navigation started anywhere else
 * (a link, a search result, the editor's "go to notebook", ...).
 */
export function MacSidebar() {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const insets = useGlobalSafeAreaInsets();
  const { notebooks, tags, counts } = useLibrarySourceList();
  const focusedRouteId = useNavigationStore((state) => state.focusedRouteId);
  const section = useAppleNavigationStore((state) => state.section);

  /**
   * The window toolbar has no segmented control any more, so the three sections
   * it used to switch are rows at the top of the source list now. Switching
   * goes through the same handler the iPad tab bar and the toolbar's
   * `section:<name>` commands use, and the selected section is also pushed to
   * the native toolbar, which still tracks it for its own state.
   */
  const selectSection = (next: AppleSection) => {
    NativeModules.VeyraNMacMenu?.setSelectedSection(next);
    selectAppleSection(next);
  };

  const sectionRows: LibraryDestination[] = [
    {
      key: "section:library",
      label: strings.routes.Library(),
      symbol: "books.vertical",
      onPress: () => selectSection("library")
    },
    {
      key: "section:tasks",
      // Same label as the iPad tab bar's Tasks item.
      label: strings.tasksTitle(),
      symbol: "checklist",
      onPress: () => selectSection("tasks")
    },
    {
      key: "section:search",
      label: strings.routes.Search(),
      symbol: "magnifyingglass",
      onPress: () => selectSection("search")
    }
  ];

  // Tasks and Search are sections of their own (the native toolbar switches to
  // them): the sidebar stays mounted, but no Library row is the current one.
  const isCurrentDestination = React.useCallback(
    (key: string) => {
      if (section !== "library") return false;
      if (key.startsWith("notebook:"))
        return focusedRouteId === key.slice("notebook:".length);
      if (key.startsWith("tag:"))
        return focusedRouteId === key.slice("tag:".length);
      return focusedRouteId === MAC_SELECTED_ROUTE_ID[key];
    },
    [focusedRouteId, section]
  );

  const collections: LibraryDestination[] = [
    {
      key: "all-notes",
      label: strings.routes.AllNotes(),
      symbol: "note.text",
      count: counts.allNotes,
      onPress: () =>
        openMacList("Library", { initialCollection: "all-notes" }, "AllNotes")
    },
    {
      key: "inbox",
      label: strings.routes.Inbox(),
      symbol: "tray",
      count: counts.inbox,
      onPress: () =>
        openMacList("Library", { initialCollection: "inbox" }, "Inbox")
    }
  ];

  const destinations: LibraryDestination[] = [
    {
      key: "favorites",
      label: strings.routes.Favorites(),
      symbol: "star",
      onPress: () => openMacList("Favorites", {}, "Favorites")
    },
    {
      key: "monographs",
      label: strings.routes.Monographs(),
      symbol: "globe",
      onPress: () =>
        openMacList(
          "Monographs",
          { type: "monograph", id: "monograph", canGoBack: true },
          "monograph"
        )
    },
    {
      key: "archive",
      label: strings.routes.Archive(),
      symbol: "archivebox",
      onPress: () => openMacList("Archive", {}, "Archive")
    },
    {
      key: "trash",
      label: strings.routes.Trash(),
      symbol: "trash",
      onPress: () => openMacList("Trash", {}, "Trash")
    }
  ];

  /**
   * Section header ("Notebooks", "Tags"): a plain 11 pt label in the secondary
   * color, like a source list's section header.
   */
  const sectionTitle = (title: string, onAdd?: () => void) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginTop: 14,
        marginBottom: 2,
        marginLeft: MAC_LIST_TEXT_LEFT,
        marginRight: MAC_LIST_TEXT_LEFT
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          flex: 1,
          color: visual.secondaryText,
          fontSize: 11,
          fontWeight: "600"
        }}
      >
        {title}
      </Text>
      {onAdd ? (
        <IosBarButton
          symbol="plus"
          accessibilityLabel={strings.newNotebookRow()}
          testID="library-new-notebook"
          iconSize={16}
          onPress={onAdd}
        />
      ) : null}
    </View>
  );

  const notebookRows: LibraryDestination[] = notebooks.map((item) => ({
    key: `notebook:${item.id}`,
    label: item.title,
    symbol: "book.closed",
    item,
    onPress: () =>
      openMacList("Notebook", { id: item.id, canGoBack: true }, item.id)
  }));
  const tagRows: LibraryDestination[] = tags.map((item) => ({
    key: `tag:${item.id}`,
    label: item.title,
    symbol: "number",
    item,
    onPress: () =>
      openMacList(
        "TaggedNotes",
        { type: "tag", id: item.id, canGoBack: true },
        item.id
      )
  }));

  return (
    <View
      style={{
        flex: 1,
        // The window's native toolbar is drawn above the content area, and
        // UIKit reports its height as the window's top safe-area inset: the
        // padding puts the source list below it, and this pane's own background
        // is what shows through that strip (see `macToolbarInset`).
        paddingTop: macToolbarInset(insets.top),
        // Opaque macOS source-list colour for now (F5/R8): the pane stays a
        // real, distinct surface instead of UIKit's grouped black. Letting the
        // native sidebar material (NSVisualEffectView) show through is a
        // follow-up, so this must not be made transparent yet.
        backgroundColor: visual.sidebarBackground
      }}
    >
      <ScrollView
        testID="library-scroll"
        // flex: 1 so the account footer below can stay pinned to the bottom
        // while the list scrolls; its own paddingBottom only needs the small
        // gap under the last row now that the footer owns the bottom edge.
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 8 }}
      >
        {/* Mac sidebars have no large title, and no 44 pt bar either: the pane's
            name is just a 13 pt secondary label above the rows. */}
        <View style={{ paddingLeft: MAC_LIST_TEXT_LEFT, paddingBottom: 4 }}>
          <Text
            accessibilityRole="header"
            testID="library-heading"
            style={{
              color: visual.secondaryText,
              fontSize: MAC_HEADING_FONT_SIZE,
              fontWeight: "600"
            }}
          >
            {strings.routes.Library()}
          </Text>
        </View>
        {sectionRows.map((item, index) => (
          <MacRow
            key={item.key}
            item={item}
            index={index}
            selected={section === item.key.slice("section:".length)}
          />
        ))}
        {collections.map((item, index) => (
          <MacRow
            key={item.key}
            item={item}
            index={index}
            selected={isCurrentDestination(item.key)}
          />
        ))}
        {destinations.map((item, index) => (
          <MacRow
            key={item.key}
            item={item}
            index={index}
            marginTop={visual.sectionSpacing}
            selected={isCurrentDestination(item.key)}
          />
        ))}
        {sectionTitle(strings.routes.Notebooks(), presentNewNotebook)}
        {notebookRows.length ? (
          notebookRows.map((item, index) => (
            <MacRow
              key={item.key}
              item={item}
              index={index}
              selected={isCurrentDestination(item.key)}
            />
          ))
        ) : (
          <MacRow
            item={{
              key: "new-notebook",
              label: strings.newNotebookRow(),
              symbol: "folder.badge.plus",
              onPress: presentNewNotebook
            }}
            index={0}
            selected={false}
          />
        )}
        {/* An empty Tags section is hidden; tags appear once a note has one. */}
        {tagRows.length ? sectionTitle(strings.routes.Tags()) : null}
        {tagRows.map((item, index) => (
          <MacRow
            key={item.key}
            item={item}
            index={index}
            selected={isCurrentDestination(item.key)}
          />
        ))}
      </ScrollView>
      {/* Pinned account row, outside the ScrollView so it never scrolls away. */}
      {isMacCatalyst() ? <MacSidebarAccountFooter /> : null}
    </View>
  );
}

/**
 * One Library destination as a source-list row: 28 pt tall, no card
 * background, no separators, a 6 pt rounded accent highlight when the route it
 * opens is the one on screen, and counts right-aligned in the secondary color.
 *
 * The pointer draws the same 6 pt highlight in the theme's hover color while
 * it is over the row; a selected row keeps its accent (the hover layer is only
 * rendered when the row is not selected). Notebook and tag rows additionally
 * carry their item's context menu, so right-click / control-click offers the
 * same actions as the row has in the note list (see item-actions-menu.tsx).
 */
function MacRow({
  item,
  index,
  marginTop = 0,
  selected
}: {
  item: LibraryDestination;
  index: number;
  marginTop?: number;
  selected: boolean;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const { hovered, hoverProps } = useMacHover();
  const systemAccent = useMacSystemStore((state) => state.accent);
  const windowActive = useMacSystemStore((state) => state.active);
  // S1: the selected source-list row follows the macOS system accent, and goes
  // neutral grey while the window is not key. The theme accent is only the
  // fallback when the bridge has no system accent to offer.
  const selection = macSelectionFill(
    macAccent(colors.primary.accent, systemAccent),
    windowActive,
    isDark
  );

  const row = (
    <Pressable
      {...hoverProps}
      onPress={item.onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={
        item.count === undefined
          ? item.label
          : `${item.label}, ${strings.notes(item.count)}`
      }
      style={{
        height: MAC_ROW_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        // 10 pt of margin around the column so the rounded highlight sits
        // inside it and the icons clear the window edge.
        marginHorizontal: MAC_SOURCE_LIST_INSET,
        // Only the first row of a group keeps a gap: source lists have no
        // card, so the group break is the only separation left.
        marginTop: index === 0 && marginTop ? 8 : 0,
        paddingHorizontal: MAC_ROW_PADDING,
        borderRadius: MAC_ROW_RADIUS,
        backgroundColor: "transparent",
        overflow: "hidden"
      }}
    >
      {/* Pointer feedback under the selection highlight, so a hovered row can
          never hide the row that is actually on screen. */}
      <MacHoverHighlight
        visible={hovered && !selected}
        radius={MAC_ROW_RADIUS}
      />
      {/* Accent at low opacity (grey while the window is not key): a layer of
          its own so custom themes (and their non-hex colors) keep working. */}
      {selected ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: MAC_ROW_RADIUS,
            backgroundColor: selection.color,
            opacity: selection.opacity
          }}
        />
      ) : null}
      <TaskSymbolView
        name={item.symbol}
        size={MAC_ROW_ICON_SIZE}
        // The selected row's icon keeps the accent while the window is active
        // and follows the selection grey while it is not.
        color={selected ? selection.color : colors.primary.accent}
      />
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          color: visual.primaryText,
          fontSize: MAC_ROW_FONT_SIZE,
          marginLeft: 8
        }}
      >
        {item.label}
      </Text>
      {item.count === undefined ? null : (
        <Text
          style={{
            color: visual.secondaryText,
            fontSize: MAC_ROW_FONT_SIZE,
            marginLeft: 8
          }}
        >
          {item.count}
        </Text>
      )}
    </Pressable>
  );

  if (!item.item) return row;
  return (
    <ItemContextMenu item={item.item} previewCornerRadius={MAC_ROW_RADIUS}>
      {row}
    </ItemContextMenu>
  );
}

export default MacSidebar;
