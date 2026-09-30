#!/usr/bin/env bash
# Adds a Mac Catalyst slice (arm64 + x86_64) to the vendored libsodium.xcframework.
#
# @ammarahmed/react-native-sodium ships libsodium.xcframework with only the
# ios-arm64 and ios-arm64-simulator slices, so the Mac Catalyst build of the
# VeyraN app cannot link libsodium. This script builds the same upstream
# libsodium release (1.0.17, full build) for both Mac Catalyst architectures,
# combines them into one universal static library, and rebuilds the xcframework
# with an extra maccatalyst slice.
#
# The script is idempotent: once the xcframework advertises a maccatalyst slice
# it exits immediately. The original framework is backed up once to
# libsodium.xcframework.orig before it is replaced.
#
# No secrets and no network access are required beyond downloading the pinned
# upstream tarball on first run. Set VEYRAN_LIBSODIUM_CACHE to override the
# cache directory (default: ~/Library/Caches/veyran/libsodium-1.0.17).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS="$(cd "$SCRIPT_DIR/.." && pwd)"
FRAMEWORK="$IOS/../node_modules/@ammarahmed/react-native-sodium/libsodium/libsodium.xcframework"

LIBSODIUM_VERSION=1.0.17
URL="https://download.libsodium.org/libsodium/releases/old/unsupported/libsodium-${LIBSODIUM_VERSION}.tar.gz"
LIBSODIUM_SHA256=0cc3dae33e642cc187b5ceb467e0ad0e1b51dcba577de1190e9ffa17766ac2b1
CACHE_DIR="${VEYRAN_LIBSODIUM_CACHE:-$HOME/Library/Caches/veyran/libsodium-${LIBSODIUM_VERSION}}"
TARBALL="$CACHE_DIR/libsodium-${LIBSODIUM_VERSION}.tar.gz"
CACHED_LIB="$CACHE_DIR/libsodium.a"
CACHED_INCLUDE="$CACHE_DIR/include"

if [[ ! -d "$FRAMEWORK" ]]; then
  echo "libsodium.xcframework not found at $FRAMEWORK; run npm install first." >&2
  exit 1
fi

has_catalyst_slice() {
  local plist
  plist="$(plutil -convert xml1 -o - "$1/Info.plist" 2>/dev/null || true)"
  [[ "$plist" == *"<string>maccatalyst</string>"* ]]
}

if has_catalyst_slice "$FRAMEWORK"; then
  echo "libsodium.xcframework already contains a Mac Catalyst slice; nothing to do."
  exit 0
fi

mkdir -p "$CACHE_DIR"

verify_tarball() {
  local actual
  actual="$(shasum -a 256 "$1" | cut -d' ' -f1)"
  if [[ "$actual" != "$LIBSODIUM_SHA256" ]]; then
    echo "libsodium tarball checksum mismatch for $1" >&2
    echo "  expected: $LIBSODIUM_SHA256" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

if [[ ! -f "$TARBALL" ]]; then
  echo "Downloading libsodium ${LIBSODIUM_VERSION}..."
  curl -fL -o "$TARBALL.part" "$URL"
  mv "$TARBALL.part" "$TARBALL"
fi
verify_tarball "$TARBALL"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

build_arch() {
  # build_arch <arch> <configure-host> <source-dir> <install-prefix>
  local arch="$1" host="$2" srcdir="$3" prefix="$4"
  local sdk cc target cflags ldflags
  sdk="$(xcrun --sdk macosx --show-sdk-path)"
  cc="$(xcrun --sdk macosx -f clang)"
  target="$arch-apple-ios15.0-macabi"
  cflags="-O3 -target $target -isysroot $sdk -iframework $sdk/System/iOSSupport/System/Library/Frameworks"
  ldflags="-target $target -isysroot $sdk -iframework $sdk/System/iOSSupport/System/Library/Frameworks"
  (
    cd "$srcdir"
    CC="$cc" CFLAGS="$cflags" LDFLAGS="$ldflags" \
      ./configure --host="$host" \
        --disable-shared --enable-static --with-pic \
        --disable-dependency-tracking --prefix="$prefix"
    make -j"$(sysctl -n hw.ncpu)"
    make install
  )
}

if [[ -f "$CACHED_LIB" && -d "$CACHED_INCLUDE" ]]; then
  echo "Reusing cached Mac Catalyst libsodium.a from $CACHE_DIR"
  UNIVERSAL_LIB="$CACHED_LIB"
  UNIVERSAL_INCLUDE="$CACHED_INCLUDE"
else
  mkdir -p "$WORK/src-arm64" "$WORK/src-x86_64"
  tar -xzf "$TARBALL" -C "$WORK/src-arm64" --strip-components=1
  tar -xzf "$TARBALL" -C "$WORK/src-x86_64" --strip-components=1

  ARM_PREFIX="$WORK/prefix-arm64"
  X86_PREFIX="$WORK/prefix-x86_64"

  echo "Building libsodium for Mac Catalyst arm64..."
  build_arch arm64 aarch64-apple-darwin "$WORK/src-arm64" "$ARM_PREFIX"
  echo "Building libsodium for Mac Catalyst x86_64..."
  build_arch x86_64 x86_64-apple-darwin "$WORK/src-x86_64" "$X86_PREFIX"

  UNIVERSAL_LIB="$WORK/libsodium.a"
  lipo -create "$ARM_PREFIX/lib/libsodium.a" "$X86_PREFIX/lib/libsodium.a" \
    -output "$UNIVERSAL_LIB"

  mkdir -p "$CACHED_INCLUDE"
  cp -R "$ARM_PREFIX/include/." "$CACHED_INCLUDE/"
  cp "$UNIVERSAL_LIB" "$CACHED_LIB"
  UNIVERSAL_INCLUDE="$CACHED_INCLUDE"
fi

for slice in ios-arm64 ios-arm64-simulator; do
  if [[ ! -f "$FRAMEWORK/$slice/libsodium.a" || ! -d "$FRAMEWORK/$slice/Headers" ]]; then
    echo "Expected existing xcframework slice $slice is missing (libsodium.a or Headers)." >&2
    exit 1
  fi
done

echo "Rebuilding libsodium.xcframework with a Mac Catalyst slice..."
NEW_FRAMEWORK="$WORK/libsodium.xcframework"
xcodebuild -create-xcframework \
  -library "$FRAMEWORK/ios-arm64/libsodium.a" \
  -headers "$FRAMEWORK/ios-arm64/Headers" \
  -library "$FRAMEWORK/ios-arm64-simulator/libsodium.a" \
  -headers "$FRAMEWORK/ios-arm64-simulator/Headers" \
  -library "$UNIVERSAL_LIB" \
  -headers "$UNIVERSAL_INCLUDE" \
  -output "$NEW_FRAMEWORK"

BACKUP="$FRAMEWORK.orig"
if [[ ! -d "$BACKUP" ]]; then
  echo "Backing up original framework to $BACKUP"
  cp -R "$FRAMEWORK" "$BACKUP"
fi
rm -rf "$FRAMEWORK"
cp -R "$NEW_FRAMEWORK" "$FRAMEWORK"

if ! has_catalyst_slice "$FRAMEWORK"; then
  echo "Rebuilt libsodium.xcframework is missing the Mac Catalyst slice." >&2
  exit 1
fi

CATALYST_ID=""
idx=0
while id="$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$idx:LibraryIdentifier" "$FRAMEWORK/Info.plist" 2>/dev/null)"; do
  variant="$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$idx:SupportedPlatformVariant" "$FRAMEWORK/Info.plist" 2>/dev/null || true)"
  if [[ "$variant" == "maccatalyst" ]]; then
    CATALYST_ID="$id"
    break
  fi
  idx=$((idx + 1))
done

if [[ -z "$CATALYST_ID" ]]; then
  echo "Could not locate the Mac Catalyst slice in the rebuilt xcframework." >&2
  exit 1
fi

CATALYST_REL="$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$idx:LibraryPath" "$FRAMEWORK/Info.plist")"
CATALYST_LIB="$FRAMEWORK/$CATALYST_ID/$CATALYST_REL"
ARCHS="$(lipo -info "$CATALYST_LIB")"
if [[ "$ARCHS" != *arm64* || "$ARCHS" != *x86_64* ]]; then
  echo "Catalyst libsodium is not universal: $ARCHS" >&2
  exit 1
fi

echo "Done. libsodium.xcframework now has a Mac Catalyst slice ($CATALYST_ID)."
