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

//
// Runtime harness for the *real* production `URLSession` transport.
//
// The pure `SecTrust` fixture in `Tests/VeyraNConnectHarness.swift` proves the
// trust/pin *policy*; this harness proves the actual handshake behaviour against
// a live throwaway HTTPS fixture (`Tests/runtime/fixture.mjs`), including that a
// wrong CA or wrong pin writes **zero** HTTP bytes.
//
// It is a separate executable from the pure harness (each has its own `@main`):
//
//   node apps/mobile/ios/Notesnook/VeyraNConnect/Tests/runtime/fixture.mjs \
//     --dir "$RUNTIME_DIR" --mode valid &
//   swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
//     -target arm64-apple-ios18.0-macabi -swift-version 5 -parse-as-library \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectWire.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectSession.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectPairingFile.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectTLS.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/Tests/runtime/RuntimeMain.swift \
//     -o "$TMPDIR/veyran-runtime-harness"
//   VEYRAN_RUNTIME_DIR="$RUNTIME_DIR" VEYRAN_RUNTIME_SCENARIO=valid \
//     "$TMPDIR/veyran-runtime-harness"
//
// Scenarios: valid | wrongpin | wrongca | oversized | compressed | redirect.
// A scenario run asserts `requests.log` is empty for wrongpin / wrongca.

import Foundation
import Security

@main
struct VeyraNConnectRuntimeHarness {
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
    guard let dir = ProcessInfo.processInfo.environment["VEYRAN_RUNTIME_DIR"] else {
      print("FAIL: VEYRAN_RUNTIME_DIR is required")
      exit(2)
    }
    let scenario =
      ProcessInfo.processInfo.environment["VEYRAN_RUNTIME_SCENARIO"] ?? "valid"
    let requestsLog = dir + "/requests.log"

    guard case let .success(pairing) = VeyraNConnectPairingFileReader.read(
      path: dir + "/connection.export.json"
    ) else {
      print("FAIL: the fixture pairing document is not readable")
      exit(2)
    }

    switch scenario {
    case "valid":
      await runValid(pairing: pairing)
    case "wrongpin":
      await runWrongPin(pairing: pairing, requestsLog: requestsLog)
    case "wrongca":
      await runWrongCA(pairing: pairing, dir: dir, requestsLog: requestsLog)
    case "oversized":
      await runExpectFailure(
        pairing: pairing,
        label: "an oversized response aborts as responseInvalid"
      )
    case "compressed":
      await runExpectFailure(
        pairing: pairing,
        label: "a compressed response is refused"
      )
    case "redirect":
      await runExpectFailure(
        pairing: pairing,
        label: "a redirect is refused"
      )
    default:
      print("FAIL: unknown scenario \(scenario)")
      exit(2)
    }

    print("")
    if failures == 0 {
      print("PASS: \(checks) checks")
    } else {
      print("FAIL: \(failures) of \(checks) checks failed")
      exit(1)
    }
  }

  // MARK: scenarios

  private static func runValid(pairing: VeyraNConnectPairing) async {
    print("runtime transport (valid)")
    guard let transport = try? VeyraNConnectURLSessionTransport(pairing: pairing)
    else {
      expect(false, "the transport is built from the fixture root")
      return
    }
    do {
      guard let healthBody = VeyraNConnectRequests.health() else {
        expect(false, "a health frame is built")
        return
      }
      let healthData = try await transport.send(
        path: "/v1/health",
        body: healthBody,
        timeout: 10
      )
      guard let decoded = VeyraNConnectBroker.decode(healthData),
        case let .success(result) = decoded,
        let health = VeyraNConnectHealth.parse(result)
      else {
        expect(false, "the health response is a valid envelope")
        return
      }
      expect(
        health.brokerId == pairing.brokerId && health.port == pairing.port,
        "the live handshake presents the paired identity"
      )

      guard let sessionBody = VeyraNConnectRequests.session(
        clientNonce: VeyraNConnectBase64URL.encode(Data(repeating: 3, count: 16)),
        accountId: "account-1",
        grantsGeneration: 7
      ) else {
        expect(false, "a session frame is built")
        return
      }
      let sessionData = try await transport.send(
        path: "/v1/session",
        body: sessionBody,
        timeout: 10
      )
      if let decoded = VeyraNConnectBroker.decode(sessionData),
        case let .success(result) = decoded,
        VeyraNConnectSession.parse(result) != nil
      {
        expect(true, "the session response is accepted over the real TLS session")
      } else {
        expect(false, "the session response is accepted over the real TLS session")
      }

      guard let claimBody = VeyraNConnectRequests.claim(
        sessionId: "dmV5cmFuLXNlc3Npb24xNg",
        nonce: 1,
        clientId: "veyran-host"
      ) else {
        expect(false, "a claim frame is built")
        return
      }
      let claimData = try await transport.send(
        path: "/v1/claim",
        body: claimBody,
        timeout: 10
      )
      if let decoded = VeyraNConnectBroker.decode(claimData),
        case let .success(result) = decoded,
        let claim = VeyraNConnectClaim.parse(result),
        case .request = claim
      {
        expect(true, "a correlated request is claimed")
      } else {
        expect(false, "a correlated request is claimed")
      }

      guard let replyBody = VeyraNConnectRequests.reply(
        sessionId: "dmV5cmFuLXNlc3Npb24xNg",
        nonce: 2,
        clientId: "veyran-host",
        ticketId: String(repeating: "1", count: 32),
        response: ["ok": true, "result": ["operation": "status"]]
      ) else {
        expect(false, "a reply frame is built")
        return
      }
      let replyData = try await transport.send(
        path: "/v1/reply",
        body: replyBody,
        timeout: 10
      )
      if let decoded = VeyraNConnectBroker.decode(replyData),
        case let .success(result) = decoded,
        VeyraNConnectReplyAck.parse(result)
      {
        expect(true, "the reply is acknowledged")
      } else {
        expect(false, "the reply is acknowledged")
      }
    } catch {
      expect(false, "the valid exchange completes (\(error))")
    }
  }

  private static func runWrongPin(
    pairing: VeyraNConnectPairing,
    requestsLog: String
  ) async {
    print("runtime transport (wrong pin)")
    let wrong = VeyraNConnectPairing(
      brokerId: pairing.brokerId,
      port: pairing.port,
      appId: pairing.appId,
      appSecret: pairing.appSecret,
      rootPem: pairing.rootPem,
      leafPin: String(repeating: "0", count: 64)
    )
    await expectHandshakeRejected(wrong, requestsLog: requestsLog, label: "wrong pin")
  }

  private static func runWrongCA(
    pairing: VeyraNConnectPairing,
    dir: String,
    requestsLog: String
  ) async {
    print("runtime transport (wrong CA)")
    guard let otherRoot = readText(dir + "/other-root.pem") else {
      expect(false, "the fixture provides an unrelated root")
      return
    }
    let wrong = VeyraNConnectPairing(
      brokerId: pairing.brokerId,
      port: pairing.port,
      appId: pairing.appId,
      appSecret: pairing.appSecret,
      rootPem: otherRoot,
      leafPin: pairing.leafPin
    )
    await expectHandshakeRejected(wrong, requestsLog: requestsLog, label: "wrong CA")
  }

  private static func expectHandshakeRejected(
    _ pairing: VeyraNConnectPairing,
    requestsLog: String,
    label: String
  ) async {
    guard let transport = try? VeyraNConnectURLSessionTransport(pairing: pairing),
      let body = VeyraNConnectRequests.health()
    else {
      expect(false, "\(label): the transport is built")
      return
    }
    var rejected = false
    do {
      _ = try await transport.send(path: "/v1/health", body: body, timeout: 10)
    } catch let error as VeyraNConnectError {
      rejected = error == .tlsRejected
    } catch {
      rejected = false
    }
    expect(rejected, "\(label): the handshake is refused as tlsRejected")
    // Zero HTTP: the fixture appends one line per application request.
    let log = readText(requestsLog) ?? ""
    expect(log.isEmpty, "\(label): zero HTTP request bytes were written")
  }

  private static func runExpectFailure(
    pairing: VeyraNConnectPairing,
    label: String
  ) async {
    print("runtime transport (refusal)")
    guard let transport = try? VeyraNConnectURLSessionTransport(pairing: pairing),
      let body = VeyraNConnectRequests.health()
    else {
      expect(false, label)
      return
    }
    do {
      _ = try await transport.send(path: "/v1/health", body: body, timeout: 10)
      expect(false, label)
    } catch let error as VeyraNConnectError {
      expect(error == .responseInvalid, label)
    } catch {
      expect(false, label)
    }
  }

  // MARK: helpers

  private static func readText(_ path: String) -> String? {
    let descriptor = open(path, O_RDONLY)
    guard descriptor >= 0 else { return nil }
    defer { close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_size >= 0,
      info.st_size < 1024 * 1024
    else { return nil }
    let size = Int(info.st_size)
    guard size > 0 else { return "" }
    var data = Data(count: size)
    let read = data.withUnsafeMutableBytes { buffer -> Int in
      guard let base = buffer.baseAddress else { return -1 }
      var total = 0
      while total < size {
        let count = pread(descriptor, base + total, size - total, off_t(total))
        if count <= 0 { return count < 0 ? -1 : total }
        total += count
      }
      return total
    }
    guard read == size else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
