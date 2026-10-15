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

// Pure, dependency-injected core of the VeyraN SIWC ("sign in with ChatGPT")
// provider.
//
// This file imports only Foundation, CryptoKit and Security. It must never
// import React/UIKit: that is what lets the standalone Swift harness in
// `Tests/` compile and exercise the exact production state machine without an
// app, entitlements, a simulator, a real Keychain or any network. Every
// transport, clock and random source is injected; the production adapters live
// in the sibling files (Keychain store, URLSession transports, NWListener
// callback server).
//
// The fixed endpoint map below is the *only* set of origin/paths this provider
// ever dials. No host, scheme, path, query or header is ever taken from JS, a
// model string, a token or a URL authority.

import CryptoKit
import Foundation
import Security

// MARK: - Fixed endpoint / contract constants

enum VeyraNSIWC {
  // --- official, fixed endpoints (never derived from runtime input) ---
  static let authorizeEndpoint = "https://auth.openai.com/api/accounts/authorize"
  static let tokenEndpoint = "https://auth.openai.com/api/accounts/oauth/token"
  static let jwksEndpoint = "https://auth.openai.com/.well-known/jwks.json"
  static let discoveryEndpoint =
    "https://auth.openai.com/.well-known/openid-configuration"
  static let modelsEndpoint = "https://api.openai.com/v1/models"
  static let responsesEndpoint = "https://api.openai.com/v1/responses"

  /// The only token issuer this provider trusts.
  static let issuer = "https://auth.openai.com"
  /// The only resource audience the Responses/Models endpoints accept.
  static let resource = "https://api.openai.com/v1"
  /// The fixed authentication-origin for revocation (validated against
  /// discovery; never taken from a redirect).
  static let authOrigin = "https://auth.openai.com"

  /// The exact scope set requested at authorization. `offline_access` is what
  /// makes a refresh token legitimate.
  static let scope =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
  /// Scopes that must be present in a *granted* token response before models or
  /// inference may be attempted.
  static let requiredDirectScopes = [
    "resource.invoke", "chatgpt.tokens.use.direct"
  ]

  /// Initial (first-time) registration uses the dynamic agent client; the
  /// agent-name hint is sent *only* on that initial request.
  static let dynamicAgentClientId = "dynamic_agent_client"
  static let agentNameHint = "VeyraN"

  static let callbackHost = "127.0.0.1"
  static let callbackPath = "/auth/callback"
  static let codeChallengeMethod = "S256"
  /// The single supported prompt value; used *only* for the explicit,
  /// human-initiated "release ChatGPT usage" recovery. Ordinary sign-in and
  /// returning sign-in never send it, and `force_reconsent` is never sent.
  static let consentPrompt = "consent"

  /// Fresh auth flows (state/nonce/PKCE) live 600s and are bound to the exact
  /// Notes account + provider epoch that opened them. This one bounded value is
  /// shared by the provider's pending-flow deadline and the loopback listener's
  /// own deadline, so an abandoned flow ends at exactly one TTL — never at two
  /// independent ones.
  static let flowTTLSeconds: TimeInterval = 600

  // --- storage ---
  static let keychainService = "com.ozel0t.note.notesnookpencil.veyran.siwc"
  static let keychainAccount = "siwc-v1"

  // --- callback listener bounds ---
  static let maxHeaderBytes = 16 * 1024
  static let maxRequestBytes = 32 * 1024
  static let maxConnections = 4
  static let readTimeoutSeconds: TimeInterval = 3

  // --- streaming bounds ---
  static let maxStreamBytes = 1024 * 1024
  static let maxLineBytes = 64 * 1024
  static let maxOutputBytes = 1024 * 1024
  static let maxEvents = 4096
  static let streamWallclockSeconds: TimeInterval = 120

  // --- generic bounds ---
  static let maxTokenBytes = 256 * 1024
  static let maxJwksBytes = 512 * 1024
  static let maxModelsBytes = 1024 * 1024
  static let maxClientIdChars = 512
  static let maxSubjectChars = 512
  static let maxHostURNChars = 128

  // --- request/response transport bounds ---
  // Every bound is enforced *before* the bytes are retained, so an oversized
  // header block, declared length or decoded body aborts the task instead of
  // being buffered first.
  static let maxResponseHeaderBytes = 32 * 1024
  static let maxResponseHeaders = 64
}

// MARK: - Bounded local error surface

/// Every case maps to one fixed string and never interpolates a payload, token,
/// model, id or caught error. Provider-reported limit codes are surfaced as
/// these static cases, never as raw provider JSON.
enum VeyraNSIWCError: Error, Equatable {
  case unsupportedPlatform
  case notSignedIn
  case authCanceled
  case stateMismatch
  case callbackInvalid
  case flowExpired
  case accountChanged
  case keychainFailure
  case transportUnavailable
  case tokenInvalid
  case identityMismatch
  case missingPlanScope
  case consentRequired
  case notEligible
  case usageLimitExceeded
  case usageUnavailable
  case invalidUser
  case modelUnavailable
  case streamInvalid
  case functionCallDenied
  case canceled
  case busy

  var code: String {
    switch self {
    case .unsupportedPlatform: return "unsupported"
    case .notSignedIn: return "not_signed_in"
    case .authCanceled: return "auth_canceled"
    case .stateMismatch: return "state_mismatch"
    case .callbackInvalid: return "callback_invalid"
    case .flowExpired: return "flow_expired"
    case .accountChanged: return "account_changed"
    case .keychainFailure: return "keychain_failure"
    case .transportUnavailable: return "transport_unavailable"
    case .tokenInvalid: return "token_invalid"
    case .identityMismatch: return "identity_mismatch"
    case .missingPlanScope: return "MISSING_PLAN_SCOPE"
    case .consentRequired: return "consent_required"
    case .notEligible: return "subscription_sharing_user_not_eligible"
    case .usageLimitExceeded: return "usage_limit_exceeded"
    case .usageUnavailable: return "usage_unavailable"
    case .invalidUser: return "invalid_user"
    case .modelUnavailable: return "model_unavailable"
    case .streamInvalid: return "stream_invalid"
    case .functionCallDenied: return "function_call_denied"
    case .canceled: return "canceled"
    case .busy: return "busy"
    }
  }
}

/// The bounded provider status surface. There is deliberately no "connected"
/// value: nothing here claims a live inference is running.
enum VeyraNSIWCStatus: String, Equatable {
  case signedOut = "signedout"
  case authenticating
  case missingPermission = "missingpermission"
  case ready
  case refreshing
  case limited
  case failed
  case canceled
}

// MARK: - Injected seams

struct VeyraNSIWCHTTPRequest {
  let method: String
  let url: String
  let headers: [String: String]
  let body: Data?
}

struct VeyraNSIWCHTTPResponse {
  let status: Int
  let headers: [String: String]
  let body: Data

  /// A bounded, case-insensitive header lookup. Never returns a raw provider
  /// body; callers only ever inspect static, named headers they expect.
  func header(_ name: String) -> String? {
    let target = name.lowercased()
    for (key, value) in headers where key.lowercased() == target {
      return value
    }
    return nil
  }
}

/// Non-streaming HTTPS transport (models, token, JWKS, discovery). The
/// production adapter pins the exact fixed endpoints, disables proxies,
/// cookies and redirects and uses the default system TLS validation.
protocol VeyraNSIWCTransport {
  func send(
    _ request: VeyraNSIWCHTTPRequest,
    timeout: TimeInterval
  ) async throws -> VeyraNSIWCHTTPResponse
}

/// Dedicated incremental streaming transport for the Responses SSE endpoint.
/// It yields *decompressed* body chunks in order; the provider enforces every
/// byte/line/event/time bound while consuming. It must terminate on task
/// cancelation and must never be the JS/RCTNetworking/EventSource path.
protocol VeyraNSIWCStreamingTransport {
  func stream(_ request: VeyraNSIWCHTTPRequest) -> AsyncThrowingStream<Data, Error>
}

protocol VeyraNSIWCClock {
  func now() -> Date
}

protocol VeyraNSIWCRandomSource {
  /// Cryptographically secure random bytes, or `nil` on failure (fail closed).
  func bytes(_ count: Int) -> Data?
}

struct VeyraNSIWCSystemClock: VeyraNSIWCClock {
  func now() -> Date { Date() }
}

struct VeyraNSIWCSystemRandom: VeyraNSIWCRandomSource {
  func bytes(_ count: Int) -> Data? {
    guard count > 0 else { return nil }
    var data = Data(count: count)
    let status = data.withUnsafeMutableBytes { buffer -> Int32 in
      guard let base = buffer.baseAddress else { return errSecParam }
      return SecRandomCopyBytes(kSecRandomDefault, count, base)
    }
    return status == errSecSuccess ? data : nil
  }
}

// MARK: - PKCE / state / nonce

enum VeyraNSIWCPKCE {
  static let verifierBytes = 32
  static let stateBytes = 32
  static let nonceBytes = 16

  /// A 43-char unpadded base64url verifier from 32 CSPRNG bytes (RFC 7636
  /// requires 43..128 unreserved chars; base64url is a subset).
  static func verifier(_ random: VeyraNSIWCRandomSource) -> String? {
    guard let data = random.bytes(verifierBytes) else { return nil }
    return VeyraNConnectBase64URL.encode(data)
  }

  /// `code_challenge = BASE64URL(SHA256(ASCII(verifier)))`.
  static func challenge(verifier: String) -> String? {
    guard let ascii = verifier.data(using: .ascii), !ascii.isEmpty else {
      return nil
    }
    let digest = SHA256.hash(data: ascii)
    return VeyraNConnectBase64URL.encode(Data(digest))
  }

  static func state(_ random: VeyraNSIWCRandomSource) -> String? {
    guard let data = random.bytes(stateBytes) else { return nil }
    return VeyraNConnectBase64URL.encode(data)
  }

  static func nonce(_ random: VeyraNSIWCRandomSource) -> String? {
    guard let data = random.bytes(nonceBytes) else { return nil }
    return VeyraNConnectBase64URL.encode(data)
  }
}

// MARK: - Percent encoding / query & form building

enum VeyraNSIWCEncode {
  /// RFC 3986 unreserved set only. Everything else is `%XX` (upper-case hex),
  /// so a value can never smuggle an extra `&`, `=`, `#` or space into a query
  /// or an `application/x-www-form-urlencoded` body.
  static func percent(_ value: String) -> String {
    var out = ""
    out.reserveCapacity(value.utf8.count)
    for byte in value.utf8 {
      switch byte {
      case 0x41...0x5A, 0x61...0x7A, 0x30...0x39, 0x2D, 0x2E, 0x5F, 0x7E:
        out.append(Character(UnicodeScalar(byte)))
      default:
        out.append("%")
        out.append(hexDigit(byte >> 4))
        out.append(hexDigit(byte & 0x0F))
      }
    }
    return out
  }

  private static func hexDigit(_ value: UInt8) -> Character {
    let table: [Character] = [
      "0", "1", "2", "3", "4", "5", "6", "7",
      "8", "9", "A", "B", "C", "D", "E", "F"
    ]
    return table[Int(value & 0x0F)]
  }

  /// Deterministic, sorted query string. The parameter *set* is fixed by the
  /// caller; the order is stable so tests can assert the whole URL.
  static func query(_ pairs: [(String, String)]) -> String {
    pairs
      .sorted { $0.0 < $1.0 }
      .map { "\(percent($0.0))=\(percent($0.1))" }
      .joined(separator: "&")
  }

  static func form(_ pairs: [(String, String)]) -> Data {
    query(pairs).data(using: .utf8) ?? Data()
  }
}

// MARK: - Callback redirect URI

enum VeyraNSIWCRedirect {
  /// `http://127.0.0.1:<ephemeral>/auth/callback`. The host is the loopback
  /// literal and the port is a bounded ephemeral port; nothing else is
  /// representable, so no foreign origin can be embedded.
  static func uri(port: Int) -> String? {
    guard port >= 1024, port <= 65535 else { return nil }
    return "http://\(VeyraNSIWC.callbackHost):\(port)\(VeyraNSIWC.callbackPath)"
  }
}

// MARK: - Authorize URL

struct VeyraNSIWCAuthorizeParams {
  let clientId: String
  let redirectURI: String
  let state: String
  let nonce: String
  let codeChallenge: String
  /// Optional official `login_hint` (a saved email). Never an authorization
  /// input; a mismatch between the returned `sub` and the selected account
  /// still fails closed.
  let loginHint: String?
  /// Only ever `consent`, only for the explicit human recovery action.
  let prompt: String?
  /// Sent only on the initial (dynamic client) registration.
  let agentNameHint: String?
  /// The own stable host id, always the canonical `urn:uuid:<uuid-v4>`. The
  /// official contract requires it on *every* attempt (fresh, returning and
  /// consent), so it is never omitted, and it is always sent in that exact
  /// canonical form.
  let extAgentHostId: String?
}

enum VeyraNSIWCAuthorize {
  static func url(_ params: VeyraNSIWCAuthorizeParams) -> URL? {
    guard VeyraNSIWCValidate.clientId(params.clientId),
      VeyraNSIWCValidate.redirectURI(params.redirectURI),
      VeyraNSIWCValidate.opaque(params.state, max: 128),
      VeyraNSIWCValidate.opaque(params.nonce, max: 128),
      VeyraNSIWCValidate.opaque(params.codeChallenge, max: 128),
      params.prompt == nil || params.prompt == VeyraNSIWC.consentPrompt
    else { return nil }
    if let hint = params.loginHint, !VeyraNSIWCValidate.email(hint) { return nil }
    if let hint = params.agentNameHint,
      hint != VeyraNSIWC.agentNameHint
    { return nil }
    if let urn = params.extAgentHostId, !VeyraNSIWCValidate.hostURN(urn) {
      return nil
    }

    var pairs: [(String, String)] = [
      ("response_type", "code"),
      ("client_id", params.clientId),
      ("redirect_uri", params.redirectURI),
      ("scope", VeyraNSIWC.scope),
      ("resource", VeyraNSIWC.resource),
      ("state", params.state),
      ("nonce", params.nonce),
      ("code_challenge", params.codeChallenge),
      ("code_challenge_method", VeyraNSIWC.codeChallengeMethod)
    ]
    if let hint = params.loginHint { pairs.append(("login_hint", hint)) }
    if let prompt = params.prompt { pairs.append(("prompt", prompt)) }
    if let hint = params.agentNameHint {
      pairs.append(("agent_name_hint", hint))
    }
    if let urn = params.extAgentHostId {
      pairs.append(("ext_agent_host_id", urn))
    }
    // `id_token_hint` is deliberately never sent: it would place the retained
    // (protected) id_token into a browser URL.
    return URL(string: "\(VeyraNSIWC.authorizeEndpoint)?\(VeyraNSIWCEncode.query(pairs))")
  }
}

// MARK: - Token endpoint bodies

enum VeyraNSIWCTokenRequest {
  /// Authorization-code exchange. Form-encoded, no client secret, exact
  /// redirect URI and resource.
  static func exchange(
    code: String,
    clientId: String,
    verifier: String,
    redirectURI: String
  ) -> Data? {
    guard VeyraNSIWCValidate.opaque(code, max: 4096),
      VeyraNSIWCValidate.clientId(clientId),
      VeyraNSIWCValidate.opaque(verifier, max: 256),
      VeyraNSIWCValidate.redirectURI(redirectURI)
    else { return nil }
    return VeyraNSIWCEncode.form([
      ("grant_type", "authorization_code"),
      ("code", code),
      ("client_id", clientId),
      ("code_verifier", verifier),
      ("redirect_uri", redirectURI),
      ("resource", VeyraNSIWC.resource)
    ])
  }

  /// Refresh grant. `scope` is deliberately omitted (the granted scope set is
  /// preserved by the issuer).
  static func refresh(refreshToken: String, clientId: String) -> Data? {
    guard VeyraNSIWCValidate.tokenString(refreshToken),
      VeyraNSIWCValidate.clientId(clientId)
    else { return nil }
    return VeyraNSIWCEncode.form([
      ("grant_type", "refresh_token"),
      ("refresh_token", refreshToken),
      ("client_id", clientId),
      ("resource", VeyraNSIWC.resource)
    ])
  }

  /// Best-effort revocation at the discovery-provided endpoint. The hint is
  /// fixed to the catalogued OAuth values; a credential without a refresh token
  /// revokes its access token instead of silently skipping the request.
  static func revocation(
    token: String,
    clientId: String,
    hint: String = "refresh_token"
  ) -> Data? {
    guard VeyraNSIWCValidate.tokenString(token),
      VeyraNSIWCValidate.clientId(clientId),
      hint == "refresh_token" || hint == "access_token"
    else { return nil }
    return VeyraNSIWCEncode.form([
      ("token", token),
      ("client_id", clientId),
      ("token_type_hint", hint)
    ])
  }
}

// MARK: - Validators

enum VeyraNSIWCValidate {
  /// A bounded opaque string made of a safe, unambiguous alphabet. Used for
  /// state, nonce, verifier, code and challenge.
  static func opaque(_ value: String, max: Int) -> Bool {
    guard !value.isEmpty, value.utf8.count <= max else { return false }
    for scalar in value.unicodeScalars {
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9", "-", "_", ".":
        continue
      default:
        return false
      }
    }
    return true
  }

  /// An issued client id: a bounded opaque string. The dynamic placeholder is
  /// valid here as a *request* value; it is never persisted as a registration.
  static func clientId(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= VeyraNSIWC.maxClientIdChars
    else { return false }
    for scalar in value.unicodeScalars {
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9", "-", "_", ".", ":", "/", "+", "=":
        continue
      default:
        return false
      }
    }
    return true
  }

  /// A real, non-placeholder issued client id (what may be persisted).
  static func issuedClientId(_ value: String) -> Bool {
    value != VeyraNSIWC.dynamicAgentClientId && clientId(value)
  }

  static func subject(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= VeyraNSIWC.maxSubjectChars
    else { return false }
    for scalar in value.unicodeScalars {
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9", "-", "_", ".", "|", ":", "@", "+":
        continue
      default:
        return false
      }
    }
    return true
  }

  /// A bearer-style token: bounded, printable ASCII, no whitespace/control.
  static func tokenString(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= VeyraNSIWC.maxTokenBytes
    else { return false }
    for byte in value.utf8 {
      if byte < 0x21 || byte > 0x7E { return false }
    }
    return true
  }

  static func redirectURI(_ value: String) -> Bool {
    guard value.hasPrefix("http://\(VeyraNSIWC.callbackHost):") else {
      return false
    }
    guard value.hasSuffix(VeyraNSIWC.callbackPath) else { return false }
    let middle = value.dropFirst("http://\(VeyraNSIWC.callbackHost):".count)
      .dropLast(VeyraNSIWC.callbackPath.count)
    guard let port = Int(middle), port >= 1024, port <= 65535 else {
      return false
    }
    return VeyraNSIWCRedirect.uri(port: port) == value
  }

  /// The **canonical wire** host id: `urn:uuid:<uuid-v4-lowercase>`, the exact
  /// form the official token-sharing contract accepts
  /// (`https://developers.openai.com/siwc/token-sharing-open-source`: an opaque,
  /// stable, distinct-per-host `urn:uuid:` value). This validator is
  /// canonical-only — the own legacy `urn:veyran:` prefix (and every foreign,
  /// v1, uppercase, unhyphenated or trailing-junk value) is **never** accepted
  /// here, so a legacy value can never reach `ext_agent_host_id`.
  static func hostURN(_ value: String) -> Bool {
    guard value.utf8.count <= VeyraNSIWC.maxHostURNChars else { return false }
    let prefix = "urn:uuid:"
    guard value.hasPrefix(prefix) else { return false }
    let uuid = String(value.dropFirst(prefix.count))
    return isUUIDv4(uuid)
  }

  /// Persisted-host compatibility for documents written before the wire format
  /// was corrected. Pure and **write-free**: a canonical value passes through
  /// unchanged, and a *strictly valid own legacy* `urn:veyran:<v4>` maps to
  /// `urn:uuid:` with the **same** UUID suffix. No UUID is ever minted and no
  /// host is impersonated (a host id is not an auth credential). Any other
  /// value — malformed, foreign, v1, uppercase, unhyphenated, over-bound — is
  /// refused. Used **only** by persisted parse; the wire validator stays
  /// canonical-only.
  static func normalizePersistedHostURN(_ value: String) -> String? {
    if hostURN(value) { return value }
    guard value.utf8.count <= VeyraNSIWC.maxHostURNChars else { return nil }
    let legacyPrefix = "urn:veyran:"
    guard value.hasPrefix(legacyPrefix) else { return nil }
    let uuid = String(value.dropFirst(legacyPrefix.count))
    guard isUUIDv4(uuid) else { return nil }
    return "urn:uuid:\(uuid)"
  }

  static func isUUIDv4(_ value: String) -> Bool {
    let parts = value.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 5,
      parts[0].count == 8, parts[1].count == 4,
      parts[2].count == 4, parts[3].count == 4, parts[4].count == 12
    else { return false }
    for (index, part) in parts.enumerated() {
      for scalar in part.unicodeScalars {
        switch scalar {
        case "0"..."9", "a"..."f":
          continue
        default:
          return false
        }
      }
      // Version nibble 4 and RFC 4122 variant 10xx.
      if index == 2, part.first != "4" { return false }
      if index == 3 {
        guard let first = part.first, "89ab".contains(first) else {
          return false
        }
      }
    }
    return true
  }

  /// Build a fresh canonical `urn:uuid:<uuid-v4>` from CSPRNG bytes.
  /// Version/variant bits are set exactly per RFC 4122.
  static func makeHostURN(_ random: VeyraNSIWCRandomSource) -> String? {
    guard var bytes = random.bytes(16) else { return nil }
    bytes[6] = (bytes[6] & 0x0F) | 0x40
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    let uuid =
      "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-"
      + "\(hex.dropFirst(12).prefix(4))-\(hex.dropFirst(16).prefix(4))-"
      + hex.suffix(12)
    return "urn:uuid:\(uuid)"
  }

  /// A bounded, syntactically plausible email used only as a `login_hint`.
  static func email(_ value: String) -> Bool {
    guard value.utf8.count >= 3, value.utf8.count <= 320 else { return false }
    guard let at = value.firstIndex(of: "@"), at != value.startIndex else {
      return false
    }
    let domain = value[value.index(after: at)...]
    guard !domain.isEmpty, domain.contains("."), !domain.hasSuffix(".") else {
      return false
    }
    for scalar in value.unicodeScalars {
      if scalar == "@" || scalar == "." || scalar == "-" || scalar == "_"
        || scalar == "+"
      {
        continue
      }
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9":
        continue
      default:
        return false
      }
    }
    return true
  }

  /// A bounded model slug from the live catalog. Deliberately permissive about
  /// the alphabet (the server is authoritative) but never empty/unbounded and
  /// never carrying control characters, so it cannot reshape a URL or a body.
  static func modelSlug(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 200 else { return false }
    for scalar in value.unicodeScalars {
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9", "-", "_", ".", "/", ":":
        continue
      default:
        return false
      }
    }
    return true
  }

  /// A revocation endpoint taken from the official OIDC discovery document.
  /// It must be HTTPS on the exact fixed authorization origin, with a non-empty
  /// path, no query, no fragment and no userinfo — so a hostile or redirected
  /// discovery value can never become an arbitrary target.
  static func discoveryEndpoint(_ value: String) -> String? {
    guard value.utf8.count <= 2048 else { return nil }
    guard value.hasPrefix("\(VeyraNSIWC.authOrigin)/") else { return nil }
    guard !value.contains("?"), !value.contains("#"), !value.contains("@")
    else { return nil }
    let path = value.dropFirst(VeyraNSIWC.authOrigin.count)
    guard path.hasPrefix("/"), path.count > 1, path.count <= 1024 else {
      return nil
    }
    for scalar in path.unicodeScalars {
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9", "-", "_", ".", "/", "~":
        continue
      default:
        return nil
      }
    }
    return value
  }

  static func isHex(_ value: String, count: Int) -> Bool {
    guard value.count == count else { return false }
    for character in value {
      switch character {
      case "0"..."9", "a"..."f", "A"..."F":
        continue
      default:
        return false
      }
    }
    return true
  }

  /// Constant-time string comparison. Never short-circuits on the first
  /// differing byte, so a state mismatch reveals no prefix information.
  static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
    let lhs = Array(a.utf8)
    let rhs = Array(b.utf8)
    var diff = UInt8(lhs.count ^ rhs.count)
    let count = max(lhs.count, rhs.count)
    for index in 0..<count {
      let left = index < lhs.count ? lhs[index] : 0
      let right = index < rhs.count ? rhs[index] : 0
      diff |= left ^ right
    }
    return diff == 0
  }
}
