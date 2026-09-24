/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2026 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

import { Notification } from "electron";
import { AssetManager } from "./asset-manager";

export type ScheduledTaskReminder = {
  id: string;
  title: string;
  reminderAt: number;
};

const MAX_TIMEOUT = 2_147_483_647;

/** Schedules decrypted Task titles only in the Electron process's memory. */
export class InMemoryTaskReminderScheduler {
  private reminders = new Map<string, ScheduledTaskReminder>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private notifications = new Set<Notification>();
  private onActivate: ((id: string) => void) | undefined;
  private onSnapshot: (() => void) | undefined;

  setActivationHandler(handler: (id: string) => void) {
    this.onActivate = handler;
  }

  setSnapshotHandler(handler: () => void) {
    this.onSnapshot = handler;
  }

  replace(reminders: ScheduledTaskReminder[]) {
    const now = Date.now();
    const next = new Map<string, ScheduledTaskReminder>();
    for (const reminder of reminders) {
      const old = this.reminders.get(reminder.id);
      if (
        reminder.reminderAt > now ||
        (old && old.reminderAt === reminder.reminderAt)
      )
        next.set(reminder.id, reminder);
    }
    this.reminders = next;
    this.arm();
    this.onSnapshot?.();
    return this.reminders.size;
  }

  clear() {
    this.reminders.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let nextTime = Infinity;
    for (const reminder of this.reminders.values())
      nextTime = Math.min(nextTime, reminder.reminderAt);
    if (!Number.isFinite(nextTime)) return;
    const delay = Math.min(Math.max(nextTime - Date.now(), 0), MAX_TIMEOUT);
    this.timer = setTimeout(() => this.fireDue(), delay);
  }

  private fireDue() {
    this.timer = undefined;
    const now = Date.now();
    for (const reminder of this.reminders.values()) {
      if (reminder.reminderAt > now) continue;
      this.reminders.delete(reminder.id);
      this.show(reminder);
    }
    this.arm();
  }

  private show(reminder: ScheduledTaskReminder) {
    if (!Notification.isSupported()) return;
    try {
      const notification = new Notification({
        title: reminder.title,
        icon: AssetManager.appIcon({
          size: 64,
          format: process.platform === "win32" ? "ico" : "png"
        })
      });
      this.notifications.add(notification);
      notification.once("click", () => {
        this.onActivate?.(reminder.id);
        this.notifications.delete(notification);
      });
      notification.once("close", () => this.notifications.delete(notification));
      notification.show();
    } catch {
      console.error("Could not show Task notification");
    }
  }
}

export const taskReminderScheduler = new InMemoryTaskReminderScheduler();
