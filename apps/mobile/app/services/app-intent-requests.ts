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

import { strings } from "@notesnook/intl";
import { db } from "../common/database";
import { MMKV } from "../common/database/mmkv";
import { taskWidgetAccountScope } from "../hooks/task-widget-completion-intents";
import { textToHTML } from "./notifications";
import { TaskNotifications } from "./task-notifications";
import Navigation from "./navigation";
import { ReminderWidget } from "./reminder-widget";
import SettingsService from "./settings";
import { useSettingStore } from "../stores/use-setting-store";
import { useUserStore } from "../stores/use-user-store";
import {
  buildTaskEntityCandidate,
  buildTaskEntityCandidates,
  decodeTaskEntityId,
  decodeTaskEntityIds,
  matchOpenTasks,
  rankOpenTasks,
  resolveTaskCompletionTarget,
  type TaskEntityCandidate,
  type TaskEntityContext
} from "./app-intent-tasks";

export type AppIntentAction =
  | "createTask"
  | "completeTask"
  | "createNote"
  | "todayTasks"
  | "suggestTasks"
  | "resolveTasks";

export type AppIntentRequest = {
  id: string;
  action: AppIntentAction;
  payload: Record<string, string>;
};

export type AppIntentReply = { status: string; value: string };

/**
 * Actions the app can answer without a mounted surface. They read or complete
 * Tasks through the same encrypted domain the Tasks screen uses, need no user
 * input and cannot raise a system permission prompt, so their intents do not
 * have to drag the person into the app to run.
 *
 * The two creating actions stay out. `createTask` can ask for notification
 * permission for a reminder or an urgent Task, and that system alert needs a
 * foreground app; both write paths keep their existing foreground behavior
 * until the headless route has been verified on hardware.
 */
export const HEADLESS_APP_INTENT_ACTIONS: ReadonlySet<string> = new Set([
  "completeTask",
  "todayTasks",
  "suggestTasks",
  "resolveTasks"
]);

const repeatRules: Record<string, string | undefined> = {
  never: undefined,
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY"
};

function localDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(value.getDate()).padStart(2, "0")}`;
}

function localTime(value: Date) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(
    value.getMinutes()
  ).padStart(2, "0")}`;
}

function failure(status: string): AppIntentReply {
  return { status, value: "" };
}

function appLockEnabled() {
  return (
    // The persisted setting is the only trustworthy source in a process that
    // has never mounted the App component.
    !!SettingsService.get().appLockEnabled ||
    !!useSettingStore.getState().settings.appLockEnabled
  );
}

/**
 * Whether this process may act on an out-of-app request at all.
 *
 * A headless intent process never mounts the App component, so `appLocked` is
 * still at its unlocked default there and cannot be trusted. `isAppLoading`
 * only becomes false once the App component has opened the database past its
 * own App Lock gate, which makes it the positive signal that the person really
 * is inside an unlocked app.
 */
export function appIntentLocked() {
  const user = useUserStore.getState();
  if (user.appLocked || user.isLoggingOut) return true;
  return appLockEnabled() && useSettingStore.getState().isAppLoading;
}

/**
 * Whether a headless process must refuse an out-of-app request outright,
 * independent of `appIntentLocked`'s `isAppLoading` signal.
 *
 * A process that was already warm before App Lock got turned on keeps
 * `isAppLoading` at its stale `false`, so `appIntentLocked` alone would let it
 * through. The persisted setting has no such staleness window, so it is
 * checked directly here rather than through `isAppLoading`. This is the same
 * rule the Task widget snapshot uses, and it now also gates the headless
 * "Complete Task" write, not just title export: a locked account must refuse
 * a completion exactly as it refuses a title, not roll it forward for the UI
 * to discover later.
 */
export function appLockBlocksHeadlessAccess() {
  const user = useUserStore.getState();
  return appLockEnabled() || user.appLocked || user.isLoggingOut;
}

/**
 * Whether Task titles may leave the app. Shortcuts output, the Siri response
 * and the parameter picker all live outside VeyraN, so App Lock withholds
 * titles even while the current UI is unlocked.
 */
function mayExportTaskTitles() {
  return !appLockBlocksHeadlessAccess();
}

/**
 * The same per-account token the Task widget uses, so one account's saved
 * Shortcut can never address another account's Task. It is an isolation token,
 * not a credential.
 */
async function currentAccountScope(): Promise<string> {
  const accountId = (await db.user.getUser())?.id || null;
  return taskWidgetAccountScope(MMKV, accountId);
}

async function taskEntityContext(): Promise<TaskEntityContext> {
  const listNames: Record<string, string> = {};
  for (const list of await db.taskLists.list()) listNames[list.id] = list.name;
  return {
    scope: await currentAccountScope(),
    today: localDate(new Date()),
    listNames,
    labels: {
      untitled: strings.untitled(),
      overdue: strings.tasksOverdue(),
      today: strings.dueToday(),
      due: (date: string) => strings.due(date),
      completed: strings.tasksCompleted()
    }
  };
}

export async function executeAppIntentRequest(
  request: AppIntentRequest
): Promise<AppIntentReply> {
  if (
    HEADLESS_APP_INTENT_ACTIONS.has(request.action) &&
    appLockBlocksHeadlessAccess()
  )
    return failure("locked");
  if (appIntentLocked()) return failure("locked");
  if (!db.isInitialized) return failure("unavailable");

  try {
    const payload = request.payload;
    switch (request.action) {
      case "createTask": {
        const title = payload.title?.trim();
        if (!title) return failure("invalid");
        let listId = (await db.taskLists.default()).id;
        if (payload.listName?.trim()) {
          const matches = (await db.taskLists.list()).filter(
            (list) =>
              list.name.toLocaleLowerCase() ===
              payload.listName.trim().toLocaleLowerCase()
          );
          if (!matches.length) return failure("notFound");
          if (matches.length !== 1) return failure("ambiguous");
          listId = matches[0].id;
        }
        const priority = payload.priority || "none";
        if (!["none", "low", "medium", "high"].includes(priority))
          return failure("invalid");
        const repeatMode = payload.repeatMode || "never";
        if (!(repeatMode in repeatRules)) return failure("invalid");
        const reminderInput = payload.reminderTimestamp?.trim();
        if (payload.reminderTimestamp !== undefined && !reminderInput)
          return failure("invalid");
        const reminderTimestamp = reminderInput
          ? Number(reminderInput)
          : undefined;
        if (
          reminderTimestamp !== undefined &&
          (!Number.isFinite(reminderTimestamp) ||
            Number.isNaN(new Date(reminderTimestamp).getTime()))
        )
          return failure("invalid");
        const reminder =
          reminderTimestamp === undefined
            ? undefined
            : new Date(reminderTimestamp);
        if (repeatMode !== "never" && !reminder) return failure("invalid");
        const urgent = payload.urgent === "true";
        if (urgent && !reminder) return failure("invalid");
        if (urgent) {
          const status = await TaskNotifications.urgentStatus();
          const authorized =
            status === "authorized"
              ? status
              : await TaskNotifications.requestUrgentPermission();
          if (authorized !== "authorized") return failure("unavailable");
        } else if (reminder) {
          const authorized = await TaskNotifications.requestPermission().catch(
            () => false
          );
          if (!authorized) return failure("unavailable");
        }
        const task = await db.tasks.create({
          title,
          listId,
          reminderDate: reminder ? localDate(reminder) : undefined,
          reminderTime: reminder ? localTime(reminder) : undefined,
          recurrenceRule: repeatRules[repeatMode],
          priority: priority as "none" | "low" | "medium" | "high",
          flagged: payload.flagged === "true",
          urgent
        });
        return { status: "ok", value: task.id };
      }
      case "suggestTasks": {
        if (!mayExportTaskTitles()) return failure("locked");
        const context = await taskEntityContext();
        const tasks = await db.tasks.list();
        const query = payload.query?.trim();
        return {
          status: "ok",
          value: JSON.stringify(
            buildTaskEntityCandidates(
              query
                ? matchOpenTasks(tasks, query, context.today)
                : rankOpenTasks(tasks, context.today),
              context
            )
          )
        };
      }
      case "resolveTasks": {
        if (!mayExportTaskTitles()) return failure("locked");
        const context = await taskEntityContext();
        const ids = decodeTaskEntityIds(payload.ids, context.scope);
        if (!ids) return failure("invalid");
        const tasks = await db.tasks.list();
        const byId = new Map(tasks.map((task) => [task.id, task] as const));
        const candidates: TaskEntityCandidate[] = [];
        for (const id of ids) {
          const task = byId.get(id);
          if (!task) continue;
          // A saved parameter keeps the identifier Shortcuts stored, and it is
          // displayed as exactly the record that id addresses. Completion
          // binds strictly to this occurrence, so a completed one is labeled
          // completed here rather than shown as whichever occurrence of the
          // series is still open, which "Complete Task" would refuse anyway.
          candidates.push(
            buildTaskEntityCandidate(
              // The entity id is rebuilt from the same scope it was decoded
              // with, so it is exactly the identifier that was requested.
              `${context.scope}:${id}`,
              task,
              context
            )
          );
        }
        return { status: "ok", value: JSON.stringify(candidates) };
      }
      case "completeTask": {
        // Recheck before even resolving an account scope or reading the Task.
        // A warm process can have stale UI lock state while persisted App Lock
        // is already enabled.
        if (appLockBlocksHeadlessAccess()) return failure("locked");
        const taskId = decodeTaskEntityId(
          payload.entityId,
          await currentAccountScope()
        );
        // A Shortcut saved under another account, or a hand-edited parameter,
        // names nothing here.
        if (!taskId) return failure("notFound");
        const picked = await db.tasks.get(taskId);
        if (!picked) return failure("notFound");
        const target = resolveTaskCompletionTarget(picked);
        if (target.kind === "alreadyCompleted")
          return failure("alreadyCompleted");
        // App Lock may have been turned on while the domain was being read,
        // or this warm process may have been locked all along without
        // `isAppLoading` ever having observed it.
        if (appLockBlocksHeadlessAccess()) return failure("locked");
        // The same encrypted-domain operation as the Tasks screen. Core
        // completion is idempotent and is what advances a recurring series.
        await db.tasks.complete(target.id);
        // The Task is persisted. A widget snapshot that cannot be refreshed is
        // a stale derived cache, not a failed completion, so it must not make
        // Shortcuts report a failure and invite a second completion.
        try {
          ReminderWidget.update();
          await ReminderWidget.waitForUpdate();
        } catch {
          // Keep the persisted completion as the acknowledged result.
        }
        return { status: "ok", value: target.id };
      }
      case "createNote": {
        const title = payload.title?.trim();
        const content = payload.content?.trim();
        if (!title && !content) return failure("invalid");
        const id = await db.notes.add({
          ...(title ? { title } : {}),
          ...(content
            ? {
                content: { type: "tiptap" as const, data: textToHTML(content) }
              }
            : {})
        });
        // The Note is already saved. A failed optional default association
        // must not make Shortcuts report a failed save and invite a duplicate.
        try {
          const defaultNotebook = db.settings.getDefaultNotebook();
          if (defaultNotebook)
            await db.notes.addToNotebook(defaultNotebook, id);
          const defaultTag = db.settings.getDefaultTag();
          if (defaultTag) {
            const tag = await db.tags.tag(defaultTag);
            const note = await db.notes.note(id);
            if (tag && note) await db.relations.add(tag, note);
          }
        } catch {
          // Keep the successful Note creation as the acknowledged result.
        }
        Navigation.queueRoutesForUpdate("Notes");
        return { status: "ok", value: id };
      }
      case "todayTasks": {
        // Shortcut output lives outside the app. App Lock therefore blocks
        // exporting Task titles even when the current UI was just unlocked.
        if (!mayExportTaskTitles()) return failure("locked");
        const titles = (await db.tasks.smartList("today"))
          .slice(0, 50)
          .map((task) => task.title);
        return { status: "ok", value: JSON.stringify(titles) };
      }
      default:
        return failure("invalid");
    }
  } catch {
    return failure("failed");
  }
}
