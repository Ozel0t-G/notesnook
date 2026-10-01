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

import type { TaskFavorite, TaskList, TaskSmartList } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { DraxList, DraxProvider } from "react-native-drax";
import { SafeAreaView } from "react-native-safe-area-context";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { SymbolTile } from "../../components/ui/symbol-tile";
import { isMacCatalyst } from "../../utils/constants";
import {
  SystemColorName,
  systemColor
} from "../../utils/ios-system-colors";
import { showAlert } from "../../utils/mac-alert";
import { taskListColor, taskListSymbol } from "./list-customization";

/** Completed is a filter of every list, not a favorite tile. */
const SMART: {
  id: TaskSmartList;
  title: () => string;
  symbol: string;
  color: SystemColorName;
}[] = [
  { id: "today", title: strings.tasksToday, symbol: "calendar", color: "blue" },
  {
    id: "scheduled",
    title: strings.tasksScheduled,
    symbol: "calendar",
    color: "red"
  },
  { id: "all", title: strings.tasksAll, symbol: "tray.fill", color: "darkGray" },
  {
    id: "flagged",
    title: strings.tasksFlagged,
    symbol: "flag.fill",
    color: "orange"
  }
];

export function FavoritesEditor({
  visible,
  favorites,
  lists,
  onClose,
  onSave
}: {
  visible: boolean;
  favorites: TaskFavorite[];
  lists: TaskList[];
  onClose: () => void;
  onSave: (items: TaskFavorite[]) => Promise<void>;
}) {
  const { colors, isDark } = useThemeColors();
  const [draft, setDraft] = React.useState<TaskFavorite[]>(favorites);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (visible)
      setDraft(
        favorites.filter(
          (ref) =>
            (ref.startsWith("smart:") &&
              SMART.some((item) => ref === `smart:${item.id}`)) ||
            lists.some((list) => ref === `list:${list.id}`)
        )
      );
  }, [visible, favorites, lists]);
  const available = [
    ...SMART.map((item) => `smart:${item.id}` as TaskFavorite),
    ...lists.map((item) => `list:${item.id}` as TaskFavorite)
  ].filter((item) => !draft.includes(item));
  const label = (ref: TaskFavorite) =>
    ref.startsWith("smart:")
      ? SMART.find((item) => item.id === ref.slice(6))?.title() || ref
      : lists.find((item) => item.id === ref.slice(5))?.name || ref;
  const symbol = (ref: TaskFavorite) =>
    ref.startsWith("smart:") ? (
      <SymbolTile
        symbol={SMART.find((item) => item.id === ref.slice(6))?.symbol || "star"}
        color={systemColor(
          SMART.find((item) => item.id === ref.slice(6))?.color || "gray",
          isDark
        )}
        shape="circle"
        size={26}
      />
    ) : (
      <TaskSymbolView
        name={taskListSymbol(
          lists.find((item) => item.id === ref.slice(5))?.symbol
        )}
        color={taskListColor(
          lists.find((item) => item.id === ref.slice(5))?.color
        )}
        size={22}
      />
    );
  return (
    <Modal
      visible={visible}
      animationType={isMacCatalyst() ? "fade" : "slide"}
      presentationStyle={isMacCatalyst() ? "formSheet" : "pageSheet"}
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.primary.background }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingVertical: 14
          }}
        >
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={strings.cancel()}
            style={{ minWidth: 70, minHeight: 44, justifyContent: "center" }}
          >
            <Text style={{ color: colors.primary.accent, fontSize: 16 }}>
              {strings.cancel()}
            </Text>
          </Pressable>
          <Text
            style={{
              flex: 1,
              textAlign: "center",
              color: colors.primary.paragraph,
              fontSize: 18,
              fontWeight: "700"
            }}
          >
            {strings.tasksEditFavorites()}
          </Text>
          <Pressable
            disabled={saving}
            onPress={async () => {
              setSaving(true);
              try {
                await onSave(draft);
                onClose();
              } catch {
                showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
              } finally {
                setSaving(false);
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={strings.tasksDone()}
            style={{
              minWidth: 70,
              minHeight: 44,
              justifyContent: "center",
              alignItems: "flex-end"
            }}
          >
            <Text
              style={{
                color: colors.primary.accent,
                fontSize: 16,
                fontWeight: "700"
              }}
            >
              {strings.tasksDone()}
            </Text>
          </Pressable>
        </View>
        <Text
          style={{
            marginHorizontal: 20,
            marginTop: 12,
            marginBottom: 10,
            color: colors.secondary.paragraph,
            fontSize: 14
          }}
        >
          {strings.tasksDragFavorites()}
        </Text>
        <DraxProvider>
          <DraxList
            style={{ flexGrow: 0, maxHeight: "46%" }}
            data={draft.map((id) => ({ id }))}
            keyExtractor={(item) => item.id}
            renderItemContent={({ item }) => (
              <View
                style={{
                  marginHorizontal: 20,
                  minHeight: 54,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  borderBottomWidth: 0.5,
                  borderColor: colors.secondary.background
                }}
              >
                {symbol(item.id)}
                <Text
                  style={{
                    flex: 1,
                    color: colors.primary.paragraph,
                    fontSize: 16
                  }}
                >
                  {label(item.id)}
                </Text>
                <Pressable
                  onPress={() =>
                    setDraft((current) =>
                      current.filter((ref) => ref !== item.id)
                    )
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`${strings.tasksRemoveFavorite()}: ${label(
                    item.id
                  )}`}
                  style={{ padding: 10 }}
                >
                  <TaskSymbolView
                    name="minus.circle.fill"
                    size={22}
                    color={systemColor("red", isDark)}
                  />
                </Pressable>
                <TaskSymbolView
                  name="line.3.horizontal"
                  size={20}
                  color={colors.secondary.paragraph}
                />
              </View>
            )}
            longPressDelay={350}
            lockItemDragsToMainAxis
            onItemReorder={({ fromIndex, toIndex }) => {
              setDraft((current) => {
                const next = [...current];
                const [item] = next.splice(fromIndex, 1);
                next.splice(toIndex, 0, item);
                return next;
              });
            }}
          />
        </DraxProvider>
        <Text
          style={{
            marginHorizontal: 20,
            marginTop: 22,
            marginBottom: 10,
            color: colors.secondary.paragraph,
            fontSize: 14
          }}
        >
          {strings.tasksAddFavorite()}
        </Text>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 30 }}
        >
          {available.map((ref) => (
            <Pressable
              key={ref}
              onPress={() => setDraft((current) => [...current, ref])}
              accessibilityRole="button"
              accessibilityLabel={`${strings.tasksAddFavorite()}: ${label(
                ref
              )}`}
              style={{
                minHeight: 52,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                borderBottomWidth: 0.5,
                borderColor: colors.secondary.background
              }}
            >
              {symbol(ref)}
              <Text
                style={{
                  flex: 1,
                  color: colors.primary.paragraph,
                  fontSize: 16
                }}
              >
                {label(ref)}
              </Text>
              <TaskSymbolView
                name="plus.circle.fill"
                size={22}
                color={systemColor("green", isDark)}
              />
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
