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
 * Dedicated loopback certificate authority.
 *
 * `setup` generates a private, self-signed EC P-256 root CA and a short-lived
 * server leaf signed by it. The root is *never* installed into the system trust
 * store; it is exported only inside the `0600` broker/caller/connection files.
 * The root private key exists only transiently in a `0700` temp directory and
 * is destroyed as soon as the leaf is signed; the runtime persists only the
 * server leaf private key (`0600`).
 *
 * Generation uses the fixed absolute binary `/usr/bin/openssl` with a
 * static argument vector, `shell: false`, and all output discarded: no caller
 * path, executable, model tool or shell is ever involved, and no openssl
 * output (which could contain a filename) can reach a diagnostic.
 *
 * Both EC keys are generated with an **explicit named-curve** encoding
 * (`-pkeyopt ec_param_enc:named_curve`): macOS ships LibreSSL 3.3.6, whose
 * `genpkey -algorithm EC` default is the legacy *explicit* ECC-parameter form
 * (`SEQUENCE { OBJECT prime256v1, SEQUENCE {…} }`). Node's TLS stack refuses
 * such a peer certificate with `"Certificate public key has explicit ECC
 * parameters"`, so without this the pinned handshake could never complete.
 * `named_curve` emits the `OBJECT prime256v1` form Node accepts.
 *
 * Validation is done in Node (not by parsing openssl text): the root must be a
 * CA, the leaf must not be, the leaf must verify against the root public key,
 * the leaf private key must match the leaf certificate, the SAN must be exactly
 * `IP:127.0.0.1` (and nothing else), the EKU must include `serverAuth`, the
 * dates must be valid and the leaf's `notAfter` must be strictly earlier than
 * the root's (no grace), and the computed leaf pin must match.
 *
 * Node's `X509Certificate` exposes the *extended* key usage OID list as
 * `keyUsage` and has no `extKeyUsage` property (Node 24 / `@types/node` 24);
 * validation reads the real API rather than a non-existent one. The date
 * properties `validFromDate`/`validToDate` require Node **>= 22.10.0**.
 *
 * The leaf is generated exactly one day shorter than the root (the root is
 * signed first; both are `EC P-256`/SHA-256), so its `notAfter` is strictly
 * earlier and it can never outlive the root. `days` is bounded to an integer
 * `2..certValidityDays`, which makes the leaf at least 1 day and removes the
 * old `Math.max(1, …)`/60-second grace that could hide an outliving leaf.
 */
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { LOOPBACK_HOST, SERVER_LIMITS } from "./limits.js";
import { certificatePin, type TlsMaterial } from "./tls.js";

const OPENSSL = "/usr/bin/openssl";
const SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";

export type CertificateReason =
  | "openssl_missing"
  | "openssl_failed"
  | "invalid_validity"
  | "unreadable"
  | "root_not_ca"
  | "leaf_is_ca"
  | "chain_unverified"
  | "key_mismatch"
  | "bad_san"
  | "bad_eku"
  | "expired"
  | "leaf_outlives_root"
  | "pin_mismatch";

export class CertificateError extends Error {
  readonly reason: CertificateReason;
  constructor(reason: CertificateReason) {
    super(`certificate material invalid: ${reason}`);
    this.name = "CertificateError";
    this.reason = reason;
  }
}

function run(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(OPENSSL, [...args], {
        cwd,
        shell: false,
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
      reject(new CertificateError("openssl_missing"));
      return;
    }
    child.once("error", () => reject(new CertificateError("openssl_missing")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new CertificateError("openssl_failed"));
    });
  });
}

export interface GenerateOptions {
  /** Root validity in days; an integer in `minCertValidityDays..certValidityDays`. */
  days?: number;
  now?: () => number;
}

/**
 * Generate a fresh root + server leaf. The returned material is validated
 * before being handed back; any generation or validation failure throws a
 * `CertificateError` so the caller fails closed rather than persisting a
 * partially created profile.
 */
export async function generateTlsMaterial(
  options: GenerateOptions = {}
): Promise<TlsMaterial> {
  const days = options.days ?? SERVER_LIMITS.certValidityDays;
  // Bound the validity: a finite, whole number of days in the documented
  // `2..certValidityDays` range. `days >= minCertValidityDays` (2) is what
  // guarantees a strictly-earlier leaf: the leaf gets `days - 1 >= 1` days, so
  // its `notAfter` is always at least one day earlier than the root's and no
  // hidden grace is needed. Reject before running openssl so a bad request can
  // never mint a long-lived, zero-day or leaf-outliving certificate.
  if (
    !Number.isInteger(days) ||
    days < SERVER_LIMITS.minCertValidityDays ||
    days > SERVER_LIMITS.certValidityDays
  )
    throw new CertificateError("invalid_validity");
  // The leaf is signed after the root, so give it exactly one day less: with an
  // identical `-days` the later-signed leaf would end *after* the root. The
  // bound above keeps `leafDays >= 1`.
  const leafDays = days - 1;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-connect-ca-"));
  await fs.chmod(dir, 0o700);
  try {
    const rootKey = path.join(dir, "root.key");
    const rootCrt = path.join(dir, "root.crt");
    const leafKey = path.join(dir, "leaf.key");
    const leafCsr = path.join(dir, "leaf.csr");
    const leafCrt = path.join(dir, "leaf.crt");
    const rootCnf = path.join(dir, "root.cnf");
    const leafCnf = path.join(dir, "leaf.cnf");

    await fs.writeFile(
      rootCnf,
      [
        "[req]",
        "distinguished_name = dn",
        "x509_extensions = v3_ca",
        "prompt = no",
        "[dn]",
        "CN = VeyraN Connect Root",
        "[v3_ca]",
        "basicConstraints = critical,CA:TRUE,pathlen:0",
        "keyUsage = critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier = hash"
      ].join("\n"),
      { mode: 0o600 }
    );
    await fs.writeFile(
      leafCnf,
      [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "[dn]",
        "CN = 127.0.0.1",
        "[v3_leaf]",
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature",
        "extendedKeyUsage = serverAuth",
        "subjectAltName = IP:127.0.0.1"
      ].join("\n"),
      { mode: 0o600 }
    );

    await run(
      [
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        // Force the *named-curve* (OBJECT prime256v1) encoding. LibreSSL 3.3.6
        // otherwise emits explicit ECC parameters, which Node's TLS refuses.
        "-pkeyopt",
        "ec_param_enc:named_curve",
        "-out",
        "root.key"
      ],
      dir
    );
    await run(
      [
        "req",
        "-x509",
        "-new",
        "-key",
        "root.key",
        "-sha256",
        "-days",
        String(days),
        "-config",
        "root.cnf",
        "-out",
        "root.crt"
      ],
      dir
    );
    await run(
      [
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-pkeyopt",
        "ec_param_enc:named_curve",
        "-out",
        "leaf.key"
      ],
      dir
    );
    await run(
      ["req", "-new", "-key", "leaf.key", "-sha256", "-config", "leaf.cnf", "-out", "leaf.csr"],
      dir
    );
    await run(
      [
        "x509",
        "-req",
        "-in",
        "leaf.csr",
        "-CA",
        "root.crt",
        "-CAkey",
        "root.key",
        "-CAcreateserial",
        "-sha256",
        "-days",
        String(leafDays),
        "-extfile",
        "leaf.cnf",
        "-extensions",
        "v3_leaf",
        "-out",
        "leaf.crt"
      ],
      dir
    );

    const [rootPem, leafPem, leafKeyPem] = await Promise.all([
      fs.readFile(rootCrt, "utf8"),
      fs.readFile(leafCrt, "utf8"),
      fs.readFile(leafKey, "utf8")
    ]);

    const material: TlsMaterial = {
      rootPem,
      leafPem,
      leafKeyPem,
      leafPin: certificatePin(new X509Certificate(leafPem).raw)
    };
    validateTlsMaterial(material, options.now);
    return material;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parsePem(pem: string): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    throw new CertificateError("unreadable");
  }
}

/**
 * Validate a certificate pair/key/pin. Throws `CertificateError` naming the
 * first failed property; never returns partial success.
 */
export function validateTlsMaterial(
  material: TlsMaterial,
  now: () => number = Date.now
): void {
  const root = parsePem(material.rootPem);
  const leaf = parsePem(material.leafPem);
  if (root.ca !== true) throw new CertificateError("root_not_ca");
  if (leaf.ca === true) throw new CertificateError("leaf_is_ca");
  if (!leaf.verify(root.publicKey)) throw new CertificateError("chain_unverified");
  const derived = createPublicKey(material.leafKeyPem);
  const certKey = leaf.publicKey;
  const derivedDer = derived.export({ type: "spki", format: "der" }) as Buffer;
  const certDer = certKey.export({ type: "spki", format: "der" }) as Buffer;
  if (!derivedDer.equals(certDer)) throw new CertificateError("key_mismatch");
  // The SAN must be *exactly* one loopback IP entry — no extra DNS/IP/email
  // names. Node renders a lone IPv4 SAN as `IP Address:127.0.0.1`; split on the
  // documented separator and require exactly that, trimmed.
  const sanEntries = (leaf.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (
    sanEntries.length !== 1 ||
    sanEntries[0] !== `IP Address:${LOOPBACK_HOST}`
  )
    throw new CertificateError("bad_san");
  // Node's `X509Certificate.keyUsage` carries the *extended* key usage OID
  // list (there is no `extKeyUsage` property). `serverAuth` must be present.
  const eku: readonly string[] = Array.isArray(leaf.keyUsage)
    ? leaf.keyUsage
    : [];
  if (!eku.includes(SERVER_AUTH_OID)) throw new CertificateError("bad_eku");
  const nowMs = now();
  if (nowMs < root.validFromDate.getTime() || nowMs > root.validToDate.getTime())
    throw new CertificateError("expired");
  if (nowMs < leaf.validFromDate.getTime() || nowMs > leaf.validToDate.getTime())
    throw new CertificateError("expired");
  // The leaf is minted exactly one day shorter than the root, so its `notAfter`
  // must be *strictly* earlier. No grace window is allowed: a certificate whose
  // leaf outlives its root is refused outright, so a bad pair can never pass on
  // a clamp.
  if (leaf.validToDate.getTime() > root.validToDate.getTime())
    throw new CertificateError("leaf_outlives_root");
  if (certificatePin(leaf.raw) !== material.leafPin)
    throw new CertificateError("pin_mismatch");
}

/** Lower-case hex SHA-256 of an arbitrary buffer (test/diagnostic helper). */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
