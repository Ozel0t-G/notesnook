# Private TestFlight — Notesnook Pencil Beta

**Branch: `personal/testflight` only.** See also `private-testflight-signing.md`.

## Prerequisites

- Paid Apple Developer Program membership, team `QXCNJY73A8`.
- Xcode with the account signed in (Settings → Apple Accounts) **or** an App Store Connect API key (recommended for the CLI, see below).
- An app record in App Store Connect: name **Notesnook Pencil Beta**, iOS, bundle ID `com.ozel0t.note.notesnookpencil`, any unique SKU (e.g. `notesnookpencil`), primary language. Do not touch the official Notesnook app.

## Private identities

| Target | Bundle ID |
|---|---|
| App | `com.ozel0t.note.notesnookpencil` |
| Widget | `com.ozel0t.note.notesnookpencil.widget` |
| Share extension | `com.ozel0t.note.notesnookpencil.share` |
| App Group | `group.com.ozel0t.note.notesnookpencil` |

## Build, archive, upload

```bash
# first build (build number from ios/build-configs/ios-build.pencil.xcconfig)
scripts/build-pencil-testflight.sh

# next builds: bump build number and upload straight to App Store Connect
scripts/build-pencil-testflight.sh --bump --upload
```

Marketing version = upstream Notesnook version (3.4.13), build number is private and incremental. Internal label: *Pencil Beta 1*.

### Headless authentication (no secrets in git)

Create a Team key in App Store Connect (Users and Access → Integrations → App Store Connect API), keep the `.p8` **outside the repository** (e.g. `~/.appstoreconnect/private_keys/`) and export:

```bash
export PENCIL_ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
export PENCIL_ASC_KEY_ID=XXXXXXXXXX
export PENCIL_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

`xcodebuild` then creates/refreshes distribution certificates and profiles through the API instead of the Xcode login.

## Export compliance (needs the account holder)

`ITSAppUsesNonExemptEncryption` is `true` on this branch, so App Store Connect asks the export-compliance questions. Not answered by tooling. Technical facts and recommendation:

- Transport: HTTPS/TLS via the OS networking stack → exempt on its own.
- Data: notes and attachments are encrypted end-to-end with libsodium (XChaCha20-Poly1305, Argon2, X25519) implemented in the app, i.e. encryption beyond what the OS provides and used for protecting user data, not only for authentication/DRM. That is *not* covered by Apple's "exempt" options.
- Recommended answers: uses encryption → **Yes**; algorithms other than / in addition to those in Apple's OS → **Yes**; qualifies for exemption → **No**; standard (non-proprietary) algorithms → **Yes** (mass-market self-classification, ECCN 5D992.c). Consequence: an annual self-classification report to BIS/NSA is the account holder's duty; France may require a declaration for distribution there (not relevant for internal testers).
- This is a legal statement; the account holder must confirm it.

## Internal TestFlight

1. App Store Connect → the app → TestFlight → Internal Testing → new group **Internal Pencil Beta**.
2. Add the account holder / internal tester(s), enable automatic distribution of builds to the group.
3. No External Testing, no public link, no App Store release.
4. Install through the TestFlight app on the iPad.

## Validation checklist (Gate TESTFLIGHT-A / B)

See `apple-pencil-testing.md`. Additionally: clean reinstall from TestFlight, then update Build 1 → Build 2 without data loss.

## Known limitations

- Pods/Xcode 27 beta workaround in `ios/Podfile`.
- In-App Purchases of the official app are unavailable; sign in with an existing account.
- Associated domains removed: universal links open the official app, not this beta.
