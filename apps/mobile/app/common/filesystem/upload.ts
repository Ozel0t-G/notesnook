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
  isImage,
  RequestOptions,
  hosts,
  assertBearerDestination,
  MISSING_LOCAL_CIPHERTEXT_ERROR,
  isMissingLocalCiphertextError,
  LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
  isLocalCiphertextRepairFailedError
} from "@notesnook/core";
import { PermissionsAndroid, Platform } from "react-native";
import RNFetchBlob from "react-native-blob-util";
import { ToastManager } from "../../services/event-manager";
import { useAttachmentStore } from "../../stores/use-attachment-store";
import {
  getAppGroupIdForNative,
  getUploaderAppGroup,
  hasAppGroupContainer
} from "../../utils/constants";
import { DatabaseLogger, db } from "../database";
import {
  createCacheDir,
  isReuploadInFlight,
  migrateFilesFromCache,
  reconcileReuploadBackup
} from "./io";
import { cacheDir, cacheDirOld, checkUpload, getAppGroupPath } from "./utils";
import { downloadFile } from "./download";
import Upload from "@ammarahmed/react-native-upload";
import { CloudUploader } from "react-native-nitro-cloud-uploader";
import { useUserStore } from "../../stores/use-user-store";
import { sleep } from "../../utils/time";
import { isFeatureAvailable } from "@notesnook/common";
import { strings } from "@notesnook/intl";
import {
  completeMultipartRequest,
  initiateMultipartRequest
} from "./file-requests";

// Upload constants
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB
const MINIMUM_MULTIPART_FILE_SIZE = 25 * 1024 * 1024; // 25MB

interface InitiateMultipartResponse {
  uploadId: string;
  parts: string[];
  error?: string;
}

async function initiateMultipartUpload(
  filename: string,
  fileSize: number,
  headers: Record<string, string>
): Promise<InitiateMultipartResponse> {
  const totalParts = Math.ceil(fileSize / CHUNK_SIZE);

  const url = `${hosts.API_HOST}/s3/multipart?name=${filename}&parts=${totalParts}&uploadId=`;
  const response = await initiateMultipartRequest(url, headers);

  if (!response.ok) {
    throw new Error(
      `Failed to initiate multipart upload: ${response.statusText}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error);
  }

  if (!data.uploadId || !data.parts) {
    throw new Error("Failed to initiate multipart upload: invalid response.");
  }

  DatabaseLogger.info(
    `Initiated multipart upload for ${filename} with upload ID: ${data.uploadId}`
  );

  return data;
}

async function multipartUploadFile(
  filename: string,
  filePath: string,
  fileSize: number,
  requestOptions: RequestOptions,
  cancelToken: { cancel: (reason?: string) => Promise<void> }
): Promise<Response> {
  const { headers } = requestOptions;

  try {
    const uploadData = await initiateMultipartUpload(
      filename,
      fileSize,
      headers
    );
    const { uploadId, parts } = uploadData;

    DatabaseLogger.info(
      `Starting upload for ${filename} with ${parts.length} parts`
    );

    cancelToken.cancel = async () => {
      useAttachmentStore.getState().remove(filename);
      await CloudUploader.cancelUpload(uploadId);
    };

    CloudUploader.addListener("upload-progress", (event) => {
      useAttachmentStore
        .getState()
        .setProgress(
          event.bytesUploaded || 0,
          event.totalBytes || fileSize,
          filename,
          0,
          "upload"
        );
      DatabaseLogger.info(
        `File upload progress: ${filename}, ${event.bytesUploaded}/${
          event.totalBytes || fileSize
        }, chunk: ${event.chunkIndex}, progress: ${event.progress}`
      );
    });
    // CloudUploader handles chunking and uploading all parts internally
    const result = await CloudUploader.startUpload(
      filename,
      filePath,
      parts,
      3, // maxParallel
      true // showNotification
    );

    CloudUploader.removeListener("upload-progress");

    if (!result.success) {
      throw new Error("Failed to upload multipart file");
    }

    DatabaseLogger.info(
      `Multipart upload completed for ${filename} with upload ID: ${uploadId}`
    );

    const completeUrl = `${hosts.API_HOST}/s3/multipart`;
    const response = await completeMultipartRequest(
      completeUrl,
      {
        Key: filename,
        UploadId: uploadId,
        PartETags: result.etags.map((etag, index) => ({
          partNumber: index + 1,
          etag: etag
        }))
      },
      headers
    );

    return response;
  } catch (error) {
    DatabaseLogger.error(error, "Multipart upload failed", { filename });
    CloudUploader.removeListener("upload-progress");
    useAttachmentStore.getState().remove(filename);
    throw error;
  }
}

/**
 * Normalize the path `Sodium.decryptFile(..., "cache")` returns. The native
 * module may keep the `file://` scheme and may return a path relative to the
 * cache directory; the plaintext has to be stat'ed, hashed and unlinked, so it
 * must be a plain absolute path. Kept byte-compatible with the private
 * `decryptedCachePath` in download.ts (it is not exported, and importing the
 * mocked `./download` here would drag its whole dependency graph in).
 */
function decryptedCachePath(uri: string) {
  const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  return path.startsWith("/") ? path : `${cacheDir}/${path}`;
}

/**
 * Apple upload preflight.
 *
 * `uploadFile` locates the local ciphertext by raw presence only. A corrupted,
 * truncated or tampered local file would be PUT as-is and silently overwrite a
 * valid remote object with unusable data. Before any PUT/multipart request the
 * local ciphertext is therefore authenticated against the attachment's own
 * key/IV/salt/chunkSize: it must decrypt to a plaintext of exactly
 * `attachment.size` bytes whose xxh64 content hash equals `attachment.hash`.
 *
 * The ciphertext is addressed by its exact filename via the same FileCipher
 * shape `download.ts` uses (including the App Group fallback), so a copy in the
 * App Group container is found too. The decrypted plaintext is an artifact and
 * is always removed in `finally`; the ciphertext itself is never touched.
 *
 * Returns `true` only when the local ciphertext is authentic. Every other
 * outcome (missing attachment row, undecryptable key, decrypt/hash failure,
 * mismatch) returns `false` and the caller must fail closed without a toast.
 */
async function authenticateLocalCiphertext(filename: string): Promise<boolean> {
  const plaintextPath = `${cacheDir}/${filename}_dcache`;
  let decryptedUri: string | undefined;
  try {
    const attachment = await db.attachments.attachment(filename);
    // Without the attachment row there is no key/IV/size/hash to authenticate
    // against, so the ciphertext cannot be proven to be this attachment's.
    if (!attachment) return false;

    const key = await db.attachments.decryptKey(attachment.key);
    if (!key) return false;

    decryptedUri = await Sodium.decryptFile(
      key,
      {
        iv: attachment.iv,
        salt: attachment.salt,
        // `size` mirrors the FileEncryptionMetadata shape the native module and
        // download.ts use.
        size: attachment.size,
        // The exact filename: it is both the ciphertext file name and the hash
        // the object is keyed by.
        hash: filename,
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
      DatabaseLogger.error(
        new Error(`${strings.fileVerificationFailed()} (File hash: ${filename})`),
        "Local ciphertext failed verification",
        {
          filename,
          expectedSize: attachment.size,
          decryptedSize,
          expectedHash: attachment.hash,
          decryptedHash
        }
      );
      return false;
    }

    return true;
  } catch (e) {
    // A corrupt, unreadable or undecryptable local ciphertext must never be
    // uploaded: it would replace the remote copy with unusable data. Fail
    // closed and let core keep the attachment pending for a later retry.
    DatabaseLogger.error(e, "Local ciphertext verification failed", {
      filename
    });
    return false;
  } finally {
    // The decrypted plaintext is a verification artifact, never the attachment.
    // Remove it whether verification succeeded or not.
    await RNFetchBlob.fs.unlink(plaintextPath).catch(() => {
      /* empty */
    });
    if (decryptedUri) {
      await RNFetchBlob.fs.unlink(decryptedCachePath(decryptedUri)).catch(() => {
        /* empty */
      });
    }
  }
}

/**
 * Apple-only authenticated local repair, used when a local ciphertext exists
 * but is unusable: zero bytes, or present-but-not-authentic per the preflight.
 *
 * Fetches the remote object and, only if it authenticates against the
 * attachment row, quarantines the invalid local bytes and promotes the verified
 * remote copy into `cacheDir` (see `DownloadMode.repairInvalidLocal`). Returns
 * `true` only when a valid local ciphertext now exists — either because the
 * remote was promoted or because the local copy already authenticated — so the
 * caller can report the attachment uploaded without a PUT. Never throws: a
 * failure leaves every local byte in place and the caller must fail closed.
 */
async function repairInvalidLocalCiphertext(
  filename: string,
  requestOptions: RequestOptions
): Promise<boolean> {
  try {
    return await downloadFile(
      filename,
      requestOptions,
      // A dedicated cancel token: `downloadFile` overwrites the token's
      // `cancel`, which must not clobber the upload's own cancel handler.
      { cancel: async () => {} },
      {
        forceRemote: true,
        repairInvalidLocal: true,
        silent: true,
        // The caller/core owns the failure marker: a transient repair failure
        // (reupload in flight, row changed mid-download) must not write a
        // status directly from `downloadFile`, and a durable failure is
        // recorded by `uploadFile`'s own marker below.
        skipFailureMark: true
      }
    );
  } catch (e) {
    DatabaseLogger.error(e, "Local ciphertext repair failed", { filename });
    return false;
  }
}

/**
 * Whether a failed authenticated repair should be treated as a transient
 * deferral instead of a durable "local ciphertext repair failed" condition.
 *
 * `download.ts` collapses its repair outcomes into a single `false` (both the
 * "deferred because an explicit reupload owns the ciphertext" and the genuine
 * "failed" cases), so a reupload that starts while the network-bound repair is
 * running cannot be told apart there. Re-checking the in-flight flag here keeps
 * that transient window transient: the upload defers (returns `false`, leaves
 * the local bytes alone and records no marker) and core retries on a later sync
 * once the reupload settles, instead of persisting a durable failure against a
 * ciphertext that is about to become valid.
 */
function shouldDeferFailedRepair(filename: string): boolean {
  if (Platform.OS !== "ios" || !isReuploadInFlight(filename)) return false;
  DatabaseLogger.log(
    `Reupload in flight for ${filename} after a failed repair, deferring instead of recording a durable failure.`
  );
  return true;
}

export async function uploadFile(
  filename: string,
  requestOptions: RequestOptions,
  cancelToken: {
    cancel: (reason?: string) => Promise<void>;
  }
) {
  if (!requestOptions) return false;
  const { url, headers } = requestOptions;
  await createCacheDir();
  DatabaseLogger.info(`Preparing to upload file: ${filename}`);

  // An explicit reupload is mid-flight for this hash: the real `<hash>` may be
  // partially written. Fail closed and let core retry after the reupload
  // settles, instead of PUT-ing a half-staged ciphertext.
  if (Platform.OS === "ios" && isReuploadInFlight(filename)) {
    DatabaseLogger.log(
      `Reupload in flight for ${filename}, deferring upload.`
    );
    useAttachmentStore.getState().remove(filename);
    return false;
  }
  // Resolve any leftover reupload backup before probing the local ciphertext
  // so a crash-between-commit-and-cleanup cannot cause the wrong bytes to be
  // uploaded.
  await reconcileReuploadBackup(filename);

  try {
    let filePath = `${cacheDir}/${filename}`;
    let exists = await RNFetchBlob.fs.exists(filePath);
    // Old builds wrote ciphertext to RNFetchBlob's CacheDir (cacheDirOld), a
    // different location from cacheDir. On Apple platforms the preflight below
    // authenticates the ciphertext by its exact filename through the native
    // cipher, which resolves it from the cache dir / App Group — not the legacy
    // dir. Migrate the legacy copy first and re-probe the cache dir so the
    // ciphertext is validated from the location the cipher can actually read.
    if (!exists && Platform.OS === "ios") {
      const legacyFilePath = `${cacheDirOld}/${filename}`;
      if (await RNFetchBlob.fs.exists(legacyFilePath)) {
        await migrateFilesFromCache();
        filePath = `${cacheDir}/${filename}`;
        exists = await RNFetchBlob.fs.exists(filePath);
        if (!exists) {
          // The migration did not produce a usable cache-dir copy (e.g. it
          // failed). The legacy file may be the only local copy of the
          // ciphertext, so it must never be unlinked here: fail closed and
          // defer the upload.
          DatabaseLogger.log(
            `Legacy ciphertext for ${filename} could not be migrated to the cache dir, deferring upload.`
          );
          useAttachmentStore.getState().remove(filename);
          return false;
        }
      }
    } else if (!exists) {
      // Android has no App Group container and no cipher-based preflight, so it
      // keeps the previous behavior: a legacy-only ciphertext is uploaded
      // directly from the legacy dir.
      const legacyFilePath = `${cacheDirOld}/${filename}`;
      exists = await RNFetchBlob.fs.exists(legacyFilePath);
      if (exists) filePath = legacyFilePath;
    }

    // Check for file in appGroupPath if it doesn't exist in cacheDir. Skipped
    // when this process has no App Group container (Mac Catalyst), where the
    // file can only be in the app's own cache directory. Gated on iOS because
    // hasAppGroupContainer() reports true on Android, which has no App Group.
    if (!exists && Platform.OS === "ios" && hasAppGroupContainer()) {
      const iosAppGroup = await getAppGroupPath();
      if (iosAppGroup) {
        const appGroupPath = `${iosAppGroup}/${filename}`;
        filePath = appGroupPath;
        exists = await RNFetchBlob.fs.exists(filePath);
      } else {
        // This device does have an App Group container but its path could not
        // be resolved right now (e.g. a transient pathForAppGroup failure).
        // The ciphertext may still be in the container, so absence is UNKNOWN,
        // not confirmed. Return quietly without a global error toast so core
        // keeps the attachment pending and retries it on a later sync instead
        // of recording a terminal missing-ciphertext marker.
        DatabaseLogger.log(
          `App Group path unavailable, deferring upload of ${filename}.`
        );
        useAttachmentStore.getState().remove(filename);
        return false;
      }
    }

    if (!exists) {
      // The file is in none of the locations this process can see: neither the
      // cache dir, nor the legacy cache dir, nor (on iOS) a resolved App Group
      // container — or this process has no App Group container at all (Mac
      // Catalyst / simulator).
      //
      // On Apple platforms (iPhone/iPad/iPadOS/Mac Catalyst) a local cache miss
      // does not prove the ciphertext is gone: a pending attachment may have a
      // copy on the server (e.g. it was restored/reinstalled on this device).
      // Attempt to recover it by forcing a remote download, which authenticates
      // the remote bytes against the attachment's own key/IV/size/hash before
      // promoting them into the local cache. Only when that fails is the
      // ciphertext treated as confirmed missing.
      if (Platform.OS === "ios") {
        // A dedicated cancel token is mandatory: `downloadFile` overwrites
        // `cancelToken.cancel` with its own handler, which would clobber the
        // upload's cancel handler (the caller's token is never mutated here).
        let recovered = false;
        try {
          recovered = await downloadFile(
            filename,
            requestOptions,
            { cancel: async () => {} },
            // forceRemote: skip the local short-circuits and fetch/authenticate
            //   the remote object. N.B. deliberately NOT `verifyOnly`: this mode
            //   promotes the authenticated temp ciphertext into the cache dir,
            //   which is exactly what a recovered upload needs.
            // silent: a recovery failure is not a user action item, so no toast.
            // skipFailureMark: the caller owns the outcome — a recovery miss
            //   becomes the terminal MISSING_LOCAL_CIPHERTEXT_ERROR marker
            //   below, and a transient network/repair failure must not write a
            //   status directly from `downloadFile`.
            { forceRemote: true, silent: true, skipFailureMark: true }
          );
        } catch (e) {
          // `downloadFile` normally resolves false on failure, but a failure
          // before its own try block could still reject. Swallow it here so the
          // confirmed-absent path never surfaces a global startup toast.
          DatabaseLogger.error(
            e,
            "Failed to recover missing local ciphertext from remote",
            { filename }
          );
          recovered = false;
        }

        if (recovered) {
          // The remote copy was authenticated and promoted into the cache dir.
          // There is nothing to PUT: returning true here makes core mark the
          // attachment uploaded, and no local ciphertext is overwritten or
          // deleted.
          useAttachmentStore.getState().remove(filename);
          return true;
        }

        // No authenticated remote copy could be recovered. Throw the stable
        // core marker: core persists it and skips this attachment in later
        // syncs instead of retrying in a loop. Deliberately no toast.
        throw new Error(MISSING_LOCAL_CIPHERTEXT_ERROR);
      }
      throw new Error(
        `Trying to upload file at path ${filePath} that doest not exist.`
      );
    }

    const fileInfo = await RNFetchBlob.fs.stat(filePath);

    // A zero-byte local file is never valid ciphertext. On Apple platforms the
    // native cipher treats a zero-byte cache-dir file as missing and falls back
    // to a copy elsewhere (App Group), so the preflight below could authenticate
    // that other copy while this zero-byte file is still what gets PUT. Fail
    // closed before the preflight/PUT and never delete the file. Before treating
    // the attachment as unusable, try to repair it from an authenticated remote
    // copy; the zero-byte local bytes are preserved (quarantined, not deleted).
    //
    // Android has no App Group container, no native cipher preflight and no
    // authenticated remote repair, so this recovery path is Apple-only. Android
    // must still never PUT a zero-byte file: it preserves the local bytes (never
    // unlinked) and falls through to the generic failure path below (a plain
    // `Error` -> toast + resolve `false`), with no repair download and without
    // recording the Apple-only `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR` marker.
    if (Number(fileInfo.size) === 0) {
      if (Platform.OS === "ios") {
        DatabaseLogger.log(
          `Local ciphertext for ${filename} is zero bytes, attempting authenticated repair.`
        );
        const repaired = await repairInvalidLocalCiphertext(
          filename,
          requestOptions
        );
        useAttachmentStore.getState().remove(filename);
        if (repaired) return true;
        // A reupload that started while the repair ran owns the ciphertext now;
        // treat this as a transient deferral rather than corruption.
        if (shouldDeferFailedRepair(filename)) return false;
        // No authenticated remote copy could be recovered either. The local bytes
        // stay on disk (they are present, just invalid), so a raw presence check
        // would report the attachment as present. Throw the stable "repair
        // failed" core marker, which core backs off for 30 minutes purely from
        // `dateModified` regardless of the raw `exists()` result instead of
        // re-running this repair download on every sync. Deliberately no toast.
        throw new Error(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR);
      }
      throw new Error(
        `Refusing to upload a zero-byte file at path ${filePath}.`
      );
    }

    const featureResult = await isFeatureAvailable(
      "fileSize",
      fileInfo.size || 0
    );

    if (!featureResult.isAllowed) {
      ToastManager.show({
        heading: strings.fileTooLarge(),
        message: featureResult.error,
        type: "error"
      });
      return false;
    }

    let attachmentInfo = await db.attachments.attachment(filename);

    // Apple upload preflight. The raw-presence probe above only proves *a* file
    // with this name exists. Before any PUT/multipart request the local
    // ciphertext must be authenticated as this attachment's exact content,
    // otherwise a corrupted local file would overwrite a valid remote object.
    // A failure is never PUT; instead try to repair the local copy from an
    // authenticated remote copy, and only then give up. Deliberately silent and
    // fail-closed (no global toast).
    if (Platform.OS === "ios") {
      const authenticated = await authenticateLocalCiphertext(filename);
      if (!authenticated) {
        DatabaseLogger.log(
          `Local ciphertext for ${filename} failed authentication, attempting authenticated repair.`
        );
        const repaired = await repairInvalidLocalCiphertext(
          filename,
          requestOptions
        );
        useAttachmentStore.getState().remove(filename);
        if (repaired) return true;
        // A reupload that started while the repair ran owns the ciphertext now;
        // treat this as a transient deferral rather than corruption.
        if (shouldDeferFailedRepair(filename)) return false;
        // The present-but-corrupt local bytes are preserved and a durable,
        // exists-independent marker is recorded *after* the remote was actually
        // checked, so core backs off for 30 minutes regardless of the file's
        // presence instead of silently re-downloading on every sync.
        throw new Error(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR);
      }
    }

    DatabaseLogger.info(
      `Starting upload of ${filename} at path: ${fileInfo.path} ${fileInfo.size}`
    );

    if (Platform.OS === "android") {
      useUserStore.setState({
        disableAppLockRequests: true
      });
      const status = await PermissionsAndroid.request(
        "android.permission.POST_NOTIFICATIONS"
      );
      if (status !== "granted") {
        ToastManager.show({
          message: `The permission to show file upload notification was disallowed by the user.`,
          type: "info"
        });
      }
      await sleep(500);
      useUserStore.setState({
        disableAppLockRequests: false
      });
    }

    let uploaded = false;

    // Use multipart upload for files larger than MINIMUM_MULTIPART_FILE_SIZE
    if (fileInfo.size >= MINIMUM_MULTIPART_FILE_SIZE) {
      DatabaseLogger.info(
        `Using multipart upload for large file: ${filename} (${fileInfo.size} bytes)`
      );
      const result = await multipartUploadFile(
        filename,
        filePath,
        fileInfo.size,
        requestOptions,
        cancelToken
      );
      const status = result.status || 0;
      uploaded = status >= 200 && status < 300;

      if (!uploaded) {
        const fileInfo = await RNFetchBlob.fs.stat(filePath);
        throw new Error(
          `${status}, name: ${fileInfo.filename}, length: ${
            fileInfo.size
          }, info: ${JSON.stringify(await result.text())}`
        );
      }
    } else {
      // Use single-part upload for smaller files
      DatabaseLogger.info(
        `Using single-part upload for file: ${filename} (${fileInfo.size} bytes)`
      );
      assertBearerDestination(headers, url);
      const upload = Upload.create({
        customUploadId: filename,
        path: Platform.OS === "ios" ? "file://" + fileInfo.path : fileInfo.path,
        url: url,
        method: "PUT",
        headers: {
          ...headers,
          "content-type": "application/octet-stream"
        },
        // Empty on Mac Catalyst: the uploader only sets
        // sharedContainerIdentifier for a non-empty string, and the app has no
        // App Group container there.
        appGroup: getUploaderAppGroup(),
        notification: {
          filename:
            attachmentInfo && isImage(attachmentInfo?.mimeType)
              ? "image"
              : attachmentInfo?.filename || "file",
          enabled: true,
          enableRingTone: true,
          autoClear: true
        }
      }).onChange((event) => {
        switch (event.status) {
          case "running":
          case "pending":
            useAttachmentStore
              .getState()
              .setProgress(
                event.uploadedBytes || 0,
                event.totalBytes || fileInfo.size,
                filename,
                0,
                "upload"
              );
            DatabaseLogger.info(
              `File upload progress: ${filename}, ${event.uploadedBytes}/${
                event.totalBytes || fileInfo.size
              }`
            );
            break;
          case "completed":
            DatabaseLogger.info("Upload completed");
            break;
        }
      });
      const result = await upload.start();
      cancelToken.cancel = async () => {
        useAttachmentStore.getState().remove(filename);
        upload.cancel();
      };

      const status = result.responseCode || 0;
      uploaded = status >= 200 && status < 300;

      if (!uploaded) {
        const fileInfo = await RNFetchBlob.fs.stat(filePath);
        throw new Error(
          `${status}, name: ${fileInfo.filename}, length: ${
            fileInfo.size
          }, info: ${JSON.stringify(result.error)}`
        );
      }
    }

    useAttachmentStore.getState().remove(filename);

    if (uploaded) {
      attachmentInfo = await db.attachments.attachment(filename);
      if (!attachmentInfo) return false;
      await checkUpload(
        filename,
        requestOptions.chunkSize,
        attachmentInfo.size
      );

      if (Platform.OS === "ios") {
        // checkUpload only compares the remote HEAD Content-Length against the
        // expected ciphertext size. A matching size (or ETag) is not proof that
        // the server holds this exact ciphertext, so before reporting success
        // the remote object must be re-downloaded and authenticated: decrypted
        // with the attachment's own key/IV/size/hash and discarded. A dedicated
        // cancel token is used because `downloadFile` overwrites
        // `cancelToken.cancel`, which would otherwise clobber this upload's
        // cancel handler. Silent: a verification failure is not a user action
        // item and the attachment is simply kept pending.
        const verified = await downloadFile(
          filename,
          requestOptions,
          { cancel: async () => {} },
          // skipFailureMark: a failed post-upload verification is a transient
          // deferral (the local copy is kept and the attachment stays pending),
          // not a durable failure to write from `downloadFile`; core owns the
          // retry.
          { forceRemote: true, verifyOnly: true, silent: true, skipFailureMark: true }
        );

        if (!verified) {
          // The remote copy could not be authenticated. Return false without
          // touching the local ciphertext: core keeps the attachment pending
          // (markAsFailed only clears `failed`, never `dateUploaded`) so the
          // next sync retries the upload instead of evicting the only local
          // copy.
          DatabaseLogger.error(
            new Error("Uploaded file failed remote verification."),
            "File upload verification failed",
            { filename }
          );
          return false;
        }
      }

      DatabaseLogger.info(`File upload status: ${filename}, success`);
    }

    return uploaded;
  } catch (e) {
    useAttachmentStore.getState().remove(filename);
    if (isMissingLocalCiphertextError(e)) {
      // Confirmed-missing local ciphertext is a terminal condition that core
      // must observe: rethrow so it can persist the marker and skip this
      // attachment in later syncs. Deliberately no global ToastManager.error
      // here, since the user has no action to take and the iPhone startup sync
      // must not surface an error popup for a file that can never upload.
      DatabaseLogger.error(e, "Attachment ciphertext missing locally", {
        filename
      });
      throw e;
    }
    if (isLocalCiphertextRepairFailedError(e)) {
      // Present-but-invalid local ciphertext whose authenticated remote repair
      // also failed. Like the missing marker this is a terminal, device-local
      // condition core must observe and back off; rethrow so the marker is
      // persisted, again with no global ToastManager.error so startup sync does
      // not surface a popup for a file the user cannot fix without Reupload.
      DatabaseLogger.error(
        e,
        "Attachment ciphertext could not be repaired locally",
        { filename }
      );
      throw e;
    }
    ToastManager.error(e as Error, "File upload failed");
    DatabaseLogger.error(e, "File upload failed", {
      filename
    });
    return false;
  }
}
