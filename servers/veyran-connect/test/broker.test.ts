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
 * Broker state machine + loopback HTTPS edge, over the **real** TLS listener
 * and the real pinned client. No in-process dispatch shortcut is used for the
 * protocol tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createHandshakeNonce, formatBearerToken } from "../src/credentials.js";
import { BrokerClient, BrokerHttpError } from "../src/client.js";
import { maxBodyBytesForRoute } from "../src/https.js";
import { SERVER_LIMITS, maxRequestBytesForRoute } from "../src/limits.js";
import { routePath, type BrokerResponse, type BrokerRoute } from "../src/broker-wire.js";
import {
  AppConnection,
  makeProfile,
  rawHttpsPost,
  rawTlsChunkedUpload,
  rawTlsRequest,
  startBroker,
  type StartedBroker
} from "./harness.js";

const STATUS_REQUEST = { operation: "status" };

const STATUS_RESPONSE = {
  operation: "status",
  version: 1,
  account: "signed_in",
  status: "ready",
  available: true,
  grantsGeneration: 1,
  capabilities: { read: true, create: true, change: true, task: true },
  journal: { capacity: 1000, count: 0 },
  sync: "unknown"
};

const running: StartedBroker[] = [];

/** The numeric status from a raw HTTP/1.1 response's status line. */
function statusLineOf(text: string): number {
  const match = /^HTTP\/1\.1 (\d{3})\b/.exec(text);
  return match ? Number(match[1]) : 0;
}

/**
 * True only once a *complete, bounded* `413 PAYLOAD_TOO_LARGE` response is
 * buffered: the status line is `413`, the declared `content-length` body has
 * fully arrived and it names the fail-closed code. This is the sole condition
 * under which a later client write `EPIPE`/reset may be tolerated.
 */
function isCompleteBoundedTooLarge(text: string): boolean {
  if (!/^HTTP\/1\.1 413\b/.test(text)) return false;
  const separator = text.indexOf("\r\n\r\n");
  if (separator < 0) return false;
  const head = text.slice(0, separator);
  const length = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(head);
  if (!length) return false;
  const body = text.slice(separator + 4);
  if (Buffer.byteLength(body, "utf8") < Number(length[1])) return false;
  return body.includes("PAYLOAD_TOO_LARGE");
}

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.stop();
});

async function boot(options: Parameters<typeof startBroker>[1] = {}): Promise<StartedBroker> {
  const profile = await makeProfile();
  const started = await startBroker(profile, options);
  running.push(started);
  return started;
}

function appConnection(started: StartedBroker): AppConnection {
  return new AppConnection({
    port: started.port,
    credential: started.profile.credentials.app,
    rootPem: started.profile.tls.rootPem,
    leafPin: started.profile.tls.leafPin
  });
}

function mcpClient(started: StartedBroker): BrokerClient {
  return new BrokerClient({
    port: started.port,
    credential: started.profile.credentials.mcp,
    rootPem: started.profile.tls.rootPem,
    leafPin: started.profile.tls.leafPin,
    timeoutMs: 5_000
  });
}

/** Narrow a `BrokerResponse` to its success member, failing the test otherwise. */
function expectOk(response: BrokerResponse): unknown {
  if (!response.ok)
    throw new Error(`expected a successful response, got ${response.error.code}`);
  return response.result;
}

/** Narrow a `BrokerResponse` to its failure member and return the error code. */
function errorCodeOf(response: BrokerResponse): string {
  expect(response.ok).toBe(false);
  if (response.ok) return "";
  return response.error.code;
}

describe("broker protocol over real TLS", () => {
  it("authenticates every route with the right role credential", async () => {
    const started = await boot();
    const mcp = formatBearerToken(started.profile.credentials.mcp);
    const app = formatBearerToken(started.profile.credentials.app);
    const post = (authorization: string | undefined, path: string, body: unknown) =>
      rawHttpsPost({
        port: started.port,
        rootPem: started.profile.tls.rootPem,
        leafPin: started.profile.tls.leafPin,
        path,
        ...(authorization ? { headers: { authorization } } : {}),
        body: JSON.stringify(body)
      });

    expect((await post(undefined, routePath("health"), { v: 1 })).status).toBe(401);
    expect((await post(app, routePath("health"), { v: 1 })).status).toBe(200);
    expect((await post(mcp, routePath("health"), { v: 1 })).status).toBe(200);
    // The app credential can never drive `hello`; the MCP credential can never
    // open an app session.
    expect(
      (await post(app, routePath("hello"), { v: 1, clientNonce: createHandshakeNonce() })).status
    ).toBe(401);
    expect(
      (
        await post(mcp, routePath("session"), {
          v: 1,
          clientNonce: createHandshakeNonce(),
          accountId: "acct-1",
          grantsGeneration: 1
        })
      ).status
    ).toBe(401);
  });

  it("replaces the app session on relaunch and refuses the old session id", async () => {
    const started = await boot();
    const app = appConnection(started);
    const first = await app.session("acct-1");
    const second = await app.session("acct-1");
    expect(second).not.toBe(first);
    const stale = await rawHttpsPost({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      path: routePath("claim"),
      headers: { authorization: formatBearerToken(started.profile.credentials.app) },
      body: JSON.stringify({ v: 1, sessionId: first, nonce: 1, clientId: "client-1" })
    });
    expect((stale.body as { error: { code: string } }).error.code).toBe("SESSION_CHANGED");
  });

  it("refuses a replayed handshake nonce", async () => {
    const started = await boot();
    const nonce = createHandshakeNonce();
    const app = formatBearerToken(started.profile.credentials.app);
    const body = JSON.stringify({ v: 1, clientNonce: nonce, accountId: "acct-1", grantsGeneration: 1 });
    const first = await rawHttpsPost({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      path: routePath("session"),
      headers: { authorization: app },
      body
    });
    expect(first.status).toBe(200);
    const replay = await rawHttpsPost({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      path: routePath("session"),
      headers: { authorization: app },
      body
    });
    expect((replay.body as { error: { code: string } }).error.code).toBe("REPLAY");
  });

  it("gives every MCP caller instance its own nonce sequence (restart safe)", async () => {
    const started = await boot();
    const app = appConnection(started);
    await app.session("acct-1");
    // A single client instance can run many sequential tools without REPLAY.
    const client = mcpClient(started);
    for (let index = 0; index < 3; index++) {
      const submitted = await client.submit(STATUS_REQUEST);
      expect(submitted.ok).toBe(true);
    }
    // A brand new client instance (a restarted MCP server) handshakes afresh.
    const restarted = mcpClient(started);
    const submitted = await restarted.submit(STATUS_REQUEST);
    expect(submitted.ok).toBe(true);
  });

  it("reports APP_UNAVAILABLE when no app session exists", async () => {
    const started = await boot();
    const client = mcpClient(started);
    const submitted = await client.submit(STATUS_REQUEST);
    expect(errorCodeOf(submitted)).toBe("APP_UNAVAILABLE");
  });

  it("submits, claims, replies and awaits exactly one correlated response", async () => {
    const started = await boot();
    const app = appConnection(started);
    await app.session("acct-1");
    const client = mcpClient(started);

    const submitted = await client.submit(STATUS_REQUEST);
    expect(submitted.ok).toBe(true);
    const ticketId = (expectOk(submitted) as { ticketId: string }).ticketId;

    const claimed = await app.claim("client-1");
    expect((expectOk(claimed) as { item: { ticketId: string } }).item.ticketId).toBe(
      ticketId
    );

    // One unanswered claim per client.
    const second = await app.claim("client-1");
    expect(errorCodeOf(second)).toBe("ALREADY_CLAIMED");

    const pending = client.awaitResponse(ticketId);
    const replied = await app.reply("client-1", ticketId, {
      ok: true,
      result: STATUS_RESPONSE
    });
    expect(replied.ok).toBe(true);
    const awaited = await pending;
    expect(awaited.ok).toBe(true);
    expect((expectOk(awaited) as { response: unknown }).response).toEqual({
      ok: true,
      result: STATUS_RESPONSE
    });

    // A delivered response can never be replayed.
    const replay = await client.awaitResponse(ticketId);
    expect(errorCodeOf(replay)).toBe("REPLAY");
  });

  it("refuses an uncorrelated or non-catalog reply", async () => {
    const started = await boot();
    const app = appConnection(started);
    await app.session("acct-1");
    const client = mcpClient(started);
    const submitted = await client.submit(STATUS_REQUEST);
    const ticketId = (expectOk(submitted) as { ticketId: string }).ticketId;
    await app.claim("client-1");
    const bad = await app.reply("client-1", ticketId, {
      ok: true,
      result: {
        operation: "create_note",
        operationId: "op",
        noteId: "note-000000000000000000000001",
        revision: "r",
        url: "nn://note/n",
        persisted: "local_saved",
        sync: "unknown"
      }
    });
    expect(errorCodeOf(bad)).toBe("BAD_REQUEST");
    const badError = await app.reply("client-1", ticketId, {
      ok: false,
      error: { code: "NOT_AUTHORIZED", message: "SQLITE_BUSY" }
    });
    expect(errorCodeOf(badError)).toBe("BAD_REQUEST");
  });

  it("bounds the queue at 32 and releases capacity after completion", async () => {
    const started = await boot();
    const app = appConnection(started);
    await app.session("acct-1");
    const client = mcpClient(started);
    for (let index = 0; index < 32; index++) {
      const response = await client.submit(STATUS_REQUEST);
      expect(response.ok).toBe(true);
    }
    const overflow = await client.submit(STATUS_REQUEST);
    expect(errorCodeOf(overflow)).toBe("QUEUE_FULL");

    const claimed = await app.claim("app-cli");
    const item = (expectOk(claimed) as { item: { ticketId: string } }).item;
    const pending = client.awaitResponse(item.ticketId);
    await app.reply("app-cli", item.ticketId, { ok: true, result: STATUS_RESPONSE });
    expect((await pending).ok).toBe(true);

    // The delivered request no longer occupies a slot.
    const after = await client.submit(STATUS_REQUEST);
    expect(after.ok).toBe(true);
  });

  it("removes a request cancelled before claim and reports uncertainty after", async () => {
    const started = await boot();
    const app = appConnection(started);
    await app.session("acct-1");
    const client = mcpClient(started);

    const first = await client.submit(STATUS_REQUEST);
    const firstTicket = (expectOk(first) as { ticketId: string }).ticketId;
    const removed = await client.cancel(firstTicket);
    expect(expectOk(removed)).toEqual({ removed: true, uncertain: false, completed: false });

    const second = await client.submit(STATUS_REQUEST);
    const secondTicket = (expectOk(second) as { ticketId: string }).ticketId;
    await app.claim("client-1");
    const uncertain = await client.cancel(secondTicket);
    expect((expectOk(uncertain) as { uncertain: boolean }).uncertain).toBe(true);
    const awaited = await client.awaitResponse(secondTicket);
    expect(errorCodeOf(awaited)).toBe("UNCERTAIN");
  });

  it("reports APP_UNAVAILABLE when the app never replies", async () => {
    const started = await boot({ ttlMs: 60 });
    const app = appConnection(started);
    await app.session("acct-1");
    const client = mcpClient(started);
    const submitted = await client.submit(STATUS_REQUEST);
    const ticketId = (expectOk(submitted) as { ticketId: string }).ticketId;
    const awaited = await client.awaitResponse(ticketId);
    expect(errorCodeOf(awaited)).toBe("APP_UNAVAILABLE");
  });

  it("reports UNCERTAIN when a claimed request times out without a reply", async () => {
    const started = await boot({ ttlMs: 60 });
    const app = appConnection(started);
    await app.session("acct-1");
    const client = mcpClient(started);
    const submitted = await client.submit(STATUS_REQUEST);
    const ticketId = (expectOk(submitted) as { ticketId: string }).ticketId;
    // Claim it, then never reply: the write may have happened, so the outcome
    // must be uncertain rather than merely unavailable.
    await app.claim("client-1");
    const awaited = await client.awaitResponse(ticketId);
    expect(errorCodeOf(awaited)).toBe("UNCERTAIN");
  });

  it("purges a previous account's queued work on an account switch", async () => {
    const started = await boot();
    const app = appConnection(started);
    await app.session("account-A");
    const client = mcpClient(started);
    const submitted = await client.submit(STATUS_REQUEST);
    const ticketId = (expectOk(submitted) as { ticketId: string }).ticketId;

    // Switch to account B; A's context is purged.
    await app.session("account-B");
    const claimed = await app.claim("app-cli");
    expect((expectOk(claimed) as { item: unknown }).item).toBeNull();
    // The old claim's reply is refused (entry gone).
    const stale = await app.reply("app-cli", ticketId, { ok: true, result: STATUS_RESPONSE });
    expect(errorCodeOf(stale)).toBe("NOT_FOUND");
  });

  it("never exposes ids or payloads through describe()", async () => {
    const started = await boot();
    expect(Object.keys(started.broker.describe()).sort()).toEqual([
      "closed",
      "hasSession",
      "queueDepth"
    ]);
  });

  it("keeps the single app lease alive across a burst of caller instances", async () => {
    const started = await boot();
    const app = appConnection(started);
    const sessionId = await app.session("acct-1");
    // Well over `maxInstances` (8) fresh caller instances: each does its own
    // `hello`. Caller churn must never evict the live app session.
    for (let index = 0; index < 12; index++) {
      const caller = mcpClient(started);
      const submitted = await caller.submit(STATUS_REQUEST);
      expect(submitted.ok).toBe(true);
    }
    expect(app.currentSessionId).toBe(sessionId);
    // The app can still claim the queued work: the lease survived.
    const claimed = await app.claim("app-cli");
    expect(claimed.ok).toBe(true);
    expect((expectOk(claimed) as { item: unknown }).item).not.toBeNull();
  });

  it("recovers from a broker restart by re-handshaking the caller instance", async () => {
    const profile = await makeProfile();
    const first = await startBroker(profile);
    running.push(first);
    const app = new AppConnection({
      port: first.port,
      credential: profile.credentials.app,
      rootPem: profile.tls.rootPem,
      leafPin: profile.tls.leafPin
    });
    await app.session("acct-1");
    const client = new BrokerClient({
      port: first.port,
      credential: profile.credentials.mcp,
      rootPem: profile.tls.rootPem,
      leafPin: profile.tls.leafPin,
      timeoutMs: 5_000
    });
    expect((await client.submit(STATUS_REQUEST)).ok).toBe(true);

    // Restart the broker on the same port with the same material: the caller's
    // instance is gone. The client must transparently re-handshake (a stale
    // instance would otherwise surface as SESSION_CHANGED/TRANSPORT_UNAVAILABLE)
    // and then honestly report that the app is not connected.
    await first.stop();
    const restarted = await startBroker(profile, { port: first.port });
    running.push(restarted);
    const afterRestart = await client.submit(STATUS_REQUEST);
    expect(errorCodeOf(afterRestart)).toBe("APP_UNAVAILABLE");
  });

  it("resolves a parked await honestly when a queued request is cancelled", async () => {
    const started = await boot();
    const app = appConnection(started);
    await app.session("acct-1");
    const client = mcpClient(started);
    const submitted = await client.submit(STATUS_REQUEST);
    const ticketId = (expectOk(submitted) as { ticketId: string }).ticketId;

    const pending = client.awaitResponse(ticketId);
    // Let the `await` reach the broker and park before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelled = await client.cancel(ticketId);
    expect(expectOk(cancelled)).toEqual({
      removed: true,
      uncertain: false,
      completed: false
    });
    // The parked await resolves `unavailable`/`not found` — never a fabricated
    // response and never `uncertain`, since nothing could have been written.
    const awaited = await pending;
    expect(["APP_UNAVAILABLE", "NOT_FOUND"]).toContain(errorCodeOf(awaited));
  });

  it("cancels a submit during a slow handshake without enqueuing it", async () => {
    const profile = await makeProfile();
    const started = await startBroker(profile, { delay: { hello: 250 } });
    running.push(started);
    const app = appConnection(started);
    await app.session("acct-1");
    const client = mcpClient(started);

    const controller = new AbortController();
    const pending = client.submit(STATUS_REQUEST, controller.signal);
    // Abort while the (shared) `hello` handshake is still parked.
    controller.abort();

    // The submit never reached the socket: a provable pre-transmit abort.
    await expect(pending).rejects.toBeInstanceOf(BrokerHttpError);

    // Nothing was enqueued for the app to claim; the app lease is untouched.
    const claimed = await app.claim("app-cli");
    expect(expectOk(claimed)).toEqual({ item: null });
    expect(started.broker.queueDepth).toBe(0);
    expect(started.broker.hasSession).toBe(true);
  });
});

describe("loopback HTTPS edge hardening", () => {
  it("accepts an exact Host and rejects a foreign one", async () => {
    const started = await boot();
    const ok = await rawHttpsPost({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      path: routePath("health"),
      headers: { authorization: formatBearerToken(started.profile.credentials.mcp) },
      body: JSON.stringify({ v: 1 })
    });
    expect(ok.status).toBe(200);
    // A raw pinned-TLS request dials the fixed numeric endpoint (so the pin
    // checker passes) but hand-writes a foreign HTTP `Host`. `https.request`
    // cannot express this: it derives the TLS `checkServerIdentity` hostname
    // from the `Host` header, so the pinned client would reject at the
    // handshake and never reach the server's HTTP `Host` guard. The raw socket
    // keeps the real TLS identity and still reaches — and is refused by — the
    // production `FORBIDDEN_HOST` check.
    const body = JSON.stringify({ v: 1 });
    const foreign =
      `POST ${routePath("health")} HTTP/1.1\r\n` +
      `Host: localhost:${started.port}\r\n` +
      `Authorization: ${formatBearerToken(started.profile.credentials.mcp)}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n` +
      body;
    const badText = await rawTlsRequest({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      raw: foreign
    });
    expect(statusLineOf(badText)).toBe(403);
    expect(badText).toContain("FORBIDDEN_HOST");
    expect(badText).not.toContain('"ok":true');
    // The exact `127.0.0.1:<port>` Host is the only accepted one; the guard
    // lives in the production server, not in a weakened client pin checker.
    expect(started.broker.hasSession).toBe(false);
  });

  it("matches the whole literal request target (no query string or trailing slash)", async () => {
    const started = await boot();
    const auth = formatBearerToken(started.profile.credentials.mcp);
    for (const path of ["/v1/health?v=1", "/v1/health/", "/v1/health?x=/v1/claim"]) {
      const response = await rawHttpsPost({
        port: started.port,
        rootPem: started.profile.tls.rootPem,
        leafPin: started.profile.tls.leafPin,
        path,
        headers: { authorization: auth },
        body: JSON.stringify({ v: 1 })
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    }
  });

  it("refuses a duplicated singleton Authorization header", async () => {
    const started = await boot();
    const auth = formatBearerToken(started.profile.credentials.mcp);
    const body = JSON.stringify({ v: 1 });
    const raw =
      `POST /v1/health HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${started.port}\r\n` +
      `Authorization: ${auth}\r\n` +
      `Authorization: ${auth}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n` +
      body;
    const text = await rawTlsRequest({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      raw
    });
    expect(text).toContain("403");
    expect(text).toContain("FORBIDDEN_HEADER");
    expect(text).not.toContain('"ok":true');
  });

  it("refuses ANY Origin header, including null", async () => {
    const started = await boot();
    for (const origin of ["null", `http://localhost:${started.port}`, "http://evil.example"]) {
      const response = await rawHttpsPost({
        port: started.port,
        rootPem: started.profile.tls.rootPem,
        leafPin: started.profile.tls.leafPin,
        path: routePath("health"),
        headers: {
          authorization: formatBearerToken(started.profile.credentials.mcp),
          origin
        },
        body: JSON.stringify({ v: 1 })
      });
      expect(response.status).toBe(403);
      expect((response.body as { error: { code: string } }).error.code).toBe(
        "FORBIDDEN_ORIGIN"
      );
    }
  });

  it("refuses hop-by-hop/rebinding headers and compressed bodies", async () => {
    const started = await boot();
    for (const header of ["sec-fetch-site", "x-forwarded-for", "forwarded", "via"]) {
      const response = await rawHttpsPost({
        port: started.port,
        rootPem: started.profile.tls.rootPem,
        leafPin: started.profile.tls.leafPin,
        path: routePath("health"),
        headers: { authorization: formatBearerToken(started.profile.credentials.mcp), [header]: "x" },
        body: JSON.stringify({ v: 1 })
      });
      expect(response.status).toBe(403);
      expect((response.body as { error: { code: string } }).error.code).toBe(
        "FORBIDDEN_HEADER"
      );
    }
    const compressed = await rawHttpsPost({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      path: routePath("health"),
      headers: {
        authorization: formatBearerToken(started.profile.credentials.mcp),
        "content-encoding": "gzip"
      },
      body: JSON.stringify({ v: 1 })
    });
    expect(compressed.status).toBe(415);
  });

  it("rejects non-POST, unknown routes, invalid UTF-8 and oversized bodies", async () => {
    const started = await boot();
    const auth = formatBearerToken(started.profile.credentials.mcp);
    const base = {
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin
    };
    const get = await rawHttpsPost({
      ...base,
      path: routePath("health"),
      method: "GET",
      headers: { authorization: auth }
    });
    expect(get.status).toBe(400);

    const missing = await rawHttpsPost({
      ...base,
      path: "/v1/nope",
      headers: { authorization: auth },
      body: "{}"
    });
    expect(missing.status).toBe(404);

    const invalid = await rawHttpsPost({
      ...base,
      path: routePath("health"),
      headers: { authorization: auth },
      body: Buffer.from([0xff, 0xfe, 0xfd])
    });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { error: { code: string } }).error.code).toBe("INVALID_UTF8");

    // A declared body over the route cap is refused *immediately*, before any
    // byte is read: the request carries only `Content-Length` above the cap and
    // no body at all, and the server still answers a bounded `413`. Sending the
    // body via `https.request` would surface as a client `EPIPE` (the server
    // tears the socket down while the client is still writing) before the 413
    // could be observed, so the declared case is proven with a raw pinned-TLS
    // request that sends headers only.
    const overCap =
      `POST ${routePath("health")} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${started.port}\r\n` +
      `Authorization: ${auth}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${SERVER_LIMITS.maxRequestBytes + 1}\r\n` +
      `Connection: close\r\n\r\n`;
    const hugeText = await rawTlsRequest({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      raw: overCap,
      timeoutMs: 4_000
    });
    expect(statusLineOf(hugeText)).toBe(413);
    expect(hugeText).toContain("PAYLOAD_TOO_LARGE");
    expect(hugeText).not.toContain('"ok":true');
  });

  it("stops an unknown-length streamed body the moment it passes the route cap", async () => {
    const started = await boot();
    const auth = formatBearerToken(started.profile.credentials.mcp);
    // 128 × 32 KiB ≈ 4 MiB, far beyond the 1 MiB caller cap, streamed with no
    // declared length via real chunked frames. The server must refuse once it
    // has *read* past the cap — not after draining the whole upload — so the
    // terminating chunk is never written and the client is stopped early.
    const chunk = Buffer.alloc(32 * 1024, 0x61);
    const head =
      `POST ${routePath("health")} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${started.port}\r\n` +
      `Authorization: ${auth}\r\n` +
      `Content-Type: application/json\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `Connection: close\r\n\r\n`;
    const result = await rawTlsChunkedUpload({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      head,
      chunks: Array.from({ length: 128 }, () => chunk),
      chunkDelayMs: 4,
      timeoutMs: 8_000,
      isComplete: isCompleteBoundedTooLarge
    });
    expect(statusLineOf(result.text)).toBe(413);
    expect(result.text).toContain("PAYLOAD_TOO_LARGE");
    expect(result.text).not.toContain('"ok":true');
    expect(result.stoppedEarly).toBe(true);
    expect(result.chunksWritten).toBeLessThan(result.chunksTotal);
  });

  it("returns an honest 401 for a bad credential", async () => {
    const started = await boot();
    const response = await rawHttpsPost({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      path: routePath("health"),
      headers: {
        authorization: `Bearer ${randomBytes(16).toString("hex")}.${randomBytes(32).toString("base64url")}`
      },
      body: JSON.stringify({ v: 1 })
    });
    expect(response.status).toBe(401);
    expect((response.body as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
  });

  it("authenticates at the edge before reading: a wrong-role 5 MiB claim gets an immediate 401", async () => {
    const started = await boot();
    // Two wrong authorizations for the app-only `reply` route: a random
    // well-formed credential and the (valid but wrong-role) MCP credential. The
    // edge must refuse before the declared, never-sent 5 MiB body is buffered;
    // if the server tried to read it this would hang until the request timeout.
    const wrongAuthorizations = [
      `Bearer ${randomBytes(16).toString("hex")}.${randomBytes(32).toString("base64url")}`,
      formatBearerToken(started.profile.credentials.mcp)
    ];
    for (const authorization of wrongAuthorizations) {
      const raw =
        `POST ${routePath("reply")} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${started.port}\r\n` +
        `Authorization: ${authorization}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${5 * 1024 * 1024}\r\n` +
        `Connection: close\r\n\r\n`;
      const text = await rawTlsRequest({
        port: started.port,
        rootPem: started.profile.tls.rootPem,
        leafPin: started.profile.tls.leafPin,
        raw,
        timeoutMs: 4_000
      });
      expect(text).toContain("401");
      expect(text).toContain("UNAUTHORIZED");
      expect(text).not.toContain('"ok":true');
    }
    // No body was read and nothing reached the broker state machine.
    expect(started.broker.queueDepth).toBe(0);
    expect(started.broker.hasSession).toBe(false);
  });

  it("answers an unknown route immediately without draining a declared large body", async () => {
    const started = await boot();
    const raw =
      `POST /v1/nope HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${started.port}\r\n` +
      `Authorization: ${formatBearerToken(started.profile.credentials.mcp)}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${5 * 1024 * 1024}\r\n` +
      `Connection: close\r\n\r\n`;
    const text = await rawTlsRequest({
      port: started.port,
      rootPem: started.profile.tls.rootPem,
      leafPin: started.profile.tls.leafPin,
      raw,
      timeoutMs: 4_000
    });
    expect(text).toContain("404");
    expect(text).toContain("NOT_FOUND");
    expect(text).not.toContain('"ok":true');
  });

  it("rejects an oversized caller request client-side before it reaches the socket", async () => {
    const started = await boot();
    const client = mcpClient(started);
    // Any caller-facing route is capped at 1 MiB by the client itself: the
    // request is never written, so the broker never sees it.
    await expect(
      client.submit({ operation: "create_note", content: "a".repeat(1024 * 1024 + 64) })
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  it("keeps the 5 MiB request cap strictly app-`reply`-only", () => {
    expect(maxRequestBytesForRoute("reply")).toBe(SERVER_LIMITS.maxAppReplyBytes);
    for (const route of ["health", "session", "hello", "submit", "claim", "await", "cancel"]) {
      expect(maxRequestBytesForRoute(route)).toBe(SERVER_LIMITS.maxRequestBytes);
      expect(maxBodyBytesForRoute(route as BrokerRoute)).toBe(
        SERVER_LIMITS.maxRequestBytes
      );
    }
    expect(maxBodyBytesForRoute("reply")).toBe(SERVER_LIMITS.maxAppReplyBytes);
    expect(maxBodyBytesForRoute("reply")).toBe(
      maxRequestBytesForRoute("reply")
    );
  });
});
