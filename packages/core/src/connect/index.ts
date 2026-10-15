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

export { ConnectAdapter } from "./adapter.js";
export type { ConnectAdapterOptions, ConnectHostContext } from "./adapter.js";
export { assertHostCurrent } from "./fence.js";
export type { HostAssert } from "./fence.js";
export { ConnectError, isConnectError } from "./errors.js";
export type { ConnectErrorCode } from "./errors.js";
export type { ConnectGrantsInput } from "./grants.js";
export { IdempotencyJournal, RECEIPT_PREFIX } from "./journal.js";
export type {
  BeginResult,
  JournalRecord,
  JournalState
} from "./journal.js";
export { CONTENT_LIMITS, toTiptapHtml } from "./content.js";
export type { ConnectContentFormat } from "./content.js";
export {
  fingerprintOf,
  noteContentHash,
  noteRevision,
  taskRevision
} from "./revision.js";
export { requestSchema, responseSchema } from "./schema.js";
export type { ConnectRequest, ConnectResponse } from "./schema.js";
// Pure wire protocol (operation names, per-operation strict schemas, static
// error catalog and the IPC/transport wire schemas). Safe to re-export: it
// imports only pure modules.
export * from "./protocol.js";
