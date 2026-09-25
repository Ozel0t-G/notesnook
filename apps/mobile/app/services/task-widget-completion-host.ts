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

import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import { DatabaseLogger, db, initializeDatabaseOnce } from "../common/database";
import { isValidTaskWidgetId } from "../hooks/task-widget-completion-intents";
import {
  ReminderWidget,
  type TaskWidgetCompletionOutcome
} from "./reminder-widget";
import SettingsService from "./settings";

/**
 * On iOS 27 the Task widget's completion App Intent runs in the main app
 * process in the background, which may be a cold start with no scene, no App
 * component and no editor. This module is the JavaScript end of that: it is
 * started from index.js at the top level, so the intent is answered by the same
 * encrypted Task domain the Tasks screen writes, without any UI being mounted.
 *
 * Every reply is definitive. The native side only hears back once the action is
 * either persisted, projected into the App Group snapshot and acknowledged, or
 * left queued for a later retry, so a failure can never be shown as a
 * completion.
 */

export type TaskWidgetCompletionRequest = {
  requestId: string;
  taskId: string;
  scope: string;
  updatedAt: number;
  filename: string;
};

type NativeCompletionBridge = {
  pendingRequests(): Promise<unknown[]>;
  resolveRequest(requestId: string, outcome: string): Promise<void>;
};

const Native: NativeCompletionBridge | undefined =
  Platform.OS === "ios" ? NativeModules.TaskWidgetCompletionModule : undefined;

// The request crosses a process-internal bridge, but it still describes a
// mutation of user data, so it is checked as strictly as the durable queue file.
export function isTaskWidgetCompletionRequest(
  value: unknown
): value is TaskWidgetCompletionRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    request.requestId.length <= 64 &&
    isValidTaskWidgetId(request.taskId) &&
    typeof request.scope === "string" &&
    /^[0-9a-f]{32}$/.test(request.scope) &&
    typeof request.updatedAt === "number" &&
    Number.isSafeInteger(request.updatedAt) &&
    request.updatedAt > 0 &&
    typeof request.filename === "string" &&
    /^[0-9a-f]{64}\.json$/.test(request.filename)
  );
}

export async function runTaskWidgetCompletion(
  request: TaskWidgetCompletionRequest
): Promise<TaskWidgetCompletionOutcome> {
  // App Lock has to be read from persisted settings and before the database is
  // opened. Nothing has mounted the App component in this process, so the
  // in-memory lock flag is still at its unlocked default and would wave a
  // locked account's Tasks through.
  if (SettingsService.get().appLockEnabled) return "locked";
  try {
    // db.init is broad but editor-free, and it is what loads the collections
    // and the recurrence maintenance this action depends on. Creating a
    // database key is refused here: an unreadable Keychain (a device that has
    // not been unlocked since boot) must fail the action rather than open a new
    // empty database over the user's Tasks.
    await initializeDatabaseOnce(undefined, { createDatabaseKey: false });
  } catch (error) {
    DatabaseLogger.error(error as Error, "TaskWidgetCompletion.database");
    return "unavailable";
  }
  // A database waiting on a migration cannot be written to. The action stays
  // queued for the next launch, which is where the migration runs.
  if (db.migrations.required()) return "unavailable";
  // Opening the database can take seconds; App Lock may have been turned on in
  // the foreground meanwhile.
  if (SettingsService.get().appLockEnabled) return "locked";
  return ReminderWidget.commitCompletion({
    filename: request.filename,
    id: request.taskId
  });
}

let draining = false;
let drainAgain = false;

async function drain(native: NativeCompletionBridge) {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      const requests = await native.pendingRequests();
      for (const raw of requests) {
        const requestId = (raw as TaskWidgetCompletionRequest | null)
          ?.requestId;
        if (!isTaskWidgetCompletionRequest(raw)) {
          DatabaseLogger.error(
            new Error("Malformed Task widget completion request"),
            "TaskWidgetCompletion.drain"
          );
          if (typeof requestId === "string" && requestId.length <= 64)
            await native.resolveRequest(requestId, "stale");
          continue;
        }
        let outcome: TaskWidgetCompletionOutcome = "failed";
        try {
          outcome = await runTaskWidgetCompletion(raw);
        } catch (error) {
          // An unexpected throw leaves the durable action queued, so reporting
          // a failure is both honest and recoverable.
          DatabaseLogger.error(error as Error, "TaskWidgetCompletion.run");
        }
        await native.resolveRequest(raw.requestId, outcome);
      }
    } while (drainAgain);
  } finally {
    draining = false;
  }
}

function start() {
  if (!Native) return () => {};
  const requestDrain = () =>
    void drain(Native).catch((error) => {
      DatabaseLogger.error(error as Error, "TaskWidgetCompletion.drain");
    });
  const emitter = new NativeEventEmitter(Native as never);
  const pending = emitter.addListener(
    "pendingTaskWidgetCompletion",
    requestDrain
  );
  // A cold start launched by the intent submits its request before this bundle
  // finishes loading, so that notification is missed. Drain once on start.
  requestDrain();
  return () => {
    pending.remove();
  };
}

export const TaskWidgetCompletionHost = { start };
