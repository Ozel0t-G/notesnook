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
import { strings } from "@notesnook/intl";
import {
  taskReminderSchedule,
  taskReminderTimestamp,
  type Task
} from "@notesnook/core";
import { RRule } from "rrule";

const MAX_FUTURE_OCCURRENCES = 5;

/**
 * Bumped whenever the *native* alarm configuration changes shape (tint,
 * snooze interval, intents, state machine). It is folded into the native
 * fingerprint so an unchanged occurrence is left alone and a changed one is
 * recreated -- but only for a strictly future occurrence: the native reconcile
 * never tears down an alarm that is alerting, snoozing, paused or due now, so a
 * version bump upgrades future alarms without cancelling a live one.
 *
 * Every alarm carries this value and the native side folds it into the alarm
 * fingerprint (`TaskAlarmModule.parse`), so the two stay in lockstep: bumping
 * this constant is what makes unchanged occurrences re-create.
 */
export const TASK_ALARM_CONFIGURATION_VERSION = "4";

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

/** The App Lock alarm title: says what is due and when, never the Task. */
export function redactedAlarmTitle(timestamp: number) {
  const time = new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
  return strings.tasksUrgentDueRedacted(time);
}

export type DesiredTaskAlarm = {
  alarmKey: string;
  taskId: string;
  timestamp: number;
  title: string;
  updatedAt: number;
  privacyHidden: boolean;
  /**
   * The native alarm configuration generation. Folded into the native
   * fingerprint so a configuration change upgrades future alarms only, never a
   * live one. The alarm is always tinted the fixed VeyraN blue natively; a List
   * color is deliberately not part of the alarm identity.
   */
  configurationVersion: string;
  /** Neutral but useful alarm title under App Lock ("Urgent Task due (13:20)"). */
  redactedTitle?: string;
  /** The recurring series this occurrence belongs to, when it has one. */
  seriesId?: string;
  /** The occurrence's own stable key (`YYYY-MM-DDTHH:MM` or `...Tdate`). */
  occurrenceKey?: string;
};

export type OverdueTaskSurface = {
  taskId: string;
  /** The overdue occurrence's instant, in milliseconds. */
  timestamp: number;
  title: string;
  /** The Task revision the surface was planned from, for a strict LA completion. */
  updatedAt: number;
  /**
   * The occurrence's own stable key and the series it belongs to, so the
   * native side can validate an LA completion against the exact occurrence the
   * card describes (never a sibling occurrence of the same series).
   */
  occurrenceKey?: string;
  seriesId?: string;
  /** The per-occurrence alarm key, so a surface never competes with its alarm. */
  alarmKey: string;
};

/**
 * The explicit Urgent-reminder occurrence state machine shared by the planner,
 * the native alarm report and the Live Activity surface. Every occurrence is in
 * exactly one of these states; the native observable set (`scheduled`,
 * `alerting`, `countdown`, `paused`, or absent) maps onto it unambiguously.
 *
 * - `SCHEDULED` -- a native alarm is held and not presenting yet.
 * - `ALERTING` -- the alarm is sounding right now.
 * - `SNOOZED` -- the person chose Snooze (countdown) or Pause; it re-alerts.
 * - `STOPPED_BUT_INCOMPLETE` -- the occurrence passed and is not held and the
 *   Task is not completed: it must never be re-armed on a past instant and it
 *   owns no second audible delivery.
 * - `COMPLETED` -- the Task is complete.
 * - `RESCHEDULED` -- the occurrence moved to a different instant; the old one
 *   is finished and the new one is scheduled afresh.
 * - `REMOVED_OR_DISABLED` -- Urgent is off, the reminder was removed, or the
 *   alarm is gone for a future occurrence.
 */
export type TaskAlarmState =
  | "SCHEDULED"
  | "ALERTING"
  | "SNOOZED"
  | "STOPPED_BUT_INCOMPLETE"
  | "COMPLETED"
  | "RESCHEDULED"
  | "REMOVED_OR_DISABLED";

/** The native `Alarm.State` names the app understands. */
export type NativeAlarmPresentation = "alerting" | "countdown" | "paused";

/**
 * Resolves the single state of one occurrence from the *task record* and the
 * native truth about that occurrence's alarm. Pure and total, so the state can
 * be asserted per occurrence without a device.
 */
export function taskAlarmState(input: {
  completed?: boolean;
  urgent?: boolean;
  hasReminder: boolean;
  occurrenceTimestamp: number;
  held: boolean;
  /**
   * The alarm is presenting right now. Only meaningful when `held` is true; a
   * `presentation` of `countdown`/`paused` refines it to `SNOOZED`, `alerting`
   * is `ALERTING`, and `null`/`undefined` (held but not presenting) is
   * `SCHEDULED`.
   */
  presentation?: NativeAlarmPresentation | null;
  /** The occurrence's previous instant, when the caller tracked one. */
  previousTimestamp?: number;
  now?: number;
}): TaskAlarmState {
  if (input.completed) return "COMPLETED";
  if (!input.urgent || !input.hasReminder) return "REMOVED_OR_DISABLED";
  if (
    input.previousTimestamp !== undefined &&
    input.previousTimestamp !== input.occurrenceTimestamp
  )
    return "RESCHEDULED";
  if (input.held) {
    // A held alarm with no presentation is *scheduled*, not alerting: the native
    // report distinguishes "the system holds it" (`scheduledAlarmKeys`) from
    // "it is presenting right now" (`activeAlarmKeys`), so a held occurrence
    // that is not presenting must never be reported as if it were already
    // sounding.
    if (input.presentation === "countdown" || input.presentation === "paused")
      return "SNOOZED";
    if (input.presentation === "alerting") return "ALERTING";
    return "SCHEDULED";
  }
  const now = input.now ?? Date.now();
  if (input.occurrenceTimestamp <= now) return "STOPPED_BUT_INCOMPLETE";
  return "REMOVED_OR_DISABLED";
}

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
  // The occurrence key must be exactly the one core stores for the occurrence
  // (`packages/core/src/collections/tasks.ts#ensureNextOccurrence`): the wall
  // time when the series is timed, else the literal `date`. `nextOccurrence`
  // decides "timed" from the series start (falling back to the record's own due
  // time), and the date-only 09:00 default is only ever the *timestamp* -- never
  // part of the key. Getting this wrong makes a tap on a materialized occurrence
  // miss its record and fall through to the series fallback.
  const seriesIsTimed =
    task.seriesStartDate !== undefined
      ? task.seriesStartTime !== undefined
      : task.dueTime !== undefined;
  const occurrence = (
    date: string,
    wallTime: string,
    at: number
  ): TaskReminderOccurrence => ({
    date,
    time: wallTime,
    timestamp: at,
    key: `${date}T${seriesIsTimed ? wallTime : "date"}`
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
        privacyHidden,
        configurationVersion: TASK_ALARM_CONFIGURATION_VERSION,
        ...(task.recurrenceRule ? { seriesId: task.seriesId || task.id } : {}),
        occurrenceKey: item.key,
        ...(privacyHidden
          ? { redactedTitle: redactedAlarmTitle(item.timestamp) }
          : {})
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
  limit = MAX_OVERDUE_SURFACES,
  /**
   * Occurrences whose AlarmKit alarm is presenting right now (alerting,
   * counting down after a Snooze, or paused). Those already own a Lock Screen
   * surface for this occurrence, so the ongoing overdue surface would be a
   * second, redundant one -- and the person's live alarm must never be traded
   * for it. Unknown alarm state passes `false` here and leaves the surface
   * exactly as it was.
   */
  isAlarmPresenting?: (alarmKey: string) => boolean
): OverdueTaskSurface[] {
  return tasks
    .flatMap((task): OverdueTaskSurface[] => {
      if (task.completed || !task.urgent) return [];
      const schedule = taskReminderSchedule(task);
      // A date-only reminder has no instant to be overdue relative to.
      if (!schedule.date || !schedule.time) return [];
      const current = taskReminderOccurrences(task, now)[0];
      if (!current) return [];
      const alarmKey = taskAlarmKey(task, current.key);
      if (isAlarmPresenting?.(alarmKey)) return [];
      const age = now - current.timestamp;
      if (age < 0 || age > OVERDUE_SURFACE_LIFETIME_MS) return [];
      return [
        {
          taskId: task.id,
          timestamp: current.timestamp,
          title: taskAlertTitle(task.title),
          updatedAt: task.updatedAt,
          alarmKey,
          occurrenceKey: current.key,
          ...(task.recurrenceRule ? { seriesId: task.seriesId || task.id } : {})
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
