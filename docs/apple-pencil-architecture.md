# Apple Pencil handwriting — architecture

Status: Phase 0 review (repository inspection). Verified against `streetwriters/notesnook` @ `bf909697d`, mobile `3.4.13`.

## 1. Goal

Native PencilKit handwriting on iPad, stored with Notesnook's existing image + attachment model. No new editor node, no new sync/crypto/backend.

## 2. Mobile architecture (verified)

- React Native app in `apps/mobile` (no Expo). JS in `apps/mobile/app`, native iOS project in `apps/mobile/ios`.
- The note editor is a WebView hosting `packages/editor-mobile` (TipTap, built from `packages/editor`). React Native talks to it through `apps/mobile/app/screens/editor/tiptap/commands.ts` (`sendCommand`) and receives events in `use-editor-events.tsx`.
- Shared iPhone/iPad target: `TARGETED_DEVICE_FAMILY = "1,2"`, iOS deployment target 15.6 (PencilKit needs 13+).
- Native code is Objective-C/Objective-C++ (`AppDelegate.mm`, `Make Note/*.m`) plus a small amount of Swift (`File.swift`, `Add to Notes/ShareViewController.swift`, `NotesWidget`); `SWIFT_VERSION = 5.0`, so a Swift native module is viable. There is **no** existing first-party RN native module in `ios/`; native functionality comes from third-party pods.
- iOS targets: `Notesnook` (main), `NotesWidget`, `Add to Notes` (share, Swift), `Make Note` (share, ObjC).
- Bundle IDs, profiles, display name and version are already parametrised in `apps/mobile/ios/build-configs/*.xcconfig` (`IOS_MAIN_BUNDLE_ID`, `IOS_WIDGET_BUNDLE_ID`, `IOS_SHARE_BUNDLE_ID`, `APP_DISPLAY_NAME`, `IOS_MARKETING_VERSION`, `IOS_CURRENT_PROJECT_VERSION`). This is the natural home for the private TestFlight identity and keeps it out of the feature branch.
- `DEVELOPMENT_TEAM = 53CWBG3QUC` is hardcoded in `project.pbxproj` (upstream's team). Must be overridden on the private branch only.

## 3. Editor architecture (verified)

- `image` node (`packages/editor/src/extensions/image/image.ts`): attrs `src`, `width`, `height`, `align`, `hash`, `filename`, `mime`, `size`, `aspectRatio`. Serialised with `data-hash`, `data-filename`, `data-mime`, `data-size`.
- `attachment` node (`extensions/attachment/attachment.ts`): `span[data-hash]` with `hash`, `filename`, `mime`, `size`.
- Commands exposed to RN: `insertImage` and `insertAttachment` (`editor-mobile/src/utils/commands.ts`, `apps/mobile/.../tiptap/commands.ts:182-199`).
- Existing insertion flow: `apps/mobile/app/screens/editor/tiptap/picker.ts`
  1. pick/camera → local temp file
  2. `Sodium.hashFile` → hash
  3. `attachFile()` → `Sodium.encryptFile` + `db.attachments.add(...)`
  4. `commands.insertImage({hash, mime, filename, width, height, dataurl, size, type:"image"})`
  5. temp file unlinked.
  `insertAttachment` follows the same path for non-image files.
  The handwriting flow should reuse `attachFile()` and these commands verbatim.

## 4. Attachment model (verified in `packages/core`)

- Attachments are **content-hash addressed** (`Sodium.hashFile`), not filename addressed. `filename` is metadata only. Identical bytes → same attachment.
- Files are encrypted client-side (`xcha-stream`) before upload; the encryption key is stored in the attachment record. This is the existing E2EE path.
- Note ↔ attachment relations are **derived from note content** on every save: `content.ts → processLinkedAttachments(noteId, hashes)` collects `data-hash` values from the HTML, adds relations for new hashes and **unlinks relations for hashes no longer present**.

### Consequence (key design constraint)

An attachment that is not referenced from the note content is unlinked from the note on the next content save. A bare `handwriting-<UUID>.pkdrawing` attachment that only exists in the attachments table would not stay associated with the note. The question is therefore how to bind the PKDrawing **invisibly** (PNG = visible, PKDrawing = hidden source).

### Investigation of hidden-binding options (in the requested order)

| # | Question | Finding (code-verified) |
|---|---|---|
| 1 | Can an attachment stay linked to a note without a visible node in the content? | **Not via note relations.** `content.ts → processLinkedAttachments` derives note→attachment relations from `data-hash` on `img`/`iframe`/`audio`/`span` in the HTML and unlinks all others on each save. Any element that yields a hash is a rendered node. |
| 2 | Are there hidden/non-rendered attachment references, metadata or relations? | **Yes: generic relations.** `db.relations.add(from, to)` accepts any two `ItemReference`s; `attachment` is a relatable type (`TABLE_MAP`). `Attachment.orphaned` is defined as "no relation row with `toType == "attachment"`" — **from any type**, not only notes. `Attachment.metadata` is deprecated; `Note` has no free-form property bag. |
| 3 | Store the pkdrawing hash in PNG/image-node metadata? | Only through declared node attributes (see 4). The PNG *attachment record* itself has no free field (fixed schema; adding a column would be a sync-schema change). |
| 4 | Extra invisible attribute on the image node (`handwritingSourceHash`, …)? | **Technically possible, but not safe with old clients.** The image node declares a fixed attribute set (`hash`, `filename`, `mime`, `size`, `align`, `width`, `height`, `aspectRatio`). ProseMirror only keeps declared attributes, and clients save `editor.getHTML()` for the whole document — so **any official client that opens and saves the note (even a text edit elsewhere) silently strips the unknown attribute**. Also `postProcess` ignores it for linking. Rejected as sole mechanism. |
| 5 | Can attachment GC treat metadata-referenced attachments as "in use"? | GC is *not automatic*: `removeOrphaned()` is only referenced by tests; app code deletes attachments only on explicit user action (attachment manager → delete / "orphaned" filter) and `bulkRemove`. Because `orphaned` already counts relations from any type, **no GC change is needed** for the relation approach. |
| 6 | Small shared editor/core change acceptable? | Not needed for the recommended option. Kept only as an optional later hardening (see Option C). |

### Alternatives

| | **R — hidden relation (recommended)** | **A — visible attachment node (fallback)** | **B — extra attribute on image node** | **C — declare new attribute in shared editor schema** |
|---|---|---|---|---|
| Mechanism | Save PNG and PKDrawing as attachments; add relation `PNG attachment → PKDrawing attachment` (`db.relations.add({id: pngId, type:"attachment"}, {id: pkdId, type:"attachment"})`). Lookup on edit: image node `hash` → PNG attachment → `relations.from(png,"attachment")`. Recovery fallback: `data-filename` (`handwriting-<UUID>.png`, a declared attribute that survives all clients) → find `handwriting-<UUID>.pkdrawing` in `db.attachments`. | Insert `attachment` node (`span[data-hash]`) beside the image. | `data-handwriting-source-hash` etc. on `<img>`. | Same as B, but declared in `packages/editor` image extension (+ `postProcess` hash collection in core). |
| Files touched | New JS module in `apps/mobile/app/...` only (+ native module). No `packages/*` change. | Mobile JS only. | `packages/editor`, `packages/core`. | `packages/editor`, `packages/core`. |
| Visible on other clients | Nothing in the note. `.pkdrawing` appears only in the Attachments manager list (settings), as a normal file. | File chip in the note. | Nothing. | Nothing (updated clients); stripped by old clients. |
| Old-client compatibility | Relation is a normal synced, E2EE item (`type: relation`); note content is untouched, so official clients open/edit/save the note unchanged. Old clients see the PKDrawing as *linked* (protective). **To be proven against real official clients** (Test A–D). | Full. | **Attribute lost on first save by any old client.** | Lost by clients without the schema change. |
| Attachment cleanup | Protected: relation makes it non-orphaned. Old PNG revisions keep their old PKDrawing linked until the old PNG is removed (`bulkRemove → unlinkOfType` drops the relation), then it becomes orphaned → harmless leak, reclaimable. | Protected via note relation. | **Unprotected** (no relation, attribute ignored by core). | Protected only after core change. |
| Data-loss risk | Low. Worst case: relation lost/not yet synced → PNG still shown, edit disabled, filename-UUID fallback can re-attach; user can only lose the PKDrawing by explicitly deleting it in the attachment manager. | Low; user could delete the visible chip. | **High** (silent stripping + GC). | Medium. |
| Maintenance | Small, isolated; depends on generic relation semantics staying stable (`orphaned`, `unlinkOfType`). | Small. | — | Cross-package; upstream review needed. |

**Decision:** Option **R**. Option A stays as fallback only if the compatibility tests with the official clients show that relations of type attachment→attachment are dropped or rejected. Option C can be proposed upstream later as hardening; B is rejected.

### Proof of concept (core, executed)

`packages/core/__tests__/handwriting-relation.poc.test.ts` (local PoC, not committed) passes on this checkout:

- lookup `image hash → PNG attachment → relations.from(png,"attachment")` returns the PKDrawing,
- PKDrawing is **not** orphaned and **not** linked to the note (nothing visible in the note's attachment list),
- a note content save (`processLinkedAttachments`) does not remove the relation,
- `removeOrphaned()` keeps PNG + PKDrawing,
- after an "edit" (new PNG+PKDrawing, image hash swapped) the old PNG is collected on the first GC pass and the old PKDrawing on the second — self-cleaning, no permanent leak.

Not yet proven: behaviour on real official clients, backup/sync merge (see below).

### Risks of R to verify before relying on it

1. Core unit test: relation `attachment → attachment` survives (a) note content save (`processLinkedAttachments`), (b) `removeOrphaned()`, (c) backup export/import, (d) sync merge.
2. Real-client test (Web) that a note containing such an image still opens, saves and syncs, and that the relation does not surface in any UI as an error.
3. Clean-device test: PKDrawing file is downloadable through the normal attachment layer when the relation and attachment records exist but the file is not cached locally.
4. Ordering: relation and attachment items sync independently; edit action must tolerate "relation present, attachment/file not yet available".

## 5. Data model

```
handwriting-<UUID>.png        image/png                  inline image node (fallback for all clients)
handwriting-<UUID>.pkdrawing  application/octet-stream   hidden attachment, bound by relation (PKDrawing.dataRepresentation())
```

- The UUID is created once and kept across edits; pairing is by filename UUID (attachment `filename`), found through `db.attachments` filename lookup + the note's linked attachments.
- Because attachments are hash-addressed, every edit produces new hashes. "Replace" means: write new PNG + new PKDrawing attachments, swap the hash in the image node, add the new PNG→PKDrawing relation, then let the existing relation processing unlink the old PNG hash. The old attachments are only removed after the new ones are stored (no data loss on failure).
- Missing PKDrawing → show PNG, hide `Edit Handwriting`, never fail the note.

## 6. Native integration plan

- New native module in the main app target only, isolated in `apps/mobile/ios/Notesnook/Handwriting/`:
  - `HandwritingModule` (RN bridge, Swift + ObjC export shim)
  - `HandwritingViewController` (`PKCanvasView` + `PKToolPicker`, full-screen modal, Save/Cancel, undo/redo/clear)
- JS API: `createHandwriting()` and `editHandwriting(pkdrawingPath)` → `{ pngPath, pkdrawingPath, uuid, width, height }`. Files are exchanged as temp **paths**, not base64.
- JS wrapper in `apps/mobile/app/...` guards with `Platform.OS === "ios" && Platform.isPad`; Android/iPhone code paths are untouched.
- Save path: temp files → `Sodium.hashFile` → `attachFile()` (existing E2EE pipeline) → `insertImage` + `insertAttachment` → unlink temp files.
- Edit path: locate paired `.pkdrawing` attachment → existing download/decrypt (`download-attachment`) → temp file → `editHandwriting` → store new pair → update nodes → unlink temp files.

## 7. Existing tests

- `packages/editor/src/extensions/image/tests/image.test.ts`, `packages/core/__tests__`, mobile `apps/mobile/__tests__` and Detox e2e in `apps/mobile/e2e`. New unit tests (UUID pairing, filename detection, platform guard, replace/rollback) go next to the new JS module.

## 8. Open items

- Prove Option R with core tests and real-client tests (section 4, "Risks of R"); fall back to Option A only if it fails.
- Confirm the exact edit-affordance placement in the mobile image tool/menu (still to inspect: `packages/editor/src/toolbar/tools/image.tsx`, `editor-mobile` image actions).
- Toolchain is Xcode 27 beta; verify the untouched RN build works before any feature code (Gate A).
