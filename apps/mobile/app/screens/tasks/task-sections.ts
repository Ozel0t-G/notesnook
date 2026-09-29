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

import { isTaskOverdue, Task, taskReminderSchedule } from "@notesnook/core";

export type TaskSectionKind =
  | "overdue"
  | "today"
  | "later"
  | "noDate"
  | "day"
  | "completed";

export type TaskListRow =
  | { kind: "header"; id: string; section: TaskSectionKind; date?: string }
  | { kind: "task"; id: string; task: Task };

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function localCalendarDate(now: Date) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}`;
}

function byDue(a: Task, b: Task) {
  const left = taskReminderSchedule(a);
  const right = taskReminderSchedule(b);
  return (
    (left.date || "").localeCompare(right.date || "") ||
    (left.time || "99:99").localeCompare(right.time || "99:99") ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Groups a Task list the way Reminders does: Overdue first, then Today, Later
 * and tasks without a date; the Scheduled list is grouped per day instead.
 * Completed Tasks (when shown) come last. Headers are only added when they
 * separate something: a single undated group gets none.
 */
export function taskListRows(
  tasks: Task[],
  options: { perDay?: boolean; now?: Date } = {}
): TaskListRow[] {
  const now = options.now || new Date();
  const today = localCalendarDate(now);
  const open = tasks.filter((task) => !task.completed);
  const completed = tasks.filter((task) => task.completed);
  const overdue = open.filter((task) => isTaskOverdue(task, now)).sort(byDue);
  const rest = open.filter((task) => !isTaskOverdue(task, now));

  const groups: { section: TaskSectionKind; date?: string; tasks: Task[] }[] =
    [];
  if (overdue.length) groups.push({ section: "overdue", tasks: overdue });

  if (options.perDay) {
    const days = new Map<string, Task[]>();
    const undated: Task[] = [];
    for (const task of [...rest].sort(byDue)) {
      const date = taskReminderSchedule(task).date;
      if (!date) undated.push(task);
      else days.set(date, [...(days.get(date) || []), task]);
    }
    for (const [date, items] of days)
      groups.push({
        section: date === today ? "today" : "day",
        date,
        tasks: items
      });
    if (undated.length) groups.push({ section: "noDate", tasks: undated });
  } else {
    const dated = rest.filter((task) => taskReminderSchedule(task).date);
    const undated = rest.filter((task) => !taskReminderSchedule(task).date);
    const todays = dated
      .filter((task) => taskReminderSchedule(task).date! <= today)
      .sort(byDue);
    const later = dated
      .filter((task) => taskReminderSchedule(task).date! > today)
      .sort(byDue);
    if (todays.length) groups.push({ section: "today", tasks: todays });
    if (later.length) groups.push({ section: "later", tasks: later });
    // Undated Tasks keep their manual/creation order.
    if (undated.length) groups.push({ section: "noDate", tasks: undated });
  }
  if (completed.length) groups.push({ section: "completed", tasks: completed });

  const showHeaders =
    groups.length > 1 || (groups.length === 1 && groups[0].section !== "noDate");
  return groups.flatMap((group) => [
    ...(showHeaders
      ? [
          {
            kind: "header" as const,
            id: `header:${group.section}:${group.date || ""}`,
            section: group.section,
            date: group.date
          }
        ]
      : []),
    ...group.tasks.map((task) => ({
      kind: "task" as const,
      id: task.id,
      task
    }))
  ]);
}
