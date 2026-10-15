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

import { ConnectError } from "./errors.js";

/**
 * The per-invocation host predicate: "is the execution context this operation
 * started under still current?".
 *
 * It must be a *synchronous*, zero-argument function returning `void`: the
 * contract is **throw-based** — it signals a stale context by throwing, never by
 * a return value. A host that returns a thenable (an `async` function, a
 * Promise, any duck-typed `then`) or any other non-`undefined` value (a boolean
 * ownership flag included) is rejected as malformed — a thenable is never
 * awaited, because awaiting it would introduce an unbounded suspension point
 * that the fence cannot revalidate, and a returned flag must never be silently
 * treated as "still current".
 */
export type HostAssert = () => void;

/**
 * True for any value that looks like a thenable (`Promise`, an `async`
 * function's result, or a duck-typed `{ then() }`).
 *
 * A hostile `then` *getter* that throws is a malformed predicate result, not a
 * raw host exception: it is reported through the same bounded `INVALID_INPUT`
 * path as a thenable rather than escaping.
 */
function isThenable(value: unknown): boolean {
  if (value === null) return false;
  const type = typeof value;
  if (type !== "object" && type !== "function") return false;
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch {
    return true;
  }
  return typeof then === "function";
}

/**
 * Run the host predicate synchronously and translate every failure into the
 * bounded static Connect error surface: no raw host exception text (a stack
 * trace, a session id, a secret) may ever escape, a thenable result is a
 * malformed predicate, never an awaited step, and a non-`void` return (a boolean
 * ownership flag included) is malformed rather than being accepted as current.
 */
export function assertHostCurrent(hostAssert: HostAssert): void {
  let result: unknown;
  try {
    result = hostAssert();
  } catch {
    // "This operation's execution context is no longer current." Bounded and
    // static: the host's own error is deliberately swallowed.
    throw new ConnectError("SESSION_CHANGED");
  }
  if (isThenable(result)) {
    // Never await it; just make sure an eventually-rejected predicate promise
    // cannot surface as an unhandled rejection.
    try {
      Promise.resolve(result as PromiseLike<unknown>).then(
        () => undefined,
        () => undefined
      );
    } catch {
      // A hostile/foreign thenable: nothing to observe.
    }
    throw new ConnectError("INVALID_INPUT");
  }
  if (result !== undefined) {
    // The predicate contract is throw-based: a non-`undefined` return (e.g. a
    // boolean ownership flag) must never be treated as a valid assertion.
    throw new ConnectError("INVALID_INPUT");
  }
}

/** The live adapter state the fence revalidates against. */
export interface FenceHost {
  readonly closed: boolean;
  readonly locked: boolean;
  readonly generation: number;
  /** Account id from the signed-in `kv.user` row; never a "local" fallback. */
  resolveAccountId(): Promise<string | undefined>;
  migrationsRequired(): boolean;
  /** Test-only seam: awaited after each fence step. */
  onFenceStep?: (label: string) => Promise<void>;
}

/**
 * Captures the immutable starting account + grants generation for one
 * operation. Every awaited step must revalidate through this fence before its
 * result may be used, and again immediately before any content is returned.
 *
 * The fence never trusts an in-memory account: it always re-reads the
 * persisted user row, so logout, account switch or a schematic change while an
 * operation is suspended is detected.
 */
export class OperationFence {
  constructor(
    private readonly host: FenceHost,
    readonly generation: number,
    readonly accountId: string,
    /**
     * Per-invocation host ownership predicate. Invoked synchronously at the
     * *end* of every {@link assertSync} — i.e. at the operation's entry (via
     * an explicit call), after every awaited fence step, inside every
     * persistence guard (each guard calls {@link assert}/{@link assertSync})
     * and immediately before any output. It is captured per operation, never
     * stored on the adapter, so concurrent invocations keep independent
     * contexts. Absent for the plain, no-host-context callers, whose behavior
     * is byte-for-byte unchanged.
     */
    private readonly hostAssert?: HostAssert
  ) {}

  assertSync(): void {
    if (this.host.closed) throw new ConnectError("ADAPTER_CLOSED");
    if (this.host.locked) throw new ConnectError("ADAPTER_LOCKED");
    if (this.host.generation !== this.generation)
      throw new ConnectError("GRANTS_CHANGED");
    if (this.host.migrationsRequired())
      throw new ConnectError("MIGRATION_IN_PROGRESS");
    if (this.hostAssert) assertHostCurrent(this.hostAssert);
  }

  async assert(): Promise<void> {
    this.assertSync();
    const accountId = await this.host.resolveAccountId();
    if (!accountId) throw new ConnectError("DENIED");
    if (accountId !== this.accountId) throw new ConnectError("SESSION_CHANGED");
    // Re-check after the await: grants/close could have changed mid-read.
    this.assertSync();
  }

  /** Await a promise, then revalidate the fence before its value is used. */
  async step<T>(label: string, promise: Promise<T>): Promise<T> {
    const value = await promise;
    await this.assert();
    if (this.host.onFenceStep) {
      await this.host.onFenceStep(label);
      // The instrumentation hook is an await like any other: lock/account/
      // grant state can change while it runs, so revalidate before the value
      // is allowed to be used.
      await this.assert();
    }
    return value;
  }

  /** Revalidate right before returning content from the operation. */
  async seal(): Promise<void> {
    await this.assert();
    if (this.host.onFenceStep) {
      await this.host.onFenceStep("seal");
      await this.assert();
    }
  }
}
