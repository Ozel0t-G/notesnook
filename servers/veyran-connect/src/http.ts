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
 * Compatibility shim: the plaintext HTTP edge was superseded by the loopback
 * HTTPS edge in `https.ts` (see docs/veyran-connect/MCP.md §"TLS"). New code
 * imports `./https.js`; this module only re-exports it so no stale plaintext
 * listener can be constructed by accident.
 */
export {
  createBrokerAuthorizer,
  createBrokerHttpsServer,
  handleRequest,
  maxBodyBytesForRoute,
  statusForError
} from "./https.js";
export type { BrokerAuthorizePreamble, BrokerDispatch } from "./https.js";
