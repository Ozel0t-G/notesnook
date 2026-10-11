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

// Apple explicit Reupload must never be a destructive remote DELETE + write.
// `Sodium.encryptFile` writes the new ciphertext straight to `cacheDir/<hash>`
// and unlinks whatever was there, so the old bytes must be moved to a protected
// backup first and only dropped once the `db.attachments` row has committed.
//
// These cases pin the staging protocol itself (order, restore-on-failure,
// commit-before-backup-delete, crash reconciliation) and the `attachFile`
// orchestration (Apple never touches the server; Android keeps delete-first).
// Real failure injection is simulated between encryption and row commit, and
// after the commit but before the backup deletion.

export {};

jest.mock(
  "./utils",
  () => ({
    ABYTES: 17,
    cacheDir: "/cache",
    cacheDirOld: "/cache-old",
    getAppGroupPath: jest.fn(async () => null),
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
      attachments: {
        attachment: jest.fn(),
        add: jest.fn(),
        reset: jest.fn(),
        exists: jest.fn(),
        generateKey: jest.fn(),
        decryptKey: jest.fn(),
        markReuploadConfirmed: jest.fn()
      },
      fs: jest.fn()
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
    getAppGroupIdForNative: jest.fn(() => "group.example"),
    getUploaderAppGroup: jest.fn(() => "group.example"),
    hasAppGroupContainer: jest.fn(() => true)
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
        mv: jest.fn(),
        unlink: jest.fn(),
        stat: jest.fn(),
        ls: jest.fn(),
        mkdir: jest.fn(),
        createFile: jest.fn(),
        dirs: {
          CacheDir: "/cache-old",
          LibraryDir: "/library",
          DocumentDir: "/documents"
        }
      },
      fetch: jest.fn()
    }
  }),
  { virtual: true }
);

jest.mock(
  "@ammarahmed/react-native-sodium",
  () => ({
    __esModule: true,
    default: {
      encryptFile: jest.fn(),
      decryptFile: jest.fn(),
      hashFile: jest.fn()
    }
  }),
  { virtual: true }
);

jest.mock("@notesnook/core", () => ({ assertBearerDestination: jest.fn() }), {
  virtual: true
});
jest.mock("@notesnook/crypto", () => ({}), { virtual: true });

// io.ts statically imports ./download for clearCache remote verification. Mock
// it so the heavy native transitive deps never load here.
jest.mock("./download", () => ({ checkAttachment: jest.fn() }), {
  virtual: true
});

// --- picker.ts dependency mocks (for the attachFile integration cases) ---
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
      fileTooLargeDesc: () => "too large",
      failToOpen: () => "fail to open",
      loginRequired: () => "login required",
      fileMismatch: () => "file mismatch"
    }
  }),
  { virtual: true }
);
jest.mock(
  "@react-native-documents/picker",
  () => ({ pick: jest.fn(), keepLocalCopy: jest.fn() }),
  { virtual: true }
);
jest.mock("pathe", () => ({ basename: jest.fn(), dirname: jest.fn() }), {
  virtual: true
});
jest.mock(
  "react-native-image-crop-picker",
  () => ({ openCamera: jest.fn(), openPicker: jest.fn() }),
  { virtual: true }
);
jest.mock("./compress", () => ({ compressToFile: jest.fn() }), {
  virtual: true
});
jest.mock(
  "../../components/dialogs/attach-image-dialog",
  () => ({ __esModule: true, default: { present: jest.fn() } }),
  { virtual: true }
);
jest.mock(
  "../../services/premium",
  () => ({ __esModule: true, default: { showVerifyEmailDialog: jest.fn() } }),
  { virtual: true }
);
jest.mock(
  "../../stores/use-setting-store",
  () => ({ useSettingStore: { getState: jest.fn() } }),
  { virtual: true }
);
jest.mock(
  "../../stores/use-user-store",
  () => ({ useUserStore: { getState: jest.fn(), setState: jest.fn() } }),
  { virtual: true }
);
jest.mock(
  "../../screens/editor/tiptap/use-tab-store",
  () => ({ useTabStore: { getState: jest.fn() } }),
  { virtual: true }
);
jest.mock(
  "../../screens/editor/tiptap/utils",
  () => ({
    editorController: {
      current: { commands: { insertAttachment: jest.fn(), insertImage: jest.fn() } }
    },
    editorState: jest.fn(() => ({ isFocused: false }))
  }),
  { virtual: true }
);

import RNFetchBlob from "react-native-blob-util";
import Sodium from "@ammarahmed/react-native-sodium";
import { Platform } from "react-native";
import { db } from "../database";
import { useSettingStore } from "../../stores/use-setting-store";
import { useUserStore } from "../../stores/use-user-store";
import { useTabStore } from "../../screens/editor/tiptap/use-tab-store";
import {
  commitReuploadBackup,
  isReuploadInFlight,
  performAppleReupload,
  readEncrypted,
  reconcileAllReuploadBackups,
  reconcileReuploadBackup,
  restoreReuploadBackup,
  stageReuploadBackup
} from "./io";
import { attachFile } from "../../screens/editor/tiptap/picker";

const fs = RNFetchBlob.fs as unknown as {
  exists: jest.Mock;
  mv: jest.Mock;
  unlink: jest.Mock;
  stat: jest.Mock;
  ls: jest.Mock;
  mkdir: jest.Mock;
  createFile: jest.Mock;
};
const sodium = Sodium as unknown as {
  encryptFile: jest.Mock;
  decryptFile: jest.Mock;
  hashFile: jest.Mock;
};

const attachmentMock = db.attachments.attachment as unknown as jest.Mock;
const addMock = db.attachments.add as unknown as jest.Mock;
const resetMock = db.attachments.reset as unknown as jest.Mock;
const existsMock = db.attachments.exists as unknown as jest.Mock;
const generateKeyMock = db.attachments.generateKey as unknown as jest.Mock;
const decryptKeyMock = db.attachments.decryptKey as unknown as jest.Mock;
const markReuploadConfirmedMock = db.attachments
  .markReuploadConfirmed as unknown as jest.Mock;
const deleteFileMock = jest.fn(async () => true);
const platform = Platform as unknown as { OS: string };

const HASH = "3f9a1c0b7d2e4f56";
// Must match `MISSING_LOCAL_CIPHERTEXT_ERROR` in
// packages/core/src/common.ts (persisted verbatim, strict equality).
const MISSING_LOCAL_CIPHERTEXT_ERROR =
  "Attachment data is missing on this device and cannot be uploaded.";
const REAL_PATH = `/cache/${HASH}`;
const BACKUP_PATH = `/cache/${HASH}_reupload_backup`;
const OLD_SIZE = 100;
const NEW_SIZE = 250;
const CHUNK_SIZE = 1024 * 1024;
const URI = "/tmp/picked";

/**
 * In-memory filesystem. `cipher` records, for every ciphertext path, what a
 * successful decrypt would yield (plaintext hash/size), so verification can be
 * decided exactly like the native cipher would.
 */
const files = new Set<string>();
const cipher = new Map<string, { plainHash: string; plainSize: number }>();
const plainHash = new Map<string, string>();
const plainSize = new Map<string, number>();
const order: string[] = [];
const unlinked: string[] = [];

const state = {
  encryptThrows: false,
  decryptThrows: false,
  addThrows: false,
  decryptKeyNull: false,
  encryptPlainHash: undefined as string | undefined,
  sourceSize: NEW_SIZE,
  appGroupPath: null as string | null
};

let rows: Record<string, Record<string, unknown>>;

function setPlatform(os: "ios" | "android") {
  platform.OS = os;
}

function idx(label: string) {
  const i = order.findIndex((entry) => entry.startsWith(label));
  if (i < 0) throw new Error(`missing order entry: ${label}`);
  return i;
}

function seedOldCiphertext() {
  files.add(REAL_PATH);
  cipher.set(REAL_PATH, { plainHash: HASH, plainSize: OLD_SIZE });
  rows[HASH] = {
    id: "row-1",
    hash: HASH,
    key: { cipher: "k", alg: "xchacha20" },
    iv: "old-iv",
    salt: "old-salt",
    size: OLD_SIZE,
    chunkSize: CHUNK_SIZE,
    hashType: "xxh64",
    mimeType: "application/octet-stream"
  };
}

async function encryptionInfoFor(hash: string, uri: string) {
  const info: Record<string, unknown> = await sodium.encryptFile("key", {
    uri,
    type: "url",
    hash
  });
  info.mimeType = "image/png";
  info.filename = "p.png";
  info.alg = "xcha-stream";
  info.key = "key";
  return info;
}

/**
 * Hold the next `db.attachments.add` open until the returned `release()` is
 * called, so a test can observe the reupload's in-flight window (staged backup,
 * new ciphertext on disk, row not yet committed).
 */
function deferNextAdd() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  addMock.mockImplementationOnce(async (item: Record<string, unknown>) => {
    order.push("add");
    await gate;
    rows[item.hash as string] = {
      ...(rows[item.hash as string] || {}),
      ...item
    };
    return item.hash;
  });
  return release;
}

async function waitFor(predicate: () => boolean, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitFor timed out");
}

beforeEach(() => {
  jest.clearAllMocks();
  files.clear();
  cipher.clear();
  plainHash.clear();
  plainSize.clear();
  order.length = 0;
  unlinked.length = 0;
  state.encryptThrows = false;
  state.decryptThrows = false;
  state.addThrows = false;
  state.decryptKeyNull = false;
  state.encryptPlainHash = undefined;
  state.sourceSize = NEW_SIZE;
  state.appGroupPath = null;
  rows = {};

  setPlatform("ios");

  fs.exists.mockImplementation(async (path: string) => files.has(path));
  fs.mv.mockImplementation(async (src: string, dst: string) => {
    // Faithful to RNFetchBlob.fs.mv (NSFileManager `moveItemAtURL`): the move
    // FAILS when the destination already exists; it never overwrites. A
    // restore over leftover bytes must therefore unlink the destination first.
    if (!files.has(src)) throw new Error(`ENOENT: ${src}`);
    if (files.has(dst)) throw new Error(`EEXIST: ${dst}`);
    files.delete(src);
    files.add(dst);
    if (cipher.has(src)) {
      cipher.set(dst, cipher.get(src) as { plainHash: string; plainSize: number });
      cipher.delete(src);
    }
    order.push(`mv:${src}->${dst}`);
  });
  fs.unlink.mockImplementation(async (path: string) => {
    files.delete(path);
    cipher.delete(path);
    unlinked.push(path);
    order.push(`unlink:${path}`);
  });
  fs.stat.mockImplementation(async (path: string) => {
    if (path.endsWith("_dcache")) {
      if (!plainSize.has(path)) throw new Error(`ENOENT: ${path}`);
      return { size: plainSize.get(path) };
    }
    if (cipher.has(path)) return { size: (cipher.get(path) as { plainSize: number }).plainSize };
    throw new Error(`ENOENT: ${path}`);
  });
  fs.ls.mockImplementation(async (dir: string) => {
    const prefix = `${dir}/`;
    const out: string[] = [];
    for (const file of files) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/"))
        out.push(file.slice(prefix.length));
    }
    return out;
  });
  fs.mkdir.mockResolvedValue(undefined);
  fs.createFile.mockResolvedValue(undefined);

  sodium.encryptFile.mockImplementation(
    async (_key: unknown, opts: { hash: string }) => {
      order.push("encrypt");
      if (state.encryptThrows) throw new Error("encrypt failed");
      const real = `/cache/${opts.hash}`;
      files.add(real);
      cipher.set(real, {
        plainHash: state.encryptPlainHash ?? opts.hash,
        plainSize: state.sourceSize
      });
      return {
        iv: "new-iv",
        salt: "new-salt",
        size: state.sourceSize,
        chunkSize: CHUNK_SIZE,
        hashType: "xxh64",
        hash: opts.hash
      };
    }
  );
  sodium.decryptFile.mockImplementation(
    async (_key: unknown, data: { hash: string }) => {
      const name = data.hash;
      order.push(`decrypt:${name}`);
      if (state.decryptThrows) throw new Error("decrypt failed");
      const cipherPath = `/cache/${name}`;
      if (!files.has(cipherPath)) throw new Error(`ENOENT: ${cipherPath}`);
      const info = cipher.get(cipherPath);
      if (!info) throw new Error(`not ciphertext: ${cipherPath}`);
      const plaintextPath = `${cipherPath}_dcache`;
      files.add(plaintextPath);
      plainHash.set(plaintextPath, info.plainHash);
      plainSize.set(plaintextPath, info.plainSize);
      return plaintextPath;
    }
  );
  sodium.hashFile.mockImplementation(async ({ uri }: { uri: string }) => {
    if (!plainHash.has(uri)) throw new Error(`no plaintext: ${uri}`);
    return plainHash.get(uri);
  });

  attachmentMock.mockImplementation(async (hash: string) => rows[hash]);
  existsMock.mockImplementation(async (hash: string) => !!rows[hash]);
  generateKeyMock.mockResolvedValue("generated-key");
  decryptKeyMock.mockImplementation(async () =>
    state.decryptKeyNull ? null : { key: "decryption-key" }
  );
  addMock.mockImplementation(async (item: Record<string, unknown>) => {
    order.push("add");
    if (state.addThrows) throw new Error("add failed");
    rows[item.hash as string] = {
      ...(rows[item.hash as string] || {}),
      ...item
    };
    return item.hash;
  });
  resetMock.mockImplementation(async () => {
    order.push("reset");
  });
  markReuploadConfirmedMock.mockImplementation(async (id: string) => {
    order.push("markReuploadConfirmed");
    const row = Object.values(rows).find((r) => r.id === id);
    if (row) {
      row.failed = null;
      row.dateUploaded = null;
      row.dateModified = Date.now();
    }
  });
  deleteFileMock.mockImplementation(async () => {
    order.push("deleteFile");
    return true;
  });
  (db.fs as unknown as jest.Mock).mockImplementation(() => ({
    deleteFile: deleteFileMock
  }));

  (useSettingStore.getState as jest.Mock).mockReturnValue({
    setAppDidEnterBackgroundForAction: jest.fn()
  });
  (useUserStore.getState as jest.Mock).mockReturnValue({
    setDisableAppLockRequests: jest.fn(),
    getUser: jest.fn()
  });
  (useTabStore.getState as jest.Mock).mockReturnValue({
    getNoteIdForTab: jest.fn()
  });
});

describe("Apple reupload staging protocol", () => {
  test("moves the old ciphertext to a protected backup before encrypting", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;

    await performAppleReupload(HASH, URI, "image/png", "p.png", "url");

    // The old bytes are moved, never deleted first.
    expect(fs.mv).toHaveBeenCalledWith(REAL_PATH, BACKUP_PATH);
    expect(unlinked).not.toContain(REAL_PATH);
    expect(idx("mv:" + REAL_PATH) < idx("encrypt")).toBe(true);
    expect(idx("encrypt") < idx("add")).toBe(true);
    // The backup is dropped only after the row has committed.
    expect(idx("add") < idx("unlink:" + BACKUP_PATH)).toBe(true);
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: HASH,
        dateUploaded: null,
        alg: "xcha-stream",
        mimeType: "image/png",
        filename: "p.png"
      })
    );
    // Never a remote delete (or any delete) of the server copy.
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
  });

  test("fails closed and restores the backup when the new ciphertext cannot be verified", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    // The freshly written ciphertext decrypts to a different content hash.
    state.encryptPlainHash = "0000000000000000";

    await expect(
      performAppleReupload(HASH, URI, "image/png", "p.png", "url")
    ).rejects.toThrow(/verification/i);

    expect(addMock).not.toHaveBeenCalled();
    // The old ciphertext is back at the real path, untouched.
    expect(files.has(REAL_PATH)).toBe(true);
    expect(cipher.get(REAL_PATH)).toEqual({ plainHash: HASH, plainSize: OLD_SIZE });
    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(unlinked).not.toContain(BACKUP_PATH);
  });

  test("failure injection between encryption and row commit restores the old ciphertext", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    state.addThrows = true;

    await expect(
      performAppleReupload(HASH, URI, "image/png", "p.png", "url")
    ).rejects.toThrow("add failed");

    // Old bytes restored, backup consumed, no data loss, no half-committed row.
    expect(files.has(REAL_PATH)).toBe(true);
    expect(cipher.get(REAL_PATH)).toEqual({ plainHash: HASH, plainSize: OLD_SIZE });
    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(rows[HASH].size).toBe(OLD_SIZE);
  });

  test("reupload with no prior local ciphertext does not stage a backup", async () => {
    rows[HASH] = {
      id: "row-1",
      hash: HASH,
      key: {},
      iv: "old-iv",
      salt: "old-salt",
      size: OLD_SIZE,
      chunkSize: CHUNK_SIZE,
      hashType: "xxh64"
    };
    state.sourceSize = NEW_SIZE;

    await performAppleReupload(HASH, URI, "image/png", "p.png", "url");

    expect(fs.mv).not.toHaveBeenCalled();
    expect(addMock).toHaveBeenCalledTimes(1);
  });
});

describe("Apple reupload crash reconciliation", () => {
  test("crash after the commit but before the backup deletion drops the backup", async () => {
    seedOldCiphertext();
    // Simulate the committed state: new ciphertext at the real path, new row,
    // backup still present (the process died before commitReuploadBackup).
    await stageReuploadBackup(HASH);
    state.sourceSize = NEW_SIZE;
    const info = await encryptionInfoFor(HASH, URI);
    await db.attachments.add({
      ...info,
      // Runtime cleared marker is `null`; the shared `Attachment` type only
      // allows `number | undefined`, so widen the value, not the behavior.
      dateUploaded: null as unknown as number | undefined
    });
    expect(files.has(BACKUP_PATH)).toBe(true);

    await reconcileAllReuploadBackups();

    // The real ciphertext matches the committed row, so the stale backup goes.
    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(files.has(REAL_PATH)).toBe(true);
    expect(unlinked).toContain(BACKUP_PATH);
  });

  test("crash before the commit restores the backup over the half-written ciphertext", async () => {
    seedOldCiphertext();
    await stageReuploadBackup(HASH);
    state.sourceSize = NEW_SIZE;
    // Encrypt wrote the new ciphertext but the row was never committed.
    await encryptionInfoFor(HASH, URI);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });

    await reconcileReuploadBackup(HASH);

    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: OLD_SIZE
    });
    // `mv` cannot overwrite, so the half-written new bytes are unlinked before
    // the backup is moved back into place (in that order).
    expect(idx("unlink:" + REAL_PATH) < idx(`mv:${BACKUP_PATH}->${REAL_PATH}`)).toBe(
      true
    );
  });

  test("keeps both copies and never unlinks the real ciphertext when the state is ambiguous", async () => {
    seedOldCiphertext();
    await stageReuploadBackup(HASH);
    // Same size as the old row: both the backup and the real file match it.
    state.sourceSize = OLD_SIZE;
    await encryptionInfoFor(HASH, URI);

    await reconcileReuploadBackup(HASH);

    expect(files.has(REAL_PATH)).toBe(true);
    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(unlinked).not.toContain(REAL_PATH);
    expect(unlinked).not.toContain(BACKUP_PATH);
  });

  test("keeps both copies when neither can be decrypted", async () => {
    seedOldCiphertext();
    await stageReuploadBackup(HASH);
    state.sourceSize = NEW_SIZE;
    await encryptionInfoFor(HASH, URI);
    state.decryptThrows = true;

    await expect(reconcileReuploadBackup(HASH)).resolves.toBeUndefined();

    expect(files.has(REAL_PATH)).toBe(true);
    expect(files.has(BACKUP_PATH)).toBe(true);
  });

  test("keeps an orphaned backup when there is no attachment row to reconcile against", async () => {
    files.add(BACKUP_PATH);
    cipher.set(BACKUP_PATH, { plainHash: HASH, plainSize: OLD_SIZE });

    await reconcileReuploadBackup(HASH);

    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(unlinked).not.toContain(BACKUP_PATH);
  });

  test("restore and commit never throw and never unlink the backup on failure", async () => {
    seedOldCiphertext();
    await stageReuploadBackup(HASH);
    fs.mv.mockRejectedValueOnce(new Error("mv failed"));

    await expect(restoreReuploadBackup(HASH)).resolves.toBeUndefined();

    // The backup was not consumed by the failed restore; it is still present.
    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(unlinked).not.toContain(BACKUP_PATH);

    fs.unlink.mockRejectedValueOnce(new Error("unlink failed"));
    await expect(commitReuploadBackup(HASH)).resolves.toBeUndefined();
  });
});

describe("concurrent reconcile/read during an in-flight Apple reupload", () => {
  // Regression: `readEncrypted()` (reachable concurrently from core's
  // `attachments.read()`) used to reconcile unconditionally. Landing in the
  // reupload window it would see the freshly written new ciphertext as invalid
  // against the still-old row and restore the backup over it, producing exactly
  // the new-metadata/old-bytes split the protocol exists to prevent. The read
  // path and the startup sweep must instead fail closed while a reupload is in
  // flight.
  test("reconcile, the startup sweep and readEncrypted all fail closed in flight", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    const release = deferNextAdd();

    const reupload = performAppleReupload(HASH, URI, "image/png", "p.png", "url");
    // Wait until the reupload has staged, encrypted and reached the deferred
    // row commit: the in-flight window.
    await waitFor(() => order.includes("add"));
    expect(isReuploadInFlight(HASH)).toBe(true);
    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });

    // A concurrent reconcile (e.g. the startup sweep) must not restore the old
    // backup over the just-written new ciphertext.
    await reconcileReuploadBackup(HASH);
    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });

    await reconcileAllReuploadBackups();
    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });

    // The read path reconciles too, but must skip it in flight.
    await readEncrypted(HASH, {} as never, { outputType: "text" } as never);
    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });

    release();
    await reupload;

    // The commit resolved, so the backup is dropped and the new ciphertext
    // remains: the row and the bytes agree.
    expect(isReuploadInFlight(HASH)).toBe(false);
    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });
  });

  test("readEncrypted reconciles a leftover backup when no reupload is in flight", async () => {
    seedOldCiphertext();
    await stageReuploadBackup(HASH);
    state.sourceSize = NEW_SIZE;
    // New ciphertext at the real path, row still describes the old one.
    await encryptionInfoFor(HASH, URI);
    expect(files.has(BACKUP_PATH)).toBe(true);

    await readEncrypted(HASH, {} as never, { outputType: "text" } as never);

    // Backup matched the row, real did not -> restored, backup consumed.
    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: OLD_SIZE
    });
  });
});

describe("Apple reupload critical corrections", () => {
  test("no staged backup: a failed attempt discards only the new cacheDir ciphertext", async () => {
    // A row exists but there is no local ciphertext to preserve, so staging is
    // a no-op (returns false). A legacy copy is present and must survive.
    rows[HASH] = {
      id: "row-1",
      hash: HASH,
      key: {},
      iv: "old-iv",
      salt: "old-salt",
      size: OLD_SIZE,
      chunkSize: CHUNK_SIZE,
      hashType: "xxh64"
    };
    files.add(`/cache-old/${HASH}`);
    state.sourceSize = NEW_SIZE;
    state.encryptPlainHash = "0000000000000000"; // verification will fail

    await expect(
      performAppleReupload(HASH, URI, "image/png", "p.png", "url")
    ).rejects.toThrow(/verification/i);

    // Only the newly written real-path bytes are removed...
    expect(unlinked).toContain(REAL_PATH);
    expect(files.has(REAL_PATH)).toBe(false);
    // ...the legacy copy and any backup are untouched, no remote delete.
    expect(files.has(`/cache-old/${HASH}`)).toBe(true);
    expect(unlinked).not.toContain(`/cache-old/${HASH}`);
    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(fs.mv).not.toHaveBeenCalled();
    expect(deleteFileMock).not.toHaveBeenCalled();
    // The old row is untouched, so it is not shadowed by a new ciphertext.
    expect(rows[HASH].size).toBe(OLD_SIZE);
    expect(rows[HASH].iv).toBe("old-iv");
  });

  test("size 0 metadata is rejected before the row write and the backup is restored", async () => {
    seedOldCiphertext();
    state.sourceSize = 0;

    await expect(
      performAppleReupload(HASH, URI, "image/png", "p.png", "url")
    ).rejects.toThrow(/metadata is incomplete/i);

    expect(addMock).not.toHaveBeenCalled();
    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: OLD_SIZE
    });
  });

  test("add() returning undefined is a failed commit and restores the backup", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    addMock.mockImplementationOnce(async () => {
      order.push("add");
      return undefined; // e.g. a required field was falsy: no row written
    });

    await expect(
      performAppleReupload(HASH, URI, "image/png", "p.png", "url")
    ).rejects.toThrow(/Could not commit/i);

    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: OLD_SIZE
    });
    expect(rows[HASH].iv).toBe("old-iv");
  });

  test("add() returning an id without persisting is caught by the read-back", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    // `SQLCollection.upsert` silently no-ops when the sanitizer rejects the
    // item, but `add()` still returns the id.
    addMock.mockImplementationOnce(async (item: Record<string, unknown>) => {
      order.push("add");
      return item.hash;
    });

    await expect(
      performAppleReupload(HASH, URI, "image/png", "p.png", "url")
    ).rejects.toThrow(/was not committed/i);

    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: OLD_SIZE
    });
    expect(rows[HASH].iv).toBe("old-iv");
  });

  test("a throwing read-back keeps both the backup and the new ciphertext", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    // The commit write itself succeeds, but confirming it cannot be read.
    attachmentMock.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      performAppleReupload(HASH, URI, "image/png", "p.png", "url")
    ).rejects.toThrow(/Could not confirm/i);

    // Ambiguous: neither copy may be unlinked, for later reconciliation.
    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });
    expect(unlinked).not.toContain(BACKUP_PATH);
    expect(unlinked).not.toContain(REAL_PATH);
  });

  test("failed:null and dateUploaded:null are committed together and read back cleared", async () => {
    seedOldCiphertext();
    rows[HASH].failed = MISSING_LOCAL_CIPHERTEXT_ERROR;
    state.sourceSize = NEW_SIZE;

    await performAppleReupload(HASH, URI, "image/png", "p.png", "url");

    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: HASH,
        dateUploaded: null,
        failed: null
      })
    );
    // The recovered row is queued for upload instead of being skipped.
    expect(rows[HASH].dateUploaded).toBeNull();
    expect(rows[HASH].failed).toBeNull();
  });

  test("a concurrent markAsFailed between add and confirm never restores the old ciphertext", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    // An earlier background upload of the reused row writes a failure marker
    // between the reupload's `add()` and its read-back confirm. The read-back
    // must still recognize the new crypto as committed (status is transient)
    // and reconcile the stale marker away.
    addMock.mockImplementationOnce(async (item: Record<string, unknown>) => {
      order.push("add");
      rows[HASH] = { ...(rows[HASH] || {}), ...item };
      rows[HASH].failed = "Failed to upload attachment.";
      return item.hash;
    });

    await performAppleReupload(HASH, URI, "image/png", "p.png", "url");

    // The old bytes are NEVER restored over the committed new ciphertext.
    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(unlinked).toContain(BACKUP_PATH);
    expect(unlinked).not.toContain(REAL_PATH);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });
    // The new crypto survives; the stale status is reconciled to pending.
    expect(rows[HASH].iv).toBe("new-iv");
    expect(rows[HASH].size).toBe(NEW_SIZE);
    expect(rows[HASH].failed).toBeNull();
    expect(rows[HASH].dateUploaded).toBeNull();
    expect(markReuploadConfirmedMock).toHaveBeenCalledWith("row-1");
  });

  test("a concurrent markAsUploaded between add and confirm keeps the new ciphertext pending", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    // An earlier upload reports success for the reused row id mid-commit; the
    // new ciphertext has not actually been uploaded, so `dateUploaded` must be
    // reconciled back to pending instead of letting the stale success suppress
    // the upload.
    addMock.mockImplementationOnce(async (item: Record<string, unknown>) => {
      order.push("add");
      rows[HASH] = { ...(rows[HASH] || {}), ...item };
      rows[HASH].dateUploaded = Date.now();
      return item.hash;
    });

    await performAppleReupload(HASH, URI, "image/png", "p.png", "url");

    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });
    expect(rows[HASH].dateUploaded).toBeNull();
    expect(rows[HASH].failed).toBeNull();
    expect(rows[HASH].iv).toBe("new-iv");
  });

  test("a status reconcile failure cannot restore the old ciphertext", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    // The crypto commit succeeds but the status reconcile rejects. Because the
    // new metadata is already committed, propagating that failure into the
    // restore path would pair the new row with the old bytes.
    markReuploadConfirmedMock.mockRejectedValueOnce(
      new Error("status update failed")
    );

    await expect(
      performAppleReupload(HASH, URI, "image/png", "p.png", "url")
    ).resolves.toBeDefined();

    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: NEW_SIZE
    });
    expect(rows[HASH].iv).toBe("new-iv");
  });

  test("restore unlinks an existing real path before the non-overwriting move", async () => {
    seedOldCiphertext();
    await stageReuploadBackup(HASH); // real path -> backup
    // Partial new bytes left at the real path by a failed attempt.
    files.add(REAL_PATH);
    cipher.set(REAL_PATH, { plainHash: HASH, plainSize: NEW_SIZE });

    await restoreReuploadBackup(HASH);

    expect(files.has(BACKUP_PATH)).toBe(false);
    expect(cipher.get(REAL_PATH)).toEqual({
      plainHash: HASH,
      plainSize: OLD_SIZE
    });
    expect(
      idx("unlink:" + REAL_PATH) < idx(`mv:${BACKUP_PATH}->${REAL_PATH}`)
    ).toBe(true);
  });

  test("restore keeps the backup when the move fails over an existing real path", async () => {
    seedOldCiphertext();
    await stageReuploadBackup(HASH);
    files.add(REAL_PATH);
    cipher.set(REAL_PATH, { plainHash: HASH, plainSize: NEW_SIZE });
    fs.mv.mockRejectedValueOnce(new Error("mv failed"));

    await expect(restoreReuploadBackup(HASH)).resolves.toBeUndefined();

    expect(files.has(BACKUP_PATH)).toBe(true);
    expect(unlinked).not.toContain(BACKUP_PATH);
  });
});

describe("Apple staging is a no-op on Android", () => {
  test("stage/reconcile do nothing on Android and never move the ciphertext", async () => {
    setPlatform("android");
    seedOldCiphertext();
    files.add(BACKUP_PATH);
    cipher.set(BACKUP_PATH, { plainHash: HASH, plainSize: OLD_SIZE });

    await expect(stageReuploadBackup(HASH)).resolves.toBe(false);
    await reconcileReuploadBackup(HASH);

    expect(fs.mv).not.toHaveBeenCalled();
    expect(files.has(REAL_PATH)).toBe(true);
    expect(files.has(BACKUP_PATH)).toBe(true);
  });
});

describe("attachFile Apple reupload (end to end)", () => {
  const options = { reupload: true, hash: HASH } as never;

  test("never remote-deletes, stages before encrypting and commits before dropping the backup", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;

    const result = await attachFile(URI, HASH, "image/png", "p.png", options);

    expect(result).toBe(true);
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(fs.mv).toHaveBeenCalledWith(REAL_PATH, BACKUP_PATH);
    expect(idx("mv:" + REAL_PATH) < idx("encrypt")).toBe(true);
    expect(idx("add") < idx("unlink:" + BACKUP_PATH)).toBe(true);
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({ hash: HASH, dateUploaded: null })
    );
  });

  test("returns false and restores the old ciphertext when the row commit fails", async () => {
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;
    state.addThrows = true;

    const result = await attachFile(URI, HASH, "image/png", "p.png", options);

    expect(result).toBe(false);
    expect(files.has(REAL_PATH)).toBe(true);
    expect(cipher.get(REAL_PATH)).toEqual({ plainHash: HASH, plainSize: OLD_SIZE });
    expect(files.has(BACKUP_PATH)).toBe(false);
  });

  test("Android keeps the delete-first behavior unchanged", async () => {
    setPlatform("android");
    seedOldCiphertext();
    state.sourceSize = NEW_SIZE;

    const result = await attachFile(URI, HASH, "image/png", "p.png", options);

    expect(result).toBe(true);
    expect(deleteFileMock).toHaveBeenCalledWith(HASH, false);
    expect(fs.mv).not.toHaveBeenCalledWith(REAL_PATH, BACKUP_PATH);
    expect(resetMock).toHaveBeenCalled();
  });
});
