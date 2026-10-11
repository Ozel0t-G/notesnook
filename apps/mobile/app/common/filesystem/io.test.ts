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

// clearCache() must never delete the local ciphertext of an attachment that has
// not been uploaded: the server has no copy and the file could not be
// re-downloaded. These cases pin that guarantee (and the fail-closed behaviour
// when the attachment lookup itself fails), while ensuring uploaded and
// known-disposable cache files are still cleaned up by clearCache().
// A missing attachment row is never treated as proof that a file is
// disposable: writeEncryptedBase64 writes the bare-hash ciphertext before the
// attachment row is committed, so untracked files are kept unless their name
// explicitly matches a cache artifact Notesnook can regenerate.
// exists() and readEncrypted() never delete the local ciphertext: a size
// mismatch or a decrypt failure is not proof that the server holds a usable
// copy, so both keep the file even when the attachment has been uploaded.
// deleteFile() (local-only) must also await the removal of the cached
// ciphertext: a caller that immediately re-uploads after deleteFile resolves
// must not race a still-in-flight unlink of the file it is about to write.

export {};

jest.mock(
  "./utils",
  () => ({
    ABYTES: 17,
    cacheDir: "/cache",
    cacheDirOld: "/cache-old",
    getAppGroupPath: jest.fn(),
    getRandomId: (prefix: string) => `${prefix || ""}random`,
    isSuccessStatusCode: (code: number) => code >= 200 && code <= 299,
    parseS3Error: (data?: string) => ({ Code: "UNKNOWN", Message: data })
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
      attachments: { attachment: jest.fn(), decryptKey: jest.fn() }
    }
  }),
  { virtual: true }
);

jest.mock(
  "../../services/event-manager",
  () => ({ eSendEvent: jest.fn() }),
  { virtual: true }
);

jest.mock(
  "../../utils/constants",
  () => ({ getAppGroupIdForNative: jest.fn(() => "group.example") }),
  { virtual: true }
);

jest.mock(
  "react-native",
  () => ({
    Platform: {
      OS: "android",
      select: (spec: Record<string, unknown>) => spec.default
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
        ls: jest.fn(),
        exists: jest.fn(),
        mkdir: jest.fn(),
        unlink: jest.fn(),
        stat: jest.fn(),
        createFile: jest.fn(),
        mv: jest.fn(),
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

jest.mock("@notesnook/core", () => ({ assertBearerDestination: jest.fn() }), {
  virtual: true
});
jest.mock("@notesnook/crypto", () => ({}), { virtual: true });
jest.mock(
  "@ammarahmed/react-native-sodium",
  () => ({
    __esModule: true,
    default: { decryptFile: jest.fn(), hashFile: jest.fn() }
  }),
  { virtual: true }
);

// clearCache statically imports ./download to verify uploaded attachments on
// Apple platforms. Mock it so the heavy native transitive deps are never loaded
// and the verification result is controllable. download.ts is not mocked
// anywhere else, so without this the import would reject and every uploaded
// file would be kept (masking the intended success path).
jest.mock(
  "./download",
  () => ({ checkAttachment: jest.fn() }),
  { virtual: true }
);

import {
  bulkExists,
  clearCache,
  clearFileStorage,
  deleteDCacheFiles,
  deleteFile,
  exists,
  getCachePathForFile,
  isLocalCiphertextValidForRow,
  readEncrypted
} from "./io";
import RNFetchBlob from "react-native-blob-util";
import Sodium from "@ammarahmed/react-native-sodium";
import { Platform } from "react-native";
import { db } from "../database";
import { eSendEvent } from "../../services/event-manager";
import { getAppGroupPath } from "./utils";
import { checkAttachment } from "./download";

const fs = RNFetchBlob.fs as unknown as {
  ls: jest.Mock;
  exists: jest.Mock;
  mkdir: jest.Mock;
  unlink: jest.Mock;
  stat: jest.Mock;
  createFile: jest.Mock;
  mv: jest.Mock;
};
const lookupAttachment = db.attachments.attachment as unknown as jest.Mock;
const appGroupPath = getAppGroupPath as unknown as jest.Mock;
const sendEvent = eSendEvent as unknown as jest.Mock;
const decryptFile = Sodium.decryptFile as unknown as jest.Mock;
const hashFile = Sodium.hashFile as unknown as jest.Mock;
const decryptKey = db.attachments.decryptKey as unknown as jest.Mock;
const verifyAttachment = checkAttachment as unknown as jest.Mock;
const platform = Platform as unknown as { OS: string };

function setApplePlatform(isApple: boolean) {
  platform.OS = isApple ? "ios" : "android";
}

type AttachmentRow = {
  size?: number;
  chunkSize?: number;
  dateUploaded?: number | null;
};

const state: {
  cacheFiles: string[];
  oldCacheFiles: string[];
  existing: Set<string>;
  stats: Record<string, number>;
  attachments: Record<string, AttachmentRow>;
  attachmentThrows: Set<string>;
  unlinked: string[];
  appGroupPath: string | null;
} = {
  cacheFiles: [],
  oldCacheFiles: [],
  existing: new Set(),
  stats: {},
  attachments: {},
  attachmentThrows: new Set(),
  unlinked: [],
  appGroupPath: null
};

function expectedSize(size: number, chunkSize: number) {
  return size + Math.ceil(size / chunkSize) * 17;
}

beforeEach(() => {
  jest.clearAllMocks();
  state.cacheFiles = [];
  state.oldCacheFiles = [];
  state.existing = new Set();
  state.stats = {};
  state.attachments = {};
  state.attachmentThrows = new Set();
  state.unlinked = [];
  state.appGroupPath = null;

  // Default the platform to Android so the pre-existing tests keep exercising
  // the unconditional-cleanup path; Apple-only cases opt in explicitly.
  setApplePlatform(false);
  verifyAttachment.mockReset();
  verifyAttachment.mockResolvedValue({ success: true });
  decryptKey.mockReset();
  decryptKey.mockResolvedValue({ key: "decryption-key" });
  hashFile.mockReset();
  hashFile.mockResolvedValue("hash");
  decryptFile.mockReset();

  fs.ls.mockImplementation(async (dir: string) => {
    if (dir === "/cache") return state.cacheFiles;
    if (dir === "/cache-old") return state.oldCacheFiles;
    return [];
  });
  fs.exists.mockImplementation(async (path: string) =>
    state.existing.has(path)
  );
  fs.mkdir.mockImplementation(async (path: string) => {
    state.existing.add(path);
  });
  fs.unlink.mockImplementation(async (path: string) => {
    state.unlinked.push(path);
    state.existing.delete(path);
  });
  fs.stat.mockImplementation(async (path: string) => {
    const size = state.stats[path];
    if (size === undefined) throw new Error(`ENOENT: ${path}`);
    return { size };
  });
  fs.createFile.mockResolvedValue(undefined);
  fs.mv.mockResolvedValue(undefined);

  lookupAttachment.mockImplementation(async (name: string) => {
    if (state.attachmentThrows.has(name))
      throw new Error("attachments table unavailable");
    return state.attachments[name];
  });
  appGroupPath.mockImplementation(async () => state.appGroupPath);
});

describe("clearCache", () => {
  test("preserves pending attachment ciphertext and deletes disposable files", async () => {
    state.cacheFiles = [
      "pendinghash",
      "uploadedhash",
      "imagecache_abc",
      "NN_report.docx",
      "note.pdf",
      "abcdef_dcache",
      "abcdef_temp",
      "orphan"
    ];
    state.attachments = {
      pendinghash: { dateUploaded: null },
      uploadedhash: { dateUploaded: 1_700_000_000_000 }
    };

    await clearCache();

    expect(state.unlinked).not.toContain("/cache/pendinghash");
    expect(state.unlinked).not.toContain("/cache/orphan");
    expect(state.unlinked).toEqual(
      expect.arrayContaining([
        "/cache/uploadedhash",
        "/cache/imagecache_abc",
        "/cache/NN_report.docx",
        "/cache/note.pdf",
        "/cache/abcdef_dcache",
        "/cache/abcdef_temp"
      ])
    );
  });

  test("keeps an untracked bare ciphertext hash while removing known disposable files", async () => {
    // `writeEncryptedBase64` writes the bare-hash ciphertext to the cache dir
    // before its attachment row is committed, so for a short window the only
    // copy of the file has no DB row. clearCache must not treat that as an
    // orphan: only positively-known disposable names may be deleted.
    state.cacheFiles = [
      "3f9a1c0b7d2e4f56",
      "imagecache_abc",
      "one_dcache",
      "two_temp",
      "NN_preview.png",
      "report.pdf"
    ];
    state.attachments = {};

    await clearCache();

    expect(state.unlinked).not.toContain("/cache/3f9a1c0b7d2e4f56");
    expect(state.unlinked).toEqual(
      expect.arrayContaining([
        "/cache/imagecache_abc",
        "/cache/one_dcache",
        "/cache/two_temp",
        "/cache/NN_preview.png",
        "/cache/report.pdf"
      ])
    );
    expect(state.unlinked).toHaveLength(5);
  });

  test("keeps generic untracked files that are not known cache artifacts", async () => {
    state.cacheFiles = [
      "drop_1234",
      "thumb_abc",
      "backup_temp",
      ".migrated_1",
      "some-random-file"
    ];
    state.attachments = {};

    await clearCache();

    expect(state.unlinked).toEqual([]);
  });

  test("a temp file does not inherit the pending state of its attachment", async () => {
    state.cacheFiles = ["abcdef", "abcdef_temp"];
    state.attachments = { abcdef: { dateUploaded: null } };

    await clearCache();

    expect(state.unlinked).not.toContain("/cache/abcdef");
    expect(state.unlinked).toContain("/cache/abcdef_temp");
  });

  test("keeps the file and continues when the attachment lookup throws", async () => {
    state.cacheFiles = ["thrower", "uploadedhash"];
    state.attachmentThrows.add("thrower");
    state.attachments = { uploadedhash: { dateUploaded: 1 } };

    await expect(clearCache()).resolves.toBeUndefined();

    expect(state.unlinked).not.toContain("/cache/thrower");
    expect(state.unlinked).toContain("/cache/uploadedhash");
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith("cache-cleared");
  });

  test("recreates the cache dir and emits the event exactly once", async () => {
    state.cacheFiles = ["pendinghash"];
    state.attachments = { pendinghash: { dateUploaded: undefined } };

    await clearCache();

    expect(state.unlinked).toEqual([]);
    expect(fs.mkdir).toHaveBeenCalledWith("/cache");
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith("cache-cleared");
  });

  test("resolves and still emits the event when the cache dir cannot be listed", async () => {
    fs.ls.mockRejectedValue(new Error("ENOENT: /cache"));

    await expect(clearCache()).resolves.toBeUndefined();

    expect(fs.unlink).not.toHaveBeenCalled();
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith("cache-cleared");
  });

  test("deletes an uploaded attachment on Apple only after remote verification succeeds", async () => {
    // Regression: clearCache used to delete any `dateUploaded` ciphertext.
    // `dateUploaded` is not proof that the server still holds a usable copy, so
    // on Apple the remote object must be authenticated first.
    setApplePlatform(true);
    state.cacheFiles = ["uploadedhash"];
    state.attachments = { uploadedhash: { dateUploaded: 1_700_000_000_000 } };
    verifyAttachment.mockResolvedValue({ success: true });

    await clearCache();

    expect(verifyAttachment).toHaveBeenCalledWith("uploadedhash");
    expect(state.unlinked).toContain("/cache/uploadedhash");
  });

  test("keeps an uploaded attachment on Apple when verification fails", async () => {
    setApplePlatform(true);
    state.cacheFiles = ["uploadedhash"];
    state.attachments = { uploadedhash: { dateUploaded: 1_700_000_000_000 } };
    // A truthy `{ failed }` object must not be read as success.
    verifyAttachment.mockResolvedValue({ failed: "File not found." });

    await clearCache();

    expect(verifyAttachment).toHaveBeenCalledWith("uploadedhash");
    expect(state.unlinked).not.toContain("/cache/uploadedhash");
    expect(state.unlinked).toEqual([]);
  });

  test("keeps an uploaded attachment on Apple while offline (verification undefined)", async () => {
    setApplePlatform(true);
    state.cacheFiles = ["uploadedhash"];
    state.attachments = { uploadedhash: { dateUploaded: 1 } };
    // checkAttachment returns undefined when offline.
    verifyAttachment.mockResolvedValue(undefined);

    await clearCache();

    expect(state.unlinked).toEqual([]);
  });

  test("keeps the file, continues and still emits once when verification throws", async () => {
    setApplePlatform(true);
    state.cacheFiles = ["uploadedhash", "otherhash"];
    state.attachments = {
      uploadedhash: { dateUploaded: 1 },
      otherhash: { dateUploaded: 1 }
    };
    verifyAttachment
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({ success: true });

    await expect(clearCache()).resolves.toBeUndefined();

    // The throw keeps the first file but must not abort the loop.
    expect(state.unlinked).not.toContain("/cache/uploadedhash");
    expect(state.unlinked).toContain("/cache/otherhash");
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith("cache-cleared");
  });

  test("does not verify non-uploaded or untracked files on Apple", async () => {
    setApplePlatform(true);
    state.cacheFiles = ["pendinghash", "orphan", "imagecache_abc"];
    state.attachments = { pendinghash: { dateUploaded: null } };

    await clearCache();

    // No needless network for files that can never be safe to delete.
    expect(verifyAttachment).not.toHaveBeenCalled();
    expect(state.unlinked).not.toContain("/cache/pendinghash");
    expect(state.unlinked).not.toContain("/cache/orphan");
    // Disposable temp artifacts still go.
    expect(state.unlinked).toContain("/cache/imagecache_abc");
  });

  test("deletes uploaded attachments without verification on non-Apple platforms", async () => {
    setApplePlatform(false);
    state.cacheFiles = ["uploadedhash"];
    state.attachments = { uploadedhash: { dateUploaded: 1 } };

    await clearCache();

    expect(verifyAttachment).not.toHaveBeenCalled();
    expect(state.unlinked).toContain("/cache/uploadedhash");
  });

  test("keeps a protected reupload backup even when its attachment is uploaded", async () => {
    // A `<hash>_reupload_backup` holds the only previous copy of an
    // attachment's ciphertext until its metadata commit is reconciled, so it
    // must survive clearCache regardless of the (uploaded) row state.
    setApplePlatform(true);
    state.cacheFiles = ["hash", "hash_reupload_backup"];
    state.attachments = { hash: { dateUploaded: 1_700_000_000_000 } };
    verifyAttachment.mockResolvedValue({ success: true });

    await clearCache();

    expect(state.unlinked).toContain("/cache/hash");
    expect(state.unlinked).not.toContain("/cache/hash_reupload_backup");
  });

  test("keeps a protected repair quarantine even when its attachment is uploaded", async () => {
    // `<hash>_repair_quarantine` holds the previous local ciphertext that an
    // authenticated repair replaced with a verified remote copy, so it must
    // survive clearCache regardless of the (uploaded) row state.
    setApplePlatform(true);
    state.cacheFiles = ["hash", "hash_repair_quarantine"];
    state.attachments = { hash: { dateUploaded: 1_700_000_000_000 } };
    verifyAttachment.mockResolvedValue({ success: true });

    await clearCache();

    expect(state.unlinked).toContain("/cache/hash");
    expect(state.unlinked).not.toContain("/cache/hash_repair_quarantine");
  });

  test("keeps a uniquely named repair quarantine even when its attachment is uploaded", async () => {
    // Repairs now quarantine into `<hash>_<random>_repair_quarantine`; the
    // random middle component must not defeat the suffix-based protection.
    setApplePlatform(true);
    state.cacheFiles = ["hash", "hash_ab12cd_repair_quarantine"];
    state.attachments = { hash: { dateUploaded: 1_700_000_000_000 } };
    verifyAttachment.mockResolvedValue({ success: true });

    await clearCache();

    expect(state.unlinked).toContain("/cache/hash");
    expect(state.unlinked).not.toContain(
      "/cache/hash_ab12cd_repair_quarantine"
    );
  });

  test("mixed batch on Apple deletes only the verified uploaded file", async () => {
    setApplePlatform(true);
    state.cacheFiles = ["verified", "unverified", "pendinghash", "report.pdf"];
    state.attachments = {
      verified: { dateUploaded: 1 },
      unverified: { dateUploaded: 1 },
      pendinghash: { dateUploaded: null }
    };
    verifyAttachment.mockImplementation(async (name: string) =>
      name === "verified" ? { success: true } : { failed: "nope" }
    );

    await clearCache();

    expect(state.unlinked).toContain("/cache/verified");
    expect(state.unlinked).toContain("/cache/report.pdf");
    expect(state.unlinked).not.toContain("/cache/unverified");
    expect(state.unlinked).not.toContain("/cache/pendinghash");
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });
});

describe("deleteDCacheFiles (plaintext artifact cleanup)", () => {
  test("unlinks plaintext artifacts by their absolute cache path", async () => {
    // Regression: unlink was called with the bare name from `ls`, so it never
    // removed the actual decrypt artifacts at startup.
    state.cacheFiles = ["abc_dcache", "NN_preview.png", "note.pdf", "keepfile"];

    await deleteDCacheFiles();

    expect(state.unlinked).toEqual(
      expect.arrayContaining([
        "/cache/abc_dcache",
        "/cache/NN_preview.png",
        "/cache/note.pdf"
      ])
    );
    expect(state.unlinked).not.toContain("abc_dcache");
    expect(state.unlinked).not.toContain("NN_preview.png");
    expect(state.unlinked).not.toContain("/cache/keepfile");
    expect(state.unlinked).toHaveLength(3);
  });

  test("resolves when the cache dir cannot be listed", async () => {
    fs.ls.mockRejectedValue(new Error("ENOENT: /cache"));

    await expect(deleteDCacheFiles()).resolves.toBeUndefined();

    expect(fs.unlink).not.toHaveBeenCalled();
  });

  test("reconciles reupload backups on startup and never deletes them", async () => {
    // deleteDCacheFiles() is the startup hook: it must resolve a leftover
    // reupload backup (or keep it fail-closed when undecidable) instead of
    // treating it as a disposable artifact.
    setApplePlatform(true);
    state.cacheFiles = ["hash_reupload_backup", "abc_dcache"];
    state.existing.add("/cache/hash_reupload_backup");

    await deleteDCacheFiles();

    expect(state.unlinked).not.toContain("/cache/hash_reupload_backup");
    expect(state.unlinked).toContain("/cache/abc_dcache");
  });

  test("never sweeps a repair quarantine as a disposable artifact", async () => {
    setApplePlatform(true);
    state.cacheFiles = ["hash_repair_quarantine", "abc_dcache"];
    state.existing.add("/cache/hash_repair_quarantine");

    await deleteDCacheFiles();

    expect(state.unlinked).not.toContain("/cache/hash_repair_quarantine");
    expect(state.unlinked).toContain("/cache/abc_dcache");
  });

  test("never sweeps a uniquely named repair quarantine as a disposable artifact", async () => {
    setApplePlatform(true);
    state.cacheFiles = ["hash_ab12cd_repair_quarantine", "abc_dcache"];
    state.existing.add("/cache/hash_ab12cd_repair_quarantine");

    await deleteDCacheFiles();

    expect(state.unlinked).not.toContain(
      "/cache/hash_ab12cd_repair_quarantine"
    );
    expect(state.unlinked).toContain("/cache/abc_dcache");
  });
});

describe("isLocalCiphertextValidForRow (authenticated local-ciphertext check)", () => {
  const row = {
    hash: "hash",
    key: { cipher: "encrypted-key" },
    iv: "iv",
    salt: "salt",
    size: 100,
    chunkSize: 50,
    hashType: "xxh64",
    mimeType: "application/octet-stream"
  };

  test("rejects a zero-byte cache-dir stub even when a valid App Group copy exists", async () => {
    // The native cipher treats a zero-byte cache-dir file as missing and falls
    // back to the App Group, so without the raw size check this stub could be
    // "authenticated" by the other copy while the stub is what would be
    // replaced. The size check is on the exact cache-dir file and runs before
    // any decryption.
    state.appGroupPath = "/appgroup";
    state.existing.add("/cache/hash");
    state.existing.add("/appgroup/hash");
    state.stats["/cache/hash"] = 0;
    state.stats["/appgroup/hash"] = expectedSize(100, 50);

    await expect(isLocalCiphertextValidForRow("hash", row)).resolves.toBe(false);
    expect(decryptFile).not.toHaveBeenCalled();
  });

  test("rejects a size-mismatched (truncated) cache-dir ciphertext", async () => {
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = expectedSize(100, 50) - 1;

    await expect(isLocalCiphertextValidForRow("hash", row)).resolves.toBe(false);
    expect(decryptFile).not.toHaveBeenCalled();
  });

  test("accepts a size-valid cache-dir ciphertext that decrypts to the row's size and hash", async () => {
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = expectedSize(100, 50);
    decryptFile.mockResolvedValue("/cache/hash_dcache");
    state.stats["/cache/hash_dcache"] = 100;
    hashFile.mockResolvedValue("hash");

    await expect(isLocalCiphertextValidForRow("hash", row)).resolves.toBe(true);
    expect(decryptFile).toHaveBeenCalledTimes(1);
    expect(hashFile).toHaveBeenCalledWith({
      uri: "/cache/hash_dcache",
      type: "url"
    });
    // The plaintext verification artifact never lingers.
    expect(state.unlinked).toContain("/cache/hash_dcache");
  });

  test("rejects a size-valid but corrupt cache-dir ciphertext", async () => {
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = expectedSize(100, 50);
    decryptFile.mockResolvedValue("/cache/hash_dcache");
    state.stats["/cache/hash_dcache"] = 100;
    hashFile.mockResolvedValue("0000000000000000");

    await expect(isLocalCiphertextValidForRow("hash", row)).resolves.toBe(false);
    expect(decryptFile).toHaveBeenCalledTimes(1);
  });

  test("rejects an absent cache-dir ciphertext", async () => {
    await expect(isLocalCiphertextValidForRow("hash", row)).resolves.toBe(false);
    expect(decryptFile).not.toHaveBeenCalled();
  });
});

describe("clearFileStorage (intentional logout wipe)", () => {
  test("still deletes pending attachment ciphertext", async () => {
    state.cacheFiles = ["pendinghash"];
    state.oldCacheFiles = ["oldfile"];
    state.attachments = { pendinghash: { dateUploaded: null } };
    state.existing.add("/cache/pendinghash");
    state.existing.add("/cache-old/oldfile");

    await clearFileStorage();

    expect(state.unlinked).toContain("/cache/pendinghash");
    expect(state.unlinked).toContain("/cache-old/oldfile");
  });
});

describe("exists", () => {
  test("returns false but keeps a size-mismatched pending file", async () => {
    state.attachments = { hash: { size: 100, chunkSize: 50, dateUploaded: null } };
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = 999;

    const result = await exists("hash");

    expect(result).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(state.existing.has("/cache/hash")).toBe(true);
  });

  test("returns true when the pending file size matches", async () => {
    state.attachments = {
      hash: { size: 100, chunkSize: 50, dateUploaded: null }
    };
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = expectedSize(100, 50);

    const result = await exists("hash");

    expect(result).toBe(true);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  test("keeps a size-mismatched uploaded file", async () => {
    state.attachments = { hash: { size: 100, chunkSize: 50, dateUploaded: 1 } };
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = 999;

    const result = await exists("hash");

    expect(result).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(state.existing.has("/cache/hash")).toBe(true);
  });

  test("keeps the file when the attachment lookup throws", async () => {
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = 999;
    lookupAttachment.mockRejectedValue(new Error("db unavailable"));

    await expect(exists("hash")).resolves.toBe(false);

    expect(fs.unlink).not.toHaveBeenCalled();
    expect(state.existing.has("/cache/hash")).toBe(true);
  });

  test("returns false without deleting when there is no attachment record", async () => {
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = 999;

    const result = await exists("hash");

    expect(result).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  test("keeps a size-mismatched pending file that only exists in the app group", async () => {
    state.appGroupPath = "/appgroup";
    state.attachments = { hash: { size: 100, chunkSize: 50, dateUploaded: null } };
    state.existing.add("/appgroup/hash");
    state.stats["/appgroup/hash"] = 999;

    const result = await exists("hash");

    expect(result).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(state.existing.has("/appgroup/hash")).toBe(true);
  });

  test("keeps a size-mismatched uploaded file that only exists in the app group", async () => {
    state.appGroupPath = "/appgroup";
    state.attachments = { hash: { size: 100, chunkSize: 50, dateUploaded: 1 } };
    state.existing.add("/appgroup/hash");
    state.stats["/appgroup/hash"] = 999;

    const result = await exists("hash");

    expect(result).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(state.existing.has("/appgroup/hash")).toBe(true);
  });

  // A ciphertext left behind in the legacy cache dir (RNFetchBlob's CacheDir)
  // is still a valid local copy: uploadFile probes it, so exists() must too,
  // otherwise core keeps the attachment marked as locally missing forever.
  test("returns true for a valid file that only exists in the legacy cache dir", async () => {
    state.attachments = {
      hash: { size: 100, chunkSize: 50, dateUploaded: null }
    };
    state.existing.add("/cache-old/hash");
    state.stats["/cache-old/hash"] = expectedSize(100, 50);

    const result = await exists("hash");

    expect(result).toBe(true);
    expect(fs.unlink).not.toHaveBeenCalled();
    // The size must be validated against the copy that was actually found;
    // statting /cache/hash would throw ENOENT here.
    expect(fs.stat).toHaveBeenCalledWith("/cache-old/hash");
  });

  test("returns false but keeps a size-mismatched pending file in the legacy cache dir", async () => {
    state.attachments = {
      hash: { size: 100, chunkSize: 50, dateUploaded: null }
    };
    state.existing.add("/cache-old/hash");
    state.stats["/cache-old/hash"] = 999;

    const result = await exists("hash");

    expect(result).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(state.existing.has("/cache-old/hash")).toBe(true);
  });

  test("keeps a size-mismatched uploaded file from the legacy cache dir", async () => {
    state.attachments = { hash: { size: 100, chunkSize: 50, dateUploaded: 1 } };
    state.existing.add("/cache-old/hash");
    state.stats["/cache-old/hash"] = 999;

    const result = await exists("hash");

    expect(result).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(state.existing.has("/cache-old/hash")).toBe(true);
  });

  test("prefers the cache dir copy over the legacy one", async () => {
    state.attachments = {
      hash: { size: 100, chunkSize: 50, dateUploaded: null }
    };
    state.existing.add("/cache/hash");
    state.existing.add("/cache-old/hash");
    state.stats["/cache/hash"] = expectedSize(100, 50);
    state.stats["/cache-old/hash"] = expectedSize(100, 50);

    const result = await exists("hash");

    expect(result).toBe(true);
    expect(fs.stat).toHaveBeenCalledWith("/cache/hash");
    expect(fs.stat).not.toHaveBeenCalledWith("/cache-old/hash");
  });
});

describe("readEncrypted", () => {
  test("keeps the local ciphertext when decryption fails for an uploaded file", async () => {
    // Regression: a decrypt failure used to delete the local ciphertext when
    // the attachment had been uploaded, silently discarding the only offline
    // copy on a transient or structural decrypt error.
    state.attachments = { hash: { size: 100, chunkSize: 50, dateUploaded: 1 } };
    state.existing.add("/cache/hash");
    state.stats["/cache/hash"] = expectedSize(100, 50);
    decryptFile.mockRejectedValue(new Error("decrypt failed"));

    await expect(
      readEncrypted("hash", {} as never, { outputType: "text" } as never)
    ).resolves.toBeUndefined();

    // Reaching decryptFile proves the fixture passed exists() and the failure
    // exercised the catch branch, not an early return.
    expect(decryptFile).toHaveBeenCalledTimes(1);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(state.existing.has("/cache/hash")).toBe(true);
  });
});

describe("getCachePathForFile", () => {
  test("returns the legacy cache path when that is where the file is", async () => {
    state.existing.add("/cache-old/hash");

    await expect(getCachePathForFile("hash")).resolves.toBe("/cache-old/hash");
  });

  test("prefers the cache dir path when both locations hold the file", async () => {
    state.existing.add("/cache/hash");
    state.existing.add("/cache-old/hash");

    await expect(getCachePathForFile("hash")).resolves.toBe("/cache/hash");
  });

  test("still returns the cache dir path when the file is nowhere", async () => {
    await expect(getCachePathForFile("hash")).resolves.toBe("/cache/hash");
  });
});

describe("bulkExists", () => {
  test("does not report a file present only in the legacy cache dir as missing", async () => {
    state.oldCacheFiles = ["hash"];

    await expect(bulkExists(["hash"])).resolves.toEqual([]);
  });

  test("reports only the files that are in neither location", async () => {
    state.cacheFiles = ["present"];
    state.oldCacheFiles = ["legacy"];

    await expect(bulkExists(["present", "legacy", "gone"])).resolves.toEqual([
      "gone"
    ]);
  });

  test("keeps reporting missing files when the legacy cache dir cannot be listed", async () => {
    // A fresh install has no legacy cache dir, and `ls` rejects for a missing
    // directory. That must not fail the whole call: the outer catch returns [],
    // which core reads as "every file is present" and would silently stop all
    // downloads.
    fs.ls.mockImplementation(async (dir: string) => {
      if (dir === "/cache") return state.cacheFiles;
      if (dir === "/cache-old") throw new Error("ENOENT: /cache-old");
      return [];
    });

    await expect(bulkExists(["hash"])).resolves.toEqual(["hash"]);
  });
});

describe("deleteFile (local-only reupload race)", () => {
  test("does not settle until the unlink of the cached ciphertext resolves", async () => {
    // deleteFile must not resolve while the cached ciphertext is still being
    // removed: otherwise a caller that immediately re-uploads the same hash
    // could write the new ciphertext and then have the in-flight unlink delete
    // it. Platform.OS is mocked as "android", so this drives the local path.
    state.existing.add("/cache/hash");

    let releaseUnlink: (() => void) | undefined;
    let sawUnlink!: (path: string) => void;
    const reachedUnlink = new Promise<string>((resolve) => {
      sawUnlink = resolve;
    });

    // Deferred (unresolved) unlink: the file is reached but not yet removed.
    fs.unlink.mockImplementation((path: string) => {
      sawUnlink(path);
      return new Promise<void>((resolve) => {
        releaseUnlink = resolve;
      });
    });

    let settled = false;
    const pending = deleteFile("hash").then((value) => {
      settled = true;
      return value;
    });

    try {
      // Gate on unlink actually being invoked so the "unsettled" assertion
      // cannot pass vacuously (e.g. if deleteFile stalled before reaching it).
      await expect(reachedUnlink).resolves.toBe("/cache/hash");
      expect(settled).toBe(false);

      if (!releaseUnlink) throw new Error("unlink was never reached");
      releaseUnlink();
      await expect(pending).resolves.toBe(true);
      expect(state.unlinked).not.toContain("/cache/hash");
    } finally {
      // Never leave the deferred promise dangling if an assertion throws.
      releaseUnlink?.();
    }
  });
});
