# Private TestFlight signing — Notesnook Pencil Beta

Private signing identity for this fork. Build on `test` when a TestFlight upload is explicitly authorized; do not merge release-only signing changes into upstream branches.

Team: `QXCNJY73A8` (individual, paid program). Signing: **Automatic** (Xcode-managed profiles). No keys, `.p12`, profiles or API keys are stored in the repository.

## Targets

| Target | Original Bundle ID | Private Bundle ID | Capabilities | Changes |
|---|---|---|---|---|
| Notesnook (main) | `org.streetwriters.notesnook` | `com.ozel0t.note.notesnookpencil` | App Group, Keychain Sharing | ID via `ios-build.active.xcconfig`, team, automatic signing, associated domains removed |
| NotesWidgetExtension | `org.streetwriters.notesnook.notewidget` | `com.ozel0t.note.notesnookpencil.widget` | none in Release (Debug entitlements file lists the app group) | ID, team, automatic signing |
| Make Note (share extension) | `org.streetwriters.notesnook.share` | `com.ozel0t.note.notesnookpencil.share` | App Group, Keychain Sharing | ID, team, automatic signing |
| Add to Notes | `org.streetwriters.notesnook` (host id string) | — (not a target of the project) | — | host id string updated for consistency |
| Notesnook-tvOS / tests | react-native defaults | unchanged | — | not built |

## Identifiers changed (all literal strings, must match everywhere)

| What | Original | Private |
|---|---|---|
| App Group | `group.org.streetwriters.notesnook` | `group.com.ozel0t.note.notesnookpencil` |
| Keychain access group | `$(AppIdentifierPrefix)group.org.streetwriters.notesnook` | `$(AppIdentifierPrefix)group.com.ozel0t.note.notesnookpencil` |
| Keychain service | `org.streetwriters.notesnook` | `com.ozel0t.note.notesnookpencil` |
| Backup UTI | `org.streetwriters.notesnook.nnbackup` | `com.ozel0t.note.notesnookpencil.nnbackup` |
| Display name | Notesnook | Notesnook Pencil Beta |

Files: `app/utils/constants.ts` (`IOS_APPGROUPID`), `app/common/database/encryption.ts` (keychain group + service), entitlements of main/share/widget/Add to Notes, `Info.plist` of main and Make Note, `Add to Notes/ShareViewController.swift`, `ios/build-configs/ios-build.{active,pencil}.xcconfig`, `project.pbxproj` (team, signing style), `ExportOptionsPencil.plist`.

## Capability audit

| Capability | Status |
|---|---|
| App Groups | kept, private group id |
| Keychain Sharing | kept, private group id (the app stores its encryption key material there, so this must match `encryption.ts`) |
| Associated Domains (`applinks:app.notesnook.com`) | **removed** — a private bundle id cannot be associated with the official domain; universal links keep opening the official app |
| Push / Sign in with Apple / Background modes | not present in the entitlements |
| In-App Purchases | official product ids (`com.streetwriters.notesnook.sub.*`) do not exist for the private app; premium purchase is unavailable in the beta (sign in with an existing account) |
| Extensions | share extension + widget are embedded and need their own app ids (created by automatic signing) |

## Toolchain workarounds also on this branch

- `ios/Podfile`: raises pod deployment targets below 15.0 (Xcode 27 SDK rejects them).
