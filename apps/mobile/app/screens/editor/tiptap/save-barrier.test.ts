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
 * The barrier's bookkeeping on its own: which saves it awaits, how it scopes
 * them to one sender, and how a finished failure is kept until a newer
 * success supersedes it.
 *
 * The hook-level behaviour (the real debounce, the guards and the payloads
 * that reach the database) is covered by `use-editor-save.test.tsx`.
 */

import { SaveBarrier, SaveBarrierContext } from "./save-barrier";

const context = (overrides: Partial<SaveBarrierContext> = {}) =>
  ({
    readSender: () => ({ ok: true, sessionId: "session-1" }),
    isEditorLocked: () => false,
    isLoadingNote: () => false,
    isAppLoading: () => false,
    isUnsupportedEditor: () => false,
    ...overrides
  } as SaveBarrierContext);

function pendingId() {
  let resolve!: (value: string | undefined) => void;
  const promise = new Promise<string | undefined>((res) => (resolve = res));
  return { promise, resolve };
}

/** Lets the already-attached promises of a job settle. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const sender = { tabId: "tab-1", noteId: "note-1" };

describe("SaveBarrier", () => {
  it("awaits every queued and in-flight save of the exact sender", async () => {
    const barrier = new SaveBarrier();
    const order: string[] = [];

    // One save of this sender is already in flight...
    const inflight = pendingId();
    barrier.attachJob(barrier.beginJob(sender), inflight.promise);

    // ...and two more are queued behind their debounce timers. Like the hook,
    // the timer callback unregisters itself and starts the real save.
    const content = pendingId();
    const title = pendingId();
    const contentKey = "note-1:editor-event:content";
    const titleKey = "note-1:editor-event:title";
    const runContent = () => {
      barrier.completePending(contentKey, runContent);
      order.push("content");
      barrier.attachJob(barrier.beginJob(sender), content.promise);
    };
    const runTitle = () => {
      barrier.completePending(titleKey, runTitle);
      order.push("title");
      barrier.attachJob(barrier.beginJob(sender), title.promise);
    };
    barrier.registerPending(sender, contentKey, runContent);
    barrier.registerPending(sender, titleKey, runTitle);

    let settled = false;
    const flushing = barrier
      .flushSaves("tab-1", "note-1", context())
      .then((result) => {
        settled = true;
        return result;
      });

    // The flush itself forced both queued saves to run, without any timer.
    expect(order).toEqual(["content", "title"]);
    inflight.resolve("note-1");
    await tick();
    // Still waiting: the in-flight save alone does not finish the flush.
    expect(settled).toBe(false);

    content.resolve("note-1");
    title.resolve("note-1");
    expect(await flushing).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: false
    });
    expect(barrier.isSavePending("tab-1", "note-1")).toBe(false);
  });

  it("never runs or awaits a foreign sender's queued save", async () => {
    const barrier = new SaveBarrier();
    const ran: string[] = [];
    barrier.registerPending(
      { tabId: "tab-2", noteId: "note-1" },
      "note-1:editor-event:content",
      () => ran.push("tab-2")
    );

    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
    expect(ran).toEqual([]);
    // The foreign save is still queued for its own sender.
    expect(barrier.isSavePending("tab-2", "note-1")).toBe(true);
  });

  it("keeps a finished failure until a newer successful save supersedes it", async () => {
    const barrier = new SaveBarrier();
    barrier.attachJob(barrier.beginJob(sender), Promise.resolve(undefined));
    await tick();

    // The failure finished before the flush started: it must not read clean.
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "failed",
      reason: "save-failed"
    });

    barrier.attachJob(barrier.beginJob(sender), Promise.resolve("note-1"));
    await tick();

    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
  });

  it("records a guarded drop that no later save has superseded", async () => {
    const barrier = new SaveBarrier();
    barrier.markGuardedDrop(sender);

    expect(barrier.isSavePending("tab-1", "note-1")).toBe(true);
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "failed",
      reason: "dropped-while-guarded"
    });

    barrier.attachJob(barrier.beginJob(sender), Promise.resolve("note-1"));
    await tick();
    expect(barrier.isSavePending("tab-1", "note-1")).toBe(false);
  });

  it("reports edits that arrived while the flush was awaiting", async () => {
    const barrier = new SaveBarrier();
    barrier.attachJob(barrier.beginJob(sender), Promise.resolve("note-1"));

    const flushing = barrier.flushSaves("tab-1", "note-1", context());
    barrier.registerPending(
      sender,
      "note-1:editor-event:content",
      () => undefined
    );

    expect(await flushing).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: true
    });
  });

  it("stays busy for a save that was queued but has not started", async () => {
    const barrier = new SaveBarrier();
    // The app-loading deferral registers the job before `saveNote` runs.
    barrier.beginJob(sender);

    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "busy",
      reason: "save-not-started"
    });
  });

  it("reports a locked, loading or app-loading editor as busy", async () => {
    const options: Partial<SaveBarrierContext>[] = [
      { isEditorLocked: () => true },
      { isLoadingNote: () => true },
      { isAppLoading: () => true }
    ];
    const reasons = ["editor-locked", "note-loading", "app-loading"];

    for (let index = 0; index < options.length; index++) {
      const barrier = new SaveBarrier();
      barrier.registerPending(
        sender,
        "note-1:editor-event:content",
        () => undefined
      );
      expect(
        await barrier.flushSaves("tab-1", "note-1", context(options[index]))
      ).toEqual({ status: "busy", reason: reasons[index] });
      // The queued save is retained for the next flush.
      expect(barrier.isSavePending("tab-1", "note-1")).toBe(true);
    }
  });

  it("refuses a missing sender and an unsupported editor", async () => {
    const barrier = new SaveBarrier();

    expect(await barrier.flushSaves("tab-1", "", context())).toEqual({
      status: "aborted",
      reason: "invalid-sender"
    });
    expect(
      await barrier.flushSaves(
        "tab-1",
        "note-1",
        context({ isUnsupportedEditor: () => true })
      )
    ).toEqual({ status: "aborted", reason: "unsupported-editor" });
    expect(
      await barrier.flushSaves(
        "tab-1",
        "note-1",
        context({
          readSender: () => ({ ok: false, reason: "inactive-sender" })
        })
      )
    ).toEqual({ status: "aborted", reason: "inactive-sender" });
  });

  it("aborts when the sender's session changed while awaiting", async () => {
    const barrier = new SaveBarrier();
    let session = "session-1";
    barrier.attachJob(
      barrier.beginJob(sender),
      new Promise((resolve) =>
        setTimeout(() => {
          session = "session-2";
          resolve("note-1");
        }, 0)
      )
    );

    const result = await barrier.flushSaves(
      "tab-1",
      "note-1",
      context({ readSender: () => ({ ok: true, sessionId: session }) })
    );

    expect(result).toEqual({ status: "aborted", reason: "sender-changed" });
  });

  it("does not let a successful title save clear a failed content save", async () => {
    const barrier = new SaveBarrier();
    barrier.attachJob(
      barrier.beginJob(sender, "content"),
      Promise.resolve(undefined)
    );
    barrier.attachJob(
      barrier.beginJob(sender, "title"),
      Promise.resolve("note-1")
    );
    await tick();

    // The body was never persisted: the title write must not hide that.
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "failed",
      reason: "save-failed"
    });

    // Only a *newer successful content* save supersedes it.
    barrier.attachJob(
      barrier.beginJob(sender, "content"),
      Promise.resolve("note-1")
    );
    await tick();
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
  });

  it("does not let a successful content save clear a failed title save", async () => {
    const barrier = new SaveBarrier();
    barrier.attachJob(
      barrier.beginJob(sender, "title"),
      Promise.resolve(undefined)
    );
    barrier.attachJob(
      barrier.beginJob(sender, "content"),
      Promise.resolve("note-1")
    );
    await tick();

    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "failed",
      reason: "save-failed"
    });

    barrier.attachJob(
      barrier.beginJob(sender, "title"),
      Promise.resolve("note-1")
    );
    await tick();
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
  });

  it("keeps a guarded content drop failed when only a title save succeeds", async () => {
    const barrier = new SaveBarrier();
    barrier.markGuardedDrop(sender, "content");

    barrier.attachJob(
      barrier.beginJob(sender, "title"),
      Promise.resolve("note-1")
    );
    await tick();

    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "failed",
      reason: "dropped-while-guarded"
    });

    barrier.attachJob(
      barrier.beginJob(sender, "content"),
      Promise.resolve("note-1")
    );
    await tick();
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
  });

  it("ignores a late failure a newer same-kind success already superseded", async () => {
    const barrier = new SaveBarrier();
    const older = pendingId();
    barrier.attachJob(barrier.beginJob(sender, "content"), older.promise);
    barrier.attachJob(
      barrier.beginJob(sender, "content"),
      Promise.resolve("note-1")
    );
    await tick();

    // The newer content save already wrote the body; the older one settling
    // late must not resurrect a failure for it.
    older.resolve(undefined);
    await tick();

    expect(barrier.isSavePending("tab-1", "note-1")).toBe(false);
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
  });

  it("reports failure when an awaited save failed, even if another succeeded", async () => {
    const barrier = new SaveBarrier();
    const failing = pendingId();
    const succeeding = pendingId();
    barrier.attachJob(barrier.beginJob(sender, "content"), failing.promise);
    barrier.attachJob(barrier.beginJob(sender, "title"), succeeding.promise);

    const flushing = barrier.flushSaves("tab-1", "note-1", context());
    succeeding.resolve("note-1");
    failing.resolve(undefined);

    expect(await flushing).toEqual({ status: "failed", reason: "save-failed" });
  });

  it("reports a clean sender as busy while it cannot be written to", async () => {
    const guards: Partial<SaveBarrierContext>[] = [
      { isEditorLocked: () => true },
      { isLoadingNote: () => true },
      { isAppLoading: () => true }
    ];
    const reasons = ["editor-locked", "note-loading", "app-loading"];

    for (let index = 0; index < guards.length; index++) {
      const barrier = new SaveBarrier();
      // Nothing is queued at all, but the sender still must not read clean.
      expect(barrier.isSavePending("tab-1", "note-1")).toBe(false);
      expect(
        await barrier.flushSaves("tab-1", "note-1", context(guards[index]))
      ).toEqual({ status: "busy", reason: reasons[index] });
    }

    // Without any guard and without work, a clean sender is clean.
    const barrier = new SaveBarrier();
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
  });

  it("reports a first-save entry from another note as failed, not clean", async () => {
    const barrier = new SaveBarrier();
    barrier.registerPending(
      { tabId: "tab-1", sourceNoteId: "note-2" },
      "tab-1:editor-event:content",
      () => undefined
    );

    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "failed",
      reason: "save-failed"
    });
    expect(barrier.isSavePending("tab-1", "note-1")).toBe(true);
  });

  it("keeps a monotonic revision that survives the sender becoming clean", async () => {
    const barrier = new SaveBarrier();
    const start = barrier.getSaveRevision("tab-1", "note-1");

    const first = pendingId();
    barrier.attachJob(barrier.beginJob(sender, "content"), first.promise);
    const begun = barrier.getSaveRevision("tab-1", "note-1");
    expect(begun).toBeGreaterThan(start);

    first.resolve("note-1");
    await tick();

    // Clean again, but the counter is not reset: a caller that captured
    // `begun` still sees that this edit fully settled.
    expect(barrier.isSavePending("tab-1", "note-1")).toBe(false);
    expect(barrier.getSaveRevision("tab-1", "note-1")).toBe(begun);

    const run = () => undefined;
    barrier.registerPending({ tabId: "tab-3", noteId: "note-1" }, "key", run);
    expect(barrier.getSaveRevision("tab-3", "note-1")).toBe(1);

    barrier.attachJob(
      barrier.beginJob(sender, "content"),
      Promise.resolve("note-1")
    );
    await tick();
    expect(barrier.getSaveRevision("tab-1", "note-1")).toBeGreaterThan(begun);

    // A foreign tab's revision is its own.
    expect(barrier.getSaveRevision("tab-2", "note-1")).toBe(0);
  });

  it("reports pendingAfter for an edit that settled while the flush awaited", async () => {
    const barrier = new SaveBarrier();
    const inflight = pendingId();
    barrier.attachJob(barrier.beginJob(sender, "content"), inflight.promise);

    const flushing = barrier.flushSaves("tab-1", "note-1", context());
    // A new content edit arrives and settles *completely* before the awaited
    // save does: nothing is pending anymore, only the revision moved.
    barrier.attachJob(
      barrier.beginJob(sender, "content"),
      Promise.resolve("note-1")
    );
    await tick();
    inflight.resolve("note-1");

    expect(await flushing).toEqual({
      status: "saved",
      id: "note-1",
      pendingAfter: true
    });
  });

  it("does not let an older queued save's success clear a newer guarded drop", async () => {
    const barrier = new SaveBarrier();
    const contentKey = "note-1:editor-event:content";
    const content = pendingId();
    // The edit is queued first; its real job only begins when the flush forces
    // the debounce, which can be long after a newer edit was dropped.
    let ticket = 0;
    const runContent = () => {
      barrier.completePending(contentKey, runContent);
      barrier.attachJob(
        barrier.beginJob(sender, "content", ticket),
        content.promise
      );
    };
    ticket = barrier.registerPending(sender, contentKey, runContent, "content");

    // A newer content edit is dropped by the guard while the older one is
    // still sitting in the debounce.
    barrier.markGuardedDrop(sender, "content");

    const flushing = barrier.flushSaves("tab-1", "note-1", context());
    await tick();
    // The forced older save succeeded, but it is *older* than the drop.
    content.resolve("note-1");
    expect(await flushing).toEqual({
      status: "failed",
      reason: "dropped-while-guarded"
    });
    expect(barrier.isSavePending("tab-1", "note-1")).toBe(true);

    // Only a genuinely newer content write - a direct beginJob without a
    // registration ticket included - supersedes the drop.
    barrier.attachJob(
      barrier.beginJob(sender, "content"),
      Promise.resolve("note-1")
    );
    await tick();
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
  });

  it("re-checks the guards after awaiting and reports a newly busy sender as busy", async () => {
    const cases: {
      guard: (busy: { value: boolean }) => Partial<SaveBarrierContext>;
      reason: string;
    }[] = [
      {
        guard: (busy) => ({ isEditorLocked: () => busy.value }),
        reason: "editor-locked"
      },
      {
        guard: (busy) => ({ isLoadingNote: () => busy.value }),
        reason: "note-loading"
      },
      {
        guard: (busy) => ({ isAppLoading: () => busy.value }),
        reason: "app-loading"
      }
    ];

    for (const { guard, reason } of cases) {
      const barrier = new SaveBarrier();
      const inflight = pendingId();
      barrier.attachJob(barrier.beginJob(sender, "content"), inflight.promise);

      // The guard is off at the synchronous pre-check, then flips while the
      // flush is awaiting the in-flight save.
      const busy = { value: false };
      const flushing = barrier.flushSaves(
        "tab-1",
        "note-1",
        context(guard(busy))
      );
      busy.value = true;
      inflight.resolve("note-1");

      expect(await flushing).toEqual({ status: "busy", reason });
    }
  });

  it("records a displaced sender's evicted queued save as failed, not clean", async () => {
    const barrier = new SaveBarrier();
    const key = "note-1:editor-event:content";
    const ran: string[] = [];
    const runA = () => {
      barrier.completePending(key, runA);
      ran.push("tab-1");
    };
    const runB = () => {
      barrier.completePending(key, runB);
      ran.push("tab-2");
    };

    barrier.registerPending(
      { tabId: "tab-1", noteId: "note-1" },
      key,
      runA,
      "content"
    );
    // A different tab on the same note shares the timer key and evicts tab-1's
    // queued payload; nothing will ever run it.
    barrier.registerPending(
      { tabId: "tab-2", noteId: "note-1" },
      key,
      runB,
      "content"
    );

    expect(barrier.isSavePending("tab-1", "note-1")).toBe(true);
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "failed",
      reason: "dropped-while-guarded"
    });

    // The displacing sender's own queued save is untouched: forcing it runs it.
    expect(await barrier.flushSaves("tab-2", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
    expect(ran).toEqual(["tab-2"]);

    // A newer same-kind success for tab-1 supersedes its displaced failure.
    barrier.attachJob(
      barrier.beginJob({ tabId: "tab-1", noteId: "note-1" }, "content"),
      Promise.resolve("note-1")
    );
    await tick();
    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "nothing-pending"
    });
  });

  it("fails closed for an ambiguous payload with a source note id but no note id", async () => {
    const barrier = new SaveBarrier();
    const ran: string[] = [];
    barrier.registerPending(
      { tabId: "tab-1", sourceNoteId: "note-1" },
      "tab-1:editor-event:content",
      () => ran.push("ambiguous"),
      "content"
    );

    expect(await barrier.flushSaves("tab-1", "note-1", context())).toEqual({
      status: "failed",
      reason: "save-failed"
    });
    // The ambiguous payload is never forced: with no note id it would resolve
    // under an unknown token and write an empty note there.
    expect(ran).toEqual([]);
    expect(barrier.isSavePending("tab-1", "note-1")).toBe(true);
  });
});
