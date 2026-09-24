/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2026 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.
*/

import { DatabaseUpdatedEvent, EVENTS, Task } from "@notesnook/core";
import dayjs from "dayjs";
import { db } from "../common/db";
import { desktop } from "../common/desktop-bridge";
import { hashNavigate } from "../navigation";
import Config from "../utils/config";
import { logger } from "../utils/logger";
import { TaskScheduler } from "../utils/task-scheduler";

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let updateQueue = Promise.resolve();

function cron(timestamp: number) {
  return dayjs(timestamp).format("ss mm HH DD MM * YYYY");
}

async function notify(task: Task) {
  if (!Config.get("reminderNotifications", true)) return;
  const current = await db.tasks.get(task.id);
  if (!current || current.completed || current.reminderAt !== task.reminderAt)
    return;

  if ("Notification" in window && Notification.permission === "granted") {
    const notification = new Notification(task.title, {
      tag: `task:${task.id}`
    });
    notification.onclick = () => {
      window.focus();
      hashNavigate(`/tasks/${task.id}/edit`);
    };
  }
}

async function refreshNow() {
  if (!db.isInitialized) return;
  await db.tasks.reconcile();
  await TaskScheduler.stopAllWithPrefix("task:");
  const now = Date.now();
  const tasks = (await db.tasks.list())
    .filter((task) => !task.completed && task.reminderAt !== undefined)
    .sort(
      (a, b) =>
        (a.reminderAt as number) - (b.reminderAt as number) ||
        a.id.localeCompare(b.id)
    );

  if (IS_DESKTOP_APP) {
    await desktop?.integration.replaceTaskReminders.mutate(
      Config.get("reminderNotifications", true)
        ? tasks.map((task) => ({
            id: task.id,
            title: task.title.slice(0, 2048),
            reminderAt: task.reminderAt as number
          }))
        : []
    );
    return;
  }

  for (const task of tasks
    .filter((task) => (task.reminderAt as number) > now)
    .slice(0, 500)) {
    await TaskScheduler.register(
      `task:${task.id}`,
      cron(task.reminderAt as number),
      () => {
        void notify(task);
        void refresh();
      }
    );
  }
}

function refresh() {
  updateQueue = updateQueue.then(refreshNow).catch((error) => {
    logger.error(error);
  });
  return updateQueue;
}

function queueRefresh() {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), 250);
}

function start() {
  if (started) return;
  started = true;
  db.eventManager.subscribe(
    EVENTS.databaseUpdated,
    (event: DatabaseUpdatedEvent) => {
      if (event.collection === "settings") queueRefresh();
    }
  );
  db.eventManager.subscribe(EVENTS.syncCompleted, queueRefresh);
  db.eventManager.subscribe(EVENTS.userLoggedOut, () => {
    if (IS_DESKTOP_APP)
      void desktop?.integration.replaceTaskReminders.mutate([]);
    else void TaskScheduler.stopAllWithPrefix("task:");
  });
  queueRefresh();
}

export const TaskNotificationStore = { start, refresh };
