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

// `uploadFile` must actually PUT a pending local ciphertext even when a remote
// HEAD would report the very same size. A pre-flight "remote size matches
// local, so treat it as already uploaded" short-circuit silently drops the
// only copy of the file: the server never received it, and the local
// ciphertext can be evicted later. These cases pin that the single-part PUT is
// always attempted for files below MINIMUM_MULTIPART_FILE_SIZE, that success
// is derived from the real upload response code, and that a failed upload
// resolves `false` (surfacing an error) rather than pretending success.

export {};

jest.mock(
  "./utils",
  () => ({
    ABYTES: 17,
    cacheDir: "/cache",
    // Legacy RNFetchBlob CacheDir. On Apple platforms upload.ts migrates it
    // into the cache dir and validates from there (the native cipher resolves
    // the ciphertext by filename from the cache dir / App Group, not here).
    cacheDirOld: "/cache-old",
    getAppGroupPath: jest.fn(async () => null),
    // Mocked so the real checkUpload -> getUploadedFileSize chain does not run:
    // the assertion below guards against a direct pre-flight HEAD call added to
    // upload.ts, not against checkUpload's internal use of getUploadedFileSize.
    checkUpload: jest.fn(async () => {}),
    getUploadedFileSize: jest.fn(async () => 1024)
  }),
  { virtual: true }
);

jest.mock(
  "../database",
  () => ({
    DatabaseLogger: {
      log: jest.fn(),
      info: jest.fn(),
      error: jest.fn()
    },
    db: {
      attachments: {
        attachment: jest.fn(),
        decryptKey: jest.fn(async () => ({ key: "decryption-key" }))
      }
    }
  }),
  { virtual: true }
);

jest.mock(
  "../../services/event-manager",
  () => ({
    ToastManager: { show: jest.fn(), error: jest.fn() },
    eSendEvent: jest.fn()
  }),
  { virtual: true }
);

jest.mock(
  "../../utils/constants",
  () => ({
    getUploaderAppGroup: jest.fn(() => "group.example"),
    // Passed to Sodium.decryptFile so the App Group fallback is exercised.
    getAppGroupIdForNative: jest.fn(() => "group.example.appgroup"),
    // Physical iPhone/iPad have an App Group container by default here; the
    // Mac Catalyst / no-container case overrides this per test.
    hasAppGroupContainer: jest.fn(() => true)
  }),
  { virtual: true }
);

jest.mock(
  "@ammarahmed/react-native-sodium",
  () => ({
    __esModule: true,
    default: {
      decryptFile: jest.fn(),
      hashFile: jest.fn()
    }
  }),
  { virtual: true }
);

jest.mock(
  "react-native",
  () => ({
    Platform: {
      OS: "ios",
      select: (spec: Record<string, unknown>) => spec.default
    },
    PermissionsAndroid: { request: jest.fn(async () => "granted") }
  }),
  { virtual: true }
);

jest.mock(
  "react-native-blob-util",
  () => ({
    __esModule: true,
    default: {
      fs: {
        exists: jest.fn(),
        stat: jest.fn(),
        unlink: jest.fn(async () => {}),
        dirs: {
          CacheDir: "/cache-old",
          LibraryDir: "/library",
          DocumentDir: "/documents"
        }
      }
    }
  }),
  { virtual: true }
);

// The real core markers/predicates are mirrored here (the actual
// `@notesnook/core` package's `dist` is not built in this checkout, so
// `jest.requireActual` cannot load it). Keep the strings byte-identical to
// packages/core/src/common.ts — they are persisted verbatim and matched by
// strict equality.
jest.mock(
  "@notesnook/core",
  () => ({
    isImage: jest.fn(() => false),
    hosts: { API_HOST: "https://api.veyran.northcore.space" },
    assertBearerDestination: jest.fn(),
    MISSING_LOCAL_CIPHERTEXT_ERROR:
      "Attachment data is missing on this device and cannot be uploaded.",
    isMissingLocalCiphertextError: jest.fn(
      (error: unknown) =>
        error ===
          "Attachment data is missing on this device and cannot be uploaded." ||
        (error instanceof Error &&
          error.message ===
            "Attachment data is missing on this device and cannot be uploaded.")
    ),
    LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR:
      "Attachment data on this device is damaged and could not be repaired automatically.",
    isLocalCiphertextRepairFailedError: jest.fn(
      (error: unknown) =>
        error ===
          "Attachment data on this device is damaged and could not be repaired automatically." ||
        (error instanceof Error &&
          error.message ===
            "Attachment data on this device is damaged and could not be repaired automatically.")
    )
  }),
  { virtual: true }
);

jest.mock(
  "@ammarahmed/react-native-upload",
  () => ({ __esModule: true, default: { create: jest.fn() } }),
  { virtual: true }
);

jest.mock(
  "react-native-nitro-cloud-uploader",
  () => ({
    CloudUploader: {
      startUpload: jest.fn(),
      cancelUpload: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn()
    }
  }),
  { virtual: true }
);

jest.mock(
  "../../stores/use-attachment-store",
  () => ({
    useAttachmentStore: {
      getState: jest.fn()
    }
  }),
  { virtual: true }
);

jest.mock(
  "../../stores/use-user-store",
  () => ({ useUserStore: { setState: jest.fn() } }),
  { virtual: true }
);

jest.mock("../../utils/time", () => ({ sleep: jest.fn(async () => {}) }), {
  virtual: true
});

jest.mock(
  "@notesnook/common",
  () => ({ isFeatureAvailable: jest.fn(async () => ({ isAllowed: true })) }),
  { virtual: true }
);

jest.mock(
  "@notesnook/intl",
  () => ({
    strings: {
      fileTooLarge: () => "file too large",
      fileVerificationFailed: () => "file verification failed"
    }
  }),
  { virtual: true }
);

jest.mock(
  "./io",
  () => ({
    createCacheDir: jest.fn(async () => {}),
    // Present so tests can assert upload.ts never triggers the racy legacy
    // migration (its mv() operations are unawaited) while handling an upload.
    migrateFilesFromCache: jest.fn(async () => {}),
    // Apple reupload staging guards. Default to "no reupload in flight" so the
    // existing probe-order assertions are unaffected; the reupload-specific
    // tests override isReuploadInFlight and pin reconcile is called.
    isReuploadInFlight: jest.fn(() => false),
    reconcileReuploadBackup: jest.fn(async () => {})
  }),
  { virtual: true }
);

jest.mock(
  "./file-requests",
  () => ({
    initiateMultipartRequest: jest.fn(),
    completeMultipartRequest: jest.fn()
  }),
  { virtual: true }
);

// `uploadFile` must authenticate the remote copy with the (already verified)
// download pipeline before reporting success. The real module is replaced
// wholesale so its own dependency graph never loads here.
jest.mock("./download", () => ({
  downloadFile: jest.fn(async () => true)
}));

import Upload from "@ammarahmed/react-native-upload";
import RNFetchBlob from "react-native-blob-util";
import Sodium from "@ammarahmed/react-native-sodium";
import { Platform } from "react-native";
import {
  assertBearerDestination,
  LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR,
  MISSING_LOCAL_CIPHERTEXT_ERROR
} from "@notesnook/core";
import { useAttachmentStore } from "../../stores/use-attachment-store";
import { ToastManager } from "../../services/event-manager";
import {
  getAppGroupIdForNative,
  hasAppGroupContainer
} from "../../utils/constants";
import { db } from "../database";
import { checkUpload, getAppGroupPath, getUploadedFileSize } from "./utils";
import {
  isReuploadInFlight,
  migrateFilesFromCache,
  reconcileReuploadBackup
} from "./io";
import {
  completeMultipartRequest,
  initiateMultipartRequest
} from "./file-requests";
import { downloadFile } from "./download";
import { uploadFile } from "./upload";

const fs = RNFetchBlob.fs as unknown as {
  exists: jest.Mock;
  stat: jest.Mock;
  unlink: jest.Mock;
};
const sodium = Sodium as unknown as {
  decryptFile: jest.Mock;
  hashFile: jest.Mock;
};
const uploadCreate = Upload.create as unknown as jest.Mock;
const lookupAttachment = db.attachments.attachment as unknown as jest.Mock;
const decryptKeyMock = db.attachments.decryptKey as unknown as jest.Mock;
const bearerGuard = assertBearerDestination as unknown as jest.Mock;
const checkUploadMock = checkUpload as unknown as jest.Mock;
const getUploadedFileSizeMock = getUploadedFileSize as unknown as jest.Mock;
const getAppGroupPathMock = getAppGroupPath as unknown as jest.Mock;
const getAppGroupIdForNativeMock =
  getAppGroupIdForNative as unknown as jest.Mock;
const hasAppGroupContainerMock =
  hasAppGroupContainer as unknown as jest.Mock;
const toastError = ToastManager.error as unknown as jest.Mock;
const migrateFilesFromCacheMock = migrateFilesFromCache as unknown as jest.Mock;
const isReuploadInFlightMock = isReuploadInFlight as unknown as jest.Mock;
const reconcileReuploadBackupMock =
  reconcileReuploadBackup as unknown as jest.Mock;
const downloadFileMock = downloadFile as unknown as jest.Mock;
const initiateMultipartRequestMock =
  initiateMultipartRequest as unknown as jest.Mock;
const completeMultipartRequestMock =
  completeMultipartRequest as unknown as jest.Mock;

const FILENAME = "3f9a1c0b7d2e4f56";
const FILE_PATH = `/cache/${FILENAME}`;
const LEGACY_FILE_PATH = `/cache-old/${FILENAME}`;
// Sodium.decryptFile(..., "cache") output for the ciphertext named `<FILENAME>`.
const PLAINTEXT_PATH = `${FILE_PATH}_dcache`;
const DECRYPTION_KEY = { key: "decryption-key" };
// Below MINIMUM_MULTIPART_FILE_SIZE (25 MB) so the single-part PUT path runs.
const FILE_SIZE = 1024;
const ATTACHMENT_CHUNK_SIZE = 1024 * 1024;
// The exact repair mode `uploadFile` must pass to `downloadFile` for the
// zero-byte and failed-preflight branches: fetch and authenticate the remote
// object, quarantine the invalid local bytes and promote the verified copy.
const REPAIR_MODE = {
  forceRemote: true,
  repairInvalidLocal: true,
  silent: true,
  skipFailureMark: true
} as const;

const removeAttachment = jest.fn();
const setProgress = jest.fn();

const uploadInstance = {
  onChange: jest.fn(),
  start: jest.fn(),
  cancel: jest.fn()
};

const requestOptions = {
  url: "https://api.veyran.northcore.space/s3?name=" + FILENAME,
  headers: { Authorization: "Bearer file-token" },
  chunkSize: 1024 * 1024
};

type UploadRequestOptions = Parameters<typeof uploadFile>[1];
type UploadCancelToken = Parameters<typeof uploadFile>[2];

function makeCancelToken(): UploadCancelToken {
  return { cancel: jest.fn(async () => {}) };
}

beforeEach(() => {
  jest.clearAllMocks();

  // Physical iPhone/iPad defaults: App Group container exists, cache has the
  // file. Individual tests override these per scenario.
  (Platform as unknown as { OS: string }).OS = "ios";
  hasAppGroupContainerMock.mockReturnValue(true);
  getAppGroupPathMock.mockResolvedValue(null);
  getAppGroupIdForNativeMock.mockReturnValue("group.example.appgroup");

  fs.exists.mockImplementation(async (path: string) => path === FILE_PATH);
  fs.unlink.mockResolvedValue(undefined);
  migrateFilesFromCacheMock.mockImplementation(async () => {});
  fs.stat.mockImplementation(async (path: string) => {
    if (path === FILE_PATH)
      return { size: FILE_SIZE, path: FILE_PATH, filename: FILENAME };
    // The preflight attributes the decrypted plaintext.
    if (path === PLAINTEXT_PATH)
      return { size: FILE_SIZE, path: PLAINTEXT_PATH, filename: FILENAME };
    throw new Error(`ENOENT: ${path}`);
  });

  // Pending local ciphertext: written to the cache dir but not yet on the
  // server. The extra cipher fields are what the Apple upload preflight
  // authenticates the local ciphertext with.
  lookupAttachment.mockImplementation(async () => ({
    id: "attachment-id",
    filename: FILENAME,
    hash: FILENAME,
    size: FILE_SIZE,
    chunkSize: ATTACHMENT_CHUNK_SIZE,
    iv: "attachment-iv",
    salt: "attachment-salt",
    alg: "xcha-stream",
    hashType: "xxh64",
    mimeType: "application/octet-stream",
    key: { cipher: "encrypted-key", alg: "xchacha20" },
    dateUploaded: null
  }));

  // Successful preflight by default: the ciphertext decrypts to a plaintext of
  // the expected size whose hash matches the attachment. Tampering tests
  // override one of these.
  decryptKeyMock.mockResolvedValue(DECRYPTION_KEY);
  sodium.decryptFile.mockResolvedValue(PLAINTEXT_PATH);
  sodium.hashFile.mockResolvedValue(FILENAME);

  uploadInstance.onChange.mockReturnValue(uploadInstance);
  uploadInstance.start.mockResolvedValue({ responseCode: 200 });
  uploadCreate.mockReturnValue(uploadInstance);

  getUploadedFileSizeMock.mockResolvedValue(FILE_SIZE);
  checkUploadMock.mockResolvedValue(undefined);
  // The authenticated remote re-download + verification succeeds by default;
  // verification-failure tests override this.
  downloadFileMock.mockResolvedValue(true);

  (useAttachmentStore.getState as jest.Mock).mockReturnValue({
    remove: removeAttachment,
    setProgress
  });
});

describe("uploadFile single-part upload", () => {
  test("still PUTs a pending ciphertext when the remote HEAD would report the same size", async () => {
    // A remote HEAD for this hash reports exactly the local ciphertext size.
    getUploadedFileSizeMock.mockResolvedValue(FILE_SIZE);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);

    // The upload must be dispatched, not skipped.
    expect(uploadCreate).toHaveBeenCalledTimes(1);
    expect(uploadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customUploadId: FILENAME,
        method: "PUT",
        url: requestOptions.url,
        path: `file://${FILE_PATH}`,
        headers: expect.objectContaining({
          Authorization: "Bearer file-token",
          "content-type": "application/octet-stream"
        })
      })
    );
    expect(uploadInstance.onChange).toHaveBeenCalledTimes(1);
    expect(uploadInstance.start).toHaveBeenCalledTimes(1);
    expect(bearerGuard).toHaveBeenCalledWith(
      requestOptions.headers,
      requestOptions.url
    );

    // Regression guard: no pre-flight remote-size check may short-circuit the PUT.
    expect(getUploadedFileSizeMock).not.toHaveBeenCalled();

    // The App Group fallback must not be consulted when the cache has the file.
    expect(getAppGroupPathMock).not.toHaveBeenCalled();

    // Success is acknowledged to the backend only after the PUT succeeded.
    expect(checkUploadMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions.chunkSize,
      FILE_SIZE
    );
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("returns false when the PUT fails instead of pretending the file is uploaded", async () => {
    uploadInstance.start.mockResolvedValue({
      responseCode: 403,
      error: "Forbidden"
    });

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(uploadInstance.start).toHaveBeenCalledTimes(1);
    expect(getUploadedFileSizeMock).not.toHaveBeenCalled();
    expect(checkUploadMock).not.toHaveBeenCalled();
    // A failed PUT must never trigger the remote verification download.
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("recovers a corrupted local ciphertext from an authenticated remote copy without a PUT", async () => {
    // The local ciphertext is present but does not decrypt to the attachment's
    // expected plaintext size. It must never be PUT (that would overwrite the
    // remote object with unusable data). Instead the remote copy is fetched,
    // authenticated and promoted to repair the local file.
    fs.exists.mockImplementation(async (path: string) => path === FILE_PATH);
    fs.stat.mockImplementation(async (path: string) => {
      if (path === FILE_PATH)
        return { size: FILE_SIZE, path: FILE_PATH, filename: FILENAME };
      if (path === PLAINTEXT_PATH)
        return {
          size: FILE_SIZE + 7,
          path: PLAINTEXT_PATH,
          filename: FILENAME
        };
      throw new Error(`ENOENT: ${path}`);
    });
    downloadFileMock.mockResolvedValue(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    // Recovered: the authenticated remote bytes are now the local copy, so no
    // PUT is dispatched and core can mark the attachment uploaded.
    expect(result).toBe(true);
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(bearerGuard).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      REPAIR_MODE
    );
    // The present local bytes are never relabelled as missing while the remote
    // still holds a usable copy, and no toast surfaces.
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
  });

  test("preserves the corrupt local file and fails durably when the remote copy cannot be recovered", async () => {
    // Same corrupted (present, size-valid) local ciphertext, but the server has
    // no authenticated copy either. The local bytes are kept (never PUT, never
    // deleted) and the exists-independent "repair failed" marker is recorded
    // only *after* the remote was checked.
    fs.exists.mockImplementation(async (path: string) => path === FILE_PATH);
    fs.stat.mockImplementation(async (path: string) => {
      if (path === FILE_PATH)
        return { size: FILE_SIZE, path: FILE_PATH, filename: FILENAME };
      if (path === PLAINTEXT_PATH)
        return {
          size: FILE_SIZE + 7,
          path: PLAINTEXT_PATH,
          filename: FILENAME
        };
      throw new Error(`ENOENT: ${path}`);
    });
    downloadFileMock.mockResolvedValue(false);

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR);

    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      REPAIR_MODE
    );
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(bearerGuard).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });
});

describe("uploadFile missing local ciphertext", () => {
  // The recovery mode `uploadFile` must pass to `downloadFile`: fetch and
  // authenticate the remote object, promote it into the cache dir (NOT
  // verifyOnly), and suppress user-facing toasts.
  const RECOVERY_MODE = {
    forceRemote: true,
    silent: true,
    skipFailureMark: true
  };

  test("rejects with the core marker when the remote copy cannot be recovered either", async () => {
    // Confirmed missing on a physical iPhone/iPad: cache miss, App Group
    // resolves, the ciphertext is absent there too, and the forced remote
    // download cannot authenticate/promote a copy.
    fs.exists.mockResolvedValue(false);
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue("/appgroup");
    downloadFileMock.mockResolvedValue(false);

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(MISSING_LOCAL_CIPHERTEXT_ERROR);

    // Every applicable location must actually be probed before concluding it
    // is gone: cache dir, legacy cache dir, then the resolved App Group path.
    expect(fs.exists).toHaveBeenCalledWith(FILE_PATH);
    expect(fs.exists).toHaveBeenCalledWith(LEGACY_FILE_PATH);
    expect(fs.exists).toHaveBeenCalledWith(`/appgroup/${FILENAME}`);

    // Recovery was attempted with the exact force-remote mode (no verifyOnly:
    // the recovered ciphertext must be promoted, not merely checked).
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      RECOVERY_MODE
    );

    // Terminal marker: no upload attempt, no invented bytes, and crucially no
    // global error toast (core persists the marker and later syncs skip it).
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(checkUploadMock).not.toHaveBeenCalled();
    expect(getUploadedFileSizeMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("rejects with the core marker when the recovery download itself rejects", async () => {
    // A failure before downloadFile's own try block can still reject; even then
    // no global startup toast may surface and the marker is preserved.
    fs.exists.mockResolvedValue(false);
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue("/appgroup");
    downloadFileMock.mockRejectedValue(new Error("network down"));

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(MISSING_LOCAL_CIPHERTEXT_ERROR);

    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  test("resolves false quietly (transient) when the App Group container exists but its path is unresolved", async () => {
    // Absence is UNKNOWN here: the device has a container but pathForAppGroup
    // could not resolve it right now. Must not be recorded as terminal and must
    // not attempt recovery — the ciphertext may still be in the container.
    fs.exists.mockResolvedValue(false);
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue(null);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(checkUploadMock).not.toHaveBeenCalled();
    expect(getUploadedFileSizeMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  test("rejects with the core marker when there is no App Group container (Mac Catalyst) and recovery fails", async () => {
    // No container: the cache dir is the only possible local location, so after
    // a failed recovery the cache miss is a confirmed-missing terminal
    // condition. Recovery must still be attempted (Catalyst is an Apple
    // platform), but the App Group path must not be probed.
    fs.exists.mockResolvedValue(false);
    hasAppGroupContainerMock.mockReturnValue(false);
    downloadFileMock.mockResolvedValue(false);

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(MISSING_LOCAL_CIPHERTEXT_ERROR);

    expect(getAppGroupPathMock).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      RECOVERY_MODE
    );
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  test("recovers an authenticated remote copy on iOS without any PUT", async () => {
    // Cache + legacy + App Group all lack the file, but the server still holds
    // a pending copy: the forced remote download authenticates and promotes it.
    fs.exists.mockResolvedValue(false);
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue("/appgroup");
    downloadFileMock.mockResolvedValue(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    // Recovered: core marks the attachment uploaded, so no PUT/HEAD runs.
    expect(result).toBe(true);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      RECOVERY_MODE
    );
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(checkUploadMock).not.toHaveBeenCalled();
    expect(getUploadedFileSizeMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("recovers an authenticated remote copy on Mac Catalyst (no App Group container)", async () => {
    // Mac Catalyst has no App Group container, but it is an Apple platform: a
    // cache miss must still attempt recovery rather than declare the file gone.
    (Platform as unknown as { OS: string }).OS = "ios";
    fs.exists.mockResolvedValue(false);
    hasAppGroupContainerMock.mockReturnValue(false);
    downloadFileMock.mockResolvedValue(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    expect(getAppGroupPathMock).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      RECOVERY_MODE
    );
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("uses a separate cancel token for recovery and never clobbers the upload token", async () => {
    fs.exists.mockResolvedValue(false);
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue("/appgroup");
    downloadFileMock.mockResolvedValue(true);

    const cancelToken = makeCancelToken();
    const originalCancel = cancelToken.cancel;

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      cancelToken
    );

    expect(result).toBe(true);
    // downloadFile overwrites the 3rd-arg token's cancel; the caller's token
    // must be untouched, so the recovery call must receive a distinct object.
    const recoveryToken = downloadFileMock.mock.calls[0][2];
    expect(recoveryToken).not.toBe(cancelToken);
    expect(cancelToken.cancel).toBe(originalCancel);
  });

  test("preserves the generic failure (toast, resolve false) for Android when the cache lacks the file", async () => {
    // Android has no App Group; the cache miss must keep the pre-existing
    // non-terminal behavior instead of recording the iOS marker.
    (Platform as unknown as { OS: string }).OS = "android";
    hasAppGroupContainerMock.mockReturnValue(true);
    fs.exists.mockResolvedValue(false);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(getAppGroupPathMock).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  test("uploads from the App Group when the cache lacks the file but the App Group has it", async () => {
    const appGroupFile = `/appgroup/${FILENAME}`;
    fs.exists.mockImplementation(async (path: string) => path === appGroupFile);
    fs.stat.mockImplementation(async (path: string) => {
      if (path === appGroupFile)
        return { size: FILE_SIZE, path: appGroupFile, filename: FILENAME };
      if (path === PLAINTEXT_PATH)
        return { size: FILE_SIZE, path: PLAINTEXT_PATH, filename: FILENAME };
      throw new Error(`ENOENT: ${path}`);
    });
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue("/appgroup");

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    expect(uploadCreate).toHaveBeenCalledWith(
      expect.objectContaining({ path: `file://${appGroupFile}` })
    );
    expect(checkUploadMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions.chunkSize,
      FILE_SIZE
    );
    // The App Group copy is authenticated too: the cipher is addressed by the
    // exact filename and told to use the App Group container.
    const [, cipher, outputType] = sodium.decryptFile.mock.calls[0];
    expect(outputType).toBe("cache");
    expect(cipher).toMatchObject({
      hash: FILENAME,
      appGroupId: "group.example.appgroup"
    });
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("uploadFile legacy cache dir", () => {
  // Models the on-disk layout: the legacy copy is only moved away when
  // migrateFilesFromCache() succeeds, so `exists` is stateful across the
  // migration call.
  function mockLegacyOnlyFile(outcome: "migrated" | "failed") {
    let migrated = false;
    migrateFilesFromCacheMock.mockImplementation(async () => {
      migrated = true;
    });
    fs.exists.mockImplementation(async (path: string) => {
      if (path === LEGACY_FILE_PATH) return outcome === "failed" || !migrated;
      if (path === FILE_PATH) return outcome === "migrated" && migrated;
      return false;
    });
    fs.stat.mockImplementation(async (path: string) => {
      if (
        path === FILE_PATH ||
        path === LEGACY_FILE_PATH ||
        path === PLAINTEXT_PATH
      )
        return { size: FILE_SIZE, path, filename: FILENAME };
      throw new Error(`ENOENT: ${path}`);
    });
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue("/appgroup");
    return { hasMigrated: () => migrated };
  }

  test("migrates a legacy-only ciphertext into the cache dir and uploads the validated copy", async () => {
    const legacy = mockLegacyOnlyFile("migrated");

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    // The migration runs, then the upload happens from the cache-dir copy the
    // native cipher can actually authenticate (not from the legacy dir).
    expect(result).toBe(true);
    expect(legacy.hasMigrated()).toBe(true);
    expect(migrateFilesFromCacheMock).toHaveBeenCalledTimes(1);
    expect(uploadCreate).toHaveBeenCalledTimes(1);
    expect(uploadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customUploadId: FILENAME,
        method: "PUT",
        path: `file://${FILE_PATH}`
      })
    );
    expect(checkUploadMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions.chunkSize,
      FILE_SIZE
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);

    // Probe order: cache dir, then the legacy dir, then re-probe the cache dir
    // after the migration.
    expect(fs.exists).toHaveBeenNthCalledWith(1, FILE_PATH);
    expect(fs.exists).toHaveBeenNthCalledWith(2, LEGACY_FILE_PATH);
    expect(fs.exists).toHaveBeenNthCalledWith(3, FILE_PATH);
    // The App Group (which lacks the file) is never consulted.
    expect(getAppGroupPathMock).not.toHaveBeenCalled();
  });

  test("fails closed and preserves the legacy ciphertext when migration yields no cache-dir copy", async () => {
    const legacy = mockLegacyOnlyFile("failed");

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    // The migration was attempted but produced no usable copy: no PUT, no
    // recovery download, no toast, and the legacy file is left in place.
    expect(result).toBe(false);
    expect(legacy.hasMigrated()).toBe(true);
    expect(migrateFilesFromCacheMock).toHaveBeenCalledTimes(1);
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(bearerGuard).not.toHaveBeenCalled();
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(checkUploadMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);

    // The only local copy must survive the failed preflight.
    expect(fs.unlink).not.toHaveBeenCalledWith(LEGACY_FILE_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    // Absence is not the problem here (the legacy copy exists), so the App Group
    // is never treated as an authoritative location.
    expect(getAppGroupPathMock).not.toHaveBeenCalled();
  });
});

// The zero-byte recovery path — an authenticated remote repair followed by the
// Apple-only `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR` backoff marker — is
// Apple-specific. Android has no App Group container, no native cipher
// preflight and no authenticated remote repair, so a zero-byte file must take
// the generic pre-PUT failure path instead: never PUT, never download, never
// record the Apple marker, preserve the local bytes, and show the standard
// failure toast.
describe("uploadFile zero-byte ciphertext platform gating", () => {
  function mockZeroByteFile() {
    fs.stat.mockImplementation(async (path: string) => {
      if (path === FILE_PATH)
        return { size: 0, path: FILE_PATH, filename: FILENAME };
      if (path === PLAINTEXT_PATH)
        return { size: FILE_SIZE, path: PLAINTEXT_PATH, filename: FILENAME };
      throw new Error(`ENOENT: ${path}`);
    });
  }

  test("Android never PUTs a zero-byte ciphertext and takes the generic failure path", async () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockZeroByteFile();
    // If the Apple repair path ran, this `true` would short-circuit the upload
    // to success and nothing would be toasted.
    downloadFileMock.mockResolvedValue(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    // Generic failure: resolve `false` and surface the standard toast, exactly
    // like any other pre-PUT failure on Android. It must not reject with the
    // Apple-only `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR` marker (which would
    // instead surface as a rejection).
    expect(result).toBe(false);
    // No Apple authenticated repair download and no native preflight.
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(sodium.hashFile).not.toHaveBeenCalled();
    // The zero-byte file is never PUT (or multipart-uploaded).
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(bearerGuard).not.toHaveBeenCalled();
    expect(initiateMultipartRequestMock).not.toHaveBeenCalled();
    expect(checkUploadMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    // The zero-byte local bytes are preserved (no destructive cleanup) and the
    // progress entry is still cleared.
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });
});

// On Apple platforms the local ciphertext must be authenticated before it is
// PUT: a corrupted local file must never overwrite a valid remote object. The
// preflight loads the attachment row, decrypts its key and verifies the exact
// ciphertext with Sodium using the attachment's own IV/salt/chunkSize and
// filename, then requires the decrypted plaintext byte length and xxh64 hash to
// match. Every failure is silent and fails closed.
describe("uploadFile Apple ciphertext preflight", () => {
  test("authenticates the local ciphertext with the attachment key and parameters before the PUT", async () => {
    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);

    // The key is decrypted from the attachment row and passed to Sodium along
    // with the exact cipher shape download.ts uses.
    expect(decryptKeyMock).toHaveBeenCalledTimes(1);
    expect(sodium.decryptFile).toHaveBeenCalledTimes(1);
    const [key, cipher, outputType] = sodium.decryptFile.mock.calls[0];
    expect(key).toEqual(DECRYPTION_KEY);
    expect(outputType).toBe("cache");
    expect(cipher).toMatchObject({
      iv: "attachment-iv",
      salt: "attachment-salt",
      size: FILE_SIZE,
      hash: FILENAME,
      hashType: "xxh64",
      mime: "application/octet-stream",
      fileName: undefined,
      uri: undefined,
      chunkSize: ATTACHMENT_CHUNK_SIZE,
      appGroupId: "group.example.appgroup"
    });

    // Plaintext size and content hash are both authenticated.
    expect(fs.stat).toHaveBeenCalledWith(PLAINTEXT_PATH);
    expect(sodium.hashFile).toHaveBeenCalledWith({
      uri: PLAINTEXT_PATH,
      type: "url"
    });

    // Only after a successful preflight is the PUT dispatched.
    expect(uploadCreate).toHaveBeenCalledTimes(1);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
    expect(toastError).not.toHaveBeenCalled();

    // The decrypted plaintext artifact is removed; the ciphertext is never
    // touched.
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
  });

  test("repairs a zero-byte selected ciphertext from an authenticated remote copy without a PUT", async () => {
    // Raw-presence probe selects /cache/<hash>, but the native cipher treats a
    // zero-byte cache-dir file as missing and would fall back to a valid App
    // Group copy. That other copy must not be allowed to authenticate a PUT of
    // this zero-byte file, so the upload must never dispatch the preflight/PUT.
    // It instead repairs the local copy from an authenticated remote download.
    fs.exists.mockImplementation(async (path: string) => {
      return path === FILE_PATH || path === `/appgroup/${FILENAME}`;
    });
    fs.stat.mockImplementation(async (path: string) => {
      if (path === FILE_PATH)
        return { size: 0, path: FILE_PATH, filename: FILENAME };
      if (path === PLAINTEXT_PATH)
        return { size: FILE_SIZE, path: PLAINTEXT_PATH, filename: FILENAME };
      throw new Error(`ENOENT: ${path}`);
    });
    // The App Group copy *is* valid; without the guard the preflight would
    // authenticate it and the zero-byte cache-dir file would still be PUT.
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue("/appgroup");
    downloadFileMock.mockResolvedValue(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    // The zero-byte file is never authenticated (the preflight never runs) and
    // never PUT, but the attachment is repaired from the remote copy.
    expect(result).toBe(true);
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(sodium.hashFile).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(bearerGuard).not.toHaveBeenCalled();
    expect(checkUploadMock).not.toHaveBeenCalled();
    expect(initiateMultipartRequestMock).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      REPAIR_MODE
    );
    expect(toastError).not.toHaveBeenCalled();
    // The zero-byte local file is preserved (a failed repair never deletes it).
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("records the durable marker when a zero-byte ciphertext cannot be repaired", async () => {
    // A zero-byte local file whose remote copy cannot be authenticated: never
    // PUT, never delete the local bytes, and record the exists-independent
    // "repair failed" core marker so core backs off instead of re-downloading
    // on every sync.
    fs.exists.mockImplementation(async (path: string) => {
      return path === FILE_PATH || path === `/appgroup/${FILENAME}`;
    });
    fs.stat.mockImplementation(async (path: string) => {
      if (path === FILE_PATH)
        return { size: 0, path: FILE_PATH, filename: FILENAME };
      if (path === PLAINTEXT_PATH)
        return { size: FILE_SIZE, path: PLAINTEXT_PATH, filename: FILENAME };
      throw new Error(`ENOENT: ${path}`);
    });
    hasAppGroupContainerMock.mockReturnValue(true);
    getAppGroupPathMock.mockResolvedValue("/appgroup");
    downloadFileMock.mockResolvedValue(false);

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR);

    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      REPAIR_MODE
    );
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("never PUTs a same-size corrupted ciphertext; repairs it from the authenticated remote copy", async () => {
    // Decryption succeeds and the size matches, but the content is not this
    // attachment's content. A matching size alone must not be trusted.
    sodium.hashFile.mockResolvedValue("0000000000000000");
    downloadFileMock.mockResolvedValue(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    // The corrupt local bytes are never PUT; the remote copy repairs them.
    expect(result).toBe(true);
    expect(sodium.decryptFile).toHaveBeenCalledTimes(1);
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(bearerGuard).not.toHaveBeenCalled();
    expect(checkUploadMock).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      REPAIR_MODE
    );
    // Silent: no global startup toast.
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
    // The preflight cleanup still runs and the local ciphertext is preserved
    // (the repair owns replacing it, and never deletes it on failure).
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
  });

  test("fails closed with the repair-failed marker when a corrupted ciphertext cannot be repaired", async () => {
    sodium.hashFile.mockResolvedValue("0000000000000000");
    downloadFileMock.mockResolvedValue(false);

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR);

    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      REPAIR_MODE
    );
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    // The present-but-corrupt local bytes survive.
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("fails closed with the repair-failed marker when the ciphertext cannot be decrypted and recovery fails", async () => {
    sodium.decryptFile.mockRejectedValue(new Error("wrong key"));
    downloadFileMock.mockResolvedValue(false);

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR);

    expect(sodium.hashFile).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(bearerGuard).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
    // Even a nominal decrypt artifact is cleaned up, and the ciphertext is not.
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
  });

  test("fails closed with the repair-failed marker when the attachment key cannot be decrypted", async () => {
    decryptKeyMock.mockResolvedValue(null);
    downloadFileMock.mockResolvedValue(false);

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR);

    // Nothing can be authenticated without the key, so the ciphertext is never
    // even decrypted and no PUT is attempted.
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("fails closed with the repair-failed marker when the attachment row is missing", async () => {
    lookupAttachment.mockResolvedValue(undefined);
    downloadFileMock.mockResolvedValue(false);

    await expect(
      uploadFile(
        FILENAME,
        requestOptions as UploadRequestOptions,
        makeCancelToken()
      )
    ).rejects.toThrow(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR);

    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("never starts a multipart request for a corrupted ciphertext; repairs it instead", async () => {
    const MULTIPART_FILE_SIZE = 25 * 1024 * 1024;
    const { CloudUploader } = jest.requireMock(
      "react-native-nitro-cloud-uploader"
    ) as { CloudUploader: { startUpload: jest.Mock } };
    fs.stat.mockImplementation(async (path: string) => {
      if (path === FILE_PATH)
        return { size: MULTIPART_FILE_SIZE, path: FILE_PATH, filename: FILENAME };
      if (path === PLAINTEXT_PATH)
        return { size: FILE_SIZE, path: PLAINTEXT_PATH, filename: FILENAME };
      throw new Error(`ENOENT: ${path}`);
    });
    sodium.hashFile.mockResolvedValue("0000000000000000");
    downloadFileMock.mockResolvedValue(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    // No part of the multipart pipeline may run for a corrupt local file; the
    // authenticated remote copy is promoted to repair it.
    expect(result).toBe(true);
    expect(initiateMultipartRequestMock).not.toHaveBeenCalled();
    expect(CloudUploader.startUpload).not.toHaveBeenCalled();
    expect(completeMultipartRequestMock).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      REPAIR_MODE
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("does not run the preflight on Android", async () => {
    (Platform as unknown as { OS: string }).OS = "android";

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(sodium.hashFile).not.toHaveBeenCalled();
    expect(uploadCreate).toHaveBeenCalledTimes(1);
  });
});

// The upload path must not report success on the strength of a HEAD response.
// `checkUpload` only compares the remote Content-Length with the expected
// ciphertext size; a matching size (or ETag) does not prove the server holds
// this exact ciphertext. On iOS the remote object is re-downloaded and
// authenticated with the attachment's own key/IV/size/hash (then discarded)
// before `uploadFile` may resolve true.
describe("uploadFile authenticated remote verification", () => {
  const VERIFY_MODE = {
    forceRemote: true,
    verifyOnly: true,
    silent: true,
    skipFailureMark: true
  };

  test("re-downloads and authenticates the uploaded object before returning true", async () => {
    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    expect(checkUploadMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions.chunkSize,
      FILE_SIZE
    );
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      VERIFY_MODE
    );
    // The verification must happen after the (size-only) upload check, and only
    // its success may promote the upload to a success.
    expect(checkUploadMock.mock.invocationCallOrder[0]).toBeLessThan(
      downloadFileMock.mock.invocationCallOrder[0]
    );
  });

  test("returns false and keeps the attachment pending when verification fails", async () => {
    // The remote HEAD size matched (checkUpload passed), but the object could
    // not be authenticated: a matching HEAD size/ETag must not be accepted.
    downloadFileMock.mockResolvedValue(false);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(checkUploadMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    // No user-facing upload error toast: the attachment simply stays pending
    // (the local ciphertext is retained) and is retried on a later sync.
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("does not re-download for Android uploads", async () => {
    (Platform as unknown as { OS: string }).OS = "android";

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    expect(checkUploadMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).not.toHaveBeenCalled();
  });

  test("verifies multipart iOS uploads as well", async () => {
    const MULTIPART_FILE_SIZE = 25 * 1024 * 1024;
    fs.exists.mockImplementation(async (path: string) => path === FILE_PATH);
    fs.stat.mockResolvedValue({
      size: MULTIPART_FILE_SIZE,
      path: FILE_PATH,
      filename: FILENAME
    });
    lookupAttachment.mockImplementation(async () => ({
      id: "attachment-id",
      filename: FILENAME,
      hash: FILENAME,
      size: MULTIPART_FILE_SIZE,
      chunkSize: ATTACHMENT_CHUNK_SIZE,
      iv: "attachment-iv",
      salt: "attachment-salt",
      alg: "xcha-stream",
      hashType: "xxh64",
      mimeType: "application/octet-stream",
      key: { cipher: "encrypted-key", alg: "xchacha20" },
      dateUploaded: null
    }));
    const { CloudUploader } = jest.requireMock(
      "react-native-nitro-cloud-uploader"
    ) as { CloudUploader: { startUpload: jest.Mock } };
    CloudUploader.startUpload.mockResolvedValue({
      success: true,
      etags: ["etag-1", "etag-2", "etag-3"]
    });
    initiateMultipartRequestMock.mockResolvedValue({
      ok: true,
      json: async () => ({ uploadId: "upload-id", parts: ["p1", "p2", "p3"] })
    });
    completeMultipartRequestMock.mockResolvedValue({
      status: 200,
      text: async () => ""
    });

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    // The multipart path (not the single-part PUT) must have run...
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(completeMultipartRequestMock).toHaveBeenCalledTimes(1);
    expect(checkUploadMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions.chunkSize,
      MULTIPART_FILE_SIZE
    );
    // ...and it must be authenticated the same way.
    expect(downloadFileMock).toHaveBeenCalledWith(
      FILENAME,
      requestOptions,
      expect.anything(),
      VERIFY_MODE
    );
  });
});

// An explicit Apple reupload stages the old ciphertext away and rewrites the
// real `<hash>`; a concurrent sync must not PUT a half-staged ciphertext. The
// upload is deferred (fail closed), and any leftover backup is reconciled
// before the local ciphertext is probed.
describe("uploadFile reupload coordination", () => {
  test("defers without any PUT while an explicit reupload of the same hash is in flight", async () => {
    isReuploadInFlightMock.mockReturnValueOnce(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(uploadCreate).not.toHaveBeenCalled();
    // The short-circuit happens before any filesystem probe, so the staged
    // ciphertext is never read.
    expect(fs.exists).not.toHaveBeenCalled();
    expect(reconcileReuploadBackupMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("reconciles a leftover reupload backup before probing the local ciphertext", async () => {
    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    expect(reconcileReuploadBackupMock).toHaveBeenCalledWith(FILENAME);
    expect(
      reconcileReuploadBackupMock.mock.invocationCallOrder[0]
    ).toBeLessThan(fs.exists.mock.invocationCallOrder[0]);
  });
});

describe("uploadFile local ciphertext repair failed marker", () => {
  test("repairs a present-but-invalid ciphertext without recording the marker", async () => {
    // The preflight fails (hash mismatch) but the authenticated remote copy is
    // promoted: success records no marker, dispatches no PUT and keeps no toast.
    sodium.hashFile.mockResolvedValue("0000000000000000");
    downloadFileMock.mockResolvedValue(true);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("defers instead of recording the marker when a reupload starts during a zero-byte repair", async () => {
    // The entry guard sees no reupload, but one starts while the network-bound
    // repair runs. download.ts collapses that transient "deferred" outcome into
    // `false`, so the post-repair re-check must keep it transient: no durable
    // marker, no toast, local bytes kept.
    isReuploadInFlightMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    fs.stat.mockImplementation(async (path: string) => {
      if (path === FILE_PATH)
        return { size: 0, path: FILE_PATH, filename: FILENAME };
      if (path === PLAINTEXT_PATH)
        return { size: FILE_SIZE, path: PLAINTEXT_PATH, filename: FILENAME };
      throw new Error(`ENOENT: ${path}`);
    });
    downloadFileMock.mockResolvedValue(false);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });

  test("defers instead of recording the marker when a reupload starts during a preflight repair", async () => {
    isReuploadInFlightMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    sodium.hashFile.mockResolvedValue("0000000000000000");
    downloadFileMock.mockResolvedValue(false);

    const result = await uploadFile(
      FILENAME,
      requestOptions as UploadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(uploadCreate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(FILE_PATH);
    expect(removeAttachment).toHaveBeenCalledWith(FILENAME);
  });
});
