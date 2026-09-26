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
import { Platform, View } from "react-native";
import { FloatingButton } from "../../components/container/floating-button";
import DelayLayout from "../../components/delay-layout";
import { Header } from "../../components/header";
import List from "../../components/list";
import SelectionHeader from "../../components/selection-header";
import { useNavigationFocus } from "../../hooks/use-navigation-focus";
import Navigation, { NavigationProps } from "../../services/navigation";
import SettingsService from "../../services/settings";
import useNavigationStore from "../../stores/use-navigation-store";
import { useNotes } from "../../stores/use-notes-store";
import { useSelectionStore } from "../../stores/use-selection-store";
import { openEditor } from "../notes/common";
import { db } from "../../common/database";
import { presentSheet } from "../../services/event-manager";
import { useIsCompactModeEnabled } from "../../hooks/use-is-compact-mode-enabled";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { IconButton } from "../../components/ui/icon-button";
import Heading from "../../components/ui/typography/heading";
import Paragraph from "../../components/ui/typography/paragraph";
import Sort from "../../components/sheets/sort";

export const Home = ({ navigation, route }: NavigationProps<"Notes">) => {
  const [notes, loading] = useNotes();
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const compactMode = useIsCompactModeEnabled("note");
  const selectionMode = useSelectionStore((state) => state.selectionMode);

  const openSearch = () => {
    Navigation.push("Search", {
      placeholder: strings.searchInRoute(route.name),
      type: "note",
      title: route.name,
      route: route.name,
      items: db.notes.all
    });
  };

  const isFocused = useNavigationFocus(navigation, {
    onFocus: (prev) => {
      Navigation.routeNeedsUpdate(
        route.name,
        Navigation.routeUpdateFunctions[route.name]
      );
      useNavigationStore.getState().setFocusedRouteId(route.name);
      return !prev?.current;
    },
    onBlur: () => false,
    delay: SettingsService.get().homepage === route.name ? 1 : -1
  });

  return (
    <>
      {Platform.OS === "ios" ? (
        <View
          style={{
            backgroundColor: visual.screenBackground,
            paddingHorizontal: visual.pagePadding,
            paddingTop: 16,
            paddingBottom: 14,
            flexDirection: "row",
            alignItems: "flex-end",
            justifyContent: "space-between"
          }}
        >
          <View style={{ flexShrink: 1 }}>
            <Heading
              size={36}
              style={{ fontWeight: "700", letterSpacing: 0.2 }}
              numberOfLines={1}
            >
              {strings.routes[route.name]()}
            </Heading>
            <Paragraph color={visual.secondaryText} style={{ marginTop: 2 }}>
              {strings.notes(notes?.length || 0)}
            </Paragraph>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <IconButton
              name="sort"
              size={23}
              color={visual.secondaryText}
              accessibilityLabel={strings.sortBy()}
              onPress={() =>
                presentSheet({
                  component: (
                    <Sort screen="Notes" dataType="note" group="home" />
                  )
                })
              }
            />
            <IconButton
              name={compactMode ? "view-list" : "view-list-outline"}
              size={22}
              color={visual.secondaryText}
              accessibilityLabel="Toggle compact note list"
              onPress={() =>
                SettingsService.set({
                  notesListMode: compactMode ? "normal" : "compact"
                })
              }
            />
            <IconButton
              name="magnify"
              size={24}
              color={visual.secondaryText}
              accessibilityLabel={strings.searchInRoute(route.name)}
              testID="search-header"
              onPress={openSearch}
            />
          </View>
        </View>
      ) : (
        <Header
          renderedInRoute={route.name}
          title={strings.routes[route.name]()}
          canGoBack={false}
          hasSearch={true}
          onSearch={openSearch}
          id={route.name}
          onPressDefaultRightButton={openEditor}
        />
      )}

      <DelayLayout wait={loading}>
        <List
          data={notes}
          dataType="note"
          groupType="home"
          renderedInRoute={route.name}
          loading={loading || !isFocused}
          headerTitle={strings.routes[route.name]()}
          placeholder={{
            title: route.name?.toLowerCase(),
            paragraph: strings.notesEmpty(),
            button: strings.createNewNote(),
            action: openEditor,
            loading: strings.loadingNotes()
          }}
        />
        {/* iOS creates notes from the bottom bar's New Note action, so the
            inline composer bar here would be a duplicate affordance. */}
        {!notes ||
        !notes.placeholders?.length ||
        selectionMode ||
        Platform.OS === "ios" ? null : (
          <FloatingButton onPress={openEditor} alwaysVisible />
        )}
      </DelayLayout>
      <SelectionHeader id={route.name} items={notes} type="note" />
    </>
  );
};

export default Home;
