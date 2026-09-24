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
import { execFileSync } from "child_process";
import path from "path";
import {
  buildPrivateTaskWidgetSnapshot,
  buildTaskWidgetSnapshot
} from "./task-widget-snapshot";
import {
  parseReminderWidgetLink,
  REMINDER_WIDGET_URLS
} from "./reminder-widget-links";

const NOW = new Date(2026, 8, 24, 12).getTime();

function snapshotInTimezone(timezone: string, now: number, tasks: Task[] = []) {
  const modulePath = path.join(__dirname, "task-widget-snapshot.ts");
  const script = `const { buildTaskWidgetSnapshot } = require(${JSON.stringify(modulePath)});
process.stdout.write(JSON.stringify(buildTaskWidgetSnapshot(${JSON.stringify(tasks)}, {
  now: ${now}, appearance: "system", accentLight: "#123ABC", accentDark: "#456DEF"
})));`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-e", script],
      {
        env: {
          ...process.env,
          TZ: timezone,
          TS_NODE_SKIP_PROJECT: "1",
          TS_NODE_COMPILER_OPTIONS:
            '{"module":"CommonJS","moduleResolution":"node","target":"ES2022"}'
        }
      }
    ).toString()
  ) as ReturnType<typeof buildTaskWidgetSnapshot>;
}

function task(id: string, dueDate: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    dueDate,
    completed: false,
    flagged: false,
    priority: "none",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  } as Task;
}

describe("task widget", () => {
  test("App Lock snapshot contains no Task titles or IDs", () => {
    const snapshot = buildPrivateTaskWidgetSnapshot({
      now: NOW,
      appearance: "system",
      accentLight: "#123ABC",
      accentDark: "#456DEF"
    });
    expect(snapshot.privacyHidden).toBe(true);
    expect(snapshot.count).toBe(0);
    expect(snapshot.tasks).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("Task ");
  });
  test("shows overdue and today tasks, including date-only values", () => {
    const snapshot = buildTaskWidgetSnapshot(
      [
        task("future", "2026-09-25"),
        task("today", "2026-09-24"),
        task("overdue", "2026-09-23"),
        task("done", "2026-09-24", { completed: true })
      ],
      {
        now: NOW,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF"
      }
    );
    expect(snapshot.count).toBe(2);
    expect(snapshot.tasks.map((item) => item.id)).toEqual(["overdue", "today"]);
    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.generatedForDate).toBe("2026-09-24");
    expect(snapshot.generatedForTimeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
    expect(snapshot.utcOffsetMinutes).toBe(-new Date(NOW).getTimezoneOffset());
    expect(snapshot.tasks[0].dueDate).toBe("2026-09-23");
    expect(snapshot.tasks[1].dueDate).toBe("2026-09-24");
  });

  test("marks the current local day across a timezone boundary", () => {
    const snapshot = snapshotInTimezone(
      "Pacific/Kiritimati",
      Date.parse("2026-09-24T11:30:00Z"),
      [task("local-today", "2026-09-25"), task("future", "2026-09-26")]
    );
    expect(snapshot.generatedForDate).toBe("2026-09-25");
    expect(snapshot.generatedForTimeZone).toBe("Pacific/Kiritimati");
    expect(snapshot.utcOffsetMinutes).toBe(14 * 60);
    expect(snapshot.tasks.map((item) => item.id)).toEqual(["local-today"]);
  });

  test("records a changed UTC offset across DST even on the same day", () => {
    const before = snapshotInTimezone(
      "Europe/Oslo",
      Date.parse("2026-03-29T00:30:00Z")
    );
    const after = snapshotInTimezone(
      "Europe/Oslo",
      Date.parse("2026-03-29T01:30:00Z")
    );
    expect(before.generatedForDate).toBe("2026-03-29");
    expect(after.generatedForDate).toBe("2026-03-29");
    expect(before.generatedForTimeZone).toBe("Europe/Oslo");
    expect(before.utcOffsetMinutes).toBe(60);
    expect(after.utcOffsetMinutes).toBe(120);

    const fallBefore = snapshotInTimezone(
      "Europe/Oslo",
      Date.parse("2026-10-25T00:30:00Z")
    );
    const fallAfter = snapshotInTimezone(
      "Europe/Oslo",
      Date.parse("2026-10-25T01:30:00Z")
    );
    expect(fallBefore.generatedForDate).toBe("2026-10-25");
    expect(fallAfter.generatedForDate).toBe("2026-10-25");
    expect(fallBefore.utcOffsetMinutes).toBe(120);
    expect(fallAfter.utcOffsetMinutes).toBe(60);
  });

  test("completion links target a stable task ID", () => {
    expect(
      parseReminderWidgetLink(
        REMINDER_WIDGET_URLS.complete("0123456789abcdef01234567")
      )
    ).toEqual({ action: "complete", id: "0123456789abcdef01234567" });
    expect(
      parseReminderWidgetLink("ShareMedia://TaskWidget?id=")
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(REMINDER_WIDGET_URLS.complete("a/b"))
    ).toBeUndefined();
  });
});
