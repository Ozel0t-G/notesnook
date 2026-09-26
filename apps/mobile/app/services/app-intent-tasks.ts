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

import { taskReminderSchedule, type Task } from "@notesnook/core";

/**
 * The Shortcuts "Complete Task" action selects a real Task through an
 * `AppEntity` picker instead of matching a title string. Everything the picker
 * needs is derived here from the encrypted Task domain: this module holds no
 * Task copy of its own, and the identifiers it produces are only addresses for
 * records that already exist.
 *
 * An `AppEntity` round trip preserves nothing but the identifier, so the
 * account a Task belongs to has to be part of that identifier rather than a
 * property of the entity.
 */

const SCOPE = /^[0-9a-f]{32}$/i;
const TASK_ID = /^(?:[0-9a-f]{24}|[0-9a-f]{32})$/i;

/** The picker and the Shortcuts string search are both bounded lists. */
export const MAX_TASK_ENTITY_RESULTS = 50;
/** Shortcuts resolves a saved parameter; it never needs a whole library. */
export const MAX_TASK_ENTITY_IDS = 50;
const MAX_ENTITY_TEXT = 120;

export type TaskEntityCandidate = {
  id: string;
  title: string;
  subtitle: string;
};

export type TaskEntityLabels = {
  untitled: string;
  overdue: string;
  today: string;
  due: (date: string) => string;
};

/** `<account scope>:<Task id>`. */
export function encodeTaskEntityId(
  scope: string,
  taskId: string
): string | undefined {
  if (!SCOPE.test(scope) || !TASK_ID.test(taskId)) return undefined;
  return `${scope}:${taskId}`;
}

/**
 * Returns the Task id only when the identifier was issued for the account that
 * is signed in now. Migrated and recurring Task ids are derived, so a Shortcut
 * saved by another account is refused explicitly rather than being allowed to
 * depend on an id not existing in this database.
 */
export function decodeTaskEntityId(
  value: unknown,
  scope: string
): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(":");
  if (parts.length !== 2) return undefined;
  const [entityScope, taskId] = parts;
  if (!SCOPE.test(entityScope) || !TASK_ID.test(taskId)) return undefined;
  if (entityScope.toLowerCase() !== scope.toLowerCase()) return undefined;
  return taskId;
}

export function decodeTaskEntityIds(
  value: unknown,
  scope: string
): string[] | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_TASK_ENTITY_IDS)
    return undefined;
  const ids: string[] = [];
  for (const entry of parsed) {
    const id = decodeTaskEntityId(entry, scope);
    // A single foreign or malformed identifier must not silently drop the
    // whole resolution, but it must not resolve either.
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function scheduleOf(task: Task) {
  const schedule = taskReminderSchedule(task);
  return { date: schedule.date, time: schedule.time };
}

function compareSchedules(a: Task, b: Task) {
  const first = scheduleOf(a);
  const second = scheduleOf(b);
  return (
    (first.date || "9999-12-31").localeCompare(second.date || "9999-12-31") ||
    (first.time || "").localeCompare(second.time || "") ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Suggestion order for the picker: what is due now, then what is coming, then
 * everything else with flagged Tasks first. Deterministic, so the list the
 * user sees does not depend on storage order.
 */
export function rankOpenTasks(tasks: Task[], today: string): Task[] {
  const open = tasks.filter((task) => !task.completed);
  const due: Task[] = [];
  const upcoming: Task[] = [];
  const unscheduled: Task[] = [];
  for (const task of open) {
    const date = scheduleOf(task).date;
    if (!date) unscheduled.push(task);
    else if (date <= today) due.push(task);
    else upcoming.push(task);
  }
  return [
    ...due.sort(compareSchedules),
    ...upcoming.sort(compareSchedules),
    ...unscheduled.sort(
      (a, b) =>
        Number(b.flagged) - Number(a.flagged) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id)
    )
  ];
}

/** Shortcuts and Siri search this list by the text the user typed or said. */
export function matchOpenTasks(
  tasks: Task[],
  query: string,
  today: string
): Task[] {
  const needle = query.trim().toLocaleLowerCase();
  const ranked = rankOpenTasks(tasks, today);
  if (!needle) return ranked;
  return ranked
    .map((task, order) => {
      const title = task.title.toLocaleLowerCase();
      const weight =
        title === needle
          ? 0
          : title.startsWith(needle)
            ? 1
            : title.includes(needle)
              ? 2
              : 3;
      return { task, order, weight };
    })
    .filter((entry) => entry.weight < 3)
    .sort((a, b) => a.weight - b.weight || a.order - b.order)
    .map((entry) => entry.task);
}

/** Picker rows are one line of text, and they come from user content. */
function sanitizeEntityText(value: string) {
  let normalized = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    normalized += code < 0x20 || code === 0x7f ? " " : value[index];
  }
  // Collapses those replacements together with every other kind of whitespace,
  // including the line and paragraph separators.
  return normalized.replace(/\s+/g, " ").trim().slice(0, MAX_ENTITY_TEXT);
}

function formatWallDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(year, (month || 1) - 1, day || 1);
  return Number.isNaN(value.getTime()) ? date : value.toLocaleDateString();
}

/**
 * The picker subtitle is what actually resolves the duplicate-title problem
 * for the person choosing: two Tasks called "Call Alex" are told apart by
 * their List and their schedule.
 */
export function taskEntitySubtitle(
  task: Task,
  listName: string | undefined,
  today: string,
  labels: TaskEntityLabels
): string {
  const parts: string[] = [];
  if (listName) parts.push(sanitizeEntityText(listName));
  const { date, time } = scheduleOf(task);
  if (date) {
    const when =
      date < today
        ? labels.overdue
        : date === today
          ? labels.today
          : labels.due(formatWallDate(date));
    parts.push(time ? `${when} ${time}` : when);
  }
  return parts.filter(Boolean).join(" · ");
}

export type TaskEntityContext = {
  scope: string;
  today: string;
  listNames: Record<string, string>;
  labels: TaskEntityLabels;
};

/**
 * `id` is passed separately because resolving a saved parameter has to keep the
 * identifier Shortcuts already stored, even when the record it describes best
 * is a later occurrence of the same recurring series.
 */
export function buildTaskEntityCandidate(
  id: string,
  task: Task,
  context: TaskEntityContext
): TaskEntityCandidate {
  return {
    id,
    title: sanitizeEntityText(task.title) || context.labels.untitled,
    subtitle: taskEntitySubtitle(
      task,
      context.listNames[task.listId],
      context.today,
      context.labels
    )
  };
}

export function buildTaskEntityCandidates(
  tasks: Task[],
  context: TaskEntityContext,
  limit = MAX_TASK_ENTITY_RESULTS
): TaskEntityCandidate[] {
  const candidates: TaskEntityCandidate[] = [];
  for (const task of tasks) {
    if (candidates.length >= limit) break;
    const id = encodeTaskEntityId(context.scope, task.id);
    // A Task id the picker cannot address is left out rather than guessed at.
    if (!id) continue;
    candidates.push(buildTaskEntityCandidate(id, task, context));
  }
  return candidates;
}

export type TaskCompletionTarget =
  | { kind: "complete"; id: string }
  | { kind: "alreadyCompleted" };

/**
 * A recurring Task gives every occurrence its own id, so the occurrence a
 * saved Shortcut points at stops being the open one as soon as it is
 * completed. Falling back to the open occurrence of the same series keeps that
 * Shortcut meaningful next week without storing a second identity anywhere;
 * the completion itself still goes through `db.tasks.complete`, which is what
 * advances the series.
 */
export function resolveTaskCompletionTarget(
  picked: Task,
  tasks: Task[]
): TaskCompletionTarget {
  if (!picked.completed) return { kind: "complete", id: picked.id };
  const series = picked.seriesId || picked.id;
  const open = tasks
    .filter((task) => !task.completed && (task.seriesId || task.id) === series)
    .sort(compareSchedules);
  return open.length
    ? { kind: "complete", id: open[0].id }
    : { kind: "alreadyCompleted" };
}
