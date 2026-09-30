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

import {
  Task,
  TaskList,
  TaskPriority,
  taskReminderSchedule
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import notifee, { AuthorizationStatus } from "@notifee/react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import React from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  findNodeHandle,
  Keyboard,
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
import { db } from "../../common/database";
import { ToastManager } from "../../services/event-manager";
import { isMacCatalyst } from "../../utils/constants";
import { NavigationProps } from "../../services/navigation";
import { openAppNotificationSettings } from "../../services/notification-settings";
import { TaskNotifications } from "../../services/task-notifications";
import {
  requestUrgentPermission as requestNativeUrgentPermission,
  urgentStatus as nativeUrgentStatus,
  type UrgentAlarmStatus
} from "../../services/task-alarms";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { MenuButton, NativeMenuItem } from "../../components/native-menu";
import { SymbolTile } from "../../components/ui/symbol-tile";
import { systemColor } from "../../utils/ios-system-colors";
import { taskListColor, taskListSymbol } from "./list-customization";

type ScheduledTask = Task & {
  reminderDate?: string;
  reminderTime?: string;
  urgent?: boolean;
};
type UrgentStatus = UrgentAlarmStatus;
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
type CustomFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

function customRule(
  frequency: CustomFrequency,
  interval: string,
  weekdays: string[]
) {
  const every = Math.max(1, Math.min(365, Number.parseInt(interval, 10) || 1));
  return `FREQ=${frequency};INTERVAL=${every}${
    frequency === "WEEKLY" && weekdays.length
      ? `;BYDAY=${weekdays.join(",")}`
      : ""
  }`;
}

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
  return taskReminderSchedule(task);
}

function repeatMode(rule?: string): RepeatMode {
  if (!rule) return "never";
  return (
    (Object.entries(REPEAT_RULES).find(([, value]) => value === rule)?.[0] as
      | RepeatMode
      | undefined) || "custom"
  );
}

type Snapshot = {
  title: string;
  description: string;
  listId: string;
  reminderDate?: string;
  reminderTime?: string;
  urgent: boolean;
  rule: string;
  priority: TaskPriority;
  flagged: boolean;
};

function snapshotKey(value: Snapshot) {
  return JSON.stringify({
    ...value,
    title: value.title.trim(),
    description: value.description.trim()
  });
}

/** Explains what an Urgent reminder will actually do, from the live AlarmKit status. */
export function urgentExplanation(
  status: UrgentStatus | undefined,
  hasTime: boolean
) {
  if (!hasTime) return strings.tasksUrgentTimeRequired();
  switch (status) {
    case "authorized":
      return strings.tasksUrgentAlarmAuthorized();
    case "denied":
      return strings.tasksUrgentAlarmDenied();
    case "unsupported":
      return strings.tasksUrgentAlarmUnsupported();
    default:
      return strings.tasksUrgentAlarmNotDetermined();
  }
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
  const [reminderDate, setReminderDate] = React.useState<string | undefined>(
    route.params?.initialDate
  );
  const [reminderTime, setReminderTime] = React.useState<string | undefined>(
    route.params?.initialDate ? route.params?.initialTime : undefined
  );
  const [urgent, setUrgent] = React.useState(false);
  const [urgentStatus, setUrgentStatus] = React.useState<UrgentStatus>();
  const [rule, setRule] = React.useState("");
  const [customFrequency, setCustomFrequency] =
    React.useState<CustomFrequency>("WEEKLY");
  const [customInterval, setCustomInterval] = React.useState("1");
  const [customWeekdays, setCustomWeekdays] = React.useState<string[]>([
    "MO",
    "WE",
    "FR"
  ]);
  const [priority, setPriority] = React.useState<TaskPriority>("none");
  const [flagged, setFlagged] = React.useState(
    !!route.params?.initialFlagged
  );
  const [expandedPicker, setExpandedPicker] = React.useState<"date" | "time">();
  const [showLists, setShowLists] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [notificationsDenied, setNotificationsDenied] = React.useState(false);
  const initialSnapshot = React.useRef<string | undefined>(undefined);
  const allowLeave = React.useRef(false);
  const cancelButton = React.useRef<View>(null);
  const deleteButton = React.useRef<View>(null);

  const refreshPermissions = React.useCallback(() => {
    notifee
      .getNotificationSettings()
      .then((settings) =>
        setNotificationsDenied(
          settings.authorizationStatus === AuthorizationStatus.DENIED
        )
      )
      .catch(() => {});
    nativeUrgentStatus()
      .then(setUrgentStatus)
      .catch(() => {
        setUrgentStatus("unsupported");
      });
  }, []);

  React.useEffect(() => {
    refreshPermissions();
    // Returning from the Settings app after "Allow Alarms" must update the
    // explanation below the Urgent switch.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshPermissions();
    });
    return () => subscription.remove();
  }, [refreshPermissions]);

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
          if (scheduled.recurrenceRule) {
            const freq = /(?:^|;)FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.exec(
              scheduled.recurrenceRule
            )?.[1] as CustomFrequency | undefined;
            if (freq) setCustomFrequency(freq);
            setCustomInterval(
              /(?:^|;)INTERVAL=(\d+)/.exec(scheduled.recurrenceRule)?.[1] || "1"
            );
            setCustomWeekdays(
              /(?:^|;)BYDAY=([A-Z,]+)/
                .exec(scheduled.recurrenceRule)?.[1]
                ?.split(",") || []
            );
          }
          setPriority(scheduled.priority);
          setFlagged(scheduled.flagged);
          initialSnapshot.current = snapshotKey({
            title: scheduled.title,
            description: scheduled.description || "",
            listId: scheduled.listId,
            reminderDate: schedule.date,
            reminderTime: schedule.time,
            urgent: !!scheduled.urgent,
            rule: scheduled.recurrenceRule || "",
            priority: scheduled.priority,
            flagged: scheduled.flagged
          });
        } else if (taskId || legacyReminderId) {
          setNotFound(true);
        } else {
          let initialList = route.params?.listId || "";
          if (!initialList) {
            const defaultList = await db.taskLists.default();
            if (!active) return;
            initialList = defaultList.id;
            setListId(initialList);
          }
          // A new Task counts as changed as soon as anything was entered,
          // including a title carried over from Quick Add.
          initialSnapshot.current = snapshotKey({
            title: "",
            description: "",
            listId: initialList,
            urgent: false,
            rule: "",
            priority: "none",
            flagged: false
          });
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

  const currentSnapshot = snapshotKey({
    title,
    description,
    listId,
    reminderDate,
    reminderTime,
    urgent,
    rule,
    priority,
    flagged
  });
  const dirty =
    !loading &&
    !notFound &&
    initialSnapshot.current !== undefined &&
    currentSnapshot !== initialSnapshot.current;
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;

  // Swiping the sheet down must not silently throw away edits
  // (isModalInPresentation on iOS).
  React.useEffect(() => {
    navigation.setOptions({ gestureEnabled: !dirty });
  }, [navigation, dirty]);

  const leave = React.useCallback(() => {
    allowLeave.current = true;
    navigation.goBack();
  }, [navigation]);

  const confirmDiscard = React.useCallback(
    (onDiscard: () => void) => {
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: strings.tasksDiscardChangesTitle(),
            options: [strings.tasksDiscardChanges(), strings.tasksKeepEditing()],
            destructiveButtonIndex: 0,
            cancelButtonIndex: 1,
            // An action sheet is a popover on the wide layouts, which UIKit
            // anchors to a source view. Mac Catalyst needs that anchor too now
            // that it draws with the Mac interface (`Platform.isPad` is false
            // there); without it the popover has nothing to point at.
            ...(Platform.isPad || isMacCatalyst()
              ? { anchor: findNodeHandle(cancelButton.current) || undefined }
              : {}),
            userInterfaceStyle: isDark ? "dark" : "light"
          },
          (index) => {
            if (index === 0) onDiscard();
          }
        );
        return;
      }
      Alert.alert(strings.tasksDiscardChangesTitle(), undefined, [
        { text: strings.tasksKeepEditing(), style: "cancel" },
        {
          text: strings.tasksDiscardChanges(),
          style: "destructive",
          onPress: onDiscard
        }
      ]);
    },
    [isDark]
  );

  // Any other way out (hardware back, programmatic navigation) asks too.
  React.useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (allowLeave.current || !dirtyRef.current) return;
        event.preventDefault();
        confirmDiscard(() => {
          allowLeave.current = true;
          navigation.dispatch(event.data.action);
        });
      }),
    [navigation, confirmDiscard]
  );

  const cancel = () => {
    if (!dirty) {
      leave();
      return;
    }
    confirmDiscard(leave);
  };

  const save = async () => {
    if (!title.trim() || saving || notFound) return;
    if (rule.trim() && !reminderDate) {
      Alert.alert(strings.tasksTitle(), strings.tasksRepeatNeedsDueDate());
      return;
    }
    if (urgent && !reminderTime) {
      Alert.alert(strings.tasksTitle(), strings.tasksUrgentNeedsTime());
      return;
    }
    if (task && !dirty) {
      leave();
      return;
    }
    setSaving(true);
    try {
      if (reminderDate && (!urgent || urgentStatus !== "authorized"))
        await TaskNotifications.requestPermission().catch(() => false);
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
      leave();
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
    const run = async () => {
      try {
        await db.tasks.remove(task.id);
        leave();
      } catch {
        Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: strings.tasksDeleteConfirm(),
          options: [strings.tasksDelete(), strings.cancel()],
          destructiveButtonIndex: 0,
          cancelButtonIndex: 1,
          // See the discard sheet above: iPad and Mac present popovers.
          ...(Platform.isPad || isMacCatalyst()
            ? { anchor: findNodeHandle(deleteButton.current) || undefined }
            : {}),
          userInterfaceStyle: isDark ? "dark" : "light"
        },
        (index) => {
          if (index === 0) void run();
        }
      );
      return;
    }
    Alert.alert(strings.tasksDelete(), strings.tasksDeleteConfirm(), [
      { text: strings.cancel(), style: "cancel" },
      { text: strings.delete(), style: "destructive", onPress: run }
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
      Alert.alert(strings.tasksTitle(), strings.tasksUrgentChooseTime());
      return;
    }
    try {
      const currentStatus = urgentStatus || (await nativeUrgentStatus());
      const status =
        currentStatus === "notDetermined"
          ? await requestNativeUrgentPermission()
          : currentStatus;
      setUrgentStatus(status);
      if (status === "authorized") setUrgent(true);
      else if (status === "unsupported")
        Alert.alert(strings.tasksUrgent(), strings.tasksUrgentUnavailable());
      else
        Alert.alert(strings.tasksUrgent(), strings.tasksUrgentAlarmDenied(), [
          { text: strings.cancel(), style: "cancel" },
          { text: strings.tasksAllowAlarms(), onPress: openAlarmSettings }
        ]);
    } catch {
      Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
    }
  };

  const openAlarmSettings = async () => {
    try {
      await openAppNotificationSettings();
    } catch (e) {
      ToastManager.error(
        e as Error,
        strings.tasksNotificationsSettingsError(),
        "local"
      );
    }
  };

  const repeatOptions: { mode: RepeatMode; label: string }[] = [
    { mode: "never", label: strings.never() },
    { mode: "daily", label: strings.tasksDaily() },
    { mode: "weekdays", label: strings.tasksWeekdays() },
    { mode: "weekends", label: strings.tasksWeekends() },
    { mode: "weekly", label: strings.tasksWeekly() },
    { mode: "biweekly", label: strings.tasksBiweekly() },
    { mode: "monthly", label: strings.tasksMonthly() },
    { mode: "quarterly", label: strings.tasksEveryThreeMonths() },
    { mode: "halfyearly", label: strings.tasksEverySixMonths() },
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

  const chooseRepeat = (next: RepeatMode) => {
    if (next !== "never" && !reminderDate)
      setReminderDate(calendarDate(new Date()));
    if (next === "never") setRule("");
    else if (next === "custom")
      setRule(
        mode === "custom"
          ? rule
          : customRule(customFrequency, customInterval, customWeekdays)
      );
    else setRule(REPEAT_RULES[next] || "");
  };

  // Repeat groups mirror Reminders: never · days · weeks · months/years · custom.
  const repeatGroups: RepeatMode[][] = [
    ["never"],
    ["daily", "weekdays", "weekends"],
    ["weekly", "biweekly"],
    ["monthly", "quarterly", "halfyearly", "yearly"],
    ["custom"]
  ];
  const repeatMenu: NativeMenuItem[] = repeatGroups.map((group, index) => ({
    title: "",
    inline: true,
    id: `repeat-group-${index}`,
    children: group.map((value) => ({
      id: value,
      title: repeatOptions.find((item) => item.mode === value)?.label || value,
      checked: mode === value
    }))
  }));
  const priorityMenu: NativeMenuItem[] = [
    {
      title: "",
      inline: true,
      children: [
        {
          id: "none",
          title: strings.tasksPriorityNone(),
          checked: priority === "none"
        }
      ]
    },
    {
      title: "",
      inline: true,
      children: priorityOptions
        .filter((item) => item.value !== "none")
        .map((item) => ({
          id: item.value,
          title: item.label,
          checked: priority === item.value
        }))
    }
  ];

  const group = (children: React.ReactNode, marginTop = 20) => (
    <View
      style={{
        marginTop,
        borderRadius: visual.cardRadius,
        backgroundColor: visual.contentSurface,
        overflow: "hidden"
      }}
    >
      {children}
    </View>
  );
  const divider = (
    <View
      style={{ height: 0.5, marginLeft: 60, backgroundColor: visual.separator }}
    />
  );

  const rowLabel = (label: string, subtitle?: string) => (
    <View style={{ flex: 1, marginLeft: 14, paddingVertical: 10 }}>
      <Text style={{ color: visual.primaryText, fontSize: 17 }}>{label}</Text>
      {subtitle ? (
        <Text
          style={{ color: colors.primary.accent, fontSize: 14, marginTop: 1 }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  /**
   * One row = one accessibility element. The label area expands the picker,
   * the switch area (a generous 44 pt target) toggles. The UISwitch itself
   * does not take touches so a tap anywhere near it always registers.
   */
  const toggleRow = ({
    symbol,
    tint,
    label,
    subtitle,
    value,
    onValueChange,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityActions,
    onAccessibilityAction
  }: {
    symbol: string;
    tint: string;
    label: string;
    subtitle?: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityActions?: { name: string; label: string }[];
    onAccessibilityAction?: (name: string) => void;
  }) => (
    <View
      accessible
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityValue={subtitle ? { text: subtitle } : undefined}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityActions={[
        { name: "activate", label },
        ...(accessibilityActions || [])
      ]}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === "activate") {
          if (!disabled) onValueChange(!value);
        } else onAccessibilityAction?.(name);
      }}
      style={{
        minHeight: 52,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 16
      }}
    >
      <Pressable
        onPress={onPress || (() => !disabled && onValueChange(!value))}
        style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
      >
        <SymbolTile symbol={symbol} color={tint} />
        {rowLabel(label, subtitle)}
      </Pressable>
      <Pressable
        onPress={() => !disabled && onValueChange(!value)}
        hitSlop={4}
        style={{
          minHeight: 52,
          paddingLeft: 10,
          paddingRight: 16,
          justifyContent: "center"
        }}
      >
        <View pointerEvents="none">
          <Switch
            value={value}
            disabled={disabled}
            trackColor={{ true: colors.primary.accent }}
            importantForAccessibility="no"
            accessibilityElementsHidden
          />
        </View>
      </Pressable>
    </View>
  );

  const valueRow = ({
    symbol,
    tint,
    tile,
    label,
    value,
    onPress,
    menu,
    onMenuSelect
  }: {
    symbol?: string;
    tint?: string;
    tile?: React.ReactNode;
    label: string;
    value: string;
    onPress?: () => void;
    menu?: NativeMenuItem[];
    onMenuSelect?: (id: string) => void;
  }) => {
    const content = (
      <View
        style={{
          minHeight: 52,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16
        }}
      >
        {tile || <SymbolTile symbol={symbol!} color={tint!} />}
        {rowLabel(label)}
        <Text
          numberOfLines={1}
          style={{
            color: visual.secondaryText,
            maxWidth: "50%",
            fontSize: 17,
            marginRight: 6
          }}
        >
          {value}
        </Text>
        <TaskSymbolView
          name={menu ? "chevron.up.chevron.down" : "chevron.right"}
          size={menu ? 15 : 13}
          color={visual.tertiaryText}
        />
      </View>
    );
    if (menu && onMenuSelect && Platform.OS === "ios")
      return (
        <MenuButton
          items={menu}
          accessibilityLabel={`${label}: ${value}`}
          onSelect={onMenuSelect}
        >
          {content}
        </MenuButton>
      );
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
      >
        {content}
      </Pressable>
    );
  };

  const header = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 8,
        minHeight: 56
      }}
    >
      <Pressable
        ref={cancelButton}
        onPress={cancel}
        accessibilityRole="button"
        accessibilityLabel={strings.cancel()}
        style={{ paddingHorizontal: 10, paddingVertical: 12, minWidth: 80 }}
      >
        <Text style={{ color: colors.primary.accent, fontSize: 17 }}>
          {strings.cancel()}
        </Text>
      </Pressable>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{
          flex: 1,
          textAlign: "center",
          color: visual.primaryText,
          fontSize: 17,
          fontWeight: "600"
        }}
      >
        {task ? strings.tasksDetails() : strings.tasksNewTask()}
      </Text>
      <Pressable
        onPress={save}
        disabled={!title.trim() || saving}
        accessibilityRole="button"
        accessibilityLabel={strings.tasksDone()}
        accessibilityState={{ disabled: !title.trim() || saving }}
        style={{
          paddingHorizontal: 10,
          paddingVertical: 12,
          minWidth: 80,
          alignItems: "flex-end"
        }}
      >
        {saving ? (
          <ActivityIndicator color={colors.primary.accent} />
        ) : (
          <Text
            style={{
              color: title.trim() ? colors.primary.accent : visual.tertiaryText,
              fontSize: 17,
              fontWeight: "600"
            }}
          >
            {task || !route.params?.initialTitle
              ? strings.tasksDone()
              : strings.tasksAddTask()}
          </Text>
        )}
      </Pressable>
    </View>
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
      <View
        style={{
          flex: 1,
          backgroundColor: visual.screenBackground,
          justifyContent: "center",
          alignItems: "center",
          padding: 24
        }}
      >
        <Text style={{ color: visual.secondaryText, fontSize: 17 }}>
          {strings.tasksNoLongerAvailable()}
        </Text>
        <Pressable
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel={strings.close()}
          style={{ padding: 16 }}
        >
          <Text style={{ color: colors.primary.accent, fontSize: 17 }}>
            {strings.close()}
          </Text>
        </Pressable>
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: visual.screenBackground }}>
      {header}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          alignSelf: "center",
          width: "100%",
          maxWidth: width >= 700 ? 720 : undefined,
          paddingHorizontal: width >= 700 ? 28 : 16,
          paddingBottom: 40
        }}
      >
        {group(
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
            textContentType="none"
            autoComplete="off"
            onSubmitEditing={() => Keyboard.dismiss()}
            style={{
              color: visual.primaryText,
              fontSize: 20,
              fontWeight: "600",
              minHeight: 54,
              paddingHorizontal: 16,
              paddingTop: 14,
              paddingBottom: 12
            }}
          />,
          8
        )}

        {task?.legacyReminderId && (
          <Text
            style={{
              color: visual.secondaryText,
              fontSize: 13,
              paddingHorizontal: 16,
              paddingTop: 8
            }}
          >
            {strings.tasksLegacyMigrationNotice()}
          </Text>
        )}

        {group(
          <>
            {toggleRow({
              symbol: "calendar",
              tint: systemColor("red", isDark),
              label: strings.date(),
              value: !!reminderDate,
              onValueChange: setDateEnabled,
              onPress: () => {
                if (!reminderDate) setDateEnabled(true);
                else
                  setExpandedPicker(
                    expandedPicker === "date" ? undefined : "date"
                  );
              },
              accessibilityLabel: strings.date(),
              accessibilityActions: reminderDate
                ? [{ name: "expand", label: strings.tasksShowDatePicker() }]
                : undefined,
              onAccessibilityAction: () =>
                setExpandedPicker(
                  expandedPicker === "date" ? undefined : "date"
                ),
              subtitle: reminderDate
                ? dateFromCalendar(reminderDate).toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric"
                  })
                : undefined
            })}
            {reminderDate && expandedPicker === "date" && (
              <DateTimePicker
                value={dateFromCalendar(reminderDate)}
                mode="date"
                display={Platform.OS === "ios" ? "inline" : "default"}
                themeVariant={isDark ? "dark" : "light"}
                accentColor={colors.primary.accent}
                onChange={(_, value) => {
                  if (value) setReminderDate(calendarDate(value));
                }}
                style={{ alignSelf: "stretch", marginHorizontal: 8 }}
              />
            )}
            {divider}
            {toggleRow({
              symbol: "clock.fill",
              tint: systemColor("blue", isDark),
              label: strings.time(),
              value: !!reminderTime,
              onValueChange: setTimeEnabled,
              onPress: () => {
                if (!reminderTime) setTimeEnabled(true);
                else
                  setExpandedPicker(
                    expandedPicker === "time" ? undefined : "time"
                  );
              },
              accessibilityLabel: strings.time(),
              accessibilityActions: reminderTime
                ? [{ name: "expand", label: strings.tasksShowTimePicker() }]
                : undefined,
              onAccessibilityAction: () =>
                setExpandedPicker(
                  expandedPicker === "time" ? undefined : "time"
                ),
              subtitle: reminderTime
                ? dateFromTime(reminderTime).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit"
                  })
                : undefined
            })}
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
            {toggleRow({
              symbol: "alarm.fill",
              tint: systemColor("red", isDark),
              label: strings.tasksUrgent(),
              value: urgent,
              onValueChange: setUrgentEnabled,
              disabled: !reminderTime || urgentStatus === "unsupported",
              accessibilityLabel: strings.tasksUrgent()
            })}
            <View style={{ paddingLeft: 59, paddingRight: 16, paddingBottom: 12 }}>
              <Text style={{ color: visual.secondaryText, fontSize: 13 }}>
                {urgentExplanation(urgentStatus, !!reminderTime)}
              </Text>
              {reminderTime && urgentStatus === "denied" ? (
                <Pressable
                  onPress={openAlarmSettings}
                  accessibilityRole="button"
                  accessibilityLabel={strings.tasksAllowAlarms()}
                  style={{ paddingTop: 6, alignSelf: "flex-start" }}
                >
                  <Text
                    style={{
                      color: colors.primary.accent,
                      fontSize: 13,
                      fontWeight: "600"
                    }}
                  >
                    {strings.tasksAllowAlarms()}
                  </Text>
                </Pressable>
              ) : null}
              {urgent && !!rule ? (
                <Text
                  style={{
                    color: visual.secondaryText,
                    fontSize: 13,
                    marginTop: 6
                  }}
                >
                  {strings.tasksUrgentRepeatLimit()}
                </Text>
              ) : null}
            </View>
            {divider}
            {valueRow({
              symbol: "repeat",
              tint: systemColor("gray", isDark),
              label: strings.tasksRepeat(),
              value:
                repeatOptions.find((item) => item.mode === mode)?.label ||
                strings.never(),
              menu: repeatMenu,
              onMenuSelect: (id) => chooseRepeat(id as RepeatMode)
            })}
            {mode === "custom" && (
              <View
                style={{
                  paddingVertical: 14,
                  paddingLeft: 59,
                  paddingRight: 16
                }}
              >
                <Text
                  style={{
                    color: visual.primaryText,
                    fontSize: 15,
                    marginBottom: 10
                  }}
                >
                  {strings.tasksRepeatEvery()}
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8
                  }}
                >
                  <TextInput
                    value={customInterval}
                    onChangeText={(value) => {
                      const next = value.replace(/\D/g, "").slice(0, 3);
                      setCustomInterval(next);
                      setRule(
                        customRule(customFrequency, next, customWeekdays)
                      );
                    }}
                    keyboardType="number-pad"
                    accessibilityLabel={strings.tasksRepeatInterval()}
                    style={{
                      color: visual.primaryText,
                      backgroundColor: visual.selectedSurface,
                      borderRadius: 10,
                      textAlign: "center",
                      width: 56,
                      minHeight: 42,
                      fontSize: 17
                    }}
                  />
                  {(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const).map(
                    (freq) => (
                      <Pressable
                        key={freq}
                        onPress={() => {
                          setCustomFrequency(freq);
                          setRule(
                            customRule(freq, customInterval, customWeekdays)
                          );
                        }}
                        accessibilityRole="button"
                        accessibilityState={{
                          selected: customFrequency === freq
                        }}
                        style={{
                          paddingHorizontal: 7,
                          paddingVertical: 10,
                          borderRadius: 9,
                          backgroundColor:
                            customFrequency === freq
                              ? visual.selectedSurface
                              : "transparent"
                        }}
                      >
                        <Text
                          style={{
                            color:
                              customFrequency === freq
                                ? colors.primary.accent
                                : visual.secondaryText,
                            fontSize: 14
                          }}
                        >
                          {freq === "DAILY"
                            ? strings.tasksDays()
                            : freq === "WEEKLY"
                              ? strings.tasksWeeks()
                              : freq === "MONTHLY"
                                ? strings.tasksMonths()
                                : strings.tasksYears()}
                        </Text>
                      </Pressable>
                    )
                  )}
                </View>
                {customFrequency === "WEEKLY" && (
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      marginTop: 16
                    }}
                  >
                    {WEEKDAYS.map((day) => (
                      <Pressable
                        key={day}
                        onPress={() => {
                          const next = customWeekdays.includes(day)
                            ? customWeekdays.filter((item) => item !== day)
                            : WEEKDAYS.filter(
                                (item) =>
                                  item === day || customWeekdays.includes(item)
                              );
                          setCustomWeekdays(next);
                          setRule(
                            customRule(customFrequency, customInterval, next)
                          );
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={day}
                        accessibilityState={{
                          selected: customWeekdays.includes(day)
                        }}
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 17,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: customWeekdays.includes(day)
                            ? colors.primary.accent
                            : visual.selectedSurface
                        }}
                      >
                        <Text
                          style={{
                            color: customWeekdays.includes(day)
                              ? "#FFFFFF"
                              : visual.primaryText,
                            fontSize: 11,
                            fontWeight: "700"
                          }}
                        >
                          {day}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}
          </>
        )}
        {reminderDate && notificationsDenied && (
          <Pressable
            onPress={openAlarmSettings}
            accessibilityRole="button"
            accessibilityLabel={strings.openSettings()}
            style={{ paddingHorizontal: 16, paddingTop: 8 }}
          >
            <Text style={{ color: visual.secondaryText, fontSize: 13 }}>
              {strings.tasksNotificationsDisabled()}{" "}
              <Text style={{ color: colors.primary.accent }}>
                {strings.openSettings()}
              </Text>
            </Text>
          </Pressable>
        )}

        {group(
          <>
            {valueRow({
              tile: selectedList ? (
                <SymbolTile
                  symbol={taskListSymbol(selectedList.symbol)}
                  color={taskListColor(selectedList.color)}
                  shape="circle"
                />
              ) : (
                <SymbolTile
                  symbol="list.bullet"
                  color={systemColor("blue", isDark)}
                  shape="circle"
                />
              ),
              label: strings.tasksList(),
              value: selectedList?.name || strings.tasksChooseList(),
              onPress: () => setShowLists(true)
            })}
            {divider}
            {valueRow({
              symbol: "exclamationmark",
              tint: systemColor("red", isDark),
              label: strings.tasksPriority(),
              value:
                priorityOptions.find((item) => item.value === priority)
                  ?.label || strings.tasksPriorityNone(),
              menu: priorityMenu,
              onMenuSelect: (id) => setPriority(id as TaskPriority)
            })}
            {divider}
            {toggleRow({
              symbol: "flag.fill",
              tint: systemColor("orange", isDark),
              label: strings.tasksFlag(),
              value: flagged,
              onValueChange: setFlagged
            })}
          </>
        )}

        {group(
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={strings.tasksNotes()}
            placeholderTextColor={visual.tertiaryText}
            accessibilityLabel={strings.tasksNotes()}
            multiline
            style={{
              color: visual.primaryText,
              fontSize: 17,
              minHeight: 96,
              paddingHorizontal: 16,
              paddingTop: 14,
              paddingBottom: 14,
              textAlignVertical: "top"
            }}
          />
        )}
      </ScrollView>

      {task && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 20,
            paddingTop: 10,
            paddingBottom: 10,
            borderTopWidth: 0.5,
            borderTopColor: visual.separator,
            backgroundColor: visual.contentSurface
          }}
        >
          <Pressable
            onPress={toggleComplete}
            accessibilityRole="button"
            accessibilityLabel={
              task.completed
                ? strings.tasksMarkIncomplete()
                : strings.tasksComplete()
            }
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              minHeight: 44
            }}
          >
            <TaskSymbolView
              name={task.completed ? "arrow.uturn.backward.circle" : "checkmark.circle"}
              size={22}
              color={colors.primary.accent}
            />
            <Text style={{ color: colors.primary.accent, fontSize: 17 }}>
              {task.completed
                ? strings.tasksMarkIncomplete()
                : strings.tasksComplete()}
            </Text>
          </Pressable>
          <Pressable
            ref={deleteButton}
            onPress={remove}
            accessibilityRole="button"
            accessibilityLabel={strings.tasksDelete()}
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "flex-end",
              justifyContent: "center"
            }}
          >
            <TaskSymbolView
              name="trash"
              size={22}
              color={systemColor("red", isDark)}
            />
          </Pressable>
        </View>
      )}

      <Modal
        visible={showLists}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowLists(false)}
      >
        <View style={{ flex: 1, backgroundColor: visual.screenBackground }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 8,
              minHeight: 56
            }}
          >
            <View style={{ minWidth: 80 }} />
            <Text
              accessibilityRole="header"
              style={{
                flex: 1,
                textAlign: "center",
                color: visual.primaryText,
                fontSize: 17,
                fontWeight: "600"
              }}
            >
              {strings.tasksChooseList()}
            </Text>
            <Pressable
              onPress={() => setShowLists(false)}
              accessibilityRole="button"
              accessibilityLabel={strings.tasksDone()}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 12,
                minWidth: 80,
                alignItems: "flex-end"
              }}
            >
              <Text
                style={{
                  color: colors.primary.accent,
                  fontSize: 17,
                  fontWeight: "600"
                }}
              >
                {strings.tasksDone()}
              </Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {group(
              lists.map((list, index) => (
                <View key={list.id}>
                  {index > 0 ? divider : null}
                  <Pressable
                    onPress={() => {
                      setListId(list.id);
                      setShowLists(false);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: listId === list.id }}
                    accessibilityLabel={list.name}
                    style={{
                      minHeight: 52,
                      flexDirection: "row",
                      alignItems: "center",
                      paddingHorizontal: 16
                    }}
                  >
                    <SymbolTile
                      symbol={taskListSymbol(list.symbol)}
                      color={taskListColor(list.color)}
                      shape="circle"
                    />
                    <Text
                      style={{
                        flex: 1,
                        color: visual.primaryText,
                        fontSize: 17,
                        marginLeft: 14
                      }}
                    >
                      {list.name}
                    </Text>
                    {list.id === listId && (
                      <TaskSymbolView
                        name="checkmark"
                        size={18}
                        color={colors.primary.accent}
                      />
                    )}
                  </Pressable>
                </View>
              )),
              0
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
