import {
  taskReminderSchedule,
  taskReminderTimestamp,
  type Task
} from "@notesnook/core";
import { RRule } from "rrule";

const MAX_FUTURE_OCCURRENCES = 5;

export type DesiredTaskAlarm = {
  alarmKey: string;
  taskId: string;
  timestamp: number;
  title: string;
  updatedAt: number;
  privacyHidden: boolean;
};

export type TaskReminderOccurrence = {
  date: string;
  time: string;
  timestamp: number;
  key: string;
};

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
        alarmKey: task.recurrenceRule
          ? `series:${task.seriesId || task.id}:${item.key}`
          : `task:${task.id}`,
        taskId: task.id,
        timestamp: item.timestamp,
        title: task.title,
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
