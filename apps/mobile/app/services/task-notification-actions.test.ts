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

import { snoozedSchedule, taskActionApplies } from "./task-notification-actions";

jest.mock("../common/database", () => ({ db: {}, DatabaseLogger: {} }));
jest.mock("../stores/use-user-store", () => ({ useUserStore: {} }));
jest.mock("./settings", () => ({ __esModule: true, default: {} }));
jest.mock("./task-navigation", () => ({}));

describe("task notification actions", () => {
  it("snoozes to one hour from now across midnight", () => {
    expect(snoozedSchedule(new Date(2026, 8, 29, 23, 30))).toEqual({
      reminderDate: "2026-09-30",
      reminderTime: "00:30"
    });
  });

  it("applies only to the unchanged, open occurrence", () => {
    const task = { completed: false, updatedAt: 42, occurrenceKey: "a" };
    expect(taskActionApplies(task, { updatedAt: "42", occurrenceKey: "a" })).toBe(
      true
    );
    expect(taskActionApplies(task, { updatedAt: "41" })).toBe(false);
    expect(taskActionApplies(task, { updatedAt: "42", occurrenceKey: "b" })).toBe(
      false
    );
    expect(
      taskActionApplies({ ...task, completed: true }, { updatedAt: "42" })
    ).toBe(false);
  });
});
