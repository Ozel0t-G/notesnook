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

import hosts from "../utils/constants.js";
import TokenManager from "../api/token-manager.js";
import {
  FileEncryptionMetadataWithOutputType,
  IFileStorage
} from "../interfaces.js";
import { DataFormat, SerializedKey } from "@notesnook/crypto";
import { EVENTS } from "../common.js";
import { logger } from "../logger.js";
import EventManager from "../utils/event-manager.js";
import { assertCredentialDestination } from "../utils/credential-host-binding.js";

export type FileStorageAccessor = () => FileStorage;

/**
 * Snapshot of the attachment crypto columns that identify one ciphertext
 * *generation* of an attachment row.
 *
 * An explicit Apple Reupload reuses the same attachment row id and hash but
 * writes fresh `iv`/`salt`/`size`/`chunkSize` metadata for the newly encrypted
 * ciphertext. Carrying this snapshot from the upload's pending snapshot through
 * `queueUploads` to `Attachments.fileUploaded` lets the status write be guarded
 * atomically (SQL `WHERE` clause) against the row's *current* crypto, so a late
 * result of a pre-reupload upload can never mark the new generation uploaded or
 * failed.
 *
 * Every field is nullable because legacy rows/sync merges may not carry all of
 * them; a null snapshot value matches SQL `IS NULL`.
 */
export type AttachmentGeneration = {
  iv: string | null;
  salt: string | null;
  size: number | null;
  chunkSize: number | null;
};

export type DownloadableFile = {
  filename: string;
  chunkSize: number;
  /**
   * Uploads only: the crypto generation the upload was queued for. `undefined`
   * (legacy/manual producers) means no generation guard is applied and the
   * completion behaves exactly as before.
   */
  generation?: AttachmentGeneration;
};
export type QueueItem = DownloadableFile & {
  cancel?: (reason?: string) => Promise<void>;
  operation?: Promise<boolean>;
  error?: unknown;
};

export class FileStorage {
  id = Date.now();
  private syncUploadCancellationVersion = 0;
  downloads = new Map<string, QueueItem>();
  uploads = new Map<string, QueueItem>();
  groups = {
    downloads: new Map<string, Set<string>>(),
    uploads: new Map<string, Set<string>>()
  };

  constructor(
    private readonly fs: IFileStorage,
    private readonly tokenManager: TokenManager,
    private readonly eventManager: EventManager
  ) {}

  async queueDownloads(
    files: DownloadableFile[],
    groupId: string,
    eventData?: Record<string, unknown>
  ) {
    try {
      const newFiles = await this.fs.bulkExists(files.map((f) => f.filename));
      files = files.filter((f) => newFiles.includes(f.filename));
      if (files.length <= 0) return;

      let current = 0;
      const token = await this.tokenManager.getAccessToken();
      const total = files.length;

      if (this.groups.downloads.has(groupId)) {
        logger.debug("[queueDownloads] group already exists", {
          groupId
        });
        return this.groups.downloads.get(groupId);
      }

      const group = new Set<string>();

      files.forEach((f) => group.add(f.filename));
      this.groups.downloads.set(groupId, group);

      for (const file of files as QueueItem[]) {
        current++;
        if (!group.has(file.filename)) {
          this.eventManager.publish(EVENTS.fileDownloaded, {
            success: false,
            groupId,
            filename: file.filename,
            eventData,
            current,
            total
          });
          continue;
        }

        const download = this.downloads.get(file.filename);
        if (download && download.operation) {
          logger.debug("[queueDownloads] duplicate download", {
            filename: file.filename,
            groupId
          });
          await download.operation;
          continue;
        }

        const { filename, chunkSize } = file;
        if (await this.exists(filename)) {
          this.eventManager.publish(EVENTS.fileDownloaded, {
            success: true,
            groupId,
            filename,
            eventData,
            current,
            total
          });
          continue;
        }

        this.eventManager.publish(EVENTS.fileDownload, {
          total,
          current,
          groupId,
          filename
        });

        const url = `${hosts.API_HOST}/s3?name=${filename}`;
        assertCredentialDestination(token, url);
        const { execute, cancel } = this.fs.downloadFile(filename, {
          url,
          chunkSize,
          headers: { Authorization: `Bearer ${token}` }
        });
        file.cancel = cancel;
        file.operation = execute()
          .catch(() => false)
          .finally(() => {
            this.downloads.delete(filename);
            group.delete(filename);
          });

        this.downloads.set(filename, file);
        const result = await file.operation;
        if (eventData)
          this.eventManager.publish(EVENTS.fileDownloaded, {
            success: result,
            total,
            current,
            groupId,
            filename,
            eventData
          });
      }
    } finally {
      this.groups.downloads.delete(groupId);
    }
  }

  async queueUploads(files: DownloadableFile[], groupId: string) {
    const cancellationVersion = this.syncUploadCancellationVersion;
    try {
      let current = 0;
      const token = await this.tokenManager.getAccessToken();
      if (
        groupId === "sync-uploads" &&
        cancellationVersion !== this.syncUploadCancellationVersion
      )
        return;
      const total = files.length;

      if (this.groups.uploads.has(groupId)) {
        logger.debug("[queueUploads] group already exists", {
          groupId
        });
        return this.groups.uploads.get(groupId);
      }

      const group = new Set<string>();

      files.forEach((f) => group.add(f.filename));
      this.groups.uploads.set(groupId, group);

      for (const file of files as QueueItem[]) {
        if (
          groupId === "sync-uploads" &&
          cancellationVersion !== this.syncUploadCancellationVersion
        )
          return;
        if (!group.has(file.filename)) continue;

        const upload = this.uploads.get(file.filename);
        if (upload && upload.operation) {
          logger.debug("[queueUploads] duplicate upload", {
            filename: file.filename,
            groupId
          });
          const operation = upload.operation;
          const result = await operation;
          await this.eventManager.publishWithResult(EVENTS.fileUploaded, {
            error: upload.error,
            success: result,
            total,
            current: ++current,
            groupId,
            filename: file.filename,
            // The bytes this operation uploaded are the ones it read when it
            // started, described by the *in-flight* queue item's generation —
            // not this duplicate request's, which may already describe a newer
            // generation (e.g. an Apple Reupload committed while the earlier
            // upload was running).
            generation: upload.generation
          });
          continue;
        }

        const { filename, chunkSize, generation } = file;
        let error = null;
        const url = `${hosts.API_HOST}/s3?name=${filename}`;
        assertCredentialDestination(token, url);
        const { execute, cancel } = this.fs.uploadFile(filename, {
          chunkSize,
          url,
          headers: { Authorization: `Bearer ${token}` }
        });
        file.cancel = cancel;
        file.operation = execute()
          .catch((e) => {
            logger.error(e, "failed to upload attachment", { hash: filename });
            // Normalize the thrown value into a string so consumers (e.g.
            // `Attachments.fileUploaded`) can persist a stable reason and the
            // duplicate group below republishes the exact same reason.
            const reason = e instanceof Error ? e.message : String(e);
            error = reason;
            file.error = reason;
            return false;
          })
          .finally(() => {
            this.uploads.delete(filename);
            group.delete(filename);
          });

        this.eventManager.publish(EVENTS.fileUpload, {
          total,
          current,
          groupId,
          filename
        });

        this.uploads.set(filename, file);
        const result = await file.operation;
        await this.eventManager.publishWithResult(EVENTS.fileUploaded, {
          error,
          success: result,
          total,
          current: ++current,
          groupId,
          filename,
          // The generation this upload was queued for. Consumers guard the
          // status write with it so a late result of a pre-reupload upload
          // cannot touch the row once its crypto has been replaced.
          generation
        });
      }
    } finally {
      this.groups.uploads.delete(groupId);
    }
  }

  async downloadFile(groupId: string, filename: string, chunkSize: number) {
    if (await this.exists(filename)) return true;

    const download = this.downloads.get(filename);
    if (download && download.operation) {
      logger.debug("[downloadFile] duplicate download", { filename, groupId });
      return await download.operation;
    }

    logger.debug("[downloadFile] downloading", { filename, groupId });

    const url = `${hosts.API_HOST}/s3?name=${filename}`;
    const file: QueueItem = { filename, chunkSize };
    const token = await this.tokenManager.getAccessToken();
    const group = this.groups.downloads.get(groupId) || new Set();
    assertCredentialDestination(token, url);
    const { execute, cancel } = this.fs.downloadFile(filename, {
      url,
      chunkSize,
      headers: { Authorization: `Bearer ${token}` }
    });
    file.cancel = cancel;
    file.operation = execute().finally(() => {
      this.downloads.delete(filename);
      group.delete(filename);
    });

    this.downloads.set(filename, file);
    this.groups.downloads.set(groupId, group.add(filename));
    return await file.operation;
  }

  async cancel(groupId: string) {
    // Invalidate a sync upload even if it is still awaiting a token and has
    // not yet created a group for cancel() to find.
    if (groupId === "sync-uploads") this.syncUploadCancellationVersion++;
    const queues = [
      {
        type: "download",
        ids: this.groups.downloads.get(groupId),
        files: this.downloads
      },
      {
        type: "upload",
        ids: this.groups.uploads.get(groupId),
        files: this.uploads
      }
    ].filter((a) => !!a.ids);

    for (const queue of queues) {
      if (!queue.ids) continue;

      for (const filename of queue.ids) {
        const file = queue.files.get(filename);
        if (file?.cancel) await file.cancel("Operation canceled.");
        queue.ids.delete(filename);
      }

      if (queue.type === "download") {
        this.groups.downloads.delete(groupId);
        this.eventManager.publish(EVENTS.downloadCanceled, {
          groupId,
          canceled: true
        });
      } else if (queue.type === "upload") {
        this.groups.uploads.delete(groupId);
        this.eventManager.publish(EVENTS.uploadCanceled, {
          groupId,
          canceled: true
        });
      }
    }
  }

  readEncrypted<TOutputFormat extends DataFormat>(
    filename: string,
    encryptionKey: SerializedKey,
    cipherData: FileEncryptionMetadataWithOutputType<TOutputFormat>
  ) {
    return this.fs.readEncrypted(filename, encryptionKey, cipherData);
  }

  writeEncryptedBase64(
    data: string,
    encryptionKey: SerializedKey,
    mimeType: string
  ) {
    return this.fs.writeEncryptedBase64(data, encryptionKey, mimeType);
  }

  async deleteFile(filename: string, localOnly = false) {
    if (localOnly) return await this.fs.deleteFile(filename);

    const token = await this.tokenManager.getAccessToken();
    const url = `${hosts.API_HOST}/s3?name=${filename}`;
    assertCredentialDestination(token, url);
    return await this.fs.deleteFile(filename, {
      url,
      headers: { Authorization: `Bearer ${token}` },
      chunkSize: 0
    });
  }

  async bulkDeleteFiles(filenames: string[], localOnly = false) {
    if (filenames.length === 0) return true;

    if (localOnly) return await this.fs.bulkDeleteFiles(filenames);

    const token = await this.tokenManager.getAccessToken();
    const url = `${hosts.API_HOST}/s3/bulk-delete`;
    assertCredentialDestination(token, url);
    return await this.fs.bulkDeleteFiles(filenames, {
      url,
      headers: { Authorization: `Bearer ${token}` },
      chunkSize: 0
    });
  }

  exists(filename: string) {
    return this.fs.exists(filename);
  }

  clear() {
    return this.fs.clearFileStorage();
  }

  hashBase64(data: string) {
    return this.fs.hashBase64(data);
  }

  getUploadedFileSize(filename: string) {
    return this.fs.getUploadedFileSize(filename);
  }
}
