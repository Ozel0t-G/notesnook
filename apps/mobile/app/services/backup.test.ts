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

type Attachment = { hash: string; dateUploaded?: number };
type BackupEntry =
  | { type: "file"; path: string; data: string }
  | { type: "attachment"; hash: string };
let mockAttachments: Attachment[] = [];
let mockLocalFiles = new Set<string>();
let mockExportFiles: BackupEntry[] = [];
let mockExportGate: Promise<void> | undefined;
const mockCopy = jest.fn(async () => {});
const mockMkdir = jest.fn(async () => {});
const mockZip = jest.fn(async () => {});
const mockCheckAndCreateDir = jest.fn(async () => "/safe-backups");
const mockExport = jest.fn(() =>
  (async function* () {
    await mockExportGate;
    for (const file of mockExportFiles) yield file;
  })()
);
const mockSettingsSet = jest.fn();

jest.mock("@notesnook/common", () => ({
  sanitizeFilename: (name: string) => name
}));
jest.mock("@notesnook/core", () => ({ formatDate: () => "2026-09-28" }));
jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_, key) => () => String(key) })
}));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("react-native-blob-util", () => ({
  __esModule: true,
  default: {
    fs: {
      unlink: jest.fn(async () => {}),
      mkdir: (...args: unknown[]) => mockMkdir(...(args as [])),
      cp: (...args: unknown[]) => mockCopy(...(args as [])),
      writeFile: jest.fn(async () => {})
    }
  }
}));
jest.mock("react-native-file-viewer", () => ({
  __esModule: true,
  default: {}
}));
jest.mock("react-native-scoped-storage", () => ({}));
jest.mock("react-native-share", () => ({ __esModule: true, default: {} }));
jest.mock("react-native-zip-archive", () => ({
  zip: (...args: unknown[]) => mockZip(...(args as []))
}));
jest.mock("../common/database", () => ({
  DatabaseLogger: { info: jest.fn(), error: jest.fn() },
  db: {
    user: { getUser: jest.fn(async () => ({ id: "qa-account" })) },
    attachments: {
      all: {
        iterate: () =>
          (async function* () {
            for (const attachment of mockAttachments) yield attachment;
          })()
      }
    },
    backup: { export: (...args: unknown[]) => mockExport(...(args as [])) }
  }
}));
jest.mock("../common/filesystem", () => ({
  __esModule: true,
  default: {
    checkAndCreateDir: (...args: unknown[]) =>
      mockCheckAndCreateDir(...(args as []))
  },
  FileStorage: { exists: async (hash: string) => mockLocalFiles.has(hash) }
}));
jest.mock("../common/filesystem/utils", () => ({
  cacheDir: "/cache",
  copyFileAsync: jest.fn()
}));
jest.mock("../common/filesystem/io", () => ({
  getCachePathForFile: async (hash: string) => `/local/${hash}`
}));
jest.mock("../components/dialog/functions", () => ({
  presentDialog: jest.fn()
}));
jest.mock("../components/dialogs/progress", () => ({
  endProgress: jest.fn(),
  startProgress: jest.fn(),
  updateProgress: jest.fn()
}));
jest.mock("../utils/events", () => ({ eCloseSheet: "close-sheet" }));
jest.mock("../utils/time", () => ({ sleep: jest.fn(async () => {}) }));
jest.mock("./event-manager", () => ({
  ToastManager: { error: jest.fn(), show: jest.fn() },
  eSendEvent: jest.fn(),
  presentSheet: jest.fn()
}));
jest.mock("./settings", () => ({
  __esModule: true,
  default: {
    get: () => ({ encryptedBackup: true }),
    set: (...args: unknown[]) => mockSettingsSet(...args),
    setProperty: jest.fn()
  }
}));

import BackupService from "./backup";

async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
function strictBackup() {
  return BackupService.run(false, "local", "full", {
    requireLocalAttachments: true
  });
}

describe("saved backup gate for destructive VeyraN sign-out", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAttachments = [{ hash: "local-file" }];
    mockLocalFiles = new Set(["local-file"]);
    mockExportFiles = [
      { type: "file", path: "notes.json", data: "encrypted notes" },
      { type: "attachment", hash: "local-file" }
    ];
    mockExportGate = undefined;
    mockCopy.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockZip.mockResolvedValue(undefined);
    mockCheckAndCreateDir.mockResolvedValue("/safe-backups");
  });

  it("reports success only after all local attachment bytes are copied and zip is saved", async () => {
    const result = await strictBackup();
    expect(result.error).toBeUndefined();
    expect(result.path).toMatch(/^\/safe-backups\/.+\.nnbackupz$/);
    expect(mockCopy).toHaveBeenCalledWith(
      "/local/local-file",
      "/cache/backup_temp/attachments/local-file"
    );
    expect(mockZip).toHaveBeenCalledTimes(1);
    expect(mockExport).toHaveBeenCalledWith({
      type: "mobile",
      encrypt: true,
      mode: "full"
    });
    expect(mockSettingsSet).toHaveBeenCalled();
  });

  it("native copy failure cannot produce a saved-backup result and releases the lock", async () => {
    const copyFailure = new Error("native attachment copy failed");
    mockCopy.mockRejectedValueOnce(copyFailure);
    const failed = await strictBackup();
    expect(failed).toMatchObject({ error: copyFailure });
    expect(failed.path).toBeUndefined();
    expect(mockZip).not.toHaveBeenCalled();
    expect((await strictBackup()).path).toBeDefined();
  });

  it("refuses success when core export omits a file that exists locally", async () => {
    mockExportFiles = [
      { type: "file", path: "notes.json", data: "encrypted notes" }
    ];
    const result = await strictBackup();
    expect(result.error?.message).toBe("backupLocalAttachmentMissing");
    expect(result.path).toBeUndefined();
    expect(mockZip).not.toHaveBeenCalled();
  });

  it("refuses an unsynced attachment with missing local bytes before exporting", async () => {
    mockLocalFiles.clear();
    const result = await strictBackup();
    expect(result.error?.message).toBe("backupLocalAttachmentMissing");
    expect(result.path).toBeUndefined();
    expect(mockExport).not.toHaveBeenCalled();
    expect(mockZip).not.toHaveBeenCalled();
  });

  it("permits an already-uploaded remote-only attachment without fabricating local bytes", async () => {
    mockAttachments = [{ hash: "remote-file", dateUploaded: 1 }];
    mockLocalFiles.clear();
    mockExportFiles = [
      { type: "file", path: "notes.json", data: "encrypted notes" }
    ];
    const result = await strictBackup();
    expect(result.error).toBeUndefined();
    expect(result.path).toBeDefined();
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it("preflight rejection releases the backup lock so the next attempt can save", async () => {
    const preflightFailure = new Error("backup folder unavailable");
    mockCheckAndCreateDir.mockRejectedValueOnce(preflightFailure);
    const failed = await strictBackup();
    expect(failed.error).toBe(preflightFailure);
    expect(failed.path).toBeUndefined();
    expect(mockExport).not.toHaveBeenCalled();
    expect((await strictBackup()).path).toBeDefined();
  });

  it("concurrent rejected attempts cannot clear the active backup lock", async () => {
    let release: () => void = () => {};
    mockExportGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = strictBackup();
    await flush();
    const rejected = await strictBackup();
    expect(rejected.error?.message).toBe("backupFailed");
    expect(rejected.path).toBeUndefined();
    const alsoRejected = await strictBackup();
    expect(alsoRejected.error?.message).toBe("backupFailed");
    expect(mockExport).toHaveBeenCalledTimes(1);
    expect(mockZip).not.toHaveBeenCalled();
    release();
    expect((await active).path).toBeDefined();
    expect((await strictBackup()).path).toBeDefined();
    expect(mockExport).toHaveBeenCalledTimes(2);
  });

  it("strict attachment protection cannot silently downgrade to partial backup", async () => {
    const result = await BackupService.run(false, "local", "partial", {
      requireLocalAttachments: true
    });
    expect(result.error?.message).toBe("backupFailed");
    expect(result.path).toBeUndefined();
    expect(mockZip).not.toHaveBeenCalled();
  });

  it("zip failure never returns a usable backup path", async () => {
    const zipFailure = new Error("disk full");
    mockZip.mockRejectedValueOnce(zipFailure);
    const result = await strictBackup();
    expect(result.error).toBe(zipFailure);
    expect(result.path).toBeUndefined();
  });
});
