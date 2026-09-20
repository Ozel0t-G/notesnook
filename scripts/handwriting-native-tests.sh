#!/usr/bin/env bash
# Compiles the native handwriting model/renderer/exporter together with
# apps/mobile/ios/HandwritingTests/main.swift for the iOS simulator and runs
# it there. Requires a booted iOS simulator (any device).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/mobile/ios/Notesnook/Handwriting"
TESTS="$ROOT/apps/mobile/ios/HandwritingTests"
OUT="$(mktemp -d)/handwriting-native-tests"

UDID="${SIMULATOR_UDID:-$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next((x["udid"] for v in d.values() for x in v if x["state"]=="Booted"), ""))')}"
[[ -n "$UDID" ]] || { echo "No booted simulator. Boot one first (xcrun simctl boot <device>)." >&2; exit 1; }

xcrun -sdk iphonesimulator swiftc -target arm64-apple-ios17.0-simulator \
  -o "$OUT" \
  "$SRC/HandwritingMetadata.swift" "$SRC/HandwritingPaper.swift" "$SRC/HandwritingExporter.swift" \
  "$TESTS/main.swift" 2>&1 | grep -v "^$" || true
[[ -x "$OUT" ]] || { echo "Build failed" >&2; exit 1; }
xcrun simctl spawn "$UDID" "$OUT"
