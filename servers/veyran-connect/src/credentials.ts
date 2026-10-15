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
 * 256-bit broker credentials.
 *
 * Two *separate* random credentials exist — one for the app and one for the MCP
 * client — so a leak of either never authorizes the other. Both are exactly
 * 256 bits: a 16-byte (32 hex char) id and a 32-byte (43 char, unpadded
 * base64url) secret. The schema is exact rather than ranged, so a short or
 * over-long secret cannot be persisted as if it were 256-bit. The broker holds
 * both in its `0600` credential file; the MCP caller config holds only the MCP
 * credential; the app connection export holds only the app credential.
 * Comparison is constant-time over equal-length buffers and never logs, echoes
 * or includes the secret in any error.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SERVER_LIMITS } from "./limits.js";

export const CREDENTIAL_BYTES = 32; // 256 bits
export const CREDENTIAL_ID_BYTES = 16; // 128-bit id (32 hex chars)
export const SECRET_BASE64URL_CHARS = 43; // 32 bytes -> 43 unpadded base64url
export const HAND_NONCE_BYTES = 16; // 128-bit handshake nonce / instance id

export interface Credential {
  id: string;
  secret: string;
}

/** Exactly 16 random bytes, lower-case hex (32 chars). */
export const credentialIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "credential id must be 32 hex chars");

/**
 * Exactly 32 random bytes encoded as 43 unpadded base64url chars. The
 * regex pins the shape; the refine decodes to prove exactly 256 bits of
 * entropy rather than a shorter string padded to look long.
 */
export const credentialSecretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "secret must be 43 base64url chars")
  .refine(
    (value) => Buffer.from(value, "base64url").length === CREDENTIAL_BYTES,
    { message: "secret must decode to exactly 32 bytes (256 bits)" }
  );

export const credentialSchema = z.strictObject({
  id: credentialIdSchema,
  secret: credentialSecretSchema
});

export const brokerCredentialsSchema = z.strictObject({
  v: z.literal(1),
  app: credentialSchema,
  mcp: credentialSchema,
  tls: z.strictObject({
    rootPem: z.string().min(1).max(SERVER_LIMITS.maxCertPemBytes),
    leafPem: z.string().min(1).max(SERVER_LIMITS.maxCertPemBytes),
    leafKeyPem: z.string().min(1).max(SERVER_LIMITS.maxCertPemBytes),
    leafPin: z.string().regex(/^[0-9a-f]{64}$/)
  })
});

export type BrokerCredentials = z.infer<typeof brokerCredentialsSchema>;

/** A fresh 256-bit credential: random 16-byte hex id + random 32-byte secret. */
export function createCredential(): Credential {
  return {
    id: randomBytes(CREDENTIAL_ID_BYTES).toString("hex"),
    secret: randomBytes(CREDENTIAL_BYTES).toString("base64url")
  };
}

/** A fresh 128-bit handshake nonce / instance id (22-char base64url). */
export function createHandshakeNonce(): string {
  return randomBytes(HAND_NONCE_BYTES).toString("base64url");
}

/** Constant-time comparison; length differences short-circuit to `false`. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Parse an `Authorization: Bearer <id>.<secret>` token into its two halves
 * without throwing. Returns `undefined` for any malformed shape. The shape is
 * exact: a 32-hex id and a 43-char base64url secret.
 */
export function parseBearerToken(
  header: string | undefined
): Credential | undefined {
  if (typeof header !== "string") return undefined;
  if (header.length > 128) return undefined;
  const match = /^Bearer ([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) return undefined;
  return { id: match[1], secret: match[2] };
}

export function formatBearerToken(credential: Credential): string {
  return `Bearer ${credential.id}.${credential.secret}`;
}

/**
 * Authenticate a bearer token against an expected credential. Both the id and
 * the secret are compared constant-time; a mismatched id is compared against
 * the expected id anyway so timing does not reveal whether an id exists.
 */
export function authenticate(
  header: string | undefined,
  expected: Credential
): boolean {
  const parsed = parseBearerToken(header);
  if (!parsed) return false;
  const idOk = constantTimeEqual(parsed.id, expected.id);
  const secretOk = constantTimeEqual(parsed.secret, expected.secret);
  return idOk && secretOk;
}

export function credentialsFileBudget(): number {
  return SERVER_LIMITS.maxCredentialFileBytes;
}
