# VeyraN Connect — Mac Catalyst client host

This document describes the **client** side of VeyraN Connect: the native
Mac Catalyst broker client and the JavaScript host that executes Connect
requests against the encrypted Core domain. The broker itself (a separate
foreground Node process) and the MCP caller are documented in `MCP.md`; the
pure Core operation/authorization contract is documented in `CORE.md`.

> **Authoring / verification status.**
>
> - **Verified in the authoring environment:** the pure Swift helpers and the
>   standalone harness (`VeyraNConnectWire/Session/PairingFile/PairGate/Lifecycle/TLS`
>   + `Tests/VeyraNConnectHarness.swift`) compile with `swiftc` for
>   `arm64-apple-ios18.0-macabi` and the harness **runs to 225 passing checks**
>   (see §8 for the exact command). No app, entitlements, simulator or personal
>   Keychain is touched.
> - **Authored, not executed here:** the JavaScript host, its Jest suite, the
>   React settings screen and the React Native module (`VeyraNConnectModule.swift`,
>   which imports React and cannot be compiled without the app) — no `tsc`, no
>   Jest and no app build were run in the authoring environment (no
>   `node_modules`; `npm install`/`npx` are out of scope for this worker). The
>   coordinator runs those.
> - **Not yet proven:** an *actual* production `URLSession` handshake against a
>   throwaway Node HTTPS fixture. The pure `SecTrust` fixture in the harness
>   proves the trust/pin policy, not a live zero-HTTP handshake. A runtime
>   transport harness is the next rung and is **not** claimed as passing here.
> - The native client never launches a Mac app: a full Mac UI run needs an
>   isolated app container/profile and is deliberately out of scope here.

## 1. Roles

```
MCP client  ──submit──▶  broker (Node, 127.0.0.1:port)  ──claim──▶  native client (Mac)
                                     ▲                                   │
                                     └──────────── reply ◀──────────────┘
                                                                         │ executes
                                                                         ▼
                                                        Core ConnectAdapter (encrypted DB)
```

- The **native module** (`apps/mobile/ios/Notesnook/VeyraNConnect/`) is the
  **outgoing** client only. It holds the paired credential, verifies the pinned
  certificate, establishes the broker session, polls exactly one correlated
  claim at a time and emits each validated request to JavaScript. It never
  listens, never opens a server socket and needs no `network.server`
  entitlement. Mac Catalyst already carries `com.apple.security.network.client`.
- The **JS host** (`apps/mobile/app/services/veyran-connect.ts`) validates the
  request against the pure Core wire schema, executes it through a single
  `ConnectAdapter` and answers the correlated ticket.
- The **settings screen** (`apps/mobile/app/components/veyran-connect-settings.tsx`)
  is registered as the `veyran-connect` settings component.

## 2. Pairing document (frozen v1)

The operator exports `connection.export.json` (`saveConnectionExport`). The
accepted shape is exact — an unknown version, missing field, unknown field,
out-of-range port or malformed pin fails closed:

```json
{
  "v": 1,
  "service": "veyran-connect",
  "brokerId": "<32 lower-case hex>",
  "port": 45999,
  "app":  { "id": "<32 lower-case hex>", "secret": "<43 base64url chars>" },
  "tls":  { "rootPem": "-----BEGIN CERTIFICATE-----\n…", "leafPin": "<64 hex>" }
}
```

- `app.secret` must decode to **exactly 256 bits** *and* re-encode to the
  identical 43 characters. A 43-char string carrying unused low bits is refused
  (a regex alone would accept it). There is no `app.token` field.
- `tls.rootPem` is at most 16 KiB; `tls.leafPin` is the exact leaf DER SHA-256.
- **Duplicate object keys are refused.** `JSONSerialization` would otherwise
  accept `{"leafPin":"…","leafPin":"…"}` with last-wins semantics, reinterpreting
  a security field; a bounded scanner rejects any document in which a key repeats
  inside the same object (after `\u` escape decoding) before the values are read.
- The document is read once through an `O_NOFOLLOW | O_NONBLOCK` descriptor whose
  `fstat` must prove a regular file, owned by the current effective user, mode
  **exactly** `0600` and ≤ 64 KiB. A symlink, another owner, any group/other bit,
  a broader owner-only mode such as `0700` or `0400`, a FIFO/device, an oversized
  file or malformed JSON reads nothing and writes nothing. `O_NONBLOCK` means a
  FIFO can never block `open` before the `fstat` that rejects it.

The imported identity is stored in a **new, namespaced Keychain service**
(`com.ozel0t.veyran.connect.pairing.v1`) inside the app's **existing entitled
default access group** (`$(AppIdentifierPrefix)group.com.ozel0t.note.notesnookpencil`),
with `kSecUseDataProtectionKeychain: true`,
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `synchronizable: false`.
No app-identifier access group is requested (the app is not entitled to one).
`disconnect` deletes only its own record. Any Security error fails closed; there
is no legacy-Keychain or file fallback.

Saving is **atomic**: the existing item is rewritten with `SecItemUpdate`, and
`SecItemAdd` is used only when the item does not exist (`errSecItemNotFound`).
Any other error fails closed and leaves the previous item untouched; the module
does **not** activate a new pairing in memory unless the store reported success.
The native module runs no Keychain read/delete on an unsupported platform.

**Access-group boundary.** The app shares one signed access group with its
signed extensions. A sibling extension that shares the app identifier could, in
principle, reach the same group. None of the existing extensions reads this new
service, and the credential is never "app-exclusive": this is a documented
boundary, not a guarantee against every sibling binary.

## 3. TLS trust

The broker's leaf is signed by a dedicated self-signed root that is **never** in
the system trust store. The client's `URLSession` delegate:

1. requires the literal host `127.0.0.1`;
2. installs an SSL policy for that host;
3. anchors **only** to the paired root (`SecTrustSetAnchorCertificatesOnly(true)`);
4. evaluates the chain and validity time (`SecTrustEvaluateWithError`);
5. requires the presented leaf's DER SHA-256 to equal the paired pin.

A foreign process that owns the port is rejected during the handshake, before
any `Authorization`, `Host` or body byte is written. There is no
`rejectUnauthorized:false`, no unconditional trust and no system-CA fallback.
The session is ephemeral (no cookies, no cache, no proxy) and never follows a
redirect. The credential travels only in `Authorization: Bearer <id>.<secret>`,
never in a URL or a log.

The pure harness proves this **policy** (right chain, right pin, empty anchors
refused); the "zero HTTP bytes" property is asserted by the *runtime* transport
fixture in §8 — and that fixture has **not yet been run** here.

Responses are read **incrementally** through the data delegate and bounded to
5 MiB: a declared `Content-Length` over the bound is refused before the body, a
running buffer that exceeds the bound cancels the task immediately (so a chunked
or undisclosed-length response cannot grow the process), and any
`Content-Encoding` other than `identity` is refused before a body byte is
accepted. The request asks for `Accept-Encoding: identity`, so a compressed body
is never delivered at all.

## 4. Wire protocol (v1)

Routes are the closed set `POST /v1/{health,session,claim,reply}` on
`https://127.0.0.1:{port}`. Frames are bounded (request 1 MiB, reply 5 MiB,
response 5 MiB) and strictly UTF-8/JSON.

| Route | Request | Success result |
| --- | --- | --- |
| `health` | `{v:1}` | `{service,protocolVersion:1,brokerId:32hex,bootId:32hex,port}` |
| `session` | `{v:1,clientNonce:22,accountId,grantsGeneration}` | `{sessionId:22,grantsGeneration}` |
| `claim` | `{v:1,sessionId,nonce≥1,clientId:6..200}` | `{item:null \| {ticketId:32hex,request}}` |
| `reply` | `{v:1,sessionId,nonce,ticketId,response}` | `{accepted:true}` |

`health` must report the *paired* `brokerId` and `port`; a restarted broker is
detected by a changed `bootId`, and the previous session/nonce sequence is
discarded under the current host lease. `sessionId` is broker-issued and is
separate from any host id. `nonce` starts at 1 and strictly increases per
session. At most one claim is outstanding; a reply is accepted only for the
exact outstanding ticket. Every response envelope is `{ok:true,result}` or
`{ok:false,error:{code,message}}`, where `message` must equal the static catalog
string for its `code`.

## 5. Capabilities and grants

Capabilities are explicit switches, **all default off**: `canRead`,
`canCreate`, `canChange`, `canTask`, plus a bound selection of notebook ids,
task-list ids and (only if explicitly chosen) note ids.

- `canChange` requires at least one selected notebook or note.
- `canTask` requires at least one selected list.
- `canCreate` **additionally requires a chosen, live, externally-shareable
  default notebook**. An omitted `create_note.notebookId` is normalized to that
  notebook *before* execution, and only when that id is still a member of the
  immutable granted set, so a retry of the same `operationId` fingerprints
  identically and an unfiled note can never be created silently. An explicitly
  named notebook is still authorized by Core against the grants.
- No right is ever inferred from a request id.

Grants are snapshotted immutably by Core (`GrantSnapshot`) and installed **only
after** the persisted account and its bootstrap are valid **and** a broker is
paired. They are never installed before login. The JS host keeps a deep-copied
snapshot of the installed capabilities and **clears it synchronously at every
lock/close/clear/account-switch/grant-generation seam**, so a stale default can
never be used to normalize a request.

### The local record vs backups

The chosen default notebook and capability record are stored as a single
encrypted, **device-local** `SettingItem` (`localOnly: true`) in the encrypted
Core database. It **never carries a credential or a note body**, and its
*content* is excluded from Sync.

The record's codec lives in a **pure module**
(`apps/mobile/app/services/veyran-connect-grants.ts`: no React Native, no
database, no Core import) that both production (`veyran-connect.ts`) and the
headless Core test import, so the shape proven in a test is the shape the app
writes. The stored `value` is always the **canonical JSON string** — the
`settingitem` DataMapper only `JSON.parse`s a fixed set of key prefixes, so
`veyranConnectLocal` must round-trip as text (a warm cache would otherwise hold
an object while a reopened SQLite row holds a string). A closed/reopened
encrypted database therefore yields an identical parse; `packages/core/__tests__/connect/grants-persistence.test.ts`
proves exactly that against a real password-encrypted SQLite fixture
(`openConnectDb` + `signIn("acct-1")`), including the account-bound id lists and
the rejection of legacy/malformed rows.

**Honest scope.** "localOnly" excludes the record's *content* from Sync; it does
**not** make the record invisible everywhere. Sync still pushes a tombstone
(`{id, deleted, dateModified}`) for a `localOnly` row. More importantly, a
**user-created backup** (the existing, user-selected export) may include the
record's metadata — the account id and the capability id lists. The native
credential (Keychain) is never part of any backup. So the correct statement is:
*the record is encrypted at rest, its content is excluded from Sync, and its
metadata may appear in a backup the user explicitly creates.*

A restored record **never auto-activates**. Grants are reinstalled only when the
actual signed-in account matches the record **and** the device's own protected
pairing is present **and** the user explicitly starts a session after reviewing
the current choices. Restoring a backup without pairing, or without an explicit
start, installs nothing.

## 6. Lifecycle seams

The host is mounted once from the mounted app hook (no headless autostart, no
module-level autostart). A monotonic host epoch, a per-run host UUID and an
adapter generation are captured at the start of every request and re-checked
**before and after every await**; a stale reply is dropped rather than executed.

| Seam | Action (first line, before any await) |
| --- | --- |
| `onLogout` | `onHostTearDown()` — close adapter, bump epoch, clear snapshot, native stop |
| `onUserSessionExpired` | `onHostAccountChanging()` — lock adapter, bump epoch, clear snapshot, native stop |
| `migrationStarted` | `onHostMigrationStarted()` — lock adapter, bump epoch, clear snapshot, native stop |
| `onUserUpdated` entry | `onHostAccountChanging()` — fences an A→B→A cycle |
| actual account change (id differs) | `onHostAccountChanging()` + `stopSession()` on the synchronous subscription callback |
| `userStore.subscribe` (synchronous) | lock / clear / close + epoch on lock, `isLoggingOut`, account-session, `accountSetupRequired` |
| `stopSession` | bump epoch, clear snapshot **and the adopted native identity**, lock adapter, then native stop |
| host unmount (listener cleanup) | bump epoch, clear snapshot, lock adapter, native stop — not just `listener.remove()` |
| unlock | reinstall persisted grants **only** for the same actual Notes account |
| pairing pick (`pickPairingFile`) | fence the live JS session **first** (drop identity + snapshot, bump epoch, lock adapter, native stop), then own one pair flow |

### The pairing import fence

Importing a pairing file is a lifecycle edge, not a read:

1. `pickPairingFile` fences the live JS session **synchronously, before the
   picker opens** — the adopted native identity and the capability snapshot are
   dropped, the host epoch is bumped, the adapter is locked and the native poll
   loop is stopped. A claim queued under the previous session can therefore
   never execute while a file is being imported.
2. The call claims one monotonic **pair flow** and captures the exact mounted
   account + host identity. A lock, disconnect, unmount, account switch or a
   *concurrent* pick bumps that counter; when the picker resolves, the flow,
   mount, host epoch and account are all re-checked. A completion that fails any
   of them is reported as `{ paired: false, cancelled: true, stale: true }` —
   never as a pairing — and is never adopted.
3. The native side applies the same rule before its **atomic** Keychain store:
   every pick is stamped with `(epoch, pick generation)`, a new pick or any
   stop/disconnect/replacement invalidates the previous token, and the token's
   store slot is consumed *exactly once* — immediately before `SecItemUpdate` /
   `SecItemAdd`. A stale, cancelled or invalid completion therefore cannot
   reach the store, and the previously stored credential stays untouched.
   Authorization, the credential store call, the re-check and the memory/engine
   adoption are **one critical section** of the single
   `VeyraNConnectLifecycle` primitive (covered by the standalone harness with an
   injected synthetic credential store and real concurrent threads): a fence
   that lands first leaves the token stale (zero store calls), and a fence that
   lands after a commit — including a disconnect requested while the commit is
   inside the store — waits for it and then owns the final state (engine
   invalidated and dropped, pairing cleared, credential deleted). The same
   primitive linearizes `ensureEngine` against stop/disconnect, so a cached
   epoch comparison can never adopt the previous pairing/engine after a
   disconnect.

   The native side claims the pick token **synchronously at the native method
   entry**, *before* it hops to the main queue to open the picker. The deferred
   main-queue work then re-checks that the *exact* entry token is still the
   current pending pick (`isCurrentPick`) before it shows the picker or stops
   the poll loop, and it never re-stamps a fresh token at queue-execution time.
   A disconnect/stop that lands while the work is still queued therefore leaves
   the entry token stale, and the queued work bails with
   `{ paired: false, cancelled: true, stale: true }` — zero stores, no picker,
   and no newer poll loop disturbed. (Stamping a fresh token *inside* the
   queued block re-opens exactly the post-disconnect resurrection window; the
   harness's *dispatch-entry fencing* group models both orderings and proves
   the superseded one would store.)
4. A re-pair commit **invalidates the previous engine** before replacing it, and
   a disconnect invalidates *and drops* it, so a session that belonged to the
   replaced pairing can neither keep polling nor answer a late claim.

`onHostAccountReady` captures the mounted/account/epoch state **before** the
native status read and re-checks it **after** every await (status, account id),
so a lock, logout or migration that races the read can never resurrect an unlock
or install a grant. `installGrants` revalidates account + epoch **after** the
Core `setGrants` promise resolves and clears the snapshot/grants on any mismatch.

### Authoritative eligibility (fail closed)

Unlocking the adapter, installing grants, adopting a native session and executing
a request all pass through one fail-closed proof, `hostEligibility()`, which reads
the **real lifecycle stores** rather than an assumed default:

- `db.isInitialized === true` (the encrypted database exists),
- `SettingStore.isAppLoading !== true` (not still hydrating),
- `UserStore.appLocked !== true` (not App Locked),
- `UserStore.isLoggingOut !== true` (no logout in progress),
- `UserStore.accountSetupRequired !== true` (no pending (re)setup),
- a persisted account id is present.

Any thrown getter denies without enumerating the database or touching the
Keychain. `onHostAccountReady` proves this **before** the unconditional
`adapter.unlock()`, and again after every await — so the previously reachable
"lock during a durable grants write → unlock on a stale epoch" resurrection is
refused, and the direct executable export is gated the same way.

### Two-phase native start

`startSession` deliberately does **not** let the native side poll. It runs in two
phases so JS owns the exact session context before any event can be emitted.
The account-bound persisted record is **mandatory**: an **absent** record or a
record that belongs to a **different** account is refused with `false`
*before* any native credential read (`getStatus` → Keychain), session or network
operation — a recall of the previous behaviour that opened a broker session with
no grants installed is therefore impossible. It also fails closed *before* the
native session opens when the app is not eligible (§ "Authoritative
eligibility"), when the host is not mounted, or when the matching record cannot
actually be applied (not paired, locked, account switched, database not ready) —
in those cases it reports `false` and never calls `startSession` on the native
side. The settings screen says which of the two reasons applies.

1. `startSession(accountId, grantsGeneration, clientId)` verifies the broker
   identity and establishes the session, then resolves with the exact context
   `{ sessionId, grantsGeneration, nativeLeaseGeneration }` — and does **not**
   poll. `nativeLeaseGeneration` is the native session-engine *lease* generation
   (a distinct counter from the Core grants generation; the two are never
   compared).
2. JS adopts that context immutably (`ActiveNativeSession`) and calls
   `activateSession(nativeLeaseGeneration, sessionId)`. The native side re-checks
   the exact `(flow, session)` tuple against the live engine and only then begins
   polling. If activation fails, the adopted context is revoked synchronously and
   no success is reported.

   The host epoch is snapshotted **synchronously at the native `startSession`
   entry**, before the asynchronous task is scheduled; the task then adopts the
   engine against that immutable entry epoch, so a stop/disconnect that landed
   while the work was queued is refused *before* the credential load or the
   engine build (zero Keychain reads, zero transports). `ensureEngine` returns
   the engine together with the exact lease generation it held at the moment of
   adoption — read inside the same lifecycle critical section — and
   `establishSession` takes that immutable lease as its **first** engine-lock
   check, *before* the first health/session frame. A stop that lands between the
   adoption and the handshake entry therefore can never open a broker session
   under a replaced pairing, and every subsequent post-await flow guard is
   retained. (Reading the epoch inside the task, or the lease after
   `ensureEngine` returns, re-opens exactly those windows; the harness's
   *dispatch-entry fencing* and *adoption lease fencing* groups model both
   orderings and prove the superseded ones would proceed.)

Every emitted `connectRequest` event carries a **mandatory** canonical 22-char
`sessionId` and the native lease `generation`; a missing or malformed context is
rejected outright. `handleNativeRequest` requires both to match the adopted
session exactly, re-checks the host epoch/mount and the authoritative eligibility
before execution and **after every await**, and the reply passes the expected
native lease generation + session id back to `reply(...)`, which re-checks them
under the engine's own lock before sending. A queued event from a previous
session (Stop → Start, or A → B → A) can therefore never execute, and a stale JS
ticket can never be delivered into a different session — even when the ticket id
happens to be outstanding.

`executeConnectRequest` checks the captured host identity **before** it
normalizes or executes anything, not only after the Core write: a caller that
captured an identity that is already stale (a seam bumped the epoch between the
capture and the call) gets a static `INVALID_INPUT` and **zero** Core
operations — no optimistic write followed by a refused reply. A direct call
without a captured identity takes the current one, so the same gate applies to
every entry point.

The native engine mirrors this: every async flow (session handshake, claim,
reply) snapshots the monotonic lease generation before its first await and
re-checks it after **every** await, so `invalidate()` (stop/stop-session/re-pair/
disconnect) can never be resurrected by a late result. The claim slot is taken
*before* the await (a second concurrent claim is refused as `busy`), the
outstanding-ticket correlation is cleared only for the exact session+generation,
an unanswered ticket expires with its lease (the poll loop drops it rather than
wedging forever), and each emitted event carries generation+session metadata that
is re-checked at dispatch.

After a confirmed Core write the existing surfaces are refreshed
(`Navigation.queueRoutesForUpdate`, `useRelationStore.update`, `refreshAllStores`,
`NotePreviewWidget.updateNotes`) and the existing `TaskNotifications.reconcile()`
is awaited — never a forced editor reload over an unsaved draft, and never a
`syncCompleted`/`appRefreshRequested` event.

The document picker makes the key window inactive; that is **not** an auth lock.
The existing `appDidEnterBackgroundForAction` flag is saved, set true around the
picker and restored afterwards.

## 7. Platform behaviour

- **Mac Catalyst**: fully functional.
- **iOS / iPadOS**: the Connect client is honestly unavailable. The settings
  screen says so and disables pairing and session start only; the shared Core
  data still syncs normally. The native module performs **no** Keychain read,
  delete or session start on an unsupported platform, and the JS `disconnect`
  does not call the native disconnect there.

## 8. Tests

**Swift standalone harness — compiled and run to `PASS: 225 checks`** in the
authoring environment (pure Foundation/Security; real test chain; no app,
entitlements or simulator). Files it creates are made with POSIX calls, because
the Mac Catalyst sandbox used to compile the harness denies `FileManager`
writes outside a container:

```
swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -target arm64-apple-ios18.0-macabi -swift-version 5 -parse-as-library \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectWire.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectSession.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectPairingFile.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectPairGate.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectLifecycle.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectTLS.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/Tests/VeyraNConnectHarness.swift \
  -o "$TMPDIR/veyran-connect-harness" \
&& VEYRAN_HARNESS_DIR="$TMPDIR" "$TMPDIR/veyran-connect-harness"
```

`VEYRAN_HARNESS_DIR` must point at a writable directory: without it the
file-reader scenarios report their directory as uncreatable (and the run
reports fewer checks / one failure) instead of failing closed silently.

It covers: exact pairing JSON with unknown keys denied, **duplicate-key
rejection** (including `\u`-escaped duplicates), **strict numeric types** (a
boolean `v`/`ok`, a fractional port and an out-of-safe integer are refused while
a real boolean is accepted), canonical base64url (unused-low-bit rejection), the
closed URL/route map, the 64 KiB document bound, the symlink-safe reader
(symlink / `0644` / `0700` / `0400` / FIFO / missing), the real TLS
chain + leaf-pin evaluation (right pin, wrong pin, empty anchor set ⇒ no system
fallback, non-loopback host), the nonce sequence, single outstanding-claim
correlation, cancellation, bounded backoff, and the flow-fencing behaviours
(a handshake invalidated mid-flight never resurrects `active`; a concurrent
claim is `busy`; a reply invalidated mid-flight is refused; an unanswered ticket
and the lease both expire), **the session-id canonical form** (a canonical
22-char 16-byte value is accepted and parsed, the old 27-char non-canonical value
is refused by both the validator and `VeyraNConnectSession.parse`), and the
**reply session/flow fence** (a reply with the wrong native lease generation or
the wrong session id is refused *before* the frame is sent, leaving the
correlation outstanding), and the **pair gate** (`VeyraNConnectPairGate`, 20
checks) — a Foundation-only, harness-tested historical predicate that the
module **no longer wires in** (its token semantics are folded into
`VeyraNConnectLifecycle`; it is retained only as the reference model and is
*not* the primitive that protects the module): a fresh pick owns the store slot
at the live epoch; a lifecycle fence (lock / disconnect / unmount / account
switch) bumps the epoch, drops the pending pick, and the fenced token can never
take the store slot; a concurrent pick invalidates the older pick and the slot
is consumed exactly once (no duplicate store); a pick opened *after* a fence
still stores; an abandoned (cancelled/invalid) pick can never store, leaving
the previously stored credential untouched.

It then covers the **single lifecycle linearization primitive**
(`VeyraNConnectLifecycle`, 64 checks) with an injected synthetic credential
store, an injected engine factory and *real concurrent threads*: a fence that
landed before a picker completion ⇒ zero credential store calls, no adoption; a
legitimate completion stores exactly once, adopts the pairing atomically and
refuses a duplicate completion; only the newest of two concurrent picks stores;
a refused store consumes the pick and adopts nothing; a re-pair invalidates and
drops the replaced engine; `stop` fences without touching the credential while
`disconnect` deletes it and clears memory; engine adoption is epoch-fenced,
reuses a matching engine and never builds one after a disconnect; and the
concurrency proofs — a commit paused *inside* the injected credential store
while a disconnect waits, then the disconnect deletes what the commit wrote
(final memory + credential nil, delete observed only after the save returned),
and a paused engine adoption that a concurrent disconnect invalidates after the
factory returned (nothing survives the disconnect; the reverse order refuses
the adoption before the factory runs). It reads/writes only its own files under
`$VEYRAN_HARNESS_DIR` (default the system temp dir) and never touches the
personal Keychain.

It then covers the three **dispatch-entry fences** (the *dispatch-entry
fencing* group, 26 checks) by modelling the module's deferred main-queue work as
a closure consumed *after* the fence, using the exact production primitive
calls: a pick token claimed at native entry whose pending work is later
dispatched bails when a queued disconnect/stop left it stale (zero stores, no
picker shown), two concurrent entry claims let only the newest store, and the
counterfactual ordering — stamping a *fresh* token inside the queued block —
is shown to resurrect the credential (proving the entry-claim guard is load
bearing). Likewise a start entry epoch captured at native entry is refused
after a queued stop/disconnect *before* the credential load or engine build,
while the counterfactual (capturing the epoch inside the queued work) proceeds
and reads the store. The *adoption lease fencing* group (10 checks) then runs
the **real** `VeyraNConnectSessionEngine` over a scripted transport through the
lifecycle: the lease captured atomically with the adoption is refused
after a stop *before* the first health frame (no frame sent, no active
session), the counterfactual lease read after the stop is shown to open a
session, an unfenced adoption still establishes health→session, and a reused
adoption captures the engine's current lease.

**Not run here:** the JavaScript/Jest suite, the Vitest Core suite and the React
Native module (the isolated checkout has no `node_modules`, and installing or
mutating a lockfile is out of scope). All three are authored and are run by the
coordinator. The Jest suite:

```
cd apps/mobile && npx jest app/services/veyran-connect.test.ts \
  --runInBand --moduleNameMapper '{"^@notifee/react-native$":"<rootDir>/node_modules/@ammarahmed/notifee-react-native-mock"}'
```

They cover: no authorization before grants, no grant for a different account, a
lock/logout invalidating an in-flight request before it replies **or refreshes**,
an A→B→A cycle fenced by the epoch, default-notebook normalization (including a
stale default that is no longer granted), capability selection requirements, no
id/payload leakage into an error, refresh + task reconcile after a confirmed
write, malformed-claim/metadata rejection, **durable record round-trip** (stored
as JSON text; a rejected write fails closed; `clearLocalRecord` awaits the
delete; malformed/foreign/oversized records rejected), the capability snapshot
being installed only after grants and cleared on lock, `startSession` installing
the persisted grants before the broker session opens, and that the credential
never crosses into JS.

Added adversarial coverage: `hostEligibility()` denying on **every** authoritative
edge (uninitialized database, hydrating, App Locked, logging out, account setup
pending, no account); the reviewer's exact **lock-during-a-durable-write** race
(possession of a post-lock epoch + a racing unlock callback → no unlock, no grant,
adapter stays locked); a **direct execute** denied while locked; a native event
with **no adopted session** ignored; a **queued event from a previous session**
(Stop → Start) dropped; a request whose context does not match the live session
ignored; the **two-phase start** activating the exact adopted flow/session, a
failed activation revoking the context with no success, and a non-canonical
native session id refused before adoption; the reply carrying the expected native
lease generation + session id; and `disconnect` reporting `false` when the durable
clear fails.

The pairing-import and execution fences added here are covered explicitly:
**an absent or foreign record never starts a session and makes zero native
calls** (`getStatus`/`startSession`/`activateSession` all uncalled, the foreign
record left untouched) while a valid account record still starts; the picker
**fences the live JS session synchronously** (no adopted identity, no snapshot,
locked adapter, native stop, and a claim emitted while picking executes
nothing); **an old queued claim after a re-pair executes zero Core operations**;
**a lock or disconnect while the picker is open never adopts the picked
pairing** (reported `{ paired: false, cancelled: true, stale: true }`, the
record stays cleared); **concurrent picks adopt only the newest completion**; a
native `stale` completion is never reported as a pairing; **a cancelled or
invalid import preserves the credential and the record**; and **a stale captured
identity writes nothing** (zero Core operations) while a current capture still
executes.

The **Core-side persistence proof** (Vitest, `vitest.connect.config.ts`)
additionally writes the production row into a real password-encrypted SQLite
database with the real Core `settings` collection, closes it, reopens the same
file and parses the row with the production codec
(`packages/core/__tests__/connect/grants-persistence.test.ts`).

**Runtime transport harness (authored; the coordinator runs it).** The real
production `URLSession` transport is driven against a live throwaway HTTPS
fixture at
`apps/mobile/ios/Notesnook/VeyraNConnect/Tests/runtime/` (`fixture.mjs` +
`RuntimeMain.swift` + `README.md`). It compiles cleanly with `swiftc` and the
fixture is `node --check`-clean, but it was **not executed** in the authoring
environment (it cannot generate certificate private keys). It covers: a valid
health/session/claim/reply exchange over real TLS; **zero HTTP bytes** for a
wrong CA and a wrong pin; an oversized chunked response aborted before the 5 MiB
bound; a non-`identity` `Content-Encoding` refused; and a redirect refused.

**Not claimed:** the runtime transport scenarios (see above), and any full
RN/Mac UI run. Those remain coordinator QA.

### Local pairing (minimal steps)

1. On the broker machine: run the VeyraN Connect broker setup, producing
   `connection.export.json` (mode `0600`).
2. On the Mac: Settings → **VeyraN Connect** → **Import pairing file**, pick the
   exported document. The status line shows the paired broker id/port.
3. Choose the notebooks / task lists you want to expose, and a default notebook
   for new notes.
4. Tap **Start**. A Session is established; the broker can now claim requests.
4. **Disconnect** removes only the local record and the local Keychain item.

## 9. Out of scope

- No Core or server changes: the adapter, protocol schemas and broker are used
  as published.
- No Mac app launch in an unisolated personal profile.
- No bundle id, App Group, Keychain assignment, provisioning profile or ATS
  change: `NSAllowsLocalNetworking` is already true and no exception is added.
- No global backup-format, DataMapper or schema change. The `localOnly` flag is
  used exactly as Core defines it; the backup wording in §5 is deliberately
  honest rather than absolute.
- No AI/model provider is added or changed. This client talks only to the
  operator's own loopback broker; it introduces no OpenAI (or other) provider,
  no API key and no per-request cost of its own.
