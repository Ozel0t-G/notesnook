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
 * The broker's own small fixed v1 wire protocol (loopback HTTPS, POST only).
 *
 * Roles are explicit and never interchangeable:
 *   app  → `session` (handshake) then `claim`/`reply`
 *   mcp  → `hello`    (handshake) then `submit`/`await`/`cancel`
 *   both → `health`
 *
 * A handshake returns a fresh random instance id (`sessionId`/`instanceId`).
 * Every subsequent request from that role carries the instance id and a
 * strictly increasing per-instance `nonce` (starting at 1). A restarted app or
 * MCP caller simply handshakes again: the new instance starts its own nonce
 * sequence, so a relaunch can never be poisoned by an old global counter. A
 * replayed handshake `clientNonce` is refused by a bounded replay window.
 *
 * `v` is part of every request. The exact shapes are frozen here so the future
 * native worker can implement the same contract.
 */
import { z } from "zod";
import { brokerErrorEnvelopeSchema, type BrokerErrorEnvelope } from "./errors.js";
import { BROKER_PROTOCOL_VERSION } from "./limits.js";

export const BROKER_ROUTES = [
  "health",
  "session",
  "hello",
  "submit",
  "claim",
  "reply",
  "await",
  "cancel"
] as const;
export type BrokerRoute = (typeof BROKER_ROUTES)[number];

export function routePath(route: BrokerRoute): string {
  return `/v1/${route}`;
}

/** The app-chosen caller label; bounded, never an authorization input. */
const clientIdSchema = z
  .string()
  .min(6)
  .max(200)
  .regex(/^[A-Za-z0-9_:.-]+$/);
const accountIdSchema = z
  .string()
  .min(6)
  .max(200)
  .regex(/^[A-Za-z0-9_:.-]+$/);
const instanceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/);
const clientNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/);
const ticketIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
const nonceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const grantsGenerationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const v = z.literal(BROKER_PROTOCOL_VERSION);

export const healthRequestSchema = z.strictObject({ v });

export const sessionRequestSchema = z.strictObject({
  v,
  clientNonce: clientNonceSchema,
  accountId: accountIdSchema,
  grantsGeneration: grantsGenerationSchema
});

export const helloRequestSchema = z.strictObject({
  v,
  clientNonce: clientNonceSchema
});

export const submitRequestSchema = z.strictObject({
  v,
  instanceId: instanceIdSchema,
  nonce: nonceSchema,
  request: z.unknown()
});

export const claimRequestSchema = z.strictObject({
  v,
  sessionId: instanceIdSchema,
  nonce: nonceSchema,
  clientId: clientIdSchema
});

export const replyRequestSchema = z.strictObject({
  v,
  sessionId: instanceIdSchema,
  nonce: nonceSchema,
  clientId: clientIdSchema,
  ticketId: ticketIdSchema,
  response: z.unknown()
});

export const awaitRequestSchema = z.strictObject({
  v,
  instanceId: instanceIdSchema,
  nonce: nonceSchema,
  ticketId: ticketIdSchema
});

export const cancelRequestSchema = z.strictObject({
  v,
  instanceId: instanceIdSchema,
  nonce: nonceSchema,
  ticketId: ticketIdSchema
});

export const brokerRequestSchemas = {
  health: healthRequestSchema,
  session: sessionRequestSchema,
  hello: helloRequestSchema,
  submit: submitRequestSchema,
  claim: claimRequestSchema,
  reply: replyRequestSchema,
  await: awaitRequestSchema,
  cancel: cancelRequestSchema
} as const;

export const healthResultSchema = z.strictObject({
  service: z.literal("veyran-connect"),
  protocolVersion: z.literal(BROKER_PROTOCOL_VERSION),
  brokerId: z.string().regex(/^[0-9a-f]{32}$/),
  /** Random per broker process; lets a caller notice a broker restart. */
  bootId: z.string().regex(/^[0-9a-f]{32}$/),
  port: z.number().int().min(1024).max(65535)
});

export const sessionResultSchema = z.strictObject({
  sessionId: instanceIdSchema,
  grantsGeneration: grantsGenerationSchema
});

export const helloResultSchema = z.strictObject({
  instanceId: instanceIdSchema
});

export const submitResultSchema = z.strictObject({ ticketId: ticketIdSchema });

export const claimResultSchema = z.strictObject({
  item: z
    .strictObject({
      ticketId: ticketIdSchema,
      request: z.unknown()
    })
    .nullable()
});

export const replyResultSchema = z.strictObject({ accepted: z.literal(true) });

export const awaitResultSchema = z.strictObject({ response: z.unknown() });

export const cancelResultSchema = z.strictObject({
  removed: z.boolean(),
  uncertain: z.boolean(),
  completed: z.boolean()
});

const brokerSuccessSchema = z.strictObject({
  ok: z.literal(true),
  result: z.unknown()
});
const brokerFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: brokerErrorEnvelopeSchema
});

export const brokerResponseSchema = z.union([
  brokerSuccessSchema,
  brokerFailureSchema
]);

export type BrokerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: BrokerErrorEnvelope };

export function brokerOk(result: unknown): BrokerResponse {
  return { ok: true, result };
}

export function brokerFail(error: BrokerErrorEnvelope): BrokerResponse {
  return { ok: false, error };
}
