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

import { parseQuickAdd } from "./quick-add-parse";

// Tuesday, 29 September 2026, 10:15 local time.
const NOW = new Date(2026, 8, 29, 10, 15);

describe("parseQuickAdd", () => {
  it("keeps plain titles untouched", () => {
    expect(parseQuickAdd("Buy milk", NOW)).toEqual({ title: "Buy milk" });
  });

  it("parses German 'morgen 9 Uhr'", () => {
    expect(parseQuickAdd("Müll rausbringen morgen 9 Uhr", NOW)).toEqual({
      title: "Müll rausbringen",
      date: "2026-09-30",
      time: "09:00"
    });
  });

  it("parses English 'tomorrow 9am'", () => {
    expect(parseQuickAdd("Call Anna tomorrow 9am", NOW)).toEqual({
      title: "Call Anna",
      date: "2026-09-30",
      time: "09:00"
    });
  });

  it("parses 'today at 14:30'", () => {
    expect(parseQuickAdd("Dentist today at 14:30", NOW)).toEqual({
      title: "Dentist",
      date: "2026-09-29",
      time: "14:30"
    });
  });

  it("parses pm times", () => {
    expect(parseQuickAdd("Gym 6:30pm", NOW)).toEqual({
      title: "Gym",
      date: "2026-09-29",
      time: "18:30"
    });
  });

  it("moves a past bare time to tomorrow", () => {
    expect(parseQuickAdd("Standup um 9", NOW)).toEqual({
      title: "Standup",
      date: "2026-09-30",
      time: "09:00"
    });
  });

  it("parses relative hours", () => {
    expect(parseQuickAdd("Check oven in 2 hours", NOW)).toEqual({
      title: "Check oven",
      date: "2026-09-29",
      time: "12:15"
    });
    expect(parseQuickAdd("Anrufen in 1 Std.", NOW)).toEqual({
      title: "Anrufen",
      date: "2026-09-29",
      time: "11:15"
    });
  });

  it("parses weekdays to the next occurrence", () => {
    expect(parseQuickAdd("Report Montag", NOW)).toEqual({
      title: "Report",
      date: "2026-10-05"
    });
    expect(parseQuickAdd("Review next tuesday 8am", NOW)).toEqual({
      title: "Review",
      date: "2026-10-06",
      time: "08:00"
    });
  });

  it("does not match words inside other words", () => {
    expect(parseQuickAdd("Morgenroutine planen", NOW)).toEqual({
      title: "Morgenroutine planen"
    });
    expect(parseQuickAdd("Heutelist", NOW)).toEqual({ title: "Heutelist" });
  });

  it("parses 'heute abend'", () => {
    expect(parseQuickAdd("Kochen heute abend", NOW)).toEqual({
      title: "Kochen",
      date: "2026-09-29",
      time: "18:00"
    });
  });

  it("parses übermorgen and evening", () => {
    expect(parseQuickAdd("Packen übermorgen abends", NOW)).toEqual({
      title: "Packen",
      date: "2026-10-01",
      time: "18:00"
    });
  });
});
