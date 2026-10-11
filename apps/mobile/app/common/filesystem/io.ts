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

import Sodium from "@ammarahmed/react-native-sodium";
import {
  FileEncryptionMetadataWithHash,
  FileEncryptionMetadataWithOutputType,
  Output,
  RequestOptions,
  assertBearerDestination
} from "@notesnook/core";
import { DataFormat, SerializedKey } from "@notesnook/crypto";
import { Platform } from "react-native";
import RNFetchBlob from "react-native-blob-util";
import { eSendEvent } from "../../services/event-manager";
import { getAppGroupIdForNative } from "../../utils/constants";
import { DatabaseLogger, db } from "../database";
import { checkAttachment } from "./download";
import {
  ABYTES,
  cacheDir,
  cacheDirOld,
  getAppGroupPath,
  getRandomId,
  isSuccessStatusCode,
  parseS3Error
} from "./utils";

export async function readEncrypted<TOutputFormat extends DataFormat>(
  filename: string,
  key: SerializedKey,
  cipherData: FileEncryptionMetadataWithOutputType<TOutputFormat>
) {
  await migrateFilesFromCache();
  // Reconcile a leftover explicit-reupload backup before reading, so a crash
  // between encryption and the metadata commit cannot surface a ciphertext that
  // does not match the row. `reconcileReuploadBackup` fails closed (no-op) while
  // a reupload of this hash is in flight, so a concurrent read can never mistake
  // the reupload's freshly written new ciphertext for an invalid one and restore
  // the backup over it.
  await reconcileReuploadBackup(filename);
  DatabaseLogger.log("Read encrypted file...");

  try {
    if (!(await exists(filename))) {
      return;
    }

    const output = await Sodium.decryptFile(
      key,
      {
        ...cipherData,
        hash: filename,
        appGroupId: getAppGroupIdForNative()
      },
      cipherData.outputType === "base64" ? "base64" : "text"
    );

    DatabaseLogger.log("File decrypted...");

    return output as Output<TOutputFormat>;
  } catch (e) {
    // Never discard the local ciphertext on a decrypt failure. decryptFile
    // rejects for transient and structural reasons too (a missing cipher field,
    // a short read, an app group container that is not available), and the
    // server copy is never guaranteed to be present or intact, so deleting the
    // only local copy risks permanent data loss. Recovery is a verified remote
    // check (`checkAttachment` in download.ts) followed by a re-download/reattach
    // — not a manual cache clear, which is exactly what can lose the only copy.
    DatabaseLogger.info(
      `Keeping local ciphertext for ${filename}: it cannot be re-downloaded reliably`
    );
    DatabaseLogger.error(e);
  }
}

export async function hashBase64(data: string) {
  const hash = await Sodium.hashFile({
    type: "base64",
    data,
    uri: ""
  });
  return {
    hash: hash,
    type: "xxh64"
  };
}

export async function writeEncryptedBase64(
  data: string,
  encryptionKey: SerializedKey,
  mimeType: string
): Promise<FileEncryptionMetadataWithHash> {
  await createCacheDir();
  const filepath = cacheDir + `/${getRandomId("imagecache_")}`;
  await RNFetchBlob.fs.writeFile(filepath, data, "base64");
  const output = await Sodium.encryptFile(encryptionKey, {
    uri: Platform.OS === "ios" ? filepath : "file://" + filepath,
    type: "url"
  });

  RNFetchBlob.fs.unlink(filepath).catch(() => {
    /* empty */
  });

  return {
    ...output,
    alg: "xcha-stream"
  };
}

async function deleteLocalFile(filename: string) {
  try {
    await createCacheDir();
    const path = cacheDir + `/${filename}`;
    const exists = await RNFetchBlob.fs.exists(path);
    if (Platform.OS === "ios" && !exists) {
      const iosAppGroup = await getAppGroupPath();
      if (iosAppGroup) {
        const appGroupPath = `${iosAppGroup}/${filename}`;
        if (await RNFetchBlob.fs.exists(appGroupPath)) {
          await RNFetchBlob.fs.unlink(appGroupPath).catch(() => {
            /* empty */
          });
          return;
        }
      }
    }
    if (exists) {
      await RNFetchBlob.fs.unlink(path).catch(() => {
        /* empty */
      });
    }
  } catch (e) {
    DatabaseLogger.error(e as Error, "deleteLocalFile");
  }
}

export async function deleteFile(
  filename: string,
  requestOptions?: RequestOptions
): Promise<boolean> {
  await createCacheDir();
  if (!requestOptions) {
    await deleteLocalFile(filename);
    return true;
  }

  const { url, headers } = requestOptions;

  try {
    assertBearerDestination(headers, url);
    const response = await RNFetchBlob.fetch("DELETE", url, headers);
    const status = response.info().status;
    const ok = status >= 200 && status < 300;
    if (ok) {
      await deleteLocalFile(filename);
    }
    return ok;
  } catch (e) {
    DatabaseLogger.error(e, "Delete file", {
      url: url
    });
    return false;
  }
}

export async function bulkDeleteFiles(
  filenames: string[],
  requestOptions?: RequestOptions
) {
  await createCacheDir();
  if (!requestOptions) {
    filenames.forEach((filename) => {
      deleteLocalFile(filename);
    });
    return true;
  }

  try {
    const { url, headers } = requestOptions;
    assertBearerDestination(headers, url);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        names: filenames
      })
    });

    const result = isSuccessStatusCode(response.status);
    if (result) {
      filenames.forEach((filename) => {
        deleteLocalFile(filename);
      });
    } else {
      throw await response.text();
    }
    return result;
  } catch (e) {
    DatabaseLogger.error(
      typeof e === "string" ? parseS3Error(e as string) : (e as Error),
      "Could not bulk delete files"
    );
    return false;
  }
}

export async function clearFileStorage() {
  try {
    await createCacheDir();
    const files = await RNFetchBlob.fs.ls(cacheDir);
    const oldCache = await RNFetchBlob.fs.ls(cacheDirOld);

    for (const file of files) {
      await RNFetchBlob.fs.unlink(cacheDir + `/${file}`).catch(() => {
        /* empty */
      });
    }
    for (const file of oldCache) {
      await RNFetchBlob.fs.unlink(cacheDirOld + `/${file}`).catch(() => {
        /* empty */
      });
    }
  } catch (e) {
    DatabaseLogger.error(e, "clearFileStorage");
  }
}

export async function createCacheDir() {
  try {
    if (!(await RNFetchBlob.fs.exists(cacheDir))) {
      await RNFetchBlob.fs.mkdir(cacheDir);
      DatabaseLogger.log("Cache directory created");
    }
  } catch (e) {
    DatabaseLogger.error(e);
  }
}

// Shared in-flight migration. `readEncrypted` is invoked concurrently from the
// download paths, so without this guard every concurrent decrypt would re-run
// the whole migration, racing `mv` calls over the same legacy files. The guard
// is cleared in `finally` so a later call retries after a failed run instead of
// latching a rejected promise forever.
let migrateFilesFromCachePromise: Promise<void> | null = null;

export function migrateFilesFromCache(): Promise<void> {
  if (!migrateFilesFromCachePromise) {
    migrateFilesFromCachePromise = runMigration().finally(() => {
      migrateFilesFromCachePromise = null;
    });
  }
  return migrateFilesFromCachePromise;
}

async function runMigration() {
  try {
    await createCacheDir();
    const migratedFilesPath = cacheDir + "/.migrated_1";

    let oldCache: string[] = [];
    try {
      oldCache = await RNFetchBlob.fs.ls(cacheDirOld);
    } catch (e) {
      // A fresh install has no legacy cache dir. That is indistinguishable
      // from "nothing left to migrate", so treat it as drained.
      oldCache = [];
    }

    const filesToMigrate = oldCache.filter(
      (file) => !file.startsWith("org.") && !file.startsWith("com.")
    );

    if (filesToMigrate.length === 0) {
      // The marker is only trustworthy once the legacy dir is verifiably
      // drained of migratable files; an absent dir counts as drained. This
      // deliberately re-lists the legacy dir even when the marker exists, so a
      // stale marker can never hide leftover ciphertext.
      if (!(await RNFetchBlob.fs.exists(migratedFilesPath))) {
        await RNFetchBlob.fs.createFile(migratedFilesPath, "1", "utf8");
      }
      return;
    }

    let allMovesSucceeded = true;
    for (const file of filesToMigrate) {
      const src = cacheDirOld + `/${file}`;
      const dest = cacheDir + `/${file}`;
      try {
        // Never `mv` over an existing cacheDir copy: RNFetchBlob.fs.mv maps to
        // NSFileManager `moveItemAtURL`, which fails when the destination
        // exists, and the cacheDir copy may be newer (written by this build).
        // An existing destination is already-migrated, so skip it.
        if (await RNFetchBlob.fs.exists(dest)) continue;
        await RNFetchBlob.fs.mv(src, dest);
      } catch (e) {
        // Preserve the ciphertext: never unlink the legacy source on failure,
        // and do not write the marker, so a later call retries the move.
        allMovesSucceeded = false;
        DatabaseLogger.error(e, `migrateFilesFromCache: ${file}`);
      }
    }

    if (!allMovesSucceeded) return;

    if (!(await RNFetchBlob.fs.exists(migratedFilesPath))) {
      await RNFetchBlob.fs.createFile(migratedFilesPath, "1", "utf8");
    }
  } catch (e) {
    DatabaseLogger.error(e, "migrateFilesFromCache");
  }
}

/**
 * ============================ Apple reupload protocol ==========================
 *
 * Explicit reupload of an existing attachment (`picker.ts::attachFile` with
 * `options.reupload`) must never be a remote delete + write. The server copy is
 * the last line of recovery, and `Sodium.encryptFile` writes the new ciphertext
 * straight to `cacheDir/<hash>`, unlinking whatever was there. A crash between
 * that write and the `db.attachments` commit used to leave new ciphertext on
 * disk under old metadata, with the old bytes already gone.
 *
 * The protocol below keeps the old ciphertext in a protected backup until the
 * metadata upsert has resolved:
 *
 *   1. reconcile any leftover backup from an earlier crash;
 *   2. move the current local ciphertext to `<hash>_reupload_backup`;
 *   3. encrypt the picked file to the real `<hash>` and verify it against the
 *      freshly produced metadata;
 *   4. commit the row in a single upsert (`dateUploaded: null`, `failed: null`),
 *      reusing the existing id, then read the row back to confirm the new
 *      crypto metadata actually landed;
 *   5. only then unlink the backup.
 *
 * Any failure up to and including the upsert restores the backup, so the old
 * ciphertext/old metadata pair is never split. When there was no ciphertext to
 * stage (step 2 was a no-op), the failure path discards only the new
 * `cacheDir/<hash>` bytes so the old row is not shadowed — it never deletes a
 * legacy/App Group copy or the server copy. An *unconfirmed* commit (the
 * read-back throws) keeps both copies for later reconciliation. `commit` and
 * `restore` never throw; a backup that cannot be resolved is kept and
 * reconciled later. Apple only (`Platform.OS === "ios"`, which covers Mac
 * Catalyst); Android keeps its previous delete-first behavior.
 */
export const REUPLOAD_BACKUP_SUFFIX = "_reupload_backup";

/**
 * Suffix of the protected quarantine file an authenticated local repair leaves
 * behind: `cacheDir/<hash>_<random>_repair_quarantine` holds the previous local
 * ciphertext of `hash` after it was found to be invalid and replaced with a
 * copy authenticated against the remote object (see `download.ts`
 * `repairInvalidLocal`). Every repair uses its own random middle component, so a
 * second repair never overwrites or deletes an earlier quarantine. Like
 * `<hash>_reupload_backup` such a file can hold bytes that exist nowhere else, so
 * any name ending in this suffix is never treated as a disposable cache artifact
 * and is never unlinked by `clearCache()` or `deleteDCacheFiles()`.
 */
export const REPAIR_QUARANTINE_SUFFIX = "_repair_quarantine";

export interface ReuploadAttachmentRow {
  id?: string;
  hash: string;
  key: unknown;
  iv: string;
  salt: string;
  size: number;
  chunkSize: number;
  hashType: string;
  mimeType?: string;
}

const reuploadLocks = new Map<string, Promise<void>>();
const reuploadsInFlight = new Set<string>();

/**
 * True while an Apple explicit reupload of `hash` is between staging and the
 * metadata commit. `uploadFile` fails closed instead of PUT-ing a half-staged
 * ciphertext (the native `Sodium.encryptFile` may still be writing the real
 * hash). This serializes upload against reupload; it cannot stop a background
 * uploader that already read the bytes before staging began (see residual risk
 * in the Apple recovery runbook).
 */
export function isReuploadInFlight(hash: string) {
  return reuploadsInFlight.has(hash);
}

/**
 * Serialize concurrent Apple reuploads of the same hash. Without this a second
 * reupload could stage over the first's backup and lose one of the copies.
 */
async function runExclusiveReupload<T>(
  hash: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = reuploadLocks.get(hash) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => gate);
  reuploadLocks.set(hash, tail);
  await previous.catch(() => {
    /* a failed predecessor must not block this reupload */
  });
  reuploadsInFlight.add(hash);
  try {
    return await fn();
  } finally {
    reuploadsInFlight.delete(hash);
    release();
    if (reuploadLocks.get(hash) === tail) reuploadLocks.delete(hash);
  }
}

function reuploadBackupPath(hash: string) {
  return `${cacheDir}/${hash}${REUPLOAD_BACKUP_SUFFIX}`;
}

function isReuploadBackupName(file: string) {
  return file.endsWith(REUPLOAD_BACKUP_SUFFIX);
}

function isRepairQuarantineName(file: string) {
  return file.endsWith(REPAIR_QUARANTINE_SUFFIX);
}

/** Normalize the path `Sodium.decryptFile(..., "cache")` returns. */
function decryptedCachePath(uri: string) {
  const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  return path.startsWith("/") ? path : `${cacheDir}/${path}`;
}

/**
 * Decrypt `filename` (a basename inside `cacheDir`) with `cipher`/`key` and
 * require the plaintext to have exactly `expectedSize` bytes and an xxh64 hash
 * equal to `expectedHash`. The decrypted plaintext artifact is always removed.
 * Never throws: any failure (missing file, decrypt error, mismatch) is `false`.
 */
async function verifyCiphertext(
  filename: string,
  cipher: {
    iv: string;
    salt: string;
    size: number;
    hashType: string;
    mime?: string;
    chunkSize: number;
    appGroupId?: string;
  },
  key: SerializedKey,
  expectedSize: number,
  expectedHash: string
): Promise<boolean> {
  const plaintextPath = `${cacheDir}/${filename}_dcache`;
  let decryptedUri: string | undefined;
  try {
    decryptedUri = await Sodium.decryptFile(
      key,
      {
        iv: cipher.iv,
        salt: cipher.salt,
        size: cipher.size,
        hash: filename,
        hashType: cipher.hashType,
        mime: cipher.mime,
        fileName: undefined,
        uri: undefined,
        chunkSize: cipher.chunkSize,
        appGroupId: cipher.appGroupId
      } as never,
      "cache"
    );
    const decryptedPath = decryptedCachePath(decryptedUri as unknown as string);
    const { size } = await RNFetchBlob.fs.stat(decryptedPath);
    const decryptedHash = await Sodium.hashFile({
      uri: decryptedPath,
      type: "url"
    });
    return Number(size) === expectedSize && decryptedHash === expectedHash;
  } catch (e) {
    DatabaseLogger.error(e, `verifyCiphertext: ${filename}`);
    return false;
  } finally {
    await RNFetchBlob.fs.unlink(plaintextPath).catch(() => {
      /* empty */
    });
    if (decryptedUri) {
      await RNFetchBlob.fs.unlink(
        decryptedCachePath(decryptedUri as unknown as string)
      ).catch(() => {
        /* empty */
      });
    }
  }
}

async function ciphertextMatchesRow(
  filename: string,
  row: ReuploadAttachmentRow
): Promise<boolean> {
  try {
    const key = await db.attachments.decryptKey(row.key as never);
    if (!key) return false;
    return await verifyCiphertext(
      filename,
      {
        iv: row.iv,
        salt: row.salt,
        size: row.size,
        hashType: row.hashType,
        mime: row.mimeType,
        chunkSize: row.chunkSize,
        appGroupId: getAppGroupIdForNative()
      },
      key,
      row.size,
      row.hash
    );
  } catch (e) {
    DatabaseLogger.error(e, `ciphertextMatchesRow: ${filename}`);
    return false;
  }
}

/**
 * True only when the ciphertext at `cacheDir/<hash>` is this attachment's exact
 * content: its on-disk length equals the expected ciphertext size
 * (`size + 17 * ceil(size / chunkSize)`) and it decrypts with the row's
 * key/IV/salt/chunkSize to a plaintext of exactly `row.size` bytes whose xxh64
 * hash equals `row.hash`.
 *
 * The raw size check is on the exact `cacheDir` file, not on `exists()`: the
 * native cipher treats a zero-byte cache-dir file as missing and falls back to
 * an App Group copy, so without it a zero-byte stub could be "authenticated" by
 * a *different* (App Group) file while the stub is what a promotion would
 * replace. `exists()` also reports a size-mismatched file as absent, which is
 * exactly the case a repair is for. Never throws.
 */
export async function isLocalCiphertextValidForRow(
  hash: string,
  row: ReuploadAttachmentRow
): Promise<boolean> {
  try {
    const path = `${cacheDir}/${hash}`;
    if (!(await RNFetchBlob.fs.exists(path))) return false;
    const expectedSize =
      row.size + Math.ceil(row.size / row.chunkSize) * ABYTES;
    const stat = await RNFetchBlob.fs.stat(path);
    if (Number(stat.size) !== expectedSize) return false;
    return await ciphertextMatchesRow(hash, row);
  } catch (e) {
    DatabaseLogger.error(e, `isLocalCiphertextValidForRow: ${hash}`);
    return false;
  }
}

/** The local ciphertext `uploadFile`/the native cipher would actually use. */
async function findAuthoritativeLocalCiphertext(
  hash: string
): Promise<string | undefined> {
  const cachePath = `${cacheDir}/${hash}`;
  if (await RNFetchBlob.fs.exists(cachePath)) return cachePath;
  const appGroup = await getAppGroupPath();
  if (appGroup && (await RNFetchBlob.fs.exists(`${appGroup}/${hash}`))) {
    return `${appGroup}/${hash}`;
  }
  return undefined;
}

/**
 * Move the current local ciphertext of `hash` to the protected backup path.
 * No-op when there is nothing to preserve. Refuses to clobber an unresolved
 * backup from an earlier crash.
 */
export async function stageReuploadBackup(hash: string): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  const backup = reuploadBackupPath(hash);
  await createCacheDir();

  if (await RNFetchBlob.fs.exists(backup)) {
    // We are about to stage for a reupload, so we own the backup: resolve any
    // leftover from an earlier crash even though this hash is in flight.
    await reconcileReuploadBackup(hash, { force: true });
    if (await RNFetchBlob.fs.exists(backup)) {
      throw new Error(
        `Refusing to reupload ${hash}: an unresolved backup already exists`
      );
    }
  }

  const source = await findAuthoritativeLocalCiphertext(hash);
  if (!source) return false;
  await RNFetchBlob.fs.mv(source, backup);
  return true;
}

/**
 * Restore the backup over the real hash, replacing whatever a failed attempt
 * left behind. Never unlinks the backup on failure: an unresolved backup is
 * reconciled on a later startup/read/upload.
 */
export async function restoreReuploadBackup(hash: string): Promise<void> {
  if (Platform.OS !== "ios") return;
  const backup = reuploadBackupPath(hash);
  const realPath = `${cacheDir}/${hash}`;
  try {
    if (!(await RNFetchBlob.fs.exists(backup))) return;
    // `RNFetchBlob.fs.mv` maps to NSFileManager `moveItemAtURL`, which does
    // NOT overwrite an existing destination: it fails with an error when the
    // target exists. A failed attempt may have left partial new bytes at the
    // real path, so remove them first. The backup is only consumed by the
    // `mv` itself, so if the move fails the backup survives and is reconciled
    // later — the real path being temporarily absent is preferable to a
    // restore that silently no-ops against an existing destination.
    if (await RNFetchBlob.fs.exists(realPath)) {
      await RNFetchBlob.fs.unlink(realPath);
    }
    await RNFetchBlob.fs.mv(backup, realPath);
  } catch (e) {
    DatabaseLogger.error(e, `restoreReuploadBackup: ${hash}`);
  }
}

/**
 * Discard the ciphertext a failed reupload wrote to `cacheDir/<hash>` when it
 * did NOT stage a backup — i.e. no previous ciphertext existed in `cacheDir`
 * or the App Group, so the file at the real path is entirely the failed
 * attempt's own bytes and would otherwise shadow the still-old row. Unlike
 * `deleteLocalFile`, this touches only `cacheDir`: a legacy (`cacheDirOld`) or
 * App Group copy must never be unlinked here, and the server copy is never
 * touched. Never throws.
 */
async function discardUnstagedReuploadCiphertext(hash: string): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    await RNFetchBlob.fs.unlink(`${cacheDir}/${hash}`).catch(() => {
      /* empty */
    });
  } catch (e) {
    DatabaseLogger.error(e, `discardUnstagedReuploadCiphertext: ${hash}`);
  }
}

/**
 * Drop the backup after a confirmed metadata commit. Must never throw: a
 * failure here means the new ciphertext + new row are already committed, so
 * reverting would corrupt both. A left-over backup is reconciled later.
 */
export async function commitReuploadBackup(hash: string): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    await RNFetchBlob.fs.unlink(reuploadBackupPath(hash));
  } catch (e) {
    DatabaseLogger.error(e, `commitReuploadBackup: ${hash}`);
  }
}

/**
 * Decide what to do with a leftover `<hash>_reupload_backup` using the current
 * attachment row as the source of truth:
 *
 * - the backup matches the row -> crash before the commit -> restore it;
 * - the real file matches the row -> crash after the commit, before the backup
 *   was removed -> drop the backup;
 * - neither (or both) -> ambiguous -> keep both copies and fail closed.
 *
 * Never unlinks the real ciphertext while the state is ambiguous, and never
 * throws. Unless `options.force` is set, it also fails closed (no-op) while an
 * explicit reupload of the same hash is in flight, so it cannot race the
 * reupload's own staging/commit window.
 */
export async function reconcileReuploadBackup(
  hash: string,
  options: { force?: boolean } = {}
): Promise<void> {
  if (Platform.OS !== "ios") return;

  // Fail closed while a reupload of this hash is in flight. The reupload owns
  // the real path and the backup for its whole stage -> encrypt -> verify ->
  // commit window. A reconcile from a concurrent read (or the startup sweep)
  // would see the freshly written new ciphertext as invalid against the still
  // old row and restore the backup over it; if the commit then succeeded, the
  // row would describe the new ciphertext while the real file held the old
  // bytes — the exact split this protocol exists to prevent. Callers that are
  // the reupload itself pass `force` (see `performAppleReupload` /
  // `stageReuploadBackup`), since they run inside the per-hash lock.
  if (!options.force && isReuploadInFlight(hash)) {
    DatabaseLogger.info(
      `Deferring reupload reconciliation for ${hash}: a reupload is in flight`
    );
    return;
  }

  const backup = reuploadBackupPath(hash);
  try {
    if (!(await RNFetchBlob.fs.exists(backup))) return;

    let row;
    try {
      row = await db.attachments.attachment(hash);
    } catch (e) {
      DatabaseLogger.error(e, `reconcileReuploadBackup lookup: ${hash}`);
      return;
    }
    if (!row) {
      DatabaseLogger.info(
        `Keeping reupload backup for ${hash}: no attachment row to reconcile against`
      );
      return;
    }

    const realPath = `${cacheDir}/${hash}`;
    const realExists = await RNFetchBlob.fs.exists(realPath);
    const realValid = realExists && (await ciphertextMatchesRow(hash, row));
    const backupValid = await ciphertextMatchesRow(
      `${hash}${REUPLOAD_BACKUP_SUFFIX}`,
      row
    );

    if (backupValid && !realValid) {
      // Crash before the metadata commit: the row still describes the backup.
      await restoreReuploadBackup(hash);
      return;
    }
    if (realValid && !backupValid) {
      // Crash after the metadata commit, before the backup was removed.
      await RNFetchBlob.fs.unlink(backup).catch(() => {
        /* empty */
      });
      return;
    }
    DatabaseLogger.info(
      `Keeping both ciphertext copies for ${hash}: reupload state is ambiguous`
    );
  } catch (e) {
    DatabaseLogger.error(e, `reconcileReuploadBackup: ${hash}`);
  }
}

/** Sweep every leftover backup in the cache dir. Called on startup. */
export async function reconcileAllReuploadBackups(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const files = await listFilesSafely(cacheDir);
    const hashes = new Set<string>();
    for (const file of files) {
      if (isReuploadBackupName(file)) {
        hashes.add(file.slice(0, -REUPLOAD_BACKUP_SUFFIX.length));
      }
    }
    // Each hash goes through the same fail-closed guard, so the startup sweep
    // can never race an in-flight reupload of that hash.
    for (const hash of hashes) await reconcileReuploadBackup(hash);
  } catch (e) {
    DatabaseLogger.error(e, "reconcileAllReuploadBackups");
  }
}

export interface AppleReuploadResult {
  iv: string;
  salt: string;
  size: number;
  hash: string;
  hashType: string;
  chunkSize: number;
  alg: string;
  mimeType: string;
  filename: string;
  key: SerializedKey;
  [key: string]: unknown;
}

/**
 * Thrown when the metadata commit cannot be confirmed either way because the
 * read-back itself failed. The caller must keep BOTH the backup and the new
 * ciphertext: we do not know whether the upsert landed, so restoring the backup
 * could pair an old ciphertext with a committed new row, and discarding the new
 * ciphertext could lose an uncommitted copy.
 */
class ReuploadCommitIndeterminate extends Error {
  constructor(hash: string) {
    super(`Could not confirm reuploaded metadata for ${hash}.`);
    this.name = "ReuploadCommitIndeterminate";
  }
}

/**
 * Reject crypto metadata that cannot describe a usable ciphertext before it is
 * ever handed to `db.attachments.add`. `size === 0` is the important case:
 * `attachments.add` uses a falsy check (`!size`) and would silently return
 * without writing a row, and a zero-length ciphertext is never valid anyway
 * (a real one is `size + 17 * chunks`).
 */
function assertCompleteReuploadMetadata(
  hash: string,
  info: AppleReuploadResult
) {
  if (
    !info ||
    !info.iv ||
    !info.salt ||
    !info.size ||
    !info.hashType ||
    !info.chunkSize ||
    !info.alg ||
    !info.key ||
    !info.hash
  ) {
    throw new Error(`Reuploaded ciphertext metadata is incomplete. ${hash}`);
  }
}

/**
 * Confirm the row the commit just wrote actually describes the new ciphertext.
 * `db.attachments.add()` returns the row id even when `SQLCollection.upsert`
 * silently no-ops (an unknown table schema makes the sanitizer reject the
 * write), so the return value alone is not proof the row landed. Returns the
 * committed row on a confirmed crypto match, `undefined` on a definite
 * mismatch, and throws when the read itself fails — the caller keeps both
 * copies in that ambiguous case.
 *
 * The match is **crypto-generation only** (`iv`/`salt`/`size`/`chunkSize`/
 * `hashType`, with `key` present). It deliberately does NOT require
 * `dateUploaded`/`failed` to be cleared: a concurrent upload of the same reused
 * row (an earlier queued background upload, or `download.ts`'s direct
 * `markAsFailed`) can write a status between `add()` and this read-back, and
 * treating that transient status as an uncommitted write would restore the old
 * bytes over the committed new metadata — the exact data-loss split this
 * protocol exists to prevent. The status is reconciled separately by
 * `reconcileReuploadStatus` after the new crypto has been confirmed.
 *
 * `key` is only checked for presence: the stored value is the encrypted
 * `Cipher`, not the plain `SerializedKey` we produced, so the two are not
 * comparable.
 */
async function confirmReuploadCommitted(
  hash: string,
  info: AppleReuploadResult
): Promise<ReuploadAttachmentRow | undefined> {
  const row = (await db.attachments.attachment(hash)) as unknown as
    | ReuploadAttachmentRow
    | undefined;
  if (!row) return undefined;
  const matches =
    row.iv === info.iv &&
    row.salt === info.salt &&
    row.size === info.size &&
    row.chunkSize === info.chunkSize &&
    row.hashType === info.hashType &&
    !!row.key;
  return matches ? row : undefined;
}

/**
 * Clear any stale `dateUploaded`/`failed` a concurrent upload may have written
 * onto the row between the reupload's `add()` and the read-back, so the new
 * ciphertext is queued as a normal pending upload. This is invoked only after
 * the row's crypto has been confirmed to match the new ciphertext, so it must
 * **never throw**: it is deliberately self-swallowing, because propagating here
 * would route into the caller's failure path and restore the old bytes over the
 * committed new metadata — the data loss this whole protocol prevents.
 */
async function reconcileReuploadStatus(
  hash: string,
  row: ReuploadAttachmentRow
): Promise<void> {
  try {
    if (!row.id) return;
    await db.attachments.markReuploadConfirmed(row.id);
  } catch (e) {
    DatabaseLogger.error(e, `reconcileReuploadStatus: ${hash}`);
  }
}

/**
 * Complete Apple explicit reupload: stage -> encrypt -> verify -> commit ->
 * drop backup. Never touches the server (no remote DELETE, no PUT). Throws on
 * any failure after restoring (or, when there was nothing to back up,
 * discarding) the local ciphertext so the old row is never shadowed.
 */
export async function performAppleReupload(
  hash: string,
  uri: string,
  mimeType: string,
  filename: string,
  outputType: "base64" | "url" | "cache"
): Promise<AppleReuploadResult> {
  return runExclusiveReupload(hash, async () => {
    // Inside the per-hash lock we own the backup, so force-resolve a leftover
    // from an earlier crash even though this hash is marked in flight.
    await reconcileReuploadBackup(hash, { force: true });
    // `false` means there was no previous ciphertext to preserve (neither
    // `cacheDir/<hash>` nor an App Group copy existed), so the only bytes the
    // failure path may touch are the ones this attempt writes to `cacheDir`.
    const staged = await stageReuploadBackup(hash);

    let encryptionInfo!: AppleReuploadResult;
    try {
      const key = await db.attachments.generateKey();
      encryptionInfo = (await Sodium.encryptFile(key, {
        uri,
        type: outputType,
        hash
      } as never)) as unknown as AppleReuploadResult;
      encryptionInfo.mimeType = mimeType;
      encryptionInfo.filename = filename;
      encryptionInfo.alg = "xcha-stream";
      encryptionInfo.key = key;

      // Reject incomplete metadata (including size 0) before the row is
      // written, so a malformed ciphertext never becomes authoritative.
      assertCompleteReuploadMetadata(hash, encryptionInfo);

      // Authenticate the freshly written ciphertext before it becomes the
      // authoritative copy for a pending row.
      const verified = await verifyCiphertext(
        hash,
        {
          iv: encryptionInfo.iv,
          salt: encryptionInfo.salt,
          size: encryptionInfo.size,
          hashType: encryptionInfo.hashType,
          mime: mimeType,
          chunkSize: encryptionInfo.chunkSize,
          appGroupId: getAppGroupIdForNative()
        },
        key,
        encryptionInfo.size,
        hash
      );
      if (!verified) {
        throw new Error(`Reuploaded ciphertext failed verification. ${hash}`);
      }

      // Single atomic upsert: reuses the existing row id and marks it pending.
      // No separate reset() call, so there is no intermediate row state.
      // `failed: null` clears a recovered `MISSING_LOCAL_CIPHERTEXT_ERROR`
      // marker in the same write; otherwise core's sync predicate would keep
      // skipping this attachment and the reupload would never upload.
      const addedId = await db.attachments.add({
        ...encryptionInfo,
        // `dateUploaded`/`failed` are typed non-nullable on `Attachment`, but
        // the persisted cleared state is `null` (see `markAsUploaded`/
        // `markAsFailed`). Widen just these two values; the runtime payload
        // still carries `null` in this one atomic write.
        dateUploaded: null as unknown as number | undefined,
        failed: null as unknown as string | undefined
      });
      if (!addedId) {
        throw new Error(`Could not commit reuploaded attachment metadata. ${hash}`);
      }

      // `add()` returning an id is not proof the row landed (a sanitizer
      // no-op still returns the id), so read the row back and confirm it
      // carries the new crypto metadata before the old bytes are dropped. The
      // confirmation is crypto-only: a transient status a concurrent upload
      // may have written is reconciled below, never treated as an uncommitted
      // write.
      let committedRow: ReuploadAttachmentRow | undefined;
      try {
        committedRow = await confirmReuploadCommitted(hash, encryptionInfo);
      } catch (readError) {
        // Ambiguous: keep both copies for later reconciliation rather than
        // restoring over a possibly-committed new row.
        DatabaseLogger.error(readError, `confirmReuploadCommitted: ${hash}`);
        throw new ReuploadCommitIndeterminate(hash);
      }
      if (!committedRow) {
        throw new Error(`Reuploaded attachment metadata was not committed. ${hash}`);
      }
      // The new crypto is confirmed committed, so it is now safe to clear a
      // stale failure/uploaded status a concurrent upload may have written
      // between `add()` and the read-back. Self-swallowing: it must never
      // route into the `catch` below (that would restore old bytes over the
      // new metadata).
      await reconcileReuploadStatus(hash, committedRow);
    } catch (e) {
      if (e instanceof ReuploadCommitIndeterminate) {
        // The new row may or may not have landed; do not unlink either copy.
        throw e;
      }
      if (staged) {
        await restoreReuploadBackup(hash);
      } else {
        await discardUnstagedReuploadCiphertext(hash);
      }
      throw e;
    }

    // Commit confirmed; only now is it safe to discard the old ciphertext.
    await commitReuploadBackup(hash);
    return encryptionInfo;
  });
}

/**
 * Cached names that Notesnook itself creates and can always regenerate. Only
 * files matching one of these explicit, positively-known patterns may be
 * deleted when they have no attachment row: a missing row is NOT evidence that
 * a file is disposable.
 *
 * Attachment ciphertext files are named by their xxh64 hash — hex with no
 * separators — so none of these patterns can match one. This matters because
 * `writeEncryptedBase64`/`Sodium.encryptFile` write the ciphertext to the cache
 * directory *before* the caller commits the `db.attachments` row; during that
 * window the only copy of the ciphertext is an untracked bare-hash file that
 * must survive clearing the cache.
 *
 * `backup_temp` is the one cache directory entry that is disposable in
 * principle but must not be removed here: it is the staging folder of an
 * in-progress backup export (see services/backup.ts), and clearing the cache
 * mid-export would corrupt it.
 */
const DISPOSABLE_CACHE_FILE_PATTERNS = [
  /^imagecache_/, // base64 input temp of writeEncryptedBase64
  /^NN_/, // rendered image-preview/export copy
  /\.pdf$/i, // RNHTMLtoPDF export temp
  /_dcache$/, // Sodium.decryptFile output of an attachment hash
  /_temp$/ // in-progress download of an attachment hash (`<hash>_temp`)
];

const NEVER_DISPOSABLE_CACHE_FILES = ["backup_temp"];

function isDisposableCacheFile(file: string) {
  if (NEVER_DISPOSABLE_CACHE_FILES.includes(file)) return false;
  // A reupload backup holds the only previous copy of an attachment's
  // ciphertext until its metadata commit is reconciled. It must never be
  // treated as a disposable cache artifact.
  if (isReuploadBackupName(file)) return false;
  // A repair quarantine holds the previous (invalid) local ciphertext that was
  // replaced by a verified remote copy. It is preserved, not disposable.
  if (isRepairQuarantineName(file)) return false;
  return DISPOSABLE_CACHE_FILE_PATTERNS.some((pattern) => pattern.test(file));
}

export async function clearCache() {
  try {
    const files = await RNFetchBlob.fs.ls(cacheDir);

    for (const file of files) {
      // Protected names (reupload backups, repair quarantines) hold bytes that
      // exist nowhere else (the server copy is not the same bytes). They must
      // survive a cache clear regardless of any attachment row.
      if (isReuploadBackupName(file) || isRepairQuarantineName(file)) continue;

      // The server only has a copy of an attachment after it has been
      // uploaded. Deleting the ciphertext of a pending attachment would lose
      // it permanently, so it must survive clearing the cache.
      let attachment;
      try {
        attachment = await db.attachments.attachment(file);
      } catch (lookupError) {
        // We cannot prove the file is re-downloadable, so fail closed and
        // keep it instead of risking permanent data loss.
        DatabaseLogger.error(
          lookupError,
          "Could not check if attachment is uploaded"
        );
        continue;
      }

      if (attachment && !attachment.dateUploaded) {
        DatabaseLogger.info(
          `Keeping local ciphertext for ${file}: it is not uploaded, so it cannot be re-downloaded`
        );
        continue;
      }

      // On Apple platforms (iOS/iPadOS/Mac Catalyst) `dateUploaded` alone is
      // not proof that the server still holds a usable copy: the object can be
      // missing, truncated or corrupt. Before deleting the only local
      // ciphertext, authenticate the remote copy with `checkAttachment`, which
      // returns `{success: true}` only after a full download + decrypt + size +
      // hash match and never touches the local file. Offline (undefined), a
      // failed check, or a thrown error all mean "keep the local file".
      if (attachment && attachment.dateUploaded && Platform.OS === "ios") {
        let verified = false;
        try {
          const result = await checkAttachment(file);
          verified =
            !!result && "success" in result && result.success === true;
        } catch (verifyError) {
          DatabaseLogger.error(
            verifyError,
            `Could not verify remote copy of ${file}`
          );
        }

        if (!verified) {
          DatabaseLogger.info(
            `Keeping local ciphertext for ${file}: the remote copy could not be verified`
          );
          continue;
        }
      }

      if (attachment || isDisposableCacheFile(file)) {
        await RNFetchBlob.fs.unlink(cacheDir + `/${file}`).catch(() => {
          /* empty */
        });
        continue;
      }

      // No attachment row and no known disposable name: this is an ambiguous
      // untracked file (e.g. ciphertext written moments ago by
      // writeEncryptedBase64, before its attachment row was committed). We
      // cannot tell whether the server has a copy, so keep it.
      DatabaseLogger.info(
        `Keeping untracked cache file ${file}: it may be an only copy of an attachment`
      );
    }
  } catch (e) {
    DatabaseLogger.error(e, "clearCache");
  }
  await createCacheDir();
  eSendEvent("cache-cleared");
}

export async function deleteCacheFileByPath(path: string) {
  await RNFetchBlob.fs.unlink(path).catch(() => {
    /* empty */
  });
}

export async function deleteCacheFileByName(name: string) {
  const iosAppGroup = await getAppGroupPath();
  if (iosAppGroup) {
    await RNFetchBlob.fs.unlink(`${iosAppGroup}/${name}`).catch(() => {
      /* empty */
    });
  }
  await RNFetchBlob.fs.unlink(`${cacheDir}/${name}`).catch(() => {
    /* empty */
  });
}

export async function deleteDCacheFiles() {
  // Startup hook: resolve any explicit-reupload backup left behind by a crash
  // before plaintext artifacts are swept. Fail-closed and never throws.
  await reconcileAllReuploadBackups();
  try {
    await createCacheDir();
    const files = await RNFetchBlob.fs.ls(cacheDir);
    for (const file of files) {
      // Protected names (reupload backups, repair quarantines) hold bytes that
      // exist nowhere else; never sweep them even if they somehow match one of
      // the disposable patterns below.
      if (isReuploadBackupName(file) || isRepairQuarantineName(file)) continue;
      if (
        file.includes("_dcache") ||
        file.startsWith("NN_") ||
        file.endsWith(".pdf")
      ) {
        // `file` is a bare name from `ls(cacheDir)`; unlink needs the full path
        // or it targets the process working directory and silently leaves the
        // plaintext decrypt artifacts behind.
        await RNFetchBlob.fs.unlink(`${cacheDir}/${file}`).catch(() => {
          /* empty */
        });
      }
    }
  } catch (e) {
    /** Empty */
  }
}

/**
 * Raw presence check (no size validation) used by callers that only need to
 * know whether a copy of the ciphertext is already on disk. Probes the same
 * locations and in the same order as `uploadFile`: cacheDir, then the legacy
 * cacheDirOld, then the App Group container. Without the legacy probe a file
 * written by an old build is reported as absent and re-downloaded (or, in
 * download.ts, re-fetched) even though a readable copy is present.
 */
export async function getCachePathForFile(filename: string) {
  const path = `${cacheDir}/${filename}`;

  const iosAppGroup = await getAppGroupPath();

  let exists = await RNFetchBlob.fs.exists(path);
  let foundPath = path;
  if (!exists) {
    // Old builds wrote ciphertext to RNFetchBlob's CacheDir (cacheDirOld).
    // migrateFilesFromCache() moves those across, but it only runs from
    // readEncrypted() and a move can fail (leaving the legacy copy in place),
    // so probe the legacy dir directly.
    const legacyPath = `${cacheDirOld}/${filename}`;
    if (await RNFetchBlob.fs.exists(legacyPath)) {
      exists = true;
      foundPath = legacyPath;
    }
  }

  // Check if file is present in app group path. Skipped when this process has
  // no App Group container (Mac Catalyst), where the file can only be local.
  let existsInAppGroup = false;
  if (!exists && iosAppGroup) {
    existsInAppGroup = await RNFetchBlob.fs.exists(
      `${iosAppGroup}/${filename}`
    );
  }

  if (existsInAppGroup && iosAppGroup) return `${iosAppGroup}/${filename}`;
  return exists ? foundPath : path;
}

export async function exists(filename: string) {
  const path = `${cacheDir}/${filename}`;

  const iosAppGroup = await getAppGroupPath();
  const appGroupPath = iosAppGroup ? `${iosAppGroup}/${filename}` : undefined;

  let exists = await RNFetchBlob.fs.exists(path);
  let filePath = path;

  // Old builds wrote ciphertext to RNFetchBlob's CacheDir (cacheDirOld), a
  // different location from cacheDir. `uploadFile` probes the legacy dir too,
  // so a valid copy can live only there; this lookup must mirror that or core
  // would keep treating an attachment whose ciphertext is present as missing.
  // migrateFilesFromCache() cannot be relied on here: it only runs from
  // readEncrypted(), and a move can fail leaving the legacy copy in place.
  if (!exists) {
    const legacyPath = `${cacheDirOld}/${filename}`;
    exists = await RNFetchBlob.fs.exists(legacyPath);
    if (exists) filePath = legacyPath;
  }

  // Check if file is present in app group path. Skipped when this process has
  // no App Group container (Mac Catalyst), where the file can only be local.
  if (!exists && appGroupPath) {
    const existsInAppGroup = await RNFetchBlob.fs.exists(appGroupPath);
    if (existsInAppGroup) {
      exists = true;
      filePath = appGroupPath;
    }
  }

  if (exists) {
    let attachment;
    try {
      attachment = await db.attachments.attachment(filename);
    } catch (lookupError) {
      // We cannot tell whether the ciphertext is re-downloadable, so keep it
      // instead of risking permanent data loss.
      DatabaseLogger.error(
        lookupError,
        "Could not check if attachment is uploaded"
      );
      return false;
    }
    if (!attachment) return false;
    const totalChunks = Math.ceil(attachment.size / attachment.chunkSize);
    const totalAbytes = totalChunks * ABYTES;
    const expectedFileSize = attachment.size + totalAbytes;

    // Validate the size of the copy that was actually found, whichever
    // location holds it; statting cacheDir would throw ENOENT for a legacy or
    // App Group copy and reject the caller.
    const stat = await RNFetchBlob.fs.stat(filePath);

    if (stat.size !== expectedFileSize) {
      DatabaseLogger.log(
        `File size mismatch: ${filename}, expected: ${expectedFileSize}, actual: ${stat.size}`
      );
      // Never discard the local ciphertext, even when the attachment has been
      // uploaded. A size mismatch does not prove the server holds a usable
      // copy, and the local file may be the only one; deleting it risks
      // permanent loss. Recovery is a verified remote check (`checkAttachment`
      // in download.ts) followed by a re-download/reattach, not a manual cache
      // clear.
      DatabaseLogger.info(
        `Keeping local ciphertext for ${filename}: it cannot be re-downloaded reliably`
      );
      return false;
    }
  }
  return exists;
}

/**
 * `ls` rejects when the directory does not exist (the legacy cache dir is
 * absent on fresh installs). Treating that as an empty listing keeps the
 * failure local; letting it bubble to the caller would make `bulkExists`
 * report every file as present, silently disabling all downloads.
 */
async function listFilesSafely(dir: string) {
  try {
    return await RNFetchBlob.fs.ls(dir);
  } catch {
    return [];
  }
}

export async function bulkExists(files: string[]) {
  try {
    await createCacheDir();
    const cacheFiles = await RNFetchBlob.fs.ls(cacheDir);
    // Probe the legacy cache dir on every platform: `uploadFile` does the
    // same, so a ciphertext that only exists there is present, not missing.
    const legacyCacheFiles = await listFilesSafely(cacheDirOld);
    let missingFiles = files.filter(
      (file) => !cacheFiles.includes(file) && !legacyCacheFiles.includes(file)
    );

    if (Platform.OS === "ios") {
      const iosAppGroup = await getAppGroupPath();
      if (iosAppGroup) {
        const appGroupFiles = await RNFetchBlob.fs.ls(iosAppGroup);
        missingFiles = missingFiles.filter(
          (file) => !appGroupFiles.includes(file)
        );
      }
    }
    return missingFiles;
  } catch (e) {
    DatabaseLogger.error(e);
    return [];
  }
}

export async function getCacheSize() {
  await createCacheDir();
  const stat = await RNFetchBlob.fs.lstat(`file://` + cacheDir);
  let total = 0;

  stat.forEach((file) => {
    total += parseInt(file.size as unknown as string);
  });
  return total;
}
