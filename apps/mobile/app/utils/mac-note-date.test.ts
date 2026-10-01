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

import { formatMacNoteDate } from "./mac-note-date";

describe("Mac note-list date", () => {
  test("formats today as localized relative day + time", () => {
    const now = new Date(2026, 8, 30, 18, 0);
    expect(
      formatMacNoteDate(new Date(2026, 8, 30, 12, 13), now, "en-US")
    ).toBe("Today 12:13 PM");
  });

  test("formats yesterday as localized relative day + time", () => {
    const now = new Date(2026, 8, 30, 10, 0);
    expect(
      formatMacNoteDate(new Date(2026, 8, 29, 14, 2), now, "en-US")
    ).toBe("Yesterday 2:02 PM");
    expect(
      formatMacNoteDate(new Date(2026, 8, 29, 14, 2), now, "de-DE")
    ).toBe("Gestern 14:02");
  });

  test("uses the calendar day, not a rolling 24 hour window", () => {
    const now = new Date(2026, 8, 30, 0, 30);
    // 23:30 the previous evening is under 24 hours ago but still yesterday.
    expect(
      formatMacNoteDate(new Date(2026, 8, 29, 23, 30), now, "en-US")
    ).toBe("Yesterday 11:30 PM");
  });

  test("formats older dates as a localized short date", () => {
    const now = new Date(2026, 8, 30, 10, 0);
    expect(
      formatMacNoteDate(new Date(2026, 8, 28, 14, 2), now, "en-US")
    ).toBe("9/28/2026");
    expect(
      formatMacNoteDate(new Date(2026, 8, 28, 14, 2), now, "de-DE")
    ).toBe("28.9.2026");
  });

  test("accepts a timestamp", () => {
    const now = new Date(2026, 8, 30, 10, 0);
    expect(
      formatMacNoteDate(new Date(2026, 8, 30, 9, 5).getTime(), now, "en-US")
    ).toBe("Today 9:05 AM");
  });

  test("returns an empty string for an invalid date", () => {
    expect(formatMacNoteDate(Number.NaN, new Date(2026, 8, 30), "en-US")).toBe(
      ""
    );
  });
});
