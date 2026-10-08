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

import { DatabaseUpdatedEvent, EVENTS } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { AppState, NativeModules, Platform } from "react-native";
import {
  beginBackgroundTask,
  endBackgroundTask
  // @ts-ignore The package does not ship TypeScript declarations.
} from "react-native-begin-background-task";
import { db, DatabaseLogger } from "../common/database";
import { MMKV } from "../common/database/mmkv";
import { ToastManager } from "./event-manager";
import {
  NATIVE_TASK_COMPLETION_MAX_AGE_MS,
  isNativeTaskCompletionAction,
  mayCommitNativeTaskCompletion,
  taskWidgetAccountScope,
  type NativeTaskCompletionAction
} from "../hooks/task-widget-completion-intents";
import { useSettingStore } from "../stores/use-setting-store";
import { useThemeStore } from "../stores/use-theme-store";
import { useUserStore } from "../stores/use-user-store";
import SettingsService from "./settings";
import {
  buildPrivateTaskWidgetSnapshot,
  buildTaskWidgetSnapshot
} from "./task-widget-snapshot";
import { TaskNotifications } from "./task-notifications";

type NativeReminderWidget = {
  writeSnapshot(snapshot: string): Promise<void>;
  clearSnapshot(): Promise<void>;
  listPendingCompletions(): Promise<unknown[]>;
  acknowledgeCompletion(filename: string): Promise<void>;
};

const Native: NativeReminderWidget | undefined =
  Platform.OS === "ios" ? NativeModules.ReminderWidgetModule : undefined;

let updateTimer: NodeJS.Timeout | undefined;
let writeQueue = Promise.resolve();
let snapshotGeneration = 0;

/**
 * What became of one durable widget action. Only `completed` means the Task is
 * persisted, the snapshot has been rewritten from it and the action has been
 * acknowledged; `locked`, `accountMismatch`, `unavailable` and `failed` all
 * leave the action queued for a later retry, and `stale` drops it.
 */
export type TaskWidgetCompletionOutcome =
  | "completed"
  | "locked"
  | "accountMismatch"
  | "stale"
  | "unavailable"
  | "failed";

let drainChain: Promise<unknown> = Promise.resolve();
let untargetedDrainQueued = false;

/** One drain at a time, so a targeted commit cannot interleave with the
 * lifecycle drains and read a queue another pass is already consuming. */
function enqueueDrain<T>(run: () => Promise<T>): Promise<T> {
  const next = drainChain.then(run, run);
  drainChain = next.catch(() => {});
  return next;
}

/**
 * Finishes the device side of a Task that was just persisted as completed:
 * the native alarm, the pending notification fallback and the overdue Live
 * Activity for the occurrence are reconciled away so a completed occurrence
 * does not keep ringing or showing a card.
 *
 * This is awaited even in a headless process with no mounted subscriptions --
 * the App Intent process never mounts the App component, so nothing else would
 * ever run it there. It is deliberately best-effort: `TaskNotifications`
 * reconciles with `runIndependentCleanup` and keeps its own durable retry
 * obligation for anything that failed, so a cleanup failure here is logged and
 * retried later, and it never turns a *persisted* completion into a failure.
 * The success the caller is told about is the Task write, never this cleanup.
 */
async function reconcileAfterCompletion(): Promise<void> {
  try {
    await TaskNotifications.reconcile();
  } catch (error) {
    // Keep the durable cleanup obligation in TaskNotifications; only log here.
    DatabaseLogger.error(error as Error, "ReminderWidget.completionReconcile");
  }
}

// The widget extension cannot open the encrypted React Native Task domain.
// Its action remains visibly pending until a host path commits and projects it.
async function drainOnce(
  target?: string
): Promise<TaskWidgetCompletionOutcome | undefined> {
  if (!Native || !db.isInitialized) return target ? "unavailable" : undefined;
  if (
    SettingsService.get().appLockEnabled ||
    useUserStore.getState().appLocked ||
    useUserStore.getState().isLoggingOut
  )
    return target ? "locked" : undefined;
  let outcome: TaskWidgetCompletionOutcome | undefined;
  const record = (
    filename: string,
    value: TaskWidgetCompletionOutcome
  ): void => {
    if (filename === target) outcome = value;
  };
  let needsRetryNotice = false;
  try {
    const accountId = (await db.user.getUser())?.id || null;
    const scope = taskWidgetAccountScope(MMKV, accountId);
    const queued = await Native.listPendingCompletions();
    // An App Intent has a short execution budget. Commit the tapped action
    // first and leave unrelated queued actions for the normal lifecycle drain.
    const actions = target
      ? queued.filter(
          (raw) =>
            (raw as NativeTaskCompletionAction | null)?.filename === target
        )
      : queued;
    for (const raw of actions) {
      const filename = (raw as NativeTaskCompletionAction | null)?.filename;
      if (!isNativeTaskCompletionAction(raw)) {
        if (
          typeof filename === "string" &&
          /^[0-9a-f]{64}\.json$/.test(filename)
        ) {
          await Native.acknowledgeCompletion(filename);
          record(filename, "stale");
        }
        continue;
      }
      const expired =
        raw.enqueuedAt > Date.now() + 5 * 60 * 1000 ||
        Date.now() - raw.enqueuedAt > NATIVE_TASK_COMPLETION_MAX_AGE_MS;
      if (expired) {
        if (raw.scope === scope) needsRetryNotice = true;
        await Native.acknowledgeCompletion(raw.filename);
        record(raw.filename, "stale");
        continue;
      }
      // A different signed-in account must never consume this action. Keep it
      // for a later sign-in to the original account within the retry window.
      if (raw.scope !== scope) {
        record(raw.filename, "accountMismatch");
        continue;
      }
      const task = await db.tasks.get(raw.id);
      const accountStillMatches =
        ((await db.user.getUser())?.id || null) === accountId;
      if (
        SettingsService.get().appLockEnabled ||
        useUserStore.getState().appLocked ||
        useUserStore.getState().isLoggingOut ||
        !accountStillMatches
      ) {
        if (target && !outcome) outcome = "locked";
        break;
      }
      if (
        !task?.completed &&
        !mayCommitNativeTaskCompletion(raw, scope, task)
      ) {
        needsRetryNotice = true;
        await Native.acknowledgeCompletion(raw.filename);
        record(raw.filename, "stale");
        continue;
      }
      // The persisted setting is authoritative in a headless process. Check
      // again after the last await and immediately before mutating the Task.
      if (SettingsService.get().appLockEnabled) {
        record(raw.filename, "locked");
        break;
      }
      // The revision check and write share Core's Task mutation lock. A
      // completed occurrence also repairs a missing next occurrence on retry.
      const completed = await db.tasks.completeIfUnchanged(
        raw.id,
        raw.updatedAt
      );
      if (!completed) {
        needsRetryNotice = true;
        await Native.acknowledgeCompletion(raw.filename);
        record(raw.filename, "stale");
        continue;
      }
      await flushUpdateForCompletion();
      // The Task is persisted and projected. Its alarm, pending fallback and
      // overdue surface are reconciled away here (best effort: a failure is
      // logged and stays a durable retry obligation, never a clean-up claim),
      // so a completed occurrence stops ringing and is dropped from the widget.
      await reconcileAfterCompletion();
      await Native.acknowledgeCompletion(raw.filename);
      record(raw.filename, "completed");
    }
    if (needsRetryNotice && AppState.currentState === "active")
      ToastManager.show({
        type: "info",
        message: strings.tasksWidgetCompletionRetry()
      });
  } catch (error) {
    // Keep the durable action for a later foreground/unlock retry.
    DatabaseLogger.error(error as Error, "ReminderWidget.complete");
    if (target && !outcome) outcome = "failed";
  }
  return outcome;
}

/** Fire and forget, for the app lifecycle. Repeat requests while one is queued
 * are coalesced, as a single pass already consumes the whole queue. */
function drainPendingCompletions(): Promise<void> {
  if (!Native) return Promise.resolve();
  if (untargetedDrainQueued) return drainChain.then(() => {});
  untargetedDrainQueued = true;
  return enqueueDrain(async () => {
    untargetedDrainQueued = false;
    await drainOnce();
  });
}

/**
 * Commit one action and report what definitively happened to it, so a caller
 * that has to answer the system (the widget completion App Intent) never
 * reports a completion the encrypted database did not persist.
 */
function commitCompletion(action: {
  filename: string;
  id: string;
}): Promise<TaskWidgetCompletionOutcome> {
  if (!Native)
    return Promise.resolve<TaskWidgetCompletionOutcome>("unavailable");
  return enqueueDrain(async () => {
    const outcome = await drainOnce(action.filename);
    if (outcome) return outcome;
    // The action was not in the queue. That is *not* proof an earlier pass
    // consumed it: the native reader can omit a protected App-Group file, so
    // an incomplete Task means the action must be retried, never dropped as
    // stale. The persisted Task is the only authority on what a pass did.
    try {
      if (!(await db.tasks.get(action.id))?.completed) return "failed";
      await flushUpdateForCompletion();
      await reconcileAfterCompletion();
      return "completed";
    } catch (error) {
      DatabaseLogger.error(error as Error, "ReminderWidget.completeResult");
      return "failed";
    }
  });
}

function mayExposeTaskTitles() {
  return (
    !SettingsService.get().appLockEnabled &&
    !useSettingStore.getState().settings.appLockEnabled &&
    !useUserStore.getState().appLocked
  );
}

function clearSnapshot() {
  snapshotGeneration++;
  clearTimeout(updateTimer);
  updateTimer = undefined;
  if (!Native) return Promise.resolve();
  writeQueue = writeQueue
    .then(() => Native.clearSnapshot())
    .catch((error) =>
      DatabaseLogger.error(error as Error, "ReminderWidget.clear")
    );
  if (AppState.currentState !== "active")
    void protectBackgroundWrite(writeQueue, beginBackgroundTask());
  return writeQueue;
}

async function writeCurrentSnapshot() {
  if (!Native || !db.isInitialized) return false;
  const generation = snapshotGeneration;
  const themeState = useThemeStore.getState();
  const appearance = SettingsService.getProperty("useSystemTheme")
    ? "system"
    : themeState.colorScheme;
  const options = {
    appearance,
    accentLight: themeState.lightTheme.scopes.base.primary.accent,
    accentDark: themeState.darkTheme.scopes.base.primary.accent
  } as const;
  if (!mayExposeTaskTitles()) {
    if (generation !== snapshotGeneration) return false;
    if (
      SettingsService.get().appLockEnabled ||
      useSettingStore.getState().settings.appLockEnabled
    )
      await Native.writeSnapshot(
        JSON.stringify(buildPrivateTaskWidgetSnapshot(options))
      );
    else await Native.clearSnapshot();
    return true;
  }
  const tasks = await db.tasks.list();
  if (generation !== snapshotGeneration || !mayExposeTaskTitles()) return false;
  const accountId = (await db.user.getUser())?.id || null;
  if (generation !== snapshotGeneration || !mayExposeTaskTitles()) return false;
  const snapshot = buildTaskWidgetSnapshot(tasks, {
    ...options,
    accountScope: taskWidgetAccountScope(MMKV, accountId)
  });
  await Native.writeSnapshot(JSON.stringify(snapshot));
  return true;
}

function flushUpdate() {
  if (!Native) return Promise.resolve();
  clearTimeout(updateTimer);
  updateTimer = undefined;
  writeQueue = writeQueue.then(async () => {
    await writeCurrentSnapshot();
  }).catch((error) => {
    DatabaseLogger.error(error as Error, "ReminderWidget.update");
  });
  return writeQueue;
}

/** Keep the action pending when a committed Task cannot yet be projected. */
function flushUpdateForCompletion() {
  if (!Native) return Promise.resolve();
  clearTimeout(updateTimer);
  updateTimer = undefined;
  const write = writeQueue.then(async () => {
    if (!(await writeCurrentSnapshot()))
      throw new Error("Task Widget snapshot was not refreshed");
  });
  writeQueue = write.catch((error) => {
    DatabaseLogger.error(error as Error, "ReminderWidget.completeSnapshot");
  });
  return write;
}

async function protectBackgroundWrite(
  write: Promise<void>,
  backgroundTask: Promise<number>
) {
  let backgroundTaskId: number | undefined;
  try {
    backgroundTaskId = await backgroundTask;
    await write;
  } catch (error) {
    DatabaseLogger.error(error as Error, "ReminderWidget.background");
    await write;
  } finally {
    if (backgroundTaskId !== undefined) {
      try {
        await endBackgroundTask(backgroundTaskId);
      } catch (error) {
        DatabaseLogger.error(error as Error, "ReminderWidget.backgroundEnd");
      }
    }
  }
}

function update() {
  if (!Native) return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    flushUpdate();
  }, 250);
}

function start() {
  if (!Native) {
    if (Platform.OS === "ios")
      DatabaseLogger.error(
        new Error("Native Task widget bridge unavailable"),
        "ReminderWidget.start"
      );
    return () => {};
  }

  update();
  void drainPendingCompletions();
  const databaseSubscription = db.eventManager.subscribe(
    EVENTS.databaseUpdated,
    (event: DatabaseUpdatedEvent) => {
      if (event.collection === "settings" || event.collection === "reminders")
        update();
    }
  );
  const syncSubscription = db.eventManager.subscribe(EVENTS.syncCompleted, () =>
    update()
  );
  // iOS may suspend JavaScript before the debounce fires after the user saves
  // a Task and immediately leaves the app. Flush the derived cache first.
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      const backgroundTask = beginBackgroundTask();
      void protectBackgroundWrite(
        updateTimer ? flushUpdate() : writeQueue,
        backgroundTask
      );
    } else {
      update();
      void drainPendingCompletions();
    }
  });
  const logoutSubscription = db.eventManager.subscribe(
    EVENTS.userLoggedOut,
    () => void clearSnapshot()
  );
  const unsubscribeTheme = useThemeStore.subscribe((state, previous) => {
    if (
      state.colorScheme !== previous.colorScheme ||
      state.darkTheme !== previous.darkTheme ||
      state.lightTheme !== previous.lightTheme
    ) {
      update();
    }
  });
  const unsubscribeSettings = useSettingStore.subscribe((state, previous) => {
    if (state.settings.appLockEnabled !== previous.settings.appLockEnabled) {
      void clearSnapshot();
      flushUpdate();
    } else if (
      state.settings.useSystemTheme !== previous.settings.useSystemTheme
    ) {
      update();
    }
  });
  const unsubscribeUser = useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) {
      // Clearing alone leaves the widget showing its empty state until some
      // unrelated event happens to re-project it. The account change *is* the
      // event: the previous account's snapshot is dropped (generation bumped,
      // so a write already in flight is discarded) and the signed-in state --
      // the new account's Tasks, or nothing while signed out -- is projected.
      void clearSnapshot();
      update();
    } else if (state.appLocked !== previous.appLocked) {
      if (state.appLocked) {
        void clearSnapshot();
        flushUpdate();
      } else {
        update();
        void drainPendingCompletions();
      }
    }
  });

  return () => {
    databaseSubscription.unsubscribe();
    syncSubscription.unsubscribe();
    logoutSubscription.unsubscribe();
    appStateSubscription.remove();
    unsubscribeTheme();
    unsubscribeSettings();
    unsubscribeUser();
    clearTimeout(updateTimer);
    updateTimer = undefined;
  };
}

export const ReminderWidget = {
  start,
  update,
  drainPendingCompletions,
  commitCompletion,
  waitForUpdate: () => {
    if (updateTimer) flushUpdate();
    return writeQueue;
  },
  clear: clearSnapshot
};
