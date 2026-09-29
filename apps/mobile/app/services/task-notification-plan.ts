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
import { taskAlarmKey, taskReminderOccurrences } from "./task-alarm-plan";

export type ExistingTaskTrigger = {
  id: string;
  updatedAt?: string;
  timestamp?: number;
  privacyHidden?: boolean;
  urgentFallback?: boolean;
};

/**
 * How the current pass treats the notification fallback for an Urgent
 * occurrence. `needsFallback` is asked per **occurrence** (by its stable
 * `taskAlarmKey`), never per Task: one recurring Task can have some occurrences
 * delivered by a successfully scheduled alarm and others that failed, and only
 * the failed ones may get a notification -- a Task-wide answer would duplicate
 * audio for the occurrences whose alarm did schedule.
 */
export type UrgentAlarmFallback = {
  needsFallback: (alarmKey: string) => boolean;
  /**
   * Asked per occurrence when `needsFallback` is false: the native alarm state
   * for this occurrence could not be determined, so its existing fallback (if
   * any) is kept untouched and no new one is created. This is the fail-closed
   * answer for a single occurrence, so one unknown occurrence never forces the
   * rest of the plan into the same all-or-nothing treatment.
   */
  isUnknown?: (alarmKey: string) => boolean;
  /**
   * Set only when the native alarm state could not be determined at all. Every
   * Urgent occurrence without fallback news then keeps whatever trigger it
   * already has (rather than being cancelled into silence) and never gains a
   * second, duplicate audible alert. Callers that know the alarm state leave
   * this off.
   */
  preserveExisting?: boolean;
};

/**
 * Fail-safe default for a caller that does not know the real alarm outcome:
 * every Urgent occurrence is treated as needing the notification fallback, so
 * an unknown caller never ends up with neither an alarm nor a notification.
 */
export const ALWAYS_FALLBACK: UrgentAlarmFallback = {
  needsFallback: () => true
};

export function taskNotificationId(id: string, occurrenceKey?: string) {
  return occurrenceKey ? `task:${id}:${occurrenceKey}` : `task:${id}`;
}

/** iOS's pending-local-notification limit is shared with non-Task alerts. */
export function availableTaskNotificationSlots(
  existingIds: string[],
  totalBudget: number
) {
  const otherNotifications = existingIds.filter(
    (id) => !id.startsWith("task:")
  ).length;
  return Math.max(0, totalBudget - otherNotifications);
}

export function planTaskNotifications(
  tasks: Task[],
  existing: ExistingTaskTrigger[],
  now: number,
  limit: number,
  privacyHidden = false,
  urgentFallback: UrgentAlarmFallback = ALWAYS_FALLBACK
) {
  const existingIds = new Set(existing.map((item) => item.id));
  const eligible = tasks
    .filter((task) => !task.completed)
    .flatMap((task) =>
      taskReminderOccurrences(task, now)
        .filter((occurrence) => occurrence.timestamp > now)
        .map((occurrence) => {
          const alarmKey = taskAlarmKey(task, occurrence.key);
          // An Urgent occurrence whose alarm state is unknown must never gain a
          // second, possibly-duplicate audible alert. It is not granted a new
          // fallback, but an existing trigger is preserved rather than
          // cancelled into silence.
          const unknownAlarm = task.urgent
            ? Boolean(urgentFallback.preserveExisting) ||
              Boolean(urgentFallback.isUnknown?.(alarmKey))
            : false;
          return {
            ...task,
            notificationId: taskNotificationId(
              task.seriesId || task.id,
              task.recurrenceRule ? occurrence.key : undefined
            ),
            timestamp: occurrence.timestamp,
            // The notification's own occurrence identity travels with it, so a
            // tap on a future occurrence can never be answered with whatever
            // occurrence the Task record happens to hold by then. The id is the
            // authoritative record id core uses for that occurrence, so the tap
            // resolves the record for the occurrence it was produced for.
            occurrenceKey: task.recurrenceRule ? occurrence.key : undefined,
            seriesId: task.recurrenceRule ? task.seriesId || task.id : undefined,
            // A notification is only ever a fallback for the occurrence whose
            // own alarm is not scheduled, so the decision is taken per
            // occurrence (stable `taskAlarmKey`), never per Task. Non-urgent
            // Tasks are their own normal notification path and are never
            // fallbacks.
            urgentFallback: Boolean(task.urgent),
            unknownAlarm,
            needsFallback:
              !task.urgent || (!unknownAlarm && urgentFallback.needsFallback(alarmKey))
          };
        })
    )
    .filter(
      (entry) =>
        entry.needsFallback || (entry.unknownAlarm && existingIds.has(entry.notificationId))
    );
  const wanted = eligible
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp ||
        a.notificationId.localeCompare(b.notificationId)
    )
    .slice(0, limit);
  const existingById = new Map(existing.map((item) => [item.id, item]));
  const wantedIds = new Set(wanted.map((task) => task.notificationId));
  const cancelIds = existing
    .filter((item) => item.id.startsWith("task:") && !wantedIds.has(item.id))
    .map((item) => item.id);
  const schedule = wanted.filter((task) => {
    // Occurrences kept only to protect an existing trigger from cancellation are
    // never rewritten: this pass cannot confirm the native alarm state.
    if (!task.needsFallback) return false;
    const old = existingById.get(task.notificationId);
    if (
      old?.updatedAt === String(task.updatedAt) &&
      old.timestamp === task.timestamp &&
      Boolean(old.privacyHidden) === privacyHidden &&
      Boolean(old.urgentFallback) === task.urgentFallback
    )
      return false;
    if (old) cancelIds.push(old.id);
    return true;
  });
  return {
    cancelIds,
    schedule,
    eligibleCount: eligible.filter((entry) => entry.needsFallback).length
  };
}
