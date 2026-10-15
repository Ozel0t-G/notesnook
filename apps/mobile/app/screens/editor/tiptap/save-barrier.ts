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
 * A deterministic, sender-scoped save barrier for the editor's debounced
 * saves.
 *
 * `saveContent` coalesces saves behind a 150 ms `withTimer` and fires
 * `saveNote` *without awaiting it*, so the hook has no idea whether the
 * content a sender (tab + note) queued has reached the database. The barrier
 * records every queued and in-flight save of a sender and can force that
 * sender's debounce to run and await the real completion - without touching
 * the editor's legacy timing, coalescing, guards or payloads.
 *
 * Saves are tracked per *kind* as well as per sender: the hook passes the
 * save's own event type (`EditorEvents.content` / `EditorEvents.title`), the
 * exact transport the write belongs to. A successful write can therefore only
 * ever supersede a failure of the same kind - a saved title must never clear a
 * failed body write, which would let the caller export stale content as
 * "saved".
 *
 * Everything lives in the barrier instance (one per hook via a ref): there is
 * no global store, no persisted state and no new database format.
 *
 * This is the native database barrier only. The web editor keeps its own
 * 100 ms debounce plus pending-id delivery; that is a separate, later effort
 * and is not modelled here.
 */

export type SaveSender = {
  tabId: string;
  /** The note the sender claims to save. Unknown only for a first save. */
  noteId?: string;
  /** The note the content *came from*, when the editor reported one. */
  sourceNoteId?: string;
};

export type SaveFlushFailureReason = "save-failed" | "dropped-while-guarded";

export type SaveFlushAbortReason =
  | "invalid-sender"
  | "unsupported-editor"
  | "unknown-tab"
  | "stale-sender"
  | "inactive-sender"
  | "sender-changed";

export type SaveFlushBusyReason =
  | "editor-locked"
  | "note-loading"
  | "app-loading"
  | "save-not-started";

export type SaveFlushResult =
  | {
      status: "saved";
      /** The id the database accepted the saved note under. */
      id: string;
      /**
       * True when edits arrived while the flush was awaiting: the barrier
       * snapshot no longer describes the sender, so the caller must run a
       * bounded retry (or abort) instead of exporting stale content.
       */
      pendingAfter: boolean;
    }
  | { status: "nothing-pending" }
  | { status: "busy"; reason: SaveFlushBusyReason }
  | { status: "aborted"; reason: SaveFlushAbortReason }
  | { status: "failed"; reason: SaveFlushFailureReason };

/**
 * The sender's identity as the stores see it *now*. `sessionId` is the tab
 * session's id, snapshotted before the flush and compared after it: a changed
 * session aborts the flush instead of exporting content for a different
 * sender. This is a *bounded* guard, not an ABA/remount proof - `session.id`
 * is a logical history session id and is not guaranteed unique for every
 * WebView remount, so a caller that needs ABA safety (the mounted-intent /
 * tab-activity generation the native executor owns) must provide it on top.
 */
export type SaveSenderState =
  | { ok: true; sessionId?: string }
  | { ok: false; reason: "unknown-tab" | "stale-sender" | "inactive-sender" };

/**
 * Everything the barrier needs to know about the editor it guards. Kept as
 * callbacks so the barrier never imports the stores itself.
 */
export type SaveBarrierContext = {
  readSender: (tabId: string, noteId: string) => SaveSenderState;
  isEditorLocked: () => boolean;
  isLoadingNote: (noteId: string) => boolean;
  isAppLoading: () => boolean;
  /**
   * A subeditor (`onChange`) never writes to the database: its saves are
   * unsupported for the barrier, not "clean".
   */
  isUnsupportedEditor: () => boolean;
};

/**
 * The kind used by callers that do not distinguish a sender's saves (the
 * barrier's own bookkeeping tests). The hook always passes the real event
 * type, so content and title failures never share a bucket.
 */
export const DEFAULT_SAVE_KIND = "save";

/** One debounced save that has been queued but whose timer has not fired. */
type PendingSave = {
  timerKey: string;
  sender: SaveSender;
  run: () => void;
  kind: string;
  /**
   * The ordinal of the *edit* that registered this save. It is handed back to
   * the caller (`registerPending` returns it) and must be carried into the
   * real job (`beginJob`): an edit is dropped by the guard, or a flush forces
   * an old debounce to run, strictly after newer edits may already have been
   * registered. Supersession has to follow the order edits were *queued* in,
   * not the order their timers happened to fire.
   */
  ticket: number;
};

/** One real `saveNote` call the barrier is awaiting. */
export type SaveJob = {
  token: string;
  kind: string;
  generation: number;
  result: Promise<string | undefined>;
  resolve: (id: string | undefined) => void;
  started: boolean;
  settled: boolean;
};

/**
 * Bookkeeping for one kind of save of one sender. `successGeneration` is the
 * only thing that may supersede `failure`: a successful save of a *newer*
 * generation of the *same* kind. A late, older failure that a newer success
 * already superseded is ignored instead of contaminate the sender.
 */
type KindState = {
  successGeneration?: number;
  failure?: { generation: number; reason: SaveFlushFailureReason };
};

type TokenState = {
  jobs: Set<SaveJob>;
  kinds: Map<string, KindState>;
};

export class SaveBarrier {
  /** Queued (debounced) saves by timer key - the same key `withTimer` uses. */
  private pending = new Map<string, PendingSave>();
  private tokens = new Map<string, TokenState>();
  /**
   * Monotonic save-activity revision per sender token. It is deliberately
   * *not* cleaned up with the token state: a consumer (the native database
   * executor) captures it before converting content for export and compares it
   * afterwards to detect edits that arrived *and fully settled* while it was
   * working - a case `isSavePending` cannot see because nothing is pending
   * anymore. Hook-lifetime only: never persisted, never global.
   */
  private revisions = new Map<string, number>();
  /**
   * A single monotonic ordinal shared by every sender and kind, used only for
   * supersession ordering. It is deliberately global instead of per token: a
   * first save is registered against the tab token (`tab-1:`) and only later,
   * once the note id resolves, lands in the note token (`tab-1:note-1`), so
   * per-token numbers are not comparable across that boundary. `revisions`
   * stays per token - it is the consumer-facing "has anything settled" signal
   * whose exact per-sender values are part of the contract.
   */
  private sequence = 0;

  private nextOrdinal() {
    return ++this.sequence;
  }

  private token(tabId: string, noteId?: string) {
    return `${tabId}:${noteId ?? ""}`;
  }

  private state(token: string) {
    let state = this.tokens.get(token);
    if (!state) {
      state = { jobs: new Set<SaveJob>(), kinds: new Map<string, KindState>() };
      this.tokens.set(token, state);
    }
    return state;
  }

  private kind(token: string, kind: string) {
    const state = this.state(token);
    let entry = state.kinds.get(kind);
    if (!entry) {
      entry = {};
      state.kinds.set(kind, entry);
    }
    return entry;
  }

  /** Advances the sender's monotonic save revision and returns it. */
  private bumpRevision(token: string) {
    const next = (this.revisions.get(token) ?? 0) + 1;
    this.revisions.set(token, next);
    return next;
  }

  /**
   * The exact sender's monotonic save revision. Incremented whenever an edit
   * is scheduled (a debounce registration), dropped by a guard, or its real
   * save begins - not only when a job settles - and it survives the sender
   * becoming clean, so a caller can tell that new work fully settled.
   */
  getSaveRevision(tabId: string, noteId: string) {
    if (!tabId || !noteId) return 0;
    return this.revisions.get(this.token(tabId, noteId)) ?? 0;
  }

  /**
   * Records a debounced save before its timer fires. Replaces any entry for
   * the same timer key, exactly like `withTimer` replaces the timer. Returns
   * the edit's ordinal, which the caller must carry into `beginJob` so a late
   * success cannot supersede a newer edit that was already dropped.
   */
  registerPending(
    sender: SaveSender,
    timerKey: string,
    run: () => void,
    kind: string = DEFAULT_SAVE_KIND
  ) {
    const senderToken = this.token(sender.tabId, sender.noteId);
    this.bumpRevision(senderToken);
    const ticket = this.nextOrdinal();

    // `withTimer` keys only on `${noteId || tabId}:${kind}`, and one default
    // native editor serves every web tab: two tabs on the same note share a
    // timer key, so registering the second evicts the first tab's queued
    // payload. That edit really was dropped - nothing will ever run its `run`
    // - so record an unresolved failure of *its own* kind for *its own*
    // sender instead of letting it vanish. Its ordinal is the displaced
    // registration's ticket, so a later same-kind success of that sender still
    // supersedes it in the correct order. Only an actually queued entry of a
    // *different* sender is displaced; a same-sender re-registration is the
    // legacy coalescing and stays silent. The physical timer and the payload
    // that fires are untouched.
    const displaced = this.pending.get(timerKey);
    if (displaced) {
      const displacedToken = this.token(
        displaced.sender.tabId,
        displaced.sender.noteId
      );
      if (displacedToken !== senderToken) {
        this.bumpRevision(displacedToken);
        this.kind(displacedToken, displaced.kind).failure = {
          generation: displaced.ticket,
          reason: "dropped-while-guarded"
        };
      }
    }

    this.pending.set(timerKey, { timerKey, sender, run, kind, ticket });
    return ticket;
  }

  /**
   * Drops a pending registration once its timer fired. Only the entry that
   * belongs to `run` is removed, so a foreign sender that re-registered the
   * same key in the meantime is never stolen.
   */
  completePending(timerKey: string, run: () => void) {
    const entry = this.pending.get(timerKey);
    if (entry && entry.run === run) this.pending.delete(timerKey);
  }

  /**
   * Records that a live edit was thrown away by the saveContent guard (the
   * editor was locked or the note was still loading). Nothing was queued for
   * it, so the sender must not be reported as clean afterwards. The failure is
   * scoped to the edit's kind like every other failure.
   */
  markGuardedDrop(sender: SaveSender, kind: string = DEFAULT_SAVE_KIND) {
    const token = this.token(sender.tabId, sender.noteId);
    this.bumpRevision(token);
    this.kind(token, kind).failure = {
      generation: this.nextOrdinal(),
      reason: "dropped-while-guarded"
    };
  }

  /**
   * Starts tracking one real save for the sender. The caller must attach the
   * `saveNote` promise as soon as it exists (`attachJob`); a job that was
   * never attached keeps the sender pending - it was queued and has not
   * finished.
   *
   * `ticket` is the ordinal of the edit that queued this save, when the caller
   * got one from `registerPending`. It becomes the job's generation so
   * supersession follows the *queued* order: a flush can force an old debounce
   * to run after a newer edit was already dropped by the guard, and that old
   * save's late success must not clear the newer failure. A caller with no
   * registration (a direct `beginJob`) simply gets a fresh ordinal, which is
   * still monotonic.
   */
  beginJob(
    sender: { tabId: string; noteId?: string },
    kind: string = DEFAULT_SAVE_KIND,
    ticket?: number
  ): SaveJob {
    const token = this.token(sender.tabId, sender.noteId);
    // The revision keeps advancing with the real save; that is the signal a
    // consumer captures for `pendingAfter`. The supersession ordinal, by
    // contrast, is the registration ticket when there is one.
    this.bumpRevision(token);
    const generation = ticket ?? this.nextOrdinal();
    let resolve!: (id: string | undefined) => void;
    const job: SaveJob = {
      token,
      kind,
      generation,
      result: new Promise<string | undefined>((r) => (resolve = r)),
      resolve,
      started: false,
      settled: false
    };
    this.state(token).jobs.add(job);
    return job;
  }

  attachJob(job: SaveJob, result: Promise<string | undefined>) {
    job.started = true;
    result.then(
      (id) => this.settleJob(job, id),
      () => this.settleJob(job, undefined)
    );
  }

  private settleJob(job: SaveJob, id: string | undefined) {
    if (job.settled) return;
    job.settled = true;
    job.resolve(id);
    const state = this.state(job.token);
    state.jobs.delete(job);
    const kind = this.kind(job.token, job.kind);

    if (id) {
      // A successful save supersedes only an *older* failure of the same
      // kind: what it wrote is newer than whatever failed before it. A
      // failure of another kind (a body write still failing while the title
      // went through) is untouched.
      if (
        kind.successGeneration === undefined ||
        kind.successGeneration < job.generation
      ) {
        kind.successGeneration = job.generation;
      }
      if (kind.failure && kind.failure.generation < job.generation) {
        kind.failure = undefined;
      }
    } else if (
      (!kind.failure || job.generation >= kind.failure.generation) &&
      // A failure that a *newer* success of the same kind already superseded
      // may settle late; it must not contaminate the sender again.
      (kind.successGeneration === undefined ||
        job.generation > kind.successGeneration)
    ) {
      kind.failure = { generation: job.generation, reason: "save-failed" };
    }

    this.cleanup(job.token);
  }

  /** Forgets a sender's job bookkeeping once it has nothing left to report. */
  private cleanup(token: string) {
    const state = this.tokens.get(token);
    if (!state) return;
    if (state.jobs.size > 0) return;
    for (const kind of state.kinds.values()) if (kind.failure) return;
    for (const entry of this.pending.values()) {
      if (this.token(entry.sender.tabId, entry.sender.noteId) === token) return;
    }
    this.tokens.delete(token);
  }

  /**
   * A debounced save belongs to a sender when it was queued for that tab and
   * note. An entry without a note id resolves the tab's current note at fire
   * time, so it only counts when the editor reported no source at all: a
   * *source* note id that the caller could not pin to a note id is ambiguous
   * (it may resolve to the requested note and write there under a token the
   * flush never awaits), so that queued payload must fail closed, never be
   * forced and never be exported as clean.
   */
  private pendingMatches(entry: PendingSave, tabId: string, noteId: string) {
    if (entry.sender.tabId !== tabId) return false;
    if (entry.sender.noteId) return entry.sender.noteId === noteId;
    return !entry.sender.sourceNoteId;
  }

  private pendingFor(tabId: string, noteId: string) {
    const matches: PendingSave[] = [];
    for (const entry of this.pending.values()) {
      if (this.pendingMatches(entry, tabId, noteId)) matches.push(entry);
    }
    return matches;
  }

  /**
   * This tab's queued first-save entries that carry a *source* note id but no
   * note id. Such an entry can be attributed to neither this note (its note id
   * is unknown, so it may be a different note) nor a foreign sender (the tab
   * is this one). It must surface as a failure, never as a clean snapshot -
   * including when the source id happens to equal the requested note, because
   * the missing note id means the payload would resolve elsewhere.
   */
  private pendingConflicts(tabId: string) {
    const conflicts: PendingSave[] = [];
    for (const entry of this.pending.values()) {
      if (entry.sender.tabId !== tabId) continue;
      if (entry.sender.noteId) continue;
      if (!entry.sender.sourceNoteId) continue;
      conflicts.push(entry);
    }
    return conflicts;
  }

  /** The newest unresolved failure across all kinds of this sender, if any. */
  private newestFailure(token: string) {
    const state = this.tokens.get(token);
    if (!state) return undefined;
    let newest:
      | { generation: number; reason: SaveFlushFailureReason }
      | undefined;
    for (const kind of state.kinds.values()) {
      if (!kind.failure) continue;
      if (!newest || kind.failure.generation > newest.generation) {
        newest = kind.failure;
      }
    }
    return newest?.reason;
  }

  /**
   * True while the exact sender still has queued or in-flight saves (or an
   * unresolved failure) - the additive, non-blocking peek for a caller that
   * decides whether to start a flush at all.
   */
  isSavePending(tabId: string, noteId: string) {
    if (!tabId || !noteId) return false;
    const token = this.token(tabId, noteId);
    const state = this.tokens.get(token);
    return (
      this.pendingFor(tabId, noteId).length > 0 ||
      (state?.jobs.size ?? 0) > 0 ||
      !!this.newestFailure(token)
    );
  }

  /**
   * Forces the exact sender's queued saves to run and awaits every save of
   * that sender - the ones already in flight and the ones the flush itself
   * started - before reporting what actually happened. Nothing is guessed:
   * an awaited save must have reached the database for the flush to succeed.
   */
  async flushSaves(
    tabId: string,
    noteId: string,
    context: SaveBarrierContext
  ): Promise<SaveFlushResult> {
    // No default or current-note fallback: a barrier is only ever run for the
    // sender that asked for it.
    if (!tabId || !noteId)
      return { status: "aborted", reason: "invalid-sender" };
    if (context.isUnsupportedEditor())
      return { status: "aborted", reason: "unsupported-editor" };

    const before = context.readSender(tabId, noteId);
    if (!before.ok) return { status: "aborted", reason: before.reason };

    const token = this.token(tabId, noteId);
    const entries = this.pendingFor(tabId, noteId);

    // Truthful busy comes first: a sender with nothing queued that cannot be
    // written to right now (locked editor, note still loading, app loading) is
    // not "clean", and reporting it as clean would let a caller export
    // whatever the editor happens to hold.
    if (context.isEditorLocked())
      return { status: "busy", reason: "editor-locked" };
    if (context.isLoadingNote(noteId))
      return { status: "busy", reason: "note-loading" };
    if (context.isAppLoading())
      return { status: "busy", reason: "app-loading" };

    // Queued work that came from another note is neither this note's content
    // nor clean: it is recorded as a failure for its own kind.
    const conflicts = this.pendingConflicts(tabId);
    if (conflicts.length > 0) {
      this.bumpRevision(token);
      this.kind(token, conflicts[0].kind).failure = {
        generation: this.nextOrdinal(),
        reason: "save-failed"
      };
      return { status: "failed", reason: "save-failed" };
    }

    const state = this.tokens.get(token);
    const hasWork =
      entries.length > 0 ||
      (state?.jobs.size ?? 0) > 0 ||
      !!this.newestFailure(token);

    // Nothing queued and nothing failed: an ordinary, clean sender (a
    // persisted readonly note included) may proceed without a write.
    if (!hasWork) return { status: "nothing-pending" };

    // Force this sender's own debounced saves to run now: the barrier holds
    // the registration, so a scheduled-but-unfired timer cannot make the
    // flush settle early. Foreign senders' entries are never touched.
    for (const entry of entries) entry.run();

    const jobs = [...(this.tokens.get(token)?.jobs ?? [])];
    if (jobs.some((job) => !job.started))
      return { status: "busy", reason: "save-not-started" };

    // Snapshotted *after* the flush forced its own work, so the flush's own
    // scheduling/begin never reads as a new edit - otherwise every flush would
    // report `pendingAfter` and a bounded retry would never terminate.
    const revision = this.getSaveRevision(tabId, noteId);

    const results = await Promise.all(jobs.map((job) => job.result));

    // The sender must still be the same one that started the flush: same tab,
    // same note, same session and still the active tab.
    const after = context.readSender(tabId, noteId);
    if (!after.ok || after.sessionId !== before.sessionId)
      return { status: "aborted", reason: "sender-changed" };

    const finalState = this.tokens.get(token);
    const pendingAfter =
      this.pendingFor(tabId, noteId).length > 0 ||
      (finalState?.jobs.size ?? 0) > 0 ||
      // An edit that arrived *and fully settled* while the flush was awaiting
      // leaves nothing pending; only the revision shows that the snapshot the
      // flush is about to report no longer describes the sender.
      this.getSaveRevision(tabId, noteId) !== revision;

    // A failed save of *any* kind is reported before any id, so an unrelated
    // successful save can never mask it.
    const failure = this.newestFailure(token);
    if (failure) return { status: "failed", reason: failure };

    // The guards are cheap and can flip while the flush awaited: the note
    // started reloading, the app went back to loading, a sync merge locked the
    // editor. A sender that only became un-writable during the await must not
    // be exported as `saved` (or clean) on the strength of a pre-await
    // snapshot, so re-check them before reporting either. A real failure is
    // reported above and is not weakened by a busy guard.
    if (context.isEditorLocked())
      return { status: "busy", reason: "editor-locked" };
    if (context.isLoadingNote(noteId))
      return { status: "busy", reason: "note-loading" };
    if (context.isAppLoading())
      return { status: "busy", reason: "app-loading" };

    const id = results.find(
      (value): value is string => typeof value === "string"
    );
    if (id) return { status: "saved", id, pendingAfter };

    return { status: "nothing-pending" };
  }
}
