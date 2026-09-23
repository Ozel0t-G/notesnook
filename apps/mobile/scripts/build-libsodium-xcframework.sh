#!/usr/bin/env bash
set -euo pipefail

# Keep react-native-sodium's API and embedded libsodium version unchanged.
readonly VERSION="1.0.17"
readonly SOURCE_URL="https://github.com/jedisct1/libsodium/archive/refs/tags/1.0.17-RELEASE.tar.gz"
readonly SOURCE_SHA256="709e56e5d3bb34c0fa321283b636b9a992e7181381e5ab43c5571b4255055b08"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly SODIUM_DIR="$MOBILE_DIR/node_modules/@ammarahmed/react-native-sodium/libsodium"
readonly OUTPUT="$SODIUM_DIR/libsodium.xcframework"

[[ -d "$OUTPUT" ]] && exit 0
command -v xcrun >/dev/null || { echo "Xcode is required" >&2; exit 1; }
for tool in autoconf automake glibtoolize; do
  command -v "$tool" >/dev/null || {
    echo "$tool is required to build libsodium ${VERSION} from source" >&2
    exit 1
  }
done

readonly WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notesnook-libsodium.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
readonly ARCHIVE="$WORK_DIR/libsodium-${VERSION}.tar.gz"
readonly SOURCE_DIR="$WORK_DIR/libsodium-${VERSION}-RELEASE"

curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$SOURCE_URL" --output "$ARCHIVE"
echo "${SOURCE_SHA256}  ${ARCHIVE}" | shasum -a 256 --check --status
tar -xzf "$ARCHIVE" -C "$WORK_DIR"
(cd "$SOURCE_DIR" && ./autogen.sh)

build_slice() {
  local sdk="$1"
  local target="$2"
  local build_dir="$WORK_DIR/build-${sdk}"
  local sdk_path clang
  sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"
  clang="$(xcrun --sdk "$sdk" --find clang)"
  mkdir -p "$build_dir"
  (
    cd "$build_dir"
    CC="$clang" \
    CFLAGS="-target ${target} -isysroot ${sdk_path}" \
    CPPFLAGS="-isysroot ${sdk_path}" \
    LDFLAGS="-target ${target} -isysroot ${sdk_path}" \
      "$SOURCE_DIR/configure" --host=arm-apple-darwin --disable-shared --enable-static --with-pic
    make -j"$(sysctl -n hw.ncpu)"
  )
}

build_slice iphoneos arm64-apple-ios15.0
build_slice iphonesimulator arm64-apple-ios15.0-simulator

xcodebuild -create-xcframework \
  -library "$WORK_DIR/build-iphoneos/src/libsodium/.libs/libsodium.a" \
  -headers "$WORK_DIR/build-iphoneos/src/libsodium/include" \
  -library "$WORK_DIR/build-iphonesimulator/src/libsodium/.libs/libsodium.a" \
  -headers "$WORK_DIR/build-iphonesimulator/src/libsodium/include" \
  -output "$OUTPUT"
