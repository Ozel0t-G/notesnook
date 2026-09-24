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

import { Task, TaskList, TaskPriority } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import notifee, { AuthorizationStatus } from "@notifee/react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import React from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { db } from "../../common/database";
import { NavigationProps } from "../../services/navigation";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";

type RepeatMode = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
const RRULES: Record<Exclude<RepeatMode, "none" | "custom">, string> = {
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY"
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function dateOnly(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromDateOnly(value?: string): Date {
  if (!value) return new Date();
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function fromTime(value?: string): Date {
  const date = new Date();
  const [hour, minute] = (value || "09:00").split(":").map(Number);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function repeatMode(rule?: string): RepeatMode {
  if (!rule) return "none";
  for (const [key, value] of Object.entries(RRULES)) {
    if (value === rule) return key as RepeatMode;
  }
  return "custom";
}

export default function TaskDetail({
  navigation,
  route
}: NavigationProps<"TaskDetail">) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const { width } = useWindowDimensions();
  const taskId = route.params?.taskId;
  const legacyReminderId = (
    route.params as { reminder?: { id?: string } } | undefined
  )?.reminder?.id;
  const [task, setTask] = React.useState<Task>();
  const [lists, setLists] = React.useState<TaskList[]>([]);
  const [title, setTitle] = React.useState(route.params?.initialTitle || "");
  const [description, setDescription] = React.useState("");
  const [listId, setListId] = React.useState(route.params?.listId || "");
  const [dueDate, setDueDate] = React.useState<string>();
  const [dueTime, setDueTime] = React.useState<string>();
  const [reminderAt, setReminderAt] = React.useState<number>();
  const [rule, setRule] = React.useState("");
  const [priority, setPriority] = React.useState<TaskPriority>("none");
  const [flagged, setFlagged] = React.useState(false);
  const [picker, setPicker] = React.useState<
    "dueDate" | "dueTime" | "reminderDate" | "reminderTime" | undefined
  >();
  const [showLists, setShowLists] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [notificationsDenied, setNotificationsDenied] = React.useState(false);

  React.useEffect(() => {
    notifee
      .getNotificationSettings()
      .then((settings) =>
        setNotificationsDenied(
          settings.authorizationStatus === AuthorizationStatus.DENIED
        )
      )
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [allLists, existing] = await Promise.all([
          db.taskLists.list(),
          taskId
            ? db.tasks.get(taskId)
            : legacyReminderId
              ? db.tasks
                  .list()
                  .then((tasks) =>
                    tasks.find(
                      (item) => item.legacyReminderId === legacyReminderId
                    )
                  )
              : Promise.resolve(undefined)
        ]);
        if (!active) return;
        setLists(allLists);
        if (existing) {
          setTask(existing);
          setTitle(existing.title);
          setDescription(existing.description || "");
          setListId(existing.listId);
          setDueDate(existing.dueDate);
          setDueTime(existing.dueTime);
          setReminderAt(existing.reminderAt);
          setRule(existing.recurrenceRule || "");
          setPriority(existing.priority);
          setFlagged(existing.flagged);
        } else if (taskId || legacyReminderId) {
          setNotFound(true);
        } else if (!route.params?.listId) {
          const defaultList = await db.taskLists.default();
          if (active) setListId(defaultList.id);
        }
      } catch {
        if (active)
          Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [taskId, legacyReminderId, route.params?.listId]);

  const save = async () => {
    if (!title.trim() || saving || notFound) return;
    if (rule.trim() && !dueDate) {
      Alert.alert(strings.tasksTitle(), strings.tasksRepeatNeedsDueDate());
      return;
    }
    setSaving(true);
    try {
      const input = {
        title: title.trim(),
        description: description.trim() || undefined,
        listId,
        dueDate,
        dueTime: dueDate ? dueTime : undefined,
        reminderAt,
        recurrenceRule: rule.trim() || undefined,
        priority,
        flagged
      };
      if (task) await db.tasks.update(task.id, input);
      else await db.tasks.create(input);
      navigation.goBack();
    } catch (error) {
      Alert.alert(
        strings.tasksTitle(),
        rule ? strings.tasksInvalidRecurrence() : strings.tasksCouldNotSave()
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleComplete = async () => {
    if (!task) return;
    try {
      const updated = task.completed
        ? await db.tasks.uncomplete(task.id)
        : await db.tasks.complete(task.id);
      setTask(updated);
    } catch {
      Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
    }
  };

  const remove = () => {
    if (!task) return;
    Alert.alert(strings.tasksDelete(), strings.tasksDeleteConfirm(), [
      { text: strings.cancel(), style: "cancel" },
      {
        text: strings.delete(),
        style: "destructive",
        onPress: async () => {
          try {
            await db.tasks.remove(task.id);
            navigation.goBack();
          } catch {
            Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
          }
        }
      }
    ]);
  };

  const choosePickerDate = (value: Date) => {
    switch (picker) {
      case "dueDate":
        setDueDate(dateOnly(value));
        break;
      case "dueTime":
        setDueTime(`${pad(value.getHours())}:${pad(value.getMinutes())}`);
        break;
      case "reminderDate": {
        const current = reminderAt ? new Date(reminderAt) : new Date();
        current.setFullYear(
          value.getFullYear(),
          value.getMonth(),
          value.getDate()
        );
        setReminderAt(current.getTime());
        break;
      }
      case "reminderTime": {
        const current = reminderAt ? new Date(reminderAt) : new Date();
        current.setHours(value.getHours(), value.getMinutes(), 0, 0);
        setReminderAt(current.getTime());
        break;
      }
    }
  };

  const selectedListName =
    lists.find((item) => item.id === listId)?.name || strings.tasksChooseList();
  const chooseRepeat = (option: RepeatMode) => {
    if (option !== "none" && !dueDate) setDueDate(dateOnly(new Date()));
    if (option === "none") setRule("");
    else if (option === "custom")
      setRule(mode === "custom" ? rule : "FREQ=WEEKLY;BYDAY=MO,WE,FR");
    else setRule(RRULES[option]);
  };
  const openDueDate = () => {
    if (!dueDate) setDueDate(dateOnly(new Date()));
    setPicker("dueDate");
  };
  const openDueTime = () => {
    if (!dueTime) {
      const nextHour = new Date(Date.now() + 60 * 60 * 1000);
      setDueTime(`${pad(nextHour.getHours())}:${pad(nextHour.getMinutes())}`);
    }
    setPicker("dueTime");
  };
  const openReminderDate = () => {
    if (!reminderAt) setReminderAt(Date.now() + 60 * 60 * 1000);
    setPicker("reminderDate");
  };
  const mode = repeatMode(rule);
  const priorityOptions: { value: TaskPriority; label: () => string }[] = [
    { value: "none", label: strings.tasksPriorityNone },
    { value: "low", label: strings.tasksPriorityLow },
    { value: "medium", label: strings.tasksPriorityMedium },
    { value: "high", label: strings.tasksPriorityHigh }
  ];
  const repeatOptions: { value: RepeatMode; label: () => string }[] = [
    { value: "none", label: strings.tasksNone },
    { value: "daily", label: strings.tasksDaily },
    { value: "weekly", label: strings.tasksWeekly },
    { value: "monthly", label: strings.tasksMonthly },
    { value: "yearly", label: strings.tasksYearly },
    { value: "custom", label: strings.tasksCustom }
  ];

  const section = (label: string, content: React.ReactNode) => (
    <View style={{ marginTop: 22 }}>
      <Text
        style={{
          color: visual.secondaryText,
          fontSize: 13,
          fontWeight: "600",
          marginBottom: 8
        }}
      >
        {label}
      </Text>
      {content}
    </View>
  );

  const row = (
    label: string,
    value: string,
    onPress: () => void,
    selected = true
  ) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={{
        minHeight: 52,
        flexDirection: "row",
        alignItems: "center",
        borderBottomColor: visual.separator,
        borderBottomWidth: 0.5
      }}
    >
      <Text style={{ flex: 1, color: visual.primaryText, fontSize: 16 }}>
        {label}
      </Text>
      <Text
        style={{
          color: selected ? colors.primary.accent : visual.secondaryText,
          fontSize: 15
        }}
      >
        {value}
      </Text>
      <Icon name="chevron-right" size={19} color={visual.tertiaryText} />
    </Pressable>
  );

  if (loading)
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: visual.screenBackground,
          justifyContent: "center"
        }}
      >
        <ActivityIndicator color={colors.primary.accent} />
      </View>
    );
  if (notFound)
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: visual.screenBackground,
          justifyContent: "center",
          alignItems: "center",
          padding: 24
        }}
      >
        <Text style={{ color: visual.secondaryText, fontSize: 17 }}>
          {strings.noResultsFound()}
        </Text>
        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={strings.back()}
          style={{ padding: 16 }}
        >
          <Text style={{ color: colors.primary.accent }}>{strings.back()}</Text>
        </Pressable>
      </SafeAreaView>
    );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: visual.screenBackground }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 8
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={strings.back()}
          style={{ width: 48, height: 48, justifyContent: "center" }}
        >
          <Icon name="arrow-left" color={visual.primaryText} size={25} />
        </Pressable>
        <Text
          style={{
            flex: 1,
            color: visual.primaryText,
            fontSize: 20,
            fontWeight: "700"
          }}
        >
          {task ? strings.tasksEditTask() : strings.tasksAddTask()}
        </Text>
        <Pressable
          onPress={save}
          disabled={!title.trim() || saving}
          accessibilityRole="button"
          accessibilityLabel={strings.tasksSave()}
          style={{ paddingHorizontal: 10, paddingVertical: 12 }}
        >
          <Text
            style={{
              color: title.trim() ? colors.primary.accent : visual.tertiaryText,
              fontSize: 16,
              fontWeight: "700"
            }}
          >
            {strings.save()}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          alignSelf: "center",
          width: "100%",
          maxWidth: width >= 700 ? 720 : undefined,
          paddingHorizontal: 22,
          paddingBottom: 70
        }}
      >
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={strings.tasksTaskTitle()}
          placeholderTextColor={visual.tertiaryText}
          accessibilityLabel={strings.tasksTaskTitle()}
          autoFocus={!taskId}
          multiline
          style={{
            color: visual.primaryText,
            fontSize: 24,
            fontWeight: "600",
            minHeight: 64,
            paddingVertical: 10
          }}
        />
        {section(
          strings.description(),
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={strings.description()}
            placeholderTextColor={visual.tertiaryText}
            accessibilityLabel={strings.description()}
            multiline
            style={{
              color: visual.primaryText,
              backgroundColor: visual.contentSurface,
              borderRadius: visual.controlRadius,
              minHeight: 86,
              padding: 12,
              fontSize: 16,
              textAlignVertical: "top"
            }}
          />
        )}
        {section(
          strings.tasksList(),
          row(strings.tasksList(), selectedListName, () => setShowLists(true))
        )}
        {section(
          strings.tasksDue(),
          <View
            style={{
              borderRadius: visual.controlRadius,
              backgroundColor: visual.contentSurface,
              paddingHorizontal: 14
            }}
          >
            {row(
              strings.tasksDueDate(),
              dueDate
                ? fromDateOnly(dueDate).toLocaleDateString()
                : strings.tasksNone(),
              openDueDate,
              !!dueDate
            )}
            {dueDate &&
              row(
                strings.tasksDueTime(),
                dueTime || strings.tasksNone(),
                openDueTime,
                !!dueTime
              )}
            {dueDate && (
              <Pressable
                onPress={() => {
                  setDueDate(undefined);
                  setDueTime(undefined);
                }}
                accessibilityRole="button"
                accessibilityLabel={strings.tasksNone()}
                style={{ alignSelf: "flex-end", padding: 12 }}
              >
                <Text style={{ color: colors.primary.accent }}>
                  {strings.tasksNone()}
                </Text>
              </Pressable>
            )}
            {dueTime && (
              <Pressable
                onPress={() => setDueTime(undefined)}
                accessibilityRole="button"
                accessibilityLabel={`${strings.tasksDueTime()}: ${strings.tasksNone()}`}
                style={{ alignSelf: "flex-end", padding: 12 }}
              >
                <Text style={{ color: colors.primary.accent }}>
                  {strings.tasksDueTime()}: {strings.tasksNone()}
                </Text>
              </Pressable>
            )}
          </View>
        )}
        {section(
          strings.tasksReminder(),
          <View
            style={{
              borderRadius: visual.controlRadius,
              backgroundColor: visual.contentSurface,
              paddingHorizontal: 14
            }}
          >
            {row(
              strings.tasksReminderAt(),
              reminderAt
                ? new Date(reminderAt).toLocaleDateString()
                : strings.tasksNoReminder(),
              openReminderDate,
              !!reminderAt
            )}
            {reminderAt &&
              row(
                strings.tasksDueTime(),
                new Date(reminderAt).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit"
                }),
                () => setPicker("reminderTime")
              )}
            {reminderAt && (
              <Pressable
                onPress={() => setReminderAt(undefined)}
                accessibilityRole="button"
                accessibilityLabel={strings.tasksNoReminder()}
                style={{ alignSelf: "flex-end", padding: 12 }}
              >
                <Text style={{ color: colors.primary.accent }}>
                  {strings.tasksNoReminder()}
                </Text>
              </Pressable>
            )}
          </View>
        )}
        {reminderAt && notificationsDenied && (
          <Pressable
            onPress={() => notifee.openNotificationSettings()}
            accessibilityRole="button"
            accessibilityLabel={strings.openSettings()}
            style={{
              marginTop: 10,
              padding: 12,
              borderRadius: visual.controlRadius,
              backgroundColor: visual.secondarySurface
            }}
          >
            <Text style={{ color: visual.secondaryText, fontSize: 13 }}>
              {strings.tasksNotificationsDisabled()}
            </Text>
            <Text
              style={{
                color: colors.primary.accent,
                fontSize: 13,
                fontWeight: "600",
                marginTop: 5
              }}
            >
              {strings.openSettings()}
            </Text>
          </Pressable>
        )}
        {section(
          strings.tasksRepeat(),
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {repeatOptions.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => chooseRepeat(option.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === option.value }}
                style={{
                  borderRadius: 12,
                  backgroundColor:
                    mode === option.value
                      ? visual.selectedSurface
                      : visual.contentSurface,
                  paddingHorizontal: 13,
                  paddingVertical: 10
                }}
              >
                <Text
                  style={{
                    color:
                      mode === option.value
                        ? colors.primary.accent
                        : visual.primaryText
                  }}
                >
                  {option.label()}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {mode === "custom" && (
          <TextInput
            value={rule}
            onChangeText={setRule}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
            placeholderTextColor={visual.tertiaryText}
            accessibilityLabel={strings.tasksCustom()}
            style={{
              color: visual.primaryText,
              backgroundColor: visual.contentSurface,
              borderRadius: visual.controlRadius,
              padding: 14,
              marginTop: 10
            }}
          />
        )}
        {section(
          strings.tasksPriority(),
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {priorityOptions.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => setPriority(option.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: priority === option.value }}
                style={{
                  borderRadius: 12,
                  backgroundColor:
                    priority === option.value
                      ? visual.selectedSurface
                      : visual.contentSurface,
                  paddingHorizontal: 13,
                  paddingVertical: 10
                }}
              >
                <Text
                  style={{
                    color:
                      priority === option.value
                        ? colors.primary.accent
                        : visual.primaryText
                  }}
                >
                  {option.label()}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {section(
          strings.tasksFlag(),
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: visual.contentSurface,
              padding: 13,
              borderRadius: visual.controlRadius
            }}
          >
            <Text style={{ color: visual.primaryText, fontSize: 16, flex: 1 }}>
              {strings.tasksFlag()}
            </Text>
            <Switch
              value={flagged}
              onValueChange={setFlagged}
              trackColor={{ true: colors.primary.accent }}
              accessibilityLabel={strings.tasksFlag()}
            />
          </View>
        )}
        {task && (
          <View style={{ marginTop: 30, gap: 10 }}>
            <Pressable
              onPress={toggleComplete}
              accessibilityRole="button"
              accessibilityLabel={
                task.completed
                  ? strings.tasksUncomplete()
                  : strings.tasksComplete()
              }
              style={{
                backgroundColor: visual.contentSurface,
                borderRadius: visual.controlRadius,
                padding: 16
              }}
            >
              <Text style={{ color: colors.primary.accent, fontWeight: "600" }}>
                {task.completed
                  ? strings.tasksUncomplete()
                  : strings.tasksComplete()}
              </Text>
            </Pressable>
            <Pressable
              onPress={remove}
              accessibilityRole="button"
              accessibilityLabel={strings.tasksDelete()}
              style={{
                backgroundColor: visual.contentSurface,
                borderRadius: visual.controlRadius,
                padding: 16
              }}
            >
              <Text
                style={{ color: colors.error.paragraph, fontWeight: "600" }}
              >
                {strings.tasksDelete()}
              </Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      <Modal
        visible={!!picker}
        transparent
        animationType="slide"
        onRequestClose={() => setPicker(undefined)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "flex-end",
            backgroundColor: "#0008"
          }}
        >
          <View
            style={{
              backgroundColor: visual.contentSurface,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 18
            }}
          >
            <Pressable
              onPress={() => setPicker(undefined)}
              accessibilityRole="button"
              accessibilityLabel={strings.done()}
              style={{ alignSelf: "flex-end", padding: 10 }}
            >
              <Text style={{ color: colors.primary.accent, fontWeight: "700" }}>
                {strings.done()}
              </Text>
            </Pressable>
            {picker && (
              <DateTimePicker
                value={
                  picker === "dueDate"
                    ? fromDateOnly(dueDate)
                    : picker === "dueTime"
                      ? fromTime(dueTime)
                      : reminderAt
                        ? new Date(reminderAt)
                        : new Date()
                }
                mode={
                  picker === "dueDate" || picker === "reminderDate"
                    ? "date"
                    : "time"
                }
                display="spinner"
                onChange={(_, value) => {
                  if (value) choosePickerDate(value);
                }}
                style={{ alignSelf: "center" }}
              />
            )}
          </View>
        </View>
      </Modal>
      <Modal
        visible={showLists}
        transparent
        animationType="slide"
        onRequestClose={() => setShowLists(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "flex-end",
            backgroundColor: "#0008"
          }}
        >
          <View
            style={{
              backgroundColor: visual.contentSurface,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 18,
              maxHeight: "65%"
            }}
          >
            <Text
              style={{
                color: visual.primaryText,
                fontSize: 20,
                fontWeight: "700",
                marginBottom: 12
              }}
            >
              {strings.tasksChooseList()}
            </Text>
            <ScrollView>
              {lists.map((list) => (
                <Pressable
                  key={list.id}
                  onPress={() => {
                    setListId(list.id);
                    setShowLists(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: listId === list.id }}
                  style={{
                    minHeight: 52,
                    flexDirection: "row",
                    alignItems: "center",
                    borderBottomColor: visual.separator,
                    borderBottomWidth: 0.5
                  }}
                >
                  <Text
                    style={{ flex: 1, color: visual.primaryText, fontSize: 16 }}
                  >
                    {list.name}
                  </Text>
                  {list.id === listId && (
                    <Icon
                      name="check"
                      size={22}
                      color={colors.primary.accent}
                    />
                  )}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
