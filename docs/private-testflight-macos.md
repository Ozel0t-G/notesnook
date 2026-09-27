# VeyraN macOS TestFlight

The private macOS build belongs to the existing **VeyraN** App Store Connect
record (Apple ID `6813860928`) and the personal team `QXCNJY73A8`. Apple
requires the same bundle ID for both platforms in one app record, so the macOS
bundle ID is `com.ozel0t.note.notesnookpencil`. The visible app name is VeyraN.
Do not use the upstream `org.streetwriters.notesnook` signing identity or the
upstream Apple ID `1544027013` for this build.

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

The account also contains cloud-managed distribution certificates. The local
Electron build requires signing identities with private keys in this Mac's
keychain, so the cloud-managed entries do not satisfy step 1. Do not revoke
the existing team-wide Apple Distribution certificate to make this build.

## Build and upload

Build the desktop web app when source files have changed:

```bash
npm run tx @notesnook/web:build:desktop
```

Then build the Apple Silicon Mac App Store package:

```bash
export VEYRAN_MAC_PROVISIONING_PROFILE="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/<profile>.provisionprofile"
scripts/build-macos-testflight.sh
```

The script selects a new Unix-seconds build number. To reproduce a build,
set `VEYRAN_MAC_BUILD_NUMBER` explicitly. The package is written to
`apps/desktop/output/testflight-macos/mas-arm64/` and is never published by the build
script. Validate the signed app and profile before upload:

```bash
codesign --verify --strict --verbose=2 apps/desktop/output/testflight-macos/mas-arm64/VeyraN.app
codesign -d --entitlements :- apps/desktop/output/testflight-macos/mas-arm64/VeyraN.app
security cms -D -i "$VEYRAN_MAC_PROVISIONING_PROFILE"
```

Upload the generated `.pkg` to the **VeyraN** app record using Apple's
Transporter app while signed into the account with access to VeyraN. Drag the
package into Transporter and choose **Deliver**. As an alternative, use a
personal App Store Connect API key with the command below when API access is
available:

```bash
export VEYRAN_ASC_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_<id>.p8"
export VEYRAN_ASC_KEY_ID="<id>"
export VEYRAN_ASC_ISSUER_ID="<issuer-id>"
scripts/upload-macos-testflight.sh apps/desktop/output/testflight-macos/mas-arm64/VeyraN-<build>-arm64.pkg
```

The upload script validates before uploading and waits for Apple processing.
After processing, assign the macOS build to an internal TestFlight group and
install it from TestFlight on an Apple Silicon Mac. Do not submit this private
beta for App Store review or enable external testing unless requested.

Apple's Transporter checks that `icon.icns` in the app bundle contains a
512-point @2x image. The build script checks this before presenting a package
as ready for upload.

This first package supports Apple Silicon Macs running macOS 13 or later. The
TestFlight package uses App Sandbox with network access, user-selected file
read/write and printing. It claims only its own team-prefixed app group,
`QXCNJY73A8.com.ozel0t.note.notesnookpencil`, for Electron's sandboxed
process communication; the provisioning profile permits this through its
`QXCNJY73A8.*` wildcard. It does not use the upstream app group. The app uses
the existing `/Documents/Notesnook/` sandbox exception for its default backup
directory. The helper-process entitlements retain the upstream library
validation exception needed by the Electron build. The app uses
the same export-compliance declaration as the private iOS VeyraN build,
`ITSAppUsesNonExemptEncryption = false`, recorded in `private-testflight.md`.
