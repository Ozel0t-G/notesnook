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
 * The broker state machine.
 *
 * Everything here is **RAM-only** and bounded: the queue holds at most
 * `maxQueueDepth` live requests, bounded instances exist for the app and MCP
 * callers, a client may hold one unanswered claim, and every request has a
 * hard TTL. A periodic (and per-request) cleanup purges queued, claimed and
 * delivered entries and expired instances, so capacity is released and no
 * plaintext entry outlives its TTL. No note title, body, id, credential or
 * caught error is ever logged, cached to disk or written to a file — the only
 * persistent broker artifacts are the `0600` credential/config files created
 * by the operator CLI.
 *
 * Identity is explicit: an app `session` handshake and an MCP `hello`
 * handshake each return a fresh random instance id with its own monotonic
 * nonce sequence. A request entry is immutably bound to the app session,
 * account and grants generation current when it was submitted; a session
 * change purges the old session's context, so an account switch can never let
 * one account's queued work be claimed or answered by another. Authorization
 * of the underlying records is decided only by the app's Core adapter.
 */
import { randomBytes } from "node:crypto";
import { SERVER_LIMITS } from "./limits.js";
import { authenticate, createHandshakeNonce, type BrokerCredentials } from "./credentials.js";
import { brokerErrorEnvelope } from "./errors.js";
import {
  awaitRequestSchema,
  cancelRequestSchema,
  claimRequestSchema,
  healthRequestSchema,
  healthResultSchema,
  helloRequestSchema,
  helloResultSchema,
  replyRequestSchema,
  sessionRequestSchema,
  sessionResultSchema,
  submitRequestSchema,
  brokerFail,
  brokerOk,
  type BrokerResponse,
  type BrokerRoute
} from "./broker-wire.js";
import {
  errorEnvelope,
  requestWireSchema,
  wireResponseSchemaFor,
  type ConnectOperation
} from "./contract.js";

type Role = "app" | "mcp";

interface Instance {
  id: string;
  role: Role;
  lastNonce: number;
  expiresAt: number;
  accountId?: string;
  grantsGeneration?: number;
}

type EntryState = "queued" | "claimed" | "delivered" | "uncertain";

interface QueueEntry {
  ticketId: string;
  operation: ConnectOperation;
  request: unknown;
  enqueuedAt: number;
  deadlineAt: number;
  state: EntryState;
  sessionId: string;
  accountId: string;
  grantsGeneration: number;
  clientId?: string;
  claimedAt?: number;
  answeredAt?: number;
  response?: unknown;
  deliveredAt?: number;
}

type WaiterResult =
  | { kind: "response"; response: unknown }
  | { kind: "uncertain" }
  | { kind: "unavailable" }
  | { kind: "closed" };

interface Waiter {
  resolve: (result: WaiterResult) => void;
}

export interface BrokerOptions {
  port: number;
  brokerId: string;
  credentials: BrokerCredentials;
  now?: () => number;
  ttlMs?: number;
  maxQueueDepth?: number;
  instanceTtlMs?: number;
  deliveredRetentionMs?: number;
  cleanupIntervalMs?: number;
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

export class Broker {
  private readonly port: number;
  /** Persisted broker identity; public so callers/tests can pin `health`. */
  readonly brokerId: string;
  private readonly credentials: BrokerCredentials;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxQueueDepth: number;
  private readonly instanceTtlMs: number;
  private readonly deliveredRetentionMs: number;

  /** Random per broker process; surfaces in `health` so callers notice a restart. */
  private readonly bootId = newId();

  private readonly instances = new Map<string, Instance>();
  private currentSessionId?: string;
  private readonly entries = new Map<string, QueueEntry>();
  private readonly claims = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly appHandshakeNonces: string[] = [];
  private readonly mcpHandshakeNonces: string[] = [];
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: BrokerOptions) {
    this.port = options.port;
    this.brokerId = options.brokerId;
    this.credentials = options.credentials;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? SERVER_LIMITS.requestTtlMs;
    this.maxQueueDepth = options.maxQueueDepth ?? SERVER_LIMITS.maxQueueDepth;
    this.instanceTtlMs = options.instanceTtlMs ?? SERVER_LIMITS.instanceTtlMs;
    this.deliveredRetentionMs =
      options.deliveredRetentionMs ?? SERVER_LIMITS.deliveredRetentionMs;
    const interval = options.cleanupIntervalMs ?? SERVER_LIMITS.cleanupIntervalMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), interval);
    if (typeof this.cleanupTimer.unref === "function") this.cleanupTimer.unref();
  }

  get queueDepth(): number {
    return this.liveCount();
  }

  get hasSession(): boolean {
    return this.currentSessionId !== undefined;
  }

  /** Resolve every waiting `await` and mark the broker closed. */
  close(): void {
    this.closed = true;
    clearInterval(this.cleanupTimer);
    for (const list of this.waiters.values())
      for (const waiter of list) waiter.resolve({ kind: "closed" });
    this.waiters.clear();
    this.entries.clear();
    this.claims.clear();
    this.instances.clear();
    this.currentSessionId = undefined;
  }

  async dispatch(
    route: BrokerRoute,
    authorization: string | undefined,
    body: unknown
  ): Promise<BrokerResponse> {
    if (this.closed) return brokerFail(brokerErrorEnvelope("BROKER_UNAVAILABLE"));
    switch (route) {
      case "health":
        return this.health(authorization, body);
      case "session":
        return this.openSession(authorization, body);
      case "hello":
        return this.hello(authorization, body);
      case "submit":
        return this.submit(authorization, body);
      case "claim":
        return this.claim(authorization, body);
      case "reply":
        return this.reply(authorization, body);
      case "await":
        return this.awaitTicket(authorization, body);
      case "cancel":
        return this.cancelTicket(authorization, body);
      default:
        return brokerFail(brokerErrorEnvelope("NOT_FOUND"));
    }
  }

  // ------------------------------------------------------------------ helpers

  private authenticateApp(authorization: string | undefined): boolean {
    return authenticate(authorization, this.credentials.app);
  }

  private authenticateMcp(authorization: string | undefined): boolean {
    return authenticate(authorization, this.credentials.mcp);
  }

  private liveCount(): number {
    let count = 0;
    for (const entry of this.entries.values())
      if (entry.state === "queued" || entry.state === "claimed") count++;
    return count;
  }

  /** Bounded recent-handshake replay window; returns false on a replay. */
  private acceptHandshake(window: string[], nonce: string): boolean {
    if (window.includes(nonce)) return false;
    window.push(nonce);
    while (window.length > SERVER_LIMITS.handshakeReplayWindow) window.shift();
    return true;
  }

  /**
   * Bounded instance map: evict expired, then the least-recently-used instance
   * if over the cap. The single live **app** session is never evicted by caller
   * churn: a burst of MCP `hello` handshakes must not silently destroy the
   * immutable app lease (which would strand every in-flight request as
   * `APP_UNAVAILABLE` with no re-handshake path).
   */
  private retainInstance(instance: Instance): void {
    this.instances.set(instance.id, instance);
    const now = this.now();
    for (const [id, candidate] of [...this.instances])
      if (candidate.expiresAt <= now && id !== this.currentSessionId)
        this.dropInstance(id);
    while (this.instances.size > SERVER_LIMITS.maxInstances) {
      let evicted = false;
      for (const id of this.instances.keys()) {
        if (id === this.currentSessionId) continue;
        this.dropInstance(id);
        evicted = true;
        break;
      }
      if (!evicted) break; // only the protected app session remains
    }
  }

  private dropInstance(id: string): void {
    this.instances.delete(id);
    if (this.currentSessionId === id) this.currentSessionId = undefined;
  }

  private resolveInstance(
    role: Role,
    id: unknown,
    nonce: number
  ): Instance | BrokerResponse {
    if (typeof id !== "string")
      return brokerFail(brokerErrorEnvelope("SESSION_REQUIRED"));
    const instance = this.instances.get(id);
    if (!instance || instance.role !== role)
      return brokerFail(brokerErrorEnvelope("SESSION_CHANGED"));
    if (role === "app" && this.currentSessionId !== id)
      return brokerFail(brokerErrorEnvelope("SESSION_CHANGED"));
    if (instance.expiresAt <= this.now()) {
      this.dropInstance(id);
      return brokerFail(brokerErrorEnvelope("SESSION_CHANGED"));
    }
    if (!Number.isInteger(nonce) || nonce <= instance.lastNonce)
      return brokerFail(brokerErrorEnvelope("REPLAY"));
    instance.lastNonce = nonce;
    instance.expiresAt = this.now() + this.instanceTtlMs;
    // Move to the most-recent position so an active instance is the *last* to
    // be evicted under caller churn (the map is ordered least→most recent).
    this.instances.delete(id);
    this.instances.set(id, instance);
    return instance;
  }

  private resolveWaiters(ticketId: string, result: WaiterResult): void {
    const list = this.waiters.get(ticketId);
    if (!list) return;
    this.waiters.delete(ticketId);
    for (const waiter of list) waiter.resolve(result);
  }

  private removeEntry(ticketId: string, result: WaiterResult): void {
    this.entries.delete(ticketId);
    for (const [clientId, held] of this.claims)
      if (held === ticketId) this.claims.delete(clientId);
    this.resolveWaiters(ticketId, result);
  }

  /** Purge every entry bound to a session (used on session replacement). */
  private purgeSession(sessionId: string): void {
    for (const [ticketId, entry] of [...this.entries]) {
      if (entry.sessionId !== sessionId) continue;
      this.removeEntry(
        ticketId,
        entry.state === "claimed" ? { kind: "uncertain" } : { kind: "unavailable" }
      );
    }
  }

  /**
   * Bounded periodic + per-request cleanup:
   *  - a queued entry past its deadline is purged (never claimed)
   *  - a claimed entry past its deadline becomes uncertain, then is purged
   *  - a delivered / answered entry is purged after the short retention
   *  - expired instances are evicted
   */
  private cleanup(): void {
    const now = this.now();
    for (const [ticketId, entry] of [...this.entries]) {
      if (entry.state === "queued") {
        if (now > entry.deadlineAt) this.removeEntry(ticketId, { kind: "unavailable" });
        continue;
      }
      if (entry.state === "claimed") {
        if (entry.answeredAt !== undefined) {
          if (now - entry.answeredAt > this.deliveredRetentionMs)
            this.removeEntry(ticketId, { kind: "uncertain" });
          continue;
        }
        if (now > entry.deadlineAt) {
          entry.state = "uncertain";
          this.resolveWaiters(ticketId, { kind: "uncertain" });
          continue;
        }
        continue;
      }
      if (entry.state === "uncertain") {
        if (now > entry.deadlineAt + this.deliveredRetentionMs)
          this.removeEntry(ticketId, { kind: "uncertain" });
        continue;
      }
      if (entry.state === "delivered") {
        if (now - (entry.deliveredAt ?? now) > this.deliveredRetentionMs)
          this.removeEntry(ticketId, { kind: "unavailable" });
      }
    }
    for (const [id, instance] of [...this.instances])
      if (instance.expiresAt <= now) this.dropInstance(id);
  }

  // ------------------------------------------------------------------- routes

  private health(
    authorization: string | undefined,
    body: unknown
  ): BrokerResponse {
    if (
      !this.authenticateApp(authorization) &&
      !this.authenticateMcp(authorization)
    )
      return brokerFail(brokerErrorEnvelope("UNAUTHORIZED"));
    const parsed = healthRequestSchema.safeParse(body);
    if (!parsed.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    const result = healthResultSchema.safeParse({
      service: "veyran-connect",
      protocolVersion: 1,
      brokerId: this.brokerId,
      bootId: this.bootId,
      port: this.port
    });
    if (!result.success) return brokerFail(brokerErrorEnvelope("INTERNAL"));
    return brokerOk(result.data);
  }

  /** App handshake: a fresh random instance replaces any previous session. */
  private openSession(
    authorization: string | undefined,
    body: unknown
  ): BrokerResponse {
    if (!this.authenticateApp(authorization))
      return brokerFail(brokerErrorEnvelope("UNAUTHORIZED"));
    const parsed = sessionRequestSchema.safeParse(body);
    if (!parsed.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    if (!this.acceptHandshake(this.appHandshakeNonces, parsed.data.clientNonce))
      return brokerFail(brokerErrorEnvelope("REPLAY"));
    const previous = this.currentSessionId;
    if (previous !== undefined) {
      this.purgeSession(previous);
      this.dropInstance(previous);
    }
    // There is exactly `maxAppSessions` (=1) live app session at a time.
    const id = createHandshakeNonce();
    this.currentSessionId = id;
    this.retainInstance({
      id,
      role: "app",
      lastNonce: 0,
      expiresAt: this.now() + this.instanceTtlMs,
      accountId: parsed.data.accountId,
      grantsGeneration: parsed.data.grantsGeneration
    });
    const result = sessionResultSchema.safeParse({
      sessionId: id,
      grantsGeneration: parsed.data.grantsGeneration
    });
    if (!result.success) return brokerFail(brokerErrorEnvelope("INTERNAL"));
    return brokerOk(result.data);
  }

  /** MCP handshake: an independent caller instance with its own nonces. */
  private hello(
    authorization: string | undefined,
    body: unknown
  ): BrokerResponse {
    if (!this.authenticateMcp(authorization))
      return brokerFail(brokerErrorEnvelope("UNAUTHORIZED"));
    const parsed = helloRequestSchema.safeParse(body);
    if (!parsed.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    if (!this.acceptHandshake(this.mcpHandshakeNonces, parsed.data.clientNonce))
      return brokerFail(brokerErrorEnvelope("REPLAY"));
    const id = createHandshakeNonce();
    this.retainInstance({
      id,
      role: "mcp",
      lastNonce: 0,
      expiresAt: this.now() + this.instanceTtlMs
    });
    const result = helloResultSchema.safeParse({ instanceId: id });
    if (!result.success) return brokerFail(brokerErrorEnvelope("INTERNAL"));
    return brokerOk(result.data);
  }

  private submit(
    authorization: string | undefined,
    body: unknown
  ): BrokerResponse {
    if (!this.authenticateMcp(authorization))
      return brokerFail(brokerErrorEnvelope("UNAUTHORIZED"));
    const parsed = submitRequestSchema.safeParse(body);
    if (!parsed.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    const instance = this.resolveInstance(
      "mcp",
      parsed.data.instanceId,
      parsed.data.nonce
    );
    if ("ok" in instance) return instance;
    const sessionId = this.currentSessionId;
    const session = sessionId !== undefined ? this.instances.get(sessionId) : undefined;
    if (!sessionId || !session || session.role !== "app")
      return brokerFail(brokerErrorEnvelope("APP_UNAVAILABLE"));
    this.cleanup();
    if (this.liveCount() >= this.maxQueueDepth)
      return brokerFail(brokerErrorEnvelope("QUEUE_FULL"));
    const request = requestWireSchema.safeParse(parsed.data.request);
    if (!request.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    const operation = request.data.operation as ConnectOperation;
    const entry: QueueEntry = {
      ticketId: newId(),
      operation,
      request: request.data,
      enqueuedAt: this.now(),
      deadlineAt: this.now() + this.ttlMs,
      state: "queued",
      sessionId,
      accountId: session.accountId ?? "",
      grantsGeneration: session.grantsGeneration ?? 0
    };
    this.entries.set(entry.ticketId, entry);
    return brokerOk({ ticketId: entry.ticketId });
  }

  private claim(
    authorization: string | undefined,
    body: unknown
  ): BrokerResponse {
    if (!this.authenticateApp(authorization))
      return brokerFail(brokerErrorEnvelope("UNAUTHORIZED"));
    const parsed = claimRequestSchema.safeParse(body);
    if (!parsed.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    const instance = this.resolveInstance(
      "app",
      parsed.data.sessionId,
      parsed.data.nonce
    );
    if ("ok" in instance) return instance;
    // At most `maxClaimsPerClient` (=1) unanswered claim may be held by one app
    // client; a second claim while one is outstanding is refused.
    const clientId = parsed.data.clientId;
    const heldTicket = this.claims.get(clientId);
    if (heldTicket) {
      const held = this.entries.get(heldTicket);
      if (held && held.state === "claimed") return brokerFail(brokerErrorEnvelope("ALREADY_CLAIMED"));
      this.claims.delete(clientId);
    }
    this.cleanup();
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.state !== "queued") continue;
      if (entry.sessionId !== instance.id) continue;
      if (entry.accountId !== (instance.accountId ?? "")) continue;
      if (entry.grantsGeneration !== (instance.grantsGeneration ?? 0)) continue;
      if (now > entry.deadlineAt) continue;
      entry.state = "claimed";
      entry.clientId = clientId;
      entry.claimedAt = now;
      this.claims.set(clientId, entry.ticketId);
      return brokerOk({ item: { ticketId: entry.ticketId, request: entry.request } });
    }
    return brokerOk({ item: null });
  }

  private reply(
    authorization: string | undefined,
    body: unknown
  ): BrokerResponse {
    if (!this.authenticateApp(authorization))
      return brokerFail(brokerErrorEnvelope("UNAUTHORIZED"));
    const parsed = replyRequestSchema.safeParse(body);
    if (!parsed.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    const instance = this.resolveInstance(
      "app",
      parsed.data.sessionId,
      parsed.data.nonce
    );
    if ("ok" in instance) return instance;
    const entry = this.entries.get(parsed.data.ticketId);
    if (
      !entry ||
      entry.sessionId !== instance.id ||
      entry.accountId !== (instance.accountId ?? "") ||
      entry.grantsGeneration !== (instance.grantsGeneration ?? 0) ||
      entry.clientId !== parsed.data.clientId
    )
      return brokerFail(brokerErrorEnvelope("NOT_FOUND"));
    if (entry.state === "uncertain") return brokerFail(brokerErrorEnvelope("UNCERTAIN"));
    if (entry.response !== undefined) return brokerFail(brokerErrorEnvelope("REPLAY"));
    // The response must correlate with the entry's operation: a result for a
    // different operation (or an unknown error string) is refused here and can
    // therefore never reach the model.
    const checked = wireResponseSchemaFor(entry.operation).safeParse(
      parsed.data.response
    );
    if (!checked.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    // Broker-side bound on a `get_note` body: the app caps returned content at
    // 1M chars, but the broker independently refuses to deliver a body larger
    // than `maxGetBodyBytes`, substituting the correlated `CONTENT_TOO_LARGE`
    // error envelope (still a valid wire response for the operation) so the
    // model can never receive an unbounded read.
    const oversized =
      entry.operation === "get_note" &&
      checked.data.ok === true &&
      Buffer.byteLength(JSON.stringify(checked.data.result), "utf8") >
        SERVER_LIMITS.maxGetBodyBytes;
    entry.response = oversized
      ? { ok: false, error: errorEnvelope("CONTENT_TOO_LARGE") }
      : checked.data;
    entry.answeredAt = this.now();
    this.claims.delete(parsed.data.clientId);
    this.resolveWaiters(entry.ticketId, {
      kind: "response",
      response: entry.response
    });
    return brokerOk({ accepted: true });
  }

  private async awaitTicket(
    authorization: string | undefined,
    body: unknown
  ): Promise<BrokerResponse> {
    if (!this.authenticateMcp(authorization))
      return brokerFail(brokerErrorEnvelope("UNAUTHORIZED"));
    const parsed = awaitRequestSchema.safeParse(body);
    if (!parsed.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    const instance = this.resolveInstance(
      "mcp",
      parsed.data.instanceId,
      parsed.data.nonce
    );
    if ("ok" in instance) return instance;
    this.cleanup();
    const entry = this.entries.get(parsed.data.ticketId);
    if (!entry) return brokerFail(brokerErrorEnvelope("NOT_FOUND"));
    if (entry.deliveredAt !== undefined) return brokerFail(brokerErrorEnvelope("REPLAY"));
    if (entry.state === "uncertain") return brokerFail(brokerErrorEnvelope("UNCERTAIN"));
    if (entry.response !== undefined) {
      entry.state = "delivered";
      entry.deliveredAt = this.now();
      const response = entry.response;
      this.resolveWaiters(entry.ticketId, { kind: "response", response });
      return brokerOk({ response });
    }
    const remaining = entry.deadlineAt - this.now();
    if (remaining <= 0) {
      if (entry.state === "claimed") {
        entry.state = "uncertain";
        return brokerFail(brokerErrorEnvelope("UNCERTAIN"));
      }
      this.removeEntry(entry.ticketId, { kind: "unavailable" });
      return brokerFail(brokerErrorEnvelope("APP_UNAVAILABLE"));
    }
    const result = await this.wait(entry.ticketId, remaining);
    if (result.kind === "response") {
      entry.state = "delivered";
      entry.deliveredAt = this.now();
      return brokerOk({ response: result.response });
    }
    if (result.kind === "uncertain")
      return brokerFail(brokerErrorEnvelope("UNCERTAIN"));
    if (result.kind === "closed")
      return brokerFail(brokerErrorEnvelope("BROKER_UNAVAILABLE"));
    // The wait settled by expiring. Other handlers (reply/cancel/cleanup) run
    // during the await and mutate or purge the entry, so re-acquire its *fresh*
    // state from the map rather than trusting the pre-await snapshot (whose
    // narrowed type would also hide a legitimate post-await transition).
    const current = this.entries.get(entry.ticketId);
    if (!current) return brokerFail(brokerErrorEnvelope("APP_UNAVAILABLE"));
    // A late reply that landed during the wait is a real response, not a
    // timeout: deliver it truthfully.
    if (current.response !== undefined) {
      current.state = "delivered";
      current.deliveredAt = this.now();
      return brokerOk({ response: current.response });
    }
    // If the request was claimed (or already marked uncertain), the app may have
    // persisted the write: the honest outcome is uncertain, not unavailable.
    if (current.state === "claimed" || current.state === "uncertain") {
      current.state = "uncertain";
      return brokerFail(brokerErrorEnvelope("UNCERTAIN"));
    }
    this.removeEntry(current.ticketId, { kind: "unavailable" });
    return brokerFail(brokerErrorEnvelope("APP_UNAVAILABLE"));
  }

  private wait(ticketId: string, timeoutMs: number): Promise<WaiterResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: WaiterResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const waiter: Waiter = {
        resolve: (result) => {
          clearTimeout(timer);
          finish(result);
        }
      };
      const timer = setTimeout(() => {
        this.removeWaiter(ticketId, waiter);
        finish({ kind: "unavailable" });
      }, Math.max(1, Math.min(timeoutMs, this.ttlMs)));
      if (typeof timer.unref === "function") timer.unref();
      const list = this.waiters.get(ticketId) ?? [];
      list.push(waiter);
      this.waiters.set(ticketId, list);
    });
  }

  private removeWaiter(ticketId: string, waiter: Waiter): void {
    const list = this.waiters.get(ticketId);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) this.waiters.delete(ticketId);
  }

  private cancelTicket(
    authorization: string | undefined,
    body: unknown
  ): BrokerResponse {
    if (!this.authenticateMcp(authorization))
      return brokerFail(brokerErrorEnvelope("UNAUTHORIZED"));
    const parsed = cancelRequestSchema.safeParse(body);
    if (!parsed.success) return brokerFail(brokerErrorEnvelope("BAD_REQUEST"));
    const instance = this.resolveInstance(
      "mcp",
      parsed.data.instanceId,
      parsed.data.nonce
    );
    if ("ok" in instance) return instance;
    const entry = this.entries.get(parsed.data.ticketId);
    if (!entry) return brokerOk({ removed: false, uncertain: false, completed: false });
    if (entry.state === "delivered" || entry.response !== undefined)
      return brokerOk({ removed: false, uncertain: false, completed: true });
    if (entry.state === "claimed" || entry.state === "uncertain") {
      // Already claimed: the app may have persisted the write, so the outcome
      // is genuinely uncertain and may only be retried with the same
      // operationId. The late reply (if any) is refused by the `uncertain`
      // state.
      entry.state = "uncertain";
      this.resolveWaiters(entry.ticketId, { kind: "uncertain" });
      return brokerOk({ removed: false, uncertain: true, completed: false });
    }
    // Queued and never claimed: remove it entirely; no write can have happened.
    // A concurrently parked `await` resolves `unavailable`, matching the
    // `removed:true, uncertain:false` outcome reported here.
    this.removeEntry(entry.ticketId, { kind: "unavailable" });
    return brokerOk({ removed: true, uncertain: false, completed: false });
  }

  /** For diagnostics/tests only: never returns ids or payloads. */
  describe(): { queueDepth: number; hasSession: boolean; closed: boolean } {
    return {
      queueDepth: this.liveCount(),
      hasSession: this.currentSessionId !== undefined,
      closed: this.closed
    };
  }
}
