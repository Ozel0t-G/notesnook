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

import { describe, expect, test, vi } from "vitest";
import { Sync } from "../sync/index.js";
import type Database from "../index.js";
import {
  LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
  MISSING_LOCAL_CIPHERTEXT_ERROR
} from "../../common.js";
import EventManager from "../../utils/event-manager.js";
import type { Attachment } from "../../types.js";

type PendingRow = Pick<Attachment, "id" | "hash" | "chunkSize"> & {
  // `failed` is nullable in SQLite; the typed Attachment model uses
  // `string | undefined`, so widen it here to cover unset (null) rows too.
  failed?: string | null;
  // `markAsFailed` bumps `dateModified` on every failed attempt, so this is
  // the age of the `MISSING_LOCAL_CIPHERTEXT_ERROR` marker.
  dateModified?: number;
};

const RETRY_AFTER_MS = 30 * 60 * 1000;
const AGED = () => Date.now() - (RETRY_AFTER_MS + 60 * 1000);
const FUTURE_BEYOND_SKEW = () => Date.now() + 365 * 24 * 60 * 60 * 1000;
const FUTURE_WITHIN_SKEW = () => Date.now() + 30 * 1000;

const invalidTimestamps: [string, number | null | undefined][] = [
  ["missing", undefined],
  ["null", null],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["zero", 0],
  ["negative", -1]
];

/**
 * Builds a `Sync` whose only live collaborators are the backend-affinity
 * check, the pending attachments selector and the file-storage queue. All
 * other dependencies (`Collector`, `Merger`, `AutoSync`, `SyncDevices`) only
 * capture `db` and subscribe to events in their constructors, so a minimal
 * stub is sufficient.
 */
function createSync(pending: PendingRow[]) {
  const eventManager = new EventManager();
  const exists = vi.fn<(hash: string) => Promise<boolean>>();
  const queueUploads = vi
    .fn<
      (
        files: { filename: string; chunkSize: number }[],
        groupId: string
      ) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  const markAsFailed =
    vi.fn<(id: string, reason?: string) => Promise<boolean>>();
  markAsFailed.mockResolvedValue(true);

  const fs = { exists, queueUploads, cancel: vi.fn(async () => undefined) };

  const db = {
    eventManager,
    kv: () => ({} as never),
    tokenManager: {} as never,
    user: {
      backendAffinity: {
        check: vi.fn(async () => ({ status: "match" })),
        isBlocked: vi.fn(async () => false)
      }
    },
    attachments: {
      pending: { items: vi.fn(async () => pending) },
      markAsFailed
    },
    fs: () => fs
  } as unknown as Database;

  return { sync: new Sync(db), exists, queueUploads, markAsFailed };
}

const queuedFiles = (
  queueUploads: ReturnType<typeof createSync>["queueUploads"]
) => {
  const calls = queueUploads.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][0] : [];
};

/**
 * `Sync.uploadAttachments` now snapshots the row's crypto generation onto every
 * queued upload. These `PendingRow` fixtures only set `id`/`hash`/`chunkSize`,
 * so the three absent crypto columns normalize to `null` (guarded with `IS
 * NULL` downstream), and `chunkSize` is carried verbatim.
 */
const gen = (chunkSize: number) => ({
  iv: null,
  salt: null,
  size: null,
  chunkSize
});

describe("Sync.uploadAttachments missing local ciphertext", () => {
  test("skips a fresh terminal-marker attachment when the local ciphertext is missing", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: Date.now()
      }
    ]);
    exists.mockResolvedValue(false);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(exists).toHaveBeenCalledWith("h1");
    // Nothing is queued and the marker is left intact so a later run can
    // retry once the marker ages or the bytes come back.
    expect(queuedFiles(queueUploads)).toEqual([]);
    expect(queueUploads).toHaveBeenCalledWith([], "sync-uploads");
    expect(markAsFailed).not.toHaveBeenCalled();
  });

  test("queues an aged terminal-marker attachment without clearing the marker", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 4,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: AGED()
      }
    ]);
    exists.mockResolvedValue(false);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    // The marker must survive the retry: the failed upload re-marks it (and
    // bumps dateModified) only if mobile's remote recovery also fails.
    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queueUploads).toHaveBeenCalledWith(
      [{ filename: "h1", chunkSize: 4, generation: gen(4) }],
      "sync-uploads"
    );
  });

  test("treats a marker at exactly the retry boundary as due", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        // A margin keeps this stable as the clock advances between setup and
        // read (age can only grow, which stays on the "due" side).
        dateModified: Date.now() - RETRY_AFTER_MS
      }
    ]);
    exists.mockResolvedValue(false);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h1", chunkSize: 1, generation: gen(1) }
    ]);
  });

  test.each(invalidTimestamps)(
    "treats a %s dateModified as due so a corrupt clock cannot block retries",
    async (_label, dateModified) => {
      const { sync, exists, queueUploads, markAsFailed } = createSync([
        {
          id: "a1",
          hash: "h1",
          chunkSize: 2,
          failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
          dateModified: dateModified as number | undefined
        }
      ]);
      exists.mockResolvedValue(false);

      await expect(sync.uploadAttachments()).resolves.toBeUndefined();

      expect(markAsFailed).not.toHaveBeenCalled();
      expect(queuedFiles(queueUploads)).toEqual([
        { filename: "h1", chunkSize: 2, generation: gen(2) }
      ]);
    }
  );

  test("treats an invalid far-future dateModified as due", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: FUTURE_BEYOND_SKEW()
      }
    ]);
    exists.mockResolvedValue(false);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h1", chunkSize: 1, generation: gen(1) }
    ]);
  });

  test("keeps a marker fresh when the timestamp is only slightly ahead of the clock", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: FUTURE_WITHIN_SKEW()
      }
    ]);
    exists.mockResolvedValue(false);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queuedFiles(queueUploads)).toEqual([]);
  });

  test("revives a terminal-marker attachment when the ciphertext reappears", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 7,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: Date.now()
      }
    ]);
    exists.mockResolvedValue(true);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    // Marker cleared without a reason (failed -> null) but dateUploaded is
    // never touched, so the row stays a normal pending upload.
    expect(markAsFailed).toHaveBeenCalledWith("a1");
    expect(queueUploads).toHaveBeenCalledWith(
      [{ filename: "h1", chunkSize: 7, generation: gen(7) }],
      "sync-uploads"
    );
  });

  test("revives a reappeared ciphertext even when the marker is aged", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 7,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: AGED()
      }
    ]);
    exists.mockResolvedValue(true);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(markAsFailed).toHaveBeenCalledWith("a1");
    expect(queueUploads).toHaveBeenCalledWith(
      [{ filename: "h1", chunkSize: 7, generation: gen(7) }],
      "sync-uploads"
    );
  });

  test("queues transient failures and unmarked rows without checking local files", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      { id: "a1", hash: "h1", chunkSize: 1, failed: "Network request failed" },
      { id: "a2", hash: "h2", chunkSize: 2, failed: null },
      { id: "a3", hash: "h3", chunkSize: 3, failed: undefined }
    ]);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(exists).not.toHaveBeenCalled();
    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h1", chunkSize: 1, generation: gen(1) },
      { filename: "h2", chunkSize: 2, generation: gen(2) },
      { filename: "h3", chunkSize: 3, generation: gen(3) }
    ]);
  });

  test("fails open when the local ciphertext check throws", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: AGED()
      }
    ]);
    exists.mockRejectedValue(new Error("disk unavailable"));

    // A failure to check must not turn into a sync failure.
    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(queueUploads).toHaveBeenCalledWith(
      [{ filename: "h1", chunkSize: 1, generation: gen(1) }],
      "sync-uploads"
    );
    expect(markAsFailed).not.toHaveBeenCalled();
  });

  test("queues only due rows when fresh, aged and missing attachments are mixed", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: Date.now()
      },
      {
        id: "a2",
        hash: "h2",
        chunkSize: 2,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: AGED()
      },
      { id: "a3", hash: "h3", chunkSize: 3, failed: null },
      {
        id: "a4",
        hash: "h4",
        chunkSize: 4,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR
      }
    ]);
    exists.mockResolvedValue(false);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    // h1 is fresh -> skipped; h2 is aged -> queued; h3 is unmarked -> queued;
    // h4 has no timestamp -> treated as due and queued. Order is preserved.
    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h2", chunkSize: 2, generation: gen(2) },
      { filename: "h3", chunkSize: 3, generation: gen(3) },
      { filename: "h4", chunkSize: 4, generation: gen(4) }
    ]);
    expect(queueUploads).toHaveBeenCalledTimes(1);
  });

  test("queues due and reappeared rows together without failing", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: AGED()
      },
      {
        id: "a2",
        hash: "h2",
        chunkSize: 2,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: AGED()
      },
      { id: "a3", hash: "h3", chunkSize: 3, failed: null }
    ]);
    exists.mockImplementation(async (hash) => hash === "h2");

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    // h1 is aged and still missing -> queue without clearing the marker;
    // h2 reappeared -> marker cleared; h3 is unmarked. Order is preserved.
    expect(markAsFailed).toHaveBeenCalledWith("a2");
    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h1", chunkSize: 1, generation: gen(1) },
      { filename: "h2", chunkSize: 2, generation: gen(2) },
      { filename: "h3", chunkSize: 3, generation: gen(3) }
    ]);
  });
});

describe("Sync.uploadAttachments local ciphertext repair failed", () => {
  test("skips a fresh repair-failed marker without checking the local file", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
        dateModified: Date.now()
      }
    ]);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    // The ciphertext is present but invalid, so a raw presence check must never
    // run: trusting `exists() === true` is exactly what cleared the marker and
    // re-ran the repair download on every sync (the hot loop).
    expect(exists).not.toHaveBeenCalled();
    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queueUploads).toHaveBeenCalledWith([], "sync-uploads");
  });

  test("never clears a repair-failed marker from a raw exists() result", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 4,
        failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
        dateModified: Date.now()
      }
    ]);
    // A size-valid corrupt local file makes mobile's exists() report `true`.
    exists.mockResolvedValue(true);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(exists).not.toHaveBeenCalled();
    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queuedFiles(queueUploads)).toEqual([]);
  });

  test("queues an aged repair-failed marker without clearing it", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 4,
        failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
        dateModified: AGED()
      }
    ]);
    exists.mockResolvedValue(true);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    // The marker survives the retry: a still-unrepairable upload re-marks it
    // (and bumps dateModified) only if mobile's remote repair fails again.
    expect(exists).not.toHaveBeenCalled();
    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queueUploads).toHaveBeenCalledWith(
      [{ filename: "h1", chunkSize: 4, generation: gen(4) }],
      "sync-uploads"
    );
  });

  test("treats a repair-failed marker at exactly the retry boundary as due", async () => {
    const { sync, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
        // Age can only grow between setup and read, which stays on the "due"
        // side of the boundary.
        dateModified: Date.now() - RETRY_AFTER_MS
      }
    ]);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h1", chunkSize: 1, generation: gen(1) }
    ]);
  });

  test.each(invalidTimestamps)(
    "treats a repair-failed marker with a %s dateModified as due",
    async (_label, dateModified) => {
      const { sync, queueUploads, markAsFailed } = createSync([
        {
          id: "a1",
          hash: "h1",
          chunkSize: 2,
          failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
          dateModified: dateModified as number | undefined
        }
      ]);

      await expect(sync.uploadAttachments()).resolves.toBeUndefined();

      expect(markAsFailed).not.toHaveBeenCalled();
      expect(queuedFiles(queueUploads)).toEqual([
        { filename: "h1", chunkSize: 2, generation: gen(2) }
      ]);
    }
  );

  test("treats an invalid far-future repair-failed dateModified as due", async () => {
    const { sync, queueUploads } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
        dateModified: FUTURE_BEYOND_SKEW()
      }
    ]);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h1", chunkSize: 1, generation: gen(1) }
    ]);
  });

  test("keeps a repair-failed marker fresh when the timestamp is only slightly ahead of the clock", async () => {
    const { sync, queueUploads } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
        dateModified: FUTURE_WITHIN_SKEW()
      }
    ]);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(queuedFiles(queueUploads)).toEqual([]);
  });

  test("queues a repaired attachment immediately once the marker is cleared", async () => {
    // Manual Retry (markAsFailed(id) with no reason), a successful upload
    // (markAsUploaded) and a Reupload commit all write `failed: null`, so the
    // row is queued as a normal pending upload with no backoff.
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      { id: "a1", hash: "h1", chunkSize: 1, failed: null }
    ]);

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    expect(exists).not.toHaveBeenCalled();
    expect(markAsFailed).not.toHaveBeenCalled();
    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h1", chunkSize: 1, generation: gen(1) }
    ]);
  });

  test("queues only the due rows when repair-failed, missing and transient rows are mixed", async () => {
    const { sync, exists, queueUploads, markAsFailed } = createSync([
      {
        id: "a1",
        hash: "h1",
        chunkSize: 1,
        failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
        dateModified: Date.now()
      },
      {
        id: "a2",
        hash: "h2",
        chunkSize: 2,
        failed: LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
        dateModified: AGED()
      },
      {
        id: "a3",
        hash: "h3",
        chunkSize: 3,
        failed: MISSING_LOCAL_CIPHERTEXT_ERROR,
        dateModified: Date.now()
      },
      { id: "a4", hash: "h4", chunkSize: 4, failed: "Network request failed" }
    ]);
    // Only the missing row's ciphertext reappeared (its size is valid again).
    exists.mockImplementation(async (hash) => hash === "h3");

    await expect(sync.uploadAttachments()).resolves.toBeUndefined();

    // The presence check runs only for the missing marker; the
    // present-but-invalid repair-failed rows are never passed to it.
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith("h3");
    // h1 (fresh repair-failed) is skipped; h2 (aged) is queued; h3 reappeared
    // -> marker cleared; h4 (transient) is queued. Order is preserved.
    expect(markAsFailed).toHaveBeenCalledTimes(1);
    expect(markAsFailed).toHaveBeenCalledWith("a3");
    expect(queuedFiles(queueUploads)).toEqual([
      { filename: "h2", chunkSize: 2, generation: gen(2) },
      { filename: "h3", chunkSize: 3, generation: gen(3) },
      { filename: "h4", chunkSize: 4, generation: gen(4) }
    ]);
    expect(queueUploads).toHaveBeenCalledTimes(1);
  });
});
