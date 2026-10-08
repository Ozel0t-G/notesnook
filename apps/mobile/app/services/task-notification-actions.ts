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
import { DatabaseLogger, db } from "../common/database";
import { useUserStore } from "../stores/use-user-store";
import SettingsService from "./settings";
import { taskReminderOccurrences } from "./task-alarm-plan";
import { decideTaskIntentAccount, taskNotificationIntent } from "./task-navigation";

/** Notification category carrying the Task actions (iOS). */
export const TASK_NOTIFICATION_CATEGORY = "TASK";
export const TASK_ACTION_COMPLETE = "TASK_COMPLETE";
export const TASK_ACTION_SNOOZE = "TASK_SNOOZE_HOUR";

const SNOOZE_MINUTES = 60;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** The reminder fields that move an occurrence to `minutes` from `now`. */
export function snoozedSchedule(now: Date, minutes = SNOOZE_MINUTES) {
  const target = new Date(now.getTime() + minutes * 60_000);
  return {
    reminderDate: `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(
      target.getDate()
    )}`,
    reminderTime: `${pad(target.getHours())}:${pad(target.getMinutes())}`
  };
}

/**
 * The Task record fields an occurrence-identity decision is made from. A
 * notification produced by an older build names an occurrence only through the
 * record it was planned from, so the record's own schedule fields are what the
 * domain derivation needs.
 */
export type TaskActionTarget = Pick<Task, "id" | "completed" | "updatedAt"> &
  Partial<
    Pick<
      Task,
      | "occurrenceKey"
      | "recurrenceRule"
      | "seriesId"
      | "seriesStartDate"
      | "seriesStartTime"
      | "dueDate"
      | "dueTime"
      | "reminderAt"
      | "reminderDate"
      | "reminderTime"
      | "scheduleVersion"
    >
  >;

/**
 * Whether an action from a delivered notification may still change `task`:
 * the record is the occurrence and revision the notification was produced for.
 * A Task edited, moved or already completed since then is left alone.
 *
 * Occurrence identity is compared strictly, so an action for one occurrence of
 * a recurring series is never applied to another:
 *
 * - A record that stores its own `occurrenceKey` answers only for exactly that
 *   key.
 * - A record with **no** stored key is the series' *first* occurrence: core only
 *   assigns `occurrenceKey` to the occurrences it materializes afterwards
 *   (`packages/core/src/collections/tasks.ts#ensureNextOccurrence`). That record
 *   can still be confirmed as the occurrence a legacy notification named, but
 *   only through the same derivation the notification planner uses
 *   (`taskReminderOccurrences` -- the domain's own occurrence key). When the
 *   claimed key is exactly this record's own occurrence, the action applies.
 * - Any other claim names an occurrence this record does not own -- typically a
 *   *future* occurrence whose record does not exist yet. There is no record to
 *   apply it to, so the action is refused instead of silently completing or
 *   snoozing a different occurrence of the series.
 */
export function taskActionApplies(
  task: TaskActionTarget,
  payload: { updatedAt?: unknown; occurrenceKey?: unknown }
) {
  if (task.completed) return false;
  const claimed =
    typeof payload.occurrenceKey === "string" && payload.occurrenceKey
      ? payload.occurrenceKey
      : undefined;
  if (claimed && task.occurrenceKey !== claimed) {
    // A stored key that disagrees is a sibling occurrence; a record without one
    // is only ever the series' first occurrence, and only the domain's own
    // derivation can confirm that the claimed key is that occurrence.
    if (task.occurrenceKey || !task.recurrenceRule) return false;
    const own = taskReminderOccurrences(task as Task)[0]?.key;
    if (!own || own !== claimed) return false;
  }
  const updatedAt = Number(payload.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt === task.updatedAt;
}

/**
 * Runs "Mark as Completed" / "Remind Me in 1 Hour" from a Task notification.
 * Returns whether the Task was changed. Never throws.
 */
export async function runTaskNotificationAction(
  actionId: string | undefined,
  data: Record<string, unknown> | undefined,
  now = new Date()
): Promise<boolean> {
  if (actionId !== TASK_ACTION_COMPLETE && actionId !== TASK_ACTION_SNOOZE)
    return false;
  // Actions are only attached while App Lock is off; a notification delivered
  // before App Lock was enabled must not bypass it.
  if (SettingsService.get().appLockEnabled) return false;
  const intent = taskNotificationIntent(data, "notification");
  if (!intent) return false;
  const account = decideTaskIntentAccount(
    intent.accountId,
    useUserStore.getState().user?.id || null
  );
  if (account === "mismatch") return false;
  try {
    const task = (await db.tasks.get(intent.taskId)) as
      | (Task & { occurrenceKey?: string })
      | undefined;
    if (!task || !taskActionApplies(task, data || {})) return false;
    if (actionId === TASK_ACTION_COMPLETE) {
      return !!(await db.tasks.completeIfUnchanged(task.id, task.updatedAt));
    }
    await db.tasks.update(task.id, snoozedSchedule(now));
    return true;
  } catch (error) {
    DatabaseLogger.error(error as Error, "Task notification action");
    return false;
  }
}
