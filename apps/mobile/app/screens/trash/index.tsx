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

import React from "react";
import { Platform } from "react-native";
import { db } from "../../common/database";
import { FloatingButton } from "../../components/container/floating-button";
import DelayLayout from "../../components/delay-layout";
import { presentDialog } from "../../components/dialog/functions";
import { Header } from "../../components/header";
import List from "../../components/list";
import { useNavigationFocus } from "../../hooks/use-navigation-focus";
import { ToastManager } from "../../services/event-manager";
import Navigation, { NavigationProps } from "../../services/navigation";
import useNavigationStore from "../../stores/use-navigation-store";
import { useSelectionStore } from "../../stores/use-selection-store";
import { useTrash, useTrashStore } from "../../stores/use-trash-store";
import SelectionHeader from "../../components/selection-header";
import { strings } from "@notesnook/intl";

/**
 * The Trash screen's own "empty trash" confirmation (the floating button and,
 * on Mac Catalyst, the Trash row's context menu in components/mac-sidebar.tsx
 * both run it).
 */
export const confirmEmptyTrash = () => {
  presentDialog({
    title: strings.clearTrash(),
    paragraph: strings.clearTrashDesc(),
    positiveText: strings.clear(),
    negativeText: strings.cancel(),
    positivePress: async () => {
      await db.trash?.clear();
      useTrashStore.getState().refresh();
      useSelectionStore.getState().clearSelection();
      ToastManager.show({
        heading: strings.trashCleared(),
        type: "success",
        context: "local"
      });
    },
    positiveType: "errorShade"
  });
};
const PLACEHOLDER_DATA = (trashCleanupInterval = 7) => ({
  title: strings.trash(),
  paragraph:
    trashCleanupInterval === -1
      ? strings.noTrashCleanupInterval()
      : trashCleanupInterval === 1
        ? strings.trashCleanupIntervalTextDaily()
        : strings.trashCleanupIntervalTextDays(trashCleanupInterval),
  loading: strings.loadingTrash()
});

export const Trash = ({ navigation, route }: NavigationProps<"Trash">) => {
  const [trash, loading] = useTrash();
  const isFocused = useNavigationFocus(navigation, {
    onFocus: () => {
      Navigation.routeNeedsUpdate(
        route.name,
        Navigation.routeUpdateFunctions[route.name]
      );
      useNavigationStore.getState().setFocusedRouteId(route.name);
      return false;
    },
    onBlur: () => false
  });

  return (
    <>
      <Header
        renderedInRoute={route.name}
        title={strings.routes.Trash()}
        // Mac window subtitle: the number of notes in the trash.
        count={trash?.placeholders?.length}
        id={route.name}
        canGoBack={Platform.OS === "ios"}
        hasSearch={true}
        menu={{
          group: "trash",
          dataType: "trash",
          selectable: true,
          hideGroupOptions: true
        }}
        onSearch={() => {
          Navigation.push("Search", {
            placeholder: strings.searchInRoute(route.name),
            type: "trash",
            title: route.name,
            route: route.name
          });
        }}
      />
      <DelayLayout wait={loading}>
        <List
          data={trash}
          dataType="trash"
          groupType="trash"
          renderedInRoute="Trash"
          loading={!isFocused}
          placeholder={PLACEHOLDER_DATA(db.settings.getTrashCleanupInterval())}
          headerTitle="Trash"
        />

        {trash && trash?.placeholders?.length !== 0 ? (
          <FloatingButton
            onPress={confirmEmptyTrash}
            testID="trash-clear"
            alwaysVisible={true}
          />
        ) : null}
      </DelayLayout>
      <SelectionHeader
        id={route.name}
        items={trash}
        type="trash"
        renderedInRoute={route.name}
      />
    </>
  );
};

export default Trash;
