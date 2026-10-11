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
  RequestOptions,
  assertBearerDestination,
  hosts
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import NetInfo from "@react-native-community/netinfo";
import { Platform } from "react-native";
import RNFetchBlob from "react-native-blob-util";
import { ToastManager } from "../../services/event-manager";
import { useAttachmentStore } from "../../stores/use-attachment-store";
import { getAppGroupIdForNative } from "../../utils/constants";
import { DatabaseLogger, db } from "../database";
import {
  REPAIR_QUARANTINE_SUFFIX,
  createCacheDir,
  exists,
  getCachePathForFile,
  isLocalCiphertextValidForRow,
  isReuploadInFlight
} from "./io";
import {
  ABYTES,
  cacheDir,
  getRandomId,
  getUploadedFileSize,
  isSuccessStatusCode,
  parseS3Error
} from "./utils";

/**
 * Sodium.decryptFile("cache") returns a path that may keep the `file://` scheme
 * and be relative to the cache directory. Normalize it the same way the
 * thumbnail pipeline does so it can be stat'ed, hashed and unlinked.
 */
function decryptedCachePath(uri: string) {
  const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  return path.startsWith("/") ? path : `${cacheDir}/${path}`;
}

export interface DownloadMode {
  /**
   * Ignore both local short-circuits (the "file already exists" check and the
   * "pending attachment with a local ciphertext" guard) and always download the
   * remote copy. Required when the caller wants the remote object itself
   * authenticated even though a local ciphertext is already present.
   */
  forceRemote?: boolean;
  /**
   * Authenticate the downloaded temp ciphertext (decrypt with the attachment's
   * key/IV/size/hash) and then discard it. The original path is never read,
   * moved, overwritten or unlinked; a successful verification resolves `true`
   * without modifying any local file.
   */
  verifyOnly?: boolean;
  /**
   * Suppress the user-facing error toasts. Logging (DatabaseLogger) still
   * happens.
   */
  silent?: boolean;
  /**
   * Never call `db.attachments.markAsFailed` from within `downloadFile`, even
   * when the verification fails. Used by the manual File Check action and by
   * `uploadFile`'s background repair/recovery/post-upload-verification
   * downloads, where the caller/core owns reporting the failure (File Check
   * marks the attachment with its own message and shows the toast; the upload
   * path records only its own durable markers and treats a verification miss as
   * a transient deferral). Defaults to `false`, so a bare download keeps its
   * existing behavior.
   */
  skipFailureMark?: boolean;
  /**
   * Apple-only, opt-in authenticated local repair. Requires `forceRemote` (the
   * remote object must be fetched and authenticated first) and is ignored for
   * `verifyOnly`; without either it is a no-op and the default promotion runs.
   *
   * Default promotion discards the verified remote temp whenever *any* file
   * already exists at the canonical path, even a zero-byte or corrupt one, and
   * the local copy then stays unusable forever. In this mode the canonical
   * local ciphertext is authenticated against the attachment row after the
   * remote temp has been fully decrypted and matched:
   *
   * - **valid** local ciphertext → never moved, overwritten or deleted; only
   *   the verified temp is discarded (the default behavior);
   * - **no** local ciphertext → the verified temp is promoted as usual;
   * - **present but invalid** (zero-byte, truncated or corrupt) → the invalid
   *   bytes are moved to a unique, protected, non-disposable
   *   `<hash>_<random>_repair_quarantine` path and only then is the verified
   *   temp promoted into place. `RNFetchBlob.fs.mv` maps to NSFileManager
   *   `moveItemAtURL`, which does not overwrite, so the canonical path is
   *   vacated first; if either move fails the previous bytes are restored where
   *   possible and no verified bytes are promoted over them. A quarantine left
   *   by an earlier repair is never overwritten or deleted.
   *
   * Repair is skipped (the invalid original is preserved, the temp discarded,
   * `false` returned) while an explicit Apple reupload of the same hash is in
   * flight, so the reupload's staging/backup window is never touched. Android
   * ignores this flag. `verifyOnly`/`checkAttachment` must never set it: File
   * Check stays strictly non-destructive.
   */
  repairInvalidLocal?: boolean;
}

/**
 * The attachment-row fields the local-ciphertext check needs. Structural so it
 * accepts the `db.attachments.attachment()` row without importing its type.
 */
type RepairAttachment = {
  key: unknown;
  iv: string;
  salt: string;
  size: number;
  chunkSize: number;
  hashType: string;
  mimeType?: string;
  hash: string;
};

type LocalRepairOutcome = "promoted" | "kept-valid" | "deferred" | "failed";

/**
 * True when two attachment rows describe the same ciphertext: the crypto
 * parameters the local-validity probe and any promotion depend on. Used to
 * detect that an explicit reupload committed a *new* row (fresh key → fresh
 * `iv`/`salt`) while the network-bound repair download was in flight. Pure and
 * total: never throws.
 */
function sameCipherRow(a: RepairAttachment, b: RepairAttachment) {
  return (
    a.iv === b.iv &&
    a.salt === b.salt &&
    a.hash === b.hash &&
    a.size === b.size &&
    a.chunkSize === b.chunkSize &&
    a.hashType === b.hashType
  );
}

/**
 * Promotion step for `DownloadMode.repairInvalidLocal`. The remote temp at
 * `tempFilePath` has already been fully decrypted and authenticated against
 * `attachment` by the caller; this only decides what may happen to the
 * canonical `cacheDir/<hash>` file and never promotes unverified bytes:
 *
 * - explicit reupload in flight → nothing is promoted, moved or overwritten;
 *   the verified temp is discarded and the repair is deferred. Checked first,
 *   because a reupload has already vacated the canonical path (its backup owns
 *   the bytes), so the "absent" branch below must never treat that as a genuine
 *   missing original;
 * - the attachment row no longer matches the one the remote object was
 *   authenticated against (a reupload committed mid-download, or the row was
 *   removed) → nothing is promoted, moved or overwritten; the verified temp is
 *   discarded and the repair is deferred. The `isReuploadInFlight` flag is
 *   already false by promotion time in that window, so the row re-read is what
 *   prevents the fresh reupload ciphertext from being quarantined and the remote
 *   *old* ciphertext from being promoted into place;
 * - absent → promote the verified temp (the ordinary case);
 * - present and valid → leave it completely untouched, discard only the temp;
 * - present and invalid (zero-byte, truncated or corrupt) → move the invalid
 *   bytes to a fresh, uniquely named protected
 *   `<hash>_<random>_repair_quarantine` path, then promote the verified temp.
 *   `RNFetchBlob.fs.mv` maps to NSFileManager `moveItemAtURL`, which does not
 *   overwrite, so the canonical path is vacated first; if either move fails the
 *   old bytes are restored where possible and the verified temp is only
 *   discarded once the on-disk state is safe (crash/catch conservative). A
 *   quarantine left by an earlier repair is never overwritten or deleted.
 *
 * `deferred` means an explicit reupload owns the local ciphertext right now, so
 * nothing is promoted. `failed` means the repair could not complete and the
 * caller must report a durable failure. Never throws.
 */
async function promoteRepairingInvalidLocal(
  filename: string,
  tempFilePath: string,
  attachment: RepairAttachment
): Promise<LocalRepairOutcome> {
  const originalFilePath = `${cacheDir}/${filename}`;
  // Each repair quarantines into its *own* uniquely named protected file. A
  // fixed `<hash>_repair_quarantine` would have to be overwritten (or a
  // preexisting quarantine destroyed) on a second repair of the same hash,
  // losing the only preserved copy of those earlier bytes. The random component
  // is inserted *before* the suffix so the name still ends in
  // `REPAIR_QUARANTINE_SUFFIX` and `io.ts`'s `isRepairQuarantineName` keeps it
  // out of the disposable-cache sweeps. `NSFileManager moveItemAtURL` fails on
  // an existing destination, so a (negligible) name collision fails closed via
  // the move's catch below instead of overwriting a prior quarantine.
  const quarantineId = getRandomId("");
  const quarantinePath = `${originalFilePath}_${quarantineId}${REPAIR_QUARANTINE_SUFFIX}`;

  const discardTemp = async () => {
    await RNFetchBlob.fs.unlink(tempFilePath).catch(() => {
      /* empty */
    });
  };

  // An explicit Apple reupload owns the real path and its backup for the whole
  // stage → encrypt → verify → commit window. Checked before *any* promotion or
  // quarantine step: during a reupload `stageReuploadBackup` has already moved
  // the canonical ciphertext aside, so the path legitimately looks absent and
  // the "no original" branch below would otherwise promote the remote old
  // ciphertext straight into the reupload's staging window. Preserve the local
  // bytes and let the reupload settle.
  if (isReuploadInFlight(filename)) {
    DatabaseLogger.info(
      `Deferring local repair for ${filename}: a reupload is in flight`
    );
    await discardTemp();
    return "deferred";
  }

  // The row read when the download started is only a snapshot. An explicit
  // reupload can commit new crypto metadata for this hash while the remote
  // object is being fetched; by promotion time its in-flight flag is already
  // false again. The canonical path then holds the reupload's *fresh*
  // ciphertext, which cannot authenticate against the stale snapshot, so the
  // absent/valid/invalid decision below would quarantine those fresh bytes and
  // promote the remote *old* ciphertext into place — the exact
  // ciphertext/metadata split the reupload protocol exists to prevent. Re-read
  // the row and, on any change (or removal), fail closed: promote/quarantine
  // nothing and discard only the verified temp.
  let rowChanged = true;
  try {
    const currentRow = await db.attachments.attachment(filename);
    rowChanged = !currentRow || !sameCipherRow(currentRow, attachment);
  } catch (e) {
    // Cannot establish whether the row the remote object was authenticated
    // against is still current, so fail closed exactly like a changed row
    // instead of letting the read error escape (this helper never throws).
    DatabaseLogger.error(e, `Repair row re-read failed: ${filename}`);
  }
  if (rowChanged) {
    DatabaseLogger.info(
      `Deferring local repair for ${filename}: the attachment row changed during the download`
    );
    await discardTemp();
    return "deferred";
  }

  if (!(await RNFetchBlob.fs.exists(originalFilePath))) {
    // Nothing to preserve: promote the authenticated temp exactly like the
    // default path. A failed move keeps the remote copy as the only source of
    // truth and discards the temp (there was no local byte to lose).
    try {
      await RNFetchBlob.fs.mv(tempFilePath, originalFilePath);
      return "promoted";
    } catch (e) {
      DatabaseLogger.error(e, `Repair promote failed: ${filename}`);
      await discardTemp();
      return "failed";
    }
  }

  // A present ciphertext that authenticates against the row is the attachment's
  // content and must never be replaced. `isLocalCiphertextValidForRow` also
  // rejects a zero-byte file outright, so a valid App Group copy can never
  // "authenticate" a zero-byte canonical stub.
  if (await isLocalCiphertextValidForRow(filename, attachment)) {
    await discardTemp();
    return "kept-valid";
  }

  // Present but invalid. Preserve it in a fresh protected quarantine, then
  // promote the verified temp. Any quarantine left by an earlier repair is
  // never probed, overwritten or deleted: the move targets this repair's own
  // unique name, so previously preserved bytes always survive.
  try {
    await RNFetchBlob.fs.mv(originalFilePath, quarantinePath);
  } catch (e) {
    // Could not preserve the invalid bytes: promote nothing and leave the disk
    // exactly as it was (canonical untouched, verified temp discarded).
    DatabaseLogger.error(e, `Repair quarantine failed: ${filename}`);
    await discardTemp();
    return "failed";
  }

  try {
    await RNFetchBlob.fs.mv(tempFilePath, originalFilePath);
    return "promoted";
  } catch (e) {
    // Promotion failed after the old bytes were quarantined. Put them back so
    // the disk state matches the pre-repair state; only then discard the
    // verified temp. If the restore itself fails, the quarantine and the
    // verified temp are both kept, so no byte is lost even though the canonical
    // path is momentarily absent.
    DatabaseLogger.error(e, `Repair promotion failed: ${filename}`);
    let restored = false;
    try {
      await RNFetchBlob.fs.mv(quarantinePath, originalFilePath);
      restored = true;
    } catch (restoreError) {
      DatabaseLogger.error(restoreError, `Repair restore failed: ${filename}`);
    }
    if (restored) await discardTemp();
    return "failed";
  }
}

export async function downloadFile(
  filename: string,
  requestOptions: RequestOptions,
  cancelToken: {
    cancel: (reason?: string) => Promise<void>;
  },
  mode: DownloadMode = {}
) {
  if (!requestOptions) {
    DatabaseLogger.log(
      `Error downloading file: ${filename}, reason: No requestOptions`
    );
    return false;
  }

  DatabaseLogger.log(`Downloading ${filename}`);
  await createCacheDir();

  const { url, headers, chunkSize } = requestOptions;
  // Every invocation gets its own ciphertext temp name. Manual File Check,
  // cache clearing, a normal download and a post-upload verification can all
  // run concurrently for the same hash; a shared `${filename}_temp` let them
  // overwrite or unlink each other's in-flight transfer. The random suffix is
  // per invocation and the name still ends in `_temp`, so `clearCache()`'s
  // disposable-temp pattern (and the derived `_dcache` plaintext) keeps
  // treating it as disposable.
  const tempFileBaseName = getRandomId(`${filename}_`);
  const tempFilePath = `${cacheDir}/${tempFileBaseName}_temp`;
  // Sodium.decryptFile reads the ciphertext from `${cacheDir}/<hash>` and writes
  // `${cacheDir}/<hash>_dcache`, so the hash must be exactly the temp
  // ciphertext's basename (no directory component).
  const tempFileHash = `${tempFileBaseName}_temp`;
  const originalFilePath = `${cacheDir}/${filename}`;

  try {
    // `forceRemote` deliberately skips this short-circuit: the caller wants the
    // remote object re-fetched and authenticated even though a (size-valid)
    // local ciphertext is already present.
    if (!mode.forceRemote && (await exists(filename))) {
      DatabaseLogger.log(`File Exists already: ${filename}`);
      return true;
    }

    const attachment = await db.attachments.attachment(filename);
    if (!attachment) return false;

    // A pending attachment synced from another device may have no local
    // ciphertext even though the server has a copy, so only block the download
    // when a local ciphertext actually exists. getCachePathForFile checks both
    // the cache directory and the iOS App Group and, unlike exists(), does not
    // reject (or consider absent) a size-mismatched local file.
    if (!mode.forceRemote && !attachment.dateUploaded) {
      if (await RNFetchBlob.fs.exists(await getCachePathForFile(filename))) {
        return false;
      }
    }

    const size = await getUploadedFileSize(filename);

    if (size === -1) {
      const error = `${strings.fileVerificationFailed()} (File hash: ${filename})`;
      throw new Error(error);
    }

    if (size === 0) {
      const error = `${strings.fileLengthError()} (File hash: ${filename})`;
      if (!mode.skipFailureMark)
        await db.attachments.markAsFailed(attachment.id, error);
      throw new Error(error);
    }

    const totalChunks = Math.ceil(size / (chunkSize + ABYTES));
    const decryptedLength = size - totalChunks * ABYTES;

    if (attachment && attachment.size !== decryptedLength) {
      const error = `${strings.fileLengthMismatch(
        attachment.size,
        decryptedLength
      )} (File hash: ${filename})`;
      if (!mode.skipFailureMark)
        await db.attachments.markAsFailed(attachment.id, error);
      throw new Error(error);
    }

    assertBearerDestination(headers, url);
    const resolveUrlResponse = await fetch(url, {
      method: "GET",
      headers
    });

    if (!resolveUrlResponse.ok) {
      DatabaseLogger.log(
        `Error downloading file: ${filename}, ${resolveUrlResponse.status}, ${resolveUrlResponse.statusText}, reason: Unable to resolve download url`
      );
      throw new Error(
        `${resolveUrlResponse.status}: ${strings.failedToResolvedDownloadUrl()}`
      );
    }

    const downloadUrl = await resolveUrlResponse.text();

    if (!downloadUrl) {
      DatabaseLogger.log(
        `Error downloading file: ${filename}, reason: Unable to resolve download url`
      );
      throw new Error(strings.failedToResolvedDownloadUrl());
    }

    DatabaseLogger.log(`Download starting: ${filename}`);
    const request = RNFetchBlob.config({
      path: tempFilePath,
      IOSBackgroundTask: true,
      overwrite: true
    })
      .fetch("GET", downloadUrl)
      .progress(async (recieved, total) => {
        useAttachmentStore
          .getState()
          .setProgress(
            0,
            parseInt(total),
            filename,
            parseInt(recieved),
            "download"
          );

        DatabaseLogger.log(`Downloading: ${filename}, ${recieved}/${total}`);
      });

    cancelToken.cancel = async (reason) => {
      useAttachmentStore.getState().remove(filename);
      request.cancel();
      RNFetchBlob.fs.unlink(tempFilePath).catch(() => {
        /* empty */
      });
      DatabaseLogger.log(`Download cancelled: ${reason} ${filename}`);
    };

    const response = await request;

    const contentType =
      response.info().headers?.["content-type"] ||
      response.info().headers?.["Content-Type"];

    if (contentType === "application/xml") {
      const error = parseS3Error(await response.text());
      throw new Error(`[${error.Code}] ${error.Message}`);
    }

    const status = response.info().status;
    useAttachmentStore.getState().remove(filename);

    // Require an explicit 2xx before the temp file may be promoted. The
    // transfer library resolves the request for error bodies too (S3 error
    // documents included), so a non-2xx response must never be treated as a
    // completed download.
    if (!isSuccessStatusCode(status)) {
      const error = `HTTP ${status} (File hash: ${filename})`;
      DatabaseLogger.log(`Error downloading file: ${filename}, ${error}`);
      throw new Error(error);
    }

    // Authenticated verification of the freshly downloaded temp ciphertext
    // before it can replace the original. Remote size (and a matching ETag)
    // is not proof of integrity: a truncated, corrupted or tampered transfer
    // can still match both, and promoting it would swap usable data for
    // unusable data. Decrypt the temp file with the attachment's own key and
    // parameters and require the plaintext to have exactly `attachment.size`
    // bytes and a content hash equal to `attachment.hash`.
    // Derived from this invocation's unique temp ciphertext so the decrypted
    // plaintext artifact can never collide with a concurrent invocation either.
    const plaintextTempPath = `${tempFilePath}_dcache`;
    let decryptedUri: string | undefined;
    try {
      const key = await db.attachments.decryptKey(attachment.key);
      if (!key) {
        // The content is encrypted with a key this device does not have, so
        // nothing can be verified. Fail closed instead of promoting it.
        throw new Error(
          `${strings.fileVerificationFailed()} (File hash: ${filename})`
        );
      }

      decryptedUri = await Sodium.decryptFile(
        key,
        {
          iv: attachment.iv,
          salt: attachment.salt,
          // `size` mirrors the FileEncryptionMetadata shape used by
          // readEncrypted.
          size: attachment.size,
          // Point Sodium at the just-downloaded temp ciphertext; the original
          // path is untouched until verification succeeds.
          hash: tempFileHash,
          hashType: attachment.hashType,
          mime: attachment.mimeType,
          fileName: undefined,
          uri: undefined,
          chunkSize: attachment.chunkSize,
          appGroupId: getAppGroupIdForNative()
        },
        "cache"
      );

      const decryptedPath = decryptedCachePath(decryptedUri);
      const { size: decryptedSize } = await RNFetchBlob.fs.stat(decryptedPath);
      const decryptedHash = await Sodium.hashFile({
        uri: decryptedPath,
        type: "url"
      });

      if (
        Number(decryptedSize) !== attachment.size ||
        decryptedHash !== attachment.hash
      ) {
        const error = `${strings.fileVerificationFailed()} (File hash: ${filename})`;
        DatabaseLogger.error(error, strings.fileVerificationFailed(), {
          hash: filename,
          expectedSize: attachment.size,
          decryptedSize,
          expectedHash: attachment.hash,
          decryptedHash
        });
        if (!mode.skipFailureMark)
          await db.attachments.markAsFailed(attachment.id, error);
        throw new Error(error);
      }

      if (mode.verifyOnly) {
        // Verification-only: the temp ciphertext has been authenticated against
        // the attachment's own key/IV/size/hash above. It is a verification
        // artifact, never a replacement for the local copy, so discard it and
        // leave the original path completely untouched (it may hold the only
        // local ciphertext).
        await RNFetchBlob.fs.unlink(tempFilePath).catch(() => {
          /* empty */
        });
      } else if (
        mode.forceRemote &&
        mode.repairInvalidLocal &&
        Platform.OS === "ios"
      ) {
        // Apple-only, opt-in authenticated local repair. verifyOnly is handled
        // by the branch above, so File Check (which must stay non-destructive)
        // can never reach this promotion.
        const outcome = await promoteRepairingInvalidLocal(
          filename,
          tempFilePath,
          attachment
        );
        if (outcome === "deferred" || outcome === "failed") {
          // Nothing was promoted. The local bytes (if any) are preserved and
          // the caller reports the durable failure; returning here keeps the
          // catch cleanup from touching the original path.
          useAttachmentStore.getState().remove(filename);
          return false;
        }
      } else {
        // Verified. Never replace a file that may already be on disk. Reaching
        // this point means exists() above found no *size-valid* local
        // ciphertext, but a size-mismatched (e.g. partially written) original
        // can still be present; exists() reports such a file as absent without
        // unlinking it. Overwriting it could destroy the only local copy of the
        // attachment. Preserve it and discard only the verified temp download.
        if (await RNFetchBlob.fs.exists(originalFilePath)) {
          await RNFetchBlob.fs.unlink(tempFilePath).catch(() => {
            /* empty */
          });
        } else {
          await RNFetchBlob.fs.mv(tempFilePath, originalFilePath).catch(() => {
            /* empty */
          });
        }
      }
    } finally {
      // The decrypted plaintext is a verification artifact, never the
      // attachment itself. It must not linger in the cache on success or
      // failure, so remove it unconditionally.
      await RNFetchBlob.fs.unlink(plaintextTempPath).catch(() => {
        /* empty */
      });
      if (decryptedUri) {
        await RNFetchBlob.fs.unlink(decryptedCachePath(decryptedUri)).catch(
          () => {
            /* empty */
          }
        );
      }
    }

    if (mode.verifyOnly) {
      // Nothing was promoted by design, so the "promoted file is size-valid"
      // assertion below must not run: the local original may legitimately be
      // absent (or size-mismatched) in verify-only mode. The remote ciphertext
      // was authenticated, which is exactly what this mode promises.
      return true;
    }

    if (!(await exists(filename))) {
      throw new Error("File size mismatch");
    }

    return true;
  } catch (e) {
    if (
      !mode.silent &&
      (e as Error).message !== "canceled" &&
      !(e as Error).message.includes("NoSuchKey")
    ) {
      const toast = {
        heading: strings.downloadError((e as Error).message),
        message: (e as Error).message,
        type: "error" as const,
        context: "global"
      };
      ToastManager.show(toast);
      toast.context = "local";
      ToastManager.show(toast);
    }

    useAttachmentStore.getState().remove(filename);
    // Only ever clean up the partial temp download. Never unlink the original
    // path: exists() reports a size-mismatched local ciphertext as absent
    // without unlinking it, so the original can hold the only copy of the
    // attachment and it cannot be recreated once removed. In particular, never
    // unlink based on dateUploaded or a no-op "does the path exist" probe.
    RNFetchBlob.fs.unlink(tempFilePath).catch(() => {
      /* empty */
    });
    DatabaseLogger.error(e, "Download failed: ", {
      url
    });
    return false;
  }
}

/**
 * Manual File Check action.
 *
 * A remote HEAD that reports a plausible size (or a matching ETag) is not proof
 * that the server holds this exact ciphertext: a truncated, corrupted or
 * tampered object can still match both. This therefore authenticates the
 * *remote* object itself by re-downloading it with the same request options
 * core's `fs.downloadFile` builds (account token bound to the API host) and
 * verifying the decrypted plaintext against the attachment's own
 * key/IV/size/hash, exactly like the upload path's post-upload verification.
 *
 * The check is non-destructive: verify-only never promotes, moves or unlinks
 * the local original, and this manual action produces no toast of its own. The
 * caller owns both the failure report (`markAsFailed`) and the user-facing
 * toast, which is why verification failures are returned instead of recorded
 * here.
 *
 * Returns `undefined` when offline (existing behavior), `{ failed }` when the
 * remote object cannot be authenticated (including a missing attachment or no
 * account session) and `{ success: true }` only when the remote ciphertext
 * decrypted to the expected size *and* content hash.
 */
export async function checkAttachment(hash: string) {
  const internetState = await NetInfo.fetch();
  const isInternetReachable =
    internetState.isConnected && internetState.isInternetReachable;
  if (!isInternetReachable) return;
  const attachment = await db.attachments.attachment(hash);
  if (!attachment) return { failed: "Attachment not found." };

  const verificationFailed = () =>
    `${strings.fileVerificationFailed()} (File hash: ${hash})`;

  try {
    const token = await db.tokenManager.getAccessToken();
    if (!token) return { failed: verificationFailed() };

    // Identical construction to core's `fs.downloadFile`: the /s3 object url
    // for this hash, the attachment's chunk size and the account token bound to
    // the API host (assertBearerDestination inside downloadFile rejects a
    // malformed/mismatched credential).
    const requestOptions: RequestOptions = {
      url: `${hosts.API_HOST}/s3?name=${hash}`,
      headers: { Authorization: `Bearer ${token}` },
      chunkSize: attachment.chunkSize
    };

    const verified = await downloadFile(
      hash,
      requestOptions,
      // A dedicated token: downloadFile overwrites `cancelToken.cancel`.
      { cancel: async () => {} },
      {
        // A size-valid (or size-mismatched) local ciphertext must not
        // short-circuit the check; the remote object is what is being
        // authenticated.
        forceRemote: true,
        // Authenticate and discard: never promote over the local original.
        verifyOnly: true,
        // The manual check must not toast; the caller does.
        silent: true,
        // The caller marks the attachment failed, not this check.
        skipFailureMark: true
      }
    );

    if (!verified) return { failed: verificationFailed() };

    return { success: true };
  } catch (e) {
    return { failed: (e as Error)?.message || verificationFailed() };
  }
}
