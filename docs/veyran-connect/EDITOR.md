# VeyraN Connect — Editor host context

Status: **core library only.** This document describes what this slice added to
`@notesnook/core`: an optional, **trusted per-invocation host execution context**
for `ConnectAdapter.execute`, and — built on the *same* immutable snapshot — an
additive **strict canonical-content mode** (`requireCanonicalContent`) for the
controlled editor/assistant path.

This slice adds **no** editor/UI integration, **no** MCP transport, **no**
account/device handling and **no** live-sync evidence, and it does **not** make
guest editor saves use Connect, support Vault editing, or add an ordinary editor
persistence facade. That is a statement about *this slice only*: the rest of the
repository already has MCP transport, native surfaces and SIWC sign-in, and this
work does not touch, block or claim to be the whole-project state of any of
them. It likewise makes no high-level auth or AI changes. The controlled
replacement is **pending RN/PM wiring** — the strict mode is a library-level
seam only.

This continuation is **not** a Core no-op: the strict mode lives in
`packages/core/src/connect/adapter.ts` (the host-only gate), refuses unsupported
input up front in `packages/core/src/connect/content.ts`, and is re-exported
from `packages/core/src/connect/index.ts`. No Core source outside
`packages/core/src/connect` (or its tests) was changed by it.

Evidence on the test host: the host-context suite passed **24/24**, the complete
Connect suite passed **234/234 across 22 files**, and the canonical-content file
passed **24/24**. `npm run build` completed the Core CommonJS, ESM and
typechecked declaration outputs. Tests use a synthetic encrypted SQLite
database; no real account, private note, backend or sync session was used.

The strict-append follow-up was completed by Codex after two DeepSeek writer
attempts hit the same `error_max_turns` failure without producing a completed
job; both parallel analysis workers had returned successfully. A focused
DeepSeek security review found no critical/high issue and identified the
revision, cross-mode receipt and attachment-preflight edges that were then
addressed in the local change. The worker candidate was not applied.

## 1. What problem this solves

`ConnectAdapter.execute(request)` already revalidates the *adapter-wide* state
(account row, grants generation, lock, migration) at every fence point. It did
**not** know anything about the *caller-owned execution* that issued the
request: the editor session, the window/buffer, the request the user is
currently waiting on.

A model-facing request must never be able to assert any of that. So the context
is passed as a **second, trusted argument** that only the embedding host process
supplies, and the adapter binds each accepted operation to it for its whole
lifetime.

## 2. Exact host interface

```ts
export interface ConnectHostContext {
  /** Bounded id label for this invocation (required). */
  operationId: string;
  /** Exact note id; required for note-scoped operations, rejected elsewhere. */
  noteId?: string;
  /** Host session id; accepted for note writes only. */
  sessionId?: string;
  /**
   * Controlled strict canonical-content mode for the editor/assistant path.
   * Omitted/false = ordinary behavior; true requires the prospective body of a
   * content-bearing invocation to already be safe and byte-stable.
   */
  requireCanonicalContent?: boolean;
  /** Synchronous "is this execution context still current?" predicate. */
  assertCurrent: () => void;
}

class ConnectAdapter {
  async execute(
    request: unknown,
    hostContext?: ConnectHostContext
  ): Promise<unknown>;
}
```

`ConnectHostContext` is exported from `packages/core/src/connect/adapter.ts` and
re-exported from `packages/core/src/connect/index.ts`. `HostAssert`
(`() => void`) and `assertHostCurrent()` are exported from
`packages/core/src/connect/fence.ts` / `connect/index.ts`.

### Rules the adapter enforces

| rule | detail |
| ---- | ------ |
| optional | Omitted (`undefined`) means "no host context": behavior is byte-for-byte unchanged. Any other value must be well formed. |
| shape | A plain object with **only** the five keys above. `null`, arrays, primitives, functions, unknown keys → `INVALID_INPUT`. |
| strict flag | `requireCanonicalContent` is optional. Omitted means `false`; an explicit `false` is preserved; **any** non-boolean (`0`/`1`/`"true"`/`null`/object) → `INVALID_INPUT`, before any write. It is copied into the same immutable snapshot as the ownership predicate: mutating the caller's object during an `await` cannot change the selected mode, and concurrent `true`/`false` invocations cannot contaminate one another. It is never part of the wire request. |
| bounds | `operationId`, `noteId`, `sessionId` must be strings of `1..CONTENT_LIMITS.maxIdChars` (200). |
| predicate | `assertCurrent` must be a function, must be **synchronous** and must return `void`/`undefined`. The contract is throw-based: a stale context is signalled by throwing. Returning a thenable (`async` function, `Promise`, any duck-typed `then`, a throwing `then` getter) or any other non-`undefined` value (a boolean ownership flag included) → `INVALID_INPUT`; a thenable is never awaited and a returned flag is never accepted as current. |
| mutation identity | For `create_note`, `append_to_note`, `update_note`, `create_task`, `update_task`, `complete_task`, `hostContext.operationId` must equal the request's `operationId` exactly. |
| note scoping | `noteId` is required and must equal the request target for `get_note`, `append_to_note`, `update_note`; a `noteId` on any other operation is rejected. |
| session scoping | `sessionId` is accepted only for `create_note`, `append_to_note`, `update_note`. |
| status | `status` accepts a context (an `operationId` label); it is asserted at entry and again before the content-free status is returned, including the locked report. `noteId`/`sessionId` are rejected. |

### Guarantees

- **Immutable snapshot.** The context is validated and copied into local
  primitives before the operation's first `await`; `assertCurrent` is captured
  at that moment and bound to a **frozen snapshot of the validated identity**
  (`operationId`/`noteId`/`sessionId`), never to the caller's live object. A
  method-style predicate reading `this.operationId`/`this.sessionId` therefore
  sees the validated values for the whole invocation, and mutating the caller's
  object while the operation is suspended has **no** effect on either the
  snapshot or what `this` observes. Only those three validated primitives are
  ever exposed — host state is not deep-copied or fabricated, and no ownership
  value is derived from the caller object after entry. The
  `requireCanonicalContent` boolean is validated synchronously and frozen into
  that **same** snapshot as `requireCanonicalContent === true`; the caller's
  original mutable record is never retained after entry, so a mutation during an
  `await` cannot relax the already-selected strict mode.
- **No adapter-global state.** The context is threaded as a per-invocation
  parameter into the operation's `OperationFence` (and, for note writes, into
  the note-write implementation). Concurrent invocations on one adapter keep
  independent contexts and cannot abort or contaminate each other.
- **Asserted everywhere.** `assertCurrent` runs at entry (synchronously, before
  the account read), again at admission after `captureFence`'s account read and
  before dispatch, after every awaited fence step (`OperationFence.step`), on
  each `OperationFence.assert`/`assertSync` — which is what every persistence
  guard calls immediately before each write boundary (content row, note row,
  note history, task save, recurrence follow-up) — and, in the same final
  continuation, immediately before the response is parsed and returned for both
  the normal and the `status` branches (nothing runs between the final check and
  the return). Finally, the **public `execute` boundary** re-asserts ownership
  after the real bounded result returns: the public continuation, synchronously
  and immediately before the value is handed to the caller, checks the *same
  entry snapshot* — nothing (no `await`, no `then`) runs between that check and
  the `return`. This closes the in-adapter gap between the bounded method's final
  assertion and the public `execute` continuation; it says nothing about any
  scheduling gap in the caller after `execute` resolves, which is outside this
  boundary.
- **One snapshot contract.** The request is parsed and the host context is
  validated+snapshotted exactly **once**, in the public `execute`, before the
  first `await`. The validated request and the frozen snapshot are then threaded
  into the private bounded method (and into the operation's `OperationFence`),
  which never renormalizes the caller's record. Every assertion — including the
  public-boundary one — therefore observes the one identity validated at entry;
  a later mutation of the caller's object cannot shift which predicate the
  boundary evaluates.
- **Bounded errors only.** A throwing predicate is reported as the static
  `SESSION_CHANGED`; a thenable predicate (including a throwing `then` getter), a
  non-`void` return, and every malformed/mismatched context as `INVALID_INPUT`.
  The host's own exception text is never surfaced, and no new error code was
  added.
- **`sessionId` forwarding.** When the host supplies a `sessionId` for a note
  write, it is copied into the *actual* note write for that invocation (and
  therefore into the real note-history row), while the ownership predicate
  asserted by the write guard still holds. It is never sourced from the wire
  request, and no other adapter-global session state exists.
- **Wire isolation.** The request schemas stay `z.strictObject`, so a model
  request carrying `hostContext`, `sessionId`, `assertCurrent` or `noteId` in a
  field the operation does not have is rejected as `INVALID_INPUT` with zero
  writes.

### Error codes

| condition | code |
| --------- | ---- |
| malformed context, unknown key, out-of-bounds field | `INVALID_INPUT` |
| thenable/async predicate, throwing `then` getter, non-`void` predicate return | `INVALID_INPUT` |
| `operationId` or `noteId` mismatch; `noteId`/`sessionId` on a non-scoped operation | `INVALID_INPUT` |
| `assertCurrent` threw (execution context no longer current) | `SESSION_CHANGED` |
| strict flag present but not a boolean | `INVALID_INPUT` |
| strict mode, missing/incompatible format, or a non-canonical body | `UNSUPPORTED_CONTENT` |
| strict mode, body over the bounded size | `CONTENT_TOO_LARGE` |

### Strict canonical-content mode (`requireCanonicalContent: true`)

This is an **additive, controlled editor/assistant mode**. It changes nothing
for callers that omit it: ordinary manual saves, external
Markdown/plaintext/TipTap conversion, reads and task operations keep their
existing behavior and their existing external identities.

- **Host-only, never a model field.** The mode is selected *only* by the
  trusted second argument of `ConnectAdapter.execute`. The request schemas stay
  `z.strictObject` and expose no `requireCanonicalContent` (or any other
  authority) field, so no wire/model request can select, weaken or bypass the
  gate; a request that smuggles such a key is `INVALID_INPUT` with zero writes.
- **Scope.** The strict check applies only to the *present prospective content*
  of `create_note`, `append_to_note` and `update_note.patch.content`. A
  `update_note` that carries only `title`/`pinned`/`favorite` has no prospective
  content and stays valid under its existing patch validation and host
  ownership (it is not made to fabricate a body). Reads, `status` and task
  operations accept and ignore the flag.
- **Format.** Strict content requires an explicit effective format of `tiptap`.
  The defaults still mean `markdown`, so a content-bearing strict request that
  omits `format` (or names `markdown`/`plaintext`) is a conversion, not a
  canonical body, and is rejected (`UNSUPPORTED_CONTENT`).
- **No silent strip, no sanitizer weakening.** Strict mode *rejects* a
  prospective body that the sanitizer or the persistence pipeline would rewrite
  rather than silently stripping/converting it: inline `style`, event handlers,
  scripts, unsafe URLs, a document the block-id pre-processor would modify, and
  a remote/`nn://`/`data:`/`data-hash` form the post-processor would reserialize
  are all `UNSUPPORTED_CONTENT`. The ordinary sanitizer itself is **not**
  relaxed: the shared `toTiptapHtml` pass (its `FORBID_TAGS`/`FORBID_ATTR`/
  `ALLOWED_URI_REGEXP`) and the existing external conversion path are unchanged;
  strict mode only adds a refusal on top of them. Existing stored
  styles/attachments are likewise never silently stripped by a strict append —
  the strict path rejects when the real post-processor would rewrite the
  assembled body and never sanitizes the stored base to make it pass.
- **Byte-stability fixed point.** A body is accepted only when *all* of the
  following hold, so the bytes the caller proposes are exactly the bytes that
  persist:
  1. `raw === toTiptapHtml("tiptap", raw)` — the raw string is already the
     sanitizer's own output (no stripped style/script/event handler/unsafe URL,
     no re-quoting/entity/parser normalization);
  2. a *detached* `db.content.preProcess({ type: "tiptap", data: raw })` leaves
     `type` **and** `data` byte-identical — the block-id pre-processor would not
     insert anything (so a document without block ids, or a string the sanitizer
     would materialize, e.g. a raw empty string, is rejected);
  3. the *actual* content-type post-processing, run detached and write-free with
     a rejecting attachment-save callback (never `db.content.postProcess` and
     never the relation helpers), leaves the bytes byte-identical — a proposed
     form the real persistence pipeline would rewrite is rejected honestly as
     non-canonical rather than silently converted.
  A valid explicit empty paragraph with a stable block id (e.g.
  `<p data-block-id="p1"></p>`) is a canonical fixed point and is accepted; a
  raw empty string is not, because the sanitizer materializes `<p></p>`.
- **Legacy rule, unchanged.** The block-id pre-processor inserts ids only when
  the *entire* string lacks the literal `data-block-id`. A mixed document that
  already carries some ids is therefore a pre-processing fixed point even if
  other blocks have none; strict mode accepts it on that basis. This slice does
  **not** redesign that legacy rule or the global, deterministic
  tag-name + `++index` id scheme (`p1`, `h12`, …), and makes no claim about its
  completeness or uniqueness policy.
- **Before any persistence.** The one preparation/validation of the prospective
  fragment happens in the payload-fingerprint step, before `journal.begin`.
  Strict append additionally reads its authorized note/revision and checks the
  assembled body before `journal.begin`. A rejection leaves **no receipt** (not
  even an aborted one), no content/note/history row, no relation and no
  attachment; a deliberately legacy no-id base is not migrated. The same
  prepared fragment is reused by the reservation expectation and guarded write.
- **Append vs stored base.** A strict append validates the complete
  `stored base + prepared fragment` against the real detached content-type
  post-processor before `journal.begin` can persist a receipt. The stored base is
  never sanitized or rewritten to make it pass: if the actual persistence
  pipeline would transform any part of the combined body, the request fails
  before a receipt or write. The expected revision is checked before this
  preflight, and the guarded write checks it again, binding the validated base
  to the bytes later persisted. The combined body must also fit the adapter's
  complete-read limit. A stored base with a `data-hash` reference remains
  supported and keeps its relation; a legacy inline-`data:` base or a prospective
  fragment containing `data-hash`/`data:` is refused before a receipt.
- **External compatibility and strict receipt identity.** The strict flag is
  never part of the wire request. The underlying request identity remains the
  established one: `create_note` fingerprints the prepared body, an append
  fingerprints its sanitizer-only bytes, and an update fingerprints the raw
  `patch`. Only a host invocation with `requireCanonicalContent: true` wraps
  that fingerprint with a separate strict-mode marker. This prevents strict
  calls from replaying an ordinary receipt (or vice versa), while calls without
  strict mode retain the exact historical fingerprint. `noteRevision`,
  `noteContentHash`, and canonical JSON hashing are unchanged.
- **Authorization unchanged.** Strict mode does not relax any account, grants,
  revision, mode, lock or Vault gate: a locked/adapter-locked or otherwise
  unauthorized target is denied through the existing authorization, with no
  Vault API or decryption fallback regardless of any visible/decrypted editor
  text. A host context revoked while the fragment is being prepared is denied
  (`SESSION_CHANGED`) with no receipt and no write.
- **No admitted-SQL rollback.** The schema is not transactional across a whole
  mutation, so a failure that lands *after* a durable write cannot roll that SQL
  back; where a write has already landed the adapter keeps the receipt truthful
  (recoverable `uncertain` / deterministic `aborted`) instead of faking a
  rollback. Strict validation itself runs before any write, so a strict
  rejection needs no rollback at all. The existing legacy external conversion,
  fingerprint and `noteRevision` shapes are unchanged.

## 3. Pending (explicitly not in this work)

- **Canonical validation (broader).** Strict mode validates each prospective
  create/replacement body and the complete body produced by append; there is
  still no general
  canonical note-body / task grammar validation of the model's output beyond the
  existing bounded content pipeline, and the host context does not otherwise
  make a model-authored body authoritative.
- **Receipt namespace.** A stable external namespace for receipts is still
  pending; receipts stay keyed by the caller-supplied `operationId` (under the
  existing journal `RECEIPT_PREFIX` storage namespace). This is *not* link
  grammar: `nn://note/<id>` and `veyran://task/<id>` are unchanged and documented
  in [CORE.md](./CORE.md); no new namespaced forms are introduced here.
- **Normal persistence facade / RN-PM wiring.** An ordinary editor persistence
  facade for guest editor saves and the React-Native/ProseMirror ("RN/PM")
  wiring of the controlled replacement are still **pending**; this slice is a
  core-library seam only and does not make guest editor saves use Connect.
- **FIFO.** No ordering guarantee between editor-originated writes and Connect
  writes beyond the existing shared domain write lock / `dbMutex`; a FIFO
  reconciliation queue is still pending.
- **Sidebar / editor UI.** No UI, sidebar, settings or app integration exists.
  The host context is a library-level seam only.
- **Auth / AI.** No changes to authentication or to any AI/inference layer; the
  host context only describes the caller-owned execution that issued a request.

## 4. Tests

`packages/core/__tests__/connect/host-context.test.ts` (new file; uses the
existing read-only `fixtures.ts` harness and `helpers.ts` `expectCode`) covers:
no-context back-compat, `sessionId` reaching the real note-history row,
note-scoped reads/writes, wire-smuggle denial, malformed context, async
predicate, `operationId`/`noteId` mismatches, entry/pre-output enforcement,
no-leak of the host exception text, caller mutation during an awaited step,
concurrent independence, `status`, and task mutations. This slice adds cases for
the final-continuation assertion (after the real `executeStatus`/`finalizeOutput`
return), the admission assertion (after the real `captureFence` account read and
before dispatch), a method-style predicate bound to the frozen validated
identity (caller mutation inert, external revocation still observed), a
mid-persistence revocation after the real content row landed (remaining writes
denied, truthful uncertain receipt, no faked rollback), and the malformed
predicate hardening (throwing `then` getter, non-`void` return). The **public
return boundary** is covered by wrapping the real private bounded method on the
harness adapter only: after it returns the genuine note/status object, ownership
is revoked and the caller's original record is replaced, and the public
`execute` must still reject with `SESSION_CHANGED` (never `INVALID_INPUT`, and
with no returned body) — proving the boundary evaluates the single entry
snapshot rather than a renormalized caller record.

This is a library-level boundary only. It does **not** claim that a caller's own
scheduling gap (the interval between the adapter returning and the host acting)
is closed, does not add an admitted-SQL rollback, and adds no UI/MCP/SIWC
integration.

`packages/core/__tests__/connect/canonical-content.test.ts` (new file; uses the
same `fixtures.ts` harness, `helpers.ts` and the *actual* encrypted-SQLite
pipeline) covers the strict mode: non-boolean flag rejection with zero
persistence; the flag ignored on reads/status; inert caller mutation and
concurrent strict/external independence; a canonical create/append/update whose
**real persisted raw bytes** equal the proposed canonical bytes (derived from
the real converter + pre-processor, never a synthetic serializer) with correct
receipt/replay/`IDEMPOTENCY_CONFLICT`; an ordinary receipt cannot satisfy a
strict replay; a reopen; exactly one invocation
preparation per content-bearing call with reservation/perform reuse (spied
`preProcess`); unchanged underlying request fingerprint shapes for create,
append and update plus the host-only strict receipt marker; a strict append
against a legacy body whose real post-processor would remove a node is rejected
with zero persistence admissions; a stale strict append is rejected before a
receipt; the remote-image / internal-`nn://`-link post-processing fixed point
(accept only a byte-identical result, otherwise assert a bounded no-write
rejection); a strict append onto a stored `data-hash` base that preserves the
relation and imports no attachment; a prospective `data-hash`/`data:` fragment
refused before any receipt; the legacy inline-data append denial; no migration of
a deliberately legacy no-id base on a rejected strict request; a host revoked
during preparation (`SESSION_CHANGED`, no receipt, no write); and an
adapter-locked target denied through existing authorization.

The continuation corrections (all present in this tree) tighten exactly three
things:

- **Real locked fixture.** The Vault-locked case writes the *actual* locked row
  shape (`locked: true` **and** `data: JSON.stringify({ cipher: "synthetic" })`)
  so the read-only `get` returns the parsed cipher object, and it asserts that
  object structurally (`toEqual`) — never `String(object)` against
  `"[object Object]"`. The previous `locked`-only fixture left plaintext `data`
  and the read mapper's `JSON.parse` threw before the adapter ran.
- **Spy-through zero-write coverage.** The strict rejection suite and the
  host-revoked-during-preparation case install spy-through counters on the
  *real* persistence boundaries (note `add`/`addGuarded`, content
  `add`/`postProcess`/collection `upsert`/`update`, note-history `add`,
  relation `add`/`unlink`, attachment `save`, settings collection
  `upsert`/`update`) and assert **zero** admissions, backed by read-only
  snapshots of the existing note metadata, history count and relations — not
  merely the final note count.
- **Update byte/replay proof.** The strict update test also proves the raw
  stored body equals the replacement, the returned revision equals the raw
  row's own revision, a byte-identical replay admits no second content/note/
  history/settings write, and a changed raw payload under the same
  `operationId` is `IDEMPOTENCY_CONFLICT`.

Root validation in the main checkout: the focused canonical-content suite
passed **24/24**; all Connect suites passed **234/234 across 22 files**; and
`npm run build` completed the Core CommonJS, ESM and declaration builds. This
does not validate the still-pending React Native editor bridge or user-facing
assistant actions.

Run the focused regression suite from `packages/core` with:

```sh
./node_modules/.bin/vitest run --config vitest.connect.config.ts __tests__/connect/canonical-content.test.ts
```
