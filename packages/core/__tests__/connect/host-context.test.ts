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

import { describe, it, expect, afterEach } from "vitest";
import { expectCode, connectErrorCode } from "./helpers.js";
import { createHarness, ConnectHarness } from "./fixtures.js";
import type { ConnectHostContext } from "../../src/connect/adapter.js";
import { assertHostCurrent } from "../../src/connect/fence.js";
import { noteRevision } from "../../src/connect/revision.js";
import { CONTENT_LIMITS } from "../../src/connect/content.js";

/**
 * Per-invocation trusted host execution context.
 *
 * These tests exercise the *actual* encrypted SQLite note pipeline through the
 * existing `createHarness` fixture: every accepted context is verified against
 * real persisted state (or real note-history rows), and every rejected context
 * is verified to have produced no write.
 */

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

/** A predicate that always says the context is still current. */
const alwaysCurrent = () => undefined;

async function revisionOf(db: ConnectHarness["db"], noteId: string) {
  const note = await db.notes.note(noteId);
  const content = await db.content.findByNoteId(noteId);
  return noteRevision(note!, content);
}

/** Every note-history session id recorded for `noteId` (real persisted rows). */
async function sessionIdsOf(db: ConnectHarness["db"], noteId: string) {
  const rows = (await db.noteHistory.get(noteId).items()) as { id: string }[];
  return rows.map((row) => row.id);
}

async function noteCount(db: ConnectHarness["db"]) {
  return db.notes.all.count();
}

describe("VeyraN Connect host execution context", () => {
  it("keeps the no-context callers byte-for-byte unchanged", async () => {
    harness = await createHarness();
    const created = (await harness.adapter.execute({
      operation: "create_note",
      operationId: "hc-backcompat-1",
      content: "no host context"
    })) as { noteId: string; operationId: string };
    expect(created.operationId).toBe("hc-backcompat-1");
    expect(await harness.db.notes.exists(created.noteId)).toBe(true);
    // No context means no session attribution is invented.
    expect(await sessionIdsOf(harness.db, created.noteId)).toEqual([]);
  });

  it("forwards the host sessionId into the actual note write", async () => {
    harness = await createHarness();
    const context: ConnectHostContext = {
      operationId: "hc-create-1",
      sessionId: "host-session-1",
      assertCurrent: alwaysCurrent
    };
    const created = (await harness.adapter.execute(
      {
        operation: "create_note",
        operationId: "hc-create-1",
        content: "with session"
      },
      context
    )) as { noteId: string };
    expect(await harness.db.notes.exists(created.noteId)).toBe(true);
    expect(await sessionIdsOf(harness.db, created.noteId)).toEqual([
      `${created.noteId}_host-session-1`
    ]);
  });

  it("accepts note-scoped contexts with an exact noteId", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;

    const read = (await harness.adapter.execute(
      { operation: "get_note", noteId },
      { operationId: "hc-read-1", noteId, assertCurrent: alwaysCurrent }
    )) as { noteId: string; content: string };
    expect(read.noteId).toBe(noteId);
    expect(read.content).toContain("hello");

    const revision = await revisionOf(harness.db, noteId);
    const appended = (await harness.adapter.execute(
      {
        operation: "append_to_note",
        operationId: "hc-append-1",
        noteId,
        content: " tail",
        expectedRevision: revision
      },
      {
        operationId: "hc-append-1",
        noteId,
        sessionId: "host-append-session",
        assertCurrent: alwaysCurrent
      }
    )) as { revision: string };
    expect(appended.revision).not.toBe(revision);
    expect(await sessionIdsOf(harness.db, noteId)).toContain(
      `${noteId}_host-append-session`
    );
  });

  it("denies a wire request that tries to smuggle context fields", async () => {
    harness = await createHarness();
    const before = await noteCount(harness.db);
    const context: ConnectHostContext = {
      operationId: "hc-smuggle-1",
      sessionId: "host-session-smuggle",
      assertCurrent: alwaysCurrent
    };
    for (const smuggled of [
      { sessionId: "from-model" },
      { assertCurrent: "from-model" },
      { hostContext: { operationId: "from-model" } },
      { noteId: "from-model" }
    ]) {
      await expectCode(
        harness.adapter.execute(
          {
            operation: "create_note",
            operationId: "hc-smuggle-1",
            content: "smuggled",
            ...smuggled
          },
          context
        ),
        "INVALID_INPUT"
      );
    }
    expect(await noteCount(harness.db)).toBe(before);
  });

  it("rejects malformed host contexts without writing", async () => {
    harness = await createHarness();
    const before = await noteCount(harness.db);
    const cases: unknown[] = [
      null,
      [],
      42,
      "context",
      () => undefined,
      // missing/incorrect assertCurrent
      { operationId: "x" },
      { operationId: "x", assertCurrent: 1 },
      // missing/empty/oversized operationId
      { assertCurrent: alwaysCurrent },
      { operationId: "", assertCurrent: alwaysCurrent },
      {
        operationId: "x".repeat(CONTENT_LIMITS.maxIdChars + 1),
        assertCurrent: alwaysCurrent
      },
      // unknown key
      { operationId: "x", assertCurrent: alwaysCurrent, extra: true },
      // out-of-bounds noteId
      {
        operationId: "x",
        noteId: "n".repeat(CONTENT_LIMITS.maxIdChars + 1),
        assertCurrent: alwaysCurrent
      }
    ];
    for (const malformed of cases) {
      await expectCode(
        harness.adapter.execute(
          {
            operation: "create_note",
            operationId: "hc-malformed-1",
            content: "malformed"
          },
          malformed as ConnectHostContext
        ),
        "INVALID_INPUT"
      );
    }
    expect(await noteCount(harness.db)).toBe(before);
  });

  it("rejects a thenable host predicate without awaiting it", async () => {
    harness = await createHarness();
    const before = await noteCount(harness.db);
    const request = {
      operation: "create_note" as const,
      operationId: "hc-async-1",
      content: "async predicate"
    };
    // An `async` function returns a Promise.
    await expectCode(
      harness.adapter.execute(request, {
        operationId: "hc-async-1",
        assertCurrent: (async () => undefined) as unknown as () => void
      }),
      "INVALID_INPUT"
    );
    // A duck-typed thenable must be caught too, never awaited.
    await expectCode(
      harness.adapter.execute(request, {
        operationId: "hc-async-1",
        assertCurrent: (() => ({
          then: () => undefined
        })) as unknown as () => void
      }),
      "INVALID_INPUT"
    );
    expect(await noteCount(harness.db)).toBe(before);
  });

  it("enforces exact mutation operationId equality", async () => {
    harness = await createHarness();
    const before = await noteCount(harness.db);
    await expectCode(
      harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "hc-op-a",
          content: "mismatch"
        },
        { operationId: "hc-op-b", assertCurrent: alwaysCurrent }
      ),
      "INVALID_INPUT"
    );
    expect(await noteCount(harness.db)).toBe(before);

    // The same request with the matching operationId succeeds (no stranded
    // reservation from the rejected attempt).
    const created = (await harness.adapter.execute(
      { operation: "create_note", operationId: "hc-op-a", content: "mismatch" },
      { operationId: "hc-op-a", assertCurrent: alwaysCurrent }
    )) as { noteId: string };
    expect(await harness.db.notes.exists(created.noteId)).toBe(true);
  });

  it("enforces exact noteId scoping and rejects sessionId elsewhere", async () => {
    harness = await createHarness();
    const { noteId, listId } = harness;
    const before = await noteCount(harness.db);

    const cases: [unknown, ConnectHostContext][] = [
      // note-scoped read without the noteId
      [
        { operation: "get_note", noteId },
        { operationId: "hc-scope-1", assertCurrent: alwaysCurrent }
      ],
      // note-scoped read with a different noteId
      [
        { operation: "get_note", noteId },
        {
          operationId: "hc-scope-2",
          noteId: `${noteId}-other`,
          assertCurrent: alwaysCurrent
        }
      ],
      // sessionId on a read
      [
        { operation: "get_note", noteId },
        {
          operationId: "hc-scope-3",
          noteId,
          sessionId: "nope",
          assertCurrent: alwaysCurrent
        }
      ],
      // noteId on an unscoped create
      [
        { operation: "create_note", operationId: "hc-scope-4", content: "x" },
        {
          operationId: "hc-scope-4",
          noteId,
          assertCurrent: alwaysCurrent
        }
      ],
      // noteId and sessionId on a task create
      [
        {
          operation: "create_task",
          operationId: "hc-scope-5",
          listId,
          title: "task"
        },
        {
          operationId: "hc-scope-5",
          noteId,
          assertCurrent: alwaysCurrent
        }
      ],
      [
        {
          operation: "create_task",
          operationId: "hc-scope-6",
          listId,
          title: "task"
        },
        {
          operationId: "hc-scope-6",
          sessionId: "nope",
          assertCurrent: alwaysCurrent
        }
      ],
      // noteId on a search
      [
        { operation: "search_notes", query: "hello" },
        {
          operationId: "hc-scope-7",
          noteId,
          assertCurrent: alwaysCurrent
        }
      ]
    ];
    for (const [request, context] of cases) {
      await expectCode(
        harness.adapter.execute(request, context),
        "INVALID_INPUT"
      );
    }
    expect(await noteCount(harness.db)).toBe(before);
  });

  it("runs the host predicate at entry, before any await, exactly once", async () => {
    harness = await createHarness();
    const before = await noteCount(harness.db);
    let calls = 0;
    await expectCode(
      harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "hc-entry-1",
          content: "stale at entry"
        },
        {
          operationId: "hc-entry-1",
          assertCurrent: () => {
            calls++;
            throw new Error("ownership lost: 5ecret-token");
          }
        }
      ),
      "SESSION_CHANGED"
    );
    // Entry is the first thing that runs: the operation never reaches the
    // account read or the pipeline.
    expect(calls).toBe(1);
    expect(await noteCount(harness.db)).toBe(before);
  });

  it("never leaks the host exception text", async () => {
    harness = await createHarness();
    let caught: unknown;
    try {
      await harness.adapter.execute(
        { operation: "create_note", operationId: "hc-leak-1", content: "x" },
        {
          operationId: "hc-leak-1",
          assertCurrent: () => {
            throw new Error("5ecret-token-should-not-escape");
          }
        }
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("SESSION_CHANGED");
    expect((caught as { message: string }).message).not.toContain("5ecret");
    expect(JSON.stringify(caught)).not.toContain("5ecret");
  });

  it("denies a note read when ownership is lost before the response", async () => {
    let stale = false;
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          // `seal` is the operation's last suspension point, right before the
          // read's output objects are built.
          if (label === "seal") stale = true;
        }
      }
    });
    await expectCode(
      harness.adapter.execute(
        { operation: "get_note", noteId: harness.noteId },
        {
          operationId: "hc-seal-1",
          noteId: harness.noteId,
          assertCurrent: () => {
            if (stale) throw new Error("ownership lost");
          }
        }
      ),
      "SESSION_CHANGED"
    );
  });

  it("denies a note write when ownership is lost while suspended", async () => {
    let stale = false;
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          // Fires during the reservation's note read, before any persistence.
          if (label === "note") stale = true;
        }
      }
    });
    const noteBefore = await harness.db.notes.note(harness.noteId);
    const contentBefore = await harness.db.content.findByNoteId(harness.noteId);
    const revision = noteRevision(noteBefore!, contentBefore);

    await expectCode(
      harness.adapter.execute(
        {
          operation: "append_to_note",
          operationId: "hc-late-1",
          noteId: harness.noteId,
          content: "late tail",
          expectedRevision: revision
        },
        {
          operationId: "hc-late-1",
          noteId: harness.noteId,
          sessionId: "host-late-session",
          assertCurrent: () => {
            if (stale) throw new Error("ownership lost");
          }
        }
      ),
      "SESSION_CHANGED"
    );

    // Nothing was written: the stored body and its revision are untouched and
    // no session was attributed.
    const contentAfter = await harness.db.content.findByNoteId(harness.noteId);
    expect(contentAfter?.data).toBe(contentBefore?.data);
    expect(await sessionIdsOf(harness.db, harness.noteId)).toEqual([]);
  });

  it("keeps concurrent invocations on one adapter independent", async () => {
    harness = await createHarness();
    const before = await noteCount(harness.db);
    const results = await Promise.allSettled([
      harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "hc-conc-a",
          content: "concurrent A"
        },
        {
          operationId: "hc-conc-a",
          sessionId: "host-sess-a",
          assertCurrent: alwaysCurrent
        }
      ),
      harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "hc-conc-b",
          content: "concurrent B"
        },
        {
          operationId: "hc-conc-b",
          sessionId: "host-sess-b",
          assertCurrent: alwaysCurrent
        }
      ),
      harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "hc-conc-stale",
          content: "concurrent stale"
        },
        {
          operationId: "hc-conc-stale",
          sessionId: "host-sess-stale",
          assertCurrent: () => {
            throw new Error("this invocation is not current");
          }
        }
      )
    ]);

    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected"
    ]);
    const staleError = (results[2] as PromiseRejectedResult).reason;
    expect((staleError as { code?: string }).code).toBe("SESSION_CHANGED");

    const fulfilled = results as unknown as PromiseFulfilledResult<{
      noteId: string;
    }>[];
    const [a, b] = fulfilled.map((r) => r.value);
    expect(a.noteId).not.toBe(b.noteId);
    expect(await noteCount(harness.db)).toBe(before + 2);
    // No context contaminated another: each note carries exactly its own
    // session, and the failed invocation wrote nothing.
    expect(await sessionIdsOf(harness.db, a.noteId)).toEqual([
      `${a.noteId}_host-sess-a`
    ]);
    expect(await sessionIdsOf(harness.db, b.noteId)).toEqual([
      `${b.noteId}_host-sess-b`
    ]);
    expect(await sessionIdsOf(harness.db, a.noteId)).not.toContain(
      `${a.noteId}_host-sess-b`
    );
  });

  it("ignores caller mutation of the context after the call starts", async () => {
    const context: ConnectHostContext = {
      operationId: "hc-immutable-1",
      sessionId: "original-session",
      assertCurrent: alwaysCurrent
    };
    harness = await createHarness({
      instrumentation: {
        onStep: async () => {
          // The snapshot was taken at entry; mutating the caller's object while
          // the operation is suspended must change nothing.
          context.sessionId = "tampered-session";
          context.operationId = "tampered-operation";
        }
      }
    });
    const created = (await harness.adapter.execute(
      {
        operation: "create_note",
        operationId: "hc-immutable-1",
        // The notebook forces a real awaited fence step, so the mutation lands
        // mid-operation.
        notebookId: harness.notebookId,
        content: "immutable body"
      },
      context
    )) as { noteId: string };
    expect(await sessionIdsOf(harness.db, created.noteId)).toEqual([
      `${created.noteId}_original-session`
    ]);
  });

  it("asserts the host context for status at entry and before output", async () => {
    harness = await createHarness();
    const status = (await harness.adapter.execute(
      { operation: "status" },
      { operationId: "hc-status-1", assertCurrent: alwaysCurrent }
    )) as { operation: string; status: string };
    expect(status.operation).toBe("status");
    expect(status.status).toBe("ready");

    // A stale context denies the (content-free) status too — at entry.
    await expectCode(
      harness.adapter.execute(
        { operation: "status" },
        {
          operationId: "hc-status-2",
          assertCurrent: () => {
            throw new Error("stale");
          }
        }
      ),
      "SESSION_CHANGED"
    );

    // Status is unscoped: note/session fields are rejected.
    for (const extra of [{ noteId: "n" }, { sessionId: "s" }]) {
      await expectCode(
        harness.adapter.execute(
          { operation: "status" },
          {
            operationId: "hc-status-3",
            assertCurrent: alwaysCurrent,
            ...extra
          } as ConnectHostContext
        ),
        "INVALID_INPUT"
      );
    }
  });

  it("asserts the host context for task mutations", async () => {
    harness = await createHarness();
    const created = (await harness.adapter.execute(
      {
        operation: "create_task",
        operationId: "hc-task-1",
        listId: harness.listId,
        title: "host task"
      },
      { operationId: "hc-task-1", assertCurrent: alwaysCurrent }
    )) as { taskId: string };
    expect(created.taskId).toBeTruthy();

    // operationId mismatch on a task mutation.
    await expectCode(
      harness.adapter.execute(
        {
          operation: "update_task",
          operationId: "hc-task-2",
          taskId: created.taskId,
          expectedRevision: "nope",
          patch: { title: "x" }
        },
        { operationId: "hc-task-other", assertCurrent: alwaysCurrent }
      ),
      "INVALID_INPUT"
    );

    // A stale context denies the task mutation.
    await expectCode(
      harness.adapter.execute(
        {
          operation: "update_task",
          operationId: "hc-task-3",
          taskId: created.taskId,
          expectedRevision: "nope",
          patch: { title: "x" }
        },
        {
          operationId: "hc-task-3",
          assertCurrent: () => {
            throw new Error("stale");
          }
        }
      ),
      "SESSION_CHANGED"
    );
  });

  it("binds a method-style predicate to the frozen validated identity", async () => {
    let mutateOwner = true;
    let revokeNext = false;
    let stale = false;
    const first = {
      operationId: "hc-method-1",
      sessionId: "method-session",
      assertCurrent: function (this: {
        operationId: string;
        sessionId?: string;
      }) {
        if (
          this.operationId !== "hc-method-1" ||
          this.sessionId !== "method-session"
        )
          throw new Error("identity changed");
        if (stale) throw new Error("ownership revoked");
      }
    } as unknown as ConnectHostContext;
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          if (label !== "notebook") return;
          // The caller mutates its own object during a real awaited step.
          if (mutateOwner) {
            first.sessionId = "tampered-session";
            first.operationId = "tampered-operation";
          }
          // A revocation observed *outside* the caller object (a closure).
          if (revokeNext) stale = true;
        }
      }
    });

    // `this.operationId`/`this.sessionId` must stay the validated snapshot, so
    // the mutation is inert: the operation succeeds and the original session is
    // attributed in the real history row.
    const created = (await harness.adapter.execute(
      {
        operation: "create_note",
        operationId: "hc-method-1",
        notebookId: harness.notebookId,
        content: "method body"
      },
      first
    )) as { noteId: string };
    expect(await sessionIdsOf(harness.db, created.noteId)).toEqual([
      `${created.noteId}_method-session`
    ]);
    expect(first.operationId).toBe("tampered-operation");

    // The frozen snapshot pins identity, not liveness: an external revocation is
    // still observed through the same method-style predicate.
    mutateOwner = false;
    revokeNext = true;
    const second = {
      operationId: "hc-method-2",
      sessionId: "method-session-2",
      assertCurrent: function (this: {
        operationId: string;
        sessionId?: string;
      }) {
        if (this.operationId !== "hc-method-2")
          throw new Error("identity changed");
        if (stale) throw new Error("ownership revoked");
      }
    } as unknown as ConnectHostContext;
    const before = await noteCount(harness.db);
    await expectCode(
      harness.adapter.execute(
        {
          operation: "create_note",
          operationId: "hc-method-2",
          notebookId: harness.notebookId,
          content: "revoked body"
        },
        second
      ),
      "SESSION_CHANGED"
    );
    expect(await noteCount(harness.db)).toBe(before);
  });

  it("re-asserts the host context in the final status continuation", async () => {
    harness = await createHarness();
    let stale = false;
    const adapter = harness.adapter as unknown as {
      executeStatus: (hostAssert?: () => void) => Promise<unknown>;
    };
    const realStatus = adapter.executeStatus.bind(harness.adapter);
    adapter.executeStatus = async (...args: Parameters<typeof realStatus>) => {
      const status = await realStatus(...args);
      // The account read and the inner assertion have completed; revoke before
      // the outer continuation parses and returns the status.
      stale = true;
      return status;
    };
    await expectCode(
      harness.adapter.execute(
        { operation: "status" },
        {
          operationId: "hc-status-final-1",
          assertCurrent: () => {
            if (stale) throw new Error("ownership revoked");
          }
        }
      ),
      "SESSION_CHANGED"
    );
  });

  it("re-asserts the host context after the real output finalization", async () => {
    harness = await createHarness();
    let stale = false;
    const adapter = harness.adapter as unknown as {
      finalizeOutput: (
        fence: unknown,
        prepared: unknown
      ) => Promise<Record<string, unknown>>;
    };
    const realFinalize = adapter.finalizeOutput.bind(harness.adapter);
    adapter.finalizeOutput = async (
      ...args: Parameters<typeof realFinalize>
    ) => {
      const output = await realFinalize(...args);
      stale = true;
      return output;
    };
    // The response must reject (never resolve with a leaked output).
    await expectCode(
      harness.adapter.execute(
        { operation: "list_notebooks" },
        {
          operationId: "hc-final-1",
          assertCurrent: () => {
            if (stale) throw new Error("ownership revoked");
          }
        }
      ),
      "SESSION_CHANGED"
    );
  });

  it("re-asserts the host context at admission before dispatch", async () => {
    harness = await createHarness();
    let stale = false;
    const adapter = harness.adapter as unknown as {
      captureFence: (hostAssert?: () => void) => Promise<unknown>;
    };
    const realCapture = adapter.captureFence.bind(harness.adapter);
    adapter.captureFence = async (...args: Parameters<typeof realCapture>) => {
      const fence = await realCapture(...args);
      stale = true;
      return fence;
    };
    const before = await noteCount(harness.db);
    await expectCode(
      harness.adapter.execute(
        { operation: "create_note", operationId: "hc-admit-1", content: "x" },
        {
          operationId: "hc-admit-1",
          assertCurrent: () => {
            if (stale) throw new Error("ownership revoked");
          }
        }
      ),
      "SESSION_CHANGED"
    );
    // Denied before any operation-specific side effect.
    expect(await noteCount(harness.db)).toBe(before);
  });

  it("re-asserts the host context at the public return boundary from one entry snapshot", async () => {
    harness = await createHarness();
    const { noteId } = harness;
    let stale = false;
    let boundedResult: unknown;

    const adapter = harness.adapter as unknown as {
      executeBounded: (request: unknown, context?: unknown) => Promise<unknown>;
    };
    const original = adapter.executeBounded;
    const realBounded = original.bind(harness.adapter);
    const context: ConnectHostContext = {
      operationId: "hc-public-1",
      noteId,
      assertCurrent: () => {
        if (stale) throw new Error("ownership revoked");
      }
    };

    // Wrap *only this adapter's* private bounded method. It still runs the REAL
    // pipeline (including the bounded method's own final synchronous assertion);
    // only after it has returned do we revoke ownership and replace the caller's
    // original record. Only a boundary that re-asserts the *single entry
    // snapshot* can still deny the value the bounded method already produced.
    adapter.executeBounded = async (...args: Parameters<typeof realBounded>) => {
      const result = await realBounded(...args);
      boundedResult = result;
      stale = true;
      context.assertCurrent = () => undefined;
      context.operationId = "tampered-operation";
      context.sessionId = "tampered-session";
      return result;
    };

    let caught: unknown;
    try {
      await harness.adapter.execute({ operation: "get_note", noteId }, context);
    } catch (error) {
      caught = error;
    } finally {
      adapter.executeBounded = original;
    }

    // Denied at the public boundary: the code is SESSION_CHANGED (not
    // INVALID_INPUT), which proves the check ran on the frozen entry snapshot
    // rather than the caller's just-replaced record, and no note body was
    // returned (a note `content` field would only exist on a resolved value).
    expect(connectErrorCode(caught)).toBe("SESSION_CHANGED");
    expect((caught as { content?: unknown }).content).toBeUndefined();
    // Anti-fake-success control: the REAL bounded method did return the real,
    // persisted note, so this was a genuine leak that the boundary stopped.
    expect(boundedResult).toMatchObject({ operation: "get_note", noteId });
    expect((boundedResult as { content?: string }).content).toContain("hello");
  });

  it("re-asserts the host context at the public return boundary for status", async () => {
    harness = await createHarness();
    let stale = false;
    let boundedResult: unknown;

    const adapter = harness.adapter as unknown as {
      executeBounded: (request: unknown, context?: unknown) => Promise<unknown>;
    };
    const original = adapter.executeBounded;
    const realBounded = original.bind(harness.adapter);
    const context: ConnectHostContext = {
      operationId: "hc-public-status-1",
      assertCurrent: () => {
        if (stale) throw new Error("ownership revoked");
      }
    };

    adapter.executeBounded = async (...args: Parameters<typeof realBounded>) => {
      const result = await realBounded(...args);
      boundedResult = result;
      stale = true;
      context.assertCurrent = () => undefined;
      context.operationId = "tampered-operation";
      return result;
    };

    let caught: unknown;
    try {
      await harness.adapter.execute({ operation: "status" }, context);
    } catch (error) {
      caught = error;
    } finally {
      adapter.executeBounded = original;
    }

    // `status` flows through the same public method: a context revoked after the
    // real status object was built is still denied at the public boundary.
    expect(connectErrorCode(caught)).toBe("SESSION_CHANGED");
    expect(boundedResult).toMatchObject({ operation: "status", status: "ready" });
  });

  it("denies the remaining note writes when ownership is lost mid-persistence", async () => {
    harness = await createHarness();
    const { noteId } = harness;
    let stale = false;

    // Hook the *real* content persistence: the content row is an admitted
    // boundary, so revoking immediately after it resolves lands between it and
    // the next boundary (the note row / history) — exactly the mid-persistence
    // case a pre-write reservation check cannot cover.
    const realAdd = harness.db.content.add.bind(harness.db.content);
    harness.db.content.add = (async (...args: Parameters<typeof realAdd>) => {
      const result = await realAdd(...args);
      stale = true;
      return result;
    }) as unknown as typeof harness.db.content.add;

    const noteBefore = await harness.db.notes.note(noteId);
    const contentBefore = await harness.db.content.findByNoteId(noteId);
    const revision = noteRevision(noteBefore!, contentBefore);
    const request = {
      operation: "update_note" as const,
      operationId: "hc-midp-1",
      noteId,
      expectedRevision: revision,
      patch: { title: "mid-persist title", content: "mid-persist body" }
    };
    const context: ConnectHostContext = {
      operationId: "hc-midp-1",
      noteId,
      sessionId: "host-midp-session",
      assertCurrent: () => {
        if (stale) throw new Error("ownership lost");
      }
    };

    await expectCode(
      harness.adapter.execute(request, context),
      // The content row already landed, so verification cannot prove the write
      // never happened: the receipt is left uncertain (repairable) and only the
      // bounded error surfaces — never a fabricated rollback or a saved reply.
      "SESSION_CHANGED"
    );

    // The already-issued content write completed; the remaining note-row write
    // was denied by the next guard. No rollback is faked or asserted.
    const contentAfter = await harness.db.content.findByNoteId(noteId);
    expect(contentAfter?.data).not.toBe(contentBefore?.data);
    expect((await harness.db.notes.note(noteId))?.title).toBe(noteBefore?.title);

    // Re-running the same operation claims no success it cannot prove and does
    // not write again: the landed body/title split stays uncertain.
    stale = false;
    const landedBody = contentAfter?.data;
    await expectCode(
      harness.adapter.execute(request, context),
      "IDEMPOTENCY_UNCERTAIN"
    );
    expect((await harness.db.content.findByNoteId(noteId))?.data).toBe(
      landedBody
    );
    expect((await harness.db.notes.note(noteId))?.title).toBe(noteBefore?.title);
  });

  it("bounds a throwing then-getter and a non-void predicate return", async () => {
    harness = await createHarness();
    const before = await noteCount(harness.db);

    const throwingThen = (() => ({
      get then(): unknown {
        throw new Error("5ecret-then-getter");
      }
    })) as unknown as () => void;

    // Directly through the exported helper: the raw getter error never escapes.
    let direct: unknown;
    try {
      assertHostCurrent(throwingThen);
    } catch (error) {
      direct = error;
    }
    expect(connectErrorCode(direct)).toBe("INVALID_INPUT");
    expect(JSON.stringify(direct)).not.toContain("5ecret");

    // Through the adapter: bounded, and no write happens.
    await expectCode(
      harness.adapter.execute(
        { operation: "create_note", operationId: "hc-then-1", content: "x" },
        { operationId: "hc-then-1", assertCurrent: throwingThen }
      ),
      "INVALID_INPUT"
    );

    // An eventually-rejected predicate promise stays bounded (it is never
    // awaited) and cannot surface as an unhandled rejection.
    await expectCode(
      harness.adapter.execute(
        { operation: "create_note", operationId: "hc-reject-1", content: "x" },
        {
          operationId: "hc-reject-1",
          assertCurrent: (() =>
            Promise.reject(
              new Error("5ecret-rejection")
            )) as unknown as () => void
        }
      ),
      "INVALID_INPUT"
    );

    // The predicate contract is throw-based: a boolean return is malformed, not
    // an ownership signal that could be silently accepted as current.
    await expectCode(
      harness.adapter.execute(
        { operation: "create_note", operationId: "hc-bool-1", content: "x" },
        {
          operationId: "hc-bool-1",
          assertCurrent: (() => false) as unknown as () => void
        }
      ),
      "INVALID_INPUT"
    );
    expect(await noteCount(harness.db)).toBe(before);
  });
});
