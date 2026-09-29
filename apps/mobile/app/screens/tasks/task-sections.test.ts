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
import { taskListRows } from "./task-sections";

const NOW = new Date(2026, 8, 29, 12, 0);

function task(
  id: string,
  reminderDate?: string,
  reminderTime?: string,
  completed = false
): Task {
  return {
    id,
    title: id,
    listId: "l",
    priority: "none",
    flagged: false,
    completed,
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    scheduleVersion: 2,
    reminderDate,
    reminderTime
  } as unknown as Task;
}

const shape = (rows: ReturnType<typeof taskListRows>) =>
  rows.map((row) => (row.kind === "header" ? `#${row.section}` : row.id));

describe("taskListRows", () => {
  it("adds no header to a plain undated list", () => {
    expect(shape(taskListRows([task("a"), task("b")], { now: NOW }))).toEqual([
      "a",
      "b"
    ]);
  });

  it("groups overdue, today, later and no date", () => {
    const rows = taskListRows(
      [
        task("undated"),
        task("later", "2026-10-02"),
        task("today", "2026-09-29", "18:00"),
        task("overdue", "2026-09-28")
      ],
      { now: NOW }
    );
    expect(shape(rows)).toEqual([
      "#overdue",
      "overdue",
      "#today",
      "today",
      "#later",
      "later",
      "#noDate",
      "undated"
    ]);
  });

  it("groups scheduled tasks per day after overdue", () => {
    const rows = taskListRows(
      [
        task("b", "2026-10-01"),
        task("a", "2026-09-29", "20:00"),
        task("c", "2026-09-29", "08:00")
      ],
      { now: NOW, perDay: true }
    );
    expect(shape(rows)).toEqual(["#overdue", "c", "#today", "a", "#day", "b"]);
  });

  it("puts completed tasks last", () => {
    const rows = taskListRows([task("done", undefined, undefined, true), task("open")], {
      now: NOW
    });
    expect(shape(rows)).toEqual(["#noDate", "open", "#completed", "done"]);
  });
});
