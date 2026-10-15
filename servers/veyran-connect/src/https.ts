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
 * Loopback HTTPS edge for the broker.
 *
 * The server is an HTTPS listener on the fixed numeric IPv4 `127.0.0.1` using
 * the dedicated root/leaf material (see `tls.ts`). Only a caller that validates
 * the chain and the exact leaf DER pin and then presents a bearer credential
 * gets past the handshake; a foreign process holding the port but serving any
 * other certificate sees zero request bytes.
 *
 * HTTP hardening (all fail closed):
 *  - POST only; the **whole** request target must equal a literal
 *    `/v1/<route>` — a query string, trailing slash or fragment makes the
 *    request `404` (the target is compared verbatim, never split);
 *  - `Host` must exactly equal `127.0.0.1:<persisted port>`; a duplicated
 *    singleton header (`Host`, `Authorization`, `Content-Length`, …) is refused
 *    even when Node would otherwise collapse or ignore the duplicate;
 *  - **any** `Origin` header — including `null`, browser, `localhost` or a
 *    DNS-rebinding value — is refused (native clients send no `Origin`);
 *  - `Sec-Fetch-*`, `Forwarded`, `X-Forwarded-*`, `Via`, `X-Real-IP`, `Upgrade`
 *    and oversized/too-many headers are refused;
 *  - `Content-Encoding` (compressed bodies) is refused;
 *  - an **unknown** route target is answered `404` and the socket torn down
 *    *immediately*, without reading or draining the (possibly huge) body;
 *  - the request is **authenticated at the edge, before the body is read**: a
 *    required `authorizePreamble` checks the bearer credential for the matched
 *    route's role (constant-time). A wrong/missing credential gets `401` and a
 *    closed socket *before* a single body byte is buffered, so an unauthenticated
 *    local peer cannot park many 5 MiB request buffers. The in-`Broker` auth
 *    check remains as a second gate;
 *  - only then is the body counted while streaming; the read stops *immediately*
 *    over the route's cap (the socket is not drained until end), then decoded
 *    with fatal UTF-8 before JSON parsing. Caller routes are capped at
 *    `maxRequestBytes`; the app's authenticated `reply` upload is bounded
 *    separately at `maxAppReplyBytes` so an allowed Core `get_note` body
 *    (1M chars / ~4 MiB UTF-8) can be delivered. No caller route gains that
 *    larger cap, and the serialized response is bounded by `maxResponseBytes`.
 *
 * A finite `maxConnections` bound (`SERVER_LIMITS.maxConnections`) caps how many
 * loopback sockets may be open at once, so a peer cannot hold unbounded
 * half-read request buffers.
 */
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SERVER_LIMITS,
  LOOPBACK_HOST,
  maxRequestBytesForRoute
} from "./limits.js";
import { authenticate, type BrokerCredentials } from "./credentials.js";
import { brokerErrorEnvelope, type BrokerErrorEnvelope } from "./errors.js";
import { brokerFail, routePath, BROKER_ROUTES, type BrokerResponse, type BrokerRoute } from "./broker-wire.js";
import { brokerSecureOptions, type TlsMaterial } from "./tls.js";

const MAX_HEADERS = 64;

/** The app-only routes: the app credential is the only one accepted. */
const APP_ROLE_ROUTES: readonly BrokerRoute[] = ["session", "claim", "reply"];
/** The caller-only routes: the MCP credential is the only one accepted. */
const MCP_ROLE_ROUTES: readonly BrokerRoute[] = [
  "hello",
  "submit",
  "await",
  "cancel"
];

/**
 * Header names that must appear exactly once. Node collapses some duplicates
 * (comma-joining) and quietly picks one for others, so a smuggled second
 * `Host`/`Authorization` would otherwise be invisible; the raw header list is
 * checked instead.
 */
const SINGLETON_HEADERS = new Set([
  "host",
  "authorization",
  "content-length",
  "content-encoding",
  "content-type",
  "connection",
  "origin",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "via",
  "x-real-ip"
]);

function hasDuplicateSingletonHeader(req: IncomingMessage): boolean {
  const raw = req.rawHeaders;
  const seen = new Set<string>();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index].toLowerCase();
    if (!SINGLETON_HEADERS.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/** The strict body cap for a route: only the app's `reply` gets the larger one. */
export function maxBodyBytesForRoute(route: BrokerRoute): number {
  return maxRequestBytesForRoute(route);
}

/**
 * The edge authorization preamble. Given the matched route and the raw
 * `Authorization` header, it decides whether the peer may proceed to send a
 * body. It is built from the broker's own constant-time `authenticate` and the
 * two *separate* credentials, so a credential for the wrong role is refused,
 * `health` accepts either, and an unclassified route is refused. It is a
 * required argument of `handleRequest`: a missing callback fails closed rather
 * than acting as an accidental "allow everything".
 */
export type BrokerAuthorizePreamble = (
  route: BrokerRoute,
  authorization: string | undefined
) => boolean;

/** Build the edge preamble from the broker's two role credentials. */
export function createBrokerAuthorizer(
  credentials: Pick<BrokerCredentials, "app" | "mcp">
): BrokerAuthorizePreamble {
  return (route, authorization) => {
    if (route === "health")
      return (
        authenticate(authorization, credentials.app) ||
        authenticate(authorization, credentials.mcp)
      );
    if (APP_ROLE_ROUTES.includes(route))
      return authenticate(authorization, credentials.app);
    if (MCP_ROLE_ROUTES.includes(route))
      return authenticate(authorization, credentials.mcp);
    // Fail closed for any route not explicitly classified above.
    return false;
  };
}

export interface BrokerDispatch {
  (
    route: BrokerRoute,
    authorization: string | undefined,
    body: unknown
  ): Promise<BrokerResponse>;
}

export function statusForError(error: BrokerErrorEnvelope): number {
  switch (error.code) {
    case "BAD_REQUEST":
    case "INVALID_UTF8":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN_ORIGIN":
    case "FORBIDDEN_HOST":
    case "FORBIDDEN_HEADER":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "UNSUPPORTED_ENCODING":
      return 415;
    case "QUEUE_FULL":
    case "ALREADY_CLAIMED":
      return 429;
    case "BROKER_UNAVAILABLE":
    case "APP_UNAVAILABLE":
    case "TRANSPORT_UNAVAILABLE":
    case "SESSION_REQUIRED":
    case "SESSION_CHANGED":
    case "REPLAY":
    case "QUEUE_EMPTY":
    case "UNCERTAIN":
      return 409;
    default:
      return 400;
  }
}

type ReadResult =
  | { kind: "ok"; body: unknown }
  | { kind: "error"; error: BrokerErrorEnvelope; fatal: boolean };

async function readBody(req: IncomingMessage, maxBytes: number): Promise<ReadResult> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string") {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0)
      return { kind: "error", error: brokerErrorEnvelope("BAD_REQUEST"), fatal: false };
    if (length > maxBytes)
      return {
        kind: "error",
        error: brokerErrorEnvelope("PAYLOAD_TOO_LARGE"),
        fatal: true
      };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  let failed = false;
  await new Promise<void>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      if (overflow || failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        overflow = true;
        chunks.length = 0;
        // Stop reading immediately: never drain an unbounded body to end.
        req.pause();
        resolve();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve());
    req.on("aborted", () => {
      failed = true;
      resolve();
    });
    req.on("error", () => {
      failed = true;
      resolve();
    });
  });

  if (overflow)
    return {
      kind: "error",
      error: brokerErrorEnvelope("PAYLOAD_TOO_LARGE"),
      fatal: true
    };
  if (failed)
    return { kind: "error", error: brokerErrorEnvelope("BAD_REQUEST"), fatal: true };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return { kind: "error", error: brokerErrorEnvelope("INVALID_UTF8"), fatal: false };
  }
  try {
    return { kind: "ok", body: JSON.parse(text) };
  } catch {
    return { kind: "error", error: brokerErrorEnvelope("BAD_REQUEST"), fatal: false };
  }
}

function headerViolation(
  req: IncomingMessage,
  port: number
): BrokerErrorEnvelope | undefined {
  // A duplicated singleton header (e.g. a second `Host`/`Authorization`) is
  // refused from the raw list, before Node's collapsing can hide it.
  if (hasDuplicateSingletonHeader(req)) return brokerErrorEnvelope("FORBIDDEN_HEADER");
  const names = Object.keys(req.headers);
  if (names.length > MAX_HEADERS) return brokerErrorEnvelope("FORBIDDEN_HEADER");
  for (const name of names) {
    const raw = req.headers[name];
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    for (const value of values) {
      if (Buffer.byteLength(value, "utf8") > SERVER_LIMITS.maxHeaderValueBytes)
        return brokerErrorEnvelope("FORBIDDEN_HEADER");
    }
    if (name.startsWith("sec-fetch-")) return brokerErrorEnvelope("FORBIDDEN_HEADER");
    if (name.startsWith("x-forwarded-")) return brokerErrorEnvelope("FORBIDDEN_HEADER");
    if (name === "forwarded" || name === "x-real-ip" || name === "via" || name === "upgrade")
      return brokerErrorEnvelope("FORBIDDEN_HEADER");
  }
  // Any present Origin header (including an empty or `null` value) is refused:
  // a native client never sends one, so its presence means a browser context.
  if (Object.prototype.hasOwnProperty.call(req.headers, "origin"))
    return brokerErrorEnvelope("FORBIDDEN_ORIGIN");
  const host = req.headers.host;
  if (host !== `${LOOPBACK_HOST}:${port}`)
    return brokerErrorEnvelope("FORBIDDEN_HOST");
  const encoding = req.headers["content-encoding"];
  if (encoding !== undefined && encoding !== "" && encoding !== "identity")
    return brokerErrorEnvelope("UNSUPPORTED_ENCODING");
  return undefined;
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    port: number;
    dispatch: BrokerDispatch;
    authorizePreamble: BrokerAuthorizePreamble;
  }
): Promise<void> {
  const send = (status: number, response: BrokerResponse): void => {
    let payload = Buffer.from(JSON.stringify(response), "utf8");
    if (payload.byteLength > SERVER_LIMITS.maxResponseBytes) {
      payload = Buffer.from(
        JSON.stringify(brokerFail(brokerErrorEnvelope("TRANSPORT_UNAVAILABLE"))),
        "utf8"
      );
    }
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(payload.byteLength),
      "cache-control": "no-store",
      connection: "close"
    });
    res.end(payload);
  };

  const fail = (error: BrokerErrorEnvelope, fatal: boolean): void => {
    // Flush the bounded error to the client first; only then tear the socket
    // down (an unread/oversized request body must not be drained forever).
    if (fatal) res.once("finish", () => req.destroy());
    send(statusForError(error), brokerFail(error));
  };

  if (req.method !== "POST") {
    fail(brokerErrorEnvelope("BAD_REQUEST"), true);
    return;
  }
  // A missing authorize callback is a configuration error: fail closed for
  // every request instead of treating an absent check as "allowed".
  if (typeof opts.authorizePreamble !== "function") {
    fail(brokerErrorEnvelope("INTERNAL"), true);
    return;
  }
  const violation = headerViolation(req, opts.port);
  if (violation) {
    fail(violation, true);
    return;
  }

  // Compare the *entire* request target against the literal route: a query
  // string, trailing slash or fragment can never be smuggled past an exact
  // match. An unmatched target is `404`ed and the socket destroyed **without**
  // reading or draining the body, so an unknown route can never hold a buffer.
  const target = req.url ?? "";
  const matched = BROKER_ROUTES.find((candidate) => routePath(candidate) === target);
  if (!matched) {
    fail(brokerErrorEnvelope("NOT_FOUND"), true);
    return;
  }

  // Authenticate the edge **before** a single body byte is read. The bearer
  // header is passed as-is (never logged, never echoed) to the constant-time
  // role check; a wrong/missing credential is a `401` with the socket closed,
  // so an unauthenticated peer cannot park a large declared body.
  if (!opts.authorizePreamble(matched, req.headers.authorization)) {
    fail(brokerErrorEnvelope("UNAUTHORIZED"), true);
    return;
  }

  const read = await readBody(req, maxBodyBytesForRoute(matched));
  if (read.kind === "error") {
    fail(read.error, read.fatal);
    return;
  }

  let response: BrokerResponse;
  try {
    response = await opts.dispatch(matched, req.headers.authorization, read.body);
  } catch {
    response = brokerFail(brokerErrorEnvelope("INTERNAL"));
  }
  if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
    response = brokerFail(brokerErrorEnvelope("INTERNAL"));
  }
  send(response.ok ? 200 : statusForError(response.error), response);
}

export function createBrokerHttpsServer(opts: {
  port: number;
  dispatch: BrokerDispatch;
  authorizePreamble: BrokerAuthorizePreamble;
  tls: TlsMaterial;
}): https.Server {
  const server = https.createServer(
    brokerSecureOptions(opts.tls),
    (req, res) => {
      void handleRequest(req, res, opts);
    }
  );
  // Refuse request smuggling surfaces.
  server.on("checkContinue", (_req, res) => {
    res.writeHead(400).end();
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
  });
  // A failed TLS handshake (foreign/wrong certificate) is swallowed: the peer
  // gets nothing, and no diagnostic can echo a peer-supplied string.
  server.on("tlsClientError", () => undefined);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = MAX_HEADERS;
  // Finite socket bound: refuse the overflow connection instead of letting a
  // peer hold unbounded half-read request buffers.
  server.maxConnections = SERVER_LIMITS.maxConnections;
  return server;
}
