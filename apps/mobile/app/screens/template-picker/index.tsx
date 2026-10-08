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

import { LegendList } from "@legendapp/list";
import type { Note } from "@notesnook/core";
import { EditorEvents } from "@notesnook/editor-mobile/src/utils/editor-events";
import { NativeEvents } from "@notesnook/editor-mobile/src/utils/native-events";
import { useThemeColors } from "@notesnook/theme";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { db } from "../../common/database";
import { Header } from "../../components/header";
import Input from "../../components/ui/input";
import { Pressable } from "../../components/ui/pressable";
import Paragraph from "../../components/ui/typography/paragraph";
import { useNavigationFocus } from "../../hooks/use-navigation-focus";
import { ToastManager } from "../../services/event-manager";
import Navigation, { NavigationProps } from "../../services/navigation";
import {
  getTemplates,
  prepareTemplateForInsert
} from "../../services/templates";
import { isMacCatalyst } from "../../utils/constants";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { editorController } from "../editor/tiptap/utils";
import {
  filterTemplates,
  shouldAdoptTemplateTitle,
  templatePreview
} from "./utils";

const EMPTY_MESSAGE = "No templates yet. Create one under Library › Templates.";
const INSERT_FAILED_MESSAGE = "Failed to insert template. Please try again.";

const TemplatePicker = (props: NavigationProps<"TemplatePicker">) => {
  const { colors } = useThemeColors();
  const { noteId, tabId } = props.route.params;
  const [templates, setTemplates] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const inputRef = useRef<TextInput>(null);

  const refreshTemplates = useCallback(async () => {
    try {
      setTemplates(await getTemplates());
    } catch (e) {
      ToastManager.error(e as Error);
    }
  }, []);

  const onFocus = useCallback(() => {
    refreshTemplates();
    return true;
  }, [refreshTemplates]);

  useNavigationFocus(props.navigation, { focusOnInit: true, onFocus });

  const onPress = useCallback(
    async (template: Note) => {
      try {
        const note = noteId ? await db.notes.note(noteId) : undefined;
        const currentTitle = note?.title || "";
        const { title, html } = await prepareTemplateForInsert(template.id, {
          now: new Date(),
          title: currentTitle
        });

        const editor = editorController.current;
        const inserted = editor
          ? await editor.commands.insertTemplate(html, tabId)
          : false;

        // Without an editor (e.g. a locked or stale tab) or when the editor
        // refused the insertion, keep the picker open so the user can retry
        // and don't touch the note's title.
        if (!editor || !inserted) {
          ToastManager.error(new Error(INSERT_FAILED_MESSAGE));
          return;
        }

        // An untitled note takes its name from the template it was created
        // from, through the same path the editor's title input saves.
        if (noteId && shouldAdoptTemplateTitle(currentTitle)) {
          await editor.postMessage(NativeEvents.title, title, tabId);
          editor.saveContent({
            type: EditorEvents.title,
            title,
            noteId,
            tabId
          });
        }

        Navigation.goBack();
      } catch (e) {
        ToastManager.error(e as Error);
      }
    },
    [noteId, tabId]
  );

  const filteredTemplates = useMemo(
    () => filterTemplates(templates, query),
    [templates, query]
  );

  const renderTemplate = useCallback(
    ({ item }: { item: Note }) => {
      const preview = templatePreview(item.headline);
      return (
        <Pressable
          testID={`template-${item.id}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: DefaultAppStyles.GAP_VERTICAL,
            paddingHorizontal: DefaultAppStyles.GAP_SMALL
          }}
          onPress={() => onPress(item)}
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
    [colors.primary.icon, colors.secondary.paragraph, onPress]
  );

  return (
    <SafeAreaView
      // A Mac form sheet is centered over the window, not tucked under the
      // native toolbar, so it must not clear the toolbar inset Mac's full-window
      // screens pad themselves with. iPhone/iPad keep every edge.
      edges={isMacCatalyst() ? ["left", "right", "bottom"] : undefined}
      style={{
        width: "100%",
        alignSelf: "center",
        backgroundColor: colors.primary.background,
        gap: DefaultAppStyles.GAP_VERTICAL,
        flex: 1
      }}
    >
      <Header title="Templates" canGoBack macSheet />

      <View
        style={{
          paddingHorizontal: DefaultAppStyles.GAP,
          flex: 1
        }}
      >
        <Input
          button={{
            icon: "magnify",
            color: colors.primary.accent,
            size: AppFontSize.lg,
            onPress: () => {}
          }}
          testID="template-input"
          fwdRef={inputRef}
          autoCapitalize="none"
          onChangeText={(v) => setQuery(v)}
          placeholder="Search for templates"
        />

        <View style={{ flex: 1 }}>
          <LegendList
            data={filteredTemplates}
            extraData={filteredTemplates}
            keyboardShouldPersistTaps
            keyboardDismissMode="interactive"
            estimatedItemSize={50}
            renderItem={renderTemplate}
            ListEmptyComponent={
              <View
                style={{
                  width: "100%",
                  height: 200,
                  justifyContent: "center",
                  alignItems: "center"
                }}
              >
                <Icon
                  name="file-document-outline"
                  size={50}
                  color={colors.secondary.heading}
                />
                <Paragraph
                  textBreakStrategy="balanced"
                  color={colors.secondary.paragraph}
                  style={{ textAlign: "center" }}
                >
                  {EMPTY_MESSAGE}
                </Paragraph>
              </View>
            }
            ListFooterComponent={<View style={{ height: 50 }} />}
          />
        </View>
      </View>
    </SafeAreaView>
  );
};

export default TemplatePicker;
