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
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
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
  const script = `const { buildTaskWidgetSnapshot } = require(${JSON.stringify(
    modulePath
  )});
process.stdout.write(JSON.stringify(buildTaskWidgetSnapshot(${JSON.stringify(
    tasks
  )}, {
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

function task(
  id: string,
  dueDate: string | undefined,
  patch: Partial<Task> = {}
): Task {
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
    expect(snapshot.accountScope).toBeUndefined();
    expect(snapshot.count).toBe(0);
    expect(snapshot.totalOpen).toBe(0);
    expect(snapshot.flaggedOpen).toBe(0);
    expect(snapshot.generatedDayCount).toBe(0);
    expect(snapshot.tasks).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("Task ");
  });
  test("includes only an opaque scope and Task revision for an interactive row", () => {
    const snapshot = buildTaskWidgetSnapshot(
      [task("0123456789abcdef01234567", "2026-09-24")],
      {
        now: NOW,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF",
        accountScope: "a".repeat(32)
      }
    );
    expect(snapshot.accountScope).toBe("a".repeat(32));
    expect(snapshot.tasks[0].updatedAt).toBe(NOW);
    expect(JSON.stringify(snapshot)).not.toContain("account-a");
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
    expect(snapshot.tasks.map((item) => item.id)).toEqual([
      "overdue",
      "today",
      "future"
    ]);
    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.generatedForDate).toBe("2026-09-24");
    expect(snapshot.generatedForTimeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
    expect(snapshot.utcOffsetMinutes).toBe(-new Date(NOW).getTimezoneOffset());
    expect(snapshot.tasks[0].dueDate).toBe("2026-09-23");
    expect(snapshot.tasks[1].dueDate).toBe("2026-09-24");
  });

  test("uses the new reminder schedule instead of a retained legacy due date", () => {
    const snapshot = buildTaskWidgetSnapshot(
      [
        task("scheduled-today", "2026-09-30", {
          reminderDate: "2026-09-24",
          reminderTime: "14:00",
          scheduleVersion: 2
        }),
        task("unscheduled", "2026-09-24", {
          reminderDate: undefined,
          reminderTime: undefined,
          scheduleVersion: 2
        })
      ],
      {
        now: NOW,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF"
      }
    );
    // The undated Task is cached so the "All" list can show it, but it has no
    // schedule and therefore carries no due date or time keys.
    expect(snapshot.tasks.map((item) => item.id)).toEqual([
      "scheduled-today",
      "unscheduled"
    ]);
    expect(snapshot.tasks[0]).toMatchObject({
      dueDate: "2026-09-24",
      dueTime: "14:00"
    });
    expect(snapshot.tasks[1].dueDate).toBeUndefined();
    expect(snapshot.tasks[1].dueTime).toBeUndefined();
    expect(JSON.parse(JSON.stringify(snapshot.tasks[1]))).not.toHaveProperty(
      "dueDate"
    );
  });

  test("caches undated Tasks and counts every open Task", () => {
    const snapshot = buildTaskWidgetSnapshot(
      [
        task("overdue", "2026-09-23", { flagged: true }),
        task("today", "2026-09-24"),
        task("future", "2026-09-30"),
        task("undated-a", undefined),
        task("undated-b", undefined, { flagged: true }),
        task("undated-done", undefined, { completed: true }),
        task("done", "2026-09-24", { completed: true })
      ],
      {
        now: NOW,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF"
      }
    );
    // Dated rows keep their due sort; undated rows follow in input order.
    expect(snapshot.tasks.map((item) => item.id)).toEqual([
      "overdue",
      "today",
      "future",
      "undated-a",
      "undated-b"
    ]);
    // count and generatedDayCount keep their original meaning (dated, <= today).
    expect(snapshot.count).toBe(2);
    expect(snapshot.generatedDayCount).toBe(1);
    expect(snapshot.totalOpen).toBe(5);
    expect(snapshot.flaggedOpen).toBe(2);
    expect(snapshot.upcomingCounts).toEqual({ "2026-09-30": 1 });
    expect(JSON.stringify(snapshot)).not.toContain("undated-done");
    expect(JSON.stringify(snapshot)).not.toContain('"done"');
  });

  test("caps the cache at 64 dated, 32 undated and 16 extra flagged rows", () => {
    const dated = Array.from({ length: 70 }, (_, index) =>
      task(`future-${String(index).padStart(2, "0")}`, "2026-09-25")
    );
    const undated = Array.from({ length: 40 }, (_, index) =>
      task(`undated-${String(index).padStart(2, "0")}`, undefined)
    );
    // Flagged rows outside both windows are appended last, capped at 16.
    const flagged = Array.from({ length: 20 }, (_, index) =>
      task(`flag-${String(index).padStart(2, "0")}`, "2026-09-26", {
        createdAt: NOW + 1000,
        flagged: true
      })
    );
    const snapshot = buildTaskWidgetSnapshot([...dated, ...undated, ...flagged], {
      now: NOW,
      appearance: "system",
      accentLight: "#123ABC",
      accentDark: "#456DEF"
    });
    expect(snapshot.tasks).toHaveLength(64 + 32 + 16);
    expect(snapshot.tasks.slice(0, 64).map((item) => item.id)).toEqual(
      dated.slice(0, 64).map((item) => item.id)
    );
    expect(snapshot.tasks.slice(64, 96).map((item) => item.id)).toEqual(
      undated.slice(0, 32).map((item) => item.id)
    );
    expect(
      snapshot.tasks.slice(96).every((item) => item.flagged)
    ).toBe(true);
    // The cache is capped but every count stays exact.
    expect(snapshot.totalOpen).toBe(130);
    expect(snapshot.flaggedOpen).toBe(20);
    expect(snapshot.generatedDayCount).toBe(0);
    expect(snapshot.count).toBe(0);
  });

  test("stays well under the 256 KiB WidgetKit snapshot limit", () => {
    // 400 distinct future dates drive the date histogram to its 366-date cap,
    // and a full cache of 120-character titles drives the row limit.
    const spreadDate = (offset: number) => {
      const date = new Date(2027, 0, 1 + offset);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(date.getDate()).padStart(2, "0")}`;
    };
    const tasks = [
      ...Array.from({ length: 70 }, (_, index) =>
        task(`dated-${index}`, "2026-10-01", {
          title: `A long Task title ${"x".repeat(120)} ${index}`
        })
      ),
      ...Array.from({ length: 40 }, (_, index) =>
        task(`undated-${index}`, undefined, {
          title: `Undated ${"y".repeat(120)} ${index}`
        })
      ),
      ...Array.from({ length: 400 }, (_, index) =>
        task(`spread-${index}`, spreadDate(index), {
          title: `Flagged ${"z".repeat(120)} ${index}`,
          flagged: true
        })
      )
    ];
    const snapshot = buildTaskWidgetSnapshot(tasks, {
      now: NOW,
      appearance: "system",
      accentLight: "#123ABC",
      accentDark: "#456DEF"
    });
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    expect(bytes).toBeLessThan(256 * 1024);
  });

  test("keeps widget titles short and on one line", () => {
    const snapshot = buildTaskWidgetSnapshot(
      [
        task("title", "2026-09-24", {
          title: `First\nSecond ${"x".repeat(180)}`
        })
      ],
      {
        now: NOW,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF"
      }
    );
    expect(snapshot.tasks[0].title).toMatch(/^First Second /);
    expect(snapshot.tasks[0].title).toHaveLength(120);
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
    expect(snapshot.tasks.map((item) => item.id)).toEqual([
      "local-today",
      "future"
    ]);
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

(process.platform === "darwin" ? describe : describe.skip)(
  "production Task writer to WidgetKit decoder contract",
  () => {
    const swiftDirectory = path.join(__dirname, "../../ios/NotesWidget");
    let buildDirectory: string;
    let binary: string;
    const writtenAt = Date.parse("2026-09-24T12:00:00Z");
    const nextDay = Date.parse("2026-09-25T12:00:00Z");

    beforeAll(() => {
      buildDirectory = mkdtempSync(
        path.join(tmpdir(), "task-widget-contract-")
      );
      binary = path.join(buildDirectory, "snapshot-contract");
      execFileSync("xcrun", [
        "swiftc",
        "-o",
        binary,
        path.join(swiftDirectory, "TaskWidgetSnapshotCodec.swift"),
        path.join(swiftDirectory, "TaskWidgetSnapshotContract.swift")
      ]);
    });
    afterAll(() => {
      if (buildDirectory)
        rmSync(buildDirectory, { recursive: true, force: true });
    });

    function decode(
      snapshot: ReturnType<typeof buildTaskWidgetSnapshot>,
      at: number,
      timezone = "UTC"
    ) {
      return JSON.parse(
        execFileSync(binary, [String(at / 1000)], {
          input: JSON.stringify(snapshot),
          env: { ...process.env, TZ: timezone }
        }).toString()
      ) as {
        available: boolean;
        privacyHidden?: boolean;
        count?: number;
        ids?: string[];
        accountScope?: string | null;
        revisions?: Record<string, number>;
        lists?: Record<string, { count: number; ids: string[] }>;
      };
    }

    test("Swift decoder preserves account scope and Task revision", () => {
      const id = "0123456789abcdef01234567";
      const snapshot = buildTaskWidgetSnapshot([task(id, "2026-09-24")], {
        now: writtenAt,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF",
        accountScope: "a".repeat(32)
      });
      const decoded = decode(
        snapshot,
        writtenAt,
        snapshot.generatedForTimeZone
      );
      expect(decoded.accountScope).toBe("a".repeat(32));
      expect(decoded.revisions?.[id]).toBe(snapshot.tasks[0].updatedAt);
      const privateSnapshot = buildPrivateTaskWidgetSnapshot({
        now: writtenAt,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF",
        accountScope: "a".repeat(32)
      });
      expect(
        decode(privateSnapshot, writtenAt, snapshot.generatedForTimeZone)
          .accountScope
      ).toBeNull();
    });

    test("date-only, timed, overdue, recurring, urgent, and migrated Tasks survive midnight", () => {
      const snapshot = snapshotInTimezone("UTC", writtenAt, [
        task("date-only", "2026-09-24", {
          reminderDate: "2026-09-24",
          scheduleVersion: 2
        }),
        task("timed", "2026-09-24", {
          reminderDate: "2026-09-24",
          reminderTime: "14:00",
          scheduleVersion: 2
        }),
        task("overdue", "2026-09-23"),
        task("recurring", "2026-09-25", {
          reminderDate: "2026-09-25",
          scheduleVersion: 2,
          recurrenceRule: "FREQ=DAILY",
          seriesId: "series"
        }),
        task("urgent", "2026-09-25", {
          reminderDate: "2026-09-25",
          reminderTime: "15:00",
          scheduleVersion: 2,
          urgent: true,
          priority: "high",
          flagged: true,
          listId: "custom-list"
        }),
        task("legacy", "2026-09-30", {
          reminderAt: Date.parse("2026-09-23T09:00:00Z"),
          legacyReminderId: "source-reminder"
        }),
        task("completed", "2026-09-24", { completed: true }),
        task("unscheduled", "2026-09-24", {
          reminderDate: undefined,
          scheduleVersion: 2
        }),
        task("later", "2026-09-26")
      ]);
      expect(snapshot.count).toBe(4);
      expect(decode(snapshot, writtenAt)).toMatchObject({
        available: true,
        count: 4,
        ids: ["overdue", "legacy", "date-only", "timed"]
      });
      expect(decode(snapshot, nextDay)).toMatchObject({
        available: true,
        count: 6,
        ids: ["overdue", "legacy", "date-only", "timed", "recurring", "urgent"]
      });
      // The undated Task is cached for the "All" list only; it stays out of
      // the dated "Today" rows and carries no due keys. Rows follow the app's
      // Tasks screen: by date, timed before untimed on the same day.
      expect(decode(snapshot, writtenAt).lists?.all?.ids).toEqual([
        "legacy",
        "overdue",
        "timed",
        "date-only",
        "urgent",
        "recurring",
        "later",
        "unscheduled"
      ]);
      expect(snapshot.tasks.find((item) => item.id === "unscheduled"))
        .not.toHaveProperty("dueDate");
    });

    test("App Lock bytes decode as redacted without Task IDs or titles", () => {
      const snapshot = buildPrivateTaskWidgetSnapshot({
        now: writtenAt,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF"
      });
      expect(decode(snapshot, nextDay)).toMatchObject({
        available: true,
        privacyHidden: true,
        count: 0,
        ids: []
      });
    });

    test("pre-fix v3 snapshots remain decodable after midnight", () => {
      const snapshot = snapshotInTimezone("UTC", writtenAt, [
        task("old-overdue", "2026-09-23"),
        task("old-today", "2026-09-24")
      ]);
      delete (snapshot as Partial<typeof snapshot>).upcomingCounts;
      expect(decode(snapshot, nextDay)).toMatchObject({
        available: true,
        ids: ["old-overdue", "old-today"],
        count: 2
      });
    });

    test("local dates remain valid across a daylight-saving offset change", () => {
      const before = Date.parse("2026-03-28T12:00:00Z");
      const after = Date.parse("2026-03-29T12:00:00Z");
      const snapshot = snapshotInTimezone("Europe/Oslo", before, [
        task("overdue", "2026-03-28"),
        task("today", "2026-03-29")
      ]);
      expect(decode(snapshot, after, "Europe/Oslo")).toMatchObject({
        available: true,
        ids: ["overdue", "today"],
        count: 2
      });
    });

    test("equivalent timezone aliases decode, while a real offset change asks for refresh", () => {
      const snapshot = snapshotInTimezone("America/Los_Angeles", writtenAt, [
        task("today", "2026-09-24")
      ]);
      expect(decode(snapshot, writtenAt, "US/Pacific")).toMatchObject({
        available: true,
        ids: ["today"]
      });
      expect(decode(snapshot, writtenAt, "UTC")).toMatchObject({
        available: false
      });
    });

    function smartListTasks() {
      return [
        task("overdue", "2026-09-23"),
        task("today", "2026-09-24", {
          reminderDate: "2026-09-24",
          reminderTime: "14:00",
          scheduleVersion: 2
        }),
        task("today-late", "2026-09-24", {
          reminderDate: "2026-09-24",
          reminderTime: "18:00",
          scheduleVersion: 2
        }),
        task("tomorrow", "2026-09-25"),
        task("later", "2026-09-27", { flagged: true }),
        task("undated-a", "2026-09-24", {
          reminderDate: undefined,
          reminderTime: undefined,
          scheduleVersion: 2
        }),
        task("undated-b", "2026-09-24", {
          reminderDate: undefined,
          reminderTime: undefined,
          scheduleVersion: 2,
          flagged: true
        }),
        task("done", "2026-09-24", { completed: true })
      ];
    }

    test("smart lists match the app's Today, Scheduled, All and Flagged lists", () => {
      const snapshot = snapshotInTimezone("UTC", writtenAt, smartListTasks());
      expect(snapshot.count).toBe(3);
      const decoded = decode(snapshot, writtenAt);
      expect(decoded.lists?.today).toEqual({
        count: 3,
        ids: ["overdue", "today", "today-late"]
      });
      expect(decoded.lists?.scheduled).toEqual({
        count: 4,
        ids: ["today", "today-late", "tomorrow", "later"]
      });
      // Dated rows by due, then the undated rows in cached order.
      expect(decoded.lists?.all).toEqual({
        count: 7,
        ids: [
          "overdue",
          "today",
          "today-late",
          "tomorrow",
          "later",
          "undated-a",
          "undated-b"
        ]
      });
      expect(decoded.lists?.flagged).toEqual({
        count: 2,
        ids: ["later", "undated-b"]
      });
    });

    test("smart lists roll over midnight from the cached rows and date histogram", () => {
      const snapshot = snapshotInTimezone("UTC", writtenAt, smartListTasks());
      const decoded = decode(snapshot, nextDay);
      expect(decoded.lists?.today?.ids).toEqual([
        "overdue",
        "today",
        "today-late",
        "tomorrow"
      ]);
      // "Today"'s count stays exact: 3 generation-day rows plus tomorrow's one.
      expect(decoded.lists?.today?.count).toBe(4);
      expect(decoded.lists?.scheduled).toEqual({
        count: 2,
        ids: ["tomorrow", "later"]
      });
      expect(decoded.lists?.all?.count).toBe(7);
      expect(decoded.lists?.flagged?.count).toBe(2);
    });

    test("App Lock snapshots expose no smart list contents", () => {
      const snapshot = buildPrivateTaskWidgetSnapshot({
        now: writtenAt,
        appearance: "system",
        accentLight: "#123ABC",
        accentDark: "#456DEF"
      });
      const decoded = decode(snapshot, nextDay);
      expect(decoded.lists).toEqual({
        today: { count: 0, ids: [] },
        scheduled: { count: 0, ids: [] },
        all: { count: 0, ids: [] },
        flagged: { count: 0, ids: [] }
      });
    });

    test("the count stays accurate when cached rows are capped", () => {
      const snapshot = snapshotInTimezone(
        "UTC",
        writtenAt,
        Array.from({ length: 70 }, (_, index) =>
          task(`future-${index}`, "2026-09-25")
        )
      );
      expect(snapshot.tasks).toHaveLength(64);
      expect(decode(snapshot, writtenAt)).toMatchObject({
        available: true,
        count: 0,
        ids: []
      });
      expect(decode(snapshot, nextDay)).toMatchObject({
        available: true,
        count: 70
      });
    });
  }
);
