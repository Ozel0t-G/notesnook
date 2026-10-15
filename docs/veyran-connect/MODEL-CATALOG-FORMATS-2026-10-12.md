# Model catalog response formats — 2026-10-12

Scope: the native SIWC model-catalog parser (`VeyraNSIWCCatalog.parse`) for the
single existing request `GET https://api.openai.com/v1/models` (OAuth Bearer,
`VeyraNSIWC.modelsEndpoint`), plus a small exact-claim ownership guard in
`VeyraNSIWCProvider.finishCallback`. No Core/JS, Keychain, schema, ID, group,
endpoint, header, transport, OAuth-credential or inference-builder change.

## Observed state (facts, not a format claim)

A real user's UI is authenticated and carries the direct scopes; the metadata
request returns HTTP 200 and the provider then throws `model_unavailable`,
because `VeyraNSIWCCatalog.parse` returned `nil` and the raw body is deliberately
never read or surfaced. **The exact rejected response shape has not been
observed.** This document therefore does *not* claim to know which envelope the
live account currently returns; it records only the two *officially documented*
response shapes of that same endpoint and makes the parser accept both.

## Source basis (officially documented envelopes of `GET /v1/models`)

Two separate OpenAI documents describe the response of this one endpoint:

1. **SIWC token-sharing / models-and-inference devkit** — an object with a
   `models[]` array; each *displayed* row carries `slug` and `display_name` and
   an ordered `visibility` (only `visibility:"list"` rows are the shared model
   list). This is the projection the parser already accepted.

2. **Public API reference, models → list** — `{ "object": "list",
   "data": [ { "id": string, "object": "model", "created": unixtime (number),
   "owned_by": string, "shutdown_date": optional null|string } ] }`. `data` lists
   the currently available models and the `id` is the value used in API
   endpoints.

Note on scope: shape 2 is the *response schema* of the same authenticated
`/v1/models` request. Recording it here does **not** introduce, and is not
conflated with, an API-key, billing, credit or provider fallback path. There is
still exactly one request, one OAuth Bearer credential and no fallback.

## Parser behaviour (after this change)

`VeyraNSIWCCatalog.parse` discriminates the two envelopes **narrowly**:

- `models` present → the SIWC projection. A body carrying *both* `models` and
  `data` (with or without `object:"list"`) fails the whole document closed.
- `models` absent **and** root `object` exactly `"list"` **and** `data` is an
  array **and** `≤ 512` rows → the public API list projection.
- anything else → `nil` (fail closed).

### SIWC branch (unchanged semantics)

- The `visibility` filter is applied *before* validation: a row whose
  `visibility` is not the string `"list"` (missing, `null`, non-string, non-object
  row) is skipped, never failed. A *displayed* row must carry a valid slug and a
  non-empty bounded `display_name`; only `slug`/`display_name` are projected.
- Rows keep the server order; duplicate rows are not duplicate keys.

### Public API branch

- Each row must be an object within the key bound, with `object` exactly
  `"model"`, a valid returned `id`, a non-negative integer `created` and a
  non-empty bounded `owned_by`. `created` is validated with the existing strict
  integer check, which rejects CoreFoundation booleans, fractions and
  out-of-exact-range numbers.
- The **returned `id` is projected verbatim as both the slug and the display
  name**. No friendly name, no hardcoded model list and no prefix filter is
  invented, and metadata alone implies no inference capability.
- Order is preserved and ids are unique within one list envelope; any invalid
  displayed row fails the whole document closed. The optional `shutdown_date`
  (and any other extra metadata) is tolerated but ignored.

### Shared bounds (never relaxed)

The body is bounded by `maxModelsBytes` (1 MiB), the root by `maxRootKeys` (32),
the rows by `maxRows` (512), each row by `maxItemKeys` (32) and each projected
field by `maxFieldBytes` (200). Duplicate object keys anywhere fail the document
closed (existing strict-JSON key check).

`fetchModels` / `requestModels` are unchanged: the same GET, the same headers,
the same 30 s timeout, no raw-body read, no API key or billing/provider
fallback, and non-200 / parse-`nil` still surface as `modelUnavailable`.

## Prepared-callback ownership guard

`VeyraNSIWCProvider.finishCallback` consumes the sealed ticket once, then proves
under the provider lock that the ticket's exact attempt still owns
`claimedAttempt` at that epoch — before any immediate outcome or exchange, and
again after the exchange and identity awaits (the final commit already checks).
A prepared ticket that a `cancelFlow`, a new `beginAuth` or a `fence` disowned
before its task started, or while its exchange was in flight, therefore performs
zero exchange, zero JWKS work and zero writes and reports `.claimed(.accountChanged)`.
The check reads the guarded fields directly (never via `currentEpoch()`), so it
cannot re-enter the non-recursive lock.

## Tests

The existing standalone Swift harness (docs `SIWC.md` §8) was rebuilt with the
unchanged `swiftc … -target arm64-apple-ios18.0-macabi -swift-version 5
-parse-as-library` command over the 10 source files + `SIWC/Tests/VeyraNSIWCHarness.swift`
into a `$TMPDIR` binary. It runs **694 checks, 0 failed** (60 added): both
documented envelopes, bounded extra metadata, an empty valid API list, the
heterogeneous no-prefix-filter set, malformed API rows, non-integer/bool/negative
`created`, wrong/missing `object`, missing fields, duplicate ids, over-bound
fields/rows/keys/body, mixed `models`+`data` envelopes, provider reachability of
the new branch, and the prepare→cancel / prepare→new-begin / cancel-during-exchange
ownership cases. All tokens and credentials are synthetic; no real Keychain,
network, note or inference is used.
