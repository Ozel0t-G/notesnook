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
 * Certificate generation/validation and the pinned-TLS boundary.
 *
 * The last test is the important one: a caller that validates the chain but has
 * the wrong pin (or a foreign server with the wrong certificate) must send
 * **zero** `Authorization`/context HTTP bytes. Bytes received before that point
 * are the raw TLS ClientHello, which contains no credential material.
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import tls from "node:tls";
import type { Server as TlsServer, TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { X509Certificate, createPublicKey } from "node:crypto";
import { generateTlsMaterial, validateTlsMaterial } from "../src/certs.js";
import { certificatePin, makePinChecker } from "../src/tls.js";
import { TLS_MIN_VERSION } from "../src/limits.js";
import { BrokerClient } from "../src/client.js";
import { createCredential } from "../src/credentials.js";
import { makeProfile, startBroker, freePort, type StartedBroker } from "./harness.js";

const running: StartedBroker[] = [];
const sockets: net.Server[] = [];
const tlsServers: TlsServer[] = [];

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.stop();
  for (const server of tlsServers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const server of sockets.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("certificate authority material", () => {
  it("generates a validating root + loopback leaf with an exact pin", async () => {
    const material = await generateTlsMaterial();
    validateTlsMaterial(material);
    const root = new X509Certificate(material.rootPem);
    const leaf = new X509Certificate(material.leafPem);
    expect(root.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(root.publicKey)).toBe(true);
    // The SAN is *exactly* the single loopback IP entry (no extra names).
    expect(leaf.subjectAltName).toBe("IP Address:127.0.0.1");
    // Node exposes the *extended* key usage OID list as `keyUsage`; there is no
    // `extKeyUsage` property on Node 24's `X509Certificate`.
    expect(leaf.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
    // The leaf is minted exactly one day shorter than the root, so its
    // `notAfter` is *strictly* earlier — never merely within a grace window.
    expect(leaf.validToDate.getTime()).toBeLessThan(root.validToDate.getTime());
    expect(material.leafPin).toBe(certificatePin(leaf.raw));
    expect(material.leafPin).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates named-curve EC keys and completes a real Node TLS handshake", async () => {
    const material = await generateTlsMaterial();
    // LibreSSL's `genpkey -algorithm EC` default is the legacy *explicit*
    // ECC-parameter encoding, which Node's TLS rejects with "Certificate public
    // key has explicit ECC parameters". `asymmetricKeyDetails.namedCurve` is
    // exposed **only** for a named-curve key, so this proves the fix rather than
    // a weakened handshake.
    expect(
      createPublicKey(material.rootPem).asymmetricKeyDetails?.namedCurve
    ).toBe("prime256v1");
    expect(
      createPublicKey(material.leafKeyPem).asymmetricKeyDetails?.namedCurve
    ).toBe("prime256v1");

    // The definitive proof: a real Node TLS server/client handshake using the
    // generated material, the pinned root and the exact leaf pin. The server
    // presents the generated leaf chain and private key (the same fields
    // `brokerSecureOptions` uses), so an explicit-parameter key would fail this
    // handshake exactly as it failed the production broker.
    const server = tls.createServer({
      key: material.leafKeyPem,
      cert: `${material.leafPem.trimEnd()}\n${material.rootPem.trimEnd()}\n`,
      minVersion: TLS_MIN_VERSION
    });
    tlsServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const connecting = tls.connect(
        {
          host: "127.0.0.1",
          port: address.port,
          ca: material.rootPem,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          checkServerIdentity: makePinChecker(material.leafPin)
        },
        () => resolve(connecting)
      );
      connecting.once("error", reject);
    });
    expect(socket.authorized).toBe(true);
    expect(certificatePin(socket.getPeerCertificate().raw)).toBe(
      material.leafPin
    );
    socket.destroy();
  });

  it("bounds the requested validity to the documented integer 2..365 days", async () => {
    // Out-of-range, non-integer, non-finite and non-number values all fail
    // closed before openssl runs.
    for (const days of [0, 1, 1.5, -1, NaN, Infinity, -Infinity, 365.5, 366]) {
      await expect(generateTlsMaterial({ days })).rejects.toThrow(
        /invalid_validity/
      );
    }
    // The two accepted boundaries: the minimum (root 2 days, leaf 1 day) and
    // the maximum (root 365 days, leaf 364).
    const twoDays = await generateTlsMaterial({ days: 2 });
    expect(() => validateTlsMaterial(twoDays)).not.toThrow();
    const maxDays = await generateTlsMaterial({ days: 365 });
    expect(() => validateTlsMaterial(maxDays)).not.toThrow();
    for (const material of [twoDays, maxDays]) {
      const root = new X509Certificate(material.rootPem);
      const leaf = new X509Certificate(material.leafPem);
      expect(leaf.validToDate.getTime()).toBeLessThan(root.validToDate.getTime());
    }
  });

  it("refuses a tampered pin and a swapped leaf", async () => {
    const [first, second] = await Promise.all([
      generateTlsMaterial(),
      generateTlsMaterial()
    ]);
    expect(() =>
      validateTlsMaterial({ ...first, leafPin: "0".repeat(64) })
    ).toThrow(/pin_mismatch/);
    expect(() =>
      validateTlsMaterial({ ...first, leafPin: second.leafPin })
    ).toThrow(/pin_mismatch/);
  });
});

describe("pinned TLS boundary", () => {
  it("connects to the real broker with the correct pin", async () => {
    const profile = await makeProfile();
    const started = await startBroker(profile);
    running.push(started);
    const client = new BrokerClient({
      port: started.port,
      credential: profile.credentials.mcp,
      rootPem: profile.tls.rootPem,
      leafPin: profile.tls.leafPin
    });
    const health = await client.health();
    expect(health?.service).toBe("veyran-connect");
    expect(health?.port).toBe(started.port);
  });

  it("refuses a valid chain with the wrong pin", async () => {
    const profile = await makeProfile();
    const started = await startBroker(profile);
    running.push(started);
    const client = new BrokerClient({
      port: started.port,
      credential: profile.credentials.mcp,
      rootPem: profile.tls.rootPem,
      leafPin: "1".repeat(64)
    });
    await expect(client.health()).rejects.toBeTruthy();
  });

  it("sends zero Authorization/HTTP bytes to a foreign listener", async () => {
    const profile = await makeProfile();
    const received: Buffer[] = [];
    const port = await freePort();
    const foreign = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) =>
      foreign.listen(port, "127.0.0.1", resolve)
    );
    sockets.push(foreign);

    const credential = createCredential();
    const client = new BrokerClient({
      port,
      credential,
      rootPem: profile.tls.rootPem,
      leafPin: profile.tls.leafPin,
      timeoutMs: 800
    });
    await expect(client.health()).rejects.toBeTruthy();

    const seen = Buffer.concat(received).toString("latin1");
    expect(seen.toLowerCase()).not.toContain("authorization");
    expect(seen).not.toContain(credential.secret);
    expect(seen).not.toContain(credential.id);
    expect(seen).not.toContain("/v1/");
  });
});
