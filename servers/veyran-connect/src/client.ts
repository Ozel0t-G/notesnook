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
 * MCP-side HTTPS client for the loopback broker.
 *
 * Every call targets `127.0.0.1:<persisted port>` over TLS with the dedicated
 * root CA as the only trusted anchor, `rejectUnauthorized: true`, and a custom
 * `checkServerIdentity` that pins the exact leaf DER SHA-256. The pinned
 * handshake completes **before** any `Authorization`, `Host` or body byte is
 * written, so a foreign listener on the port learns nothing. There is no proxy,
 * no DNS, no redirect and no decompression; a fresh agent per request means no
 * TLS session is ever resumed. Responses are counted while streaming (bounded
 * by `maxResponseBytes`), decoded with fatal UTF-8 and JSON-parsed before use.
 * Request bodies are bounded by the *route-aware* cap: every route the MCP
 * caller speaks is limited to `maxRequestBytes`; only the app `reply` route may
 * use the larger `maxAppReplyBytes` (mirroring the server edge).
 *
 * The client performs one `hello` handshake and then a strictly increasing
 * per-instance nonce; a broker restart or a new client instance simply
 * handshakes again, so no global counter can poison a restart.
 */
import https from "node:https";
import { SERVER_LIMITS, LOOPBACK_HOST, maxRequestBytesForRoute } from "./limits.js";
import { createHandshakeNonce, formatBearerToken, type Credential } from "./credentials.js";
import { makePinChecker } from "./tls.js";
import { routePath, type BrokerResponse, type BrokerRoute } from "./broker-wire.js";
import type { healthResultSchema } from "./broker-wire.js";
import type { z } from "zod";

export type HealthResult = z.infer<typeof healthResultSchema>;

export type BrokerHttpErrorKind =
  | "unavailable"
  | "invalid"
  | "too_large"
  /**
   * The caller aborted **before** the request bytes were handed to the socket,
   * so the broker provably never saw the request. This is distinct from a
   * transport failure (which may or may not have reached the broker): only this
   * kind may be reported as a clean pre-enqueue cancellation.
   */
  | "aborted";

export class BrokerHttpError extends Error {
  constructor(readonly kind: BrokerHttpErrorKind, message: string) {
    super(message);
    this.name = "BrokerHttpError";
  }
}

/** True for an abort that provably happened before any request byte was sent. */
export function isPreTransmitAbort(error: unknown): boolean {
  return error instanceof BrokerHttpError && error.kind === "aborted";
}

export interface BrokerClientOptions {
  port: number;
  credential: Credential;
  /** PEM of the public root CA the broker is trusted through. */
  rootPem: string;
  /** Lower-case hex SHA-256 of the broker leaf DER. */
  leafPin: string;
  timeoutMs?: number;
}

export class BrokerClient {
  private nonce = 0;
  private instanceId?: string;
  private hello?: Promise<string>;
  private readonly port: number;
  private readonly credential: Credential;
  private readonly rootPem: string;
  private readonly leafPin: string;
  private readonly timeoutMs: number;

  constructor(options: BrokerClientOptions) {
    this.port = options.port;
    this.credential = options.credential;
    this.rootPem = options.rootPem;
    this.leafPin = options.leafPin;
    this.timeoutMs = options.timeoutMs ?? SERVER_LIMITS.requestTtlMs;
  }

  nextNonce(): number {
    this.nonce += 1;
    return this.nonce;
  }

  private request(
    route: BrokerRoute,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    // Route-aware cap: only the app's `reply` upload may carry an allowed Core
    // `get_note` body (`maxAppReplyBytes`); every caller-facing route the MCP
    // client speaks stays strictly at `maxRequestBytes`. This mirrors the
    // server's own per-route cap so a caller can never ask for the larger bound.
    if (payload.byteLength > maxRequestBytesForRoute(route))
      return Promise.reject(new BrokerHttpError("too_large", "request too large"));
    return new Promise((resolve, reject) => {
      let settled = false;
      let abortListener: (() => void) | undefined;
      const removeAbortListener = (): void => {
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
          abortListener = undefined;
        }
      };
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        // Drop the abort listener as soon as the request finishes so a long-lived
        // signal cannot retain a completed request (and its payload) forever.
        removeAbortListener();
        action();
      };
      const fail = (kind: BrokerHttpErrorKind, message: string): void => {
        settle(() => {
          req.destroy();
          reject(new BrokerHttpError(kind, message));
        });
      };
      const req = https.request(
        {
          host: LOOPBACK_HOST,
          port: this.port,
          path: routePath(route),
          method: "POST",
          // A fresh agent per request: no TLS session is resumed.
          agent: false,
          rejectUnauthorized: true,
          ca: this.rootPem,
          minVersion: "TLSv1.2",
          checkServerIdentity: makePinChecker(this.leafPin),
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-length": String(payload.byteLength),
            authorization: formatBearerToken(this.credential),
            connection: "close"
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > SERVER_LIMITS.maxResponseBytes) {
              fail("too_large", "response too large");
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => fail("unavailable", "response stream failed"));
          res.on("end", () => {
            if (settled) return;
            let text: string;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks)
              );
            } catch {
              fail("invalid", "response not utf-8");
              return;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              fail("invalid", "response not json");
              return;
            }
            settle(() => resolve(parsed));
          });
        }
      );
      req.setTimeout(timeoutMs, () => fail("unavailable", "broker timeout"));
      req.on("error", () => fail("unavailable", "broker unreachable"));
      // Abort is re-checked here, immediately before the bytes are handed to the
      // socket (the caller also re-checks it after every handshake await). An
      // abort observed *before* `req.end` is a provable pre-transmit
      // cancellation; once the request has been written any abort is an
      // uncertain in-flight failure.
      let transmitted = false;
      if (signal) {
        if (signal.aborted) {
          fail("aborted", "aborted before send");
          return;
        }
        abortListener = () =>
          fail(transmitted ? "unavailable" : "aborted", "aborted");
        signal.addEventListener("abort", abortListener, { once: true });
      }
      if (settled || signal?.aborted) {
        fail("aborted", "aborted before send");
        return;
      }
      transmitted = true;
      req.end(payload);
    });
  }

  private async call(
    route: BrokerRoute,
    body: unknown,
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal
  ): Promise<BrokerResponse> {
    const parsed = (await this.request(route, body, timeoutMs, signal)) as
      | BrokerResponse
      | undefined;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { ok?: unknown }).ok !== "boolean"
    )
      throw new BrokerHttpError("invalid", "malformed broker response");
    return parsed;
  }

  async health(): Promise<HealthResult | undefined> {
    const response = await this.call("health", { v: 1 }, 5_000);
    if (!response.ok) return undefined;
    const value = response.result as Partial<HealthResult> | undefined;
    if (
      !value ||
      value.service !== "veyran-connect" ||
      value.protocolVersion !== 1 ||
      typeof value.port !== "number" ||
      typeof value.brokerId !== "string" ||
      typeof value.bootId !== "string"
    )
      return undefined;
    return value as HealthResult;
  }

  /** One `hello` handshake per client instance; concurrent callers share it. */
  private ensureInstance(): Promise<string> {
    if (this.instanceId !== undefined) return Promise.resolve(this.instanceId);
    if (!this.hello) {
      this.hello = (async () => {
        const response = await this.call("hello", {
          v: 1,
          clientNonce: createHandshakeNonce()
        });
        if (!response.ok)
          throw new BrokerHttpError("invalid", "broker rejected handshake");
        const instanceId = (response.result as { instanceId?: unknown } | undefined)
          ?.instanceId;
        if (typeof instanceId !== "string")
          throw new BrokerHttpError("invalid", "handshake returned no instance");
        this.instanceId = instanceId;
        return instanceId;
      })().catch((error: unknown) => {
        this.hello = undefined;
        throw error;
      });
    }
    return this.hello;
  }

  /** Forget the current instance so the next call handshakes afresh. */
  private resetInstance(): void {
    this.instanceId = undefined;
    this.hello = undefined;
  }

  /**
   * Run one instance-scoped route, recovering **once** from a stale instance.
   *
   * `SESSION_CHANGED`/`REPLAY` mean the broker no longer knows our instance
   * (a broker restart or an eviction). The failed call was rejected before any
   * work was recorded, so a single fresh handshake plus retry is safe for
   * `submit` (never enqueued), `await` (idempotent delivery) and `cancel`
   * (idempotent removal). The new instance starts its own nonce sequence, so
   * the retry can never be poisoned by the previous instance's counter.
   */
  private async instanceCall(
    route: BrokerRoute,
    bodyFor: (instanceId: string) => unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<BrokerResponse> {
    for (let attempt = 0; ; attempt++) {
      const instanceId = await this.ensureInstance();
      const response = await this.call(
        route,
        bodyFor(instanceId),
        timeoutMs,
        signal
      );
      if (
        attempt === 0 &&
        !response.ok &&
        (response.error.code === "SESSION_CHANGED" ||
          response.error.code === "REPLAY")
      ) {
        this.resetInstance();
        continue;
      }
      return response;
    }
  }

  /**
   * Submit one request. The optional `signal` is re-checked after the (shared)
   * `hello` handshake await and immediately before the request bytes are
   * written: an abort that arrives while the handshake is still in flight
   * therefore never enqueues anything (the rejection carries
   * `kind: "aborted"`). Once transmitted, an abort is an uncertain in-flight
   * failure and the caller must correlate it with the acquired ticket.
   */
  async submit(request: unknown, signal?: AbortSignal): Promise<BrokerResponse> {
    return this.instanceCall(
      "submit",
      (instanceId) => ({
        v: 1,
        instanceId,
        nonce: this.nextNonce(),
        request
      }),
      this.timeoutMs,
      signal
    );
  }

  /**
   * Wait for the app's correlated response. The HTTP timeout is a bounded
   * multiple of the broker TTL so the broker's own deadline (which returns
   * `APP_UNAVAILABLE`/`UNCERTAIN`) is what normally decides the outcome.
   * The abort signal is propagated so a cancelled tool call stops waiting and
   * falls back to the correlated `cancel` route.
   */
  async awaitResponse(
    ticketId: string,
    signal?: AbortSignal
  ): Promise<BrokerResponse> {
    return this.instanceCall(
      "await",
      (instanceId) => ({ v: 1, instanceId, nonce: this.nextNonce(), ticketId }),
      this.timeoutMs + 5_000,
      signal
    );
  }

  async cancel(ticketId: string): Promise<BrokerResponse> {
    return this.instanceCall(
      "cancel",
      (instanceId) => ({ v: 1, instanceId, nonce: this.nextNonce(), ticketId }),
      5_000
    );
  }
}
