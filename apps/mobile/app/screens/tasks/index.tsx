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
  EVENTS,
  Task,
  TaskFavorite,
  TaskList,
  isTaskOverdue,
  taskReminderSchedule
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Keyboard,
  KeyboardEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets
} from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { db } from "../../common/database";
import Navigation, { NavigationProps } from "../../services/navigation";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { FavoritesEditor } from "./favorites-editor";
import {
  ListCustomization,
  taskListColor,
  taskListSymbol
} from "./list-customization";
import { keyboardDockInset } from "./keyboard-dock";

type SmartList = "today" | "scheduled" | "all" | "flagged" | "completed";
type Selection =
  | { kind: "smart"; id: SmartList }
  | { kind: "list"; id: string };

const SMART_LISTS: { id: SmartList; icon: string; label: () => string }[] = [
  { id: "today", icon: "calendar", label: strings.tasksToday },
  { id: "scheduled", icon: "calendar.badge.clock", label: strings.tasksScheduled },
  { id: "all", icon: "tray.full", label: strings.tasksAll },
  { id: "flagged", icon: "flag", label: strings.tasksFlagged },
  {
    id: "completed",
    icon: "checkmark.circle",
    label: strings.tasksCompleted
  }
];

function dateLabel(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(year !== new Date().getFullYear() ? { year: "numeric" as const } : {})
  }).format(new Date(year, month - 1, day));
}

function scheduledDay(task: Task) {
  return taskReminderSchedule(task).date;
}

function priorityLabel(task: Task) {
  switch (task.priority) {
    case "low":
      return strings.tasksPriorityLow();
    case "medium":
      return strings.tasksPriorityMedium();
    case "high":
      return strings.tasksPriorityHigh();
    default:
      return "";
  }
}

function taskAccessibilityLabel(task: Task) {
  const schedule = taskReminderSchedule(task);
  return [
    task.title,
    schedule.date
      ? `${strings.tasksReminder()}: ${dateLabel(schedule.date)}${
          schedule.time ? ` ${schedule.time}` : ""
        }`
      : undefined,
    isTaskOverdue(task) ? strings.tasksOverdue() : undefined,
    task.urgent ? strings.tasksUrgent() : undefined,
    task.flagged ? strings.tasksFlagged() : undefined,
    priorityLabel(task)
  ]
    .filter(Boolean)
    .join(", ");
}

export default function Tasks({ navigation, route }: NavigationProps<"Tasks">) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const { width } = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const isTablet = width >= 700;
  const [selection, setSelection] = React.useState<Selection>(
    route.params?.listId
      ? { kind: "list", id: route.params.listId }
      : { kind: "smart", id: route.params?.smartList || "today" }
  );
  const [showListOnPhone, setShowListOnPhone] = React.useState(
    !!(route.params?.listId || route.params?.smartList)
  );
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [allTasks, setAllTasks] = React.useState<Task[]>([]);
  const [lists, setLists] = React.useState<TaskList[]>([]);
  const [favorites, setFavorites] = React.useState<TaskFavorite[]>([]);
  const [favoritesEditorOpen, setFavoritesEditorOpen] = React.useState(false);
  const [editingList, setEditingList] = React.useState<
    TaskList | null | undefined
  >();
  const [defaultListId, setDefaultListId] = React.useState<string>();
  const [counts, setCounts] = React.useState<Record<SmartList, number>>({
    today: 0,
    scheduled: 0,
    all: 0,
    flagged: 0,
    completed: 0
  });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [quickTitle, setQuickTitle] = React.useState("");
  const [quickBusy, setQuickBusy] = React.useState(false);
  const refreshGeneration = React.useRef(0);
  const screenRef = React.useRef<View>(null);
  const keyboardFrame = React.useRef<KeyboardEvent["endCoordinates"] | null>(
    null
  );
  const [keyboardInset, setKeyboardInset] = React.useState(0);

  const updateKeyboardInset = React.useCallback(() => {
    const frame = keyboardFrame.current;
    if (!frame) {
      setKeyboardInset(0);
      return;
    }
    screenRef.current?.measureInWindow((x, y, width, height) => {
      setKeyboardInset(
        keyboardDockInset(frame, { x, y, width, height }, safeAreaInsets.bottom)
      );
    });
  }, [safeAreaInsets.bottom]);

  React.useEffect(() => {
    const change = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow",
      (event) => {
        keyboardFrame.current = event.endCoordinates;
        if (Platform.OS === "ios") Keyboard.scheduleLayoutAnimation(event);
        updateKeyboardInset();
      }
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (event) => {
        keyboardFrame.current = null;
        if (Platform.OS === "ios") Keyboard.scheduleLayoutAnimation(event);
        setKeyboardInset(0);
      }
    );
    return () => {
      change.remove();
      hide.remove();
    };
  }, [updateKeyboardInset]);

  React.useEffect(() => {
    if (route.params?.listId) {
      setSelection({ kind: "list", id: route.params.listId });
      setShowListOnPhone(true);
    } else if (route.params?.smartList) {
      setSelection({ kind: "smart", id: route.params.smartList });
      setShowListOnPhone(true);
    }
  }, [route.params?.listId, route.params?.smartList]);

  const refresh = React.useCallback(async () => {
    if (!db.isInitialized) return;
    const generation = ++refreshGeneration.current;
    try {
      const [
        taskLists,
        allTasks,
        today,
        scheduled,
        all,
        flagged,
        completed,
        favoriteRefs
      ] = await Promise.all([
        db.taskLists.list(),
        db.tasks.list(),
        db.tasks.smartList("today"),
        db.tasks.smartList("scheduled"),
        db.tasks.smartList("all"),
        db.tasks.smartList("flagged"),
        db.tasks.smartList("completed"),
        db.taskFavorites.list()
      ]);
      const defaultList = await db.taskLists.default();
      if (generation !== refreshGeneration.current) return;
      setLists(taskLists);
      setAllTasks(allTasks);
      setFavorites(favoriteRefs);
      setDefaultListId(defaultList.id);
      setCounts({
        today: today.length,
        scheduled: scheduled.length,
        all: all.length,
        flagged: flagged.length,
        completed: completed.length
      });
      setTasks(
        selection.kind === "list"
          ? allTasks.filter(
              (task) => task.listId === selection.id && !task.completed
            )
          : (
              { today, scheduled, all, flagged, completed } as Record<
                SmartList,
                Task[]
              >
            )[selection.id]
      );
      setError(false);
    } catch {
      if (generation !== refreshGeneration.current) return;
      setError(true);
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [selection]);

  React.useEffect(() => {
    const generationRef = refreshGeneration;
    refresh();
    const focus = navigation.addListener("focus", refresh);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const clock = setInterval(refresh, 60_000);
    const update = db.eventManager.subscribe(
      EVENTS.databaseUpdated,
      (event) => {
        if (event.collection === "settings" || event.collection === "reminders")
          refresh();
      }
    );
    const sync = db.eventManager.subscribe(EVENTS.syncCompleted, refresh);
    return () => {
      generationRef.current++;
      focus();
      appState.remove();
      clearInterval(clock);
      update.unsubscribe();
      sync.unsubscribe();
    };
  }, [navigation, refresh]);

  const select = (next: Selection) => {
    setSelection(next);
    setShowListOnPhone(true);
    setLoading(true);
  };

  const selectedLabel =
    selection.kind === "smart"
      ? SMART_LISTS.find((item) => item.id === selection.id)?.label() ||
        strings.tasksTitle()
      : lists.find((list) => list.id === selection.id)?.name ||
        strings.tasksList();
  const selectedList =
    selection.kind === "list"
      ? lists.find((list) => list.id === selection.id)
      : undefined;
  const openCount = tasks.filter((task) => !task.completed).length;
  const overdueCount = tasks.filter((task) => isTaskOverdue(task)).length;
  const listSummary = [
    strings.tasksOpenCount(openCount),
    ...(overdueCount ? [strings.tasksOverdueCount(overdueCount)] : [])
  ].join(", ");

  const openDetail = (task?: Task, initialTitle?: string) => {
    Navigation.push("TaskDetail", {
      ...(task ? { taskId: task.id } : {}),
      ...(selection.kind === "list" ? { listId: selection.id } : {}),
      ...(initialTitle ? { initialTitle } : {})
    });
  };

  const createList = () => setEditingList(null);

  const deleteList = (list: TaskList) => {
    Alert.alert(strings.tasksDeleteList(), strings.tasksDeleteListConfirm(), [
      { text: strings.cancel(), style: "cancel" },
      {
        text: strings.delete(),
        style: "destructive",
        onPress: async () => {
          try {
            await db.taskLists.remove(list.id);
            const remainingFavorites = (await db.taskFavorites.list()).filter(
              (ref) => ref !== `list:${list.id}`
            );
            await db.taskFavorites.set(remainingFavorites);
            setSelection({ kind: "smart", id: "today" });
            await refresh();
          } catch {
            Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
          }
        }
      }
    ]);
  };

  const editList = (list: TaskList) => setEditingList(list);

  const listActions = (list: TaskList) => {
    Alert.alert(list.name, undefined, [
      { text: strings.tasksEditList(), onPress: () => editList(list) },
      ...(list.id === defaultListId
        ? []
        : [
            {
              text: strings.tasksDeleteList(),
              style: "destructive" as const,
              onPress: () => deleteList(list)
            }
          ]),
      { text: strings.cancel(), style: "cancel" }
    ]);
  };

  const addQuickTask = async () => {
    const title = quickTitle.trim();
    if (
      !title ||
      quickBusy ||
      (selection.kind === "smart" && selection.id === "completed")
    )
      return;
    setQuickBusy(true);
    try {
      const defaultList = await db.taskLists.default();
      await db.tasks.create({
        title,
        listId: selection.kind === "list" ? selection.id : defaultList.id
      });
      setQuickTitle("");
      await refresh();
    } catch {
      Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
    } finally {
      setQuickBusy(false);
    }
  };

  const toggleCompletion = async (task: Task) => {
    try {
      if (task.completed) await db.tasks.uncomplete(task.id);
      else await db.tasks.complete(task.id);
      await refresh();
    } catch {
      Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
    }
  };

  const taskActions = (task: Task) => {
    Alert.alert(task.title, undefined, [
      {
        text: task.completed
          ? strings.tasksUncomplete()
          : strings.tasksComplete(),
        onPress: () => void toggleCompletion(task)
      },
      {
        text: task.flagged ? strings.tasksUnflag() : strings.tasksFlag(),
        onPress: async () => {
          try {
            await db.tasks.update(task.id, { flagged: !task.flagged });
            await refresh();
          } catch {
            Alert.alert(strings.tasksTitle(), strings.tasksCouldNotSave());
          }
        }
      },
      {
        text: strings.tasksDelete(),
        style: "destructive",
        onPress: () => {
          Alert.alert(strings.tasksDelete(), strings.tasksDeleteConfirm(), [
            { text: strings.cancel(), style: "cancel" },
            {
              text: strings.delete(),
              style: "destructive",
              onPress: async () => {
                try {
                  await db.tasks.remove(task.id);
                  await refresh();
                } catch {
                  Alert.alert(
                    strings.tasksTitle(),
                    strings.tasksCouldNotSave()
                  );
                }
              }
            }
          ]);
        }
      },
      { text: strings.cancel(), style: "cancel" }
    ]);
  };

  const isScheduled =
    selection.kind === "smart" && selection.id === "scheduled";
  const displayTasks = React.useMemo(() => {
    if (!isScheduled) return tasks;
    return [...tasks].sort(
      (a, b) =>
        (scheduledDay(a) || "").localeCompare(scheduledDay(b) || "") ||
        (taskReminderSchedule(a).time || "").localeCompare(
          taskReminderSchedule(b).time || ""
        ) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id)
    );
  }, [tasks, isScheduled]);

  const nav = (
    <ScrollView
      style={{ flex: 1 }}
      keyboardShouldPersistTaps="always"
      contentContainerStyle={{ paddingBottom: 24 }}
    >
      <View style={{ padding: 20, flexDirection: "row", alignItems: "center" }}>
        {Platform.OS !== "ios" && <Pressable
          onPress={() =>
            navigation.canGoBack()
              ? navigation.goBack()
              : Navigation.navigate("FluidPanelsView")
          }
          accessibilityRole="button"
          accessibilityLabel={strings.back()}
          style={{ width: 44, height: 44, justifyContent: "center" }}
        >
          <Icon name="arrow-left" size={25} color={visual.primaryText} />
        </Pressable>}
        <Text
          style={{
            color: visual.primaryText,
            fontSize: 34,
            fontWeight: "700",
            flex: 1
          }}
        >
          {strings.tasksTitle()}
        </Text>
      </View>
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: 10,
          paddingBottom: 8,
          flexDirection: "row",
          alignItems: "center"
        }}
      >
        <Text
          style={{
            flex: 1,
            color: visual.primaryText,
            fontSize: 21,
            fontWeight: "700"
          }}
        >
          {strings.tasksFavorites()}
        </Text>
        <Pressable
          onPress={() => setFavoritesEditorOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={strings.tasksEditFavorites()}
          style={{ padding: 8 }}
        >
          <Text
            style={{
              color: colors.primary.accent,
              fontSize: 15,
              fontWeight: "600"
            }}
          >
            {strings.edit()}
          </Text>
        </Pressable>
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          paddingHorizontal: 14
        }}
      >
        {favorites.flatMap((ref) => {
          const smart = ref.startsWith("smart:")
            ? SMART_LISTS.find((item) => item.id === ref.slice(6))
            : undefined;
          const taskList = ref.startsWith("list:")
            ? lists.find((item) => item.id === ref.slice(5))
            : undefined;
          if (!smart && !taskList) return [];
          const next: Selection = smart
            ? { kind: "smart", id: smart.id }
            : { kind: "list", id: taskList!.id };
          const active =
            selection.kind === next.kind && selection.id === next.id;
          const label = smart ? smart.label() : taskList!.name;
          const count = smart
            ? counts[smart.id]
            : allTasks.filter(
                (task) => task.listId === taskList!.id && !task.completed
              ).length;
          return (
            <Pressable
              key={ref}
              testID={
                smart
                  ? `task-smart-${smart.id}`
                  : `task-favorite-list-${taskList!.id}`
              }
              onPress={() => select(next)}
              accessibilityRole="button"
              accessibilityLabel={`${label}, ${count}`}
              style={{
                width: "45%",
                margin: 6,
                minHeight: 86,
                padding: 13,
                borderRadius: visual.cardRadius,
                backgroundColor: active
                  ? visual.selectedSurface
                  : visual.contentSurface,
                justifyContent: "space-between"
              }}
            >
              {smart ? (
                <TaskSymbolView
                  name={smart.icon}
                  size={23}
                  color={colors.primary.accent}
                />
              ) : (
                <TaskSymbolView
                  name={taskListSymbol(taskList!.symbol)}
                  color={taskListColor(taskList!.color)}
                  size={23}
                />
              )}
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}
              >
                <Text
                  style={{
                    color: visual.primaryText,
                    fontSize: 16,
                    fontWeight: "600"
                  }}
                >
                  {label}
                </Text>
                <Text
                  style={{
                    color: visual.primaryText,
                    fontSize: 20,
                    fontWeight: "700"
                  }}
                >
                  {count}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingTop: 22,
          paddingBottom: 10
        }}
      >
        <Text
          style={{
            flex: 1,
            color: visual.primaryText,
            fontSize: 21,
            fontWeight: "700"
          }}
        >
          {strings.tasksLists()}
        </Text>
        <Pressable
          onPress={createList}
          accessibilityRole="button"
          accessibilityLabel={strings.tasksNewList()}
          style={{ padding: 8 }}
        >
          <Icon name="plus" size={23} color={colors.primary.accent} />
        </Pressable>
      </View>
      <View>
        {lists.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => select({ kind: "list", id: item.id })}
            onLongPress={() => listActions(item)}
            accessibilityRole="button"
            accessibilityLabel={item.name}
            style={{
              marginHorizontal: 20,
              minHeight: 52,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 12,
              borderRadius: visual.controlRadius,
              backgroundColor:
                selection.kind === "list" && selection.id === item.id
                  ? visual.selectedSurface
                  : "transparent"
            }}
          >
            <TaskSymbolView
              name={taskListSymbol(item.symbol)}
              size={21}
              color={taskListColor(item.color)}
            />
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                color: visual.primaryText,
                fontSize: 16,
                marginLeft: 12
              }}
            >
              {item.name}
            </Text>
            <Icon name="chevron-right" size={19} color={visual.tertiaryText} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );

  const list = (
    <View style={{ flex: 1, paddingBottom: keyboardInset }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 18,
          paddingTop: 20,
          paddingBottom: 12
        }}
      >
        {!isTablet && (
          <Pressable
            onPress={() => setShowListOnPhone(false)}
            accessibilityRole="button"
            accessibilityLabel={strings.back()}
            style={{ width: 44, height: 44, justifyContent: "center" }}
          >
            <Icon name="arrow-left" size={25} color={visual.primaryText} />
          </Pressable>
        )}
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={{
              color: selectedList
                ? taskListColor(selectedList.color)
                : visual.primaryText,
              fontSize: 32,
              fontWeight: "700"
            }}
          >
            {selectedLabel}
          </Text>
          {selection.kind === "list" && !loading && (
            <Text
              accessibilityLabel={listSummary}
              style={{ color: visual.secondaryText, fontSize: 14, marginTop: 2 }}
            >
              {listSummary}
            </Text>
          )}
        </View>
      </View>
      {loading ? (
        <ActivityIndicator
          style={{ marginTop: 40 }}
          color={colors.primary.accent}
          accessibilityLabel={strings.tasksLoading()}
        />
      ) : error ? (
        <Text
          style={{
            color: visual.secondaryText,
            textAlign: "center",
            marginTop: 50
          }}
        >
          {strings.tasksCouldNotLoad()}
        </Text>
      ) : (
        <FlatList
          data={displayTasks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{
            paddingHorizontal: 18,
            paddingBottom: 80,
            flexGrow: 1
          }}
          ListEmptyComponent={
            <Text
              style={{
                color: visual.secondaryText,
                textAlign: "center",
                marginTop: 50
              }}
            >
              {strings.tasksNoTasks()}
            </Text>
          }
          renderItem={({ item, index }) => (
            <View>
              {isScheduled &&
                scheduledDay(item) &&
                scheduledDay(item) !==
                  (index > 0
                    ? scheduledDay(displayTasks[index - 1])
                    : undefined) && (
                  <Text
                    style={{
                      color: visual.secondaryText,
                      fontSize: 13,
                      fontWeight: "700",
                      marginTop: index === 0 ? 8 : 22,
                      marginBottom: 3
                    }}
                  >
                    {dateLabel(scheduledDay(item) as string)}
                  </Text>
                )}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  borderBottomWidth: 0.5,
                  borderBottomColor: visual.separator,
                  minHeight: 68
                }}
              >
                <Pressable
                  onPress={() => toggleCompletion(item)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: item.completed }}
                  accessibilityLabel={`${
                    item.completed
                      ? strings.tasksUncomplete()
                      : strings.tasksComplete()
                  }: ${item.title}`}
                  style={({ pressed }) => ({
                    width: 48,
                    height: 50,
                    justifyContent: "center",
                    opacity: pressed ? 0.55 : 1
                  })}
                >
                  <View
                    style={{
                      width: 27,
                      height: 27,
                      borderRadius: 14,
                      borderWidth: 2,
                      borderColor: item.completed
                        ? colors.primary.accent
                        : visual.secondaryText,
                      backgroundColor: item.completed
                        ? colors.primary.accent
                        : "transparent",
                      alignItems: "center",
                      justifyContent: "center"
                    }}
                  >
                    {item.completed && (
                      <TaskSymbolView name="checkmark" size={15} color={visual.contentSurface} />
                    )}
                  </View>
                </Pressable>
                <Pressable
                  onPress={() => openDetail(item)}
                  onLongPress={() => taskActions(item)}
                  accessibilityRole="button"
                  accessibilityLabel={taskAccessibilityLabel(item)}
                  accessibilityHint={strings.tasksEditTask()}
                  style={{ flex: 1, paddingVertical: 9 }}
                >
                  <Text
                    numberOfLines={2}
                    style={{
                      color: visual.primaryText,
                      fontSize: 16,
                      textDecorationLine: item.completed
                        ? "line-through"
                        : "none"
                    }}
                  >
                    {item.title}
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      gap: 8,
                      marginTop: 4,
                      alignItems: "center",
                      flexWrap: "wrap"
                    }}
                  >
                    {taskReminderSchedule(item).date && (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        {isTaskOverdue(item) && (
                          <TaskSymbolView name="clock" size={13} color={colors.error.paragraph} />
                        )}
                        <Text
                          style={{
                            color: isTaskOverdue(item)
                              ? colors.error.paragraph
                              : visual.secondaryText,
                            fontSize: 12
                          }}
                        >
                          {isTaskOverdue(item)
                            ? `${strings.tasksOverdue()} · `
                            : ""}
                          {dateLabel(taskReminderSchedule(item).date!)}
                          {taskReminderSchedule(item).time
                            ? ` ${taskReminderSchedule(item).time}`
                            : ""}
                        </Text>
                      </View>
                    )}
                    {item.urgent && (
                      <TaskSymbolView
                        name="bell"
                        size={14}
                        color={colors.primary.accent}
                        accessibilityLabel="Urgent"
                      />
                    )}
                    {item.flagged && (
                      <TaskSymbolView
                        name="flag.fill"
                        size={13}
                        color={colors.primary.accent}
                        accessibilityLabel={strings.tasksFlag()}
                      />
                    )}
                    {item.priority !== "none" && (
                      <Text
                        style={{ color: visual.secondaryText, fontSize: 12 }}
                      >
                        {item.priority === "high"
                          ? "!!!"
                          : item.priority === "medium"
                          ? "!!"
                          : "!"}
                      </Text>
                    )}
                  </View>
                  {item.urgent && !!item.recurrenceRule && !item.completed && (
                    <Text
                      style={{
                        color: visual.secondaryText,
                        fontSize: 11,
                        marginTop: 4
                      }}
                    >
                      {strings.tasksUrgentRepeatLimit()}
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}
        />
      )}
      {(selection.kind === "list" || selection.id !== "completed") && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            margin: 14,
            borderRadius: visual.controlRadius,
            backgroundColor: visual.contentSurface,
            paddingHorizontal: 14,
            minHeight: 54
          }}
        >
          <Icon name="plus" size={22} color={colors.primary.accent} />
          <TextInput
            testID="task-quick-add-input"
            value={quickTitle}
            onChangeText={setQuickTitle}
            onSubmitEditing={addQuickTask}
            placeholder={strings.tasksQuickAdd()}
            placeholderTextColor={visual.tertiaryText}
            accessibilityLabel={strings.tasksQuickAdd()}
            returnKeyType="done"
            style={{
              flex: 1,
              color: visual.primaryText,
              fontSize: 16,
              marginLeft: 10,
              minHeight: 48
            }}
          />
          <Pressable
            onPress={() => {
              const draft = quickTitle.trim();
              setQuickTitle("");
              openDetail(undefined, draft);
            }}
            accessibilityRole="button"
            accessibilityLabel={strings.advanced()}
            style={{ padding: 8, minHeight: 44, justifyContent: "center" }}
          >
            <Text style={{ color: colors.primary.accent, fontSize: 14 }}>
              {strings.advanced()}
            </Text>
          </Pressable>
          <Pressable
            onPress={addQuickTask}
            testID="task-quick-add-submit"
            disabled={quickBusy || !quickTitle.trim()}
            accessibilityRole="button"
            accessibilityLabel={strings.tasksAddTask()}
            style={{ padding: 8 }}
          >
            <Icon
              name="arrow-up-circle"
              size={27}
              color={
                quickTitle.trim() ? colors.primary.accent : visual.tertiaryText
              }
            />
          </Pressable>
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView
      ref={screenRef}
      onLayout={updateKeyboardInset}
      style={{
        flex: 1,
        backgroundColor: visual.screenBackground,
        flexDirection: "row"
      }}
    >
      {(isTablet || !showListOnPhone) && (
        <View
          style={{
            flex: 1,
            maxWidth: isTablet ? 330 : undefined,
            borderRightWidth: isTablet ? 0.5 : 0,
            borderRightColor: visual.separator
          }}
        >
          {nav}
        </View>
      )}
      {(isTablet || showListOnPhone) && (
        <View style={{ flex: isTablet ? 2 : 1 }}>{list}</View>
      )}
      <FavoritesEditor
        visible={favoritesEditorOpen}
        favorites={favorites}
        lists={lists}
        onClose={() => setFavoritesEditorOpen(false)}
        onSave={async (items) => {
          await db.taskFavorites.set(items);
          await refresh();
        }}
      />
      <ListCustomization
        visible={editingList !== undefined}
        list={editingList || undefined}
        onClose={() => setEditingList(undefined)}
        onSave={async (input) => {
          const saved = editingList
            ? await db.taskLists.update(editingList.id, input)
            : await db.taskLists.create(input);
          await refresh();
          if (!editingList) select({ kind: "list", id: saved.id });
        }}
      />
    </SafeAreaView>
  );
}
