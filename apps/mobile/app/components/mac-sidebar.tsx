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
import { ContextMenu, NativeMenuItem } from "./native-menu";
import { MacHoverHighlight, useMacHover } from "./mac-hover";
import { selectAppleSection } from "../navigation/navigation-stack";
import { MacSidebarAccountFooter } from "./mac-sidebar-account-footer";
import { isMacCatalyst } from "../utils/constants";
import { openEditor, setOnFirstSaveUnassigned } from "../screens/notes/common";
import { confirmEmptyTrash } from "../screens/trash";
import { systemColor, SystemColorName } from "../utils/ios-system-colors";
import {
  taskSmartList,
  TaskSmartListId,
  useTaskSmartLists
} from "../hooks/use-task-smart-lists";
import {
  TaskSelection,
  useTasksSelectionStore
} from "../stores/use-tasks-selection-store";
import {
  MacSidebarSectionId,
  useMacSidebarSectionsStore
} from "../stores/use-mac-sidebar-sections-store";
import {
  taskListColor,
  taskListSymbol
} from "../screens/tasks/list-appearance";

type LibraryDestination = {
  key: string;
  label: string;
  symbol: string;
  count?: number;
  /**
   * Explicit SF Symbol color. Library rows leave this unset and keep the accent
   * (the selected row overrides it with the selection color); notebook, tag,
   * Archive, Trash and user List rows pass their own gray/List color.
   */
  iconColor?: string;
  /** Set on Tasks rows so exactly that row can be highlighted. */
  taskSelection?: TaskSelection;
  onPress: () => void;
  /**
   * The notebook/tag a row stands for. Rows backed by an item get the same
   * right-click menu as their equivalents in the note list (see
   * components/item-actions-menu.tsx); the plain Library destinations (All
   * Notes, Inbox, Favorites, ...) have no item to act on.
   */
  item?: Item;
  /**
   * C9: right-click menu of a plain Library destination. All Notes / Inbox
   * offer "New Note" (the compose / Cmd-N action), Trash "Empty Trash" (the
   * screen's own confirmation flow). Destinations without actions stay plain.
   */
  menuItems?: NativeMenuItem[];
  onMenuSelect?: (id: string) => void;
};

/** Compose / Cmd-N: a new note in the Inbox, not in the default notebook. */
const startNewNote = () => {
  setOnFirstSaveUnassigned();
  openEditor();
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
const MAC_ROW_RADIUS = 6;
const MAC_ROW_FONT_SIZE = 13;
const MAC_ROW_ICON_SIZE = 16;
/** Inner padding of a row: the icon/text inset inside the highlight. */
const MAC_ROW_PADDING = 8;
/** Text of a row/section header, measured from the column's edge. */
const MAC_LIST_TEXT_LEFT = MAC_SOURCE_LIST_INSET + MAC_ROW_PADDING;

/**
 * The smart lists Mac's Tasks section shows, in the sidebar's own order (the
 * Tasks screen's tiles keep theirs). "All" is drawn as a grey checklist here
 * even though the tile uses a tray, so the row reads as "every task".
 */
const SIDEBAR_SMART_LISTS: TaskSmartListId[] = [
  "today",
  "scheduled",
  "flagged",
  "all"
];

const presentNewNotebook = () =>
  AddNotebookSheet.present(undefined, undefined, "global", undefined, false);

/**
 * Mac's sidebar pane: a persistent source list at the left edge of the window.
 * It is the Library screen's source-list rendering lifted out of the navigation
 * stack, so iPhone/iPad keep the card-style list of screens/library and Mac gets
 * the 28 pt source rows.
 *
 * The list is split like the app's top-level sections: a Library group (Library,
 * Notebooks, Tags), a Tasks group (the smart lists and the user's Task Lists)
 * and Archive/Trash at the bottom. Selecting a Library row opens that list in
 * the middle column through `openMacList`
 * (services/mac-list-navigation.ts); selecting a Tasks row switches to the Tasks
 * section and selects that list in useTasksSelectionStore, which the Tasks
 * screen follows on Mac (screens/tasks/index.tsx). The selected row follows
 * `focusedRouteId` (Library) or that store (Tasks), so it stays in sync with
 * navigation started anywhere else.
 */
export function MacSidebar() {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const insets = useGlobalSafeAreaInsets();
  const { notebooks, tags, counts, notebookCounts, tagCounts } =
    useLibrarySourceList(undefined, { countsByNotebookAndTag: true });
  const {
    lists: taskLists,
    counts: taskCounts,
    listCounts
  } = useTaskSmartLists();
  const focusedRouteId = useNavigationStore((state) => state.focusedRouteId);
  const section = useAppleNavigationStore((state) => state.section);
  const taskSelectionState = useTasksSelectionStore((state) => state.selection);
  const collapsed = useMacSidebarSectionsStore((state) => state.collapsed);
  const toggleSection = useMacSidebarSectionsStore((state) => state.toggle);

  /** Switches the top-level section through the same handler the toolbar uses. */
  const switchSection = (next: AppleSection) => {
    NativeModules.VeyraNMacMenu?.setSelectedSection(next);
    selectAppleSection(next);
  };

  /**
   * A Tasks row (smart list or user List): select it for the Tasks screen, then
   * bring the Tasks section forward so the list it drives is on screen.
   */
  const selectTaskList = (next: TaskSelection) => {
    useTasksSelectionStore.getState().setSelection(next);
    switchSection("tasks");
  };

  /** The sidebar's "Lists" + button: the Tasks screen's own New List action. */
  const requestNewList = () => {
    useTasksSelectionStore.getState().requestNewList();
    switchSection("tasks");
  };

  // Settings is a full view next to the sidebar: no source-list row is current.
  const settingsOpen = useNavigationStore(
    (state) => state.currentRoute === "Settings"
  );
  const isCurrentDestination = React.useCallback(
    (key: string) => {
      if (section !== "library" || settingsOpen) return false;
      if (key.startsWith("notebook:"))
        return focusedRouteId === key.slice("notebook:".length);
      if (key.startsWith("tag:"))
        return focusedRouteId === key.slice("tag:".length);
      return focusedRouteId === MAC_SELECTED_ROUTE_ID[key];
    },
    [focusedRouteId, section, settingsOpen]
  );

  /** Exactly one row is highlighted: a Library list or the selected Task list. */
  const isTaskSelected = (selection?: TaskSelection) =>
    !!selection &&
    section === "tasks" &&
    !settingsOpen &&
    taskSelectionState.kind === selection.kind &&
    taskSelectionState.id === selection.id;

  /** C9: the destinations' own right-click actions (see `menuItems` above). */
  const onDestinationMenu = (id: string) => {
    if (id === "new-note") startNewNote();
    else if (id === "empty-trash") confirmEmptyTrash();
  };
  const newNoteMenuItems: NativeMenuItem[] = [
    {
      id: "new-note",
      title: strings.newNoteTab(),
      symbol: "square.and.pencil"
    }
  ];

  const libraryRows: LibraryDestination[] = [
    {
      key: "all-notes",
      label: strings.routes.AllNotes(),
      symbol: "books.vertical",
      count: counts.allNotes,
      menuItems: newNoteMenuItems,
      onMenuSelect: onDestinationMenu,
      onPress: () =>
        openMacList("Library", { initialCollection: "all-notes" }, "AllNotes")
    },
    {
      key: "inbox",
      label: strings.routes.Inbox(),
      symbol: "tray",
      count: counts.inbox,
      menuItems: newNoteMenuItems,
      onMenuSelect: onDestinationMenu,
      onPress: () =>
        openMacList("Library", { initialCollection: "inbox" }, "Inbox")
    },
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
    }
  ];

  const bottomRows: LibraryDestination[] = [
    {
      key: "archive",
      label: strings.routes.Archive(),
      symbol: "archivebox",
      iconColor: visual.secondaryText,
      onPress: () => openMacList("Archive", {}, "Archive")
    },
    {
      key: "trash",
      label: strings.routes.Trash(),
      symbol: "trash",
      iconColor: visual.secondaryText,
      menuItems: [
        {
          id: "empty-trash",
          title: strings.clearTrash(),
          symbol: "trash",
          destructive: true
        }
      ],
      onMenuSelect: onDestinationMenu,
      onPress: () => openMacList("Trash", {}, "Trash")
    }
  ];

  const notebookRows: LibraryDestination[] = notebooks.map((item) => ({
    key: `notebook:${item.id}`,
    label: item.title,
    symbol: "book.closed",
    count: notebookCounts?.[item.id] || 0,
    iconColor: visual.secondaryText,
    item,
    onPress: () =>
      openMacList("Notebook", { id: item.id, canGoBack: true }, item.id)
  }));
  const tagRows: LibraryDestination[] = tags.map((item) => ({
    key: `tag:${item.id}`,
    label: `#${item.title}`,
    symbol: "number",
    count: tagCounts?.[item.id] || 0,
    iconColor: visual.secondaryText,
    item,
    onPress: () =>
      openMacList(
        "TaggedNotes",
        { type: "tag", id: item.id, canGoBack: true },
        item.id
      )
  }));

  const smartListRows: LibraryDestination[] = SIDEBAR_SMART_LISTS.map((id) => {
    const definition = taskSmartList(id);
    // "All" is the one row whose sidebar glyph differs from its tile.
    const symbol = id === "all" ? "checklist" : definition?.symbol || "checklist";
    const color: SystemColorName =
      id === "all" ? "gray" : definition?.color || "gray";
    return {
      key: `task:${id}`,
      label: definition?.label() || strings.tasksAll(),
      symbol,
      iconColor: systemColor(color, isDark),
      count: taskCounts[id],
      taskSelection: { kind: "smart", id },
      onPress: () => selectTaskList({ kind: "smart", id })
    };
  });

  const taskListRows: LibraryDestination[] = taskLists.map((list) => ({
    key: `tasklist:${list.id}`,
    label: list.name,
    symbol: taskListSymbol(list.symbol),
    iconColor: taskListColor(list.color),
    count: listCounts[list.id] || 0,
    taskSelection: { kind: "list", id: list.id },
    onPress: () => selectTaskList({ kind: "list", id: list.id })
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
        {/* 1. Library: notes destinations, accent-tinted icons. */}
        <MacSectionHeader
          id="library"
          title={strings.routes.Library()}
          testID="library-heading"
          collapsed={collapsed.library}
          onToggle={toggleSection}
        />
        {collapsed.library
          ? null
          : libraryRows.map((item, index) => (
              <MacRow
                key={item.key}
                item={item}
                index={index}
                selected={isCurrentDestination(item.key)}
              />
            ))}

        {/* 2. Notebooks, with the existing new-notebook action. */}
        <MacSectionHeader
          id="notebooks"
          title={strings.routes.Notebooks()}
          collapsed={collapsed.notebooks}
          onToggle={toggleSection}
          onAdd={presentNewNotebook}
          addAccessibilityLabel={strings.newNotebookRow()}
          addTestID="library-new-notebook"
        />
        {collapsed.notebooks ? null : notebookRows.length ? (
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

        {/* 3. Tags, hidden entirely while there are none. */}
        {tagRows.length ? (
          <>
            <MacSectionHeader
              id="tags"
              title={strings.routes.Tags()}
              collapsed={collapsed.tags}
              onToggle={toggleSection}
            />
            {collapsed.tags
              ? null
              : tagRows.map((item, index) => (
                  <MacRow
                    key={item.key}
                    item={item}
                    index={index}
                    selected={isCurrentDestination(item.key)}
                  />
                ))}
          </>
        ) : null}

        {/* 4. Divider between the two source-list halves. */}
        <View
          style={{
            height: 1,
            backgroundColor: visual.separator,
            marginHorizontal: 8,
            marginVertical: 10
          }}
        />

        {/* 5. Tasks: the smart lists, reusing the Tasks screen's data. */}
        <MacSectionHeader
          id="tasks"
          title={strings.tasksTitle()}
          collapsed={collapsed.tasks}
          onToggle={toggleSection}
        />
        {collapsed.tasks
          ? null
          : smartListRows.map((item, index) => (
              <MacRow
                key={item.key}
                item={item}
                index={index}
                selected={isTaskSelected(item.taskSelection)}
              />
            ))}

        {/* 6. Lists: the user's Task Lists, with the New List action. */}
        <MacSectionHeader
          id="lists"
          title={strings.tasksLists()}
          collapsed={collapsed.lists}
          onToggle={toggleSection}
          onAdd={requestNewList}
          addAccessibilityLabel={strings.tasksNewList()}
          addTestID="mac-sidebar-new-list"
        />
        {collapsed.lists
          ? null
          : taskListRows.map((item, index) => (
              <MacRow
                key={item.key}
                item={item}
                index={index}
                selected={isTaskSelected(item.taskSelection)}
              />
            ))}

        {/* 7. A second divider, then Archive and Trash at the bottom. */}
        <View
          style={{
            height: 1,
            backgroundColor: visual.separator,
            marginHorizontal: 8,
            marginVertical: 10
          }}
        />
        {bottomRows.map((item, index) => (
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
 * A collapsible source-list section header: an 11 pt semibold label in the
 * secondary color with a small chevron (and, for Notebooks and Lists, a "+"
 * button). Clicking the header toggles the section through
 * use-mac-sidebar-sections-store.
 */
function MacSectionHeader({
  id,
  title,
  testID,
  collapsed,
  onToggle,
  onAdd,
  addAccessibilityLabel,
  addTestID
}: {
  id: MacSidebarSectionId;
  title: string;
  testID?: string;
  collapsed: boolean;
  onToggle: (id: MacSidebarSectionId) => void;
  onAdd?: () => void;
  addAccessibilityLabel?: string;
  addTestID?: string;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginTop: 14,
        marginBottom: 2,
        marginLeft: MAC_LIST_TEXT_LEFT,
        marginRight: MAC_SOURCE_LIST_INSET,
        minHeight: 20
      }}
    >
      {/* The title + chevron is the collapse target and fills the row's
          remaining width; the "+" (if any) is a sibling so its own press never
          also toggles the section. The chevron sits directly after the title
          (4 pt gap) rather than at the row's right edge, per macOS source-list
          convention. */}
      <Pressable
        onPress={() => onToggle(id)}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: !collapsed }}
        style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
      >
        <Text
          testID={testID}
          numberOfLines={1}
          style={{
            color: visual.secondaryText,
            fontSize: 11,
            fontWeight: "600"
          }}
        >
          {title}
        </Text>
        <View style={{ marginLeft: 4 }}>
          <TaskSymbolView
            name={collapsed ? "chevron.right" : "chevron.down"}
            size={9}
            color={visual.tertiaryText}
          />
        </View>
      </Pressable>
      {onAdd ? (
        <MacHeaderAddButton
          accessibilityLabel={addAccessibilityLabel}
          testID={addTestID}
          onPress={onAdd}
        />
      ) : null}
    </View>
  );
}

/**
 * The sidebar section headers' "+" button (New Notebook / New List).
 *
 * Unlike the toolbar's `IosBarButton` (44×44 pt with 6 pt of hit slop, sized
 * for touch), this is a compact Mac target: 22×22 pt with no hit slop, so it
 * ends at the row's right edge and can never overlap the header's title +
 * chevron toggle to its left.
 */
function MacHeaderAddButton({
  accessibilityLabel,
  testID,
  onPress
}: {
  accessibilityLabel?: string;
  testID?: string;
  onPress: () => void;
}) {
  const { colors } = useThemeColors();
  const { hovered, hoverProps } = useMacHover();
  return (
    <Pressable
      {...hoverProps}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({
        width: 22,
        height: 22,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.4 : 1
      })}
    >
      <MacHoverHighlight visible={hovered} />
      <TaskSymbolView name="plus" size={16} color={colors.primary.accent} />
    </Pressable>
  );
}

/**
 * One source-list row: 28 pt tall, no card background, no separators, a 6 pt
 * rounded accent highlight when the route it opens is the one on screen, and
 * counts right-aligned in the secondary color.
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
        color={
          selected
            ? selection.color
            : item.iconColor || colors.primary.accent
        }
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

  if (item.item)
    return (
      <ItemContextMenu item={item.item} previewCornerRadius={MAC_ROW_RADIUS}>
        {row}
      </ItemContextMenu>
    );
  // C9: plain Library destinations carry their own small menu, e.g. "New Note"
  // on All Notes / Inbox and "Empty Trash" on Trash.
  const { menuItems, onMenuSelect } = item;
  if (menuItems && menuItems.length > 0 && onMenuSelect)
    return (
      <ContextMenu
        items={menuItems}
        onSelect={onMenuSelect}
        previewCornerRadius={MAC_ROW_RADIUS}
      >
        {row}
      </ContextMenu>
    );
  return row;
}

export default MacSidebar;
