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
import { taskReminderOccurrences } from "./task-alarm-plan";

export type ExistingTaskTrigger = {
  id: string;
  updatedAt?: string;
  timestamp?: number;
  privacyHidden?: boolean;
  urgentFallback?: boolean;
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
  canScheduleUrgent = true
) {
  const eligible = tasks
    .filter((task) => !task.completed && (!task.urgent || canScheduleUrgent))
    .flatMap((task) =>
      taskReminderOccurrences(task, now)
        .filter((occurrence) => occurrence.timestamp > now)
        .map((occurrence) => ({
          ...task,
          notificationId: taskNotificationId(
            task.seriesId || task.id,
            task.recurrenceRule ? occurrence.key : undefined
          ),
          timestamp: occurrence.timestamp,
          urgentFallback: false
        }))
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
  return { cancelIds, schedule, eligibleCount: eligible.length };
}
