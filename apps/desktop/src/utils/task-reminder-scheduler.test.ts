/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2026 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notifications = vi.hoisted(
  () =>
    [] as {
      title: string;
      click: () => void;
    }[]
);

vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return true;
    }

    private listeners = new Map<string, () => void>();

    constructor(readonly options: { title: string }) {
      notifications.push({
        title: options.title,
        click: () => this.listeners.get("click")?.()
      });
    }

    once(event: string, handler: () => void) {
      this.listeners.set(event, handler);
    }

    show() {}
  }
}));

vi.mock("./asset-manager", () => ({
  AssetManager: { appIcon: () => "icon.png" }
}));

import { InMemoryTaskReminderScheduler } from "./task-reminder-scheduler";

describe("Electron Task reminder scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    notifications.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces, cancels, and delivers a stable Task reminder only once", () => {
    const scheduler = new InMemoryTaskReminderScheduler();
    const clicked: string[] = [];
    scheduler.setActivationHandler((id) => clicked.push(id));
    const now = Date.now();

    scheduler.replace([
      { id: "first", title: "Original", reminderAt: now + 1000 }
    ]);
    scheduler.replace([
      { id: "first", title: "Edited", reminderAt: now + 3000 }
    ]);
    vi.advanceTimersByTime(1000);
    expect(notifications).toHaveLength(0);

    scheduler.replace([]);
    vi.advanceTimersByTime(3000);
    expect(notifications).toHaveLength(0);

    scheduler.replace([
      { id: "first", title: "Final", reminderAt: Date.now() + 1000 }
    ]);
    vi.advanceTimersByTime(1000);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("Final");
    notifications[0].click();
    expect(clicked).toEqual(["first"]);
    vi.advanceTimersByTime(5000);
    expect(notifications).toHaveLength(1);
    scheduler.clear();
  });

  it("keeps a far-future reminder armed beyond the maximum timer interval", () => {
    const scheduler = new InMemoryTaskReminderScheduler();
    const at = Date.now() + 2_147_483_647 + 1000;
    scheduler.replace([{ id: "future", title: "Future", reminderAt: at }]);
    vi.advanceTimersByTime(2_147_483_647);
    expect(notifications).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(notifications).toHaveLength(1);
    scheduler.clear();
  });

  it("keeps an unchanged due reminder through a late renderer refresh", () => {
    const scheduler = new InMemoryTaskReminderScheduler();
    const reminder = { id: "due", title: "Due", reminderAt: Date.now() + 1000 };
    scheduler.replace([reminder]);
    vi.setSystemTime(reminder.reminderAt + 1);
    scheduler.replace([reminder]);
    vi.runOnlyPendingTimers();
    expect(notifications).toHaveLength(1);
    scheduler.clear();
  });
});
