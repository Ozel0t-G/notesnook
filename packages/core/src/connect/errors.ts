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

/**
 * Static, bounded error surface for the VeyraN Connect core adapter.
 *
 * Deliberately contains no dynamic text: callers must never be able to leak
 * note titles, ids, payloads or raw caught errors into logs or responses.
 */
const MESSAGES = {
  DENIED: "No signed-in VeyraN account is available for this operation.",
  NOT_AUTHORIZED: "This operation is not permitted by the active grants.",
  GRANTS_CHANGED: "Grants changed while the operation was in progress.",
  SESSION_CHANGED:
    "The account session changed while the operation was in progress.",
  ADAPTER_CLOSED: "The VeyraN Connect adapter is closed.",
  ADAPTER_LOCKED: "The VeyraN Connect adapter is locked.",
  MIGRATION_IN_PROGRESS:
    "A database migration is required; Connect operations are paused.",
  INVALID_INPUT: "The request is malformed or exceeds bounded limits.",
  UNSUPPORTED_OPERATION: "The requested operation is not supported.",
  OPERATION_ID_REQUIRED: "Mutations require a stable operationId.",
  IDEMPOTENCY_CONFLICT:
    "This operationId was already used with a different request payload.",
  IDEMPOTENCY_UNCERTAIN:
    "The outcome of this operationId is unknown and cannot be safely replayed.",
  JOURNAL_CORRUPT:
    "The idempotency journal record is unreadable; failing closed.",
  JOURNAL_FULL:
    "The idempotency journal is full; refusing to discard recorded history.",
  REVISION_CONFLICT:
    "The record changed since the expected revision; the write was refused.",
  NOTE_NOT_FOUND: "The requested note does not exist.",
  NOTE_READONLY: "The note is read-only.",
  NOTE_TRASHED: "The note is in the trash.",
  NOTE_ARCHIVED: "The note is archived.",
  NOTE_LOCKED: "The note content is locked (vaulted).",
  TASK_NOT_FOUND: "The requested task does not exist.",
  TASK_LIST_NOT_FOUND: "The requested task list does not exist.",
  CONTENT_TOO_LARGE: "The content exceeds the bounded size limit.",
  UNSUPPORTED_CONTENT: "The content could not be converted safely.",
  SYNC_STATE_UNAVAILABLE:
    "No verified sync evidence is available for this record."
} as const;

export type ConnectErrorCode = keyof typeof MESSAGES;

/**
 * The static code→message catalog, exported so pure protocol code can derive
 * the wire error schema and the single source of truth for error text without
 * ever handling a raw/foreign transport string.
 */
export { MESSAGES as CONNECT_ERROR_MESSAGES };

/** Every bounded Connect error code, in declaration order. */
export const CONNECT_ERROR_CODES = Object.freeze(
  Object.keys(MESSAGES) as ConnectErrorCode[]
);

export class ConnectError extends Error {
  readonly code: ConnectErrorCode;
  constructor(code: ConnectErrorCode) {
    super(MESSAGES[code]);
    this.name = "ConnectError";
    this.code = code;
  }
}

export function isConnectError(value: unknown): value is ConnectError {
  return value instanceof ConnectError;
}

export function connectError(code: ConnectErrorCode): ConnectError {
  return new ConnectError(code);
}
