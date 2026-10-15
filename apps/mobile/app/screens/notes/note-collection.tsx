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
  EVENTS,
  FilteredSelector,
  Note,
  VirtualizedGrouping
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import React from "react";
import { BackHandler, Platform } from "react-native";
import { db } from "../../common/database";
import { FloatingButton } from "../../components/container/floating-button";
import DelayLayout from "../../components/delay-layout";
import { Header } from "../../components/header";
import List from "../../components/list";
import { PlaceholderData } from "../../components/list/empty";
import SelectionHeader from "../../components/selection-header";
import {
  eSubscribeEvent,
  eUnSubscribeEvent
} from "../../services/event-manager";
import Navigation from "../../services/navigation";
import useNavigationStore from "../../stores/use-navigation-store";
import { useSelectionStore } from "../../stores/use-selection-store";
import { eGroupOptionsUpdated } from "../../utils/events";
import { useIPadWorkspace } from "../../components/ipad-workspace-context";
import { resolveIPadCollectionLeading } from "../../utils/ipad-layout";
import { AccountAffordance } from "../../components/header/account-affordance";
import { openEditor, setOnFirstSave, setOnFirstSaveUnassigned } from "./common";

export type NoteCollectionProps = {
  /** Stable id used for selection, scroll and header state. */
  id: string;
  title: string;
  notes?: VirtualizedGrouping<Note>;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Selector backing this collection, used by the search screen. */
  selector: () => FilteredSelector<Note>;
  placeholder: PlaceholderData;
  onGoBack: () => void;
  /**
   * Monotonic re-entry token owned by `screens/library`: it is bumped whenever
   * the user re-selects this collection from the sidebar and whenever the
   * retained Library column is focused again. Neither of those remounts the
   * list, and both have to re-read it (a note saved while the editor was open
   * would otherwise keep the headline and edited time it had before the save).
   */
  refreshRevision?: number;
  /**
   * Whether the Library column that renders this collection currently owns the
   * foreground - the navigator reports the Library route focused. Only then may
   * the collection publish the id it shows as the focused route and the
   * header's New Note behaviour. A retained background column (the Library is
   * kept mounted behind a pushed Notebook / Favorites) must never take either
   * away from the screen that is actually in front of the user: doing so filed
   * a note created from that screen's header into the Inbox instead of the
   * notebook it belonged to.
   */
  ownsForeground?: boolean;
  /**
   * Reads the navigator's *current* focus for the Library route.
   *
   * `ownsForeground` is a render-time snapshot, but the ownership check that
   * matters runs in the effect cleanup, against the present: the column may
   * have lost focus (a Notebook was pushed) between publishing and cleanup. A
   * stale `true` there is exactly what used to clear a newer screen's
   * first-save context, so cleanup asks this live getter instead.
   */
  isFocused?: () => boolean;
};

/**
 * The notes list of the Library's "All Notes" and "Inbox" collections.
 *
 * It renders through the exact same list, header and composer as the Notes
 * screen (same `home` group options, so sort, date grouping and counts all
 * match) and only swaps out the underlying selector.
 */
export default function NoteCollection({
  id,
  title,
  notes,
  loading,
  refresh,
  selector,
  placeholder,
  onGoBack,
  refreshRevision,
  ownsForeground = true,
  isFocused
}: NoteCollectionProps) {
  const selectionMode = useSelectionStore((state) => state.selectionMode);
  const refreshRef = React.useRef(refresh);
  refreshRef.current = refresh;

  /**
   * The debounce timer of the next scheduled read, and the poll timer that
   * waits for the database to finish opening.
   */
  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const initTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  /**
   * Reads the list once the database is ready. The collection getters throw
   * "Database not initialized" until `db.init()` finishes, and *every* trigger
   * below - not just the initial load - can fire inside that window: the Mac
   * layout mounts this list before init, and a save/relation/sync event or the
   * owner's focus re-entry can arrive while a fresh profile is still opening.
   * A read therefore waits for the database instead of throwing (and surfacing
   * the store's pre-init error toast). The wait is the same 200 ms poll the
   * initial load has always used; a named function expression is what lets the
   * poll reference itself while `useCallback`'s empty dependency list keeps its
   * identity stable.
   */
  const readWhenReady = React.useCallback(function readWhenDatabaseReady() {
    if (db.isInitialized) {
      refreshRef.current();
      return;
    }
    initTimer.current = setTimeout(readWhenDatabaseReady, 200);
  }, []);

  /**
   * One debounced refresh for every trigger below: the database's own
   * note/relation/notebook writes, the sync-completed signal, a sort/grouping
   * change and the owner's re-entry token.
   *
   * It is debounced (300 ms) because a single save publishes several of those
   * events, and it is deliberately not hung off `eMenuItemUpdate`: a refresh
   * *emits* `eMenuItemUpdate` itself (see `stores/create-db-collection-store`),
   * so listening to it here would refresh, emit, refresh, emit ...
   */
  const scheduleRefresh = React.useCallback(() => {
    clearTimeout(refreshTimer.current);
    // A pending init poll belongs to the read this call is replacing: without
    // this the superseded wait could still fire and read once more.
    clearTimeout(initTimer.current);
    refreshTimer.current = setTimeout(readWhenReady, 300);
  }, [readWhenReady]);
  React.useEffect(
    () => () => {
      clearTimeout(refreshTimer.current);
      clearTimeout(initTimer.current);
    },
    []
  );

  /**
   * The owner's re-entry token (see `NoteCollectionProps.refreshRevision`).
   * The token applied on mount is remembered, so mounting the column does not
   * schedule a second read on top of the initial one the effect below does.
   */
  const appliedRevision = React.useRef(refreshRevision);
  React.useEffect(() => {
    if (appliedRevision.current === refreshRevision) return;
    appliedRevision.current = refreshRevision;
    scheduleRefresh();
  }, [refreshRevision, scheduleRefresh]);

  /**
   * The iPad workspace's leading slot: narrow keeps the way back to the source
   * categories, medium opens the source drawer instead of pretending there is a
   * Library to go "back" to, wide has no leading navigation at all because the
   * source list is the column right next to this one. Without a workspace this
   * is the unchanged iPhone/Android/Mac behaviour (back to the Library).
   *
   * The account affordance is added whenever the sidebar is not on screen -
   * including exactly the narrow and closed-drawer cases that also have a back
   * button, which is why `IosNavBar` renders the back button and `leading`
   * together instead of either/or.
   */
  const ipad = useIPadWorkspace();
  const leading = resolveIPadCollectionLeading(ipad?.paneMode);
  const showAccountAffordance = !!ipad && !ipad.sidebarVisible;
  const onLeadingPress =
    leading === "none"
      ? undefined
      : leading === "drawer"
      ? () => Navigation.openDrawer()
      : onGoBack;

  /**
   * Whether *this* collection currently holds the focused route id and the
   * first-save context, and the id the store held before it took them. Both are
   * captured on the publish that first takes ownership - and kept across a
   * blur/regain cycle - so cleanup can prove, rather than assume, that it is
   * still the owner before it touches anything global.
   */
  const publishedOwnership = React.useRef(false);
  const previousFocusedRouteId = React.useRef<string | undefined>(undefined);

  // New notes created from here belong to no notebook: these collections live
  // at the root, unlike the notebook screen which files the note on save.
  //
  // Ownership is only ever taken while the Library column owns the foreground.
  // A retained background column mounts this list (the iPad keeps the note
  // column laid out while a Notebook is pushed over it), and publishing there
  // overwrote the foreground Notebook's `focusedRouteId` and its first-save
  // callback, so a note created from the header was filed unassigned (Inbox)
  // instead of into the notebook. The check is reactive: when the column
  // regains focus the effect re-runs (the prop transitions) and only then takes
  // ownership.
  React.useEffect(() => {
    if (!ownsForeground) return;
    // `ownsForeground` is the render-time snapshot, and it can already be stale
    // by the time this passive effect runs: a blur (a Notebook pushed over the
    // column) landing between the render and the effect leaves the snapshot
    // `true` while the navigator is unfocused, and child effects flush before
    // the parent Library's post-subscribe re-check can correct the snapshot.
    // Read the navigator's live focus here as well - exactly as the cleanup
    // below does - so a stale snapshot cannot publish over the screen that is
    // actually in front. Rejecting the publish here is safe: if focus really
    // is (or becomes) ours, a later real focus signal transitions
    // `ownsForeground` and re-runs this effect, whereas a width change alone
    // never re-runs it.
    if (!(isFocused?.() ?? true)) return;
    // The id to restore is the one that was focused *before this instance took
    // ownership*, captured once and kept across a blur/regain cycle: a regain
    // must not treat a foreground Notebook's id as "what came before", or
    // leaving the collection later would resurrect it.
    if (!publishedOwnership.current) {
      previousFocusedRouteId.current =
        useNavigationStore.getState().focusedRouteId;
      publishedOwnership.current = true;
    }
    useNavigationStore.getState().setFocusedRouteId(id);
    setOnFirstSaveUnassigned();
    return () => {
      // Never clear the global first-save context or restore an older focus id
      // for a background mount / blur, and never overwrite a newer owner: the
      // first-save registration is not rescued by its counter afterwards (the
      // `null` branch invalidates any deferred registration synchronously), so
      // this clear is exactly what stole a Notebook's ownership. Only a
      // collection that 1) published, 2) still owns the navigator's actual
      // focus, and 3) is still the focused route id may undo its own publish.
      //
      // A blur returns *without* dropping the record: the instance has not
      // undone its publish, so if it is later unmounted while it is still the
      // owner, the cleanup below must still be able to.
      if (!publishedOwnership.current) return;
      if (!(isFocused?.() ?? true)) return;
      if (useNavigationStore.getState().focusedRouteId !== id) return;
      publishedOwnership.current = false;
      setOnFirstSave(null);
      useNavigationStore.getState().setFocusedRouteId(
        previousFocusedRouteId.current
      );
    };
  }, [id, ownsForeground, isFocused]);

  // This collection is rendered inside the Library route, so it never gets a
  // turn from `Navigation.queueRoutesForUpdate`: the queue only refreshes the
  // entry of the focused *navigable* route, and this list's ids
  // ("AllNotes"/"Inbox") are not route names. Follow the events a save actually
  // produces instead - the database's own note/relation/notebook writes (an
  // editor save updates the note row, so even a body-only edit publishes a
  // `notes` write) - so the visible rows (headline, edited time, counts) stay
  // right after create/delete/archive/restore, a note edited in the editor, and
  // a note added to or removed from a notebook.
  React.useEffect(() => {
    const subscriptions = [
      db.eventManager.subscribe(EVENTS.databaseUpdated, (event) => {
        if (
          event?.collection === "notes" ||
          event?.collection === "relations" ||
          event?.collection === "notebooks"
        )
          scheduleRefresh();
      }),
      db.eventManager.subscribe(EVENTS.syncCompleted, scheduleRefresh)
    ];
    // Sorting/grouping is stored in settings, not in the notes table.
    eSubscribeEvent(eGroupOptionsUpdated, scheduleRefresh);
    // The Mac layout can mount this list before db.init() has finished (the
    // collection getters throw "Database not initialized" until then), so the
    // first load waits for the database - through the same helper every other
    // trigger uses, and with the poll cancelled on unmount.
    clearTimeout(initTimer.current);
    readWhenReady();
    return () => {
      clearTimeout(initTimer.current);
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      eUnSubscribeEvent(eGroupOptionsUpdated, scheduleRefresh);
    };
  }, [readWhenReady, scheduleRefresh]);

  React.useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (useSelectionStore.getState().selectionMode) return false;
        onGoBack();
        return true;
      }
    );
    return () => subscription.remove();
  }, [onGoBack]);

  const openSearch = () => {
    Navigation.push("Search", {
      placeholder: strings.searchInRoute(title),
      type: "note",
      title: title,
      route: id,
      items: selector()
    });
  };

  return (
    <>
      <Header
        renderedInRoute={id}
        title={title}
        // The exact number of notes in the collection (a VirtualizedGrouping's
        // length is its row count); Mac shows it as the window subtitle.
        count={notes?.placeholders?.length}
        canGoBack={leading !== "none"}
        onLeftMenuButtonPress={onLeadingPress}
        /**
         * iPad medium: the leading control opens the source drawer, so the bar
         * must not label it "Library" - there is no Library screen the column
         * could go back to there. The narrow "back" case is left undefined so
         * the header keeps its own previous-screen title, and the action is
         * always the caller's `onGoBack`/drawer callback.
         */
        backTitle={leading === "drawer" ? strings.expandSidebar() : undefined}
        leading={
          showAccountAffordance ? (
            <AccountAffordance testID="note-collection-account" />
          ) : undefined
        }
        hasSearch={true}
        onSearch={openSearch}
        id={id}
        menu={{ group: "home", dataType: "note", selectable: true }}
        onCompose={openEditor}
      />

      <DelayLayout wait={loading}>
        <List
          data={notes}
          dataType="note"
          groupType="home"
          onRefresh={refresh}
          renderedInRoute={id}
          loading={loading}
          headerTitle={title}
          placeholder={placeholder}
        />
        {!notes ||
        !notes.placeholders?.length ||
        selectionMode ||
        Platform.OS === "ios" ? null : (
          <FloatingButton onPress={openEditor} alwaysVisible />
        )}
      </DelayLayout>
      <SelectionHeader id={id} items={notes} type="note" />
    </>
  );
}
