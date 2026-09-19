# Apple Pencil handwriting — testing

## Automated

```bash
# handwriting helpers + store logic (jest is available in apps/mobile)
cd apps/mobile && npx jest app/services/handwriting

# hidden relation lifecycle, editor, core regression
npm run tx core:test
npm run tx editor:test
```

Coverage: UUID pairing, filename detection, platform guard (iPad only), drawing source lookup (relation first, filename fallback, missing source), store order (store → link → swap), rollback on failure, temp-file cleanup, relation survives content save and orphan cleanup.

## Manual (real iPad, Release build — the simulator cannot run this app on iOS 27 arm64 and cannot do Pencil input)

1. Create: note → Insert → Image → Handwriting → draw (pen, marker, eraser, colours, undo/redo) → Save. PNG appears inline; no file chip in the note.
2. Re-edit: select the image → Edit handwriting → strokes restored → change → Save. Image is replaced, not duplicated.
3. Restart app → repeat 2.
4. Web/Desktop/iPhone/Android: only the PNG is visible. Edit text around it on Web → back on iPad the drawing is still editable.
5. iPad edit → Web shows the updated PNG.
6. Clean device: delete app, reinstall, login, sync, open note → Edit handwriting works (proves the PKDrawing is synced).
7. Offline: airplane mode → create → force quit → reopen → edit → reconnect → sync → verify Web and clean device.
8. Failure cases: PKDrawing missing (button hidden, PNG shown), rotation, Split View, Dark Mode, large drawing.
