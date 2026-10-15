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
 * Persisted operator-profile documents.
 *
 * All three are strict: an unknown version, missing field, unknown field,
 * out-of-range port or malformed TLS pin fails closed. Extending the version
 * is not silently tolerated: `setup` preserves an existing *fully consistent*
 * profile and refuses (never overwrites) a partial/corrupt/insecure one.
 *
 * Every document that lets a caller trust the broker carries the same two TLS
 * fields — the public root CA PEM and the exact leaf pin — so the caller's
 * trust is bound to the persisted identity, not to whatever answers on the
 * port.
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { SERVER_LIMITS } from "./limits.js";
import { credentialSchema, type Credential } from "./credentials.js";
import {
  InsecureFileError,
  readSecureJson,
  writeSecureJsonAtomic
} from "./secure-files.js";
import { BrokerError } from "./errors.js";

const portSchema = z.number().int().min(1024).max(65535);
const brokerIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
const pinSchema = z.string().regex(/^[0-9a-f]{64}$/);
const pemSchema = z.string().min(1).max(SERVER_LIMITS.maxCertPemBytes);

export const publicTlsSchema = z.strictObject({
  rootPem: pemSchema,
  leafPin: pinSchema
});

export const brokerConfigSchema = z.strictObject({
  v: z.literal(1),
  brokerId: brokerIdSchema,
  port: portSchema,
  createdAt: z.number().int().min(0),
  /** Consistency copy of the leaf pin; must equal the credentials' pin. */
  leafPin: pinSchema
});

export type BrokerConfig = z.infer<typeof brokerConfigSchema>;

export const mcpConfigSchema = z.strictObject({
  v: z.literal(1),
  brokerId: brokerIdSchema,
  port: portSchema,
  client: credentialSchema,
  tls: publicTlsSchema
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;

export const connectionExportSchema = z.strictObject({
  v: z.literal(1),
  service: z.literal("veyran-connect"),
  brokerId: brokerIdSchema,
  port: portSchema,
  app: credentialSchema,
  tls: publicTlsSchema
});

export type ConnectionExport = z.infer<typeof connectionExportSchema>;

export function createBrokerId(): string {
  return randomBytes(16).toString("hex");
}

function configBudget(): number {
  return SERVER_LIMITS.maxConfigFileBytes;
}

function toBrokerError(error: unknown): BrokerError {
  if (error instanceof InsecureFileError)
    return new BrokerError(
      error.reason === "missing" || error.reason === "unreadable"
        ? "CONFIG_INVALID"
        : "CONFIG_INSECURE"
    );
  return new BrokerError("CONFIG_INVALID");
}

async function loadStrict<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  try {
    const raw = await readSecureJson<unknown>(file, configBudget());
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new BrokerError("CONFIG_INVALID");
    return parsed.data;
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw toBrokerError(error);
  }
}

/** True when the file is simply absent (a fresh profile), never on corruption. */
export async function isMissingFile(file: string): Promise<boolean> {
  try {
    await readSecureJson<unknown>(file, configBudget());
    return false;
  } catch (error) {
    return error instanceof InsecureFileError && error.reason === "missing";
  }
}

export function loadBrokerConfig(file: string): Promise<BrokerConfig> {
  return loadStrict(file, brokerConfigSchema);
}

export function loadMcpConfig(file: string): Promise<McpConfig> {
  return loadStrict(file, mcpConfigSchema);
}

export function loadConnectionExport(file: string): Promise<ConnectionExport> {
  return loadStrict(file, connectionExportSchema);
}

export function saveBrokerConfig(file: string, value: BrokerConfig): Promise<void> {
  return writeSecureJsonAtomic(file, value, configBudget());
}

export function saveMcpConfig(file: string, value: McpConfig): Promise<void> {
  return writeSecureJsonAtomic(file, value, configBudget());
}

export function saveConnectionExport(
  file: string,
  value: ConnectionExport
): Promise<void> {
  return writeSecureJsonAtomic(file, value, configBudget());
}

export function appCredential(credentials: { app: Credential }): Credential {
  return credentials.app;
}
