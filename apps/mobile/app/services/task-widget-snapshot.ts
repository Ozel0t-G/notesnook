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

import { taskReminderSchedule, type Task } from "@notesnook/core";

export type TaskWidgetItem = {
  id: string;
  updatedAt?: number;
  title: string;
  dueDate?: string;
  dueTime?: string;
  flagged: boolean;
  priority: Task["priority"];
};

export type TaskWidgetSnapshot = {
  // v3 additions must remain optional to old readers; breaking changes need v4.
  schemaVersion: 3;
  privacyHidden?: boolean;
  accountScope?: string;
  updatedAt: number;
  generatedForDate: string;
  generatedForTimeZone: string;
  // Retained for v3 wire compatibility; local wall-date filtering spans DST.
  utcOffsetMinutes: number;
  count: number;
  appearance: "system" | "light" | "dark";
  accentLight: string;
  accentDark: string;
  upcomingCounts: Record<string, number>;
  tasks: TaskWidgetItem[];
  // Additive v3 counts. The extension renders the "All" and "Flagged" smart
  // lists from these even when the capped cache cannot hold every Task.
  totalOpen?: number;
  flaggedOpen?: number;
  generatedDayCount?: number;
};

// Keep a small cache of future schedules so WidgetKit can roll into the next
// local day while the app is closed. The extension filters this cache at render.
const MAX_CACHED_TASKS = 64;
// Undated Tasks are the common case for people who never set a reminder, so
// they are cached after the dated window instead of being dropped.
const MAX_CACHED_UNDATED_TASKS = 32;
// Flagged Tasks are the "Flagged" smart list; cache a few beyond the windows
// above so that list is never empty while its exact count stays exact.
const MAX_CACHED_FLAGGED_TASKS = 16;
// Preserve exact badge counts for a year of day rollovers without allowing an
// unbounded date histogram to exceed the native 256 KiB snapshot limit.
const MAX_UPCOMING_COUNT_DATES = 366;

function localDate(now: number) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
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
    accountScope?: string;
  }
): TaskWidgetSnapshot {
  const now = options.now ?? Date.now();
  const today = localDate(now);
  const open = tasks.filter((task) => !task.completed);
  const scheduled = open
    .filter((task) => !!taskReminderSchedule(task).date)
    .sort((a, b) => {
      const aSchedule = taskReminderSchedule(a);
      const bSchedule = taskReminderSchedule(b);
      const aDue = aSchedule.date || "9999-12-31";
      const bDue = bSchedule.date || "9999-12-31";
      return (
        aDue.localeCompare(bDue) ||
        (aSchedule.time || "").localeCompare(bSchedule.time || "") ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id)
      );
    });
  // Undated Tasks keep the order the database handed them over in; the app
  // shows them in that same manual order below the dated sections.
  const undated = open.filter((task) => !taskReminderSchedule(task).date);
  const visibleCount = scheduled.filter(
    (task) => taskReminderSchedule(task).date! <= today
  ).length;
  const generatedDayCount = scheduled.filter(
    (task) => taskReminderSchedule(task).date === today
  ).length;
  const upcomingCounts: Record<string, number> = {};
  let countedDates = 0;
  for (const task of scheduled) {
    const date = taskReminderSchedule(task).date!;
    if (date <= today) continue;
    if (upcomingCounts[date] === undefined) {
      if (countedDates >= MAX_UPCOMING_COUNT_DATES) break;
      countedDates++;
      upcomingCounts[date] = 0;
    }
    upcomingCounts[date]++;
  }

  // Dated rows first (sorted by due), then undated rows in input order, then
  // any flagged row the two windows above could not fit. The extension sorts
  // whatever it receives into the smart-list order at render time.
  const cached = scheduled.slice(0, MAX_CACHED_TASKS);
  const cachedIds = new Set(cached.map((task) => task.id));
  const cachedUndated = undated.slice(0, MAX_CACHED_UNDATED_TASKS);
  for (const task of cachedUndated) cachedIds.add(task.id);
  const extraFlagged = open
    .filter((task) => task.flagged && !cachedIds.has(task.id))
    .slice(0, MAX_CACHED_FLAGGED_TASKS);

  return {
    schemaVersion: 3,
    accountScope: options.accountScope,
    updatedAt: now,
    generatedForDate: today,
    generatedForTimeZone: currentTimeZone(),
    utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
    count: visibleCount,
    appearance: options.appearance,
    accentLight: normalizeHexColor(options.accentLight),
    accentDark: normalizeHexColor(options.accentDark),
    upcomingCounts,
    totalOpen: open.length,
    flaggedOpen: open.filter((task) => task.flagged).length,
    generatedDayCount,
    tasks: [...cached, ...cachedUndated, ...extraFlagged].map((task) => {
      const schedule = taskReminderSchedule(task);
      const item: TaskWidgetItem = {
        id: task.id,
        updatedAt: task.updatedAt,
        title: task.title
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
          .trim()
          .slice(0, 120),
        flagged: task.flagged,
        priority: task.priority
      };
      // v3 wire keys are retained for the existing WidgetKit decoder. An
      // undated Task omits them entirely.
      if (schedule.date) item.dueDate = schedule.date;
      if (schedule.time) item.dueTime = schedule.time;
      return item;
    })
  };
}

export function buildPrivateTaskWidgetSnapshot(
  options: Parameters<typeof buildTaskWidgetSnapshot>[1]
): TaskWidgetSnapshot {
  return {
    ...buildTaskWidgetSnapshot([], options),
    accountScope: undefined,
    privacyHidden: true
  };
}

function normalizeHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#008837";
}
