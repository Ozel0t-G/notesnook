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

import Database from "../api/index.js";
import { Note, NoteContent } from "../types.js";
import { getContentFromData } from "../content-types/index.js";
import {
  Task,
  TaskInput,
  TaskRecurrenceGuard,
  TaskWriteGuard,
  validateTaskCreateInput,
  validateTaskUpdateInput
} from "../collections/tasks.js";
import { getId } from "../utils/id.js";
import { NEWLINE_STRIP_REGEX } from "../utils/title-format.js";
import { ConnectError, ConnectErrorCode, isConnectError } from "./errors.js";
import { ConnectGrantsInput, GrantSnapshot } from "./grants.js";
import {
  assertHostCurrent,
  FenceHost,
  HostAssert,
  OperationFence
} from "./fence.js";
import { IdempotencyJournal, JournalRecord } from "./journal.js";
import { hashId } from "./hash.js";
import { dbMutex } from "./mutex.js";
import { withDomainWrite } from "./domain-lock.js";
import {
  fingerprintOf,
  noteContentHash,
  noteRevision,
  taskRevision
} from "./revision.js";
import {
  boundContent,
  boundItems,
  boundText,
  ConnectContentFormat,
  containsInlineAttachmentData,
  CONTENT_LIMITS,
  toTiptapHtml
} from "./content.js";
import { ConnectRequest, requestSchema, responseSchema } from "./schema.js";

export interface ConnectAdapterOptions {
  /** Bounded journal size; the adapter fails closed rather than evict history. */
  maxJournalEntries?: number;
  /** Test-only instrumentation, awaited after every fence step. */
  instrumentation?: { onStep?: (label: string) => Promise<void> };
}

/**
 * Hard upper bound on the receipt journal capacity.
 *
 * A host may raise the capacity at construction time (the documented safe
 * sequence is: close the old adapter, then recreate it with a higher config),
 * but never without a finite bound: the journal fails closed when full rather
 * than evicting history, so an unbounded/`Infinity` capacity would turn the
 * only backpressure into "grow forever". 100000 is comfortably above any
 * realistic number of in-flight operations while staying finite.
 */
export const MAX_JOURNAL_CAPACITY = 100_000;

/** Add trusted host-only execution mode to an existing request fingerprint. */
function hostModeFingerprint(
  fingerprint: string,
  requireCanonicalContent: boolean
): string {
  return requireCanonicalContent
    ? fingerprintOf({ fingerprint, requireCanonicalContent: true })
    : fingerprint;
}

/**
 * Optional **trusted second argument** to {@link ConnectAdapter.execute}: the
 * per-invocation host execution context.
 *
 * It is supplied by the embedding host process (never by the model/wire
 * request) and describes the caller-owned execution the operation belongs to.
 * The adapter snapshots it into local primitives *before* the first `await` and
 * never stores it on the adapter, so:
 *
 * - the model cannot supply it (the strict request schema has no such field);
 * - mutating the caller's object after the call starts has no effect — the
 *   predicate is bound to a frozen snapshot of the validated identity, not to
 *   the caller's live object;
 * - concurrent invocations on one adapter keep independent contexts.
 *
 * `assertCurrent` must be **synchronous** and return `void`/`undefined`;
 * returning a thenable or any other non-`undefined` value (a boolean ownership
 * flag included) is rejected as malformed. A throw is translated to the bounded
 * static `SESSION_CHANGED` error — the host's exception text is never surfaced.
 */
export interface ConnectHostContext {
  /** Bounded id label for this invocation (required). */
  operationId: string;
  /** Exact note id, required for note-scoped operations only. */
  noteId?: string;
  /** Host session id, accepted for note writes only; copied into the note write. */
  sessionId?: string;
  /**
   * Optional controlled **strict canonical-content** mode for the editor /
   * assistant path. When `true`, created/replacement bodies and an append
   * fragment must already be *safe and byte-stable*: the effective format must
   * be `tiptap`, the raw string must be a fixed point of the sanitizer and
   * detached block-id pre-processing, and the actual persistence pipeline must
   * not rewrite it. For append, the full stored-base-plus-fragment body is
   * checked against the real persistence post-processor before a receipt is
   * reserved. Anything else is rejected with `UNSUPPORTED_CONTENT` before a
   * receipt is looked up or reserved, and before any persistence.
   *
   * Omitted (or `false`) means ordinary behavior — manual saves, external
   * Markdown/plaintext/TipTap conversion and every non-content-bearing
   * operation are unaffected. A non-boolean value is `INVALID_INPUT`. The
   * primitive is copied into the same immutable per-invocation snapshot as the
   * ownership predicate, so mutating the caller's object during an `await`
   * cannot change the selected mode and concurrent invocations cannot
   * contaminate one another. It is never part of the wire request.
   */
  requireCanonicalContent?: boolean;
  /** Synchronous "is this execution context still current?" predicate. */
  assertCurrent: () => void;
}

/** The immutable, validated per-invocation snapshot taken before the first await. */
interface HostContextSnapshot {
  readonly operationId: string;
  readonly noteId: string | undefined;
  readonly sessionId: string | undefined;
  readonly requireCanonicalContent: boolean;
  readonly assertCurrent: () => void;
}

const HOST_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "operationId",
  "noteId",
  "sessionId",
  "requireCanonicalContent",
  "assertCurrent"
]);

/** Operations that target exactly one note and therefore require an exact `noteId`. */
const NOTE_SCOPED_OPERATIONS: ReadonlySet<string> = new Set([
  "get_note",
  "append_to_note",
  "update_note"
]);

/** Operations whose write may be attributed to a host session. */
const SESSION_SCOPED_OPERATIONS: ReadonlySet<string> = new Set([
  "create_note",
  "append_to_note",
  "update_note"
]);

function isBoundedContextId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= CONTENT_LIMITS.maxIdChars
  );
}

/**
 * Validate a caller-supplied host context against the (already parsed) request
 * and take the immutable snapshot.
 *
 * Everything here is synchronous: no `await` runs between reading the caller's
 * object and freezing the primitives, so a mutation of that object while the
 * operation is suspended can never be observed. `undefined` means "no host
 * context": the plain callers stay byte-for-byte unchanged. Any other value
 * must be a well-formed context or the request is rejected as `INVALID_INPUT`.
 *
 * The rules, by operation:
 * - `operationId` is always required and bounded.
 * - `noteId` is required and must equal the request's target for the
 *   note-scoped operations; it is rejected outright for every other operation.
 * - `sessionId` is accepted for note writes only.
 * - for a mutation, `operationId` must equal the request's `operationId`.
 */
function normalizeHostContext(
  raw: unknown,
  request: ConnectRequest
): HostContextSnapshot | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConnectError("INVALID_INPUT");
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!HOST_CONTEXT_KEYS.has(key)) throw new ConnectError("INVALID_INPUT");
  }
  const operationId = record.operationId;
  const assertCurrent = record.assertCurrent;
  if (!isBoundedContextId(operationId))
    throw new ConnectError("INVALID_INPUT");
  if (typeof assertCurrent !== "function")
    throw new ConnectError("INVALID_INPUT");
  const noteId = record.noteId;
  const sessionId = record.sessionId;
  const requireCanonicalContent = record.requireCanonicalContent;
  if (noteId !== undefined && !isBoundedContextId(noteId))
    throw new ConnectError("INVALID_INPUT");
  if (sessionId !== undefined && !isBoundedContextId(sessionId))
    throw new ConnectError("INVALID_INPUT");
  // The strict-mode primitive is validated here, synchronously and before the
  // first `await`, and copied into the snapshot below. `undefined` (omitted)
  // and an explicit `false` both mean ordinary behavior; any other non-boolean
  // value (`0`/`1`/`"true"`/`null`/an object) is malformed — never coalesced.
  if (
    requireCanonicalContent !== undefined &&
    typeof requireCanonicalContent !== "boolean"
  )
    throw new ConnectError("INVALID_INPUT");

  if (NOTE_SCOPED_OPERATIONS.has(request.operation)) {
    // A note-scoped operation must be pinned to the exact same note: an absent
    // or different `noteId` is a mismatch, not a broader scope.
    if (!noteId || noteId !== (request as { noteId?: string }).noteId)
      throw new ConnectError("INVALID_INPUT");
  } else if (noteId !== undefined) {
    // An unscoped operation must not carry a note target at all.
    throw new ConnectError("INVALID_INPUT");
  }
  if (
    sessionId !== undefined &&
    !SESSION_SCOPED_OPERATIONS.has(request.operation)
  )
    throw new ConnectError("INVALID_INPUT");

  if ("operationId" in request) {
    if (operationId !== (request as { operationId: string }).operationId)
      throw new ConnectError("INVALID_INPUT");
  }

  // Capture `assertCurrent` now and bind it to a *frozen snapshot of the
  // validated identity* — never to the caller's live record. A method-style
  // predicate reading `this.operationId`/`this.sessionId` therefore sees the
  // exact values validated at entry, and mutating the caller's object while the
  // operation is suspended changes neither the snapshot nor what `this`
  // observes (ownership semantics cannot shift after entry). Only the three
  // validated id primitives are ever exposed: host state is never deep-copied
  // and no value is fabricated. The caller object is only read during this
  // synchronous snapshot; nothing else on it is retained.
  const identity = Object.freeze({ operationId, noteId, sessionId });
  return Object.freeze({
    operationId,
    noteId,
    sessionId,
    // Primitive copy: the strict mode is selected from the snapshot, not the
    // caller's live record, so a mutation during an await cannot shift it.
    requireCanonicalContent: requireCanonicalContent === true,
    assertCurrent: (assertCurrent as () => void).bind(identity)
  });
}

/**
 * The runtime content row. `db.content.findByNoteId` returns a `ContentItem`
 * (which carries `locked`/`dateEdited`), while the declared `NoteContent<false>`
 * only describes the decrypted shape, so the row type is narrowed here once.
 */
type NoteContentRow = NoteContent<false> & {
  locked?: boolean;
  dateEdited?: number;
  /** Present on the stored `ContentItem` row (not on the decrypted payload). */
  localOnly?: boolean;
};

interface NoteState {
  note?: Note;
  content?: NoteContentRow;
  revision?: string;
}

/**
 * A note read that has passed its pre-checks but whose returned objects are
 * (re)built only *after* the operation's last asynchronous instrumentation
 * point (the fence seal), from one coherent state — see
 * {@link ConnectAdapter.coherentNoteOutput}.
 */
type CoherentReadPlan = {
  operation: "search_notes" | "get_note";
  mode: "search" | "single";
  /**
   * Bounded candidate ids, in output order. For `search` this is the *whole*
   * `limit + 1` candidate window returned by the bounded query — the visible
   * set and `truncated` are derived from the final, domain-locked rebuild (see
   * {@link ConnectAdapter.planSearchNotes}).
   */
  noteIds: string[];
  /** Search only: the requested visible-hit limit. */
  limit?: number;
};

/**
 * A task listing whose candidate set was decided during dispatch but whose
 * returned objects are built only *after* the operation's last asynchronous
 * instrumentation point (the fence seal), from one coherent state under the
 * Task writers' critical section — see
 * {@link ConnectAdapter.coherentTaskListOutput}.
 */
type CoherentTaskListPlan = {
  operation: "list_tasks";
  mode: "tasks";
  listId?: string;
  includeCompleted?: boolean;
  limit: number;
};

/**
 * A Task-list listing whose objects are built only *after* the operation's
 * last asynchronous instrumentation point (the seal), from one coherent state
 * under the Task writers' critical section — see
 * {@link ConnectAdapter.coherentTaskListsOutput}.
 */
type CoherentTaskListsPlan = {
  operation: "list_task_lists";
  mode: "lists";
};

type PreparedOutput =
  | Record<string, unknown>
  | CoherentReadPlan
  | CoherentTaskListPlan
  | CoherentTaskListsPlan;

/**
 * `CoherentReadPlan` is the only dispatched value carrying these keys: every
 * other response is a plain record built by the adapter itself.
 */
function isCoherentReadPlan(value: PreparedOutput): value is CoherentReadPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    "mode" in value &&
    "noteIds" in value
  );
}

/** `CoherentTaskListPlan` is discriminated by its `mode`. */
function isCoherentTaskListPlan(
  value: PreparedOutput
): value is CoherentTaskListPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    "mode" in value &&
    value.mode === "tasks" &&
    "limit" in value
  );
}

/** `CoherentTaskListsPlan` is discriminated by its `mode`/`operation`. */
function isCoherentTaskListsPlan(
  value: PreparedOutput
): value is CoherentTaskListsPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    "mode" in value &&
    value.mode === "lists" &&
    "operation" in value &&
    value.operation === "list_task_lists"
  );
}

function isLockedContent(content: NoteContentRow | undefined): boolean {
  return content?.locked === true;
}

/**
 * The exact, deterministic title normalization the note pipeline applies to a
 * caller-supplied title (`Notes.addUnsafe`): newlines are stripped to a space.
 * Hashing the *normalized* value is what lets a receipt pin the title that is
 * actually stored, not the request string.
 */
function normalizeTitle(value: string): string {
  return value.replace(NEWLINE_STRIP_REGEX, " ");
}

/**
 * Constant fallback title for a Connect create whose body yields no headline.
 *
 * Deliberately a fixed literal (not the editor's generated title, which formats
 * the local clock and the user's title-format settings): the receipt records a
 * hash of the *exact* title that will be stored, so the value must be stable
 * across a crash + replay regardless of when the retry runs.
 */
const CONNECT_FALLBACK_TITLE = "Untitled";

type VerifyVerdict<T> =
  | { kind: "applied"; result: T }
  | { kind: "not_applied" }
  | { kind: "ambiguous" };

interface MutationImpl<T extends Record<string, unknown>> {
  /** Payload fingerprint; must be identical across retries of the same request. */
  fingerprint: (fence: OperationFence) => Promise<string>;
  /**
   * Re-check the *current* permission and target scope of this request.
   *
   * Called before a fresh reservation, before a replay/recovery reads the
   * recorded outcome and before any verification touches stored content: a
   * revoked grant must never be able to read an outcome or private content.
   *
   * `record` is supplied on the replay/recovery paths. A `create_task`
   * authorize uses its `reservedId` to re-check the *stored record's* current
   * list/privacy — the request's own list is not enough, because the record may
   * have been moved or made private since it was written.
   */
  authorize: (
    fence: OperationFence,
    record?: JournalRecord
  ) => Promise<void>;
  /** Allocates the stable reserved id; only called for a fresh reservation. */
  createReservation: (
    fence: OperationFence
  ) => Promise<{ reservedId: string; expect: Record<string, unknown> }>;
  verify: (
    record: JournalRecord,
    fence: OperationFence
  ) => Promise<VerifyVerdict<T>>;
  /**
   * Perform the mutation. `write.persisted` must be flipped to `true` at the
   * last possible moment before the first persistence call: everything the
   * implementation throws while it is still `false` is a *proven* pre-write
   * failure (safe to abort), while anything after it can have landed and must
   * be recovered by verification instead.
   */
  perform: (
    reservedId: string,
    fence: OperationFence,
    write: { persisted: boolean }
  ) => Promise<T>;
}

/**
 * VeyraN Connect core adapter.
 *
 * Safety model (see `docs/veyran-connect/CORE.md`):
 *  - grants are immutable snapshots with a generation fence; every await is
 *    revalidated against the live signed-in account;
 *  - every mutation takes a stable `operationId` and a bounded payload
 *    fingerprint, reserved durably under a database-scoped mutex;
 *  - note/task guarded writes execute inside the shared domain mutex, so an
 *    expected-revision string (content + metadata fingerprint) is checked at
 *    the exact point of the write.
 */
export class ConnectAdapter implements FenceHost {
  closed = false;
  locked = false;
  generation = 0;
  onFenceStep?: (label: string) => Promise<void>;
  private grants?: GrantSnapshot;
  private readonly journal: IdempotencyJournal;

  constructor(
    private readonly db: Database,
    options: ConnectAdapterOptions = {}
  ) {
    // The journal bound must be a positive finite integer *within a documented
    // upper bound*: `NaN`, `0`, negatives or `Infinity` would silently disable
    // the fail-closed capacity check (`count() >= NaN` is never true), and an
    // enormous value would turn the only backpressure into "grow forever", so
    // they are rejected here rather than accepted as a "no limit" bypass.
    const maxJournalEntries = options.maxJournalEntries;
    if (
      maxJournalEntries !== undefined &&
      (!Number.isInteger(maxJournalEntries) ||
        maxJournalEntries <= 0 ||
        maxJournalEntries > MAX_JOURNAL_CAPACITY)
    )
      throw new ConnectError("INVALID_INPUT");
    this.journal = new IdempotencyJournal(db, maxJournalEntries ?? 1000);
    this.onFenceStep = options.instrumentation?.onStep;
  }

  async resolveAccountId(): Promise<string | undefined> {
    const user = await this.db.user.getUser();
    return user?.id;
  }

  migrationsRequired(): boolean {
    return this.db.migrations.required();
  }

  /**
   * Install grants for the currently signed-in account. Snapshots/deduplicates
   * the ids and increments the generation, invalidating in-flight operations.
   *
   * Reading the signed-in account is asynchronous, so the account id is
   * resolved twice and the adapter state (closed/locked/generation) is
   * revalidated on both sides of every await: grants must never be installed
   * for an account that was switched, logged out or locked mid-call.
   */
  async setGrants(input: ConnectGrantsInput): Promise<number> {
    if (this.closed) throw new ConnectError("ADAPTER_CLOSED");
    if (this.locked) throw new ConnectError("ADAPTER_LOCKED");
    if (!input || typeof input.accountId !== "string")
      throw new ConnectError("DENIED");

    const generation = this.generation;
    const first = await this.resolveAccountId();
    this.assertGrantsInstallable(generation);
    const confirmed = await this.resolveAccountId();
    this.assertGrantsInstallable(generation);

    if (!first || !confirmed) throw new ConnectError("DENIED");
    if (first !== confirmed) throw new ConnectError("SESSION_CHANGED");
    if (input.accountId !== confirmed) throw new ConnectError("DENIED");

    const snapshot = new GrantSnapshot({ ...input, accountId: confirmed });
    this.grants = snapshot;
    this.generation += 1;
    return this.generation;
  }

  private assertGrantsInstallable(generation: number): void {
    if (this.closed) throw new ConnectError("ADAPTER_CLOSED");
    if (this.locked) throw new ConnectError("ADAPTER_LOCKED");
    if (this.generation !== generation)
      throw new ConnectError("GRANTS_CHANGED");
  }

  /** Revoke all grants and invalidate in-flight operations. */
  clearGrants(): void {
    this.grants = undefined;
    this.generation += 1;
  }

  lock(): void {
    this.locked = true;
    this.generation += 1;
  }

  unlock(): void {
    if (!this.closed) this.locked = false;
  }

  close(): void {
    this.closed = true;
    this.locked = true;
    this.grants = undefined;
    this.generation += 1;
  }

  private assertUsable(): void {
    if (this.closed) throw new ConnectError("ADAPTER_CLOSED");
    if (this.locked) throw new ConnectError("ADAPTER_LOCKED");
    if (this.migrationsRequired())
      throw new ConnectError("MIGRATION_IN_PROGRESS");
  }

  private currentGrants(): GrantSnapshot {
    if (!this.grants) throw new ConnectError("NOT_AUTHORIZED");
    return this.grants;
  }

  private requireGrant(flag: boolean): void {
    if (!flag) throw new ConnectError("NOT_AUTHORIZED");
  }

  /**
   * Capture the immutable starting account + grants generation for one
   * operation.
   *
   * The grants snapshot and the generation are captured *before* the account
   * read and revalidated *after* it: grants installed, cleared or reinstalled
   * while that read was suspended must not become the baseline of a request
   * that started earlier (that would authorize an old operation under new
   * grants). The account id is always re-resolved from the persisted user row,
   * so logout, an account switch — including A→B→A — or a lock/generation
   * change denies the operation instead of being absorbed.
   */
  private async captureFence(hostAssert?: HostAssert): Promise<OperationFence> {
    this.assertUsable();
    const generation = this.generation;
    const grants = this.grants;
    const accountId = await this.resolveAccountId();
    this.assertGrantsInstallable(generation);
    // No signed-in account is `DENIED`. A signed-in account with *no* grants
    // installed (never installed or cleared) is a pure authorization failure:
    // there are no active grants that permit the operation, exactly like a
    // scope miss on the replay/resume path — the account itself is available,
    // the operation simply is not authorized.
    if (!accountId) throw new ConnectError("DENIED");
    if (!grants) throw new ConnectError("NOT_AUTHORIZED");
    if (grants.accountId !== accountId) throw new ConnectError("DENIED");
    // The snapshot this request started under must still be the installed one:
    // grants cleared and reinstalled while the account was read are *new*
    // grants and must not authorize an operation that began before them.
    if (this.grants !== grants) throw new ConnectError("GRANTS_CHANGED");
    return new OperationFence(this, generation, accountId, hostAssert);
  }

  /**
   * Execute one bounded operation.
   *
   * `hostContext` is the optional, trusted per-invocation execution context
   * (see {@link ConnectHostContext}). It is never part of the wire request and
   * never stored on the adapter: this public method parses the request and
   * validates+snapshots the context exactly once, before the first `await`, and
   * threads the frozen snapshot into the private bounded method as a
   * per-invocation predicate (and, for note writes, as the note-write session
   * id). After the bounded method returns, ownership is re-asserted once more on
   * that same snapshot, synchronously, immediately before the value crosses back
   * to the caller. Callers that pass no context are byte-for-byte unchanged.
   */
  async execute(
    request: unknown,
    hostContext?: ConnectHostContext
  ): Promise<unknown> {
    // The bounded error surface is a hard boundary: no raw error (SQL text,
    // stored content, a `TypeError` from a bug deep in the pipeline) may ever
    // escape the adapter. Receipt decisions are made inside `runMutation`
    // *before* an error propagates here, so converting the escaped value to a
    // static `ConnectError` cannot strand a durable receipt.
    try {
      // Parse the request and take the immutable host-context snapshot exactly
      // once, here in the *public* boundary and before the first `await`. The
      // validated request and the frozen snapshot — never the caller's mutable
      // record — are threaded into the private bounded method, which never
      // renormalizes them: every assertion below, including this one, observes
      // the one identity validated at entry.
      const parsed = requestSchema.safeParse(request);
      if (!parsed.success) throw new ConnectError("INVALID_INPUT");
      const context = normalizeHostContext(hostContext, parsed.data);
      const result = await this.executeBounded(parsed.data, context);
      // Final public-boundary assertion. The bounded method re-asserts ownership
      // in its own continuation immediately before it returns, but that value
      // still crosses one more asynchronous boundary (this `await`) before it
      // reaches the caller. Re-assert the *same entry snapshot* synchronously in
      // this continuation — no `await`/`then` runs between this check and the
      // return — so a context revoked after the bounded method finished cannot
      // leak a previously authorized object to the caller.
      if (context) assertHostCurrent(context.assertCurrent);
      return result;
    } catch (error) {
      if (isConnectError(error)) throw error;
      throw new ConnectError("INVALID_INPUT");
    }
  }

  private async executeBounded(
    request: ConnectRequest,
    context?: HostContextSnapshot
  ): Promise<unknown> {
    // `status` is the one metadata operation that stays callable while locked:
    // it reports a truthful, content-free blocked state instead of throwing
    // `ADAPTER_LOCKED`. It still revalidates the account and grants generation
    // exactly like every other operation.
    if (request.operation === "status") {
      // Entry assertion, then a second one inside `executeStatus` after its
      // account read — before any status content is returned.
      if (context) assertHostCurrent(context.assertCurrent);
      const status = await this.executeStatus(context?.assertCurrent);
      // The account read inside `executeStatus` is a suspension point after its
      // inner assertion: re-assert ownership in *this* continuation, immediately
      // before the status is parsed and returned, so a context revoked while the
      // operation was suspended cannot leak a status object.
      if (context) assertHostCurrent(context.assertCurrent);
      const checkedStatus = responseSchema.safeParse(status);
      if (!checkedStatus.success) throw new ConnectError("INVALID_INPUT");
      return checkedStatus.data;
    }
    // Entry assertion: synchronous, before `captureFence`'s account read and
    // before any other await, so a stale context is denied before the operation
    // can touch persistence.
    if (context) assertHostCurrent(context.assertCurrent);
    const fence = await this.captureFence(context?.assertCurrent);
    // Admission assertion: `captureFence` suspended on the account read, so
    // ownership is re-checked synchronously *before* dispatch — a context
    // revoked during that read is denied before any operation-specific side
    // effect. This reuses the already-captured predicate (no extra account I/O)
    // and no-ops for callers without a context.
    if (context) assertHostCurrent(context.assertCurrent);
    const prepared = await this.dispatch(
      fence,
      request,
      context?.sessionId,
      context?.requireCanonicalContent === true
    );
    // The seal is the *last* asynchronous instrumentation point of this
    // operation. Anything that changes the stored state or the adapter state
    // while it is suspended (a test hook included) must not be able to leave a
    // previously authorized object in the output, so the final objects of a
    // read are built only after it, from one coherent state.
    await fence.seal();
    const output = await this.finalizeOutput(fence, prepared);
    // Final assertion in the same continuation: `finalizeOutput` may resume
    // after the mutex/domain-write release and its inner checks, so ownership is
    // re-asserted synchronously immediately before the output is parsed and
    // returned — nothing runs between this check and the return.
    if (context) assertHostCurrent(context.assertCurrent);
    const checked = responseSchema.safeParse(output);
    if (!checked.success) throw new ConnectError("INVALID_INPUT");
    return checked.data;
  }

  /**
   * Turn the dispatched value into the returned response.
   *
   * Mutations and plain list responses are already final (they carry ids and
   * ids' metadata only, and every mutation is verified against the stored
   * record by the receipt logic). A note read and a task listing are *not*:
   * their objects are rebuilt here, after the seal, from one coherent state
   * inside the corresponding writer's critical section.
   */
  private async finalizeOutput(
    fence: OperationFence,
    prepared: PreparedOutput
  ): Promise<Record<string, unknown>> {
    if (isCoherentReadPlan(prepared))
      return this.coherentNoteOutput(fence, prepared);
    if (isCoherentTaskListPlan(prepared))
      return this.coherentTaskListOutput(fence, prepared);
    if (isCoherentTaskListsPlan(prepared))
      return this.coherentTaskListsOutput(fence);
    return prepared;
  }

  private async dispatch(
    fence: OperationFence,
    request: ConnectRequest,
    /**
     * Per-invocation host session id, valid only for the note mutations. It is
     * a local of this call — never adapter state — and is forwarded into the
     * actual note write only for this invocation.
     */
    sessionId?: string,
    /**
     * Per-invocation strict canonical-content mode (from the frozen host
     * snapshot). Only the content-bearing note mutations consume it; every
     * other operation ignores it. A local of this call — never adapter state.
     */
    requireCanonicalContent = false
  ): Promise<PreparedOutput> {
    switch (request.operation) {
      case "status":
        return this.opStatus(fence);
      case "list_notebooks":
        return this.opListNotebooks(fence);
      case "search_notes":
        return this.planSearchNotes(fence, request);
      case "get_note":
        return this.planGetNote(fence, request.noteId);
      case "list_task_lists":
        return this.opListTaskLists();
      case "list_tasks":
        return this.opListTasks(fence, request);
      case "create_note":
        return this.runMutation(
          fence,
          request,
          this.createNoteImpl(request, sessionId, requireCanonicalContent)
        );
      case "append_to_note":
        return this.runMutation(
          fence,
          request,
          this.noteWriteImpl(request, true, sessionId, requireCanonicalContent)
        );
      case "update_note":
        return this.runMutation(
          fence,
          request,
          this.noteWriteImpl(request, false, sessionId, requireCanonicalContent)
        );
      case "create_task":
        return this.runMutation(fence, request, this.createTaskImpl(request));
      case "update_task":
        return this.runMutation(
          fence,
          request,
          this.taskWriteImpl(request, false)
        );
      case "complete_task":
        return this.runMutation(
          fence,
          request,
          this.taskWriteImpl(request, true)
        );
    }
  }

  // ----------------------------------------------------------------- reads

  /**
   * Status read that is callable while locked.
   *
   * Mirrors `captureFence`'s account/generation revalidation (so an account
   * switch or grants clear+regrant during the account read is still denied),
   * but locks are *reported* as a truthful blocked state rather than thrown:
   * status carries only version, granted capabilities and non-sensitive
   * availability/pressure metadata, never ids, titles or read scope.
   */
  private async executeStatus(
    hostAssert?: HostAssert
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new ConnectError("ADAPTER_CLOSED");
    if (this.migrationsRequired())
      throw new ConnectError("MIGRATION_IN_PROGRESS");
    const generation = this.generation;
    const grants = this.grants;
    const accountId = await this.resolveAccountId();
    // Revalidate everything that could have changed across the account read.
    if (this.closed) throw new ConnectError("ADAPTER_CLOSED");
    if (this.generation !== generation)
      throw new ConnectError("GRANTS_CHANGED");
    if (this.migrationsRequired())
      throw new ConnectError("MIGRATION_IN_PROGRESS");
    if (!accountId) throw new ConnectError("DENIED");
    if (!grants) throw new ConnectError("NOT_AUTHORIZED");
    if (grants.accountId !== accountId) throw new ConnectError("DENIED");
    if (this.grants !== grants) throw new ConnectError("GRANTS_CHANGED");
    // The host ownership assertion runs again after the account read and before
    // the status content is built: a context that became stale while the
    // operation was suspended denies the output (including the locked report).
    if (hostAssert) assertHostCurrent(hostAssert);
    return this.buildStatus(grants);
  }

  private buildStatus(grants: GrantSnapshot): Record<string, unknown> {
    const available = !this.locked;
    return {
      operation: "status",
      version: 1,
      account: "signed_in",
      status: available ? "ready" : "locked",
      available,
      grantsGeneration: this.generation,
      capabilities: {
        read: grants.canRead,
        create: grants.canCreate,
        change: grants.canChange,
        task: grants.canTask
      },
      journal: {
        capacity: this.journal.capacity,
        count: this.journal.count()
      },
      sync: "unknown"
    };
  }

  private async opStatus(
    fence: OperationFence
  ): Promise<Record<string, unknown>> {
    const grants = this.currentGrants();
    await fence.assert();
    return this.buildStatus(grants);
  }

  private async opListNotebooks(
    fence: OperationFence
  ): Promise<Record<string, unknown>> {
    const grants = this.currentGrants();
    this.requireGrant(grants.canRead);
    const notebooks: { id: string; title: string }[] = [];
    let truncated = false;
    for (const id of grants.grantedNotebookIDs().sort()) {
      if (notebooks.length >= CONTENT_LIMITS.maxResponseItems) {
        truncated = true;
        break;
      }
      const notebook = await fence.step(
        "notebook",
        this.db.notebooks.notebook(id)
      );
      if (!notebook) continue;
      // `notebook()` already skips trash; a tombstone or a raw `localOnly`
      // flag must never reach the title output either.
      const rawNotebook = notebook as {
        deleted?: boolean;
        localOnly?: boolean;
      };
      if (rawNotebook.deleted || rawNotebook.localOnly) continue;
      const title = boundText(
        notebook.title,
        CONTENT_LIMITS.maxResponseTitleChars
      );
      if (title.truncated) truncated = true;
      notebooks.push({ id: notebook.id, title: title.value });
    }
    return {
      operation: "list_notebooks",
      notebooks,
      truncated,
      sync: "unknown"
    };
  }

  /**
   * True when the notebook row backing a notebook-scoped grant is *live*: it
   * still exists in the collection (tombstones are filtered by `notebook()`
   * and `collection.get`) and is neither trashed nor flagged `localOnly`. A
   * stale relation to a since-trashed or private notebook must not keep
   * authorizing its notes.
   */
  private isNotebookLive(notebook: {
    deleted?: boolean;
    localOnly?: boolean;
  }): boolean {
    return !notebook.deleted && !notebook.localOnly;
  }

  /**
   * Fenced existence + liveness read of a granted notebook.
   *
   * A notebook target is only usable when it still exists as a live,
   * externally shareable row: a missing id, a soft-deleted row, a trashed row
   * or (defensively) a `localOnly` flag must all answer the *same*
   * `NOT_AUTHORIZED` — a caller must not be able to tell "no such notebook"
   * from "not shareable" (no existence oracle).
   */
  private async assertNotebookShareable(
    notebookId: string,
    fence: OperationFence
  ): Promise<void> {
    const notebook = await fence.step(
      "notebook",
      this.db.notebooks.notebook(notebookId)
    );
    if (
      !notebook ||
      !this.isNotebookLive(
        notebook as { deleted?: boolean; localOnly?: boolean }
      )
    )
      throw new ConnectError("NOT_AUTHORIZED");
  }

  /**
   * A task list is a shareable target only while its *raw* settings row is not
   * `localOnly`. The raw column is the actual domain privacy marker the sync
   * layer carries; a granted id alone must never override it, and a
   * non-shareable list answers exactly like an out-of-scope one.
   */
  private assertListShareable(listId: string): void {
    if (this.db.taskLists.isLocalOnlyRecord(listId))
      throw new ConnectError("NOT_AUTHORIZED");
  }

  private async isNoteAuthorized(
    noteId: string,
    fence: OperationFence
  ): Promise<boolean> {
    const grants = this.currentGrants();
    // A *direct* note grant serves the note regardless of its notebook.
    if (grants.hasNote(noteId)) return true;
    const relations = await fence.step(
      "note-notebooks",
      this.db.relations.to({ id: noteId, type: "note" }, "notebook").get()
    );
    for (const relation of relations) {
      if (!grants.hasNotebook(relation.fromId)) continue;
      // Notebook membership only authorizes through a *live*, non-private
      // notebook, not merely a relation row.
      const live = await fence.step(
        "note-notebook",
        this.db.notebooks.notebook(relation.fromId).then((notebook) => {
          return notebook
            ? this.isNotebookLive(
                notebook as { deleted?: boolean; localOnly?: boolean }
              )
            : false;
        })
      );
      if (live) return true;
    }
    return false;
  }

  /**
   * Notebook-membership check without the test instrumentation hook.
   *
   * Used from inside the shared domain critical section, where `fence.step`
   * must not run (see {@link notesCurrent}); callers assert the fence
   * themselves immediately before and after.
   */
  private async isNoteAuthorizedBare(noteId: string): Promise<boolean> {
    const grants = this.currentGrants();
    if (grants.hasNote(noteId)) return true;
    const relations = await this.db.relations
      .to({ id: noteId, type: "note" }, "notebook")
      .get();
    for (const relation of relations) {
      if (!grants.hasNotebook(relation.fromId)) continue;
      const notebook = await this.db.notebooks.notebook(relation.fromId);
      if (
        notebook &&
        this.isNotebookLive(
          notebook as { deleted?: boolean; localOnly?: boolean }
        )
      )
        return true;
    }
    return false;
  }

  /**
   * Is `noteId` currently bound to `notebookId` (live relation)?
   *
   * Bare (no `fence.step`): called from inside the shared domain critical
   * section, where the instrumentation hook must not run. The caller asserts
   * the fence itself immediately after.
   */
  private async isNoteInNotebookBare(
    notebookId: string,
    noteId: string
  ): Promise<boolean> {
    const relations = await this.db.relations
      .to({ id: noteId, type: "note" }, "notebook")
      .get();
    return relations.some((relation) => relation.fromId === notebookId);
  }

  /**
   * Pre-checks + candidate selection for `search_notes`.
   *
   * The candidate set comes from one *bounded* SQL query
   * ({@link Lookup.boundedNoteIds}): the granted note/notebook id arrays are
   * passed as JSON parameters expanded with `json_each`, eligibility (scope,
   * live notebook, current body, privacy) is applied before matching/ranking,
   * the content FTS is tied to the note's current `contentId`, and the result
   * is cut to `limit + 1` ids. The adapter therefore never materializes the
   * authorized id set into an `IN (...)` list nor fetches every matching row.
   *
   * The instrumented reads here only confirm the candidates are still live and
   * authorized; they never produce the returned objects, because a later hit's
   * read (or any other await) can invalidate an earlier hit. The response is
   * built from one coherent state in {@link coherentNoteOutput}.
   *
   * The whole `limit + 1` candidate window is carried into the plan: `truncated`
   * must be derived from the *final* visible set inside the domain-locked
   * rebuild, so a candidate that is (or becomes) hidden — live revocation,
   * local-only, vaulted, missing body or a notebook that was trashed — can
   * neither consume a visible slot nor make a complete response look truncated.
   */
  private async planSearchNotes(
    fence: OperationFence,
    request: { query: string; limit?: number }
  ): Promise<CoherentReadPlan> {
    const grants = this.currentGrants();
    this.requireGrant(grants.canRead);
    const limit = Math.min(
      request.limit ?? CONTENT_LIMITS.defaultSearchResults,
      CONTENT_LIMITS.maxSearchResults,
      CONTENT_LIMITS.maxResponseItems
    );
    const candidates = await fence.step(
      "search",
      this.db.lookup.boundedNoteIds(request.query, {
        noteIds: grants.grantedNoteIDs(),
        notebookIds: grants.grantedNotebookIDs(),
        limit: limit + 1
      })
    );
    if (!candidates.length)
      return { operation: "search_notes", mode: "search", noteIds: [], limit };

    // The eligibility narrowed by SQL is a snapshot: re-read the live note and
    // its *current* body for every candidate here (the coherent rebuild
    // re-checks this again after the seal). A hidden candidate is skipped — but
    // it is *kept in the plan* so that the final rebuild can still see whether
    // an extra visible hit existed behind it.
    const seen = new Set<string>();
    for (const noteId of candidates) {
      if (seen.has(noteId)) continue;
      seen.add(noteId);
      const note = await fence.step("note", this.db.notes.note(noteId));
      if (!note || note.localOnly) continue;
      const content = await fence.step(
        "content",
        this.readContentRow(noteId, note)
      );
      // A match whose body cannot be served is not a usable result: locked
      // (vaulted) and body-less rows are skipped instead of being reported as
      // a plaintext note.
      if (!content || isLockedContent(content) || content.localOnly) continue;
      // The scope this search was built from is a snapshot, not a live
      // authorization: a note that left its granted notebook while the body was
      // being read must be detected (the rebuild re-checks it definitively).
      await this.isNoteAuthorized(noteId, fence);
    }
    return {
      operation: "search_notes",
      mode: "search",
      noteIds: candidates,
      limit
    };
  }

  /**
   * Pre-checks for `get_note`.
   *
   * Authorization is decided from the grant snapshot (and, for
   * notebook-granted notes, the relation table) *before* any note row or
   * content is read: an unauthorized id must never even be fetched (the content
   * read also pre-processes/persists block ids as a side effect). The body that
   * is actually returned comes from the coherent re-read in
   * {@link coherentNoteOutput}.
   */
  private async planGetNote(
    fence: OperationFence,
    noteId: string
  ): Promise<CoherentReadPlan> {
    const grants = this.currentGrants();
    this.requireGrant(grants.canRead);
    if (!(await this.isNoteAuthorized(noteId, fence)))
      throw new ConnectError("NOT_AUTHORIZED");

    const state = await this.readNoteState(noteId, fence);
    if (!state.note) {
      if (await fence.step("trashed", this.db.notes.trashed(noteId)))
        throw new ConnectError("NOTE_TRASHED");
      throw new ConnectError("NOTE_NOT_FOUND");
    }
    // Local-only notes are never served through the external API. A note whose
    // body row is missing or not stored as plaintext is *not* an empty note:
    // reporting a canonical empty document would be a false, writable-looking
    // plaintext view, so both cases fail closed.
    this.assertExternallyVisible(state.note, state.content);
    if (isLockedContent(state.content)) throw new ConnectError("NOTE_LOCKED");
    if (!state.content || typeof state.content.data !== "string")
      throw new ConnectError("NOTE_LOCKED");
    // The authorization decision above was made before the body read, and the
    // notebook membership that may have granted it is live state.
    if (!(await this.isNoteAuthorized(noteId, fence)))
      throw new ConnectError("NOT_AUTHORIZED");
    return { operation: "get_note", mode: "single", noteIds: [noteId] };
  }

  /**
   * Build the *final* objects of a note read.
   *
   * Everything the response may contain is re-read inside the shared domain
   * write critical section, which every note/content/relation writer takes
   * (editor `Notes.add`, vault lock/unlock, trash transitions,
   * readonly/localOnly/archive/pin changes, notebook binding, permanent
   * removal and sync's note/content/relation merges). Inside that section the
   * stored rows cannot change between the reads and the construction of the
   * response, so every returned object is reauthorized against one state:
   * current metadata (localOnly), current body visibility (vaulted/locked) and
   * current notebook binding. An early read that is invalidated by a *later*
   * await can therefore no longer be returned, and a hit that lost access is
   * dropped (search) or denies the whole request (`get_note`).
   *
   * The reads are deliberately *bare* (`db.notes.note`, `readContentRow`,
   * `relations`): the test instrumentation hook must never run while the domain
   * lock is held, because a hook that mutates note state would deadlock on that
   * same lock. The last step is a purely synchronous fence check: after it
   * nothing awaits, so nothing can invalidate the objects before they are
   * returned.
   */
  private async coherentNoteOutput(
    fence: OperationFence,
    plan: CoherentReadPlan
  ): Promise<Record<string, unknown>> {
    return withDomainWrite(this.db, async () => {
      const results: {
        noteId: string;
        title: string;
        url: string;
        revision: string;
      }[] = [];
      let output: Record<string, unknown>;

      if (plan.mode === "search") {
        // The requested `limit` bounds the returned *visible* hits and
        // `truncated` is derived from the final, domain-locked visible set
        // only: the plan carries the whole `limit + 1` candidate window, so an
        // extra *visible* hit behind the cut is detectable, while a candidate
        // that the SQL snapshot called a match but that is now hidden (live
        // revocation, local-only, vaulted, body-less) can neither consume a
        // visible slot nor make a complete response look truncated.
        const limit = plan.limit ?? plan.noteIds.length;
        let visibleCount = 0;
        let truncated = false;
        const seen = new Set<string>();
        for (const noteId of plan.noteIds) {
          if (seen.has(noteId)) continue;
          seen.add(noteId);
          const note = await this.db.notes.note(noteId);
          const content = note
            ? await this.readContentRow(noteId, note)
            : undefined;
          if (!note || !content || isLockedContent(content)) continue;
          if (note.localOnly || content.localOnly) continue;
          if (!(await this.isNoteAuthorizedBare(noteId))) continue;
          visibleCount++;
          const title = boundText(
            note.title,
            CONTENT_LIMITS.maxResponseTitleChars
          );
          // A stored title longer than the bound is still a cut response, but
          // only for a hit that is actually returned.
          if (visibleCount > limit) {
            truncated = true;
            continue;
          }
          if (title.truncated) truncated = true;
          results.push({
            noteId,
            title: title.value,
            // Actual note route with the id preserved verbatim (no re-encoding).
            url: `nn://note/${noteId}`,
            revision: noteRevision(note, content)
          });
        }
        output = {
          operation: "search_notes",
          results,
          truncated,
          sync: "unknown"
        };
      } else {
        const noteId = plan.noteIds[0];
        const note = await this.db.notes.note(noteId);
        if (!note) throw new ConnectError("NOTE_NOT_FOUND");
        const content = await this.readContentRow(noteId, note);
        this.assertExternallyVisible(note, content);
        if (isLockedContent(content)) throw new ConnectError("NOTE_LOCKED");
        if (!content || typeof content.data !== "string")
          throw new ConnectError("NOTE_LOCKED");
        if (!(await this.isNoteAuthorizedBare(noteId)))
          throw new ConnectError("NOT_AUTHORIZED");
        const title = boundText(
          note.title,
          CONTENT_LIMITS.maxResponseTitleChars
        );
        output = {
          operation: "get_note",
          noteId,
          title: title.value,
          // Actual note route with the id preserved verbatim (no re-encoding).
          url: `nn://note/${noteId}`,
          // Never a partial body: an oversized stored body fails closed.
          content: boundContent(content.data),
          format: "tiptap",
          revision: noteRevision(note, content),
          truncated: title.truncated,
          sync: "unknown"
        };
      }

      // Last await *inside* the critical section: re-read the persisted
      // signed-in account row and require it to be the account this operation
      // was captured under. A logout or account switch that rewrote `kv.user`
      // while the objects were being assembled must deny the output; the
      // synchronous fence check below (closed/locked/generation/migrations)
      // deliberately does not observe it.
      const liveAccountId = await this.resolveAccountId();
      if (!liveAccountId) throw new ConnectError("DENIED");
      if (liveAccountId !== fence.accountId)
        throw new ConnectError("SESSION_CHANGED");
      // Synchronous final check: closed/locked/grants generation/migrations
      // must still be the state this operation was authorized under. No
      // `await` may follow it inside this section.
      fence.assertSync();
      return output;
    });
  }

  private async opListTaskLists(): Promise<CoherentTaskListsPlan> {
    const grants = this.currentGrants();
    this.requireGrant(grants.canTask);
    // The *objects* are deliberately not built here: they are rebuilt after the
    // seal, under the Task writers' critical section, so a list rename, delete
    // or raw-privacy toggle that lands at the seal cannot leak a stale name or
    // drop a still-authorized list (see `coherentTaskListsOutput`).
    return { operation: "list_task_lists", mode: "lists" };
  }

  /**
   * Build the *final* Task-list listing.
   *
   * Called only after the operation's last asynchronous instrumentation point
   * (the seal). Candidate ids, existence, raw list privacy and names are all
   * re-read inside the Task writers' critical section (the same database-scoped
   * lease every list/Task write takes), with the *live* grants, so a rename,
   * delete, create or privacy toggle that lands during the seal is reflected in
   * exactly one coherent state. The virtual default list is handled explicitly:
   * `TaskLists.list()` synthesizes it when it was never persisted (a pure read,
   * no write). The reads are bare (no `fence.step`) because the instrumentation
   * hook must never run while the lock is held. The section ends with a bare
   * account re-read followed by a synchronous fence check, with no `await` in
   * between.
   */
  private async coherentTaskListsOutput(
    fence: OperationFence
  ): Promise<Record<string, unknown>> {
    const listed = await this.db.tasks.runExclusiveTaskWrite(async () => {
      const grants = this.currentGrants();
      // Includes the synthesized (virtual) default list, so a granted default
      // is listed even before it is ever materialized.
      const lists = await this.db.taskLists.list();
      // Truncation must be decided from the *authorized* result only: hidden
      // lists must not make a complete, fully returned response look truncated.
      // A list whose *raw* settings row is local-only is hidden even when its
      // parsed JSON record disagrees (the raw column is what sync carries).
      const authorizedLists = lists
        .filter((list) => grants.hasList(list.id))
        .filter((list) => !this.db.taskLists.isLocalOnlyRecord(list.id))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      let truncated =
        authorizedLists.length > CONTENT_LIMITS.maxResponseItems;
      const granted = authorizedLists
        .slice(0, CONTENT_LIMITS.maxResponseItems)
        .map((list) => {
          const name = boundText(
            list.name,
            CONTENT_LIMITS.maxResponseTitleChars
          );
          if (name.truncated) truncated = true;
          return { id: list.id, name: name.value };
        });
      // Last await inside the Task critical section: re-read the persisted
      // signed-in account and require it to match the captured account.
      const liveAccountId = await this.resolveAccountId();
      if (!liveAccountId) throw new ConnectError("DENIED");
      if (liveAccountId !== fence.accountId)
        throw new ConnectError("SESSION_CHANGED");
      // Synchronous final check: no `await` may follow it inside this section.
      fence.assertSync();
      return { granted, truncated };
    });
    return {
      operation: "list_task_lists",
      lists: listed.granted,
      truncated: listed.truncated,
      sync: "unknown"
    };
  }

  private async opListTasks(
    fence: OperationFence,
    request: { listId?: string; includeCompleted?: boolean; limit?: number }
  ): Promise<CoherentTaskListPlan> {
    const grants = this.currentGrants();
    this.requireGrant(grants.canTask);
    if (request.listId && !grants.hasList(request.listId))
      throw new ConnectError("NOT_AUTHORIZED");
    // Filtering `list_task_lists` is not enough: a raw private list must not
    // become readable by listing its tasks by id.
    if (request.listId) this.assertListShareable(request.listId);
    // The instrumented read is still the last asynchronous step *of dispatch*,
    // but it is deliberately not the last step of the operation: the seal
    // follows it, and the returned objects are built from the *current* records
    // only after that (see `coherentTaskListOutput`). Building them here would
    // let a seal hook that flips a listed Task local-only leave the previously
    // authorized private title in the response.
    await fence.step("tasks", Promise.resolve(this.db.tasks.listSync()));
    const limit = Math.min(
      request.limit ?? CONTENT_LIMITS.maxResponseItems,
      CONTENT_LIMITS.maxResponseItems
    );
    return {
      operation: "list_tasks",
      mode: "tasks",
      listId: request.listId,
      includeCompleted: request.includeCompleted,
      limit
    };
  }

  /**
   * Build the *final* objects of a task listing.
   *
   * Called only after the operation's last asynchronous instrumentation point
   * (the seal). The records are re-read inside the Task writers' critical
   * section (`mutationMutex → createMutex`, which every local Task write and
   * the sync merge take) and the fence is checked synchronously right before
   * they are returned, so a list move, a localOnly toggle or a delete that
   * lands during the seal cannot be reported from the stale snapshot. No
   * `await` runs between the last read and that synchronous check.
   */
  private async coherentTaskListOutput(
    fence: OperationFence,
    plan: CoherentTaskListPlan
  ): Promise<Record<string, unknown>> {
    const grants = this.currentGrants();
    const listed = await this.db.tasks.runExclusiveTaskWrite(async () => {
      const visible = this.db.tasks
        .listSync()
        .filter((task) => grants.hasList(task.listId))
        // Local-only tasks are never listed: both the parsed JSON flag and the
        // *raw* settings row are consulted (a legacy/foreign writer may have
        // set only one of them).
        .filter((task) => !task.localOnly)
        .filter((task) => !this.db.tasks.isLocalOnlyRecord(task.id))
        // A task in a raw private list must not leak through the list's tasks
        // either (the same raw marker `list_task_lists` hides).
        .filter((task) => !this.db.taskLists.isLocalOnlyRecord(task.listId))
        .filter((task) => (plan.listId ? task.listId === plan.listId : true))
        .filter((task) =>
          plan.includeCompleted === false ? !task.completed : true
        );
      let truncated = visible.length > plan.limit;
      const tasks = visible.slice(0, plan.limit).map((task) => {
        const title = boundText(
          task.title,
          CONTENT_LIMITS.maxResponseTitleChars
        );
        if (title.truncated) truncated = true;
        return {
          taskId: task.id,
          title: title.value,
          // Actual task route with the id preserved verbatim (no re-encoding).
          link: `veyran://task/${task.id}`,
          listId: task.listId,
          completed: task.completed,
          ...(task.dueDate ? { dueDate: task.dueDate } : {}),
          ...(task.dueTime ? { dueTime: task.dueTime } : {}),
          // Floating, device-local calendar schedule: the stored wall-clock
          // fields are returned as-is with no invented timezone argument.
          ...(task.reminderDate ? { reminderDate: task.reminderDate } : {}),
          ...(task.reminderTime ? { reminderTime: task.reminderTime } : {}),
          ...(typeof task.reminderAt === "number"
            ? { reminderAt: task.reminderAt }
            : {}),
          ...(typeof task.scheduleVersion === "number"
            ? { scheduleVersion: task.scheduleVersion }
            : {}),
          ...(task.recurrenceRule
            ? { recurrenceRule: task.recurrenceRule }
            : {}),
          flagged: task.flagged === true,
          ...(typeof task.urgent === "boolean" ? { urgent: task.urgent } : {}),
          priority: task.priority,
          revision: taskRevision(task)
        };
      });
      // Last await inside the Task critical section: re-read the persisted
      // signed-in account and require it to match the captured account. A
      // logout/switch that rewrote `kv.user` while the listing was assembled
      // must deny the output; the synchronous fence check below does not
      // observe it.
      const liveAccountId = await this.resolveAccountId();
      if (!liveAccountId) throw new ConnectError("DENIED");
      if (liveAccountId !== fence.accountId)
        throw new ConnectError("SESSION_CHANGED");
      // Synchronous final check: no `await` may follow it inside this section.
      fence.assertSync();
      return { tasks, total: visible.length, truncated };
    });
    return {
      operation: "list_tasks",
      tasks: listed.tasks,
      total: listed.total,
      truncated: listed.truncated,
      sync: "unknown"
    };
  }

  /**
   * Read the note's **current** body row, keyed by the note's own
   * `contentId`.
   *
   * `db.content.findByNoteId` selects an arbitrary row by `noteId` (a note can
   * have several historical content rows) and then runs the *mutating*
   * `readAndPreprocess` migration on whatever it picked. Neither is safe for an
   * external read: a stale, unlocked historical row could be served as the
   * current body, and the read could insert block ids into a row the note no
   * longer points at. This reads only the row the live note row references, via
   * the read-only `SQLCollection.get`, requires it to belong to this very note,
   * and leaves all failures (missing/deleted row, no `contentId`) to the
   * caller's fail-closed checks.
   *
   * The already-read `note` is passed where the caller has one, so no extra
   * note fetch (and no extra instrumentation step) happens before the target is
   * authorized.
   */
  private async readContentRow(
    noteId: string,
    note?: Note
  ): Promise<NoteContentRow | undefined> {
    const currentNote = note ?? (await this.db.notes.note(noteId));
    if (!currentNote || currentNote.id !== noteId) return undefined;
    const contentId = (currentNote as { contentId?: string }).contentId;
    if (typeof contentId !== "string" || !contentId) return undefined;
    const row = (await this.db.content.collection.get(contentId)) as
      | NoteContentRow
      | undefined;
    // `collection.get` already filters soft-deleted rows; the row must also be
    // the current body of *this* note (a renamed/foreign row fails closed).
    if (!row || (row as { noteId?: string }).noteId !== noteId) return undefined;
    return row;
  }

  private async readNoteState(
    noteId: string,
    fence: OperationFence
  ): Promise<NoteState> {
    const note = await fence.step("note", this.db.notes.note(noteId));
    if (!note) return {};
    const content = await fence.step(
      "content",
      this.readContentRow(noteId, note)
    );
    return { note, content, revision: noteRevision(note, content) };
  }

  // ------------------------------------------------------------- mutations

  private async runMutation<T extends Record<string, unknown>>(
    fence: OperationFence,
    request: { operation: string; operationId: string },
    impl: MutationImpl<T>
  ): Promise<T> {
    return dbMutex(this.db).runExclusive(async () => {
      await fence.assert();
      // Capability + target scope first, *before* the payload fingerprint
      // (which may convert/read private content) and before the durable receipt
      // is looked up. A revoked or out-of-scope request must fail as an
      // authorization failure — never as an `IDEMPOTENCY_CONFLICT` that reveals
      // that an `operationId` is already recorded, nor by converting a body the
      // caller is not allowed to touch.
      await impl.authorize(fence);
      const fingerprint = await impl.fingerprint(fence);
      const begin = await this.journal.begin({
        operationId: request.operationId,
        operation: request.operation,
        accountId: fence.accountId,
        fingerprint,
        createReservation: async () => {
          // Permission + target scope are re-checked *before* a reservation is
          // allocated (and therefore before any private content is read).
          await impl.authorize(fence);
          return impl.createReservation(fence);
        }
      });

      if (begin.kind === "replay") {
        const record = begin.record;
        // A revoked grant must not be able to read back a recorded outcome.
        // The reserved record's *current* scope/privacy is re-checked too: a
        // committed task whose list became private or left the grants must not
        // replay success.
        await impl.authorize(fence, record);
        if (record.state === "aborted")
          throw new ConnectError(
            (record.result?.error as ConnectErrorCode) ?? "IDEMPOTENCY_CONFLICT"
          );
        const result = record.result as T | undefined;
        if (!result) throw new ConnectError("IDEMPOTENCY_UNCERTAIN");
        await fence.assert();
        return result;
      }

      const record = begin.record;
      const reservedId = record.reservedId;

      if (begin.kind === "resume") {
        await impl.authorize(fence, record);
        const verdict = await this.safeVerify(impl, record, fence);
        if (verdict?.kind === "applied") {
          await fence.assert();
          await this.journal.commit(request.operationId, verdict.result);
          return verdict.result;
        }
        if (verdict?.kind === "ambiguous" || !verdict) {
          await this.journal.markUncertain(request.operationId);
          throw new ConnectError("IDEMPOTENCY_UNCERTAIN");
        }
        // Verification *proved* the mutation never landed, so a receipt that
        // was left uncertain by a previous attempt may be attempted again.
        await this.journal.reopen(request.operationId);
      }

      const write = { persisted: false };
      let result: T;
      try {
        result = await impl.perform(reservedId, fence, write);
      } catch (error) {
        if (!write.persisted) {
          // The implementation never reached its persistence point: this is a
          // *proven* pre-write failure, so a bounded Connect error may be
          // aborted and replayed deterministically. Unknown errors keep the
          // reservation (still retryable) instead of poisoning the receipt, and
          // are surfaced through the bounded static surface — a raw SQL/content
          // error must never escape.
          if (error instanceof ConnectError) {
            await this.journal.abort(request.operationId, error.code);
            throw error;
          }
          throw new ConnectError("INVALID_INPUT");
        }
        const verdict = await this.safeVerify(impl, record, fence);
        if (verdict?.kind === "applied") {
          // The write landed before the failure: acknowledge it instead of
          // reporting a failure that would strand durable data.
          await fence.assert();
          await this.journal.commit(request.operationId, verdict.result);
          return verdict.result;
        }
        if (verdict?.kind === "not_applied") {
          // Verification *proved* the mutation never landed. A bounded Connect
          // error is aborted (deterministic on replay); any other error keeps
          // the reservation recoverable and is normalized to the static
          // surface rather than leaked raw.
          if (error instanceof ConnectError) {
            await this.journal.abort(request.operationId, error.code);
            throw error;
          }
          throw new ConnectError("INVALID_INPUT");
        }
        // Unknown outcome: keep the receipt recoverable, never abort it.
        await this.journal.markUncertain(request.operationId);
        if (error instanceof ConnectError) throw error;
        throw new ConnectError("IDEMPOTENCY_UNCERTAIN");
      }

      // The write has landed. A fence failure now must not abort the receipt:
      // the mutation is durable and has to stay recoverable/uncertain.
      await fence.assert();
      await this.journal.commit(request.operationId, result);
      return result;
    });
  }

  /** Verification must never turn into an unhandled failure: fail closed. */
  private async safeVerify<T extends Record<string, unknown>>(
    impl: MutationImpl<T>,
    record: JournalRecord,
    fence: OperationFence
  ): Promise<VerifyVerdict<T> | undefined> {
    try {
      return await impl.verify(record, fence);
    } catch {
      return undefined;
    }
  }

  /** Convert + sanitize + insert block ids so content is stable on read. */
  private async prepareContent(
    format: ConnectContentFormat,
    content: string,
    /**
     * Controlled strict canonical-content mode (see
     * {@link ConnectHostContext.requireCanonicalContent}). When `true` the
     * returned body must be *exactly* the raw input: the sanitizer, the
     * detached block-id pre-processing and the actual persistence
     * post-processing must all be byte-stable fixed points of it. Otherwise
     * `UNSUPPORTED_CONTENT` is thrown before any caller can reserve or write.
     */
    strict = false
  ): Promise<string> {
    // Strict mode only ever accepts already-canonical TipTap HTML. A missing /
    // defaulted `markdown` (or `plaintext`) format is a conversion, not a
    // canonical body, so it is refused here rather than silently converted.
    if (strict && format !== "tiptap")
      throw new ConnectError("UNSUPPORTED_CONTENT");
    const html = toTiptapHtml(format, content);
    // Equality of the raw bytes to the sanitizer output: a strict body may not
    // be silently transformed and returned as an accepted replacement.
    if (strict && html !== content)
      throw new ConnectError("UNSUPPORTED_CONTENT");
    const draft = { type: "tiptap" as const, data: html };
    await this.db.content.preProcess(draft);
    if (strict) {
      // The detached pre-processing must be a fixed point too: a body whose
      // block ids would be (re)generated is not byte-stable.
      if (draft.type !== "tiptap" || draft.data !== html)
        throw new ConnectError("UNSUPPORTED_CONTENT");
      await this.assertPersistenceStable(draft.data);
    }
    return draft.data;
  }

  /**
   * Detached, write-free preflight for strict canonical content.
   *
   * Runs the *actual* content-type post-processing over the prospective
   * fragment — the same code `db.content.postProcess` runs for the body — with
   * a rejecting attachment-save callback, on a detached value, so a proposed
   * body whose bytes the real persistence pipeline would rewrite (for example
   * an `<img>` that `HTMLRewriter` reserializes to a self-closing tag, or a
   * remote/`nn://`/`data-hash` document that re-enters the rewriter) is
   * rejected as non-canonical. `Content.add` is the only writer that runs
   * `postProcess` on the final concatenated body, so a fragment the pure
   * preflight leaves byte-identical is persisted byte-identical.
   *
   * This calls neither `db.content.postProcess` nor the relation helpers and
   * makes no database or filesystem write: the attachment callback throws
   * instead of saving. Strict appends also pass the complete assembled body
   * through this detached preflight before a receipt is reserved.
   */
  private async assertPersistenceStable(html: string): Promise<void> {
    // Tiptap.postProcess catches attachment-saver errors and records a false
    // conversion result, so the callback alone is not a rejecting boundary.
    // Reject inline payloads explicitly before invoking the detached pipeline.
    if (containsInlineAttachmentData(html))
      throw new ConnectError("UNSUPPORTED_CONTENT");
    const content = await getContentFromData("tiptap", html);
    const result = await content.postProcess(async () => {
      throw new ConnectError("UNSUPPORTED_CONTENT");
    });
    if (typeof result.data !== "string" || result.data !== html)
      throw new ConnectError("UNSUPPORTED_CONTENT");
  }

  /**
   * Local-only rows are excluded from the external API entirely: they are
   * never returned, never searchable and never mutable, even when the grant
   * explicitly names their note/list/notebook. The check is a plain field test
   * so it can run at every boundary (reads, write guards) without extra awaits.
   */
  private assertExternallyVisible(
    note: Note | undefined,
    content: NoteContentRow | undefined
  ): void {
    if (note?.localOnly || content?.localOnly)
      throw new ConnectError("NOT_AUTHORIZED");
  }

  private assertNoteMutable(
    note: Note | undefined,
    content: NoteContent<false> | undefined
  ): asserts note is Note {
    if (!note) throw new ConnectError("NOTE_NOT_FOUND");
    this.assertExternallyVisible(note, content as NoteContentRow | undefined);
    if (isLockedContent(content)) throw new ConnectError("NOTE_LOCKED");
    if (note.readonly) throw new ConnectError("NOTE_READONLY");
    if (note.archived) throw new ConnectError("NOTE_ARCHIVED");
    if (note.dateDeleted || (note as { deleted?: boolean }).deleted)
      throw new ConnectError("NOTE_TRASHED");
  }

  /**
   * Guard for the notebook relation write of a created note.
   *
   * It runs *inside* the shared domain write lock (`Notes.addToNotebookGuarded`
   * calls it after the relation read that decides whether the binding is
   * missing and immediately before the relation write), so all of the
   * following is revalidated at the exact point of the write — including after
   * an unbounded wait on the domain mutex: the live fence, the notebook's
   * presence in the *current* grants and the note's current mutability/public
   * visibility. A revocation that lands during the wait denies the relation
   * instead of racing past it.
   *
   * The note's *current* notebook membership is deliberately not part of this
   * check: the relation being written is exactly that membership, so requiring
   * it would make the recovery path (`verify` restoring a binding a crash
   * dropped) impossible. The note itself is pinned by id (and, on recovery, by
   * the verified body hash) — never by a request-supplied target.
   *
   * The reads are bare (no `fence.step`): the instrumentation hook must not run
   * while the domain lock is held.
   */
  private async notebookBindingGuard(
    notebookId: string,
    noteId: string,
    fence: OperationFence
  ): Promise<void> {
    await fence.assert();
    const grants = this.currentGrants();
    if (!grants.hasNotebook(notebookId))
      throw new ConnectError("NOT_AUTHORIZED");
    // The notebook must still be a *live*, externally shareable target at the
    // exact point of the relation write: a granted notebook that was trashed,
    // deleted or (defensively) flagged local-only while the binding waited on
    // the domain mutex must not receive the note.
    const notebook = await this.db.notebooks.notebook(notebookId);
    if (
      !notebook ||
      !this.isNotebookLive(
        notebook as { deleted?: boolean; localOnly?: boolean }
      )
    )
      throw new ConnectError("NOT_AUTHORIZED");
    const note = await this.db.notes.note(noteId);
    if (!note) throw new ConnectError("NOTE_NOT_FOUND");
    const content = await this.readContentRow(noteId, note);
    this.assertNoteMutable(note, content);
    await fence.assert();
  }

  /**
   * The exact title a Connect `create_note` will store.
   *
   * An explicit title is used as-is (after the pipeline's newline
   * normalization). A missing/blank title is *not* left to the editor's
   * generated-title path — that formats the local clock and the user's
   * title-format settings, so the stored string is unpredictable at reservation
   * time and a crash+replay cannot be verified. Instead the adapter derives a
   * deterministic, Connect-specific title from the *already sanitized* body
   * (`Tiptap.toTitle()`, bounded to the request title bound) with a constant
   * fallback, and passes it as an explicit title into the ordinary `Notes.add`.
   * The ordinary editor/`Notes.add` behavior for a missing title is unchanged.
   */
  private async connectCreateTitle(
    requestTitle: string | undefined,
    html: string
  ): Promise<string> {
    const explicit =
      typeof requestTitle === "string" ? normalizeTitle(requestTitle) : "";
    if (explicit.trim()) return explicit;
    let derived = "";
    try {
      const parsed = await getContentFromData("tiptap", html);
      derived = normalizeTitle(String(parsed.toTitle() ?? "")).trim();
    } catch {
      // A body that cannot be parsed has no headline; fall back to the constant.
      derived = "";
    }
    return boundText(
      derived || CONNECT_FALLBACK_TITLE,
      CONTENT_LIMITS.maxTitleChars
    ).value;
  }

  private createNoteImpl(
    request: ConnectRequest & { operation: "create_note" },
    /** Per-invocation host session id (never from the wire request). */
    sessionId?: string,
    /**
     * Per-invocation strict canonical-content mode (never from the wire
     * request). The body is prepared and, in strict mode, validated as a
     * byte-stable fixed point exactly once — in `fingerprint`, i.e. before
     * `journal.begin` — and that same prepared value is reused by the
     * reservation, the write and the receipt.
     */
    requireCanonicalContent = false
  ): MutationImpl<Record<string, unknown>> {
    const format = (request.format ?? "markdown") as ConnectContentFormat;
    let html = "";
    // The exact title this request will store. Resolved in `fingerprint`
    // (before the reservation) and defensively re-resolved if it is ever
    // missing, so the reservation, the write and the receipt all hash the same
    // value.
    let resolvedTitle: string | undefined;
    return {
      authorize: async (fence) => {
        const grants = this.currentGrants();
        this.requireGrant(grants.canCreate);
        // The notebook target is verified as a *live, externally shareable*
        // row here — before the payload fingerprint (which converts the body)
        // and before a durable receipt is reserved — and again inside the
        // guarded binding on recovery. A granted-but-trashed/deleted/private
        // notebook is denied with no receipt and no conversion.
        if (request.notebookId) {
          if (!grants.hasNotebook(request.notebookId))
            throw new ConnectError("NOT_AUTHORIZED");
          await this.assertNotebookShareable(request.notebookId, fence);
        }
      },
      fingerprint: async () => {
        html = await this.prepareContent(
          format,
          request.content,
          requireCanonicalContent
        );
        resolvedTitle = await this.connectCreateTitle(request.title, html);
        // The fingerprint stays the *original request* identity (the raw
        // title, not the derived one), so a replay after a crash matches the
        // recorded reservation deterministically.
        const fingerprint = fingerprintOf({
          operation: request.operation,
          notebookId: request.notebookId ?? null,
          title: request.title ?? null,
          format,
          contentHash: noteContentHash("tiptap", html)
        });
        return hostModeFingerprint(fingerprint, requireCanonicalContent);
      },
      createReservation: async () => {
        const title =
          resolvedTitle ?? (await this.connectCreateTitle(request.title, html));
        return {
          reservedId: getId(),
          // The receipt is verification metadata, not a second copy of the
          // note: the title is recorded as the hash of the *exact* string the
          // write stores, so a synced receipt cannot leak a plaintext title
          // (the body is covered by `contentHash` the same way) and verification
          // can pin the title without guessing a generated/prior mode.
          expect: {
            kind: "note_create",
            contentHash: noteContentHash("tiptap", html),
            titleHash: hashId(title),
            notebookId: request.notebookId ?? null
          }
        };
      },
      verify: async (record, fence) => {
        const note = await fence.step(
          "verify-note",
          this.db.notes.note(record.reservedId)
        );
        if (!note) return { kind: "not_applied" };
        const content = await fence.step(
          "verify-content",
          this.readContentRow(record.reservedId, note)
        );
        const expect = record.expect ?? {};
        if (
          !content ||
          noteContentHash(content.type, content.data) !== expect.contentHash
        )
          // A different object with the reserved id: never touch it.
          return { kind: "ambiguous" };
        // The receipt pins the *exact* title by hash. A receipt without a title
        // hash (a hand-written recovery fixture that never carried one) imposes
        // no title constraint. The previously-authored plaintext `title` and
        // mode-based `titleMode`/`priorTitle` shapes were removed before first
        // release (no receipt in the wild carries them), so no plaintext title
        // is ever compared against — or stored in — a receipt.
        if (typeof expect.titleHash === "string") {
          if (hashId(note.title) !== expect.titleHash)
            return { kind: "ambiguous" };
        }

        const notebookId =
          typeof expect.notebookId === "string" ? expect.notebookId : undefined;
        if (notebookId) {
          // The body landed but the required notebook binding may not have
          // (crash between the two writes). Restore exactly that relation —
          // never any other object — and only while the current grants allow
          // it; otherwise stay ambiguous (uncertain) instead of reporting a
          // success the caller cannot rely on.
          const isBound = async () =>
            (
              await this.db.relations
                .to({ id: record.reservedId, type: "note" }, "notebook")
                .get()
            ).some((relation) => relation.fromId === notebookId);
          if (!(await fence.step("verify-binding", isBound()))) {
            const grants = this.currentGrants();
            if (!grants.hasNotebook(notebookId)) return { kind: "ambiguous" };
            const notebook = await fence.step(
              "verify-notebook",
              this.db.notebooks.notebook(notebookId)
            );
            if (!notebook) return { kind: "ambiguous" };
            // Restore exactly the recorded relation through the *guarded*
            // binding: the relation write shares the domain lock with every
            // other note writer, and the guard revalidates fence/scope/note
            // state after that (unbounded) wait. A denial leaves the receipt
            // reserved/uncertain (repairable), never aborted: the note body is
            // already durable and must stay recoverable.
            await this.db.notes.addToNotebookGuarded(
              notebookId,
              record.reservedId,
              async () =>
                this.notebookBindingGuard(notebookId, record.reservedId, fence)
            );
            if (!(await fence.step("verify-binding", isBound())))
              return { kind: "ambiguous" };
          }
        }

        return {
          kind: "applied",
          result: this.noteResult(
            request.operationId,
            "create_note",
            record.reservedId,
            note,
            content
          )
        };
      },
      perform: async (reservedId, fence, write) => {
        await fence.assert();
        const grants = this.currentGrants();
        this.requireGrant(grants.canCreate);
        const notebookId = request.notebookId;
        if (notebookId) {
          if (!grants.hasNotebook(notebookId))
            throw new ConnectError("NOT_AUTHORIZED");
          // Re-verify the live target immediately before the write, not only
          // its existence: a notebook trashed/deleted since `authorize` must
          // not receive a new note.
          await this.assertNotebookShareable(notebookId, fence);
        }
        const title =
          resolvedTitle ??
          (await this.connectCreateTitle(request.title, html));

        // One shared domain lease covers the *whole* create — the guarded body
        // write, the guarded notebook binding and the bare reads that build the
        // returned revision. Passing the lease as the token to
        // `Notes.addGuarded` / `Notes.addToNotebookGuarded` makes them run
        // inline on this critical section instead of acquiring (and releasing)
        // their own, so the response and the committed receipt carry the
        // revision of *this* write: a queued manual edit that lands after the
        // lease is released cannot change the acknowledged revision. The reads
        // are bare (`notesCurrent`) because a `fence.step` hook must never run
        // while the lock is held (a mutating hook would deadlock on it).
        return withDomainWrite(this.db, async (token) => {
          await this.db.notes.addGuarded(
            {
              id: reservedId,
              // The exact, deterministic title resolved before the write (see
              // `connectCreateTitle`): never left to the clock- and
              // settings-dependent generated-title path, so the receipt's
              // `titleHash` pins the stored value across a crash/replay.
              title,
              content: { type: "tiptap", data: html },
              // The host's session id for *this* invocation is copied into the
              // actual note write (and therefore the note-history entry) only
              // while the per-invocation ownership predicate still holds: the
              // guard below re-asserts it immediately before every persistence
              // boundary. It is never sourced from the wire request.
              ...(sessionId !== undefined ? { sessionId } : {})
            },
            // Runs before *every* persistence boundary of the note pipeline
            // (content row, its relation side effects, note row, history), so a
            // lock/revocation that lands while an inner await is suspended stops
            // the remaining writes. Once the first write has landed the guard
            // only revalidates the fence: the half-state is recovered by
            // verification, it must not be re-judged as a pre-write failure.
            async () => {
              if (write.persisted) {
                await fence.assert();
                return;
              }
              await fence.assert();
              if (await this.db.notes.exists(reservedId))
                throw new ConnectError("IDEMPOTENCY_CONFLICT");
              // `grants` is the snapshot `fence.assert()` just validated against
              // the live generation, so a stale snapshot cannot reach this check.
              if (request.notebookId && !grants.hasNotebook(request.notebookId))
                throw new ConnectError("NOT_AUTHORIZED");
              await fence.assert();
              // Everything past this point can have persisted.
              write.persisted = true;
            },
            token
          );
          if (notebookId) {
            // The body/row write above has already landed (`write.persisted` is
            // true), so a revocation that lands while this binding waits for the
            // domain lock cannot be undone: the guarded binding denies the
            // relation write and the half-applied create is resolved by
            // verification (reserved/uncertain = repairable), never by aborting
            // the receipt or reporting a saved reply. The binding runs on the
            // same lease as the body write (`token`), so no other writer can
            // interleave between them.
            await this.db.notes.addToNotebookGuarded(
              notebookId,
              reservedId,
              async () =>
                this.notebookBindingGuard(notebookId, reservedId, fence),
              token
            );
          }
          const state = await this.notesCurrent(reservedId);
          if (!state.note) throw new ConnectError("IDEMPOTENCY_UNCERTAIN");
          if (
            notebookId &&
            !(await this.isNoteInNotebookBare(notebookId, reservedId))
          )
            throw new ConnectError("IDEMPOTENCY_UNCERTAIN");
          const result = this.noteResult(
            request.operationId,
            "create_note",
            reservedId,
            state.note,
            state.content
          );
          // Last check inside the lease: synchronous, so no await can run
          // between the state the revision was read from and the response
          // returning it.
          fence.assertSync();
          return result;
        });
      }
    };
  }

  /** Current permission + target-scope check shared by note writes. */
  private async authorizeNoteChange(noteId: string, fence: OperationFence) {
    const grants = this.currentGrants();
    this.requireGrant(grants.canChange);
    if (!(await this.isNoteAuthorized(noteId, fence)))
      throw new ConnectError("NOT_AUTHORIZED");
  }

  private noteWriteImpl(
    request:
      | (ConnectRequest & { operation: "append_to_note" })
      | (ConnectRequest & { operation: "update_note" }),
    isAppend: boolean,
    /** Per-invocation host session id (never from the wire request). */
    sessionId?: string,
    /**
     * Per-invocation strict canonical-content mode (never from the wire
     * request). Applies only to the *prospective* fragment (an append body or a
     * replacement `patch.content`); it never sanitizes or rewrites the stored
     * base it is combined with.
     */
    requireCanonicalContent = false
  ): MutationImpl<Record<string, unknown>> {
    const format = ((request.operation === "append_to_note"
      ? request.format
      : undefined) ?? "markdown") as ConnectContentFormat;
    const patch =
      request.operation === "update_note"
        ? (request as { patch: Record<string, unknown> }).patch
        : undefined;
    /** Whether this invocation carries prospective content at all. */
    const hasPatchContent =
      isAppend || (patch !== undefined && patch.content !== undefined);

    /**
     * The one, memoized preparation of this invocation's prospective fragment.
     *
     * It is forced on the first call — made inside `fingerprint`, i.e. before
     * `journal.begin` — so a strict canonical-content rejection happens before
     * a receipt is looked up or reserved and before any persistence; the same
     * frozen string is then reused by the reservation expectation, the guarded
     * write and the receipt (no re-preparing in either). A local closure of
     * this call: it is never adapter state, so concurrent invocations cannot
     * share a prepared fragment or a strict flag.
     */
    let preparedPromise: Promise<string> | undefined;
    const prepareMutation = (): Promise<string> => {
      if (!preparedPromise) {
        if (isAppend) {
          preparedPromise = this.prepareContent(
            format,
            (request as { content: string }).content,
            requireCanonicalContent
          );
        } else {
          preparedPromise = this.prepareContent(
            (patch!.format as ConnectContentFormat) ?? "markdown",
            patch!.content as string,
            requireCanonicalContent
          );
        }
      }
      return preparedPromise;
    };

    return {
      authorize: async (fence) => {
        await this.authorizeNoteChange(request.noteId, fence);
      },
      fingerprint: async () => {
        // Prepare — and in strict mode validate — the prospective body exactly
        // once, before the durable receipt is looked up. The underlying request
        // fingerprint keeps the established identity (sanitizer-only bytes for
        // an append and the raw patch for an update); only the host-only strict
        // mode adds a separate receipt-identity bit below.
        if (hasPatchContent) await prepareMutation();
        const fingerprint = fingerprintOf({
          operation: request.operation,
          noteId: request.noteId,
          expectedRevision: request.expectedRevision,
          content:
            request.operation === "append_to_note"
              ? noteContentHash("tiptap", toTiptapHtml(format, request.content))
              : null,
          patch: request.operation === "update_note" ? request.patch : null
        });
        // The strict-canonical bit is trusted host context, not wire input. It
        // participates only in host-mode receipt identity so a strict call can
        // never replay an outcome previously committed by the ordinary path.
        // Callers without strict mode retain the exact historical fingerprint.
        return hostModeFingerprint(fingerprint, requireCanonicalContent);
      },
      createReservation: async (fence) => {
        const state = await this.readNoteState(request.noteId, fence);
        const postMatch: Record<string, unknown> = {};
        if (isAppend) {
          if (requireCanonicalContent)
            this.assertNoteMutable(state.note, state.content);
          const existing =
            typeof state.content?.data === "string" ? state.content.data : "";
          // A legacy stored body that still carries an inline base64 image
          // would be re-imported by the ordinary content pipeline once this
          // append is combined with it, crossing the attachment save/bind
          // boundary from deep inside post-processing. The append is refused
          // *before* a receipt is reserved, so the stored body and its existing
          // attachment relations are left untouched. A stored `data-hash`
          // reference is not flagged here: it binds to an already-stored
          // attachment through the guarded relation helper.
          if (containsInlineAttachmentData(existing))
            throw new ConnectError("UNSUPPORTED_CONTENT");
          if (
            requireCanonicalContent &&
            state.revision !== request.expectedRevision
          )
            throw new ConnectError("REVISION_CONFLICT");
          const appended = await prepareMutation();
          const combined = `${existing}${appended}`;
          // The ordinary content pipeline post-processes the complete body.
          // Prove that appending to a legacy/foreign base cannot silently
          // rewrite that base before allocating the durable receipt. This is
          // after the current base/revision read and before any reservation or
          // persistence boundary.
          // Stored bodies have a larger read ceiling than request fragments.
          // Keep the assembled body within that same ceiling so a successful
          // append is always readable back as one complete value.
          boundContent(combined);
          if (requireCanonicalContent)
            await this.assertPersistenceStable(combined);
          postMatch.contentHash = noteContentHash(
            "tiptap",
            combined
          );
        } else {
          if (patch!.title !== undefined) {
            const normalized = normalizeTitle(patch!.title as string);
            // An *omitted* title keeps the prior title. A supplied but blank
            // title is rejected here, before the durable reservation: the
            // pipeline would either materialize a clock/settings-dependent
            // generated title or keep an unpredictable prior one, and neither
            // can be pinned by the receipt's exact title hash — accepting it
            // would either strand a crash+replay as uncertain or force a
            // weaker "any title" check.
            if (!normalized.trim()) throw new ConnectError("INVALID_INPUT");
            postMatch.titleHash = hashId(normalized);
          }
          if (patch!.content !== undefined) {
            const replacement = await prepareMutation();
            postMatch.contentHash = noteContentHash("tiptap", replacement);
          }
        }
        return {
          reservedId: request.noteId,
          expect: {
            kind: "note_write",
            noteId: request.noteId,
            preRevision: state.revision ?? "",
            postMatch
          }
        };
      },
      verify: async (record, fence) => {
        const state = await this.readNoteState(request.noteId, fence);
        if (!state.note || !state.revision) return { kind: "ambiguous" };
        const expect = record.expect ?? {};
        if (state.revision === expect.preRevision)
          return { kind: "not_applied" };
        const postMatch = (expect.postMatch ?? {}) as Record<string, unknown>;
        if (this.matchesPost(state, postMatch))
          return {
            kind: "applied",
            result: this.noteResult(
              request.operationId,
              request.operation,
              request.noteId,
              state.note,
              state.content
            )
          };
        return { kind: "ambiguous" };
      },
      perform: async (_reservedId, fence, write) => {
        await fence.assert();
        const grants = this.currentGrants();
        this.requireGrant(grants.canChange);
        if (!(await this.isNoteAuthorized(request.noteId, fence)))
          throw new ConnectError("NOT_AUTHORIZED");

        // Reuse the *same* fragment prepared (and, in strict mode, validated)
        // once before `journal.begin`. Re-preparing here is deliberately
        // avoided: the bytes hashed into the reservation and the receipt must
        // be exactly the bytes written. The fragment is only ever combined with
        // a freshly re-read `current` state inside the critical section, after
        // the last possible await: a vault/trash/readonly transition that lands
        // in the meantime is detected and fails closed instead of being
        // overwritten.
        let appended: string | undefined;
        let replacement: string | undefined;
        if (isAppend) {
          appended = await prepareMutation();
        } else if (hasPatchContent) {
          replacement = await prepareMutation();
        }

        // One shared domain lease covers the guarded write *and* the bare
        // re-read that builds the returned revision. `addGuarded` runs inline
        // on this lease (passed as the token) instead of taking its own, so the
        // response and the committed receipt carry the revision of *this*
        // write: a queued manual edit that lands after the lease is released is
        // legitimate but cannot change the acknowledged revision.
        return withDomainWrite(this.db, async (token) => {
          await this.db.notes.addGuarded(
            // The write payload is materialized *inside* the critical section,
            // from the freshly re-read state, and never touched again: the note
            // pipeline computes `contentChanged`, headline and the generated
            // title from this final object.
            async () => {
              await fence.assert();
              const current = await this.notesCurrent(request.noteId);
              if (!current.note && (await this.db.notes.trashed(request.noteId)))
                throw new ConnectError("NOTE_TRASHED");
              this.assertNoteMutable(current.note, current.content);
              if (current.revision !== request.expectedRevision)
                throw new ConnectError("REVISION_CONFLICT");
              // The stored body must still be the one this request was based
              // on: locked content must never be replaced by prepared plaintext.
              if (isLockedContent(current.content))
                throw new ConnectError("NOTE_LOCKED");

              const item: Partial<
                Note & { content: NoteContent<false>; sessionId: string }
              > = { id: request.noteId };
              // The host's session id for *this* invocation, forwarded into the
              // actual note write (and its history entry) while the ownership
              // predicate asserted by the surrounding guard still holds.
              if (sessionId !== undefined) item.sessionId = sessionId;

              if (isAppend) {
                const existing = current.content?.data ?? "";
                item.contentId = current.note.contentId;
                item.content = {
                  type: "tiptap",
                  data: `${existing}${appended}`
                };
              } else {
                const updatePatch = (request as {
                  patch: Record<string, unknown>;
                }).patch;
                if (updatePatch.title !== undefined)
                  item.title = updatePatch.title as string;
                if (updatePatch.pinned !== undefined)
                  item.pinned = updatePatch.pinned as boolean;
                if (updatePatch.favorite !== undefined)
                  item.favorite = updatePatch.favorite as boolean;
                if (updatePatch.content !== undefined) {
                  item.contentId = current.note.contentId;
                  item.content = { type: "tiptap", data: replacement! };
                }
              }
              return item;
            },
            // Read-only validation that runs before *every* persistence boundary
            // of the pipeline (content row, its relation side effects, note row,
            // history). Nothing here mutates the prepared payload, so the fields
            // the pipeline computed above are exactly the fields that get
            // written.
            async () => {
              if (write.persisted) {
                // The prepared body may already have landed; from here on only
                // the fence decides whether the remaining boundaries run.
                await fence.assert();
                return;
              }
              await fence.assert();
              const current = await this.notesCurrent(request.noteId);
              if (!current.note && (await this.db.notes.trashed(request.noteId)))
                throw new ConnectError("NOTE_TRASHED");
              this.assertNoteMutable(current.note, current.content);
              if (current.revision !== request.expectedRevision)
                throw new ConnectError("REVISION_CONFLICT");
              if (isLockedContent(current.content))
                throw new ConnectError("NOTE_LOCKED");
              // The note must still be inside the granted scope when the body
              // lands: the scope check at the top of `perform` ran before the
              // content conversion awaits, and notebook membership is live
              // state.
              if (!(await this.isNoteAuthorizedBare(request.noteId)))
                throw new ConnectError("NOT_AUTHORIZED");
              // Last fence check immediately before the write: any grants, lock,
              // session or migration change from here on aborts the write.
              await fence.assert();
              // Everything past this point can have persisted.
              write.persisted = true;
            },
            token
          );

          // Bare re-read of the *committed* state on the same lease: no other
          // note writer can run between the write above and this read, so the
          // revision belongs to this write (not to a later queued edit).
          const state = await this.notesCurrent(request.noteId);
          if (!state.note) throw new ConnectError("IDEMPOTENCY_UNCERTAIN");
          const result = this.noteResult(
            request.operationId,
            request.operation,
            request.noteId,
            state.note,
            state.content
          );
          fence.assertSync();
          return result;
        });
      }
    };
  }

  /**
   * Read the *current* note state from inside the shared write critical
   * section.
   *
   * Unlike {@link readNoteState} this deliberately uses bare reads: it runs
   * while the caller already holds the domain write lock, and `fence.step`
   * would run the instrumentation hook here, which would allow test-only code
   * to re-enter the critical section and deadlock. Callers must therefore
   * assert the fence themselves immediately before and after these awaits
   * (see the `addGuarded` callbacks in {@link noteWriteImpl}). The domain lock
   * serializes every note writer, so the pair of reads is atomic with respect
   * to manual edits, vault locks and trash transitions. The content read does
   * not take the domain lock itself (its pre-processing write-back is a
   * compare-and-swap), so it can be called from inside this critical section.
   */
  private async notesCurrent(noteId: string): Promise<NoteState> {
    const note = await this.db.notes.note(noteId);
    if (!note) return {};
    const content = await this.readContentRow(noteId, note);
    return { note, content, revision: noteRevision(note, content) };
  }

  /**
   * Fail-closed post-state verification for crash recovery: only an exact
   * match of the fields we intended to write counts as "applied". Anything
   * else is ambiguous and must be surfaced as uncertain.
   */
  private matchesPost(
    state: NoteState,
    postMatch: Record<string, unknown>
  ): boolean {
    const keys = Object.keys(postMatch);
    if (!keys.length) return false;
    for (const key of keys) {
      if (key === "titleHash") {
        // The receipt pins the *exact* stored title by hash — never a plaintext
        // copy and never an "any generated/prior title" mode.
        if (!state.note || typeof postMatch.titleHash !== "string")
          return false;
        if (hashId(state.note.title) !== postMatch.titleHash) return false;
      } else if (key === "contentHash") {
        if (!state.content) return false;
        if (
          noteContentHash(state.content.type, state.content.data) !==
          postMatch.contentHash
        )
          return false;
      } else {
        return false;
      }
    }
    return true;
  }

  private matchesTaskPost(
    task: Task,
    postMatch: Record<string, unknown>
  ): boolean {
    const keys = Object.keys(postMatch);
    if (!keys.length) return false;
    for (const key of keys) {
      if (key === "hashes") {
        // Free-text patch fields (title, description, recurrence rule) are
        // verified through their hash: the receipt must not carry a second
        // plaintext copy of user content.
        const hashes = postMatch.hashes as Record<string, unknown> | undefined;
        if (!hashes || typeof hashes !== "object") return false;
        const hashKeys = Object.keys(hashes);
        if (!hashKeys.length) return false;
        for (const hashKey of hashKeys) {
          const expected = hashes[hashKey];
          if (typeof expected !== "string") return false;
          const actual = (task as unknown as Record<string, unknown>)[hashKey];
          if (typeof actual !== "string") return false;
          if (hashId(actual) !== expected) return false;
        }
        continue;
      }
      const expected = postMatch[key];
      const actual = (task as unknown as Record<string, unknown>)[key];
      if ((actual ?? null) !== (expected ?? null)) return false;
    }
    return true;
  }

  private noteResult(
    operationId: string,
    operation: string,
    noteId: string,
    note: Note,
    content: NoteContent<false> | undefined
  ): Record<string, unknown> {
    return {
      operation,
      operationId,
      noteId,
      revision: noteRevision(note, content),
      url: `nn://note/${noteId}`,
      persisted: "local_saved",
      sync: "unknown"
    };
  }

  private resolveCreateListId(
    grants: GrantSnapshot,
    requested?: string
  ): string {
    if (requested) {
      if (!grants.hasList(requested)) throw new ConnectError("NOT_AUTHORIZED");
      // A granted id alone cannot override the list's raw privacy marker.
      this.assertListShareable(requested);
      return requested;
    }
    const lists = grants.grantedListIDs();
    if (lists.length !== 1) throw new ConnectError("NOT_AUTHORIZED");
    this.assertListShareable(lists[0]);
    return lists[0];
  }

  /**
   * Materialize the exact `TaskInput` a `create_task` request describes.
   *
   * Only the optional fields the caller *actually supplied* become own
   * properties of the returned object. This matters because the domain
   * materializer (`buildCreateValue`) decides "this is a floating-calendar
   * write" from `hasOwn(input, "reminderDate") || hasOwn(input, "reminderTime")`
   * — attaching `reminderDate: undefined` as an own key would flip every create
   * into a `scheduleVersion: 2` write, discarding a legacy `reminderAt` and
   * making an `urgent` Task with only a legacy reminder invalid.
   *
   * The same materialized object feeds the pre-reservation validation and the
   * write, so both see exactly the same payload.
   */
  private materializeTaskCreateInput(
    request: ConnectRequest & { operation: "create_task" },
    listId: string
  ): TaskInput {
    const input: TaskInput = { title: request.title, listId };
    if (request.description !== undefined)
      input.description = request.description;
    if (request.dueDate !== undefined) input.dueDate = request.dueDate;
    if (request.dueTime !== undefined) input.dueTime = request.dueTime;
    if (request.reminderDate !== undefined)
      input.reminderDate = request.reminderDate;
    if (request.reminderTime !== undefined)
      input.reminderTime = request.reminderTime;
    if (request.reminderAt !== undefined) input.reminderAt = request.reminderAt;
    if (request.priority !== undefined) input.priority = request.priority;
    if (request.recurrenceRule !== undefined)
      input.recurrenceRule = request.recurrenceRule;
    if (request.flagged !== undefined) input.flagged = request.flagged;
    if (request.urgent !== undefined) input.urgent = request.urgent;
    return input;
  }

  /**
   * Re-check the *stored* record behind a reserved `create_task` id under the
   * current raw privacy and current grants.
   *
   * Used on the replay/recovery paths, where the request's own list is not
   * enough: the record may have been moved to another list, or its Task/list
   * raw settings row may have become `localOnly`, since it was written. A
   * present record that is private or out of scope is refused exactly like a
   * missing target; its contents are never read into the response or a log.
   *
   * `requirePresent` distinguishes the two replay states: a *committed* receipt
   * acknowledges an object that was durably written, so a now-missing record
   * (deleted/trashed since) must be denied uniformly as `NOT_AUTHORIZED` — never
   * replayed as a success against storage that no longer holds it. A
   * `reserved`/`uncertain` receipt, by contrast, may legitimately predate the
   * write (a crash before `save`), so a missing record stays recoverable proof
   * that nothing landed. The caller cannot supply the reserved id, so neither
   * branch is an existence oracle.
   */
  private async assertReservedTaskReadable(
    reservedId: string,
    fence: OperationFence,
    requirePresent = false
  ): Promise<void> {
    const task = await fence.step(
      "reserved-task",
      this.db.tasks.get(reservedId)
    );
    if (!task) {
      if (requirePresent) throw new ConnectError("NOT_AUTHORIZED");
      return;
    }
    if (task.localOnly || this.db.tasks.isLocalOnlyRecord(reservedId))
      throw new ConnectError("NOT_AUTHORIZED");
    const grants = this.currentGrants();
    if (!grants.hasList(task.listId))
      throw new ConnectError("NOT_AUTHORIZED");
    this.assertListShareable(task.listId);
  }

  private createTaskImpl(
    request: ConnectRequest & { operation: "create_task" }
  ): MutationImpl<Record<string, unknown>> {
    return {
      authorize: async (fence, record) => {
        const grants = this.currentGrants();
        this.requireGrant(grants.canTask);
        this.resolveCreateListId(grants, request.listId);
        if (record)
          await this.assertReservedTaskReadable(
            record.reservedId,
            fence,
            // A committed receipt names an object that was durably written: if
            // it is gone now (deleted/trashed), the replay is denied rather than
            // acknowledged against storage that no longer holds it. Reserved /
            // uncertain receipts stay recoverable when the record is missing.
            record.state === "committed"
          );
      },
      fingerprint: async () =>
        fingerprintOf({
          operation: request.operation,
          title: request.title,
          listId: request.listId ?? null,
          dueDate: request.dueDate ?? null,
          dueTime: request.dueTime ?? null,
          reminderDate: request.reminderDate ?? null,
          reminderTime: request.reminderTime ?? null,
          reminderAt: request.reminderAt ?? null,
          priority: request.priority ?? null,
          recurrenceRule: request.recurrenceRule ?? null,
          flagged: request.flagged ?? null,
          urgent: request.urgent ?? null,
          description: request.description ?? null
        }),
      createReservation: async () => {
        const listId = this.resolveCreateListId(
          this.currentGrants(),
          request.listId
        );
        if (!this.db.taskLists.getSync(listId))
          throw new ConnectError("TASK_LIST_NOT_FOUND");
        // Validate against the *actual* domain rules (title, impossible
        // calendar dates, recurrence-without-due-date, urgent-without-time)
        // before the durable receipt is written: a rejected payload is a
        // bounded `INVALID_INPUT` that leaves neither a receipt nor a record.
        // Exactly the same materialized input is used for the write below.
        try {
          validateTaskCreateInput(
            this.materializeTaskCreateInput(request, listId)
          );
        } catch {
          throw new ConnectError("INVALID_INPUT");
        }
        return {
          reservedId: getId(),
          // Hashed like note titles: a synced receipt must not carry a second
          // plaintext copy of a Task title.
          expect: {
            kind: "task_create",
            titleHash: hashId(request.title.trim()),
            listId
          }
        };
      },
      verify: async (record, fence) => {
        const task = await fence.step(
          "verify-task",
          this.db.tasks.get(record.reservedId)
        );
        if (!task) return { kind: "not_applied" };
        // The stored record's *current* raw privacy and current granted list
        // are part of the verdict: a record that became local-only or left the
        // granted scope must not be reported as this operation's success. Both
        // cases are `ambiguous` — never a distinct error that would turn the
        // reserved id into an existence oracle.
        const grants = this.currentGrants();
        if (task.localOnly || this.db.tasks.isLocalOnlyRecord(record.reservedId))
          return { kind: "ambiguous" };
        if (!grants.hasList(task.listId)) return { kind: "ambiguous" };
        if (this.db.taskLists.isLocalOnlyRecord(task.listId))
          return { kind: "ambiguous" };
        const expect = record.expect ?? {};
        // `titleHash` is the *only* accepted shape (like `createNoteImpl.verify`).
        // The previously authored plaintext `title` fallback was removed before
        // first release (no receipt in the wild carries it): a receipt that
        // stores a plaintext/model title must never be honoured, because a synced
        // receipt must not carry a second plaintext copy of a Task title and the
        // original request string must never stand in as proof that the record at
        // the reserved id is the object this operation wrote. An unrecognized
        // legacy shape fails closed to `ambiguous`, it is never accepted.
        const titleMatches =
          typeof expect.titleHash === "string" &&
          hashId(task.title) === expect.titleHash;
        if (titleMatches && task.listId === expect.listId)
          return {
            kind: "applied",
            result: this.taskResult(request.operationId, "create_task", task)
          };
        return { kind: "ambiguous" };
      },
      perform: async (reservedId, fence, write) => {
        await fence.assert();
        const grants = this.currentGrants();
        this.requireGrant(grants.canTask);
        const listId = this.resolveCreateListId(grants, request.listId);
        if (!this.db.taskLists.getSync(listId))
          throw new ConnectError("TASK_LIST_NOT_FOUND");
        // The final validation runs *inside* the Task write lease, after the
        // default-list materialization and immediately before the save: the
        // fence step above can be suspended arbitrarily long, and the
        // materialization is itself an await that may have written a list row.
        const guard: TaskWriteGuard = async (_current, next) => {
          await fence.assert();
          if (!grants.hasList(next.listId))
            throw new ConnectError("NOT_AUTHORIZED");
          if (this.db.taskLists.isLocalOnlyRecord(next.listId))
            throw new ConnectError("NOT_AUTHORIZED");
          if (!this.db.taskLists.getSync(next.listId))
            throw new ConnectError("TASK_LIST_NOT_FOUND");
          await fence.assert();
          // Everything past this point can have persisted.
          write.persisted = true;
        };
        const task = await this.db.tasks.create(
          {
            // Own resolved id only — the materializer never invents model
            // fields and never forwards an absent optional key as `undefined`.
            ...this.materializeTaskCreateInput(request, listId),
            id: reservedId
          },
          guard
        );
        return this.taskResult(request.operationId, "create_task", task);
      }
    };
  }

  private taskWriteImpl(
    request:
      | (ConnectRequest & { operation: "update_task" })
      | (ConnectRequest & { operation: "complete_task" }),
    isComplete: boolean
  ): MutationImpl<Record<string, unknown>> {
    return {
      authorize: async (fence) => {
        const grants = this.currentGrants();
        this.requireGrant(grants.canTask);
        if (request.operation === "update_task" && request.patch.listId) {
          if (!grants.hasList(request.patch.listId))
            throw new ConnectError("NOT_AUTHORIZED");
          this.assertListShareable(request.patch.listId);
        }
        // The task's *current* list decides the scope: a task that was moved
        // (locally or by sync) out of the granted list must not be readable or
        // writable through a replay/resume.
        const task = await fence.step(
          "task",
          this.db.tasks.get(request.taskId)
        );
        // A missing target and a target outside the effective grant are one
        // and the same answer: distinguishing them (`TASK_NOT_FOUND` vs
        // `NOT_AUTHORIZED`) would let a caller probe for the existence of tasks
        // it is not authorized to see.
        if (!task) throw new ConnectError("NOT_AUTHORIZED");
        // Local-only tasks are never mutable through the external API — both
        // the parsed JSON flag and the *raw* settings row (the actual domain
        // privacy marker) are consulted, and a granted id never overrides them.
        if (task.localOnly || this.db.tasks.isLocalOnlyRecord(request.taskId))
          throw new ConnectError("NOT_AUTHORIZED");
        if (!grants.hasList(task.listId))
          throw new ConnectError("NOT_AUTHORIZED");
        this.assertListShareable(task.listId);
      },
      fingerprint: async () =>
        fingerprintOf({
          operation: request.operation,
          taskId: request.taskId,
          expectedRevision: request.expectedRevision,
          patch: request.operation === "update_task" ? request.patch : null
        }),
      createReservation: async (fence) => {
        const task = await fence.step(
          "task",
          this.db.tasks.get(request.taskId)
        );
        // Fresh reservations only (replays never reach here): validate the
        // patched record against the *actual* domain rules before the durable
        // receipt is written. Replays keep their already-verified outcome and
        // are never re-judged against newer scheduling state.
        if (!isComplete && task) {
          try {
            validateTaskUpdateInput(
              task,
              (request as { patch: Partial<TaskInput> }).patch
            );
          } catch {
            throw new ConnectError("INVALID_INPUT");
          }
        }
        const postMatch: Record<string, unknown> = {};
        if (isComplete) postMatch.completed = true;
        else {
          const patch = (request as { patch: Record<string, unknown> }).patch;
          const hashes: Record<string, string> = {};
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            // Free-text fields are stored as hashes: verification only needs
            // to prove *which* value landed, and the receipt row syncs.
            if (key === "title") {
              hashes.title = hashId(String(value).trim());
            } else if (key === "description" || key === "recurrenceRule") {
              hashes[key] = hashId(String(value));
            } else {
              postMatch[key] = value;
            }
          }
          if (Object.keys(hashes).length) postMatch.hashes = hashes;
        }
        return {
          reservedId: request.taskId,
          expect: {
            kind: "task_write",
            taskId: request.taskId,
            preRevision: task ? taskRevision(task) : null,
            postMatch
          }
        };
      },
      verify: async (record, fence) => {
        const task = await fence.step(
          "verify-task",
          this.db.tasks.get(request.taskId)
        );
        if (!task) return { kind: "ambiguous" };
        const expect = record.expect ?? {};
        if (taskRevision(task) === expect.preRevision) {
          // An unchanged revision normally proves that the mutation never
          // landed — but not for a completion: an occurrence that is *already*
          // completed satisfies the requested end state (Tasks treats such a
          // retry as a successful, repairable one) while its recurrence
          // follow-up may still be at stake. Resolving that from the stored
          // post-state is what keeps the receipt recoverable instead of
          // aborting an operation whose occurrence write may have landed. Only
          // a completion of an occurrence that is still open is a proven
          // pre-write failure.
          if (!(isComplete && task.completed)) return { kind: "not_applied" };
        }
        if (
          this.matchesTaskPost(
            task,
            (expect.postMatch ?? {}) as Record<string, unknown>
          )
        )
          return {
            kind: "applied",
            result: this.taskResult(
              request.operationId,
              request.operation,
              task
            )
          };
        return { kind: "ambiguous" };
      },
      perform: async (_reservedId, fence, write) => {
        await fence.assert();
        const grants = this.currentGrants();
        this.requireGrant(grants.canTask);
        if (request.operation === "update_task" && request.patch.listId) {
          if (!grants.hasList(request.patch.listId))
            throw new ConnectError("NOT_AUTHORIZED");
        }
        // Runs inside the task `mutationMutex`, on the record read inside that
        // critical section and on the exact record about to be saved, with no
        // await between the validation and `save`. `grants` was validated by
        // the fence assertion above, so a stale snapshot cannot reach it.
        const guard: TaskWriteGuard = async (current, next) => {
          if (write.persisted) {
            // The completion (or patch) has already landed; only the fence
            // decides whether the recurrence follow-up may still run.
            await fence.assert();
            return;
          }
          // An occurrence that is already completed is itself durable evidence
          // of this operation's end state (Tasks treats an already completed
          // occurrence as a successful, repairable retry). A failure from here
          // on must therefore be resolved by verification instead of being
          // aborted as a proven pre-write failure — the recurrence follow-up
          // may still be at stake and the receipt has to stay recoverable.
          if (isComplete && current?.completed) write.persisted = true;
          await fence.assert();
          // Missing target and out-of-scope target are indistinguishable, as on
          // the authorize path.
          if (!current) throw new ConnectError("NOT_AUTHORIZED");
          if (current.localOnly) throw new ConnectError("NOT_AUTHORIZED");
          if (this.db.tasks.isLocalOnlyRecord(request.taskId))
            throw new ConnectError("NOT_AUTHORIZED");
          if (!grants.hasList(current.listId))
            throw new ConnectError("NOT_AUTHORIZED");
          this.assertListShareable(current.listId);
          if (taskRevision(current) !== request.expectedRevision)
            throw new ConnectError("REVISION_CONFLICT");
          // The record this write persists — including a list move — must land
          // inside the granted scope and in a shareable list.
          if (!grants.hasList(next.listId))
            throw new ConnectError("NOT_AUTHORIZED");
          this.assertListShareable(next.listId);
          // Last fence check immediately before the persisted change.
          await fence.assert();
          // Everything past this point can have persisted.
          write.persisted = true;
        };
        // The recurrence follow-up creates a *new* Task record: it is validated
        // by its own guard inside `createMutex`, immediately before the save.
        // The completion's `expectedRevision` is never applied to the new
        // occurrence's id — only the fence and the list the new occurrence
        // lands in are checked.
        const recurrenceGuard: TaskRecurrenceGuard = async (_current, next) => {
          await fence.assert();
          const currentGrants = this.currentGrants();
          if (next.localOnly) throw new ConnectError("NOT_AUTHORIZED");
          if (!currentGrants.hasList(next.listId))
            throw new ConnectError("NOT_AUTHORIZED");
          this.assertListShareable(next.listId);
          if (!this.db.taskLists.getSync(next.listId))
            throw new ConnectError("TASK_LIST_NOT_FOUND");
          // Last fence check immediately before the followed-up record is
          // saved.
          await fence.assert();
          // Everything past this point can have persisted.
          write.persisted = true;
        };
        const task = isComplete
          ? await this.db.tasks.completeGuarded(
              request.taskId,
              guard,
              recurrenceGuard
            )
          : await this.db.tasks.updateGuarded(
              request.taskId,
              (request as { patch: Record<string, unknown> })
                .patch as Partial<Task>,
              guard
            );
        return this.taskResult(request.operationId, request.operation, task);
      }
    };
  }

  private taskResult(
    operationId: string,
    operation: string,
    task: Task
  ): Record<string, unknown> {
    return {
      operation,
      operationId,
      taskId: task.id,
      revision: taskRevision(task),
      completed: task.completed,
      link: `veyran://task/${task.id}`,
      persisted: "local_saved",
      sync: "unknown"
    };
  }
}
