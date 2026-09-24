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

import { Box, Button, Flex, Text } from "@theme-ui/components";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { strings } from "@notesnook/intl";
import { DatabaseUpdatedEvent, EVENTS } from "@notesnook/core";
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
import { ItemDialog } from "../dialogs/item-dialog";
import { ConfirmDialog } from "../dialogs/confirm";
import { NavigationEvents } from "../navigation";
import { showToast } from "../utils/toast";
import { logger } from "../utils/logger";
import { Menu } from "../hooks/use-menu";

type TaskSelection = SmartTaskList | `list:${string}`;

const smartLists: { id: SmartTaskList; title: () => string; icon: string }[] = [
  { id: "today", title: strings.tasksToday, icon: "◉" },
  { id: "scheduled", title: strings.tasksScheduled, icon: "▦" },
  { id: "all", title: strings.tasksAll, icon: "☷" },
  { id: "flagged", title: strings.tasksFlagged, icon: "⚑" },
  { id: "completed", title: strings.tasksCompleted, icon: "✓" }
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
  const now = Date.now();
  return tasks.filter((task) => {
    if (kind === "completed") return task.completed;
    if (task.completed) return false;
    switch (kind) {
      case "today":
        return Boolean(
          (task.dueDate && task.dueDate <= today) ||
            (task.reminderAt && todayKeyForTimestamp(task.reminderAt) === today)
        );
      case "scheduled":
        if (task.dueDate && task.dueDate < today) return false;
        return Boolean(
          (task.dueDate && task.dueDate >= today) ||
            (task.reminderAt && task.reminderAt >= now)
        );
      case "flagged":
        return task.flagged;
      default:
        return true;
    }
  }).length;
}

function todayKeyForTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function dueLabel(task: TaskRecord): string | undefined {
  if (!task.dueDate) return undefined;
  const [year, month, day] = task.dueDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(year !== new Date().getFullYear() ? { year: "numeric" } : {})
  }).format(date);
  if (!task.dueTime) return formatted;
  const [hour, minute] = task.dueTime.split(":").map(Number);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(year, month - 1, day, hour, minute));
  return `${formatted} · ${time}`;
}

function scheduledGroups(tasks: TaskRecord[]) {
  const byDate = new Map<string, TaskRecord[]>();
  const today = todayKey();
  for (const task of tasks) {
    const date =
      (task.dueDate && task.dueDate >= today ? task.dueDate : undefined) ||
      (task.reminderAt ? todayKeyForTimestamp(task.reminderAt) : "");
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
  const [defaultListId, setDefaultListId] = useState("");
  const [title, setTitle] = useState("");
  const [quickDueDate, setQuickDueDate] = useState("");
  const [quickDueTime, setQuickDueTime] = useState("");
  const [quickReminder, setQuickReminder] = useState("");
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
      const [allTasks, allLists] = await Promise.all([
        taskDomain.tasks.list(),
        taskDomain.taskLists.list()
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
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
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
  const displayedTasks = useMemo(
    () => visibleTasks.slice(0, visibleLimit),
    [visibleTasks, visibleLimit]
  );

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
      const reminderAt = quickReminder
        ? new Date(quickReminder).getTime()
        : undefined;
      if (quickReminder && !Number.isFinite(reminderAt)) {
        showToast("error", strings.tasksInvalidReminder());
        return;
      }
      const defaultList =
        quickListId || (await taskDomain.taskLists.default()).id;
      await taskDomain.tasks.create({
        title: title.trim(),
        listId: defaultList,
        dueDate: quickDueDate || undefined,
        dueTime: quickDueDate && quickDueTime ? quickDueTime : undefined,
        reminderAt,
        priority: quickPriority,
        flagged: quickFlagged
      });
      setTitle("");
      setQuickDueDate("");
      setQuickDueTime("");
      setQuickReminder("");
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
    const name = await ItemDialog.show({ title: strings.tasksNewList() });
    if (!name || typeof name !== "string") return;
    try {
      const created = await taskDomain.taskLists.create({ name: name.trim() });
      setSelection(`list:${created.id}`);
      await refresh();
    } catch (cause) {
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
    }
  }

  async function editList(list: TaskListRecord) {
    const name = await ItemDialog.show({
      title: strings.tasksEditList(),
      defaultValue: list.name
    });
    if (!name || typeof name !== "string") return;
    try {
      await taskDomain.taskLists.update(list.id, { name: name.trim() });
      await refresh();
    } catch (cause) {
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
    }
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

  return (
    <Flex
      sx={{ flexDirection: "column", height: "100%", minHeight: 0 }}
      data-test-id="tasks-view"
    >
      <Box sx={{ overflowY: "auto", flex: 1, px: 3, py: 2 }}>
        <Flex sx={{ flexWrap: "wrap", gap: 2, mb: 3 }}>
          {smartLists.map((smart) => (
            <button
              key={smart.id}
              type="button"
              aria-pressed={selection === smart.id}
              onClick={() => setSelection(smart.id)}
              style={{
                flex: "1 1 145px",
                minHeight: 64,
                textAlign: "left",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "10px 12px",
                background:
                  selection === smart.id
                    ? "var(--background-selected)"
                    : "var(--background-secondary)",
                color: "var(--paragraph)",
                cursor: "pointer",
                font: "inherit"
              }}
            >
              <Flex
                sx={{ justifyContent: "space-between", alignItems: "center" }}
              >
                <Text aria-hidden="true" sx={{ color: "accent", fontSize: 20 }}>
                  {smart.icon}
                </Text>
                <Text sx={{ fontWeight: "bold" }}>
                  {countForSmartList(smart.id, tasks)}
                </Text>
              </Flex>
              <Text sx={{ fontWeight: "bold" }}>{smart.title()}</Text>
            </button>
          ))}
        </Flex>
        <Flex
          sx={{ justifyContent: "space-between", alignItems: "center", mb: 2 }}
        >
          <Text sx={{ fontWeight: "bold" }}>{strings.tasksLists()}</Text>
          <Button
            variant="transparent"
            onClick={createList}
            aria-label={strings.tasksNewList()}
            title={strings.tasksNewList()}
          >
            +
          </Button>
        </Flex>
        <Flex sx={{ flexDirection: "column", gap: 1, mb: 4 }}>
          {lists.map((list) => (
            <Flex key={list.id} sx={{ alignItems: "center", gap: 1 }}>
              <button
                type="button"
                aria-pressed={selection === `list:${list.id}`}
                onClick={() => {
                  setSelection(`list:${list.id}`);
                  setQuickListId(list.id);
                }}
                style={{
                  flex: 1,
                  textAlign: "left",
                  border: 0,
                  borderRadius: 6,
                  padding: "9px 10px",
                  background:
                    selection === `list:${list.id}`
                      ? "var(--background-selected)"
                      : "transparent",
                  color: "var(--paragraph)",
                  cursor: "pointer",
                  font: "inherit"
                }}
              >
                {list.name} ·{" "}
                {
                  tasks.filter(
                    (task) => !task.completed && task.listId === list.id
                  ).length
                }
              </button>
              <Button
                variant="transparent"
                aria-label={strings.tasksEditList()}
                title={strings.tasksEditList()}
                onClick={() => editList(list)}
              >
                ⋯
              </Button>
              {list.id !== defaultListId ? (
                <Button
                  variant="transparent"
                  aria-label={strings.tasksDeleteList()}
                  title={strings.tasksDeleteList()}
                  onClick={() => deleteList(list)}
                >
                  ×
                </Button>
              ) : null}
            </Flex>
          ))}
        </Flex>
        <Flex
          sx={{ justifyContent: "space-between", alignItems: "center", mb: 2 }}
        >
          <Text sx={{ fontSize: "subheading", fontWeight: "bold" }}>
            {selectedTitle}
          </Text>
          <Button
            variant="transparent"
            onClick={() => openTask()}
            aria-label={strings.tasksAddTask()}
            title={strings.tasksAddTask()}
          >
            +
          </Button>
        </Flex>
        {loading ? (
          <Text>{strings.tasksLoading()}</Text>
        ) : error ? (
          <Text sx={{ color: "error" }}>{error}</Text>
        ) : visibleTasks.length === 0 ? (
          <Text sx={{ color: "paragraph-muted", py: 3 }}>
            {strings.tasksNoTasks()}
          </Text>
        ) : selection === "scheduled" ? (
          <Flex sx={{ flexDirection: "column", gap: 3, pb: 4 }}>
            {scheduledGroups(displayedTasks).map(([date, group]) => (
              <Box key={date}>
                <Text
                  as="div"
                  sx={{ color: "accent", fontWeight: "bold", mb: 2 }}
                >
                  {sectionDateLabel(date)}
                </Text>
                <Flex sx={{ flexDirection: "column", gap: 1 }}>
                  {group.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onOpen={() => openTask(task)}
                      onToggle={() => toggleTask(task)}
                      onFlag={() => toggleFlag(task)}
                      onDelete={() => deleteTask(task)}
                    />
                  ))}
                </Flex>
              </Box>
            ))}
          </Flex>
        ) : (
          <Flex sx={{ flexDirection: "column", gap: 1, pb: 4 }}>
            {displayedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onOpen={() => openTask(task)}
                onToggle={() => toggleTask(task)}
                onFlag={() => toggleFlag(task)}
                onDelete={() => deleteTask(task)}
              />
            ))}
          </Flex>
        )}
        {visibleTasks.length > visibleLimit ? (
          <Button
            variant="secondary"
            sx={{ mb: 4 }}
            onClick={() => setVisibleLimit((limit) => limit + 100)}
          >
            {strings.tasksShowMore()}
          </Button>
        ) : null}
      </Box>
      <Box
        sx={{
          borderTop: "1px solid var(--separator)",
          px: 3,
          py: 2,
          bg: "background"
        }}
      >
        <Flex sx={{ gap: 1 }}>
          <input
            ref={quickInputRef}
            aria-label={strings.tasksQuickAdd()}
            placeholder={strings.tasksAddTask()}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void quickAdd();
              }
              if (event.key === "Escape") setTitle("");
            }}
            style={{
              flex: 1,
              minWidth: 0,
              background: "var(--background-secondary)",
              color: "var(--paragraph)",
              border: "1px solid var(--border)",
              borderRadius: 7,
              padding: "8px 10px",
              font: "inherit"
            }}
          />
          <Button
            variant="primary"
            disabled={!title.trim()}
            onClick={quickAdd}
            aria-label={strings.tasksAddTask()}
          >
            +
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShowQuickOptions((value) => !value)}
            aria-expanded={showQuickOptions}
            aria-label={strings.tasksQuickAdd()}
          >
            ⋯
          </Button>
        </Flex>
        {showQuickOptions ? (
          <Flex sx={{ flexWrap: "wrap", gap: 1, mt: 2, alignItems: "center" }}>
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
              aria-label={strings.tasksDueDate()}
              value={quickDueDate}
              onChange={(event) => setQuickDueDate(event.target.value)}
            />
            <input
              type="time"
              aria-label={strings.tasksDueTime()}
              disabled={!quickDueDate}
              value={quickDueTime}
              onChange={(event) => setQuickDueTime(event.target.value)}
            />
            <input
              type="datetime-local"
              aria-label={strings.tasksReminder()}
              value={quickReminder}
              onChange={(event) => setQuickReminder(event.target.value)}
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
            <label>
              <input
                type="checkbox"
                checked={quickFlagged}
                onChange={(event) => setQuickFlagged(event.target.checked)}
              />{" "}
              {strings.tasksFlag()}
            </label>
          </Flex>
        ) : null}
      </Box>
    </Flex>
  );
}

function TaskRow(props: {
  task: TaskRecord;
  onOpen: () => void;
  onToggle: () => void;
  onFlag: () => void;
  onDelete: () => void;
}) {
  const { task } = props;
  const overdue = taskIsOverdue(task);
  return (
    <Flex
      sx={{
        alignItems: "start",
        gap: 2,
        p: 2,
        borderRadius: 8,
        bg: "background-secondary",
        cursor: "pointer",
        ":hover": { bg: "hover" }
      }}
      onClick={props.onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        Menu.openMenu([
          {
            type: "button",
            key: "edit-task",
            title: strings.tasksEditTask(),
            onClick: props.onOpen
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
            title: strings.tasksFlag(),
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
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${task.title}${
        overdue ? `, ${strings.tasksOverdue()}` : ""
      }`}
    >
      <button
        type="button"
        aria-label={
          task.completed ? strings.tasksUncomplete() : strings.tasksComplete()
        }
        aria-pressed={task.completed}
        onClick={(event) => {
          event.stopPropagation();
          props.onToggle();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: 14,
          border: "2px solid var(--accent)",
          background: task.completed ? "var(--accent)" : "transparent",
          color: "var(--background)",
          cursor: "pointer"
        }}
      >
        {task.completed ? "✓" : ""}
      </button>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Text
          as="div"
          sx={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            textDecoration: task.completed ? "line-through" : "none",
            color: task.completed ? "paragraph-muted" : "paragraph"
          }}
        >
          {task.title}
        </Text>
        <Flex
          sx={{
            flexWrap: "wrap",
            gap: 2,
            mt: 1,
            color: overdue ? "error" : "paragraph-muted",
            fontSize: "subBody"
          }}
        >
          {overdue ? <Text>{strings.tasksOverdue()}</Text> : null}
          {dueLabel(task) ? <Text>{dueLabel(task)}</Text> : null}
          {task.reminderAt ? (
            <Text aria-label={strings.tasksReminder()}>
              {strings.tasksReminderAt()} ·{" "}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short"
              }).format(task.reminderAt)}
            </Text>
          ) : null}
          {task.priority !== "none" ? (
            <Text>{priorityLabel(task.priority)}</Text>
          ) : null}
          {task.flagged ? <Text>{strings.tasksFlag()}</Text> : null}
          {task.recurrenceRule ? <Text>{strings.tasksRepeat()}</Text> : null}
          {task.completedAt ? (
            <Text>
              {strings.tasksCompleted()} ·{" "}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short"
              }).format(task.completedAt)}
            </Text>
          ) : null}
        </Flex>
      </Box>
    </Flex>
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
