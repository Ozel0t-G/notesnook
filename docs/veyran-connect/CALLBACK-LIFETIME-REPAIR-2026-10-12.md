# SIWC callback lifetime / terminal repair — 2026-10-12

Scope: the native VeyraN "sign in with ChatGPT" (SIWC) callback listener, the
pending-flow TTL and the terminal auth-event ownership, under
`apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/`.

## Why

The user's very first native callback attempt ended after ~180 s in a browser
`connection refused` with **no event** reaching JS: the loopback listener's flow
TTL called `cancel()` silently, so an abandoned (or failed) flow was
indistinguishable from an explicit user cancel, and there was no bounded
`flow_expired` / `transport_unavailable` terminal at all. A subsequent fresh
login worked, so the credential/registration/host/epoch machinery itself was
sound — the lifetime/terminal surface was not.

Five concrete defects were repaired:

1. The flow TTL was 180 s and only the listener (which reported nothing) used it
   for terminal purposes.
2. The listener TTL was a silent `cancel()`; a listener bind/accept failure was
   silently swallowed; the browser-open completion `Bool` was discarded.
3. `completeCallback` had no *synchronous* admission, so a valid callback racing
   the flow TTL, and a supersede/cancel at the same provider epoch, were not
   linearized.
4. `cancelFlow` only cleared the pending flow, and every commit guarded only the
   provider epoch — so a *claimed-but-in-flight* flow superseded/canceled at the
   **same** epoch could still commit.
5. (Found in independent review of the first repair) the listener disarmed its
   own TTL/failure report for **every** parse-valid callback, before the owner
   correlated `state`/`client_id`. A callback the provider *rejected* (the flow
   deliberately stays live) therefore permanently suppressed the abandoned
   flow's only remaining terminal: `current` stayed `started` forever and the JS
   flow got no `flow_expired` and no `transport_unavailable` — the exact bug
   class this repair exists to remove. The listener's report suppression now
   means "the owner canceled it" only (see below).

## What changed (native only)

### One shared, bounded 600 s flow TTL
`VeyraNSIWC.flowTTLSeconds` is now `600` and remains the **single** constant used
by both the provider's pending-flow deadline (`beginAuth`) and the listener's own
deadline (`listener.start(flowTTL:)`). There is exactly one TTL per flow.

### Listener terminal seams + single-use fence (`VeyraNSIWCCallback.swift`)
`VeyraNSIWCCallbackServer` gained `onExpiry`/`onFailure`. Over its whole lifetime
it emits **at most one report**:

- the flow TTL (`onExpiry`) — never a silent cancel, or
- a listener failure (`.failed` state → `onFailure`).

A parse-valid callback is **not** a terminal in the listener: it is handed to
the owner, which correlates `state`/`client_id` and either **accepts** it (and
`cancel()`s the listener) or **rejects** it. Only an owner `cancel()` is silent
and only it disarms the pending report; a rejected callback therefore leaves the
listener (and its deadline) live for the genuine callback or the TTL, so an
abandoned flow still ends with exactly one bounded terminal. Exactly-once holds
against a concurrent delivery too: the report-carrying teardowns (`expire`/`fail`)
run on the listener's serial queue — the same queue that delivers a callback — so
a report and a delivery can never interleave, and the only off-queue caller
(`cancel`) reports nothing. The loopback origin contract is untouched: the
listener still forces
`requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)`.

### Synchronous admission + sealed ticket (`VeyraNSIWCProvider.swift`)
`completeCallback` was split:

- `prepareCallback(query:port:ownerAccountId:entry:) -> VeyraNSIWCCallbackAdmission`
  runs **every** validation (entry epoch, port, owner, TTL, flow epoch,
  constant-time state, client-id rules) **before** the claim, then claims the
  flow atomically and returns either `.rejected(error)` (nothing consumed) or
  `.admitted(VeyraNSIWCPreparedCallback)`.
- `finishCallback(ticket)` runs the (bounded-HTTP) exchange + identity + commit.
  The ticket is **single-use** (`consume()`), so a replayed ticket performs zero
  exchanges and zero commits.
- `completeCallback` is kept as the async wrapper (`prepare` → `finish`) for
  source compatibility.

The claim is now **exact**: each begun flow carries a monotonic `attempt`, and
`claim` matches `pendingFlow.attempt` (plus state + epoch), so two attempts at the
same epoch that share a state under a deterministic random source can never claim
each other.

### Exact-claim ownership guard through commit
`claimedAttempt` records the one attempt that owns the store's claim. It is
cleared by `beginAuth` (new attempt), `cancelFlow`, `fence` and logout teardown,
and `commitAuthorization` / `commitPendingRegistration` now require
`claimedAttempt == attempt` **in addition to** `epoch == epoch`. A pending *or*
claimed flow that is canceled/superseded at the same epoch therefore refuses its
late commit (returns `.stale` → `accountChanged`); it is never a global credential
delete.

### Coordinator: atomic claim-vs-expiry, exact-source terminal (`VeyraNSIWCLifecycle.swift`)
- `listenerValid` executes the synchronous `prepareCallback` admission **under the
  coordinator lock** (coordinator → provider order), marks the genuine claim
  (`reserved.claimed`), tears the listener down (disarming its TTL) and only then
  runs the async exchange outside every lock. A winning claim and a losing expiry
  are serialized by one lock, so a claimed callback always beats expiry with no
  `flow_expired` + credential-commit contradiction.
- `onExpiry`/`onFailure` are new source-bound seams. A started flow ends with
  exactly one `authError` (`flow_expired` / `transport_unavailable`); a
  failure/expiry **before `ready`** answers the start promise once as
  `transport_unavailable`; a stale source is a no-op.
- A rejected callback (wrong state / empty state / missing code / foreign or
  placeholder client id / malformed) consumes **nothing**: the flow, the listener
  and its deadline all stay live for the genuine callback, except a stale
  `flow_expired` which ends the flow exactly once.
- `endCurrentLocked` is the single per-source terminal producer (claim XOR expiry
  XOR failure); it is a no-op for a stale, unstarted or already-claimed source, so
  no two producers can ever end a flow.
- The browser opener is now `(URL, @escaping (Bool) -> Void) -> Void`. A `false`
  completion is surfaced as the exact-source `transport_unavailable` terminal. The
  completion may run **synchronously inside the opener's critical section**, so it
  never re-enters the coordinator lock — it only schedules the checked failure
  effect on the injected main queue (`browserOpenFailed`), which applies it later,
  outside the lock. A stale/superseded/claimed/fenced source's `false` is a no-op.

### Module (`VeyraNSIWCModule.swift`)
`UIApplication.shared.open` now forwards its completion `Bool` to the coordinator
instead of discarding it. This file imports React/UIKit and is **not** part of
the standalone harness link set (no `node_modules`/`Pods` in the checkout), so it
is verified by review plus: it syntax-parses with `swiftc -parse`, and the *exact*
closure shape it passes as the coordinator's `openURL` seam type-checks on the
real target (`-typecheck -target arm64-apple-ios18.0-macabi`, Catalyst UIKit from
`MacOSX.sdk/System/iOSSupport`). The end-to-end module path itself was not
executed here.

### Unchanged (deliberately)
- No new Keychain service, account or schema; no parser changes; the canonical
  `urn:uuid:` read-normalization is untouched.
- No `origin` weakening: the callback host stays the literal `127.0.0.1` with a
  bounded ephemeral port only.

## Tests

Acceptance command is the existing standalone harness (SIWC.md §8; `swiftc`,
10 production files + `Tests/VeyraNSIWCHarness.swift`, macCatalyst target):

```
swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -target arm64-apple-ios18.0-macabi -swift-version 5 -parse-as-library \
  <10 production files> apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/Tests/VeyraNSIWCHarness.swift \
  -o "$TMPDIR/veyran-siwc-harness" && "$TMPDIR/veyran-siwc-harness"
```

Baseline before this change: `PASS: 519 checks (519 total, 0 failed)`.
After this change: **`PASS: 634 checks (634 total, 0 failed)`** (519 existing + 100
prior new + 15 review-regression), stable across repeated runs. Rebuilt against
the pre-review listener, 2 of the 15 new checks fail — the exact regression they
target — which is how the review finding was reproduced before the fix.

New synthetic coverage (manual clock / synthetic listener / manual main queue / no
10-minute sleeps, no real credential):

- `sharedLifetimeTests` — the shared TTL is exactly 600, the listener is started
  with it, the provider accepts a callback just inside the TTL and refuses one
  exactly at it, and the loopback origin/port contract is unchanged (foreign
  origins and out-of-range ports refused).
- `listenerTerminalSeamTests` (real loopback socket) — the TTL fires `onExpiry`
  exactly once and never also `onFailure`; an owner cancel is silent; a synthetic
  valid GET reports one parsed callback that the owner *accepts* (by cancelling),
  which silently disarms the remaining TTL and tears the listener down.
- `rejectedCallbackLifetimeTests` (real loopback socket, review regression) — a
  parse-valid **wrong-state** GET that the owner rejects leaves the listener live
  and reports no terminal of its own; the abandoned flow's TTL then fires
  `onExpiry` **exactly once** (never also `onFailure`) and tears the listener
  down; and after the rejected callback the genuine callback is still delivered
  (listener live throughout), whose acceptance silently disarms the TTL (no
  expiry/failure even when sleeping past it).
- `callbackLifetimeTests` — abandoned started flow → exactly one `flow_expired`
  (exact source, 0 exchange, 0 writes, listener torn down once, flow no longer
  current); pre-ready start failure and pre-ready listener failure → promise
  answered once as `transport_unavailable` with no auth event; explicit cancel →
  silent (and `authCanceled` promise before ready); a genuinely claimed callback
  with a **gated** exchange beats the TTL (commits/authenticates once, no
  `flow_expired`); a callback at the TTL → one `flow_expired`, 0 exchange, 0
  writes; wrong/empty-state, missing-code, placeholder-client and malformed
  callbacks consume nothing and keep the flow live, then one expiry; a superseded
  claimed gated exchange never persists while the newer flow commits once; a
  canceled claimed gated exchange never persists; a replayed prepared ticket
  performs no second exchange; a queued terminal delivery is revoked by
  `cancelAuth` and by logout; a synchronous browser-open `false` ends the flow
  exactly once without deadlock and a stale `false` delivers nothing; and
  exactly one per-source producer wins across claim/expiry/failure.

All prior 519 checks still pass unchanged (verified), and the harness output is
stable at 634/634 over five consecutive runs.

## Remaining / user-visible follow-up

- The real end-to-end login still requires the user to sign in through the system
  browser with their own account; this repair only guarantees the bounded native
  terminal (`flow_expired` / `transport_unavailable`) instead of a silent
  `connection refused`, and that a genuinely claimed callback always wins over the
  TTL. No credential, registration, host id, profile, group or encryption format
  was changed.
- `docs/veyran-connect/SIWC.md` was **not** in the allowed changed set: its §2
  ("180 s flow TTL") and §8 ("PASS: 519") are now stale and should be updated to
  600 s / 634 by the supervisor.
- `VeyraNSIWCModule.swift` is verified by review + a shape type-check only (no
  React/UIKit link set here); its end-to-end browser-open path is not executed.
