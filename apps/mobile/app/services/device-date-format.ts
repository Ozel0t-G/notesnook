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

import { db, DatabaseLogger } from "../common/database";
import { MMKV } from "../common/database/mmkv";

const DEFAULT_DATE_FORMAT = "DD-MM-YYYY";
const DEFAULT_TIME_FORMAT = "12-hour";
const MIGRATION_KEY = "veyran.dateFormats.device.v1";

type Part = { type: string; value: string };

/**
 * Picks the supported date/time format that matches how the device formats
 * dates (order and separator) and whether it uses a 12-hour clock.
 */
export function deviceDateTimeFormats(
  dateParts: Part[],
  hour12: boolean
): { dateFormat: string; timeFormat: "12-hour" | "24-hour" } {
  const order = dateParts
    .filter((part) => ["day", "month", "year"].includes(part.type))
    .map((part) =>
      part.type === "day" ? "DD" : part.type === "month" ? "MM" : "YYYY"
    );
  const separator =
    dateParts.find((part) => part.type === "literal")?.value.trim() || "-";
  const sep = ["-", "/", "."].includes(separator) ? separator : "-";
  const known = ["DD,MM,YYYY", "MM,DD,YYYY", "YYYY,MM,DD"];
  const dateFormat = known.includes(order.join(","))
    ? order.join(sep)
    : DEFAULT_DATE_FORMAT;
  return { dateFormat, timeFormat: hour12 ? "12-hour" : "24-hour" };
}

function currentDeviceFormats() {
  const sample = new Date(2026, 10, 22, 15, 0);
  const parts = new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(sample);
  const hour12 = !!new Intl.DateTimeFormat(undefined, {
    hour: "numeric"
  }).resolvedOptions().hour12;
  return deviceDateTimeFormats(parts, hour12);
}

/**
 * Replaces the untouched upstream defaults ("29-09-2026 01:00 PM") with the
 * device's own formats once. A format the user picked in Settings is kept.
 */
export async function adoptDeviceDateFormats() {
  try {
    if (MMKV.getString(MIGRATION_KEY) === "done") return;
    const formats = currentDeviceFormats();
    if (db.settings.getDateFormat() === DEFAULT_DATE_FORMAT)
      await db.settings.setDateFormat(formats.dateFormat);
    if (db.settings.getTimeFormat() === DEFAULT_TIME_FORMAT)
      await db.settings.setTimeFormat(formats.timeFormat);
    MMKV.setString(MIGRATION_KEY, "done");
  } catch (error) {
    DatabaseLogger.error(error as Error, "Adopt device date formats");
  }
}
