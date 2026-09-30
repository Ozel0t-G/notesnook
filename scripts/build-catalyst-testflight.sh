#!/usr/bin/env bash
# Builds a private "VeyraN" Mac Catalyst archive for TestFlight.
# Private fork builds only. No secrets: signing uses Xcode's automatic signing
# with the account that is signed in to Xcode.
#
# The Mac Catalyst build uses its own bundle identifiers (com.ozel0t.note.
# notesnookpencil.mac*) so it never collides with the Electron Mac app that
# owns com.ozel0t.note.notesnookpencil.
#
# Optional headless auth (recommended; keeps credentials outside the repo):
#   export PENCIL_ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXX.p8
#   export PENCIL_ASC_KEY_ID=XXXX
#   export PENCIL_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Without them xcodebuild uses the account signed in to Xcode.
#
# Usage: scripts/build-catalyst-testflight.sh [--bump] [--archive-only] [--upload]
#   --archive-only  stop after the archive (upload it from Xcode's Organizer)
#   --bump    increment IOS_CURRENT_PROJECT_VERSION (build number) first
#   --upload  upload the exported build to App Store Connect (destination=upload)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/apps/mobile/ios"
CFG="$IOS/build-configs/ios-build.pencil.xcconfig"
ACTIVE="$IOS/build-configs/ios-build.active.xcconfig"
OUT="${PENCIL_BUILD_DIR:-$HOME/Notesnook/archives}"
BUMP=0; UPLOAD=0; ARCHIVE_ONLY=0
for a in "$@"; do
  case "$a" in
    --bump) BUMP=1 ;;
    --upload) UPLOAD=1 ;;
    --archive-only) ARCHIVE_ONLY=1 ;;
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
ARCHIVE="$OUT/VeyraNMac-$VERSION-$BUILD.xcarchive"
EXPORT="$OUT/export-mac-$VERSION-$BUILD"
mkdir -p "$OUT"

AUTH=()
if [[ -n "${PENCIL_ASC_KEY_PATH:-}" ]]; then
  AUTH=(-authenticationKeyPath "$PENCIL_ASC_KEY_PATH" \
        -authenticationKeyID "${PENCIL_ASC_KEY_ID:?}" \
        -authenticationKeyIssuerID "${PENCIL_ASC_ISSUER_ID:?}")
fi

# Editor bundle (embedded in the app)
( cd "$ROOT" && npm run tx editor-mobile:build )

# libsodium has no Mac Catalyst slice; add one before CocoaPods reads the podspec.
"$IOS/scripts/libsodium-catalyst.sh"

( cd "$IOS" && pod install )

( cd "$IOS" && xcodebuild -workspace Notesnook.xcworkspace -scheme Notesnook \
    -configuration Release -destination 'generic/platform=macOS,variant=Mac Catalyst' \
    -archivePath "$ARCHIVE" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} archive )

if [[ $ARCHIVE_ONLY -eq 1 ]]; then echo "Archive: $ARCHIVE"; exit 0; fi

OPTIONS="$IOS/ExportOptionsCatalyst.plist"
if [[ $UPLOAD -eq 1 ]]; then
  OPTIONS="$(mktemp -t exportoptions).plist"
  cp "$IOS/ExportOptionsCatalyst.plist" "$OPTIONS"
  /usr/libexec/PlistBuddy -c "Set :destination upload" "$OPTIONS"
fi
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$OPTIONS" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"}

echo "Archive: $ARCHIVE"
echo "Export:  $EXPORT"
