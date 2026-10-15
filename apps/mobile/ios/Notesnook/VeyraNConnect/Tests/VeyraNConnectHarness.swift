/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// Standalone regression harness for the pure VeyraN Connect native client.
//
// It links the real production files (Wire, Session, PairingFile, PairGate,
// Lifecycle, TLS) — never the React/UIKit module or the Keychain — so it needs
// no app, entitlements or simulator. It exercises the exact state machine the
// module drives: JSON/pairing bounds, canonical base64url, the closed URL/route
// map, the nonce sequence, single outstanding-claim correlation, cancellation,
// the symlink-safe file reader, the pairing/lifecycle gate, the single
// lifecycle linearization primitive (with an injected synthetic credential
// store, an injected engine factory and real concurrent threads), and a real
// TLS chain/leaf-pin evaluation against a self-signed test root.
//
// It reads and writes only its own temporary files under the injectable
// `VEYRAN_HARNESS_DIR` (defaulting to the system temporary directory) and never
// touches the personal Keychain or any user file.
//
// Mac Catalyst is used because the production helpers are Foundation/Security
// only and compile there:
//
//   swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
//     -target arm64-apple-ios18.0-macabi \
//     -parse-as-library \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectWire.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectSession.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectPairingFile.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectPairGate.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectLifecycle.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectTLS.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/Tests/VeyraNConnectHarness.swift \
//     -o "$TMPDIR/veyran-connect-harness" \
//   && "$TMPDIR/veyran-connect-harness"

import Foundation
import Security

// A real, throwaway test chain (self-signed root + leaf with SAN IP:127.0.0.1),
// generated only for this harness. The private keys are not part of this file.
private let testRootPem = """
-----BEGIN CERTIFICATE-----
MIIBizCCATGgAwIBAgIUJMYQW+6QNgDEw4V5x0R6uv7/dOgwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQVmV5cmFOIFRlc3QgUm9vdDAeFw0yNjEwMTEwODM2NTVaFw0z
NjEwMDgwODM2NTVaMBsxGTAXBgNVBAMMEFZleXJhTiBUZXN0IFJvb3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAATAU+BqM8z/YSNrgLrpHtSHedDK2Cml9ns/mE7P
0gJ1erct/4CWuC8A/SML7CO3oYBYhIwrBDdHoV6tUC8aXGpAo1MwUTAdBgNVHQ4E
FgQU+ZvhtemMfHnf4PAa+qsAAIKZ900wHwYDVR0jBBgwFoAU+ZvhtemMfHnf4PAa
+qsAAIKZ900wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA46TH
JosStfLtgUfgmmtFqYQK4u7poHE2ElK6fCpTd78CIDxGJdOvBkxxmMKyXBYDwg1s
A3prKEtw1FbVo8p3BHTi
-----END CERTIFICATE-----
"""

private let testLeafPem = """
-----BEGIN CERTIFICATE-----
MIIBozCCAUqgAwIBAgIUIjrlhv3SqdnwWZPrKUUeRK/S++AwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQVmV5cmFOIFRlc3QgUm9vdDAeFw0yNjEwMTEwODM2NTVaFw0y
OTAxMTMwODM2NTVaMBQxEjAQBgNVBAMMCTEyNy4wLjAuMTBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABB8J1u/ku5FeBDaTxmIXalDUZlg9s3ZXLzazbD1svC0rpeJa
Lo58yuv/8leR6u+GXHpEiMdhcKsL1H62+/o35kGjczBxMA8GA1UdEQQIMAaHBH8A
AAEwEwYDVR0lBAwwCgYIKwYBBQUHAwEwCQYDVR0TBAIwADAdBgNVHQ4EFgQUcoV6
+AZheZFG7uRhGWyoLl5dp+4wHwYDVR0jBBgwFoAU+ZvhtemMfHnf4PAa+qsAAIKZ
900wCgYIKoZIzj0EAwIDRwAwRAIgVxwlYZBGh7Vt5+a3CFfemTMRcnxhh5o3WeAL
QJPOdlgCIC2x4SfbozaWWWRJ6ZfxuPfQ1sQp92pOw9aoBj1zf3UV
-----END CERTIFICATE-----
"""

// MARK: - helpers

/// A synchronous scoped lock helper, so no `NSLock` is ever held across an
/// `await` (and no lock/unlock is called from an async context).
@inline(__always)
private func withLock<T>(_ lock: NSLock, _ body: () throws -> T) rethrows -> T {
  lock.lock()
  defer { lock.unlock() }
  return try body()
}

private final class ScriptedTransport: VeyraNConnectTransport {
  typealias Handler = (String, Data) throws -> Data
  private let handler: Handler
  private(set) var sentPaths: [String] = []
  private(set) var sentBodies: [Data] = []
  private let lock = NSLock()

  init(_ handler: @escaping Handler) { self.handler = handler }

  func send(path: String, body: Data, timeout: TimeInterval) async throws -> Data {
    withLock(lock) {
      sentPaths.append(path)
      sentBodies.append(body)
    }
    return try handler(path, body)
  }

  func lastBody() -> [String: Any]? {
    withLock(lock) {
      guard let data = sentBodies.last else { return nil }
      return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
  }
}

private func jsonObject(_ data: Data) -> [String: Any]? {
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

private func successEnvelope(_ result: Any) -> Data {
  return try! JSONSerialization.data(withJSONObject: ["ok": true, "result": result])
}

/// A transport whose handler may suspend, so a test can invalidate the engine
/// while a handshake/claim/reply is genuinely in flight.
private final class AsyncTransport: VeyraNConnectTransport {
  typealias Handler = (String, Data) async throws -> Data
  private let handler: Handler

  init(_ handler: @escaping Handler) { self.handler = handler }

  func send(path: String, body: Data, timeout: TimeInterval) async throws -> Data {
    try await handler(path, body)
  }
}

/// One-shot asynchronous signal (its own lock; never held across a suspension).
private final class AsyncSignal {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?
  private var signaled = false

  func signal() {
    let continuation = withLock(lock) { () -> CheckedContinuation<Void, Never>? in
      signaled = true
      let pending = self.continuation
      self.continuation = nil
      return pending
    }
    continuation?.resume()
  }

  func waitAsync() async {
    if withLock(lock, { signaled }) { return }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.lock()
      if signaled {
        lock.unlock()
        continuation.resume()
        return
      }
      self.continuation = continuation
      lock.unlock()
    }
  }
}

/// A gate that starts closed and can be opened once, releasing every waiter.
private final class AsyncGate {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?
  private var opened = false

  func open() {
    let continuation = withLock(lock) { () -> CheckedContinuation<Void, Never>? in
      opened = true
      let pending = self.continuation
      self.continuation = nil
      return pending
    }
    continuation?.resume()
  }

  func waitAsync() async {
    if withLock(lock, { opened }) { return }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.lock()
      if opened {
        lock.unlock()
        continuation.resume()
        return
      }
      self.continuation = continuation
      lock.unlock()
    }
  }
}

/// A clock the harness can advance without waiting in real time.
private final class MutableClock: VeyraNConnectClock {
  private let lock = NSLock()
  private var date: Date

  init(_ date: Date) { self.date = date }

  func now() -> Date {
    lock.lock()
    defer { lock.unlock() }
    return date
  }

  func advance(_ seconds: TimeInterval) {
    lock.lock()
    date = date.addingTimeInterval(seconds)
    lock.unlock()
  }
}

private let pairingSecret = String(repeating: "A", count: 43)

private func makePairing(
  brokerId: String = String(repeating: "b", count: 32),
  port: Int = 45999
) -> VeyraNConnectPairing {
  return VeyraNConnectPairing(
    brokerId: brokerId,
    port: port,
    appId: String(repeating: "a", count: 32),
    appSecret: pairingSecret,
    rootPem: testRootPem,
    leafPin: "0"
  )
}

// MARK: - harness

@main
struct VeyraNConnectHarness {
  private static var failures = 0
  private static var checks = 0

  private static func expect(_ condition: Bool, _ message: String) {
    checks += 1
    if condition {
      print("  ok   \(message)")
    } else {
      failures += 1
      print("  FAIL \(message)")
    }
  }

  static func main() async {
    testBase64URL()
    testPairingJson()
    testStrictJsonTypes()
    testDuplicateKeys()
    testUrlAndRoutes()
    testPairingFileReader()
    testPairGate()
    testLifecycleLinearization()
    testLifecycleConcurrency()
    testDispatchEntryFencing()
    testTlsChain()
    await testSessionEngine()
    await testSessionFlowFencing()
    await testLeaseAdoptionFencing()

    print("")
    if failures == 0 {
      print("PASS: \(checks) checks")
    } else {
      print("FAIL: \(failures) of \(checks) checks failed")
      exit(1)
    }
  }

  // MARK: base64url

  private static func testBase64URL() {
    print("base64url canonical")
    // 32 zero bytes -> 43 'A' chars; round-trips.
    expect(
      VeyraNConnectValidate.b64url(String(repeating: "A", count: 43), chars: 43, bytes: 32),
      "canonical 32-byte secret is accepted"
    )
    // A 43-char value with a non-zero low bit in the final char carries unused
    // bits and must be rejected (a regex alone would accept it).
    let nonCanonical = String(repeating: "A", count: 42) + "B"
    expect(
      !VeyraNConnectValidate.b64url(nonCanonical, chars: 43, bytes: 32),
      "a 43-char secret with unused low bits is rejected"
    )
    expect(
      !VeyraNConnectValidate.b64url(String(repeating: "A", count: 42), chars: 43, bytes: 32),
      "a short secret is rejected"
    )
    expect(
      !VeyraNConnectValidate.b64url(String(repeating: "A", count: 44), chars: 43, bytes: 32),
      "an over-long secret is rejected"
    )
    expect(
      !VeyraNConnectValidate.b64url(String(repeating: "A", count: 42) + "+", chars: 43, bytes: 32),
      "a padded/standard-alphabet char is rejected"
    )
    // A canonical 16-byte session id (22 chars, low unused bits zero) passes,
    // while the old fixture's 27-char value (non-canonical, wrong length) is
    // rejected by the same validator the session parser uses.
    expect(
      VeyraNConnectValidate.b64url("dmV5cmFuLXNlc3Npb24xNg", chars: 22, bytes: 16),
      "a canonical 16-byte session id is accepted"
    )
    expect(
      !VeyraNConnectValidate.b64url("c2Vzc2lvbmlkMDAwMDAwMDAwMDA", chars: 22, bytes: 16),
      "the non-canonical 27-char session id is rejected"
    )
    expect(
      VeyraNConnectValidate.b64url(String(repeating: "A", count: 22), chars: 22, bytes: 16),
      "a canonical 22-char session id is accepted"
    )
    expect(
      !VeyraNConnectValidate.b64url(
        String(repeating: "A", count: 21) + "B",
        chars: 22,
        bytes: 16
      ),
      "a 22-char session id with unused low bits is rejected"
    )
    expect(
      VeyraNConnectSession.parse([
        "sessionId": "dmV5cmFuLXNlc3Npb24xNg",
        "grantsGeneration": 7
      ]) != nil,
      "the canonical fixture session id parses"
    )
    expect(
      VeyraNConnectSession.parse([
        "sessionId": "c2Vzc2lvbmlkMDAwMDAwMDAwMDA",
        "grantsGeneration": 7
      ]) == nil,
      "the non-canonical fixture session id is refused by the parser"
    )
  }

  // MARK: pairing JSON

  private static func testPairingJson() {
    print("pairing document")
    let valid: [String: Any] = [
      "v": 1,
      "service": "veyran-connect",
      "brokerId": String(repeating: "b", count: 32),
      "port": 45999,
      "app": ["id": String(repeating: "a", count: 32), "secret": pairingSecret],
      "tls": ["rootPem": testRootPem, "leafPin": String(repeating: "c", count: 64)]
    ]
    expect(VeyraNConnectPairing.parse(valid) != nil, "valid document parses")

    var withToken = valid
    withToken["token"] = "nope"
    expect(VeyraNConnectPairing.parse(withToken) == nil, "an unknown top-level key is denied")

    var appToken = valid
    appToken["app"] = [
      "id": String(repeating: "a", count: 32),
      "secret": pairingSecret,
      "token": "nope"
    ]
    expect(VeyraNConnectPairing.parse(appToken) == nil, "an unknown app key is denied")

    var badService = valid
    badService["service"] = "something-else"
    expect(VeyraNConnectPairing.parse(badService) == nil, "a foreign service is denied")

    var badVersion = valid
    badVersion["v"] = 2
    expect(VeyraNConnectPairing.parse(badVersion) == nil, "an unknown version is denied")

    var lowPort = valid
    lowPort["port"] = 80
    expect(VeyraNConnectPairing.parse(lowPort) == nil, "a privileged port is denied")

    var highPort = valid
    highPort["port"] = 70000
    expect(VeyraNConnectPairing.parse(highPort) == nil, "an out-of-range port is denied")

    var badPin = valid
    badPin["tls"] = ["rootPem": testRootPem, "leafPin": String(repeating: "z", count: 64)]
    expect(VeyraNConnectPairing.parse(badPin) == nil, "a non-hex pin is denied")

    var oversized = valid
    oversized["tls"] = [
      "rootPem": String(repeating: "x", count: VeyraNConnectWire.maxRootPemBytes + 1),
      "leafPin": String(repeating: "c", count: 64)
    ]
    expect(VeyraNConnectPairing.parse(oversized) == nil, "an oversized root PEM is denied")

    // Full byte-level parse enforces the 64 KiB document bound.
    let tooLarge = Data(repeating: 0x20, count: VeyraNConnectWire.maxPairingFileBytes + 1)
    expect(VeyraNConnectPairing.parse(data: tooLarge) == nil, "an oversized document is denied")
  }

  // MARK: URL / route map

  private static func testUrlAndRoutes() {
    print("url and route map")
    expect(VeyraNConnectValidate.url(port: 45999)?.absoluteString == "https://127.0.0.1:45999", "url is exact loopback")
    expect(VeyraNConnectValidate.url(port: 80) == nil, "a below-range port builds no url")
    expect(VeyraNConnectValidate.url(port: 70000) == nil, "an above-range port builds no url")
    expect(VeyraNConnectValidate.routePath("health") == "/v1/health", "health route")
    expect(VeyraNConnectValidate.routePath("session") == "/v1/session", "session route")
    expect(VeyraNConnectValidate.routePath("claim") == "/v1/claim", "claim route")
    expect(VeyraNConnectValidate.routePath("reply") == "/v1/reply", "reply route")
    expect(VeyraNConnectValidate.routePath("hello") == nil, "an mcp-only route is not dialable")
    expect(VeyraNConnectValidate.routePath("http://evil") == nil, "an arbitrary target is not dialable")
    expect(VeyraNConnectValidate.isLoopbackHost("127.0.0.1"), "exact loopback host accepted")
    expect(!VeyraNConnectValidate.isLoopbackHost("localhost"), "a name host is refused")
    expect(!VeyraNConnectValidate.isLoopbackHost("127.0.0.2"), "a different loopback address is refused")
  }

  // MARK: pairing file reader

  private static func testPairingFileReader() {
    print("pairing file reader")
    // Fixtures are created with POSIX calls: the Mac Catalyst sandbox used to
    // compile this harness denies `FileManager` writes outside a container,
    // while the reader itself is pure POSIX.
    let base =
      ProcessInfo.processInfo.environment["VEYRAN_HARNESS_DIR"]
      ?? NSTemporaryDirectory()
    let dir = base + "/veyran-connect-harness-\(UUID().uuidString)"
    guard mkdir(dir, 0o700) == 0 else {
      expect(false, "the harness directory is created")
      return
    }
    var created: [String] = []
    func write(_ name: String, _ bytes: Data, mode: mode_t) -> String? {
      let path = dir + "/" + name
      let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode)
      guard fd >= 0 else { return nil }
      let ok = bytes.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Bool in
        guard let base = buffer.baseAddress else { return bytes.isEmpty }
        var total = 0
        while total < bytes.count {
          let written = Darwin.write(fd, base.advanced(by: total), bytes.count - total)
          if written <= 0 { return false }
          total += written
        }
        return true
      }
      close(fd)
      if !ok { return nil }
      _ = chmod(path, mode)
      created.append(path)
      return path
    }

    let document: [String: Any] = [
      "v": 1,
      "service": "veyran-connect",
      "brokerId": String(repeating: "b", count: 32),
      "port": 45999,
      "app": ["id": String(repeating: "a", count: 32), "secret": pairingSecret],
      "tls": ["rootPem": testRootPem, "leafPin": String(repeating: "c", count: 64)]
    ]
    let data = try! JSONSerialization.data(withJSONObject: document)

    func expectRead(
      _ path: String?,
      _ expected: (Result<VeyraNConnectPairing, VeyraNConnectPairingFileReader.ReadError>) -> Bool,
      _ message: String
    ) {
      guard let path else {
        expect(false, message)
        return
      }
      expect(expected(VeyraNConnectPairingFileReader.read(path: path)), message)
    }

    expectRead(write("good.json", data, mode: 0o600), { if case .success = $0 { return true }; return false },
      "a 0600 regular document is read")
    expectRead(write("loose.json", data, mode: 0o644), { if case .failure(.insecure) = $0 { return true }; return false },
      "a group/other-readable document is refused")
    // The documented contract is *exactly* 0600: a broader owner-only mode is
    // refused too, not silently accepted.
    expectRead(write("owner.json", data, mode: 0o700), { if case .failure(.insecure) = $0 { return true }; return false },
      "a 0700 document is refused")
    expectRead(write("readonly.json", data, mode: 0o400), { if case .failure(.insecure) = $0 { return true }; return false },
      "a 0400 document is refused")

    // A FIFO must never block the open: O_NONBLOCK plus the fstat type check
    // rejects it immediately.
    let fifoPath = dir + "/pipe"
    if mkfifo(fifoPath, 0o600) == 0 {
      created.append(fifoPath)
      if case .failure = VeyraNConnectPairingFileReader.read(path: fifoPath) {
        expect(true, "a fifo fails closed without blocking")
      } else {
        expect(false, "a fifo fails closed without blocking")
      }
    } else {
      expect(false, "a fifo fixture is created")
    }

    // A symlink must never be followed. `symlink` needs the target to exist.
    if let good = write("target.json", data, mode: 0o600) {
      let linkPath = dir + "/link.json"
      if symlink(good, linkPath) == 0 {
        created.append(linkPath)
        if case .failure = VeyraNConnectPairingFileReader.read(path: linkPath) {
          expect(true, "a symlink is never followed")
        } else {
          expect(false, "a symlink is never followed")
        }
      } else {
        expect(false, "a symlink fixture is created")
      }
    } else {
      expect(false, "a symlink target is created")
    }

    if case .failure = VeyraNConnectPairingFileReader.read(path: dir + "/missing.json") {
      expect(true, "a missing file fails closed")
    } else {
      expect(false, "a missing file fails closed")
    }

    created.forEach { _ = unlink($0) }
    _ = rmdir(dir)
  }

  // MARK: pair gate

  /// The exact ordering the module performs around the pairing picker: a pick
  /// owns one token; a lifecycle fence (lock/disconnect/unmount/account switch)
  /// or a concurrent pick invalidates it; the store slot is taken only by the
  /// current token and only once — so a stale completion can never replace the
  /// stored credential.
  private static func testPairGate() {
    print("pair gate")
    let gate = VeyraNConnectPairGate()

    let epochBefore = gate.currentEpoch()
    let first = gate.beginPick()
    expect(first.epoch == epochBefore, "a pick is stamped with the live epoch")
    expect(gate.isCurrent(first), "a fresh pick owns the pending slot")
    expect(gate.hasPendingPick(), "a fresh pick is pending")

    // 1. A lifecycle fence (lock / disconnect / unmount / account switch) bumps
    //    the epoch and drops the pending pick.
    expect(
      gate.invalidate() == epochBefore + 1,
      "a lifecycle fence bumps the epoch by exactly one"
    )
    expect(!gate.isCurrent(first), "a fenced pick is stale")
    expect(!gate.hasPendingPick(), "a fenced pick leaves no pending slot")
    expect(
      !gate.takeStoreSlot(first),
      "a stale pick can never take the store slot (no Keychain write)"
    )

    // 2. A concurrent pick invalidates the older pick; only the newest stores.
    let older = gate.beginPick()
    let newer = gate.beginPick()
    expect(!gate.isCurrent(older), "a concurrent pick invalidates the older pick")
    expect(gate.isCurrent(newer), "the newest pick is current")
    expect(
      !gate.takeStoreSlot(older),
      "the older completion can never take the store slot"
    )
    expect(gate.takeStoreSlot(newer), "the newest completion takes the store slot")
    expect(
      !gate.takeStoreSlot(newer),
      "the store slot is consumed exactly once (no duplicate store)"
    )
    expect(!gate.hasPendingPick(), "a completed pick leaves no pending slot")

    // 3. The legitimate path after a fence: a *new* pick at the new epoch still
    //    stores — the fence invalidates pending picks, not future pairings.
    gate.invalidate()
    let afterFence = gate.beginPick()
    expect(gate.isCurrent(afterFence), "a pick opened after a fence is current")
    expect(
      gate.takeStoreSlot(afterFence),
      "a pick opened after a fence stores exactly once"
    )

    // 4. A cancelled/invalid file never takes a store slot: the pick is simply
    //    abandoned, so the previously stored credential is untouched and a
    //    later legitimate pick can still store.
    let cancelled = gate.beginPick()
    expect(gate.isCurrent(cancelled), "a cancelled/invalid pick starts current")
    expect(gate.hasPendingPick(), "the pick is pending while the file is read")
    gate.invalidate()
    expect(!gate.isCurrent(cancelled), "an abandoned pick is stale after a fence")
    expect(
      !gate.takeStoreSlot(cancelled),
      "an abandoned pick never reaches the store (credential preserved)"
    )
    let retry = gate.beginPick()
    expect(gate.takeStoreSlot(retry), "a later legitimate pick can still store")
  }

  // MARK: lifecycle linearization

  /// A synthetic credential store: it counts load/save/delete, can fail, and
  /// can block inside `save` (a semaphore the test releases) so a commit can be
  /// genuinely in flight while a fence runs on another thread. It is the only
  /// credential storage the lifecycle tests ever touch — no Keychain.
  private final class SyntheticCredentialStore: VeyraNConnectCredentialStore {
    private let lock = NSLock()
    private var stored: VeyraNConnectPairing?
    private var saves = 0
    private var deletes = 0
    private var loads = 0
    private var saveFinished = false
    private var deleteAfterFinishedSave = false
    var failSave = false
    var failDelete = false
    var saveGate: DispatchSemaphore?
    /// Signaled when `save` is entered, before any blocking.
    let saveEntered = DispatchSemaphore(value: 0)

    init(seeded: VeyraNConnectPairing? = nil) {
      stored = seeded
    }

    func seed(_ pairing: VeyraNConnectPairing?) {
      lock.lock()
      stored = pairing
      lock.unlock()
    }

    func snapshot() -> VeyraNConnectPairing? {
      lock.lock()
      defer { lock.unlock() }
      return stored
    }

    var saveCount: Int {
      lock.lock()
      defer { lock.unlock() }
      return saves
    }

    var deleteCount: Int {
      lock.lock()
      defer { lock.unlock() }
      return deletes
    }

    var loadCount: Int {
      lock.lock()
      defer { lock.unlock() }
      return loads
    }

    /// True only when a delete ran after a `save` had already returned: the
    /// deterministic proof that the commit and the disconnect were serialized
    /// (an unserialized delete would run while `save` is still blocked).
    var deletedAfterCompletedSave: Bool {
      lock.lock()
      defer { lock.unlock() }
      return deleteAfterFinishedSave
    }

    func load() -> VeyraNConnectPairing? {
      lock.lock()
      loads += 1
      lock.unlock()
      return snapshot()
    }

    @discardableResult
    func save(_ pairing: VeyraNConnectPairing) -> Bool {
      saveEntered.signal()
      if let saveGate {
        _ = saveGate.wait(timeout: .now() + 10)
      }
      lock.lock()
      defer { lock.unlock() }
      saves += 1
      if failSave { return false }
      stored = pairing
      saveFinished = true
      return true
    }

    @discardableResult
    func delete() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      deletes += 1
      if saveFinished { deleteAfterFinishedSave = true }
      if failDelete { return false }
      stored = nil
      return true
    }
  }

  /// A synthetic engine that records `invalidate()` calls, maintains a
  /// monotonic lease generation (bumped by `invalidate()`, mirroring the real
  /// engine) and optionally runs a hook, so a test can prove *when* the
  /// invalidation happened and what lease was captured with an adoption.
  private final class SyntheticEngine: VeyraNConnectLifecycleEngine {
    private let lock = NSLock()
    private var invalidations = 0
    private var lease = 0
    private let onInvalidate: (() -> Void)?

    init(onInvalidate: (() -> Void)? = nil) {
      self.onInvalidate = onInvalidate
    }

    @discardableResult
    func invalidate() -> Int {
      lock.lock()
      invalidations += 1
      lease += 1
      let newLease = lease
      lock.unlock()
      onInvalidate?()
      return newLease
    }

    func currentLeaseGeneration() -> Int {
      lock.lock()
      defer { lock.unlock() }
      return lease
    }

    var invalidationCount: Int {
      lock.lock()
      defer { lock.unlock() }
      return invalidations
    }
  }

  /// A thread-safe boolean, for cross-thread completion flags.
  private final class Flag {
    private let lock = NSLock()
    private var value = false

    func set(_ newValue: Bool = true) {
      lock.lock()
      value = newValue
      lock.unlock()
    }

    func get() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return value
    }
  }

  /// A thread-safe single-value box.
  private final class Box<T> {
    private let lock = NSLock()
    private var value: T?

    func set(_ newValue: T) {
      lock.lock()
      value = newValue
      lock.unlock()
    }

    func get() -> T? {
      lock.lock()
      defer { lock.unlock() }
      return value
    }
  }

  /// The synchronous ordering proofs of the single lifecycle primitive: every
  /// fence/commit/adopt/delete is one critical section, a fenced completion
  /// performs zero credential writes, and a duplicate or superseded completion
  /// can never store.
  private static func testLifecycleLinearization() {
    print("lifecycle linearization")
    let pairingA = makePairing()
    let pairingB = makePairing(brokerId: String(repeating: "c", count: 32))

    // 1. A pick fenced *before* its completion writes nothing at all.
    do {
      let store = SyntheticCredentialStore()
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let staleToken = lifecycle.fenceAndBeginPick()
      lifecycle.invalidate()
      expect(
        lifecycle.commitPick(token: staleToken, pairing: pairingA) == .stale,
        "a fenced pick completion is stale"
      )
      expect(store.saveCount == 0, "a fenced pick performs zero credential stores")
      expect(lifecycle.currentEngine() == nil, "a fenced pick adopts no engine")
      expect(lifecycle.pairingOrStored() == nil, "a fenced pick leaves no pairing")
    }

    // 2. The legitimate path: authorize + store + adopt atomically, and a
    //    duplicate completion of the same pick can never store again.
    do {
      let store = SyntheticCredentialStore()
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let token = lifecycle.fenceAndBeginPick()
      expect(
        lifecycle.commitPick(token: token, pairing: pairingA) == .stored,
        "a current pick completion stores"
      )
      expect(store.saveCount == 1, "the credential is stored exactly once")
      expect(
        store.snapshot()?.brokerId == pairingA.brokerId,
        "the stored credential is the picked pairing"
      )
      expect(
        lifecycle.pairingOrStored()?.brokerId == pairingA.brokerId,
        "the picked pairing is adopted in memory"
      )
      expect(!lifecycle.hasPendingPick(), "a completed pick leaves no pending slot")
      expect(
        lifecycle.commitPick(token: token, pairing: pairingB) == .stale,
        "a duplicate completion of the same pick is refused"
      )
      expect(store.saveCount == 1, "a duplicate completion stores nothing")
      expect(
        store.snapshot()?.brokerId == pairingA.brokerId,
        "a duplicate completion cannot replace the credential"
      )
    }

    // 3. Concurrent picks: only the newest completion may store.
    do {
      let store = SyntheticCredentialStore()
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let older = lifecycle.fenceAndBeginPick()
      let newer = lifecycle.fenceAndBeginPick()
      expect(
        lifecycle.commitPick(token: older, pairing: pairingA) == .stale,
        "the superseded pick completion is stale"
      )
      expect(
        lifecycle.commitPick(token: newer, pairing: pairingB) == .stored,
        "the newest pick completion stores"
      )
      expect(store.saveCount == 1, "only the newest pick reaches the store")
      expect(
        store.snapshot()?.brokerId == pairingB.brokerId,
        "the newest pairing is the stored one"
      )
    }

    // 4. A re-pair commit invalidates and drops the previous engine instead of
    //    silently swapping it out.
    do {
      let store = SyntheticCredentialStore(seeded: pairingA)
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      guard
        let adopted = try? lifecycle.ensureEngine(
          epoch: lifecycle.currentEpoch(),
          make: { _ in SyntheticEngine() }
        )
      else {
        expect(false, "an engine is adopted for the stored pairing")
        return
      }
      let first = adopted.engine
      let token = lifecycle.fenceAndBeginPick()
      expect(
        first.invalidationCount == 1,
        "opening a pick invalidates the live engine"
      )
      expect(
        lifecycle.commitPick(token: token, pairing: pairingB) == .stored,
        "the re-pair commit stores"
      )
      expect(
        first.invalidationCount == 2,
        "the re-pair invalidates the engine it replaces"
      )
      expect(lifecycle.currentEngine() == nil, "the replaced engine is dropped")
    }

    // 5. A refused credential store consumes the pick and adopts nothing.
    do {
      let store = SyntheticCredentialStore()
      store.failSave = true
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let token = lifecycle.fenceAndBeginPick()
      expect(
        lifecycle.commitPick(token: token, pairing: pairingA) == .storeFailed,
        "a refused credential store is reported truthfully"
      )
      expect(lifecycle.currentEngine() == nil, "a refused store adopts no engine")
      expect(lifecycle.pairingOrStored() == nil, "a refused store leaves no pairing")
      expect(
        lifecycle.commitPick(token: token, pairing: pairingA) == .stale,
        "a refused store consumes the pick (no retry by a duplicate completion)"
      )
      expect(store.saveCount == 1, "the refused store is attempted exactly once")
    }

    // 6. stop fences and invalidates but keeps the pairing; disconnect deletes
    //    the credential and drops memory in the same critical section.
    do {
      let store = SyntheticCredentialStore(seeded: pairingA)
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      guard
        let adopted = try? lifecycle.ensureEngine(
          epoch: lifecycle.currentEpoch(),
          make: { _ in SyntheticEngine() }
        )
      else {
        expect(false, "an engine is adopted for the stored pairing")
        return
      }
      let engine = adopted.engine
      let token = lifecycle.fenceAndBeginPick()
      lifecycle.stop()
      expect(!lifecycle.hasPendingPick(), "stop drops a pending pick")
      expect(
        lifecycle.commitPick(token: token, pairing: pairingB) == .stale,
        "stop makes the pending pick stale (zero store)"
      )
      expect(store.saveCount == 0, "stop alone performs no credential store")
      expect(engine.invalidationCount == 2, "stop invalidates the live engine")
      expect(lifecycle.pairingOrStored() != nil, "stop keeps the pairing")
      expect(lifecycle.currentEngine() != nil, "stop keeps the engine for reuse")
      expect(lifecycle.disconnect(), "disconnect reports the credential delete")
      expect(store.snapshot() == nil, "disconnect deletes the stored credential")
      expect(lifecycle.currentEngine() == nil, "disconnect drops the engine")
      expect(
        lifecycle.pairingOrStored() == nil,
        "disconnect leaves no pairing in memory or store"
      )
    }

    // 7. Engine adoption is epoch-fenced and caches exactly one engine.
    do {
      let store = SyntheticCredentialStore(seeded: pairingA)
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      var builds = 0
      let epoch = lifecycle.currentEpoch()
      let first = try? lifecycle.ensureEngine(
        epoch: epoch,
        make: { _ in
          builds += 1
          return SyntheticEngine()
        }
      )
      let second = try? lifecycle.ensureEngine(
        epoch: epoch,
        make: { _ in
          builds += 1
          return SyntheticEngine()
        }
      )
      expect(
        first?.engine != nil && second?.engine === first?.engine,
        "a matching epoch reuses the engine"
      )
      expect(builds == 1, "the engine factory runs exactly once")
      lifecycle.invalidate()
      do {
        _ = try lifecycle.ensureEngine(
          epoch: epoch,
          make: { _ in
            builds += 1
            return SyntheticEngine()
          }
        )
        expect(false, "an engine request with a stale epoch is refused")
      } catch {
        expect(builds == 1, "a stale epoch never calls the engine factory")
      }
      expect(lifecycle.disconnect(), "disconnect after adoption succeeds")
      do {
        _ = try lifecycle.ensureEngine(
          epoch: lifecycle.currentEpoch(),
          make: { _ in
            builds += 1
            return SyntheticEngine()
          }
        )
        expect(false, "an engine request after a disconnect is refused")
      } catch {
        expect(builds == 1, "a disconnected lifecycle never builds an engine")
      }
    }
  }

  /// The real-thread proofs: a commit paused inside the injected credential
  /// store and a disconnect (or a paused engine adoption and a disconnect) are
  /// linearized by the primitive, so the disconnect owns the final state.
  private static func testLifecycleConcurrency() {
    print("lifecycle concurrency")

    // A. A commit that is already inside the credential store wins the store
    //    call; the disconnect requested meanwhile waits for the whole critical
    //    section and then deletes what it wrote: final memory + credential nil.
    do {
      let store = SyntheticCredentialStore()
      let saveGate = DispatchSemaphore(value: 0)
      store.saveGate = saveGate
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let token = lifecycle.fenceAndBeginPick()
      let pairing = makePairing()

      let commitDone = DispatchSemaphore(value: 0)
      let commitResult = Box<VeyraNConnectLifecycle<SyntheticEngine>.CommitResult>()
      DispatchQueue.global().async {
        commitResult.set(lifecycle.commitPick(token: token, pairing: pairing))
        commitDone.signal()
      }
      expect(
        store.saveEntered.wait(timeout: .now() + 5) == .success,
        "the commit is inside the credential store"
      )

      let disconnectDone = DispatchSemaphore(value: 0)
      let disconnectReturned = Flag()
      let disconnectOk = Flag()
      DispatchQueue.global().async {
        disconnectOk.set(lifecycle.disconnect())
        disconnectReturned.set(true)
        disconnectDone.signal()
      }
      _ = usleep(150_000)
      expect(
        !disconnectReturned.get(),
        "the disconnect waits while the credential commit is in flight"
      )

      saveGate.signal()
      expect(
        commitDone.wait(timeout: .now() + 5) == .success,
        "the in-flight commit completes"
      )
      expect(
        disconnectDone.wait(timeout: .now() + 5) == .success,
        "the waiting disconnect completes"
      )
      expect(commitResult.get() == .stored, "the in-flight commit stored the credential")
      expect(disconnectOk.get(), "the disconnect deleted the credential")
      expect(
        store.deletedAfterCompletedSave,
        "the delete ran only after the save returned (serialized critical sections)"
      )
      expect(store.snapshot() == nil, "the final credential is nil")
      expect(lifecycle.currentEngine() == nil, "the final engine is nil")
      expect(lifecycle.pairingOrStored() == nil, "the final pairing is nil")
    }

    // B. An engine adoption paused inside the factory is linearized against a
    //    concurrent disconnect: the disconnect waits, then invalidates + drops
    //    the adopted engine — nothing is resurrected after it returns.
    do {
      let store = SyntheticCredentialStore(seeded: makePairing())
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let epoch = lifecycle.currentEpoch()
      let factoryGate = DispatchSemaphore(value: 0)
      let factoryEntered = DispatchSemaphore(value: 0)
      let adopted = Box<SyntheticEngine>()
      let ensureDone = DispatchSemaphore(value: 0)
      let ensureReturnedEngine = Flag()
      // Ordering evidence: the disconnect's invalidation must run only after
      // the factory has returned (i.e. after the adoption critical section).
      let factoryReturned = Flag()
      let invalidatedAfterFactoryReturned = Flag()
      DispatchQueue.global().async {
        let result = try? lifecycle.ensureEngine(epoch: epoch) { _ in
          factoryEntered.signal()
          _ = factoryGate.wait(timeout: .now() + 10)
          let engine = SyntheticEngine {
            invalidatedAfterFactoryReturned.set(factoryReturned.get())
          }
          adopted.set(engine)
          factoryReturned.set(true)
          return engine
        }
        ensureReturnedEngine.set(result != nil)
        ensureDone.signal()
      }
      expect(
        factoryEntered.wait(timeout: .now() + 5) == .success,
        "the engine factory is running"
      )

      let disconnectDone = DispatchSemaphore(value: 0)
      let disconnectReturned = Flag()
      let disconnectOk = Flag()
      DispatchQueue.global().async {
        disconnectOk.set(lifecycle.disconnect())
        disconnectReturned.set(true)
        disconnectDone.signal()
      }
      _ = usleep(150_000)
      expect(
        !disconnectReturned.get(),
        "the disconnect waits for the in-flight engine adoption"
      )

      factoryGate.signal()
      expect(
        ensureDone.wait(timeout: .now() + 5) == .success,
        "the paused adoption returns"
      )
      expect(
        disconnectDone.wait(timeout: .now() + 5) == .success,
        "the waiting disconnect completes"
      )
      expect(ensureReturnedEngine.get(), "the adoption won the race and returned an engine")
      expect(disconnectOk.get(), "the disconnect deleted the credential")
      expect(lifecycle.currentEngine() == nil, "no engine survives the disconnect")
      expect(
        adopted.get()?.invalidationCount == 1,
        "the adopted engine was invalidated by the disconnect"
      )
      expect(
        invalidatedAfterFactoryReturned.get(),
        "the invalidation ran after the factory returned (serialized critical sections)"
      )
      expect(lifecycle.pairingOrStored() == nil, "no pairing survives the disconnect")
      expect(store.snapshot() == nil, "the credential store is empty after the disconnect")
    }

    // C. The reverse order: a disconnect that completed first refuses the
    //    adoption outright, before the factory is ever called.
    do {
      let store = SyntheticCredentialStore(seeded: makePairing())
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let staleEpoch = lifecycle.currentEpoch()
      expect(lifecycle.disconnect(), "the first disconnect completes")
      var builds = 0
      do {
        _ = try lifecycle.ensureEngine(
          epoch: staleEpoch,
          make: { _ in
            builds += 1
            return SyntheticEngine()
          }
        )
        expect(false, "an adoption after a completed disconnect is refused")
      } catch {
        expect(builds == 0, "the refused adoption never builds an engine")
      }
      expect(lifecycle.currentEngine() == nil, "no engine is adopted after the disconnect")
    }
  }

  // MARK: dispatch-entry fencing

  /// The three dispatch-entry fences: (1) the picker token is claimed
  /// synchronously at the native method entry and the deferred main-queue work
  /// only proceeds while that exact entry token is still current; (2) the
  /// session-start epoch is captured synchronously before the `Task` is
  /// scheduled; (3) the engine's lease is captured atomically with its adoption
  /// and re-checked as the *first* engine-lock step of the handshake. Each has a
  /// counterfactual modelling the superseded ordering, so the tests are
  /// discriminating rather than tautological.
  ///
  /// The deferred work is modelled as a closure consumed *after* the fence that
  /// mirrors the module's main-queue block exactly (same primitive calls in the
  /// same order), not as an independent toy predicate.
  private static func testDispatchEntryFencing() {
    print("dispatch-entry fencing")
    let pairingA = makePairing()
    let pairingB = makePairing(brokerId: String(repeating: "c", count: 32))

    // Mirrors `VeyraNConnectModule.pickPairingFile`'s main-queue block: consume
    // the *entry* token, bail unless it is still current, and only then commit.
    func queuedPickWork(
      _ lifecycle: VeyraNConnectLifecycle<SyntheticEngine>,
      _ token: VeyraNConnectLifecycle<SyntheticEngine>.Token
    ) -> Bool {
      guard lifecycle.isCurrentPick(token) else { return false }
      return lifecycle.commitPick(token: token, pairing: pairingA) == .stored
    }

    // Mirrors `VeyraNConnectModule.startSession`'s Task body: adopt against the
    // entry epoch, counting factory builds.
    func queuedStartWork(
      _ lifecycle: VeyraNConnectLifecycle<SyntheticEngine>,
      entryEpoch: Int,
      builds: inout Int
    ) -> Bool {
      do {
        _ = try lifecycle.ensureEngine(epoch: entryEpoch) { _ in
          builds += 1
          return SyntheticEngine()
        }
        return true
      } catch {
        return false
      }
    }

    // 1. A disconnect that lands while the main-queue pick work is still
    //    pending makes the queued work bail before it shows the picker or
    //    touches the poll loop: zero credential stores.
    do {
      let store = SyntheticCredentialStore()
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let token = lifecycle.fenceAndBeginPick() // native entry, before the hop
      expect(lifecycle.isCurrentPick(token), "the entry pick token is current at claim time")
      expect(lifecycle.disconnect(), "the queued disconnect deletes the credential")
      expect(
        !queuedPickWork(lifecycle, token),
        "queued pick work bails when its entry token is stale"
      )
      expect(store.saveCount == 0, "a disconnect-fenced queued pick performs zero stores")
      expect(lifecycle.currentEngine() == nil, "a disconnect-fenced queued pick adopts no engine")
    }

    // 1b. Same for a stop (it fences the entry token but keeps the credential).
    do {
      let store = SyntheticCredentialStore()
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let token = lifecycle.fenceAndBeginPick()
      lifecycle.stop()
      expect(!queuedPickWork(lifecycle, token), "queued pick work bails after a queued stop")
      expect(store.saveCount == 0, "a stop-fenced queued pick performs zero stores")
    }

    // 1c. Counterfactual: the superseded ordering stamped a *fresh* token
    //     inside the queued block, after the disconnect, so a late picker would
    //     resurrect the credential. Model that ordering and show it stores —
    //     proving the entry-claim + `isCurrentPick` guard is what closes it.
    do {
      let store = SyntheticCredentialStore()
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      _ = lifecycle.fenceAndBeginPick()
      _ = lifecycle.disconnect()
      let lateToken = lifecycle.fenceAndBeginPick() // superseded: stamped in-queue
      expect(
        lifecycle.commitPick(token: lateToken, pairing: pairingA) == .stored,
        "the superseded stamp-inside-the-queue ordering would resurrect the credential"
      )
      expect(store.saveCount == 1, "the superseded ordering reaches the store (why the fix is needed)")
    }

    // 1d. Positive control: with no fence the queued work stores the entry pick.
    do {
      let store = SyntheticCredentialStore()
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let token = lifecycle.fenceAndBeginPick()
      expect(
        queuedPickWork(lifecycle, token),
        "queued pick work proceeds while its entry token is current"
      )
      expect(store.saveCount == 1, "a current queued pick stores exactly once")
      expect(
        store.snapshot()?.brokerId == pairingA.brokerId,
        "a current queued pick stores the picked pairing"
      )
    }

    // 1e. Two concurrent entry claims: the older queued work bails, only the
    //     newest commits.
    do {
      let store = SyntheticCredentialStore()
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let older = lifecycle.fenceAndBeginPick()
      let newer = lifecycle.fenceAndBeginPick()
      expect(!queuedPickWork(lifecycle, older), "the older queued pick work bails")
      expect(lifecycle.isCurrentPick(newer), "the newest entry token stays current")
      expect(store.saveCount == 0, "the superseded queued pick never stores")
      expect(
        lifecycle.commitPick(token: newer, pairing: pairingB) == .stored,
        "the newest entry token stores"
      )
      expect(store.saveCount == 1, "only the newest queued pick stores")
    }

    // 2. A stop that lands while the queued start work is pending makes it
    //    reject its stale entry epoch *before* loading the credential or
    //    building an engine.
    do {
      let store = SyntheticCredentialStore(seeded: pairingA)
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let entryEpoch = lifecycle.currentEpoch() // native entry, before the Task
      lifecycle.stop()
      var builds = 0
      expect(
        !queuedStartWork(lifecycle, entryEpoch: entryEpoch, builds: &builds),
        "queued start work is refused when its entry epoch is stale"
      )
      expect(builds == 0, "a stale queued start never builds an engine")
      expect(store.loadCount == 0, "a stale queued start never reads the credential store")
      expect(lifecycle.currentEngine() == nil, "a stale queued start adopts no engine")
    }

    // 2b. Same for a disconnect that landed while the work was queued.
    do {
      let store = SyntheticCredentialStore(seeded: pairingA)
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      let entryEpoch = lifecycle.currentEpoch()
      _ = lifecycle.disconnect()
      var builds = 0
      expect(
        !queuedStartWork(lifecycle, entryEpoch: entryEpoch, builds: &builds),
        "queued start work is refused after a queued disconnect"
      )
      expect(
        builds == 0 && store.loadCount == 0,
        "a disconnect-fenced queued start never loads or builds"
      )
    }

    // 2c. Counterfactual: capturing the epoch *inside* the queued work (the
    //     superseded ordering) observes the post-stop epoch, so it proceeds —
    //     loads the credential and builds an engine after the stop.
    do {
      let store = SyntheticCredentialStore(seeded: pairingA)
      let lifecycle = VeyraNConnectLifecycle<SyntheticEngine>(store: store)
      lifecycle.stop()
      let lateEpoch = lifecycle.currentEpoch() // superseded: read inside the Task
      var builds = 0
      expect(
        queuedStartWork(lifecycle, entryEpoch: lateEpoch, builds: &builds),
        "the superseded read-inside-the-queue ordering would proceed after a stop"
      )
      expect(builds == 1, "the superseded ordering builds an engine after a stop")
      expect(store.loadCount == 1, "the superseded ordering reads the credential after a stop")
    }
  }

  /// The real-engine half of the dispatch-entry fences: an engine adopted
  /// through the production `VeyraNConnectLifecycle` (with a real
  /// `VeyraNConnectSessionEngine` over a scripted transport) carries the exact
  /// lease it had at adoption; a stop that lands between the adoption and the
  /// handshake entry is refused by the first engine-lock check, before any
  /// broker frame and with no active session. The counterfactual reads the
  /// lease *after* the stop (the superseded un-atomic ordering) and shows it
  /// would open a session.
  private static func testLeaseAdoptionFencing() async {
    print("adoption lease fencing")
    let brokerId = String(repeating: "b", count: 32)
    let bootId = String(repeating: "d", count: 32)
    let sessionId = VeyraNConnectBase64URL.encode(Data(repeating: 7, count: 16))
    let pairing = makePairing(brokerId: brokerId, port: 45999)

    func brokerResponse(_ path: String) throws -> Data {
      switch path {
      case "/v1/health":
        return successEnvelope([
          "service": "veyran-connect",
          "protocolVersion": 1,
          "brokerId": brokerId,
          "bootId": bootId,
          "port": 45999
        ])
      case "/v1/session":
        return successEnvelope(["sessionId": sessionId, "grantsGeneration": 1])
      default:
        throw VeyraNConnectError.responseInvalid
      }
    }

    func adopt(
      _ lifecycle: VeyraNConnectLifecycle<VeyraNConnectSessionEngine>,
      _ transport: ScriptedTransport
    ) throws -> (engine: VeyraNConnectSessionEngine, expectedLease: Int) {
      try lifecycle.ensureEngine(epoch: lifecycle.currentEpoch()) { p in
        VeyraNConnectSessionEngine(pairing: p, transport: transport)
      }
    }

    // 1. stop() between the adoption and the handshake entry: refused by the
    //    adoption lease before the first health frame; no session becomes active.
    do {
      let transport = ScriptedTransport { path, _ in try brokerResponse(path) }
      let store = SyntheticCredentialStore(seeded: pairing)
      let lifecycle = VeyraNConnectLifecycle<VeyraNConnectSessionEngine>(store: store)
      guard let adopted = try? adopt(lifecycle, transport) else {
        expect(false, "a real engine is adopted for the stored pairing")
        return
      }
      lifecycle.stop() // lands between the adoption and the handshake entry
      do {
        _ = try await adopted.engine.establishSession(
          accountId: "account-1",
          grantsGeneration: 1,
          clientId: "veyran-host",
          expectedLease: adopted.expectedLease
        )
        expect(false, "a handshake after a stop is refused")
      } catch let error as VeyraNConnectError {
        expect(error == .sessionRequired, "a handshake after a stop is refused by the adoption lease")
      } catch {
        expect(false, "a handshake after a stop is refused by the adoption lease")
      }
      expect(transport.sentPaths.isEmpty, "no broker frame is sent for a lease-fenced handshake")
      expect(!adopted.engine.isActive(), "no session becomes active under a lease-fenced handshake")
    }

    // 2. Counterfactual: reading the lease *after* the stop matches the bumped
    //    value, so the superseded ordering would send health+session and leave
    //    an active session behind a stop.
    do {
      let transport = ScriptedTransport { path, _ in try brokerResponse(path) }
      let store = SyntheticCredentialStore(seeded: pairing)
      let lifecycle = VeyraNConnectLifecycle<VeyraNConnectSessionEngine>(store: store)
      guard let adopted = try? adopt(lifecycle, transport) else {
        expect(false, "a real engine is adopted for the stored pairing")
        return
      }
      lifecycle.stop()
      let lateLease = adopted.engine.currentLeaseGeneration() // superseded: read after the stop
      let session = try? await adopted.engine.establishSession(
        accountId: "account-1",
        grantsGeneration: 1,
        clientId: "veyran-host",
        expectedLease: lateLease
      )
      expect(session != nil, "the superseded post-stop lease read would open a session")
      expect(adopted.engine.isActive(), "the superseded ordering leaves an active session after a stop")
    }

    // 3. Positive control: a matched adoption lease establishes the session and
    //    reusing the engine captures the same (current) lease.
    do {
      let transport = ScriptedTransport { path, _ in try brokerResponse(path) }
      let store = SyntheticCredentialStore(seeded: pairing)
      let lifecycle = VeyraNConnectLifecycle<VeyraNConnectSessionEngine>(store: store)
      guard let adopted = try? adopt(lifecycle, transport),
        let reused = try? adopt(lifecycle, transport)
      else {
        expect(false, "the adopted engine is reused for the stored pairing")
        return
      }
      expect(reused.engine === adopted.engine, "ensureEngine reuses the adopted engine")
      expect(
        reused.expectedLease == adopted.engine.currentLeaseGeneration(),
        "a reused adoption captures the engine's current lease"
      )
      let session = try? await adopted.engine.establishSession(
        accountId: "account-1",
        grantsGeneration: 1,
        clientId: "veyran-host",
        expectedLease: adopted.expectedLease
      )
      expect(session != nil, "a matched adoption lease establishes the session")
      expect(adopted.engine.isActive(), "the matched session is active")
      expect(
        transport.sentPaths == ["/v1/health", "/v1/session"],
        "the handshake sends health then session"
      )
    }
  }

  // MARK: TLS chain

  private static func testTlsChain() {
    print("tls chain and leaf pin")
    guard let root = VeyraNConnectTLS.certificates(pem: testRootPem),
      let leaf = VeyraNConnectTLS.certificates(pem: testLeafPem),
      let rootCert = root.first,
      let leafCert = leaf.first
    else {
      expect(false, "the test chain parses")
      return
    }
    expect(true, "the test chain parses")
    expect(
      VeyraNConnectTLS.certificates(pem: "not a pem") == nil,
      "a malformed PEM is refused"
    )

    let leafDER = SecCertificateCopyData(leafCert) as Data
    let pin = VeyraNConnectTLS.pin(der: leafDER)
    expect(pin.count == 64, "the leaf pin is 64 hex chars")
    expect(VeyraNConnectTLS.pinMatches(der: leafDER, pin: pin), "the exact leaf pin matches")
    expect(
      !VeyraNConnectTLS.pinMatches(der: leafDER, pin: String(repeating: "0", count: 64)),
      "a foreign pin is refused"
    )

    func trust() -> SecTrust? {
      var created: SecTrust?
      let status = SecTrustCreateWithCertificates(
        [leafCert] as CFArray,
        SecPolicyCreateSSL(true, "127.0.0.1" as CFString),
        &created
      )
      return status == errSecSuccess ? created : nil
    }

    guard let good = trust() else {
      expect(false, "a SecTrust is created for the leaf")
      return
    }
    expect(
      VeyraNConnectTLS.evaluate(trust: good, anchors: [rootCert], host: "127.0.0.1", leafPin: pin),
      "the leaf verifies against the paired root and pin"
    )
    expect(
      !VeyraNConnectTLS.evaluate(trust: good, anchors: [rootCert], host: "127.0.0.1", leafPin: String(repeating: "0", count: 64)),
      "the wrong pin is refused"
    )
    expect(
      !VeyraNConnectTLS.evaluate(trust: good, anchors: [rootCert], host: "localhost", leafPin: pin),
      "a non-loopback host is refused"
    )
    // An empty anchor set is refused: this client never falls back to the
    // system trust store, so a chain with no paired anchor cannot validate.
    if let emptyAnchor = trust() {
      expect(
        !VeyraNConnectTLS.evaluate(trust: emptyAnchor, anchors: [], host: "127.0.0.1", leafPin: pin),
        "an empty anchor set is refused (no system fallback)"
      )
    } else {
      expect(false, "a second SecTrust is created")
    }
    // The paired root must be the *only* anchor: a chain that does not include
    // the paired root is refused even with the correct pin.
    if let leafAnchor = trust() {
      expect(
        !VeyraNConnectTLS.evaluate(
          trust: leafAnchor,
          anchors: [leafCert],
          host: "127.0.0.1",
          leafPin: String(repeating: "0", count: 64)
        ),
        "a foreign anchor with a wrong pin is refused"
      )
    } else {
      expect(false, "a third SecTrust is created")
    }
  }

  // MARK: session engine

  private static func testSessionEngine() async {
    print("session engine")
    let brokerId = String(repeating: "b", count: 32)
    let bootId = String(repeating: "d", count: 32)
    let sessionId = VeyraNConnectBase64URL.encode(Data(repeating: 7, count: 16))
    let pairing = makePairing(brokerId: brokerId, port: 45999)

    let ticketA = String(repeating: "1", count: 32)
    let ticketB = String(repeating: "2", count: 32)

    // A scripted broker: health, session, then one empty claim, one request
    // claim, then reply. Nonce values are asserted from the recorded bodies.
    var claimCount = 0
    let transport = ScriptedTransport { path, _ in
      switch path {
      case "/v1/health":
        return successEnvelope([
          "service": "veyran-connect",
          "protocolVersion": 1,
          "brokerId": brokerId,
          "bootId": bootId,
          "port": 45999
        ])
      case "/v1/session":
        return successEnvelope(["sessionId": sessionId, "grantsGeneration": 3])
      case "/v1/claim":
        claimCount += 1
        if claimCount == 1 { return successEnvelope(["item": NSNull()]) }
        return successEnvelope([
          "item": ["ticketId": ticketA, "request": ["operation": "status"]]
        ])
      case "/v1/reply":
        return successEnvelope(["accepted": true])
      default:
        throw VeyraNConnectError.responseInvalid
      }
    }

    let engine = VeyraNConnectSessionEngine(pairing: pairing, transport: transport)
    expect(!engine.isActive(), "a fresh engine is inactive")

    do {
      let session = try await engine.establishSession(
        accountId: "account-1",
        grantsGeneration: 3,
        clientId: "veyran-host",
        expectedLease: engine.currentLeaseGeneration()
      )
      expect(session.sessionId == sessionId, "the broker session id is adopted")
      expect(session.grantsGeneration == 3, "the broker grants generation is adopted")
      expect(engine.isActive(), "the session is active")
    } catch {
      expect(false, "a session is established")
    }

    // Health mismatch: a foreign broker identity is refused.
    let foreignTransport = ScriptedTransport { path, _ in
      if path == "/v1/health" {
        return successEnvelope([
          "service": "veyran-connect",
          "protocolVersion": 1,
          "brokerId": String(repeating: "e", count: 32),
          "bootId": bootId,
          "port": 45999
        ])
      }
      return successEnvelope(["sessionId": sessionId, "grantsGeneration": 3])
    }
    let foreignEngine = VeyraNConnectSessionEngine(pairing: pairing, transport: foreignTransport)
    do {
      _ = try await foreignEngine.establishSession(
        accountId: "account-1",
        grantsGeneration: 3,
        clientId: "veyran-host",
        expectedLease: foreignEngine.currentLeaseGeneration()
      )
      expect(false, "a foreign broker identity is refused")
    } catch let error as VeyraNConnectError {
      expect(error == .tlsRejected, "a foreign broker identity is refused")
    } catch {
      expect(false, "a foreign broker identity is refused")
    }

    // Nonce starts at 1 and strictly increases.
    do {
      let first = try await engine.claim()
      expect(first == .empty, "an empty claim is reported as empty")
      expect(transport.lastBody()?["nonce"] as? Int == 1, "the first claim nonce is 1")

      let second = try await engine.claim()
      expect(transport.lastBody()?["nonce"] as? Int == 2, "the second claim nonce is 2")
      switch second {
      case let .request(ticketId, _):
        expect(ticketId == ticketA, "the request ticket is correlated")
      case .empty:
        expect(false, "the second claim returns a request")
      }

      // A second claim while one is outstanding is refused locally.
      do {
        _ = try await engine.claim()
        expect(false, "a concurrent claim is refused")
      } catch let error as VeyraNConnectError {
        expect(error == .busy, "a concurrent claim is refused")
      }

      // Replying to the wrong ticket is refused.
      do {
        try await engine.reply(ticketId: ticketB, response: ["ok": true, "result": [:]])
        expect(false, "an uncorrelated reply is refused")
      } catch let error as VeyraNConnectError {
        expect(error == .correlationMismatch, "an uncorrelated reply is refused")
      }

      // Replying to the correlated ticket succeeds and advances the nonce.
      try await engine.reply(ticketId: ticketA, response: ["ok": true, "result": [:]])
      expect(transport.lastBody()?["nonce"] as? Int == 3, "the reply nonce is 3")
      expect(transport.lastBody()?["ticketId"] as? String == ticketA, "the reply carries the ticket")
      expect(!engine.hasOutstandingClaim(), "the correlation is cleared after a reply")
    } catch {
      expect(false, "claim/reply sequence completes")
    }

    // Reply session/flow fence: a reply whose expected native lease generation
    // or session id does not match the live session is refused *before* it is
    // sent, even though the ticket id is still outstanding.
    do {
      let claim = try await engine.claim()
      guard case let .request(ticketId, _) = claim else {
        expect(false, "a fresh request claim is offered for the fence test")
        return
      }
      guard let context = engine.sessionContext() else {
        expect(false, "the live session context is available")
        return
      }
      do {
        try await engine.reply(
          ticketId: ticketId,
          response: ["ok": true, "result": [:]],
          expectedFlow: context.generation + 1,
          expectedSessionId: context.sessionId
        )
        expect(false, "a reply with the wrong native lease generation is refused")
      } catch let error as VeyraNConnectError {
        expect(error == .sessionRequired, "a reply with the wrong native lease generation is refused")
      }
      do {
        try await engine.reply(
          ticketId: ticketId,
          response: ["ok": true, "result": [:]],
          expectedFlow: context.generation,
          expectedSessionId: String(repeating: "A", count: 22)
        )
        expect(false, "a reply with the wrong session id is refused")
      } catch let error as VeyraNConnectError {
        expect(error == .sessionRequired, "a reply with the wrong session id is refused")
      }
      // The refusals never answered the claim: the ticket is still outstanding,
      // proving no reply frame was sent for the replaced session.
      expect(
        engine.hasOutstandingClaim(),
        "a fenced reply leaves the correlation outstanding"
      )
      try await engine.reply(
        ticketId: ticketId,
        response: ["ok": true, "result": [:]],
        expectedFlow: context.generation,
        expectedSessionId: context.sessionId
      )
      expect(!engine.hasOutstandingClaim(), "a correctly fenced reply is accepted")
    } catch {
      expect(false, "reply session fence completes")
    }

    // Cancellation invalidates the session and bumps the lease generation.
    let before = engine.currentLeaseGeneration()
    _ = engine.invalidate()
    expect(!engine.isActive(), "invalidate ends the session")
    expect(engine.currentLeaseGeneration() > before, "invalidate bumps the lease generation")
    do {
      _ = try await engine.claim()
      expect(false, "a claim after cancel is refused")
    } catch let error as VeyraNConnectError {
      expect(error == .sessionRequired, "a claim after cancel is refused")
    } catch {
      expect(false, "a claim after cancel is refused")
    }

    // Bounded, non-exploding backoff.
    expect(VeyraNConnectSessionEngine.backoffMillis(attempt: 0) == 250, "backoff starts bounded")
    expect(VeyraNConnectSessionEngine.backoffMillis(attempt: 99) == 5000, "backoff is capped")
  }

  // MARK: strict JSON types

  private static func testStrictJsonTypes() {
    print("strict json types")
    expect(
      VeyraNConnectValidate.strictInt(NSNumber(value: 45999)) == 45999,
      "a plain integer is accepted"
    )
    expect(
      VeyraNConnectValidate.strictInt(NSNumber(value: true)) == nil,
      "a boolean is not an integer"
    )
    expect(
      VeyraNConnectValidate.strictInt(NSNumber(value: 1.5)) == nil,
      "a fraction is not an integer"
    )
    expect(
      VeyraNConnectValidate.strictInt(NSNumber(value: 9_007_199_254_740_992)) == nil,
      "an out-of-safe integer is rejected"
    )
    expect(VeyraNConnectValidate.strictInt("45999") == nil, "a string is not an integer")
    expect(
      VeyraNConnectValidate.strictBool(NSNumber(value: true)) == true,
      "a boolean is accepted"
    )
    expect(
      VeyraNConnectValidate.strictBool(NSNumber(value: 1)) == nil,
      "a number is not a boolean"
    )
    expect(VeyraNConnectValidate.strictBool(NSNumber(value: 0)) == nil, "zero is not a boolean")
    expect(VeyraNConnectValidate.strictBool("true") == nil, "a string is not a boolean")

    // The envelope `ok` must be a real JSON boolean, not the number 1.
    let numericOk = try! JSONSerialization.data(withJSONObject: ["ok": 1, "result": [:]])
    expect(VeyraNConnectBroker.decode(numericOk) == nil, "a numeric ok is refused")
    let booleanOk = try! JSONSerialization.data(withJSONObject: ["ok": true, "result": [:]])
    expect(VeyraNConnectBroker.decode(booleanOk) != nil, "a boolean ok is accepted")
    let booleanVersion = try! JSONSerialization.data(withJSONObject: ["v": true])
    expect(
      VeyraNConnectPairing.parse(data: booleanVersion) == nil,
      "a boolean wire version is refused"
    )
    let fractionalPort = try! JSONSerialization.data(withJSONObject: ["port": 45999.5])
    expect(
      VeyraNConnectPairing.parse(data: fractionalPort) == nil,
      "a fractional port is refused"
    )
  }

  // MARK: duplicate keys

  private static func testDuplicateKeys() {
    print("strict duplicate keys")
    expect(
      VeyraNConnectStrictJSON.hasUniqueObjectKeys("{\"v\":1}"),
      "unique object keys are accepted"
    )
    expect(
      !VeyraNConnectStrictJSON.hasUniqueObjectKeys("{\"v\":1,\"v\":2}"),
      "a duplicate key is rejected"
    )
    expect(
      !VeyraNConnectStrictJSON.hasUniqueObjectKeys("{\"a\":{\"x\":1,\"x\":2}}"),
      "a nested duplicate key is rejected"
    )
    expect(
      !VeyraNConnectStrictJSON.hasUniqueObjectKeys("{\"\\u0076\":1,\"v\":2}"),
      "an escaped duplicate key is rejected"
    )
    expect(
      VeyraNConnectStrictJSON.hasUniqueObjectKeys("{\"a\":[1,2,{\"b\":true}],\"c\":null}"),
      "a nested document with unique keys is accepted"
    )
    expect(
      !VeyraNConnectStrictJSON.hasUniqueObjectKeys("{\"a\":1} trailing"),
      "trailing garbage is rejected"
    )
    expect(!VeyraNConnectStrictJSON.hasUniqueObjectKeys(""), "an empty document is rejected")

    let brokerId = String(repeating: "b", count: 32)
    let appId = String(repeating: "a", count: 32)
    let pinC = String(repeating: "c", count: 64)
    let pinD = String(repeating: "d", count: 64)
    let good =
      "{\"v\":1,\"service\":\"veyran-connect\",\"brokerId\":\"\(brokerId)\",\"port\":45999,"
      + "\"app\":{\"id\":\"\(appId)\",\"secret\":\"\(pairingSecret)\"},"
      + "\"tls\":{\"rootPem\":\"pem\",\"leafPin\":\"\(pinC)\"}}"
    let duplicate =
      "{\"v\":1,\"service\":\"veyran-connect\",\"brokerId\":\"\(brokerId)\",\"port\":45999,"
      + "\"app\":{\"id\":\"\(appId)\",\"secret\":\"\(pairingSecret)\"},"
      + "\"tls\":{\"rootPem\":\"pem\",\"leafPin\":\"\(pinC)\",\"leafPin\":\"\(pinD)\"}}"
    expect(
      VeyraNConnectPairing.parse(data: Data(good.utf8)) != nil,
      "a unique-key pairing document still parses"
    )
    expect(
      VeyraNConnectPairing.parse(data: Data(duplicate.utf8)) == nil,
      "a document with a duplicated leafPin is refused"
    )
  }

  // MARK: session flow fencing

  private static func testSessionFlowFencing() async {
    print("session flow fencing")
    let brokerId = String(repeating: "b", count: 32)
    let bootId = String(repeating: "d", count: 32)
    let sessionId = VeyraNConnectBase64URL.encode(Data(repeating: 7, count: 16))
    let pairing = makePairing(brokerId: brokerId, port: 45999)
    let ticketA = String(repeating: "1", count: 32)

    func healthEnvelope() -> Data {
      return successEnvelope([
        "service": "veyran-connect",
        "protocolVersion": 1,
        "brokerId": brokerId,
        "bootId": bootId,
        "port": 45999
      ])
    }
    func sessionEnvelope() -> Data {
      return successEnvelope(["sessionId": sessionId, "grantsGeneration": 1])
    }

    // 1. invalidate() during the session handshake must never resurrect active.
    do {
      let gate = AsyncGate()
      let sent = AsyncSignal()
      let transport = AsyncTransport { path, _ in
        switch path {
        case "/v1/health": return healthEnvelope()
        case "/v1/session":
          sent.signal()
          await gate.waitAsync()
          return sessionEnvelope()
        default: throw VeyraNConnectError.responseInvalid
        }
      }
      let engine = VeyraNConnectSessionEngine(pairing: pairing, transport: transport)
      let task = Task {
        try await engine.establishSession(
          accountId: "account-1",
          grantsGeneration: 1,
          clientId: "veyran-host",
          expectedLease: engine.currentLeaseGeneration()
        )
      }
      await sent.waitAsync()
      engine.invalidate()
      gate.open()
      switch await task.result {
      case .success:
        expect(false, "a session invalidated mid-handshake must not resurrect")
      case let .failure(error):
        expect(
          (error as? VeyraNConnectError) == .sessionRequired,
          "a session invalidated mid-handshake is refused"
        )
      }
      expect(!engine.isActive(), "the engine stays inactive after a late handshake result")
    }

    // 2. Two concurrent claims must not share the nonce sequence.
    do {
      let gate = AsyncGate()
      let sent = AsyncSignal()
      let transport = AsyncTransport { path, _ in
        switch path {
        case "/v1/health": return healthEnvelope()
        case "/v1/session": return sessionEnvelope()
        case "/v1/claim":
          sent.signal()
          await gate.waitAsync()
          return successEnvelope(["item": NSNull()])
        default: throw VeyraNConnectError.responseInvalid
        }
      }
      let engine = VeyraNConnectSessionEngine(pairing: pairing, transport: transport)
      _ = try? await engine.establishSession(
        accountId: "account-1",
        grantsGeneration: 1,
        clientId: "veyran-host",
        expectedLease: engine.currentLeaseGeneration()
      )
      let first = Task { try await engine.claim() }
      await sent.waitAsync()
      do {
        _ = try await engine.claim()
        expect(false, "a concurrent claim is refused while one is in flight")
      } catch let error as VeyraNConnectError {
        expect(error == .busy, "a concurrent claim is refused while one is in flight")
      } catch {
        expect(false, "a concurrent claim is refused while one is in flight")
      }
      gate.open()
      _ = try? await first.value
      // The gate is now open; the in-flight slot must have been released.
      _ = try? await engine.claim()
      expect(true, "the claim slot is released after the in-flight claim")
    }

    // 3. A late reply after invalidate() must be refused.
    do {
      let gate = AsyncGate()
      let sent = AsyncSignal()
      let transport = AsyncTransport { path, _ in
        switch path {
        case "/v1/health": return healthEnvelope()
        case "/v1/session": return sessionEnvelope()
        case "/v1/claim":
          return successEnvelope([
            "item": ["ticketId": ticketA, "request": ["operation": "status"]]
          ])
        case "/v1/reply":
          sent.signal()
          await gate.waitAsync()
          return successEnvelope(["accepted": true])
        default: throw VeyraNConnectError.responseInvalid
        }
      }
      let engine = VeyraNConnectSessionEngine(pairing: pairing, transport: transport)
      _ = try? await engine.establishSession(
        accountId: "account-1",
        grantsGeneration: 1,
        clientId: "veyran-host",
        expectedLease: engine.currentLeaseGeneration()
      )
      let claim = try? await engine.claim()
      guard case .request = claim ?? .empty else {
        expect(false, "a claim yields a correlated request")
        return
      }
      let reply = Task {
        try await engine.reply(ticketId: ticketA, response: ["ok": true, "result": [:]])
      }
      await sent.waitAsync()
      engine.invalidate()
      gate.open()
      switch await reply.result {
      case .success:
        expect(false, "a reply invalidated mid-flight must be refused")
      case let .failure(error):
        expect(
          (error as? VeyraNConnectError) == .sessionRequired,
          "a reply invalidated mid-flight is refused"
        )
      }
    }

    // 4. An unanswered ticket and the lease both expire so the poll loop ends.
    do {
      let clock = MutableClock(Date())
      let transport = ScriptedTransport { path, _ in
        switch path {
        case "/v1/health": return healthEnvelope()
        case "/v1/session": return sessionEnvelope()
        case "/v1/claim":
          return successEnvelope([
            "item": ["ticketId": ticketA, "request": ["operation": "status"]]
          ])
        default: throw VeyraNConnectError.responseInvalid
        }
      }
      let engine = VeyraNConnectSessionEngine(
        pairing: pairing,
        transport: transport,
        clock: clock
      )
      _ = try? await engine.establishSession(
        accountId: "account-1",
        grantsGeneration: 1,
        clientId: "veyran-host",
        expectedLease: engine.currentLeaseGeneration()
      )
      _ = try? await engine.claim()
      expect(engine.hasOutstandingClaim(), "the request claim is outstanding")
      expect(!engine.outstandingTicketExpired(), "a fresh outstanding ticket has not expired")
      clock.advance(VeyraNConnectSessionEngine.leaseSeconds + 1)
      expect(engine.outstandingTicketExpired(), "an unanswered ticket expires with its lease")
      expect(engine.leaseExpired(), "the lease expires even while a claim is outstanding")
    }

    // 5. A broker session error is surfaced as an explicit re-establish, not an
    // endless generic backoff against the wrong session.
    do {
      let transport = ScriptedTransport { path, _ in
        switch path {
        case "/v1/health": return healthEnvelope()
        case "/v1/session": return sessionEnvelope()
        case "/v1/claim":
          return try! JSONSerialization.data(withJSONObject: [
            "ok": false,
            "error": [
              "code": "SESSION_CHANGED",
              "message": "The app session changed or was replaced."
            ]
          ])
        default: throw VeyraNConnectError.responseInvalid
        }
      }
      let engine = VeyraNConnectSessionEngine(pairing: pairing, transport: transport)
      _ = try? await engine.establishSession(
        accountId: "account-1",
        grantsGeneration: 1,
        clientId: "veyran-host",
        expectedLease: engine.currentLeaseGeneration()
      )
      do {
        _ = try await engine.claim()
        expect(false, "a broker SESSION_CHANGED claim is an explicit session error")
      } catch let error as VeyraNConnectError {
        expect(
          error == .sessionRequired,
          "a broker SESSION_CHANGED claim is an explicit session error"
        )
      } catch {
        expect(false, "a broker SESSION_CHANGED claim is an explicit session error")
      }
    }
  }
}
