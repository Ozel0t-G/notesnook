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
  // The one explicit way to open a Task's schedule for editing. It is a
  // deliberate, separate action -- a plain card tap never lands here -- so a
  // reschedule intent can never be confused with "open the Task". It uses this
  // app's own scheme: the shared ShareMedia scheme may be routed to the
  // upstream Notesnook app instead.
  reschedule: (id: string) =>
    `veyran://task/${encodeURIComponent(id)}?action=reschedule`,
  complete: (id: string) =>
    `ShareMedia://CompleteTaskWidget?id=${encodeURIComponent(id)}`
} as const;

/**
 * The identity a widget link may carry alongside a Task id. Every field is
 * optional: an old widget emits only the id, and the router then resolves it
 * accountlessly. A link that *does* carry one is validated strictly, so a
 * malformed revision/scope cannot be silently ignored and read as "no claim".
 */
export type ReminderWidgetLinkIdentity = {
  /** The account scope token the emitting widget snapshot was built with. */
  scope?: string;
  /** The Task revision the link was produced from. */
  updatedAt?: number;
  /** The specific recurring occurrence the link was produced for. */
  occurrenceKey?: string;
  /**
   * The recurring series the occurrence belongs to. Carried so a link can be
   * answered by the exact occurrence's own record instead of whichever record
   * the series is on now; it names no content, only the series identity the
   * Task domain already stores.
   */
  seriesId?: string;
};

export type ReminderWidgetLink =
  | { action: "list" }
  | { action: "create" }
  | ({ action: "task"; id: string } & ReminderWidgetLinkIdentity)
  | ({ action: "reschedule"; id: string } & ReminderWidgetLinkIdentity)
  | ({ action: "complete"; id: string } & ReminderWidgetLinkIdentity);

const TASK_ID = /^(?:[a-f0-9]{24}|[a-f0-9]{32})$/i;
const SCOPE = /^[a-f0-9]{32}$/;
// The occurrence key is the core wall-time key (`YYYY-MM-DDTHH:MM` or
// `YYYY-MM-DDTdate`). Bound the length and the alphabet so nothing else can be
// smuggled through a URL.
const OCCURRENCE_KEY = /^[0-9A-Za-z:+-]{1,64}$/;
// The recurring series id is the same bounded, opaque token the Task domain
// stores and the native identity store validates (`^[0-9A-Za-z:_-]{1,64}$`).
const SERIES_ID = /^[0-9A-Za-z:_-]{1,64}$/;

/** True when any query parameter is repeated. */
function hasDuplicateParameters(url: URL): boolean {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * Reads the optional identity params of a widget URL. Returns `{ ok: false }`
 * when any present value is malformed (the whole link is then rejected), and an
 * empty identity when none are present (an accountless, revision-less link).
 *
 * A parameter that is *present* is validated strictly. An empty present value
 * (`scope=`) is not "no claim": it is a malformed claim and rejects the link,
 * so a producer can never smuggle a blank where a token is required.
 */
function readIdentity(url: URL):
  | (ReminderWidgetLinkIdentity & { ok: true })
  | { ok: false } {
  const identity: ReminderWidgetLinkIdentity = {};
  const scope = url.searchParams.get("scope");
  if (scope !== null) {
    if (!SCOPE.test(scope)) return { ok: false };
    identity.scope = scope;
  }
  const updatedAt = url.searchParams.get("updatedAt");
  if (updatedAt !== null) {
    const value = Number(updatedAt);
    if (!Number.isSafeInteger(value) || value <= 0) return { ok: false };
    identity.updatedAt = value;
  }
  const occurrenceKey = url.searchParams.get("occurrenceKey");
  if (occurrenceKey !== null) {
    if (!OCCURRENCE_KEY.test(occurrenceKey)) return { ok: false };
    identity.occurrenceKey = occurrenceKey;
  }
  const seriesId = url.searchParams.get("seriesId");
  if (seriesId !== null) {
    if (!SERIES_ID.test(seriesId)) return { ok: false };
    identity.seriesId = seriesId;
  }
  return { ok: true, ...identity };
}

/** Parses only the private, explicit URLs emitted by the iOS widget. */
export function parseReminderWidgetLink(
  value: string | null | undefined
): ReminderWidgetLink | undefined {
  if (!value) return;

  const normalized = value.replace(/\/+$/, "");
  if (
    normalized.toLowerCase() === REMINDER_WIDGET_URLS.list.toLowerCase() ||
    normalized.toLowerCase() === "sharemedia://reminderswidget" ||
    normalized.toLowerCase() === "veyran://tasks"
  ) {
    return { action: "list" };
  }
  if (
    normalized.toLowerCase() === REMINDER_WIDGET_URLS.create.toLowerCase() ||
    normalized.toLowerCase() === "sharemedia://newreminderwidget" ||
    normalized.toLowerCase() === "veyran://task/new"
  ) {
    return { action: "create" };
  }

  try {
    const url = new URL(value);
    if (url.protocol.toLowerCase() === "veyran:") {
      if (url.hostname.toLowerCase() !== "task" || url.hash) return;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 1 || !TASK_ID.test(parts[0])) return;
      if (hasDuplicateParameters(url)) return;
      const identity = readIdentity(url);
      if (!identity.ok) return;
      // The general card tap is explicitly an "open" and the schedule link is
      // explicitly a "reschedule". Any other action is a different,
      // separately parsed link and is refused here rather than silently
      // resolved to an open.
      const action = url.searchParams.get("action");
      if (action !== null && action !== "open" && action !== "reschedule") {
        return;
      }
      const { ok: _ok, ...identityValues } = identity;
      if (action === "reschedule") {
        return { action: "reschedule", id: parts[0], ...identityValues };
      }
      return { action: "task", id: parts[0], ...identityValues };
    }
    if (url.protocol.toLowerCase() !== "sharemedia:") return;
    // Only the host name and its query parameters are meaningful. An extra path
    // segment (`ShareMedia://TaskWidget/extra`), a fragment (`#...`) or a
    // duplicated parameter is a different URL than the one the widget emits, so
    // it is refused instead of silently resolved to a Task.
    if (url.hash) return;
    if (url.pathname !== "" && url.pathname !== "/") return;
    if (hasDuplicateParameters(url)) return;
    const hostname = url.hostname.toLowerCase();
    if (
      ![
        "taskwidget",
        "completetaskwidget",
        "reminderwidget",
        "rescheduletaskwidget"
      ].includes(hostname)
    ) {
      return;
    }
    const id = url.searchParams.get("id")?.trim();
    if (!id || !TASK_ID.test(id)) return;
    const identity = readIdentity(url);
    if (!identity.ok) return;
    const { ok: _ok, ...identityValues } = identity;
    if (hostname === "completetaskwidget")
      return { action: "complete", id, ...identityValues };
    if (hostname === "rescheduletaskwidget")
      return { action: "reschedule", id, ...identityValues };
    return { action: "task", id, ...identityValues };
  } catch {
    return;
  }
}
