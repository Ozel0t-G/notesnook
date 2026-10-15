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
 * Static, bounded error surface for the broker transport and the MCP tool
 * callbacks.
 *
 * Every message is a fixed catalog string. No caught error, provider text, SQL
 * message, payload, id, title or token may ever be interpolated into an
 * envelope: the model-visible error surface must be provably foreign-string
 * free. The envelope schema re-validates `message === CATALOG[code]`, and is
 * applied *separately* for `isError: true` results (the SDK skips
 * `outputSchema` validation in that case).
 */
import { z } from "zod";
import {
  CONNECT_ERROR_MESSAGES,
  TRANSPORT_ERROR_MESSAGES
} from "./contract.js";

export const BROKER_ERROR_MESSAGES = {
  BAD_REQUEST: "The broker request is malformed.",
  UNAUTHORIZED: "The broker credential is missing or invalid.",
  FORBIDDEN_ORIGIN: "Requests carrying an Origin header are refused.",
  FORBIDDEN_HOST: "The request Host header is not the broker's exact host.",
  FORBIDDEN_HEADER: "The request carries a refused hop-by-hop header.",
  UNSUPPORTED_ENCODING: "Compressed request bodies are not accepted.",
  PAYLOAD_TOO_LARGE: "The request body exceeds the bounded size limit.",
  INVALID_UTF8: "The request body is not valid UTF-8.",
  NOT_FOUND: "The requested broker route does not exist.",
  SESSION_REQUIRED: "No app session is established.",
  SESSION_CHANGED: "The app session changed or was replaced.",
  REPLAY: "A replayed nonce, response or session was refused.",
  QUEUE_FULL: "The broker queue is full.",
  QUEUE_EMPTY: "No queued request is available to claim.",
  ALREADY_CLAIMED: "This client already holds an unanswered claim.",
  UNCERTAIN: "The request was already claimed; its outcome is uncertain.",
  APP_UNAVAILABLE: "The VeyraN app is not reachable.",
  BROKER_UNAVAILABLE: "The VeyraN Connect broker is not reachable.",
  TRANSPORT_UNAVAILABLE: "The Connect transport channel is unavailable.",
  CONFIG_INVALID: "The persisted Connect configuration is invalid.",
  CONFIG_INSECURE: "A persisted Connect file failed its permission checks.",
  INTERNAL: "The broker could not complete the request."
} as const;

export type BrokerErrorCode = keyof typeof BROKER_ERROR_MESSAGES;

export const BROKER_ERROR_CODES = Object.freeze(
  Object.keys(BROKER_ERROR_MESSAGES) as BrokerErrorCode[]
);

const brokerErrorCodeSchema = z.enum(
  [...BROKER_ERROR_CODES] as [BrokerErrorCode, ...BrokerErrorCode[]]
);

export const brokerErrorEnvelopeSchema = z
  .strictObject({
    code: brokerErrorCodeSchema,
    message: z.string()
  })
  .refine(
    (value) => value.message === BROKER_ERROR_MESSAGES[value.code],
    {
      message: "broker error message must be the static catalog message",
      path: ["message"]
    }
  );

export type BrokerErrorEnvelope = {
  code: BrokerErrorCode;
  message: string;
};

export function brokerErrorEnvelope(
  code: BrokerErrorCode
): BrokerErrorEnvelope {
  return { code, message: BROKER_ERROR_MESSAGES[code] };
}

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  constructor(code: BrokerErrorCode) {
    super(BROKER_ERROR_MESSAGES[code]);
    this.name = "BrokerError";
    this.code = code;
  }
}

export function isBrokerError(value: unknown): value is BrokerError {
  return value instanceof BrokerError;
}

// ------------------------------------------------------- MCP tool error surface

/**
 * The local catalog for the one non-Core tool, `capture_note`, which talks to
 * the official Notesnook Inbox endpoint instead of the loopback broker. Every
 * state is described in *local* terms: what this process knows about its own
 * request, never an invented remote status. The remote contract has no status
 * query, so "may have been accepted" is reported as unknown, never as saved,
 * synced, imported or "queued with id X".
 */
export const INBOX_ERROR_MESSAGES: Record<string, string> = Object.freeze({
  /** No Inbox API key is configured in this operator profile. */
  INBOX_NOT_CONFIGURED:
    'No Notesnook Inbox API key is configured for this operator profile. Run "veyran-connect inbox-key" once on a foreground terminal.',
  /** Another process holds the profile-wide receipt transaction lock. */
  INBOX_BUSY:
    'Another capture is using this operator profile, or a previous process stopped during a capture. Do not retry until the local capture lock is resolved.',
  /**
   * No 200 acceptance was received for a request that may already have reached
   * the endpoint: the outcome is unknown and the capture must not be resent.
   */
  INBOX_UNCERTAIN:
    "The inbox request may have reached the server, but no acceptance was received; the outcome is unknown. Do not resend this capture.",
  /** Provably nothing was transmitted: the endpoint could not be reached. */
  INBOX_UNAVAILABLE:
    "The inbox endpoint could not be reached; the capture was not sent.",
  /** The server answered 400: the body failed its validation; nothing queued. */
  INBOX_REJECTED:
    "The inbox server refused the request body as invalid; nothing was queued.",
  /** 401/403: the key was refused or Inbox is not enabled for the account. */
  INBOX_UNAUTHORIZED:
    "The inbox server rejected the API key, or Inbox is not enabled for this account.",
  /** 429: the documented rate limit was exceeded; nothing queued. */
  INBOX_RATE_LIMITED:
    "The inbox server rate limit was exceeded; nothing was queued.",
  /** The local receipt could not be written, so nothing was sent. */
  LOCAL_STORE_UNAVAILABLE:
    "The local operator profile could not be updated; the capture was not sent."
});

/**
 * The union surfaced to the model: the accepted Core Connect catalog, the Core
 * transport catalog, the local broker catalog and the local Inbox catalog. All
 * are static.
 */
export const TOOL_ERROR_MESSAGES: Record<string, string> = Object.freeze({
  ...CONNECT_ERROR_MESSAGES,
  ...TRANSPORT_ERROR_MESSAGES,
  ...BROKER_ERROR_MESSAGES,
  ...INBOX_ERROR_MESSAGES,
  /** The MCP tool arguments failed their strict schema. */
  INVALID_ARGUMENTS: "The tool arguments are malformed or incomplete.",
  /** The tool call was cancelled before the broker accepted it. */
  CANCELLED: "The operation was cancelled before it was claimable.",
  /** The broker response did not correlate with the requested operation. */
  UNCORRELATED_RESULT:
    "The broker returned a result for a different operation."
});

export type ToolErrorCode = keyof typeof TOOL_ERROR_MESSAGES;

/** The bounded, validated error object returned as `structuredContent`. */
export const toolErrorEnvelopeSchema = z
  .strictObject({
    status: z.literal("error"),
    code: z.string(),
    message: z.string()
  })
  .refine(
    (value) =>
      Object.prototype.hasOwnProperty.call(TOOL_ERROR_MESSAGES, value.code) &&
      value.message === TOOL_ERROR_MESSAGES[value.code],
    { message: "tool error must be the static catalog message for its code" }
  );

export type ToolErrorEnvelope = {
  status: "error";
  code: string;
  message: string;
};

export function toolErrorEnvelope(code: ToolErrorCode): ToolErrorEnvelope {
  return { status: "error", code, message: TOOL_ERROR_MESSAGES[code] };
}

/** Validate an envelope independently of the SDK (used for `isError: true`). */
export function isToolErrorEnvelope(value: unknown): value is ToolErrorEnvelope {
  return toolErrorEnvelopeSchema.safeParse(value).success;
}
