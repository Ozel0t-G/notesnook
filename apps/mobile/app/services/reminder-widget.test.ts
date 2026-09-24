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

import { Reminder } from "@notesnook/core";
import {
  buildReminderWidgetSnapshot,
  getReminderWidgetTimestamp
} from "./reminder-widget-snapshot";
import {
  parseReminderWidgetLink,
  REMINDER_WIDGET_URLS
} from "./reminder-widget-links";

const NOW = new Date(2026, 8, 22, 12).getTime();

function reminder(
  id: string,
  date: number,
  overrides: Partial<Reminder> = {}
): Reminder {
  return {
    id,
    type: "reminder",
    title: `Reminder ${id}`,
    date,
    mode: "once",
    priority: "vibrate",
    dateCreated: NOW,
    dateModified: NOW,
    selectedDays: [],
    ...overrides
  } as Reminder;
}

describe("reminder widget snapshot", () => {
  test("sorts overdue reminders first and keeps the total count", () => {
    const reminders = [
      ...Array.from({ length: 11 }, (_, index) =>
        reminder(`${index}`, NOW + (index + 1) * 60_000)
      ),
      reminder("overdue", NOW - 60_000)
    ];
    const snapshot = buildReminderWidgetSnapshot(reminders, {
      now: NOW,
      appearance: "dark",
      accentLight: "#123ABC",
      accentDark: "#456DEF"
    });

    expect(snapshot.count).toBe(12);
    expect(snapshot.reminders).toHaveLength(10);
    expect(snapshot.reminders[0].id).toBe("overdue");
    expect(snapshot.accentLight).toBe("#123ABC");
    expect(snapshot.accentDark).toBe("#456DEF");
  });

  test("keeps stale one-time reminders for overdue presentation, but excludes disabled reminders", () => {
    const snapshot = buildReminderWidgetSnapshot(
      [
        reminder("disabled", NOW + 1000, { disabled: true }),
        reminder("old", NOW - 4 * 60 * 60 * 1000),
        reminder("active", NOW + 2000)
      ],
      {
        now: NOW,
        appearance: "light",
        accentLight: "invalid",
        accentDark: "also-invalid"
      }
    );
    expect(snapshot.count).toBe(2);
    expect(snapshot.reminders.map((item) => item.id)).toEqual([
      "old",
      "active"
    ]);
    expect(snapshot.accentLight).toBe("#008837");
    expect(snapshot.accentDark).toBe("#008837");
  });

  test("uses snooze time and omits a timestamp for permanent reminders", () => {
    expect(
      getReminderWidgetTimestamp(
        reminder("snoozed", NOW - 1000, { snoozeUntil: NOW + 5000 }),
        NOW
      )
    ).toBe(NOW + 5000);
    expect(
      getReminderWidgetTimestamp(
        reminder("permanent", NOW, { mode: "permanent" }),
        NOW
      )
    ).toBeUndefined();
  });

  test("uses the next core-calculated trigger for recurring reminders", () => {
    const snapshot = buildReminderWidgetSnapshot(
      [
        reminder("recurring", NOW - 60 * 60 * 1000, {
          mode: "repeat",
          recurringMode: "day"
        })
      ],
      {
        now: NOW,
        appearance: "system",
        accentLight: "#008837",
        accentDark: "#20A65A"
      }
    );

    expect(snapshot.reminders[0].timestamp).toBeGreaterThan(Date.now());
  });

  test("serializes only the privacy-minimal widget fields", () => {
    const snapshot = buildReminderWidgetSnapshot(
      [
        reminder("private", NOW + 1000, {
          title: "Visible title",
          description: "This must never leave the app database"
        })
      ],
      {
        now: NOW,
        appearance: "system",
        accentLight: "#008837",
        accentDark: "#20A65A"
      }
    );
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.reminders[0]).toEqual({
      id: "private",
      title: "Visible title",
      timestamp: NOW + 1000
    });
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("This must never leave the app database");
  });
});

describe("reminder widget links", () => {
  test("parses list, create and reminder links", () => {
    expect(parseReminderWidgetLink(REMINDER_WIDGET_URLS.list)).toEqual({
      action: "list"
    });
    expect(parseReminderWidgetLink(REMINDER_WIDGET_URLS.create)).toEqual({
      action: "create"
    });
    expect(
      parseReminderWidgetLink(REMINDER_WIDGET_URLS.reminder("0123456789abcdef01234567"))
    ).toEqual({ action: "task", id: "0123456789abcdef01234567" });
  });

  test("rejects unrelated and malformed links", () => {
    expect(
      parseReminderWidgetLink("ShareMedia://QuickNoteWidget")
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink("ShareMedia://Reminder/%GG")
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink("ShareMedia://ReminderWidget")
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink("ShareMedia://ReminderWidgetEvil?id=known")
    ).toBeUndefined();
    expect(parseReminderWidgetLink(undefined)).toBeUndefined();
  });
});
