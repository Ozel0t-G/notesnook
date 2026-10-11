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

import { Notebook } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Switch,
  Text,
  View,
  ViewStyle
} from "react-native";
import { DatabaseLogger, db } from "../../common/database";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { Pressable } from "../../components/ui/pressable";
import Paragraph from "../../components/ui/typography/paragraph";
import { eSendEvent } from "../../services/event-manager";
import Navigation from "../../services/navigation";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { isMacCatalyst } from "../../utils/constants";
import { eGroupOptionsUpdated, refreshNotesPage } from "../../utils/events";
import { DefaultAppStyles } from "../../utils/styles";

type NotebookGroupState = { [notebookId: string]: boolean };

/**
 * Exact copy of `MacCheckbox` from `section-item.tsx`. It is duplicated rather
 * than imported because `section-item.tsx` imports `./components`, which
 * imports this screen: importing back would create a cycle
 * (section-item -> components -> notebook-date-grouping -> section-item).
 * Keep the two visuals in sync if either changes.
 *
 * Mac Catalyst draws React Native's `Switch` as a checkbox whose empty state
 * has no visible frame in the light theme; this draws the frame from the
 * visual tokens instead. The row itself carries the switch semantics, so the
 * box is decorative.
 */
function MacCheckbox({ value }: { value: boolean }) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  return (
    <View
      style={{
        width: 18,
        height: 18,
        marginLeft: 8,
        borderRadius: 4,
        borderWidth: 1.5,
        borderColor: value ? colors.primary.accent : visual.tertiaryText,
        backgroundColor: value ? colors.primary.accent : "transparent",
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      {value ? (
        <TaskSymbolView
          name="checkmark"
          size={11}
          color={colors.static.white}
        />
      ) : null}
    </View>
  );
}

export const NotebookDateGrouping = () => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  /** Catalyst needs the custom checkbox; iPhone/iPad keep the native Switch. */
  const isMac = isMacCatalyst();
  const [notebooks, setNotebooks] = useState<Notebook[] | undefined>(undefined);
  const [grouping, setGrouping] = useState<NotebookGroupState>({});
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const allNotebooks = await db.notebooks.all.items();
        if (!mounted.current) return;
        setNotebooks(allNotebooks);
        setGrouping(
          allNotebooks.reduce<NotebookGroupState>((state, notebook) => {
            state[notebook.id] = isGroupingEnabled(notebook.id);
            return state;
          }, {})
        );
      } catch (e) {
        DatabaseLogger.error(e);
        if (mounted.current) setNotebooks([]);
      }
    })();

    return () => {
      mounted.current = false;
    };
  }, []);

  const onToggle = useCallback(
    (id: string, enabled: boolean) => {
      // Optimistic update so the switch reflects the new state immediately
      // (the row stays disabled until its own save settles).
      setGrouping((state) => ({ ...state, [id]: enabled }));
      setPendingIds((ids) => (ids.includes(id) ? ids : [...ids, id]));

      // Serialize writes so concurrent toggles cannot resolve out of order.
      saveQueue.current = saveQueue.current.then(async () => {
        try {
          const currentOptions = db.settings.getGroupOptionsById(id, "notebook");
          const updatedOptions = {
            ...currentOptions,
            groupBy: enabled ? ("default" as const) : ("none" as const)
          };
          await db.settings.setGroupOptionsById(id, "notebook", updatedOptions);
          if (!mounted.current) return;
          setTimeout(() => {
            Navigation.queueRoutesForUpdate("Notebook");
            eSendEvent(eGroupOptionsUpdated, "notes", id, "notebook");
            eSendEvent(refreshNotesPage);
          }, 1);
        } catch (e) {
          DatabaseLogger.error(e);
          if (mounted.current) {
            // Roll back to the last persisted value.
            setGrouping((state) => ({
              ...state,
              [id]: isGroupingEnabled(id)
            }));
          }
        } finally {
          if (mounted.current) {
            setPendingIds((ids) => ids.filter((pendingId) => pendingId !== id));
          }
        }
      });
    },
    []
  );

  if (notebooks === undefined) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          gap: DefaultAppStyles.GAP_VERTICAL,
          paddingHorizontal: DefaultAppStyles.GAP,
          width: "100%"
        }}
      >
        <ActivityIndicator size="small" color={colors.primary.accent} />
        <Paragraph color={colors.secondary.paragraph}>
          {strings.loading()}
        </Paragraph>
      </View>
    );
  }

  if (notebooks.length === 0) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: DefaultAppStyles.GAP * 2,
          width: "100%"
        }}
      >
        <Paragraph color={colors.secondary.paragraph}>
          {strings.emptyPlaceholders("notebook")}
        </Paragraph>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: visual.pagePadding,
        paddingVertical: visual.pagePadding,
        paddingBottom: 50,
        width: "100%",
        minHeight: "100%"
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          color: visual.secondaryText,
          fontSize: 13,
          marginLeft: 16,
          marginBottom: 7,
          textTransform: "uppercase"
        }}
      >
        {strings.groupBy()}
      </Text>
      <View
        style={{
          backgroundColor: visual.contentSurface,
          borderRadius: visual.controlRadius,
          overflow: "hidden"
        }}
      >
        {notebooks.map((notebook, index) => {
          const value = grouping[notebook.id] ?? false;
          const disabled = pendingIds.includes(notebook.id);
          const isLast = index === notebooks.length - 1;
          const rowStyle: ViewStyle = {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: DefaultAppStyles.GAP,
            width: "100%",
            minHeight: 48,
            paddingLeft: 16,
            paddingRight: 16,
            paddingVertical: 9,
            ...(isLast
              ? {}
              : {
                  borderBottomWidth: 0.5,
                  borderBottomColor: visual.separator
                })
          };

          if (isMac) {
            /**
             * Catalyst: one switch action per row. The native `Switch` is not
             * rendered at all (its empty frame is invisible in the light
             * theme, and leaving it mounted would keep a second hit target /
             * a11y element alive); the row itself is the switch and the
             * checkbox is decorative.
             */
            return (
              <Pressable
                key={notebook.id}
                disabled={disabled}
                noborder
                customColor="transparent"
                accessibilityRole="switch"
                accessibilityLabel={notebook.title}
                accessibilityState={{ checked: value, disabled }}
                onPress={() => onToggle(notebook.id, !value)}
                style={rowStyle}
              >
                <Paragraph
                  style={{ flex: 1 }}
                  color={visual.primaryText}
                  numberOfLines={1}
                  accessible={false}
                >
                  {notebook.title}
                </Paragraph>
                <MacCheckbox value={value} />
              </Pressable>
            );
          }

          return (
            <View key={notebook.id} style={rowStyle}>
              <Paragraph
                style={{ flex: 1 }}
                color={visual.primaryText}
                numberOfLines={1}
              >
                {notebook.title}
              </Paragraph>
              <Switch
                value={value}
                onValueChange={(enabled) => onToggle(notebook.id, enabled)}
                disabled={disabled}
                trackColor={{ true: colors.primary.accent }}
                accessibilityLabel={notebook.title}
                accessibilityState={{ checked: value, disabled }}
              />
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
};

function isGroupingEnabled(notebookId: string) {
  return (
    db.settings.getGroupOptionsById(notebookId, "notebook").groupBy !== "none"
  );
}
