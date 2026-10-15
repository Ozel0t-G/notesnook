# VeyraN Connect — Core adapter

Status: **core library only.** `@notesnook/core` exposes a bounded, idempotent
operation surface (`src/connect/*`, re-exported from `src/index.ts`). There is
**no** app integration, **no** MCP server/transport, **no** live-sync evidence
and **no** real account or device in this work. Nothing here should be read as
proof that a usable app or MCP surface exists yet.

Everything described below was verified by the tests listed in
[Tests](#tests). Every "verified" statement below refers to a synthetic,
encrypted SQLite database on the test host — never to a live Notesnook/VeyraN
account, backend, device or sync session.

## 1. What the adapter is

`ConnectAdapter` (`src/connect/adapter.ts`) wraps one `Database` and exposes
twelve versioned operations through a single `execute(request)` entry point:

| operation         | kind     | requires (grants)      | stable id           |
| ----------------- | -------- | ---------------------- | ------------------- |
| `status`          | read     | any grants installed   | – (callable while locked) |
| `list_notebooks`  | read     | `canRead`              | –                   |
| `search_notes`    | read     | `canRead`              | –                   |
| `get_note`        | read     | `canRead` + note scope | –                   |
| `list_task_lists` | read     | `canTask`              | –                   |
| `list_tasks`      | read     | `canTask` + list scope | –                   |
| `create_note`     | write    | `canCreate` (+ scope)  | `operationId`       |
| `append_to_note`  | write    | `canChange` + scope    | `operationId`       |
| `update_note`     | write    | `canChange` + scope    | `operationId`       |
| `create_task`     | write    | `canTask` + list scope | `operationId`       |
| `update_task`     | write    | `canTask` + list scope | `operationId`       |
| `complete_task`   | write    | `canTask` + list scope | `operationId`       |

Requests and responses are validated with strict Zod schemas
(`src/connect/schema.ts`); unknown fields, oversized payloads and unknown
operations are rejected with a bounded error code. Every response carries
`persisted: "local_saved"` (writes) and `sync: "unknown"`; the adapter never
claims that a record reached a server.

**Versioning.** The operation set and its request/response shape are versioned
as a unit through the durable receipt key prefix
`veyranConnect:v1:receipt:<operationId>` (`RECEIPT_PREFIX`). A receipt written
by a different schema version fails closed (`JOURNAL_CORRUPT`) instead of being
reinterpreted.

**Pure protocol module.** The wire contract lives in
`src/connect/protocol.ts`, exposed as `@notesnook/core/connect/protocol`
(ESM/CJS/types matching the existing `dist` layout). It imports only pure
modules (`zod`, `errors.ts`, `limits.ts`, `schema.ts`) and **never** the
adapter, database, SQL, crypto, native modules, DOM or showdown, so a future
MCP/broker worker can validate requests/responses without loading the app
runtime. It exports the canonical operation-name list, the per-operation strict
request/response schemas, the correlated wire envelopes
`{ ok: true, result } | { ok: false, error: { code, message } }` and the static
error catalog. A response whose `result.operation` does not match the
requested operation is rejected; an error `message` must be the catalog message
for its `code` (no raw/foreign transport strings). App-unavailable vs
broker-unavailable transport failures are represented by a **separate pure IPC
wire schema** with static transport codes (`APP_UNAVAILABLE`,
`BROKER_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE`), never by echoing a foreign error.

The shared limits (`CONTENT_LIMITS`, `ConnectContentFormat`) now live in the
pure `src/connect/limits.ts`; `content.ts` re-exports the very same bindings
(no drifting copy) and `schema.ts`/`grants.ts` import only the pure module.

**`status` shape.** `status` reports `version: 1`, the signed-in account, a
`status` of `"ready"`/`"locked"` with an `available` flag, `grantsGeneration`,
the **actually granted** capabilities (from the immutable grants snapshot) and
the non-sensitive idempotency-journal `capacity`/`count`. It is the one
operation that stays **callable while locked**, returning a truthful,
content-free blocked state (no ids, titles or read scope) instead of throwing
`ADAPTER_LOCKED`. Account-absent/closed/migration states still fail closed
exactly as before.

**Links.** `get_note` and `search_notes` results carry the real
`url: "nn://note/<id>"`; `list_tasks` entries carry the real
`link: "veyran://task/<id>"`. Ids are preserved verbatim (never re-encoded). A
notebook opening link is deliberately **omitted** until the real route is
confirmed. Task summaries include the stored `flagged`/`urgent`/`recurrenceRule`
and the floating, device-local schedule fields (`reminderDate`/`reminderTime`/
`reminderAt`/`scheduleVersion`) with **no invented timezone argument**.

**Runtime load safety.** `content.ts` no longer builds the showdown converter or
binds its document at import time (the mobile worker installs
`globalThis.DOMParser` lazily; the old eager binding captured `null` and only
failed later). The converter and showcase document are created lazily at call
time, on every conversion, from the **live** platform DOM, and fail closed with
`UNSUPPORTED_CONTENT` when no `DOMParser` exists. The general HTML/DOM helpers
(`utils/html-parser.ts`, `utils/dom-purify.ts`) are unchanged.

## 2. Grants

`setGrants({ accountId, canCreate, canRead, canChange, canTask, notebookIDs?,
noteIDs?, listIDs? })` installs an immutable `GrantSnapshot`
(`src/connect/grants.ts`):

- every id list is copied, deduplicated and bounded; oversized or malformed
  input is rejected outright (never silently trimmed);
- the snapshot carries the account id it was installed for, and grants are only
  installed while the account resolved from the persisted `kv.user` row
  (`db.user.getUser()`) is the same on both sides of the async read;
- **there is no local fallback**: with no signed-in account every operation
  fails with `DENIED`;
- the ids in a *request* never confer rights; only the installed snapshot does;
- installing or clearing grants (or locking/closing the adapter) increments the
  grants generation, which invalidates in-flight operations (`GRANTS_CHANGED`).

Note authorization for a note is `noteIDs` ∪ notes bound (through the relation
table) to a granted `notebookID`. The relation check is a live read, so moving a
note out of a granted notebook revokes access at the next check. A write
re-validates it in the guard immediately before the body is persisted. A *read*
does not return the results of its earlier, instrumented reads: the objects of
`get_note`/`search_notes` are re-read and reauthorized — current `localOnly`
metadata, current body visibility and current notebook binding — inside the
shared domain write critical section *after* the operation's last asynchronous
step (§5), so a hit that lost access while a later hit was read is dropped
(`search_notes`) or denies the request (`get_note`) instead of being returned.

**Local-only records are excluded entirely** (`localOnly` notes, their content
rows, and `localOnly` tasks): they are never returned by `get_note`, never
returned by `search_notes`/`list_tasks`, and never mutable — even when the
grant explicitly names their note/list/notebook. Notebooks and task lists
themselves are not filtered by `localOnly` (documented limitation). A note
whose body row is missing or is not stored as plaintext is never served as a
plaintext document: `get_note` fails closed (`NOTE_LOCKED`) and `search_notes`
skips the match instead of reporting a canonical empty body.

## 3. Revisions

Reads of mutable records return a `revision` string; writes to notes/tasks
require `expectedRevision` (`src/connect/revision.ts`):

- `noteRevision` hashes the note metadata (id, title, headline, contentId,
  timestamps, readonly/pinned/favorite/archived/conflicted/localOnly) together
  with a content fingerprint (content type, `dateEdited`, SHA-256 of the stored
  body, or the literal `locked` marker for vaulted bodies);
- `taskRevision` hashes the task fields a Connect request can change;
- the hash is truncated SHA-256 (`@noble/hashes`), not MD5, so two edits inside
  the same millisecond still produce different revisions;
- `expectedRevision` is checked **at the persistence point**, never before:
  the write payload is materialized and the revision re-validated inside the
  shared domain write critical section (§5), so a manual edit, vault lock, trash
  transition or readonly toggle that lands between the read and the write makes
  the write fail with `REVISION_CONFLICT` instead of overwriting it.

## 4. Idempotency, durable receipts and recovery

Mutations require a caller-chosen stable `operationId`. The adapter persists a
**metadata-only** receipt in the local encrypted database:

```
veyranConnect:v1:receipt:<operationId> → {
  v: 1, operationId, operation, accountId, fingerprint,
  reservedId, state: reserved|committed|aborted|uncertain,
  createdAt, updatedAt, expect?, result?
}
```

- `fingerprint` is a SHA-256 of the canonicalized request (payload fields and,
  for content, the SHA-256 of the *prepared* body). Reusing an `operationId`
  with a different payload fails with `IDEMPOTENCY_CONFLICT`.
- Receipts are stored in the `settings` collection: the local SQLite file is
  encrypted at rest and settings rows are end-to-end encrypted on sync.
  **What they actually contain** (verified against the stored rows, not
  intended): the account id (`accountId`), operation names, opaque ids
  (`reservedId`, `noteId`, `taskId`, `notebookId`, `listId`), SHA-256
  fingerprints/revisions/content hashes, **hashes** of note/task titles and
  task descriptions/recurrence rules, and the structured non-textual task
  fields a patch may set (dates, times, priority, flags). No note/task body,
  title, description or recurrence rule is stored in plaintext. A note title is
  pinned by the hash of the *exact* string the write stores (`titleHash`); the
  earlier plaintext `title` key and the `titleMode`/`priorTitle` mode shapes are
  neither written nor read (they were removed before first release, so no
  receipt in the wild carries them).
- **Write ordering.** A mutation is `(1)` reserve the durable receipt
  (`state: reserved`, awaited), `(2)` perform the domain write, `(3)` commit the
  receipt with bounded result metadata. `db.transaction` is a pass-through in
  this codebase, so these are three separate writes: a crash between them leaves
  a `reserved` receipt whose outcome is reconstructed from the record itself by
  verification (never from the receipt's outcome field).
- Failure policy is fail-closed: a receipt that is unreadable, of an unknown
  version or tombstoned fails the operation (`JOURNAL_CORRUPT`); a full journal
  (default bound: 1000 receipts) refuses new operations (`JOURNAL_FULL`)
  instead of evicting history. Receipts are never cleared or marked `localOnly`
  by this adapter — neither at logout nor during pruning; removing them would
  destroy the only proof that an operation may have landed.
- Guarantees are **single-database, single-process**. This is not a distributed
  exactly-once protocol: two processes (or two app installs) over the same file
  are not coordinated. Receipts are ordinary synced rows, so one merged in from
  another device does take part in `begin()` — where it is either recognized
  (and then resolved by verification, never by blindly retrying) or fails the
  operation closed. No cross-device exactly-once guarantee is claimed.
- A receipt left `reserved`/`uncertain` (crash) is **resumed by verification**,
  never blindly retried: the adapter re-reads the recorded target and classifies
  the outcome as `applied` (commit), `not_applied` (reopen and perform) or
  `ambiguous` (`IDEMPOTENCY_UNCERTAIN`). `ambiguous` never marks the receipt
  aborted.
- A crash **after** the note body was saved but **before** the notebook
  association is repaired during verification: the adapter restores exactly the
  recorded notebook→note relation (after re-checking the current grants and the
  notebook's existence) and only then returns the stable reserved id. That
  relation write goes through the *guarded* binding (§5), which revalidates the
  fence, the notebook grant and the note's mutability inside the domain lock,
  immediately before the write: a revocation that lands while the binding waits
  for that lock denies the relation and leaves the receipt reserved/uncertain
  (repairable) instead of aborting it — the note body is already durable.
- A `complete_task` whose recurrence follow-up could not be created is resolved
  from the *stored* post-state: verification counts a stored occurrence that is
  already completed (and matches the recorded post-state) as `applied`, so the
  durable completion is acknowledged and its receipt is never falsely aborted;
  a completion that is still open remains a proven pre-write failure. The
  missing occurrence is repaired by the existing maintenance path
  (`Tasks.reconcileRecurrence()`, run at startup and after sync), which creates
  exactly the one occurrence with the stable occurrence id — a retry never
  creates a second one.
- Everything the implementation does before its persistence point is a *proven*
  pre-write failure and may abort the receipt; everything after it is only
  resolved by verification.

## 5. Fences and domain locks

**Operation fence** (`src/connect/fence.ts`). Every operation captures a fence
(account id + grants generation) and revalidates it after *every* awaited step
(`fence.step`) and immediately before returning (`fence.seal`). The fence always
re-reads the persisted user row, so logout, account switch, lock, close,
migration requirement or a grants change stops the operation instead of leaking
content. The pre-processing content read happens only after the preceding step's
fence check, so a revoked/locked operation never touches the body.

**Shared domain write lock** (`src/connect/domain-lock.ts`). `db.transaction` is
a pass-through in this codebase (it opens no real SQL transaction), so the only
way to make a note read-modify-write atomic is to serialize the writers on one
mutex per live `Database` object:

- the lock is keyed by the `Database` instance in a `WeakMap`. Two independent
  `Database` objects opened over the same file are **not** covered (documented
  limitation: Connect is a single-process API over one shared database);
- re-entrancy is explicit: a caller that already holds the lock passes the
  `DomainWriteToken` it received, and the nested write runs inline;
- a token is an **opaque single-acquisition lease**: it is valid only for the
  database it was issued for and only while that critical section is still
  running. A token that leaked out of a finished section, was copied or forged
  is rejected instead of silently re-entering (or bypassing) the lock.
- guarded note writes (`Notes.addGuarded`) materialize their payload *inside*
  the critical section and run a read-only guard (revision, mutability, fence)
  immediately before **every** persistence boundary the write owns — the
  attachment row a data-URI image is saved as, the note↔note and
  note↔attachment relation writes/removals, the content row, the note row and
  the note history entry — so the fields the note pipeline computed
  (`contentChanged`, headline, generated title) are exactly the fields that get
  written, and a lock/revocation that lands while an inner `await` is suspended
  stops the remaining writes. The guard is threaded *into* the pipeline (the
  `saveAttachment` callback is wrapped and both relation helpers re-check after
  their own reads, immediately before each mutation); the ordinary, unguarded
  editor path is unchanged. Once the first write has landed, the guard only
  revalidates the fence: that half-state is recovered by receipt verification,
  not re-judged as a pre-write failure;
- the guarded notebook binding (`Notes.addToNotebookGuarded`) runs its guard
  inside the same critical section, after the relation read that decides whether
  the binding is missing and immediately before the relation write: the
  (possibly long) wait on the domain mutex is itself covered. The ordinary
  `addToNotebook` keeps its behavior for the editor/UI/sync paths;
- a Connect note write holds **one** lease for its whole write: `perform`
  acquires `withDomainWrite` and threads that lease into `addGuarded` /
  `addToNotebookGuarded`, then re-reads the committed state and builds the
  returned revision on the same lease before releasing it. The acknowledged
  revision is therefore the snapshot of *that* write, not of a manual edit that
  is queued behind the lease;
- the `*Locked` entry points that bypass `withDomainWrite` (`Notes.removeLocked`,
  `Content.removeLocked`, `Content.removeByNoteIdLocked`,
  `Content.updateByNoteIdLocked`) validate that the passed token is the *live*
  lease of the same `Database` before their first read or write. A stale, copied
  or foreign token is rejected instead of being able to run part of a sequence
  outside (or while another writer holds) the lock.

Paths that take the lock: `Notes.add`/`addGuarded` (and everything nested through
`Content.add`), note/trash transitions (`Notes.moveToTrash`, `Notes.remove`,
`Trash.*`), readonly/pinned/favorite/archive/localOnly/expiry changes, notebook
binding changes, the vault lock/unlock/save/open/remove/re-encrypt paths, and
sync's read→merge→put for `note`, `content` and `relation` chunks.

Paths that coordinate without the lock: `Content.get`/`findByNoteId`
pre-process the stored body (tiny→tiptap, block ids) as a read-modify-write, but
they are called from inside locked sections, so instead of taking the lock they
write back through a **compare-and-swap** (`type` + `data` + `locked` +
`deleted` predicate) that writes **only the transformed payload columns** — the
row's other metadata (`localOnly`, dates, `conflicted`, …) belongs to whoever
wrote it last and survives the migration write-back. The row is then *re-read*:
a lost CAS (a vault lock stores ciphertext and sets `locked`, or any other
writer replaced the body) returns the current stored row, so the caller never
receives the stale plaintext the read started from, and the migration is
retried on the next read.

**Read coherence.** A read that returns note objects (`get_note`,
`search_notes`) does not hand out anything it computed before the operation's
last asynchronous step. After `fence.seal()` it re-reads every candidate inside
one domain critical section and reauthorizes each of them there (with *bare*
reads — no test instrumentation hook may run while the lock is held, because a
hook that mutates note state would deadlock) and ends with a synchronous fence
check: closed/locked/generation/migrations must still be the state the request
was authorized under, and no `await` follows it. A task listing
(`list_tasks`) does the same, bounded, inside the Task write lease
(`runExclusiveTaskWrite`) with synchronous reads. `list_task_lists` is built
the same way: dispatch returns a distinct coherent plan and the objects are
rebuilt after the seal inside the Task write lease, with live grants,
existence, raw list privacy, bounded names/count, the *virtual* default list
handled explicitly, and a final bare account re-read followed by
`fence.assertSync()` — so a rename, delete, create or privacy toggle at the
seal cannot leak a stale name or drop a still-authorized list. The seal hook of
an operation — the last await before the response — therefore cannot leave
previously authorized content in it, and no instrumentation hook ever runs
inside a held lock.

Task records **and Task list records** are written by several paths (the
ordinary Tasks API, `TaskLists` list management, the Connect adapter and the
sync merge), so they all serialize on one **database-scoped Task write lease**
(`withTaskWrite`, the established `mutation` → `create` order, keyed by the
live `Database`). `TaskLists.create/update/remove/ensureDefaultPersisted` and
every Tasks create/update/complete/remove/uncomplete path use the same helper,
so a list write cannot interleave with a Task write. Re-entrancy is explicit
and live-identity-checked: a writer that already holds the section passes its
opaque `TaskWriteLease` (branded symbol, not exported through any wire schema
or model API) and nested calls run inline — which is why
`create → ensureDefaultPersisted` and `list.remove → Tasks.update` no longer
re-acquire (and dead-lock on) a mutex the caller already holds. A guarded Task
write validates the record read inside the lease and the exact record about to
be saved, immediately before `save` — with no `await` in between — and
revalidates *any* target list inside the critical section, not just the default.
An occurrence that is *already* completed is validated too: nothing is
re-written, but the recurrence follow-up is still a persisted change that needs
a live authorization. The recurrence follow-up a guarded completion creates is a
*different* record and gets its own optional follow-up guard
(`TaskRecurrenceGuard`) on the same lease, immediately before its own `save`:
it checks the fence and the list the new occurrence lands in, and it never
applies the completed occurrence's `expectedRevision` to the new id.

Sync's `settingitem` read→merge→put (the chunk type that carries Task records
and Connect receipts) runs under the adapter's database mutex and the Task write
lease, in the adapter's order, so a merge computed from a stale row cannot
overwrite a guarded local Task write (and the reverse).

## 6. Persistence vs. sync truth

- Local persistence is the only thing the adapter can attest to. Writes return
  `persisted: "local_saved"`; `sync` is always `"unknown"` and the error code
  `SYNC_STATE_UNAVAILABLE` exists for future sync-evidence paths.
- The adapter does not start, await or infer sync; it never reports
  "uploaded"/"synced". No live sync was exercised in this work.
- The idempotency receipts are themselves synced as ordinary encrypted settings
  rows by the normal sync machinery, which is why they are metadata-only (ids,
  hashes, bounded structured fields) and bounded. Sync's `settingitem`
  read→merge→put now runs under the adapter's database mutex and the Task
  write/create mutexes (§5), so a merge computed from a stale row cannot
  overwrite a guarded local write; a receipt row that is not in a valid,
  recognized state (unknown version, corrupt JSON, tombstoned) still fails the
  operation closed. Coordination — not receipt pruning, exclusion or
  `localOnly` rewriting — is what protects them.

## 7. Tests and synthetic setup

Focused suite (no network, synthetic account and database):

```sh
cd packages/core
npx vitest run --config vitest.connect.config.ts            # the focused Connect suite
# the same config with the package's remaining suites (incl. Notes/Tasks/
# Vault/Trash/account barrier):
CONNECT_INCLUDE_BASELINE=1 npx vitest run --config vitest.connect.config.ts
```

**Corrections after the run below** (four defects: the inner post-processing
boundaries, the guarded notebook binding, the guarded recurrence follow-up and
returned-object coherence after the seal) add three focused files —
`__tests__/connect/postprocess-boundaries.test.ts`,
`__tests__/connect/binding-recurrence.test.ts` and
`__tests__/connect/coherence.test.ts`. They were **authored but not executed**
in the authoring round (that round is not allowed to run install/test/build
commands); the counts below are from the run *before* those corrections, so the
focused suite (and the baseline config) must be re-run in the normal workspace
before any of this is claimed as verified.

**Gate corrections (this round, also authored but not executed here).** A
further review gate produced the changes described in §7a and
`__tests__/connect/gate-corrections.test.ts`; none of them was executed in this
round either. The `80 passed (80)` / `1019 passed` figures below predate both
this round and the previous one and are **not** a result for the current tree.

**Result of the last full run in the isolated worker checkout** (2026-10-11):
`80 passed (80)` for the focused Connect config; `CONNECT_INCLUDE_BASELINE=1`
ran the whole `packages/core` suite: **1019 passed, 1 todo, 62 suites passed,
1 suite failed to load** — `__tests__/task-widget-contract.test.ts` imports
`apps/mobile/…`, and Vite cannot resolve that app's
`@react-native/typescript-config` because `apps/mobile/node_modules` is not
installed in the isolated checkout. That failure is environmental (missing
sibling-app dependencies) and unrelated to `src/connect`, the collections or the
sync merge; it must be re-run in the normal installed workspace.

Setup (`__tests__/connect/fixtures.ts`): a real `Database` over a
`better-sqlite3-multiple-ciphers` file in the OS temp directory, protected by a
throwaway password, with a synthetic `kv.user` row ("signed in" locally, no
network) and one notebook/note/task list. The Connect config resolves the
workspace packages to their real sources and is test-only (the package-wide
`vitest.config.ts` is untouched).

What the suite covers: content conversion/sanitization, markdown/plaintext/
tiptap round-trips, unicode, bounded response rules, grant scoping (foreign
notebooks/notes/lists are never leaked or writable), paused account/grants/lock
changes during reads and writes, revision conflicts (including same-millisecond
edits), locked/readonly/trashed notes, guard checks against a slow ordinary
write, vault locks during a guarded append, permanent deletes during a guarded
append, stale content reads vs. vault rewrites, sync merge coordination, the
domain-lease rules, full/corrupt/tombstoned journal handling, crash recovery
before/after a write, and notebook-binding repair.

`__tests__/connect/safety.test.ts` adds the focused pause tests for the audited
defects. They are discriminative rather than vacuous: for the post-processing
guards and the sync-merge coordination this was confirmed by reverting the
corresponding guard and watching exactly those tests fail; the remaining ones
assert the exact condition the removed code ignored (rejected call, unchanged
row, denied read), so they cannot pass against the pre-correction code either:

- a pre-processing read paused across a `localOnly` change keeps the new
  metadata (only `type`/`data` are written back) and a paused read whose CAS is
  lost to a vault lock returns the *current* locked body, not the old plaintext;
- stale/foreign/copied domain leases are rejected by the `*Locked` content and
  note-removal entry points (including while another writer holds the lock);
- a note append paused inside content post-processing, then locked or
  grants-revoked, writes neither content nor note row (payload byte-identical);
- `create_task` paused in default-list materialization and `update_task` paused
  before its save do not write after a lock; a task outside the granted list is
  never touched;
- a real (non-empty, collected) `settingitem` chunk merge is serialized with the
  Task write lock, and a local guarded task write cannot slip between a merge's
  read and its put;
- local-only notes/tasks are never returned, searched or mutated, a missing body
  fails closed, and a note that leaves its granted notebook during the body read
  is denied;
- stored receipts contain no plaintext note/task title or task description, and
  the hashed receipts still verify on replay.

The three files added with the corrections above and **not yet executed** cover
one boundary each:

- a body append paused in the link helper's `notes.exists` read, then locked,
  writes neither the relation nor the content; the attachment helper's own
  boundary is checked after its lookup (pause on the last pre-helper boundary,
  revoke, then no relation is added or removed), and the attachment save
  callback is guarded (a revoked guard writes no attachment row; a passing
  guard runs before every save); attachment-bearing Connect input (a
  markdown/tiptap `data:` image and a stored `data-hash` reference) is rejected
  with `UNSUPPORTED_CONTENT` and leaves no note, relation, attachment row or
  receipt behind — `postprocess-boundaries`;
- a `create_note` revoked while the notebook binding runs leaves the note body
  durable, writes no relation, is denied while still revoked and repairs
  exactly that relation on the stable retry; a completed recurring Task whose
  follow-up is revoked keeps its durable completion, creates no occurrence,
  acknowledges the durable completion on the re-authorized retry and repairs
  exactly one occurrence through `reconcileRecurrence()`, with no second
  occurrence on a further replay — `binding-recurrence`;
- two `search_notes` hits with a revocation (notebook unlink or vault lock)
  landing while the second hit is read return only the surviving hit; a
  `get_note` whose note becomes local-only, leaves its granted notebook or is
  vaulted during the seal is denied (the previously authorized body is never
  returned); a `list_tasks` paused across a `localOnly` flip does not list the
  task, and the discriminating variant flips the first listed task
  `localOnly` in the *seal* (after dispatch returned) — the listing is rebuilt
  from the post-seal state and the task, its private title and its count never
  appear; a grants clear + regrant (with an A→B→A account flip) during the
  operation's initial account read denies the operation — `coherence`.

The portable-protocol/load-safety round adds three more files, also **authored
but not executed here**:

- `__tests__/connect/protocol.test.ts` — pure wire contract: canonical operation
  list, per-operation strict request/response schemas, `result.operation`
  mismatch rejection, the static error catalog (message must equal the catalog
  message for its code), and the app-vs-broker transport codes and IPC wire
  schema (foreign transport errors rejected). Runs under the focused connect
  config (no DOM needed);
- `__tests__/connect/status.test.ts` — the `status` contract (version,
  granted capability flags, journal capacity/count, no id/read-scope leak while
  locked) and the real `nn://note/<id>` / `veyran://task/<id>` links plus the
  stored task schedule fields;
- `__tests__/connect/load-safety.spec.ts` under its own
  `__tests__/connect/vitest.load-safety.config.ts` (**no `setupFiles`**, so no
  `linkedom`): imports the pure modules in a DOM-less process with a
  throwing `DOMParser` getter (proving zero DOM touch), imports `content` with
  no DOM and checks it fails closed (`UNSUPPORTED_CONTENT`, not a raw
  `TypeError`), then installs the *actual* `apps/mobile/worker.js` `DOMParser`
  and converts markdown/unicode/lists/links/scripts/events. It is named
  `.spec.ts` so the shared connect config (whose setup always installs a DOM)
  does not pick it up.

Run it with:
`cd packages/core && npx vitest run --config __tests__/connect/vitest.load-safety.config.ts`.

The `postprocess-boundaries` "not added" case was also strengthened: it now
asserts the note has **zero** attachment relations before the paused add and
**zero** after the revocation (the previous `toId === hash` comparison was
vacuous — the relation target is the attachment record id, not the content
hash).

## 7a. Gate corrections (authored in this round, **not executed**)

This round corrects the defects the gate raised against the boundary patch. The
diff is confined to `src/connect/adapter.ts`, `src/connect/content.ts`,
`src/connect/revision.ts`, `src/collections/tasks.ts`,
`src/collections/notes.ts` and the new test file; it does not change the wire
protocol, the operation set, sync formats or any native/UI layer.

- **Authorization before fingerprint/receipt.** `runMutation` now authorizes the
  capability and the fenced target scope *before* the payload fingerprint (which
  may convert request content) and before `journal.begin`. A revoked or
  out-of-scope request can therefore no longer surface as `IDEMPOTENCY_CONFLICT`
  (which leaked that an `operationId` was already recorded) and can no longer
  convert a body or reserve a receipt it is not authorized to touch. This is
  exercised by `gate-corrections.test.ts` (revoked-scope reuse →
  `NOT_AUTHORIZED`; no receipt for an unauthorized conversion).
- **Task payload validation before the reservation.** `create_task` /
  `update_task` payloads are validated with the *actual* domain materialization
  and validator (`validateTaskCreateInput` / `validateTaskUpdateInput`, extracted
  in `tasks.ts` and reused by `Tasks.create` / `Tasks.updateUnsafe` so they cannot
  drift) inside `createReservation` — before the durable receipt is written.
  Empty titles, impossible calendar dates, an urgent task without a date/time and
  a recurrence without a due date are a bounded `INVALID_INPUT` with **no
  receipt** and no record. Replays never reach this path, so an old committed
  replay is never re-judged against newer scheduling state.
- **Bounded error surface.** `execute` normalizes any escaped non-`ConnectError`
  to a static `ConnectError`, and `runMutation` keeps (does not abort) the
  reservation for a non-Connect pre-write failure after normalizing the thrown
  value to `INVALID_INPUT`. No raw SQL/content can leak, and a possibly-persisted
  write is never abandoned.
- **Task existence and external visibility.** A missing task target and an
  out-of-scope task target are the same `NOT_AUTHORIZED` answer (no existence
  oracle); `list_tasks` and `list_task_lists` also consult the **raw**
  `settings.localOnly` column, so a legacy/foreign writer that flagged only the
  row (not the JSON payload) cannot leak a task/title. `list_notebooks` skips a
  raw tombstone/`localOnly` row defensively (the `notebooks` table has no
  `localOnly` column; `notebook()` already excludes trash).
- **Live-notebook authorization.** Notebook-scoped access (`isNoteAuthorized` /
  `isNoteAuthorizedBare`) no longer trusts a relation row alone: the notebook
  behind the relation must still exist (not tombstoned) and be neither trashed
  nor flagged `localOnly`. A *direct* `noteID` grant still serves its note
  regardless of the notebook. Trashing a granted notebook therefore revokes its
  notes at the next check (the previous code only checked that the relation's
  `fromId` was in the grant set).
- **Search visibility and bounds (bounded SQL).** `search_notes` no longer
  materializes an authorized id list into an `IN (...)`: candidates come from
  `Lookup.boundedNoteIds`, which passes the granted note/notebook id arrays as
  **two JSON parameters** expanded with `json_each` (constant parameter count,
  bounded to the adapter's 1000-id grant limit), applies eligibility (scope,
  live notebook, *current* body row, `localOnly`/locked/trash) **before**
  matching/ranking and the `LIMIT`, joins the FTS to `content.id =
  notes.contentId` so a stale historical body can never hit, and cuts to
  `limit + 1` ids. The whole candidate window is carried through the final,
  domain-locked rebuild: `truncated` is derived only from the *final* visible
  count (plus the title bound), so a candidate that is or becomes hidden can
  neither consume a visible slot nor make a complete response look truncated,
  and hidden/revoked overflow is never revealed through `truncated`. The
  sub-3-character branch intersects the regex with the *eligible* FTS hits when
  any exist and preserves their rank order (deterministic id tiebreak); an
  eligible-hidden FTS hit does not flip that branch. A hidden-only hit yields
  `[]`/`truncated: false`, byte-identical to a genuinely-no-match query.
- **Exact title hashing.** Receipts pin the exact stored title by hash:
  `titleHash = sha256(normalize(title))` where `normalize` strips newlines
  (matching `Notes.addUnsafe`). The plaintext `title` key and the `titleMode`
  (`generated`/`prior`) / `priorTitle` shapes are no longer authored *or* read —
  they were removed before first release, so no receipt in the wild carries
  them and no plaintext title is ever compared against or stored. A
  missing/blank `create_note` title is resolved by the adapter itself
  (`connectCreateTitle`): the explicit title is used as-is, otherwise a
  deterministic, Connect-specific title is derived from the already-sanitized
  body (`Tiptap.toTitle()`, bounded to 512) with the constant fallback
  `"Untitled"`, and passed as an explicit title into the ordinary `Notes.add`
  (so the editor's clock/settings-dependent generated-title path is never
  taken). A supplied but blank `update_note` title is rejected with
  `INVALID_INPUT` in `createReservation`, before the durable receipt: omitting
  the title keeps the prior one.
- **Write-point revision ownership.** A guarded note write runs on one shared
  domain lease: `perform` acquires `withDomainWrite` and passes that lease as
  the token to `Notes.addGuarded` / `Notes.addToNotebookGuarded` (which run
  inline instead of taking their own), then re-reads the committed state with
  *bare* reads on the same lease and builds the result synchronously before
  releasing. The response and the committed receipt therefore carry the
  revision of *this* write — a manual edit queued immediately after the lease
  is released is legitimate but cannot change the acknowledged revision — and no
  `fence.step` hook ever runs inside the lease (a mutating hook would deadlock
  on it). The last check inside the lease is a synchronous `fence.assertSync()`.
- **Task revision coverage.** `taskRevision` now includes `schemaVersion`,
  `reminderLeadMinutes`, `legacyReminderId` and `localOnly`.
- **`create_task` payload materialization.** The adapter builds the `TaskInput`
  from an explicit list of *defined* optional keys
  (`materializeTaskCreateInput`), never forwarding an absent optional field as
  an own `undefined` property: `buildCreateValue` decides "floating-calendar
  write" from `hasOwn(input, "reminderDate"|"reminderTime")`, so an own
  `undefined` would flip every create into a `scheduleVersion: 2` write,
  discard a legacy `reminderAt`, and make an `urgent` Task with only a legacy
  reminder invalid. The **same** materializer feeds the pre-reservation
  validation and the write, and the resolved list/id are owned separately — no
  arbitrary model extras. Legacy `urgent + reminderAt`, explicit floating
  `reminderDate/reminderTime`, and `dueDate + recurrence` therefore all
  validate and persist correctly, while the ordinary Task *update* clear
  semantics (`buildUpdateValue`) are unchanged.
- **`create_task` recovery verification.** `verify` requires the **stored
  record's** title hash to match (`hashId(task.title) === expect.titleHash`);
  the original request string is never accepted as proof of the object at the
  reserved id (the removed `hashId(request.title.trim())` disjunct was
  unconditionally true). A reserved id occupied by a different/manual-edited
  Task is reported `ambiguous` and never touched. Recovery *and* committed
  replay re-check the reserved record's **current** raw Task/list privacy and
  its presence in the **current** grants (a record that became `localOnly` or
  left the granted scope is refused; a missing record is only allowed on the
  recovery path so a crash before the write stays recoverable — the reserved id
  is never caller-supplied, so neither case is an existence oracle). No private
  contents are read into a response or a log, and no new plaintext
  title/description/recurrence is stored.
- **Coherent `list_task_lists`.** Dispatch returns a distinct read plan and the
  objects are rebuilt after the seal inside the Task write lease (live grants,
  existence, raw list privacy, bounded names/count, explicit virtual default,
  final bare account re-read + `fence.assertSync()`), so a list mutation at the
  seal is reflected coherently.
- **Legacy inline attachments.** A plain `append_to_note` whose *stored* body
  still carries an inline `data:` image (an older client's body) is refused with
  `UNSUPPORTED_CONTENT` in `createReservation` — before a receipt is written — so
  the ordinary pipeline can never (re)import that image through the bounded
  Connect surface. Stored `data-hash` references are unaffected (they bind
  through the guarded relation helper), and the ordinary editor path is
  unchanged.
- **Journal capacity.** `new ConnectAdapter(db, { maxJournalEntries })` rejects a
  non-positive/non-finite/non-integer or *above-`MAX_JOURNAL_CAPACITY`
  (100000)* bound (`NaN`, `0`, `-1`, `Infinity`, `1.5`, `100001`) with
  `INVALID_INPUT` instead of silently disabling the fail-closed `JOURNAL_FULL`
  check. The default is **1000**; there is no automatic growth, eviction, TTL,
  pruning, delete or reset, and no user-supplied per-request capacity. All old
  receipts and the original stable ids/replays remain; lowering the capacity
  denies only new operations. `status.journal.capacity`/`count` are a
  **snapshot** of local metadata, not an atomic distributed count, and a
  tombstoned receipt remains corrupt/fail-closed (a conservative, non-atomic
  claim is deliberate).
  Raising the capacity is a **trusted-host** action taken *off* the request
  path: close the old adapter (`close()` revokes its grants and increments the
  generation, so no in-flight or later call on it can proceed), then construct a
  new adapter over the same `Database` with the higher `maxJournalEntries`.
  Construction is not itself a mutex, but the journal is only ever read/written
  inside the database-scoped operation mutex (`dbMutex`), so the closed
  adapter's operations and the new adapter's operations are serialized by that
  mutex and the new generation's revocation denies the old one. There is no new
  model tool and no user-supplied capacity.
- **Final coherent account read.** `coherentNoteOutput`,
  `coherentTaskListOutput` and `coherentTaskListsOutput` end with a bare read of
  the persisted signed-in account *inside* the held lock, require it to equal
  the captured account, and
  only then run the synchronous fence check — so a logout/switch that rewrote
  `kv.user` after the last fence assert denies the output. ABA still relies on the
  generation-lifecycle contract and is not proved by a single read.
- **Domain leases.** `Notes.addGuarded` / `Notes.addToNotebookGuarded` accept an
  optional `DomainWriteToken` so a caller that already holds the critical section
  can run inline instead of deadlocking; the ordinary callers are unchanged.

New test file `__tests__/connect/gate-corrections.test.ts` (focused config). It
was **not executed** in this round. Its cases: revoked-scope reuse and
no-receipt-for-unauthorized-conversion; a note of a soft-deleted granted
notebook (relation intact) denied; empty/urgent/recurrence/impossible-date
task rejects with no receipt; empty-title and time-without-date updates;
raw-error normalization; journal-capacity validation; hidden-only vs no-match
search identity; limit/truncation against visible overflow; title+body dedupe;
raw-local-only task hiding; task-revision coverage; legacy inline-attachment
append refusal with no attachment/receipt/body change; and the final coherent
account read denial.

**Continuation round (also authored here, not executed).** Three instrumentation
tests written against an earlier reader were repaired to instrument the reader
that is actually used — the read-only `SQLCollection.get` keyed by the note's
own `contentId`, with a content-id→note-id map (`fixtures.noteContentIds`) —
instead of the retired `content.findByNoteId`: the two `coherence` search-race
cases (an unlink/vault landing while a later hit is read must drop exactly that
hit) and the `gate-corrections` final coherent account read (flip the persisted
account on the second real content read; `SESSION_CHANGED`). Two new focused
files cover the bounded SQL candidate path and the title/write-point rules:

- `__tests__/connect/search-bounded.test.ts` — real database, no fake lookup:
  hidden matches (`localOnly`, vaulted, trashed, out-of-scope, missing current
  body, stale historical row) neither consume the visible limit nor flip
  `truncated`; a 1000-entry grant array is a constant number of SQL parameters
  and still honors the `LIMIT` (adapter asks `limit + 1`); the
  sub-3-character branch keeps eligible-FTS rank order and ignores hidden FTS
  hits; a directly granted archived note is served while an archived notebook
  member is not; only the note's current body can hit;
- `__tests__/connect/title-and-writepoint.test.ts` — an empty-title create gets
  a deterministic, explicit (non-generated) title that survives a close/reopen
  replay with no duplicate; the constant `"Untitled"` fallback for a
  headline-less body; a blank (`""`/whitespace) `update_note` title is
  `INVALID_INPUT` with no receipt/row/dateEdited change while an omitted title
  keeps the prior one; no plaintext title (explicit or derived) appears in any
  receipt value; a manual edit queued immediately after the guarded write (while
  the lease is still held) does not change the acknowledged revision and does
  not deadlock; a stale unlocked row and a locked/deleted current row behave
  correctly and the reader inserts no block ids on read; and a create into a
  granted-but-soft-deleted notebook is `NOT_AUTHORIZED` like a missing id, with
  no receipt.

None of the tests in this round was executed here (the authoring checkout may
not run installs/tests); the counts in §7 predate them.

## 7b. Final Core integration corrections (authored, **not executed**)

Confined to `src/connect/adapter.ts`, `src/collections/tasks.ts` and the
`__tests__/connect` tests; no wire-protocol, operation-set, sync-format,
native/UI or dependency change.

- **`create_task` materialization** (`materializeTaskCreateInput`): only defined
  optional keys become own properties; the same object feeds validation and the
  write (see §5). Fixes legacy `urgent + reminderAt` being rejected.
- **`create_task` recovery verification**: the stored record's title hash is
  required (the request-string disjunct is removed); recovery and committed
  replay re-check the reserved record's current raw Task/list privacy and
  current granted list. Missing/private/out-of-scope are one indistinguishable
  refusal; no private contents enter the response or a log; a missing record is
  only tolerated on the recovery path (the reserved id is never caller-supplied,
  so it is not an existence oracle).
- **Coherent `list_task_lists`**: dispatch returns a distinct read plan; the
  objects are rebuilt after the seal inside the Task write lease, with live
  grants, existence, raw list privacy, bounded names/count, explicit virtual
  default, and a final bare account re-read + synchronous fence check.
- **One database-scoped Task write lease** for Task *and* Task list writes, with
  explicit re-entrancy (`TaskWriteLease`), so list writes and Task writes share
  one lock order and `create → ensureDefaultPersisted` /
  `list.remove → Tasks.update` no longer re-acquire a held mutex.
- **Receipt capacity**: finite bounded positive-integer validation with a
  documented upper bound (`MAX_JOURNAL_CAPACITY = 100000`); the default stays
  1000, with no growth/eviction/TTL/pruning; a trusted host raises the bound only
  by closing the old adapter and recreating over the same database (see §5).

New, **not executed**, focused tests:

- `__tests__/connect/task-create-input.test.ts` — legacy `urgent + reminderAt`
  (including `reminderAt: 0`) preserved with no `scheduleVersion`; explicit
  floating calendar sets `scheduleVersion: 2` and mirrors due; `dueDate +
  recurrence`; urgent due-date-only; urgent-with-no-schedule still rejected;
  replay/restart/update round-trips; and the reserved-id recovery regressions
  (wrong title, same title in a different list, raw-private reserved list,
  committed replay after the record moved into a raw-private list).
- `__tests__/connect/task-lists-coherence.test.ts` — `list_task_lists` rebuilt
  coherently when a raw privacy toggle, a rename or a removal lands at the
  seal; Task list create/remove serialized with the Task write lease (no lost
  update, no dangling task list reference); journal-capacity upper-bound
  rejection, trusted raise with old-receipt replay, and a real `settingitem`
  sync merge preserving the receipt snapshot.

## 7c. Post-migration gate corrections (authored, **not executed**)

Confined to `src/collections/tasks.ts`, `src/connect/adapter.ts` and the
`__tests__/connect` + `__tests__/task-widget-contract.test.ts` tests; no schema,
wire-protocol, sync-format, dependency or native/UI change.

- **Reminder-time-without-date is rejected at the raw materializer.** The shared
  `buildCreateValue`/`buildUpdateValue` (used by `Tasks.create`/`Tasks.update`
  *and* by the Connect pre-reservation validators `validateTaskCreateInput`/
  `validateTaskUpdateInput`) previously dropped a supplied `reminderTime` when no
  `reminderDate` accompanied it — and, on a legacy due-date record, flipped it
  into a `scheduleVersion: 2` write that then cleared the due schedule. Create
  now rejects a *defined* `reminderTime` with no `reminderDate`; update rejects
  it unless the merged record still resolves a `reminderDate` (an existing
  floating date or one supplied in the same patch), and rejects it when the date
  is explicitly cleared. Explicit `reminderTime: undefined` still clears, and a
  sole `reminderDate: undefined` still clears the whole calendar; legacy
  `reminderAt`/due-date/urgent/recurrence paths are unchanged. Because the same
  materializer feeds both the pre-reservation validator and the write, Connect
  rejects such a `create_task`/`update_task` as `INVALID_INPUT` with no receipt
  and no record.
- **Default Task list tombstone.** `TaskLists.getSync`/`default()` now consult
  the *raw* settings row: a soft-deleted (tombstoned) default row is treated as
  absent — the virtual default is returned and the next default-list write
  (`ensureDefaultPersisted`, on the held Task write lease) re-materializes it —
  while a present, non-deleted row that fails to parse (unknown schema version /
  corrupt JSON) stays fail-closed and is never overwritten.
- **Task list / Task id boundary hardening.** `TaskLists.update` now assembles
  only the mutable list fields (`name`/`sortOrder`/`color`/`symbol`) and pins
  `id`/`schemaVersion`/`createdAt` to the stored record, so a runtime (untyped)
  patch can no longer overwrite a list's identity through the spread. An explicit
  empty/whitespace `listId` on `Tasks.create`/`Tasks.update` is rejected instead
  of being silently routed to the default list. `runExclusiveTaskWrite` keeps no
  global "active writer" fail-fast (that would reject legitimate concurrent
  callers, not just self-nesting); the lease stays an opaque, database-scoped,
  single-acquisition token, and `recordExists` keeps its raw-row truthiness so a
  legacy/unknown-schema Task row still blocks a reused id.
- **`create_task` recovery is hash-only.** The reserved-record verification
  accepts only `expect.titleHash`; the previously authored plaintext/model
  `title` disjunct was removed, so an unrecognized legacy receipt shape fails
  closed to `ambiguous` (`IDEMPOTENCY_UNCERTAIN`) instead of being honoured. A
  *committed* receipt whose stored Task is gone (deleted/trashed) is denied
  uniformly as `NOT_AUTHORIZED` — a committed acknowledgement is never replayed
  against storage that no longer holds the object — while a `reserved`/
  `uncertain` receipt with a missing record stays recoverable proof that nothing
  landed. The analogous note-create replay is verified (test-only) to keep its
  historical, bounded result and never re-create a trashed note.
- **Widget contract fault injection.** `Tasks.complete` persists the completed
  occurrence and then the next occurrence through the *private*
  `createWithinLease`, never the public `create`; the widget regression test now
  injects the failure at the actual underlying settings `upsert` of the stable
  next-occurrence row (the completed row is written first and does not match).

New, **not executed**, focused tests:

- `__tests__/connect/task-reminder-guards.test.ts` — raw create/update
  time-without-date rejection and the shared-validator equivalents; valid
  time-only update onto an existing floating date; explicit-`undefined` clears;
  legacy due-date record untouched by a rejected update; default-list tombstone
  resolution + re-materialization (create and update-into-default) with an
  unknown-version row still failing closed; `TaskLists.update` identity pinning;
  empty/whitespace `listId` rejection.
- `__tests__/connect/journal-capacity-merge.test.ts` — the real default bound of
  1000 receipts (one real committed operation + 999 seeded via the journal API):
  `JOURNAL_FULL`, a trusted raise to 1001 with a new write, replay of the real
  committed operation with no duplicate, then restart and a lowered bound both
  denying new writes while still replaying the old receipt; and a real
  `settingitem` collector/`processChunk` merge preserving
  committed/reserved/tombstoned/unknown-version/cross-account receipt states.
- `__tests__/connect/task-create-input.test.ts` — added Connect-level rejection
  of a time-only create/update before any receipt, the deleted-committed-task
  replay denial, the legacy-plaintext-title receipt failing closed, and the
  historical note-replay analogue.
- `__tests__/task-widget-contract.test.ts` — the recurrence fault injection moved
  to the actual next-occurrence settings write.

## 8. Limitations (honest list)

- Core-only: no app UI, no MCP server/transport, no CLI, no auth flow.
- Single-process locking only; two `Database` instances over the same file, or
  two processes, are not serialized. Receipts are not a distributed
  exactly-once protocol.
- No live sync/account/device verification: `sync` remains `unknown`. Sync
  merges are serialized with local writers for `note`/`content`/`relation`
  chunks (domain lock) and for `settingitem` chunks (database mutex + Task write
  lease); other chunk types keep their previous unlocked merge path.
- The Task write lease shared with sync covers Task *records* **and Task list
  records**: `TaskLists.create/update/remove/ensureDefaultPersisted` take the
  same database-scoped section as every Task create/update/complete, and a
  `settingitem` merge is serialized against both. The recurrence follow-up of a
  guarded completion is not re-gated by the caller's guard (the completion
  itself is).
- The local-only exclusion covers notes, content rows, tasks and task lists
  (the latter via the raw `settings.localOnly` column, since the task-list JSON
  model has no `localOnly` field). Notebooks are not filtered by `localOnly`
  because the `notebooks` table has no such column; they are excluded by trash
  state (`notebook()` + the `deleted` flag), and a defensive raw-flag check is
  applied.
- **Bounded-adapter query is implemented, with a conservative truncation rule.**
  `search_notes` candidates come from `Lookup.boundedNoteIds` (two JSON
  parameters + `json_each`; no materialized `IN (...)`), and `truncated` is
  derived only from the final visible set. Because eligibility is a SQL
  snapshot, a candidate that a *live* revocation (a notebook unlink or vault
  lock landing after the query) turns hidden can drop out of the rebuilt
  window, so the response may under-report `truncated` (never over-report it and
  never reveal hidden/revoked overflow). The candidate window is `limit + 1`.
- **`db.transaction` is a pass-through** (`api/index.ts`: the executor is
  `this.sql()`), so a note create/update spans *several* separate writes (the
  content row and its relation side effects, the note row, the history entry,
  and for a create the notebook binding). They are serialized against every
  other note/content/relation writer by the shared domain lease and guarded at
  each boundary, but a crash mid-sequence can leave a partially applied write;
  that half-state is resolved by receipt verification (`reserved`/`uncertain`),
  never claimed as multi-row atomicity.
- **Truncation is not a hidden-hit oracle.** Under-reporting `truncated` when a
  live revocation empties the extra candidate is a deliberate trade-off (see
  above): the alternative — reporting an overflow because a now-hidden hit
  filled the `limit + 1` window — would leak that hidden matches exist.
- The final coherent account read denies an account change that lands after the
  last fence assert, but a same-account ABA across the read still relies on the
  generation-lifecycle contract (documented, not proved by a single read).
- Vault password change re-encrypts notes one critical section at a time; a
  failure mid-way leaves earlier notes already re-encrypted.
- The adapter returns bounded summaries; it is not a general note API (no
  attachments, tags, notebooks or history operations). Connect conversions keep
  ordinary Markdown links, lists and unicode, but **attachment-bearing input is
  rejected up front**: an image carried as a `data:` URI or as a stored
  `data-hash` reference is refused (`UNSUPPORTED_CONTENT`) before a reservation
  is allocated and before any persistence effect, so Connect never crosses the
  attachment save/bind boundary from deep inside the content pipeline (a plain
  `<img>` without an attachment payload is unaffected). An `append_to_note`
  whose *stored* body still carries an inline `data:` image (a body synced from
  an older client not using `data-hash`) is likewise refused
  (`UNSUPPORTED_CONTENT`) in `createReservation`, before the receipt is written,
  so the ordinary pipeline never re-imports it; the stored body and its existing
  attachment relations are left untouched. Internal `nn://` links are still
  processed by the guarded domain pipeline.
- No claim is made that these operations are sufficient for a usable assistant
  surface; that requires the transport/app layer on top of this core, which does
  not exist in this repository state.
- In an isolated worker checkout the focused suite and the whole `packages/core`
  suite were run; the full monorepo build, TypeScript project build, app-level
  and packaging gates were **not** run there and remain for the normal installed
  workspace.
