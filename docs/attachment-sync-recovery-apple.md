# Apple attachment sync recovery — engineering & QA runbook

Status: implemented on the current branch. This documents behavior that exists in
the tree now; it does not describe or announce a release. Everything below is
scoped to the React Native (Apple) app.

This runbook covers how Notesnook recovers attachments on Apple platforms when a
local ciphertext is missing, corrupt or unverified, and how a failed attachment
is represented, retried and repaired. It is written for engineers and QA reading
the code, not for end users.

## Scope and platform boundary

The recovery machinery is gated on `Platform.OS === "ios"`, which covers
**iPhone/iPad (iOS/iPadOS)** and **Mac Catalyst** (the mobile app built for Mac).
Android keeps its previous upload/download behavior and has none of this logic.
The one shared invariant is that a zero-byte local file is never PUT on any
platform; on Android that guard falls through to the generic pre-PUT failure
path (see step 2 below) with no Apple repair, no Apple marker and no destructive
action.

- All of it lives in `apps/mobile/app/common/filesystem/` (`upload.ts`,
  `download.ts`, `io.ts`, `utils.ts`) plus the core sync/collection code in
  `packages/core/`.
- **Mac Catalyst has no App Group container.** `hasAppGroupContainer()` in
  `apps/mobile/app/utils/constants.ts` returns `false` for Mac Catalyst (and for
  the iOS Simulator), so those processes only ever see the app's own container.
  The App Group fallbacks below are skipped there, and the background uploader
  gets an empty `appGroup` string.
- **The iOS Simulator has no App Group either** because a local Simulator build
  is signed ad hoc without a provisioning profile and installed with empty
  entitlements. Physical iPhone/iPad are unaffected.
- A **local ciphertext is the only local copy** of an attachment. Every code path
  in this document treats deleting it as a last resort, never as a cleanup.

## Local source paths

Ciphertext is addressed by the attachment's **hash** (the file name is the hash).
Three locations are probed, in this order:

| Location | Value | Notes |
| --- | --- | --- |
| `cacheDir` | `LibraryDir/.cache` on iOS; `DocumentDir/.cache` otherwise | Primary. `utils.ts` |
| `cacheDirOld` | `RNFetchBlob`'s `CacheDir` | Legacy; older builds wrote ciphertext here |
| App Group container | `pathForAppGroup(IOS_APPGROUPID)` | iPhone/iPad only; not Mac Catalyst or Simulator |

`getCachePathForFile()` and `exists()` probe all three; `uploadFile()` probes
`cacheDir → cacheDirOld → App Group`. `migrateFilesFromCache()` is the one-time
move from the legacy dir into `cacheDir`; it never `mv`s over an existing
`cacheDir` copy and never unlinks the legacy source when a move fails, so
ciphertext is preserved and a later call can retry.

## Attachment lifecycle

An attachment is **pending** while `dateUploaded IS NULL` (`attachments.ts`,
`get pending`). Uploaded is `dateUploaded` set. A **device-local failure** is a
non-null `failed` string (see below). These are independent: a row can be
uploaded *and* failed, or pending *and* failed.

## Upload: local authentication, then remote verification

`uploadFile()` (`upload.ts`) performs, in order:

1. **Raw presence probe** across the three locations above. A legacy-only
   ciphertext is migrated first so the native cipher can read it from the cache
   dir.
2. **Zero-byte guard + authenticated repair (Apple only)** — a zero-byte local
   file is never valid ciphertext and is never PUT on any platform. On Apple
   platforms the upload first attempts an authenticated local repair (see
   [Authenticated local repair](#authenticated-local-repair-apple-opt-in)); if
   that fails the zero-byte bytes are kept and
   `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR` is recorded. Android has no App Group,
   no native cipher preflight and no authenticated remote repair, so it takes
   the generic pre-PUT failure path instead: no repair download, no Apple
   marker, the local bytes are preserved and the standard failure toast is
   shown.
3. **Plan size check** (`isFeatureAvailable("fileSize", …)`).
4. **Local preflight** — `authenticateLocalCiphertext(filename)`: decrypts the
   local ciphertext with the attachment's own **key/IV/salt/chunkSize** and
   requires the plaintext to have exactly `attachment.size` bytes **and** an
   **xxh64** content hash equal to `attachment.hash`. Any other outcome (no
   attachment row, no key, decrypt error, size/hash mismatch) is never PUT;
   the upload first attempts an authenticated local repair (see below), and only
   if that also fails are the local bytes kept and
   `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR` recorded (after the remote copy was
   actually checked, never before it). No global toast.
5. **PUT / multipart upload** (single-part under 25 MB, multipart at/above it).
6. **`checkUpload()`** — a HEAD request whose `Content-Length` must match the
   expected ciphertext size (plaintext size + 17 bytes per chunk).
7. **Remote re-download verification** (Apple only) — after a successful upload,
   the remote object is re-fetched with `downloadFile(… { forceRemote: true,
   verifyOnly: true, silent: true, skipFailureMark: true })`, decrypted and
   hash-checked. Only then is the upload reported as successful. A verification
   failure returns `false` without touching the local ciphertext, so the next
   sync retries; the attachment is **not** marked uploaded. The verification
   download passes `skipFailureMark`, because that failure is transient and the
   caller (core) owns retries — `downloadFile` must never write a row status of
   its own from a background call.

### Missing local ciphertext → remote recovery → terminal marker

If the ciphertext is in none of the visible locations, an Apple upload does not
immediately give up:

- It calls `downloadFile(… { forceRemote: true, silent: true,
  skipFailureMark: true })`. A successful **authenticated** recovery promotes
  the remote ciphertext into `cacheDir` and `uploadFile()` returns `true` — core
  marks the attachment uploaded and nothing is PUT, overwritten or deleted. The
  recovery download passes `skipFailureMark`, so it never writes a row status
  directly; the caller owns the terminal marker below.
- If recovery fails, `uploadFile()` throws `MISSING_LOCAL_CIPHERTEXT_ERROR`
  (from `@notesnook/core`). Core persists this as the device-local `failed`
  marker and skips the attachment on later syncs instead of looping. Deliberately
  no toast: it is not a user action item.

An App Group container that exists but whose path cannot be resolved is treated
as **unknown**, not missing: the upload defers quietly and core retries later.

### Present-but-invalid local ciphertext → repair → repair-failed marker

When the local ciphertext is *present* but unusable — zero bytes, or present and
failing the preflight — `uploadFile()` never PUTs it. It first attempts the
authenticated local repair above. If a valid local ciphertext now exists
(promoted from an authenticated remote copy) the upload returns `true` and core
marks the attachment uploaded; nothing is overwritten or deleted.

If the repair fails, the invalid local bytes are preserved and `uploadFile()`
throws `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR` (a **distinct** marker from
`MISSING_LOCAL_CIPHERTEXT_ERROR`). The bytes are still on disk, so a raw presence
check would report the attachment as present; core therefore backs this marker
off purely from `dateModified` (30 minutes) and **never** clears it because
`fs().exists()` is `true`. This is what stops a size-valid corrupt local file
from re-running the (network-bound) repair download on every sync. Deliberately
no toast: it is not a user action item.

A zero-byte or truncated file makes `fs().exists()` `false`, and a size-valid
corrupt file makes it `true`; both now get the same 30-minute backoff. A
successful upload, a manual **Retry** or a **Reupload** clears the marker
exactly like the missing marker.

A repair that is only *deferred* because an explicit reupload owns the ciphertext
(see [Concurrency](#concurrency)) must not be recorded as corruption.
`download.ts` collapses its `deferred` and `failed` repair outcomes into a single
`false`, so `uploadFile()` re-checks `isReuploadInFlight()` after a failed repair
and, while a reupload is still in flight, returns `false` (a transient deferral)
instead of throwing the marker. The remaining unfixable case is a reupload that
committed during the download, after which the in-flight flag is already cleared;
that can still be mis-read as a repair failure (see limitations).

## Download: verify before promoting

`downloadFile()` (`download.ts`) downloads to a **unique temp name**
(`<hash>_<random>_temp`) so concurrent invocations cannot clobber each other,
then, before the temp file may replace the original:

- decrypts the temp ciphertext with the attachment's key/IV/size/hash and
  requires plaintext size `== attachment.size` **and** xxh64 `== attachment.hash`.
- On mismatch it marks the attachment failed (unless `skipFailureMark`) and
  discards the temp file.
- `verifyOnly` mode authenticates and then deletes the temp ciphertext, leaving
  any local original completely untouched.
- Otherwise it promotes by moving the temp file into place **only when no
  original exists**; an existing (possibly size-mismatched) original is never
  overwritten with the download.
- The temp file is always cleaned up on failure; the original is never unlinked.

`checkAttachment()` is the manual, non-destructive form of the same check: it
requires internet, builds the same `/s3` request options core uses, and returns
`undefined` when offline, `{ failed }` when the remote object cannot be
authenticated, and `{ success: true }` only after a full download + decrypt +
size + hash match. It produces no toast and no failure mark — the caller owns
both. It always runs in `verifyOnly` mode and therefore never sets
`repairInvalidLocal`, so File Check can never move, overwrite, quarantine or
unlink anything locally.

### Authenticated local repair (Apple, opt-in)

`downloadFile(…, { forceRemote: true, repairInvalidLocal: true, silent: true,
skipFailureMark: true })` is the mode `uploadFile` uses when a local ciphertext exists but is unusable
(zero bytes, or present-but-not-authentic). The mode is ignored without
`forceRemote`, ignored for `verifyOnly`, and ignored on Android, so the default
promotion behavior is byte-identical everywhere else.

After the remote temp has been fully decrypted and matched against the
attachment row, the canonical `cacheDir/<hash>` is authenticated with the same
key/IV/salt/chunkSize and the same plaintext-size/xxh64-hash requirement:

| Local canonical ciphertext | Action |
| --- | --- |
| explicit reupload in flight | defer first: preserve the local bytes, discard the temp, return `false` (checked before every other branch, because a reupload has already vacated the canonical path) |
| attachment row changed during the download | defer: promote/quarantine nothing, discard the temp, return `false` |
| absent | promote the verified temp (`mv`) |
| present **and valid** | leave it completely untouched; discard only the temp |
| present **and invalid** | `mv` it to a fresh, uniquely named protected `<hash>_<random>_repair_quarantine`, then `mv` the verified temp into place |

The attachment row is read once when the download starts and **re-read
immediately before the promotion decision**. The repair download is
network-bound, so an explicit reupload of the same hash can commit its new
key/iv/salt in that window; by promotion time `isReuploadInFlight` is already
`false` again and only the row re-read can tell that the canonical
`cacheDir/<hash>` now holds the reupload's fresh ciphertext. Without it the
fresh bytes would fail the validity probe against the stale row, be quarantined
and the remote *old* ciphertext promoted over them — the ciphertext/metadata
split the reupload protocol exists to prevent. On any (crypto-relevant) row
change, or if the row is gone, the repair fails closed: nothing is moved and
only the verified temp is discarded.

`RNFetchBlob.fs.mv` is NSFileManager `moveItemAtURL`, which fails on an existing
destination, so the canonical path is quarantined first. Every repair writes its
own uniquely named quarantine (`<hash>_<random>_repair_quarantine`, the random
component from `getRandomId`): a quarantine left by an earlier repair is never
overwritten or deleted, so each repair preserves its own previous bytes. Because
the random component sits *before* the suffix, the name still ends in
`_repair_quarantine` and stays protected from the disposable-cache sweeps. If
the promotion fails after quarantine, the old bytes are moved back so the disk
state matches the pre-repair state; if even that fails, the quarantine and the
verified temp are both kept. No valid local ciphertext is ever overwritten or
deleted, and an **unverified** remote object is never promoted.

The raw size check is on the exact `cacheDir` file and runs before any
decryption, because the native cipher treats a zero-byte cache-dir file as
missing and falls back to the App Group: without it a valid App Group copy could
"authenticate" a zero-byte canonical stub (`isLocalCiphertextValidForRow` in
`io.ts`).

The invalid bytes are *preserved*, not deleted: every
`<hash>_<random>_repair_quarantine` is a protected, non-disposable cache name
that `clearCache()` and `deleteDCacheFiles()` never remove, exactly like
`<hash>_reupload_backup`.

## Cache clearing keeps unverifiable copies

`clearCache()` (`io.ts`) deletes a cached ciphertext only when it can be shown to
be re-downloadable:

- an attachment with `!dateUploaded` is **kept** (it cannot be re-downloaded);
- on Apple platforms, an uploaded attachment is deleted **only after
  `checkAttachment()` succeeds**; offline/`undefined`, a failed check or a thrown
  error all mean "keep the local file";
- known disposable artifacts (`imagecache_`, `NN_`, `*.pdf`, `*_dcache`,
  `*_temp`) are removed; `backup_temp`, every `*_reupload_backup` and every
  `*_repair_quarantine` never are;
- an untracked bare-hash file with no attachment row is **kept** — it may be the
  only copy written moments before its row was committed.

## Explicit Reupload: staged, verified, commit-before-delete (Apple)

Explicit Reupload (the attachment menu action in `picker.ts::attachFile` with
`options.reupload`) used to be delete-first: it issued a **remote** `DELETE` and
unlinked the local ciphertext before re-encrypting the picked file. Since
`Sodium.encryptFile` writes the new ciphertext straight to `cacheDir/<hash>` and
unlinks whatever was there, a crash between that write and the `db.attachments`
commit left new ciphertext on disk under old metadata with the old bytes already
gone.

On Apple platforms this is now a staging protocol (`performAppleReupload` in
`io.ts`, called from `picker.ts`); **the server copy is never deleted** and no
request of any kind is made during reupload. Android keeps its previous
delete-first behavior unchanged.

1. **Reconcile** any leftover `<hash>_reupload_backup` from an earlier crash
   (see below).
2. **Stage** — move the current local ciphertext to
   `cacheDir/<hash>_reupload_backup`. If only an App Group copy exists, that copy
   is moved into the backup instead. No-op when there is nothing to preserve.
3. **Encrypt** the picked file with a fresh key to the real `cacheDir/<hash>`
   (native `Sodium.encryptFile`).
4. **Verify** — reject incomplete metadata (`iv`/`salt`/`size`/`hashType`/
   `chunkSize`/`alg`/`key`/`hash`, including `size === 0`, which
   `db.attachments.add` would silently reject), then decrypt the freshly written
   ciphertext with the new key/IV/salt and require the plaintext to have exactly
   the new `size` **and** an xxh64 hash equal to the attachment hash. A failure
   restores the backup and aborts before any metadata is written.
5. **Commit** — a single
   `db.attachments.add({ …, dateUploaded: null, failed: null })` upsert (reuses
   the existing row id, marks it pending, and clears a recovered
   `MISSING_LOCAL_CIPHERTEXT_ERROR` marker in the same write). No separate
   `reset()` call, so there is no intermediate half-committed row. `add()`
   returning `undefined` is treated as a failed commit.
6. **Confirm** — read the row back and require it to carry the new ciphertext's
   `iv`/`salt`/`size`/`chunkSize`/`hashType` and a `key`. The confirmation is
   **crypto-generation only**: it deliberately does *not* require
   `dateUploaded`/`failed` to be cleared, because a concurrent upload of the
   reused row (an earlier queued background upload, or `download.ts`'s direct
   `markAsFailed`) can write a status between `add()` and the read-back.
   Treating that transient status as an uncommitted write would restore the old
   bytes over the already-committed new metadata and split the row. `add()`
   returns the row id even when `SQLCollection.upsert` silently no-ops (an
   unknown table schema makes the sanitizer reject the write), so the return
   value alone is not proof the row landed; a definite **crypto** mismatch is a
   failed commit. After a confirmed match, the stale status is reconciled to
   pending via `Attachments.markReuploadConfirmed(id)` (clears
   `dateUploaded`/`failed`, never the crypto columns); that reconcile is
   self-swallowing, so a status-write failure can never route into the restore
   path.
7. **Drop the backup** only after the upsert has been confirmed.

Any failure up to and including the confirmed upsert restores the old
ciphertext, so the old ciphertext/old metadata pair is never split. When there
was nothing to stage (step 2 was a no-op because no copy existed in `cacheDir`
or the App Group), the failure path instead discards only the newly written
`cacheDir/<hash>` so the old row is not shadowed by partial new bytes — it never
unlinks a legacy (`cacheDirOld`) or App Group copy, and never the server copy.
If the read-back **throws** (not a definite mismatch), the commit is
unconfirmed, so both the backup and the new ciphertext are kept for later
reconciliation; neither is unlinked. The backup is a protected cache name:
`clearCache()` and `deleteDCacheFiles()` never treat it as disposable.

### Backup reconciliation

A leftover `<hash>_reupload_backup` is resolved using the current attachment row
as the source of truth:

| State | Decision |
| --- | --- |
| Backup matches the row | Crash **before** the commit → restore the backup |
| Real `<hash>` matches the row | Crash **after** the commit, before cleanup → drop the backup |
| Neither (or both) match | Ambiguous → **keep both** copies, fail closed |

Restoring a backup unlinks whatever is at the real path first, because
`RNFetchBlob.fs.mv` maps to NSFileManager `moveItemAtURL`, which fails when the
destination exists instead of overwriting it. If that move fails, the backup is
kept and reconciled later, so no bytes are lost.

Reconciliation runs on ordinary paths, not only on a later Reupload: the startup
sweep (`deleteDCacheFiles()` → `reconcileAllReuploadBackups()`), every
`readEncrypted()` and every `uploadFile()`. All of those entries go through
`reconcileReuploadBackup`, which **fails closed (no-op) while an explicit Reupload
of the same hash is in flight**; only the reupload itself passes
`{ force: true }`. So a concurrent read or sweep can never resolve the backup
against the still-old row while the reupload is mid-commit. It never throws and
never unlinks the real ciphertext while the state is ambiguous.

### Concurrency

- While a reupload of a hash is in flight, an `uploadFile()` for the same hash
  fails closed (defers) instead of PUT-ing a half-staged ciphertext.
- A concurrent `readEncrypted()` (reachable from core's `attachments.read()`),
  the startup sweep and any other `reconcileReuploadBackup()` caller also fail
  closed while a reupload of the same hash is in flight: reconciliation is
  skipped, so none of them can mistake the reupload's freshly written new
  ciphertext for an invalid one and `restoreReuploadBackup()` over it. That
  mistake would pair the committed new metadata with the old bytes — the exact
  split this protocol exists to prevent. The read itself still proceeds; if it
  cannot decrypt against the still-old row it keeps the local copy instead of
  deleting it (see `readEncrypted`).
- Two concurrent reuploads of the same hash are serialized by a per-hash lock so
  the second cannot clobber the first's backup.
- A concurrent upload of the reused row writing a status (an earlier queued
  background upload's `markAsFailed`/`markAsUploaded`, or `download.ts`'s direct
  `markAsFailed`) between the reupload's `add()` and its read-back can no longer
  cause a restore: the confirmation is crypto-only, and the transient status is
  reconciled to pending (`Attachments.markReuploadConfirmed`) after the new
  crypto is confirmed. The reconcile is self-swallowing, so it can never route
  into the old-byte restore.

**Fixed — stale results are dropped by a crypto-generation guard:** a
pre-reupload background upload that is still in flight can publish a late
`fileUploaded` *after* the reupload has committed. It can no longer touch the
reused row: `Sync.uploadAttachments()` snapshots the pending row's
`iv`/`salt`/`size`/`chunkSize` into the queue item's `generation`
(`packages/core/src/database/fs.ts`), `FileStorage.queueUploads()` republishes
that generation on **both** the primary and the duplicate `fileUploaded` event
(the duplicate branch carries the *in-flight* operation's generation, not the
newer duplicate request's), and `Attachments.fileUploaded` runs
`markAsUploaded`/`markAsFailed` with a SQL `WHERE` clause matching the row's
*current* crypto against the snapshot. A late pre-reupload success **or**
failure therefore matches zero rows and leaves the new ciphertext's status
untouched.
Every upload `Sync.uploadAttachments()` queues carries the generation — an
incomplete/legacy row (not all four crypto columns present) is snapshotted with
the absent values normalized to `null` (matched with SQL `IS NULL`) instead of
omitting the field, so an incomplete old row is still guarded against a late
result for a newly reuploaded generation. Only non-Sync/manual producers that
omit `generation` from their queue payload keep the previous unguarded
behavior.

## The failed marker is device-local

`failed` is a device-local upload marker and must never sync:

- **Outbound:** the collector's `stripLocalSyncFlags()` strips `failed` (and
  `synced`) from the attachment JSON before it is uploaded
  (`packages/core/src/api/sync/collector.ts`).
- **Inbound:** the merger's `mergeAttachmentFailedMarker()` never adopts a
  remote `failed` value; when the remote item wins it carries this device's own
  marker forward instead, so a sync cannot erase the local failure state
  (`packages/core/src/api/sync/merger.ts`).
- `markAsFailed()` writes or clears `failed` through the collection's `update`,
  which also bumps `dateModified`. When called from the `fileUploaded` handler
  it is passed the upload's crypto generation and only writes if the row's
  current `iv`/`salt`/`size`/`chunkSize` still match (see the reupload section);
  the marker-clear call from `Sync.uploadAttachments()` passes no generation and
  stays unconditioned.

### Transient deferrals write no marker

`FileStorage.queueUploads` (`fs.ts`) publishes `fileUploaded` with
`success: false, error: null` whenever `uploadFile` **resolves** `false` — an
explicit reupload in flight, an unresolvable App Group path, a feature gate, or
a failed post-upload verification. Those are transient deferrals, not durable
failures, so the `Attachments.fileUploaded` handler writes **no** marker for a
falsy `error`: it leaves an existing marker (e.g. `MISSING_LOCAL_CIPHERTEXT_ERROR`
or `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR`) and its 30-minute backoff untouched.
Clobbering the bounded marker with a generic `"Failed to upload attachment."`
would reset `dateModified` and hot-loop the attachment on every sync. A real
`error` string (or `Error`) is still persisted verbatim.

## Automatic retry (30 minutes)

`Sync.uploadAttachments()` (`packages/core/src/api/sync/index.ts`) honours two
device-local local-ciphertext failure markers. Both are skipped until they age
past the same **30-minute** window (`LOCAL_CIPHERTEXT_RETRY_AFTER_MS`) since
`dateModified`, and neither is cleared by an aged retry.

For `failed === MISSING_LOCAL_CIPHERTEXT_ERROR` (the bytes are confirmed gone)
the attachment is skipped **unless**:

- the ciphertext has reappeared (`fs().exists()` is `true`) — the missing marker
  is cleared and the attachment is queued as a normal pending upload; or
- the marker has aged — the upload is queued again *without* clearing the marker,
  so a still-missing ciphertext is simply re-marked.

For `failed === LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR` (the bytes are present but
invalid and the authenticated remote repair failed) the raw presence check is
**deliberately not consulted**: a size-valid corrupt file makes `fs().exists()`
report `true`, which would wrongly clear the marker and re-run the repair every
sync. The attachment is skipped while the marker is fresh and queued again once
it has aged, again *without* clearing the marker.

`dateModified` is bumped by every failed attempt, which is what throttles
retries to one per window. A timestamp that is missing, non-finite or
non-positive is treated as due; a future timestamp within 5 minutes is treated as
fresh (clock skew), and one beyond that is treated as invalid and retried.

## Manual recovery (Settings → Manage attachments → Errors)

In the app: **Settings → Account → Manage account → Manage attachments**, then
the **Errors** filter. The attachment menu (`components/attachments/actions.tsx`)
offers:

- **File Check** (UI label: "Run file check") — runs
  `checkAttachment()`; on failure it marks the attachment failed with the reason
  and shows an error toast, on success it clears the marker and shows a success
  toast. Non-destructive. When the check cannot run at all (offline, so
  `checkAttachment()` returns `undefined`, or `NetInfo.fetch()` rejects) it
  reports the offline state with an error toast. The action clears its loading
  spinner in a `finally`, so it can never be left stuck.
- **Retry** — shown only when the attachment already has a `failed` marker.
  Clears the marker, updates the row and runs `Sync.run("global", true, "send")`.
- **Reupload** — opens the file picker; the picked file's hash must match. On
  Apple it runs the staged/verified protocol above (never a remote delete).

Running the recheck over the **Errors** tab only rechecks rows that are actually
flagged failed (`components/attachments/index.tsx`).

## Plaintext temp cleanup

`Sodium.decryptFile` writes a plaintext artifact (a `_dcache` file). Both the
upload preflight and the download verification unlink it in a `finally` block,
so it is removed whether verification succeeds or fails. `deleteDCacheFiles()`
sweeps any leftovers (`_dcache`, `NN_`, `*.pdf`). Temp ciphertext names end in
`_temp` and are treated as disposable by `clearCache()`.

## Failure categories

| Category | Where it appears | Recovery |
| --- | --- | --- |
| Local ciphertext present but invalid (zero-byte / corrupted) | `uploadFile` zero-byte guard, `authenticateLocalCiphertext` preflight | Never PUT; attempt an authenticated local repair (`repairInvalidLocal`) from the remote object. On success the verified copy is promoted (invalid bytes quarantined). On failure the local bytes are preserved and `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR` is recorded; core backs off for 30 min from `dateModified` regardless of the raw file presence (so a size-valid corrupt file is throttled too), and manual Retry/Reupload clears it |
| Local ciphertext missing everywhere | `uploadFile` after recovery attempt | `MISSING_LOCAL_CIPHERTEXT_ERROR` marker; 30-min retry; manual Retry/Reupload |
| Remote object missing | `checkUpload` / `getUploadedFileSize` / S3 `NoSuchKey` | Stays pending; re-upload on a later sync |
| Remote content unauthenticated (truncated/tampered) | Post-upload verify; `checkAttachment` | Upload not marked successful; local copy kept; manual File Check |
| Encryption key unavailable (no session / key not on this device) | Preflight / download verify | Fail closed; cannot be verified or promoted |
| Offline | `checkAttachment` (`NetInfo`) | Returns `undefined`; the action shows offline feedback and clears its spinner; local copies kept |
| App Group path unresolvable | `uploadFile`, `getAppGroupPath` | Treated as unknown; upload deferred, not marked missing |
| Interrupted explicit Reupload | `<hash>_reupload_backup` in the cache dir | Reconciled on startup/read/upload from the row metadata (restore or drop); ambiguous states fail closed and keep both copies |

## Current limitations (not yet implemented)

These are real gaps, documented so they are not mistaken for finished behavior:

- **No recovery when both local and remote copies are gone.** The terminal
  marker is honest: the bytes exist nowhere recoverable. The only path is
  supplying the original file via Reupload.
- **Rows already carrying the old missing marker are not migrated.** A
  size-valid corrupt local file that an *older* build recorded as
  `MISSING_LOCAL_CIPHERTEXT_ERROR` still hot-loops once: core clears the missing
  marker because `fs().exists()` is `true`, then the failed repair records
  `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR`, which is backed off from then on. No
  migration rewrites pre-existing rows.
- **A reupload that commits *during* a repair download can still be treated as a
  repair failure.** `download.ts` collapses its `deferred` (a reupload owns the
  ciphertext, or the row changed mid-download) and `failed` repair outcomes into
  a single `false`, so `uploadFile()` cannot tell them apart. It re-checks
  `isReuploadInFlight()` after a failed repair and defers transiently while a
  reupload is still in flight, which covers a repair that outlives the reupload's
  in-flight window. If the reupload has already committed by then (its in-flight
  flag is cleared and the row changed), the repair can be mis-read as a failure
  and the now-valid ciphertext gets a 30-minute backoff; a later sync or a manual
  Retry/Reupload clears it. No bytes are lost.
- **Repair quarantines are preserved, never auto-deleted.** A repair that finds
  the canonical ciphertext invalid moves it to a fresh
  `<hash>_<random>_repair_quarantine`. Each repair gets its own name, so an
  earlier quarantine is never overwritten or deleted and every repair preserves
  its own previous bytes. Those bytes are kept as a last-resort copy and are only
  removed by an explicit file-storage wipe (`clearFileStorage`); they are not
  reconciled or garbage-collected automatically, so repeated repairs of one hash
  can leave several quarantines behind (bounded by the number of repair events,
  all preserved by `clearCache()`/`deleteDCacheFiles()`). An interrupted repair
  (crash between quarantine and promote) therefore leaves the old bytes in the
  quarantine and the verified temp / remote copy intact; a later repair or
  download restores a usable `cacheDir/<hash>` (the canonical-absent branch),
  and the leftover quarantine survives untouched.
- **Reupload is not atomic against an already-running background uploader.**
  The per-hash in-flight guard stops a *new* `uploadFile()` during staging, but a
  native background upload that had already opened the previous ciphertext can
  still PUT those bytes. The upload path's post-upload remote verification
  re-authenticates the object and keeps the attachment pending if it does not
  match, so it self-heals on a later sync; there is no lock shared with the
  native uploader.
- **A late pre-reupload `fileUploaded` result is now dropped, not applied.**
  Every `fileUploaded` event produced by `FileStorage.queueUploads` carries the
  `generation` snapshot (`iv`/`salt`/`size`/`chunkSize`) the upload was queued
  for — `Sync.uploadAttachments()` always emits it, normalizing columns missing
  from an incomplete/legacy row to `null` (guarded with SQL `IS NULL`) — and
  `markAsUploaded`/`markAsFailed` gate the status write on the row's current
  crypto via a SQL `WHERE` clause. A background upload that started before the
  reupload and finishes after it commits therefore matches no row, so it can
  neither mark the new ciphertext uploaded nor overwrite its failure marker.
  Only non-Sync/manual producers that omit `generation` stay unguarded.
  Residual: an inbound sync merge that adopts remote crypto for a row
  *before* a legitimate upload result arrives suppresses that result (the row
  is re-queued on the next sync) — a safe false-negative that loses no bytes.
- **Transient absent real path during a restore.** `restoreReuploadBackup`
  unlinks the leftover real-path bytes before moving the backup in (because `mv`
  cannot overwrite). Within that window a concurrent `exists()`/`bulkExists()`
  reader can observe the ciphertext as missing; only `readEncrypted`/`uploadFile`
  are guarded by the in-flight flag, not those presence probes. The backup still
  exists throughout, so no bytes are lost and the next reconcile finishes the
  restore.
- **Unconfirmed commits keep both copies.** If the read-back after the upsert
  throws, the new row's state is unknown, so the backup and the new ciphertext
  are both kept and reconciliation resolves them later from the row metadata
  (which may land in the ambiguous case below).
- **Ambiguous reupload states fail closed, not resolved.** Reconciliation tells
  the two copies apart by authenticating each against the current row
  (`ciphertextMatchesRow`): it decrypts the candidate with the row's
  key/IV/salt/chunkSize and requires the plaintext size and xxh64 hash to match.
  Because every reupload uses a fresh key, an old ciphertext cannot authenticate
  against a post-commit row and vice versa, so an ordinary same-length reupload
  is still resolved (restore the old copy or drop the stale backup). The
  ambiguous, keep-both case is reached only when *neither* copy authenticates
  against the row — e.g. the row key is unavailable/unreadable, or the bytes are
  corrupt or half-written — or when both happen to. No bytes are lost, and every
  reconcile re-derives both candidates from the row, so the state self-heals on
  the next read, upload, or startup sweep once the row key becomes available;
  until then the attachment can stay unreadable. (A fresh Reupload cannot clear
  it: staging refuses to clobber an unresolved backup, and a File Check verifies
  only the remote copy.)
- **App Group relocation.** Staging moves an App-Group-only ciphertext into the
  cache-dir backup. A reader that had already resolved the old App Group path is
  the same residual risk as the background uploader above.
- **The in-flight guard is per process.** The per-hash reupload lock and the
  `isReuploadInFlight` set are module state, so they serialize reupload against
  `readEncrypted`/`uploadFile`/the startup sweep only within one process. A
  second process that can see the same App Group container (a share/notification
  extension, a background upload task) could still enter `reconcileReuploadBackup`
  or `uploadFile` during the window; there is no cross-process file lock. The
  staged backup and the fail-closed "keep both" rule bound the damage (an
  ambiguous state never unlinks a copy). The repair download is additionally
  guarded by the **row re-read** before promotion: a reupload that commits
  (in this or any other process) changes the row's key/iv/salt, so the repair
  defers instead of quarantining the fresh ciphertext and promoting the stale
  remote copy. A cross-process reconcile *before* a commit is still the
  remaining unguarded case.
- **iOS Simulator builds are blocked on Intel hosts by x86_64 libsodium.**
  `apps/mobile/scripts/build-libsodium-xcframework.sh` builds only arm64 slices
  (device + arm64 simulator), so a Simulator build on an Intel Mac has no
  matching libsodium slice. Apple Silicon hosts are unaffected. The Simulator
  also has no App Group container (see scope).

## Targeted tests

```bash
# mobile filesystem unit tests (jest) — upload preflight, remote recovery,
# verify-only downloads, cache clear, concurrency
cd apps/mobile && npx jest app/common/filesystem

# core sync/collection regression (vitest)
npm run tx core:test
# or just these suites:
cd packages/core && npx vitest run src/api/__tests__/missing-local-ciphertext.test.ts __tests__/fs.test.ts

# type checks
cd apps/mobile && npx tsc
cd packages/core && npx tsc --noEmit -p tsconfig.json
```

## Source map

- `apps/mobile/app/common/filesystem/upload.ts` — preflight, remote recovery,
  post-upload verification, `MISSING_LOCAL_CIPHERTEXT_ERROR`,
  `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR`
- `apps/mobile/app/common/filesystem/download.ts` — verified download/promote,
  `checkAttachment()`, `DownloadMode`, the Apple-only authenticated local repair
  (`repairInvalidLocal` / `promoteRepairingInvalidLocal`)
- `apps/mobile/app/common/filesystem/io.ts` — `clearCache()`, `exists()`,
  `getCachePathForFile()`, migration, disposable patterns,
  `isLocalCiphertextValidForRow()`, `REPAIR_QUARANTINE_SUFFIX`, the Apple
  reupload staging/verify/reconcile protocol (`performAppleReupload`,
  `stageReuploadBackup`, `restoreReuploadBackup`, `commitReuploadBackup`,
  `reconcileReuploadBackup`/`reconcileAllReuploadBackups`)
- `apps/mobile/app/common/filesystem/utils.ts` — `cacheDir`, `cacheDirOld`,
  `getAppGroupPath()`, `checkUpload()`
- `apps/mobile/app/utils/constants.ts` — `hasAppGroupContainer()`,
  `getAppGroupIdForNative()`, `getUploaderAppGroup()`
- `apps/mobile/app/components/attachments/{actions,index}.tsx` — manual actions
  and the Errors filter
- `apps/mobile/app/screens/editor/tiptap/picker.ts` — `attachFile()`; Apple
  Reupload delegates to the staged/verified protocol, Android keeps delete-first
- `packages/core/src/api/sync/{index,collector,merger}.ts` — retry window,
  outbound flag stripping, inbound marker preservation, attachment-generation
  snapshot into `queueUploads`
- `packages/core/src/database/fs.ts` — `queueUploads`/`fileUploaded` publishing
  the upload's `generation` (primary and duplicate branches)
- `packages/core/src/collections/attachments.ts` — `markAsFailed`,
  `markAsUploaded` (crypto-generation-guarded status writes), `pending`
- `packages/core/src/common.ts` — `MISSING_LOCAL_CIPHERTEXT_ERROR`,
  `isMissingLocalCiphertextError`, `LOCAL_CIPHERTEXT_REPAIR_FAILED_ERROR`,
  `isLocalCiphertextRepairFailedError`
- `apps/mobile/scripts/build-libsodium-xcframework.sh` — Simulator slice
  limitation
