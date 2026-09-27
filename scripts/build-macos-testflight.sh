#!/usr/bin/env bash
# Build the private VeyraN Mac App Store package for TestFlight.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
PROFILE="${VEYRAN_MAC_PROVISIONING_PROFILE:-}"
BUILD_NUMBER="${VEYRAN_MAC_BUILD_NUMBER:-$(date -u +%s)}"

if [[ -z "$PROFILE" || ! -f "$PROFILE" ]]; then
  echo "Set VEYRAN_MAC_PROVISIONING_PROFILE to the VeyraN Mac App Store profile." >&2
  exit 1
fi
if ! [[ "$BUILD_NUMBER" =~ ^[1-9][0-9]{0,9}$ ]] || (( BUILD_NUMBER > 4294967295 )); then
  echo "VEYRAN_MAC_BUILD_NUMBER must be a positive 32-bit integer." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "The VeyraN TestFlight package must be built on an Apple Silicon Mac." >&2
  exit 1
fi
for LIBRARY in \
  "sqlite-better-trigram-darwin-arm64/better-trigram.dylib" \
  "sqlite3-fts5-html-darwin-arm64/fts5-html.dylib"; do
  if [[ ! -f "$DESKTOP/node_modules/$LIBRARY" ]]; then
    echo "Missing required Apple Silicon library: $LIBRARY" >&2
    exit 1
  fi
done

export VEYRAN_MAC_BUILD_NUMBER="$BUILD_NUMBER"
export VEYRAN_MAC_PROVISIONING_PROFILE="$PROFILE"

if [[ ! -f "$ROOT/apps/web/build/index.html" ]]; then
  echo "Build the desktop web app first: npm run tx @notesnook/web:build:desktop" >&2
  exit 1
fi

cd "$DESKTOP"
npm run build
node "$DESKTOP/scripts/patch-better-sqlite3.mjs"

rm -rf build
cp -R ../web/build build
npm run bundle:mas -- --outdir="$DESKTOP/build"
rm -f "$DESKTOP/output/testflight-macos/mas-arm64/VeyraN-${BUILD_NUMBER}-arm64.pkg"
./node_modules/.bin/electron-builder --config=electron-builder.testflight.config.js --mac mas:arm64 --publish never

PACKAGE="$DESKTOP/output/testflight-macos/mas-arm64/VeyraN-${BUILD_NUMBER}-arm64.pkg"
if [[ ! -f "$PACKAGE" ]]; then
  echo "Expected package missing: $PACKAGE" >&2
  exit 1
fi
APP="$DESKTOP/output/testflight-macos/mas-arm64/VeyraN.app"
if [[ ! -d "$APP" ]]; then
  echo "Expected signed app missing: $APP" >&2
  exit 1
fi
ICONSET="$(mktemp -d)"
PROFILE_INFO="$(mktemp)"
ENTITLEMENTS_INFO="$(mktemp)"
trap 'rm -rf "$ICONSET" "$PROFILE_INFO" "$ENTITLEMENTS_INFO"' EXIT
iconutil --convert iconset --output "$ICONSET/icon.iconset" "$APP/Contents/Resources/icon.icns"
if [[ ! -f "$ICONSET/icon.iconset/icon_512x512@2x.png" ]]; then
  echo "The app icon is missing the required 512pt @2x macOS image." >&2
  exit 1
fi
TEAM="$(codesign -dv --verbose=4 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
if [[ "$TEAM" != "QXCNJY73A8" ]]; then
  echo "Unexpected signing team: $TEAM" >&2
  exit 1
fi
codesign -d --entitlements :- "$APP" > "$ENTITLEMENTS_INFO" 2>/dev/null
APP_GROUP="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups:0' "$ENTITLEMENTS_INFO")"
if [[ "$APP_GROUP" != "QXCNJY73A8.com.ozel0t.note.notesnookpencil" ]]; then
  echo "The app is missing its sandboxed Electron process group." >&2
  exit 1
fi
SIGNATURE="$(codesign -dv --verbose=4 "$APP" 2>&1)"
if ! grep -Eq '^Authority=(Apple Distribution:|3rd Party Mac Developer Application:)' <<< "$SIGNATURE"; then
  echo "The app is not signed with a Mac App Store distribution certificate." >&2
  exit 1
fi
PLIST="$APP/Contents/Info.plist"
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")" != "com.ozel0t.note.notesnookpencil" ]] || \
   [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")" != "$BUILD_NUMBER" ]] || \
   [[ "$(/usr/libexec/PlistBuddy -c 'Print :ElectronTeamID' "$PLIST")" != "QXCNJY73A8" ]]; then
  echo "The signed app has the wrong bundle ID, build number, or Electron team ID." >&2
  exit 1
fi
EMBEDDED="$APP/Contents/embedded.provisionprofile"
if [[ ! -f "$EMBEDDED" ]]; then
  echo "The signed app has no embedded Mac App Store provisioning profile." >&2
  exit 1
fi
security cms -D -i "$EMBEDDED" > "$PROFILE_INFO"
PROFILE_APP_ID="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "$PROFILE_INFO")"
if [[ "$PROFILE_APP_ID" != "QXCNJY73A8.com.ozel0t.note.notesnookpencil" ]]; then
  echo "The embedded provisioning profile belongs to a different app: $PROFILE_APP_ID" >&2
  exit 1
fi
PROFILE_GROUPS="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.security.application-groups' "$PROFILE_INFO")"
if ! grep -qF 'QXCNJY73A8.*' <<< "$PROFILE_GROUPS" && \
   ! grep -qF 'QXCNJY73A8.com.ozel0t.note.notesnookpencil' <<< "$PROFILE_GROUPS"; then
  echo "The profile does not permit VeyraN's sandboxed Electron process group." >&2
  exit 1
fi
codesign --verify --strict --verbose=2 "$APP"
PACKAGE_SIGNATURE="$(pkgutil --check-signature "$PACKAGE")"
if ! grep -q '3rd Party Mac Developer Installer:' <<< "$PACKAGE_SIGNATURE"; then
  echo "The installer is not signed with a Mac Installer Distribution certificate." >&2
  exit 1
fi
echo "$PACKAGE_SIGNATURE"
echo "$PACKAGE"
