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
 * Shared real-transport test harness.
 *
 * Everything here dials the **actual** HTTPS broker with the actual pinned
 * client: there is no in-process dispatch shortcut and no unbound-port stand-in.
 * `makeProfile` generates real certificate material, `startBroker` starts the
 * real listener, `AppConnection` speaks the app half of the protocol over TLS
 * exactly like the future native worker will, and `startAppLoop` drives the
 * real Core adapter for each claim.
 */
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:https";
import { randomBytes } from "node:crypto";
import { LOOPBACK_HOST } from "../src/limits.js";
import { makePinChecker, type TlsMaterial } from "../src/tls.js";
import { generateTlsMaterial } from "../src/certs.js";
import {
  createCredential,
  createHandshakeNonce,
  formatBearerToken,
  type Credential
} from "../src/credentials.js";
import type { BrokerCredentials } from "../src/credentials.js";
import { Broker } from "../src/broker.js";
import { createBrokerAuthorizer, createBrokerHttpsServer } from "../src/https.js";
import { routePath, type BrokerResponse, type BrokerRoute } from "../src/broker-wire.js";
import type { BrokerDispatch } from "../src/https.js";
import { errorEnvelope, isConnectError, type ConnectErrorCode } from "../src/contract.js";

export interface TestProfile {
  credentials: BrokerCredentials;
  tls: TlsMaterial;
}

export async function makeProfile(): Promise<TestProfile> {
  const tls = await generateTlsMaterial();
  return { credentials: { v: 1, app: createCredential(), mcp: createCredential(), tls }, tls };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, LOOPBACK_HOST, () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

export interface StartedBroker {
  broker: Broker;
  server: Server;
  port: number;
  profile: TestProfile;
  stop: () => Promise<void>;
}

export async function startBroker(
  profile: TestProfile,
  options: {
    ttlMs?: number;
    maxQueueDepth?: number;
    instanceTtlMs?: number;
    /** Reuse a fixed port (e.g. to simulate a broker restart). */
    port?: number;
    /** Artificial per-route delay (ms), e.g. to park a slow `hello`. */
    delay?: Partial<Record<BrokerRoute, number>>;
    /** Extra wrapper around the real broker dispatch (never a shortcut). */
    wrapDispatch?: (dispatch: BrokerDispatch) => BrokerDispatch;
  } = {}
): Promise<StartedBroker> {
  const port = options.port ?? (await freePort());
  const broker = new Broker({
    port,
    brokerId: randomBytes(16).toString("hex"),
    credentials: profile.credentials,
    ttlMs: options.ttlMs,
    maxQueueDepth: options.maxQueueDepth,
    instanceTtlMs: options.instanceTtlMs
  });
  const baseDispatch: BrokerDispatch = (route, authorization, body) =>
    broker.dispatch(route, authorization, body);
  const dispatch: BrokerDispatch = options.delay
    ? async (route, authorization, body) => {
        const delayMs = options.delay?.[route];
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return baseDispatch(route, authorization, body);
      }
    : baseDispatch;
  const server = createBrokerHttpsServer({
    port,
    tls: profile.tls,
    // Same edge preamble the real CLI builds, so the harness exercises the
    // exact authentication-before-body ordering the production server uses.
    authorizePreamble: createBrokerAuthorizer(profile.credentials),
    dispatch: options.wrapDispatch ? options.wrapDispatch(dispatch) : dispatch
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, resolve);
  });
  return {
    broker,
    server,
    port,
    profile,
    stop: async () => {
      broker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export interface RawRequest {
  port: number;
  rootPem: string;
  leafPin: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
}

export interface RawResponse {
  status: number;
  text: string;
  body: unknown;
}

export function rawHttpsPost(options: RawRequest): Promise<RawResponse> {
  const payload =
    typeof options.body === "string"
      ? Buffer.from(options.body, "utf8")
      : options.body ?? Buffer.from("{}", "utf8");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: LOOPBACK_HOST,
        port: options.port,
        path: options.path,
        method: options.method ?? "POST",
        agent: false,
        rejectUnauthorized: true,
        ca: options.rootPem,
        minVersion: "TLSv1.2",
        checkServerIdentity: makePinChecker(options.leafPin),
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
          ...options.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, text, body });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 10_000, () => req.destroy(new Error("timeout")));
    req.end(payload);
  });
}

export interface RawTlsRequest {
  port: number;
  rootPem: string;
  leafPin: string;
  /** Hand-written HTTP/1.1 request bytes (lets a test send duplicate headers). */
  raw: string;
  timeoutMs?: number;
}

/**
 * Send a hand-written HTTP/1.1 request over the pinned TLS channel. `https`
 * cannot emit duplicate header names, so the duplicate-header guard is proven
 * with a raw socket. Resolves with the decoded response text.
 */
export function rawTlsRequest(options: RawTlsRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const socket = tls.connect(
      {
        host: LOOPBACK_HOST,
        port: options.port,
        ca: options.rootPem,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        checkServerIdentity: makePinChecker(options.leafPin)
      },
      () => socket.write(options.raw)
    );
    socket.setTimeout(options.timeoutMs ?? 10_000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error) => {
      if (settled) return;
      // A fail-closed reply tears the socket down after writing the status, so a
      // trailing reset is not a failure once the response bytes were received.
      if (chunks.length > 0) {
        finish();
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

export interface RawTlsChunkedUpload {
  port: number;
  rootPem: string;
  leafPin: string;
  /**
   * Request line + headers, ending with a blank line. The caller declares
   * `Transfer-Encoding: chunked`; the helper appends genuine chunk frames so the
   * body arrives with **no declared length**.
   */
  head: string;
  /** Body pieces streamed as real chunked frames (total length unknown up front). */
  chunks: readonly (Buffer | string)[];
  /** Delay between chunk writes (ms), so the upload genuinely streams over time. */
  chunkDelayMs?: number;
  timeoutMs?: number;
  /**
   * Returns true only once a *complete, bounded* HTTP error response has been
   * buffered (status line + fully received declared body). Until then the helper
   * fails closed: no response, no tolerance.
   */
  isComplete: (text: string) => boolean;
}

export interface RawTlsChunkedUploadResult {
  /** Decoded response text (the validated bounded error response). */
  text: string;
  /** How many body chunks were handed to the socket before the refusal. */
  chunksWritten: number;
  chunksTotal: number;
  /** True when the upload was refused before its final chunk was written. */
  stoppedEarly: boolean;
}

/**
 * Stream a real chunked (declared-length-unknown) upload over the pinned TLS
 * channel and resolve only once a validated bounded error response is buffered.
 *
 * This exists because `https.request`/`req.end(payload)` write the whole body
 * before the reader can surface a bounded fail-closed reply, so an oversized
 * request only shows up as a client `EPIPE`/reset *before* the 413. Here the
 * upload is written frame-by-frame, so an early server refusal is reachable and
 * provable. A write `EPIPE`/reset is tolerated **only after** the bounded error
 * response has been fully validated; any error, end or close before that is a
 * hard rejection (no `chunks.length > 0` blanket tolerance).
 */
export function rawTlsChunkedUpload(
  options: RawTlsChunkedUpload
): Promise<RawTlsChunkedUploadResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let validated = false;
    let chunksWritten = 0;
    const received: Buffer[] = [];
    const text = (): string => Buffer.concat(received).toString("utf8");
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      resolve({
        text: text(),
        chunksWritten,
        chunksTotal: options.chunks.length,
        stoppedEarly: chunksWritten < options.chunks.length
      });
    };
    const socket = tls.connect(
      {
        host: LOOPBACK_HOST,
        port: options.port,
        ca: options.rootPem,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        checkServerIdentity: makePinChecker(options.leafPin)
      },
      () => {
        socket.write(options.head);
        let index = 0;
        const writeNext = (): void => {
          // Stop the instant the refusal validated: an unentitled body is never
          // pushed to completion, and the socket is not written after destroy.
          if (settled || validated) return;
          if (index >= options.chunks.length) {
            socket.write("0\r\n\r\n");
            return;
          }
          const piece = options.chunks[index++];
          const buf =
            typeof piece === "string" ? Buffer.from(piece, "utf8") : piece;
          chunksWritten += 1;
          socket.write(`${buf.length.toString(16)}\r\n`);
          socket.write(buf);
          socket.write("\r\n");
          setTimeout(writeNext, options.chunkDelayMs ?? 0);
        };
        writeNext();
      }
    );
    socket.setTimeout(options.timeoutMs ?? 10_000, () => {
      if (!settled) socket.destroy(new Error("timeout"));
    });
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      if (!validated && options.isComplete(text())) {
        validated = true;
        succeed();
        // The refused upload is not entitled to finish: free the socket. A
        // trailing EPIPE/reset is tolerated below *only* because we validated.
        socket.destroy();
      }
    });
    const failClosed = (error: Error): void => {
      if (settled) return;
      if (validated) {
        succeed();
        return;
      }
      settled = true;
      reject(error);
    };
    socket.on("end", () =>
      failClosed(
        new Error("socket ended before a validated bounded error response")
      )
    );
    socket.on("close", () =>
      failClosed(
        new Error("socket closed before a validated bounded error response")
      )
    );
    socket.on("error", (error: Error) => {
      if (settled) return;
      if (validated) {
        succeed();
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

/** The app half of the protocol over real TLS (mirrors the future native worker). */
export class AppConnection {
  private sessionId?: string;
  private nonce = 0;
  constructor(
    private readonly options: {
      port: number;
      credential: Credential;
      rootPem: string;
      leafPin: string;
    }
  ) {}

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  private async call(route: BrokerRoute, body: unknown): Promise<BrokerResponse> {
    const response = await rawHttpsPost({
      port: this.options.port,
      rootPem: this.options.rootPem,
      leafPin: this.options.leafPin,
      path: routePath(route),
      headers: { authorization: formatBearerToken(this.options.credential) },
      body: JSON.stringify(body)
    });
    if (!response.body || typeof response.body !== "object")
      throw new Error("malformed broker response");
    return response.body as BrokerResponse;
  }

  async session(accountId: string, grantsGeneration = 1): Promise<string> {
    this.nonce = 0;
    const response = await this.call("session", {
      v: 1,
      clientNonce: createHandshakeNonce(),
      accountId,
      grantsGeneration
    });
    if (!response.ok) throw new Error("app session rejected");
    this.sessionId = (response.result as { sessionId: string }).sessionId;
    return this.sessionId;
  }

  async claim(clientId: string): Promise<BrokerResponse> {
    return this.call("claim", {
      v: 1,
      sessionId: this.sessionId,
      nonce: ++this.nonce,
      clientId
    });
  }

  async reply(
    clientId: string,
    ticketId: string,
    response: unknown
  ): Promise<BrokerResponse> {
    return this.call("reply", {
      v: 1,
      sessionId: this.sessionId,
      nonce: ++this.nonce,
      clientId,
      ticketId,
      response
    });
  }

  /** Raw call with an explicit session/nonce (edge-case tests). */
  async raw(route: BrokerRoute, body: unknown): Promise<BrokerResponse> {
    return this.call(route, body);
  }

  nextNonce(): number {
    return ++this.nonce;
  }
}

export function claimedItem(
  response: BrokerResponse
): { ticketId: string; request: unknown } | null {
  if (!response.ok) return null;
  return (
    (response.result as { item: { ticketId: string; request: unknown } | null }).item ??
    null
  );
}

export interface AppLoop {
  stop: () => void;
  readonly handled: number;
}

/**
 * Poll the broker for work and answer each claim by driving `execute` (the real
 * Core adapter), exactly as the native app does. Errors become the correlated
 * static Connect error envelope.
 */
export function startAppLoop(
  connection: AppConnection,
  clientId: string,
  execute: (request: unknown) => Promise<unknown>
): AppLoop {
  let stopped = false;
  let handled = 0;
  const loop = (async () => {
    while (!stopped) {
      let claimed: BrokerResponse;
      try {
        claimed = await connection.claim(clientId);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const item = claimedItem(claimed);
      if (!item) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
      let response: unknown;
      try {
        const result = await execute(item.request);
        response = { ok: true, result };
      } catch (error) {
        const code = (isConnectError(error)
          ? error.code
          : "INVALID_INPUT") as ConnectErrorCode;
        response = { ok: false, error: errorEnvelope(code) };
      }
      handled += 1;
      try {
        await connection.reply(clientId, item.ticketId, response);
      } catch {
        // Cancelled or session-changed; move on.
      }
    }
  })();
  void loop;
  return {
    stop: () => {
      stopped = true;
    },
    get handled() {
      return handled;
    }
  };
}
