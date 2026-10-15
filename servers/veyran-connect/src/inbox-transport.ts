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
 * The one outbound HTTPS call of this server: the official Notesnook Inbox API.
 *
 * Fixed destination, no exceptions: the host, port, path and method are literal
 * constants in this file and are never taken from an argument, the environment,
 * the profile or the model. There is no proxy, no redirect following (Node's
 * HTTPS client never follows one, and this module never reads `location`), no
 * custom agent, no CA override and no plaintext HTTP path — `node:https` with
 * `rejectUnauthorized: true` and TLS >= 1.2 only. The request carries exactly
 * four headers the documented endpoint needs; the key travels only in the
 * `Authorization` header of this one request.
 *
 * Outcome classification is deliberately asymmetric (see `classifyInboxResponse`):
 * only a documented `200 {"success":true}` is *accepted*, only the documented
 * refusal statuses are *refused*, and everything else — including a timeout, a
 * truncated body or a dropped socket after the body was written — is
 * `unconfirmed`, i.e. "may have reached the endpoint". A connection that never
 * carried the request (DNS/TCP/TLS failure, or a cancel/timeout before the body
 * was flushed) is `not_sent`, and is the only failure that may be retried
 * without new evidence.
 */
import https from "node:https";
import { INBOX_LIMITS } from "./limits.js";

/** The documented endpoint: exact scheme, host, port and path. */
export const INBOX_ENDPOINT_URL = "https://inbox.notesnook.com/";
export const INBOX_ENDPOINT_HOST = "inbox.notesnook.com";
export const INBOX_ENDPOINT_PORT = 443;
export const INBOX_ENDPOINT_PATH = "/";

/** Statuses the documented contract defines as a refusal (nothing queued). */
export const INBOX_REFUSAL_STATUSES: Readonly<
  Record<number, "INBOX_REJECTED" | "INBOX_UNAUTHORIZED" | "INBOX_RATE_LIMITED">
> = Object.freeze({
  400: "INBOX_REJECTED",
  401: "INBOX_UNAUTHORIZED",
  403: "INBOX_UNAUTHORIZED",
  429: "INBOX_RATE_LIMITED"
});

export type InboxRefusalCode = "INBOX_REJECTED" | "INBOX_UNAUTHORIZED" | "INBOX_RATE_LIMITED";

export type InboxOutcome =
  /** Documented `200 {"success":true}`: encrypted and queued by the relay. */
  | { kind: "accepted" }
  /** Documented refusal: the item was not queued. */
  | { kind: "refused"; code: InboxRefusalCode }
  /** May have reached the endpoint with no acceptance: unknown, never retried. */
  | { kind: "unconfirmed" }
  /** Provably no request bytes were handed to the endpoint. */
  | { kind: "not_sent" };

/**
 * The documented acceptance signal: HTTP 200 whose JSON body says
 * `{"success":true}`. Only that exact boolean value counts; a missing, mistyped
 * or unparseable body never becomes an acceptance claim.
 */
export function isInboxAcceptanceBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { success?: unknown }).success === true
    );
  } catch {
    return false;
  }
}

/**
 * Classify one HTTP exchange. `bodyComplete` is false when the body was
 * truncated by the bounded read or the stream failed, in which case a 200 can
 * no longer be *proved* to carry `{"success":true}`.
 */
export function classifyInboxResponse(
  status: number,
  body: string,
  bodyComplete: boolean
): InboxOutcome {
  const refusal = INBOX_REFUSAL_STATUSES[status];
  if (refusal) return { kind: "refused", code: refusal };
  if (status === 200 && bodyComplete && isInboxAcceptanceBody(body))
    return { kind: "accepted" };
  // Everything else — a 200 without the documented body, a 3xx/4xx/5xx the
  // contract does not define, a truncated response — leaves the item's fate
  // unknown: the request may already have been encrypted and queued.
  return { kind: "unconfirmed" };
}

/** One bounded POST. Implementations must never throw and never retry. */
export interface InboxSender {
  send(request: { apiKey: string; body: string }): Promise<InboxOutcome>;
}

function collectOutcome(
  status: number | undefined,
  chunks: readonly Buffer[],
  bodyComplete: boolean
): InboxOutcome {
  if (status === undefined) return { kind: "unconfirmed" };
  return classifyInboxResponse(
    status,
    Buffer.concat([...chunks]).toString("utf8"),
    bodyComplete
  );
}

/**
 * The real sender: one `https.POST` to the literal endpoint with bounded
 * request/response sizes and one hard timeout. It resolves exactly once and
 * never retries, so a caller can never accidentally send twice.
 */
export const httpsInboxSender: InboxSender = {
  send({ apiKey, body }): Promise<InboxOutcome> {
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > INBOX_LIMITS.maxRequestBytes)
      // Unreachable through the tool handler (the body is bounded before the
      // sender is called); fail closed rather than open a socket.
      return Promise.resolve({ kind: "not_sent" });

    return new Promise<InboxOutcome>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: InboxOutcome): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(outcome);
      };

      // Once request.end receives the body, conservatively assume it might
      // reach the endpoint. Its callback only reports local flushing and is
      // not proof that the peer did not receive bytes when an earlier error
      // fires. This path therefore never tells a caller to resend on a network
      // failure with an ambiguous transmission outcome.
      let mayHaveTransmitted = false;
      let status: number | undefined;
      let receivedBytes = 0;
      const chunks: Buffer[] = [];

      const request = https.request(
        {
          host: INBOX_ENDPOINT_HOST,
          port: INBOX_ENDPOINT_PORT,
          path: INBOX_ENDPOINT_PATH,
          method: "POST",
          // A fresh connection per capture: no pooled socket is reused for a
          // different request, and no agent option (proxy/CA/keep-alive) can be
          // injected from outside this literal.
          agent: false,
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
          headers: {
            "content-type": "application/json",
            "content-length": String(bodyBytes),
            accept: "application/json",
            authorization: apiKey
          }
        },
        (response) => {
          status = response.statusCode ?? 0;
          response.on("data", (chunk: Buffer) => {
            if (receivedBytes + chunk.length > INBOX_LIMITS.maxResponseBytes) {
              // Bounded read: stop, and never treat a truncated body as proof.
              finish(collectOutcome(status, chunks, false));
              response.destroy();
              return;
            }
            receivedBytes += chunk.length;
            chunks.push(chunk);
          });
          response.on("end", () => finish(collectOutcome(status, chunks, true)));
          response.on("error", () =>
            finish(collectOutcome(status, chunks, false))
          );
          response.on("aborted", () =>
            finish(collectOutcome(status, chunks, false))
          );
        }
      );

      request.on("error", () => {
        finish(
          mayHaveTransmitted ? { kind: "unconfirmed" } : { kind: "not_sent" }
        );
      });
      timeout = setTimeout(() => {
        const outcome =
          status === undefined
            ? mayHaveTransmitted
              ? ({ kind: "unconfirmed" } as const)
              : ({ kind: "not_sent" } as const)
            : collectOutcome(status, chunks, false);
        finish(outcome);
        request.destroy();
      }, INBOX_LIMITS.requestTimeoutMs);
      mayHaveTransmitted = true;
      request.end(body);
    });
  }
};
