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

import type { Task } from "@notesnook/core";

export type TaskWidgetItem = {
  id: string;
  title: string;
  dueDate?: string;
  dueTime?: string;
  flagged: boolean;
  priority: Task["priority"];
};

export type TaskWidgetSnapshot = {
  schemaVersion: 3;
  privacyHidden?: boolean;
  updatedAt: number;
  generatedForDate: string;
  generatedForTimeZone: string;
  utcOffsetMinutes: number;
  count: number;
  appearance: "system" | "light" | "dark";
  accentLight: string;
  accentDark: string;
  tasks: TaskWidgetItem[];
};

const MAX_VISIBLE_TASKS = 10;

function localDate(now: number) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function currentTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function buildTaskWidgetSnapshot(
  tasks: Task[],
  options: {
    now?: number;
    appearance: "system" | "light" | "dark";
    accentLight: string;
    accentDark: string;
  }
): TaskWidgetSnapshot {
  const now = options.now ?? Date.now();
  const today = localDate(now);
  const visible = tasks
    .filter(
      (task) =>
        !task.completed &&
        ((task.dueDate && task.dueDate <= today) ||
          (task.reminderAt && localDate(task.reminderAt) === today))
    )
    .sort((a, b) => {
      const aDue = a.dueDate || "9999-12-31";
      const bDue = b.dueDate || "9999-12-31";
      return (
        aDue.localeCompare(bDue) ||
        (a.dueTime || "").localeCompare(b.dueTime || "") ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id)
      );
    });

  return {
    schemaVersion: 3,
    updatedAt: now,
    generatedForDate: today,
    generatedForTimeZone: currentTimeZone(),
    utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
    count: visible.length,
    appearance: options.appearance,
    accentLight: normalizeHexColor(options.accentLight),
    accentDark: normalizeHexColor(options.accentDark),
    tasks: visible.slice(0, MAX_VISIBLE_TASKS).map((task) => ({
      id: task.id,
      title: task.title.trim(),
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      flagged: task.flagged,
      priority: task.priority
    }))
  };
}

export function buildPrivateTaskWidgetSnapshot(
  options: Parameters<typeof buildTaskWidgetSnapshot>[1]
): TaskWidgetSnapshot {
  return {
    ...buildTaskWidgetSnapshot([], options),
    privacyHidden: true
  };
}

function normalizeHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#008837";
}
