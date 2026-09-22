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

import { getUpcomingReminderTime, Reminder } from "@notesnook/core";

const MAX_SNAPSHOT_REMINDERS = 10;
const RECENTLY_PASSED_WINDOW = 3 * 60 * 60 * 1000;

export type ReminderWidgetItem = {
  id: string;
  title: string;
  timestamp?: number;
  displayKind?: "ongoing";
};

export type ReminderWidgetSnapshot = {
  schemaVersion: 1;
  updatedAt: number;
  count: number;
  appearance: "system" | "light" | "dark";
  accentLight: string;
  accentDark: string;
  reminders: ReminderWidgetItem[];
};

export function getReminderWidgetTimestamp(
  reminder: Pick<
    Reminder,
    "date" | "mode" | "recurringMode" | "selectedDays" | "snoozeUntil"
  >,
  now = Date.now()
) {
  if (reminder.snoozeUntil && reminder.snoozeUntil > now) {
    return reminder.snoozeUntil;
  }
  if (reminder.mode === "permanent") return undefined;
  if (reminder.mode === "repeat") {
    return getUpcomingReminderTime(reminder as Reminder);
  }
  return reminder.date;
}

export function buildReminderWidgetSnapshot(
  reminders: Reminder[],
  options: {
    now?: number;
    appearance: "system" | "light" | "dark";
    accentLight: string;
    accentDark: string;
  }
): ReminderWidgetSnapshot {
  const now = options.now ?? Date.now();
  const active = reminders
    .map((reminder) => ({
      reminder,
      timestamp: getReminderWidgetTimestamp(reminder, now)
    }))
    .filter(({ reminder, timestamp }) => {
      const recentlyPassed =
        reminder.mode === "once" &&
        !reminder.disabled &&
        typeof timestamp === "number" &&
        timestamp <= now &&
        timestamp > now - RECENTLY_PASSED_WINDOW;
      const active =
        !reminder.disabled &&
        (reminder.mode !== "once" ||
          reminder.date > now ||
          (!!reminder.snoozeUntil && reminder.snoozeUntil > now));
      return active || recentlyPassed;
    })
    .sort((a, b) => {
      if (a.timestamp === undefined) return 1;
      if (b.timestamp === undefined) return -1;
      const aOverdue = a.timestamp < now;
      const bOverdue = b.timestamp < now;
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      return a.timestamp - b.timestamp;
    });

  return {
    schemaVersion: 1,
    updatedAt: now,
    count: active.length,
    appearance: options.appearance,
    accentLight: normalizeHexColor(options.accentLight),
    accentDark: normalizeHexColor(options.accentDark),
    reminders: active.slice(0, MAX_SNAPSHOT_REMINDERS).map(
      ({ reminder, timestamp }): ReminderWidgetItem => ({
        id: reminder.id,
        title: reminder.title.trim(),
        ...(timestamp === undefined
          ? { displayKind: "ongoing" }
          : { timestamp })
      })
    )
  };
}

function normalizeHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#008837";
}
