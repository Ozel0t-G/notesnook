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
import { AttachmentGeneration, FileStorage } from "../src/database/fs.js";
import { Sync } from "../src/api/sync/index.js";
import EventManager from "../src/utils/event-manager.js";
import hosts from "../src/utils/constants.js";
import { bindCredential } from "../src/utils/credential-host-binding.js";
import { EVENTS, MISSING_LOCAL_CIPHERTEXT_ERROR } from "../src/common.js";
import { databaseTest, loginFakeUser } from "./utils";

type UploadedEvent = {
  error: unknown;
  success: boolean;
  total: number;
  current: number;
  groupId: string;
  filename: string;
  generation?: AttachmentGeneration;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Builds a FileStorage whose single upload is held open by a deferred
 * `execute` so a second group can hit the in-flight duplicate branch.
 * Binds a unique token so `assertCredentialDestination` is satisfied without
 * touching the network.
 */
function createStorage(token: string) {
  bindCredential(token, { api: hosts.API_HOST, auth: hosts.AUTH_HOST });

  const operation = deferred<boolean>();
  const uploadFile = vi.fn(() => ({
    execute: vi.fn(() => operation.promise),
    cancel: vi.fn(async () => undefined)
  }));

  const eventManager = new EventManager();
  const uploaded: UploadedEvent[] = [];
  const started: { groupId: string; filename: string }[] = [];
  eventManager.subscribe(EVENTS.fileUploaded, (event: UploadedEvent) =>
    uploaded.push(event)
  );
  eventManager.subscribe(
    EVENTS.fileUpload,
    (event: { groupId: string; filename: string }) => started.push(event)
  );

  const storage = new FileStorage(
    { uploadFile } as never,
    { getAccessToken: async () => token } as never,
    eventManager
  );

  return { storage, uploadFile, uploaded, started, operation };
}

const FILE = { filename: "attachment.bin", chunkSize: 1 };

function byGroup(events: UploadedEvent[]) {
  return Object.fromEntries(events.map((e) => [e.groupId, e]));
}

describe("FileStorage.queueUploads duplicate uploads", () => {
  test("a second group awaits the in-flight promise and does not start a second upload", async () => {
    const { storage, uploadFile, uploaded, started, operation } = createStorage(
      "dup-upload-success-token"
    );

    const first = storage.queueUploads([FILE], "group-1");
    await vi.waitFor(() => expect(storage.uploads.size).toBe(1));

    let secondSettled = false;
    const second = storage.queueUploads([FILE], "group-2").then(() => {
      secondSettled = true;
    });
    await vi.waitFor(() =>
      expect(storage.groups.uploads.has("group-2")).toBe(true)
    );

    // Flush pending microtasks: the duplicate branch must still be awaiting
    // the first group's unresolved operation.
    await Promise.resolve();
    await Promise.resolve();
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);
    expect(secondSettled).toBe(false);

    operation.resolve(true);
    await Promise.all([first, second]);

    expect(secondSettled).toBe(true);
    expect(uploadFile).toHaveBeenCalledTimes(1);

    expect(uploaded).toHaveLength(2);
    const events = byGroup(uploaded);
    expect(events["group-1"].filename).toBe(FILE.filename);
    expect(events["group-2"].filename).toBe(FILE.filename);
    expect(events["group-1"].success).toBe(true);
    expect(events["group-2"].success).toBe(true);
    // Group 1 publishes the local error (null); the duplicate branch
    // republishes the stored error (undefined on success). Assert falsy.
    expect(events["group-1"].error == null).toBe(true);
    expect(events["group-2"].error == null).toBe(true);
  });

  test("both groups report the rejection error when the in-flight upload fails", async () => {
    const { storage, uploadFile, uploaded, started, operation } = createStorage(
      "dup-upload-failure-token"
    );
    const boom = new Error("upload failed");

    const first = storage.queueUploads([FILE], "group-1");
    await vi.waitFor(() => expect(storage.uploads.size).toBe(1));

    const second = storage.queueUploads([FILE], "group-2");
    await vi.waitFor(() =>
      expect(storage.groups.uploads.has("group-2")).toBe(true)
    );

    operation.reject(boom);
    await Promise.all([first, second]);

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);

    expect(uploaded).toHaveLength(2);
    const events = byGroup(uploaded);
    expect(events["group-1"].success).toBe(false);
    expect(events["group-2"].success).toBe(false);
    // The thrown Error is normalized to its message and shared by both groups.
    expect(events["group-1"].error).toBe("upload failed");
    expect(events["group-2"].error).toBe("upload failed");
  });

  test("normalizes a non-Error rejection into a string", async () => {
    const { storage, uploaded, operation } = createStorage(
      "dup-upload-non-error-token"
    );

    const first = storage.queueUploads([FILE], "group-1");
    await vi.waitFor(() => expect(storage.uploads.size).toBe(1));

    operation.reject("plain string failure");
    await first;

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].error).toBe("plain string failure");
  });

  test("publishes the missing-local-ciphertext marker verbatim", async () => {
    const { storage, uploaded, operation } = createStorage(
      "missing-local-ciphertext-token"
    );

    const first = storage.queueUploads([FILE], "group-1");
    await vi.waitFor(() => expect(storage.uploads.size).toBe(1));

    operation.reject(new Error(MISSING_LOCAL_CIPHERTEXT_ERROR));
    await first;

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].error).toBe(MISSING_LOCAL_CIPHERTEXT_ERROR);
    expect(uploaded[0].error).not.toBe(
      "Error: " + MISSING_LOCAL_CIPHERTEXT_ERROR
    );
  });
});

describe("FileStorage.queueUploads crypto generation", () => {
  const G1: AttachmentGeneration = {
    iv: "iv-1",
    salt: "salt-1",
    size: 10,
    chunkSize: 1
  };
  const G2: AttachmentGeneration = {
    iv: "iv-2",
    salt: "salt-2",
    size: 20,
    chunkSize: 1
  };

  test("publishes the queued generation on the primary upload result", async () => {
    const { storage, uploaded, operation } = createStorage(
      "generation-primary-token"
    );

    const first = storage.queueUploads(
      [{ ...FILE, generation: G1 }],
      "group-1"
    );
    await vi.waitFor(() => expect(storage.uploads.size).toBe(1));

    operation.resolve(true);
    await first;

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].success).toBe(true);
    expect(uploaded[0].generation).toEqual(G1);
  });

  test("the duplicate event carries the in-flight generation, not the newer request's", async () => {
    const { storage, uploaded, operation } = createStorage(
      "generation-duplicate-token"
    );

    const first = storage.queueUploads(
      [{ ...FILE, generation: G1 }],
      "group-1"
    );
    await vi.waitFor(() => expect(storage.uploads.size).toBe(1));

    // A second, newer-generation request while the G1 bytes are still being
    // uploaded: the duplicate branch must report G1 because those are the
    // bytes this operation actually read.
    const second = storage.queueUploads(
      [{ ...FILE, generation: G2 }],
      "group-2"
    );
    await vi.waitFor(() =>
      expect(storage.groups.uploads.has("group-2")).toBe(true)
    );

    operation.resolve(true);
    await Promise.all([first, second]);

    const events = byGroup(uploaded);
    expect(events["group-1"].generation).toEqual(G1);
    expect(events["group-2"].generation).toEqual(G1);
  });

  test("omits the generation for legacy queue producers", async () => {
    const { storage, uploaded, operation } = createStorage(
      "generation-legacy-token"
    );

    const first = storage.queueUploads([FILE], "group-1");
    await vi.waitFor(() => expect(storage.uploads.size).toBe(1));

    operation.resolve(true);
    await first;

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].generation).toBeUndefined();
  });
});

// `queueUploads` publishes `success: false` with `error: null` whenever
// `uploadFile` *resolves* `false` (a transient deferral: an explicit reupload
// in flight, an unresolvable App Group path, a feature gate, a failed
// post-upload verification). The `Attachments.fileUploaded` handler must treat
// that as "no durable failure to record" and leave the row (and any bounded
// marker + its 30-minute backoff) untouched, instead of clobbering it with a
// generic "Failed to upload attachment." that would hot-loop every sync.
describe("Attachments.fileUploaded deferral handling", () => {
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  async function saveAttachment(db: Awaited<ReturnType<typeof databaseTest>>) {
    const hash = await db.attachments.save(PNG_BASE64, "image/png", "t.png");
    if (!hash) throw new Error("Failed to create attachment");
    const attachment = await db.attachments.attachment(hash);
    if (!attachment) throw new Error("Failed to load attachment");
    return { hash, attachment };
  }

  test("a falsy error leaves an existing bounded marker and its backoff intact", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash, attachment } = await saveAttachment(db);
    await db.attachments.markAsFailed(
      attachment.id,
      MISSING_LOCAL_CIPHERTEXT_ERROR
    );
    const before = await db.attachments.attachment(hash);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: false,
      error: null,
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1
    });
    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: false,
      error: undefined,
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1
    });

    const after = await db.attachments.attachment(hash);
    // The bounded marker is preserved verbatim...
    expect(after?.failed).toBe(MISSING_LOCAL_CIPHERTEXT_ERROR);
    // ...and no write happened (markAsFailed bumps dateModified).
    expect(after?.dateModified).toBe(before?.dateModified);
  });

  test("a falsy error leaves an unmarked row untouched", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash } = await saveAttachment(db);
    const before = await db.attachments.attachment(hash);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: false,
      error: null,
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1
    });

    const after = await db.attachments.attachment(hash);
    expect(after?.failed == null).toBe(true);
    expect(after?.dateModified).toBe(before?.dateModified);
  });

  test("a real error reason is still recorded verbatim", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash } = await saveAttachment(db);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: false,
      error: "boom",
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1
    });

    expect((await db.attachments.attachment(hash))?.failed).toBe("boom");
  });

  test("an Error reason persists its message", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash } = await saveAttachment(db);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: false,
      error: new Error("network down"),
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1
    });

    expect((await db.attachments.attachment(hash))?.failed).toBe(
      "network down"
    );
  });
});

// A late `fileUploaded` result of a pre-reupload upload must not touch the row
// once an Apple Reupload replaced its `iv`/`salt`/`size`/`chunkSize` (it would
// otherwise mark the *new* ciphertext uploaded or failed even though the remote
// object is the old one). The event's `generation` snapshot is matched against
// the row's current crypto inside the SQL `WHERE`, so only a matching result
// applies; an absent generation keeps the unguarded legacy behavior.
describe("Attachments.fileUploaded crypto generation guard", () => {
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  async function saveAttachment(db: Awaited<ReturnType<typeof databaseTest>>) {
    const hash = await db.attachments.save(PNG_BASE64, "image/png", "t.png");
    if (!hash) throw new Error("Failed to create attachment");
    const attachment = await db.attachments.attachment(hash);
    if (!attachment) throw new Error("Failed to load attachment");
    return { hash, attachment };
  }

  function generationOf(attachment: {
    iv: string;
    salt: string;
    size: number;
    chunkSize: number;
  }): AttachmentGeneration {
    return {
      iv: attachment.iv,
      salt: attachment.salt,
      size: attachment.size,
      chunkSize: attachment.chunkSize
    };
  }

  test("a matching-generation success marks the row uploaded", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash, attachment } = await saveAttachment(db);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: true,
      error: null,
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1,
      generation: generationOf(attachment)
    });

    const after = await db.attachments.attachment(hash);
    expect(after?.dateUploaded).toBeTruthy();
    expect(after?.failed == null).toBe(true);
  });

  test("a stale-generation success is ignored", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash, attachment } = await saveAttachment(db);
    const before = await db.attachments.attachment(hash);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: true,
      error: null,
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1,
      // The row's crypto has moved on (post-reupload): this upload's snapshot
      // describes the old generation and must match no row.
      generation: { ...generationOf(attachment), iv: "stale-iv" }
    });

    const after = await db.attachments.attachment(hash);
    expect(after?.dateUploaded == null).toBe(true);
    expect(after?.dateModified).toBe(before?.dateModified);
  });

  test("a matching-generation failure records the reason", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash, attachment } = await saveAttachment(db);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: false,
      error: "boom",
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1,
      generation: generationOf(attachment)
    });

    expect((await db.attachments.attachment(hash))?.failed).toBe("boom");
  });

  test("a stale-generation failure cannot clobber the new row's status", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash, attachment } = await saveAttachment(db);
    await db.attachments.markAsFailed(attachment.id, "existing");
    const before = await db.attachments.attachment(hash);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: false,
      error: "stale boom",
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1,
      generation: { ...generationOf(attachment), iv: "stale-iv" }
    });

    const after = await db.attachments.attachment(hash);
    expect(after?.failed).toBe("existing");
    expect(after?.dateModified).toBe(before?.dateModified);
  });

  test("a legacy event without a generation still applies", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash } = await saveAttachment(db);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: true,
      error: null,
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1
    });

    expect(
      (await db.attachments.attachment(hash))?.dateUploaded
    ).toBeTruthy();
  });

  test("a null snapshot field matches with IS NULL, not = NULL", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash, attachment } = await saveAttachment(db);

    // Simulate a partial/legacy row whose crypto columns are null.
    await db.attachments.collection.update([attachment.id], {
      iv: null,
      salt: null,
      size: null,
      chunkSize: null
    });

    await db.attachments.markAsUploaded(attachment.id, {
      iv: null,
      salt: null,
      size: null,
      chunkSize: null
    });

    // `= NULL` would never match; `IS NULL` must.
    expect(
      (await db.attachments.attachment(hash))?.dateUploaded
    ).toBeTruthy();
  });

  test("a null snapshot field cannot match a row whose crypto has since changed", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash, attachment } = await saveAttachment(db);

    // The upload was queued for an incomplete/legacy row whose `iv` is null.
    await db.attachments.collection.update([attachment.id], { iv: null });
    const staleGeneration: AttachmentGeneration = {
      iv: null,
      salt: attachment.salt,
      size: attachment.size,
      chunkSize: attachment.chunkSize
    };

    // The row is then reuploaded: its `iv` becomes a fresh value, so the
    // snapshot describes the *old* generation.
    await db.attachments.collection.update([attachment.id], {
      iv: "fresh-iv"
    });
    const before = await db.attachments.attachment(hash);

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: true,
      error: null,
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1,
      generation: staleGeneration
    });
    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: false,
      error: "stale boom",
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1,
      generation: staleGeneration
    });

    const after = await db.attachments.attachment(hash);
    // `iv IS NULL` must not match the fresh `iv`, so neither the late success
    // nor the late failure may write to the new generation.
    expect(after?.dateUploaded == null).toBe(true);
    expect(after?.failed == null).toBe(true);
    expect(after?.dateModified).toBe(before?.dateModified);
  });

  test("a matching null snapshot field still marks an unchanged incomplete row uploaded", async () => {
    const db = await databaseTest();
    await loginFakeUser(db);
    const { hash, attachment } = await saveAttachment(db);

    // `iv`/`salt` are null on the row and in the snapshot: the guard must match
    // with `IS NULL` and the upload must still be recorded as successful.
    await db.attachments.collection.update([attachment.id], {
      iv: null,
      salt: null
    });

    await db.eventManager.publishWithResult(EVENTS.fileUploaded, {
      success: true,
      error: null,
      filename: hash,
      groupId: "sync-uploads",
      total: 1,
      current: 1,
      generation: {
        iv: null,
        salt: null,
        size: attachment.size,
        chunkSize: attachment.chunkSize
      }
    });

    expect(
      (await db.attachments.attachment(hash))?.dateUploaded
    ).toBeTruthy();
  });
});

// The production bridge between the collection guard above and the queue: every
// upload `Sync.uploadAttachments()` queues must carry a generation snapshot,
// including when the pending row is missing some crypto columns. An incomplete
// row is normalized to `null` fields (guarded with `IS NULL`) rather than
// omitting the generation, so a late result of a pre-reupload upload can never
// mark a newly reuploaded generation uploaded/failed. Non-Sync/manual producers
// that omit `generation` stay unguarded (see `FileStorage.queueUploads`).
describe("Sync.uploadAttachments crypto generation snapshot", () => {
  function createSync(pending: Record<string, unknown>[]) {
    const eventManager = new EventManager();
    const queueUploads = vi.fn(async () => undefined);
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
        markAsFailed: vi.fn(async () => true)
      },
      fs: () => ({
        queueUploads,
        cancel: vi.fn(async () => undefined),
        exists: vi.fn(async () => true)
      })
    };
    return { sync: new Sync(db as never), queueUploads };
  }

  test("always snapshots the four crypto values, normalizing absent ones to null", async () => {
    const { sync, queueUploads } = createSync([
      {
        id: "a1",
        hash: "complete",
        chunkSize: 3,
        iv: "iv",
        salt: "salt",
        size: 9
      },
      // A legacy/partially merged row: only `chunkSize` is present.
      { id: "a2", hash: "partial", chunkSize: 4 }
    ]);

    await sync.uploadAttachments();

    expect(queueUploads).toHaveBeenCalledWith(
      [
        {
          filename: "complete",
          chunkSize: 3,
          generation: { iv: "iv", salt: "salt", size: 9, chunkSize: 3 }
        },
        {
          filename: "partial",
          chunkSize: 4,
          generation: { iv: null, salt: null, size: null, chunkSize: 4 }
        }
      ],
      "sync-uploads"
    );
  });
});
