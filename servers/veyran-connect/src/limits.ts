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
 * Bounded transport limits for the VeyraN Connect broker and the stdio MCP
 * server. These are *transport* limits, separate from the pure Core content
 * limits (`CONTENT_LIMITS` in the Core contract) which bound note/task payload
 * sizes on the operation schemas.
 */
export const SERVER_LIMITS = {
  /** Largest accepted broker request body (bytes of the UTF-8 body). */
  maxRequestBytes: 1024 * 1024, // 1 MiB
  /**
   * Largest number of concurrent broker sockets (Node's `server.maxConnections`).
   * A finite, documented bound so a peer cannot open unbounded loopback
   * connections and hold many in-flight request buffers. Node refuses the
   * overflow connection by closing it.
   */
  maxConnections: 64,
  /** Largest broker response body the MCP client will buffer (bytes). */
  maxResponseBytes: 5 * 1024 * 1024, // 5 MiB
  /** Largest `get_note` body returned over the broker (bytes). */
  maxGetBodyBytes: 4 * 1024 * 1024, // 4 MiB
  /**
   * Largest accepted app→broker `reply` body. The app uploads a correlated
   * response that may carry an allowed Core `get_note` body (up to 1M chars /
   * ~4 MiB UTF-8, plus JSON). Only the authenticated app `reply` route uses
   * this; every caller-facing route stays strictly at `maxRequestBytes`.
   */
  maxAppReplyBytes: 5 * 1024 * 1024, // 5 MiB
  /** Bounded broker queue depth (queued + in-flight requests). */
  maxQueueDepth: 32,
  /** One in-flight claim per app client. */
  maxClaimsPerClient: 1,
  /**
   * Hard request lifetime. A request that is neither claimed nor replied to
   * within this window is purged (RAM only, no disk). Never more than 30s.
   */
  requestTtlMs: 30_000,
  /** How long a delivered response entry is kept so replays are refused. */
  deliveredRetentionMs: 5_000,
  /** Bounded TTL for an app session / MCP caller instance. */
  instanceTtlMs: 120_000,
  /** Periodic cleanup cadence (queued, claimed, delivered, instances). */
  cleanupIntervalMs: 1_000,
  /** Bounded number of live app sessions + caller instances retained. */
  maxInstances: 8,
  /** Bounded recent-handshake replay window per role. */
  handshakeReplayWindow: 64,
  /** Aggregate unread stdin buffer for the stdio transport. */
  maxStdioBufferBytes: 1024 * 1024, // 1 MiB
  /** Exactly one app session/lease at a time. */
  maxAppSessions: 1,
  /** Entropy for either broker credential, in bits. */
  credentialBits: 256,
  /** Entropy for a handshake nonce/instance id, in bits. */
  handshakeBits: 128,
  /** Largest accepted credential file (bytes). */
  maxCredentialFileBytes: 64 * 1024,
  /** Largest accepted JSON config/connection file (bytes). */
  maxConfigFileBytes: 64 * 1024,
  /** Largest accepted PEM certificate material (bytes). */
  maxCertPemBytes: 16 * 1024,
  /** Largest accepted `Host`/`Origin`/`Sec-Fetch` header value (bytes). */
  maxHeaderValueBytes: 1024,
  /**
   * Smallest accepted validity of the generated root CA, in days. Two is the
   * minimum that still lets the leaf be minted one day shorter (1 day) while
   * the root always outlives the leaf; a 1-day request would need a leaf with
   * the *same* `notAfter` day as its later-signed root, so it is refused rather
   * than silently given a hidden one-minute grace.
   */
  minCertValidityDays: 2,
  /**
   * Validity of the generated root CA, in days (the leaf is minted one day
   * shorter). The persisted material lifetime is therefore this bounded window.
   */
  certValidityDays: 365
} as const;

/**
 * The route-aware broker request-body cap. Only the app-authenticated `reply`
 * upload may carry an allowed Core `get_note` body (1M chars ≈ ~4 MiB UTF-8,
 * plus JSON), so it alone gets `maxAppReplyBytes`; **every** other route stays
 * at the strict `maxRequestBytes`. This is the single source of truth used by
 * both the HTTPS edge (`https.ts`) and the caller client (`client.ts`) so a
 * larger cap can never be requested for a caller-facing route.
 */
export function maxRequestBytesForRoute(route: string): number {
  return route === "reply"
    ? SERVER_LIMITS.maxAppReplyBytes
    : SERVER_LIMITS.maxRequestBytes;
}

/**
 * Bounded limits for the official Notesnook Inbox API capture path
 * (`capture_note`) — the one tool that talks to a public endpoint
 * (`https://inbox.notesnook.com/`) instead of the loopback broker.
 *
 * These are **our** conservative bounds, deliberately far below the documented
 * service limits (`10 MB` body, `60 req/min/IP`): the documented 10 MB is never
 * used as a local budget. Every value is an *upper* bound enforced before a
 * socket is opened and while a response is read; nothing here is derived from
 * the request or the environment.
 */
export const INBOX_LIMITS = {
  /** Largest accepted capture title (chars); matches the Core title bound. */
  maxTitleChars: 512,
  /** Largest accepted capture title (UTF-8 bytes). */
  maxTitleBytes: 2 * 1024,
  /**
   * Largest accepted capture text (UTF-8 bytes) — the *raw* plain text or
   * Markdown the model supplied (1 MiB, the conservative local choice).
   */
  maxContentBytes: 1024 * 1024, // 1 MiB
  /**
   * Largest accepted derived HTML document (UTF-8 bytes). Escaping and markup
   * generation can expand the input (up to ~6x), so the derived form has its
   * own bound; exceeding it is a bounded refusal, never a silent truncation.
   */
  maxHtmlBytes: 2 * 1024 * 1024, // 2 MiB
  /** Largest accepted JSON request body (UTF-8 bytes) before sending. */
  maxRequestBytes: 4 * 1024 * 1024, // 4 MiB
  /** Largest response body read (UTF-8 bytes) before the socket is destroyed. */
  maxResponseBytes: 16 * 1024, // 16 KiB
  /** Hard end-to-end timeout for one capture request. */
  requestTimeoutMs: 15_000,
  /** Bounded shape of the operator's Inbox API key (chars, printable ASCII). */
  minKeyChars: 16,
  maxKeyChars: 1024,
  /** Largest accepted Inbox key file (bytes). */
  maxKeyFileBytes: 16 * 1024,
  /** Bounded local write-receipt history (newest wins, oldest dropped). */
  maxReceipts: 256,
  /** Largest accepted receipt file (bytes). */
  maxReceiptsFileBytes: 128 * 1024,
  /** Bound on the model-supplied stable operation id. */
  maxOperationIdChars: 128
} as const;

export const BROKER_PROTOCOL_VERSION = 1 as const;
export const VEYRAN_CONNECT_SERVICE = "veyran-connect" as const;
export const TLS_MIN_VERSION = "TLSv1.2" as const;
/** The only loopback address the broker ever binds or dials. */
export const LOOPBACK_HOST = "127.0.0.1" as const;
