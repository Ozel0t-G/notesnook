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

export const REMINDER_WIDGET_URLS = {
  list: "ShareMedia://TasksWidget",
  create: "ShareMedia://NewTaskWidget",
  task: (id: string) =>
    `ShareMedia://TaskWidget?id=${encodeURIComponent(id)}`,
  reminder: (id: string) =>
    `ShareMedia://TaskWidget?id=${encodeURIComponent(id)}`,
  complete: (id: string) =>
    `ShareMedia://CompleteTaskWidget?id=${encodeURIComponent(id)}`
} as const;

export type ReminderWidgetLink =
  | { action: "list" }
  | { action: "create" }
  | { action: "task"; id: string }
  | { action: "complete"; id: string };

/** Parses only the private, explicit URLs emitted by the iOS widget. */
export function parseReminderWidgetLink(
  value: string | null | undefined
): ReminderWidgetLink | undefined {
  if (!value) return;

  const normalized = value.replace(/\/+$/, "");
  if (
    normalized.toLowerCase() === REMINDER_WIDGET_URLS.list.toLowerCase() ||
    normalized.toLowerCase() === "sharemedia://reminderswidget"
  ) {
    return { action: "list" };
  }
  if (
    normalized.toLowerCase() === REMINDER_WIDGET_URLS.create.toLowerCase() ||
    normalized.toLowerCase() === "sharemedia://newreminderwidget"
  ) {
    return { action: "create" };
  }

  try {
    const url = new URL(value);
    if (
      url.protocol.toLowerCase() !== "sharemedia:" ||
      !["taskwidget", "completetaskwidget", "reminderwidget"].includes(
        url.hostname.toLowerCase()
      )
    ) {
      return;
    }
    const id = url.searchParams.get("id")?.trim();
    if (!id || !/^(?:[a-f0-9]{24}|[a-f0-9]{32})$/i.test(id)) return;
    return url.hostname.toLowerCase() === "completetaskwidget"
      ? { action: "complete", id }
      : { action: "task", id };
  } catch {
    return;
  }
}
