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
import { Alert, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { DraxList, DraxProvider } from "react-native-drax";
import { SafeAreaView } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { taskListColor, taskListSymbol } from "./list-customization";

const SMART: { id: TaskSmartList; title: () => string; icon: string }[] = [
  { id: "today", title: strings.tasksToday, icon: "calendar-today" },
  { id: "scheduled", title: strings.tasksScheduled, icon: "calendar-clock" },
  { id: "all", title: strings.tasksAll, icon: "tray-full" },
  { id: "flagged", title: strings.tasksFlagged, icon: "flag-outline" },
  {
    id: "completed",
    title: strings.tasksCompleted,
    icon: "check-circle-outline"
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
  const { colors } = useThemeColors();
  const [draft, setDraft] = React.useState<TaskFavorite[]>(favorites);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (visible)
      setDraft(
        favorites.filter(
          (ref) =>
            ref.startsWith("smart:") ||
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
      <Icon
        name={SMART.find((item) => item.id === ref.slice(6))?.icon || "star"}
        size={22}
        color={colors.primary.accent}
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
      animationType="slide"
      presentationStyle="pageSheet"
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
                Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
              } finally {
                setSaving(false);
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={strings.save()}
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
              {strings.save()}
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
                  <Icon
                    name="minus-circle-outline"
                    size={22}
                    color={colors.error.paragraph}
                  />
                </Pressable>
                <Icon
                  name="drag-horizontal-variant"
                  size={24}
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
              <Icon
                name="plus-circle-outline"
                size={22}
                color={colors.primary.accent}
              />
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
