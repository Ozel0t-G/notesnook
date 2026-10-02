#!/usr/bin/env bash
# Builds a private "Notesnook Pencil Beta" archive for TestFlight.
# Private fork builds only. No secrets: signing uses Xcode's automatic signing
# with the account that is signed in to Xcode.
#
# Optional headless auth (recommended; keeps credentials outside the repo):
#   export PENCIL_ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXX.p8
#   export PENCIL_ASC_KEY_ID=XXXX
#   export PENCIL_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Without them xcodebuild uses the account signed in to Xcode.
#
# Mac Catalyst export signing (optional; auto-detected when not set):
#   export PENCIL_MAC_SIGNING_CERT=...        SHA-1 of an "Apple Distribution" identity
#   export PENCIL_MAC_INSTALLER_CERT=...      installer identity (default: "3rd Party Mac Developer Installer")
# Mac App Store profiles for Catalyst only accept "Apple Distribution" certificates,
# but Xcode's export prefers the legacy local "3rd Party Mac Developer Application"
# identity, so --mac pins signingCertificate/installerSigningCertificate explicitly.
#
# Usage: scripts/build-pencil-testflight.sh [--bump] [--archive-only] [--upload] [--mac]
#   --archive-only  stop after the archive (upload it from Xcode's Organizer)
#   --bump    increment IOS_CURRENT_PROJECT_VERSION (build number) first
#   --upload  upload the exported build to App Store Connect (destination=upload)
#   --mac     build/upload the Mac Catalyst variant (macOS platform of the same app)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/apps/mobile/ios"
CFG="$IOS/build-configs/ios-build.pencil.xcconfig"
ACTIVE="$IOS/build-configs/ios-build.active.xcconfig"
OUT="${PENCIL_BUILD_DIR:-$HOME/Notesnook/archives}"
BUMP=0; UPLOAD=0; ARCHIVE_ONLY=0; MAC=0
for a in "$@"; do
  case "$a" in
    --bump) BUMP=1 ;;
    --upload) UPLOAD=1 ;;
    --archive-only) ARCHIVE_ONLY=1 ;;
    --mac) MAC=1 ;;
    *) echo "unknown option: $a" >&2; exit 1 ;;
  esac
done
export LANG=en_US.UTF-8

if [[ $BUMP -eq 1 ]]; then
  current=$(sed -n 's/^IOS_CURRENT_PROJECT_VERSION *= *//p' "$CFG")
  next=$((current + 1))
  sed -i '' "s/^IOS_CURRENT_PROJECT_VERSION *=.*/IOS_CURRENT_PROJECT_VERSION = $next/" "$CFG"
  echo "Build number: $current -> $next"
fi
cp "$CFG" "$ACTIVE"
BUILD=$(sed -n 's/^IOS_CURRENT_PROJECT_VERSION *= *//p' "$CFG")
VERSION=$(sed -n 's/^IOS_MARKETING_VERSION *= *//p' "$CFG")
# Mac Catalyst shares the iOS App Store Connect app and bundle ids, but TestFlight
# for macOS treats build numbers per platform: the Electron Mac builds used unix
# timestamps as CFBundleVersion, so the Mac build number must be a fresh timestamp.
# Passed as a build setting override (not written into the xcconfig).
if [[ $MAC -eq 1 ]]; then
  MAC_BUILD=$(date +%s)
  ARCHIVE="$OUT/NotesnookPencil-mac-$VERSION-$MAC_BUILD.xcarchive"
  EXPORT="$OUT/export-mac-$VERSION-$MAC_BUILD"
else
  ARCHIVE="$OUT/NotesnookPencil-$VERSION-$BUILD.xcarchive"
  EXPORT="$OUT/export-$VERSION-$BUILD"
fi
mkdir -p "$OUT"

AUTH=()
if [[ -n "${PENCIL_ASC_KEY_PATH:-}" ]]; then
  AUTH=(-authenticationKeyPath "$PENCIL_ASC_KEY_PATH" \
        -authenticationKeyID "${PENCIL_ASC_KEY_ID:?}" \
        -authenticationKeyIssuerID "${PENCIL_ASC_ISSUER_ID:?}")
fi

# Resolve the Mac Catalyst signing identity before the long archive step, so a
# missing "Apple Distribution" certificate fails fast. Xcode's export otherwise
# picks the legacy "3rd Party Mac Developer Application" identity, which Mac App
# Store provisioning profiles reject.
MAC_SIGNING_CERT="${PENCIL_MAC_SIGNING_CERT:-}"
if [[ $MAC -eq 1 && $ARCHIVE_ONLY -eq 0 && -z "$MAC_SIGNING_CERT" ]]; then
  # Match the local "Apple Distribution: <name> (<teamID>)" identity by its SHA-1.
  team_id=$(/usr/libexec/PlistBuddy -c "Print :teamID" "$IOS/ExportOptionsPencil.plist" 2>/dev/null || true)
  found=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -E "\"Apple Distribution: .* \(${team_id}\)\"" || true)
  MAC_SIGNING_CERT=$(printf '%s\n' "$found" | grep -Eo '[0-9A-F]{40}' | head -n1 || true)
  if [[ -z "$MAC_SIGNING_CERT" ]]; then
    echo "error: no 'Apple Distribution' code-signing identity for team '${team_id:-?}' was found." >&2
    echo "       Create one in Xcode > Settings > Accounts > Manage Certificates > + > Apple Distribution," >&2
    echo "       then re-run. Alternatively set PENCIL_MAC_SIGNING_CERT to a SHA-1 hash." >&2
    exit 1
  fi
fi
MAC_INSTALLER_CERT="${PENCIL_MAC_INSTALLER_CERT:-3rd Party Mac Developer Installer}"

# Editor bundle (embedded in the app)
( cd "$ROOT" && npm run tx editor-mobile:build )

( cd "$IOS" && pod install )

if [[ $MAC -eq 1 ]]; then
  ( cd "$IOS" && xcodebuild -workspace Notesnook.xcworkspace -scheme Notesnook \
      -configuration Release -destination 'generic/platform=macOS,variant=Mac Catalyst' \
      CURRENT_PROJECT_VERSION="$MAC_BUILD" \
      -archivePath "$ARCHIVE" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} archive )
else
  ( cd "$IOS" && xcodebuild -workspace Notesnook.xcworkspace -scheme Notesnook \
      -configuration Release -destination 'generic/platform=iOS' \
      -archivePath "$ARCHIVE" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} archive )
fi

if [[ $ARCHIVE_ONLY -eq 1 ]]; then echo "Archive: $ARCHIVE"; exit 0; fi

OPTIONS="$IOS/ExportOptionsPencil.plist"
if [[ $MAC -eq 1 || $UPLOAD -eq 1 ]]; then
  OPTIONS="$(mktemp -t exportoptions).plist"
  cp "$IOS/ExportOptionsPencil.plist" "$OPTIONS"
fi
if [[ $UPLOAD -eq 1 ]]; then
  /usr/libexec/PlistBuddy -c "Set :destination upload" "$OPTIONS"
fi
if [[ $MAC -eq 1 ]]; then
  # Mac Catalyst: pin the App Store distribution and installer identities (see above).
  /usr/libexec/PlistBuddy -c "Delete :signingCertificate" "$OPTIONS" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :signingCertificate string $MAC_SIGNING_CERT" "$OPTIONS"
  /usr/libexec/PlistBuddy -c "Delete :installerSigningCertificate" "$OPTIONS" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :installerSigningCertificate string $MAC_INSTALLER_CERT" "$OPTIONS"
fi
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$OPTIONS" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"}

echo "Archive: $ARCHIVE"
echo "Export:  $EXPORT"
if [[ $MAC -eq 1 ]]; then echo "Mac build number: $MAC_BUILD"; fi
