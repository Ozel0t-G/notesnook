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

import { TASK_LIST_SYMBOLS, type TaskList } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { isMacCatalyst } from "../../utils/constants";
import { showAlert } from "../../utils/mac-alert";

import {
  TASK_LIST_COLORS as COLORS,
  taskListColor,
  taskListSymbol
} from "./list-appearance";

export { taskListColor, taskListSymbol };

const SYMBOLS = TASK_LIST_SYMBOLS;

export function ListCustomization({
  visible,
  list,
  onClose,
  onSave
}: {
  visible: boolean;
  list?: TaskList;
  onClose: () => void;
  onSave: (input: {
    name: string;
    symbol: string;
    color: string;
  }) => Promise<void>;
}) {
  const { colors } = useThemeColors();
  const [name, setName] = React.useState("");
  const [symbol, setSymbol] = React.useState("list.bullet");
  const [color, setColor] = React.useState("blue");
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (!visible) return;
    setName(list?.name || "");
    setSymbol(taskListSymbol(list?.symbol));
    setColor(list?.color || "blue");
  }, [visible, list]);
  const accent = taskListColor(color);

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
            style={{ minWidth: 65, minHeight: 44, justifyContent: "center" }}
          >
            <Text style={{ color: colors.primary.accent, fontSize: 16 }}>
              {strings.cancel()}
            </Text>
          </Pressable>
          <Text
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: 18,
              fontWeight: "700",
              color: colors.primary.paragraph
            }}
          >
            {list ? strings.tasksEditList() : strings.tasksNewList()}
          </Text>
          <Pressable
            onPress={async () => {
              if (!name.trim() || saving) return;
              setSaving(true);
              try {
                await onSave({ name: name.trim(), symbol, color });
                onClose();
              } catch {
                showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
              } finally {
                setSaving(false);
              }
            }}
            disabled={!name.trim() || saving}
            accessibilityRole="button"
            accessibilityLabel={strings.save()}
            style={{
              minWidth: 65,
              minHeight: 44,
              justifyContent: "center",
              alignItems: "flex-end"
            }}
          >
            <Text
              style={{
                color: name.trim()
                  ? colors.primary.accent
                  : colors.secondary.paragraph,
                fontWeight: "700",
                fontSize: 16
              }}
            >
              {strings.save()}
            </Text>
          </Pressable>
        </View>
        <ScrollView
          testID="task-list-customization-scroll"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, paddingBottom: 50 }}
        >
          <View style={{ alignItems: "center", paddingVertical: 22 }}>
            <View
              style={{
                width: 74,
                height: 74,
                borderRadius: 22,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: accent
              }}
            >
              <TaskSymbolView
                name={symbol}
                color="#FFFFFF"
                size={38}
                accessibilityLabel={symbol}
              />
            </View>
            <Text
              style={{
                marginTop: 12,
                fontSize: 18,
                fontWeight: "700",
                color: colors.primary.paragraph
              }}
            >
              {name.trim() || strings.tasksNewList()}
            </Text>
          </View>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={strings.tasksEnterListName()}
            accessibilityLabel={strings.tasksEnterListName()}
            returnKeyType="done"
            style={{
              color: colors.primary.paragraph,
              backgroundColor: colors.secondary.background,
              borderRadius: 14,
              paddingHorizontal: 16,
              minHeight: 52,
              fontSize: 17
            }}
          />
          <Text
            style={{
              color: colors.secondary.paragraph,
              fontWeight: "700",
              fontSize: 14,
              marginTop: 28,
              marginBottom: 12
            }}
          >
            {strings.tasksListIcon()}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9 }}>
            {SYMBOLS.map((item) => (
              <Pressable
                key={item}
                onPress={() => setSymbol(item)}
                accessibilityRole="button"
                accessibilityLabel={item.replace(/[.\d]/g, " ").trim()}
                accessibilityState={{ selected: symbol === item }}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 15,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor:
                    symbol === item ? accent : colors.secondary.background
                }}
              >
                <TaskSymbolView
                  name={item}
                  color={symbol === item ? "#FFFFFF" : colors.primary.paragraph}
                  size={25}
                />
              </Pressable>
            ))}
          </View>
          <Text
            style={{
              color: colors.secondary.paragraph,
              fontWeight: "700",
              fontSize: 14,
              marginTop: 28,
              marginBottom: 12
            }}
          >
            {strings.tasksListColor()}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
            {COLORS.map(([label, hex]) => (
              <Pressable
                key={label}
                onPress={() => setColor(label)}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ selected: color === label }}
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  backgroundColor: hex,
                  borderWidth: color === label ? 3 : 0,
                  borderColor: colors.primary.paragraph,
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                {color === label && (
                  <Text
                    style={{
                      color: "#FFFFFF",
                      fontWeight: "800",
                      fontSize: 20
                    }}
                  >
                    ✓
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
