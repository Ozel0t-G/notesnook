# VeyraN macOS TestFlight

The private macOS build belongs to the existing **VeyraN** App Store Connect
record (Apple ID `6813860928`) and the personal team `QXCNJY73A8`. Apple
requires the same bundle ID for both platforms in one app record, so the macOS
bundle ID is `com.ozel0t.note.notesnookpencil`. The visible app name is VeyraN.
Do not use the upstream `org.streetwriters.notesnook` signing identity or the
upstream Apple ID `1544027013` for this build.

This record ships the **native Mac Catalyst** build of the VeyraN app (the same
three-column Notesnook UI as iOS/iPadOS), built from `apps/mobile/ios`. It is
**not** the Electron desktop app. `scripts/build-macos-testflight.sh` (the old
Electron path) is disabled and must not be used for this record — it once
re-uploaded Electron over the native Catalyst build. There is exactly one
canonical Mac release path: `scripts/build-pencil-testflight.sh --mac`.

## Signing prerequisites

Before uploading, add the macOS platform to the existing VeyraN app record
(Apple ID `6813860928`) in App Store Connect with the shared bundle ID above.
The platform has already been added for the current private beta.

1. Install a **Mac App Distribution** (or **Apple Distribution**) and a **Mac
   Installer Distribution** certificate with their private keys in the login
   keychain. Apple lists the Mac-specific app certificate in Keychain as
   `3rd Party Mac Developer Application` and the installer certificate as
   `3rd Party Mac Developer Installer`.
2. Create a **Mac App Store Connect** distribution provisioning profile for
   `com.ozel0t.note.notesnookpencil`, select the Mac App Distribution certificate,
   and download the `.provisionprofile` file outside the repository.
3. Keep any App Store Connect API key outside the repository. Never commit
   certificates, private keys, or provisioning profiles.

The account also contains cloud-managed distribution certificates. The Mac
Catalyst export requires a locally installed **Apple Distribution** signing
identity with its private key in this Mac's keychain — the legacy local
`3rd Party Mac Developer Application` identity is rejected by Mac App Store
provisioning profiles. The build script pins `signingCertificate` (and
`installerSigningCertificate`) in the export options and fails fast if no
matching `Apple Distribution` identity is found; set `PENCIL_MAC_SIGNING_CERT`
to an explicit SHA-1 only if auto-detection is ambiguous. Do not revoke the
existing team-wide Apple Distribution certificate to make this build.

## Build and upload

The canonical Mac Catalyst command is:

```bash
scripts/build-pencil-testflight.sh --mac --upload
```

`--mac` builds the Mac Catalyst variant of the shared iOS app (the macOS platform
of the same App Store Connect record). Do **not** pass `--bump` on a Mac-only
run: it increments the **iOS** build number, which this build does not need. The
Mac build number is always a fresh Unix-seconds timestamp (`date +%s`) passed to
`xcodebuild` as `CURRENT_PROJECT_VERSION`, which is monotonic and ahead of the
last shipped Mac build. It is never written into the xcconfig, so the iOS build
number is unaffected.

On `--mac` the script prepares libsodium automatically: the vendored
`libsodium.xcframework` has no Mac Catalyst slice, so
`apps/mobile/ios/scripts/libsodium-catalyst.sh` extends it (idempotently) before
`pod install`. On a clean checkout this needs a normal `npm install` first and
one-time network access to fetch the pinned upstream libsodium tarball.

Drop `--upload` to export only; you can then deliver the export with Apple's
Transporter app. For a headless upload, export a personal App Store Connect API
key first and then run the command above:

```bash
export PENCIL_ASC_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_<id>.p8"
export PENCIL_ASC_KEY_ID="<id>"
export PENCIL_ASC_ISSUER_ID="<issuer-id>"
```

The Electron-only `scripts/build-macos-testflight.sh` and
`scripts/upload-macos-testflight.sh` path is retired for this record and must not
be used.

Assign the uploaded macOS build to an internal TestFlight group and install it
from TestFlight on an Apple Silicon Mac. Do not submit this private beta for App
Store review or enable external testing unless requested.

The Mac Catalyst bundle is sandboxed with network access; it claims the app
group `group.com.ozel0t.note.notesnookpencil` shared with the iOS build (see
`apps/mobile/ios/Notesnook/Notesnook-macOS.entitlements`), and its keychain
access group is `$(AppIdentifierPrefix)group.com.ozel0t.note.notesnookpencil`.
`QXCNJY73A8` is the team ID, not part of the app group identifier. It does not
use the upstream app group. It uses the same export-compliance declaration as
the private iOS VeyraN build, `ITSAppUsesNonExemptEncryption = false`, recorded
in `private-testflight.md`.
