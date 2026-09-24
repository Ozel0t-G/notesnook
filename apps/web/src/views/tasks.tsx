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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { strings } from "@notesnook/intl";
import {
  DatabaseUpdatedEvent,
  EVENTS,
  taskReminderSchedule
} from "@notesnook/core";
import { TaskFavorite } from "@notesnook/core";
import { db } from "../common/db";
import {
  SmartTaskList,
  TaskListRecord,
  TaskRecord,
  compareTasks,
  taskDomain,
  taskIsOverdue
} from "../common/task-domain";
import { TaskDialog } from "../dialogs/task-dialog";
import { TaskListDialog } from "../dialogs/task-list-dialog";
import { TaskListGlyph } from "../components/task-list-appearance";
import { ConfirmDialog } from "../dialogs/confirm";
import { NavigationEvents } from "../navigation";
import { showToast } from "../utils/toast";
import { logger } from "../utils/logger";
import { Menu } from "../hooks/use-menu";
import { isMac } from "../utils/platform";
import {
  Check,
  MoreHorizontal,
  Plus,
  ArrowLeft,
  Search,
  Cross,
  Calendar,
  Date as DateIcon,
  TableOfContents,
  Pin,
  CheckCircleOutline,
  type Icon
} from "../components/icons";
import "../styles/veyran-mac-tasks.css";

type TaskSelection = SmartTaskList | `list:${string}`;

const smartLists: { id: SmartTaskList; title: () => string; icon: Icon }[] = [
  { id: "today", title: strings.tasksToday, icon: Calendar },
  { id: "scheduled", title: strings.tasksScheduled, icon: DateIcon },
  { id: "all", title: strings.tasksAll, icon: TableOfContents },
  { id: "flagged", title: strings.tasksFlagged, icon: Pin },
  { id: "completed", title: strings.tasksCompleted, icon: CheckCircleOutline }
];

function todayKey(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function countForSmartList(kind: SmartTaskList, tasks: TaskRecord[]): number {
  const today = todayKey();
  return tasks.filter((task) => {
    if (kind === "completed") return task.completed;
    if (task.completed) return false;
    const schedule = taskReminderSchedule(task);
    switch (kind) {
      case "today":
        return Boolean(schedule.date && schedule.date <= today);
      case "scheduled":
        return Boolean(schedule.date && schedule.date >= today);
      case "flagged":
        return task.flagged;
      default:
        return true;
    }
  }).length;
}

function reminderLabel(task: TaskRecord): string | undefined {
  const schedule = taskReminderSchedule(task);
  const dateValue = schedule.date;
  if (!dateValue) return undefined;
  const timeValue = schedule.time;
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(year !== new Date().getFullYear() ? { year: "numeric" } : {})
  }).format(date);
  if (!timeValue) return formatted;
  const [hour, minute] = timeValue.split(":").map(Number);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(year, month - 1, day, hour, minute));
  return `${formatted} · ${time}`;
}

function repeatLabel(task: TaskRecord): string {
  switch (task.recurrenceRule) {
    case undefined:
    case "":
      return strings.tasksNone();
    case "FREQ=DAILY":
      return strings.tasksDaily();
    case "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR":
      return strings.tasksWeekdays();
    case "FREQ=WEEKLY;BYDAY=SA,SU":
      return strings.tasksWeekends();
    case "FREQ=WEEKLY":
      return strings.tasksWeekly();
    case "FREQ=WEEKLY;INTERVAL=2":
      return strings.tasksBiweekly();
    case "FREQ=MONTHLY":
      return strings.tasksMonthly();
    case "FREQ=MONTHLY;INTERVAL=3":
      return strings.tasksEveryThreeMonths();
    case "FREQ=MONTHLY;INTERVAL=6":
      return strings.tasksEverySixMonths();
    case "FREQ=YEARLY":
      return strings.tasksYearly();
    default:
      return strings.tasksCustom();
  }
}

function scheduledGroups(tasks: TaskRecord[]) {
  const byDate = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const date = taskReminderSchedule(task).date;
    if (!date) continue;
    const group = byDate.get(date) || [];
    group.push(task);
    byDate.set(date, group);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function sectionDateLabel(dateKey: string): string {
  if (dateKey === todayKey()) return strings.tasksToday();
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(new Date(year, month - 1, day));
}

export default function Tasks() {
  const [selection, setSelection] = useState<TaskSelection>("today");
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [visibleTasks, setVisibleTasks] = useState<TaskRecord[]>([]);
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [lists, setLists] = useState<TaskListRecord[]>([]);
  const [favorites, setFavorites] = useState<TaskFavorite[]>([]);
  const favoritesRef = useRef<TaskFavorite[]>([]);
  const favoriteSave = useRef(Promise.resolve());
  const pendingFavoriteWrites = useRef(0);
  const draggedFavorite = useRef<TaskFavorite | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskQuery, setTaskQuery] = useState("");
  const [defaultListId, setDefaultListId] = useState("");
  const [title, setTitle] = useState("");
  const [quickReminderDate, setQuickReminderDate] = useState("");
  const [quickReminderTime, setQuickReminderTime] = useState("");
  const [quickPriority, setQuickPriority] = useState<
    "none" | "low" | "medium" | "high"
  >("none");
  const [quickFlagged, setQuickFlagged] = useState(false);
  const [showQuickOptions, setShowQuickOptions] = useState(false);
  const [quickListId, setQuickListId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const quickInputRef = useRef<HTMLInputElement>(null);
  const refreshId = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++refreshId.current;
    try {
      const [allTasks, allLists, savedFavorites] = await Promise.all([
        taskDomain.tasks.list(),
        taskDomain.taskLists.list(),
        taskDomain.taskFavorites.list()
      ]);
      const defaultList = await taskDomain.taskLists.default();
      const selectedTasks = selection.startsWith("list:")
        ? allTasks.filter(
            (task) => task.listId === selection.slice(5) && !task.completed
          )
        : await taskDomain.tasks.smartList(selection as SmartTaskList);
      if (request !== refreshId.current) return;
      setTasks(allTasks);
      setLists(allLists);
      const resolvedFavorites = savedFavorites.filter(
        (item) =>
          !item.startsWith("list:") ||
          allLists.some((list) => list.id === item.slice(5))
      );
      // A settings update can trigger refresh before an optimistic Favorites
      // write finishes. Keep the queued local order until storage catches up.
      if (pendingFavoriteWrites.current === 0) {
        favoritesRef.current = resolvedFavorites;
        setFavorites(resolvedFavorites);
      }
      setDefaultListId(defaultList.id);
      setVisibleTasks(
        selection === "completed"
          ? [...selectedTasks]
          : [...selectedTasks].sort(compareTasks)
      );
      setQuickListId((current) =>
        allLists.some((list) => list.id === current)
          ? current
          : allLists[0]?.id || ""
      );
      setLoading(false);
      setError("");
    } catch (cause) {
      if (request !== refreshId.current) return;
      setLoading(false);
      logger.error(cause);
      setError(strings.tasksCouldNotLoad());
    }
  }, [selection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => setVisibleLimit(100), [selection]);

  useEffect(() => {
    const database = db.eventManager.subscribe(
      EVENTS.databaseUpdated,
      (event: DatabaseUpdatedEvent) => {
        if (event.collection === "settings" || event.collection === "reminders")
          void refresh();
      }
    );
    const sync = db.eventManager.subscribe(
      EVENTS.syncCompleted,
      () => void refresh()
    );
    const appRefresh = db.eventManager.subscribe(
      EVENTS.appRefreshRequested,
      () => void refresh()
    );
    const navigation = NavigationEvents.subscribe(
      "onNavigate",
      (route: { key: string }) => {
        if (route?.key === "tasks") void refresh();
      }
    );
    return () => {
      database.unsubscribe();
      sync.unsubscribe();
      appRefresh.unsubscribe();
      navigation.unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    let midnight: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = new Date();
      const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1
      );
      midnight = setTimeout(() => {
        void refresh();
        schedule();
      }, next.getTime() - now.getTime() + 100);
    };
    const onFocus = () => void refresh();
    schedule();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(midnight);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!window.location.pathname.startsWith("/tasks")) return;
      if (
        !(event.metaKey || event.ctrlKey) ||
        !event.shiftKey ||
        event.key.toLowerCase() !== "t"
      )
        return;
      event.preventDefault();
      quickInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedTitle = useMemo(() => {
    if (selection.startsWith("list:")) {
      return (
        lists.find((list) => list.id === selection.slice(5))?.name ||
        strings.tasksLists()
      );
    }
    return (
      smartLists.find((list) => list.id === selection)?.title() ||
      strings.tasksTitle()
    );
  }, [selection, lists]);
  const filteredTasks = useMemo(() => {
    const query = taskQuery.trim().toLocaleLowerCase();
    return query
      ? visibleTasks.filter((task) =>
          `${task.title} ${task.description || ""}`
            .toLocaleLowerCase()
            .includes(query)
        )
      : visibleTasks;
  }, [visibleTasks, taskQuery]);
  const displayedTasks = useMemo(
    () => filteredTasks.slice(0, visibleLimit),
    [filteredTasks, visibleLimit]
  );
  const availableFavorites = useMemo(
    () =>
      [
        ...smartLists.map((item) => `smart:${item.id}` as TaskFavorite),
        ...lists.map((item) => `list:${item.id}` as TaskFavorite)
      ].filter((item) => !favorites.includes(item)),
    [lists, favorites]
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId),
    [tasks, selectedTaskId]
  );
  const selectedList = useMemo(
    () => lists.find((list) => list.id === selectedTask?.listId),
    [lists, selectedTask]
  );
  const listCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (!task.completed)
        counts.set(task.listId, (counts.get(task.listId) || 0) + 1);
    }
    return counts;
  }, [tasks]);
  const smartCounts = useMemo(
    () =>
      new Map(
        smartLists.map((list) => [list.id, countForSmartList(list.id, tasks)])
      ),
    [tasks]
  );

  function favoriteTitle(item: TaskFavorite): string {
    if (item.startsWith("list:"))
      return (
        lists.find((list) => list.id === item.slice(5))?.name ||
        strings.tasksLists()
      );
    return (
      smartLists.find((smart) => smart.id === item.slice(6))?.title() ||
      strings.tasksTitle()
    );
  }

  async function openTask(task?: TaskRecord) {
    const changed = await TaskDialog.show({
      task,
      lists,
      defaultListId: selection.startsWith("list:")
        ? selection.slice(5)
        : quickListId
    });
    if (changed) await refresh();
  }

  async function quickAdd() {
    if (!title.trim()) return;
    try {
      const defaultList =
        quickListId || (await taskDomain.taskLists.default()).id;
      await taskDomain.tasks.create({
        title: title.trim(),
        listId: defaultList,
        reminderDate: quickReminderDate || undefined,
        reminderTime:
          quickReminderDate && quickReminderTime
            ? quickReminderTime
            : undefined,
        priority: quickPriority,
        flagged: quickFlagged
      } as Parameters<typeof taskDomain.tasks.create>[0]);
      setTitle("");
      setQuickReminderDate("");
      setQuickReminderTime("");
      setQuickPriority("none");
      setQuickFlagged(false);
      await refresh();
      quickInputRef.current?.focus();
    } catch (cause) {
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
    }
  }

  async function createList() {
    if (await TaskListDialog.show({})) await refresh();
  }

  async function editList(list: TaskListRecord) {
    if (await TaskListDialog.show({ list })) await refresh();
  }

  async function saveFavorites(next: TaskFavorite[]) {
    const previous = favoritesRef.current;
    pendingFavoriteWrites.current += 1;
    favoritesRef.current = next;
    setFavorites(next);
    const save = favoriteSave.current
      .catch(() => undefined)
      .then(() => taskDomain.taskFavorites.set(next));
    favoriteSave.current = save;
    try {
      await save;
    } catch (cause) {
      if (favoritesRef.current === next) {
        favoritesRef.current = previous;
        setFavorites(previous);
      }
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
    } finally {
      pendingFavoriteWrites.current -= 1;
      if (pendingFavoriteWrites.current === 0) void refresh();
    }
  }

  function moveFavorite(item: TaskFavorite, offset: number) {
    const current = favoritesRef.current;
    const from = current.indexOf(item);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= current.length) return;
    const next = [...current];
    next.splice(from, 1);
    next.splice(to, 0, item);
    void saveFavorites(next);
  }

  async function deleteList(list: TaskListRecord) {
    const confirmed = await ConfirmDialog.show({
      title: strings.tasksDeleteList(),
      message: strings.tasksDeleteListConfirm(),
      positiveButtonText: strings.tasksDeleteList(),
      negativeButtonText: strings.cancel()
    });
    if (!confirmed) return;
    try {
      await taskDomain.taskLists.remove(list.id);
      await saveFavorites(
        favoritesRef.current.filter((ref) => ref !== `list:${list.id}`)
      );
      setSelection("all");
      await refresh();
    } catch (cause) {
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
    }
  }

  async function toggleTask(task: TaskRecord) {
    try {
      if (task.completed) await taskDomain.tasks.uncomplete(task.id);
      else await taskDomain.tasks.complete(task.id);
      await refresh();
    } catch (cause) {
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
    }
  }

  async function toggleFlag(task: TaskRecord) {
    try {
      await taskDomain.tasks.update(task.id, { flagged: !task.flagged });
      await refresh();
    } catch (cause) {
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
    }
  }

  async function deleteTask(task: TaskRecord) {
    const confirmed = await ConfirmDialog.show({
      title: strings.tasksDelete(),
      message: task.title,
      positiveButtonText: strings.tasksDelete(),
      negativeButtonText: strings.cancel()
    });
    if (!confirmed) return;
    try {
      await taskDomain.tasks.remove(task.id);
      await refresh();
    } catch (cause) {
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
    }
  }

  function openFavoriteMenu(item?: TaskFavorite) {
    const index = item ? favoritesRef.current.indexOf(item) : -1;
    Menu.openMenu(
      item
        ? [
            {
              type: "button",
              key: "move-favorite-up",
              title: strings.tasksMoveFavoriteUp(),
              isDisabled: index <= 0,
              onClick: () => moveFavorite(item, -1)
            },
            {
              type: "button",
              key: "move-favorite-down",
              title: strings.tasksMoveFavoriteDown(),
              isDisabled: index < 0 || index >= favoritesRef.current.length - 1,
              onClick: () => moveFavorite(item, 1)
            },
            {
              type: "button",
              key: "remove-favorite",
              title: strings.tasksRemoveFavorite(),
              onClick: () =>
                void saveFavorites(
                  favoritesRef.current.filter((value) => value !== item)
                )
            }
          ]
        : availableFavorites.map((favorite) => ({
            type: "button" as const,
            key: favorite,
            title: favoriteTitle(favorite),
            onClick: () =>
              void saveFavorites([...favoritesRef.current, favorite])
          }))
    );
  }

  function openListMenu(list: TaskListRecord) {
    Menu.openMenu([
      {
        type: "button",
        key: "edit-list",
        title: strings.tasksEditList(),
        onClick: () => void editList(list)
      },
      ...(list.id === defaultListId
        ? []
        : [
            {
              type: "button" as const,
              key: "delete-list",
              title: strings.tasksDeleteList(),
              onClick: () => void deleteList(list)
            }
          ])
    ]);
  }

  return (
    <div
      className={
        IS_DESKTOP_APP && isMac() ? "veyran-mac-tasks" : "veyran-web-tasks"
      }
      data-test-id="tasks-view"
    >
      <aside className="veyran-task-sources" aria-label={strings.tasksTitle()}>
        <div className="veyran-task-sources-scroll">
          <div className="veyran-task-section-heading">
            <span>{strings.tasksFavorites()}</span>
            <button
              type="button"
              className="veyran-task-icon-button"
              aria-label={strings.tasksAddFavorite()}
              title={strings.tasksAddFavorite()}
              disabled={availableFavorites.length === 0}
              onClick={() => openFavoriteMenu()}
            >
              <Plus size={16} />
            </button>
          </div>
          {favorites.length === 0 ? (
            <p className="veyran-task-source-empty">
              {strings.tasksNoFavorites()}
            </p>
          ) : null}
          <div className="veyran-task-source-group">
            {favorites.map((item, index) => {
              const custom = item.startsWith("list:");
              const smart = custom
                ? undefined
                : smartLists.find((value) => value.id === item.slice(6));
              const list = custom
                ? lists.find((value) => value.id === item.slice(5))
                : undefined;
              const SmartIcon = smart?.icon;
              const target = custom
                ? (item as TaskSelection)
                : (item.slice(6) as SmartTaskList);
              const count = custom
                ? listCounts.get(list?.id || "") || 0
                : smartCounts.get(smart!.id) || 0;
              return (
                <div
                  key={item}
                  className="veyran-task-source-wrap"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = draggedFavorite.current;
                    if (from && from !== item)
                      moveFavorite(from, index - favorites.indexOf(from));
                    draggedFavorite.current = null;
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openFavoriteMenu(item);
                  }}
                >
                  <button
                    type="button"
                    className="veyran-task-source"
                    title={favoriteTitle(item)}
                    aria-current={selection === target ? "page" : undefined}
                    onClick={() => {
                      setSelection(target);
                      setSelectedTaskId(null);
                    }}
                  >
                    <span
                      className="veyran-task-source-symbol"
                      aria-hidden="true"
                    >
                      {list ? (
                        <TaskListGlyph
                          symbol={list.symbol}
                          color={list.color}
                          size={17}
                        />
                      ) : SmartIcon ? (
                        <SmartIcon size={16} />
                      ) : null}
                    </span>
                    <span className="veyran-task-source-name">
                      {favoriteTitle(item)}
                    </span>
                    <span className="veyran-task-source-count">{count}</span>
                  </button>
                  <button
                    type="button"
                    className="veyran-task-drag-handle"
                    draggable
                    aria-label={`${strings.tasksDragFavorites()}: ${favoriteTitle(
                      item
                    )}`}
                    title={strings.tasksDragFavorites()}
                    onDragStart={(event) => {
                      draggedFavorite.current = item;
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      draggedFavorite.current = null;
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "ArrowUp" ||
                        event.key === "ArrowDown"
                      ) {
                        event.preventDefault();
                        moveFavorite(item, event.key === "ArrowUp" ? -1 : 1);
                      }
                    }}
                  >
                    <span aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="veyran-task-source-more veyran-task-icon-button"
                    aria-label={`${favoriteTitle(
                      item
                    )}: ${strings.tasksEditFavorites()}`}
                    title={strings.tasksEditFavorites()}
                    onClick={() => openFavoriteMenu(item)}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="veyran-task-section-heading veyran-task-list-heading">
            <span>{strings.tasksLists()}</span>
            <button
              type="button"
              className="veyran-task-icon-button"
              aria-label={strings.tasksNewList()}
              title={strings.tasksNewList()}
              onClick={() => void createList()}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="veyran-task-source-group">
            {lists.map((list) => (
              <div
                key={list.id}
                className="veyran-task-source-wrap"
                onContextMenu={(event) => {
                  event.preventDefault();
                  openListMenu(list);
                }}
              >
                <button
                  type="button"
                  className="veyran-task-source"
                  title={list.name}
                  aria-current={
                    selection === `list:${list.id}` ? "page" : undefined
                  }
                  onClick={() => {
                    setSelection(`list:${list.id}`);
                    setQuickListId(list.id);
                    setSelectedTaskId(null);
                  }}
                >
                  <span
                    className="veyran-task-source-symbol"
                    aria-hidden="true"
                  >
                    <TaskListGlyph
                      symbol={list.symbol}
                      color={list.color}
                      size={17}
                    />
                  </span>
                  <span className="veyran-task-source-name">{list.name}</span>
                  <span className="veyran-task-source-count">
                    {listCounts.get(list.id) || 0}
                  </span>
                </button>
                <button
                  type="button"
                  className="veyran-task-source-more veyran-task-icon-button"
                  aria-label={`${list.name}: ${strings.tasksEditList()}`}
                  title={strings.tasksEditList()}
                  onClick={() => openListMenu(list)}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </aside>
      <main className="veyran-task-main">
        <header className="veyran-task-header">
          <div className="veyran-task-heading">
            <span className="veyran-task-eyebrow">{strings.tasksTitle()}</span>
            <h1>{selectedTitle}</h1>
          </div>
          <button
            type="button"
            className="veyran-task-primary-button"
            onClick={() => void openTask()}
            aria-label={strings.tasksAddTask()}
            title={strings.tasksAddTask()}
          >
            <Plus size={17} /> <span>{strings.tasksAddTask()}</span>
          </button>
        </header>
        <div className="veyran-task-search-wrap">
          <Search size={15} color="icon" />
          <input
            id="veyran-task-search"
            data-test-id="task-search"
            type="search"
            aria-label={strings.search()}
            placeholder={strings.search()}
            value={taskQuery}
            onChange={(event) => setTaskQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setTaskQuery("");
            }}
          />
          {taskQuery ? (
            <button
              type="button"
              className="veyran-task-icon-button"
              aria-label={strings.clear()}
              onClick={() => setTaskQuery("")}
            >
              <Cross size={14} />
            </button>
          ) : null}
        </div>
        <div className="veyran-task-list-scroll">
          {loading ? (
            <p className="veyran-task-message">{strings.tasksLoading()}</p>
          ) : error ? (
            <p className="veyran-task-message">{error}</p>
          ) : filteredTasks.length === 0 ? (
            <div className="veyran-task-empty">
              <span className="veyran-task-empty-symbol" aria-hidden="true">
                {taskQuery ? (
                  <Search size={21} />
                ) : (
                  <CheckCircleOutline size={22} />
                )}
              </span>
              <span className="veyran-task-empty-eyebrow">{selectedTitle}</span>
              <h2>
                {taskQuery ? strings.noResultsFound() : strings.tasksNoTasks()}
              </h2>
              {!taskQuery ? (
                <button
                  type="button"
                  className="veyran-task-empty-action"
                  onClick={() => void openTask()}
                >
                  <Plus size={15} /> {strings.tasksAddTask()}
                </button>
              ) : null}
            </div>
          ) : selection === "scheduled" ? (
            scheduledGroups(displayedTasks).map(([date, group]) => (
              <section key={date} className="veyran-task-date-section">
                <h2>{sectionDateLabel(date)}</h2>
                {group.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    selected={selectedTaskId === task.id}
                    onOpen={() => setSelectedTaskId(task.id)}
                    onEdit={() => void openTask(task)}
                    onToggle={() => void toggleTask(task)}
                    onFlag={() => void toggleFlag(task)}
                    onDelete={() => void deleteTask(task)}
                  />
                ))}
              </section>
            ))
          ) : (
            displayedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                selected={selectedTaskId === task.id}
                onOpen={() => setSelectedTaskId(task.id)}
                onEdit={() => void openTask(task)}
                onToggle={() => void toggleTask(task)}
                onFlag={() => void toggleFlag(task)}
                onDelete={() => void deleteTask(task)}
              />
            ))
          )}
          {filteredTasks.length > visibleLimit ? (
            <button
              type="button"
              className="veyran-task-inline-button"
              onClick={() => setVisibleLimit((limit) => limit + 100)}
            >
              {strings.tasksShowMore()}
            </button>
          ) : null}
        </div>
        <div className="veyran-task-quick-add">
          <div className="veyran-task-quick-row">
            <Plus size={17} color="icon" />
            <input
              ref={quickInputRef}
              aria-label={strings.tasksQuickAdd()}
              placeholder={strings.tasksQuickAdd()}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void quickAdd();
                }
                if (event.key === "Escape") setTitle("");
              }}
            />
            <button
              type="button"
              className="veyran-task-quick-submit"
              disabled={!title.trim()}
              onClick={() => void quickAdd()}
              aria-label={strings.tasksAddTask()}
              title={strings.tasksAddTask()}
            >
              {strings.tasksAddTask()}
            </button>
            <button
              type="button"
              className="veyran-task-icon-button"
              onClick={() => setShowQuickOptions((value) => !value)}
              aria-expanded={showQuickOptions}
              aria-label={strings.tasksQuickAdd()}
              title={strings.tasksQuickAdd()}
            >
              <MoreHorizontal size={17} />
            </button>
          </div>
          {showQuickOptions ? (
            <div className="veyran-task-quick-options">
              <select
                aria-label={strings.tasksList()}
                value={quickListId}
                onChange={(event) => setQuickListId(event.target.value)}
              >
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
              <input
                type="date"
                aria-label={`${strings.tasksReminder()} ${strings.tasksDate()}`}
                value={quickReminderDate}
                onChange={(event) => {
                  setQuickReminderDate(event.target.value);
                  if (!event.target.value) setQuickReminderTime("");
                }}
              />
              <input
                type="time"
                aria-label={`${strings.tasksReminder()} ${strings.tasksTime()}`}
                disabled={!quickReminderDate}
                value={quickReminderTime}
                onChange={(event) => setQuickReminderTime(event.target.value)}
              />
              <select
                aria-label={strings.tasksPriority()}
                value={quickPriority}
                onChange={(event) =>
                  setQuickPriority(event.target.value as typeof quickPriority)
                }
              >
                <option value="none">{strings.tasksPriorityNone()}</option>
                <option value="low">{strings.tasksPriorityLow()}</option>
                <option value="medium">{strings.tasksPriorityMedium()}</option>
                <option value="high">{strings.tasksPriorityHigh()}</option>
              </select>
              <label className="veyran-task-checkbox">
                <input
                  type="checkbox"
                  checked={quickFlagged}
                  onChange={(event) => setQuickFlagged(event.target.checked)}
                />
                {strings.tasksFlag()}
              </label>
            </div>
          ) : null}
        </div>
      </main>
      {selectedTask ? (
        <aside
          className="veyran-task-inspector"
          aria-label={strings.tasksEditTask()}
        >
          <div className="veyran-task-inspector-header">
            <button
              type="button"
              className="veyran-task-icon-button veyran-task-inspector-back"
              aria-label={strings.back()}
              onClick={() => setSelectedTaskId(null)}
            >
              <ArrowLeft size={17} />
            </button>
            <span>{strings.tasksTitle()}</span>
            <button
              type="button"
              className="veyran-task-icon-button"
              aria-label={strings.tasksEditTask()}
              title={strings.tasksEditTask()}
              onClick={() => void openTask(selectedTask)}
            >
              <MoreHorizontal size={17} />
            </button>
          </div>
          <div className="veyran-task-inspector-scroll">
            <div className="veyran-task-inspector-title-row">
              <button
                type="button"
                className={`veyran-task-complete ${
                  selectedTask.completed ? "is-completed" : ""
                }`}
                aria-label={
                  selectedTask.completed
                    ? strings.tasksUncomplete()
                    : strings.tasksComplete()
                }
                aria-pressed={selectedTask.completed}
                onClick={() => void toggleTask(selectedTask)}
              >
                {selectedTask.completed ? <Check size={15} /> : null}
              </button>
              <h2>{selectedTask.title}</h2>
            </div>
            {selectedTask.description ? (
              <p className="veyran-task-inspector-description">
                {selectedTask.description}
              </p>
            ) : null}
            <dl className="veyran-task-detail-list">
              <div>
                <dt>{strings.tasksList()}</dt>
                <dd className="veyran-task-detail-list-value">
                  {selectedList ? (
                    <TaskListGlyph
                      symbol={selectedList.symbol}
                      color={selectedList.color}
                      size={16}
                    />
                  ) : null}
                  {selectedList?.name || strings.tasksLists()}
                </dd>
              </div>
              <div>
                <dt>{strings.tasksReminder()}</dt>
                <dd>
                  {reminderLabel(selectedTask) || strings.tasksNoReminder()}
                </dd>
              </div>
              <div>
                <dt>{strings.tasksRepeat()}</dt>
                <dd>{repeatLabel(selectedTask)}</dd>
              </div>
              <div>
                <dt>{strings.tasksPriority()}</dt>
                <dd>{priorityLabel(selectedTask.priority)}</dd>
              </div>
              <div>
                <dt>{strings.tasksFlag()}</dt>
                <dd>
                  {selectedTask.flagged
                    ? strings.tasksFlag()
                    : strings.tasksNone()}
                </dd>
              </div>
              {selectedTask.completedAt ? (
                <div>
                  <dt>{strings.tasksCompleted()}</dt>
                  <dd>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short"
                    }).format(selectedTask.completedAt)}
                  </dd>
                </div>
              ) : null}
            </dl>
            <button
              type="button"
              className="veyran-task-standard-button"
              onClick={() => void openTask(selectedTask)}
            >
              {strings.tasksEditTask()}
            </button>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function TaskRow(props: {
  task: TaskRecord;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onFlag: () => void;
  onDelete: () => void;
}) {
  const { task } = props;
  const overdue = taskIsOverdue(task);
  return (
    <div
      className={`veyran-task-row ${props.selected ? "is-selected" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        Menu.openMenu([
          {
            type: "button",
            key: "edit-task",
            title: strings.tasksEditTask(),
            onClick: props.onEdit
          },
          {
            type: "button",
            key: "toggle-task",
            title: task.completed
              ? strings.tasksUncomplete()
              : strings.tasksComplete(),
            onClick: props.onToggle
          },
          {
            type: "button",
            key: "flag-task",
            title: task.flagged ? strings.tasksUnflag() : strings.tasksFlag(),
            onClick: props.onFlag
          },
          {
            type: "button",
            key: "delete-task",
            title: strings.tasksDelete(),
            onClick: props.onDelete
          }
        ]);
      }}
      data-test-id="task-row"
    >
      <button
        type="button"
        aria-label={
          task.completed ? strings.tasksUncomplete() : strings.tasksComplete()
        }
        aria-pressed={task.completed}
        onClick={props.onToggle}
        className={`veyran-task-complete ${
          task.completed ? "is-completed" : ""
        }`}
      >
        {task.completed ? <Check size={15} /> : null}
      </button>
      <button
        type="button"
        className="veyran-task-row-open"
        aria-label={`${task.title}${
          overdue ? `, ${strings.tasksOverdue()}` : ""
        }`}
        aria-current={props.selected ? "true" : undefined}
        onClick={props.onOpen}
      >
        <span
          className={`veyran-task-row-title ${
            task.completed ? "is-completed" : ""
          }`}
        >
          {task.title}
        </span>
        <span className={`veyran-task-row-meta ${overdue ? "is-overdue" : ""}`}>
          {overdue ? <span>{strings.tasksOverdue()}</span> : null}
          {reminderLabel(task) ? <span>{reminderLabel(task)}</span> : null}
          {task.priority !== "none" ? (
            <span>{priorityLabel(task.priority)}</span>
          ) : null}
          {task.flagged ? <span>{strings.tasksFlag()}</span> : null}
          {task.recurrenceRule ? <span>{strings.tasksRepeat()}</span> : null}
          {task.completedAt ? (
            <span>
              {strings.tasksCompleted()} ·{" "}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short"
              }).format(task.completedAt)}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}

function priorityLabel(priority: TaskRecord["priority"]): string {
  switch (priority) {
    case "low":
      return strings.tasksPriorityLow();
    case "medium":
      return strings.tasksPriorityMedium();
    case "high":
      return strings.tasksPriorityHigh();
    default:
      return strings.tasksPriorityNone();
  }
}
