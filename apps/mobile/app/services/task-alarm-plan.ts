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
  taskReminderSchedule,
  taskReminderTimestamp,
  type Task
} from "@notesnook/core";
import { RRule } from "rrule";

const MAX_FUTURE_OCCURRENCES = 5;

/**
 * How many ongoing overdue surfaces can exist at once. Apple's
 * `ActivityAuthorizationError.globalMaximumExceeded`/`targetMaximumExceeded`
 * bound how many Live Activities may be live, so the newest overdue Tasks win.
 */
export const MAX_OVERDUE_SURFACES = 5;

/**
 * Apple ends a Live Activity after roughly eight hours. An occurrence older
 * than that is never re-surfaced, so opening the app on a device that has been
 * closed for days does not resurrect a long-past overdue banner.
 */
export const OVERDUE_SURFACE_LIFETIME_MS = 8 * 60 * 60 * 1000;

export function taskAlertTitle(title: string) {
  return title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .trim()
    .slice(0, 120);
}

export type DesiredTaskAlarm = {
  alarmKey: string;
  taskId: string;
  timestamp: number;
  title: string;
  updatedAt: number;
  privacyHidden: boolean;
};

export type OverdueTaskSurface = {
  taskId: string;
  /** The overdue occurrence's instant, in milliseconds. */
  timestamp: number;
  title: string;
};

export type TaskReminderOccurrence = {
  date: string;
  time: string;
  timestamp: number;
  key: string;
};

/**
 * The stable per-occurrence identity shared by the audible alarm and its
 * notification fallback: one recurring Task contributes several occurrences, so
 * a Task id alone cannot say which occurrence a scheduler accepted or dropped.
 *
 * A recurring occurrence is keyed by `series:<series/task id>:<occurrenceKey>`
 * (the same local wall-time key both paths derive from the reminder), and a
 * one-off occurrence by `task:<id>`. The signed-in account is folded into the
 * native alarm identity (`TaskAlarmModule.alarmId`), so a key is only ever
 * meaningful together with the account that reconciled it.
 */
export function taskAlarmKey(
  task: Pick<Task, "id" | "seriesId" | "recurrenceRule">,
  occurrenceKey?: string
) {
  return task.recurrenceRule
    ? `series:${task.seriesId || task.id}:${occurrenceKey ?? ""}`
    : `task:${task.id}`;
}

/** Current occurrence plus the next five RRULE occurrences, in local wall time. */
export function taskReminderOccurrences(
  task: Task,
  now = Date.now()
): TaskReminderOccurrence[] {
  const schedule = taskReminderSchedule(task);
  if (!schedule.date) return [];
  const time = schedule.time || "09:00";
  const timestamp = taskReminderTimestamp(task);
  if (timestamp === undefined) return [];
  const occurrence = (
    date: string,
    wallTime: string,
    at: number
  ): TaskReminderOccurrence => ({
    date,
    time: wallTime,
    timestamp: at,
    key: `${date}T${wallTime}`
  });
  const result = [occurrence(schedule.date, time, timestamp)];
  if (!task.recurrenceRule) return result;

  try {
    const start = floatingDate(
      task.seriesStartDate || schedule.date,
      task.seriesStartTime || time
    );
    const rule = new RRule({
      ...RRule.parseString(task.recurrenceRule.replace(/^RRULE:/i, "").trim()),
      dtstart: start
    });
    const wallNow = new Date(now);
    const wallCutoff = Date.UTC(
      wallNow.getFullYear(),
      wallNow.getMonth(),
      wallNow.getDate(),
      wallNow.getHours(),
      wallNow.getMinutes()
    );
    let cursor = new Date(
      Math.max(floatingDate(schedule.date, time).getTime(), wallCutoff)
    );
    for (let index = 0; index < MAX_FUTURE_OCCURRENCES; index++) {
      const next = rule.after(cursor, false);
      if (!next) break;
      const date = next.toISOString().slice(0, 10);
      const wallTime = next.toISOString().slice(11, 16);
      const at = localTimestamp(date, wallTime);
      if (at > now) result.push(occurrence(date, wallTime, at));
      cursor = next;
    }
  } catch {
    // Core validates RRULEs; corrupted synced data keeps its current reminder.
  }
  return result;
}

/** Keep past occurrences here so an alarm that is already sounding survives reconciliation. */
export function desiredTaskAlarms(
  tasks: Task[],
  privacyHidden: boolean,
  now = Date.now()
): DesiredTaskAlarm[] {
  const desired = tasks.flatMap((task) => {
    if (task.completed || !task.urgent) return [];
    const schedule = taskReminderSchedule(task);
    if (!schedule.date || !schedule.time) return [];
    return taskReminderOccurrences(task, now).map(
      (item): DesiredTaskAlarm => ({
        alarmKey: taskAlarmKey(task, item.key),
        taskId: task.id,
        timestamp: item.timestamp,
        title: taskAlertTitle(task.title),
        updatedAt: task.updatedAt,
        privacyHidden
      })
    );
  });
  return [
    ...new Map(desired.map((alarm) => [alarm.alarmKey, alarm])).values()
  ].sort(
    (a, b) => a.timestamp - b.timestamp || a.alarmKey.localeCompare(b.alarmKey)
  );
}

/**
 * The overdue-but-still-incomplete Urgent Tasks that should own an ongoing Live
 * Activity surface right now (the `OVERDUE_INCOMPLETE` device presentation of
 * an incomplete Urgent Task whose reminder has already fired).
 *
 * Restricted to Urgent Tasks: these surfaces belong to the Urgent alarm
 * feature. A normal (non-Urgent) reminder never owns one, so switching Urgent
 * off -- or removing the reminder, completing, deleting or rescheduling the
 * Task -- clears the surface instead of leaving an unsolicited Live Activity
 * behind, and normal reminders can never consume the shared five-surface budget
 * ahead of Urgent ones. Normal reminder delivery is unchanged and unaffected.
 *
 * Titles are passed through sanitized but unredacted; the native side applies
 * the same App Lock redaction the alarm path uses, so the placeholder is chosen
 * in one place.
 */
export function overdueTaskSurfaces(
  tasks: Task[],
  now = Date.now(),
  limit = MAX_OVERDUE_SURFACES
): OverdueTaskSurface[] {
  return tasks
    .flatMap((task): OverdueTaskSurface[] => {
      if (task.completed || !task.urgent) return [];
      const schedule = taskReminderSchedule(task);
      // A date-only reminder has no instant to be overdue relative to.
      if (!schedule.date || !schedule.time) return [];
      const current = taskReminderOccurrences(task, now)[0];
      if (!current) return [];
      const age = now - current.timestamp;
      if (age < 0 || age > OVERDUE_SURFACE_LIFETIME_MS) return [];
      return [
        {
          taskId: task.id,
          timestamp: current.timestamp,
          title: taskAlertTitle(task.title)
        }
      ];
    })
    .sort(
      (a, b) => b.timestamp - a.timestamp || a.taskId.localeCompare(b.taskId)
    )
    .slice(0, Math.max(0, limit));
}

function floatingDate(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

function localTimestamp(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute).getTime();
}
