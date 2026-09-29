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

import { db } from "../common/database";
import { isValidTaskWidgetId } from "../hooks/task-widget-completion-intents";
import { useSettingStore } from "../stores/use-setting-store";
import { useUserStore } from "../stores/use-user-store";
import { ToastManager } from "./event-manager";
import Navigation from "./navigation";

/**
 * A deliberately generic, non-identifying notice shown when an out-of-app tap
 * named a Task this account does not (or no longer does) have. It never carries
 * a title, a List name or an account, so a wrong-account or stale payload cannot
 * leak what it addressed.
 *
 * It is intentionally a literal rather than a `@notesnook/intl` string: the Task
 * strings package sits outside this bounded change's allowed paths.
 */
export const TASK_UNAVAILABLE_MESSAGE = "This Task is no longer available.";

const MAX_PENDING_INTENTS = 4;

/**
 * Where an "open this Task" request came from. Recorded (not trusted) so the
 * accountless-payload policy below stays explicit and testable.
 */
export type TaskNavigationSource =
  | "notification"
  | "cold-initial-notification"
  | "widget"
  | "legacy-link"
  | "explicit";

/**
 * The minimal, non-content identity of a Task to open.
 *
 * It deliberately carries no title, no List ID and no other Task content, so a
 * queued (cold/locked) or rejected intent can never disclose what it addressed.
 * `accountId` is the account the producing surface belonged to when the producer
 * knew it; `undefined`/`null` is a legacy/accountless payload.
 */
export type TaskNavigationIntent = {
  taskId: string;
  accountId?: string | null;
  occurrenceKey?: string;
  source?: TaskNavigationSource;
};

export type TaskNavigationReadiness = {
  databaseReady: boolean;
  appLoading: boolean;
  appLocked: boolean;
  loggingOut: boolean;
};

/**
 * Whether the encrypted Task domain may be read at all right now. It reads the
 * same live store/bootstrap signals the widget completion queue uses
 * (`db.isInitialized`, `isAppLoading`, `appLocked`, `isLoggingOut`) -- no new or
 * unrelated readiness flag is invented.
 */
export function taskNavigationReadiness(): TaskNavigationReadiness {
  return {
    databaseReady: db.isInitialized,
    appLoading: useSettingStore.getState().isAppLoading,
    appLocked: useUserStore.getState().appLocked,
    loggingOut: useUserStore.getState().isLoggingOut
  };
}

export function canRouteTaskNavigation(
  state: TaskNavigationReadiness = taskNavigationReadiness()
) {
  return (
    state.databaseReady &&
    !state.appLoading &&
    !state.appLocked &&
    !state.loggingOut
  );
}

export type TaskIntentAccountDecision = "match" | "mismatch" | "accountless";

/**
 * Account policy:
 *
 * - `accountless` -- a legacy/accountless payload (old widget deep links, the
 *   legacy reminder-migration link, and any producer that did not know the
 *   account). It is resolved against the CURRENT account's data only, and can
 *   never address another account, because no other account is ever opened.
 * - `match` -- the payload named the signed-in account.
 * - `mismatch` -- the payload named a different account (or one that cannot be
 *   confirmed). Rejected without touching Task data.
 */
export function decideTaskIntentAccount(
  intentAccountId: string | null | undefined,
  currentAccountId: string | null
): TaskIntentAccountDecision {
  if (intentAccountId === undefined || intentAccountId === null)
    return "accountless";
  return intentAccountId === currentAccountId ? "match" : "mismatch";
}

export type TaskNavigationTarget =
  | { kind: "list"; taskId: string; listId: string }
  | { kind: "completed"; taskId: string; listId?: string }
  | { kind: "stale"; taskId: string }
  | { kind: "missing"; taskId: string };

type NavigableTask = {
  id: string;
  listId: string;
  completed?: boolean;
  occurrenceKey?: string;
};

/**
 * Resolves where a Task should open, purely from the freshly read record.
 *
 * - The Task's CURRENT canonical `listId` is used, never a stale List ID from
 *   the payload, so a moved Task opens its current List.
 * - A completed Task stays visible in its own List when that List still exists
 *   (`includeCompleted`), so its real context is shown without resurrecting it;
 *   otherwise it opens the Completed smart list.
 * - Occurrence identity is only compared when BOTH the payload and the record
 *   knew one. A payload that names a different occurrence than the record now
 *   stored is `stale`: the current occurrence is never treated as the tapped one.
 * - A record that no longer exists is `missing`.
 */
export function resolveTaskNavigationTarget(
  task: NavigableTask | undefined,
  intent: Pick<TaskNavigationIntent, "taskId" | "occurrenceKey">,
  listExists: (listId: string) => boolean
): TaskNavigationTarget {
  if (!task) return { kind: "missing", taskId: intent.taskId };
  if (
    intent.occurrenceKey &&
    task.occurrenceKey &&
    intent.occurrenceKey !== task.occurrenceKey
  )
    return { kind: "stale", taskId: intent.taskId };
  if (task.completed) {
    const canonicalListId =
      task.listId && listExists(task.listId) ? task.listId : undefined;
    return canonicalListId
      ? { kind: "completed", taskId: intent.taskId, listId: canonicalListId }
      : { kind: "completed", taskId: intent.taskId };
  }
  return {
    kind: "list",
    taskId: intent.taskId,
    listId: task.listId
  };
}

/** A unique, monotonically increasing nonce for one focus request. */
let focusRequestCounter = 0;
export function nextTaskFocusRequestId(now = Date.now()) {
  focusRequestCounter += 1;
  return `${now}.${focusRequestCounter}`;
}

/** Guards async ordering: only the most recently accepted request may route. */
let navigationGeneration = 0;

const pendingIntents: TaskNavigationIntent[] = [];

/**
 * Reads the account/occurrence identity a Task notification producer attached
 * to a tap payload. An empty string means "not known" (accountless/legacy), so
 * it is normalized to `undefined` and resolved against the current account.
 */
export function taskNotificationIntent(
  data: Record<string, unknown> | undefined,
  source: TaskNavigationSource
): TaskNavigationIntent | undefined {
  const taskId = data?.taskId;
  if (typeof taskId !== "string") return undefined;
  const accountId =
    typeof data?.accountId === "string" && data.accountId
      ? data.accountId
      : undefined;
  const occurrenceKey =
    typeof data?.occurrenceKey === "string" && data.occurrenceKey
      ? data.occurrenceKey
      : undefined;
  return { taskId, accountId, occurrenceKey, source };
}

function normalizeIntent(
  intent: TaskNavigationIntent | string
): TaskNavigationIntent | undefined {
  const value: TaskNavigationIntent =
    typeof intent === "string"
      ? { taskId: intent, source: "explicit" }
      : intent;
  // Widget URLs, deep links and notification payloads are untrusted input. An
  // id that cannot be a Task id names nothing here.
  if (!isValidTaskWidgetId(value.taskId)) return undefined;
  return value;
}

function notifyTaskUnavailable() {
  ToastManager.show({
    message: TASK_UNAVAILABLE_MESSAGE,
    type: "info"
  });
}

function presentTaskNavigationTarget(target: TaskNavigationTarget) {
  switch (target.kind) {
    case "list":
      Navigation.navigate("Tasks", {
        listId: target.listId,
        focusTaskId: target.taskId,
        focusRequestId: nextTaskFocusRequestId()
      });
      return;
    case "completed":
      Navigation.navigate(
        "Tasks",
        target.listId
          ? {
              listId: target.listId,
              includeCompleted: true,
              focusTaskId: target.taskId,
              focusRequestId: nextTaskFocusRequestId()
            }
          : {
              smartList: "completed",
              focusTaskId: target.taskId,
              focusRequestId: nextTaskFocusRequestId()
            }
      );
      return;
    case "stale":
    case "missing":
      // The Task is gone or the payload addressed a different occurrence. Land
      // on a safe Tasks destination and say only that it is unavailable.
      notifyTaskUnavailable();
      Navigation.navigate("Tasks");
      return;
  }
}

/**
 * Opens the Task named by `intent` in its CURRENT canonical List, scrolled into
 * view and briefly highlighted -- never the editor, never the keyboard.
 *
 * Safety rules:
 * - The protected domain is not read until auth/App Lock/domain hydration is
 *   ready; a cold or locked tap queues the minimal intent instead.
 * - A payload that names a different account than the signed-in one is rejected
 *   BEFORE any Task lookup, so no other account's content is ever read or shown.
 * - Only the most recently accepted request routes (last tap wins).
 * - The router never completes, edits or reopens a Task, so a stale recurring
 *   occurrence can never be applied to the following one.
 *
 * A bare `string` is accepted for compatibility and treated as an explicit open.
 */
export async function openTaskInContext(
  intent: TaskNavigationIntent | string
): Promise<void> {
  const normalized = normalizeIntent(intent);
  if (!normalized) return;
  if (!canRouteTaskNavigation()) {
    queuePendingTaskNavigation(normalized);
    return;
  }
  const generation = ++navigationGeneration;
  try {
    let currentAccountId: string | null = null;
    if (
      normalized.accountId !== undefined &&
      normalized.accountId !== null
    ) {
      // Only read the account (a protected-domain value) when the payload
      // actually claims one; accountless payloads resolve against whichever
      // account is signed in without a second read.
      currentAccountId = (await db.user.getUser())?.id || null;
      if (generation !== navigationGeneration) return;
      if (
        decideTaskIntentAccount(normalized.accountId, currentAccountId) ===
        "mismatch"
      ) {
        // Wrong account: reject before any Task lookup or navigation. Nothing
        // about the other account (or whether the id exists) is revealed.
        return;
      }
    }
    const task = await db.tasks.get(normalized.taskId);
    if (generation !== navigationGeneration) return;
    presentTaskNavigationTarget(
      resolveTaskNavigationTarget(task, normalized, (listId) =>
        !!db.taskLists.getSync(listId)
      )
    );
  } catch {
    // A failed domain read is never an instruction to open stale content.
  }
}

function queuePendingTaskNavigation(intent: TaskNavigationIntent) {
  const existingIndex = pendingIntents.findIndex(
    (entry) => entry.taskId === intent.taskId
  );
  if (existingIndex !== -1) pendingIntents.splice(existingIndex, 1);
  pendingIntents.push(intent);
  while (pendingIntents.length > MAX_PENDING_INTENTS) pendingIntents.shift();
}

/** A copy of the queued minimal intents, for diagnostics and tests. */
export function pendingTaskNavigation(): readonly TaskNavigationIntent[] {
  return [...pendingIntents];
}

/** Clears the queue on logout or account change. */
export function clearPendingTaskNavigation() {
  pendingIntents.length = 0;
}

/**
 * Consumes the queued intent once, after auth/App Lock/domain readiness. Call
 * from the same unlock/ready signal that replays the widget completion queue.
 */
export async function consumePendingTaskNavigation(): Promise<void> {
  if (!canRouteTaskNavigation()) return;
  const queued = pendingIntents.splice(0, pendingIntents.length);
  const last = queued[queued.length - 1];
  if (last) await openTaskInContext(last);
}
