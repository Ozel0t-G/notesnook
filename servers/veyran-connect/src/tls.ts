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
 * TLS material handling for the loopback broker.
 *
 * The broker is an HTTPS service bound to the fixed numeric IPv4 `127.0.0.1`.
 * Its identity is a dedicated self-signed root CA (never installed into the
 * system trust store) that signs a short-lived server leaf carrying
 * `SAN IP:127.0.0.1` and `EKU serverAuth`. A caller trusts that one root and
 * *additionally* pins the exact DER SHA-256 of the leaf, so a foreign process
 * that owns the port but presents any other certificate terminates at the TLS
 * handshake: not one byte of `Authorization`, `Host` or body is ever sent.
 *
 * This module contains no listening/serving side effects; it only builds the
 * option objects and the pure fingerprint helpers used by both ends and by the
 * test harness.
 */
import { createHash, X509Certificate } from "node:crypto";
import type { SecureContextOptions } from "node:tls";
import type { ServerOptions } from "node:https";
import { LOOPBACK_HOST, SERVER_LIMITS, TLS_MIN_VERSION } from "./limits.js";

export interface TlsMaterial {
  /** PEM of the self-signed root CA (public). */
  rootPem: string;
  /** PEM chain of the server leaf (leaf first, then root). */
  leafPem: string;
  /** PEM of the server leaf private key (never exported). */
  leafKeyPem: string;
  /** Lower-case hex SHA-256 of the leaf DER. */
  leafPin: string;
}

/** SHA-256 of a certificate's DER bytes, lower-case hex (64 chars). */
export function certificatePin(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

/** Pin of a PEM certificate's DER. Throws on unparseable PEM. */
export function pemPin(pem: string): string {
  return certificatePin(new X509Certificate(pem).raw);
}

export function isValidPin(pin: string): boolean {
  return /^[0-9a-f]{64}$/.test(pin);
}

/**
 * The server's TLS options: leaf chain + leaf key, TLS 1.2 minimum, no client
 * certificates (the credential bearer header is the only auth), and a bounded
 * handshake. `requestCert` is false: the app is authenticated by its 256-bit
 * bearer credential, not by a client certificate.
 */
export function brokerSecureOptions(material: TlsMaterial): ServerOptions {
  const secure: SecureContextOptions = {
    key: material.leafKeyPem,
    cert: `${material.leafPem.trimEnd()}\n${material.rootPem.trimEnd()}\n`,
    minVersion: TLS_MIN_VERSION,
    maxVersion: "TLSv1.3"
  };
  return {
    ...secure,
    requestCert: false,
    handshakeTimeout: 10_000
  };
}

export interface ClientTlsOptions {
  port: number;
  rootPem: string;
  leafPin: string;
  timeoutMs?: number;
}

/**
 * `checkServerIdentity` for the callers: the hostname must be the literal
 * `127.0.0.1` and the presented leaf's DER SHA-256 must equal the pinned value.
 * Returning an `Error` aborts the handshake before any request byte is written.
 */
export function makePinChecker(
  leafPin: string
): (hostname: string, cert: { raw?: Buffer } | undefined) => Error | undefined {
  return (hostname, cert) => {
    if (hostname !== LOOPBACK_HOST)
      return new Error("broker host is not the loopback address");
    const raw = cert?.raw;
    if (!raw) return new Error("broker presented no certificate");
    if (certificatePin(raw) !== leafPin)
      return new Error("broker leaf certificate pin mismatch");
    return undefined;
  };
}

/** Marker for the `error` handling of a pinned TLS client. */
export const TLS_PIN_MISMATCH = "TLS_PIN_MISMATCH";

export function maxCertPemBytes(): number {
  return SERVER_LIMITS.maxCertPemBytes;
}
