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
import {
  HEADLESS_APP_INTENT_ACTIONS,
  appLockBlocksHeadlessAccess,
  appIntentLocked,
  executeAppIntentRequest,
  type AppIntentReply,
  type AppIntentRequest
} from "./app-intent-requests";

/**
 * The Shortcuts actions that do not open the app run in the main app process in
 * the background, which can be a cold start with no scene, no App component and
 * no editor. This module is the JavaScript end of that, started from index.js at
 * the top level, so the parameter picker and "Complete Task" are answered by the
 * same encrypted Task domain the Tasks screen writes.
 *
 * It owns only the actions in `HEADLESS_APP_INTENT_ACTIONS`. The creating
 * actions stay with `startAppIntentBridge`, which runs inside the mounted app;
 * splitting ownership by action is what keeps the one native mailbox from being
 * drained, and a request from being executed, twice.
 */

type NativeIntentBridge = {
  pendingRequests(): Promise<unknown[]>;
  acknowledge(id: string, status: string, value: string): Promise<void>;
};

const Native: NativeIntentBridge | undefined =
  Platform.OS === "ios" ? NativeModules.VeyraNIntentModule : undefined;

const MAX_REQUEST_ID = 64;
const MAX_PAYLOAD_KEYS = 16;
// Bounded so a malformed request cannot hand the Task domain an unbounded
// string. The largest real payload is a list of entity identifiers.
const MAX_PAYLOAD_VALUE = 4096;

export function isHeadlessAppIntentRequest(
  value: unknown
): value is AppIntentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (
    typeof request.id !== "string" ||
    request.id.length === 0 ||
    request.id.length > MAX_REQUEST_ID
  )
    return false;
  if (
    typeof request.action !== "string" ||
    !HEADLESS_APP_INTENT_ACTIONS.has(request.action)
  )
    return false;
  const payload = request.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return false;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length > MAX_PAYLOAD_KEYS) return false;
  return entries.every(
    ([, item]) => typeof item === "string" && item.length <= MAX_PAYLOAD_VALUE
  );
}

export async function runHeadlessAppIntentRequest(
  request: AppIntentRequest
): Promise<AppIntentReply> {
  // Fail closed before the database is opened. App Lock has to be read from
  // persisted settings here: nothing has mounted the App component in this
  // process, so the in-memory lock flag is still at its unlocked default and
  // would wave a locked account's Tasks through.
  if (appIntentLocked() || appLockBlocksHeadlessAccess())
    return { status: "locked", value: "" };
  try {
    // db.init is broad but editor-free, and it is what loads the collections
    // and the recurrence maintenance a completion depends on. Creating a
    // database key is refused here: an unreadable Keychain (a device that has
    // not been unlocked since boot) must fail the action rather than open a new
    // empty database over the user's Tasks.
    await initializeDatabaseOnce(undefined, { createDatabaseKey: false });
  } catch (error) {
    DatabaseLogger.error(error as Error, "AppIntentHost.database");
    return { status: "unavailable", value: "" };
  }
  // A database waiting on a migration cannot be written to, and its Tasks are
  // not yet in their final shape, so neither a read nor a write is answered.
  if (db.migrations.required()) return { status: "unavailable", value: "" };
  return executeAppIntentRequest(request);
}

let draining = false;
let drainAgain = false;

async function drain(native: NativeIntentBridge) {
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
        const action = (raw as { action?: unknown } | null)?.action;
        // Leave the creating actions to the foreground bridge.
        if (
          typeof action !== "string" ||
          !HEADLESS_APP_INTENT_ACTIONS.has(action)
        )
          continue;
        if (!isHeadlessAppIntentRequest(raw)) {
          DatabaseLogger.error(
            new Error("Malformed headless App Intent request"),
            "AppIntentHost.drain"
          );
          const id = (raw as { id?: unknown })?.id;
          if (
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= MAX_REQUEST_ID
          )
            await native.acknowledge(id, "invalid", "");
          continue;
        }
        let reply: AppIntentReply = { status: "failed", value: "" };
        try {
          reply = await runHeadlessAppIntentRequest(raw);
        } catch (error) {
          // An unexpected throw is reported as a failure. Nothing here claims
          // a Task was completed that the encrypted domain did not persist.
          DatabaseLogger.error(error as Error, "AppIntentHost.run");
        }
        try {
          await native.acknowledge(raw.id, reply.status, reply.value);
        } catch (error) {
          // The native request remains pending and its App Intent will time out
          // honestly. Continue this batch so one bridge failure cannot strand
          // unrelated Shortcuts requests behind it.
          DatabaseLogger.error(error as Error, "AppIntentHost.acknowledge");
        }
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
      DatabaseLogger.error(error as Error, "AppIntentHost.drain");
    });
  const emitter = new NativeEventEmitter(Native as never);
  const pending = emitter.addListener("pendingIntent", requestDrain);
  // A cold start launched by the intent submits its request before this bundle
  // finishes loading, so that notification is missed. Drain once on start.
  requestDrain();
  return () => {
    pending.remove();
  };
}

export const AppIntentHost = { start };
