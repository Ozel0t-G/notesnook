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

/**
 * Mac Catalyst note-list dates (WP06/R5).
 *
 * The iPad row prints an absolute date through the app's `dateFormat`
 * setting, which defaults to the US format ("09/30/2026") even on a
 * German system. Mac source-list rows instead show a relative day
 * ("Today"/"Yesterday"/localized date) followed by the localized time.
 * Pure and locale-driven so it stays testable without a React tree.
 */
export function formatMacNoteDate(
  date: number | Date,
  now: Date = new Date(),
  locale?: string
): string {
  const value = date instanceof Date ? date : new Date(date);
  if (isNaN(value.getTime())) return "";

  const dayDiff = calendarDayDiff(now, value);
  if (dayDiff === 0 || dayDiff === -1) {
    return `${relativeDay(dayDiff, locale)} ${formatTime(value, locale)}`;
  }

  return value.toLocaleDateString(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric"
  });
}

/**
 * Whole local calendar days between `now` and `date` (negative = past).
 * Computed on local midnights so a date "yesterday 23:30" is still
 * yesterday and DST changes cannot shift the result.
 */
function calendarDayDiff(now: Date, date: Date): number {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / dayMs);
}

/**
 * "Today"/"Yesterday", localized. Hermes ships without
 * `Intl.RelativeTimeFormat`, so it is feature-checked and falls back to
 * English/German words instead of throwing while rendering the list.
 */
function relativeDay(dayDiff: number, locale?: string): string {
  const RelativeTimeFormat = (Intl as { RelativeTimeFormat?: any })
    .RelativeTimeFormat;
  if (typeof RelativeTimeFormat === "function") {
    try {
      const relative = new RelativeTimeFormat(locale, {
        numeric: "auto"
      }).format(dayDiff, "day");
      return capitalize(relative, locale);
    } catch {
      // Fall through to the fixed words below.
    }
  }
  const german = (locale ?? currentLocale()).toLowerCase().startsWith("de");
  if (dayDiff === 0) return german ? "Heute" : "Today";
  return german ? "Gestern" : "Yesterday";
}

function currentLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "en";
  } catch {
    return "en";
  }
}

function formatTime(date: Date, locale?: string): string {
  return date.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function capitalize(value: string, locale?: string): string {
  return value.charAt(0).toLocaleUpperCase(locale) + value.slice(1);
}
