# Apple Pencil handwriting — maintenance

Touch points (keep in sync when rebasing):

- iOS native: `apps/mobile/ios/Notesnook/Handwriting/` (module, view controller, `HandwritingMetadata`, `HandwritingPaper`, `HandwritingExporter`), bridging header import, `project.pbxproj` entries, native tests in `apps/mobile/ios/HandwritingTests` (`scripts/handwriting-native-tests.sh`)
- JS: `apps/mobile/app/services/handwriting/`, `screens/editor/tiptap/{picker,commands,use-editor-events}`, `screens/editor/index.tsx` (`globalThis.handwriting`)
- Metadata schema and presets exist in JS (`metadata.ts`) **and** Swift (`HandwritingMetadata.swift`): change both together.
- Editor: `packages/editor` (first-level insert item, edit overlay in the image node view, `editHandwriting` tool, props), `packages/editor-mobile` (event, controller, `replaceImage`), `packages/intl/src/strings.ts` (two strings appended at the end to keep `.po` diffs small)

Assumptions that must keep holding (covered by `packages/core/__tests__/handwriting-relation.test.ts`):

- `db.relations.add` accepts attachment → attachment
- `Attachments.orphaned` counts relations from any type
- `processLinkedAttachments` only touches note → attachment relations

Rebase:

```bash
git fetch upstream
git checkout feature/apple-pencil
git rebase upstream/master
git checkout personal/testflight
git rebase feature/apple-pencil
```

Then run the tests, rebuild `editor-mobile` (`npm run tx editor-mobile:build`) and create a new TestFlight build.
