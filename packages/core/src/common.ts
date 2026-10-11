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

import EventManager from "./utils/event-manager.js";

export const EV = new EventManager();

export const SYNC_CHECK_IDS = {
  autoSync: "autoSync",
  sync: "sync"
};

export type SyncStatusEvent = keyof typeof SYNC_CHECK_IDS;

export async function checkSyncStatus(
  eventManager: EventManager,
  type: string
) {
  const results = await eventManager.publishWithResult<{
    type: string;
    result: boolean;
  }>(EVENTS.syncCheckStatus, type);
  if (typeof results === "boolean") return results;
  else if (typeof results === "undefined") return true;
  return results.some((r) => r.type === type && r.result === true);
}

export type SyncProgressEvent = {
  type: "upload" | "download";
  current: number;
};

export function sendSyncProgressEvent(
  eventManager: EventManager,
  type: string,
  current: number
) {
  eventManager.publish(EVENTS.syncProgress, {
    type,
    current
  } as SyncProgressEvent);
}

export function sendMigrationProgressEvent(
  eventManager: EventManager,
  collection: string,
  total: number,
  current?: number
) {
  eventManager.publish(EVENTS.migrationProgress, {
    collection,
    total,
    current: current === undefined ? total : current
  });
}

export const CLIENT_ID = "notesnook";

/**
 * Stable, human-readable error message used when the local encrypted
 * ciphertext for an attachment is confirmed to be missing and cannot be
 * recovered from this device.
 *
 * Clients (e.g. mobile) throw `new Error(MISSING_LOCAL_CIPHERTEXT_ERROR)`
 * from their file upload implementation. Core normalizes that error into this
 * exact string, persists it in `attachments.failed`, and later sync runs skip
 * re-queueing such attachments unless the local ciphertext reappears.
 *
 * This string is persisted verbatim and matched by strict equality, so it
 * must never change once shipped.
 */
export const MISSING_LOCAL_CIPHERTEXT_ERROR =
  "Attachment data is missing on this device and cannot be uploaded.";

/**
 * Returns true when the given value represents the terminal
 * {@link MISSING_LOCAL_CIPHERTEXT_ERROR} condition. Accepts both the raw
 * message string (as published/persisted by core) and an `Error` carrying it.
 */
export function isMissingLocalCiphertextError(error: unknown): boolean {
  if (typeof error === "string")
    return error === MISSING_LOCAL_CIPHERTEXT_ERROR;
  if (error instanceof Error)
    return error.message === MISSING_LOCAL_CIPHERTEXT_ERROR;
  return false;
}

/**
 * Stable, human-readable error message used when the local encrypted
 * ciphertext for an attachment is *present but invalid* (zero bytes, or it
 * fails the upload preflight) and the authenticated remote repair could not
 * produce a usable copy on this device.
 *
 * This is distinct from {@link MISSING_LOCAL_CIPHERTEXT_ERROR}: the bytes are
 * still on disk, so a raw presence check (`fs().exists()`) reports them as
 * present even though they cannot be used. Core therefore backs off this
 * marker purely from `dateModified` (a bounded retry window) and must **not**
 * clear it merely because the file exists, which would otherwise re-run the
 * (network-bound) repair download on every sync.
 *
 * Clients (e.g. mobile) throw `new Error(LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR)`
 * from their file upload implementation. Core normalizes that error into this
 * exact string and persists it in `attachments.failed`. A successful upload, a
 * manual Retry or a Reupload clears it exactly like the missing marker.
 *
 * This string is persisted verbatim and matched by strict equality, so it
 * must never change once shipped.
 */
export const LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR =
  "Attachment data on this device is damaged and could not be repaired automatically.";

/**
 * Returns true when the given value represents the terminal
 * {@link LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR} condition. Accepts both the raw
 * message string (as published/persisted by core) and an `Error` carrying it.
 */
export function isLocalCiphertextRepairFailedError(error: unknown): boolean {
  if (typeof error === "string")
    return error === LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR;
  if (error instanceof Error)
    return error.message === LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR;
  return false;
}

export const EVENTS = {
  userSubscriptionUpdated: "user:subscriptionUpdated",
  userEmailConfirmed: "user:emailConfirmed",
  userLoggedIn: "user:loggedIn",
  userLoggedOut: "user:loggedOut",
  userFetched: "user:fetched",
  userSignedUp: "user:signedUp",
  userSessionExpired: "user:sessionExpired",
  backendRecoveryStarted: "backend:recoveryStarted",
  databaseSyncRequested: "db:syncRequested",
  syncProgress: "sync:progress",
  syncCompleted: "sync:completed",
  syncItemMerged: "sync:itemMerged",
  syncAborted: "sync:aborted",
  syncCheckStatus: "sync:checkStatus",
  databaseUpdated: "db:updated",
  databaseCollectionInitiated: "db:collectionInitiated",
  appRefreshRequested: "app:refreshRequested",
  migrationProgress: "migration:progress",
  migrationStarted: "migration:start",
  migrationFinished: "migration:finished",
  noteRemoved: "note:removed",
  tokenRefreshed: "token:refreshed",
  userUnauthorized: "user:unauthorized",
  downloadCanceled: "file:downloadCanceled",
  uploadCanceled: "file:uploadCanceled",
  fileDownload: "file:download",
  fileUpload: "file:upload",
  fileDownloaded: "file:downloaded",
  fileUploaded: "file:uploaded",
  attachmentDeleted: "attachment:deleted",
  mediaAttachmentDownloaded: "attachments:mediaDownloaded",
  monographsUpdated: "monographs:updated",
  vaultLocked: "vault:locked",
  vaultUnlocked: "vault:unlocked",
  systemTimeInvalid: "system:invalidTime",
  vaultAutoLocked: "vault:autoLocked"
};

const separators = ["-", "/", "."];
const DD = "DD";
const MM = "MM";
const YYYY = "YYYY";
export const DATE_FORMATS = [
  ...[
    [DD, MM, YYYY],
    [MM, DD, YYYY],
    [YYYY, MM, DD]
  ]
    .map((item) => separators.map((sep) => item.join(sep)))
    .flat(),
  "MMM D, YYYY"
];

export const TIME_FORMATS = ["12-hour", "24-hour"];

export const CURRENT_DATABASE_VERSION = 6.1;

export const FREE_NOTEBOOKS_LIMIT = 20;
