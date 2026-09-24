/*
This file is part of the Notesnook project (https://notesnook.com/)
Copyright (C) 2026 Streetwriters (Private) Limited
This program is free software under the GNU General Public License v3 or later.
*/

import type { Task } from "@notesnook/core";
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
  urgentFallback = false
) {
  const eligible = tasks
    .filter((task) => !task.completed && (!task.urgent || urgentFallback))
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
          urgentFallback: Boolean(task.urgent && urgentFallback)
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
