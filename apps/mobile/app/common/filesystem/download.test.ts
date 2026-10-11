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

// `downloadFile` must not discard the only local copy of a pending
// attachment's ciphertext. `io.exists()` treats a size-mismatched local file as
// absent (it is a partially-written ciphertext), so the download path must
// consult the raw filesystem before deciding a pending attachment is safe to
// re-download. When a raw local ciphertext exists, the download must bail out
// *before* touching the network, and the catch cleanup must never unlink the
// original path for an attachment the server has never received. Conversely, a
// pending attachment with no local ciphertext at all (synced from another
// device) must still fall through to the remote size check so it can be
// recovered.
//
// The same rule applies after a successful transfer: before promoting the temp
// download over the original path, the raw filesystem must be consulted, and a
// present original must be preserved (only the temp file discarded) because
// there is no authenticated verification of the downloaded temp file. The catch
// cleanup must only ever remove the temp download and must never unlink the
// original path - not from `dateUploaded`, and not from a bare existence probe.

export {};

jest.mock(
  "./utils",
  () => ({
    ABYTES: 17,
    cacheDir: "/cache",
    getRandomId: jest.fn(),
    getUploadedFileSize: jest.fn(async () => -1),
    isSuccessStatusCode: (status: number) => status >= 200 && status <= 299,
    parseS3Error: jest.fn()
  }),
  { virtual: true }
);

jest.mock(
  "./io",
  () => ({
    createCacheDir: jest.fn(async () => {}),
    exists: jest.fn(async () => false),
    getCachePathForFile: jest.fn(
      async (filename: string) => `/cache/${filename}`
    ),
    // Apple-only repair helpers. Defaults keep the pre-existing behavior: no
    // reupload in flight and the canonical local file is *not* valid (so the
    // repair promotion quarantines it). Tests override per scenario.
    isReuploadInFlight: jest.fn(() => false),
    isLocalCiphertextValidForRow: jest.fn(async () => false),
    REPAIR_QUARANTINE_SUFFIX: "_repair_quarantine"
  }),
  { virtual: true }
);

jest.mock(
  "react-native",
  () => ({
    Platform: {
      OS: "ios",
      select: (spec: Record<string, unknown>) => spec.default
    }
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
        markAsFailed: jest.fn(async () => {}),
        decryptKey: jest.fn(async () => ({ key: "decryption-key" }))
      },
      tokenManager: {
        getAccessToken: jest.fn(async () => "file-token")
      }
    }
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
  "../../utils/constants",
  () => ({
    getAppGroupIdForNative: jest.fn(() => undefined)
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
  "../../stores/use-attachment-store",
  () => ({
    useAttachmentStore: {
      getState: jest.fn()
    }
  }),
  { virtual: true }
);

jest.mock(
  "react-native-blob-util",
  () => ({
    __esModule: true,
    default: {
      fs: {
        exists: jest.fn(async () => false),
        unlink: jest.fn(async () => {}),
        mv: jest.fn(async () => {}),
        stat: jest.fn()
      },
      config: jest.fn(),
      fetch: jest.fn()
    }
  }),
  { virtual: true }
);

jest.mock(
  "@notesnook/core",
  () => ({
    assertBearerDestination: jest.fn(),
    hosts: { API_HOST: "https://api.example" }
  }),
  { virtual: true }
);

jest.mock(
  "@notesnook/intl",
  () => ({
    strings: {
      fileVerificationFailed: () => "file verification failed",
      fileLengthError: () => "file length is 0",
      fileLengthMismatch: () => "file length mismatch",
      failedToResolvedDownloadUrl: () => "failed to resolve download url",
      downloadError: (message: string) => `download error: ${message}`
    }
  }),
  { virtual: true }
);

jest.mock(
  "@react-native-community/netinfo",
  () => ({ __esModule: true, default: { fetch: jest.fn() } }),
  { virtual: true }
);

import RNFetchBlob from "react-native-blob-util";
import Sodium from "@ammarahmed/react-native-sodium";
import NetInfo from "@react-native-community/netinfo";
import { Platform } from "react-native";
import { useAttachmentStore } from "../../stores/use-attachment-store";
import { ToastManager } from "../../services/event-manager";
import { DatabaseLogger, db } from "../database";
import {
  REPAIR_QUARANTINE_SUFFIX,
  exists,
  getCachePathForFile,
  isLocalCiphertextValidForRow,
  isReuploadInFlight
} from "./io";
import { getRandomId, getUploadedFileSize } from "./utils";
import { checkAttachment, downloadFile } from "./download";

const fs = RNFetchBlob.fs as unknown as {
  exists: jest.Mock;
  unlink: jest.Mock;
  mv: jest.Mock;
  stat: jest.Mock;
};
const lookupAttachment = db.attachments.attachment as unknown as jest.Mock;
const decryptKeyMock = db.attachments.decryptKey as unknown as jest.Mock;
const markAsFailedMock = db.attachments.markAsFailed as unknown as jest.Mock;
const getUploadedFileSizeMock = getUploadedFileSize as unknown as jest.Mock;
const ioExists = exists as unknown as jest.Mock;
const getCachePathForFileMock = getCachePathForFile as unknown as jest.Mock;
const isLocalCiphertextValidForRowMock =
  isLocalCiphertextValidForRow as unknown as jest.Mock;
const isReuploadInFlightMock = isReuploadInFlight as unknown as jest.Mock;
const platform = Platform as unknown as { OS: string };
const toastShow = ToastManager.show as unknown as jest.Mock;
const configMock = (RNFetchBlob as unknown as { config: jest.Mock }).config;
const sodium = Sodium as unknown as {
  decryptFile: jest.Mock;
  hashFile: jest.Mock;
};
const getAccessTokenMock = db.tokenManager.getAccessToken as unknown as jest.Mock;
const netInfoFetch = NetInfo.fetch as unknown as jest.Mock;
const getRandomIdMock = getRandomId as unknown as jest.Mock;

const FILENAME = "3f9a1c0b7d2e4f56";
const ORIGINAL_PATH = `/cache/${FILENAME}`;
// `download.ts` builds each invocation's temp ciphertext name from
// `getRandomId`; the mock below returns this suffix so every temp path here is
// deterministic while still exercising the real unique-name plumbing.
const RANDOM_SUFFIX = "fixed";
// Protected quarantine target used by the Apple-only repair promotion. Each
// repair uses its own unique name: `<hash>_<random>_repair_quarantine`, where
// `<random>` comes from `getRandomId("")` (RANDOM_SUFFIX below) and the name
// still ends in REPAIR_QUARANTINE_SUFFIX, so io.ts keeps protecting it.
const QUARANTINE_PATH = `${ORIGINAL_PATH}_${RANDOM_SUFFIX}${REPAIR_QUARANTINE_SUFFIX}`;
// A quarantine left by an *earlier* repair (here the fixed, pre-unique-name
// path that an older build or the first repair draft would have written). It
// must never be overwritten, unlinked or used as a move source/destination by a
// later repair.
const LEGACY_QUARANTINE_PATH = `${ORIGINAL_PATH}${REPAIR_QUARANTINE_SUFFIX}`;
// Basename handed to Sodium.decryptFile as `hash` (must equal the temp
// ciphertext's basename, no directory component) and the temp ciphertext path.
const TEMP_HASH = `${FILENAME}_${RANDOM_SUFFIX}_temp`;
const TEMP_PATH = `/cache/${TEMP_HASH}`;
// Sodium.decryptFile(..., "cache") output for `${TEMP_HASH}`.
const PLAINTEXT_TEMP_PATH = `${TEMP_PATH}_dcache`;
const FILE_SIZE = 1024;
// Must match the mocked `./utils` export used by `download.ts`.
const ABYTES = 17;

const removeAttachment = jest.fn();
const setProgress = jest.fn();
const fetchMock = jest.fn();

const requestOptions = {
  url: "https://api.veyran.northcore.space/s3?name=" + FILENAME,
  headers: { Authorization: "Bearer file-token" },
  chunkSize: 1024 * 1024
};

type DownloadRequestOptions = Parameters<typeof downloadFile>[1];
type DownloadCancelToken = Parameters<typeof downloadFile>[2];

function makeCancelToken(): DownloadCancelToken {
  return { cancel: jest.fn(async () => {}) };
}

const DECRYPTION_KEY = { key: "decryption-key" };

function mockAttachment(dateUploaded: number | null) {
  lookupAttachment.mockImplementation(async () => ({
    id: "attachment-id",
    filename: FILENAME,
    hash: FILENAME,
    size: FILE_SIZE,
    chunkSize: 1024 * 1024,
    iv: "attachment-iv",
    salt: "attachment-salt",
    alg: "xcha-stream",
    hashType: "xxh64",
    mimeType: "application/octet-stream",
    key: { cipher: "encrypted-key", alg: "xchacha20" },
    dateUploaded
  }));
}

function mockPendingAttachment() {
  mockAttachment(null);
}

// Remote side of the transfer only: a remote size that decrypts to
// `attachment.size` (totalChunks = ceil((FILE_SIZE + ABYTES) /
// (chunkSize + ABYTES)) = 1, so decryptedLength = FILE_SIZE and the length
// guard passes), a resolvable download url and a completed transfer response.
function mockTransfer(status = 200) {
  getUploadedFileSizeMock.mockResolvedValue(FILE_SIZE + ABYTES);
  fetchMock.mockResolvedValue({
    ok: true,
    text: async () => `https://cdn.example/${FILENAME}`
  });

  const response = {
    info: () => ({ headers: {}, status }),
    text: async () => ""
  };
  configMock.mockReturnValue({
    fetch: jest.fn(() => ({ progress: jest.fn(async () => response) }))
  });
  return response;
}

// Drives the download past every guard so the promotion block is reached:
// an uploaded attachment (skips the pending ciphertext guard), a remote size
// that decrypts to `attachment.size`, a resolvable download url and a completed
// transfer response.
function mockUploadedDownload(status = 200) {
  mockAttachment(Date.now());
  return mockTransfer(status);
}

beforeEach(() => {
  jest.clearAllMocks();
  configMock.mockReset();

  (globalThis as unknown as { fetch?: jest.Mock }).fetch = fetchMock;

  ioExists.mockResolvedValue(false);
  getCachePathForFileMock.mockImplementation(
    async (filename: string) => `/cache/${filename}`
  );
  platform.OS = "ios";
  isReuploadInFlightMock.mockReset();
  isReuploadInFlightMock.mockReturnValue(false);
  isLocalCiphertextValidForRowMock.mockReset();
  isLocalCiphertextValidForRowMock.mockResolvedValue(false);
  fs.exists.mockResolvedValue(false);
  fs.unlink.mockResolvedValue(undefined);
  fs.mv.mockResolvedValue(undefined);

  getUploadedFileSizeMock.mockResolvedValue(-1);

  // Deterministic per-invocation temp name: `download.ts` asks `getRandomId`
  // for `${filename}_<random>`; returning a constant keeps the temp paths
  // predictable. The concurrency test overrides this with distinct values.
  getRandomIdMock.mockReset();
  getRandomIdMock.mockImplementation((prefix: string) => `${prefix}${RANDOM_SUFFIX}`);

  // Successful verification by default: the temp ciphertext decrypts to a
  // plaintext of the expected size whose hash matches the attachment. Tests
  // that exercise tampering override one of these. Mirror Sodium: the plaintext
  // path is derived from the ciphertext hash (`<hash>_dcache`) so the temp
  // stat/hash/unlink assertions track whatever unique name was generated.
  decryptKeyMock.mockResolvedValue(DECRYPTION_KEY);
  sodium.decryptFile.mockImplementation((_key: unknown, cipher: { hash: string }) =>
    Promise.resolve(`/cache/${cipher.hash}_dcache`)
  );
  sodium.hashFile.mockResolvedValue(FILENAME);
  fs.stat.mockResolvedValue({ size: FILE_SIZE });

  (useAttachmentStore.getState as jest.Mock).mockReturnValue({
    remove: removeAttachment,
    setProgress
  });

  // Online by default; the offline check overrides this.
  netInfoFetch.mockResolvedValue({ isConnected: true, isInternetReachable: true });
  getAccessTokenMock.mockResolvedValue("file-token");
});

describe("downloadFile pending ciphertext safety", () => {
  test("keeps a raw local ciphertext and never hits the network for a pending attachment", async () => {
    // A pending attachment whose local ciphertext has the wrong size on disk:
    // io.exists() reports false, but the raw file is present and is the only
    // copy of the ciphertext.
    mockPendingAttachment();
    fs.exists.mockImplementation(
      async (path: string) => path === ORIGINAL_PATH
    );

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);

    // The raw filesystem check must consult the exact cache path.
    expect(getCachePathForFileMock).toHaveBeenCalledWith(FILENAME);
    expect(fs.exists).toHaveBeenCalledWith(ORIGINAL_PATH);

    // No remote size check and no network request may be made while a local
    // ciphertext exists for a not-yet-uploaded attachment.
    expect(getUploadedFileSizeMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // The local ciphertext must never be unlinked (not the original path, and
    // in this early-return path nothing at all is unlinked).
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);

    // The early return is a success guard, not a failure: it must not surface
    // an error toast or log a download failure.
    expect(toastShow).not.toHaveBeenCalled();
    expect(DatabaseLogger.error).not.toHaveBeenCalled();
  });

  test("attempts the remote size check when a pending attachment has no local ciphertext", async () => {
    // Synced from another device: the server has the ciphertext but nothing is
    // on this device, so the download must proceed to the remote size check.
    mockPendingAttachment();
    fs.exists.mockResolvedValue(false);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);

    // Remote size / network path must be attempted for cross-device recovery.
    expect(getUploadedFileSizeMock).toHaveBeenCalledTimes(1);
    expect(getUploadedFileSizeMock).toHaveBeenCalledWith(FILENAME);

    // The (absent) original path must not be unlinked; only the temp file.
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
  });

  test("never unlinks the original path on failure, even for an uploaded attachment", async () => {
    // `dateUploaded` must never be treated as permission to delete a local
    // ciphertext: the original path may be the only recoverable copy. A failed
    // download may only clean up the temp file.
    lookupAttachment.mockImplementation(async () => ({
      id: "attachment-id",
      filename: FILENAME,
      size: FILE_SIZE,
      chunkSize: 1024 * 1024,
      dateUploaded: new Date()
    }));
    fs.exists.mockResolvedValue(false);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(getUploadedFileSizeMock).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });
});

describe("downloadFile promotion safety", () => {
  test("preserves an existing original and discards only the temp download", async () => {
    mockUploadedDownload();
    // The initial io.exists() check rejects a size-mismatched local file, but
    // the raw path still holds that (only) local ciphertext.
    fs.exists.mockImplementation(
      async (path: string) => path === ORIGINAL_PATH
    );

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    // Promotion must consult the raw filesystem, not io.exists().
    expect(fs.exists).toHaveBeenCalledWith(ORIGINAL_PATH);

    // The existing original must not be overwritten and must not be unlinked.
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);

    // The preserved file is still size-mismatched to io.exists(), so the
    // download is honestly reported as failed rather than as a success.
    expect(result).toBe(false);
  });

  test("moves the temp download into place when no original exists", async () => {
    mockUploadedDownload();
    // io.exists() reports false before the download (no local ciphertext) and
    // true afterwards (the promoted file is valid).
    ioExists.mockResolvedValue(true);
    ioExists.mockResolvedValueOnce(false);
    fs.exists.mockResolvedValue(false);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);
    expect(fs.mv).toHaveBeenCalledTimes(1);
    expect(fs.mv).toHaveBeenCalledWith(TEMP_PATH, ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });
});

describe("downloadFile authenticated verification before promotion", () => {
  function mockNoOriginal() {
    // No local original, so a successful verification is promoted by mv().
    fs.exists.mockResolvedValue(false);
    ioExists.mockResolvedValue(true);
    ioExists.mockResolvedValueOnce(false);
  }

  test("decrypts and hashes the temp ciphertext before promoting it", async () => {
    mockUploadedDownload();
    mockNoOriginal();

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(true);

    // The temp ciphertext (not the original) must be decrypted with the
    // attachment's own key and parameters, into the cache.
    expect(decryptKeyMock).toHaveBeenCalledTimes(1);
    expect(sodium.decryptFile).toHaveBeenCalledTimes(1);
    const [key, cipher, outputType] = sodium.decryptFile.mock.calls[0];
    expect(key).toEqual(DECRYPTION_KEY);
    expect(outputType).toBe("cache");
    expect(cipher).toMatchObject({
      hash: TEMP_HASH,
      iv: "attachment-iv",
      salt: "attachment-salt",
      chunkSize: 1024 * 1024,
      size: FILE_SIZE,
      hashType: "xxh64"
    });

    // The plaintext size and content hash must both be checked.
    expect(fs.stat).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
    expect(sodium.hashFile).toHaveBeenCalledWith({
      uri: PLAINTEXT_TEMP_PATH,
      type: "url"
    });

    // Only after a successful verification is the temp file promoted.
    expect(fs.mv).toHaveBeenCalledWith(TEMP_PATH, ORIGINAL_PATH);

    // The decrypted plaintext is always removed again.
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
  });

  test("rejects a tampered download whose plaintext hash does not match", async () => {
    mockUploadedDownload();
    mockNoOriginal();
    // Decryption succeeds but the content is not the attachment's content.
    sodium.hashFile.mockResolvedValue("0000000000000000");

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    // A hash mismatch is never promoted over the original path.
    expect(fs.mv).not.toHaveBeenCalled();
    // Both the temp ciphertext and the decrypted plaintext are cleaned up.
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(markAsFailedMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a truncated download whose plaintext size does not match", async () => {
    mockUploadedDownload();
    mockNoOriginal();
    fs.stat.mockResolvedValue({ size: FILE_SIZE - 1 });

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
    expect(markAsFailedMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a download that cannot be decrypted", async () => {
    mockUploadedDownload();
    mockNoOriginal();
    sodium.decryptFile.mockRejectedValue(new Error("wrong key"));

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    // Even when decryptFile rejects, the (nominal) plaintext temp is removed.
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });

  test("fails closed when the attachment key cannot be decrypted", async () => {
    mockUploadedDownload();
    mockNoOriginal();
    decryptKeyMock.mockResolvedValue(null);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    // Nothing can be verified without the key, so the temp file is not
    // promoted and is not even decrypted.
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });

  test("refuses to promote a non-2xx response", async () => {
    mockUploadedDownload(403);
    mockNoOriginal();

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    // A non-2xx status must short-circuit before any verification or promotion.
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });
});

describe("downloadFile forceRemote", () => {
  test("re-downloads the remote copy even when a size-valid local file exists", async () => {
    mockUploadedDownload();
    // A size-valid local ciphertext is already present, so the default mode
    // would return true without touching the network.
    ioExists.mockResolvedValue(true);
    fs.exists.mockResolvedValue(false);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true }
    );

    expect(result).toBe(true);
    // The local existence short-circuit must be bypassed.
    expect(getUploadedFileSizeMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(configMock).toHaveBeenCalledTimes(1);
    // The freshly downloaded (and authenticated) temp is still promoted.
    expect(fs.mv).toHaveBeenCalledWith(TEMP_PATH, ORIGINAL_PATH);
  });

  test("re-downloads even though a pending attachment has a raw local ciphertext", async () => {
    mockPendingAttachment();
    mockTransfer();
    // Raw local ciphertext present: without forceRemote the pending guard
    // returns false before any network call.
    fs.exists.mockImplementation(
      async (path: string) => path === ORIGINAL_PATH
    );
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true }
    );

    expect(result).toBe(true);
    // The pending-ciphertext guard must be bypassed and the remote copy
    // actually fetched.
    expect(getUploadedFileSizeMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The existing local ciphertext is preserved; only the temp is discarded.
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });
});

describe("downloadFile repairInvalidLocal (Apple authenticated repair)", () => {
  const REPAIR_MODE = { forceRemote: true, repairInvalidLocal: true };

  // A raw local ciphertext is present at the canonical path (even a zero-byte
  // stub): the default promotion would preserve it and discard the verified
  // remote temp. The repair path must authenticate it and, when it is invalid,
  // quarantine it before promoting.
  function mockRawLocalPresent() {
    fs.exists.mockImplementation(
      async (path: string) => path === ORIGINAL_PATH
    );
  }

  test("quarantines an invalid local ciphertext and promotes the verified remote copy", async () => {
    mockUploadedDownload();
    mockRawLocalPresent();
    isLocalCiphertextValidForRowMock.mockResolvedValue(false);
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(true);

    // The invalid local bytes are preserved in the protected quarantine, and
    // the authenticated temp is promoted. Quarantine strictly precedes the
    // promotion (NSFileManager mv does not overwrite, so the canonical path
    // must be vacated first).
    expect(isLocalCiphertextValidForRowMock).toHaveBeenCalledWith(
      FILENAME,
      expect.anything()
    );
    expect(fs.mv).toHaveBeenCalledWith(ORIGINAL_PATH, QUARANTINE_PATH);
    expect(fs.mv).toHaveBeenCalledWith(TEMP_PATH, ORIGINAL_PATH);
    expect(fs.mv.mock.invocationCallOrder[0]).toBeLessThan(
      fs.mv.mock.invocationCallOrder[1]
    );

    // Neither the old bytes nor the quarantine may be unlinked, and the temp
    // was moved (not discarded).
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(TEMP_PATH);
  });

  test("never touches a valid local ciphertext", async () => {
    mockUploadedDownload();
    mockRawLocalPresent();
    isLocalCiphertextValidForRowMock.mockResolvedValue(true);
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(true);
    // A valid local copy is the attachment's only local content: it is never
    // moved, overwritten, quarantined or unlinked. Only the temp is discarded.
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
  });

  test("defers without touching the local ciphertext while a reupload is in flight", async () => {
    mockUploadedDownload();
    mockRawLocalPresent();
    isReuploadInFlightMock.mockReturnValue(true);
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(false);
    expect(isReuploadInFlightMock).toHaveBeenCalledWith(FILENAME);
    // The reupload owns the local ciphertext: the validity probe is never even
    // reached, nothing is moved and the local bytes are preserved.
    expect(isLocalCiphertextValidForRowMock).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
  });

  test("defers an absent original while a reupload is in flight instead of promoting into its staging window", async () => {
    // A concurrent explicit reupload has already moved the canonical ciphertext
    // to its backup, so the path legitimately looks absent. The authenticated
    // *remote old* ciphertext must not be promoted into that window: the
    // in-flight guard must run before the "no original" promotion branch.
    mockUploadedDownload();
    fs.exists.mockResolvedValue(false);
    isReuploadInFlightMock.mockReturnValue(true);
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(false);
    expect(isReuploadInFlightMock).toHaveBeenCalledWith(FILENAME);
    // The validity probe is never reached, nothing is moved (in particular the
    // verified temp is not promoted to the canonical path) and only the temp is
    // discarded.
    expect(isLocalCiphertextValidForRowMock).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });

  test("defers without quarantining or promoting when the attachment row changes mid-download", async () => {
    // A concurrent explicit reupload commits new crypto metadata (a fresh
    // key/iv/salt, as `generateKey`/`Sodium.encryptFile` produce) for this hash
    // while the network-bound repair download is in flight. By promotion time
    // `isReuploadInFlight` is false again, so the row re-read is the only guard
    // left. The canonical path now holds the reupload's fresh ciphertext, which
    // must not be quarantined, and the remote object authenticated against the
    // stale row must not be promoted over it.
    mockUploadedDownload();
    mockRawLocalPresent();
    ioExists.mockResolvedValue(true);
    isReuploadInFlightMock.mockReturnValue(false);

    const staleRow = {
      id: "attachment-id",
      filename: FILENAME,
      hash: FILENAME,
      size: FILE_SIZE,
      chunkSize: 1024 * 1024,
      iv: "attachment-iv",
      salt: "attachment-salt",
      alg: "xcha-stream",
      hashType: "xxh64",
      mimeType: "application/octet-stream",
      key: { cipher: "encrypted-key", alg: "xchacha20" },
      dateUploaded: Date.now()
    };
    let reads = 0;
    lookupAttachment.mockImplementation(async () => {
      reads++;
      // First read: the snapshot the remote temp is authenticated against.
      // Second read (the promotion re-check): the reupload's committed new row.
      return reads === 1
        ? staleRow
        : { ...staleRow, iv: "reuploaded-iv", salt: "reuploaded-salt" };
    });

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(false);
    // Read once at the start, re-read before the promotion decision.
    expect(lookupAttachment).toHaveBeenCalledTimes(2);
    // Nothing may be moved: the fresh reupload ciphertext is preserved and the
    // stale-row verified temp is never promoted. The local-validity probe is
    // not even reached.
    expect(fs.mv).not.toHaveBeenCalled();
    expect(isLocalCiphertextValidForRowMock).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
  });

  test("defers without moving anything when the attachment row disappears mid-download", async () => {
    // The attachment was deleted (or its row removed by sync) during the
    // download. Promoting the remote object authenticated against the vanished
    // row would install bytes with no authoritative metadata, so the repair
    // fails closed.
    mockUploadedDownload();
    mockRawLocalPresent();
    ioExists.mockResolvedValue(true);

    const staleRow = {
      id: "attachment-id",
      filename: FILENAME,
      hash: FILENAME,
      size: FILE_SIZE,
      chunkSize: 1024 * 1024,
      iv: "attachment-iv",
      salt: "attachment-salt",
      alg: "xcha-stream",
      hashType: "xxh64",
      mimeType: "application/octet-stream",
      key: { cipher: "encrypted-key", alg: "xchacha20" },
      dateUploaded: Date.now()
    };
    let reads = 0;
    lookupAttachment.mockImplementation(async () =>
      ++reads === 1 ? staleRow : undefined
    );

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(false);
    expect(lookupAttachment).toHaveBeenCalledTimes(2);
    expect(fs.mv).not.toHaveBeenCalled();
    expect(isLocalCiphertextValidForRowMock).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
  });

  test("promotes the verified remote copy when the original is genuinely absent", async () => {
    // No raw local ciphertext at all and no reupload in flight: the ordinary
    // repair case that must still promote.
    mockUploadedDownload();
    fs.exists.mockResolvedValue(false);
    isReuploadInFlightMock.mockReturnValue(false);
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(true);
    expect(isReuploadInFlightMock).toHaveBeenCalledWith(FILENAME);
    expect(fs.mv).toHaveBeenCalledTimes(1);
    expect(fs.mv).toHaveBeenCalledWith(TEMP_PATH, ORIGINAL_PATH);
    // The verified temp was moved (not discarded) and the canonical path was
    // never unlinked.
    expect(fs.unlink).not.toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });

  test("never deletes or overwrites a quarantine left by an earlier repair", async () => {
    mockUploadedDownload();
    // Canonical present but invalid, and an earlier repair's quarantine is
    // already on disk. This repair must use its own unique name and leave the
    // older quarantine completely alone.
    fs.exists.mockImplementation(
      async (path: string) =>
        path === ORIGINAL_PATH || path === LEGACY_QUARANTINE_PATH
    );
    isLocalCiphertextValidForRowMock.mockResolvedValue(false);
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(true);
    // The new quarantine name is unique and distinct from the earlier one.
    expect(QUARANTINE_PATH).not.toBe(LEGACY_QUARANTINE_PATH);
    expect(fs.mv).toHaveBeenCalledWith(ORIGINAL_PATH, QUARANTINE_PATH);
    expect(fs.mv).toHaveBeenCalledWith(TEMP_PATH, ORIGINAL_PATH);
    // The earlier quarantine is never unlinked, overwritten, or used as a move
    // source/destination.
    expect(fs.unlink).not.toHaveBeenCalledWith(LEGACY_QUARANTINE_PATH);
    expect(fs.mv).not.toHaveBeenCalledWith(
      LEGACY_QUARANTINE_PATH,
      expect.anything()
    );
    expect(fs.mv).not.toHaveBeenCalledWith(
      expect.anything(),
      LEGACY_QUARANTINE_PATH
    );
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
  });

  test("never quarantines or promotes when the remote copy fails authentication", async () => {
    mockUploadedDownload();
    mockRawLocalPresent();
    ioExists.mockResolvedValue(true);
    // The remote temp decrypts but is not the attachment's content.
    sodium.hashFile.mockResolvedValue("0000000000000000");

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(false);
    // An unverified remote copy is never promoted, so the repair step is never
    // reached and the local bytes are untouched.
    expect(isLocalCiphertextValidForRowMock).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(markAsFailedMock).toHaveBeenCalledTimes(1);
  });

  test("preserves the local bytes when the quarantine move fails", async () => {
    mockUploadedDownload();
    mockRawLocalPresent();
    isLocalCiphertextValidForRowMock.mockResolvedValue(false);
    ioExists.mockResolvedValue(true);
    fs.mv.mockImplementation(async (src: string) => {
      if (src === ORIGINAL_PATH) throw new Error("quarantine failed");
    });

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(false);
    expect(fs.mv).toHaveBeenCalledWith(ORIGINAL_PATH, QUARANTINE_PATH);
    // Nothing is promoted over the still-present invalid original, the original
    // is never unlinked, and only the temp is discarded.
    expect(fs.mv).not.toHaveBeenCalledWith(TEMP_PATH, ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
  });

  test("restores the old bytes when promotion fails after quarantine", async () => {
    mockUploadedDownload();
    mockRawLocalPresent();
    isLocalCiphertextValidForRowMock.mockResolvedValue(false);
    ioExists.mockResolvedValue(true);
    fs.mv.mockImplementation(async (src: string) => {
      if (src === TEMP_PATH) throw new Error("promotion failed");
    });

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(false);
    // Quarantined, then the promotion failed, then the old bytes were restored
    // so the disk state matches the pre-repair state.
    expect(fs.mv).toHaveBeenCalledWith(ORIGINAL_PATH, QUARANTINE_PATH);
    expect(fs.mv).toHaveBeenCalledWith(TEMP_PATH, ORIGINAL_PATH);
    expect(fs.mv).toHaveBeenCalledWith(QUARANTINE_PATH, ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
  });

  test("is ignored on Android, keeping the default preserve-and-discard behavior", async () => {
    platform.OS = "android";
    mockUploadedDownload();
    mockRawLocalPresent();
    ioExists.mockResolvedValue(false);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      REPAIR_MODE
    );

    expect(result).toBe(false);
    // The repair helpers are never consulted on Android.
    expect(isLocalCiphertextValidForRowMock).not.toHaveBeenCalled();
    expect(isReuploadInFlightMock).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
  });

  test("never runs when verifyOnly is set, so File Check stays non-destructive", async () => {
    mockUploadedDownload();
    mockRawLocalPresent();
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true, repairInvalidLocal: true }
    );

    expect(result).toBe(true);
    expect(isLocalCiphertextValidForRowMock).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).not.toHaveBeenCalledWith(QUARANTINE_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
  });
});

describe("downloadFile verifyOnly", () => {
  test("authenticates the temp ciphertext then discards it without promoting anything", async () => {
    mockUploadedDownload();
    fs.exists.mockResolvedValue(false);
    // No size-valid local original: the default path would demand a promoted
    // file at the end. verifyOnly must succeed without one.
    ioExists.mockResolvedValue(false);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true }
    );

    expect(result).toBe(true);

    // The remote temp ciphertext is decrypted with the attachment's own key
    // and parameters.
    const [key, cipher, outputType] = sodium.decryptFile.mock.calls[0];
    expect(key).toEqual(DECRYPTION_KEY);
    expect(outputType).toBe("cache");
    expect(cipher).toMatchObject({
      hash: TEMP_HASH,
      iv: "attachment-iv",
      salt: "attachment-salt",
      chunkSize: 1024 * 1024,
      size: FILE_SIZE,
      hashType: "xxh64"
    });

    // Plaintext size and content hash are both authenticated.
    expect(fs.stat).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
    expect(sodium.hashFile).toHaveBeenCalledWith({
      uri: PLAINTEXT_TEMP_PATH,
      type: "url"
    });

    // Nothing is promoted and the original path is never touched.
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);

    // The temp ciphertext and the decrypted plaintext artifact are removed.
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
  });

  test("leaves an existing local ciphertext untouched", async () => {
    mockUploadedDownload();
    fs.exists.mockImplementation(
      async (path: string) => path === ORIGINAL_PATH
    );
    ioExists.mockResolvedValue(true);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true }
    );

    expect(result).toBe(true);
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
  });

  test("rejects a tampered remote copy (hash mismatch) without touching the original", async () => {
    mockUploadedDownload();
    fs.exists.mockResolvedValue(false);
    ioExists.mockResolvedValue(false);
    sodium.hashFile.mockResolvedValue("0000000000000000");

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true }
    );

    expect(result).toBe(false);
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
    expect(markAsFailedMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a truncated remote copy (size mismatch)", async () => {
    mockUploadedDownload();
    fs.exists.mockResolvedValue(false);
    ioExists.mockResolvedValue(false);
    fs.stat.mockResolvedValue({ size: FILE_SIZE - 1 });

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true }
    );

    expect(result).toBe(false);
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(markAsFailedMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a remote copy that cannot be decrypted", async () => {
    mockUploadedDownload();
    fs.exists.mockResolvedValue(false);
    ioExists.mockResolvedValue(false);
    sodium.decryptFile.mockRejectedValue(new Error("wrong key"));

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true }
    );

    expect(result).toBe(false);
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
  });

  test("fails closed when the attachment key cannot be decrypted", async () => {
    mockUploadedDownload();
    fs.exists.mockResolvedValue(false);
    ioExists.mockResolvedValue(false);
    decryptKeyMock.mockResolvedValue(null);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true }
    );

    expect(result).toBe(false);
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
  });

  test("refuses to verify a non-2xx response", async () => {
    mockUploadedDownload(403);
    fs.exists.mockResolvedValue(false);
    ioExists.mockResolvedValue(false);

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true }
    );

    expect(result).toBe(false);
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(fs.unlink).toHaveBeenCalledWith(TEMP_PATH);
  });
});

describe("downloadFile silent", () => {
  function mockFailingRemoteSize() {
    mockUploadedDownload();
    fs.exists.mockResolvedValue(false);
    ioExists.mockResolvedValue(false);
    // The remote size check fails before any transfer.
    getUploadedFileSizeMock.mockResolvedValue(-1);
  }

  test("suppresses the download error toasts but still reports failure", async () => {
    mockFailingRemoteSize();

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken(),
      { forceRemote: true, verifyOnly: true, silent: true }
    );

    expect(result).toBe(false);
    expect(toastShow).not.toHaveBeenCalled();
    // Logging is not silenced.
    expect(DatabaseLogger.error).toHaveBeenCalled();
  });

  test("still shows the error toast when silent is not requested", async () => {
    mockFailingRemoteSize();

    const result = await downloadFile(
      FILENAME,
      requestOptions as DownloadRequestOptions,
      makeCancelToken()
    );

    expect(result).toBe(false);
    // One toast per context (global + local).
    expect(toastShow).toHaveBeenCalledTimes(2);
    expect(DatabaseLogger.error).toHaveBeenCalled();
  });
});

describe("checkAttachment remote authentication", () => {
  const ONLINE = { isConnected: true, isInternetReachable: true };
  const OFFLINE = { isConnected: false, isInternetReachable: false };

  function mockLocalOriginalPresent() {
    // A (possibly size-mismatched) local ciphertext exists on disk and must be
    // preserved no matter how the remote check turns out.
    fs.exists.mockImplementation(async (path: string) => path === ORIGINAL_PATH);
  }

  test("authenticates the remote object and reports success", async () => {
    netInfoFetch.mockResolvedValue(ONLINE);
    mockUploadedDownload();

    const result = await checkAttachment(FILENAME);

    expect(result).toEqual({ success: true });

    // The remote object is fetched with the core request shape: the /s3 url for
    // this hash and the account token from the token manager.
    expect(getAccessTokenMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example/s3?name=${FILENAME}`,
      { method: "GET", headers: { Authorization: "Bearer file-token" } }
    );

    // The downloaded remote ciphertext is decrypted with the attachment's own
    // key/IV/size/hash and its plaintext is authenticated.
    expect(sodium.decryptFile).toHaveBeenCalledTimes(1);
    expect(fs.stat).toHaveBeenCalledWith(PLAINTEXT_TEMP_PATH);
    expect(sodium.hashFile).toHaveBeenCalledWith({
      uri: PLAINTEXT_TEMP_PATH,
      type: "url"
    });

    // Nothing is promoted and the local original is never unlinked.
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);

    // The manual check produces no toast and does not mark the attachment
    // failed; the caller owns both.
    expect(toastShow).not.toHaveBeenCalled();
    expect(markAsFailedMock).not.toHaveBeenCalled();
  });

  test("fails a same-size remote object whose plaintext hash does not match", async () => {
    netInfoFetch.mockResolvedValue(ONLINE);
    mockUploadedDownload();
    mockLocalOriginalPresent();
    // The remote copy is served from a plausible size but is not this
    // attachment's content.
    sodium.hashFile.mockResolvedValue("0000000000000000");

    const result = await checkAttachment(FILENAME);

    expect(result).toEqual({ failed: expect.stringContaining("file verification failed") });
    // A size-valid but tampered remote copy must never be reported as success.
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    // verification failure toasts and marks are the caller's responsibility.
    expect(toastShow).not.toHaveBeenCalled();
    expect(markAsFailedMock).not.toHaveBeenCalled();
  });

  test("fails a truncated remote copy whose plaintext size does not match", async () => {
    netInfoFetch.mockResolvedValue(ONLINE);
    mockUploadedDownload();
    mockLocalOriginalPresent();
    fs.stat.mockResolvedValue({ size: FILE_SIZE - 1 });

    const result = await checkAttachment(FILENAME);

    expect(result).toEqual({ failed: expect.stringContaining("file verification failed") });
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(toastShow).not.toHaveBeenCalled();
    expect(markAsFailedMock).not.toHaveBeenCalled();
  });

  test("fails when the remote object cannot be decrypted with the attachment key", async () => {
    netInfoFetch.mockResolvedValue(ONLINE);
    mockUploadedDownload();
    mockLocalOriginalPresent();
    sodium.decryptFile.mockRejectedValue(new Error("wrong key"));

    const result = await checkAttachment(FILENAME);

    expect(result).toEqual({ failed: expect.stringContaining("file verification failed") });
    expect(fs.mv).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
    expect(toastShow).not.toHaveBeenCalled();
  });

  test("fails instead of passing when the remote size check cannot find the object", async () => {
    netInfoFetch.mockResolvedValue(ONLINE);
    mockUploadedDownload();
    // HEAD failed (missing object / persistent error): -1 is not a valid size,
    // so it must be a failure rather than the old optimistic success.
    getUploadedFileSizeMock.mockResolvedValue(-1);

    const result = await checkAttachment(FILENAME);

    expect(result).toEqual({ failed: expect.stringContaining("file verification failed") });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(markAsFailedMock).not.toHaveBeenCalled();
  });

  test("reports a missing attachment without touching the network", async () => {
    netInfoFetch.mockResolvedValue(ONLINE);
    lookupAttachment.mockResolvedValue(null);

    const result = await checkAttachment(FILENAME);

    expect(result).toEqual({ failed: "Attachment not found." });
    expect(getUploadedFileSizeMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
  });

  test("reports a failure when no account session is available", async () => {
    netInfoFetch.mockResolvedValue(ONLINE);
    mockUploadedDownload();
    getAccessTokenMock.mockResolvedValue(null);

    const result = await checkAttachment(FILENAME);

    expect(result).toEqual({ failed: expect.stringContaining("file verification failed") });
    // Without a credential nothing may be requested or decrypted.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(markAsFailedMock).not.toHaveBeenCalled();
  });

  test("returns undefined when offline and performs no remote work", async () => {
    netInfoFetch.mockResolvedValue(OFFLINE);
    mockUploadedDownload();

    const result = await checkAttachment(FILENAME);

    expect(result).toBeUndefined();
    expect(getUploadedFileSizeMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sodium.decryptFile).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
    expect(markAsFailedMock).not.toHaveBeenCalled();
  });
});

describe("downloadFile concurrent same-hash temp isolation", () => {
  test("gives each invocation its own temp name and cleans up independently", async () => {
    mockUploadedDownload();
    // forceRemote bypasses the local-existence short-circuit; no original on
    // disk, so a verified download is promoted with mv().
    ioExists.mockResolvedValue(true);
    fs.exists.mockResolvedValue(false);

    // Two concurrent invocations for the same hash must not share a temp name.
    getRandomIdMock
      .mockImplementationOnce((prefix: string) => `${prefix}aaa`)
      .mockImplementationOnce((prefix: string) => `${prefix}bbb`);

    // Make exactly the invocation whose temp name contains "aaa" fail the
    // status check. Keying the response on the temp path (passed to
    // RNFetchBlob.config) instead of call order keeps the test independent of
    // scheduling/interleaving.
    configMock.mockImplementation((options: { path: string }) => ({
      fetch: jest.fn(() => ({
        progress: jest.fn(async () => {
          const failing = options.path.includes("aaa");
          return {
            info: () => ({ headers: {}, status: failing ? 403 : 200 }),
            text: async () => ""
          };
        })
      }))
    }));

    const results = await Promise.all([
      downloadFile(
        FILENAME,
        requestOptions as DownloadRequestOptions,
        makeCancelToken(),
        { forceRemote: true }
      ),
      downloadFile(
        FILENAME,
        requestOptions as DownloadRequestOptions,
        makeCancelToken(),
        { forceRemote: true }
      )
    ]);

    // Exactly one invocation was refused (403) and one succeeded.
    expect([...results].sort()).toEqual([false, true]);

    // Two distinct temp ciphertext paths, both uniquely named and still ending
    // in `_temp` so clearCache() keeps treating them as disposable.
    const tempPaths = configMock.mock.calls.map(
      (call) => (call[0] as { path: string }).path
    );
    expect(tempPaths).toHaveLength(2);
    expect(tempPaths[0]).not.toBe(tempPaths[1]);
    expect(new Set(tempPaths).size).toBe(2);
    for (const path of tempPaths) {
      expect(path).toMatch(new RegExp(`^/cache/${FILENAME}_.+_temp$`));
    }

    const failedTemp = tempPaths.find((path) => path.includes("aaa")) as string;
    const succeededTemp = tempPaths.find((path) =>
      path.includes("bbb")
    ) as string;
    expect(failedTemp).toBeDefined();
    expect(succeededTemp).toBeDefined();
    expect(failedTemp).not.toBe(succeededTemp);

    // The successful invocation decrypted *its own* temp ciphertext (basename,
    // no directory) with the attachment key and promoted only that temp.
    const decryptedHashes = sodium.decryptFile.mock.calls.map(
      (call) => (call[1] as { hash: string }).hash
    );
    expect(decryptedHashes).toEqual([succeededTemp.slice("/cache/".length)]);
    expect(fs.mv).toHaveBeenCalledTimes(1);
    expect(fs.mv).toHaveBeenCalledWith(succeededTemp, ORIGINAL_PATH);
    expect(fs.mv).not.toHaveBeenCalledWith(failedTemp, expect.anything());

    // Cleanup independence: the failed invocation removed only its own temp
    // ciphertext (and produced no plaintext, so it never touched the other
    // invocation's artifacts).
    expect(fs.unlink).toHaveBeenCalledWith(failedTemp);
    expect(fs.unlink).not.toHaveBeenCalledWith(succeededTemp);
    expect(fs.unlink).not.toHaveBeenCalledWith(`${failedTemp}_dcache`);

    // The successful invocation cleaned up its own `_dcache` plaintext only;
    // the two plaintext paths are as distinct as their ciphertext temps.
    expect(fs.unlink).toHaveBeenCalledWith(`${succeededTemp}_dcache`);
    expect(`${failedTemp}_dcache`).not.toBe(`${succeededTemp}_dcache`);
    expect(fs.unlink).not.toHaveBeenCalledWith(ORIGINAL_PATH);
  });
});
