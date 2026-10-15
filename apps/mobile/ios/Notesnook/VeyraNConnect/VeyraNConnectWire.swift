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

// Pure VeyraN Connect wire protocol for the native client.
//
// This file imports only Foundation (plus Security for the CSPRNG). It must
// never import React/UIKit: that is what lets the standalone Swift harness in
// `Tests/` compile and exercise it without an app, entitlements or a
// simulator. Its shapes mirror the accepted broker source exactly
// (`servers/veyran-connect/src/broker-wire.ts`, `config.ts`, `credentials.ts`,
// `limits.ts`): a mismatch fails closed here, before any HTTP byte is written.

import Foundation
import Security

// MARK: - Constants

enum VeyraNConnectWire {
  /// The one service name the pairing/config documents may carry.
  static let service = "veyran-connect"
  /// The only protocol version this client speaks.
  static let protocolVersion = 1
  /// The only loopback address the client ever dials or trusts.
  static let loopbackHost = "127.0.0.1"

  static let maxPairingFileBytes = 64 * 1024
  static let maxRootPemBytes = 16 * 1024
  static let maxRequestBytes = 1024 * 1024 // 1 MiB (health/session/claim)
  static let maxReplyBytes = 5 * 1024 * 1024 // 5 MiB (app reply upload)
  static let maxResponseBytes = 5 * 1024 * 1024 // 5 MiB

  /// 32-byte broker credential secret, unpadded base64url (43 chars).
  static let secretBytes = 32
  static let secretChars = 43
  /// 16-byte handshake nonce / instance id, unpadded base64url (22 chars).
  static let instanceNonceBytes = 16
  static let instanceNonceChars = 22
  /// 16-byte credential id / boot id, lower-case hex (32 chars).
  static let hexIdChars = 32
  /// SHA-256 of the leaf DER, lower-case hex (64 chars).
  static let leafPinChars = 64

  static let minPort = 1024
  static let maxPort = 65535

  /// App-chosen caller label; bounded, never an authorization input.
  static let minClientIdChars = 6
  static let maxClientIdChars = 200
  static let maxAccountIdChars = 200

  static let maxTicketIdChars = 32
}

// MARK: - Errors

/// The bounded local failure surface. Every case maps to a fixed string and
/// never interpolates payloads, ids or caught errors.
enum VeyraNConnectError: Error, Equatable {
  case unsupportedPlatform
  case notPaired
  case pairingCancelled
  case pairingInvalid
  case pairingFileInsecure
  case keychainFailure
  case transportUnavailable
  case tlsRejected
  case sessionRequired
  case responseInvalid
  case correlationMismatch
  case busy

  var code: String {
    switch self {
    case .unsupportedPlatform: return "unsupported"
    case .notPaired: return "not_paired"
    case .pairingCancelled: return "pairing_cancelled"
    case .pairingInvalid: return "pairing_invalid"
    case .pairingFileInsecure: return "pairing_file_insecure"
    case .keychainFailure: return "keychain_failure"
    case .transportUnavailable: return "transport_unavailable"
    case .tlsRejected: return "tls_rejected"
    case .sessionRequired: return "session_required"
    case .responseInvalid: return "response_invalid"
    case .correlationMismatch: return "correlation_mismatch"
    case .busy: return "busy"
    }
  }
}

// MARK: - Unpadded base64url

enum VeyraNConnectBase64URL {
  private static let encodeTable: [Character] =
    Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

  static func encode(_ data: Data) -> String {
    var out = ""
    out.reserveCapacity((data.count * 4 + 2) / 3)
    var buffer = 0
    var bits = 0
    for byte in data {
      buffer = (buffer << 8) | Int(byte)
      bits += 8
      while bits >= 6 {
        bits -= 6
        out.append(encodeTable[(buffer >> bits) & 0x3f])
      }
    }
    if bits > 0 {
      out.append(encodeTable[(buffer << (6 - bits)) & 0x3f])
    }
    return out
  }

  /// Strict decode: only `[A-Za-z0-9_-]`, no padding, no whitespace and no
  /// invalid group length. Re-encoding a successful decode returns the input
  /// byte-for-byte, which is what rejects a value carrying extra unused bits.
  static func decode(_ value: String) -> Data? {
    if value.isEmpty { return nil }
    if value.count % 4 == 1 { return nil }
    var buffer = 0
    var bits = 0
    var out = Data()
    out.reserveCapacity((value.count * 3) / 4)
    for character in value {
      let index: Int
      switch character {
      case "A"..."Z":
        index = Int(character.asciiValue! - 65)
      case "a"..."z":
        index = Int(character.asciiValue! - 97) + 26
      case "0"..."9":
        index = Int(character.asciiValue! - 48) + 52
      case "-":
        index = 62
      case "_":
        index = 63
      default:
        return nil
      }
      buffer = (buffer << 6) | index
      bits += 6
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((buffer >> bits) & 0xff))
      }
    }
    return out
  }

  /// Decode a value that must be exactly `bytes` long and canonical (i.e. the
  /// re-encoded form is identical). This is what rejects a 43-char secret that
  /// merely looks long but carries unused low bits.
  static func decodeCanonical(_ value: String, bytes: Int) -> Data? {
    guard let data = decode(value) else { return nil }
    guard data.count == bytes else { return nil }
    guard encode(data) == value else { return nil }
    return data
  }
}

// MARK: - Small validators

enum VeyraNConnectValidate {
  /// Largest integer JavaScript can represent exactly.
  static let maxSafeInteger = 9_007_199_254_740_991

  /// A strict integer coming out of `JSONSerialization`.
  ///
  /// Swift's `as? Int` happily bridges `__NSCFBoolean` (`true` -> 1) and can
  /// round a fractional or out-of-range `NSNumber`; this rejects a CoreFoundation
  /// boolean, a fractional value and anything outside the exact-integer range,
  /// using the number's own canonical string form rather than a lossy `Double`.
  static func strictInt(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber else { return nil }
    guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    guard let parsed = Int(number.stringValue) else { return nil }
    guard parsed <= maxSafeInteger, parsed >= -maxSafeInteger else { return nil }
    return parsed
  }

  /// A strict boolean: only a true CoreFoundation boolean bridges, never the
  /// numbers `1`/`0` that `as? Bool` also accepts.
  static func strictBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber else { return nil }
    guard CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  static func isHex(_ value: String, count: Int) -> Bool {
    guard value.count == count else { return false }
    for character in value {
      switch character {
      case "0"..."9", "a"..."f":
        continue
      default:
        return false
      }
    }
    return true
  }

  static func b64url(_ value: String, chars: Int, bytes: Int) -> Bool {
    guard value.count == chars else { return false }
    return VeyraNConnectBase64URL.decodeCanonical(value, bytes: bytes) != nil
  }

  static func isLoopbackHost(_ host: String) -> Bool {
    host == VeyraNConnectWire.loopbackHost
  }

  /// The single URL shape this client ever dials. The port is already numeric
  /// and bounded, so no host, scheme, path or query can be supplied.
  static func url(port: Int) -> URL? {
    guard port >= VeyraNConnectWire.minPort, port <= VeyraNConnectWire.maxPort
    else { return nil }
    return URL(string: "https://\(VeyraNConnectWire.loopbackHost):\(port)")
  }

  static func routePath(_ route: String) -> String? {
    switch route {
    case "health", "session", "claim", "reply":
      return "/v1/\(route)"
    default:
      return nil
    }
  }

  static func clientId(_ value: String) -> Bool {
    guard value.count >= VeyraNConnectWire.minClientIdChars,
      value.count <= VeyraNConnectWire.maxClientIdChars
    else { return false }
    for character in value {
      switch character {
      case "A"..."Z", "a"..."z", "0"..."9", "_", ":", ".", "-":
        continue
      default:
        return false
      }
    }
    return true
  }

  static func accountId(_ value: String) -> Bool {
    guard value.count >= VeyraNConnectWire.minClientIdChars,
      value.count <= VeyraNConnectWire.maxAccountIdChars
    else { return false }
    for character in value {
      switch character {
      case "A"..."Z", "a"..."z", "0"..."9", "_", ":", ".", "-":
        continue
      default:
        return false
      }
    }
    return true
  }
}

// MARK: - Strict duplicate-key detection

/// A bounded, allocation-light JSON scanner used *only* to reject duplicate
/// object keys in a security-sensitive document.
///
/// `JSONSerialization` accepts a duplicate key (last wins), so a document that
/// spells `"leafPin"` twice would silently take the second value. This scanner
/// refuses any document in which a key repeats inside the same object (after
/// decoding `\u` escapes), so the accepted document has exactly one
/// interpretation. Values are still produced by `JSONSerialization`; this only
/// gates acceptance, and any input it cannot fully scan is rejected.
enum VeyraNConnectStrictJSON {
  static func hasUniqueObjectKeys(_ text: String) -> Bool {
    var scanner = Scanner(Array(text.unicodeScalars))
    return scanner.parseTopLevel()
  }

  private struct Scanner {
    let scalars: [Unicode.Scalar]
    var index = 0

    init(_ scalars: [Unicode.Scalar]) { self.scalars = scalars }

    mutating func parseTopLevel() -> Bool {
      if !parseValue() { return false }
      skipWhitespace()
      return index == scalars.count
    }

    mutating func skipWhitespace() {
      while index < scalars.count {
        switch scalars[index] {
        case " ", "\t", "\n", "\r": index += 1
        default: return
        }
      }
    }

    mutating func parseValue() -> Bool {
      skipWhitespace()
      guard index < scalars.count else { return false }
      switch scalars[index] {
      case "{": return parseObject()
      case "[": return parseArray()
      case "\"": return parseString() != nil
      case "t", "f", "n": return parseLiteral()
      case "-", "0"..."9": return parseNumber()
      default: return false
      }
    }

    mutating func parseObject() -> Bool {
      index += 1 // consume '{'
      skipWhitespace()
      var seen = Set<String>()
      if index < scalars.count, scalars[index] == "}" {
        index += 1
        return true
      }
      while true {
        skipWhitespace()
        guard let key = parseString() else { return false }
        if !seen.insert(key).inserted { return false }
        skipWhitespace()
        guard index < scalars.count, scalars[index] == ":" else { return false }
        index += 1
        if !parseValue() { return false }
        skipWhitespace()
        guard index < scalars.count else { return false }
        switch scalars[index] {
        case ",": index += 1
        case "}": index += 1; return true
        default: return false
        }
      }
    }

    mutating func parseArray() -> Bool {
      index += 1 // consume '['
      skipWhitespace()
      if index < scalars.count, scalars[index] == "]" {
        index += 1
        return true
      }
      while true {
        if !parseValue() { return false }
        skipWhitespace()
        guard index < scalars.count else { return false }
        switch scalars[index] {
        case ",": index += 1
        case "]": index += 1; return true
        default: return false
        }
      }
    }

    mutating func parseString() -> String? {
      guard index < scalars.count, scalars[index] == "\"" else { return nil }
      index += 1
      var out = String.UnicodeScalarView()
      while index < scalars.count {
        let scalar = scalars[index]
        if scalar == "\"" {
          index += 1
          return String(out)
        }
        if scalar == "\\" {
          index += 1
          guard index < scalars.count else { return nil }
          let escaped = scalars[index]
          switch escaped {
          case "\"", "\\", "/", "b", "f", "n", "r", "t":
            out.append(escaped)
          case "u":
            guard index + 4 < scalars.count else { return nil }
            let hex = String(String.UnicodeScalarView(scalars[(index + 1)...(index + 4)]))
            guard let code = UInt32(hex, radix: 16),
              let decoded = Unicode.Scalar(code)
            else { return nil }
            out.append(decoded)
            index += 5
            continue
          default:
            return nil
          }
          index += 1
          continue
        }
        out.append(scalar)
        index += 1
      }
      return nil
    }

    mutating func parseLiteral() -> Bool {
      for literal in ["true", "false", "null"] {
        let chars = Array(literal.unicodeScalars)
        if index + chars.count <= scalars.count,
          Array(scalars[index..<(index + chars.count)]) == chars
        {
          index += chars.count
          return true
        }
      }
      return false
    }

    /// Lenient number scan: the real grammar is enforced by `JSONSerialization`
    /// afterwards; here we only need to advance past the token without
    /// mistaking a structural character for part of it.
    mutating func parseNumber() -> Bool {
      var digits = 0
      while index < scalars.count {
        switch scalars[index] {
        case "0"..."9": digits += 1; index += 1
        case "-", "+", ".", "e", "E": index += 1
        default: return digits > 0
        }
      }
      return digits > 0
    }
  }
}

// MARK: - Pairing record

/// The persisted, trusted broker identity. Everything here is public except the
/// app credential secret, which lives only in the Keychain record and is never
/// returned to JavaScript.
struct VeyraNConnectPairing: Equatable {
  let brokerId: String
  let port: Int
  let appId: String
  let appSecret: String
  let rootPem: String
  let leafPin: String

  /// `Authorization: Bearer <id>.<secret>` — never placed in a URL or a log.
  var bearerToken: String { "Bearer \(appId).\(appSecret)" }
}

extension VeyraNConnectPairing {
  /// Parse the frozen app pairing document with unknown keys denied.
  ///
  /// Accepted shape (exact):
  ///   { v:1, service:"veyran-connect", brokerId:32hex, port:1024..65535,
  ///     app:{ id:32hex, secret:43 base64url }, tls:{ rootPem<=16KiB,
  ///     leafPin:64hex } }
  static func parse(_ object: Any) -> VeyraNConnectPairing? {
    guard let root = object as? [String: Any] else { return nil }
    guard exactKeys(root, ["v", "service", "brokerId", "port", "app", "tls"])
    else { return nil }
    guard let v = VeyraNConnectValidate.strictInt(root["v"]),
      v == VeyraNConnectWire.protocolVersion
    else { return nil }
    guard let service = root["service"] as? String,
      service == VeyraNConnectWire.service
    else { return nil }
    guard let brokerId = root["brokerId"] as? String,
      VeyraNConnectValidate.isHex(brokerId, count: VeyraNConnectWire.hexIdChars)
    else { return nil }
    guard let port = VeyraNConnectValidate.strictInt(root["port"]),
      port >= VeyraNConnectWire.minPort, port <= VeyraNConnectWire.maxPort
    else { return nil }

    guard let app = root["app"] as? [String: Any],
      exactKeys(app, ["id", "secret"]),
      let appId = app["id"] as? String,
      VeyraNConnectValidate.isHex(appId, count: VeyraNConnectWire.hexIdChars),
      let appSecret = app["secret"] as? String,
      VeyraNConnectValidate.b64url(
        appSecret,
        chars: VeyraNConnectWire.secretChars,
        bytes: VeyraNConnectWire.secretBytes
      )
    else { return nil }

    guard let tls = root["tls"] as? [String: Any],
      exactKeys(tls, ["rootPem", "leafPin"]),
      let rootPem = tls["rootPem"] as? String,
      !rootPem.isEmpty,
      rootPem.utf8.count <= VeyraNConnectWire.maxRootPemBytes,
      let leafPin = tls["leafPin"] as? String,
      VeyraNConnectValidate.isHex(leafPin, count: VeyraNConnectWire.leafPinChars)
    else { return nil }

    return VeyraNConnectPairing(
      brokerId: brokerId,
      port: port,
      appId: appId,
      appSecret: appSecret,
      rootPem: rootPem,
      leafPin: leafPin
    )
  }

  /// Parse raw pairing-file bytes: bounded, strict UTF-8/JSON, no trailing
  /// garbage and **no duplicate object key** (the last-wins behaviour of
  /// `JSONSerialization` is not allowed to reinterpret a security field). A
  /// byte-order mark or a duplicate key is simply not this document.
  static func parse(data: Data) -> VeyraNConnectPairing? {
    guard data.count > 0, data.count <= VeyraNConnectWire.maxPairingFileBytes
    else { return nil }
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    guard VeyraNConnectStrictJSON.hasUniqueObjectKeys(text) else { return nil }
    guard let value = try? JSONSerialization.jsonObject(
      with: data,
      options: [.fragmentsAllowed]
    ) else { return nil }
    return parse(value)
  }

  private static func exactKeys(_ object: [String: Any], _ keys: Set<String>)
    -> Bool
  {
    return Set(object.keys) == keys
  }
}

// MARK: - Broker response envelope

/// The static broker error catalog, mirrored from
/// `servers/veyran-connect/src/errors.ts`. A response whose `message` is not the
/// catalog string for its `code` is rejected, so a foreign/raw string can never
/// pass through this client.
enum VeyraNConnectBrokerErrors {
  static let messages: [String: String] = [
    "BAD_REQUEST": "The broker request is malformed.",
    "UNAUTHORIZED": "The broker credential is missing or invalid.",
    "FORBIDDEN_ORIGIN": "Requests carrying an Origin header are refused.",
    "FORBIDDEN_HOST": "The request Host header is not the broker's exact host.",
    "FORBIDDEN_HEADER": "The request carries a refused hop-by-hop header.",
    "UNSUPPORTED_ENCODING": "Compressed request bodies are not accepted.",
    "PAYLOAD_TOO_LARGE": "The request body exceeds the bounded size limit.",
    "INVALID_UTF8": "The request body is not valid UTF-8.",
    "NOT_FOUND": "The requested broker route does not exist.",
    "SESSION_REQUIRED": "No app session is established.",
    "SESSION_CHANGED": "The app session changed or was replaced.",
    "REPLAY": "A replayed nonce, response or session was refused.",
    "QUEUE_FULL": "The broker queue is full.",
    "QUEUE_EMPTY": "No queued request is available to claim.",
    "ALREADY_CLAIMED": "This client already holds an unanswered claim.",
    "UNCERTAIN": "The request was already claimed; its outcome is uncertain.",
    "APP_UNAVAILABLE": "The VeyraN app is not reachable.",
    "BROKER_UNAVAILABLE": "The VeyraN Connect broker is not reachable.",
    "TRANSPORT_UNAVAILABLE": "The Connect transport channel is unavailable.",
    "CONFIG_INVALID": "The persisted Connect configuration is invalid.",
    "CONFIG_INSECURE": "A persisted Connect file failed its permission checks.",
    "INTERNAL": "The broker could not complete the request."
  ]

  static func isValidEnvelope(_ code: String, _ message: String) -> Bool {
    guard let expected = messages[code] else { return false }
    return expected == message
  }
}

/// A validated broker envelope. Errors are surfaced as `.failure` with the
/// catalog code only; the raw message is never propagated.
enum VeyraNConnectBrokerResponse {
  case success(Any)
  case failure(String)
}

enum VeyraNConnectBroker {
  static func decode(_ data: Data) -> VeyraNConnectBrokerResponse? {
    guard data.count > 0, data.count <= VeyraNConnectWire.maxResponseBytes
    else { return nil }
    guard let value = try? JSONSerialization.jsonObject(
      with: data,
      options: [.fragmentsAllowed]
    ) else { return nil }
    guard let object = value as? [String: Any] else { return nil }
    guard let ok = VeyraNConnectValidate.strictBool(object["ok"]) else { return nil }

    if ok {
      guard Set(object.keys) == ["ok", "result"] else { return nil }
      guard let result = object["result"] else { return nil }
      return .success(result)
    }
    guard Set(object.keys) == ["ok", "error"] else { return nil }
    guard let error = object["error"] as? [String: Any],
      Set(error.keys) == ["code", "message"],
      let code = error["code"] as? String,
      let message = error["message"] as? String,
      VeyraNConnectBrokerErrors.isValidEnvelope(code, message)
    else { return nil }
    return .failure(code)
  }
}

// MARK: - Results

struct VeyraNConnectHealth: Equatable {
  let service: String
  let protocolVersion: Int
  let brokerId: String
  let bootId: String
  let port: Int

  static func parse(_ value: Any) -> VeyraNConnectHealth? {
    guard let object = value as? [String: Any],
      Set(object.keys) == [
        "service", "protocolVersion", "brokerId", "bootId", "port"
      ],
      let service = object["service"] as? String,
      service == VeyraNConnectWire.service,
      let protocolVersion = VeyraNConnectValidate.strictInt(object["protocolVersion"]),
      protocolVersion == VeyraNConnectWire.protocolVersion,
      let brokerId = object["brokerId"] as? String,
      VeyraNConnectValidate.isHex(brokerId, count: VeyraNConnectWire.hexIdChars),
      let bootId = object["bootId"] as? String,
      VeyraNConnectValidate.isHex(bootId, count: VeyraNConnectWire.hexIdChars),
      let port = VeyraNConnectValidate.strictInt(object["port"]),
      port >= VeyraNConnectWire.minPort, port <= VeyraNConnectWire.maxPort
    else { return nil }
    return VeyraNConnectHealth(
      service: service,
      protocolVersion: protocolVersion,
      brokerId: brokerId,
      bootId: bootId,
      port: port
    )
  }
}

struct VeyraNConnectSession: Equatable {
  let sessionId: String
  let grantsGeneration: Int

  static func parse(_ value: Any) -> VeyraNConnectSession? {
    guard let object = value as? [String: Any],
      Set(object.keys) == ["sessionId", "grantsGeneration"],
      let sessionId = object["sessionId"] as? String,
      VeyraNConnectValidate.b64url(
        sessionId,
        chars: VeyraNConnectWire.instanceNonceChars,
        bytes: VeyraNConnectWire.instanceNonceBytes
      ),
      let grantsGeneration = VeyraNConnectValidate.strictInt(
        object["grantsGeneration"]
      ),
      grantsGeneration >= 0
    else { return nil }
    return VeyraNConnectSession(
      sessionId: sessionId,
      grantsGeneration: grantsGeneration
    )
  }
}

/// A claim item: either nothing is queued or one correlated request is offered.
enum VeyraNConnectClaim: Equatable {
  case empty
  case request(ticketId: String, request: Any)

  static func parse(_ value: Any) -> VeyraNConnectClaim? {
    guard let object = value as? [String: Any],
      Set(object.keys) == ["item"]
    else { return nil }
    guard let item = object["item"] else { return nil }
    if item is NSNull { return .empty }
    guard let entry = item as? [String: Any],
      Set(entry.keys) == ["ticketId", "request"],
      let ticketId = entry["ticketId"] as? String,
      VeyraNConnectValidate.isHex(
        ticketId,
        count: VeyraNConnectWire.maxTicketIdChars
      ),
      let request = entry["request"]
    else { return nil }
    return .request(ticketId: ticketId, request: request)
  }

  static func == (lhs: VeyraNConnectClaim, rhs: VeyraNConnectClaim) -> Bool {
    switch (lhs, rhs) {
    case (.empty, .empty):
      return true
    case let (.request(a, _), .request(b, _)):
      return a == b
    default:
      return false
    }
  }
}

enum VeyraNConnectReplyAck {
  static func parse(_ value: Any) -> Bool {
    guard let object = value as? [String: Any],
      Set(object.keys) == ["accepted"],
      let accepted = VeyraNConnectValidate.strictBool(object["accepted"])
    else { return false }
    return accepted
  }
}

// MARK: - Request builders

enum VeyraNConnectRequests {
  static func health() -> Data? { encode(["v": VeyraNConnectWire.protocolVersion]) }

  static func session(
    clientNonce: String,
    accountId: String,
    grantsGeneration: Int
  ) -> Data? {
    encode([
      "v": VeyraNConnectWire.protocolVersion,
      "clientNonce": clientNonce,
      "accountId": accountId,
      "grantsGeneration": grantsGeneration
    ])
  }

  static func claim(sessionId: String, nonce: Int, clientId: String) -> Data? {
    encode([
      "v": VeyraNConnectWire.protocolVersion,
      "sessionId": sessionId,
      "nonce": nonce,
      "clientId": clientId
    ])
  }

  static func reply(
    sessionId: String,
    nonce: Int,
    clientId: String,
    ticketId: String,
    response: Any
  ) -> Data? {
    encode([
      "v": VeyraNConnectWire.protocolVersion,
      "sessionId": sessionId,
      "nonce": nonce,
      "clientId": clientId,
      "ticketId": ticketId,
      "response": response
    ])
  }

  private static func encode(_ object: [String: Any]) -> Data? {
    guard JSONSerialization.isValidJSONObject(object) else { return nil }
    return try? JSONSerialization.data(withJSONObject: object, options: [])
  }
}

// MARK: - Redaction

/// A content-free summary of the current session that is safe to hand to
/// JavaScript. Never carries the credential, the account id or any request.
struct VeyraNConnectStatusSummary: Equatable {
  let paired: Bool
  let pairedBrokerId: String?
  let pairedPort: Int?
  let sessionActive: Bool
  let bootId: String?
  let sessionId: String?
  let grantsGeneration: Int?

  var jsonObject: [String: Any] {
    var out: [String: Any] = [
      "paired": paired,
      "sessionActive": sessionActive
    ]
    if let pairedBrokerId, let pairedPort {
      out["brokerId"] = pairedBrokerId
      out["port"] = pairedPort
    }
    if let bootId { out["bootId"] = bootId }
    if let sessionId { out["sessionId"] = sessionId }
    if let grantsGeneration { out["grantsGeneration"] = grantsGeneration }
    return out
  }
}
