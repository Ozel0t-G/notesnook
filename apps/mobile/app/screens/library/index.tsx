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

import { EVENTS, Notebook, Tag } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { db } from "../../common/database";
import Navigation, { NavigationProps } from "../../services/navigation";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { useNotes } from "../../stores/use-notes-store";
import { useSettingStore } from "../../stores/use-setting-store";
import { useInboxNotes } from "../../stores/use-inbox-store";
import NoteCollection from "../notes/note-collection";
import { openEditor, setOnFirstSaveUnassigned } from "../notes/common";
import {
  IosBarButton,
  IosLargeTitle,
  IosNavBar
} from "../../components/ios-nav-bar";
import {
  APPLE_TAB_BAR_HEIGHT,
  hasBottomTabBar
} from "../../components/apple-tab-bar";
import { AddNotebookSheet } from "../../components/sheets/add-notebook";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isMacCatalyst } from "../../utils/constants";
import useNavigationStore from "../../stores/use-navigation-store";

type LibraryDestination = {
  key: string;
  label: string;
  symbol: string;
  count?: number;
  onPress: () => void;
};

/** The note collections shown above everything else in the Library. */
type LibraryCollection = "all-notes" | "inbox";

/**
 * Mac source list: the `focusedRouteId` that marks each Library destination as
 * the current one. Notebook and tag rows compare their own id instead, since
 * they go through the shared Notes screen and set the id they were opened with.
 */
const MAC_SELECTED_ROUTE_ID: Record<string, string> = {
  "all-notes": "AllNotes",
  inbox: "Inbox",
  favorites: "Favorites",
  monographs: "monograph",
  archive: "Archive",
  trash: "Trash"
};

/** Mac source list metrics (see `mac-layout.ts` for the window chrome). */
const MAC_ROW_HEIGHT = 28;
const MAC_ROW_RADIUS = 6;
const MAC_ROW_FONT_SIZE = 13;
const MAC_ROW_ICON_SIZE = 16;
const MAC_ROW_PADDING = 8;

export default function Library({
  navigation,
  route
}: NavigationProps<"Library">) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const insets = useSafeAreaInsets();
  const [notebooks, setNotebooks] = React.useState<Notebook[]>([]);
  const [tags, setTags] = React.useState<Tag[]>([]);
  const [counts, setCounts] = React.useState<{
    allNotes?: number;
    inbox?: number;
  }>({});
  const [collection, setCollection] = React.useState<
    LibraryCollection | undefined
  >(route.params?.initialCollection);
  const isAppLoading = useSettingStore((state) => state.isAppLoading);
  const [allNotes, allNotesLoading, refreshAllNotes] = useNotes();
  const [inboxNotes, inboxLoading, refreshInbox] = useInboxNotes();
  // Mac renders this screen as a source list (see `isMac` branches below):
  // rows are 28 pt tall, nothing is a card, and the open route is highlighted.
  const isMac = isMacCatalyst();
  const focusedRouteId = useNavigationStore((state) => state.focusedRouteId);
  const isCurrentDestination = React.useCallback(
    (key: string) => {
      if (!isMac) return false;
      if (key.startsWith("notebook:"))
        return focusedRouteId === key.slice("notebook:".length);
      if (key.startsWith("tag:"))
        return focusedRouteId === key.slice("tag:".length);
      return focusedRouteId === MAC_SELECTED_ROUTE_ID[key];
    },
    [focusedRouteId, isMac]
  );

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!db.isInitialized) return;
      const [nextNotebooks, nextTags, allNotesCount, inboxCount] =
        await Promise.all([
          db.notebooks.all.limit(2000).items(),
          db.tags.all.limit(2000).items(),
          db.notes.all.count(),
          db.notes.unassigned.count()
        ]);
      if (alive) {
        setNotebooks(nextNotebooks);
        setTags(nextTags);
        setCounts({ allNotes: allNotesCount, inbox: inboxCount });
      }
    };
    void load();

    // The Library route has no entry in `Navigation.routeUpdateFunctions`, so
    // follow the database directly to keep the counts honest after a note is
    // created, deleted, archived, restored or (un)filed in a notebook.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    };
    const subscriptions = [
      db.eventManager.subscribe(EVENTS.databaseUpdated, (event) => {
        if (
          event?.collection === "notes" ||
          event?.collection === "notebooks" ||
          event?.collection === "relations" ||
          event?.collection === "tags"
        )
          schedule();
      }),
      db.eventManager.subscribe(EVENTS.syncCompleted, schedule)
    ];
    const unsubscribe = navigation.addListener("focus", () => void load());
    return () => {
      alive = false;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      unsubscribe();
    };
  }, [navigation, isAppLoading]);

  const goBackToLibrary = React.useCallback(() => setCollection(undefined), []);

  if (collection === "all-notes") {
    return (
      <NoteCollection
        id="AllNotes"
        title={strings.routes.AllNotes()}
        notes={allNotes}
        loading={allNotesLoading}
        refresh={refreshAllNotes}
        selector={() => db.notes.all}
        placeholder={{
          title: strings.yourNotes(),
          paragraph: strings.notesEmpty(),
          button: Platform.OS === "ios" ? undefined : strings.createNewNote(),
          action: openEditor,
          loading: strings.loadingNotes(),
          plain: Platform.OS === "ios"
        }}
        onGoBack={goBackToLibrary}
      />
    );
  }

  if (collection === "inbox") {
    return (
      <NoteCollection
        id="Inbox"
        title={strings.routes.Inbox()}
        notes={inboxNotes}
        loading={inboxLoading}
        refresh={refreshInbox}
        selector={() => db.notes.unassigned}
        placeholder={{
          title: strings.yourInbox(),
          paragraph: strings.inboxEmpty(),
          button: Platform.OS === "ios" ? undefined : strings.createNewNote(),
          action: openEditor,
          loading: strings.loadingInbox(),
          plain: Platform.OS === "ios",
          // "notes" has generic tips attached to it which would replace the
          // paragraph above; the inbox has none so its own copy is shown.
          type: "inbox"
        }}
        onGoBack={goBackToLibrary}
      />
    );
  }

  const collections: LibraryDestination[] = [
    {
      key: "all-notes",
      label: strings.routes.AllNotes(),
      symbol: "note.text",
      count: counts.allNotes,
      onPress: () => setCollection("all-notes")
    },
    {
      key: "inbox",
      label: strings.routes.Inbox(),
      symbol: "tray",
      count: counts.inbox,
      onPress: () => setCollection("inbox")
    }
  ];

  const destinations: LibraryDestination[] = [
    {
      key: "favorites",
      label: strings.routes.Favorites(),
      symbol: "star",
      onPress: () => navigation.navigate("Favorites", {})
    },
    {
      key: "monographs",
      label: strings.routes.Monographs(),
      symbol: "globe",
      onPress: () =>
        navigation.navigate("Monographs", {
          type: "monograph",
          id: "monograph",
          canGoBack: true
        })
    },
    {
      key: "archive",
      label: strings.routes.Archive(),
      symbol: "archivebox",
      onPress: () => navigation.navigate("Archive", {})
    },
    {
      key: "trash",
      label: strings.routes.Trash(),
      symbol: "trash",
      onPress: () => navigation.navigate("Trash", {})
    }
  ];

  /**
   * Section header ("Notebooks", "Tags"). On Mac it is a plain 11 pt label in
   * the secondary color, like a source list's section header.
   */
  const sectionTitle = (title: string, onAdd?: () => void) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginTop: isMac ? 14 : 22,
        marginBottom: isMac ? 2 : 4,
        marginLeft: isMac ? MAC_ROW_PADDING : 20,
        marginRight: isMac ? MAC_ROW_PADDING : 8
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          flex: 1,
          color: isMac ? visual.secondaryText : visual.primaryText,
          fontSize: isMac ? 11 : 20,
          fontWeight: isMac ? "600" : "700"
        }}
      >
        {title}
      </Text>
      {onAdd ? (
        <IosBarButton
          symbol="plus"
          accessibilityLabel={strings.newNotebookRow()}
          testID="library-new-notebook"
          iconSize={isMac ? 16 : undefined}
          onPress={onAdd}
        />
      ) : null}
    </View>
  );

  /**
   * One Library destination. Mac draws it as a source-list row: 28 pt tall,
   * no card background, no separators, a 6 pt rounded accent highlight when
   * the route it opens is the one on screen, and counts right-aligned in the
   * secondary color. iPhone/iPad keep the inset-group card (radius, hairline
   * separators, chevrons).
   */
  const row = (
    item: LibraryDestination,
    index: number,
    length: number,
    marginTop = 0
  ) => {
    const selected = isCurrentDestination(item.key);
    return (
      <Pressable
        key={item.key}
        onPress={item.onPress}
        accessibilityRole="button"
        accessibilityState={isMac ? { selected } : undefined}
        accessibilityLabel={
          item.count === undefined
            ? item.label
            : `${item.label}, ${strings.notes(item.count)}`
        }
        style={
          isMac
            ? {
                height: MAC_ROW_HEIGHT,
                flexDirection: "row",
                alignItems: "center",
                marginHorizontal: 0,
                // Only the first row of a group keeps a gap: source lists have
                // no card, so the group break is the only separation left.
                marginTop: index === 0 && marginTop ? 8 : 0,
                paddingHorizontal: MAC_ROW_PADDING,
                borderRadius: MAC_ROW_RADIUS,
                borderWidth: 0,
                backgroundColor: "transparent",
                overflow: "hidden"
              }
            : {
                minHeight: 54,
                flexDirection: "row",
                alignItems: "center",
                marginHorizontal: 16,
                marginTop: index === 0 ? marginTop : 0,
                paddingHorizontal: 16,
                borderTopLeftRadius: index === 0 ? visual.controlRadius : 0,
                borderTopRightRadius: index === 0 ? visual.controlRadius : 0,
                borderBottomLeftRadius:
                  index === length - 1 ? visual.controlRadius : 0,
                borderBottomRightRadius:
                  index === length - 1 ? visual.controlRadius : 0,
                borderBottomWidth: index === length - 1 ? 0 : 0.5,
                borderBottomColor: visual.separator,
                backgroundColor: visual.contentSurface
              }
        }
      >
        {/* Accent at low opacity: a layer of its own so custom themes (and
            their non-hex colors) keep working. */}
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
              backgroundColor: colors.primary.accent,
              opacity: 0.2
            }}
          />
        ) : null}
        <TaskSymbolView
          name={item.symbol}
          size={isMac ? MAC_ROW_ICON_SIZE : 21}
          color={colors.primary.accent}
        />
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            color: visual.primaryText,
            fontSize: isMac ? MAC_ROW_FONT_SIZE : 16,
            marginLeft: isMac ? 8 : 14
          }}
        >
          {item.label}
        </Text>
        {item.count === undefined ? null : (
          <Text
            style={{
              color: visual.secondaryText,
              fontSize: isMac ? MAC_ROW_FONT_SIZE : 16,
              marginLeft: 8,
              marginRight: isMac ? 0 : 8
            }}
          >
            {item.count}
          </Text>
        )}
        {isMac ? null : (
          <TaskSymbolView
            name="chevron.right"
            size={14}
            color={visual.tertiaryText}
          />
        )}
      </Pressable>
    );
  };

  const notebookRows: LibraryDestination[] = notebooks.map((item) => ({
    key: `notebook:${item.id}`,
    label: item.title,
    symbol: "book.closed",
    onPress: () =>
      navigation.navigate("Notebook", { id: item.id, canGoBack: true })
  }));
  const tagRows: LibraryDestination[] = tags.map((item) => ({
    key: `tag:${item.id}`,
    label: item.title,
    symbol: "number",
    onPress: () =>
      navigation.navigate("TaggedNotes", {
        type: "tag",
        id: item.id,
        canGoBack: true
      })
  }));

  return (
    <View style={{ flex: 1, backgroundColor: visual.screenBackground }}>
      <ScrollView
        testID="library-scroll"
        contentContainerStyle={{
          // Mac's title bar row is a sibling above this scroll view, so the
          // list starts 8 pt under it. Only the iPhone bar floats over the
          // bottom of this list; the iPad bar floats at the top and Mac shows
          // no bar at all.
          paddingTop: isMac ? 8 : 0,
          paddingBottom:
            32 + (hasBottomTabBar() ? APPLE_TAB_BAR_HEIGHT + insets.bottom : 0)
        }}
      >
        {/* Settings and compose live in the navigation bar, as in Notes. */}
        <IosNavBar
          leading={
            isMac ? (
              // Mac sidebars have no large title: the screen name is a 13 pt
              // secondary label on the bar row itself.
              <Text
                accessibilityRole="header"
                testID="library-heading"
                style={{
                  color: visual.secondaryText,
                  fontSize: 13,
                  fontWeight: "600",
                  paddingLeft: MAC_ROW_PADDING
                }}
              >
                {strings.routes.Library()}
              </Text>
            ) : undefined
          }
          trailing={
            <>
              <IosBarButton
                symbol="gearshape"
                accessibilityLabel={strings.routes.Settings()}
                testID="library-settings"
                iconSize={isMac ? MAC_ROW_ICON_SIZE : undefined}
                onPress={() => Navigation.push("Settings", {})}
              />
              <IosBarButton
                symbol="square.and.pencil"
                accessibilityLabel={strings.newNoteTab()}
                testID="library-compose"
                iconSize={isMac ? MAC_ROW_ICON_SIZE : undefined}
                onPress={() => {
                  setOnFirstSaveUnassigned();
                  openEditor();
                }}
              />
            </>
          }
        />
        {isMac ? null : (
          <IosLargeTitle
            title={strings.routes.Library()}
            testID="library-heading"
          />
        )}
        {collections.map((item, index) => row(item, index, collections.length))}
        {destinations.map((item, index) =>
          row(item, index, destinations.length, visual.sectionSpacing)
        )}
        {sectionTitle(strings.routes.Notebooks(), () =>
          AddNotebookSheet.present(undefined, undefined, "global", undefined, false)
        )}
        {notebookRows.length
          ? notebookRows.map((item, index) =>
              row(item, index, notebookRows.length)
            )
          : row(
              {
                key: "new-notebook",
                label: strings.newNotebookRow(),
                symbol: "folder.badge.plus",
                onPress: () =>
                  AddNotebookSheet.present(undefined, undefined, "global", undefined, false)
              },
              0,
              1
            )}
        {/* An empty Tags section is hidden; tags appear once a note has one. */}
        {tagRows.length ? sectionTitle(strings.routes.Tags()) : null}
        {tagRows.map((item, index) => row(item, index, tagRows.length))}
      </ScrollView>
    </View>
  );
}
