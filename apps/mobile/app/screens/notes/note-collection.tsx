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
  onGoBack
}: NoteCollectionProps) {
  const selectionMode = useSelectionStore((state) => state.selectionMode);
  const refreshRef = React.useRef(refresh);
  refreshRef.current = refresh;

  // New notes created from here belong to no notebook: these collections live
  // at the root, unlike the notebook screen which files the note on save.
  React.useEffect(() => {
    setOnFirstSaveUnassigned();
    const previousFocusedRouteId = useNavigationStore.getState().focusedRouteId;
    useNavigationStore.getState().setFocusedRouteId(id);
    return () => {
      setOnFirstSave(null);
      useNavigationStore.getState().setFocusedRouteId(previousFocusedRouteId);
    };
  }, [id]);

  // This collection is rendered inside the Library route, so it never gets a
  // turn from `Navigation.queueRoutesForUpdate`. Follow the database directly
  // instead so counts stay right after create/delete/archive/restore and after
  // a note is added to or removed from a notebook.
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refreshRef.current(), 300);
    };
    const subscriptions = [
      db.eventManager.subscribe(EVENTS.databaseUpdated, (event) => {
        if (
          event?.collection === "notes" ||
          event?.collection === "relations" ||
          event?.collection === "notebooks"
        )
          schedule();
      }),
      db.eventManager.subscribe(EVENTS.syncCompleted, schedule)
    ];
    // Sorting/grouping is stored in settings, not in the notes table.
    eSubscribeEvent(eGroupOptionsUpdated, schedule);
    // The Mac layout can mount this list before db.init() has finished (the
    // collection getters throw "Database not initialized" until then), so the
    // first load waits for the database.
    let initTimer: ReturnType<typeof setTimeout> | undefined;
    const loadWhenReady = () => {
      if (db.isInitialized) {
        refreshRef.current();
        return;
      }
      initTimer = setTimeout(loadWhenReady, 200);
    };
    loadWhenReady();
    return () => {
      clearTimeout(initTimer);
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      eUnSubscribeEvent(eGroupOptionsUpdated, schedule);
    };
  }, []);

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
        canGoBack={true}
        onLeftMenuButtonPress={onGoBack}
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
