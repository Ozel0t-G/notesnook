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
import {
  CompiledQuery,
  DatabaseConnection,
  DefaultQueryExecutor,
  Dialect,
  Driver,
  Kysely,
  QueryResult,
  TableNode,
  TransactionSettings
} from "@streetwriters/kysely";

type WriteLease = {
  connection: DatabaseConnection;
  done?: Promise<void>;
  release?: () => void;
};

/** Only session/configuration tables may change during account-data export. */
function isAccountDataWrite(query: CompiledQuery): boolean {
  const node = query.query;
  if (node.kind === "SelectQueryNode") return false;
  if (
    node.kind === "InsertQueryNode" ||
    node.kind === "UpdateQueryNode" ||
    node.kind === "DeleteQueryNode"
  ) {
    const target =
      node.kind === "InsertQueryNode"
        ? node.into
        : node.kind === "UpdateQueryNode"
        ? node.table
        : node.from.froms.length === 1
        ? node.from.froms[0]
        : undefined;
    if (target && TableNode.is(target)) {
      const name = target.table.identifier.name;
      if (name === "kv" || name === "config") return false;
    }
  }
  // Raw SQL does not carry a trusted target table. Permit single SELECTs;
  // fail closed for raw mutations, schema changes, PRAGMAs and multi-statements.
  if (node.kind === "RawNode") {
    const statement = query.sql.trim().replace(/;$/, "");
    if (
      !statement.includes(";") &&
      /^(?:select|explain\s+(?:query\s+plan\s+)?select)\b/i.test(statement)
    )
      return false;
  }
  return true;
}

/**
 * Fence the SQL execution boundary, including queries built before the fence.
 * A write lease lasts through connection release, so an existing transaction
 * must commit or roll back before the backup starts.
 */
export class AccountDataWriteBarrier {
  private readonly writers = new Set<WriteLease>();
  private readonly leases = new WeakMap<DatabaseConnection, WriteLease>();
  private frozen?: { conflicted: boolean };
  private generation = 0;
  private driver?: Driver;
  private dialect?: Dialect;

  wrapDialect(dialect: Dialect): Dialect {
    this.dialect = dialect;
    return {
      createAdapter: () => dialect.createAdapter(),
      createQueryCompiler: () => {
        const compiler = dialect.createQueryCompiler();
        return {
          compileQuery: (node) => {
            const query = compiler.compileQuery(node);
            if (this.frozen && isAccountDataWrite(query))
              this.rejectWrite(this.frozen);
            return query;
          }
        };
      },
      createIntrospector: (db) => dialect.createIntrospector(db),
      createDriver: () => {
        const driver = (this.driver = dialect.createDriver());
        const original = (connection: DatabaseConnection) => {
          const lease = this.leases.get(connection);
          if (!lease) throw new Error("Unknown account database connection.");
          return lease;
        };
        return {
          init: () => driver.init(),
          destroy: () => driver.destroy(),
          acquireConnection: async () => {
            const generation = this.generation;
            const requestedDuringFreeze = this.frozen;
            const connection = await driver.acquireConnection();
            const lease: WriteLease = { connection };
            const check = (query: CompiledQuery) => {
              if (!isAccountDataWrite(query)) return;
              if (
                this.frozen ||
                requestedDuringFreeze ||
                generation !== this.generation
              )
                this.rejectWrite(this.frozen || requestedDuringFreeze);
              if (!lease.done) {
                lease.done = new Promise((resolve) => {
                  lease.release = resolve;
                });
                this.writers.add(lease);
              }
            };
            const guarded: DatabaseConnection = {
              executeQuery: <R>(query: CompiledQuery) => {
                check(query);
                return connection.executeQuery<R>(query);
              },
              streamQuery: async function* <R>(
                query: CompiledQuery,
                chunkSize?: number
              ): AsyncIterableIterator<QueryResult<R>> {
                check(query);
                yield* connection.streamQuery<R>(query, chunkSize);
              }
            };
            this.leases.set(guarded, lease);
            return guarded;
          },
          beginTransaction: (connection, settings: TransactionSettings) =>
            driver.beginTransaction(original(connection).connection, settings),
          commitTransaction: (connection) =>
            driver.commitTransaction(original(connection).connection),
          rollbackTransaction: (connection) =>
            driver.rollbackTransaction(original(connection).connection),
          releaseConnection: async (connection) => {
            const lease = original(connection);
            try {
              await driver.releaseConnection(lease.connection);
            } finally {
              this.writers.delete(lease);
              lease.release?.();
              this.leases.delete(connection);
            }
          }
        };
      }
    };
  }

  private rejectWrite(state?: { conflicted: boolean }): never {
    if (state) state.conflicted = true;
    throw new Error("Account data changed during sign out. Please retry.");
  }

  async run<T>(operation: (assertUnchanged: () => void) => Promise<T>) {
    if (this.frozen)
      throw new Error("Account data is already being prepared for sign out.");
    const state = (this.frozen = { conflicted: false });
    this.generation++;
    const assertUnchanged = () => {
      if (state.conflicted)
        throw new Error("Account data changed during sign out. Please retry.");
    };
    try {
      await Promise.all(Array.from(this.writers, (lease) => lease.done));
      assertUnchanged();
      return await operation(assertUnchanged);
    } finally {
      this.frozen = undefined;
    }
  }

  /**
   * Reset alone owns this private view. It shares the initialized driver but
   * passes original connections to its executor; ordinary collections and
   * previously captured sql() handles continue to use guarded connections.
   */
  createResetView<Schema>(db: Kysely<Schema>): Kysely<Schema> {
    const driver = this.driver;
    const dialect = this.dialect;
    if (!driver || !dialect)
      throw new Error("Account database driver is not initialized.");
    return new Kysely<Schema>({
      config: { dialect },
      dialect,
      driver,
      executor: new DefaultQueryExecutor(
        dialect.createQueryCompiler(),
        dialect.createAdapter(),
        {
          provideConnection: async (consumer) => {
            const connection = await driver.acquireConnection();
            try {
              return await consumer(connection);
            } finally {
              await driver.releaseConnection(connection);
            }
          }
        },
        [...db.getExecutor().plugins]
      )
    });
  }
}
