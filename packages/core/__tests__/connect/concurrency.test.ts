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
import { expectCode } from "./helpers.js";
import { createHarness, ConnectHarness } from "./fixtures.js";
import {
  DomainWriteToken,
  withDomainWrite
} from "../../src/connect/domain-lock.js";
import { noteRevision } from "../../src/connect/revision.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

/** A resolvable promise used to hold the domain write lock open. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function revisionOf(db: ConnectHarness["db"], noteId: string) {
  const note = await db.notes.note(noteId);
  const content = await db.content.findByNoteId(noteId);
  return noteRevision(note!, content);
}

/**
 * Every test below proves one half of the same contract: the shared domain
 * write lock (`connect/domain-lock.ts`) is what makes a note read-modify-write
 * atomic, so it must be held by the *reader* paths (content pre-processing), the
 * other writers (permanent delete) and the merge paths (sync), not only by the
 * Connect adapter and the editor.
 */
describe("VeyraN Connect domain write lease", () => {
  it("rejects a lease after its critical section exits", async () => {
    const db = {};
    let lease: DomainWriteToken | undefined;
    await withDomainWrite(db, async (token) => {
      lease = token;
    });

    let ran = false;
    await expect(
      withDomainWrite(
        db,
        async () => {
          ran = true;
        },
        lease
      )
    ).rejects.toThrow(/active lease/);
    expect(ran).toBe(false);
  });

  it("never lets a stale lease bypass a held lock", async () => {
    const db = {};
    let stale: DomainWriteToken | undefined;
    await withDomainWrite(db, async (token) => {
      stale = token;
    });

    const entered = gate();
    const hold = gate();
    const holder = withDomainWrite(db, async () => {
      entered.open();
      await hold.promise;
    });
    await entered.promise;

    let bypassed = false;
    await expect(
      withDomainWrite(
        db,
        async () => {
          bypassed = true;
        },
        stale
      )
    ).rejects.toThrow(/active lease/);
    expect(bypassed).toBe(false);

    // A tokenless writer still queues behind the held lock.
    let queued = false;
    const waiting = withDomainWrite(db, async () => {
      queued = true;
    });
    await nextTick();
    expect(queued).toBe(false);

    hold.open();
    await holder;
    await waiting;
    expect(queued).toBe(true);
  });

  it("rejects a lease issued for another database", async () => {
    const dbA = {};
    const dbB = {};
    await withDomainWrite(dbA, async (lease) => {
      await expect(
        withDomainWrite(dbB, async () => undefined, lease)
      ).rejects.toThrow(/active lease/);
    });
  });
});

describe("VeyraN Connect writers and the shared domain lock", () => {
  it("never writes a stale pre-processed row over a vault rewrite", async () => {
    harness = await createHarness();
    const noteId = harness.noteId;
    await harness.db.vault.create("vault-password");

    // Suspend the read after it observed the plaintext row and before its
    // pre-processing write-back.
    const content = harness.db.content;
    const original = content.preProcess.bind(content);
    const entered = gate();
    const hold = gate();
    let paused = false;
    content.preProcess = async (row) => {
      if (!paused) {
        paused = true;
        entered.open();
        await hold.promise;
      }
      return original(row);
    };

    try {
      const read = content.findByNoteId(noteId);
      await entered.promise;

      // A vault lock lands while the read is suspended.
      await harness.db.vault.add(noteId);

      hold.open();
      // The stale read may still report what it observed, but its write-back
      // must not restore that plaintext over the ciphertext.
      expect(await read).toBeTruthy();

      const stored = await harness.db
        .sql()
        .selectFrom("content")
        .select(["locked", "data"])
        .where("noteId", "=", noteId)
        .executeTakeFirst();
      expect(stored?.locked).toBeTruthy();
      expect(String(stored?.data)).not.toContain("hello");
    } finally {
      content.preProcess = original;
    }
  });

  it("runs a permanent note removal inside the domain lock", async () => {
    harness = await createHarness();
    const entered = gate();
    const hold = gate();
    const holder = withDomainWrite(harness.db, async () => {
      entered.open();
      await hold.promise;
    });
    await entered.promise;

    let removed = false;
    const removal = harness.db.notes.remove(harness.noteId).then(() => {
      removed = true;
    });
    await nextTick();
    expect(removed).toBe(false);

    hold.open();
    await holder;
    await removal;
    expect(removed).toBe(true);
    expect(await harness.db.notes.note(harness.noteId)).toBeFalsy();
    expect(await harness.db.content.findByNoteId(harness.noteId)).toBeFalsy();
  });

  it("serializes a note sync merge with the domain lock", async () => {
    harness = await createHarness();
    const entered = gate();
    const hold = gate();
    const holder = withDomainWrite(harness.db, async () => {
      entered.open();
      await hold.promise;
    });
    await entered.promise;

    let merged = false;
    let mergeError: unknown;
    const merge = harness.db.syncer.sync
      .processChunk(
        { type: "note", items: [], count: 0 } as never,
        [],
        {} as never
      )
      .then(
        () => {
          merged = true;
        },
        (error) => {
          mergeError = error;
        }
      );
    await nextTick();
    // The read→merge→put of note rows must hold the shared lock.
    expect(merged).toBe(false);

    hold.open();
    await holder;
    await merge;
    expect(mergeError).toBeUndefined();
    expect(merged).toBe(true);
  });

  it("fails closed when a vault lock lands during a Connect append", async () => {
    let injected = false;
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          if (label === "note" && !injected) {
            injected = true;
            await harness!.db.vault.create("vault-password");
            await harness!.db.vault.add(harness!.noteId);
          }
        }
      }
    });
    const r0 = await revisionOf(harness.db, harness.noteId);

    await expectCode(
      harness.adapter.execute({
        operation: "append_to_note",
        operationId: "vault-1",
        noteId: harness.noteId,
        content: "**tail**",
        expectedRevision: r0
      }),
      "NOTE_LOCKED"
    );

    // The vault body is intact: no prepared plaintext may replace it.
    const stored = await harness.db
      .sql()
      .selectFrom("content")
      .select(["locked", "data"])
      .where("noteId", "=", harness.noteId)
      .executeTakeFirst();
    expect(stored?.locked).toBeTruthy();
    expect(String(stored?.data)).not.toContain("<strong>tail</strong>");
    expect(String(stored?.data)).not.toContain("hello");
  });

  it("fails closed when the note is deleted during a Connect append", async () => {
    let injected = false;
    harness = await createHarness({
      instrumentation: {
        onStep: async (label) => {
          if (label === "note" && !injected) {
            injected = true;
            await harness!.db.notes.remove(harness!.noteId);
          }
        }
      }
    });
    const r0 = await revisionOf(harness.db, harness.noteId);

    await expectCode(
      harness.adapter.execute({
        operation: "append_to_note",
        operationId: "delete-1",
        noteId: harness.noteId,
        content: "tail",
        expectedRevision: r0
      }),
      "NOTE_NOT_FOUND"
    );

    expect(await harness.db.notes.note(harness.noteId)).toBeFalsy();
    expect(await harness.db.content.findByNoteId(harness.noteId)).toBeFalsy();
  });
});
