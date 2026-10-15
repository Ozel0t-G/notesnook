# VeyraN Connect — broker, MCP server and plugin

> **Status of this document:** authoring handoff. The code and tests in
> `servers/veyran-connect` were written in this round and **have not been
> executed here** (no `npm`/`npx`/install/build/test/`tsc` runs in the authoring
> worker). Root runs the build, typecheck and test suite; §13 lists exactly what
> must run.

## 1. Architecture

There are three pieces and one transport:

```
  native VeyraN app                    MCP client (Codex/Claude, …)
  (outbound NSURLSession)                     │  stdio (JSON-RPC)
        │  HTTPS, pinned                      ▼
        │  POST /v1/…                  dist/server.mjs  (stdio MCP server)
        └──────────────┬──────────────────────┘  HTTPS, pinned
                       ▼
          veyran-connect broker (foreground, singleton)
          https://127.0.0.1:<persisted port>
```

- The **broker** is an explicit, foreground, singleton HTTPS listener bound to
  the fixed numeric IPv4 `127.0.0.1`. It never auto-spawns, never scans ports,
  never takes over a foreign listener and never daemonises. `EADDRINUSE` fails
  closed.
- The **stdio MCP server** attaches to the broker once (a pinned, authenticated
  health probe followed by a single `hello` handshake) and reuses that caller
  instance for every tool call; if the broker is absent or foreign it returns an
  honest `BROKER_UNAVAILABLE`. It never starts the broker.
- The **app** polls the broker over the same pinned HTTPS (iOS
  `NSURLSession`, loopback), draining work with `session`/`claim`/`reply`.
- The broker holds **no database, no ledger and no notes file**: it is a
  bounded RAM-only queue of plaintext requests between the MCP caller and the
  app. All durable exactly-once semantics live in Core's idempotency journal,
  and all authorization is decided by the app's Core adapter.

All three identities are separate 256-bit credentials; TLS is anchored to a
dedicated private root CA plus an exact leaf pin (§5).

## 2. Files and ownership

The operator profile is **only** the dedicated `<home>/.veyran-connect`
directory (or an explicit `--profile <dir>`). It is never the user's app
container or Keychain. The directory is `0700`; every file inside is `0600`,
created atomically and read with `lstat` + `O_NOFOLLOW` + `fstat` re-validation.

| file | owner | contents |
| --- | --- | --- |
| `broker.credentials.json` | broker | `{ v, app:{id,secret}, mcp:{id,secret}, tls:{rootPem,leafPem,leafKeyPem,leafPin} }` — **both** credentials **and** the server leaf private key; never leaves the profile |
| `broker.config.json` | broker | `{ v, brokerId, port, createdAt, leafPin }` — static identity + a consistency copy of the pin |
| `mcp.config.json` | caller | `{ v, brokerId, port, client:{id,secret}, tls:{rootPem,leafPin} }` — **MCP credential only**, never the app credential |
| `connection.export.json` | app import | `{ v, service:"veyran-connect", brokerId, port, app:{id,secret}, tls:{rootPem,leafPin} }` — written only on **explicit** `export-connection --out <path>`; the app imports it through its own user picker into a protected container/Keychain |
| `inbox.key.json` | operator | `{ v, createdAt, apiKey }` — the operator's **separate** Notesnook Inbox API key, written only by the explicit `inbox-key` command behind a hidden TTY prompt. It is **not** a broker credential, is never copied into any other file, and is used only as the `Authorization` header of the one fixed-endpoint `capture_note` request (§7.1). Deleting it disables `capture_note` only |
| `inbox.receipts.json` | operator | `{ v, receipts:[{ operationId, payloadHash, state:"accepted"\|"uncertain", at }] }` — bounded (≤256 entries), local-only capture receipts for repeat safety. A receipt records what **this process observed** (a documented 200, or an unknown outcome); it never claims a remote status and never contains any captured text |

`brokerId` is 32 hex chars (16 random bytes). A credential `id` is 32 hex
chars; a `secret` is exactly 43 base64url chars decoding to 32 bytes. A leaf pin
is exactly 64 hex chars (SHA-256 of the leaf DER).

## 3. Operator CLI

```
veyran-connect setup [--profile <dir>] [--port <port>] [--pair]
veyran-connect export-connection [--profile <dir>] --out <path>
veyran-connect mcp-config [--profile <dir>]
veyran-connect broker   [--profile <dir>]
veyran-connect inbox-key [--profile <dir>] [--replace]
veyran-connect status   [--profile <dir>]
```

- `setup` creates the `0700` profile and the `0600` files. It generates the TLS
  material (§5) and the credentials **only when the whole profile is absent**
  (no credentials *and* no config). A profile is valid only as a whole: one file
  present without the other, a corrupt/insecure file, or a caller config that
  does not match the broker credentials/root/pin is **never** overwritten or
  rotated — `setup` fails closed and leaves every file byte-for-byte unchanged.
  Nothing is written until all checks pass, and it is idempotent only for a fully
  consistent profile. Re-creating or re-importing is an explicit manual act.
- `export-connection` requires an explicit, user-chosen `--out` path and writes
  the app-side file; it refuses without one.
- `broker` runs the foreground singleton HTTPS listener on the persisted port.
- `inbox-key` stores the operator's **separate** Notesnook Inbox API key for the
  `capture_note` tool. The key is read **only** from a hidden prompt on a
  foreground TTY — never from argv, the environment, a pipe or a redirect — and
  is never echoed, printed, logged or telemetered. It is validated
  (printable ASCII, no whitespace, 16–1024 chars) and written atomically as
  `0600` into the existing `0700` profile. It refuses without an existing
  profile (`setup` first), preserves a valid existing key unless `--replace` is
  explicit, and never overwrites a corrupt, partial or permission-unsafe key
  file. This is the user's **only** missing setup step for Inbox capture.
- `status` prints a non-secret report (file permission status + broker
  reachability). It reports the inbox key file only as `ok`/`missing`/reason; it
  never reads or prints a credential.
- There is **no `teardown`**: removing the profile directory is a manual,
  explicit act; nothing here clears or takes over a foreign service.

Secrets never appear in argv, the environment, stdout, stderr or a log.

## 4. Broker wire protocol v1 (loopback HTTPS, POST only)

Route paths are literal `/v1/<route>`; bodies are strict JSON. Two roles exist
and are never interchangeable:

- **app** — `session` (handshake), `claim`, `reply`
- **mcp** — `hello` (handshake), `submit`, `await`, `cancel`
- **both** — `health`

A handshake returns a fresh random **instance id** (22-char base64url, 128
bits). Every
later request from that role carries the instance id and a strictly increasing
per-instance `nonce` (starting at 1). A restarted app or MCP caller simply
handshakes again: the new instance starts its own nonce sequence, so a relaunch
can never be poisoned by an old counter. Replaying a handshake `clientNonce` is
refused by a bounded recent-nonce window.

| route | body | result |
| --- | --- | --- |
| `health` | `{v}` | `{service, protocolVersion, brokerId, bootId, port}` |
| `session` (app) | `{v, clientNonce, accountId, grantsGeneration}` | `{sessionId, grantsGeneration}` |
| `hello` (mcp) | `{v, clientNonce}` | `{instanceId}` |
| `submit` (mcp) | `{v, instanceId, nonce, request}` | `{ticketId}` |
| `claim` (app) | `{v, sessionId, nonce, clientId}` | `{item: {ticketId, request} \| null}` |
| `reply` (app) | `{v, sessionId, nonce, clientId, ticketId, response}` | `{accepted: true}` |
| `await` (mcp) | `{v, instanceId, nonce, ticketId}` | `{response}` |
| `cancel` (mcp) | `{v, instanceId, nonce, ticketId}` | `{removed, uncertain, completed}` |

Every response is the strict envelope `{ok:true,result}` or
`{ok:false,error:{code,message}}` with a **static** code→message catalog; a raw
error string can never pass validation.

### Queue, session and cancellation semantics

- `submit` requires an active app session (otherwise honest `APP_UNAVAILABLE`)
  and binds the entry **immutably** to the current `sessionId`, `accountId` and
  `grantsGeneration`.
- A `session` handshake replaces the previous session and **purges the old
  session's entries**: an account switch A→B→A can never let one account's
  queued work be claimed or answered by another; replies to purged claims are
  refused.
- Capacity is `32` live (queued + claimed) entries; a request is bounded by a
  `30s` TTL. A periodic (and per-request) cleanup purges queued, claimed and
  delivered entries and expired instances, so capacity is released and no
  plaintext entry outlives its TTL. A delivered entry is removed after a short
  replay-retention window.
- The single live **app** session is a protected lease: a burst of MCP `hello`
  handshakes can never evict it from the bounded instance map (caller instances
  are evicted least-recently-used, the app lease is exempt). Otherwise the 9th
  tool call would silently destroy the app session and strand every request as
  `APP_UNAVAILABLE` with no re-handshake path.
- A `get_note` body delivered to a caller is independently bounded at **4 MiB**
  broker-side (a larger valid body is replaced by the correlated
  `CONTENT_TOO_LARGE` error envelope). The app→broker `reply` body is capped at
  **5 MiB** (route-specific, app-only), which is what lets an allowed Core
  `get_note` body (1M chars ≈ ~4 MiB UTF-8, plus JSON) actually reach the
  caller; every *caller* route stays capped at **1 MiB**.
- **Cancel before claim** removes the request entirely (`removed:true`) — no
  write can have happened. **Cancel after claim** reports `uncertain:true`: the
  app may already have persisted the write, so it may only be retried with the
  **same `operationId`** (Core's journal is the sole write authority). A late
  reply to an uncertain claim is refused.
- `await` timeouts that were already claimed report `UNCERTAIN`; timeouts that
  were never claimed report `APP_UNAVAILABLE`. A delivered response can never be
  replayed. A refresh (reply/cancel/cleanup) that lands during a parked `await`
  is re-read from the fresh entry state after the wait, so a late reply is
  delivered and an already-claimed entry stays uncertain.

### In-flight cancellation

- The caller's abort signal is re-checked after **every** await (attach, `hello`
  handshake, a stale-instance re-handshake) and, in the pinned HTTPS client,
  immediately **before** the request bytes are handed to the socket. An abort
  observed before the request is written is a **provable pre-transmit
  cancellation** — nothing was enqueued — and is reported as `CANCELLED`.
- Once the request has been transmitted, an abort is an **uncertain in-flight
  failure**: if the ticket was already acquired the client issues the correlated
  `cancel` and reports the claim phase (`CANCELLED` if the entry was still
  queued; `IDEMPOTENCY_UNCERTAIN` if it had been claimed). A blind business
  retry is never attempted on a network timeout; only the one-shot re-handshake
  for a **stale instance** (`SESSION_CHANGED`/`REPLAY`, a pre-enqueue rejection)
  is retried.
- Abort listeners are removed as soon as a request settles, so a long-lived
  signal can never retain a completed request or its payload.

## 5. TLS: dedicated CA, chain validation and leaf pinning

`setup` generates, with the fixed binary `/usr/bin/openssl` (no shell, static
argument vector, all output discarded, transient `0700` temp files):

- a **root CA**: EC P-256, self-signed, SHA-256, `basicConstraints=critical,
  CA:TRUE,pathlen:0`, `keyUsage=critical,keyCertSign,cRLSign`;
- a **server leaf**: EC P-256, signed by the root, `basicConstraints=critical,
  CA:FALSE`, `keyUsage=critical,digitalSignature`, `extendedKeyUsage=serverAuth`,
  `subjectAltName=IP:127.0.0.1`.

Both EC keys are generated with the **named-curve** encoding
(`genpkey … -pkeyopt ec_param_enc:named_curve`). macOS ships LibreSSL 3.3.6,
whose `genpkey -algorithm EC` default is the legacy *explicit* ECC-parameter form;
Node's TLS stack refuses such a peer certificate with "Certificate public key
has explicit ECC parameters", so the named-curve encoding is required for the
pinned handshake to complete. A regression test asserts
`asymmetricKeyDetails.namedCurve === "prime256v1"` for both keys **and**
completes a real Node TLS handshake with the generated material.

The requested validity is bounded to an integer in **2..365** days
(`minCertValidityDays`..`certValidityDays`). The root is signed with `N` days and
the leaf with exactly `N − 1`, because the leaf is signed slightly later and an
identical `N` would end *after* the root. The leaf's `notAfter` must be
**strictly** earlier than the root's — there is no grace window and no clamp, so
a leaf that outlives its root is refused outright. `N ≥ 2` is what keeps the
leaf ≥ 1 day without silently extending it. The root **private key** exists only
transiently and is destroyed after the leaf is signed; the runtime persists only
the server leaf private key (`0600`). The root is **never** installed into the
system trust store.

Before persisting, the material is validated in Node: the root is a CA, the leaf
is not, the leaf verifies against the root public key, the leaf private key
matches the certificate, the SAN is exactly one `IP:127.0.0.1` entry (no extra
DNS/IP names), the extended key usage includes `serverAuth` (read through Node's
`X509Certificate.keyUsage`, the EKU OID list — Node has no `extKeyUsage`
property), the dates are valid and the leaf's `notAfter` is strictly earlier than
the root's, and the computed leaf pin matches. Validation reads
`X509Certificate.validFromDate`/`validToDate`, which were introduced in Node
**22.10.0**; the runtime minimum is therefore Node ≥ 22.10.0 (verified on Node
24.x), not 20.

Callers (app **and** MCP client) trust exactly one anchor — the exported public
root — with `rejectUnauthorized:true` and a custom `checkServerIdentity` that
requires hostname `127.0.0.1` and the **exact leaf DER SHA-256 pin**. The pinned
handshake completes **before** any `Authorization`, `Host` or body byte is
written, so a foreign process that owns the port but presents any other
certificate receives zero request bytes. There is no proxy, no DNS, no redirect
and no decompression; a fresh agent per request means no TLS session is resumed
(`maxCachedSessions: 0` semantics). `TLSv1.2` is the floor.

**Honest residual:** the request/response plaintext is RAM-only in the broker,
but the OS may swap it; there is no promise of zero residual on a swapped
machine. This is documented, not hidden.

## 6. HTTP hardening (all fail closed)

- POST only; the **whole** request target must equal a literal `/v1/<route>` —
  a query string, trailing slash or fragment is `404` (the target is compared
  verbatim, never split at `?`). An **unknown** target is answered `404` and the
  socket is torn down *immediately*, without reading or draining the body, so an
  unknown route can never hold a buffer.
- `Host` must exactly equal `127.0.0.1:<persisted port>`; a duplicated singleton
  header (`Host`, `Authorization`, `Content-Length`, …) is refused from the raw
  header list even when Node would collapse or ignore the duplicate.
- **Any** `Origin` header is refused (native clients send none) — including
  `null`, a browser value, `localhost` or a DNS-rebinding value.
- `Sec-Fetch-*`, `Forwarded`, `X-Forwarded-*`, `Via`, `X-Real-IP`, `Upgrade`
  and oversized/too-many headers are refused.
- `Content-Encoding` (compressed bodies) is refused.
- **Authenticated at the edge before the body is read.** After the literal
  route and header checks, a required `authorizePreamble` performs the
  constant-time bearer check for the matched route's role (app routes
  `session`/`claim`/`reply` → app credential; caller routes
  `hello`/`submit`/`await`/`cancel` → MCP credential; `health` → either). A
  wrong or missing credential is a `401` with the socket closed **before a single
  body byte is buffered**, so an unauthenticated local peer cannot park many
  5 MiB request buffers; the in-`Broker` auth check remains as a second gate. A
  missing callback fails closed, never "allow all".
- Only then is the body counted while streaming; the read **stops immediately**
  over the route's cap (the socket is not drained to end), then fatal UTF-8
  decoding precedes JSON parsing. Caller routes are capped at **1 MiB**; the
  app-only `reply` upload is capped at **5 MiB** so an allowed Core `get_note`
  body can be delivered (no caller route gains that larger cap). The caller
  client applies the same route-aware cap. Responses are bounded at 5 MiB.
- A finite `server.maxConnections` (`64`) bounds concurrent loopback sockets.
- `allowedMethods`-style smuggling surfaces are closed: `checkContinue`,
  `upgrade` and `clientError` are refused; handshake/headers/request timeouts are
  bounded.

## 7. MCP server and tools

`dist/server.mjs` is the stdio entry point. It uses the official SDK
`serveStdio(() => buildMcpServer(), { transport: new StdioServerTransport(
process.stdin, process.stdout, { maxBufferSize: 1 MiB }), onerror })`. The
factory is **side-effect free**: it registers the twelve Core tools plus the one
non-Core `capture_note` tool (§7.1) and returns; the
SDK's default legacy handshake and its disposable modern-probe sibling both
build the same stateless server, so nothing is written, paired or spawned during
probing. The SDK client's default `versionNegotiation` is **`legacy`** (not
`auto`): the legacy path is what the default-constructed client tests exercise,
and a separate test explicitly opts into
`versionNegotiation: { mode: "auto", probe: { timeoutMs, maxRetries: 0 } }` and
lists the twelve tools. Protocol frames go to stdout **only**; diagnostics use a static
code→text catalog on stderr with no token, payload, id, title or raw
provider/parser/SQL text. **One** stdio server process is **one** MCP caller
instance: the first tool call performs the `hello` handshake and every later call
reuses that instance and its monotonic nonce sequence (a failed attach is not
cached and is retried once the broker is reachable). A restart or eviction of
that instance is recovered transparently by a single re-handshake. Two concurrent
servers are two independent caller instances.

The twelve Core tools map 1:1 to the accepted Core operations. Each visible
`inputSchema` is the Core request schema **minus the internal `operation`
field**; the tool adds `operation` internally, so the model can never
desynchronise the tool from the operation. `outputSchema` is the Core response
schema. Annotations are truthful: reads are `readOnly:true`; `update_note`/
`update_task` are `destructive:true`; create/append/complete are non-destructive;
all are `idempotent:true` and `openWorld:false`. There is no timezone parameter
anywhere (dates are floating device-local calendar values).

Every result is validated twice: the operation-correlated wire envelope
(`result.operation` must match) and the operation response schema. Errors are
the static bounded envelope, re-validated separately because the SDK skips
`outputSchema` validation for `isError:true`. A write whose fate is unknown — an
await transport failure or a claimed/cancelled request — is reported as
`IDEMPOTENCY_UNCERTAIN` (retry with the same `operationId`), never as saved and
never as an unavailable transport. Reads stay distinguishable. Cancellation
propagates `ctx.mcpReq.signal`: it is re-checked **after** every await (attach,
`hello`, re-handshake) and, inside the pinned client, immediately **before** the
request bytes are written. A call cancelled before anything is transmitted
provably never enqueued and is reported as `CANCELLED`; a request cancelled
before claim is removed (`CANCELLED`); one cancelled after claim is
`IDEMPOTENCY_UNCERTAIN` (retry with the same `operationId`). Truthfulness is
absolute: `sync` is always reported as `unknown`, and `persisted` exactly as Core
says.

Lifecycle: the stdio handle is used only through its documented `close():
Promise<void>` (the pinned SDK's `StdioServerHandle`), which closes the pinned
server **and** its transport. SIGINT/SIGTERM and a closed stdin pipe (EOF) all
trigger the same idempotent shutdown with a short, unref'd exit guard; no
lifecycle field is invented and no field is read through a cast.

### 7.1 `capture_note` — the official Notesnook Inbox API

`capture_note` is the **one non-Core tool**. It is deliberately *not*
`create_note`:

| | `create_note` | `capture_note` |
| --- | --- | --- |
| path | broker → app → Core database | direct HTTPS POST from this process |
| destination | the signed-in account's device database | `POST https://inbox.notesnook.com/` (fixed) |
| credential | the broker's 256-bit credentials | the operator's separate Inbox API key (`inbox.key.json`) |
| success means | `persisted: "local_saved"` + note id + `nn://` link | the relay answered `200 {"success":true}`: encrypted with the account's Inbox PGP key and **queued** |
| id / link | returned | **none exists** — the documented response has no note id |
| needs the app/broker | yes | **no** |

**Enablement (the user's only missing setup step).** The user enables Inbox in
the Notesnook app (`Settings > Account > Inbox API`), creates an Inbox API key
there, and then runs `veyran-connect inbox-key` once on a foreground terminal to
store it in the operator profile. Nothing else is required: no new port, no
app-side change, no broker restart. `capture_note` works even while the VeyraN
app and the broker are not running. Until a key is stored, the tool fails closed
with `INBOX_NOT_CONFIGURED`.

**What is sent.** `{ title, type:"note", source:"veyran-connect", version:1,
content?:{ type:"html", data } }` — the documented schema, nothing else. `source`
is a fixed constant; `title` is 1–512 characters with no control characters;
`content` is the user's text (≤ **1 MiB** UTF-8) converted locally to HTML.
`pinned`/`favorite`/`notebookIds`/`tagIds`/`archived` are **not** exposed: a
smaller surface means less to get wrong. The endpoint, method, path and headers
are literal constants in `inbox-transport.ts`; the model cannot supply a URL, a
key, a header, a proxy or a redirect setting (the strict input schema rejects
them). Redirects are never followed, plaintext HTTP is impossible, TLS
verification is on (`rejectUnauthorized`), TLS ≥ 1.2, the response is read only
up to 16 KiB, and the whole request is bounded by one timeout (15 s).

**Cleartext exposure (honest statement).** The Inbox API encrypts the payload
with the account's PGP *public* key **on the relay's side**, so the payload
leaves this process in cleartext over TLS and is decrypted/encrypted inside the
infrastructure that terminates TLS (`inbox.notesnook.com`, or a self-hosted
relay). This is therefore **not** a blind end-to-end path: it is private to the
same standard as the rest of the Notesnook sync protocol, and it is not claimed
to be more than that. The local `inbox.key.json` is a bearer secret: anyone who
reads it can post into the account's Inbox until the key is revoked in the app.

**What is converted.** Escaping happens **first** (`& < > " '`), so no element,
attribute, event handler or script from the capture can survive; headings
(`#`…`######`), paragraphs (single newlines become `<br>`), ordered/unordered
lists (nested items are flattened), blockquotes, fenced code blocks, inline
`code`, `**bold**`, `*italic*`, `~~strike~~` and `[label](url)` links are
produced. A link is emitted **only** for an exact `http`/`https` address from a
strict character allow-list (always with `rel="noopener noreferrer nofollow"`);
`javascript:`, `data:`, `file:`, relative and protocol-relative addresses stay
literal text. Everything the converter emits is a balanced tag it wrote itself,
so the documented "unbalanced tag becomes one code block" rule cannot be
triggered by our output. Plain text (`format: "plaintext"`) is escaped and split
into paragraphs only — no Markdown parsing at all.

**What is reported.** A documented `200 {"success":true}` yields
`{ status:"inbox_accepted", serverQueued:true, importedToDevice:false,
noteId:null, sync:"unknown", replayedFromReceipt }`. There is no note id, no
link, no "imported", no "synced" and no "created here" — the relay accepted and
queued the item; whether a device later decrypts and imports it is not knowable
from this response. `capture_note` never calls the Inbox response an import.

**Server acceptance vs device import.** Acceptance (`200`) means: the relay
fetched the account's Inbox public key, encrypted the payload and handed it to
Notesnook's servers. The note appears on a device only after that device syncs
and the Core merger (`handleInboxItems`) decrypts it with the account's Inbox
private key and calls `db.notes.add` with **the inbox item id as the note id**.
A failure at that later stage (bad key, invalid payload on-device, sync never
run) is invisible here and is surfaced by the app's own "failed inbound items"
list.

**Retry semantics (the API has no idempotency header and no status query).**
Local receipts, keyed by stable `operationId` and the canonical payload hash,
provide the only repeat safety:

1. Before anything is sent, a provisional `uncertain` receipt is written — so a
   crash between "sent" and "answered" can never become a silent resend.
2. `200 {"success":true}` → the receipt becomes `accepted`.
3. A documented refusal (`400` invalid item, `401`/`403` key/Inbox disabled,
   `429` rate limited) removes the receipt and returns the matching static code
   (`INBOX_REJECTED`/`INBOX_UNAUTHORIZED`/`INBOX_RATE_LIMITED`): nothing was
   queued, so a corrected retry may send again.
4. Anything else — timeout, a socket dropped after the body was written, `5xx`,
   an unparseable or truncated `200`, an unexpected status — leaves the receipt
   `uncertain` and returns `INBOX_UNCERTAIN`: the outcome is unknown, and the
   tool will **not** resend. There is no supported endpoint to ask whether the
   item arrived, so "unknown" is the honest answer.
5. An exact repeat (same `operationId`, same title/content/format) returns the
   stored receipt with **no second HTTP request**; the same `operationId` with
   different content is `IDEMPOTENCY_CONFLICT` and is refused without a request.
   A *different* `operationId` with the same content is a deliberately new
   capture and is sent.
6. A provably unsent request (DNS/TCP/TLS failure, or nothing written) returns
   `INBOX_UNAVAILABLE`, keeps no receipt, and may be retried.

Receipts are per operator profile and are bounded (256 entries, oldest dropped);
concurrent calls with the same `operationId` inside one process are serialized,
so a duplicate can never be sent by two in-flight calls.

Local error codes added for this tool: `INBOX_NOT_CONFIGURED`,
`INBOX_UNCERTAIN`, `INBOX_UNAVAILABLE`, `INBOX_REJECTED`, `INBOX_UNAUTHORIZED`,
`INBOX_RATE_LIMITED`, `LOCAL_STORE_UNAVAILABLE` (the receipt could not be
written, so nothing was sent); it reuses `IDEMPOTENCY_CONFLICT`,
`CONTENT_TOO_LARGE`, `UNSUPPORTED_CONTENT`, `INVALID_ARGUMENTS`, `CANCELLED` and
`CONFIG_INVALID`/`CONFIG_INSECURE` for the shared cases. No request body, title,
key or raw HTTP error body ever appears in a diagnostic, a log line or an error
envelope: diagnostics are static codes, and errors are the static catalog.

**Cost is not claimed.** The Inbox service is part of the account's Notesnook
functionality; this document makes **no** claim that it is free, unlimited or
included in any plan, and no claim about its availability or its own storage
retention. The documented rate limit (60 requests/minute/IP) and body limit
(10 MB) are *server* limits; this tool stays far below both (1 MiB text, one
request per accepted capture).

## 8. Plugin bundle

`plugin/veyran-connect` is a portable agent-plugins 1.0.0 bundle:

- `plugin.json` — `$schema`, `name: veyran-connect`, `version`; no historical
  top-level `skills`/`mcpServers` keys.
- `mcp.json` — `mcpServers.veyran-connect` is `{type:"stdio", command:"node",
  args:["${PLUGIN_ROOT}/dist/server.mjs"], cwd:"${PLUGIN_ROOT}"}`; `node` is
  never an absolute path or a placeholder. `${PLUGIN_ROOT}` is expanded **only
  in the plugin context** — a plain Codex-style MCP configuration that does not
  load the plugin must instead point `args` at the absolute
  `<repo>/plugin/veyran-connect/dist/server.mjs` (or the server package's
  `dist/server.mjs`) path.
- `skills/veyran/SKILL.md` — `name: veyran` plus a discriminating description.
- `dist/server.mjs` — the same self-contained bundle, built by
  `plugin/scripts/bundle.mjs` with the same purity guard as the server package.

A **complete** local plugin install is performed by the host's local
marketplace / plugins directory (which carries `plugin.json`, `mcp.json` and the
skill together). That is distinct from a bare `mcp add` of a single server:
adding only the MCP server does not install the skill, and this document makes no
claim that an MCP-only registration installs the skill.

### Local Codex plugin marketplace

`plugin/.agents/plugins/marketplace.json` is a Codex local-plugin marketplace
(marketplace id `veyran-local`) with one entry, `veyran-connect`, whose
`source` is the relative local path `./veyran-connect` (resolved from the
marketplace root, the `plugin/` directory that contains `.agents/`),
`policy.installation` is `AVAILABLE` and `policy.authentication` is `ON_USE`
(no auth on install; broker/app pairing and the optional Inbox key happen only
when a tool is used). Because a `local` source references the directory **in
place**, `dist/server.mjs` must be built before installing.

From the repository root:

```sh
# 1. build the bundle first: a local source is referenced in place, not copied
cd servers/veyran-connect && npm install && npm run build
cd ../../plugin/veyran-connect && npm run build
cd ../..

# 2. register the marketplace and add the plugin
codex plugin marketplace add ./plugin
codex plugin add veyran-connect@veyran-local
```

`codex plugin marketplace add` and `codex plugin add` are the commands supported
by the locally verified Codex build; run both from the repository root so
`./plugin` resolves. Restart Codex if it does not pick the plugin up in the
current session. The plugin installs with **no authentication**.

The plugin adds the separate stdio server id `veyran-connect`; a pre-existing
direct MCP server named `veyran` is **not** replaced and stays untouched. The
skill name `veyran` and the plugin id `veyran-connect` are likewise distinct
identifiers. This document does not claim that an MCP-only `mcp add` installs
the skill.

### Plugin-format verification

The local marketplace and plugin were accepted by the installed Codex CLI,
listed as enabled, and loaded from this checkout. The generated stdio bundle
also passed the real MCP SDK handshake test. This verifies the actual local
Codex installation path and MCP manifest behavior; no separate external
JSON-Schema validator was run.

## 9. macOS / ATS notes

The app talks to `https://127.0.0.1:<port>` with a **pinned** TLS chain that is
not in the system trust store. `NSAllowsLocalNetworking` is described by Apple
as covering unqualified hosts and numeric IPv4/IPv6 literals; the app must verify
this empirically in an isolated simulator **and** a verified isolated Mac before
any claim of "tested". No ATS wide exceptions (`NSAllowsArbitraryLoads`) and no
`network.server` entitlement are used for the broker. The app only ever makes
**outbound** connections (macOS sandbox `network.client`).

## 10. Native app integration

The native side is implemented in
`apps/mobile/ios/Notesnook/VeyraNConnect/`; the detailed wire and lifecycle
contract is in `CLIENT.md`. Pairing import and explicit capability grants are
available in the app settings. The client follows these constraints:

- Import the user-selected `connection.export.json` (explicit picker) into a
  protected container/Keychain; store the app credential, `brokerId`, `port`,
  public root and leaf pin.
- One **single** app session/lease at a time: on launch (and after any restart)
  call `session` with a fresh `clientNonce` and the current `accountId` +
  `grantsGeneration`, then drain with a single `clientId` via
  `claim`/`reply`. A session change replaces the lease and purges the old
  account's queued work.
- Authorization is **local**: the Core adapter independently checks the actual
  user and grants for every claimed request. Ids inside a request confer no
  right.
- No secrets are ever sent to the MCP side; the queue is plaintext RAM only,
  bounded, with a `30s` TTL.
- No `Origin` header; exact `Host`; the pinned TLS chain and leaf.

The native client built for iOS Simulator and Mac Catalyst. A synthetic iOS
simulator reached the app welcome screen, but a real app pairing, live broker
exchange from a Mac install and personal-account access remain untested until
the user imports the pairing file on their device. `APP_UNAVAILABLE` is the
current live status, so MCP does not claim the app is connected.

## 11. Teardown / rollback

Rollback is manual and explicit:

1. Stop the foreground broker (`Ctrl-C`).
2. Remove the MCP server from the client configuration.
3. Remove the Codex plugin registration and then its marketplace entry. Only
   `marketplace add` and `plugin add` were verified against the Codex build
   here; if it provides removal subcommands use them, otherwise delete the
   `veyran-connect` entry and the `veyran-local` marketplace through Codex's own
   plugin configuration:

   ```sh
   codex plugin remove veyran-connect@veyran-local   # if provided
   codex plugin marketplace remove ./plugin          # if provided
   ```

4. Optionally delete the dedicated profile directory `~/.veyran-connect` to
   destroy the credentials, the TLS material, the Inbox key *copy* and the local
   capture receipts. Deleting `inbox.key.json` (or the whole profile) removes
   only the local copy of the Inbox key: the key itself stays valid on the
   Notesnook side until it is revoked in the app
   (`Settings > Account > Inbox API > API Keys`), which is also what stops a
   third party who copied it from posting to the Inbox.

Nothing in this project clears, edits or takes over a foreign service, port or
configuration; a foreign listener on the persisted port is reported, never
replaced.

## 12. Tests (authored, **not executed** here)

| file | what it proves (over real transports) |
| --- | --- |
| `test/broker.test.ts` | role auth, handshake/instance/nonce semantics, restart safety, session replacement purge, **app-lease survival across a caller-instance burst**, **parked-await/cancel consistency**, queue capacity + release, cancel before/after claim, APP_UNAVAILABLE, **abort during a slow handshake enqueues nothing**, the full HTTPS edge hardening matrix (literal-target/query rejection, duplicated `Authorization` refusal, Host/Origin/header/encoding), the **edge auth before body read** (a wrong-role credential declaring a 5 MiB body is `401`ed with the socket closed and nothing buffered), an **unknown route with a declared large body gets an immediate `404`**, the route-specific cap (only app `reply` is 5 MiB), and the fail-closed oversize proof (a declared over-cap body is an immediate `413` with **no body byte read**, and an unknown-length chunked upload is refused the moment it passes the cap — the terminating chunk is never written, so nothing is drained) |
| `test/tools.test.ts` | the true route tool handler → pinned HTTPS client → broker → app TLS client → **real Core adapter** for all twelve operations, revision conflict, locked adapter, cancellation, correction and rejection, durable same-`operationId` replay across a DB restart, a **>1 MiB note body round trip** (fail-closed `CONTENT_TOO_LARGE` above the Core cap), and an **uncertain write when a claimed request is aborted in flight** |
| `test/setup.test.ts` | `setup` fail-closed: fresh profile created, re-run preserves bytes, and partial/inconsistent profiles are refused with **no file changed** |
| `test/tls.test.ts` | CA generation/validation (exact SAN, EKU via `keyUsage`, leaf `notAfter` **strictly** earlier than the root with no grace, validity bounded to the integer **2..365** days), **named-curve EC generation proven by `asymmetricKeyDetails.namedCurve` and a real Node TLS handshake**, pin mismatch rejection, and **zero** `Authorization`/HTTP bytes to a foreign listener |
| `test/stdio.test.ts` | built `dist/server.mjs` over the official SDK stdio client: twelve tools/no visible `operation` on the **default legacy** path, an explicit **`mode: "auto"`** session that also lists the twelve tools with no profile mutation/no broker spawn, an **EOF stdin pipe terminating the child well before the unref'd exit guard**, honest `BROKER_UNAVAILABLE`, and a real note-create round trip through the bundled stack |
| `test/inbox-format.test.ts` | `capture_note` input shaping with **no network**: strict schema (no key/url/header/proxy/redirect argument can be supplied), escape-first conversion of hostile HTML (`<script>`, `<img onerror>`, `<svg/onload>`, comments) proving no input markup survives, link filtering (`http`/`https` only; `javascript:`/`data:`/`file:`/relative/protocol-relative stay text, attribute breaks impossible), headings/paragraphs/lists/quotes/fenced code/emphasis/code spans, plain-text mode, CRLF/BOM normalization, control-character refusal, the 1 MiB text + 2 MiB derived-HTML bounds, the exact documented payload and the canonical payload hash (stable; changes with title/content/format; independent of the operation id) |
| `test/inbox-profile.test.ts` | the `0600`/`0700` inbox key file (round trip, missing → `INBOX_NOT_CONFIGURED`, corrupt/insecure/symlink refusal, no write into a non-`0700` profile), the hidden TTY prompt (typed value returned, **nothing echoed**, backspace editing, Ctrl-C abort with the terminal restored, non-TTY refusal, bounded paste), the bounded receipt store (one entry per `operationId`, upsert/remove, oldest dropped at 256, corrupt/insecure refusal, strict schema) and the keyed lock (serialization, no poisoning) |
| `test/inbox-tool.test.ts` | `capture_note` end to end against a **recording fake sender** (no live call): the exact request body and the profile-bound key, `inbox_accepted`/`serverQueued`/`importedToDevice:false`/`noteId:null`/`sync:"unknown"` wording, no title/body/key reflection, receipt replay with **no second request**, `IDEMPOTENCY_CONFLICT` on a reused id with changed content, uncertain outcomes (`INBOX_UNCERTAIN` + no resend + write-ahead receipt kept on a mid-flight crash), provably-unsent retry, documented refusals with no receipt, `INBOX_NOT_CONFIGURED`/`CONFIG_INVALID`/`CONFIG_INSECURE`, per-profile recipient binding, bounds/sanitization/redaction, cancellation before any write, single-flight concurrency, the real MCP registration + SDK in-memory `listTools`/`callTool` (13 tools, strict output schema), and static proofs that the transport names exactly one HTTPS endpoint, never reads a redirect/`location`, and never touches `process.env`/`process.argv` |
| `test/cli-inbox.test.ts` | `inbox-key` fail-closed behaviour: refuses without an existing profile, **never** accepts a key from argv, refuses a piped/non-TTY entry, preserves an existing key unless `--replace`, never overwrites a corrupt/insecure key file, and prints a key-free `status` report (`inboxKey: ok\|missing`) |
| `test/bundle.test.ts` | bundle purity and an isolated SDK handshake for the plugin's standalone `dist/server.mjs` (13 advertised tools: the 12 Core operations + `capture_note`) |
| `test/credentials.test.ts`, `test/contract.test.ts`, `test/manifest.test.ts`, `test/mcp.test.ts` | credential/limits strictness, single-contract schema/correlation, manifests and side-effect-free factory |

The pinned SDK client's **default** `versionNegotiation` is `legacy`, so the
default-constructed clients exercise the legacy path; the stdio suite adds one
explicit `mode: "auto"` (bounded probe) session. Both paths assert only the
twelve Core tools plus `capture_note`, the absent `operation` field and the
honest `BROKER_UNAVAILABLE`/round-trip behaviour, so no unverified
modern-vs-legacy claim is made beyond that explicit test.

**No live Inbox call is made by any test.** The `capture_note` suites inject a
recording fake sender (or the SDK in-memory transport) and use synthetic
placeholder keys in temporary profile directories; nothing in the test suite
contacts `inbox.notesnook.com`, and no real account, key, note or network
credential is used. The real HTTPS sender is covered by static proofs (one fixed
endpoint literal, no redirect/`location` handling, no environment/argv input,
TLS verification on, bounded request/response sizes) plus its pure
`classifyInboxResponse` mapping — not by a live request.

**Root must run, in order:** `npm ci` (or install) → `npm run build` (which also
emits the plugin bundle `plugin/veyran-connect/dist/server.mjs`) →
`npm run typecheck` (src) → `npm run typecheck:test` (tests; `tools.test.ts` and
`stdio.test.ts` are excluded from *type checking* because they import the real
Core fixture subtree — see `tsconfig.test.json`; they still run under `vitest`) →
`npm test`. The stdio and bundle/plugin tests **fail** (never skip) when `dist/`
is missing: build first.

## 13. Limitations (honest list)

- Generated certificates are bounded to the integer range **2..365** days
  (`minCertValidityDays`..`certValidityDays`, default 365); the leaf is minted
  exactly one day shorter than the root and its `notAfter` must be strictly
  earlier, so it can never outlive the root (no grace, no clamp). A 1-day request
  is refused rather than silently extended. **Manual rotation/re-import is
  documented here but not automated**. Rotating means deleting the profile
  (which mints a new CA) and re-importing the connection export in the app.
- The runtime minimum is **Node ≥ 22.10.0** (verified on Node 24.x), because
  validation reads `X509Certificate.validFromDate`/`validToDate` (added in
  22.10.0); the earlier `>=20` claim was inaccurate.
- Timebase: nonces are per-instance monotonic integers, not wall-clock; there is
  no clock synchronisation requirement between the caller and the broker.
- The queue plaintext may be swapped by the OS (see §5).
- The native app side (pairing import, grant UI, and pinned loopback client) is
  implemented in `apps/mobile/ios/Notesnook/VeyraNConnect/`. Until the user
  imports the pairing file and grants access in the running VeyraN app, the
  MCP server honestly reports the client as unavailable; no personal note is
  readable through the broker before that step.
- `capture_note` limitations, stated plainly:
  - the Inbox API documents **no idempotency header and no item-status query**,
    so an `INBOX_UNCERTAIN` outcome can never be resolved later by this tool: the
    item may or may not have been queued, and neither a resend nor a "check"
    endpoint is available;
  - the payload is encrypted by the **relay**, not by this process: the relay
    (and whatever terminates its TLS) necessarily handles the cleartext body.
    This is not a blind end-to-end path;
  - an atomic per-profile lock serializes capture sends across processes. If a
    process crashes while holding it, later capture calls fail closed with
    `INBOX_BUSY`; after stopping all MCP processes for that profile, the
    operator can remove the stale `inbox.capture.lock` marker. Receipt history
    is bounded to the latest 256 operations, so an evicted old operation ID no
    longer has local deduplication protection;
  - receipts are bound to a one-way fingerprint of the configured Inbox API
    key. Reusing an operation ID after switching recipients is a conflict,
    rather than a false report of acceptance for the new account;
  - receipts live until a profile is deleted or the 256-entry bound drops them;
    deleting `inbox.key.json` does not delete receipt history;
  - capture text is bounded to 1 MiB and the *derived* HTML to 2 MiB (escaping
    expands the input), so an extreme body (e.g. ~1 MiB of `<`) is refused as
    `CONTENT_TOO_LARGE` rather than sent;
  - Markdown support is the deliberate subset in §7.1 (no tables, images,
    nested lists, footnotes or HTML passthrough): anything richer is escaped
    text, and unbalanced markup can never be produced;
  - the Inbox endpoint is the fixed official host only; the documented
    self-hosting option (a self-hosted relay URL) is **not** supported by this
    tool, and no cost/plan/availability claim is made about the hosted service;
  - no live Inbox call is made by any test (see §12).
- `/usr/bin/openssl` flag support was confirmed against macOS LibreSSL 3.3.6
  (`genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -pkeyopt
  ec_param_enc:named_curve`, `req -x509 -extensions`, `x509 -req
  -extfile/-extensions/-CAcreateserial`); the `ec_param_enc:named_curve` option
  is required because LibreSSL's default is the explicit ECC-parameter encoding
  that Node's TLS rejects. The full generate-and-validate round trip could not be
  *executed* in the authoring sandbox (spawned writes to the temp dir were denied)
  and is a Root step.
