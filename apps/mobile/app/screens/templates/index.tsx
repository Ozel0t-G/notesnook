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

import type { Note } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React, { useCallback, useEffect, useState } from "react";
import { FlatList, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { db } from "../../common/database";
import DelayLayout from "../../components/delay-layout";
import { Header } from "../../components/header";
import { openNote } from "../../components/list-items/note/wrapper";
import { Pressable } from "../../components/ui/pressable";
import Paragraph from "../../components/ui/typography/paragraph";
import { useNavigationFocus } from "../../hooks/use-navigation-focus";
import { ToastManager } from "../../services/event-manager";
import Navigation, { NavigationProps } from "../../services/navigation";
import SettingsService from "../../services/settings";
import {
  createTemplate,
  getTemplates,
  removeFromTemplates
} from "../../services/templates";
import useNavigationStore from "../../stores/use-navigation-store";
import { isMacCatalyst } from "../../utils/constants";
import { MAC_TOOLBAR_HEIGHT, macToolbarInset } from "../../utils/mac-layout";
import { showAlert } from "../../utils/mac-alert";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { templatePreview } from "../template-picker/utils";
import { removeTemplateMessage } from "./utils";

const EMPTY_TITLE = "No templates yet";
const EMPTY_PARAGRAPH = "Tap + to create one, or use Note › Save as Template.";

/**
 * Library › Templates: the management list for Note Templates.
 *
 * A template is a normal note that is archived and tagged with the internal
 * "template" tag (services/templates), so there is no collection to subscribe
 * to: the list is simply `getTemplates()` reloaded on focus and after every
 * create/remove.
 */
const Templates = ({ navigation, route }: NavigationProps<"Templates">) => {
  const { colors } = useThemeColors();
  const insets = useSafeAreaInsets();
  const [templates, setTemplates] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setTemplates(await getTemplates());
    } catch (e) {
      ToastManager.error(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useNavigationFocus(navigation, {
    onFocus: () => {
      Navigation.routeNeedsUpdate(
        route.name,
        Navigation.routeUpdateFunctions[route.name]
      );
      useNavigationStore.getState().setFocusedRouteId(route?.name);
      void refresh();
      return false;
    },
    onBlur: () => false,
    delay: SettingsService.get().homepage === route.name ? 1 : -1
  });

  const createAndOpen = useCallback(async () => {
    try {
      const noteId = await createTemplate();
      await refresh();
      const note = await db.notes.note(noteId);
      if (note) void openNote(note);
    } catch (e) {
      ToastManager.error(e as Error);
    }
  }, [refresh]);

  const confirmRemove = useCallback(
    (item: Note) => {
      showAlert(
        item.title || strings.routes.Templates(),
        removeTemplateMessage(item.title),
        [
          { text: strings.cancel(), style: "cancel" },
          {
            text: "Remove from templates",
            style: "destructive",
            onPress: async () => {
              try {
                await removeFromTemplates(item.id);
                await refresh();
                ToastManager.show({
                  heading: "Removed from templates",
                  type: "success"
                });
              } catch (e) {
                ToastManager.error(e as Error);
              }
            }
          }
        ]
      );
    },
    [refresh]
  );

  const renderItem = useCallback(
    ({ item }: { item: Note }) => {
      const preview = templatePreview(item.headline);
      return (
        <Pressable
          testID={`template-row-${item.id}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: DefaultAppStyles.GAP_VERTICAL,
            paddingHorizontal: DefaultAppStyles.GAP_SMALL
          }}
          onPress={() => void openNote(item)}
          onLongPress={() => confirmRemove(item)}
          type="plain"
        >
          <Icon
            name="file-document-outline"
            color={colors.primary.icon}
            size={AppFontSize.lg}
          />
          <View style={{ flexShrink: 1, flexGrow: 1 }}>
            <Paragraph size={AppFontSize.sm} numberOfLines={1}>
              {item.title}
            </Paragraph>
            {preview ? (
              <Paragraph
                size={AppFontSize.xxs}
                color={colors.secondary.paragraph}
                numberOfLines={1}
              >
                {preview}
              </Paragraph>
            ) : null}
          </View>
        </Pressable>
      );
    },
    [colors.primary.icon, colors.secondary.paragraph, confirmRemove]
  );

  const empty = useCallback(
    () => (
      <View style={styles.empty}>
        <Icon
          name="file-document-outline"
          size={50}
          color={colors.secondary.heading}
        />
        <Paragraph
          size={AppFontSize.sm}
          color={colors.secondary.heading}
          style={{ textAlign: "center" }}
        >
          {EMPTY_TITLE}
        </Paragraph>
        <Paragraph
          textBreakStrategy="balanced"
          color={colors.secondary.paragraph}
          style={{ textAlign: "center" }}
        >
          {EMPTY_PARAGRAPH}
        </Paragraph>
      </View>
    ),
    [colors.secondary.heading, colors.secondary.paragraph]
  );

  const isMac = isMacCatalyst();

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          // Mac's note list column starts under the window's native toolbar and
          // pads itself with its inset (see components/list). The header here
          // has no list menu, so Header itself does not apply that inset.
          paddingTop: isMac
            ? Math.max(macToolbarInset(insets.top), MAC_TOOLBAR_HEIGHT)
            : 0
        }}
      >
        <Header
          renderedInRoute={route.name}
          title={strings.routes[route.name]()}
          count={templates.length}
          canGoBack={Platform.OS === "ios"}
          id={route.name}
          rightButton={{
            name: "plus",
            accessibilityLabel: strings.routes.Templates(),
            testID: "templates-new",
            onPress: () => void createAndOpen()
          }}
        />
      </View>
      <DelayLayout wait={loading}>
        <FlatList
          data={templates}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListEmptyComponent={empty}
          contentContainerStyle={{
            paddingHorizontal: DefaultAppStyles.GAP_SMALL,
            paddingBottom: insets.bottom + 24,
            flexGrow: templates.length === 0 ? 1 : undefined
          }}
          ItemSeparatorComponent={() => (
            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: colors.primary.border,
                marginLeft: DefaultAppStyles.GAP_SMALL
              }}
            />
          )}
        />
      </DelayLayout>
    </View>
  );
};

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    minHeight: 260,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: DefaultAppStyles.GAP
  }
});

export default Templates;
