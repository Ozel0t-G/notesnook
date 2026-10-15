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
 * Pure wire protocol for VeyraN Connect.
 *
 * This is the single source of truth for the operation names, the per-operation
 * strict request/response schemas, the correlated `{ ok, result }` /
 * `{ ok: false, error }` wire envelopes and the static error catalog. It must
 * stay *pure*: it imports only `zod`, `errors.ts` and `schema.ts` (which in
 * turn imports only `limits.ts`), and never the adapter, database, SQL, crypto,
 * native modules, DOM, showdown or any transport implementation. That is what
 * lets a future MCP/broker worker validate requests and responses without
 * loading the app runtime.
 */

import { z } from "zod";
import {
  CONNECT_ERROR_CODES,
  CONNECT_ERROR_MESSAGES
} from "./errors.js";
import type { ConnectErrorCode } from "./errors.js";
import {
  appendToNoteRequest,
  appendToNoteResponse,
  completeTaskRequest,
  completeTaskResponse,
  createNoteRequest,
  createNoteResponse,
  createTaskRequest,
  createTaskResponse,
  getNoteRequest,
  getNoteResponse,
  listNotebooksRequest,
  listNotebooksResponse,
  listTaskListsRequest,
  listTaskListsResponse,
  listTasksRequest,
  listTasksResponse,
  requestSchema,
  responseSchema,
  searchNotesRequest,
  searchNotesResponse,
  statusRequest,
  statusResponse,
  updateNoteRequest,
  updateNoteResponse,
  updateTaskRequest,
  updateTaskResponse
} from "./schema.js";

// ------------------------------------------------------------- operation names

/**
 * Every supported Connect operation, in wire order. This is the canonical list:
 * `schema.ts`'s discriminated union is composed from exactly these operations.
 */
export const CONNECT_OPERATION_NAMES = [
  "status",
  "list_notebooks",
  "search_notes",
  "get_note",
  "create_note",
  "append_to_note",
  "update_note",
  "create_task",
  "list_task_lists",
  "list_tasks",
  "update_task",
  "complete_task"
] as const;

export const OPERATIONS = CONNECT_OPERATION_NAMES;

export type ConnectOperation = (typeof CONNECT_OPERATION_NAMES)[number];

// ----------------------------------------------------------- per-operation I/O

/** Per-operation strict request schemas (the composed source of `requestSchema`). */
export const operationRequestSchemas = {
  status: statusRequest,
  list_notebooks: listNotebooksRequest,
  search_notes: searchNotesRequest,
  get_note: getNoteRequest,
  create_note: createNoteRequest,
  append_to_note: appendToNoteRequest,
  update_note: updateNoteRequest,
  create_task: createTaskRequest,
  list_task_lists: listTaskListsRequest,
  list_tasks: listTasksRequest,
  update_task: updateTaskRequest,
  complete_task: completeTaskRequest
} as const;

/**
 * Per-operation strict response schemas. Each carries `operation: z.literal(...)`,
 * so a result of one operation cannot validate as another.
 */
export const operationResponseSchemas = {
  status: statusResponse,
  list_notebooks: listNotebooksResponse,
  search_notes: searchNotesResponse,
  get_note: getNoteResponse,
  create_note: createNoteResponse,
  append_to_note: appendToNoteResponse,
  update_note: updateNoteResponse,
  create_task: createTaskResponse,
  list_task_lists: listTaskListsResponse,
  list_tasks: listTasksResponse,
  update_task: updateTaskResponse,
  complete_task: completeTaskResponse
} as const;

export function requestSchemaFor(operation: ConnectOperation) {
  return operationRequestSchemas[operation];
}

export function responseSchemaFor(operation: ConnectOperation) {
  return operationResponseSchemas[operation];
}

// --------------------------------------------------------------- error catalog

export const CONNECT_ERROR_MESSAGE_CATALOG = CONNECT_ERROR_MESSAGES;
export { CONNECT_ERROR_CODES };

const connectErrorCodeSchema = z.enum(
  [...CONNECT_ERROR_CODES] as [ConnectErrorCode, ...ConnectErrorCode[]]
);

/**
 * The static error envelope. `message` must be the catalog message for `code`:
 * no raw/foreign transport string can pass validation.
 */
export const errorEnvelopeSchema = z
  .strictObject({
    code: connectErrorCodeSchema,
    message: z.string()
  })
  .refine(
    (value) => value.message === CONNECT_ERROR_MESSAGES[value.code],
    {
      message: "error message must be the static catalog message for its code",
      path: ["message"]
    }
  );

export type ConnectErrorEnvelope = {
  code: ConnectErrorCode;
  message: string;
};

/** Build the single valid envelope for `code` from the static catalog. */
export function errorEnvelope(code: ConnectErrorCode): ConnectErrorEnvelope {
  return { code, message: CONNECT_ERROR_MESSAGES[code] };
}

// ------------------------------------------------------------------ wire union

const errorWireMember = z.strictObject({
  ok: z.literal(false),
  error: errorEnvelopeSchema
});

/**
 * Correlated wire response for a specific operation:
 * `{ ok: true, result: <operation response> }` or `{ ok: false, error }`.
 *
 * Because the success `result` is the operation-specific strict schema, a
 * response whose `result.operation` differs from `operation` is rejected.
 */
export function wireResponseSchemaFor(operation: ConnectOperation) {
  return z.union([
    z.strictObject({
      ok: z.literal(true),
      result: operationResponseSchemas[operation]
    }),
    errorWireMember
  ]);
}

/** Correlated wire response accepting any supported operation's result. */
export const connectWireResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), result: responseSchema }),
  errorWireMember
]);

export const requestWireSchema = requestSchema;

// ------------------------------------------------------- transport / IPC layer

/**
 * Static transport codes distinguish "the app/broker is unavailable" from a
 * validated in-band Connect error. They exist so a transport failure is never
 * relayed as a foreign/unvalidated error string.
 */
export const TRANSPORT_ERROR_MESSAGES = {
  APP_UNAVAILABLE: "The VeyraN app is not reachable.",
  BROKER_UNAVAILABLE: "The VeyraN Connect broker is not reachable.",
  TRANSPORT_UNAVAILABLE: "The Connect transport channel is unavailable."
} as const;

export type TransportErrorCode = keyof typeof TRANSPORT_ERROR_MESSAGES;

export const TRANSPORT_ERROR_CODES = Object.freeze(
  Object.keys(TRANSPORT_ERROR_MESSAGES) as TransportErrorCode[]
);

const transportErrorCodeSchema = z.enum(
  [...TRANSPORT_ERROR_CODES] as [TransportErrorCode, ...TransportErrorCode[]]
);

export const transportErrorEnvelopeSchema = z
  .strictObject({
    code: transportErrorCodeSchema,
    message: z.string()
  })
  .refine(
    (value) => value.message === TRANSPORT_ERROR_MESSAGES[value.code],
    {
      message:
        "transport error message must be the static catalog message for its code",
      path: ["message"]
    }
  );

export type TransportErrorEnvelope = {
  code: TransportErrorCode;
  message: string;
};

export function transportErrorEnvelope(
  code: TransportErrorCode
): TransportErrorEnvelope {
  return { code, message: TRANSPORT_ERROR_MESSAGES[code] };
}

/**
 * Pure IPC wire schema. A transport failure is either a validated Connect error
 * (in-band) or one of the static transport codes (app vs broker unavailable);
 * an arbitrary foreign error payload is rejected.
 */
export const transportWireResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: errorEnvelopeSchema }),
  z.strictObject({ ok: z.literal(false), error: transportErrorEnvelopeSchema })
]);

// --------------------------------------------------------------- shared types

export type ConnectWireRequest = z.infer<typeof requestSchema>;
export type ConnectWireResponse = z.infer<typeof connectWireResponseSchema>;
export type TransportWireResponse = z.infer<
  typeof transportWireResponseSchema
>;
