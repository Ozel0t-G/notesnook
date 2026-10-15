#!/usr/bin/env node
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

//
// Throwaway loopback HTTPS fixture for the VeyraN Connect *runtime* transport
// harness (`RuntimeMain.swift`). This file is NOT part of the app build and is
// never imported by production code.
//
// Usage:
//   node fixture.mjs --dir DIR [--mode valid|oversized|compressed|redirect|refuse]
//
// It generates, into DIR (only if not already present):
//   * `root-key.pem` / `leaf-key.pem` — ephemeral EC private keys (mode 0600),
//   * `root.pem` / `leaf.pem`         — the self-signed root and its leaf with
//                                        `subjectAltName = IP:127.0.0.1`,
//   * `connection.export.json`        — the frozen v1 pairing document (mode 0600)
//                                        the production reader accepts,
//   and writes every received request as one line to `requests.log` so a
//   zero-HTTP handshake rejection can be proven.
//
// It then prints `READY <port>` and serves `POST /v1/{health,session,claim,reply}`.
// `--mode` selects an adversarial response shape:
//   valid      — a well-formed broker exchange (one claim, then empty)
//   oversized  — a chunked body larger than the 5 MiB client bound
//   compressed — a `Content-Encoding: gzip` body
//   redirect   — a 302 with a `Location`
//   refuse     — accepts nothing; used for wrong-CA / wrong-pin runs (the client
//                must never complete a handshake, so `requests.log` stays empty)
//
// The private keys are generated at run time and never committed.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:https";
import zlib from "node:zlib";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dir = arg("dir", process.env.VEYRAN_RUNTIME_DIR);
const mode = arg("mode", "valid");
if (!dir) {
  process.stderr.write("--dir is required\n");
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const requestsLog = path.join(dir, "requests.log");
fs.writeFileSync(requestsLog, "", { mode: 0o600 });

const p = (...parts) => path.join(dir, ...parts);
const openssl = (args) =>
  execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });

function rootPemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

function ensureCerts() {
  const rootKey = p("root-key.pem");
  const leafKey = p("leaf-key.pem");
  const rootPemPath = p("root.pem");
  const leafPemPath = p("leaf.pem");
  const leafCsr = p("leaf.csr");
  const ext = p("san.cnf");
  if (fs.existsSync(rootPemPath) && fs.existsSync(leafPemPath)) return;

  fs.writeFileSync(
    ext,
    "subjectAltName=IP:127.0.0.1\n" +
      "basicConstraints=CA:FALSE\n" +
      "keyUsage=digitalSignature,keyEncipherment\n" +
      "extendedKeyUsage=serverAuth\n",
    { mode: 0o600 }
  );
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", rootKey]);
  openssl([
    "req", "-x509", "-new", "-key", rootKey, "-sha256", "-days", "30",
    "-subj", "/CN=VeyraN Runtime Test Root", "-out", rootPemPath
  ]);
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", leafKey]);
  openssl(["req", "-new", "-key", leafKey, "-subj", "/CN=127.0.0.1", "-out", leafCsr]);
  openssl([
    "x509", "-req", "-in", leafCsr, "-CA", rootPemPath, "-CAkey", rootKey,
    "-CAcreateserial", "-days", "30", "-sha256", "-extfile", ext, "-out", leafPemPath
  ]);
  // An unrelated self-signed root, so the wrong-CA scenario has a real,
  // well-formed anchor that simply is not the one that signed the leaf.
  const otherKey = p("other-root-key.pem");
  const otherPem = p("other-root.pem");
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", otherKey]);
  openssl([
    "req", "-x509", "-new", "-key", otherKey, "-sha256", "-days", "30",
    "-subj", "/CN=VeyraN Unrelated Root", "-out", otherPem
  ]);
  for (const file of [rootKey, leafKey, rootPemPath, leafPemPath, otherKey, otherPem]) {
    fs.chmodSync(file, 0o600);
  }
}

ensureCerts();

const rootPem = fs.readFileSync(p("root.pem"), "utf8");
const leafPem = fs.readFileSync(p("leaf.pem"), "utf8");
const leafKeyPem = fs.readFileSync(p("leaf-key.pem"), "utf8");
const leafPin = createHash("sha256").update(rootPemToDer(leafPem)).digest("hex");

// The frozen v1 pairing document, exactly as the production reader expects it.
const pairing = {
  v: 1,
  service: "veyran-connect",
  brokerId: "b".repeat(32),
  port: 0, // filled in once the server is listening
  app: { id: "a".repeat(32), secret: "A".repeat(43) },
  tls: { rootPem, leafPin }
};

// A canonical 16-byte unpadded base64url session id (exactly 22 chars, low
// unused bits zero). The production reader's `VeyraNConnectSession.parse`
// requires exactly this shape, so the fixture must not invent a longer value.
const SESSION_ID = "dmV5cmFuLXNlc3Npb24xNg";

const HEALTH = {
  service: "veyran-connect",
  protocolVersion: 1,
  brokerId: pairing.brokerId,
  port: 0,
  bootId: "d".repeat(32)
};

let claimServed = false;

function json(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(data.length),
    ...extraHeaders
  });
  res.end(data);
}

function handle(req, res, body) {
  const route = req.url;
  if (mode === "redirect") {
    res.writeHead(302, { Location: "https://127.0.0.1:1/v1/health" });
    res.end();
    return;
  }
  if (mode === "compressed") {
    const data = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, result: {} })));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    res.end(data);
    return;
  }
  if (mode === "oversized") {
    res.writeHead(200, { "Content-Type": "application/json" }); // chunked
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent < 6 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      res.end();
    };
    pump();
    return;
  }
  if (mode === "refuse") {
    // No application request should ever arrive in this mode.
    res.destroy();
    return;
  }

  switch (route) {
    case "/v1/health":
      json(res, 200, { ok: true, result: { ...HEALTH, port: server.address().port } });
      return;
    case "/v1/session":
      json(res, 200, {
        ok: true,
        result: { sessionId: SESSION_ID, grantsGeneration: 7 }
      });
      return;
    case "/v1/claim": {
      if (!claimServed) {
        claimServed = true;
        json(res, 200, {
          ok: true,
          result: {
            item: {
              ticketId: "1".repeat(32),
              request: { operation: "status" }
            }
          }
        });
      } else {
        json(res, 200, { ok: true, result: { item: null } });
      }
      return;
    }
    case "/v1/reply":
      json(res, 200, { ok: true, result: { accepted: true } });
      return;
    default:
      json(res, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: "The requested broker route does not exist." }
      });
      return;
  }
}

const server = createServer(
  { key: leafKeyPem, cert: leafPem, minVersion: "TLSv1.2" },
  (req, res) => {
    fs.appendFileSync(requestsLog, `${req.method} ${req.url}\n`);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
    req.on("error", () => {});
  }
);

server.on("tlsClientError", () => {
  // A rejected handshake must not append to requests.log: the point of the
  // wrong-CA / wrong-pin scenarios is that *no* request is ever written.
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  pairing.port = port;
  fs.writeFileSync(
    p("connection.export.json"),
    JSON.stringify(pairing),
    { mode: 0o600 }
  );
  fs.chmodSync(p("connection.export.json"), 0o600);
  process.stdout.write(`READY ${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 250);
  });
}

// Keep a reference so lint does not elide it.
void randomBytes;
