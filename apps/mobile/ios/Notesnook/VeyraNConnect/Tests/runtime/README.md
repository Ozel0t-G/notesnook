# VeyraN Connect runtime transport harness

This is **not** part of the app build. It proves the *actual* production
`URLSession` transport (`VeyraNConnectURLSessionTransport`) against a live,
throwaway loopback HTTPS fixture — the one thing the pure `SecTrust` fixture in
`../VeyraNConnectHarness.swift` cannot prove.

The fixture generates its **own** ephemeral CA + leaf (private keys are created
at run time under a temp directory, mode `0600`, and never committed), writes a
frozen `connection.export.json` in the exact shape the production reader
accepts, and logs every application request to `requests.log`.

Prerequisites: `openssl`, `node`, and a macOS SDK (`xcrun`). Nothing here touches
the personal Keychain, an Apple entitlement, a simulator or a real user file.

## Build

```sh
swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -target arm64-apple-ios18.0-macabi -swift-version 5 -parse-as-library \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectWire.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectSession.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectPairingFile.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectTLS.swift \
  apps/mobile/ios/Notesnook/VeyraNConnect/Tests/runtime/RuntimeMain.swift \
  -o "$TMPDIR/veyran-runtime-harness"
```

## Run a scenario

Each scenario starts a fresh fixture, runs one client scenario, then stops it.
The mode the fixture serves must match the client scenario:

| Fixture `--mode` | Client `VEYRAN_RUNTIME_SCENARIO` | Expected |
| --- | --- | --- |
| `valid` | `valid` | health → session → claim → reply all succeed over real TLS |
| `refuse` | `wrongpin` | `tlsRejected`, `requests.log` empty (zero HTTP) |
| `refuse` | `wrongca` | `tlsRejected`, `requests.log` empty (zero HTTP) |
| `oversized` | `oversized` | `responseInvalid`, aborted before the 5 MiB bound |
| `compressed` | `compressed` | `responseInvalid` (non-`identity` `Content-Encoding`) |
| `redirect` | `redirect` | `responseInvalid` (no redirect followed) |

```sh
RUNTIME_DIR="$TMPDIR/veyran-runtime-fixture"
mkdir -p "$RUNTIME_DIR"

run() { # $1 = fixture mode, $2 = client scenario
  node apps/mobile/ios/Notesnook/VeyraNConnect/Tests/runtime/fixture.mjs \
    --dir "$RUNTIME_DIR" --mode "$1" > "$RUNTIME_DIR/fixture.out" &
  FIXTURE_PID=$!
  for _ in $(seq 1 50); do
    grep -q '^READY ' "$RUNTIME_DIR/fixture.out" 2>/dev/null && break
    sleep 0.1
  done
  VEYRAN_RUNTIME_DIR="$RUNTIME_DIR" VEYRAN_RUNTIME_SCENARIO="$2" \
    "$TMPDIR/veyran-runtime-harness"
  STATUS=$?
  kill "$FIXTURE_PID" 2>/dev/null
  wait "$FIXTURE_PID" 2>/dev/null
  return $STATUS
}

run valid      valid
run refuse     wrongpin
run refuse     wrongca
run oversized  oversized
run compressed compressed
run redirect   redirect
```

Each `run` prints `PASS: N checks` and exits `0`, or `FAIL: …` and exits `1`.

## Provenance / status

Authored by the implementation worker. The Swift harness **compiles cleanly**
(`swiftc` for `arm64-apple-ios18.0-macabi`, no warnings) and the fixture is
`node --check`-clean, but the runtime scenarios were **not executed** in the
authoring environment (it could not create private-key files and so could not
generate the fixture certificates). The coordinator runs them.
