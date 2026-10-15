# VeyraN SIWC — Mac Catalyst authentication + Responses streaming provider

This document describes the **SIWC** ("sign in with ChatGPT") slice: the native
Mac Catalyst provider under
`apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/`, its React Native host under
`apps/mobile/app/services/veyran-siwc/`, and the narrow lifecycle seam in
`apps/mobile/app/hooks/use-app-events.tsx`.

It is a sibling of the VeyraN Connect broker client (`CLIENT.md`): it does **not**
reuse the broker transport. The SIWC provider talks only to the fixed official
`auth.openai.com` / `api.openai.com` endpoints.

> **Authoring / verification status.**
>
> - **Verified in the authoring environment:** the pure Swift production files
>   (`VeyraNSIWCTypes/JWT/Callback/Identity/Responses/Provider/Keychain/Transport`
>   plus the native lifecycle coordinator `VeyraNSIWCLifecycle`) compile with
>   `swiftc` for `arm64-apple-ios18.0-macabi`, and the standalone harness
>   `SIWC/Tests/VeyraNSIWCHarness.swift` **runs to 694 passing checks** (see §8
>   for the exact command). The harness drives the *production* request/response
>   transport through a synthetic `URLProtocol`, the *production* Keychain
>   mapping through an injected Security API, the *production* callback server
>   over a synthetic loopback socket, and the *production* lifecycle coordinator
>   through an injected listener/main queue — so the bounded transport, the typed
>   store reads, the loopback listener admission and the deferred method-entry
>   ownership are exercised without a live network call, a real Keychain, an
>   entitlement or a simulator. It generates throwaway RSA-2048 key pairs at run
>   time; no private key is committed.
> - **Authored, not executed here:** the React Native host, its Jest suite, the
>   React Native module (`VeyraNSIWCModule.swift`, which imports React/UIKit) and
>   the Xcode project changes — there is no `node_modules` in this checkout, no
>   `npm install`/`npx` is run and no app build is performed. The coordinator
>   runs those (the native Mac Catalyst compile with bundling skipped and the
>   Jest suite are owned by the coordinator). **No live network call is made and
>   no real inference is run.**
> - **Not yet proven:** a *real* callback against a real system browser, a full
>   Mac app build/run and any first **real** inference. The first real inference
>   is a **human-only** step.
> - A full Mac app run needs an isolated app container/profile and is out of
>   scope here.

## 1. Roles

```
system browser ──authorize──▶ auth.openai.com ──redirect──▶ 127.0.0.1:<ephemeral>/auth/callback
                                     ▲                                   │
                                     └────────── token (code+PKCE) ◀─────┘
                                                                          │
                                     api.openai.com/v1/models  ◀──────────┤
                                     api.openai.com/v1/responses (SSE) ◀──┘
```

- The **native module** (`VeyraNSIWCModule`) owns the credential (never exposed
  to JS), the loopback callback listener, the system-browser hand-off and the
  dedicated SSE stream.
- The **JS host** (`apps/mobile/app/services/veyran-siwc/index.ts`) owns the
  lifecycle: it reads the authoritative eligibility stores, fences the host at
  every account seam and integrates the bounded native events.
- **Mac Catalyst is the only supported platform.** Every native method answers
  `supported:false`/`unsupported` elsewhere *before* any Keychain, listener or
  browser work; the JS platform copy is truthful (§6).

## 2. Fixed contract

| Purpose | Fixed value |
| --- | --- |
| authorize | `https://auth.openai.com/api/accounts/authorize` |
| token | `https://auth.openai.com/api/accounts/oauth/token` |
| JWKS | `https://auth.openai.com/.well-known/jwks.json` |
| OIDC discovery | `https://auth.openai.com/.well-known/openid-configuration` |
| models | `https://api.openai.com/v1/models` |
| responses | `https://api.openai.com/v1/responses` |
| issuer | `https://auth.openai.com` |
| resource | `https://api.openai.com/v1` |
| scope | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| redirect | `http://127.0.0.1:<ephemeral>/auth/callback` |

No host, scheme, path, query or header is ever taken from JS, a model string, a
token or a URL authority. `id_token_hint` is deliberately never sent; the
retained `id_token` never leaves the Keychain for a browser URL.

### Authorization request

Exact query: `response_type=code`, `client_id`, `redirect_uri`, `scope`,
`resource`, `state` (fresh CSPRNG), `nonce` (fresh CSPRNG), `code_challenge` +
`code_challenge_method=S256`, plus optional official `login_hint` (a saved
email). **No invented DCR/secret/prompt.** The first registration uses
`client_id=dynamic_agent_client` with `agent_name_hint=VeyraN`; the own **stable
host id** (`ext_agent_host_id`, always the canonical `urn:uuid:<uuid-v4>`) is
sent on **every** attempt — fresh, returning and consent — because the official
contract requires it for each one, and in exactly that canonical form. The own
issued `client_id` stays registration/account-bound: a returning/consent flow
always presents its own registered id and never a placeholder exchange or a
fresh foreign identity.

Fresh state/nonce/PKCE-verifier live **600 s** and are bound to the exact current
Notes account + provider epoch.

### Callback listener

A real `NWListener` bound to IPv4 `127.0.0.1` only, on an ephemeral port, and
`ready` **before** `UIApplication.shared.open` runs on the main queue. Bounds:
16 KiB headers / 32 KiB request / max 4 concurrent connections / 3 s read /
600 s flow TTL. A non-GET request, a wrong path, a `Host` that is not exactly
`127.0.0.1:<port>`, a folded/duplicate/pipelined header, a duplicate query
parameter, a malformed percent-escape and an over-limit request are all refused.
A well-formed request split across TCP reads is still accepted. The response is a
**static** HTML document that never echoes the `state`, `code` or any provider
error, and it claims **no** authentication success: it is answered before the
async code exchange and JWT verification, and a syntactically valid but
wrong-state callback receives the same body, so it says only that the request was
received and VeyraN is checking it. An invalid request never reaches the flow
owner.

A syntactically valid request is delivered to the flow coordinator together with
the *exact* flow generation it was captured for, and the coordinator resolves one
of three outcomes:

- **rejected** (a wrong/empty `state`, a missing code, a client-id mismatch, a
  replay, a second concurrent callback): *nothing* is consumed. No event is
  emitted and the listener plus the genuine pending flow stay alive, so a
  hostile or malformed request can never cancel the user's sign-in. A bounded
  number of them is simply ignored until the flow TTL or an explicit cancel.
- **claimed → authenticated**: this exact callback atomically consumed the
  pending flow (state + epoch are re-verified together with the claim), so a
  replay or a concurrent double exchange can never claim it again.
- **claimed → failed**: the flow really produced an error (a state-correlated
  `error=` callback, or a post-claim exchange/identity failure); the flow is over.

Only a claimed outcome *that still owns the current flow generation* reports to
JS and tears the listener down; a late completion for a superseded generation can
therefore never cancel a newer listener/auth. Cancel stops every connection, the
listener and every deadline.

### Token / refresh

`POST` form-encoded (`authorization_code`, own client id, code, verifier, exact
redirect, resource) — **no client secret**. Refresh uses `refresh_token`, own
client id, latest token, resource, and **omits `scope`**.

The token 200 is parsed with an exact allowed-key set: `access_token`,
`refresh_token`, `id_token`, `scope`, `token_type`, `expires_in` and the
officially documented `earliest_refresh_at`. The last one is type/units-
undocumented, so it is **accepted in any shape and never guessed, scheduled or
used to reject** an otherwise valid response. Every other documented field is
validated strictly: `token_type` must be the string `Bearer` (a malformed or
non-Bearer value is rejected, never ignored), `expires_in` must be a strict
integer, and a malformed `refresh_token`/`id_token`/`access_token` fails the
whole response.

The granted scope set is **only** what the issuer actually returned. A missing
`scope` is **not** widened to the requested set: the verified identity is still
retained, and the direct-scope gate then truthfully reports `MISSING_PLAN_SCOPE`
before any model or inference work. Scopes are never invented.

### ID token validation

RS256 only, against the fixed JWKS, issuer `https://auth.openai.com`. Canonical
base64url segments, bounded duplicate-key denial, no `jku`/`x5u`/`crit`/`b64`,
unique compatible `kid`, RSA-2048+, `use:sig`, `alg:RS256` and `key_ops:verify`
when present — a *present* JWK metadata field must have the exact expected type
and value (a boolean `use`, a numeric `alg`, a string `key_ops` fails the key
closed) and is never treated as absent. `aud` must be the own issued client
(string **or** array); the standard `azp` is validated when present/required, and
a present `azp` of any other type is rejected. `exp`/`nbf`/`iat` must be numeric
seconds: a *present* boolean, string or fractional value is malformed and is
rejected rather than treated as absent. A present non-string `nonce` is likewise
rejected. Verification uses `rsaSignatureMessagePKCS1v15SHA256` over the
**original ASCII** `header.payload` (hashed exactly once — never PSS, never
re-serialized). A standard refresh that legitimately omits a nonce is not
rejected; any supplied nonce must equal the retained original.

## 3. Registration and account model

- One **stable host id** per device, sent on the wire as the canonical
  `urn:uuid:<uuid-v4>` (`ext_agent_host_id`). This is the exact form the official
  token-sharing contract accepts — an opaque, stable, distinct-per-host
  `urn:uuid:` value
  ([`https://developers.openai.com/siwc/token-sharing-open-source`](https://developers.openai.com/siwc/token-sharing-open-source)).
  The same id is sent for a fresh, returning and consent attempt
  ([`.../sign-in`](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)).
- One or more own **issued registrations** (`client_id` + verified ChatGPT
  `sub`) that **survive logout**.
- One **active credential**, whose *owner* is the **persisted Notes account**
  (never the ChatGPT subject).
- The first-time callback's new issued `client_id` is retained **atomically
  before** the token exchange, as an *incomplete* registration; the placeholder
  `dynamic_agent_client` is never persisted. A verified registration is never
  overwritten by an unverified pending one.
- A **returning sign-in and a consent recovery** must both authenticate the
  **same** `sub` as the selected registration before anything is persisted, so a
  foreign ChatGPT account can never overwrite a verified registration under its
  issued `client_id`.
- The store itself enforces the same rule structurally: a pending (subject-less)
  registration can never replace a verified one, and a **different** verified
  subject under an already verified `client_id` is refused. An explicit,
  human-initiated fresh-account flow binds a **new** own registration (a new
  issued client id) and replaces only the active credential; it never silently
  rebinds an existing verified registration.

## 4. Storage

One device-only Keychain record: service
`com.ozel0t.note.notesnookpencil.veyran.siwc`, using the **existing** entitled
default group (no explicit group), `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`,
`synchronizable:false`, `kSecUseDataProtectionKeychain:true`. The
data-protection option is a *query/scope* option: it belongs to the query and to
the `SecItemAdd` dictionary and is **never** placed in the `SecItemUpdate`
attribute dictionary (which accepts real item attributes only). Writes are atomic
(`SecItemUpdate` → `SecItemAdd` only on `errSecItemNotFound`); a failed persist
keeps the previous item and the previous in-memory credential untouched. Tokens
never reach the renderer, MMKV, a browser store, a log, a URL or telemetry.

**Reads are typed.** `load` answers exactly one of four outcomes:

| Outcome | Meaning |
| --- | --- |
| `missing` | Exactly `errSecItemNotFound` — the **only** state that may be initialized |
| `loaded(document)` | A record exists and parses |
| `invalid` | A record exists but its bytes are not a valid document (corrupt/truncated) |
| `unavailable` | The store could not be read at all (locked, entitlement, any other `OSStatus`) |

Neither `invalid` nor `unavailable` is ever treated as "no document" and neither
is ever overwritten: a corrupt record fails closed (`keychainFailure`), and an
unavailable store is *retried* on the next read (the failure is never cached as
"missing"), so the original host/registrations are reloaded when the Keychain
becomes readable again. Initialization uses **create-if-absent**
(`SecItemAdd` first); an `errSecDuplicateItem` makes the adapter re-read and
validate the existing record instead of replacing it, so a concurrent
initialization can never be clobbered. A record that exists but cannot be read
during that re-read fails closed. The exact Security calls go through the
injected `VeyraNSIWCSecAPI`, so the production dictionaries and outcome mapping
are tested without a real Keychain.

**Legacy read normalization (write-free).** A record written before the wire
format was corrected stores its host as `urn:veyran:<uuid-v4>`. Persisted parse
canonicalizes *only* that strictly valid, own-prefixed value in memory to
`urn:uuid:` with the **same** UUID suffix (no UUID is minted; a host id is not an
auth credential). The document stays fully loadable — host, registrations and
credential are all preserved — and **no write is performed on a read**: the
Keychain bytes are left untouched and the record is not re-saved during
`load`/`credentialStatus`/`ensureHost`/a flow start. The canonical form is
written only later, by the next already-authorized commit, with no schema bump
(`v` stays `1`). The wire validator itself is never widened: a legacy, foreign,
v1, uppercase or malformed host is still refused for `ext_agent_host_id`.

The credential status read is typed too: `stale` (the entry no longer owns the
store — zero reads), `signedOut`, `keychainFailure`, `ready` and
`missingPermission`. A store error therefore surfaces as the static
`keychain_failure` (module: `status:"failed"`, `error:"keychain_failure"`) and is
**never** reported as `signedout`, and no credential field is included in that
answer.

Every credential **commit or clear** is linearized: the epoch/identity guard, the
store write and the in-memory adoption happen inside one lock critical section
(never with an `await` held), so a concurrent fence either lands before it (the
guard fails and *nothing* is written) or after it (it owns the final state). A
refresh flight is additionally bound to the exact credential it started from and
to its own generation: a fenced or superseded flight can never clear or overwrite
a newer credential/registration, and a failed persist surfaces truthfully while
keeping the previous item and credential.

## 5. Lifecycle

The JS host reads the authoritative stores (`db.isInitialized`,
`SettingStore.isAppLoading`, `UserStore.appLocked` / `isLoggingOut` /
`accountSetupRequired`) plus the actual persisted account id. Lock, logout,
account switch, migration and unmount call the native `fence()` **synchronously
as the first line, before any await**; the epoch bump invalidates any pending
auth flow, refresh, model read or stream, so an A → B → A result can never be
adopted.

### Native method entry (`VeyraNSIWCLifecycle`)

The RCT module is only a transport: every security-relevant decision lives in the
Foundation-only lifecycle coordinator (`SIWC/VeyraNSIWCLifecycle.swift`). Each
native method entry captures an **immutable entry** — the provider epoch, the
Notes owner and (for a listener-bound flow or a stream) the monotonic flow/stream
generation — *synchronously, before anything is deferred*: before a `Task` is
created, before the listener can report `ready`, before a main-queue hop. Every
deferred step then presents that exact capture:

- the provider re-checks the entry epoch/identity **before every credential read,
  request and store commit** (`VeyraNSIWCProviderEntry`), and never restamps it
  from `currentEpoch()`: a deferred refresh, models read, stream or logout whose
  account moved on performs **zero** credential reads, zero writes and zero
  requests — a deferred logout can therefore never clear a newer credential;
- the auth source (generation + provider entry + listener) is reserved **before**
  the listener starts, and the listener callbacks carry only that immutable
  snapshot: a late `ready`, a late callback, an old catch path or a deferred
  browser hop can neither open a browser, touch a credential, issue a request nor
  tear down (or cancel) a newer flow. The browser-open claim is atomic with the
  source check, and the exact-source + provider-epoch re-check and the synchronous
  system-opener invocation share **one** critical section (a fence/new flow can no
  longer interleave between the check and the API call; an open already issued
  before a fence may still be completed by the OS, which the fence cannot unsend);
- each stream invocation owns a monotonic stream generation: a newer stream
  supersedes an older one (which is marked canceled and can neither emit, report a
  success nor clear the newer stream), and a superseded stream that is admitted
  late is refused by the provider instead of superseding the newer one. Its own
  promise is still answered truthfully as `canceled`;
- the listener, the browser hand-off and every stream task are mutated under
  **one** lock (lock order: coordinator → provider, no `await` under the lock) and
  no injected closure (promise completion, browser opener, event handler, main
  queue hop) is ever invoked while that lock is held, so the emitter can never
  deadlock against the lifecycle.

The two generations are independent counters and the request id is **owned by
JS**: `streamInvoke` receives a bounded JS-generated `requestId`, and the native
side echoes exactly that value in its `start` handshake together with its own
provider generation. JS adopts the provider generation *only* from that
handshake (never from an arbitrary first emission), and only for a stream whose
owner token is still current. Before the handshake arrives, **nothing** is
emitted; every later emission is adopted only when both its `requestId` and its
provider generation match, and only while the exact host identity is unchanged.

Each stream invocation also owns a per-invocation token and a canceled flag: only
the invocation that still owns the active stream may clear it, a canceled or
superseded invocation always reports `canceled` (a late `{completed:true}` is
never adopted and never runs an automatic action), and an old invocation's
`finally` can never clear a newer invocation's stream.

Auth events are fenced the same way: the native event carries the exact
authorized-flow generation, provider epoch and owner account; the native side
re-checks at dispatch time that the flow still owns the current generation, and
re-checks after the callback that the flow generation and the provider epoch are
both still the ones it was opened under. A claimed callback ends its flow *before*
its queued event is dispatched, so the coordinator mints one immutable,
revocable **terminal ticket** (source generation + owner + provider epoch) for
exactly that ended source. Delivery is once and linearized: the module presents a
non-consuming `allowsAuthDelivery` gate before queueing (an event that owns
neither the current flow nor the ticket is never queued), and at the actual
main-queue dispatch it calls the consuming `withAuthorizedAuthDelivery` primitive,
which — under the coordinator lock — re-checks the exact identity, **consumes the
terminal ticket exactly once** and invokes the synchronous `sendEvent` in the same
critical section. So a duplicate queued terminal event is delivered once, and a
fence/new flow either wins before the check (the event is dropped) or blocks until
the delivery returns (it cannot interleave between the check and the invocation);
a still-current nonterminal event stays retryable. The ticket is revoked by every
source change (a new auth flow, cancel, fence, logout or account change), so a
superseded terminal delivery is dropped. JS surfaces the event only when its own
active flow
(generation + epoch + owner), the host identity (ABA) and the authoritative host
eligibility all still match, correlating it against the *original* returned
`beginAuth` source. A wrong, stale or foreign auth event changes zero UI state and
performs zero credential work.

Logout reports three separate facts: the immediate local clear, whether the one
best-effort revocation was **actually confirmed** (a 200 with an empty body), and
whether there was no active connection at all. Neither a missing record nor an
unreadable store is ever reported as a confirmed remote revocation; the request
uses the old refresh token (or, when a credential has none, its access token) and
the own issued client id, and the old credential never leaves bounded memory.

## 6. Models, invocation and statuses

- `GET /v1/models` returns a **projection** of the official devkit model records:
  the root is an object carrying a `models` array; a *displayed* row carries
  `slug` and `display_name`, and every row whose `visibility` is not exactly
  `"list"` is skipped. The parser follows the official projection exactly:
  - bounded extra metadata (root and row) is **ignored** and carries no
    authorization meaning; only `slug`/`display_name` are ever projected, and the
    metadata budget is bounded (≤ 32 root keys, ≤ 32 keys per displayed row, plus
    the total byte bound);
  - a row that is not exactly `visibility:"list"` is skipped **before** any
    slug/display-name validation, exactly as the official devkit projects it: a
    missing or non-string `visibility`, `null`, `{}` and a non-object row are all
    skipped, so an undeclared/hidden or malformed row with incomplete display
    fields never fails the document;
  - a *displayed* (`visibility:"list"`) row must carry a valid own slug and a
    display name that is non-empty **after trimming** and within bounds — an
    invalid displayed row, a missing/non-array `models`, a `data[]` array, a
    duplicate key, more than 512 rows or an oversize body denies the whole
    document;
  - rows are kept in the *server's* order and the catalog is never hardcoded.
- A missing direct scope is reported as `MISSING_PLAN_SCOPE` **before** models or
  invocation.
- Statuses: `signedout`, `authenticating`, `missingpermission`, `ready`,
  `refreshing`, `limited`, `failed`, `canceled`. There is no false "connected"
  state.

### Fixed Responses body

`POST /v1/responses` with **only** `model` (validated against the live catalog),
`input` (an **array**), `store:false`, `stream:true`, optional `instructions` and
the fixed `veyran` tool namespace when at least one function is offered. A
**tool-less text stream is allowed** (the body simply omits `tools`); a non-empty
function list must build into the strict namespace or the request is refused. The
unsupported parameters (background,
conversation, max_output_tokens, max_tool_calls, metadata, moderation,
multi_agent, prompt, prompt_cache_retention, safety_identifier, temperature,
top_logprobs, top_p, truncation, user, `previous_response_id`) are not
constructible. A `system` role is rejected; `developer` messages and a top-level
`instructions` are allowed.

### Stream bounds and outcome

A dedicated `URLSession` data-delegate stream (never the JS/RCTNetworking/
EventSource path) with total 1 MiB / line 64 KiB / output 1 MiB / 4096 events /
120 s wallclock / single active stream. The 120 s wallclock is enforced both
per-chunk *and* by the session's `timeoutIntervalForResource`, so it holds even
when the server stalls between chunks. Partial deltas are emitted to JS; the
partial draft is preserved on failure. **Only `response.completed` is a success
terminal**; `response.output_text.delta`, a `[DONE]` sentinel, a 200 EOF,
`response.failed`, `response.incomplete`, `response.canceled` and an `error`
event never authorize a tool call, a write or a success. A local abort is not a
guarantee that the provider stopped server-side compute/billing.

The failure code is read from the *official nested* shape
(`response.error.code`), with the flat `error.code`/`code`/`response.code`
fallbacks, and only a bounded, catalogued code is ever surfaced — an uncatalogued
or malformed code fails closed as `stream_invalid` and never retries implicitly.
Partial deltas already emitted are preserved for the caller.

### Function namespace

The namespace entry is `{ type:"namespace", name:"veyran", tools:[
{ type:"function", name, description, strict:true, parameters:{
type:"object", properties, required(all), additionalProperties:false } } ] }`.
A terminal `function_call` requires `type`, `call_id`, `namespace:"veyran"`,
`name` (a function this provider offered) and an `arguments` JSON **string**;
`id`/`status` are optional (a present `status` must be `completed`), an optional
`async` boolean and `caller:{type:"direct"}` are accepted, and a `program`
caller, an unknown namespace, a duplicate `call_id`, an unknown name, extra
fields or malformed arguments are denied. A **missing namespace is denied by our
policy**, not asserted to be impossible on the wire.

### Continuation

The full input is resent: the original user/developer messages + the actual
returned reasoning/function_call items + one
`function_call_output { call_id, output: <JSON string> }`. There is never an
HTTP `previous_response_id`. `store:false` is not a local-history promise.

### Provider limits

`subscription_sharing_user_not_eligible` (403) → no looping OAuth;
`usage_limit_exceeded` / `subscription_sharing_usage_limit_exceeded` (429) →
"Manage usage" (`https://chatgpt.com/settings/usage`), no guessed reset;
`usage_unavailable` / `subscription_sharing_usage_unavailable` (503) → temporary,
credentials preserved, bounded retry later; `invalid_user` /
`subscription_sharing_invalid_user` (401) → terminal re-login. The same catalogue
maps the nested `response.failed` stream packets and the transport status, and no
failure ever triggers an implicit inference retry.

## 7. Recovery, cost and mobile

- A prior-declined `MISSING_PLAN_SCOPE` exposes an explicit, human-initiated
  **"ChatGPT-Nutzung freigeben"** action (`prompt=consent`). Ordinary and
  returning sign-in are **never** forced to consent, and `force_reconsent` is
  **never** sent (it is not confirmed as deployed for this integration).
- The visible, informative notice is:

  > Nutzung kann ChatGPT-Kontingent oder vorhandene Credits verbrauchen. Reine
  > Abo-Nutzung ist nicht garantiert.

  It is **informative, not a confirmation gate**. The neutral, factual
  verified-account label **"Verbundenes ChatGPT-Konto"** and the official
  "Manage usage" link are surfaced near the model selector. It makes **no**
  plan-only or no-cost guarantee. There is **no** model API-key fallback, no
  provider fallback and no cost override.
- **no-op**: on iOS/iPadOS the native methods are unsupported *before* any
  Keychain/listener/browser work, and the copy states: *"In dieser
  VeyraN-Version nicht verfügbar; kein bestätigter mobiler SIWC-Callbackweg."*
  It does not claim that OpenAI universally forbids mobile SIWC.

## 8. Tests

### Swift provider harness (verified here)

```sh
swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -target arm64-apple-ios18.0-macabi -swift-version 5 -parse-as-library \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectWire.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCTypes.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCJWT.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCCallback.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCIdentity.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCResponses.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCProvider.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCKeychain.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCTransport.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCLifecycle.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/Tests/VeyraNSIWCHarness.swift \
  -o "$TMPDIR/veyran-siwc-harness" && "$TMPDIR/veyran-siwc-harness"
```

It prints `PASS: 694 checks (694 total, 0 failed)`. Coverage: the RFC 7636 PKCE
vector; canonical host generation/validation (`urn:uuid:<uuid-v4>`; the legacy
`urn:veyran:` prefix, a v1/uppercase/unhyphenated/trailing-junk/foreign value and
an over-bound host are all refused on the wire) plus the pure, write-free
persisted-host normalization (canonical passthrough; a strictly valid own legacy
`urn:veyran:<v4>` maps to the *same* UUID under `urn:uuid:`; malformed/foreign
values refused, never widened) and the authorize builder refusing a direct legacy
host id; the exact authorize URL (including the canonical `ext_agent_host_id`,
the absence of `id_token_hint`/`force_reconsent` and that no legacy host id is
ever sent); the callback parser (valid,
non-GET, wrong path, wrong `Host`, duplicate header, folded header, duplicate
query, malformed percent, pipelined, well-formed-fragmented); the identity
document round-trip, the no-overwrite rule, the "a different verified subject
never replaces a verified registration" rule and the **legacy read regression**
(a raw `urn:veyran:` document loads with the same UUID canonicalized in memory,
every registration/credential preserved, the raw bytes untouched, a later commit
serializing canonical `v:1` with no token loss, and a malformed/foreign/v1/
uppercase persisted host still refused) plus the production Keychain
attribute dictionaries (the `SecItemUpdate` attributes never carry the
data-protection option, the query/add dictionaries keep it with
`synchronizable:false` and no explicit access group) **without touching the real
Keychain**; the models catalog; JWT accept/tamper/wrong-issuer/aud/azp/nonce/
expiry/alg/jku/kid/`use`/duplicate-kid plus the new malformed-optional-claim and
malformed-JWK-metadata rejections; the token-200 contract (documented
`earliest_refresh_at` accepted in any shape and never used, `token_type` must be
`Bearer`, malformed official fields and duplicate keys rejected, a missing
`scope` never widened — the identity is retained and the gate reports
`MISSING_PLAN_SCOPE`); store-failure preserving the previous document; a full
fresh auth flow including direct scopes and the logout outcome (credential
cleared, host + registration retained, exactly one revocation request carrying
the old token + own client, 200-empty confirmed, non-empty/503 unknown, no record
never confirmed and reported as no active connection); a **consent flow
authenticated as a foreign subject** that is refused without overwriting the
verified registration; the **production lifecycle coordinator** driven with a
synthetic listener and a manually drained main queue (**wrong/empty/missing-code
requests claim nothing and keep the flow alive, a genuine callback then succeeds
exactly once, two concurrent callbacks produce exactly one exchange, a replay
claims nothing, a superseded flow's deferred `ready` opens no browser and starts
no flow, a late callback of a superseded flow performs no exchange and never
cancels the newer listener, an explicit cancel/fence invalidates exactly the
current flow, and a superseded pending flow's promise is still answered as
`canceled`**); the fixed Responses body/headers and strict namespace builder;
the **`start` generation handshake** that precedes the first delta and echoes the
JS-owned request id; the SSE decoder; the nested `response.failed` code mapping
and the partial-draft preservation with exactly one stream request; the provider
status→error mapping; single-flight/fenced/ambiguous refresh; and **real
concurrent barrier tests** for the linearized credential commits (a commit that
wins the lock before a fence is stored but logically ineligible, a fenced flight
performs zero writes, a delayed old failure cannot erase a newer credential, a
failed persist keeps the previous one, and a fenced flight is never re-used).

Additional sections cover the three seams that were previously unproven:

- **official catalog compatibility** — root/row metadata tolerated (bounded),
  every non-`list` row (missing/`null`/non-string visibility, `{}`, non-object)
  skipped before validation, invalid displayed rows (including a whitespace-only
  display name), missing/non-array `models`, `data[]`, duplicate keys, > 512 rows,
  unbounded metadata and an oversize body all denied, server order kept;
- **typed Keychain store** — the production mapping via an injected Security API
  (`errSecItemNotFound` → `missing`, any other status → `unavailable`, corrupt
  bytes → `invalid`, a valid record → `loaded`, the exact query/add
  dictionaries, create-if-absent adoption of a concurrent record, duplicate
  unreadable → `duplicateUnreadable`) plus the provider behaviour on a corrupt
  record (hard `keychainFailure`, zero writes, zero requests), an unavailable
  store retried into the *original* host/credential (zero writes), the
  create-if-absent host initialization and its stability, and the **legacy
  record path** (a raw `urn:veyran:` record loads canonicalized in memory with
  **zero writes**, a concurrent create adopts a legacy record canonicalized
  without overwriting it, and `ensureHost` plus a returning flow on a
  legacy-backed store use the canonical host, mint no host and save nothing);
- **bounded transport** — the production `URLSession` delegate against a
  synthetic `URLProtocol`: a non-official origin refused before any byte, a slow
  trickle aborted at the *absolute* deadline, an oversize declared length and an
  oversize chunk refused before being retained, a truncated body refused, a
  redirect never followed, a transport error and a cancelled task both reported
  as one bounded failure (the continuation is resumed exactly once). A
  **decoded compressed** body (`Content-Encoding`) with a larger declared wire
  `Content-Length` succeeds (the body the delegate sees is already decoded), while
  an identical *identity* body shorter than its declared length is still refused,
  the decoded byte bound is always enforced, and a compressed transport error is
  still a failure;
- **method-entry / deferred ownership** — a stale entry (after a fence) performs
  zero credential reads, zero writes and zero requests for refresh, models,
  status, logout, clear, callback and `beginAuth`; a deferred logout can never
  clear a newer login; an old flow's callback never claims a newer flow; a
  browser hop that runs after a fence opens nothing; and a superseded deferred
  stream is refused admission (answering `canceled`) while the newer stream keeps
  its transport and emissions;
- **terminal auth delivery** — the *production* delivery path is presented
  through a faithful reproduction of the module's two-stage path (the
  non-consuming pre-queue gate, then the consuming `withAuthorizedAuthDelivery`
  primitive at dispatch): a verified success and a claimed provider failure both
  reach JS **exactly once** (as `authenticated`/`authError`) after their flow has
  already ended, a wrong-state callback delivers nothing and keeps the listener
  alive, and a terminal delivery that is superseded by a new auth flow or a fence
  **before the main-queue dispatch** is dropped (the immutable terminal ticket is
  revoked at every source change);
- **terminal delivery linearization** — the single production primitive is driven
  directly: a duplicate queued terminal event is delivered **exactly once** (the
  ticket is consumed inside the critical section), a fence that wins before the
  check refuses the event without ever invoking the body, a fence that loses
  **blocks** until the in-flight delivery returns (a real `DispatchSemaphore`
  barrier — check+consume+deliver share one critical section), and a still-current
  nonterminal event stays retryable (nothing is consumed, the started flow is
  preserved);
- **browser linearization** — a real barrier proves the exact-source +
  provider-epoch check and the system-opener invocation share one critical
  section: a concurrently-started fence **blocks** until the in-flight open
  returns (open-wins), and a fence that wins before the hop opens nothing
  (fence-wins). An open accepted just before a fence may still be completed by
  the OS afterwards — the fence only prevents a *later* invocation;
- **callback server lifecycle** — the *actual* `VeyraNSIWCCallbackServer` is
  driven over a synthetic loopback socket: a cancel-before-start can never be
  revived (a restart is refused and no `ready` is ever reported), a concurrent
  start∥cancel never leaves a live owned listener, a cancel stops a live
  listener, and the production coordinator tears down an **already-ready**
  superseded listener (the predecessor listener is canceled unconditionally,
  while only the promise answer stays conditional).

### JS Jest suite (authored, not run here)

`apps/mobile/app/services/veyran-siwc/veyran-siwc.test.ts` (pure helpers + the
provider surface with a native jest double and authoritative-store mocks). It
includes discriminating seam tests: the `start` handshake echoing the JS-owned
request id (a pre-handshake delta, a foreign request id and a stale generation
are all dropped; the exact generation is adopted), a canceled invocation that
still reports `canceled` after a late success while a newer stream keeps its
fence, auth events correlated to the exact flow generation/owner/identity/
eligibility, a **fail-closed invoke grant** (`siwcCanInvoke` requires
`signedIn:true` **and** `status:"ready"` **and** an explicit
`hasDirectScopes:true`; a missing or malformed grant, a non-ready status and a
signed-out summary all deny), and the logout outcome never reporting an unknown
revocation as confirmed. Run by the coordinator with the repo's Jest
configuration; **not executed in this environment** (no `node_modules`, no
`npm install` allowed). The files were syntax-checked by type-stripping them with
Node (`module.stripTypeScriptTypes`) and parsing the result, which is not a
substitute for `tsc`/Jest. The native Mac Catalyst compile with bundling skipped
is likewise owned by the coordinator and not run here.

## 9. Local personal sign-in steps

1. On Mac Catalyst, open Settings → the SIWC provider screen.
2. **Sign in with ChatGPT** → the system browser opens
   `auth.openai.com` (no webview, no cookies, no internal endpoint).
3. Complete the official sign-in; the browser returns to the loopback callback.
4. If prompted, your account must already have the direct ChatGPT usage scopes
   (`resource.invoke`, `chatgpt.tokens.use.direct`). If they are missing, the
   provider shows `MISSING_PLAN_SCOPE` and offers the explicit
   **"ChatGPT-Nutzung freigeben"** recovery.
5. Models come from the live catalog. The credits notice above is shown; the
   **first real inference is a human-only action** and is not performed by any
   automated worker.

## 10. Out of scope

- No assistant/chat UI: that is a separate slice.
- No Core/server/schema/migration/backup-format change.
- No Bundle ID, App Group, provisioning-profile, URL-scheme, Keychain-assignment
  or ATS change. The only entitlements change is
  `com.apple.security.network.server = true` (the loopback callback listener).
- No model API-key fallback, no cost override, no mock-enable toggle, no
  provider fallback, no credit purchase, no real Keychain/auth/inference in any
  automated test, no app launch and no deployment.
