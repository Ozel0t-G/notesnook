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
import { NavigationProps } from "../../services/navigation";
import { selectAppleSection } from "../../navigation/navigation-stack";
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
import { useSettingStore } from "../../stores/use-setting-store";
import { useLibrarySourceList } from "../../hooks/use-library-source-list";
import {
  useMacSidebarSectionCollapsed,
  useMacSidebarSectionsStore
} from "../../stores/use-mac-sidebar-sections-store";
import { useIPadWorkspace } from "../../components/ipad-workspace-context";
import {
  ipadDefaultCollection,
  ipadShowsNoteCollection
} from "../../utils/ipad-layout";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { AccountAffordance } from "../../components/header/account-affordance";

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
  const isMac = isMacCatalyst();
  const isPhone = Platform.OS === "ios" && !Platform.isPad && !isMac;
  /**
   * The iPad workspace this column is laid out in, or undefined on every other
   * client (and outside the provider). It is read for exactly two things: the
   * collection this column must show by default (the pane mode, *not* the
   * sidebar's momentary visibility: a closed medium drawer and fullscreen both
   * report the sidebar as not visible but still give this column a collection),
   * and whether the sidebar's own account affordance is on screen.
   */
  const ipad = useIPadWorkspace();
  /**
   * Reads the navigator's *current* focus for this Library route.
   *
   * "Is the Library focused" has two different answers at two different
   * moments: the value a render paints from, and the value at cleanup time (the
   * retained column may have lost focus to a pushed Notebook since). This
   * getter answers the present, so the collection it hands to `NoteCollection`
   * can prove at cleanup whether it still owns the foreground; the state below
   * is the render-time snapshot it reacts to.
   */
  const navigatorIsFocused = React.useCallback(
    () => navigation?.isFocused?.() ?? true,
    [navigation]
  );
  /**
   * Whether this Library column currently owns the foreground, seeded from the
   * navigator and kept live by the focus/blur subscriptions below. Only the
   * focused column may publish the collection it shows as the focused route and
   * the header's New Note behaviour; a retained background column must never
   * take either from the screen that is actually in front of the user.
   */
  const [ownsForeground, setOwnsForeground] = React.useState(() =>
    navigatorIsFocused()
  );
  const [collection, setCollection] = React.useState<
    LibraryCollection | undefined
  >(
    () =>
      route.params?.initialCollection ||
      (isMac
        ? MAC_DEFAULT_COLLECTION
        : ipad && navigatorIsFocused()
        ? ipadDefaultCollection(ipad.paneMode)
        : undefined)
  );
  const [allNotes, allNotesLoading, refreshAllNotes] = useNotes();
  const [inboxNotes, inboxLoading, refreshInbox] = useInboxNotes();
  /**
   * Bumped whenever the user *re-enters* the collection that is already on
   * screen: the sidebar re-selects this Library column (a repeated
   * `initialCollection` selection) or the retained column is focused again.
   * Both are re-entries that remount nothing, so the bare state update above
   * would otherwise leave the list showing the headline and edited time a save
   * had already replaced in the database.
   */
  const [collectionRevision, requestCollectionRefresh] = React.useReducer(
    (revision: number) => revision + 1,
    0
  );
  const deviceMode = useSettingStore((state) => state.deviceMode);
  /**
   * iPad without the width-derived workspace (no provider above this screen):
   * the root reports `deviceMode === "tablet"` and the sidebar pane is not on
   * screen, so the account/login-status affordance the sidebar used to carry
   * moves into this list's navigation bar. Gated on the same predicate —
   * `!isMacCatalyst()` because Mac also reports `deviceMode === "tablet"` (and
   * `Platform.isPad`). The sidebar pane is never unmounted for this: it is laid
   * out at zero width / off canvas (see `navigation/fluid-panels-view.tsx`), so
   * "on screen" is a presentation fact, not a mounting one.
   *
   * With an iPad workspace the momentary answer is used instead: the sidebar's
   * account affordance (components/side-menu/side-menu-header.tsx) is the one
   * that is actually reachable only when the sidebar is actually on screen, and
   * that is a presentation fact the pane mode alone cannot answer (a closed
   * medium drawer, fullscreen). It never decides which collection is shown.
   */
  const noSidebarIPadLandscape =
    Platform.OS === "ios" &&
    Platform.isPad === true &&
    !isMac &&
    deviceMode === "tablet";
  const showAccountAffordance = ipad
    ? !ipad.sidebarVisible
    : noSidebarIPadLandscape;
  const { notebooks, tags, counts, notebookCounts, tagCounts } =
    useLibrarySourceList(navigation, { countsByNotebookAndTag: true });
  const notebooksCollapsed = useMacSidebarSectionCollapsed("notebooks");
  const tagsCollapsed = useMacSidebarSectionCollapsed("tags");
  const toggleSection = useMacSidebarSectionsStore((state) => state.toggle);

  /**
   * The sidebar selects a list by navigating here with `initialCollection`
   * (`openMacList` in services/mac-list-navigation.ts, the iPad sidebar's own
   * rows), so follow the params instead of only reading them once. Mac always
   * has a collection: All Notes is the middle column's default content.
   *
   * The effect keys off the params *object*, not the value: two selections of
   * the same collection (open Inbox, go back to the source list, open Inbox
   * again) carry the same value, and a value-keyed effect would ignore the
   * second one and leave the column on the source list. A navigation that
   * changes the parameters produces a new params object (React Navigation
   * merges the action's params into a fresh object), so the repeated selection
   * still applies - while a plain re-render keeps the same object and never
   * re-applies a param over a selection the user has since undone.
   */
  const initialCollection = route.params?.initialCollection;
  /**
   * The params object the last navigation applied. The column is mounted with
   * its collection already seeded (above) when it opens *once* on a param, so
   * the mount value is remembered as handled: only a *new* params object - a
   * real navigation - re-applies the selection and re-reads the list.
   */
  const handledParams = React.useRef(route.params);
  React.useEffect(() => {
    if (handledParams.current === route.params) return;
    handledParams.current = route.params;
    if (!initialCollection) return;
    setCollection(initialCollection);
    // A fresh params object is a real navigation (the sidebar row was pressed
    // again), and it must re-read the list even when the collection value is
    // unchanged: the user is asking for that list *now*, and the row it shows
    // may have been edited in the editor since it was last read.
    requestCollectionRefresh();
  }, [route.params, initialCollection]);

  /**
   * The column is kept mounted across a pushed screen, so nothing else tells it
   * that it lost the foreground and got it back: re-entering it (returning from
   * Notebook / Favorites) re-reads the collection on screen, and both
   * transitions keep `ownsForeground` live.
   *
   * The current focus is read *after* the subscriptions are installed: focus
   * can change between the render above and this registration, and neither a
   * one-shot read nor the subscriptions alone would see that transition - the
   * column would keep believing the focus state it happened to render with.
   */
  React.useEffect(() => {
    const nav = navigation;
    const unsubscribeFocus = nav?.addListener?.("focus", () => {
      setOwnsForeground(true);
      requestCollectionRefresh();
    });
    const unsubscribeBlur = nav?.addListener?.("blur", () => {
      setOwnsForeground(false);
    });
    setOwnsForeground(navigatorIsFocused());
    return () => {
      unsubscribeFocus?.();
      unsubscribeBlur?.();
    };
  }, [navigation, navigatorIsFocused]);

  /**
   * Wide and medium give this column the note collection and the sidebar the
   * source list, so a column without a collection must fall back to All Notes
   * rather than draw a second copy of the source list. This is the mode, not
   * the sidebar's momentary visibility: a medium drawer that happens to be
   * closed, or fullscreen, still leaves the column a collection.
   *
   * The fallback is *written into the state* (and seeded above on mount) rather
   * than derived on every render, so a later narrow - where there is no column
   * default at all - keeps showing the very list that had been on screen, with
   * its scroll position and its selected note, instead of dropping back to the
   * source categories.
   *
   * Seeding is functional: the params effect above has already queued an
   * incoming explicit choice into `prev`, so it is preserved; only an empty
   * column (a narrow "back" that left a stale param behind) takes the default.
   * Guarding on `initialCollection` here would instead re-block the seed after
   * a back whenever the old param object is still on the route.
   *
   * The seed is written only while the column owns the foreground. A retained
   * background column still *derives* the wide/medium default for rendering
   * (see `activeCollection`), but must not commit it into state: a narrow
   * source list the user left behind, widened while a Notebook is in front, and
   * narrowed again would otherwise come back as All Notes and lose the source
   * history the user expects to return to. The explicit `route.params` choice
   * above is intentional and applies regardless of focus.
   */
  const paneMode = ipad?.paneMode;
  React.useEffect(() => {
    if (!ownsForeground) return;
    if (!paneMode || collection !== undefined) return;
    const next = ipadDefaultCollection(paneMode);
    if (!next) return;
    setCollection((prev) => prev ?? next);
  }, [paneMode, collection, ownsForeground]);

  const activeCollection = isMac
    ? collection || MAC_DEFAULT_COLLECTION
    : collection ||
      (ipad && ipadShowsNoteCollection(ipad.paneMode)
        ? MAC_DEFAULT_COLLECTION
        : undefined);

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
        refreshRevision={collectionRevision}
        ownsForeground={ownsForeground}
        isFocused={navigatorIsFocused}
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
        refreshRevision={collectionRevision}
        ownsForeground={ownsForeground}
        isFocused={navigatorIsFocused}
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
      key: "templates",
      label: strings.routes.Templates(),
      symbol: "doc.on.doc",
      count: counts.templates,
      onPress: () => navigation.navigate("Templates", {})
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
   * (components/mac-sidebar.tsx); this is the iPhone/iPad card list. The title
   * area toggles the section through the same store the Mac sidebar uses.
   */
  const sectionTitle = (
    id: "notebooks" | "tags",
    title: string,
    collapsed: boolean,
    onAdd?: () => void
  ) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginTop: isPhone ? visual.sectionSpacing : 22,
        marginBottom: 4,
        // Section headers line up with the rows' content (and their trailing
        // "+" with the row counts), not with the column's edges.
        marginLeft: isPhone ? visual.pagePadding * 2 : 20,
        marginRight: 8
      }}
    >
      <Pressable
        onPress={() => toggleSection(id)}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: !collapsed }}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          minHeight: isPhone ? 44 : undefined
        }}
      >
        <Text
          accessibilityRole="header"
          style={{
            color: visual.secondaryText,
            fontSize: isPhone ? AppFontSize.md : 17,
            flexShrink: isPhone ? 1 : undefined,
            fontWeight: "400"
          }}
        >
          {title}
        </Text>
        <View style={{ marginLeft: 6 }}>
          <TaskSymbolView
            name={collapsed ? "chevron.right" : "chevron.down"}
            size={13}
            color={visual.tertiaryText}
          />
        </View>
      </Pressable>
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
          paddingVertical: isPhone
            ? DefaultAppStyles.GAP_VERTICAL_SMALL
            : undefined,
          flexDirection: "row",
          alignItems: "center",
          marginHorizontal: isPhone ? visual.pagePadding : 16,
          marginTop: index === 0 ? marginTop : 0,
          paddingHorizontal: isPhone ? visual.pagePadding : 16,
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
          numberOfLines={isPhone ? 2 : 1}
          style={{
            flex: 1,
            color: visual.primaryText,
            fontSize: isPhone ? AppFontSize.md : 16,
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
    count: notebookCounts?.[item.id] || 0,
    onPress: () =>
      navigation.navigate("Notebook", { id: item.id, canGoBack: true })
  }));
  const tagRows: LibraryDestination[] = tags.map((item) => ({
    key: `tag:${item.id}`,
    label: item.title,
    symbol: "number",
    count: tagCounts?.[item.id] || 0,
    onPress: () =>
      navigation.navigate("TaggedNotes", {
        type: "tag",
        id: item.id,
        canGoBack: true
      })
  }));

  // Keep the existing notebook content/actions in one fragment. Phone places
  // this primary filing destination before secondary sources; other clients
  // retain their existing order.
  const notebookSection = (
    <>
      {sectionTitle(
        "notebooks",
        strings.routes.Notebooks(),
        notebooksCollapsed,
        () =>
          AddNotebookSheet.present(
            undefined,
            undefined,
            "global",
            undefined,
            false
          )
      )}
      {notebooksCollapsed
        ? null
        : notebookRows.length
        ? notebookRows.map((item, index) =>
            row(item, index, notebookRows.length)
          )
        : row(
            {
              key: "new-notebook",
              label: strings.newNotebookRow(),
              symbol: "folder.badge.plus",
              onPress: () =>
                AddNotebookSheet.present(
                  undefined,
                  undefined,
                  "global",
                  undefined,
                  false
                )
            },
            0,
            1
          )}
    </>
  );

  /**
   * The compact account/login-status affordance that stands in for the sidebar
   * whenever it is not on screen: the signed-in name (or obfuscated e-mail), a
   * sync/login dot, and `notLoggedIn` when signed out. It is a bar item, not a
   * card: pressing it opens the existing UserSheet for login/sync/account, so
   * no Library content moves or grows. Only the leading slot is used, next to
   * the Search and compose buttons.
   */
  const accountAffordance = showAccountAffordance ? (
    <AccountAffordance />
  ) : undefined;

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
          Separate Settings and compose live in the navigation bar; the
          "Notebooks" section header's "+" (see `sectionTitle`) adds a notebook.
          Mac renders neither this list nor this bar: its source list is the
          sidebar pane and its chrome is the window's native toolbar.
        */}
        <IosNavBar
          leading={accountAffordance}
          trailing={
            <>
              <IosBarButton
                symbol="gearshape"
                accessibilityLabel={strings.routes.Settings()}
                testID="library-settings"
                onPress={() => selectAppleSection("settings")}
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
        {isPhone ? notebookSection : null}
        {destinations.map((item, index) =>
          row(item, index, destinations.length, visual.sectionSpacing)
        )}
        {!isPhone ? notebookSection : null}
        {/* An empty Tags section is hidden; tags appear once a note has one. */}
        {tagRows.length
          ? sectionTitle("tags", strings.routes.Tags(), tagsCollapsed)
          : null}
        {tagsCollapsed
          ? null
          : tagRows.map((item, index) => row(item, index, tagRows.length))}
      </ScrollView>
    </View>
  );
}
