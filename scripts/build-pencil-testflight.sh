#!/usr/bin/env bash
# Builds a private "Notesnook Pencil Beta" archive for TestFlight.
# personal/testflight only. No secrets: signing uses Xcode's automatic signing
# with the account that is signed in to Xcode.
#
# Optional headless auth (recommended; keeps credentials outside the repo):
#   export PENCIL_ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXX.p8
#   export PENCIL_ASC_KEY_ID=XXXX
#   export PENCIL_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Without them xcodebuild uses the account signed in to Xcode.
#
# Usage: scripts/build-pencil-testflight.sh [--bump] [--upload]
#   --bump    increment IOS_CURRENT_PROJECT_VERSION (build number) first
#   --upload  upload the exported build to App Store Connect (destination=upload)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/apps/mobile/ios"
CFG="$IOS/build-configs/ios-build.pencil.xcconfig"
ACTIVE="$IOS/build-configs/ios-build.active.xcconfig"
OUT="${PENCIL_BUILD_DIR:-$HOME/Notesnook/archives}"
BUMP=0; UPLOAD=0
for a in "$@"; do
  case "$a" in
    --bump) BUMP=1 ;;
    --upload) UPLOAD=1 ;;
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
ARCHIVE="$OUT/NotesnookPencil-$VERSION-$BUILD.xcarchive"
EXPORT="$OUT/export-$VERSION-$BUILD"
mkdir -p "$OUT"

AUTH=()
if [[ -n "${PENCIL_ASC_KEY_PATH:-}" ]]; then
  AUTH=(-authenticationKeyPath "$PENCIL_ASC_KEY_PATH" \
        -authenticationKeyID "${PENCIL_ASC_KEY_ID:?}" \
        -authenticationKeyIssuerID "${PENCIL_ASC_ISSUER_ID:?}")
fi

# Editor bundle (embedded in the app)
( cd "$ROOT" && npm run tx editor-mobile:build )

( cd "$IOS" && pod install )

( cd "$IOS" && xcodebuild -workspace Notesnook.xcworkspace -scheme Notesnook \
    -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} archive )

OPTIONS="$IOS/ExportOptionsPencil.plist"
if [[ $UPLOAD -eq 1 ]]; then
  OPTIONS="$(mktemp -t exportoptions).plist"
  cp "$IOS/ExportOptionsPencil.plist" "$OPTIONS"
  /usr/libexec/PlistBuddy -c "Set :destination upload" "$OPTIONS"
fi
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$OPTIONS" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"}

echo "Archive: $ARCHIVE"
echo "Export:  $EXPORT"
