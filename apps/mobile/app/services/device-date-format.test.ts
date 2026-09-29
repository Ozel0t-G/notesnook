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

jest.mock("../common/database", () => ({ db: {}, DatabaseLogger: {} }));
jest.mock("../common/database/mmkv", () => ({ MMKV: {} }));

import { deviceDateTimeFormats } from "./device-date-format";

const parts = (locale: string) =>
  new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(new Date(2026, 10, 22));

describe("deviceDateTimeFormats", () => {
  it("maps German to DD.MM.YYYY and 24-hour", () => {
    expect(deviceDateTimeFormats(parts("de-DE"), false)).toEqual({
      dateFormat: "DD.MM.YYYY",
      timeFormat: "24-hour"
    });
  });

  it("maps US English to MM/DD/YYYY and 12-hour", () => {
    expect(deviceDateTimeFormats(parts("en-US"), true)).toEqual({
      dateFormat: "MM/DD/YYYY",
      timeFormat: "12-hour"
    });
  });

  it("maps ISO-like locales", () => {
    expect(deviceDateTimeFormats(parts("sv-SE"), false).dateFormat).toBe(
      "YYYY-MM-DD"
    );
  });
});
