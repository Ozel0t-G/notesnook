#!/usr/bin/env bash
# Validate and upload a signed VeyraN macOS package to the private app record.
set -euo pipefail

PACKAGE="${1:?Pass the VeyraN .pkg path as the first argument.}"
KEY_PATH="${VEYRAN_ASC_KEY_PATH:-}"
KEY_ID="${VEYRAN_ASC_KEY_ID:-}"
ISSUER_ID="${VEYRAN_ASC_ISSUER_ID:-}"

if [[ ! -f "$PACKAGE" ]]; then
  echo "Package not found: $PACKAGE" >&2
  exit 1
fi
if [[ ! -f "$KEY_PATH" || -z "$KEY_ID" || -z "$ISSUER_ID" ]]; then
  echo "Set VEYRAN_ASC_KEY_PATH, VEYRAN_ASC_KEY_ID and VEYRAN_ASC_ISSUER_ID." >&2
  exit 1
fi

NAME="$(basename "$PACKAGE")"
if [[ ! "$NAME" =~ ^VeyraN-([1-9][0-9]{0,9})-arm64\.pkg$ ]]; then
  echo "Package name does not match the private VeyraN macOS build." >&2
  exit 1
fi
BUILD_NUMBER="${BASH_REMATCH[1]}"
if (( BUILD_NUMBER > 4294967295 )); then
  echo "The package build number is outside the supported range." >&2
  exit 1
fi
APP="$(dirname "$PACKAGE")/VeyraN.app"
PLIST="$APP/Contents/Info.plist"
if [[ ! -f "$PLIST" ]]; then
  echo "Signed app missing beside package: $APP" >&2
  exit 1
fi
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
ACTUAL_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")"
ACTUAL_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")"
if [[ "$ACTUAL_BUILD" != "$BUILD_NUMBER" || "$ACTUAL_ID" != "com.ozel0t.note.notesnookpencil" ]]; then
  echo "Package name and signed VeyraN app metadata do not match." >&2
  exit 1
fi

xcrun altool --validate-app "$PACKAGE" \
  --api-key "$KEY_ID" --api-issuer "$ISSUER_ID" --p8-file-path "$KEY_PATH"

xcrun altool --upload-package "$PACKAGE" \
  --api-key "$KEY_ID" --api-issuer "$ISSUER_ID" --p8-file-path "$KEY_PATH" \
  --apple-id 6813860928 \
  --bundle-id com.ozel0t.note.notesnookpencil \
  --bundle-short-version-string "$VERSION" \
  --bundle-version "$BUILD_NUMBER" --wait
