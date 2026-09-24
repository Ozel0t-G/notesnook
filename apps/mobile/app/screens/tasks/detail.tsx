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
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  findNodeHandle,
  Modal,
  Platform,
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
import { TaskNotifications } from "../../services/task-notifications";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";

type ScheduledTask = Task & {
  reminderDate?: string;
  reminderTime?: string;
  urgent?: boolean;
};
type UrgentStatus = "unsupported" | "notDetermined" | "denied" | "authorized";
const urgentNotifications = TaskNotifications as typeof TaskNotifications & {
  urgentStatus(): Promise<UrgentStatus>;
  requestUrgentPermission(): Promise<UrgentStatus>;
};
type RepeatMode =
  | "never"
  | "daily"
  | "weekdays"
  | "weekends"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "halfyearly"
  | "yearly"
  | "custom";

const REPEAT_RULES: Partial<Record<RepeatMode, string>> = {
  daily: "FREQ=DAILY",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekends: "FREQ=WEEKLY;BYDAY=SA,SU",
  weekly: "FREQ=WEEKLY",
  biweekly: "FREQ=WEEKLY;INTERVAL=2",
  monthly: "FREQ=MONTHLY",
  quarterly: "FREQ=MONTHLY;INTERVAL=3",
  halfyearly: "FREQ=MONTHLY;INTERVAL=6",
  yearly: "FREQ=YEARLY"
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function calendarDate(value: Date) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
    value.getDate()
  )}`;
}

function wallTime(value: Date) {
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function dateFromCalendar(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function dateFromTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

function nextHour() {
  const value = new Date();
  value.setHours(value.getHours() + 1, 0, 0, 0);
  return value;
}

function scheduleFromTask(task: ScheduledTask) {
  // Old records are not rewritten by opening the editor. An explicit legacy
  // reminder wins over its separate due date until the domain migrates it.
  if (task.reminderDate)
    return { date: task.reminderDate, time: task.reminderTime };
  if (task.reminderAt) {
    const value = new Date(task.reminderAt);
    return { date: calendarDate(value), time: wallTime(value) };
  }
  return { date: task.dueDate, time: task.dueTime };
}

function repeatMode(rule?: string): RepeatMode {
  if (!rule) return "never";
  return (
    (Object.entries(REPEAT_RULES).find(([, value]) => value === rule)?.[0] as
      | RepeatMode
      | undefined) || "custom"
  );
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
  const [task, setTask] = React.useState<ScheduledTask>();
  const [lists, setLists] = React.useState<TaskList[]>([]);
  const [title, setTitle] = React.useState(route.params?.initialTitle || "");
  const [description, setDescription] = React.useState("");
  const [listId, setListId] = React.useState(route.params?.listId || "");
  const [reminderDate, setReminderDate] = React.useState<string>();
  const [reminderTime, setReminderTime] = React.useState<string>();
  const [urgent, setUrgent] = React.useState(false);
  const [urgentStatus, setUrgentStatus] = React.useState<UrgentStatus>();
  const [rule, setRule] = React.useState("");
  const [priority, setPriority] = React.useState<TaskPriority>("none");
  const [flagged, setFlagged] = React.useState(false);
  const [expandedPicker, setExpandedPicker] = React.useState<"date" | "time">();
  const [showLists, setShowLists] = React.useState(false);
  const [choiceSheet, setChoiceSheet] = React.useState<{
    options: string[];
    onChoose: (index: number) => void;
  }>();
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [notificationsDenied, setNotificationsDenied] = React.useState(false);
  const repeatRow = React.useRef<View>(null);
  const priorityRow = React.useRef<View>(null);

  React.useEffect(() => {
    notifee
      .getNotificationSettings()
      .then((settings) =>
        setNotificationsDenied(
          settings.authorizationStatus === AuthorizationStatus.DENIED
        )
      )
      .catch(() => {});
    urgentNotifications
      .urgentStatus()
      .then(setUrgentStatus)
      .catch(() => {
        setUrgentStatus("unsupported");
      });
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
          const scheduled = existing as ScheduledTask;
          const schedule = scheduleFromTask(scheduled);
          setTask(scheduled);
          setTitle(scheduled.title);
          setDescription(scheduled.description || "");
          setListId(scheduled.listId);
          setReminderDate(schedule.date);
          setReminderTime(schedule.time);
          setUrgent(!!scheduled.urgent);
          setRule(scheduled.recurrenceRule || "");
          setPriority(scheduled.priority);
          setFlagged(scheduled.flagged);
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
    if (rule.trim() && !reminderDate) {
      Alert.alert(strings.tasksTitle(), strings.tasksRepeatNeedsDueDate());
      return;
    }
    if (urgent && !reminderTime) {
      Alert.alert(strings.tasksTitle(), "Urgent reminders need a time.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        title: title.trim(),
        description: description.trim() || undefined,
        listId,
        reminderDate,
        reminderTime: reminderDate ? reminderTime : undefined,
        urgent: !!reminderDate && !!reminderTime && urgent,
        recurrenceRule: rule.trim() || undefined,
        priority,
        flagged
      };
      if (task) await db.tasks.update(task.id, input);
      else await db.tasks.create(input);
      navigation.goBack();
    } catch {
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
      setTask(updated as ScheduledTask);
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

  const setDateEnabled = (enabled: boolean) => {
    if (enabled) {
      setReminderDate(calendarDate(new Date()));
      setExpandedPicker("date");
    } else {
      setReminderDate(undefined);
      setReminderTime(undefined);
      setUrgent(false);
      setRule("");
      setExpandedPicker(undefined);
    }
  };

  const setTimeEnabled = (enabled: boolean) => {
    if (enabled) {
      if (!reminderDate) setReminderDate(calendarDate(new Date()));
      setReminderTime(wallTime(nextHour()));
      setExpandedPicker("time");
    } else {
      setReminderTime(undefined);
      setUrgent(false);
      if (expandedPicker === "time") setExpandedPicker(undefined);
    }
  };

  const setUrgentEnabled = async (enabled: boolean) => {
    if (!enabled) {
      setUrgent(false);
      return;
    }
    if (!reminderTime) {
      Alert.alert(
        strings.tasksTitle(),
        "Choose a reminder time before enabling Urgent."
      );
      return;
    }
    try {
      const currentStatus =
        urgentStatus || (await urgentNotifications.urgentStatus());
      const status =
        currentStatus === "notDetermined"
          ? await urgentNotifications.requestUrgentPermission()
          : currentStatus;
      setUrgentStatus(status);
      if (status === "authorized") setUrgent(true);
      else if (status === "unsupported")
        Alert.alert(
          "Urgent",
          "Alarm reminders are unavailable on this device. Standard reminders still work."
        );
      else
        Alert.alert(
          "Urgent",
          "Allow alarms in Settings to use Urgent reminders."
        );
    } catch {
      Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
    }
  };

  const repeatOptions: { mode: RepeatMode; label: string }[] = [
    { mode: "never", label: strings.never() },
    { mode: "daily", label: strings.tasksDaily() },
    { mode: "weekdays", label: "Weekdays" },
    { mode: "weekends", label: "Weekends" },
    { mode: "weekly", label: strings.tasksWeekly() },
    { mode: "biweekly", label: "Biweekly" },
    { mode: "monthly", label: strings.tasksMonthly() },
    { mode: "quarterly", label: "Every 3 Months" },
    { mode: "halfyearly", label: "Every 6 Months" },
    { mode: "yearly", label: strings.tasksYearly() },
    { mode: "custom", label: strings.tasksCustom() }
  ];
  const priorityOptions: { value: TaskPriority; label: string }[] = [
    { value: "none", label: strings.tasksPriorityNone() },
    { value: "low", label: strings.tasksPriorityLow() },
    { value: "medium", label: strings.tasksPriorityMedium() },
    { value: "high", label: strings.tasksPriorityHigh() }
  ];
  const mode = repeatMode(rule);
  const selectedList = lists.find((item) => item.id === listId);

  const showChoices = (
    options: string[],
    anchor: React.RefObject<View | null>,
    onChoose: (index: number) => void
  ) => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...options, strings.cancel()],
          cancelButtonIndex: options.length,
          ...(Platform.isPad
            ? { anchor: findNodeHandle(anchor.current) || undefined }
            : {}),
          userInterfaceStyle: isDark ? "dark" : "light"
        },
        (index) => {
          if (index < options.length) onChoose(index);
        }
      );
    } else {
      setChoiceSheet({ options, onChoose });
    }
  };

  const chooseRepeat = (next: RepeatMode) => {
    if (next !== "never" && !reminderDate)
      setReminderDate(calendarDate(new Date()));
    if (next === "never") setRule("");
    else if (next === "custom")
      setRule(mode === "custom" ? rule : "FREQ=WEEKLY;BYDAY=MO,WE,FR");
    else setRule(REPEAT_RULES[next] || "");
  };

  const group = (children: React.ReactNode) => (
    <View
      style={{
        borderRadius: visual.cardRadius,
        backgroundColor: visual.contentSurface,
        paddingHorizontal: 16,
        overflow: "hidden"
      }}
    >
      {children}
    </View>
  );
  const divider = (
    <View style={{ height: 0.5, backgroundColor: visual.separator }} />
  );
  const sectionTitle = (label: string) => (
    <Text
      style={{
        color: visual.secondaryText,
        fontSize: 14,
        fontWeight: "600",
        marginTop: 24,
        marginBottom: 9,
        marginLeft: 10
      }}
    >
      {label}
    </Text>
  );
  const actionRow = (
    label: string,
    value: string,
    icon: string,
    onPress: () => void,
    selected = false
  ) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={{ minHeight: 57, flexDirection: "row", alignItems: "center" }}
    >
      <Icon name={icon} size={22} color={visual.secondaryText} />
      <Text
        style={{
          flex: 1,
          color: visual.primaryText,
          fontSize: 16,
          marginLeft: 14
        }}
      >
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: selected ? colors.primary.accent : visual.secondaryText,
          maxWidth: "43%",
          fontSize: 15
        }}
      >
        {value}
      </Text>
      <Icon name="chevron-right" size={20} color={visual.tertiaryText} />
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
          paddingTop: 10,
          paddingBottom: 8
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={strings.back()}
          style={{ width: 46, height: 46, justifyContent: "center" }}
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
          paddingHorizontal: width >= 700 ? 28 : 20,
          paddingBottom: 90
        }}
      >
        {group(
          <>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={strings.tasksTaskTitle()}
              placeholderTextColor={visual.tertiaryText}
              accessibilityLabel={strings.tasksTaskTitle()}
              autoFocus={!taskId}
              multiline
              blurOnSubmit
              returnKeyType="done"
              onSubmitEditing={save}
              style={{
                color: visual.primaryText,
                fontSize: 23,
                fontWeight: "600",
                minHeight: 64,
                paddingTop: 12,
                paddingBottom: 10
              }}
            />
            {divider}
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder={strings.description()}
              placeholderTextColor={visual.tertiaryText}
              accessibilityLabel={strings.description()}
              multiline
              style={{
                color: visual.primaryText,
                fontSize: 15,
                minHeight: 57,
                paddingVertical: 12,
                textAlignVertical: "top"
              }}
            />
          </>
        )}

        {sectionTitle(strings.tasksReminder())}
        {group(
          <>
            <View
              style={{
                minHeight: 68,
                flexDirection: "row",
                alignItems: "center"
              }}
            >
              <Icon
                name="calendar-month-outline"
                size={22}
                color={visual.secondaryText}
              />
              <Pressable
                onPress={() => {
                  if (!reminderDate) setDateEnabled(true);
                  else
                    setExpandedPicker(
                      expandedPicker === "date" ? undefined : "date"
                    );
                }}
                accessibilityRole="button"
                accessibilityLabel={`${strings.date()}: ${
                  reminderDate
                    ? dateFromCalendar(reminderDate).toLocaleDateString()
                    : strings.tasksNone()
                }`}
                style={{ flex: 1, paddingVertical: 11, marginLeft: 14 }}
              >
                <Text style={{ color: visual.primaryText, fontSize: 16 }}>
                  {strings.date()}
                </Text>
                {reminderDate && (
                  <Text
                    style={{
                      color: colors.primary.accent,
                      fontSize: 13,
                      marginTop: 2
                    }}
                  >
                    {dateFromCalendar(reminderDate).toLocaleDateString(
                      undefined,
                      {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        year: "numeric"
                      }
                    )}
                  </Text>
                )}
              </Pressable>
              <Switch
                value={!!reminderDate}
                onValueChange={setDateEnabled}
                trackColor={{ true: colors.primary.accent }}
                accessibilityLabel={strings.date()}
              />
            </View>
            {reminderDate && expandedPicker === "date" && (
              <DateTimePicker
                value={dateFromCalendar(reminderDate)}
                mode="date"
                display={Platform.OS === "ios" ? "inline" : "default"}
                themeVariant={isDark ? "dark" : "light"}
                onChange={(_, value) => {
                  if (value) setReminderDate(calendarDate(value));
                }}
                style={{ alignSelf: "stretch" }}
              />
            )}
            {divider}
            <View
              style={{
                minHeight: 68,
                flexDirection: "row",
                alignItems: "center"
              }}
            >
              <Icon
                name="clock-outline"
                size={22}
                color={visual.secondaryText}
              />
              <Pressable
                onPress={() => {
                  if (!reminderTime) setTimeEnabled(true);
                  else
                    setExpandedPicker(
                      expandedPicker === "time" ? undefined : "time"
                    );
                }}
                accessibilityRole="button"
                accessibilityLabel={`${strings.time()}: ${
                  reminderTime || strings.tasksNone()
                }`}
                style={{ flex: 1, paddingVertical: 11, marginLeft: 14 }}
              >
                <Text style={{ color: visual.primaryText, fontSize: 16 }}>
                  {strings.time()}
                </Text>
                {reminderTime && (
                  <Text
                    style={{
                      color: colors.primary.accent,
                      fontSize: 13,
                      marginTop: 2
                    }}
                  >
                    {dateFromTime(reminderTime).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit"
                    })}
                  </Text>
                )}
              </Pressable>
              <Switch
                value={!!reminderTime}
                onValueChange={setTimeEnabled}
                trackColor={{ true: colors.primary.accent }}
                accessibilityLabel={strings.time()}
              />
            </View>
            {reminderTime && expandedPicker === "time" && (
              <DateTimePicker
                value={dateFromTime(reminderTime)}
                mode="time"
                display={Platform.OS === "ios" ? "spinner" : "default"}
                themeVariant={isDark ? "dark" : "light"}
                onChange={(_, value) => {
                  if (value) setReminderTime(wallTime(value));
                }}
                style={{ alignSelf: "stretch" }}
              />
            )}
            {divider}
            <View
              style={{
                minHeight: 68,
                flexDirection: "row",
                alignItems: "center"
              }}
            >
              <Icon
                name="alarm-light-outline"
                size={22}
                color={visual.secondaryText}
              />
              <View style={{ flex: 1, marginLeft: 14, paddingVertical: 11 }}>
                <Text style={{ color: visual.primaryText, fontSize: 16 }}>
                  Urgent
                </Text>
                <Text
                  style={{
                    color: visual.secondaryText,
                    fontSize: 12,
                    marginTop: 2
                  }}
                >
                  {urgentStatus === "unsupported"
                    ? "Alarms unavailable on this device"
                    : !reminderTime
                    ? "Choose a time to enable an alarm"
                    : "Alarm until explicitly stopped"}
                </Text>
              </View>
              <Switch
                value={urgent}
                onValueChange={setUrgentEnabled}
                disabled={!reminderTime || urgentStatus === "unsupported"}
                trackColor={{ true: colors.primary.accent }}
                accessibilityLabel="Urgent alarm"
              />
            </View>
          </>
        )}
        {reminderDate && notificationsDenied && !urgent && (
          <Pressable
            onPress={() => notifee.openNotificationSettings()}
            accessibilityRole="button"
            accessibilityLabel={strings.openSettings()}
            style={{ padding: 12 }}
          >
            <Text style={{ color: visual.secondaryText, fontSize: 13 }}>
              {strings.tasksNotificationsDisabled()}
            </Text>
            <Text
              style={{
                color: colors.primary.accent,
                fontSize: 13,
                marginTop: 4
              }}
            >
              {strings.openSettings()}
            </Text>
          </Pressable>
        )}

        {sectionTitle(strings.tasksRepeat())}
        <View ref={repeatRow} collapsable={false}>
          {group(
            actionRow(
              strings.tasksRepeat(),
              repeatOptions.find((item) => item.mode === mode)?.label ||
                strings.never(),
              "repeat",
              () =>
                showChoices(
                  repeatOptions.map((item) => item.label),
                  repeatRow,
                  (index) => chooseRepeat(repeatOptions[index].mode)
                )
            )
          )}
        </View>
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
              marginTop: 8,
              fontSize: 15
            }}
          />
        )}

        {sectionTitle(strings.tasksList())}
        {group(
          actionRow(
            strings.tasksList(),
            selectedList?.name || strings.tasksChooseList(),
            "format-list-checks",
            () => setShowLists(true),
            !!selectedList
          )
        )}

        {sectionTitle(strings.tasksPriority())}
        <View ref={priorityRow} collapsable={false}>
          {group(
            actionRow(
              strings.tasksPriority(),
              priorityOptions.find((item) => item.value === priority)?.label ||
                strings.tasksPriorityNone(),
              "exclamation",
              () =>
                showChoices(
                  priorityOptions.map((item) => item.label),
                  priorityRow,
                  (index) => setPriority(priorityOptions[index].value)
                )
            )
          )}
        </View>

        {sectionTitle(strings.tasksFlag())}
        {group(
          <View
            style={{
              minHeight: 57,
              flexDirection: "row",
              alignItems: "center"
            }}
          >
            <Icon name="flag-outline" size={22} color={visual.secondaryText} />
            <Text
              style={{
                flex: 1,
                color: visual.primaryText,
                fontSize: 16,
                marginLeft: 14
              }}
            >
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
          <View style={{ marginTop: 28, gap: 9 }}>
            {group(
              <Pressable
                onPress={toggleComplete}
                accessibilityRole="button"
                accessibilityLabel={
                  task.completed
                    ? strings.tasksUncomplete()
                    : strings.tasksComplete()
                }
                style={{ paddingVertical: 17 }}
              >
                <Text
                  style={{ color: colors.primary.accent, fontWeight: "600" }}
                >
                  {task.completed
                    ? strings.tasksUncomplete()
                    : strings.tasksComplete()}
                </Text>
              </Pressable>
            )}
            {group(
              <Pressable
                onPress={remove}
                accessibilityRole="button"
                accessibilityLabel={strings.tasksDelete()}
                style={{ paddingVertical: 17 }}
              >
                <Text
                  style={{ color: colors.error.paragraph, fontWeight: "600" }}
                >
                  {strings.tasksDelete()}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </ScrollView>

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
                  accessibilityLabel={list.name}
                  style={{
                    minHeight: 54,
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
      <Modal
        visible={!!choiceSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setChoiceSheet(undefined)}
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
              paddingHorizontal: 18,
              paddingTop: 12,
              maxHeight: "75%"
            }}
          >
            <ScrollView>
              {choiceSheet?.options.map((option, index) => (
                <Pressable
                  key={`${option}-${index}`}
                  onPress={() => {
                    choiceSheet.onChoose(index);
                    setChoiceSheet(undefined);
                  }}
                  accessibilityRole="button"
                  style={{ minHeight: 52, justifyContent: "center" }}
                >
                  <Text style={{ color: visual.primaryText, fontSize: 16 }}>
                    {option}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => setChoiceSheet(undefined)}
              accessibilityRole="button"
              accessibilityLabel={strings.cancel()}
              style={{ minHeight: 52, justifyContent: "center" }}
            >
              <Text style={{ color: colors.primary.accent, fontSize: 16 }}>
                {strings.cancel()}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
