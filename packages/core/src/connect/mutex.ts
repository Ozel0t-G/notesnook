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

import { Mutex } from "async-mutex";
// Type-only on purpose: this module is imported by `api/sync` (which
// `api/index` itself imports), so a runtime edge back into the database API
// would create a module cycle for no benefit — the registry is keyed by the
// live object, never by the class.
import type Database from "../api/index.js";

/**
 * Database-scoped operation mutex.
 *
 * The idempotency reservation + mutation + acknowledgement sequence must be
 * serialized across *every* adapter instance that shares the same `Database`
 * (and therefore the same encrypted store). An instance-local mutex would let
 * two adapters reserve the same `operationId` concurrently. The registry is
 * keyed by the live `Database` object via a WeakMap.
 *
 * Limitation (documented, honest): two fully independent `Database` instances
 * opened over the same physical file are not covered by this in-process mutex.
 * The Connect adapter is a single-process API over one shared Database.
 */
const REGISTRY = new WeakMap<Database, Mutex>();

export function dbMutex(db: Database): Mutex {
  let mutex = REGISTRY.get(db);
  if (!mutex) {
    mutex = new Mutex();
    REGISTRY.set(db, mutex);
  }
  return mutex;
}
