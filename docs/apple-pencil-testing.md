# Apple Pencil handwriting — testing

## Automated

```bash
# handwriting helpers + store logic (jest is available in apps/mobile)
cd apps/mobile && npx jest app/services/handwriting

# hidden relation lifecycle, editor, core regression
npm run tx core:test
npm run tx editor:test
```

```bash
# native page model / paper renderer / PNG export, runs in a booted iOS simulator
scripts/handwriting-native-tests.sh
```

Coverage: UUID pairing, filename detection, platform guard (iPad only), drawing source lookup (relation first, filename fallback, missing source), store order (store → link → swap), rollback on failure, temp-file cleanup, relation survives content save and orphan cleanup.

UX iteration: first-level insert menu (only when enabled, not nested in Image), edit overlay eligibility (only handwriting PNGs, iPad, editable), metadata serialize/parse/fallback/version/invalid, three-file store order + rollback, PNG+PKDrawing+metadata relation lifecycle and cleanup (core), and in the simulator: transparent new pages (alpha 0 outside strokes/template, light-theme ink), legacy opaque backgrounds (white, dark, custom), paper (blank/lined/grid/dotted) × spacing (small/medium/large) × light/dark page, strokes above the template, editor paper == exported paper, ink style on dark pages, page extent, tiled export of very long pages.

## Manual (real iPad, Release build — the simulator cannot run this app on iOS 27 arm64 and cannot do Pencil input)

1. Create: note → `+` → Handwriting (one tap, no submenu) → draw (pen, marker, eraser, colours, undo/redo) → Save. PNG appears inline; no file chip in the note.
2. Re-edit: tap the pencil icon at the top right of the image → strokes and page settings restored (old drawings keep their stored opaque background) → change → Save. Image is replaced, not duplicated.
3. Restart app → repeat 2.
4. Web/Desktop/iPhone/Android: only the PNG is visible. Edit text around it on Web → back on iPad the drawing is still editable.
5. iPad edit → Web shows the updated PNG.
6. Clean device: delete app, reinstall, login, sync, open note → Edit handwriting works (proves the PKDrawing is synced).
7. Offline: airplane mode → create → force quit → reopen → edit → reconnect → sync → verify Web and clean device.
8. Failure cases: PKDrawing missing (button hidden, PNG shown), rotation, Split View, Dark Mode, large drawing.
9. Transparent page (new drawing): create → Save → the PNG has no white rectangle; the note background shows through (Web/Desktop/iPhone/Android identical) → reopen via the pencil icon → still transparent → save again.
10. Page settings: paper (lined/grid/dotted) and spacing are selectable and saved; the template is baked into the PNG as semi-transparent lines/dots → reopen → same paper/spacing → save again. There is no background-colour picker any more.
11. Old drawing with an opaque background: opens with its stored background (no picker), exports an opaque PNG exactly as before.
12. Build 1–4 drawing (no metadata): opens as white blank paper, strokes intact; the first save writes the metadata.
