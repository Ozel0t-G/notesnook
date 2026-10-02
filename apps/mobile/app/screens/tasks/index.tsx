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
  isTaskOverdue,
  taskReminderSchedule
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  ViewStyle
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets
} from "react-native-safe-area-context";
import { db } from "../../common/database";
import { APPLE_TAB_BAR_HEIGHT } from "../../components/apple-tab-bar";
import {
  IosBarButton,
  IosLargeTitle,
  IosMoreMenu,
  IosNavBar
} from "../../components/ios-nav-bar";
import {
  compactMenu,
  ContextMenu,
  NativeMenuItem
} from "../../components/native-menu";
import { SwipeRow } from "../../components/swipe-row";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { MacHoverHighlight, useMacHover } from "../../components/mac-hover";
import { SymbolTile } from "../../components/ui/symbol-tile";
import { eSubscribeEvent, ToastManager } from "../../services/event-manager";
import Navigation, { NavigationProps } from "../../services/navigation";
import { TaskNotifications } from "../../services/task-notifications";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { isMacCatalyst } from "../../utils/constants";
import { eCreateTaskRequest } from "../../utils/events";
import { systemColor } from "../../utils/ios-system-colors";
import { showAlert } from "../../utils/mac-alert";
import { macAccent, macSelectionFill } from "../../utils/mac-system-state";
import { useMacListTitleStore } from "../../utils/mac-window-title";
import { useAppleNavigationStore } from "../../stores/use-apple-navigation-store";
import { useMacSystemStore } from "../../stores/use-mac-system-store";
import { useMacWindowStore } from "../../stores/use-mac-window-store";
import {
  taskSmartList,
  TILE_SMART_LISTS,
  TaskSmartListId,
  useTaskSmartLists
} from "../../hooks/use-task-smart-lists";
import {
  TaskSelection,
  useTasksSelectionStore
} from "../../stores/use-tasks-selection-store";
import { FavoritesEditor } from "./favorites-editor";
import {
  ListCustomization,
  taskListColor,
  taskListSymbol
} from "./list-customization";
import { parseQuickAdd } from "./quick-add-parse";
import {
  resolveTaskFocusIndex,
  TASK_FOCUS_VIEW_POSITION,
  TaskFocusSession
} from "./task-focus";
import { localCalendarDate, TaskListRow, taskListRows } from "./task-sections";

type Selection = TaskSelection;

/** Undo window for deletions and the time a checked-off Task stays visible. */
const UNDO_DELETE_MS = 4000;
const COMPLETE_LINGER_MS = 1500;

/**
 * Mac overview metrics. Catalyst has no Large Title, "Edit" button or 26 pt
 * tiles: the favourites overview is a compact source list (see
 * components/mac-sidebar.tsx for the same 6 pt row radius and 10 pt inset).
 */
const MAC_TILE_RADIUS = 10;
const MAC_TILE_ICON_SIZE = 24;
const MAC_ROW_RADIUS = 6;
const MAC_ROW_INSET = 10;
const MAC_ROW_PADDING = 8;

function dateLabel(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(year !== new Date().getFullYear() ? { year: "numeric" as const } : {})
  }).format(new Date(year, month - 1, day));
}

/** Formats a stored `HH:mm` in the device's 12/24-hour style. */
function timeLabel(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function relativeDateLabel(value: string) {
  const today = localCalendarDate(new Date());
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (value === today) return strings.tasksToday();
  if (value === localCalendarDate(tomorrow)) return strings.tasksTomorrow();
  return dateLabel(value);
}

function scheduleLabel(task: Task) {
  const schedule = taskReminderSchedule(task);
  if (!schedule.date) return "";
  return `${relativeDateLabel(schedule.date)}${
    schedule.time ? `, ${timeLabel(schedule.time)}` : ""
  }`;
}

function priorityMarks(priority: TaskPriority) {
  return priority === "high"
    ? "!!!"
    : priority === "medium"
      ? "!!"
      : priority === "low"
        ? "!"
        : "";
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

function taskAccessibilityLabel(task: Task, listName?: string) {
  const schedule = scheduleLabel(task);
  return [
    task.title,
    schedule ? `${strings.tasksReminder()}: ${schedule}` : undefined,
    isTaskOverdue(task) ? strings.tasksOverdue() : undefined,
    task.urgent ? strings.tasksUrgent() : undefined,
    task.flagged ? strings.tasksFlagged() : undefined,
    priorityLabel(task),
    listName
  ]
    .filter(Boolean)
    .join(", ");
}

function sectionTitle(row: Extract<TaskListRow, { kind: "header" }>) {
  switch (row.section) {
    case "overdue":
      return strings.tasksSectionOverdue();
    case "today":
      return strings.tasksSectionToday();
    case "later":
      return strings.tasksSectionLater();
    case "noDate":
      return strings.tasksSectionNoDate();
    case "completed":
      return strings.tasksCompleted();
    default:
      return row.date ? dateLabel(row.date) : "";
  }
}

export default function Tasks({ navigation, route }: NavigationProps<"Tasks">) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const { width, fontScale } = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const isTablet = width >= 700;
  // Catalyst is a split view: `isTablet` is true at the 900 pt minimum window
  // width, so the iPad selection highlighting stays on there too (the Mac tile
  // and row branches below only change *how* it is drawn).
  const isMac = isMacCatalyst() === true;
  // Accessibility text sizes (AX1 and up) get a single-column overview so
  // titles never break mid-word and counts never overflow their tile.
  const accessibilityLayout = fontScale >= 1.4;
  /**
   * On Mac the selected list lives in a store because Mac's sidebar drives it
   * (components/mac-sidebar.tsx); iPhone/iPad keep their own local selection, so
   * nothing changes there.
   */
  const macSelection = useTasksSelectionStore((state) => state.selection);
  const macSetSelection = useTasksSelectionStore((state) => state.setSelection);
  const [localSelection, setLocalSelection] = React.useState<Selection>(
    route.params?.listId
      ? { kind: "list", id: route.params.listId }
      : { kind: "smart", id: route.params?.smartList || "today" }
  );
  const selection: Selection = isMac ? macSelection : localSelection;
  const setSelection = (next: Selection) => {
    if (isMac) macSetSelection(next);
    else setLocalSelection(next);
  };
  const [showListOnPhone, setShowListOnPhone] = React.useState(
    !!(route.params?.listId || route.params?.smartList)
  );
  const {
    lists,
    allTasks,
    favorites,
    defaultListId,
    smartLists,
    counts,
    listCounts,
    loading,
    error,
    refresh
  } = useTaskSmartLists(navigation);
  const [favoritesEditorOpen, setFavoritesEditorOpen] = React.useState(false);
  const [editingList, setEditingList] = React.useState<
    TaskList | null | undefined
  >();
  const [includeCompleted, setIncludeCompleted] = React.useState(
    !!route.params?.includeCompleted
  );
  const [highlightedTaskId, setHighlightedTaskId] = React.useState<
    string | undefined
  >(undefined);
  const [pendingComplete, setPendingComplete] = React.useState<Set<string>>(
    () => new Set()
  );
  const [pendingDelete, setPendingDelete] = React.useState<Set<string>>(
    () => new Set()
  );
  const completeTimers = React.useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  const deleteTimers = React.useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  const listRef = React.useRef<FlatList<TaskListRow>>(null);
  const dismissedFocusRequest = React.useRef<string | undefined>(undefined);
  const focusTaskId =
    route.params?.focusTaskId ?? route.params?.highlightTaskId;
  const focusRequestId = route.params?.focusRequestId ?? focusTaskId;
  const focusSession = React.useRef<TaskFocusSession | undefined>(undefined);
  if (!focusSession.current) {
    focusSession.current = new TaskFocusSession({
      requestScroll: (index, animated) => {
        try {
          listRef.current?.scrollToIndex({
            index,
            viewPosition: TASK_FOCUS_VIEW_POSITION,
            animated
          });
        } catch {
          // Unmeasured rows are reported through onScrollToIndexFailed, which
          // schedules a bounded retry instead of looping here.
        }
      },
      resetScroll: (index, averageItemLength) => {
        listRef.current?.scrollToOffset({
          offset: index * averageItemLength,
          animated: false
        });
      },
      startHighlight: (taskId) => setHighlightedTaskId(taskId),
      endHighlight: (taskId) =>
        setHighlightedTaskId((current) =>
          current === taskId ? undefined : current
        ),
      onUnresolved: () => setHighlightedTaskId(undefined)
    });
  }

  const selectionRef = React.useRef(selection);
  selectionRef.current = selection;

  React.useEffect(() => {
    // A second notification/deep-link tap while this screen is already mounted
    // still delivers new route params (React Navigation updates params on an
    // existing screen instance rather than always creating a new one). Show the
    // requested List.
    const next: Selection | undefined = route.params?.listId
      ? { kind: "list", id: route.params.listId }
      : route.params?.smartList
        ? { kind: "smart", id: route.params.smartList }
        : undefined;
    const nextIncludeCompleted = !!route.params?.includeCompleted;
    if (next) {
      setSelection(next);
      setShowListOnPhone(true);
    }
    setIncludeCompleted(nextIncludeCompleted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    route.params?.listId,
    route.params?.smartList,
    route.params?.includeCompleted,
    route.params?.focusRequestId,
    route.params?.highlightTaskId
  ]);

  /**
   * The Tasks of the current selection, derived from the shared data above
   * (hooks/use-task-smart-lists.ts). Keeping it derived instead of loaded means
   * switching lists is instant and Mac's sidebar can drive the selection from
   * its own store.
   */
  const tasks = React.useMemo(() => {
    if (selection.kind === "list") {
      const listId = selection.id;
      return allTasks.filter(
        (task) => task.listId === listId && (includeCompleted || !task.completed)
      );
    }
    const smartId = selection.id;
    const smart = smartLists[smartId];
    if (smartId !== "completed" && includeCompleted) {
      const todayDate = localCalendarDate(new Date());
      // "Show Completed" adds the completed Tasks that belong to the list.
      const completedFor = smartLists.completed.filter((task) => {
        const date = taskReminderSchedule(task).date;
        if (smartId === "all") return true;
        if (smartId === "flagged") return task.flagged;
        if (smartId === "scheduled") return !!date;
        if (smartId === "today") return !!date && date <= todayDate;
        return false;
      });
      return [...smart, ...completedFor];
    }
    return smart;
  }, [selection, includeCompleted, allTasks, smartLists]);

  // Leaving the screen never loses a pending check-off or deletion: both are
  // committed right away instead of waiting for their undo window.
  React.useEffect(() => {
    const completions = completeTimers.current;
    const deletions = deleteTimers.current;
    return () => {
      for (const [id, timer] of completions) {
        clearTimeout(timer);
        void db.tasks.complete(id).catch(() => {});
      }
      for (const [id, timer] of deletions) {
        clearTimeout(timer);
        void db.tasks.remove(id).catch(() => {});
      }
    };
  }, []);

  const select = (next: Selection) => {
    setSelection(next);
    setShowListOnPhone(true);
    setIncludeCompleted(false);
    setHighlightedTaskId(undefined);
    focusSession.current?.cancel();
  };

  // The request handler runs long after this render: read the latest `select`
  // (it only touches setters and the focus session ref, so any instance does).
  const selectRef = React.useRef(select);
  selectRef.current = select;

  /**
   * Mac's sidebar "Lists" + button asks for the New List sheet through the
   * selection store (components/mac-sidebar.tsx): handle a request that arrived
   * before this screen mounted as well as ones that arrive while it is up.
   */
  React.useEffect(() => {
    if (!isMac) return;
    const openNewList = () => {
      if (useTasksSelectionStore.getState().takeNewListRequest())
        setEditingList(null);
    };
    openNewList();
    const unsubscribe = useTasksSelectionStore.subscribe(openNewList);
    return unsubscribe;
  }, [isMac]);

  /**
   * Mac's window toolbar sends "newTask" for its "New Task" button
   * (hooks/use-mac-menu-commands.ts): the same thing tapping the inline
   * "+ New Task" row does. The request is a counter rather than a flag so two
   * presses in a row both land.
   */
  const [composeRequest, setComposeRequest] = React.useState(0);
  React.useEffect(() => {
    const subscription = eSubscribeEvent(eCreateTaskRequest, () => {
      const current = selectionRef.current;
      // The Completed smart list is the one selection without a "+ New Task"
      // row (see `canAdd`); Today is where an added Task belongs, so land
      // there before revealing the row.
      if (current.kind === "smart" && current.id === "completed") {
        selectRef.current({ kind: "smart", id: "today" });
      }
      setComposeRequest((request) => request + 1);
      // The inline row grows the list's footer: bring it into view.
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    });
    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  const selectedSmart =
    selection.kind === "smart" ? taskSmartList(selection.id) : undefined;
  const selectedList =
    selection.kind === "list"
      ? lists.find((list) => list.id === selection.id)
      : undefined;
  const selectedLabel = selectedSmart
    ? selectedSmart.label()
    : selectedList?.name || strings.tasksList();
  /**
   * The selected list's own count, published with its title so Mac's window
   * subtitle shows "4 tasks" (see useMacListTitleStore / use-mac-window-title).
   * Smart lists use the same counts the sidebar rows do; a List uses its open
   * (not completed) task count, like its sidebar row.
   */
  const selectedCount =
    selection.kind === "smart"
      ? counts[selection.id]
      : listCounts[selection.id] || 0;
  const visibleTasks = tasks.filter((task) => !pendingDelete.has(task.id));
  const openCount = visibleTasks.filter((task) => !task.completed).length;
  const overdueCount = visibleTasks.filter((task) => isTaskOverdue(task)).length;
  const listSummary = [
    strings.tasksOpenCount(openCount),
    ...(overdueCount ? [strings.tasksOverdueCount(overdueCount)] : [])
  ].join(", ");
  const listNames = React.useMemo(
    () => new Map(lists.map((list) => [list.id, list.name])),
    [lists]
  );

  /**
   * Mac's window toolbar carries the list column's name, so the selected Task
   * list ("Today", a List's name) is published as the window's list title,
   * together with its count for the window's count-line subtitle.
   * Guarded like the Library header's publication (components/header/index.tsx):
   * the cleanup only clears the title this screen put there, so a list title
   * the Library header published - or one it publishes right after this screen
   * unmounts - is never swallowed. Inert on iPhone/iPad, which never read it.
   */
  const publishedTaskTitleRef = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!isMac) return;
    const title = selectedLabel || undefined;
    publishedTaskTitleRef.current = title;
    // The count goes with the title: Mac's window subtitle is the list's count
    // line. `selectedCount` changes on its own when a task is completed or
    // added, so it is a dependency, not a ref.
    if (title)
      useMacListTitleStore.getState().setListTitle(title, selectedCount);
  }, [isMac, selectedLabel, selectedCount]);
  React.useEffect(() => {
    if (!isMac) return;
    return () => {
      const published = publishedTaskTitleRef.current;
      if (
        published !== undefined &&
        useMacListTitleStore.getState().listTitle === published
      ) {
        useMacListTitleStore.getState().setListTitle(undefined);
      }
    };
  }, [isMac]);

  const openDetail = (
    task?: Task,
    draft?: { title?: string; date?: string; time?: string }
  ) => {
    Keyboard.dismiss();
    Navigation.push("TaskDetail", {
      ...(task ? { taskId: task.id } : {}),
      ...(selection.kind === "list" ? { listId: selection.id } : {}),
      ...(draft?.title ? { initialTitle: draft.title } : {}),
      ...(draft?.date ? { initialDate: draft.date } : {}),
      ...(draft?.time ? { initialTime: draft.time } : {}),
      ...(selection.kind === "smart" && selection.id === "flagged"
        ? { initialFlagged: true }
        : {})
    });
  };

  const createList = () => setEditingList(null);

  const deleteList = (list: TaskList) => {
    showAlert(strings.tasksDeleteList(), strings.tasksDeleteListConfirm(), [
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
            setShowListOnPhone(false);
            await refresh();
          } catch {
            showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
          }
        }
      }
    ]);
  };

  const editList = (list: TaskList) => setEditingList(list);

  /**
   * The list column's "Sort & View" menu (Show/Hide Completed, Edit List,
   * Delete List) as plain items/onSelect data, so it can serve two masters: the
   * column's own "…" button on iPhone/iPad, and - on Mac - the window toolbar's
   * Sort & View button, which opens whatever the focused screen publishes into
   * useMacWindowStore (components/header/index.tsx uses the same pattern). The
   * window toolbar's own `listOptions` command is what consumes it.
   */
  const taskListMenuItems = compactMenu([
    {
      title: "",
      inline: true,
      children: [
        {
          id: "toggle-completed",
          title: includeCompleted
            ? strings.tasksHideCompleted()
            : strings.tasksShowCompleted(),
          symbol: includeCompleted ? "eye.slash" : "eye",
          disabled: selection.kind === "smart" && selection.id === "completed"
        }
      ]
    },
    selectedList
      ? {
          title: "",
          inline: true,
          children: compactMenu([
            {
              id: "edit-list",
              title: strings.tasksEditList(),
              symbol: "info.circle"
            },
            selectedList.id !== defaultListId
              ? {
                  id: "delete-list",
                  title: strings.tasksDeleteList(),
                  symbol: "trash",
                  destructive: true
                }
              : undefined
          ])
        }
      : undefined
  ]);

  const onTaskListMenuSelect = (id: string) => {
    if (id === "toggle-completed") {
      setIncludeCompleted((value) => !value);
    } else if (id === "edit-list" && selectedList) editList(selectedList);
    else if (id === "delete-list" && selectedList) deleteList(selectedList);
  };

  /**
   * `items` and `onSelect` are rebuilt on every render, but the published
   * `onSelect` must stay stable: it delegates to the latest render's handler, so
   * switching between two Lists (whose menu items are identical) cannot leave
   * the toolbar's Sort & View editing the List that was selected when the menu
   * was published. The effect below only has to re-publish when the items
   * themselves change (a List's Edit/Delete group appearing, Show/Hide
   * Completed flipping).
   */
  const taskListMenuSelectRef = React.useRef(onTaskListMenuSelect);
  taskListMenuSelectRef.current = onTaskListMenuSelect;
  const publishedTaskListMenuSelect = React.useCallback(
    (id: string) => taskListMenuSelectRef.current(id),
    []
  );
  const taskListMenuSignature = taskListMenuItems
    .map((item) => `${item.id ?? item.title}:${item.checked ? 1 : 0}`)
    .join("|");
  const taskListMenuItemsRef = React.useRef(taskListMenuItems);
  taskListMenuItemsRef.current = taskListMenuItems;
  /**
   * Publish while this screen is the Tasks section on top, clear otherwise -
   * and follow section changes, because Tasks is not always unmounted when it
   * stops being the visible section (the Search section is pushed over the same
   * route). Otherwise Search's toolbar would keep opening the Tasks menu. The
   * cleanup only clears what this screen published, so the Library header's own
   * menu is never swallowed.
   */
  React.useEffect(() => {
    if (!isMac) return;
    const clear = () => {
      const current = useMacWindowStore.getState().listMenu;
      if (current && current.onSelect === publishedTaskListMenuSelect) {
        useMacWindowStore.getState().setListMenu(undefined);
      }
    };
    const sync = () => {
      if (useAppleNavigationStore.getState().section !== "tasks") {
        clear();
        return;
      }
      useMacWindowStore.getState().setListMenu({
        items: taskListMenuItemsRef.current,
        onSelect: publishedTaskListMenuSelect
      });
    };
    sync();
    const unsubscribe = useAppleNavigationStore.subscribe(sync);
    return () => {
      unsubscribe();
      clear();
    };
    // The signature re-publishes changed items; the ref carries the fresh
    // items into `sync`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, taskListMenuSignature, publishedTaskListMenuSelect]);

  const listMenu = () => (
    <IosMoreMenu
      accessibilityLabel={strings.more()}
      testID="task-list-more"
      items={taskListMenuItems}
      onSelect={onTaskListMenuSelect}
    />
  );

  const createTask = async (draft: string) => {
    const parsed = parseQuickAdd(draft);
    const title = parsed.title.trim();
    if (!title) return false;
    const smart = selection.kind === "smart" ? selection.id : undefined;
    // Adding in Today/Scheduled dates the Task today; Flagged flags it.
    const date =
      parsed.date ||
      (smart === "today" || smart === "scheduled"
        ? localCalendarDate(new Date())
        : undefined);
    try {
      const defaultList = await db.taskLists.default();
      if (date) await TaskNotifications.requestPermission().catch(() => false);
      await db.tasks.create({
        title,
        listId: selection.kind === "list" ? selection.id : defaultList.id,
        ...(date ? { reminderDate: date } : {}),
        ...(date && parsed.time ? { reminderTime: parsed.time } : {}),
        ...(smart === "flagged" ? { flagged: true } : {})
      });
      await refresh();
      return true;
    } catch {
      showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
      return false;
    }
  };

  const commitCompletion = async (task: Task) => {
    completeTimers.current.delete(task.id);
    try {
      await db.tasks.complete(task.id);
      await refresh();
      ToastManager.show({
        message: strings.tasksCompletedToast(),
        type: "success",
        context: "global",
        duration: UNDO_DELETE_MS,
        actionText: strings.tasksUndo(),
        func: async () => {
          try {
            await db.tasks.uncomplete(task.id);
            await refresh();
          } catch {
            showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
          }
        }
      });
    } catch {
      showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
    } finally {
      setPendingComplete((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };

  const toggleCompletion = async (task: Task) => {
    const pending = completeTimers.current.get(task.id);
    if (pending) {
      // Tapping the circle again during the linger cancels the check-off.
      clearTimeout(pending);
      completeTimers.current.delete(task.id);
      setPendingComplete((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
      return;
    }
    if (task.completed) {
      try {
        await db.tasks.uncomplete(task.id);
        await refresh();
      } catch {
        showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
      }
      return;
    }
    // Like Reminders: the Task stays, checked and struck through, for a moment
    // before it leaves the list.
    setPendingComplete((current) => new Set(current).add(task.id));
    completeTimers.current.set(
      task.id,
      setTimeout(
        () => void commitCompletion(task),
        includeCompleted ? 0 : COMPLETE_LINGER_MS
      )
    );
  };

  const toggleFlag = async (task: Task) => {
    try {
      await db.tasks.update(task.id, { flagged: !task.flagged });
      await refresh();
    } catch {
      showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
    }
  };

  const updateTask = async (task: Task, patch: Partial<Task>) => {
    try {
      await db.tasks.update(task.id, patch);
      await refresh();
    } catch {
      showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
    }
  };

  /** Deletes after an undo window instead of asking first. */
  const deleteTask = (task: Task) => {
    setPendingDelete((current) => new Set(current).add(task.id));
    const restore = () => {
      const timer = deleteTimers.current.get(task.id);
      if (timer) clearTimeout(timer);
      deleteTimers.current.delete(task.id);
      setPendingDelete((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    };
    deleteTimers.current.set(
      task.id,
      setTimeout(async () => {
        deleteTimers.current.delete(task.id);
        try {
          await db.tasks.remove(task.id);
          await refresh();
        } catch {
          showAlert(strings.tasksTitle(), strings.tasksCouldNotSave());
        } finally {
          setPendingDelete((current) => {
            const next = new Set(current);
            next.delete(task.id);
            return next;
          });
        }
      }, UNDO_DELETE_MS)
    );
    ToastManager.show({
      message: strings.tasksDeleted(),
      type: "info",
      context: "global",
      duration: UNDO_DELETE_MS,
      actionText: strings.tasksUndo(),
      func: restore
    });
  };

  const isScheduled =
    selection.kind === "smart" && selection.id === "scheduled";
  const rows = React.useMemo(
    () => taskListRows(visibleTasks, { perDay: isScheduled }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, pendingDelete, isScheduled]
  );

  React.useEffect(() => {
    const session = focusSession.current;
    if (!session) return;
    if (!focusTaskId) {
      session.cancel();
      return;
    }
    const requestId = String(focusRequestId);
    // Arriving from a notification/deep link must never land on a focused
    // input. Dismiss once per distinct request (not on every list refresh, so
    // typing in the new-task row is not interrupted by a background refresh).
    if (dismissedFocusRequest.current !== requestId) {
      dismissedFocusRequest.current = requestId;
      Keyboard.dismiss();
    }
    if (loading) return;
    // Arm focus for this request. The transient highlight only starts from the
    // FlatList viewability callback below once the row is actually on screen;
    // a fresh nonce on a repeat tap re-arms the whole thing.
    session.begin(
      { taskId: focusTaskId, requestId },
      resolveTaskFocusIndex(rows, focusTaskId)
    );
  }, [focusTaskId, focusRequestId, loading, rows]);

  React.useEffect(() => () => focusSession.current?.cancel(), []);

  const onScrollToIndexFailed = React.useCallback<
    NonNullable<
      React.ComponentProps<typeof FlatList<TaskListRow>>["onScrollToIndexFailed"]
    >
  >((info) => {
    // Bounded retry with increasing backoff -- never an unbounded loop. The
    // session uses its current index (not a stale one from this callback) and
    // aborts itself on a new intent, a list change or unmount.
    focusSession.current?.onScrollToIndexFailed(
      info.index,
      info.averageItemLength
    );
  }, []);

  // Highlight only once the row has genuinely settled on screen: at least half
  // of it visible for a short, explicit minimum so a transient fling past the
  // row does not flash the highlight.
  const viewabilityConfig = React.useRef({
    itemVisiblePercentThreshold: 50,
    minimumViewTime: 250
  }).current;
  const onViewableItemsChanged = React.useCallback<
    NonNullable<
      React.ComponentProps<typeof FlatList<TaskListRow>>["onViewableItemsChanged"]
    >
  >((info) => {
    focusSession.current?.watchViewable(
      info.viewableItems
        .filter((entry) => entry.item.kind === "task")
        .map((entry) => entry.item.id)
    );
  }, []);

  // No bar ever floats over the bottom on Mac (it shows the sections in the
  // list column instead), so there is nothing to scroll clear of there.
  const bottomInset =
    (Platform.OS === "ios" && !isMacCatalyst() ? APPLE_TAB_BAR_HEIGHT : 0) +
    safeAreaInsets.bottom +
    24;

  const tile = ({
    key,
    testID,
    label,
    count,
    symbol,
    color,
    active,
    onPress
  }: {
    key: string;
    testID: string;
    label: string;
    count: number;
    symbol: string;
    color: string;
    active: boolean;
    onPress: () => void;
  }) => (
    <Pressable
      key={key}
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count}`}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => ({
        width: accessibilityLayout ? "100%" : "47.5%",
        minHeight: accessibilityLayout ? 60 : 82,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor:
          active || pressed ? visual.selectedSurface : visual.contentSurface,
        ...(accessibilityLayout
          ? { flexDirection: "row", alignItems: "center", gap: 12 }
          : { justifyContent: "space-between" })
      })}
    >
      {accessibilityLayout ? (
        <>
          <SymbolTile symbol={symbol} color={color} shape="circle" size={34} />
          <Text
            style={{
              flex: 1,
              color: visual.primaryText,
              fontSize: 17,
              fontWeight: "600"
            }}
          >
            {label}
          </Text>
          <Text
            style={{
              color: visual.primaryText,
              fontSize: 22,
              fontWeight: "700"
            }}
          >
            {count}
          </Text>
        </>
      ) : (
        <>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "flex-start"
            }}
          >
            <SymbolTile
              symbol={symbol}
              color={color}
              shape="circle"
              size={32}
            />
            <Text
              numberOfLines={1}
              style={{
                color: visual.primaryText,
                fontSize: 26,
                fontWeight: "700",
                marginLeft: 8
              }}
            >
              {count}
            </Text>
          </View>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            style={{
              color: visual.secondaryText,
              fontSize: 16,
              fontWeight: "600",
              marginTop: 8
            }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );

  /**
   * The favourites overview. iPhone/iPad keep the 26 pt Reminders cards (and
   * the "Edit" bar button above); Mac draws compact source-list tiles instead,
   * and the removed Edit button becomes the tiles area's context menu
   * ("Edit Favorites").
   */
  const overviewTiles = (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        ...(isMac
          ? { gap: 8, paddingHorizontal: 12, paddingTop: 8 }
          : {
              justifyContent: "space-between",
              rowGap: 12,
              paddingHorizontal: 16,
              paddingTop: 6
            })
      }}
    >
      {favorites.flatMap((ref) => {
        const smart = ref.startsWith("smart:")
          ? taskSmartList(ref.slice(6) as TaskSmartListId)
          : undefined;
        if (smart && !TILE_SMART_LISTS.has(smart.id)) return [];
        const taskList = ref.startsWith("list:")
          ? lists.find((item) => item.id === ref.slice(5))
          : undefined;
        if (!smart && !taskList) return [];
        const next: Selection = smart
          ? { kind: "smart", id: smart.id }
          : { kind: "list", id: taskList!.id };
        // The current selection is only shown where the list sits next to the
        // overview: iPad and Mac (whose split view keeps `isTablet` true). On
        // iPhone nothing stays highlighted.
        const active =
          isTablet && selection.kind === next.kind && selection.id === next.id;
        const count = smart
          ? counts[smart.id]
          : listCounts[taskList!.id] || 0;
        const testID = smart
          ? `task-smart-${smart.id}`
          : `task-favorite-list-${taskList!.id}`;
        const label = smart ? smart.label() : taskList!.name;
        const symbol = smart
          ? smart.symbol
          : taskListSymbol(taskList!.symbol);
        const color = smart
          ? systemColor(smart.color, isDark)
          : taskListColor(taskList!.color);
        return [
          isMac ? (
            <MacOverviewTile
              key={ref}
              testID={testID}
              label={label}
              count={count}
              symbol={symbol}
              color={color}
              active={active}
              accessibilityLayout={accessibilityLayout}
              onPress={() => select(next)}
            />
          ) : (
            tile({
              key: ref,
              testID,
              label,
              count,
              symbol,
              color,
              active,
              onPress: () => select(next)
            })
          )
        ];
      })}
    </View>
  );

  const nav = (
    <ScrollView
      style={{ flex: 1 }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: bottomInset }}
    >
      {!isMac ? (
        <>
          <IosNavBar
            trailing={
              <IosBarButton
                label={strings.edit()}
                accessibilityLabel={strings.tasksEditFavorites()}
                onPress={() => setFavoritesEditorOpen(true)}
              />
            }
          />
          <IosLargeTitle title={strings.tasksTitle()} />
        </>
      ) : null}
      {isMac ? (
        <ContextMenu
          title={strings.tasksTitle()}
          items={[
            {
              id: "edit-favorites",
              title: strings.tasksEditFavorites(),
              symbol: "pencil"
            }
          ]}
          onSelect={(id) => {
            if (id === "edit-favorites") setFavoritesEditorOpen(true);
          }}
        >
          {overviewTiles}
        </ContextMenu>
      ) : (
        overviewTiles
      )}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: isMac ? 12 : 20,
          paddingTop: isMac ? 16 : 22,
          paddingBottom: isMac ? 4 : 10
        }}
      >
        <Text
          accessibilityRole="header"
          style={{
            flex: 1,
            color: isMac ? visual.secondaryText : visual.primaryText,
            fontSize: isMac ? 13 : 21,
            fontWeight: isMac ? "600" : "700"
          }}
        >
          {strings.tasksLists()}
        </Text>
        <IosBarButton
          symbol="plus"
          iconSize={isMac ? 16 : 23}
          accessibilityLabel={strings.tasksNewList()}
          onPress={createList}
        />
      </View>
      <View>
        {lists.map((item) => (
          <ContextMenu
            key={item.id}
            title={item.name}
            items={[
              {
                id: "edit",
                title: strings.tasksEditList(),
                symbol: "info.circle"
              },
              item.id !== defaultListId && {
                id: "delete",
                title: strings.tasksDeleteList(),
                symbol: "trash",
                destructive: true
              }
            ]}
            onSelect={(id) => {
              if (id === "edit") editList(item);
              else if (id === "delete") deleteList(item);
            }}
            style={{ marginHorizontal: isMac ? 0 : 20 }}
          >
            {isMac ? (
              <MacTaskListRow
                name={item.name}
                symbol={taskListSymbol(item.symbol)}
                color={taskListColor(item.color)}
                count={listCounts[item.id] || 0}
                selected={selection.kind === "list" && selection.id === item.id}
                onPress={() => select({ kind: "list", id: item.id })}
              />
            ) : (
              <Pressable
                onPress={() => select({ kind: "list", id: item.id })}
                accessibilityRole="button"
                accessibilityLabel={item.name}
                style={{
                  minHeight: 52,
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 12,
                  borderRadius: visual.controlRadius,
                  backgroundColor:
                    isTablet &&
                    selection.kind === "list" &&
                    selection.id === item.id
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
                <TaskSymbolView
                  name="chevron.right"
                  size={13}
                  color={visual.tertiaryText}
                />
              </Pressable>
            )}
          </ContextMenu>
        ))}
      </View>
    </ScrollView>
  );

  const renderTask = (item: Task) => {
    const checked = item.completed || pendingComplete.has(item.id);
    const schedule = taskReminderSchedule(item);
    const overdue = isTaskOverdue(item) && !checked;
    const listName =
      selection.kind === "smart" ? listNames.get(item.listId) : undefined;
    const marks = priorityMarks(item.priority);
    const menu: NativeMenuItem[] = [
      {
        title: "",
        inline: true,
        children: [
          {
            id: "details",
            title: strings.tasksDetails(),
            symbol: "info.circle"
          }
        ]
      },
      {
        title: "",
        inline: true,
        children: [
          {
            id: "complete",
            title: item.completed
              ? strings.tasksMarkIncomplete()
              : strings.tasksComplete(),
            symbol: item.completed ? "circle" : "checkmark.circle"
          },
          {
            id: "flag",
            title: item.flagged ? strings.tasksUnflag() : strings.tasksFlag(),
            symbol: item.flagged ? "flag.slash" : "flag"
          },
          {
            title: strings.tasksPriority(),
            symbol: "exclamationmark",
            children: (["none", "low", "medium", "high"] as TaskPriority[]).map(
              (value) => ({
                id: `priority:${value}`,
                title:
                  value === "none"
                    ? strings.tasksPriorityNone()
                    : value === "low"
                      ? strings.tasksPriorityLow()
                      : value === "medium"
                        ? strings.tasksPriorityMedium()
                        : strings.tasksPriorityHigh(),
                checked: item.priority === value
              })
            )
          },
          {
            title: strings.tasksMoveToList(),
            symbol: "folder",
            children: lists.map((list) => ({
              id: `list:${list.id}`,
              title: list.name,
              symbol: taskListSymbol(list.symbol),
              checked: list.id === item.listId
            }))
          }
        ]
      },
      {
        title: "",
        inline: true,
        children: [
          {
            id: "delete",
            title: strings.tasksDelete(),
            symbol: "trash",
            destructive: true
          }
        ]
      }
    ];
    return (
      <SwipeRow
        leading={[
          {
            key: "complete",
            label: item.completed
              ? strings.tasksMarkIncomplete()
              : strings.tasksComplete(),
            symbol: item.completed ? "arrow.uturn.backward" : "checkmark",
            color: item.completed
              ? systemColor("gray", isDark)
              : systemColor("green", isDark),
            onPress: () => void toggleCompletion(item)
          }
        ]}
        trailing={[
          {
            key: "delete",
            label: strings.delete(),
            symbol: "trash.fill",
            color: systemColor("red", isDark),
            onPress: () => deleteTask(item)
          },
          {
            key: "flag",
            label: item.flagged ? strings.tasksUnflag() : strings.tasksFlag(),
            symbol: item.flagged ? "flag.slash.fill" : "flag.fill",
            color: systemColor("orange", isDark),
            onPress: () => void toggleFlag(item)
          },
          {
            key: "details",
            label: strings.tasksDetails(),
            symbol: "info.circle.fill",
            color: systemColor("gray", isDark),
            onPress: () => openDetail(item)
          }
        ]}
      >
        <ContextMenu
          title={item.title}
          items={menu}
          previewCornerRadius={10}
          onSelect={(id) => {
            if (id === "details") openDetail(item);
            else if (id === "complete") void toggleCompletion(item);
            else if (id === "flag") void toggleFlag(item);
            else if (id === "delete") deleteTask(item);
            else if (id.startsWith("priority:"))
              void updateTask(item, {
                priority: id.slice(9) as TaskPriority
              });
            else if (id.startsWith("list:"))
              void updateTask(item, { listId: id.slice(5) });
          }}
        >
          <TaskRowSurface
            testID={`task-row-${item.id}`}
            highlighted={item.id === highlightedTaskId}
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              minHeight: 52,
              paddingLeft: 16,
              backgroundColor:
                item.id === highlightedTaskId
                  ? visual.selectedSurface
                  : visual.screenBackground
            }}
          >
            <Pressable
              onPress={() => toggleCompletion(item)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              accessibilityLabel={`${
                checked ? strings.tasksUncomplete() : strings.tasksComplete()
              }: ${item.title}`}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 34,
                paddingTop: 13,
                opacity: pressed ? 0.55 : 1
              })}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 1.5,
                  borderColor: checked
                    ? colors.primary.accent
                    : visual.tertiaryText,
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                {checked && (
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 7,
                      backgroundColor: colors.primary.accent
                    }}
                  />
                )}
              </View>
            </Pressable>
            <Pressable
              onPress={() => openDetail(item)}
              accessibilityRole="button"
              accessibilityLabel={taskAccessibilityLabel(item, listName)}
              accessibilityHint={strings.tasksDetails()}
              style={{
                flex: 1,
                paddingVertical: 12,
                paddingRight: 16,
                borderBottomWidth: 0.5,
                borderBottomColor: visual.separator
              }}
            >
              <Text
                style={{
                  color: checked ? visual.secondaryText : visual.primaryText,
                  fontSize: 17,
                  textDecorationLine: checked ? "line-through" : "none"
                }}
              >
                {marks ? (
                  <Text style={{ color: colors.primary.accent }}>{marks} </Text>
                ) : null}
                {item.title}
              </Text>
              {item.description ? (
                <Text
                  numberOfLines={2}
                  style={{
                    color: visual.secondaryText,
                    fontSize: 15,
                    marginTop: 2
                  }}
                >
                  {item.description}
                </Text>
              ) : null}
              {schedule.date || item.urgent || item.flagged || listName ? (
                <View
                  style={{
                    flexDirection: "row",
                    gap: 6,
                    marginTop: 3,
                    alignItems: "center",
                    flexWrap: "wrap"
                  }}
                >
                  {item.urgent && (
                    <TaskSymbolView
                      name="alarm.fill"
                      size={14}
                      color={systemColor("red", isDark)}
                      accessibilityLabel={strings.tasksUrgent()}
                    />
                  )}
                  {schedule.date ? (
                    <Text
                      style={{
                        color: overdue
                          ? systemColor("red", isDark)
                          : visual.secondaryText,
                        fontSize: 15
                      }}
                    >
                      {scheduleLabel(item)}
                    </Text>
                  ) : null}
                  {schedule.date && item.recurrenceRule ? (
                    <TaskSymbolView
                      name="repeat"
                      size={12}
                      color={visual.secondaryText}
                    />
                  ) : null}
                  {listName ? (
                    <Text style={{ color: visual.secondaryText, fontSize: 15 }}>
                      {schedule.date ? "· " : ""}
                      {listName}
                    </Text>
                  ) : null}
                  {item.flagged && (
                    <TaskSymbolView
                      name="flag.fill"
                      size={13}
                      color={systemColor("orange", isDark)}
                      accessibilityLabel={strings.tasksFlag()}
                    />
                  )}
                </View>
              ) : null}
              {item.urgent && !!item.recurrenceRule && !item.completed && (
                <Text
                  style={{
                    color: visual.secondaryText,
                    fontSize: 13,
                    marginTop: 4
                  }}
                >
                  {strings.tasksUrgentRepeatLimit()}
                </Text>
              )}
            </Pressable>
          </TaskRowSurface>
        </ContextMenu>
      </SwipeRow>
    );
  };

  const canAdd = selection.kind === "list" || selection.id !== "completed";
  const accent = colors.primary.accent;

  const list = (
    <View style={{ flex: 1 }}>
      {isMac ? (
        /**
         * Mac's window toolbar is this column's chrome: it shows the selected
         * list's name (published through useMacListTitleStore above) and opens
         * the list menu published through useMacWindowStore, so the column
         * itself draws neither a nav bar nor a large title. Only the summary
         * line a List shows stays, as the compact 12 pt secondary row macOS
         * uses for such metadata.
         */
        selection.kind === "list" && !loading ? (
          <Text
            style={{
              color: visual.secondaryText,
              fontSize: 12,
              paddingHorizontal: 16,
              paddingTop: 8,
              paddingBottom: 2
            }}
          >
            {listSummary}
          </Text>
        ) : null
      ) : (
        <>
          {!isTablet ? (
            <IosNavBar
              backTitle={strings.tasksTitle()}
              onBack={() => {
                Keyboard.dismiss();
                setShowListOnPhone(false);
              }}
              trailing={listMenu()}
            />
          ) : (
            <IosNavBar trailing={listMenu()} />
          )}
          <IosLargeTitle
            title={selectedLabel}
            color={accent}
            subtitle={
              selection.kind === "list" && !loading ? listSummary : undefined
            }
          />
        </>
      )}
      {loading ? (
        <ActivityIndicator
          style={{ marginTop: 40 }}
          color={accent}
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
          // Remount on a list/Show-Completed change so the new list starts at
          // the top (the old spinner round-trip used to remount it for us).
          key={`${selection.kind}:${selection.id}:${includeCompleted ? 1 : 0}`}
          ref={listRef}
          data={rows}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
          onScrollToIndexFailed={onScrollToIndexFailed}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          contentContainerStyle={{ paddingBottom: bottomInset, flexGrow: 1 }}
          ListEmptyComponent={
            canAdd ? null : (
              <Text
                style={{
                  color: visual.secondaryText,
                  textAlign: "center",
                  marginTop: 50,
                  fontSize: 17
                }}
              >
                {strings.tasksSmartListNoCompleted()}
              </Text>
            )
          }
          ListFooterComponent={
            canAdd ? (
              <NewTaskRow
                key={`${selection.kind}:${selection.id}`}
                onCreate={createTask}
                onDetails={(draft) => openDetail(undefined, draft)}
                composeRequest={composeRequest}
              />
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === "header" ? (
              <Text
                accessibilityRole="header"
                style={{
                  color:
                    item.section === "overdue"
                      ? systemColor("red", isDark)
                      : visual.primaryText,
                  fontSize: 20,
                  fontWeight: "700",
                  paddingHorizontal: 16,
                  paddingTop: 22,
                  paddingBottom: 4
                }}
              >
                {sectionTitle(item)}
              </Text>
            ) : (
              renderTask(item.task)
            )
          }
        />
      )}
    </View>
  );

  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={{
        flex: 1,
        backgroundColor: visual.screenBackground,
        flexDirection: "row"
      }}
    >
      {/* Mac's Tasks section is only the selected list's content: its smart
          lists and user Lists live in the sidebar (components/mac-sidebar.tsx),
          so the overview/list column is not drawn there. */}
      {!isMac && (isTablet || !showListOnPhone) && (
        <View
          style={{
            flex: 1,
            maxWidth: isTablet ? 340 : undefined,
            borderRightWidth: isTablet ? 0.5 : 0,
            borderRightColor: visual.separator
          }}
        >
          {nav}
        </View>
      )}
      {(isMac || isTablet || showListOnPhone) && (
        <View style={{ flex: isMac ? 1 : isTablet ? 2 : 1 }}>{list}</View>
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

/**
 * One favourites tile on Mac: a compact two-column card instead of the 82 pt
 * Reminders tile - 24 pt symbol circle, 13 pt semibold secondary label, 20 pt
 * bold right-aligned count - with macOS' own selection fill rather than the
 * theme's `selectedSurface` (see macSelectionFill / mac-system-state.ts). The
 * two columns come from the wrapping row's 8 pt gap and this card's 48% width
 * (a lone last tile keeps that width, as in a source list); the accessibility
 * text sizes fall back to one column.
 */
function MacOverviewTile({
  testID,
  label,
  count,
  symbol,
  color,
  active,
  accessibilityLayout,
  onPress
}: {
  testID: string;
  label: string;
  count: number;
  symbol: string;
  color: string;
  active: boolean;
  accessibilityLayout: boolean;
  onPress: () => void;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const systemAccent = useMacSystemStore((state) => state.accent);
  const windowActive = useMacSystemStore((state) => state.active);
  const selection = macSelectionFill(
    macAccent(colors.primary.accent, systemAccent),
    windowActive,
    isDark
  );
  const { hovered, hoverProps } = useMacHover();
  return (
    <Pressable
      {...hoverProps}
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count}`}
      accessibilityState={{ selected: active }}
      style={{
        width: accessibilityLayout ? "100%" : "48%",
        minHeight: 56,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: MAC_TILE_RADIUS,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        overflow: "hidden"
      }}
    >
      <MacHoverHighlight visible={hovered && !active} radius={MAC_TILE_RADIUS} />
      {active ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: MAC_TILE_RADIUS,
            backgroundColor: selection.color,
            opacity: selection.opacity
          }}
        />
      ) : null}
      <SymbolTile
        symbol={symbol}
        color={color}
        shape="circle"
        size={MAC_TILE_ICON_SIZE}
      />
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          color: visual.secondaryText,
          fontSize: 13,
          fontWeight: "600"
        }}
      >
        {label}
      </Text>
      <Text
        style={{ color: visual.primaryText, fontSize: 20, fontWeight: "700" }}
      >
        {count}
      </Text>
    </Pressable>
  );
}

/**
 * One List row of the Mac overview: a source-list row (6 pt rounded selection
 * fill, 10 pt inset, 8 pt inner padding, no chevron) with the List's open-Task
 * count right-aligned in the secondary color - the compact macOS counterpart of
 * the 52 pt chevron row iPhone/iPad keep.
 */
function MacTaskListRow({
  name,
  symbol,
  color,
  count,
  selected,
  onPress
}: {
  name: string;
  symbol: string;
  color: string;
  count: number;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const systemAccent = useMacSystemStore((state) => state.accent);
  const windowActive = useMacSystemStore((state) => state.active);
  const selection = macSelectionFill(
    macAccent(colors.primary.accent, systemAccent),
    windowActive,
    isDark
  );
  const { hovered, hoverProps } = useMacHover();
  return (
    <Pressable
      {...hoverProps}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ selected }}
      style={{
        minHeight: 30,
        flexDirection: "row",
        alignItems: "center",
        marginHorizontal: MAC_ROW_INSET,
        paddingHorizontal: MAC_ROW_PADDING,
        borderRadius: MAC_ROW_RADIUS,
        overflow: "hidden"
      }}
    >
      <MacHoverHighlight visible={hovered && !selected} radius={MAC_ROW_RADIUS} />
      {selected ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: MAC_ROW_RADIUS,
            backgroundColor: selection.color,
            opacity: selection.opacity
          }}
        />
      ) : null}
      <TaskSymbolView
        name={symbol}
        size={20}
        color={selected ? selection.color : color}
      />
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          color: visual.primaryText,
          fontSize: 14,
          marginLeft: 8
        }}
      >
        {name}
      </Text>
      <Text style={{ color: visual.secondaryText, fontSize: 13, marginLeft: 8 }}>
        {count}
      </Text>
    </Pressable>
  );
}

/**
 * One Task row's hover shell. It handles no presses of its own - the circle and
 * the title inside the row do - so it exists only to draw the Mac pointer
 * highlight (`onHoverIn`/`onHoverOut`; inert on iPhone/iPad). A highlighted
 * (focused) row keeps its selection background: the hover layer is only
 * rendered while the row is not the highlighted one.
 */
function TaskRowSurface({
  testID,
  highlighted,
  style,
  children
}: {
  testID: string;
  highlighted: boolean;
  style: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const { hovered, hoverProps } = useMacHover();
  return (
    /* `accessible={false}`: a Pressable is an accessibility element by default
       and would hide the row's own checkbox and title (the two Pressables
       inside) from VoiceOver. The row is a container, as it was before it
       gained the pointer handlers. */
    <Pressable
      {...hoverProps}
      accessible={false}
      testID={testID}
      accessibilityState={{ selected: highlighted }}
      style={style}
    >
      <MacHoverHighlight visible={hovered && !highlighted} />
      {children}
    </Pressable>
  );
}

/**
 * The Reminders-style "+ New Task" row at the end of a list. Tapping it adds an
 * inline row; Return saves and starts the next one, ⓘ opens the details.
 * Dates and times typed in the title ("tomorrow 9am", "morgen 9 Uhr") are
 * recognised; the chips set them with one tap.
 *
 * `composeRequest` is a counter the Mac toolbar bumps (see eCreateTaskRequest in
 * utils/events.js): a change reveals the same inline row a tap would, without
 * the caller having to reach into this component.
 */
function NewTaskRow({
  onCreate,
  onDetails,
  composeRequest = 0
}: {
  onCreate: (draft: string) => Promise<boolean>;
  onDetails: (draft: { title?: string; date?: string; time?: string }) => void;
  composeRequest?: number;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const [composing, setComposing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const input = React.useRef<TextInput>(null);
  const accent = colors.primary.accent;
  const parsed = draft.trim() ? parseQuickAdd(draft) : undefined;

  React.useEffect(() => {
    // 0 is the initial value (nothing was requested yet).
    if (composeRequest > 0) setComposing(true);
  }, [composeRequest]);

  const submit = async () => {
    if (busy) return;
    if (!draft.trim()) {
      setComposing(false);
      Keyboard.dismiss();
      return;
    }
    setBusy(true);
    const created = await onCreate(draft);
    setBusy(false);
    if (created) setDraft("");
  };

  const chip = (label: string, suffix: string) => (
    <Pressable
      key={label}
      onPress={() => {
        const base = parseQuickAdd(draft).title;
        setDraft(`${base ? `${base} ` : ""}${suffix}`);
        input.current?.focus();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        paddingHorizontal: 12,
        minHeight: 32,
        justifyContent: "center",
        borderRadius: 16,
        backgroundColor: pressed
          ? visual.selectedSurface
          : isDark
            ? "#2C2C2E"
            : "rgba(118,118,128,0.12)"
      })}
    >
      <Text style={{ color: visual.primaryText, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );

  if (!composing)
    return (
      <Pressable
        testID="task-new-row"
        onPress={() => setComposing(true)}
        accessibilityRole="button"
        accessibilityLabel={strings.tasksNewTaskRow()}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 50,
          paddingHorizontal: 16,
          opacity: pressed ? 0.5 : 1
        })}
      >
        <TaskSymbolView name="plus.circle.fill" size={23} color={accent} />
        <Text style={{ color: accent, fontSize: 17, fontWeight: "500" }}>
          {strings.tasksNewTaskRow()}
        </Text>
      </Pressable>
    );

  return (
    <View style={{ paddingLeft: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: 1.5,
            borderColor: visual.tertiaryText,
            marginRight: 12
          }}
        />
        <TextInput
          ref={input}
          testID="task-quick-add-input"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          onBlur={() => {
            if (!draft.trim()) setComposing(false);
          }}
          autoFocus
          blurOnSubmit={false}
          returnKeyType="next"
          textContentType="none"
          autoComplete="off"
          importantForAutofill="no"
          placeholder={strings.tasksNewTaskRow()}
          placeholderTextColor={visual.tertiaryText}
          accessibilityLabel={strings.tasksNewTaskRow()}
          style={{
            flex: 1,
            color: visual.primaryText,
            fontSize: 17,
            minHeight: 48
          }}
        />
        <Pressable
          onPress={() => {
            const value = draft.trim() ? parseQuickAdd(draft) : undefined;
            setDraft("");
            setComposing(false);
            onDetails({
              title: value?.title,
              date: value?.date,
              time: value?.time
            });
          }}
          accessibilityRole="button"
          accessibilityLabel={strings.tasksDetails()}
          hitSlop={8}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            marginRight: 8
          }}
        >
          <TaskSymbolView name="info.circle" size={22} color={accent} />
        </Pressable>
      </View>
      {parsed?.date ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            marginLeft: 34,
            marginBottom: 4
          }}
        >
          <TaskSymbolView name="calendar" size={13} color={accent} />
          <Text style={{ color: accent, fontSize: 14 }}>
            {relativeDateLabel(parsed.date)}
            {parsed.time ? `, ${timeLabel(parsed.time)}` : ""}
          </Text>
        </View>
      ) : null}
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          gap: 8,
          paddingLeft: 34,
          paddingRight: 16,
          paddingBottom: 10
        }}
      >
        {chip(strings.tasksToday(), "today")}
        {chip(strings.tasksTomorrow(), "tomorrow")}
        {chip(strings.tasksInOneHour(), "in 1 hour")}
        {chip(strings.tasksThisEvening(), "this evening")}
      </ScrollView>
    </View>
  );
}
