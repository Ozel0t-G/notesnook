/*
This file is part of the Notesnook project (https://notesnook.com/)
Copyright (C) 2026 Streetwriters (Private) Limited
This program is free software under the GNU General Public License v3 or later.
*/

import type { Task } from "@notesnook/core";

export type ExistingTaskTrigger = {
  id: string;
  updatedAt?: string;
  timestamp?: number;
  privacyHidden?: boolean;
};

export function taskNotificationId(id: string) {
  return `task:${id}`;
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
  privacyHidden = false
) {
  const wanted = tasks
    .filter((task) => !task.completed && !!task.reminderAt && task.reminderAt > now)
    .sort(
      (a, b) =>
        (a.reminderAt as number) - (b.reminderAt as number) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, limit);
  const existingById = new Map(existing.map((item) => [item.id, item]));
  const wantedIds = new Set(wanted.map((task) => taskNotificationId(task.id)));
  const cancelIds = existing
    .filter((item) => item.id.startsWith("task:") && !wantedIds.has(item.id))
    .map((item) => item.id);
  const schedule = wanted.filter((task) => {
    const old = existingById.get(taskNotificationId(task.id));
    if (
      old?.updatedAt === String(task.updatedAt) &&
      old.timestamp === task.reminderAt &&
      Boolean(old.privacyHidden) === privacyHidden
    )
      return false;
    if (old) cancelIds.push(old.id);
    return true;
  });
  return { cancelIds, schedule };
}
