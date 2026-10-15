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
 * The React Native side of the VeyraN Assistant (Slice 1 reads + Slice 2
 * explicit draft actions).
 *
 * It wires the headless {@link VeyranAssistantController} to the real
 * dependencies: the authoritative lifecycle stores, the SIWC provider, the real
 * current-tab note id and the assistant's **own** {@link ConnectAdapter}.
 *
 * Ownership rules:
 *  - the provider host lifecycle stays owned by the app-level `startSIWCHost`;
 *    this service never mounts a second provider host;
 *  - the assistant owns a *separately initialized* `ConnectAdapter` with its own
 *    closed grants; it never borrows the Connect pairing grants/secrets;
 *  - reads are scoped to exactly one explicitly selected note id (the current
 *    tab note) and are bounded;
 *  - the three write actions are each scoped to exactly one capability and one
 *    exact target (one note id + its captured revision, or the single default
 *    Task list). There is still no collection upload, no note search and no raw
 *    DB/SQL access: every write flows through the shared Core adapter only.
 *
 * Function calling (the current Responses implementation) — concrete gap:
 *  the Swift `VeyraNSIWCInput.continuation`/`functionCallOutput` builders exist,
 *  but nothing in the JS `VeyraNSIWCModule` surface can submit a
 *  `function_call_output` and continue the same turn (`streamInvoke` returns
 *  `{completed, text}` only, and there is no `previous_response_id`/continue
 *  method). So a model-selected tool call cannot round-trip a result and, more
 *  importantly, a model-selected *write* would be a hidden auto-write with no
 *  user click — exactly what this slice forbids. The assistant therefore keeps
 *  `functions: []` (no model-selected operation ids, no note search, no dynamic
 *  permissions) and every write stays behind its own explicit button press.
 */

import { ConnectAdapter, EV, EVENTS, isConnectError } from "@notesnook/core";
import { AuthMode } from "../../components/auth/common";
import { db } from "../../common/database";
import Navigation from "../navigation";
import { useTabStore } from "../../screens/editor/tiptap/use-tab-store";
import { useSettingStore } from "../../stores/use-setting-store";
import { useUserStore } from "../../stores/use-user-store";
import {
  beginSIWCAuth,
  cancelSIWCAuth,
  cancelSIWCStream,
  currentSIWCHostIdentity,
  fetchSIWCModels,
  isSIWCHostIdentityCurrent,
  isSIWCPlatformSupported,
  logoutSIWC,
  setSIWCAuthHandler,
  setSIWCStreamHandler,
  siwcCanInvoke,
  siwcHostEligibility,
  siwcMobileUnavailableCopy,
  siwcStatus,
  streamSIWC,
  type SIWCFunctionDefinition,
  type SIWCInputItem
} from "../veyran-siwc";
import { VeyranAssistantController } from "./controller";
import { OwnedSubscription, assistantLifecycleChanged } from "./helpers";
import type {
  AssistantAuthMode,
  AssistantDeps,
  AssistantHostIdentity,
  AssistantPreview,
  AssistantWriteOutcome
} from "./types";

export * from "./types";
export { VeyranAssistantController } from "./controller";
export {
  OwnedSubscription,
  assistantActionErrorNotice,
  assistantLifecycleChanged,
  buildAssistantInput,
  buildAssistantInstruction,
  buildAssistantNoteData,
  isNoteDraftSavable,
  isSendable,
  isTaskDraftSavable,
  normalizeAssistantTaskTitle,
  MAX_ASSISTANT_QUESTION_CHARS
} from "./helpers";

// ------------------------------------------------- assistant-owned ConnectAdapter

let assistantConnectAdapter: ConnectAdapter | undefined;

/**
 * The assistant's own adapter. It is created lazily and is never shared with the
 * VeyraN Connect broker host: pairing grants and secrets stay with that host.
 */
export function assistantAdapterOnce(): ConnectAdapter {
  if (!assistantConnectAdapter || assistantConnectAdapter.closed) {
    // The receipt journal is shared by every assistant action but only
    // mutations reserve a receipt (reads never do). 64 was sized for the
    // read-only Slice 1; with the three write actions a single process could
    // reach it and then be fail-closed with JOURNAL_FULL forever, so it is
    // raised to a bounded value comfortably above realistic assistant usage.
    // (The adapter still fails closed when full — it never evicts history.)
    assistantConnectAdapter = new ConnectAdapter(db, {
      maxJournalEntries: 1024
    });
  }
  return assistantConnectAdapter;
}

/** Revoke the assistant's own grants and lock its adapter (synchronous seam). */
export function fenceAssistantAdapter(): void {
  const adapter = assistantConnectAdapter;
  if (!adapter || adapter.closed) return;
  adapter.clearGrants();
  adapter.lock();
}

/** Close the assistant adapter on process teardown. */
export function closeAssistantAdapter(): void {
  assistantConnectAdapter?.close();
  assistantConnectAdapter = undefined;
}

// -------------------------------------------------------------- real tab note

/** The real current-tab note id, via `useTabStore` currentTab/getTab. */
function currentAssistantNoteId(): string | undefined {
  try {
    const state = useTabStore.getState();
    const tab = state.getTab(state.currentTab);
    return tab?.session?.noteId || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One bounded `get_note` for exactly `noteId`, scoped to exactly that id, and
 * rendered exactly as Core returned it (the saved snapshot, not the editor
 * draft). `assertCurrent` is the trusted host-ownership predicate; the adapter
 * converts a throw into `SESSION_CHANGED`, so a stale capture reads nothing.
 */
async function readAssistantNote(
  accountId: string,
  noteId: string,
  assertCurrent: () => void
): Promise<AssistantPreview | undefined> {
  const adapter = assistantAdapterOnce();
  if (adapter.closed) return undefined;
  adapter.unlock();
  try {
    await adapter.setGrants({
      accountId,
      canRead: true,
      canCreate: false,
      canChange: false,
      canTask: false,
      noteIDs: [noteId]
    });
    const operationId = `assistant-preview-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1e9
    ).toString(36)}`;
    const result = (await adapter.execute(
      { operation: "get_note", noteId },
      { operationId, noteId, assertCurrent }
    )) as {
      operation?: unknown;
      noteId?: unknown;
      title?: unknown;
      content?: unknown;
      revision?: unknown;
      truncated?: unknown;
    };
    if (!result || result.operation !== "get_note") return undefined;
    if (result.noteId !== noteId) return undefined;
    if (
      typeof result.title !== "string" ||
      typeof result.content !== "string" ||
      typeof result.revision !== "string"
    ) {
      return undefined;
    }
    return {
      noteId,
      title: result.title,
      content: result.content,
      revision: result.revision,
      truncated: result.truncated === true
    };
  } catch {
    // Fail closed, including the adapter's SESSION_CHANGED for a stale capture.
    return undefined;
  } finally {
    if (!adapter.closed) {
      adapter.clearGrants();
      adapter.lock();
    }
  }
}

// ------------------------------------------------------------- real writes

/**
 * The bounded, unique operation id the controller caches per write capture. It
 * is never derived from note content and never persisted by the assistant.
 */
function nextAssistantOperationId(): string {
  return `assistant-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e9
  ).toString(36)}`;
}

/** Map a raw thrown value to the bounded static Connect code only. */
function writeOutcomeFromError(error: unknown): AssistantWriteOutcome {
  return { ok: false, code: isConnectError(error) ? error.code : "unknown" };
}

/**
 * Report a persisted note write only from the adapter's own `local_saved`
 * state: a missing/different operation, an absent persistence marker or a
 * missing id/revision is never reported as saved.
 */
function noteWriteOutcome(
  result: unknown,
  operation: "create_note" | "append_to_note"
): AssistantWriteOutcome {
  const value = result as
    | {
        operation?: unknown;
        noteId?: unknown;
        revision?: unknown;
        persisted?: unknown;
      }
    | undefined;
  if (!value || value.operation !== operation)
    return { ok: false, code: "unknown" };
  if (value.persisted !== "local_saved")
    return { ok: false, code: "unknown" };
  if (typeof value.noteId !== "string" || !value.noteId)
    return { ok: false, code: "unknown" };
  if (typeof value.revision !== "string" || !value.revision)
    return { ok: false, code: "unknown" };
  return { ok: true, noteId: value.noteId, revision: value.revision };
}

/** The same truthfulness rule for the Task write. */
function taskWriteOutcome(result: unknown): AssistantWriteOutcome {
  const value = result as
    | {
        operation?: unknown;
        taskId?: unknown;
        revision?: unknown;
        persisted?: unknown;
      }
    | undefined;
  if (!value || value.operation !== "create_task")
    return { ok: false, code: "unknown" };
  if (value.persisted !== "local_saved")
    return { ok: false, code: "unknown" };
  if (typeof value.taskId !== "string" || !value.taskId)
    return { ok: false, code: "unknown" };
  if (typeof value.revision !== "string" || !value.revision)
    return { ok: false, code: "unknown" };
  return { ok: true, taskId: value.taskId, revision: value.revision };
}

/**
 * One bounded `create_note` through the assistant's **own** adapter, scoped to
 * exactly one capability. The body is the reviewed draft (plain/markdown text);
 * the adapter converts and sanitizes it through the ordinary Core pipeline and
 * derives a deterministic title, so a crash+replay is verifiable. No model
 * output, no raw DB write and no collection access is involved.
 */
async function createAssistantNote(
  accountId: string,
  content: string,
  operationId: string,
  assertCurrent: () => void
): Promise<AssistantWriteOutcome> {
  const adapter = assistantAdapterOnce();
  if (adapter.closed) return { ok: false, code: "ADAPTER_CLOSED" };
  adapter.unlock();
  try {
    await adapter.setGrants({ accountId, canCreate: true });
    const result = await adapter.execute(
      { operation: "create_note", operationId, content, format: "markdown" },
      { operationId, assertCurrent }
    );
    return noteWriteOutcome(result, "create_note");
  } catch (error) {
    return writeOutcomeFromError(error);
  } finally {
    if (!adapter.closed) {
      adapter.clearGrants();
      adapter.lock();
    }
  }
}

/**
 * One bounded `append_to_note` pinned to the exact reviewed note id *and* its
 * captured `expectedRevision`. The adapter re-checks the revision inside the
 * shared domain write lock, so a note that changed since it was reviewed is a
 * truthful conflict instead of an overwrite. Only `canChange` on that one note
 * is granted for the call.
 */
async function appendAssistantNote(
  accountId: string,
  noteId: string,
  content: string,
  expectedRevision: string,
  operationId: string,
  assertCurrent: () => void
): Promise<AssistantWriteOutcome> {
  const adapter = assistantAdapterOnce();
  if (adapter.closed) return { ok: false, code: "ADAPTER_CLOSED" };
  adapter.unlock();
  try {
    await adapter.setGrants({ accountId, canChange: true, noteIDs: [noteId] });
    const result = await adapter.execute(
      {
        operation: "append_to_note",
        operationId,
        noteId,
        content,
        format: "markdown",
        expectedRevision
      },
      { operationId, noteId, assertCurrent }
    );
    return noteWriteOutcome(result, "append_to_note");
  } catch (error) {
    return writeOutcomeFromError(error);
  } finally {
    if (!adapter.closed) {
      adapter.clearGrants();
      adapter.lock();
    }
  }
}

/**
 * One bounded `create_task` through the assistant's own adapter. The single
 * granted list is the real default Task list (resolved from Core, never
 * invented); the write produces a real Core Task record, never a note checkbox.
 */
async function createAssistantTask(
  accountId: string,
  title: string,
  operationId: string,
  assertCurrent: () => void
): Promise<AssistantWriteOutcome> {
  const adapter = assistantAdapterOnce();
  if (adapter.closed) return { ok: false, code: "ADAPTER_CLOSED" };
  let listId: string;
  try {
    const list = await db.taskLists.default();
    if (!list || typeof list.id !== "string" || !list.id)
      return { ok: false, code: "TASK_LIST_NOT_FOUND" };
    listId = list.id;
  } catch {
    return { ok: false, code: "TASK_LIST_NOT_FOUND" };
  }
  adapter.unlock();
  try {
    await adapter.setGrants({ accountId, canTask: true, listIDs: [listId] });
    const result = await adapter.execute(
      { operation: "create_task", operationId, title, listId },
      { operationId, assertCurrent }
    );
    return taskWriteOutcome(result);
  } catch (error) {
    return writeOutcomeFromError(error);
  } finally {
    if (!adapter.closed) {
      adapter.clearGrants();
      adapter.lock();
    }
  }
}

// --------------------------------------------------------------- real deps

function realDeps(): AssistantDeps {
  return {
    isPlatformSupported: isSIWCPlatformSupported,
    eligibility: siwcHostEligibility,
    hostIdentity: (): AssistantHostIdentity => currentSIWCHostIdentity(),
    isHostIdentityCurrent: isSIWCHostIdentityCurrent,
    canInvoke: siwcCanInvoke,
    status: siwcStatus,
    models: fetchSIWCModels,
    stream: (accountId, model, input, functions, instructions) =>
      streamSIWC(
        accountId,
        model,
        input as SIWCInputItem[],
        functions as SIWCFunctionDefinition[],
        instructions
      ),
    cancelStream: cancelSIWCStream,
    beginAuth: (mode: AssistantAuthMode) => beginSIWCAuth(mode),
    cancelAuth: cancelSIWCAuth,
    // The ordinary, non-destructive VeyraN sign-in screen. It never signs out,
    // resets or clears anything and never promises to cure a backend
    // affinity/crypto rejection.
    openVeyranSignIn: () => {
      Navigation.navigate("Auth", { mode: AuthMode.login });
    },
    logout: logoutSIWC,
    mobileUnavailableCopy: siwcMobileUnavailableCopy,
    currentNoteId: currentAssistantNoteId,
    readNote: readAssistantNote,
    makeOperationId: nextAssistantOperationId,
    createNote: createAssistantNote,
    appendToNote: appendAssistantNote,
    createTask: createAssistantTask
  };
}

/** The single process-wide assistant controller (used by the sidebar/settings). */
export const assistantController = new VeyranAssistantController(realDeps());

// ----------------------------------------------------- owned SIWC subscriptions

type SIWCStreamHandler = NonNullable<
  Parameters<typeof setSIWCStreamHandler>[0]
>;
type SIWCAuthHandler = NonNullable<Parameters<typeof setSIWCAuthHandler>[0]>;

const streamSlot = new OwnedSubscription<SIWCStreamHandler>();
const authSlot = new OwnedSubscription<SIWCAuthHandler>();

/** Reference count of live assistant surfaces (sidebar + settings). */
let assistantMountCount = 0;
let disposeStreamHandlers: (() => void) | undefined;
let disposeAuthHandlers: (() => void) | undefined;
let disposeLifecycleSubscriptions: (() => void) | undefined;

// ------------------------------------------- authoritative lifecycle seam

/** The exact current-tab context key (`currentTab` + its note id). */
function currentTabKey(): string {
  try {
    const state = useTabStore.getState();
    const tab = state.getTab(state.currentTab);
    return `${state.currentTab}\u0000${tab?.session?.noteId ?? ""}`;
  } catch {
    return "";
  }
}

function tabKeyOf(state: {
  currentTab: string;
  getTab(id: string): { session?: { noteId?: string } } | undefined;
}): string {
  try {
    const tab = state.getTab(state.currentTab);
    return `${state.currentTab}\u0000${tab?.session?.noteId ?? ""}`;
  } catch {
    return "";
  }
}

/**
 * The narrow, owned lifecycle subscriptions that clear the decrypted preview and
 * the RAM-only draft (and cancel any stream) *synchronously* at the real
 * authoritative seams: account/lock/logout/setup (`useUserStore`), app
 * loading (`useSettingStore`), migration (`EV`/`db.migrations`) and the current
 * tab (`useTabStore`). No private editor data is written to any store.
 */
function installLifecycleSubscriptions(): () => void {
  const disposers: Array<() => void> = [];

  let previousUser = useUserStore.getState();
  disposers.push(
    useUserStore.subscribe((state) => {
      const previous = previousUser;
      previousUser = state;
      // The shared edge predicate includes the `accountSetupRequired`
      // true -> false recovery edge, so a successful manual VeyraN
      // re-authentication re-reads status and re-enables provider login
      // without treating a mere re-render as a seam.
      if (
        assistantLifecycleChanged(
          {
            accountId: previous.user?.id ?? null,
            appLocked: previous.appLocked === true,
            isLoggingOut: previous.isLoggingOut === true,
            accountSetupRequired: previous.accountSetupRequired === true
          },
          {
            accountId: state.user?.id ?? null,
            appLocked: state.appLocked === true,
            isLoggingOut: state.isLoggingOut === true,
            accountSetupRequired: state.accountSetupRequired === true
          }
        )
      ) {
        onAssistantLifecycleChange();
      }
    })
  );

  let previousLoading = useSettingStore.getState().isAppLoading === true;
  disposers.push(
    useSettingStore.subscribe((state) => {
      const loading = state.isAppLoading === true;
      if (loading === previousLoading) return;
      previousLoading = loading;
      onAssistantLifecycleChange();
    })
  );

  const migration = EV.subscribe(EVENTS.migrationStarted, () => {
    fenceAssistantAdapter();
    assistantController.onContextChange();
  });
  disposers.push(() => migration.unsubscribe());

  let previousTabKey = currentTabKey();
  disposers.push(
    useTabStore.subscribe((state) => {
      const key = tabKeyOf(state);
      if (key === previousTabKey) return;
      previousTabKey = key;
      // A tab ABA (note-1 -> note-2 -> note-1) must never reuse an old preview:
      // the grant is fenced and the preview/draft/stream are dropped.
      fenceAssistantAdapter();
      assistantController.onContextChange();
    })
  );

  // A migration already pending at install time is fenced synchronously too.
  try {
    if (db.migrations?.required?.()) {
      fenceAssistantAdapter();
      assistantController.onContextChange();
    }
  } catch {
    // A missing/partial migrations API must not throw at mount.
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A disposal must never throw during unmount.
      }
    }
  };
}

/**
 * Bind the assistant to the app-level provider host.
 *
 * The provider host itself is mounted exactly once by `use-app-events.tsx`; this
 * only installs the assistant's *owned* handlers. The mount is reference-counted,
 * so a second surface that mounts (the settings screen over a live editor) keeps
 * the first one working, and only the *last* unmount disposes the handlers and
 * unmounts the controller — an older surface's unmount can never clear a newer
 * handler or unmount a newer surface. Each handler install additionally
 * supersedes any previous one through the owned slot.
 */
export function mountAssistantHost(): () => void {
  assistantMountCount += 1;
  if (assistantMountCount === 1) {
    // The lifecycle seam is installed for the *first* live surface only and is
    // disposed with the last one, so the store/event subscriptions never leak.
    disposeLifecycleSubscriptions = installLifecycleSubscriptions();
    if (isSIWCPlatformSupported()) {
      disposeStreamHandlers = streamSlot.install((emission) => {
        assistantController.onEmission(emission);
      }, setSIWCStreamHandler);
      disposeAuthHandlers = authSlot.install((event) => {
        assistantController.onAuthEvent(event);
      }, setSIWCAuthHandler);
    }
    // Off Mac Catalyst no provider host and no handler is installed; the
    // controller records the honest unsupported state and reads nothing.
    assistantController.mount();
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    assistantMountCount = Math.max(0, assistantMountCount - 1);
    if (assistantMountCount > 0) return;
    disposeLifecycleSubscriptions?.();
    disposeLifecycleSubscriptions = undefined;
    disposeStreamHandlers?.();
    disposeAuthHandlers?.();
    disposeStreamHandlers = undefined;
    disposeAuthHandlers = undefined;
    assistantController.unmount();
    fenceAssistantAdapter();
  };
}

/** Latest lifecycle seam: invalidate and drop the draft, then re-read status. */
export function onAssistantLifecycleChange(): void {
  fenceAssistantAdapter();
  assistantController.onLifecycleChange();
}

/** The strict React-free eligibility proof, re-exported for the service tests. */
export { siwcHostEligibility as assistantHostEligibility };
