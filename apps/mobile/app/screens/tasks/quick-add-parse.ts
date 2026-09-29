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
 * Natural-language scheduling for Quick Add ("Call Anna tomorrow 9am",
 * "Müll rausbringen morgen 9 Uhr", "Pay rent in 2 hours"). English and
 * German keywords are recognised; everything that is not a date or time stays
 * in the title. Pure and clock-injected so it can be tested.
 */
export type QuickAddParse = {
  title: string;
  /** `YYYY-MM-DD` */
  date?: string;
  /** `HH:mm` */
  time?: string;
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sonntag: 0,
  monday: 1,
  montag: 1,
  tuesday: 2,
  dienstag: 2,
  wednesday: 3,
  mittwoch: 3,
  thursday: 4,
  donnerstag: 4,
  friday: 5,
  freitag: 5,
  saturday: 6,
  samstag: 6,
  sonnabend: 6
};

// Words may only match as whole words; letters include German umlauts.
const L = "A-Za-zÄÖÜäöüß";
const START = `(^|[^${L}0-9])`;
const END = `(?=$|[^${L}0-9])`;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatDate(value: Date) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
    value.getDate()
  )}`;
}

function addDays(value: Date, days: number) {
  const next = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

type Match = { date?: Date; time?: string; exactDate?: Date };

export function parseQuickAdd(
  input: string,
  now: Date = new Date()
): QuickAddParse {
  let text = ` ${input} `;
  const result: Match = {};

  const take = (pattern: string, handler: (m: RegExpExecArray) => void) => {
    const regex = new RegExp(`${START}(${pattern})${END}`, "i");
    const match = regex.exec(text);
    if (!match) return false;
    handler(match);
    text =
      text.slice(0, match.index + match[1].length) +
      " " +
      text.slice(match.index + match[0].length);
    return true;
  };

  // Relative offsets: "in 2 hours", "in 30 min", "in 1 Std."
  take(
    `(?:in)\\s+(\\d{1,3})\\s*(hours?|hrs?|h|stunden?|std\\.?|minutes?|mins?|minuten?|min\\.?)`,
    (m) => {
      const amount = Number(m[3]);
      const unit = m[4].toLowerCase();
      const minutes =
        unit.startsWith("m") ? amount : amount * 60;
      const target = new Date(now.getTime() + minutes * 60_000);
      result.exactDate = target;
    }
  );
  if (!result.exactDate)
    take(`in\\s+(?:an?|one|einer)\\s+(hour|stunde)`, () => {
      result.exactDate = new Date(now.getTime() + 60 * 60_000);
    });

  // Dates.
  if (!result.exactDate) {
    take(`tonight|this evening|heute abend|heute nacht`, () => {
      result.date = addDays(now, 0);
      result.time = "18:00";
    }) ||
      take(`day after tomorrow|übermorgen|uebermorgen`, () => {
        result.date = addDays(now, 2);
      }) ||
      take(`tomorrow|tmrw|morgen`, () => {
        result.date = addDays(now, 1);
      }) ||
      take(`today|heute`, () => {
        result.date = addDays(now, 0);
      }) ||
      take(`next week|nächste woche|naechste woche`, () => {
        result.date = addDays(now, 7);
      }) ||
      take(
        `(?:(?:next|on|am|nächsten|naechsten|kommenden)\\s+)?(${Object.keys(
          WEEKDAYS
        ).join("|")})`,
        (m) => {
          const target = WEEKDAYS[m[3].toLowerCase()];
          let delta = (target - now.getDay() + 7) % 7;
          if (delta === 0) delta = 7;
          result.date = addDays(now, delta);
        }
      );

    // "abends"/"evening" after a date sets the evening default.
    take(`(?:in the )?evening|abends|am abend`, () => {
      if (!result.time) result.time = "18:00";
    });
    take(`(?:in the )?morning|morgens|früh|frueh`, () => {
      if (!result.time) result.time = "09:00";
    });

    // Times: "9am", "9:30 pm", "at 9", "um 9", "14:00", "9 Uhr", "9.30 Uhr".
    take(
      `(?:(?:at|um|@)\\s*)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.|uhr|h)`,
      (m) => {
        const time = clockTime(m[3], m[4], m[5]);
        if (time) result.time = time;
      }
    ) ||
      take(`(?:at|um|@)\\s*(\\d{1,2})(?:[:.](\\d{2}))?`, (m) => {
        const time = clockTime(m[3], m[4]);
        if (time) result.time = time;
      }) ||
      take(`(\\d{1,2})[:](\\d{2})`, (m) => {
        const time = clockTime(m[3], m[4]);
        if (time) result.time = time;
      });
  }

  const title = text.replace(/\s+/g, " ").trim();
  const cleanTitle = title || input.trim();

  if (result.exactDate)
    return {
      title: cleanTitle,
      date: formatDate(result.exactDate),
      time: `${pad(result.exactDate.getHours())}:${pad(
        result.exactDate.getMinutes()
      )}`
    };

  if (!result.date && result.time) {
    // A bare time means the next occurrence of it.
    const [hour, minute] = result.time.split(":").map(Number);
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    result.date = candidate > now ? addDays(now, 0) : addDays(now, 1);
  }

  return {
    title: cleanTitle,
    ...(result.date ? { date: formatDate(result.date) } : {}),
    ...(result.date && result.time ? { time: result.time } : {})
  };
}

function clockTime(
  hourText: string,
  minuteText?: string,
  suffix?: string
): string | undefined {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  const meridiem = suffix?.toLowerCase().replace(/\./g, "");
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  return `${pad(hour)}:${pad(minute)}`;
}
