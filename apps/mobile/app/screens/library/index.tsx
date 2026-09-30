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
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { db } from "../../common/database";
import Navigation, { NavigationProps } from "../../services/navigation";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { useNotes } from "../../stores/use-notes-store";
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
import { useLibrarySourceList } from "../../hooks/use-library-source-list";

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
 * Mac's Library route is the note list column: the source list that used to be
 * rendered here now lives in the sidebar pane (components/mac-sidebar.tsx), and
 * this screen shows the list the sidebar selected - All Notes by default - so
 * the middle column never shows a source list or a "‹ Library" back button.
 */
const MAC_DEFAULT_COLLECTION: LibraryCollection = "all-notes";

export default function Library({
  navigation,
  route
}: NavigationProps<"Library">) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const insets = useSafeAreaInsets();
  const [collection, setCollection] = React.useState<
    LibraryCollection | undefined
  >(route.params?.initialCollection);
  const [allNotes, allNotesLoading, refreshAllNotes] = useNotes();
  const [inboxNotes, inboxLoading, refreshInbox] = useInboxNotes();
  const isMac = isMacCatalyst();
  const { notebooks, tags, counts } = useLibrarySourceList(navigation);

  /**
   * The sidebar selects a list by navigating here with `initialCollection`
   * (`openMacList` in services/mac-list-navigation.ts), so follow the params
   * instead of only reading them once. Mac always has a collection: All Notes is
   * the middle column's default content.
   */
  React.useEffect(() => {
    const next = route.params?.initialCollection;
    if (next) setCollection(next);
  }, [route.params?.initialCollection]);

  const activeCollection = isMac
    ? collection || MAC_DEFAULT_COLLECTION
    : collection;

  const goBackToLibrary = React.useCallback(
    () => setCollection(isMac ? MAC_DEFAULT_COLLECTION : undefined),
    [isMac]
  );

  if (activeCollection === "all-notes") {
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

  if (activeCollection === "inbox") {
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
   * Section header ("Notebooks", "Tags"). Mac's source list draws its own
   * (components/mac-sidebar.tsx); this is the iPhone/iPad card list.
   */
  const sectionTitle = (title: string, onAdd?: () => void) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginTop: 22,
        marginBottom: 4,
        // Section headers line up with the rows' content (and their trailing
        // "+" with the row counts), not with the column's edges.
        marginLeft: 20,
        marginRight: 8
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          flex: 1,
          color: visual.primaryText,
          fontSize: 20,
          fontWeight: "700"
        }}
      >
        {title}
      </Text>
      {onAdd ? (
        <IosBarButton
          symbol="plus"
          accessibilityLabel={strings.newNotebookRow()}
          testID="library-new-notebook"
          onPress={onAdd}
        />
      ) : null}
    </View>
  );

  /**
   * One Library destination of the iPhone/iPad card list: the inset-group card
   * (radius, hairline separators, chevrons).
   */
  const row = (
    item: LibraryDestination,
    index: number,
    length: number,
    marginTop = 0
  ) => {
    return (
      <Pressable
        key={item.key}
        onPress={item.onPress}
        accessibilityRole="button"
        accessibilityLabel={
          item.count === undefined
            ? item.label
            : `${item.label}, ${strings.notes(item.count)}`
        }
        style={{
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
        }}
      >
        <TaskSymbolView
          name={item.symbol}
          size={21}
          color={colors.primary.accent}
        />
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            color: visual.primaryText,
            fontSize: 16,
            marginLeft: 14
          }}
        >
          {item.label}
        </Text>
        {item.count === undefined ? null : (
          <Text
            style={{
              color: visual.secondaryText,
              fontSize: 16,
              marginLeft: 8,
              marginRight: 8
            }}
          >
            {item.count}
          </Text>
        )}
        <TaskSymbolView
          name="chevron.right"
          size={14}
          color={visual.tertiaryText}
        />
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
          paddingTop: 0,
          paddingBottom:
            32 + (hasBottomTabBar() ? APPLE_TAB_BAR_HEIGHT + insets.bottom : 0)
        }}
      >
        {/*
          Settings and compose live in the navigation bar, as in Notes; the
          "Notebooks" section header's "+" (see `sectionTitle`) adds a notebook.
          Mac renders neither this list nor this bar: its source list is the
          sidebar pane and its chrome is the window's native toolbar.
        */}
        <IosNavBar
          trailing={
            <>
              <IosBarButton
                symbol="gearshape"
                accessibilityLabel={strings.routes.Settings()}
                testID="library-settings"
                onPress={() => Navigation.push("Settings", {})}
              />
              <IosBarButton
                symbol="square.and.pencil"
                accessibilityLabel={strings.newNoteTab()}
                testID="library-compose"
                onPress={() => {
                  setOnFirstSaveUnassigned();
                  openEditor();
                }}
              />
            </>
          }
        />
        <IosLargeTitle
          title={strings.routes.Library()}
          testID="library-heading"
        />
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
