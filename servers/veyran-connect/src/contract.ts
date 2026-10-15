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
 * The single connection point to the accepted Core contract.
 *
 * This module imports the *pure* Core Connect sources directly (relative path),
 * never the `@notesnook/core` package index — importing the index would load
 * the database, SQL, domino/showdown content pipeline and native modules into
 * the standalone MCP bundle. `protocol.ts` transitively imports only
 * `schema.ts` → `limits.ts` and `errors.ts` (all pure, `zod` only).
 *
 * The bundler (`esbuild.mjs`) resolves the `.js` specifiers below to the real
 * `.ts` sources; `tsc --moduleResolution bundler` does the same for typecheck.
 * There is exactly one schema source for both the adapter and this server, so
 * the MCP tool shapes cannot drift from Core.
 */

export {
  CONNECT_OPERATION_NAMES,
  OPERATIONS,
  operationRequestSchemas,
  operationResponseSchemas,
  requestSchemaFor,
  responseSchemaFor,
  errorEnvelope,
  errorEnvelopeSchema,
  wireResponseSchemaFor,
  connectWireResponseSchema,
  requestWireSchema,
  transportErrorEnvelope,
  transportErrorEnvelopeSchema,
  transportWireResponseSchema,
  CONNECT_ERROR_MESSAGE_CATALOG,
  CONNECT_ERROR_CODES,
  TRANSPORT_ERROR_MESSAGES,
  TRANSPORT_ERROR_CODES
} from "../../../packages/core/src/connect/protocol.js";
export type {
  ConnectOperation,
  ConnectErrorEnvelope,
  TransportErrorCode,
  TransportErrorEnvelope,
  ConnectWireRequest,
  ConnectWireResponse,
  TransportWireResponse
} from "../../../packages/core/src/connect/protocol.js";

export {
  CONNECT_ERROR_MESSAGES,
  ConnectError,
  isConnectError,
  connectError
} from "../../../packages/core/src/connect/errors.js";
export type { ConnectErrorCode } from "../../../packages/core/src/connect/errors.js";

export { CONTENT_LIMITS } from "../../../packages/core/src/connect/limits.js";
export type { ConnectContentFormat } from "../../../packages/core/src/connect/limits.js";
