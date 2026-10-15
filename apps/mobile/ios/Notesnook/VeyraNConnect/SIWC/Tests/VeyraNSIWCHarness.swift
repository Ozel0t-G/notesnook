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

// Standalone regression harness for the pure VeyraN SIWC provider *and* its
// native lifecycle coordinator.
//
// It links only the Foundation/Security/CryptoKit/Network production files —
// never the React/UIKit module, never the real Keychain — and drives the exact
// production state machine with synthetic transports, an in-memory store, a
// fixed clock and a deterministic "random" source. The bounded request/response
// transport is exercised through a synthetic `URLProtocol`, the Keychain
// mapping through an injected Security API, and the lifecycle coordinator
// through an injected listener/main queue. RSA key pairs are generated at run
// time with `SecKeyCreateRandomKey`; no private key is committed.
//
//   swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
//     -target arm64-apple-ios18.0-macabi -swift-version 5 -parse-as-library \
//     apps/mobile/ios/Notesnook/VeyraNConnect/VeyraNConnectWire.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCTypes.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCJWT.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCCallback.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCIdentity.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCResponses.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCProvider.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCKeychain.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCTransport.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/VeyraNSIWCLifecycle.swift \
//     apps/mobile/ios/Notesnook/VeyraNConnect/SIWC/Tests/VeyraNSIWCHarness.swift \
//     -o "$TMPDIR/veyran-siwc-harness" && "$TMPDIR/veyran-siwc-harness"

import Foundation
import Security

// MARK: - tiny assertion framework

private var checks = 0
private var failures = 0

private func expect(_ condition: Bool, _ message: String) {
  checks += 1
  if !condition {
    failures += 1
    print("FAIL: \(message)")
  }
}

// MARK: - deterministic DI

private struct FixedClock: VeyraNSIWCClock {
  let date: Date
  func now() -> Date { date }
}

/// A settable clock: a test advances time deterministically (no real sleeps) so a
/// TTL/expiry boundary is exercised exactly.
private final class ManualClock: VeyraNSIWCClock {
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

  func set(_ value: Date) {
    lock.lock()
    date = value
    lock.unlock()
  }
}

/// A deterministic CSPRNG stand-in that also counts its calls, so "no host was
/// generated" is provable.
private final class CountingRandom: VeyraNSIWCRandomSource {
  private let lock = NSLock()
  private var callCount = 0
  var calls: Int {
    lock.lock()
    defer { lock.unlock() }
    return callCount
  }

  func bytes(_ count: Int) -> Data? {
    lock.lock()
    callCount += 1
    lock.unlock()
    return count > 0 ? Data(repeating: 0xAB, count: count) : nil
  }
}

/// A deterministic CSPRNG stand-in: every call returns the same byte pattern,
/// so the flow state/nonce/verifier are predictable in the harness.
private struct FixedRandom: VeyraNSIWCRandomSource {
  let byte: UInt8
  func bytes(_ count: Int) -> Data? {
    count > 0 ? Data(repeating: byte, count: count) : nil
  }
}

private final class SyntheticStore: VeyraNSIWCStore {
  var document: VeyraNSIWCPersisted?
  var failSave = false
  private(set) var saveCount = 0
  private(set) var loadCount = 0
  private(set) var createCount = 0
  /// When set, every read answers this scripted outcome instead of `document`
  /// (used to replay an unavailable/invalid store).
  var scriptedRead: VeyraNSIWCStoreRead?

  init(document: VeyraNSIWCPersisted? = nil) { self.document = document }

  func load() -> VeyraNSIWCStoreRead {
    loadCount += 1
    if let scriptedRead { return scriptedRead }
    guard let document else { return .missing }
    return .loaded(document)
  }

  /// Create-if-absent: an existing record is returned, never overwritten.
  func createIfAbsent(_ value: VeyraNSIWCPersisted) -> VeyraNSIWCStoreCreate {
    createCount += 1
    if failSave { return .failed }
    if let document { return .existing(document) }
    document = value
    return .created
  }

  @discardableResult
  func save(_ value: VeyraNSIWCPersisted) -> Bool {
    saveCount += 1
    if failSave { return false }
    document = value
    return true
  }

  @discardableResult
  func delete() -> Bool {
    document = nil
    return true
  }
}

/// A store double that replays exact typed read/create outcomes, so the
/// production provider can be driven through every failure mode without a real
/// Keychain.
private final class ScriptedStore: VeyraNSIWCStore {
  /// The queue of read outcomes. Once exhausted the last one is repeated.
  var reads: [VeyraNSIWCStoreRead] = []
  var creates: [VeyraNSIWCStoreCreate] = []
  var savesSucceed = true
  var current: VeyraNSIWCPersisted?
  private(set) var loadCount = 0
  private(set) var createCount = 0
  private(set) var saveCount = 0

  init(
    reads: [VeyraNSIWCStoreRead] = [],
    current: VeyraNSIWCPersisted? = nil
  ) {
    self.reads = reads
    self.current = current
  }

  func load() -> VeyraNSIWCStoreRead {
    loadCount += 1
    guard !reads.isEmpty else {
      guard let current else { return .missing }
      return .loaded(current)
    }
    return reads.count == 1 ? reads[0] : reads.removeFirst()
  }

  func createIfAbsent(_ value: VeyraNSIWCPersisted) -> VeyraNSIWCStoreCreate {
    createCount += 1
    if !creates.isEmpty {
      let outcome = creates.count == 1 ? creates[0] : creates.removeFirst()
      switch outcome {
      case .created:
        current = value
      case let .existing(document):
        current = document
      case .duplicateUnreadable, .failed:
        break
      }
      return outcome
    }
    if let current { return .existing(current) }
    current = value
    return .created
  }

  @discardableResult
  func save(_ value: VeyraNSIWCPersisted) -> Bool {
    saveCount += 1
    guard savesSucceed else { return false }
    current = value
    return true
  }

  @discardableResult
  func delete() -> Bool {
    current = nil
    return true
  }
}

/// A store that drives the *production* Keychain mapping through an injected
/// Security API. It lets a raw (e.g. legacy-format) record be loaded into the
/// provider exactly as the app would, proving in-memory normalization performs
/// no write on read.
private final class SecBackedStore: VeyraNSIWCStore {
  let api: ScriptedSecAPI

  init(_ api: ScriptedSecAPI) { self.api = api }

  func load() -> VeyraNSIWCStoreRead { VeyraNSIWCKeychain.load(api: api) }
  func createIfAbsent(_ value: VeyraNSIWCPersisted) -> VeyraNSIWCStoreCreate {
    VeyraNSIWCKeychain.createIfAbsent(value, api: api)
  }
  @discardableResult
  func save(_ value: VeyraNSIWCPersisted) -> Bool {
    VeyraNSIWCKeychain.save(value, api: api)
  }
  @discardableResult
  func delete() -> Bool { VeyraNSIWCKeychain.delete(api: api) }
}

/// The exact method entry for one harness call, captured the same way the
/// production coordinator captures it: synchronously, at the call site, before
/// anything is deferred.
private func methodEntry(
  _ provider: VeyraNSIWCProvider,
  _ ownerAccountId: String?,
  flowGeneration: Int? = nil
) -> VeyraNSIWCProviderEntry {
  VeyraNSIWCProviderEntry.capture(
    provider,
    ownerAccountId: ownerAccountId,
    flowGeneration: flowGeneration
  )
}

/// A recorded production Security API double: it answers the *exact* outcomes a
/// real Keychain would and records every dictionary, so the production Keychain
/// mapping is exercised without touching a real Keychain.
private final class ScriptedSecAPI: VeyraNSIWCSecAPI {
  var statuses: [OSStatus] = []
  var data: Data?
  let lock = NSLock()
  private(set) var queries: [[String: Any]] = []
  private(set) var addDictionary: [String: Any]?
  private(set) var updateDictionary: [String: Any]?

  convenience init(_ status: OSStatus) { self.init([status]) }

  convenience init(_ status: OSStatus, data: Data?) { self.init([status], data: data) }

  init(_ statuses: [OSStatus] = [], data: Data? = nil) {
    self.statuses = statuses
    self.data = data
  }

  private func nextStatus() -> OSStatus {
    lock.lock()
    defer { lock.unlock() }
    if statuses.isEmpty { return errSecSuccess }
    return statuses.count == 1 ? statuses[0] : statuses.removeFirst()
  }

  func copyMatching(
    _ query: CFDictionary,
    _ result: UnsafeMutablePointer<CFTypeRef?>?
  ) -> OSStatus {
    lock.lock()
    queries.append(query as? [String: Any] ?? [:])
    let value = data
    lock.unlock()
    let status = nextStatus()
    if status == errSecSuccess, let value, let result {
      result.pointee = value as CFData
    }
    return status
  }

  func update(_ query: CFDictionary, _ attributes: CFDictionary) -> OSStatus {
    lock.lock()
    queries.append(query as? [String: Any] ?? [:])
    updateDictionary = attributes as? [String: Any]
    lock.unlock()
    return nextStatus()
  }

  func add(
    _ attributes: CFDictionary,
    _ result: UnsafeMutablePointer<CFTypeRef?>?
  ) -> OSStatus {
    lock.lock()
    addDictionary = attributes as? [String: Any]
    lock.unlock()
    _ = result
    return nextStatus()
  }

  func delete(_ query: CFDictionary) -> OSStatus {
    lock.lock()
    queries.append(query as? [String: Any] ?? [:])
    lock.unlock()
    return nextStatus()
  }
}

private struct ScriptedHTTP: VeyraNSIWCTransport {
  let handler: (VeyraNSIWCHTTPRequest) async throws -> VeyraNSIWCHTTPResponse
  func send(
    _ request: VeyraNSIWCHTTPRequest,
    timeout: TimeInterval
  ) async throws -> VeyraNSIWCHTTPResponse {
    try await handler(request)
  }
}

private final class ScriptedStream: VeyraNSIWCStreamingTransport {
  var chunks: [Data] = []
  var error: Error?
  private(set) var streamCount = 0
  func stream(_ request: VeyraNSIWCHTTPRequest) -> AsyncThrowingStream<Data, Error> {
    streamCount += 1
    _ = request
    let chunks = self.chunks
    let error = self.error
    return AsyncThrowingStream { continuation in
      for chunk in chunks { continuation.yield(chunk) }
      if let error { continuation.finish(throwing: error) } else { continuation.finish() }
    }
  }
}

// MARK: - RSA / JWT test fixtures

private func makeRSAKey() -> (privateKey: SecKey, publicKey: SecKey)? {
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
    kSecAttrKeySizeInBits as String: 2048
  ]
  guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, nil),
    let publicKey = SecKeyCopyPublicKey(key)
  else { return nil }
  return (key, publicKey)
}

private func base64URL(_ data: Data) -> String { VeyraNConnectBase64URL.encode(data) }

/// Extract the PKCS#1 RSAPublicKey `n`/`e` from a SecKey.
private func jwkParts(_ publicKey: SecKey) -> (n: String, e: String)? {
  guard let der = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else {
    return nil
  }
  var index = 0
  func readTag() -> UInt8? {
    guard index < der.count else { return nil }
    let tag = der[der.startIndex + index]
    index += 1
    return tag
  }
  func readLength() -> Int? {
    guard index < der.count else { return nil }
    let first = der[der.startIndex + index]
    index += 1
    if first < 0x80 { return Int(first) }
    let count = Int(first & 0x7F)
    guard count >= 1, count <= 4, index + count <= der.count else { return nil }
    var value = 0
    for _ in 0..<count {
      value = (value << 8) | Int(der[der.startIndex + index])
      index += 1
    }
    return value
  }
  guard readTag() == 0x30, let seqLength = readLength(), seqLength > 0,
    index + seqLength <= der.count,
    readTag() == 0x02, let nLength = readLength(), nLength > 0,
    index + nLength <= der.count
  else { return nil }
  var modulus = der.subdata(in: (der.startIndex + index)..<(der.startIndex + index + nLength))
  index += nLength
  guard readTag() == 0x02, let eLength = readLength(), eLength > 0,
    index + eLength <= der.count
  else { return nil }
  let exponent = der.subdata(in: (der.startIndex + index)..<(der.startIndex + index + eLength))
  modulus = Data(modulus.drop(while: { $0 == 0 }))
  return (base64URL(modulus), base64URL(exponent))
}

private func jwksJSON(kid: String, publicKey: SecKey, use: String = "sig") -> Data {
  guard let parts = jwkParts(publicKey) else { return Data() }
  let object: [String: Any] = [
    "keys": [[
      "kty": "RSA",
      "kid": kid,
      "use": use,
      "alg": "RS256",
      "n": parts.n,
      "e": parts.e,
      "key_ops": ["verify"]
    ]]
  ]
  return (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
}

private func signJWT(privateKey: SecKey, header: [String: Any], payload: [String: Any]) -> String? {
  guard let headerData = try? JSONSerialization.data(withJSONObject: header),
    let payloadData = try? JSONSerialization.data(withJSONObject: payload)
  else { return nil }
  let signingInput = Data("\(base64URL(headerData)).\(base64URL(payloadData))".utf8)
  guard let signature = SecKeyCreateSignature(
    privateKey,
    .rsaSignatureMessagePKCS1v15SHA256,
    signingInput as CFData,
    nil
  ) as Data? else { return nil }
  return "\(base64URL(headerData)).\(base64URL(payloadData)).\(base64URL(signature))"
}

// MARK: - main

/// A raw persisted document in the *pre-correction* wire format. It proves the
/// in-memory read normalization: the host is canonicalized to `urn:uuid:` with
/// the same UUID while every registration/credential field is preserved, and no
/// read ever writes.
private let legacyPersistedJSON = """
  {"v":1,"host":"urn:veyran:123e4567-e89b-42d3-a456-426614174000",\
  "registrations":[{"clientId":"issued-client","createdAt":1,"status":"complete",\
  "subject":"user-1","email":"a@b.com"}],\
  "credentials":{"clientId":"issued-client","subject":"user-1",\
  "ownerAccountId":"notes-1","accessToken":"access","refreshToken":"refresh",\
  "idToken":"id","grantedScopes":["openid"],"providerEpoch":0,"expiresAt":1000}}
  """
private let canonicalPersistedHost = "urn:uuid:123e4567-e89b-42d3-a456-426614174000"

@main
private struct Harness {
  static func main() async {
    pkceTests()
    hostURNTests()
    authorizeURLTests()
    callbackParserTests()
    callbackResponseCopyTests()
    identityTests()
    registrationIdentityTests()
    keychainAttributeTests()
    catalogTests()
    catalogCompatibilityTests()
    catalogAPIEnvelopeTests()
    await catalogProviderReachabilityTests()
    if let key = makeRSAKey() {
      await jwtTests(key: key)
      await tokenResponseTests(key: key)
      await authFlowTests(key: key)
      await terminalAuthDeliveryTests(key: key)
      await authDeliveryLinearizationTests(key: key)
      await callbackLifetimeTests(key: key)
      await preparedCallbackOwnershipTests(key: key)
      await refreshRaceTests(key: key)
    }
    browserLinearizationTests()
    callbackServerLifecycleTests()
    sharedLifetimeTests()
    listenerTerminalSeamTests()
    rejectedCallbackLifetimeTests()
    await providerTests()
    await consentIdentityTests()
    responsesTests()
    await streamingTests()
    await streamErrorCodeTests()
    await logoutRevocationTests()
    await refreshTests()
    await typedStoreTests()
    await transportTests()
    await lifecycleOwnershipTests()

    print("PASS: \(checks - failures) checks (\(checks) total, \(failures) failed)")
    if failures > 0 { exit(1) }
  }

  // MARK: PKCE

  static func pkceTests() {
    // RFC 7636 Appendix B vector.
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    expect(VeyraNSIWCPKCE.challenge(verifier: verifier) == expected, "PKCE S256 RFC vector")
    expect(VeyraNSIWCPKCE.challenge(verifier: "") == nil, "empty verifier refused")

    let random = FixedRandom(byte: 0xAB)
    let v = VeyraNSIWCPKCE.verifier(random)
    expect(v?.count == 43, "verifier is 43 chars")
    expect(VeyraNSIWCPKCE.state(random)?.count == 43, "state is 32-byte base64url")

    let urn = VeyraNSIWCValidate.makeHostURN(random)
    expect(urn != nil && VeyraNSIWCValidate.hostURN(urn!), "generated host URN is a v4 URN")
    expect(
      urn == "urn:uuid:abababab-abab-4bab-abab-abababababab",
      "the deterministic CSPRNG yields the exact canonical urn:uuid host"
    )
  }

  static func hostURNTests() {
    let canonical = "urn:uuid:123e4567-e89b-42d3-a456-426614174000"
    // The wire validator is canonical-only.
    expect(VeyraNSIWCValidate.hostURN(canonical), "the canonical urn:uuid v4 host is accepted")
    expect(
      !VeyraNSIWCValidate.hostURN("urn:veyran:123e4567-e89b-42d3-a456-426614174000"),
      "the legacy urn:veyran host id is refused on the wire"
    )
    expect(
      !VeyraNSIWCValidate.hostURN("urn:uuid:123e4567-e89b-12d3-a456-426614174000"),
      "a v1 uuid is refused"
    )
    expect(
      !VeyraNSIWCValidate.hostURN("urn:uuid:123E4567-E89B-42D3-A456-426614174000"),
      "an uppercase uuid is refused"
    )
    expect(
      !VeyraNSIWCValidate.hostURN("urn:uuid:123e4567e89b42d3a456426614174000"),
      "an unhyphenated uuid is refused"
    )
    expect(
      !VeyraNSIWCValidate.hostURN("urn:other:123e4567-e89b-42d3-a456-426614174000"),
      "a foreign URN is refused"
    )
    expect(
      !VeyraNSIWCValidate.hostURN("urn:uuid:123e4567-e89b-42d3-a456-426614174000 "),
      "a trailing-junk host is refused"
    )
    expect(
      !VeyraNSIWCValidate.hostURN(canonical.replacingOccurrences(of: "42d3", with: "42d")),
      "a short uuid group is refused"
    )
    expect(
      !VeyraNSIWCValidate.hostURN(String(repeating: "a", count: VeyraNSIWC.maxHostURNChars + 1)),
      "an over-bound host is refused"
    )

    // The persisted-parse normalization is pure: canonical passes through, a
    // strictly valid own legacy value maps to the *same* UUID, everything else
    // is refused (the checked-in wire allowance is never widened).
    expect(
      VeyraNSIWCValidate.normalizePersistedHostURN(canonical) == canonical,
      "a canonical persisted host passes through unchanged"
    )
    expect(
      VeyraNSIWCValidate.normalizePersistedHostURN(
        "urn:veyran:123e4567-e89b-42d3-a456-426614174000"
      ) == canonical,
      "a strictly valid legacy persisted host keeps the same UUID under urn:uuid"
    )
    expect(
      VeyraNSIWCValidate.normalizePersistedHostURN(
        "urn:veyran:123e4567-e89b-12d3-a456-426614174000"
      ) == nil,
      "a v1 legacy persisted host is refused"
    )
    expect(
      VeyraNSIWCValidate.normalizePersistedHostURN(
        "urn:veyran:123E4567-E89B-42D3-A456-426614174000"
      ) == nil,
      "an uppercase legacy persisted host is refused"
    )
    expect(
      VeyraNSIWCValidate.normalizePersistedHostURN(
        "urn:veyran:123e4567e89b42d3a456426614174000"
      ) == nil,
      "an unhyphenated legacy persisted host is refused"
    )
    expect(
      VeyraNSIWCValidate.normalizePersistedHostURN(
        "urn:veyran:123e4567-e89b-42d3-a456-426614174000x"
      ) == nil,
      "a trailing-junk legacy persisted host is refused"
    )
    expect(
      VeyraNSIWCValidate.normalizePersistedHostURN(
        "urn:other:123e4567-e89b-42d3-a456-426614174000"
      ) == nil,
      "a foreign persisted host is refused (never widened)"
    )
    expect(VeyraNSIWCValidate.normalizePersistedHostURN("") == nil, "an empty host is refused")
    expect(
      VeyraNSIWCValidate.constantTimeEquals("abc", "abc"),
      "constant-time equality true"
    )
    expect(
      !VeyraNSIWCValidate.constantTimeEquals("abc", "abd"),
      "constant-time equality false"
    )
  }

  // MARK: authorize URL

  static func authorizeURLTests() {
    let url = VeyraNSIWCAuthorize.url(VeyraNSIWCAuthorizeParams(
      clientId: VeyraNSIWC.dynamicAgentClientId,
      redirectURI: "http://127.0.0.1:49152/auth/callback",
      state: "st",
      nonce: "no",
      codeChallenge: "ch",
      loginHint: "user@example.com",
      prompt: nil,
      agentNameHint: VeyraNSIWC.agentNameHint,
      extAgentHostId: "urn:uuid:123e4567-e89b-42d3-a456-426614174000"
    ))
    let text = url?.absoluteString ?? ""
    expect(text.hasPrefix("\(VeyraNSIWC.authorizeEndpoint)?"), "authorize base is fixed")
    expect(text.contains("response_type=code"), "response_type=code")
    expect(text.contains("code_challenge_method=S256"), "S256 method")
    expect(text.contains("scope=openid%20profile%20email%20offline_access%20resource.invoke%20chatgpt.tokens.use.direct"), "exact scope")
    expect(text.contains("resource=https%3A%2F%2Fapi.openai.com%2Fv1"), "exact resource")
    expect(text.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fauth%2Fcallback"), "exact redirect")
    expect(!text.contains("id_token_hint"), "id_token_hint never sent")
    expect(text.contains("prompt=") == false, "ordinary sign-in never forces consent")
    expect(text.contains("force_reconsent") == false, "force_reconsent never sent")
    expect(
      text.contains("ext_agent_host_id=urn%3Auuid%3A123e4567-e89b-42d3-a456-426614174000"),
      "initial registration carries the canonical host id"
    )
    expect(
      text.contains("urn%3Aveyran") == false,
      "the legacy urn:veyran host id is never sent"
    )
    expect(
      VeyraNSIWCAuthorize.url(VeyraNSIWCAuthorizeParams(
        clientId: VeyraNSIWC.dynamicAgentClientId,
        redirectURI: "http://127.0.0.1:49152/auth/callback",
        state: "st", nonce: "no", codeChallenge: "ch",
        loginHint: nil, prompt: nil, agentNameHint: VeyraNSIWC.agentNameHint,
        extAgentHostId: "urn:veyran:123e4567-e89b-42d3-a456-426614174000"
      )) == nil,
      "the authorize builder refuses a legacy urn:veyran host id"
    )

    let consent = VeyraNSIWCAuthorize.url(VeyraNSIWCAuthorizeParams(
      clientId: "issued-client",
      redirectURI: "http://127.0.0.1:49152/auth/callback",
      state: "st", nonce: "no", codeChallenge: "ch",
      loginHint: nil, prompt: VeyraNSIWC.consentPrompt,
      agentNameHint: nil, extAgentHostId: nil
    ))
    expect(consent?.absoluteString.contains("prompt=consent") == true, "consent recovery uses prompt=consent")

    expect(
      VeyraNSIWCAuthorize.url(VeyraNSIWCAuthorizeParams(
        clientId: "issued", redirectURI: "http://evil.example/auth/callback",
        state: "st", nonce: "no", codeChallenge: "ch",
        loginHint: nil, prompt: nil, agentNameHint: nil, extAgentHostId: nil
      )) == nil,
      "foreign redirect refused"
    )
  }

  // MARK: callback parser

  static func callbackParserTests() {
    let port = 49152
    func request(
      method: String = "GET",
      target: String = "/auth/callback?code=abc&state=st",
      host: String = "127.0.0.1:49152",
      extra: String = ""
    ) -> Data {
      let head = "\(method) \(target) HTTP/1.1\r\nHost: \(host)\r\n\(extra)\r\n"
      return Data(head.utf8)
    }

    if case let .valid(params) = VeyraNSIWCCallbackParser.parse(request(), expectedPort: port) {
      expect(params["code"] == "abc" && params["state"] == "st", "valid callback parsed")
    } else {
      expect(false, "valid callback parsed")
    }

    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(request(method: "POST"), expectedPort: port)),
      "non-GET refused"
    )
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(request(target: "/other?code=1"), expectedPort: port)),
      "wrong path refused"
    )
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(request(host: "127.0.0.1"), expectedPort: port)),
      "Host without port refused"
    )
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(request(host: "localhost:49152"), expectedPort: port)),
      "non-loopback Host refused"
    )
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(request(extra: "X-A: 1\r\nX-A: 2"), expectedPort: port)),
      "duplicate header refused"
    )
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(request(extra: "X-A: 1\r\n folded"), expectedPort: port)),
      "folded header refused"
    )
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(
        request(target: "/auth/callback?code=1&code=2"), expectedPort: port)),
      "duplicate query param refused"
    )
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(
        request(target: "/auth/callback?code=%ZZ"), expectedPort: port)),
      "malformed percent refused"
    )
    // Pipelined/extra bytes after the header terminator.
    var pipelined = request()
    pipelined.append(Data("GET /x HTTP/1.1\r\n\r\n".utf8))
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(pipelined, expectedPort: port)),
      "pipelined request refused"
    )
    // A fragmented-but-well-formed request is accepted once assembled.
    let wellFormed = Data("GET /auth/callback?code=ok&state=s HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n".utf8)
    expect(
      isInvalid(VeyraNSIWCCallbackParser.parse(wellFormed, expectedPort: port)) == false,
      "well-formed fragmented request accepted"
    )
    expect(
      VeyraNSIWCCallbackResponse.ok.contains("state") == false
        && VeyraNSIWCCallbackResponse.ok.contains("code") == false,
      "static HTML echoes nothing"
    )
  }

  static func isInvalid(_ request: VeyraNSIWCCallbackRequest) -> Bool {
    if case .invalid = request { return true }
    return false
  }

  // MARK: callback response copy

  /// The loopback response is answered *before* the async code exchange and JWT
  /// verification, and a syntactically valid but wrong-state callback receives
  /// the same body — so it must never claim an authentication success.
  static func callbackResponseCopyTests() {
    let ok = VeyraNSIWCCallbackResponse.ok
    expect(
      !ok.lowercased().contains("abgeschlossen"),
      "the callback page never claims the sign-in is finished"
    )
    expect(
      ok.contains("empfangen") && ok.contains("prueft"),
      "the callback page says only that the request was received and is being checked"
    )
    expect(
      !VeyraNSIWCCallbackResponse.invalid.lowercased().contains("abgeschlossen"),
      "the refusal page makes no success claim either"
    )
  }

  // MARK: identity document

  static func identityTests() {
    let urn = "urn:uuid:123e4567-e89b-42d3-a456-426614174000"
    let document = VeyraNSIWCPersisted(
      hostURN: urn,
      registrations: [VeyraNSIWCRegistration(
        clientId: "issued-client", subject: "user-1", email: "a@b.com", createdAt: 1
      )],
      credential: VeyraNSIWCCredential(
        clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
        accessToken: "access", refreshToken: "refresh", idToken: "id",
        grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
        expiresAt: 1000, providerEpoch: 0
      )
    )
    guard let data = document.serialized(),
      let parsed = VeyraNSIWCPersisted.parse(data)
    else {
      expect(false, "identity round-trip")
      return
    }
    expect(parsed == document, "identity round-trip")

    // An unverified pending registration can never overwrite a verified one.
    let pending = VeyraNSIWCRegistration(
      clientId: "issued-client", subject: nil, email: nil, createdAt: 2
    )
    expect(document.withRegistration(pending) == nil, "verified registration not overwritten by pending")

    // Clearing the credential keeps the host and the registrations.
    let cleared = parsed.withCredential(nil)
    expect(cleared.hostURN == urn && cleared.registrations.count == 1, "logout keeps host + registrations")
    expect(cleared.credential == nil, "logout clears credential")

    // The placeholder client id is never a valid persisted registration.
    let placeholder = VeyraNSIWCPersisted(
      hostURN: urn,
      registrations: [VeyraNSIWCRegistration(
        clientId: VeyraNSIWC.dynamicAgentClientId, subject: "x", email: nil, createdAt: 1
      )],
      credential: nil
    )
    expect(VeyraNSIWCPersisted.parse(placeholder.serialized() ?? Data()) == nil, "placeholder client never persisted")

    // A stale/corrupt email is dropped rather than discarding the whole
    // document (which would wipe the host, registrations and credential).
    let badEmail = VeyraNSIWCPersisted(
      hostURN: urn,
      registrations: [VeyraNSIWCRegistration(
        clientId: "issued-client", subject: "user-1", email: "not-an-email", createdAt: 1
      )],
      credential: nil
    )
    let reparsed = VeyraNSIWCPersisted.parse(badEmail.serialized() ?? Data())
    expect(reparsed != nil, "a bad email does not discard the document")
    expect(reparsed?.registration(clientId: "issued-client")?.email == nil, "a bad email is dropped")
    expect(
      reparsed?.registration(clientId: "issued-client")?.subject == "user-1",
      "the verified subject survives a bad email"
    )

    // A persisted document written before the wire format was corrected must
    // stay fully loadable. Parse canonicalizes the host *in memory* to
    // `urn:uuid:` with the very same UUID; every registration and credential
    // field is preserved value-for-value and nothing is minted or written.
    let legacyBytes = Data(legacyPersistedJSON.utf8)
    let legacy = VeyraNSIWCPersisted.parse(legacyBytes)
    expect(legacy != nil, "a legacy persisted document still loads")
    expect(
      legacy?.hostURN == canonicalPersistedHost,
      "the legacy urn:veyran host is canonicalized to the same UUID"
    )
    expect(
      legacy?.registration(clientId: "issued-client")?.subject == "user-1"
        && legacy?.registration(clientId: "issued-client")?.email == "a@b.com",
      "legacy registrations are preserved"
    )
    expect(
      legacy?.credential?.accessToken == "access"
        && legacy?.credential?.refreshToken == "refresh"
        && legacy?.credential?.idToken == "id"
        && legacy?.credential?.ownerAccountId == "notes-1"
        && legacy?.credential?.grantedScopes == ["openid"]
        && legacy?.credential?.expiresAt == 1000
        && legacy?.credential?.providerEpoch == 0,
      "the legacy credential is preserved value-for-value"
    )
    // A read never mutates the raw input bytes.
    expect(
      Data(legacyPersistedJSON.utf8) == legacyBytes,
      "a legacy read leaves the raw document bytes untouched"
    )
    // A later authorized commit serializes the canonical form with no token loss
    // and no schema change.
    let recommittedText = legacy?.serialized().flatMap {
      String(data: $0, encoding: .utf8)
    }
    expect(
      recommittedText?.contains(#""v":1"#) == true
        && recommittedText?.contains(#""host":"\#(canonicalPersistedHost)""#) == true,
      "a recommitted legacy document writes schema v1 and the canonical host"
    )
    let recommittedParsed = legacy?.serialized().flatMap {
      VeyraNSIWCPersisted.parse($0)
    }
    expect(
      recommittedParsed?.credential?.accessToken == "access"
        && recommittedParsed?.credential?.refreshToken == "refresh"
        && recommittedParsed?.registration(clientId: "issued-client")?.subject == "user-1",
      "a recommitted legacy document keeps every token and registration"
    )

    // An empty legacy document also loads with a canonical host.
    let legacyEmpty = Data(
      #"{"v":1,"host":"urn:veyran:123e4567-e89b-42d3-a456-426614174000","registrations":[]}"#.utf8
    )
    expect(
      VeyraNSIWCPersisted.parse(legacyEmpty)?.hostURN == canonicalPersistedHost,
      "an empty legacy document loads with a canonical host"
    )

    // No widening: a malformed, foreign or non-v4 persisted host is refused.
    for bad in [
      #"{"v":1,"host":"urn:veyran:123e4567-e89b-12d3-a456-426614174000","registrations":[]}"#,
      #"{"v":1,"host":"urn:veyran:123E4567-E89B-42D3-A456-426614174000","registrations":[]}"#,
      #"{"v":1,"host":"urn:veyran:123e4567e89b42d3a456426614174000","registrations":[]}"#,
      #"{"v":1,"host":"urn:other:123e4567-e89b-42d3-a456-426614174000","registrations":[]}"#,
      #"{"v":1,"host":"urn:uuid:123e4567-e89b-12d3-a456-426614174000","registrations":[]}"#
    ] {
      expect(
        VeyraNSIWCPersisted.parse(Data(bad.utf8)) == nil,
        "a malformed or foreign persisted host is refused"
      )
    }
  }

  // MARK: catalog

  static func catalogTests() {
    let good = Data("""
      {"models":[{"slug":"gpt-5","display_name":"GPT-5","visibility":"list"},\
      {"slug":"hidden","display_name":"Hidden","visibility":"hidden"}]}
      """.utf8)
    let catalog = VeyraNSIWCCatalog.parse(good)
    expect(catalog?.models.count == 1, "only visibility:list models kept")
    expect(catalog?.allows(slug: "gpt-5") == true, "server order preserved and slug allowed")
    expect(catalog?.allows(slug: "hidden") == false, "hidden model not allowed")

    // A `data[]` array *without* the `object:"list"` discriminator is not a
    // documented public-API envelope and stays refused.
    let dataArray = Data(#"{"data":[{"id":"gpt-5"}]}"#.utf8)
    expect(
      VeyraNSIWCCatalog.parse(dataArray) == nil,
      "an undiscriminated data[] array is refused"
    )
    let dup = Data(#"{"models":[{"slug":"a","slug":"b","display_name":"A","visibility":"list"}]}"#.utf8)
    expect(VeyraNSIWCCatalog.parse(dup) == nil, "duplicate key refused")
  }

  // MARK: JWT

  static func jwtTests(key: (privateKey: SecKey, publicKey: SecKey)) async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let kid = "test-kid"
    let jwksJson = jwksJSON(kid: kid, publicKey: key.publicKey)
    let jwks = VeyraNSIWCJWKS.parse(jwksJson)
    expect(jwks != nil, "JWKS parsed")

    func payload(_ overrides: [String: Any] = [:]) -> [String: Any] {
      var base: [String: Any] = [
        "iss": VeyraNSIWC.issuer,
        "sub": "user-1",
        "aud": "issued-client",
        "exp": Int(now.timeIntervalSince1970) + 3600,
        "nbf": Int(now.timeIntervalSince1970) - 10,
        "nonce": "nonce-1"
      ]
      for (k, v) in overrides { base[k] = v }
      return base
    }
    func token(_ payload: [String: Any],
               header: [String: Any] = ["alg": "RS256", "typ": "JWT", "kid": kid]) -> String {
      signJWT(privateKey: key.privateKey, header: header, payload: payload) ?? ""
    }
    func verify(_ token: String, nonce: String? = "nonce-1", aud: String = "issued-client") -> VeyraNSIWCJWT.Claims? {
      guard let jwks else { return nil }
      return VeyraNSIWCJWT.verify(
        token: token, jwks: jwks, now: now,
        expectedIssuer: VeyraNSIWC.issuer, expectedAudience: aud, expectedNonce: nonce
      )
    }

    expect(verify(token(payload())) != nil, "valid token verified")
    expect(verify(token(payload(["iss": "https://evil.example"]))) == nil, "wrong issuer refused")
    expect(verify(token(payload(["aud": "someone-else"]))) == nil, "wrong audience refused")
    expect(verify(token(payload(["aud": ["issued-client", "other"]]))) == nil, "multi-aud without azp refused")
    expect(
      verify(token(payload(["aud": ["issued-client", "other"], "azp": "issued-client"]))) != nil,
      "multi-aud with own azp accepted"
    )
    expect(verify(token(payload(["nonce": "wrong"]))) == nil, "nonce mismatch refused")
    expect(verify(token(payload(["exp": Int(now.timeIntervalSince1970) - 10]))) == nil, "expired token refused")
    expect(verify(token(payload(["nbf": Int(now.timeIntervalSince1970) + 100]))) == nil, "future nbf refused")
    expect(verify(token(payload(), header: ["alg": "HS256", "kid": kid])) == nil, "non-RS256 alg refused")
    expect(verify(token(payload(), header: ["alg": "RS256", "kid": kid, "jku": "https://evil"])) == nil, "jku header refused")
    expect(verify(token(payload(), header: ["alg": "RS256", "kid": "other"])) == nil, "unknown kid refused")

    // A tampered signature fails.
    let valid = token(payload())
    let parts = valid.split(separator: ".")
    let tamperedSignature = base64URL(Data(repeating: 0, count: 256))
    expect(verify("\(parts[0]).\(parts[1]).\(tamperedSignature)") == nil, "tampered signature refused")

    // use != sig and key_ops without verify.
    let badUse = VeyraNSIWCJWKS.parse(jwksJSON(kid: kid, publicKey: key.publicKey, use: "enc"))
    let badUseToken = signJWT(privateKey: key.privateKey, header: ["alg": "RS256", "kid": kid], payload: payload()) ?? ""
    expect(badUse == nil || VeyraNSIWCJWT.verify(
      token: badUseToken, jwks: badUse!, now: now,
      expectedIssuer: VeyraNSIWC.issuer, expectedAudience: "issued-client", expectedNonce: "nonce-1"
    ) == nil, "use:enc key refused")

    // Duplicate kid is ambiguous.
    var twoKeys = jwksJSON(kid: kid, publicKey: key.publicKey)
    if let object = try? JSONSerialization.jsonObject(with: twoKeys) as? [String: Any],
      let keys = object["keys"] as? [Any]
    {
      twoKeys = (try? JSONSerialization.data(withJSONObject: ["keys": keys + keys])) ?? twoKeys
    }
    let duplicate = VeyraNSIWCJWKS.parse(twoKeys)
    expect(duplicate?.key(kid: kid) == nil, "duplicate kid is ambiguous")

    // The retained nonce is readable from the verified token.
    expect(VeyraNSIWCJWT.retainedNonce(valid) == "nonce-1", "retained nonce extracted")

    // A *present* optional claim with a malformed type is rejected, never
    // silently treated as absent.
    expect(verify(token(payload(["azp": false]))) == nil, "a boolean azp is rejected")
    expect(verify(token(payload(["azp": 1]))) == nil, "a numeric azp is rejected")
    expect(verify(token(payload(["azp": []]))) == nil, "an array azp is rejected")
    expect(
      verify(token(payload(["aud": "issued-client", "azp": "issued-client"]))) != nil,
      "a correct single-audience azp is accepted"
    )
    expect(verify(token(payload(["nbf": true]))) == nil, "a boolean nbf is rejected")
    expect(verify(token(payload(["nbf": "\(Int(now.timeIntervalSince1970) - 10)"]))) == nil, "a string nbf is rejected")
    expect(verify(token(payload(["nbf": 1.5]))) == nil, "a fractional nbf is rejected")
    expect(verify(token(payload(["iat": false]))) == nil, "a boolean iat is rejected")
    expect(verify(token(payload(["iat": -1]))) == nil, "a negative iat is rejected")
    expect(verify(token(payload(["iat": Int(now.timeIntervalSince1970) - 5]))) != nil, "a valid iat is accepted")
    expect(verify(token(payload(["nonce": 7]))) == nil, "a non-string nonce is rejected")
    // The absent-optional cases still verify.
    var withoutOptional = payload()
    withoutOptional["nbf"] = nil
    withoutOptional["azp"] = nil
    expect(verify(token(withoutOptional)) != nil, "absent optional claims still verify")

    // JWK metadata: a present-but-malformed alg/use/key_ops fails the key.
    func jwksWith(_ overrides: [String: Any], drop: [String] = []) -> VeyraNSIWCJWKS? {
      guard let parts = jwkParts(key.publicKey) else { return nil }
      var entry: [String: Any] = [
        "kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256",
        "n": parts.n, "e": parts.e, "key_ops": ["verify"]
      ]
      for key in drop { entry[key] = nil }
      for (key, value) in overrides { entry[key] = value }
      return VeyraNSIWCJWKS.parse(
        (try? JSONSerialization.data(withJSONObject: ["keys": [entry]])) ?? Data()
      )
    }
    func verifies(_ jwks: VeyraNSIWCJWKS?) -> Bool {
      guard let jwks, let jwt = jwks.key(kid: kid) else { return false }
      return VeyraNSIWCJWT.verify(
        token: valid, jwks: VeyraNSIWCJWKS(keys: [VeyraNSIWCJWK(kid: kid, key: jwt)]),
        now: now, expectedIssuer: VeyraNSIWC.issuer,
        expectedAudience: "issued-client", expectedNonce: "nonce-1"
      ) != nil
    }
    expect(jwksWith(["alg": 1]) == nil, "a numeric JWK alg fails the key")
    expect(jwksWith(["alg": "RS512"]) == nil, "a non-RS256 JWK alg fails the key")
    expect(jwksWith(["use": false]) == nil, "a boolean JWK use fails the key")
    expect(jwksWith(["use": "enc"]) == nil, "a non-sig JWK use fails the key")
    expect(jwksWith(["key_ops": "verify"]) == nil, "a string JWK key_ops fails the key")
    expect(jwksWith(["key_ops": []]) == nil, "an empty JWK key_ops fails the key")
    expect(jwksWith(["key_ops": ["sign"]]) == nil, "a JWK key_ops without verify fails the key")
    expect(jwksWith([:]) != nil, "the exact metadata parses")
    expect(verifies(jwksWith([:])), "the parsed key verifies the signed fixture")
    expect(jwksWith([:], drop: ["use", "alg", "key_ops"]) != nil, "absent metadata is allowed")
    expect(jwksWith(["d": "x"]) == nil, "private JWK material fails the key")
  }

  // MARK: provider auth

  static func providerTests() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)
    let expectedState = base64URL(Data(repeating: 0xAB, count: 32))
    let expectedNonce = base64URL(Data(repeating: 0xAB, count: 16))
    let issuedClientId = "issued-client-abc"

    guard let key = makeRSAKey() else { return }
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)

    // A store that fails its first save must leave the previous document intact.
    let failingStore = SyntheticStore()
    failingStore.failSave = true
    let failingProvider = VeyraNSIWCProvider(
      store: failingStore, http: ScriptedHTTP { _ in throw VeyraNSIWCError.transportUnavailable },
      stream: ScriptedStream(), clock: clock, random: random
    )
    do {
      _ = try failingProvider.ensureHost(entry: methodEntry(failingProvider, "notes-1"))
      expect(false, "store failure surfaces")
    } catch let error as VeyraNSIWCError {
      expect(error == .keychainFailure, "store failure surfaces as keychain_failure")
    } catch {
      expect(false, "store failure surfaces")
    }
    expect(failingStore.document == nil, "failed save preserves the previous (absent) document")

    // A full fresh auth flow.
    let store = SyntheticStore()
    let revocationBodies = Recorder()
    let http = ScriptedHTTP { request in
      switch request.url {
      case VeyraNSIWC.tokenEndpoint:
        let idToken = signJWT(
          privateKey: key.privateKey,
          header: ["alg": "RS256", "typ": "JWT", "kid": "test-kid"],
          payload: [
            "iss": VeyraNSIWC.issuer,
            "sub": "chatgpt-user",
            "aud": issuedClientId,
            "exp": Int(now.timeIntervalSince1970) + 3600,
            "nbf": Int(now.timeIntervalSince1970) - 10,
            "nonce": expectedNonce,
            "email": "user@example.com"
          ]
        ) ?? ""
        let body = """
          {"access_token":"access-1","refresh_token":"refresh-1","id_token":"\(idToken)",\
          "scope":"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",\
          "token_type":"Bearer","expires_in":3600}
          """
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
      case VeyraNSIWC.jwksEndpoint:
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: jwks)
      case VeyraNSIWC.modelsEndpoint:
        let body = #"{"models":[{"slug":"gpt-5","display_name":"GPT-5","visibility":"list"}]}"#
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
      case VeyraNSIWC.discoveryEndpoint:
        let body = #"{"revocation_endpoint":"https://auth.openai.com/api/accounts/oauth/revoke"}"#
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
      case "https://auth.openai.com/api/accounts/oauth/revoke":
        revocationBodies.record(
          request.body.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        )
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data())
      default:
        return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
      }
    }
    let provider = VeyraNSIWCProvider(
      store: store, http: http, stream: ScriptedStream(), clock: clock, random: random
    )

    do {
      let start = try provider.beginAuth(
        mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil,
        entry: methodEntry(provider, "notes-1")
      )
      expect(start.port == 49152, "beginAuth returns the ephemeral port")
      expect(
        start.authorizeURL.absoluteString.contains(
          "ext_agent_host_id=urn%3Auuid%3A"
        ),
        "the own stable host is sent on the fresh attempt"
      )

      // Wrong state must not consume the pending flow, and must not disturb it.
      let wrongState = await provider.completeCallback(
        query: ["code": "c", "state": "wrong", "client_id": issuedClientId],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(provider, "notes-1")
      )
      expect(wrongState.claimed == false, "wrong state claims nothing")
      expect(wrongState.failure == .stateMismatch, "wrong state refused")

      // An empty state is likewise refused and claims nothing.
      let emptyState = await provider.completeCallback(
        query: ["code": "c"],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(provider, "notes-1")
      )
      expect(emptyState.claimed == false, "empty state claims nothing")
      expect(emptyState.failure == .stateMismatch, "empty state refused")

      // A missing code with an exact state still claims nothing.
      let missingCode = await provider.completeCallback(
        query: ["state": expectedState, "client_id": issuedClientId],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(provider, "notes-1")
      )
      expect(missingCode.claimed == false, "missing code claims nothing")

      // ...so the genuine callback still succeeds, exactly once.
      let result = await provider.completeCallback(
        query: ["code": "c", "state": expectedState, "client_id": issuedClientId],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(provider, "notes-1")
      )
      expect(result.claimed, "the genuine callback claims the flow")
      guard let credential = result.credential else {
        expect(false, "the genuine callback yields a credential")
        return
      }
      expect(credential.subject == "chatgpt-user", "verified subject adopted")
      expect(credential.ownerAccountId == "notes-1", "credential owner is the Notes account")
      expect(
        VeyraNSIWC.requiredDirectScopes.allSatisfy { credential.grantedScopes.contains($0) },
        "direct scopes granted"
      )
      expect(store.document?.registration(clientId: issuedClientId)?.isComplete == true, "registration completed")
      expect(
        store.document?.registration(clientId: VeyraNSIWC.dynamicAgentClientId) == nil,
        "placeholder client never persisted"
      )

      // A replay of the same valid callback can never claim again.
      let replay = await provider.completeCallback(
        query: ["code": "c", "state": expectedState, "client_id": issuedClientId],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(provider, "notes-1")
      )
      expect(replay.claimed == false && replay.credential == nil, "a replayed callback claims nothing")

      // Models work after auth (no COST gate).
      let catalog = try await provider.fetchModels(ownerAccountId: "notes-1", entry: methodEntry(provider, "notes-1"))
      expect(catalog.allows(slug: "gpt-5"), "models fetched after auth")

      // Logout clears the credential but keeps host + registration, and the
      // best-effort revocation really runs (a pre-clear would skip it entirely).
      let outcome = await provider.logoutDetailed(ownerAccountId: "notes-1", entry: methodEntry(provider, "notes-1"))
      expect(store.document?.credential == nil, "logout clears the credential")
      expect(store.document?.registrations.count == 1, "logout keeps the registration")
      expect(store.document?.hostURN.isEmpty == false, "logout keeps the host")
      expect(outcome.cleared, "logout reports the local clear")
      expect(outcome.revocationConfirmed, "a 200-empty revocation is confirmed")
      expect(outcome.noActiveConnection == false, "an active connection was revoked")
      expect(
        revocationBodies.count == 1,
        "exactly one best-effort revocation request goes to the transport"
      )
      expect(
        revocationBodies.last?.contains("token=refresh-1") == true
          && revocationBodies.last?.contains("token_type_hint=refresh_token")
            == true
          && revocationBodies.last?.contains("client_id=\(issuedClientId)")
            == true,
        "the revocation carries the old refresh token, the own client and the hint"
      )

      // No record at all: nothing was revoked, so nothing is confirmed.
      let second = await provider.logoutDetailed(ownerAccountId: "notes-1", entry: methodEntry(provider, "notes-1"))
      expect(second.revocationConfirmed == false, "no record never implies a confirmed revocation")
      expect(second.noActiveConnection, "no record is reported as no active connection")
      expect(
        await provider.logout(ownerAccountId: "notes-1", entry: methodEntry(provider, "notes-1")) == false,
        "logout with nothing outstanding is not confirmed"
      )
      expect(
        revocationBodies.count == 1,
        "no record never issues a second transport request"
      )

      _ = start
    } catch let error as VeyraNSIWCError {
      expect(false, "fresh auth flow failed: \(error.code)")
    } catch {
      expect(false, "fresh auth flow failed (unknown)")
    }

    // A callback after the flow fence is refused without adopting anything.
    let ttlStore = SyntheticStore()
    let ttlProvider = VeyraNSIWCProvider(
      store: ttlStore, http: http, stream: ScriptedStream(), clock: clock, random: random
    )
    do {
      _ = try ttlProvider.beginAuth(
        mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil, entry: methodEntry(ttlProvider, "notes-1")
      )
      ttlProvider.fence()
      let fenced = await ttlProvider.completeCallback(
        query: ["code": "c", "state": expectedState, "client_id": issuedClientId],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(ttlProvider, "notes-1")
      )
      expect(fenced.claimed == false, "fenced flow claims nothing")
      expect(fenced.failure == .callbackInvalid, "fenced flow refused")
      expect(ttlStore.document?.credential == nil, "fenced callback persists nothing")
    } catch {
      expect(false, "ttl setup failed")
    }

    // A token response with the officially documented (but type/units-
    // undocumented) `earliest_refresh_at` is accepted end-to-end.
    let documentedStore = SyntheticStore()
    let documentedToken = idToken(key: key, now: now)
    let documentedJwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)
    let documentedProvider = VeyraNSIWCProvider(
      store: documentedStore,
      http: ScriptedHTTP { request in
        switch request.url {
        case VeyraNSIWC.tokenEndpoint:
          let body = """
            {"access_token":"access-1","refresh_token":"refresh-1",\
            "id_token":"\(documentedToken)",\
            "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct",\
            "token_type":"Bearer","expires_in":3600,\
            "earliest_refresh_at":{"seconds":1700000000}}
            """
          return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
        case VeyraNSIWC.jwksEndpoint:
          return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: documentedJwks)
        default:
          return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
        }
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    do {
      _ = try documentedProvider.beginAuth(
        mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil,
        entry: methodEntry(documentedProvider, "notes-1")
      )
      let documented = await documentedProvider.completeCallback(
        query: ["code": "c", "state": expectedState, "client_id": issuedClientId],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(documentedProvider, "notes-1")
      )
      expect(documented.claimed, "a documented earliest_refresh_at is accepted")
      expect(
        documented.failure == nil,
        "an undocumented-shape earliest_refresh_at never rejects the response"
      )
      expect(
        documented.credential?.refreshToken == "refresh-1",
        "the documented response yields the refresh token"
      )
    } catch let error as VeyraNSIWCError {
      expect(false, "the documented token response failed: \(error.code)")
    } catch {
      expect(false, "the documented token response failed (unknown)")
    }
  }

  // MARK: consent identity pinning

  /// A consent flow authenticated as a *different* ChatGPT subject must never
  /// overwrite the previously verified registration under the same client id.
  static func consentIdentityTests() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)
    let expectedState = base64URL(Data(repeating: 0xAB, count: 32))
    let expectedNonce = base64URL(Data(repeating: 0xAB, count: 16))
    let clientId = "issued-client-abc"

    guard let key = makeRSAKey() else { return }
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)

    let store = SyntheticStore(document: VeyraNSIWCPersisted(
      hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
      registrations: [VeyraNSIWCRegistration(
        clientId: clientId, subject: "chatgpt-user", email: nil, createdAt: 1
      )],
      credential: nil
    ))
    let http = ScriptedHTTP { request in
      switch request.url {
      case VeyraNSIWC.tokenEndpoint:
        let idToken = signJWT(
          privateKey: key.privateKey,
          header: ["alg": "RS256", "typ": "JWT", "kid": "test-kid"],
          payload: [
            "iss": VeyraNSIWC.issuer,
            "sub": "foreign-user",
            "aud": clientId,
            "exp": Int(now.timeIntervalSince1970) + 3600,
            "nonce": expectedNonce
          ]
        ) ?? ""
        let body = """
          {"access_token":"access-1","refresh_token":"refresh-1","id_token":"\(idToken)",\
          "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct"}
          """
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
      case VeyraNSIWC.jwksEndpoint:
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: jwks)
      default:
        return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
      }
    }
    let provider = VeyraNSIWCProvider(
      store: store, http: http, stream: ScriptedStream(), clock: clock, random: random
    )

    do {
      let start = try provider.beginAuth(
        mode: .consent(clientId: clientId), ownerAccountId: "notes-1",
        port: 49152, loginHint: nil,
        entry: methodEntry(provider, "notes-1")
      )
      expect(
        start.authorizeURL.absoluteString.contains(
          "ext_agent_host_id=urn%3Auuid%3A123e4567-e89b-42d3-a456-426614174000"
        ),
        "the own stable host is sent on the consent attempt"
      )
      expect(
        start.authorizeURL.absoluteString.contains(
          "client_id=\(clientId)"
        ),
        "the consent attempt presents its own issued client id"
      )
      // A consent callback that names a *different* client id never claims.
      let mismatchedClient = await provider.completeCallback(
        query: ["code": "c", "state": expectedState, "client_id": "other-client"],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(provider, "notes-1")
      )
      expect(mismatchedClient.claimed == false, "a foreign callback client id claims nothing")
      expect(mismatchedClient.failure == .identityMismatch, "a foreign callback client id is refused")

      // A foreign ChatGPT identity for the *own* client id is claimed (the
      // callback is exactly correlated) but must never be adopted.
      let foreign = await provider.completeCallback(
        query: ["code": "c", "state": expectedState],
        port: 49152, ownerAccountId: "notes-1",
        entry: methodEntry(provider, "notes-1")
      )
      expect(foreign.claimed, "the correlated consent callback claims the flow")
      expect(foreign.credential == nil, "a foreign consent identity yields no credential")
      expect(foreign.failure == .identityMismatch, "a foreign consent identity is refused")
      expect(
        store.document?.registration(clientId: clientId)?.subject == "chatgpt-user",
        "verified consent registration is not overwritten"
      )
      expect(store.document?.credential == nil, "no credential persisted for a foreign consent identity")
    } catch {
      expect(false, "consent flow setup failed")
    }

    // A returning flow must present the *own* issued client id and read the
    // exact registered subject; both the URL and the callback are checked.
    do {
      let start = try provider.beginAuth(
        mode: .returning(clientId: clientId), ownerAccountId: "notes-1",
        port: 49152, loginHint: nil,
        entry: methodEntry(provider, "notes-1")
      )
      expect(
        start.authorizeURL.absoluteString.contains(
          "ext_agent_host_id=urn%3Auuid%3A123e4567-e89b-42d3-a456-426614174000"
        ),
        "the own stable host is sent on the returning attempt"
      )
      expect(
        start.authorizeURL.absoluteString.contains("agent_name_hint") == false,
        "the agent-name hint is only sent on the initial registration"
      )
      expect(
        start.authorizeURL.absoluteString.contains("prompt=") == false,
        "a returning attempt never forces consent"
      )
    } catch {
      expect(false, "returning flow setup failed")
    }
  }

  // MARK: verified-subject replacement rules

  static func registrationIdentityTests() {
    let urn = "urn:uuid:123e4567-e89b-42d3-a456-426614174000"
    let verified = VeyraNSIWCRegistration(
      clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
    )
    let document = VeyraNSIWCPersisted(
      hostURN: urn, registrations: [verified], credential: nil
    )
    expect(
      document.withRegistration(verified) != nil,
      "the identical verified registration is idempotent"
    )
    expect(
      document.withRegistration(VeyraNSIWCRegistration(
        clientId: "issued-client", subject: "user-2", email: nil, createdAt: 2
      )) == nil,
      "a different verified subject never replaces a verified registration"
    )
    expect(
      document.withRegistration(VeyraNSIWCRegistration(
        clientId: "issued-client", subject: nil, email: nil, createdAt: 2
      )) == nil,
      "a pending registration never replaces a verified one"
    )
    // A *new* own registration (a new issued client id) is always allowed.
    expect(
      document.withRegistration(VeyraNSIWCRegistration(
        clientId: "issued-client-2", subject: "user-2", email: nil, createdAt: 2
      )) != nil,
      "a new own issued client id binds a new registration"
    )

    // An identity-without-grant credential round-trips: the verified identity
    // is retained while the direct-scope gate reports the missing permission.
    let emptyScopes = VeyraNSIWCPersisted(
      hostURN: urn,
      registrations: [VeyraNSIWCRegistration(
        clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
      )],
      credential: VeyraNSIWCCredential(
        clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
        accessToken: "a", refreshToken: nil, idToken: "i",
        grantedScopes: [], expiresAt: nil, providerEpoch: 0
      )
    )
    let reparsed = VeyraNSIWCPersisted.parse(emptyScopes.serialized() ?? Data())
    expect(reparsed != nil, "a granted-scope-less identity still round-trips")
    expect(reparsed?.credential?.grantedScopes.isEmpty == true, "no scope is invented on reload")
  }

  // MARK: keychain attribute dictionaries

  /// The production dictionaries only: no `SecItem*` call is made, so the real
  /// Keychain is never touched.
  static func keychainAttributeTests() {
    let data = Data("x".utf8)
    let update = VeyraNSIWCKeychain.updateAttributes(data)
    expect(
      update[kSecUseDataProtectionKeychain as String] == nil,
      "the SecItemUpdate attributes never carry the data-protection keychain option"
    )
    expect(
      update[kSecValueData as String] as? Data == data,
      "the SecItemUpdate attributes carry only the value data"
    )
    expect(
      update[kSecAttrAccessible as String] as? String
        == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
      "the SecItemUpdate attributes keep WhenUnlockedThisDeviceOnly"
    )
    expect(update.count == 2, "the SecItemUpdate attributes are exactly the item attributes")

    let query = VeyraNSIWCKeychain.baseQuery()
    expect(
      query[kSecUseDataProtectionKeychain as String] as? Bool == true,
      "the query keeps the data-protection keychain option"
    )
    expect(
      query[kSecAttrSynchronizable as String] as? Bool == false,
      "the query keeps synchronizable:false"
    )
    expect(
      query[kSecAttrService as String] as? String == VeyraNSIWC.keychainService
        && query[kSecAttrAccount as String] as? String == VeyraNSIWC.keychainAccount,
      "the query pins the service and account"
    )
    expect(
      query[kSecAttrAccessGroup as String] == nil,
      "no explicit access group is requested (the entitled default group is used)"
    )

    let add = VeyraNSIWCKeychain.addAttributes(data)
    expect(
      add[kSecUseDataProtectionKeychain as String] as? Bool == true,
      "the add dictionary keeps the data-protection keychain option"
    )
    expect(
      add[kSecValueData as String] as? Data == data
        && add[kSecAttrAccessible as String] as? String
          == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
      "the add dictionary carries the value data and the accessible class"
    )
    expect(
      add[kSecAttrSynchronizable as String] as? Bool == false,
      "the add dictionary keeps synchronizable:false"
    )
    // The production adapter is never driven here: the harness must not touch
    // the real Keychain, so only the dictionaries above are asserted.
  }

  // MARK: responses requests

  static func responsesTests() {
    let body = VeyraNSIWCResponsesRequest.body(
      model: "gpt-5", input: [["role": "user", "content": [["type": "input_text", "text": "hi"]]]],
      tools: [VeyraNSIWCTools.namespace([
        VeyraNSIWCFunctionTool(
          name: "do_thing", description: "does a thing",
          parameters: [
            "type": "object",
            "properties": ["x": ["type": "string"]],
            "required": ["x"],
            "additionalProperties": false
          ]
        )
      ]) ?? [:]], instructions: nil
    )
    guard let body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
      expect(false, "responses body built")
      return
    }
    let allowed: Set<String> = ["model", "input", "store", "stream", "tools", "instructions"]
    expect(Set(object.keys).isSubset(of: allowed), "only supported keys emitted")
    expect(object["store"] as? Bool == false, "store:false")
    expect(object["stream"] as? Bool == true, "stream:true")
    expect(object["model"] as? String == "gpt-5", "model emitted")

    guard let headers = VeyraNSIWCResponsesRequest.headers(accessToken: "tok") else {
      expect(false, "headers built")
      return
    }
    expect(headers == [
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Authorization": "Bearer tok"
    ], "fixed streaming headers")

    // Namespace shape.
    guard let namespace = VeyraNSIWCTools.namespace([
      VeyraNSIWCFunctionTool(
        name: "f", description: "d",
        parameters: ["type": "object", "properties": ["a": ["type": "string"]], "required": ["a"], "additionalProperties": false]
      )
    ]) else {
      expect(false, "namespace built")
      return
    }
    expect(namespace["type"] as? String == "namespace", "namespace type")
    expect(namespace["name"] as? String == "veyran", "namespace name")
    guard let tools = namespace["tools"] as? [[String: Any]], let first = tools.first else {
      expect(false, "namespace tools")
      return
    }
    expect(first["type"] as? String == "function" && first["strict"] as? Bool == true, "function strict")

    // A schema missing additionalProperties:false is refused.
    expect(
      VeyraNSIWCTools.namespace([VeyraNSIWCFunctionTool(
        name: "f", description: "d",
        parameters: ["type": "object", "properties": ["a": ["type": "string"]], "required": ["a"]]
      )]) == nil,
      "non-strict schema refused"
    )

    expect(VeyraNSIWCInput.message(role: "system", text: "x") == nil, "system role refused")
    expect(VeyraNSIWCInput.message(role: "developer", text: "x") != nil, "developer role allowed")
  }

  // MARK: streaming

  static func streamingTests() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)

    guard let key = makeRSAKey() else { return }
    _ = key
    let store = SyntheticStore(document: VeyraNSIWCPersisted(
      hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
      registrations: [VeyraNSIWCRegistration(
        clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
      )],
      credential: VeyraNSIWCCredential(
        clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
        accessToken: "access", refreshToken: "refresh", idToken: "id",
        grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
        expiresAt: nil, providerEpoch: 0
      )
    ))
    let stream = ScriptedStream()
    let provider = VeyraNSIWCProvider(
      store: store,
      http: ScriptedHTTP { _ in
        let body = #"{"models":[{"slug":"gpt-5","display_name":"GPT-5","visibility":"list"}]}"#
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
      },
      stream: stream, clock: clock, random: random
    )
    let catalog = VeyraNSIWCCatalog(models: [VeyraNSIWCModel(slug: "gpt-5", displayName: "GPT-5")])

    var emissions: [VeyraNSIWCStreamEmission] = []
    func run(chunks: [String], error: Error? = nil) async -> Result<VeyraNSIWCCompletedResponse, VeyraNSIWCError> {
      stream.chunks = chunks.map { Data($0.utf8) }
      stream.error = error
      do {
        let result = try await provider.invoke(
          ownerAccountId: "notes-1", model: "gpt-5",
          input: [["role": "user", "content": [["type": "input_text", "text": "hi"]]]],
          tools: nil, instructions: nil, requestId: "js-request-1",
          catalog: catalog, authorizedNames: ["do_thing"],
          entry: methodEntry(provider, "notes-1"),
          emit: { emissions.append($0) }
        )
        return .success(result)
      } catch let error as VeyraNSIWCError {
        return .failure(error)
      } catch {
        return .failure(.streamInvalid)
      }
    }

    let completed = await run(chunks: [
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hel\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}}\n\n"
    ])
    if case let .success(response) = completed {
      expect(response.text == "hello", "completed response text")
    } else {
      expect(false, "completed response parsed")
    }
    // The first emission is the generation handshake the JS side adopts, and it
    // echoes exactly the request id the JS host supplied.
    if case let .started(requestId, generation) = emissions.first {
      expect(generation == provider.currentEpoch(), "stream announces its provider generation")
      expect(requestId == "js-request-1", "the handshake echoes the JS-owned request id")
    } else {
      expect(false, "stream announces its provider generation")
    }
    expect(emissions.count == 2, "handshake precedes exactly one delta")
    if case let .delta(_, requestId, generation) = emissions[1] {
      expect(
        requestId == "js-request-1" && generation == provider.currentEpoch(),
        "every later emission carries the same request id and generation"
      )
    } else {
      expect(false, "every later emission carries the same request id and generation")
    }
    // An invalid/absent request id is refused before any transport work.
    do {
      _ = try await provider.invoke(
        ownerAccountId: "notes-1", model: "gpt-5",
        input: [["role": "user", "content": [["type": "input_text", "text": "hi"]]]],
        tools: nil, instructions: nil, requestId: "bad id!",
        catalog: catalog, authorizedNames: [],
        entry: methodEntry(provider, "notes-1"),
        emit: { _ in }
      )
      expect(false, "a malformed request id is refused")
    } catch let error as VeyraNSIWCError {
      expect(error == .streamInvalid, "a malformed request id is refused")
    } catch {
      expect(false, "a malformed request id is refused")
    }

    // EOF without response.completed is never a success.
    if case .failure(let error) = await run(chunks: [
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n"
    ]) {
      expect(error == .streamInvalid, "EOF without completed is not a success")
    } else {
      expect(false, "EOF without completed is not a success")
    }

    for name in ["response.failed", "response.incomplete", "response.canceled"] {
      if case .failure(let error) = await run(chunks: [
        "event: \(name)\ndata: {\"type\":\"\(name)\",\"response\":{}}\n\n"
      ]) {
        expect(error != .canceled || name == "response.canceled", "\(name) is not a success")
      } else {
        expect(false, "\(name) is not a success")
      }
    }

    // Function call terminal.
    let functionResult = await run(chunks: [
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"namespace\":\"veyran\",\"name\":\"do_thing\",\"arguments\":\"{\\\"x\\\":1}\",\"status\":\"completed\"}]}}\n\n"
    ])
    if case let .success(response) = functionResult {
      expect(response.functionCalls.count == 1, "terminal function call parsed")
      expect(response.functionCalls.first?.callId == "call_1", "call id preserved")
    } else {
      expect(false, "terminal function call parsed")
    }

    // A duplicate call id fails closed.
    if case .failure = await run(chunks: [
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"call_id\":\"c\",\"namespace\":\"veyran\",\"name\":\"do_thing\",\"arguments\":\"{}\"},{\"type\":\"function_call\",\"call_id\":\"c\",\"namespace\":\"veyran\",\"name\":\"do_thing\",\"arguments\":\"{}\"}]}}\n\n"
    ]) {
      expect(true, "duplicate call id refused")
    } else {
      expect(false, "duplicate call id refused")
    }

    // A program caller is refused; a missing namespace is refused.
    expect(functionCall(arguments: "{}", caller: ["type": "program"]) == nil, "program caller refused")
    expect(functionCall(missingNamespace: true) == nil, "missing namespace refused")
    expect(functionCall(arguments: "not json") == nil, "malformed arguments refused")
    expect(functionCall(name: "not_authorized") == nil, "unknown function name refused")
    expect(functionCall(arguments: "{}") != nil, "valid function call accepted")

    // Error status mapping.
    expect(VeyraNSIWCProvider.error(status: 429, providerCode: nil) == .usageLimitExceeded, "429 maps to usage_limit_exceeded")
    expect(VeyraNSIWCProvider.error(status: 503, providerCode: nil) == .usageUnavailable, "503 maps to usage_unavailable")
    expect(VeyraNSIWCProvider.error(status: 401, providerCode: nil) == .invalidUser, "401 maps to invalid_user")
    expect(
      VeyraNSIWCProvider.error(status: 403, providerCode: "subscription_sharing_user_not_eligible") == .notEligible,
      "not-eligible code maps"
    )
    expect(
      VeyraNSIWCProvider.error(status: 403, providerCode: "subscription_sharing_usage_limit_exceeded") == .usageLimitExceeded,
      "usage limit code maps"
    )

    // Missing direct scopes gate models/inference.
    let noScopeStore = SyntheticStore(document: VeyraNSIWCPersisted(
      hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
      registrations: [],
      credential: VeyraNSIWCCredential(
        clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
        accessToken: "a", refreshToken: nil, idToken: "i",
        grantedScopes: ["openid"], expiresAt: nil, providerEpoch: 0
      )
    ))
    let gated = VeyraNSIWCProvider(
      store: noScopeStore, http: ScriptedHTTP { _ in
        VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data())
      }, stream: ScriptedStream(), clock: clock, random: random
    )
    do {
      _ = try await gated.fetchModels(ownerAccountId: "notes-1", entry: methodEntry(gated, "notes-1"))
      expect(false, "missing direct scope gates models")
    } catch let error as VeyraNSIWCError {
      expect(error == .missingPlanScope, "missing direct scope gates models")
    } catch {
      expect(false, "missing direct scope gates models")
    }
  }

  // MARK: token response contract

  /// The exact nonce the deterministic random source produces.
  static let abNonce = base64URL(Data(repeating: 0xAB, count: 16))
  static let abState = base64URL(Data(repeating: 0xAB, count: 32))

  static func json(_ fields: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: fields),
      let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }

  static func idToken(
    key: (privateKey: SecKey, publicKey: SecKey),
    clientId: String = "issued-client-abc",
    now: Date,
    subject: String = "chatgpt-user"
  ) -> String {
    signJWT(
      privateKey: key.privateKey,
      header: ["alg": "RS256", "typ": "JWT", "kid": "test-kid"],
      payload: [
        "iss": VeyraNSIWC.issuer,
        "sub": subject,
        "aud": clientId,
        "exp": Int(now.timeIntervalSince1970) + 3600,
        "nbf": Int(now.timeIntervalSince1970) - 10,
        "nonce": abNonce,
        "email": "user@example.com"
      ]
    ) ?? ""
  }

  /// One fresh registration against a scripted token body.
  static func freshLogin(
    key: (privateKey: SecKey, publicKey: SecKey),
    clock: VeyraNSIWCClock,
    random: VeyraNSIWCRandomSource,
    token: String,
    store: SyntheticStore = SyntheticStore()
  ) async -> (result: VeyraNSIWCCallbackResult, provider: VeyraNSIWCProvider) {
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)
    let http = ScriptedHTTP { request in
      switch request.url {
      case VeyraNSIWC.tokenEndpoint:
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(token.utf8))
      case VeyraNSIWC.jwksEndpoint:
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: jwks)
      default:
        return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
      }
    }
    let provider = VeyraNSIWCProvider(
      store: store, http: http, stream: ScriptedStream(), clock: clock, random: random
    )
    guard
      let _ = try? provider.beginAuth(
        mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil,
        entry: methodEntry(provider, "notes-1")
      )
    else { return (.rejected(.callbackInvalid), provider) }
    let result = await provider.completeCallback(
      query: ["code": "c", "state": abState, "client_id": "issued-client-abc"],
      port: 49152, ownerAccountId: "notes-1",
      entry: methodEntry(provider, "notes-1")
    )
    return (result, provider)
  }

  static func tokenResponseTests(key: (privateKey: SecKey, publicKey: SecKey)) async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)
    let signed = idToken(key: key, now: now)
    let fullScope =
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"

    func fields(_ overrides: [String: Any] = [:], drop: [String] = []) -> [String: Any] {
      var base: [String: Any] = [
        "access_token": "access-1",
        "refresh_token": "refresh-1",
        "id_token": signed,
        "scope": fullScope,
        "token_type": "Bearer",
        "expires_in": 3600
      ]
      for key in drop { base[key] = nil }
      for (key, value) in overrides { base[key] = value }
      return base
    }

    // The baseline accepted response.
    let baseline = await freshLogin(
      key: key, clock: clock, random: random, token: json(fields())
    )
    expect(baseline.result.claimed, "a token 200 is claimed")
    expect(baseline.result.credential != nil, "a fully documented token 200 authenticates")
    expect(
      baseline.result.credential?.grantedScopes.count == 6,
      "the returned scope set is adopted verbatim"
    )

    // `earliest_refresh_at` is documented but its type/units are not: every
    // shape is accepted and none is ever used as a schedule or a rejection.
    for shape in [
      json(fields(["earliest_refresh_at": ["seconds": 1_700_000_000]])),
      json(fields(["earliest_refresh_at": "2026-01-01T00:00:00Z"])),
      json(fields(["earliest_refresh_at": 1_700_000_000]))
    ] {
      let documented = await freshLogin(
        key: key, clock: clock, random: random, token: shape
      )
      expect(
        documented.result.credential != nil,
        "an officially documented earliest_refresh_at never rejects the response"
      )
    }

    // A missing scope is *never* widened to the requested set: the identity is
    // retained and the direct-scope gate denies models/inference truthfully.
    let noScope = await freshLogin(
      key: key, clock: clock, random: random,
      token: json(fields(drop: ["scope", "token_type"]))
    )
    expect(noScope.result.credential != nil, "an identity without a granted scope is retained")
    expect(
      noScope.result.credential?.grantedScopes.isEmpty == true,
      "no scope is invented when the issuer omits it"
    )
    let noScopeStore = SyntheticStore(document: noScope.provider.persistedForRead())
    let gated = VeyraNSIWCProvider(
      store: noScopeStore,
      http: ScriptedHTTP { _ in
        VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data())
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    do {
      _ = try await gated.fetchModels(ownerAccountId: "notes-1", entry: methodEntry(gated, "notes-1"))
      expect(false, "a missing granted scope denies models")
    } catch let error as VeyraNSIWCError {
      expect(error == .missingPlanScope, "a missing granted scope denies models")
    } catch {
      expect(false, "a missing granted scope denies models")
    }

    // Malformed official fields fail the whole response closed.
    let malformed: [(String, [String: Any])] = [
      ("token_type:bearer", fields(["token_type": "bearer"])),
      ("token_type:number", fields(["token_type": 1])),
      ("scope:array", fields(["scope": ["openid"]])),
      ("scope:empty", fields(["scope": ""])),
      ("expires_in:string", fields(["expires_in": "3600"])),
      ("expires_in:bool", fields(["expires_in": true])),
      ("refresh_token:number", fields(["refresh_token": 7])),
      ("id_token:number", fields(["id_token": 7])),
      ("unknown key", fields(["something_else": 1])),
      ("access_token:number", fields(["access_token": 7]))
    ]
    for (label, body) in malformed {
      let rejected = await freshLogin(
        key: key, clock: clock, random: random, token: json(body)
      )
      expect(
        rejected.result.credential == nil && rejected.result.failure == .tokenInvalid,
        "a malformed official token field is rejected (\(label))"
      )
    }
    // token_type:null is simply absent, not malformed.
    let nullType = await freshLogin(
      key: key, clock: clock, random: random, token: json(fields(["token_type": NSNull()]))
    )
    expect(nullType.result.credential != nil, "an explicit null token_type is treated as absent")

    // A duplicate JSON key is refused before any parsing.
    let duplicate = """
      {"access_token":"a","access_token":"b","id_token":"\(signed)",\
      "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct"}
      """
    let duplicated = await freshLogin(
      key: key, clock: clock, random: random, token: duplicate
    )
    expect(duplicated.result.failure == .tokenInvalid, "a duplicate token key is refused")
  }

  // MARK: stream error packets

  static func streamErrorCodeTests() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)
    let stream = ScriptedStream()
    let store = SyntheticStore(document: VeyraNSIWCPersisted(
      hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
      registrations: [VeyraNSIWCRegistration(
        clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
      )],
      credential: VeyraNSIWCCredential(
        clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
        accessToken: "access", refreshToken: "refresh", idToken: "id",
        grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
        expiresAt: nil, providerEpoch: 0
      )
    ))
    let provider = VeyraNSIWCProvider(
      store: store,
      http: ScriptedHTTP { _ in
        VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data())
      },
      stream: stream, clock: clock, random: random
    )
    let catalog = VeyraNSIWCCatalog(models: [VeyraNSIWCModel(slug: "gpt-5", displayName: "GPT-5")])

    func run(chunks: [String], error: Error? = nil) async -> (VeyraNSIWCError?, [VeyraNSIWCStreamEmission]) {
      var emissions: [VeyraNSIWCStreamEmission] = []
      stream.chunks = chunks.map { Data($0.utf8) }
      stream.error = error
      do {
        _ = try await provider.invoke(
          ownerAccountId: "notes-1", model: "gpt-5",
          input: [["role": "user", "content": [["type": "input_text", "text": "hi"]]]],
          tools: nil, instructions: nil, requestId: "js-1",
          catalog: catalog, authorizedNames: [],
          entry: methodEntry(provider, "notes-1"),
          emit: { emissions.append($0) }
        )
        return (nil, emissions)
      } catch let error as VeyraNSIWCError {
        return (error, emissions)
      } catch {
        return (.streamInvalid, emissions)
      }
    }

    // The official nested `response.failed` packet maps to the catalogued code.
    for (code, expected) in [
      ("usage_limit_exceeded", VeyraNSIWCError.usageLimitExceeded),
      ("subscription_sharing_usage_limit_exceeded", .usageLimitExceeded),
      ("subscription_sharing_usage_unavailable", .usageUnavailable),
      ("subscription_sharing_invalid_user", .invalidUser),
      ("subscription_sharing_user_not_eligible", .notEligible)
    ] {
      let packet = "event: response.failed\n"
        + "data: {\"type\":\"response.failed\",\"response\":{\"id\":\"r\","
        + "\"status\":\"failed\",\"error\":{\"code\":\"\(code)\","
        + "\"message\":\"m\"}}}\n\n"
      let (error, _) = await run(chunks: [packet])
      expect(error == expected, "the nested response.failed code maps (\(code))")
    }

    // A nested packet with an uncatalogued code still fails closed, never
    // silently succeeding.
    let unknown = "event: response.failed\n"
      + "data: {\"type\":\"response.failed\",\"response\":{\"error\":"
      + "{\"code\":\"something_odd\"}}}\n\n"
    let (unknownError, _) = await run(chunks: [unknown])
    expect(unknownError == .streamInvalid, "an uncatalogued failure code still fails closed")

    // A transport-level 503/401 uses the same catalogue.
    let (unavailable, _) = await run(
      chunks: [],
      error: VeyraNSIWCProviderFailure(status: 503, providerCode: nil)
    )
    expect(unavailable == .usageUnavailable, "a 503 maps to usage_unavailable")
    let (invalidUser, _) = await run(
      chunks: [],
      error: VeyraNSIWCProviderFailure(
        status: 401, providerCode: "subscription_sharing_invalid_user"
      )
    )
    expect(invalidUser == .invalidUser, "a 401 with the official code maps to invalid_user")

    // The partial draft survives a failure; exactly one stream request is made
    // (a failed stream is never retried implicitly).
    let before = stream.streamCount
    let (limit, emissions) = await run(chunks: [
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
      "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_exceeded\"}}}\n\n"
    ])
    expect(limit == .usageLimitExceeded, "a partial stream can still end in usage_limit_exceeded")
    let deltas = emissions.compactMap { emission -> String? in
      if case let .delta(text, _, _) = emission { return text }
      return nil
    }
    expect(deltas == ["partial"], "the partial draft is emitted before the failure")
    expect(stream.streamCount - before == 1, "a failed stream is never retried implicitly")
  }

  // MARK: logout / revocation

  static func logoutRevocationTests() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)

    func makeStore(refreshToken: String?) -> SyntheticStore {
      SyntheticStore(document: VeyraNSIWCPersisted(
        hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
        registrations: [VeyraNSIWCRegistration(
          clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
        )],
        credential: VeyraNSIWCCredential(
          clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
          accessToken: "access-old", refreshToken: refreshToken, idToken: "id",
          grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
          expiresAt: nil, providerEpoch: 0
        )
      ))
    }

    let bodies = Recorder()
    func makeProvider(
      store: SyntheticStore,
      revocationStatus: Int,
      revocationBody: Data = Data()
    ) -> VeyraNSIWCProvider {
      VeyraNSIWCProvider(
        store: store,
        http: ScriptedHTTP { request in
          if request.url == VeyraNSIWC.discoveryEndpoint {
            let body = #"{"revocation_endpoint":"https://auth.openai.com/api/accounts/oauth/revoke"}"#
            return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
          }
          bodies.record(request.body.flatMap { String(data: $0, encoding: .utf8) } ?? "")
          return VeyraNSIWCHTTPResponse(
            status: revocationStatus, headers: [:], body: revocationBody
          )
        },
        stream: ScriptedStream(), clock: clock, random: random
      )
    }

    // A non-200/empty answer is an *unknown* outcome, never a confirmation, and
    // the local clear still happened first.
    let unclearStore = makeStore(refreshToken: "refresh-old")
    let unclearProvider = makeProvider(store: unclearStore, revocationStatus: 503)
    let unclear = await unclearProvider.logoutDetailed(
      ownerAccountId: "notes-1",
      entry: methodEntry(unclearProvider, "notes-1")
    )
    expect(unclear.cleared, "the local clear happens first")
    expect(unclear.revocationConfirmed == false, "a 503 is not a confirmed revocation")
    expect(unclear.noActiveConnection == false, "a 503 is not a no-connection case")
    expect(unclearStore.document?.credential == nil, "the credential is cleared locally")
    expect(
      bodies.last?.contains("token=refresh-old") == true
        && bodies.last?.contains("client_id=issued-client") == true,
      "the one best-effort request carries the old token and the own client"
    )

    // A 200 with a non-empty body is not a confirmation either.
    let echoStore = makeStore(refreshToken: "refresh-old")
    let echoProvider = makeProvider(
      store: echoStore, revocationStatus: 200, revocationBody: Data("{\"ok\":true}".utf8)
    )
    let echoed = await echoProvider.logoutDetailed(
      ownerAccountId: "notes-1",
      entry: methodEntry(echoProvider, "notes-1")
    )
    expect(echoed.revocationConfirmed == false, "a 200 with a body is not a confirmation")

    // A credential without a refresh token still revokes its access token.
    let accessOnly = makeStore(refreshToken: nil)
    let accessProvider = makeProvider(store: accessOnly, revocationStatus: 200)
    let fallback = await accessProvider.logoutDetailed(
      ownerAccountId: "notes-1",
      entry: methodEntry(accessProvider, "notes-1")
    )
    expect(fallback.revocationConfirmed, "an access-token revocation is confirmed")
    expect(
      bodies.last?.contains("token=access-old") == true
        && bodies.last?.contains("token_type_hint=access_token") == true,
      "a refresh-token-less credential revokes its access token"
    )

    // An unreadable/absent record never claims a confirmed revocation.
    let empty = SyntheticStore()
    let emptyProvider = makeProvider(store: empty, revocationStatus: 200)
    let noRecord = await emptyProvider.logoutDetailed(
      ownerAccountId: "notes-1",
      entry: methodEntry(emptyProvider, "notes-1")
    )
    expect(noRecord.cleared, "an absent record reports the (vacuous) local clear")
    expect(noRecord.revocationConfirmed == false, "an absent record is never confirmed")
    expect(noRecord.noActiveConnection, "an absent record is distinguishable")
  }

  // MARK: callback flow coordination

  static func authFlowTests(key: (privateKey: SecKey, publicKey: SecKey)) async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)
    let signed = idToken(key: key, now: now)
    let tokenBody = """
      {"access_token":"access-1","refresh_token":"refresh-1","id_token":"\(signed)",\
      "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct",\
      "token_type":"Bearer"}
      """
    let exchanges = Counter()
    let store = SyntheticStore()
    let http = ScriptedHTTP { request in
      switch request.url {
      case VeyraNSIWC.tokenEndpoint:
        exchanges.increment()
        // A small delay so a concurrent second callback really races.
        try await Task.sleep(nanoseconds: 20_000_000)
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(tokenBody.utf8))
      case VeyraNSIWC.jwksEndpoint:
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: jwks)
      default:
        return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
      }
    }
    let provider = VeyraNSIWCProvider(
      store: store, http: http, stream: ScriptedStream(), clock: clock, random: random
    )

    // The coordinator under test is the exact production seam the RCT module
    // calls; the listener and the main queue are synthetic so a *deferred*
    // delivery can be replayed deterministically.
    let registry = ListenerRegistry()
    let browserQueue = ManualQueue()
    let opened = Recorder()
    let lifecycle = VeyraNSIWCLifecycle(
      providerFactory: { provider },
      listenerFactory: { registry.make() },
      openURL: { url, _ in opened.record(url.absoluteString) },
      mainQueue: { browserQueue.enqueue($0) }
    )
    var events: [VeyraNSIWCLifecycle.AuthEvent] = []
    lifecycle.setAuthHandler { events.append($0) }
    let query = ["code": "c", "state": abState, "client_id": "issued-client-abc"]

    // A hostile empty/wrong-state request (and a missing code) never ends the
    // flow; the genuine callback then succeeds exactly once.
    let firstBox = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { firstBox.set($0) }
    )
    guard let firstListener = registry.at(0) else {
      expect(false, "the first listener is created")
      return
    }
    firstListener.ready()
    browserQueue.drain()
    guard case let .success(firstStart)? = firstBox.result else {
      expect(false, "the first flow starts")
      return
    }
    expect(firstStart.started, "the listener-ready flow reports started")
    expect(firstStart.port == 49152, "the flow reports the listener port")
    expect(firstListener.started == 1, "the listener is started exactly once")
    expect(opened.count == 1, "exactly one browser open happens for the current source")

    firstListener.valid(["code": "c", "state": "wrong"])
    firstListener.valid([:])
    firstListener.valid(["state": abState, "client_id": "issued-client-abc"])
    await settle()
    expect(events.isEmpty, "a wrong-state/empty/code-less callback reports nothing")
    expect(exchanges.value == 0, "a refused callback performs no exchange")
    expect(firstListener.canceled == 0, "the listener survives a refused callback")
    expect(
      lifecycle.isCurrentAuthFlow(firstStart.generation),
      "the flow stays current after a refused callback"
    )

    // Two *concurrent* valid callbacks: exactly one claims the flow and exactly
    // one exchange happens.
    firstListener.valid(query)
    firstListener.valid(query)
    _ = await waitUntil("exactly one authenticated event") { events.count == 1 }
    expect(events.count == 1, "exactly one concurrent callback is reported")
    if case let .authenticated(subject, clientId, generation, owner, epoch) = events.first {
      expect(subject == "chatgpt-user", "the authenticated event carries the verified subject")
      expect(clientId == "issued-client-abc", "the event carries the own issued client id")
      expect(generation == firstStart.generation, "the event carries the exact flow generation")
      expect(owner == "notes-1", "the event carries the exact owner account")
      expect(epoch == firstStart.providerEpoch, "the event carries the immutable provider epoch")
    } else {
      expect(false, "the authenticated event is reported")
    }
    expect(exchanges.value == 1, "exactly one token exchange happens")
    expect(store.document?.credential != nil, "the claimed callback persists the credential")
    expect(firstListener.canceled == 1, "a claimed callback tears exactly its own listener down")
    expect(
      lifecycle.isCurrentAuthFlow(firstStart.generation) == false,
      "the claimed flow is no longer current"
    )

    // A replay can never claim or end anything again.
    firstListener.valid(query)
    await settle()
    expect(events.count == 1, "a replayed callback reports nothing")
    expect(exchanges.value == 1, "a replayed callback performs no second exchange")

    // A *deferred* superseded flow: flow B reserves a new source. Flow A's late
    // ready/callback must open no browser, perform no provider work and never
    // cancel B, and A's promise is answered truthfully as canceled.
    let secondBox = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { secondBox.set($0) }
    )
    guard let secondListener = registry.at(1) else {
      expect(false, "the second listener is created")
      return
    }
    expect(firstBox.calls == 1, "the superseded flow's promise is answered exactly once")
    if case let .success(answered)? = firstBox.result {
      expect(
        answered.generation == firstStart.generation,
        "an already started flow is never re-answered by its supersession"
      )
    } else {
      expect(false, "an already started flow is never re-answered by its supersession")
    }
    expect(firstListener.canceled >= 1, "the superseded listener is torn down")

    // A's deferred ready is inert: no provider flow, no browser.
    let openedBeforeLateReady = opened.count
    firstListener.ready()
    browserQueue.drain()
    await settle()
    expect(
      opened.count == openedBeforeLateReady,
      "a deferred ready of a superseded flow opens no browser"
    )
    expect(secondBox.calls == 0, "a deferred ready of a superseded flow starts no second flow")

    secondListener.ready()
    browserQueue.drain()
    guard case let .success(secondStart)? = secondBox.result else {
      expect(false, "the current flow still starts from its own listener")
      return
    }
    expect(secondStart.generation != firstStart.generation, "every flow owns a fresh generation")
    expect(opened.count == openedBeforeLateReady + 1, "the current flow opens exactly one browser")

    // A late callback of the superseded flow performs zero provider work.
    let exchangesBefore = exchanges.value
    firstListener.valid(query)
    await settle()
    expect(
      exchanges.value == exchangesBefore,
      "a late callback of a superseded flow performs no exchange"
    )
    expect(events.count == 1, "a late callback of a superseded flow reports nothing")
    expect(secondListener.canceled == 0, "a late callback never cancels the newer listener")
    expect(
      lifecycle.isCurrentAuthFlow(secondStart.generation),
      "the newer flow survives the late callback"
    )

    // An explicit cancel invalidates exactly the current flow; a later callback
    // claims nothing and never reaches the provider.
    lifecycle.cancelAuth()
    expect(
      lifecycle.isCurrentAuthFlow(secondStart.generation) == false,
      "an explicit cancel invalidates the flow"
    )
    expect(secondListener.canceled >= 1, "an explicit cancel tears the listener down")
    secondListener.valid(query)
    await settle()
    expect(events.count == 1, "a callback after cancel reports nothing")
    expect(exchanges.value == exchangesBefore, "a callback after cancel never reaches the provider")

    // A fence invalidates the flow atomically and, with it, every deferred step:
    // a callback delivered afterwards is completely inert.
    let thirdBox = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { thirdBox.set($0) }
    )
    guard let thirdListener = registry.at(2) else {
      expect(false, "the third listener is created")
      return
    }
    thirdListener.ready()
    browserQueue.drain()
    guard case let .success(thirdStart)? = thirdBox.result else {
      expect(false, "the third flow starts")
      return
    }
    lifecycle.fence()
    expect(
      lifecycle.isCurrentAuthFlow(thirdStart.generation) == false,
      "a fence invalidates the current flow"
    )
    expect(thirdListener.canceled >= 1, "a fence tears the listener down")
    thirdListener.valid(query)
    await settle()
    expect(events.count == 1, "a callback after a fence reports nothing")
    expect(exchanges.value == exchangesBefore, "a callback after a fence performs no exchange")

    // A flow whose listener never reports `ready` is still answered truthfully
    // when a newer attempt supersedes it: no promise is ever left hanging.
    let pendingBox = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { pendingBox.set($0) }
    )
    expect(pendingBox.calls == 0, "a flow whose listener is not ready stays unanswered")
    let finalBox = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { finalBox.set($0) }
    )
    expect(pendingBox.calls == 1, "the superseded pending flow is answered exactly once")
    if case let .failure(pendingError)? = pendingBox.result {
      expect(
        pendingError == .authCanceled,
        "the superseded pending flow is answered as canceled"
      )
    } else {
      expect(false, "the superseded pending flow is answered as canceled")
    }
    if let pendingListener = registry.at(3) {
      expect(pendingListener.canceled >= 1, "the superseded pending listener is torn down")
    }
    registry.at(4)?.ready()
    browserQueue.drain()
    expect(finalBox.result != nil, "the newest attempt still starts")
    expect(registry.count == 5, "every attempt reserves exactly one listener")
  }

  // MARK: terminal auth delivery (module delivery seam)

  /// The *production* delivery path is exercised through a faithful reproduction
  /// of `VeyraNSIWCModule.emitAuthEvent`: the non-consuming
  /// `allowsAuthDelivery` pre-queue gate, then the consuming/linearizing
  /// `withAuthorizedAuthDelivery` primitive at the actual dispatch. A claimed
  /// success/failure therefore reaches JS exactly once even though the flow has
  /// already ended, while any source change before the dispatch drops the
  /// event. No harness-only permission facade is used — the grant *and* the
  /// one-time terminal-ticket consumption are decided by the production
  /// coordinator.
  static func terminalAuthDeliveryTests(key: (privateKey: SecKey, publicKey: SecKey)) async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)
    let signed = idToken(key: key, now: now)
    let tokenBody = """
      {"access_token":"access-1","refresh_token":"refresh-1","id_token":"\(signed)",\
      "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct",\
      "token_type":"Bearer"}
      """
    let query = ["code": "c", "state": abState, "client_id": "issued-client-abc"]

    func successHTTP() -> ScriptedHTTP {
      ScriptedHTTP { request in
        switch request.url {
        case VeyraNSIWC.tokenEndpoint:
          return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(tokenBody.utf8))
        case VeyraNSIWC.jwksEndpoint:
          return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: jwks)
        default:
          return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
        }
      }
    }
    func makeProvider(_ http: VeyraNSIWCTransport) -> VeyraNSIWCProvider {
      VeyraNSIWCProvider(
        store: SyntheticStore(), http: http, stream: ScriptedStream(), clock: clock, random: random
      )
    }
    func makeLifecycle(
      _ provider: VeyraNSIWCProvider, _ registry: ListenerRegistry, _ queue: ManualQueue
    ) -> VeyraNSIWCLifecycle {
      VeyraNSIWCLifecycle(
        providerFactory: { provider },
        listenerFactory: { registry.make() },
        openURL: { _, _ in },
        mainQueue: { queue.enqueue($0) }
      )
    }

    // --- 1. A verified success reaches JS exactly once through the seam ---
    let registryA = ListenerRegistry()
    let queueA = ManualQueue()
    let lifeA = makeLifecycle(makeProvider(successHTTP()), registryA, queueA)
    let seamA = AuthDeliverySeam(lifecycle: lifeA, mainQueue: { queueA.enqueue($0) })
    let boxA = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeA.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxA.set($0) })
    registryA.at(0)?.ready()
    queueA.drain()
    guard case let .success(startA)? = boxA.result else {
      expect(false, "the verified success flow starts")
      return
    }
    registryA.at(0)?.valid(query)
    expect(await waitUntil("the verified terminal event is queued") { queueA.count > 0 },
      "a claimed success queues its terminal delivery")
    queueA.drain()
    expect(seamA.delivered.count == 1, "a verified callback reaches JS exactly once")
    if case let .authenticated(subject, clientId, generation, owner, epoch)? = seamA.delivered.first {
      expect(subject == "chatgpt-user" && clientId == "issued-client-abc",
        "the delivered authenticated event is redacted and exact")
      expect(
        generation == startA.generation && owner == startA.ownerAccountId
          && epoch == startA.providerEpoch,
        "the delivered event correlates to the returned beginAuth source"
      )
    } else {
      expect(false, "the delivered event is an authenticated event")
    }
    expect(registryA.at(0)?.canceled == 1, "a claimed success tears its own listener down")

    // --- 2. A claimed failure reaches JS as exactly one authError ---
    let registryB = ListenerRegistry()
    let queueB = ManualQueue()
    let lifeB = makeLifecycle(makeProvider(successHTTP()), registryB, queueB)
    let seamB = AuthDeliverySeam(lifecycle: lifeB, mainQueue: { queueB.enqueue($0) })
    let boxB = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeB.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxB.set($0) })
    registryB.at(0)?.ready()
    queueB.drain()
    // A state-correlated provider error is a *claimed* failure (the flow is over).
    registryB.at(0)?.valid(["error": "access_denied", "state": abState, "client_id": "issued-client-abc"])
    expect(await waitUntil("the claimed failure is queued") { queueB.count > 0 },
      "a claimed failure queues its terminal delivery")
    queueB.drain()
    expect(seamB.delivered.count == 1, "a claimed failure reaches JS exactly once")
    if case let .authError(code, _, _, _)? = seamB.delivered.first {
      expect(code == VeyraNSIWCError.authCanceled.code,
        "the claimed failure is delivered as authError with its bounded code")
    } else {
      expect(false, "the claimed failure is delivered as authError")
    }

    // --- 3. An unclaimed callback keeps the listener alive and delivers 0 ---
    let registryC = ListenerRegistry()
    let queueC = ManualQueue()
    let lifeC = makeLifecycle(makeProvider(successHTTP()), registryC, queueC)
    let seamC = AuthDeliverySeam(lifecycle: lifeC, mainQueue: { queueC.enqueue($0) })
    let boxC = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeC.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxC.set($0) })
    registryC.at(0)?.ready()
    queueC.drain()
    guard case let .success(startC)? = boxC.result else {
      expect(false, "the unclaimed flow starts")
      return
    }
    registryC.at(0)?.valid(["code": "c", "state": "wrong"])
    await settle()
    queueC.drain()
    expect(seamC.delivered.isEmpty, "a wrong-state callback delivers nothing")
    expect(registryC.at(0)?.canceled == 0, "a wrong-state callback keeps the listener alive")
    expect(lifeC.isCurrentAuthFlow(startC.generation), "the flow stays current after an unclaimed callback")

    // --- 4. A queued terminal delivery superseded by a new auth flow is dropped
    //        at the main-queue dispatch (the ticket is revoked) ---
    registryC.at(0)?.valid(query)
    expect(await waitUntil("flow C's terminal event is queued") { queueC.count > 0 },
      "flow C queues its terminal delivery")
    let boxD = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeC.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxD.set($0) })
    queueC.drain()
    expect(seamC.delivered.isEmpty,
      "a terminal delivery superseded by a new auth flow is dropped at dispatch")

    // The replacement flow still delivers its own terminal event.
    registryC.at(1)?.ready()
    queueC.drain()
    registryC.at(1)?.valid(query)
    expect(await waitUntil("the replacement terminal event is queued") { queueC.count > 0 },
      "the replacement flow queues its terminal delivery")
    queueC.drain()
    expect(seamC.delivered.count == 1,
      "the replacement flow still delivers exactly its own terminal event")

    // --- 5. A queued terminal delivery superseded by a fence is dropped ---
    let registryE = ListenerRegistry()
    let queueE = ManualQueue()
    let lifeE = makeLifecycle(makeProvider(successHTTP()), registryE, queueE)
    let seamE = AuthDeliverySeam(lifecycle: lifeE, mainQueue: { queueE.enqueue($0) })
    let boxE = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeE.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxE.set($0) })
    registryE.at(0)?.ready()
    queueE.drain()
    registryE.at(0)?.valid(query)
    expect(await waitUntil("flow E's terminal event is queued") { queueE.count > 0 },
      "flow E queues its terminal delivery")
    lifeE.fence()
    queueE.drain()
    expect(seamE.delivered.isEmpty, "a terminal delivery superseded by a fence is dropped at dispatch")
  }

  // MARK: terminal delivery linearization (the single production primitive)

  /// The one consuming production primitive (`withAuthorizedAuthDelivery`) — the
  /// exact method the module's main-queue dispatch calls — is driven directly and
  /// through the module-faithful seam. A duplicate queued terminal event is
  /// delivered exactly once (the ticket is consumed inside the critical
  /// section), a fence that wins before the check refuses the event without ever
  /// invoking the body, a fence that loses blocks until the delivery returns
  /// (dispatch-wins, a real `DispatchSemaphore` barrier), and a still-current
  /// nonterminal event stays retryable.
  static func authDeliveryLinearizationTests(key: (privateKey: SecKey, publicKey: SecKey)) async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)
    let signed = idToken(key: key, now: now)
    let tokenBody = """
      {"access_token":"access-1","refresh_token":"refresh-1","id_token":"\(signed)",\
      "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct",\
      "token_type":"Bearer"}
      """
    let query = ["code": "c", "state": abState, "client_id": "issued-client-abc"]

    func successHTTP() -> ScriptedHTTP {
      ScriptedHTTP { request in
        switch request.url {
        case VeyraNSIWC.tokenEndpoint:
          return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(tokenBody.utf8))
        case VeyraNSIWC.jwksEndpoint:
          return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: jwks)
        default:
          return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
        }
      }
    }
    func makeProvider(_ http: VeyraNSIWCTransport) -> VeyraNSIWCProvider {
      VeyraNSIWCProvider(
        store: SyntheticStore(), http: http, stream: ScriptedStream(), clock: clock, random: random
      )
    }
    func makeLifecycle(
      _ provider: VeyraNSIWCProvider, _ registry: ListenerRegistry, _ queue: ManualQueue
    ) -> VeyraNSIWCLifecycle {
      VeyraNSIWCLifecycle(
        providerFactory: { provider },
        listenerFactory: { registry.make() },
        openURL: { _, _ in },
        mainQueue: { queue.enqueue($0) }
      )
    }

    // --- A. A duplicate queued terminal event is delivered exactly once ---
    let registryA = ListenerRegistry()
    let queueA = ManualQueue()
    let lifeA = makeLifecycle(makeProvider(successHTTP()), registryA, queueA)
    let seamA = AuthDeliverySeam(lifecycle: lifeA, mainQueue: { queueA.enqueue($0) })
    let boxA = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeA.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxA.set($0) })
    registryA.at(0)?.ready()
    queueA.drain()
    guard case let .success(startA)? = boxA.result else {
      expect(false, "the duplicate-terminal flow starts")
      return
    }
    registryA.at(0)?.valid(query)
    expect(await waitUntil("the terminal event is queued") { queueA.count > 0 },
      "a claimed terminal event queues its delivery")
    let terminalA = VeyraNSIWCLifecycle.AuthEvent.authenticated(
      subject: "chatgpt-user", clientId: "issued-client-abc",
      generation: startA.generation, ownerAccountId: startA.ownerAccountId,
      providerEpoch: startA.providerEpoch
    )
    expect(lifeA.allowsAuthDelivery(terminalA),
      "the terminal ticket authorizes the identical event before dispatch")
    // The identical event is queued a second time before the main queue runs;
    // the pre-queue gate is non-consuming, so both dispatch hops are queued.
    seamA.queueAuthDelivery(terminalA)
    expect(queueA.count == 2, "the identical terminal event is queued twice")
    queueA.drain()
    expect(seamA.delivered.count == 1,
      "a duplicate queued terminal event is delivered exactly once")
    expect(seamA.delivered.first == terminalA, "the delivered terminal event is the exact event")
    expect(!lifeA.allowsAuthDelivery(terminalA),
      "the dispatch consumed the terminal ticket exactly once in the production coordinator")

    // --- B. A fence that wins before the check refuses the event ---
    let registryB = ListenerRegistry()
    let queueB = ManualQueue()
    let lifeB = makeLifecycle(makeProvider(successHTTP()), registryB, queueB)
    let seamB = AuthDeliverySeam(lifecycle: lifeB, mainQueue: { queueB.enqueue($0) })
    let boxB = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeB.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxB.set($0) })
    registryB.at(0)?.ready()
    queueB.drain()
    guard case let .success(startB)? = boxB.result else {
      expect(false, "the fence-wins flow starts")
      return
    }
    registryB.at(0)?.valid(query)
    expect(await waitUntil("flow B's terminal event is queued") { queueB.count > 0 },
      "flow B queues its terminal delivery")
    let terminalB = VeyraNSIWCLifecycle.AuthEvent.authenticated(
      subject: "chatgpt-user", clientId: "issued-client-abc",
      generation: startB.generation, ownerAccountId: startB.ownerAccountId,
      providerEpoch: startB.providerEpoch
    )
    lifeB.fence()
    var bodyRanB = false
    let acceptedB = lifeB.withAuthorizedAuthDelivery(terminalB) { bodyRanB = true }
    expect(!acceptedB && !bodyRanB,
      "a fence that wins before the check refuses the event and never invokes the body")
    queueB.drain()
    expect(seamB.delivered.isEmpty, "the superseded queued terminal event delivers nothing")

    // --- C. A dispatch that wins blocks a concurrent fence (real barrier) ---
    let registryC = ListenerRegistry()
    let queueC = ManualQueue()
    let lifeC = makeLifecycle(makeProvider(successHTTP()), registryC, queueC)
    let seamC = AuthDeliverySeam(lifecycle: lifeC, mainQueue: { queueC.enqueue($0) })
    let boxC = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeC.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxC.set($0) })
    registryC.at(0)?.ready()
    queueC.drain()
    guard case let .success(startC)? = boxC.result else {
      expect(false, "the dispatch-wins flow starts")
      return
    }
    registryC.at(0)?.valid(query)
    expect(await waitUntil("flow C's terminal event is queued") { queueC.count > 0 },
      "flow C queues its terminal delivery")
    let terminalC = VeyraNSIWCLifecycle.AuthEvent.authenticated(
      subject: "chatgpt-user", clientId: "issued-client-abc",
      generation: startC.generation, ownerAccountId: startC.ownerAccountId,
      providerEpoch: startC.providerEpoch
    )
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let fenceReturned = DispatchSemaphore(value: 0)
    let ranC = Counter()
    // Run the delivery off the test thread: it enters the body (holding the
    // lock) and blocks there.
    DispatchQueue.global().async {
      _ = lifeC.withAuthorizedAuthDelivery(terminalC) {
        ranC.increment()
        entered.signal()
        release.wait()
      }
    }
    expect(entered.wait(timeout: .now() + 3) == .success,
      "the terminal delivery body is entered under the coordinator lock")
    // A fence started now must *block* until the delivery body returns.
    DispatchQueue.global().async {
      lifeC.fence()
      fenceReturned.signal()
    }
    expect(fenceReturned.wait(timeout: .now() + 0.5) == .timedOut,
      "a fence blocks until the in-flight terminal delivery returns (check+deliver share one critical section)")
    release.signal()
    expect(fenceReturned.wait(timeout: .now() + 3) == .success,
      "the fence returns after the terminal delivery completes")
    expect(ranC.value == 1, "the terminal delivery ran (before the fence)")
    queueC.drain()
    expect(seamC.delivered.isEmpty,
      "the ticket was already consumed by the direct delivery, so the queued hop delivers nothing")

    // --- D. A still-current nonterminal event stays retryable (not consumed) ---
    let registryD = ListenerRegistry()
    let queueD = ManualQueue()
    let lifeD = makeLifecycle(makeProvider(successHTTP()), registryD, queueD)
    let boxD = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifeD.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxD.set($0) })
    registryD.at(0)?.ready()
    queueD.drain()
    guard case let .success(startD)? = boxD.result else {
      expect(false, "the retry flow starts")
      return
    }
    let nonterminal = VeyraNSIWCLifecycle.AuthEvent.authError(
      code: VeyraNSIWCError.authCanceled.code, generation: startD.generation,
      ownerAccountId: startD.ownerAccountId, providerEpoch: startD.providerEpoch
    )
    let runsD = Counter()
    expect(lifeD.withAuthorizedAuthDelivery(nonterminal) { runsD.increment() },
      "a still-current started flow authorizes a nonterminal event")
    expect(lifeD.withAuthorizedAuthDelivery(nonterminal) { runsD.increment() },
      "the same nonterminal current-flow event is still authorized on a retry")
    expect(runsD.value == 2, "a nonterminal current-flow event is delivered on every retry")
    expect(lifeD.isCurrentAuthFlow(startD.generation),
      "the started flow is preserved after a nonterminal delivery")
    var ranMismatch = false
    let refused = lifeD.withAuthorizedAuthDelivery(
      VeyraNSIWCLifecycle.AuthEvent.authError(
        code: "x", generation: startD.generation + 1,
        ownerAccountId: startD.ownerAccountId, providerEpoch: startD.providerEpoch
      )
    ) { ranMismatch = true }
    expect(!refused && !ranMismatch,
      "a mismatched generation is refused and the body is never invoked")
  }

  // MARK: browser linearization

  /// The exact-source + provider-epoch check and the system-opener invocation
  /// share one critical section: a concurrently-started fence must **block** until
  /// the opener returns (open-wins), and a fence that wins before the hop runs
  /// opens nothing (fence-wins). This is a real barrier, not a predicate check.
  static func browserLinearizationTests() {
    func makeLifecycle(
      _ registry: ListenerRegistry, _ queue: ManualQueue,
      opener: @escaping (URL, @escaping (Bool) -> Void) -> Void
    ) -> VeyraNSIWCLifecycle {
      let provider = VeyraNSIWCProvider(
        store: SyntheticStore(), http: RecordingHTTP(), stream: ScriptedStream(),
        clock: FixedClock(date: Date(timeIntervalSince1970: 1_700_000_000)),
        random: FixedRandom(byte: 0xAB)
      )
      return VeyraNSIWCLifecycle(
        providerFactory: { provider },
        listenerFactory: { registry.make() },
        openURL: opener,
        mainQueue: { queue.enqueue($0) }
      )
    }

    // --- open-wins: the opener runs inside the critical section ---
    let registry = ListenerRegistry()
    let queue = ManualQueue()
    let opened = Recorder()
    let openerEntered = DispatchSemaphore(value: 0)
    let releaseOpener = DispatchSemaphore(value: 0)
    let fenceReturned = DispatchSemaphore(value: 0)
    let lifecycle = makeLifecycle(registry, queue) { url, _ in
      opened.record(url.absoluteString)
      openerEntered.signal()
      releaseOpener.wait()
    }
    let box = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { box.set($0) })
    registry.at(0)?.ready()
    expect(queue.count == 1 && opened.count == 0, "the browser hop is deferred until the main queue runs")

    // Run the hop off the test thread: it enters the opener (holding the lock)
    // and blocks there.
    DispatchQueue.global().async { queue.drain() }
    expect(openerEntered.wait(timeout: .now() + 3) == .success, "the opener is entered")

    // A fence started now must *block* until the opener returns.
    DispatchQueue.global().async {
      lifecycle.fence()
      fenceReturned.signal()
    }
    expect(
      fenceReturned.wait(timeout: .now() + 0.5) == .timedOut,
      "a fence blocks until the in-flight open completes (check+open share one critical section)"
    )
    releaseOpener.signal()
    expect(fenceReturned.wait(timeout: .now() + 3) == .success, "the fence returns after the open completes")
    expect(opened.count == 1, "the opener is invoked exactly once")

    // --- fence-wins: a fence that lands before the hop opens nothing ---
    let registry2 = ListenerRegistry()
    let queue2 = ManualQueue()
    let opened2 = Recorder()
    let lifecycle2 = makeLifecycle(registry2, queue2) { url, _ in opened2.record(url.absoluteString) }
    let box2 = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle2.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { box2.set($0) })
    registry2.at(0)?.ready()
    lifecycle2.fence()
    queue2.drain()
    expect(opened2.count == 0, "a fence that wins before the hop opens no browser")
  }

  // MARK: callback server lifecycle (actual listener)

  /// The *actual* `VeyraNSIWCCallbackServer` is driven over a synthetic loopback
  /// connection. A cancel-before-start can never be revived, a cancel stops a
  /// live listener, and the production coordinator tears down an already-ready
  /// superseded listener. No real browser, provider or identity is involved.
  static func callbackServerLifecycleTests() {
    // --- cancel-before-start can never revive ---
    let first = VeyraNSIWCCallbackServer()
    let firstReady = Counter()
    first.onReady = { _ in firstReady.increment() }
    first.cancel()
    var refused = false
    do { try first.start(flowTTL: 5) } catch { refused = true }
    expect(refused, "a start after a cancel is refused")
    first.cancel()  // idempotent
    Thread.sleep(forTimeInterval: 0.2)
    expect(firstReady.value == 0, "a canceled-before-start server is never ready")

    // --- start-wins then cancel: the live listener stops accepting ---
    if let live = startRealServer(ttl: 5) {
      expect(canConnectLoopback(port: live.port), "a bound listener accepts a loopback connection")
      live.server.cancel()
      expect(waitSync(3) { !canConnectLoopback(port: live.port) }, "cancel stops the live listener")
    } else {
      expect(false, "the actual callback server binds (start wins)")
    }

    // --- concurrent start ∥ cancel: the invariant holds in both orders ---
    for _ in 0..<8 {
      let server = VeyraNSIWCCallbackServer()
      let portBox = ResultBox<Int>()
      server.onReady = { portBox.set(.success($0)) }
      let group = DispatchGroup()
      group.enter()
      DispatchQueue.global().async {
        try? server.start(flowTTL: 5)
        group.leave()
      }
      DispatchQueue.global().async { server.cancel() }
      group.wait()
      server.cancel()
      Thread.sleep(forTimeInterval: 0.2)
      if case let .success(port)? = portBox.result {
        expect(
          !canConnectLoopback(port: port),
          "a concurrently-canceled server never leaves a live owned listener"
        )
      }
    }

    // --- the production coordinator tears down an already-ready superseded
    //     listener (the unconditional predecessor cancel) ---
    let provider = VeyraNSIWCProvider(
      store: SyntheticStore(), http: RecordingHTTP(), stream: ScriptedStream(),
      clock: FixedClock(date: Date(timeIntervalSince1970: 1_700_000_000)),
      random: FixedRandom(byte: 0xAB)
    )
    var realServers: [VeyraNSIWCCallbackServer] = []
    let queue = ManualQueue()
    let lifecycle = VeyraNSIWCLifecycle(
      providerFactory: { provider },
      listenerFactory: {
        let server = VeyraNSIWCCallbackServer()
        realServers.append(server)
        return server
      },
      openURL: { _, _ in },
      mainQueue: { queue.enqueue($0) }
    )
    let boxA = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxA.set($0) })
    expect(waitSync(3) { boxA.result != nil }, "the first real listener reports ready and starts")
    guard case let .success(payloadA)? = boxA.result else {
      expect(false, "the first real flow starts")
      return
    }
    queue.drain()
    expect(canConnectLoopback(port: payloadA.port), "the first real listener is live before supersession")

    let boxB = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(mode: .fresh, ownerAccountId: "notes-1", loginHint: nil, completion: { boxB.set($0) })
    expect(boxA.calls == 1, "the already-started superseded flow is not re-answered")
    expect(realServers.count == 2, "each attempt reserves exactly one real listener")
    expect(
      waitSync(3) { !canConnectLoopback(port: payloadA.port) },
      "the production coordinator tears down a superseded already-ready listener"
    )
  }

  // MARK: refresh races

  static func refreshRaceTests(key: (privateKey: SecKey, publicKey: SecKey)) async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)

    func persisted(access: String, refresh: String) -> VeyraNSIWCPersisted {
      VeyraNSIWCPersisted(
        hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
        registrations: [VeyraNSIWCRegistration(
          clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
        )],
        credential: VeyraNSIWCCredential(
          clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
          accessToken: access, refreshToken: refresh, idToken: "id",
          grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
          expiresAt: nil, providerEpoch: 0
        )
      )
    }
    let refreshedBody = """
      {"access_token":"access-2","refresh_token":"refresh-2",\
      "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct"}
      """

    // 1. A commit that is already inside the critical section when the fence
    //    lands completes *before* it; afterwards the stored credential is
    //    logically ineligible (a stale provider epoch) and nothing is written
    //    again.
    let barrier = BarrierStore(document: persisted(access: "access-1", refresh: "refresh-1"))
    let release = DispatchSemaphore(value: 0)
    let entered = DispatchSemaphore(value: 0)
    barrier.pauseNextSave = release
    barrier.saveStarted = entered
    let barrierProvider = VeyraNSIWCProvider(
      store: barrier,
      http: ScriptedHTTP { _ in
        VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(refreshedBody.utf8))
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    let commit = Task { try await barrierProvider.refresh(ownerAccountId: "notes-1", entry: methodEntry(barrierProvider, "notes-1")) }
    expect(entered.wait(timeout: .now() + 5) == .success, "the commit reaches its critical section")
    let fenced = DispatchSemaphore(value: 0)
    Thread {
      barrierProvider.fence()
      fenced.signal()
    }.start()
    release.signal()
    expect(fenced.wait(timeout: .now() + 5) == .success, "the fence completes after the commit")
    _ = try? await commit.value
    expect(barrier.saves == 1, "the pre-fence commit is the only write")
    expect(
      barrier.current?.credential?.accessToken == "access-2",
      "the commit that won the lock is the live one"
    )
    expect(
      barrier.current?.credential?.providerEpoch
        != barrierProvider.currentEpoch(),
      "a commit that won the lock before the fence is stored but logically ineligible"
    )

    // 2. A fence *before* the commit: an old flight that completes later writes
    //    nothing at all.
    let fenceFirst = BarrierStore(document: persisted(access: "access-1", refresh: "refresh-1"))
    let httpGate = Gate()
    let fenceFirstProvider = VeyraNSIWCProvider(
      store: fenceFirst,
      http: ScriptedHTTP { _ in
        httpGate.wait()
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(refreshedBody.utf8))
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    let oldFlight = Task { try? await fenceFirstProvider.refresh(ownerAccountId: "notes-1", entry: methodEntry(fenceFirstProvider, "notes-1")) }
    // Give the flight time to reach the transport, then fence and let the old
    // response arrive.
    try? await Task.sleep(nanoseconds: 30_000_000)
    fenceFirstProvider.fence()
    httpGate.open()
    _ = await oldFlight.value
    expect(fenceFirst.saves == 0, "a fenced flight performs zero store writes")
    expect(
      fenceFirst.current?.credential?.accessToken == "access-1",
      "a fenced flight preserves the old credential"
    )

    // 3. A delayed *failing* old refresh must not erase a credential written by
    //    a newer login.
    let racy = BarrierStore(document: persisted(access: "access-1", refresh: "refresh-1"))
    let failGate = Gate()
    let racyProvider = VeyraNSIWCProvider(
      store: racy,
      http: ScriptedHTTP { request in
        if request.url == VeyraNSIWC.tokenEndpoint {
          failGate.wait()
          throw VeyraNSIWCError.transportUnavailable
        }
        return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    let failingFlight = Task { try? await racyProvider.refresh(ownerAccountId: "notes-1", entry: methodEntry(racyProvider, "notes-1")) }
    try? await Task.sleep(nanoseconds: 30_000_000)
    racyProvider.fence()
    // A newer login for the same Notes account persists a *different* credential.
    let newCredential = VeyraNSIWCCredential(
      clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
      accessToken: "access-new", refreshToken: "refresh-new", idToken: "id",
      grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
      expiresAt: nil, providerEpoch: racyProvider.currentEpoch()
    )
    expect(
      racy.save(
        (racy.current ?? persisted(access: "access-1", refresh: "refresh-1"))
          .withCredential(newCredential)
      ),
      "the newer login persists a credential"
    )
    let savesBefore = racy.saves
    failGate.open()
    _ = await failingFlight.value
    expect(racy.saves == savesBefore, "the delayed old failure writes nothing")
    expect(
      racy.current?.credential?.accessToken == "access-new",
      "the delayed old failure cannot erase the newer credential"
    )

    // 4. A truthful persist failure: the previous item and the previous
    //    in-memory credential both survive.
    let failing = BarrierStore(document: persisted(access: "access-1", refresh: "refresh-1"))
    failing.failSave = true
    let failingProvider = VeyraNSIWCProvider(
      store: failing,
      http: ScriptedHTTP { _ in
        VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(refreshedBody.utf8))
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    do {
      _ = try await failingProvider.refresh(ownerAccountId: "notes-1", entry: methodEntry(failingProvider, "notes-1"))
      expect(false, "a failed persist is reported truthfully")
    } catch let error as VeyraNSIWCError {
      expect(error == .keychainFailure, "a failed persist is reported truthfully")
    } catch {
      expect(false, "a failed persist is reported truthfully")
    }
    expect(
      failingProvider.loadCredential(ownerAccountId: "notes-1", entry: methodEntry(failingProvider, "notes-1"))?.accessToken == "access-1",
      "a failed persist keeps the previous in-memory credential"
    )

    // 5. The fence unregisters the flight: a new eligible identity starts its
    //    own flight and is not answered with the old one's result.
    let flightStore = SyntheticStore(document: persisted(access: "access-1", refresh: "refresh-1"))
    let slowGate = Gate()
    let calls = Counter()
    let flightProvider = VeyraNSIWCProvider(
      store: flightStore,
      http: ScriptedHTTP { _ in
        calls.increment()
        slowGate.wait()
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(refreshedBody.utf8))
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    let first = Task { try? await flightProvider.refresh(ownerAccountId: "notes-1", entry: methodEntry(flightProvider, "notes-1")) }
    try? await Task.sleep(nanoseconds: 30_000_000)
    flightProvider.fence()
    slowGate.open()
    _ = await first.value
    let second = Task { try? await flightProvider.refresh(ownerAccountId: "notes-1", entry: methodEntry(flightProvider, "notes-1")) }
    try? await Task.sleep(nanoseconds: 30_000_000)
    slowGate.open()
    _ = await second.value
    expect(calls.value == 2, "a fenced flight is not re-used by the next refresh")
  }

  static func functionCall(
    name: String = "do_thing",
    arguments: String = "{}",
    caller: [String: Any]? = nil,
    missingNamespace: Bool = false
  ) -> VeyraNSIWCFunctionCall? {
    var item: [String: Any] = [
      "type": "function_call",
      "call_id": "call_1",
      "name": name,
      "arguments": arguments,
      "status": "completed"
    ]
    if !missingNamespace { item["namespace"] = "veyran" }
    if let caller { item["caller"] = caller }
    return VeyraNSIWCFunctionCall.parse(item, authorizedNames: ["do_thing"])
  }

  // MARK: refresh

  static func refreshTests() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let clock = FixedClock(date: now)
    let random = FixedRandom(byte: 0xAB)
    guard let key = makeRSAKey() else { return }
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)

    func makeStore() -> SyntheticStore {
      SyntheticStore(document: VeyraNSIWCPersisted(
        hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
        registrations: [VeyraNSIWCRegistration(
          clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
        )],
        credential: VeyraNSIWCCredential(
          clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
          accessToken: "access-1", refreshToken: "refresh-1", idToken: "old-id",
          grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
          expiresAt: nil, providerEpoch: 0
        )
      ))
    }

    // Single-flight: two concurrent refreshes make exactly one HTTP call.
    let counter = Counter()
    let store = makeStore()
    let provider = VeyraNSIWCProvider(
      store: store,
      http: ScriptedHTTP { request in
        counter.increment()
        try await Task.sleep(nanoseconds: 50_000_000)
        let body = #"{"access_token":"access-2","refresh_token":"refresh-2","scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct"}"#
        _ = request
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    async let first = try? provider.refresh(ownerAccountId: "notes-1", entry: methodEntry(provider, "notes-1"))
    async let second = try? provider.refresh(ownerAccountId: "notes-1", entry: methodEntry(provider, "notes-1"))
    let (a, b) = await (first, second)
    expect(a != nil && b != nil, "both concurrent refreshes resolve")
    expect(counter.value == 1, "refresh is single-flight (one HTTP call)")
    expect(store.document?.credential?.accessToken == "access-2", "rotated access token adopted")

    // A fence that lands during the refresh must abort it and preserve the old
    // credential.
    let abaStore = makeStore()
    let aba = VeyraNSIWCProvider(
      store: abaStore,
      http: ScriptedHTTP { _ in
        try await Task.sleep(nanoseconds: 100_000_000)
        let body = #"{"access_token":"access-3","refresh_token":"refresh-3","scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct"}"#
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(body.utf8))
      },
      stream: ScriptedStream(), clock: clock, random: random
    )
    let task = Task { try await aba.refresh(ownerAccountId: "notes-1", entry: methodEntry(aba, "notes-1")) }
    try? await Task.sleep(nanoseconds: 20_000_000)
    aba.fence()
    let outcome = try? await task.value
    expect(outcome == nil, "a fence during refresh aborts the refresh")
    expect(abaStore.document?.credential?.accessToken == "access-1", "fenced refresh preserves the old credential")

    // An ambiguous refresh (transport failure) clears the credential.
    let ambiguousStore = makeStore()
    let ambiguous = VeyraNSIWCProvider(
      store: ambiguousStore,
      http: ScriptedHTTP { _ in throw VeyraNSIWCError.transportUnavailable },
      stream: ScriptedStream(), clock: clock, random: random
    )
    let cleared = try? await ambiguous.refresh(ownerAccountId: "notes-1", entry: methodEntry(ambiguous, "notes-1"))
    expect(cleared == nil, "ambiguous refresh fails")
    expect(ambiguousStore.document?.credential == nil, "ambiguous refresh clears the credential")
    expect(ambiguousStore.document?.registrations.count == 1, "ambiguous refresh keeps registrations")

    _ = jwks
  }

  // MARK: catalog compatibility (official devkit projection)

  /// The official models projection carries bounded extra metadata at the root
  /// and on every row. Only `slug`/`display_name` are ever projected, a hidden
  /// row is skipped *before* any displayed-field validation, and an invalid
  /// *displayed* row still denies the whole document.
  static func catalogCompatibilityTests() {
    let metadataRich = Data("""
      {"object":"list","platform":"openai","models":[\
      {"slug":"gpt-5","display_name":"GPT-5","visibility":"list","id":"mdl_1",\
      "created":1700000000,"owned_by":"openai","permissions":[{"id":"perm_1"}]},\
      {"slug":"gpt-5-mini","display_name":"GPT-5 mini","visibility":"list",\
      "context_window":400000,"description":"a mini model"}],\
      "has_more":false,"total":2}
      """.utf8)
    let catalog = VeyraNSIWCCatalog.parse(metadataRich)
    expect(catalog?.models.count == 2, "bounded extra metadata never fails the catalog")
    expect(
      catalog?.models.first?.slug == "gpt-5" && catalog?.models.last?.slug == "gpt-5-mini",
      "rows are kept in the server's order"
    )
    expect(
      catalog?.models.first?.displayName == "GPT-5",
      "only the projected display name is read from a metadata-rich row"
    )
    expect(catalog?.allows(slug: "gpt-5-mini") == true, "a projected row authorizes its slug")

    let hiddenIncomplete = Data("""
      {"models":[{"slug":"gpt-5","display_name":"GPT-5","visibility":"list"},\
      {"slug":"","visibility":"hidden","note":"internal"},\
      {"visibility":"hidden","slug":"not-projected"}],"extra":"bounded"}
      """.utf8)
    let filtered = VeyraNSIWCCatalog.parse(hiddenIncomplete)
    expect(filtered?.models.count == 1, "a hidden incomplete row is skipped before validation")
    expect(filtered?.allows(slug: "gpt-5") == true, "the displayed row survives a hidden incomplete row")

    // An invalid *displayed* (`visibility:"list"`) row denies the whole document
    // closed. A whitespace-only display name is empty after trimming and is
    // therefore denied too.
    let invalidDisplayed = [
      #"{"models":[{"display_name":"X","visibility":"list"}]}"#,
      #"{"models":[{"slug":"bad slug","display_name":"X","visibility":"list"}]}"#,
      #"{"models":[{"slug":"a","display_name":"","visibility":"list"}]}"#,
      #"{"models":[{"slug":"a","display_name":"   ","visibility":"list"}]}"#,
      #"{"models":[{"slug":"a","visibility":"list"}]}"#
    ]
    for (index, document) in invalidDisplayed.enumerated() {
      expect(
        VeyraNSIWCCatalog.parse(Data(document.utf8)) == nil,
        "an invalid displayed row denies the catalog (\(index))"
      )
    }

    // Every row whose visibility is not exactly the string `"list"` is skipped
    // *before* validation, exactly as the official devkit projects it: a missing
    // visibility, `null`, `{}` and a non-object row never fail the document, and
    // the genuinely displayed rows are still kept in server order.
    let mixedVisibility = Data("""
      {"models":["gpt-5",{"slug":"a","display_name":"X"},{},\
      {"slug":"hidden","display_name":"","visibility":"hidden"},\
      {"slug":"n","display_name":"N","visibility":null},\
      {"slug":"gpt-5","display_name":"GPT-5","visibility":"list"},\
      {"slug":"gpt-5-mini","display_name":"GPT-5 mini","visibility":"list"}]}
      """.utf8)
    let mixed = VeyraNSIWCCatalog.parse(mixedVisibility)
    expect(mixed?.models.count == 2, "a mixed document keeps only the visible rows")
    expect(
      mixed?.models.map(\.slug) == ["gpt-5", "gpt-5-mini"],
      "the visible rows keep the server's order across skipped rows"
    )

    // A missing/non-array `models`, an *undiscriminated* `data[]` array and a
    // non-object row are denied; duplicate *keys* are denied while duplicate rows
    // are not.
    expect(
      VeyraNSIWCCatalog.parse(Data(#"{"object":"list"}"#.utf8)) == nil,
      "a missing models array is denied"
    )
    expect(
      VeyraNSIWCCatalog.parse(Data(#"{"models":{"slug":"a"}}"#.utf8)) == nil,
      "a non-array models value is denied"
    )
    expect(
      VeyraNSIWCCatalog.parse(Data(#"{"data":[{"id":"gpt-5"}]}"#.utf8)) == nil,
      "an undiscriminated data[] array is denied"
    )
    expect(
      VeyraNSIWCCatalog.parse(Data(#"{"models":["gpt-5"]}"#.utf8))?.models.count == 0,
      "a non-object row is skipped, not denied"
    )
    let duplicateRow = Data(
      #"{"models":[{"slug":"a","display_name":"A","visibility":"list"},{"slug":"a","display_name":"A","visibility":"list"}]}"#.utf8
    )
    expect(VeyraNSIWCCatalog.parse(duplicateRow)?.models.count == 2, "duplicate rows are not duplicate keys")

    var manyRows = #"{"models":["#
    manyRows += (0..<513).map {
      #"{"slug":"m\#($0)","display_name":"M","visibility":"list"}"#
    }.joined(separator: ",")
    manyRows += "]}"
    expect(VeyraNSIWCCatalog.parse(Data(manyRows.utf8)) == nil, "more than 512 rows are denied")

    var unboundedRoot = #"{"models":[],"#
    unboundedRoot += (0..<40).map { #""k\#($0)":1"# }.joined(separator: ",") + "}"
    expect(
      VeyraNSIWCCatalog.parse(Data(unboundedRoot.utf8)) == nil,
      "unbounded root metadata is denied"
    )

    var unboundedRow = #"{"models":[{"slug":"a","display_name":"A","visibility":"list","#
    unboundedRow += (0..<40).map { #""k\#($0)":1"# }.joined(separator: ",") + "}]}"
    expect(
      VeyraNSIWCCatalog.parse(Data(unboundedRow.utf8)) == nil,
      "unbounded row metadata is denied"
    )

    let padding = String(repeating: "x", count: VeyraNSIWC.maxModelsBytes)
    let oversize = Data(#"{"models":[],"pad":"\#(padding)"}"#.utf8)
    expect(
      oversize.count > VeyraNSIWC.maxModelsBytes,
      "the oversize fixture really exceeds the byte bound"
    )
    expect(VeyraNSIWCCatalog.parse(oversize) == nil, "a catalog over the byte bound is denied")
  }

  // MARK: catalog — public API list envelope

  /// The *second* officially documented envelope of the same
  /// `GET https://api.openai.com/v1/models` request:
  /// `{ "object":"list", "data":[ { id, object:"model", created, owned_by,
  /// shutdown_date? } ] }`. The returned `id` is projected verbatim as both the
  /// slug and the display name, rows keep their server order, and every malformed
  /// or conflicting document fails closed. No prefix is filtered and no friendly
  /// name is ever invented.
  static func catalogAPIEnvelopeTests() {
    func parse(_ json: String) -> VeyraNSIWCCatalog? {
      VeyraNSIWCCatalog.parse(Data(json.utf8))
    }

    // A single well-formed row: the returned id is the slug *and* the display
    // name (faithful, never an invented friendly name or hardcoded model list).
    let good = parse(
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1700000000,"owned_by":"openai"}]}"#
    )
    expect(good?.models.count == 1, "a well-formed API list envelope is accepted")
    expect(good?.models.first?.slug == "gpt-4o", "the returned id is the slug")
    expect(
      good?.models.first?.displayName == "gpt-4o",
      "the returned id is the display name (no invented friendly name)"
    )
    expect(good?.allows(slug: "gpt-4o") == true, "the returned id authorizes its slug")

    // Bounded extra metadata at the root and on each row (including the optional
    // `shutdown_date` as both `null` and a string) is tolerated and ignored.
    let metadataRich = parse(
      #"{"object":"list","platform":"openai","has_more":false,"total":2,"data":["#
        + #"{"id":"gpt-4o","object":"model","created":1700000000,"owned_by":"openai","#
        + #""shutdown_date":null,"permissions":[{"id":"perm_1"}]},"#
        + #"{"id":"gpt-4o-mini","object":"model","created":1700000001,"owned_by":"openai","#
        + #""shutdown_date":"2027-01-01","description":"a mini model"}]}"#
    )
    expect(metadataRich?.models.count == 2, "bounded extra metadata never fails the API envelope")
    expect(
      metadataRich?.models.map(\.slug) == ["gpt-4o", "gpt-4o-mini"],
      "the API rows are kept in the server's order"
    )

    // An empty but valid list is a real, non-nil catalog with zero models.
    let empty = parse(#"{"object":"list","data":[]}"#)
    expect(empty != nil, "an empty valid API list is accepted (not refused)")
    expect(empty?.models.count == 0, "an empty valid API list has zero models")
    expect(empty?.allows(slug: "gpt-4o") == false, "an empty API list authorizes nothing")

    // No prefix filter and no hardcoded model list: every returned id is kept
    // verbatim, whatever its family.
    let heterogeneous = parse(
      #"{"object":"list","data":["#
        + #"{"id":"o3-mini","object":"model","created":1,"owned_by":"openai"},"#
        + #"{"id":"whisper-1","object":"model","created":2,"owned_by":"openai"},"#
        + #"{"id":"text-embedding-3-small","object":"model","created":3,"owned_by":"openai"},"#
        + #"{"id":"dall-e-3","object":"model","created":4,"owned_by":"openai"}]}"#
    )
    expect(
      heterogeneous?.models.map(\.slug)
        == ["o3-mini", "whisper-1", "text-embedding-3-small", "dall-e-3"],
      "no model family is filtered or reordered by prefix"
    )

    // ---- discriminator: only the exact documented envelope is accepted ----
    let discriminatorDenied = [
      #"{"data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai"}]}"#,
      #"{"object":"model","data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai"}]}"#,
      #"{"object":5,"data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai"}]}"#,
      #"{"object":null,"data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":{"id":"gpt-4o"}}"#,
      #"{"object":"list","data":"gpt-4o"}"#
    ]
    for (index, document) in discriminatorDenied.enumerated() {
      expect(parse(document) == nil, "a wrong API discriminator is denied (\(index))")
    }

    // ---- mixed / conflicting envelopes fail closed ----
    let mixedDenied = [
      // models and data together, with and without object:"list"
      #"{"models":[{"slug":"a","display_name":"A","visibility":"list"}],"data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai"}]}"#,
      #"{"object":"list","models":[{"slug":"a","display_name":"A","visibility":"list"}],"data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai"}]}"#,
      // an empty models array still selects the SIWC branch, so data conflicts
      #"{"models":[],"data":[]}"#
    ]
    for (index, document) in mixedDenied.enumerated() {
      expect(parse(document) == nil, "mixed models+data envelopes fail closed (\(index))")
    }

    // ---- malformed rows fail the whole document ----
    let malformedRows = [
      #"{"object":"list","data":[{"object":"model","created":1,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","created":1,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"list","created":1,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai"},42]}"#,
      // invalid returned identifiers
      #"{"object":"list","data":[{"id":"","object":"model","created":1,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"has space","object":"model","created":1,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"café","object":"model","created":1,"owned_by":"openai"}]}"#,
      // empty / whitespace-only owned_by
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":""}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"   "}]}"#,
      // duplicate ids within one list envelope
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai"},{"id":"gpt-4o","object":"model","created":2,"owned_by":"openai"}]}"#
    ]
    for (index, document) in malformedRows.enumerated() {
      expect(parse(document) == nil, "a malformed API row fails the document (\(index))")
    }

    // ---- `created` must be a valid non-negative integer, never a bool ----
    let badCreated = [
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":true,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":false,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1.5,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":-1,"owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":"1700000000","owned_by":"openai"}]}"#,
      #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":9007199254740992,"owned_by":"openai"}]}"#
    ]
    for (index, document) in badCreated.enumerated() {
      expect(parse(document) == nil, "an invalid API created value is denied (\(index))")
    }

    // An id / owned_by beyond the field bound is denied.
    let longToken = String(repeating: "a", count: 201)
    expect(
      parse(
        #"{"object":"list","data":[{"id":"\#(longToken)","object":"model","created":1,"owned_by":"openai"}]}"#
      ) == nil,
      "a returned id over the field bound is denied"
    )
    expect(
      parse(
        #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"\#(longToken)"}]}"#
      ) == nil,
      "an owned_by over the field bound is denied"
    )

    // ---- bounds are enforced inside the API branch too ----
    var manyRows = #"{"object":"list","data":["#
    manyRows += (0..<513).map {
      #"{"id":"m\#($0)","object":"model","created":1,"owned_by":"openai"}"#
    }.joined(separator: ",")
    manyRows += "]}"
    expect(parse(manyRows) == nil, "more than 512 API rows are denied")

    var unboundedRoot = #"{"object":"list","data":[],"#
    unboundedRoot += (0..<40).map { #""k\#($0)":1"# }.joined(separator: ",") + "}"
    expect(parse(unboundedRoot) == nil, "unbounded API root metadata is denied")

    var unboundedRow = #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1,"owned_by":"openai","#
    unboundedRow += (0..<40).map { #""k\#($0)":1"# }.joined(separator: ",") + "}]}"
    expect(parse(unboundedRow) == nil, "unbounded API row metadata is denied")

    let padding = String(repeating: "x", count: VeyraNSIWC.maxModelsBytes)
    let oversize = Data(#"{"object":"list","data":[],"pad":"\#(padding)"}"#.utf8)
    expect(
      oversize.count > VeyraNSIWC.maxModelsBytes,
      "the oversize API fixture really exceeds the byte bound"
    )
    expect(VeyraNSIWCCatalog.parse(oversize) == nil, "an API catalog over the byte bound is denied")

    // Duplicate *keys* anywhere still fail the document closed.
    expect(
      parse(
        #"{"object":"list","data":[{"id":"a","id":"b","object":"model","created":1,"owned_by":"openai"}]}"#
      ) == nil,
      "duplicate keys in an API row fail the document"
    )
  }

  // MARK: catalog — provider reachability

  /// The public API list envelope is on the *product* path, not just a
  /// unit-reachable parser branch: `fetchModels` on a 200 response returns a
  /// catalog whose slug is the returned id. The credential/stores are synthetic.
  static func catalogProviderReachabilityTests() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let apiBody = #"{"object":"list","data":[{"id":"gpt-4o","object":"model","created":1700000000,"owned_by":"openai"}]}"#
    let http = ScriptedHTTP { request in
      if request.url == VeyraNSIWC.modelsEndpoint {
        return VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data(apiBody.utf8))
      }
      return VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
    }
    let credential = VeyraNSIWCCredential(
      clientId: "issued-client-abc",
      subject: "chatgpt-user",
      ownerAccountId: "notes-1",
      accessToken: "access",
      refreshToken: "refresh",
      idToken: "id",
      grantedScopes: VeyraNSIWC.requiredDirectScopes,
      expiresAt: nil,
      providerEpoch: 0
    )
    let store = SyntheticStore(
      document: VeyraNSIWCPersisted(
        hostURN: canonicalPersistedHost,
        registrations: [],
        credential: credential
      )
    )
    let provider = VeyraNSIWCProvider(
      store: store, http: http, stream: ScriptedStream(),
      clock: FixedClock(date: now), random: FixedRandom(byte: 0xAB)
    )
    do {
      let catalog = try await provider.fetchModels(
        ownerAccountId: "notes-1", entry: methodEntry(provider, "notes-1")
      )
      expect(catalog.allows(slug: "gpt-4o"), "fetchModels accepts the public API list envelope")
      expect(
        catalog.models.first?.displayName == "gpt-4o",
        "the fetched model keeps the returned id as its display name"
      )
    } catch {
      expect(false, "fetchModels accepts the public API list envelope (threw \(error))")
    }
  }

  // MARK: prepared-callback ownership

  /// A sealed prepared ticket whose claim was disowned *before* `finishCallback`
  /// runs — by a cancel, a new begin or a fence — must perform zero exchange
  /// requests, zero JWKS work and zero store writes. This also covers a cancel
  /// that supersedes the claim while the exchange is already in flight. Every
  /// token/credential value here is synthetic; no real Keychain or network is
  /// touched.
  static func preparedCallbackOwnershipTests(key: (privateKey: SecKey, publicKey: SecKey)) async {
    let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)
    let signed = idToken(key: key, now: t0)
    let tokenBody = """
      {"access_token":"access-1","refresh_token":"refresh-1","id_token":"\(signed)",\
      "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct",\
      "token_type":"Bearer"}
      """
    let state = abState

    func makeEnv() -> (store: SyntheticStore, http: GatedHTTP, provider: VeyraNSIWCProvider) {
      let http = GatedHTTP()
      http.responses[VeyraNSIWC.tokenEndpoint] = VeyraNSIWCHTTPResponse(
        status: 200, headers: [:], body: Data(tokenBody.utf8)
      )
      http.responses[VeyraNSIWC.jwksEndpoint] = VeyraNSIWCHTTPResponse(
        status: 200, headers: [:], body: jwks
      )
      let store = SyntheticStore()
      let provider = VeyraNSIWCProvider(
        store: store, http: http, stream: ScriptedStream(), clock: ManualClock(t0),
        random: FixedRandom(byte: 0xAB)
      )
      return (store, http, provider)
    }

    /// Begin one fresh flow and admit its callback, returning the sealed ticket.
    func prepare(provider: VeyraNSIWCProvider) -> VeyraNSIWCPreparedCallback? {
      _ = try? provider.beginAuth(
        mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil,
        entry: methodEntry(provider, "notes-1")
      )
      guard case let .admitted(ticket) = provider.prepareCallback(
        query: ["code": "c", "state": state, "client_id": "issued-client-abc"],
        port: 49152, ownerAccountId: "notes-1", entry: methodEntry(provider, "notes-1")
      ) else { return nil }
      return ticket
    }

    func writes(_ store: SyntheticStore) -> Int { store.saveCount + store.createCount }

    // ---- A. prepare -> cancel -> finish performs nothing ----
    let a = makeEnv()
    guard let ticketA = prepare(provider: a.provider) else {
      expect(false, "A: the callback is admitted")
      return
    }
    let writesA = writes(a.store)
    a.provider.cancelFlow(entry: methodEntry(a.provider, "notes-1"))
    let resultA = await a.provider.finishCallback(ticketA)
    expect(
      resultA.claimed && resultA.credential == nil && resultA.failure == .accountChanged,
      "A: a canceled prepared ticket is refused as account_changed"
    )
    expect(a.http.count == 0, "A: a canceled prepared ticket performs zero exchange requests")
    expect(writes(a.store) == writesA, "A: a canceled prepared ticket performs zero new store writes")
    expect(a.store.document?.credential == nil, "A: a canceled prepared ticket persists no credential")

    // ---- B. prepare -> new begin -> finish performs nothing ----
    let b = makeEnv()
    guard let ticketB = prepare(provider: b.provider) else {
      expect(false, "B: the callback is admitted")
      return
    }
    let writesB = writes(b.store)
    _ = try? b.provider.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", port: 49153, loginHint: nil,
      entry: methodEntry(b.provider, "notes-1")
    )
    let resultB = await b.provider.finishCallback(ticketB)
    expect(
      resultB.claimed && resultB.credential == nil && resultB.failure == .accountChanged,
      "B: a superseded prepared ticket is refused as account_changed"
    )
    expect(b.http.count == 0, "B: a superseded prepared ticket performs zero exchange requests")
    expect(writes(b.store) == writesB, "B: a superseded prepared ticket performs zero new store writes")

    // ---- C. a cancel during the in-flight exchange stops it before JWKS ----
    let c = makeEnv()
    guard let ticketC = prepare(provider: c.provider) else {
      expect(false, "C: the callback is admitted")
      return
    }
    let gateC = DispatchSemaphore(value: 0)
    c.http.gate = gateC
    c.http.gatedURL = VeyraNSIWC.tokenEndpoint
    let writesC = writes(c.store)
    let taskC = Task { await c.provider.finishCallback(ticketC) }
    expect(
      await waitUntil("C: the exchange is in flight") { c.http.count == 1 },
      "C: the owned ticket reaches the gated exchange"
    )
    c.provider.cancelFlow(entry: methodEntry(c.provider, "notes-1"))
    gateC.signal()
    let resultC = await taskC.value
    expect(
      resultC.claimed && resultC.credential == nil && resultC.failure == .accountChanged,
      "C: a claim canceled mid-exchange is refused as account_changed"
    )
    expect(
      !c.http.urls.contains(VeyraNSIWC.jwksEndpoint),
      "C: no JWKS request is made after the claim is lost"
    )
    expect(c.http.count == 1, "C: exactly the one gated exchange was attempted")
    expect(writes(c.store) == writesC, "C: no credential is committed after the claim is lost")
    expect(c.store.document?.credential == nil, "C: the store holds no credential")
  }

  // MARK: typed Keychain store

  /// The production Keychain mapping is driven through an injected Security API:
  /// only `errSecItemNotFound` is `missing`, a corrupt record is `invalid` and
  /// any other status is `unavailable`. No real Keychain is ever touched.
  static func typedStoreTests() async {
    let missing = VeyraNSIWCKeychain.load(api: ScriptedSecAPI(errSecItemNotFound))
    expect(missing == .missing, "errSecItemNotFound is the only missing outcome")
    expect(
      VeyraNSIWCKeychain.load(api: ScriptedSecAPI(errSecNotAvailable)) == .unavailable,
      "an unavailable Keychain is never reported as missing"
    )
    expect(
      VeyraNSIWCKeychain.load(api: ScriptedSecAPI(errSecInteractionNotAllowed)) == .unavailable,
      "a locked record is unavailable, not missing"
    )
    expect(
      VeyraNSIWCKeychain.load(api: ScriptedSecAPI(errSecAuthFailed)) == .unavailable,
      "an authorization failure is unavailable, not missing"
    )
    expect(
      VeyraNSIWCKeychain.load(api: ScriptedSecAPI(errSecSuccess)) == .invalid,
      "a success without a value is invalid"
    )
    expect(
      VeyraNSIWCKeychain.load(api: ScriptedSecAPI(errSecSuccess, data: Data("not json".utf8)))
        == .invalid,
      "an unparseable record is invalid, not missing"
    )
    let document = VeyraNSIWCPersisted.empty(
      hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000"
    )
    guard let bytes = document.serialized() else {
      expect(false, "the fixture document serializes")
      return
    }
    expect(
      VeyraNSIWCKeychain.load(api: ScriptedSecAPI(errSecSuccess, data: bytes)) == .loaded(document),
      "a valid record loads its exact document"
    )

    // The exact production query is asserted, not a test-only variant.
    let queryAPI = ScriptedSecAPI(errSecItemNotFound)
    _ = VeyraNSIWCKeychain.load(api: queryAPI)
    let query = queryAPI.queries.first ?? [:]
    expect(
      query[kSecReturnData as String] as? Bool == true,
      "the read asks for the value data"
    )
    expect(
      query[kSecMatchLimit as String] as? String == (kSecMatchLimitOne as String),
      "the read matches exactly one item"
    )
    expect(
      query[kSecUseDataProtectionKeychain as String] as? Bool == true,
      "the read uses the data-protection keychain"
    )
    expect(
      query[kSecAttrSynchronizable as String] as? Bool == false,
      "the read stays non-synchronizable"
    )
    expect(
      query[kSecAttrAccessGroup as String] == nil,
      "the read requests no explicit access group (the entitled default group is used)"
    )
    expect(
      query[kSecAttrService as String] as? String == VeyraNSIWC.keychainService
        && query[kSecAttrAccount as String] as? String == VeyraNSIWC.keychainAccount,
      "the read pins the SIWC service and account"
    )

    // create-if-absent writes the exact production dictionary and never updates.
    let created = ScriptedSecAPI(errSecSuccess)
    expect(
      VeyraNSIWCKeychain.createIfAbsent(document, api: created) == .created,
      "a fresh record is created"
    )
    let createdDictionary = created.addDictionary ?? [:]
    expect(
      createdDictionary[kSecValueData as String] as? Data == bytes,
      "the create writes the document bytes"
    )
    expect(
      createdDictionary[kSecAttrAccessible as String] as? String
        == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
      "the create keeps WhenUnlockedThisDeviceOnly"
    )
    expect(
      createdDictionary[kSecUseDataProtectionKeychain as String] as? Bool == true
        && createdDictionary[kSecAttrSynchronizable as String] as? Bool == false,
      "the create keeps the data-protection keychain and synchronizable:false"
    )

    // The production *update* path writes exactly the item attributes (never the
    // data-protection option) into the entitled default-group query.
    let saveAPI = ScriptedSecAPI(errSecSuccess)
    expect(VeyraNSIWCKeychain.save(document, api: saveAPI), "an existing record is updated")
    let updateDictionary = saveAPI.updateDictionary ?? [:]
    expect(
      updateDictionary[kSecValueData as String] as? Data == bytes
        && updateDictionary[kSecAttrAccessible as String] as? String
          == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
      "the update writes the value data and the accessible class"
    )
    expect(
      updateDictionary[kSecUseDataProtectionKeychain as String] == nil
        && updateDictionary.count == 2,
      "the update dictionary stays the exact item attributes"
    )
    expect(
      saveAPI.queries.first?[kSecAttrAccessGroup as String] == nil,
      "the update query keeps the entitled default access group"
    )

    let duplicate = ScriptedSecAPI([errSecDuplicateItem, errSecSuccess], data: bytes)
    expect(
      VeyraNSIWCKeychain.createIfAbsent(document, api: duplicate) == .existing(document),
      "a concurrent record is read back, never overwritten"
    )
    expect(duplicate.updateDictionary == nil, "create-if-absent never issues an update")
    expect(
      VeyraNSIWCKeychain.createIfAbsent(
        document, api: ScriptedSecAPI([errSecDuplicateItem, errSecSuccess], data: Data("corrupt".utf8))
      ) == .duplicateUnreadable,
      "an unreadable concurrent record fails closed"
    )
    expect(
      VeyraNSIWCKeychain.createIfAbsent(
        document, api: ScriptedSecAPI([errSecDuplicateItem, errSecItemNotFound])
      ) == .failed,
      "a raced-away record is never overwritten blindly"
    )
    expect(
      VeyraNSIWCKeychain.createIfAbsent(document, api: ScriptedSecAPI(errSecNotAvailable)) == .failed,
      "a refused create fails"
    )

    // ---- provider behaviour under the typed store contract ----------------
    let clock = FixedClock(date: Date(timeIntervalSince1970: 1_700_000_000))
    let random = FixedRandom(byte: 0xAB)

    func credential(access: String, refresh: String) -> VeyraNSIWCCredential {
      VeyraNSIWCCredential(
        clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
        accessToken: access, refreshToken: refresh, idToken: "id",
        grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
        expiresAt: nil, providerEpoch: 0
      )
    }

    func persisted(access: String, refresh: String) -> VeyraNSIWCPersisted {
      VeyraNSIWCPersisted(
        hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
        registrations: [VeyraNSIWCRegistration(
          clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
        )],
        credential: credential(access: access, refresh: refresh)
      )
    }

    // A corrupt record is a hard failure, never "no document": it is neither
    // initialized over nor overwritten, and no host is generated.
    let corrupt = ScriptedStore(reads: [.invalid])
    let corruptHTTP = RecordingHTTP()
    let corruptRandom = CountingRandom()
    let corruptProvider = VeyraNSIWCProvider(
      store: corrupt, http: corruptHTTP, stream: ScriptedStream(), clock: clock,
      random: corruptRandom
    )
    let corruptEntry = methodEntry(corruptProvider, "notes-1")
    expect(
      corruptProvider.credentialStatus(ownerAccountId: "notes-1", entry: corruptEntry)
        == .keychainFailure,
      "status reports keychain_failure for a corrupt record, never signedout"
    )
    do {
      _ = try corruptProvider.ensureHost(entry: corruptEntry)
      expect(false, "a corrupt record never yields a host")
    } catch let error as VeyraNSIWCError {
      expect(error == .keychainFailure, "a corrupt record surfaces as keychain_failure")
    } catch {
      expect(false, "a corrupt record surfaces as keychain_failure")
    }
    do {
      _ = try corruptProvider.beginAuth(
        mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil,
        entry: corruptEntry
      )
      expect(false, "a corrupt record never starts a flow")
    } catch let error as VeyraNSIWCError {
      expect(error == .keychainFailure, "beginAuth fails closed on a corrupt record")
    } catch {
      expect(false, "beginAuth fails closed on a corrupt record")
    }
    expect(
      corrupt.createCount == 0 && corrupt.saveCount == 0,
      "a corrupt record is never overwritten or initialized over"
    )
    expect(corruptHTTP.count == 0, "a corrupt record performs no request")
    expect(corruptRandom.calls == 0, "a corrupt record generates no new host material")

    // An unavailable store is retried and must then read the *original* record:
    // the failure is never cached as "missing".
    let original = persisted(access: "access-1", refresh: "refresh-1")
    let flaky = ScriptedStore(reads: [.unavailable, .loaded(original)])
    let flakyHTTP = RecordingHTTP()
    let flakyProvider = VeyraNSIWCProvider(
      store: flaky, http: flakyHTTP, stream: ScriptedStream(), clock: clock, random: random
    )
    expect(
      flakyProvider.credentialStatus(ownerAccountId: "notes-1", entry: methodEntry(flakyProvider, "notes-1"))
        == .keychainFailure,
      "an unreadable store is keychain_failure for that read"
    )
    switch flakyProvider.credentialStatus(
      ownerAccountId: "notes-1", entry: methodEntry(flakyProvider, "notes-1")
    ) {
    case let .ready(credential):
      expect(credential.accessToken == "access-1", "the retry reloads the original credential")
    default:
      expect(false, "the retry reloads the original credential")
    }
    expect(
      flakyProvider.persistedForRead()?.hostURN == original.hostURN,
      "the retry reloads the original host"
    )
    expect(
      flaky.createCount == 0 && flaky.saveCount == 0,
      "an unavailable store never writes"
    )
    expect(flakyHTTP.count == 0, "an unavailable store performs no request")

    // A missing record is the *only* state that initializes (create-if-absent),
    // and the created host is then stable.
    let fresh = ScriptedStore(reads: [.missing])
    let freshProvider = VeyraNSIWCProvider(
      store: fresh, http: RecordingHTTP(), stream: ScriptedStream(), clock: clock, random: random
    )
    let firstHost = try? freshProvider.ensureHost(entry: methodEntry(freshProvider, nil))
    expect(
      firstHost.map { VeyraNSIWCValidate.hostURN($0) } == true,
      "a missing record initializes exactly one own host"
    )
    expect(fresh.createCount == 1, "the host is created with create-if-absent")
    let secondHost = try? freshProvider.ensureHost(entry: methodEntry(freshProvider, nil))
    expect(secondHost == firstHost, "the stable host is reused")
    expect(fresh.createCount == 1, "a second ensureHost performs no second create")

    // A concurrent create is adopted, never overwritten.
    let concurrent = VeyraNSIWCPersisted.empty(
      hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000"
    )
    let raced = ScriptedStore(reads: [.missing])
    raced.creates = [.existing(concurrent)]
    let racedProvider = VeyraNSIWCProvider(
      store: raced, http: RecordingHTTP(), stream: ScriptedStream(), clock: clock, random: random
    )
    let racedHost = try? racedProvider.ensureHost(entry: methodEntry(racedProvider, nil))
    expect(racedHost == concurrent.hostURN, "a concurrent record's host is adopted")
    expect(
      racedProvider.persistedForRead()?.hostURN == concurrent.hostURN,
      "the concurrent record is adopted in memory"
    )
    expect(raced.saveCount == 0, "a concurrent record is never overwritten")

    let unreadableRace = ScriptedStore(reads: [.missing])
    unreadableRace.creates = [.duplicateUnreadable]
    let raceProvider = VeyraNSIWCProvider(
      store: unreadableRace, http: RecordingHTTP(), stream: ScriptedStream(),
      clock: clock, random: random
    )
    do {
      _ = try raceProvider.ensureHost(entry: methodEntry(raceProvider, nil))
      expect(false, "an unreadable concurrent record fails closed")
    } catch let error as VeyraNSIWCError {
      expect(error == .keychainFailure, "an unreadable concurrent record fails closed")
    } catch {
      expect(false, "an unreadable concurrent record fails closed")
    }
    expect(unreadableRace.saveCount == 0, "an unreadable concurrent record is never overwritten")

    // ---- legacy (urn:veyran) records: canonical in memory, zero writes ------
    // The production Keychain mapping reads a raw legacy record, canonicalizes
    // its host in memory, and performs no write.
    let legacyAPI = ScriptedSecAPI(errSecSuccess, data: Data(legacyPersistedJSON.utf8))
    expect(
      VeyraNSIWCKeychain.load(api: legacyAPI) == .loaded(
        VeyraNSIWCPersisted(
          hostURN: canonicalPersistedHost,
          registrations: [VeyraNSIWCRegistration(
            clientId: "issued-client", subject: "user-1", email: "a@b.com", createdAt: 1
          )],
          credential: VeyraNSIWCCredential(
            clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
            accessToken: "access", refreshToken: "refresh", idToken: "id",
            grantedScopes: ["openid"], expiresAt: 1000, providerEpoch: 0
          )
        )
      ),
      "a legacy Keychain record loads canonicalized in memory"
    )
    expect(
      legacyAPI.addDictionary == nil && legacyAPI.updateDictionary == nil,
      "loading a legacy record performs no write"
    )

    // A concurrent create that loses to a *legacy* record adopts it through the
    // store's parse: canonicalized, never overwritten.
    let raceLegacyAPI = ScriptedSecAPI(
      [errSecDuplicateItem, errSecSuccess], data: Data(legacyPersistedJSON.utf8)
    )
    let racedLegacyCreate = VeyraNSIWCKeychain.createIfAbsent(document, api: raceLegacyAPI)
    var racedLegacyHost: String?
    if case let .existing(adopted) = racedLegacyCreate { racedLegacyHost = adopted.hostURN }
    expect(
      racedLegacyHost == canonicalPersistedHost,
      "a concurrent legacy record is adopted canonicalized"
    )
    expect(raceLegacyAPI.updateDictionary == nil, "a concurrent legacy record is never overwritten")

    // ensureHost + a returning flow on a legacy-backed store: the canonical host
    // is used, no host is minted, and no write is ever performed.
    let legacyStore = SecBackedStore(
      ScriptedSecAPI(errSecSuccess, data: Data(legacyPersistedJSON.utf8))
    )
    let legacyRandom = CountingRandom()
    let legacyProvider = VeyraNSIWCProvider(
      store: legacyStore, http: RecordingHTTP(), stream: ScriptedStream(),
      clock: clock, random: legacyRandom
    )
    let legacyEntry = methodEntry(legacyProvider, "notes-1")
    expect(
      (try? legacyProvider.ensureHost(entry: legacyEntry)) == canonicalPersistedHost,
      "ensureHost returns the canonical host for a legacy record"
    )
    expect(legacyRandom.calls == 0, "no host is minted for a legacy record")
    do {
      let start = try legacyProvider.beginAuth(
        mode: .returning(clientId: "issued-client"), ownerAccountId: "notes-1",
        port: 49152, loginHint: nil, entry: legacyEntry
      )
      expect(
        start.authorizeURL.absoluteString.contains(
          "ext_agent_host_id=urn%3Auuid%3A123e4567-e89b-42d3-a456-426614174000"
        ),
        "a returning flow on a legacy record sends the canonical host"
      )
    } catch {
      expect(false, "beginAuth on a legacy record still starts")
    }
    expect(
      legacyStore.api.addDictionary == nil && legacyStore.api.updateDictionary == nil,
      "reading and starting a flow never re-save a normalized legacy record"
    )
    if case let .missingPermission(credential) = legacyProvider.credentialStatus(
      ownerAccountId: "notes-1", entry: methodEntry(legacyProvider, "notes-1")
    ) {
      expect(credential.refreshToken == "refresh", "the legacy credential is preserved on read")
    } else {
      expect(false, "the legacy credential is preserved on read")
    }
    expect(
      legacyStore.api.addDictionary == nil && legacyStore.api.updateDictionary == nil,
      "no read or flow start ever writes a normalized legacy record"
    )
  }

  // MARK: bounded transport

  /// The *production* request/response transport is driven with a synthetic
  /// `URLProtocol`: every bound is enforced before the bytes are retained, the
  /// caller's timeout is a hard absolute deadline, and an abort, truncation,
  /// redirect or cancellation is always a bounded failure. Nothing is dialed.
  static func transportTests() async {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ScriptedURLProtocol.self]
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.connectionProxyDictionary = [:]
    configuration.urlCache = nil
    let transport = VeyraNSIWCURLSessionTransport(configuration: configuration)
    let bounded = VeyraNSIWCURLSessionTransport(configuration: configuration, maxBytes: 64)

    func get(_ url: String, timeout: TimeInterval = 5) -> VeyraNSIWCHTTPRequest {
      VeyraNSIWCHTTPRequest(method: "GET", url: url, headers: [:], body: nil)
    }

    ScriptedURLProtocol.reset()
    var ok = ScriptedURLProtocol.Plan()
    ok.headers = ["Content-Type": "application/json"]
    ok.declaredLength = 13
    ok.chunks = [Data(#"{"models":[]}"#.utf8)]
    ScriptedURLProtocol.plan = ok
    let response = try? await transport.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
    expect(response?.status == 200, "a bounded response is surfaced with its exact status")
    expect(
      response.flatMap { String(data: $0.body, encoding: .utf8) } == #"{"models":[]}"#,
      "the bounded body is surfaced verbatim"
    )
    expect(ScriptedURLProtocol.requests.count == 1, "exactly one request is issued")
    expect(
      ScriptedURLProtocol.requests.first?.url?.absoluteString == VeyraNSIWC.modelsEndpoint,
      "only the fixed official URL is dialed"
    )

    ScriptedURLProtocol.reset()
    do {
      _ = try await transport.send(
        get("https://evil.example.com/v1/models"), timeout: 5
      )
      expect(false, "a non-official origin is refused")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "a non-official origin is refused")
    } catch {
      expect(false, "a non-official origin is refused")
    }
    expect(
      ScriptedURLProtocol.requests.isEmpty,
      "a refused origin is refused before any byte is written"
    )

    // The caller's timeout is the *hard* budget: a slow trickle that keeps the
    // inactivity timer alive is still aborted at the absolute deadline.
    ScriptedURLProtocol.reset()
    var trickle = ScriptedURLProtocol.Plan()
    trickle.chunkDelay = 0.15
    trickle.chunks = Array(repeating: Data([0x61]), count: 20)
    ScriptedURLProtocol.plan = trickle
    let started = Date()
    do {
      _ = try await transport.send(get(VeyraNSIWC.jwksEndpoint), timeout: 0.4)
      expect(false, "a slow trickle is aborted at the absolute deadline")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "a slow trickle is aborted at the absolute deadline")
    } catch {
      expect(false, "a slow trickle is aborted at the absolute deadline")
    }
    expect(
      Date().timeIntervalSince(started) < 2.5,
      "the deadline is absolute (20 chunks would need 3s of inactivity-free data)"
    )
    _ = await waitUntil("the aborted request is cancelled", timeout: 2) { ScriptedURLProtocol.stops >= 1 }
    expect(ScriptedURLProtocol.stops >= 1, "the aborted request is cancelled")

    // An oversize declared length aborts before the first chunk is retained.
    ScriptedURLProtocol.reset()
    var oversize = ScriptedURLProtocol.Plan()
    oversize.declaredLength = VeyraNSIWC.maxModelsBytes + 1
    ScriptedURLProtocol.plan = oversize
    do {
      _ = try await transport.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
      expect(false, "an oversize declared length is refused")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "an oversize declared length is refused")
    } catch {
      expect(false, "an oversize declared length is refused")
    }
    _ = await waitUntil("the oversize response is aborted, not buffered", timeout: 2) { ScriptedURLProtocol.stops >= 1 }
    expect(ScriptedURLProtocol.stops >= 1, "the oversize response is aborted, not buffered")

    // An oversize *header block* is refused before any body byte is retained
    // (a compressed response is bounded by the same decoded-chunk bound).
    ScriptedURLProtocol.reset()
    var hugeHeader = ScriptedURLProtocol.Plan()
    hugeHeader.headers = [
      "X-Oversize": String(repeating: "h", count: VeyraNSIWC.maxResponseHeaderBytes + 1)
    ]
    ScriptedURLProtocol.plan = hugeHeader
    do {
      _ = try await transport.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
      expect(false, "an oversize header block is refused")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "an oversize header block is refused")
    } catch {
      expect(false, "an oversize header block is refused")
    }
    expect(ScriptedURLProtocol.stops >= 1, "the oversize header block aborts the request")

    // With no declared length only the *streaming* bound can catch an oversize
    // body: the chunk is refused before it is retained.
    ScriptedURLProtocol.reset()
    var chunked = ScriptedURLProtocol.Plan()
    chunked.chunks = [
      Data(repeating: 0x62, count: 48), Data(repeating: 0x62, count: 48)
    ]
    ScriptedURLProtocol.plan = chunked
    do {
      _ = try await bounded.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
      expect(false, "an oversize chunk is refused before it is retained")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "an oversize chunk is refused before it is retained")
    } catch {
      expect(false, "an oversize chunk is refused before it is retained")
    }
    _ = await waitUntil("the oversize chunk aborts the request", timeout: 2) { ScriptedURLProtocol.stops >= 1 }
    expect(ScriptedURLProtocol.stops >= 1, "the oversize chunk aborts the request")

    // A truncated body (fewer bytes than declared) is never a success.
    ScriptedURLProtocol.reset()
    var truncated = ScriptedURLProtocol.Plan()
    truncated.declaredLength = 100
    truncated.chunks = [Data(repeating: 0x63, count: 10)]
    ScriptedURLProtocol.plan = truncated
    do {
      _ = try await transport.send(get(VeyraNSIWC.jwksEndpoint), timeout: 5)
      expect(false, "a truncated body is refused")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "a truncated body is refused")
    } catch {
      expect(false, "a truncated body is refused")
    }

    // A *content-encoded* (compressed) response declares its encoded wire length
    // in `Content-Length` while the delegate receives the decoded body, so a
    // smaller decoded body is a legitimate success. The decoded byte bound is
    // still enforced chunk-by-chunk.
    ScriptedURLProtocol.reset()
    var compressed = ScriptedURLProtocol.Plan()
    compressed.headers = ["Content-Encoding": "gzip"]
    compressed.declaredLength = 4096
    compressed.chunks = [Data(#"{"models":[]}"#.utf8)]
    ScriptedURLProtocol.plan = compressed
    let compressedResponse = try? await transport.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
    expect(
      compressedResponse.flatMap { String(data: $0.body, encoding: .utf8) } == #"{"models":[]}"#,
      "a decoded compressed body with a larger declared wire length succeeds"
    )

    // The identical declaration without a content encoding is still a truncation
    // failure (only an unencoded/identity body may be length-checked).
    ScriptedURLProtocol.reset()
    var identityTruncated = ScriptedURLProtocol.Plan()
    identityTruncated.declaredLength = 4096
    identityTruncated.chunks = [Data(#"{"models":[]}"#.utf8)]
    ScriptedURLProtocol.plan = identityTruncated
    do {
      _ = try await transport.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
      expect(false, "an identity body shorter than the declared length is refused")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "an identity body shorter than the declared length is refused")
    } catch {
      expect(false, "an identity body shorter than the declared length is refused")
    }

    // A compressed response whose *decoded* body exceeds the bound is still
    // refused: the decoded byte bound is always enforced.
    ScriptedURLProtocol.reset()
    var compressedOversize = ScriptedURLProtocol.Plan()
    compressedOversize.headers = ["Content-Encoding": "gzip"]
    compressedOversize.chunks = [
      Data(repeating: 0x62, count: 48), Data(repeating: 0x62, count: 48)
    ]
    ScriptedURLProtocol.plan = compressedOversize
    do {
      _ = try await bounded.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
      expect(false, "an oversize decoded compressed body is refused")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "an oversize decoded compressed body is refused")
    } catch {
      expect(false, "an oversize decoded compressed body is refused")
    }

    // A compressed *transport error* is still a failure (the content encoding
    // never excuses a dropped connection).
    ScriptedURLProtocol.reset()
    var compressedError = ScriptedURLProtocol.Plan()
    compressedError.headers = ["Content-Encoding": "gzip"]
    compressedError.chunks = [Data(repeating: 0x65, count: 4)]
    compressedError.failWith = URLError(.networkConnectionLost)
    ScriptedURLProtocol.plan = compressedError
    do {
      _ = try await transport.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
      expect(false, "a compressed transport error is a failure")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "a compressed transport error is a failure")
    } catch {
      expect(false, "a compressed transport error is a failure")
    }

    // A redirect is never followed: the 3xx itself is surfaced and the target is
    // never dialed.
    ScriptedURLProtocol.reset()
    var redirect = ScriptedURLProtocol.Plan()
    redirect.status = 302
    redirect.headers = ["Location": "https://evil.example.com/steal"]
    ScriptedURLProtocol.plan = redirect
    let redirectResponse = try? await transport.send(get(VeyraNSIWC.modelsEndpoint), timeout: 5)
    expect(redirectResponse?.status == 302, "a redirect is surfaced, not followed")
    expect(ScriptedURLProtocol.requests.count == 1, "a redirect never issues a second request")
    expect(
      ScriptedURLProtocol.requests.first?.url?.absoluteString != "https://evil.example.com/steal",
      "the redirect target is never dialed"
    )

    // A transport error inside the response is a bounded failure (never a
    // partial success), and the continuation is resumed exactly once (a second
    // resume would trap).
    ScriptedURLProtocol.reset()
    var failing = ScriptedURLProtocol.Plan()
    failing.chunks = [Data(repeating: 0x65, count: 4)]
    failing.failWith = URLError(.networkConnectionLost)
    ScriptedURLProtocol.plan = failing
    do {
      _ = try await bounded.send(get(VeyraNSIWC.jwksEndpoint), timeout: 5)
      expect(false, "a protocol error is a bounded failure")
    } catch let error as VeyraNSIWCError {
      expect(error == .transportUnavailable, "a protocol error is a bounded failure")
    } catch {
      expect(false, "a protocol error is a bounded failure")
    }

    // Cancelling the consuming task cancels the request and answers once.
    ScriptedURLProtocol.reset()
    var slow = ScriptedURLProtocol.Plan()
    slow.chunkDelay = 0.5
    slow.chunks = Array(repeating: Data([0x64]), count: 8)
    ScriptedURLProtocol.plan = slow
    let task = Task { () -> VeyraNSIWCError? in
      do {
        _ = try await bounded.send(get(VeyraNSIWC.discoveryEndpoint), timeout: 10)
        return nil
      } catch let error as VeyraNSIWCError {
        return error
      } catch {
        return .streamInvalid
      }
    }
    try? await Task.sleep(nanoseconds: 100_000_000)
    task.cancel()
    expect(
      await task.value == .transportUnavailable,
      "a cancelled request fails as a bounded transport failure"
    )
    _ = await waitUntil("a cancelled request stops the underlying task", timeout: 2) { ScriptedURLProtocol.stops >= 1 }
    expect(ScriptedURLProtocol.stops >= 1, "a cancelled request stops the underlying task")
  }

  // MARK: method-entry / deferred ownership

  /// A fence or a newer flow makes every *deferred* step inert: zero credential
  /// reads, zero stores, zero browser opens and zero requests — while the newer
  /// flow keeps its own listener, stream and credential.
  static func lifecycleOwnershipTests() async {
    let clock = FixedClock(date: Date(timeIntervalSince1970: 1_700_000_000))
    let random = FixedRandom(byte: 0xAB)

    func persisted(access: String, refresh: String) -> VeyraNSIWCPersisted {
      VeyraNSIWCPersisted(
        hostURN: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
        registrations: [VeyraNSIWCRegistration(
          clientId: "issued-client", subject: "user-1", email: nil, createdAt: 1
        )],
        credential: VeyraNSIWCCredential(
          clientId: "issued-client", subject: "user-1", ownerAccountId: "notes-1",
          accessToken: access, refreshToken: refresh, idToken: "id",
          grantedScopes: VeyraNSIWC.requiredDirectScopes + ["offline_access"],
          expiresAt: nil, providerEpoch: 0
        )
      )
    }

    // ---- a stale entry performs zero work ---------------------------------
    let store = ScriptedStore(current: persisted(access: "access-1", refresh: "refresh-1"))
    let http = RecordingHTTP()
    let provider = VeyraNSIWCProvider(
      store: store, http: http, stream: ScriptedStream(), clock: clock, random: random
    )
    let stale = methodEntry(provider, "notes-1")
    provider.fence()
    let readsBefore = store.loadCount

    expect(
      await capture {
        _ = try await provider.refresh(ownerAccountId: "notes-1", entry: stale)
      } == .accountChanged,
      "a deferred refresh with a stale entry is refused"
    )
    expect(store.loadCount == readsBefore, "a stale refresh performs zero credential reads")
    expect(store.saveCount == 0, "a stale refresh performs zero writes")
    expect(http.count == 0, "a stale refresh performs zero requests")

    expect(
      await capture {
        _ = try await provider.fetchModels(ownerAccountId: "notes-1", entry: stale)
      } == .accountChanged,
      "a deferred models read with a stale entry is refused"
    )
    expect(store.loadCount == readsBefore, "a stale models read performs zero credential reads")
    expect(http.count == 0, "a stale models read performs zero requests")

    expect(
      provider.credentialStatus(ownerAccountId: "notes-1", entry: stale) == .stale,
      "a stale status read is refused"
    )
    expect(store.loadCount == readsBefore, "a stale status read performs zero credential reads")

    let staleLogout = await provider.logoutDetailed(ownerAccountId: "notes-1", entry: stale)
    expect(
      staleLogout == VeyraNSIWCLogoutOutcome(
        cleared: false, revocationConfirmed: false, noActiveConnection: false
      ),
      "a stale logout reports nothing and confirms nothing"
    )
    expect(
      store.loadCount == readsBefore && store.saveCount == 0 && http.count == 0,
      "a stale logout performs zero reads, writes and requests"
    )
    expect(store.current?.credential?.accessToken == "access-1", "a stale logout clears nothing")

    expect(provider.clearCredential(entry: stale) == false, "a stale clear is refused")
    expect(store.saveCount == 0, "a stale clear performs zero writes")

    let staleCallback = await provider.completeCallback(
      query: ["code": "c", "state": abState, "client_id": "issued-client"],
      port: 49152, ownerAccountId: "notes-1", entry: stale
    )
    expect(staleCallback.claimed == false, "a stale callback claims nothing")

    expect(
      await capture {
        _ = try provider.beginAuth(
          mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil, entry: stale
        )
      } == .accountChanged,
      "a stale beginAuth is refused"
    )
    expect(store.createCount == 0, "a stale beginAuth creates no record")
    expect(http.count == 0, "a stale beginAuth performs zero requests")

    // ---- a deferred logout can never clear a newer login -------------------
    let logoutStore = ScriptedStore(current: persisted(access: "access-old", refresh: "refresh-old"))
    let logoutHTTP = RecordingHTTP()
    let logoutProvider = VeyraNSIWCProvider(
      store: logoutStore, http: logoutHTTP, stream: ScriptedStream(), clock: clock, random: random
    )
    let oldEntry = methodEntry(logoutProvider, "notes-1")
    logoutProvider.fence()
    expect(
      logoutStore.save(persisted(access: "access-new", refresh: "refresh-new")),
      "the newer login persists its credential"
    )
    let readsAfterLogin = logoutStore.loadCount
    let lateOutcome = await logoutProvider.logoutDetailed(
      ownerAccountId: "notes-1", entry: oldEntry
    )
    expect(
      lateOutcome == VeyraNSIWCLogoutOutcome(
        cleared: false, revocationConfirmed: false, noActiveConnection: false
      ),
      "a deferred logout never reports a clear it did not perform"
    )
    expect(logoutStore.loadCount == readsAfterLogin, "a deferred logout performs zero reads")
    expect(logoutStore.saveCount == 1, "a deferred logout performs zero writes")
    expect(logoutHTTP.count == 0, "a deferred logout performs zero requests")
    expect(
      logoutStore.current?.credential?.accessToken == "access-new",
      "a deferred logout never clears the newer credential"
    )

    // ---- an old flow's callback never claims a newer flow ------------------
    let flowStore = ScriptedStore(current: persisted(access: "access-1", refresh: "refresh-1"))
    let flowHTTP = RecordingHTTP()
    let flowProvider = VeyraNSIWCProvider(
      store: flowStore, http: flowHTTP, stream: ScriptedStream(), clock: clock, random: random
    )
    let oldFlow = methodEntry(flowProvider, "notes-1")
    _ = try? flowProvider.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil, entry: oldFlow
    )
    let newFlow = methodEntry(flowProvider, "notes-1")
    _ = try? flowProvider.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", port: 49153, loginHint: nil, entry: newFlow
    )
    let requestsBefore = flowHTTP.count
    let oldFlowCallback = await flowProvider.completeCallback(
      query: ["code": "c", "state": abState, "client_id": "issued-client"],
      port: 49152, ownerAccountId: "notes-1", entry: oldFlow
    )
    expect(oldFlowCallback.claimed == false, "an old flow's callback never claims the newer flow")
    expect(flowHTTP.count == requestsBefore, "an old flow's callback performs no exchange")

    // ---- a deferred browser hop after a fence opens nothing ----------------
    let browserStore = ScriptedStore()
    let browserProvider = VeyraNSIWCProvider(
      store: browserStore, http: RecordingHTTP(), stream: ScriptedStream(),
      clock: clock, random: random
    )
    let browserRegistry = ListenerRegistry()
    let browserQueue = ManualQueue()
    let opened = Recorder()
    let browserLifecycle = VeyraNSIWCLifecycle(
      providerFactory: { browserProvider },
      listenerFactory: { browserRegistry.make() },
      openURL: { url, _ in opened.record(url.absoluteString) },
      mainQueue: { browserQueue.enqueue($0) }
    )
    let browserBox = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    browserLifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { browserBox.set($0) }
    )
    browserRegistry.at(0)?.ready()
    expect(
      browserQueue.count == 1 && opened.count == 0,
      "the browser hop is deferred until the main queue runs"
    )
    browserLifecycle.fence()
    browserQueue.drain()
    expect(opened.count == 0, "a browser hop that runs after a fence opens nothing")
    expect(browserBox.calls == 1, "the fenced flow's promise is answered exactly once")

    // ---- an old deferred stream can never cancel the newer stream ----------
    let streamHTTP = RecordingHTTP()
    streamHTTP.response = VeyraNSIWCHTTPResponse(
      status: 200,
      headers: [:],
      body: Data(#"{"models":[{"slug":"gpt-5","display_name":"GPT-5","visibility":"list"}]}"#.utf8)
    )
    let streamGate = DispatchSemaphore(value: 0)
    streamHTTP.gate = streamGate
    streamHTTP.gatedURL = VeyraNSIWC.modelsEndpoint
    let streamTransport = ScriptedStream()
    streamTransport.chunks = [
      Data("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n".utf8)
    ]
    let streamStore = ScriptedStore(current: persisted(access: "access-1", refresh: "refresh-1"))
    let streamProvider = VeyraNSIWCProvider(
      store: streamStore, http: streamHTTP, stream: streamTransport, clock: clock, random: random
    )
    var emissions: [VeyraNSIWCStreamEmission] = []
    let streamLifecycle = VeyraNSIWCLifecycle(
      providerFactory: { streamProvider },
      listenerFactory: { ListenerRegistry().make() },
      openURL: { _, _ in },
      mainQueue: { $0() }
    )
    streamLifecycle.setStreamHandler { emissions.append($0) }

    let firstStream = ResultBox<VeyraNSIWCCompletedResponse>()
    streamLifecycle.streamInvoke(
      ownerAccountId: "notes-1", model: "gpt-5",
      input: [["role": "user"]], tools: nil, instructions: nil,
      requestId: "req-A", authorizedNames: [],
      completion: { firstStream.set($0) }
    )
    _ = await waitUntil("stream A is blocked inside its models request") {
      streamHTTP.count == 1
    }
    expect(streamHTTP.count == 1, "stream A issues exactly one models request")
    let secondStream = ResultBox<VeyraNSIWCCompletedResponse>()
    streamLifecycle.streamInvoke(
      ownerAccountId: "notes-1", model: "gpt-5",
      input: [["role": "user"]], tools: nil, instructions: nil,
      requestId: "req-B", authorizedNames: [],
      completion: { secondStream.set($0) }
    )
    _ = await waitUntil("stream B completes") { secondStream.result != nil }
    expect(secondStream.result != nil, "the newer stream completes while A is deferred")
    // A is released *after* B owns the stream: it must never supersede B.
    streamGate.signal()
    _ = await waitUntil("stream A is answered") { firstStream.result != nil }
    if case let .failure(firstError)? = firstStream.result {
      expect(firstError == .canceled, "a superseded deferred stream is answered as canceled")
    } else {
      expect(false, "a superseded deferred stream is answered as canceled")
    }
    expect(
      streamTransport.streamCount == 1,
      "a superseded deferred stream never reaches the streaming transport"
    )
    expect(secondStream.result != nil, "the newer stream stays untouched by the deferred older one")
    let emittedRequestIds = emissions.map { emission -> String in
      switch emission {
      case let .started(requestId, _): return requestId
      case let .delta(_, requestId, _): return requestId
      case let .functionCall(_, requestId, _): return requestId
      }
    }
    expect(
      !emittedRequestIds.isEmpty && emittedRequestIds.allSatisfy { $0 == "req-B" },
      "only the newer stream's emissions are surfaced"
    )
  }

  // MARK: shared flow TTL bound

  /// The one bounded 600s TTL is shared by the provider's pending-flow deadline
  /// and the loopback listener's own deadline, and the loopback origin/port
  /// contract is unchanged (no origin weakening).
  static func sharedLifetimeTests() {
    expect(VeyraNSIWC.flowTTLSeconds == 600, "the shared flow TTL bound is 600s")
    let clock = ManualClock(Date(timeIntervalSince1970: 1_700_000_000))
    let registry = ListenerRegistry()
    let queue = ManualQueue()
    let provider = VeyraNSIWCProvider(
      store: SyntheticStore(), http: GatedHTTP(), stream: ScriptedStream(),
      clock: clock, random: FixedRandom(byte: 0xAB)
    )
    let lifecycle = VeyraNSIWCLifecycle(
      providerFactory: { provider },
      listenerFactory: { registry.make() },
      openURL: { _, _ in },
      mainQueue: { queue.enqueue($0) }
    )
    let box = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { box.set($0) }
    )
    registry.at(0)?.ready()
    queue.drain()
    expect(
      registry.at(0)?.startTTLs == [VeyraNSIWC.flowTTLSeconds],
      "the listener is started with the one shared flow TTL (not a second bound)"
    )
    if case let .success(payload)? = box.result {
      expect(payload.port == 49152, "the flow still uses the loopback ephemeral port")
      expect(
        payload.redirectUri == "http://127.0.0.1:49152/auth/callback",
        "the redirect URI is the loopback literal + ephemeral port only"
      )
    } else {
      expect(false, "the shared-bound flow starts")
    }

    // The provider deadline is the exact same bound: a callback just inside it is
    // accepted and one exactly at it is refused.
    let providerClock = ManualClock(Date(timeIntervalSince1970: 1_700_000_000))
    let http = GatedHTTP()
    let store = SyntheticStore()
    let p = VeyraNSIWCProvider(
      store: store, http: http, stream: ScriptedStream(), clock: providerClock,
      random: FixedRandom(byte: 0xAB)
    )
    _ = try? p.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil,
      entry: methodEntry(p, "notes-1")
    )
    providerClock.advance(VeyraNSIWC.flowTTLSeconds - 1)
    let insideAdmission = p.prepareCallback(
      query: ["code": "c", "state": abState, "client_id": "issued-inside"],
      port: 49152, ownerAccountId: "notes-1", entry: methodEntry(p, "notes-1")
    )
    var insideAdmitted = false
    if case .admitted = insideAdmission { insideAdmitted = true }
    expect(insideAdmitted, "a callback one second inside the TTL is admitted")

    let p2 = VeyraNSIWCProvider(
      store: SyntheticStore(), http: GatedHTTP(), stream: ScriptedStream(),
      clock: providerClock, random: FixedRandom(byte: 0xAB)
    )
    providerClock.set(Date(timeIntervalSince1970: 1_700_000_000))
    _ = try? p2.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil,
      entry: methodEntry(p2, "notes-1")
    )
    providerClock.advance(VeyraNSIWC.flowTTLSeconds)
    var refusedExpired = false
    if case let .rejected(error) = p2.prepareCallback(
      query: ["code": "c", "state": abState, "client_id": "issued-late"],
      port: 49152, ownerAccountId: "notes-1", entry: methodEntry(p2, "notes-1")
    ), error == .flowExpired {
      refusedExpired = true
    }
    expect(refusedExpired, "a callback exactly at the TTL is refused as flow_expired")

    // Loopback origin contract unchanged: only the literal + bounded port.
    expect(VeyraNSIWC.callbackHost == "127.0.0.1", "the callback host is the loopback literal")
    expect(
      VeyraNSIWCRedirect.uri(port: 49152) == "http://127.0.0.1:49152/auth/callback",
      "the redirect URI builder is the fixed loopback form"
    )
    expect(
      VeyraNSIWCValidate.redirectURI("http://127.0.0.1:49152/auth/callback"),
      "the exact loopback redirect URI is accepted"
    )
    expect(
      !VeyraNSIWCValidate.redirectURI("http://localhost:49152/auth/callback"),
      "a non-literal host origin is refused"
    )
    expect(
      !VeyraNSIWCValidate.redirectURI("http://127.0.0.1:99999/auth/callback"),
      "an out-of-range port is refused"
    )
    expect(
      !VeyraNSIWCValidate.redirectURI("http://evil.example:49152/auth/callback"),
      "a foreign origin is refused"
    )
  }

  // MARK: real loopback listener terminal seam

  /// The *actual* `VeyraNSIWCCallbackServer` is driven so the new terminal seams
  /// hold on a real socket: the TTL fires `onExpiry` exactly once (never a silent
  /// cancel and never also a failure), an owner cancel is silent, and a synthetic
  /// valid GET over loopback reports one parsed callback that the owner *accepts*
  /// (by cancelling), which disarms the remaining TTL. No provider, browser or
  /// real credential is involved.
  static func listenerTerminalSeamTests() {
    // --- the TTL reports exactly one expiry (no failure) ---
    let expiryServer = VeyraNSIWCCallbackServer()
    let expiries = Counter()
    let failures = Counter()
    let expiryPorts = ResultBox<Int>()
    expiryServer.onReady = { expiryPorts.set(.success($0)) }
    expiryServer.onExpiry = { [weak expiryServer] in
      // Re-entering the server from the report is only safe because `onExpiry` is
      // invoked *outside* the server's own lock (a lock-held report would deadlock
      // here, since `cancel()` re-takes that lock).
      expiryServer?.cancel()
      expiries.increment()
    }
    expiryServer.onFailure = { failures.increment() }
    do { try expiryServer.start(flowTTL: 0.6) } catch {
      expect(false, "the TTL smoke server binds")
    }
    expect(
      waitSync(3) { expiries.value == 1 },
      "an abandoned listener fires onExpiry"
    )
    Thread.sleep(forTimeInterval: 0.3)
    expect(expiries.value == 1, "the listener TTL fires onExpiry exactly once")
    expect(failures.value == 0, "an expiry is never also reported as a failure")

    // --- an owner cancel is silent, distinct from `.failed` ---
    let cancelServer = VeyraNSIWCCallbackServer()
    let cancelExpiry = Counter()
    let cancelFailure = Counter()
    cancelServer.onExpiry = { cancelExpiry.increment() }
    cancelServer.onFailure = { cancelFailure.increment() }
    do { try cancelServer.start(flowTTL: 0.6) } catch {
      expect(false, "the cancel smoke server binds")
    }
    cancelServer.cancel()
    Thread.sleep(forTimeInterval: 0.9)
    expect(
      cancelExpiry.value == 0 && cancelFailure.value == 0,
      "an owner cancel is silent (no expiry and no failure)"
    )

    // --- a synthetic valid GET to the real loopback listener reports once ---
    let live = VeyraNSIWCCallbackServer()
    let validBox = ResultBox<[String: String]>()
    let liveExpiry = Counter()
    let liveFailure = Counter()
    let livePorts = ResultBox<Int>()
    live.onReady = { livePorts.set(.success($0)) }
    live.onValid = { [weak live] params in
      // `onValid` is reported outside the server's lock: re-entering `cancel()`
      // here would deadlock if it were called under the lock.
      live?.cancel()
      validBox.set(.success(params))
    }
    live.onExpiry = { liveExpiry.increment() }
    live.onFailure = { liveFailure.increment() }
    do { try live.start(flowTTL: 5) } catch {
      expect(false, "the live smoke server binds")
    }
    if waitSync(3, { livePorts.result != nil }),
      case let .success(livePort)? = livePorts.result
    {
      expect(
        sendLoopbackGET(
          port: livePort,
          path: "/auth/callback?code=synthetic-code&state=synthetic-state",
          host: "127.0.0.1:\(livePort)"
        ),
        "the synthetic loopback GET is written"
      )
      expect(
        waitSync(3) { validBox.result != nil },
        "a valid loopback callback is reported exactly once"
      )
      if case let .success(params)? = validBox.result {
        expect(
          params["code"] == "synthetic-code" && params["state"] == "synthetic-state",
          "the reported callback carries the exact synthetic query"
        )
      } else {
        expect(false, "the reported callback is a parsed query map")
      }
      live.cancel()
      Thread.sleep(forTimeInterval: 0.1)
      expect(
        liveExpiry.value == 0 && liveFailure.value == 0,
        "accepting a valid callback silently disarms the remaining TTL (no expiry, no failure)"
      )
    } else {
      expect(false, "the live smoke server reports its port")
    }
  }

  // MARK: a rejected callback must not disarm the listener TTL

  /// Regression for the callback-lifetime repair: a *parse-valid* callback that
  /// the flow owner **rejects** (wrong state / missing code / foreign client id
  /// are decided by the provider, never by the parser) must not be mistaken by
  /// the listener for a terminal outcome. The listener stays live and the
  /// abandoned flow still ends with exactly one `onExpiry` — never a silent
  /// cancel and never an `onFailure`. A genuine callback arriving afterwards is
  /// still delivered, and its acceptance disarms the TTL. No provider, browser
  /// or real credential is involved.
  static func rejectedCallbackLifetimeTests() {
    // --- (1) a rejected callback leaves the listener live; the abandoned
    //         flow's own TTL still fires exactly one expiry ---
    let abandoned = VeyraNSIWCCallbackServer()
    let abandonedPorts = ResultBox<Int>()
    let delivered = Counter()
    let abandonedExpiry = Counter()
    let abandonedFailure = Counter()
    abandoned.onReady = { abandonedPorts.set(.success($0)) }
    // The owner rejects every delivery (state/client-id correlation happens in
    // the provider, *after* this seam): it therefore never cancels the listener.
    abandoned.onValid = { _ in delivered.increment() }
    abandoned.onExpiry = { abandonedExpiry.increment() }
    abandoned.onFailure = { abandonedFailure.increment() }
    do {
      try abandoned.start(flowTTL: 0.8)
    } catch {
      expect(false, "the rejected-callback smoke server binds")
    }
    if waitSync(3, { abandonedPorts.result != nil }),
      case let .success(abandonedPort)? = abandonedPorts.result
    {
      expect(
        sendLoopbackGET(
          port: abandonedPort,
          path: "/auth/callback?code=rejected-code&state=not-the-bound-state",
          host: "127.0.0.1:\(abandonedPort)"
        ),
        "the wrong-state loopback GET is written"
      )
      expect(
        waitSync(3) { delivered.value == 1 },
        "the parse-valid wrong-state callback is handed to the owner once"
      )
      expect(
        canConnectLoopback(port: abandonedPort),
        "a rejected callback leaves the listener live for the genuine one"
      )
      expect(
        abandonedExpiry.value == 0 && abandonedFailure.value == 0,
        "a rejected callback reports no terminal of its own"
      )
      expect(
        waitSync(3) { abandonedExpiry.value == 1 },
        "the abandoned flow's own TTL still fires onExpiry after a rejected callback"
      )
      Thread.sleep(forTimeInterval: 0.3)
      expect(
        abandonedExpiry.value == 1,
        "the post-rejection expiry fires exactly once"
      )
      expect(
        abandonedFailure.value == 0,
        "a post-rejection expiry is never also reported as a failure"
      )
      expect(
        waitSync(3) { !canConnectLoopback(port: abandonedPort) },
        "the post-rejection TTL tears the listener down once"
      )
    } else {
      expect(false, "the rejected-callback smoke server reports its port")
    }

    // --- (2) after a rejected callback the genuine one is still delivered and
    //         its acceptance cancels the listener (no expiry at all) ---
    let genuine = VeyraNSIWCCallbackServer()
    let genuinePorts = ResultBox<Int>()
    let genuineDeliveries = ResultBox<[String: String]>()
    let genuineCount = Counter()
    let genuineExpiry = Counter()
    let genuineFailure = Counter()
    genuine.onReady = { genuinePorts.set(.success($0)) }
    genuine.onValid = { [weak genuine] params in
      genuineCount.increment()
      genuineDeliveries.set(.success(params))
      // Only the genuinely matching state is accepted (and only the owner can
      // decide that); acceptance cancels the listener and disarms its TTL.
      if params["state"] == "bound-state" { genuine?.cancel() }
    }
    genuine.onExpiry = { genuineExpiry.increment() }
    genuine.onFailure = { genuineFailure.increment() }
    do {
      try genuine.start(flowTTL: 1.0)
    } catch {
      expect(false, "the genuine-callback smoke server binds")
    }
    if waitSync(3, { genuinePorts.result != nil }),
      case let .success(genuinePort)? = genuinePorts.result
    {
      expect(
        sendLoopbackGET(
          port: genuinePort,
          path: "/auth/callback?code=stale-code&state=wrong-state",
          host: "127.0.0.1:\(genuinePort)"
        ),
        "the first (rejected) loopback GET is written"
      )
      expect(
        waitSync(3) { genuineCount.value == 1 },
        "the rejected callback is delivered to the owner"
      )
      expect(
        sendLoopbackGET(
          port: genuinePort,
          path: "/auth/callback?code=genuine-code&state=bound-state",
          host: "127.0.0.1:\(genuinePort)"
        ),
        "the genuine loopback GET is written"
      )
      expect(
        waitSync(3) { genuineCount.value == 2 },
        "the genuine callback is still delivered after a rejected one"
      )
      if case let .success(params)? = genuineDeliveries.result {
        expect(
          params["code"] == "genuine-code" && params["state"] == "bound-state",
          "the last delivered callback carries the exact genuine query"
        )
      } else {
        expect(false, "the genuine callback is a parsed query map")
      }
      // Acceptance cancels the listener before its TTL: sleeping past the TTL
      // proves no expiry (or failure) can ever fire for the accepted flow.
      Thread.sleep(forTimeInterval: 1.3)
      expect(
        genuineExpiry.value == 0 && genuineFailure.value == 0,
        "accepting the genuine callback disarms the remaining TTL silently"
      )
      expect(
        !canConnectLoopback(port: genuinePort),
        "accepting the genuine callback tears the listener down"
      )
    } else {
      expect(false, "the genuine-callback smoke server reports its port")
    }
  }

  // MARK: callback lifetime / terminal repair

  /// The synchronous admission, the atomic claim-vs-expiry linearization, the
  /// exact-claim ownership guard, the single-use ticket and the browser-open
  /// completion seam — driven against the exact production coordinator/provider
  /// with a synthetic listener, a manual clock and a gated exchange. No real
  /// credential, network or 10-minute sleep is involved.
  static func callbackLifetimeTests(key: (privateKey: SecKey, publicKey: SecKey)) async {
    let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    let jwks = jwksJSON(kid: "test-kid", publicKey: key.publicKey)
    let signed = idToken(key: key, now: t0)
    let tokenBody = """
      {"access_token":"access-1","refresh_token":"refresh-1","id_token":"\(signed)",\
      "scope":"openid offline_access resource.invoke chatgpt.tokens.use.direct",\
      "token_type":"Bearer"}
      """
    let state = abState

    func successHTTP() -> GatedHTTP {
      let http = GatedHTTP()
      http.responses[VeyraNSIWC.tokenEndpoint] = VeyraNSIWCHTTPResponse(
        status: 200, headers: [:], body: Data(tokenBody.utf8)
      )
      http.responses[VeyraNSIWC.jwksEndpoint] = VeyraNSIWCHTTPResponse(
        status: 200, headers: [:], body: jwks
      )
      return http
    }

    func makeEnv() -> (
      store: SyntheticStore, http: GatedHTTP, provider: VeyraNSIWCProvider,
      registry: ListenerRegistry, queue: ManualQueue, clock: ManualClock,
      lifecycle: VeyraNSIWCLifecycle, seam: AuthDeliverySeam,
      box: ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>
    ) {
      let clock = ManualClock(t0)
      let http = successHTTP()
      let store = SyntheticStore()
      let provider = VeyraNSIWCProvider(
        store: store, http: http, stream: ScriptedStream(), clock: clock,
        random: FixedRandom(byte: 0xAB)
      )
      let registry = ListenerRegistry()
      let queue = ManualQueue()
      let lifecycle = VeyraNSIWCLifecycle(
        providerFactory: { provider },
        listenerFactory: { registry.make() },
        openURL: { _, _ in },
        mainQueue: { queue.enqueue($0) }
      )
      let seam = AuthDeliverySeam(lifecycle: lifecycle, mainQueue: { queue.enqueue($0) })
      let box = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
      return (store, http, provider, registry, queue, clock, lifecycle, seam, box)
    }

    /// Drain the manual main queue repeatedly so a chain of deferred effects (the
    /// browser hop, the claim's listener cancel, the terminal dispatch) all runs.
    func pump(_ queue: ManualQueue) async {
      for _ in 0..<8 {
        queue.drain()
        await settle(0.01)
      }
    }

    func isAuthError(_ event: VeyraNSIWCLifecycle.AuthEvent) -> Bool {
      if case .authError = event { return true }
      return false
    }

    // ---- 1. An abandoned *started* flow ends with exactly one flow_expired ----
    let e1 = makeEnv()
    e1.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e1.box.set($0) }
    )
    e1.registry.at(0)?.ready()
    e1.queue.drain()
    guard case let .success(start1)? = e1.box.result else {
      expect(false, "the abandoned flow starts")
      return
    }
    e1.registry.at(0)?.expire()
    await pump(e1.queue)
    expect(e1.seam.delivered.count == 1, "an abandoned flow ends with exactly one terminal event")
    if case let .authError(code, gen, owner, epoch)? = e1.seam.delivered.first {
      expect(code == VeyraNSIWCError.flowExpired.code, "the abandoned flow ends with flow_expired")
      expect(
        gen == start1.generation && owner == start1.ownerAccountId
          && epoch == start1.providerEpoch,
        "the expiry event carries the exact source identity"
      )
    } else {
      expect(false, "the abandoned flow ends with an authError")
    }
    expect(e1.registry.at(0)?.canceled == 1, "the expiry tears the listener down once")
    expect(e1.http.count == 0, "an expired flow performs zero exchange requests")
    expect(e1.store.saveCount == 0, "an expired flow performs zero store writes")
    expect(
      !e1.lifecycle.isCurrentAuthFlow(start1.generation),
      "the expired flow is no longer current"
    )

    // ---- 2. A pre-ready start failure answers the promise once, no event ----
    let e2 = makeEnv()
    e2.registry.nextStartError = VeyraNSIWCError.transportUnavailable
    e2.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e2.box.set($0) }
    )
    expect(e2.box.calls == 1, "a listener start failure answers the start promise exactly once")
    if case let .failure(error)? = e2.box.result {
      expect(error == .transportUnavailable, "a start failure is transport_unavailable")
    } else {
      expect(false, "a start failure rejects the start promise")
    }
    expect(e2.registry.at(0)?.canceled == 1, "the failed listener is torn down once")
    e2.registry.at(0)?.expire()
    e2.registry.at(0)?.fail()
    await pump(e2.queue)
    expect(e2.seam.delivered.isEmpty, "a pre-ready start failure delivers no auth event")

    // ---- 2b. A pre-ready listener failure (before ready) answers once ----
    let e2b = makeEnv()
    e2b.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e2b.box.set($0) }
    )
    e2b.registry.at(0)?.fail()
    expect(e2b.box.calls == 1, "a pre-ready listener failure answers the promise once")
    if case let .failure(error)? = e2b.box.result {
      expect(error == .transportUnavailable, "a pre-ready listener failure is transport_unavailable")
    } else {
      expect(false, "a pre-ready listener failure rejects the promise")
    }
    e2b.registry.at(0)?.ready()
    e2b.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    await pump(e2b.queue)
    expect(e2b.seam.delivered.isEmpty, "no auth event follows a pre-ready listener failure")

    // ---- 3. An explicit cancel is silent ----
    let e3 = makeEnv()
    e3.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e3.box.set($0) }
    )
    e3.registry.at(0)?.ready()
    e3.queue.drain()
    guard case let .success(start3)? = e3.box.result else {
      expect(false, "the explicit-cancel flow starts")
      return
    }
    e3.lifecycle.cancelAuth()
    e3.registry.at(0)?.expire()
    e3.registry.at(0)?.fail()
    await pump(e3.queue)
    expect(e3.seam.delivered.isEmpty, "an explicit cancel delivers no auth event")
    expect(!e3.lifecycle.isCurrentAuthFlow(start3.generation), "the canceled flow is no longer current")
    let e3b = makeEnv()
    e3b.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e3b.box.set($0) }
    )
    e3b.lifecycle.cancelAuth()
    expect(e3b.box.calls == 1, "a cancel before ready answers the promise once")
    if case let .failure(error)? = e3b.box.result {
      expect(error == .authCanceled, "a cancel before ready answers authCanceled")
    } else {
      expect(false, "a cancel before ready answers the promise")
    }

    // ---- 4. A genuinely claimed callback beats expiry (gated exchange) ----
    let e4 = makeEnv()
    let gate4 = DispatchSemaphore(value: 0)
    e4.http.gate = gate4
    e4.http.gatedURL = VeyraNSIWC.tokenEndpoint
    e4.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e4.box.set($0) }
    )
    e4.registry.at(0)?.ready()
    e4.queue.drain()
    guard case let .success(start4)? = e4.box.result else {
      expect(false, "the claim-wins flow starts")
      return
    }
    e4.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    expect(
      await waitUntil("the claimed exchange reaches the gated token request") {
        e4.http.count == 1
      },
      "a genuine claim starts exactly one exchange"
    )
    expect(e4.registry.at(0)?.canceled == 1, "the claim disarms the listener deadline")
    // Expiry loses: advance far past the TTL and fire the listener expiry.
    e4.clock.advance(VeyraNSIWC.flowTTLSeconds + 1)
    e4.registry.at(0)?.expire()
    await settle(0.05)
    expect(
      e4.seam.delivered.isEmpty,
      "the losing expiry delivers nothing while the exchange is in flight"
    )
    gate4.signal()
    await pump(e4.queue)
    expect(e4.seam.delivered.count == 1, "the claimed callback reaches JS exactly once")
    if case let .authenticated(_, clientId, gen, _, _)? = e4.seam.delivered.first {
      expect(
        clientId == "issued-client-abc" && gen == start4.generation,
        "the delivered event is the claimed credential for the exact source"
      )
    } else {
      expect(false, "the claimed callback delivers an authenticated event")
    }
    expect(
      !e4.seam.delivered.contains(where: isAuthError),
      "no flow_expired is delivered for a claim that won"
    )
    expect(
      e4.store.document?.credential?.clientId == "issued-client-abc",
      "the winning claim commits exactly once"
    )

    // ---- 5. Expiry wins cleanly: a callback at the TTL does no work ----
    let e5 = makeEnv()
    e5.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e5.box.set($0) }
    )
    e5.registry.at(0)?.ready()
    e5.queue.drain()
    guard case let .success(start5)? = e5.box.result else {
      expect(false, "the expiry-wins flow starts")
      return
    }
    e5.clock.advance(VeyraNSIWC.flowTTLSeconds)
    e5.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    await pump(e5.queue)
    expect(e5.seam.delivered.count == 1, "a callback at the TTL ends the flow exactly once")
    if case let .authError(code, gen, _, _)? = e5.seam.delivered.first {
      expect(code == VeyraNSIWCError.flowExpired.code, "a callback at the TTL is refused as flow_expired")
      expect(gen == start5.generation, "the expiry event carries the exact generation")
    } else {
      expect(false, "a callback at the TTL ends with flow_expired")
    }
    expect(e5.http.count == 0, "a late callback performs zero exchange requests")
    expect(e5.store.saveCount == 0, "a late callback performs zero store writes")
    expect(e5.registry.at(0)?.canceled == 1, "the expired flow tears its listener down once")

    // ---- 6. Wrong/malformed callbacks consume nothing; expiry still ends it ----
    let e6 = makeEnv()
    e6.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e6.box.set($0) }
    )
    e6.registry.at(0)?.ready()
    e6.queue.drain()
    guard case let .success(start6)? = e6.box.result else {
      expect(false, "the rejected-callback flow starts")
      return
    }
    let badCallbacks: [[String: String]] = [
      ["code": "c", "state": "wrong"],
      ["code": "c"],
      ["state": state, "client_id": "issued-client-abc"],
      ["code": "c", "state": state, "client_id": VeyraNSIWC.dynamicAgentClientId]
    ]
    for bad in badCallbacks {
      e6.registry.at(0)?.valid(bad)
      await settle(0.05)
      e6.queue.drain()
      expect(e6.seam.delivered.isEmpty, "a wrong/malformed callback delivers nothing")
      expect(
        e6.registry.at(0)?.canceled == 0,
        "a rejected callback keeps the listener (and its deadline) live"
      )
      expect(
        e6.lifecycle.isCurrentAuthFlow(start6.generation),
        "the flow stays current after a rejected callback"
      )
    }
    expect(e6.http.count == 0, "no rejected callback performs any exchange")
    expect(e6.store.saveCount == 0, "no rejected callback performs any store write")
    e6.registry.at(0)?.expire()
    await pump(e6.queue)
    expect(e6.seam.delivered.count == 1, "after the rejected callbacks the flow ends with one expiry")
    if case let .authError(code, _, _, _)? = e6.seam.delivered.first {
      expect(code == VeyraNSIWCError.flowExpired.code, "the terminal event is flow_expired")
    } else {
      expect(false, "the terminal event after rejected callbacks is an authError")
    }

    // ---- 7. A superseded claimed exchange never persists; the newer flow does ----
    let e7 = makeEnv()
    let gate7 = DispatchSemaphore(value: 0)
    e7.http.gate = gate7
    e7.http.gatedURL = VeyraNSIWC.tokenEndpoint
    e7.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e7.box.set($0) }
    )
    e7.registry.at(0)?.ready()
    e7.queue.drain()
    guard case let .success(start7A)? = e7.box.result else {
      expect(false, "the supersede flow A starts")
      return
    }
    e7.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    expect(
      await waitUntil("flow A's claimed exchange is in flight") { e7.http.count == 1 },
      "flow A claimed and reached the gated exchange"
    )
    let box7B = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    e7.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { box7B.set($0) }
    )
    e7.registry.at(1)?.ready()
    e7.queue.drain()
    guard case let .success(start7B)? = box7B.result else {
      expect(false, "the superseding flow B starts")
      return
    }
    gate7.signal()
    await settle(0.2)
    await pump(e7.queue)
    expect(
      e7.seam.delivered.isEmpty,
      "a superseded claimed flow delivers nothing after the newer flow starts"
    )
    expect(
      e7.store.document?.credential == nil,
      "a superseded claimed flow never persists a credential"
    )
    expect(
      e7.store.document?.registration(clientId: "issued-client-abc")?.isComplete != true,
      "a superseded fresh claim leaves only (at most) an incomplete registration"
    )
    e7.registry.at(1)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    await pump(e7.queue)
    expect(e7.seam.delivered.count == 1, "the newer flow delivers exactly its own terminal event")
    if case let .authenticated(_, clientId, gen, _, _)? = e7.seam.delivered.first {
      expect(
        clientId == "issued-client-abc" && gen == start7B.generation,
        "the newer flow's credential is the delivered one"
      )
    } else {
      expect(false, "the newer flow delivers an authenticated event")
    }
    expect(
      e7.store.document?.credential?.clientId == "issued-client-abc",
      "only the newer flow persists a credential"
    )
    expect(start7A.generation != start7B.generation, "the superseding flow has a fresh generation")

    // ---- 8. cancelAuth during a claimed exchange never persists ----
    let e8 = makeEnv()
    let gate8 = DispatchSemaphore(value: 0)
    e8.http.gate = gate8
    e8.http.gatedURL = VeyraNSIWC.tokenEndpoint
    e8.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e8.box.set($0) }
    )
    e8.registry.at(0)?.ready()
    e8.queue.drain()
    e8.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    expect(
      await waitUntil("the cancel-during-exchange flow is in flight") { e8.http.count == 1 },
      "the canceled flow reached the gated exchange"
    )
    e8.lifecycle.cancelAuth()
    gate8.signal()
    await settle(0.2)
    await pump(e8.queue)
    expect(e8.seam.delivered.isEmpty, "an explicitly canceled claimed flow delivers nothing")
    expect(
      e8.store.document?.credential == nil,
      "an explicitly canceled claimed flow never persists a credential"
    )

    // ---- 8b. A fenced (new-epoch) claimed exchange never persists ----
    let e8b = makeEnv()
    let gate8b = DispatchSemaphore(value: 0)
    e8b.http.gate = gate8b
    e8b.http.gatedURL = VeyraNSIWC.tokenEndpoint
    e8b.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e8b.box.set($0) }
    )
    e8b.registry.at(0)?.ready()
    e8b.queue.drain()
    e8b.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    expect(
      await waitUntil("the fenced-during-exchange flow is in flight") { e8b.http.count == 1 },
      "the fenced flow reached the gated exchange"
    )
    e8b.lifecycle.fence()
    gate8b.signal()
    await settle(0.2)
    await pump(e8b.queue)
    expect(e8b.seam.delivered.isEmpty, "a fenced claimed flow delivers nothing")
    expect(
      e8b.store.document?.credential == nil,
      "a fenced claimed flow never persists a credential"
    )

    // ---- 9. A replayed prepared ticket performs no second exchange ----
    let clock9 = ManualClock(t0)
    let http9 = successHTTP()
    let store9 = SyntheticStore()
    let p9 = VeyraNSIWCProvider(
      store: store9, http: http9, stream: ScriptedStream(), clock: clock9,
      random: FixedRandom(byte: 0xAB)
    )
    _ = try? p9.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", port: 49152, loginHint: nil,
      entry: methodEntry(p9, "notes-1")
    )
    guard case let .admitted(ticket9) = p9.prepareCallback(
      query: ["code": "c", "state": state, "client_id": "issued-client-abc"],
      port: 49152, ownerAccountId: "notes-1", entry: methodEntry(p9, "notes-1")
    ) else {
      expect(false, "the callback is admitted")
      return
    }
    let first9 = await p9.finishCallback(ticket9)
    expect(first9.claimed && first9.credential != nil, "the prepared ticket performs the one exchange")
    let requestsAfter9 = http9.count
    let second9 = await p9.finishCallback(ticket9)
    expect(second9.claimed == false, "a replayed prepared ticket is refused")
    expect(http9.count == requestsAfter9, "a replayed prepared ticket performs no second exchange")
    expect(
      store9.document?.credential?.clientId == "issued-client-abc",
      "the replay does not overwrite the committed credential"
    )

    // ---- 10. A queued terminal delivery is revoked by cancelAuth/logout ----
    let e10 = makeEnv()
    e10.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e10.box.set($0) }
    )
    e10.registry.at(0)?.ready()
    e10.queue.drain()
    e10.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    expect(
      await waitUntil("flow 10's terminal event is queued") { e10.queue.count > 0 },
      "flow 10 queues its terminal delivery"
    )
    e10.lifecycle.cancelAuth()
    await pump(e10.queue)
    expect(e10.seam.delivered.isEmpty, "a queued terminal delivery revoked by cancelAuth is dropped")

    let e10b = makeEnv()
    e10b.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e10b.box.set($0) }
    )
    e10b.registry.at(0)?.ready()
    e10b.queue.drain()
    e10b.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    expect(
      await waitUntil("flow 10b's terminal event is queued") { e10b.queue.count > 0 },
      "flow 10b queues its terminal delivery"
    )
    e10b.lifecycle.logout(ownerAccountId: "notes-1") { _ in }
    await pump(e10b.queue)
    expect(e10b.seam.delivered.isEmpty, "a queued terminal delivery revoked by logout is dropped")

    // ---- 11. The browser completion seam: a synchronous false ends it once ----
    let clock11 = ManualClock(t0)
    let http11 = successHTTP()
    let store11 = SyntheticStore()
    let provider11 = VeyraNSIWCProvider(
      store: store11, http: http11, stream: ScriptedStream(), clock: clock11,
      random: FixedRandom(byte: 0xAB)
    )
    let registry11 = ListenerRegistry()
    let queue11 = ManualQueue()
    let opened11 = Counter()
    let lifecycle11 = VeyraNSIWCLifecycle(
      providerFactory: { provider11 },
      listenerFactory: { registry11.make() },
      // A *synchronous* completion inside the opener's critical section: it must
      // not deadlock (the failure effect is deferred, never applied under the lock).
      openURL: { _, completion in
        opened11.increment()
        completion(false)
      },
      mainQueue: { queue11.enqueue($0) }
    )
    let seam11 = AuthDeliverySeam(lifecycle: lifecycle11, mainQueue: { queue11.enqueue($0) })
    let box11 = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle11.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { box11.set($0) }
    )
    registry11.at(0)?.ready()
    await pump(queue11)
    expect(opened11.value == 1, "the opener runs for the exact started source")
    expect(seam11.delivered.count == 1, "a failed browser open ends the flow exactly once")
    if case let .authError(code, _, _, _)? = seam11.delivered.first {
      expect(code == VeyraNSIWCError.transportUnavailable.code, "a failed browser open is transport_unavailable")
    } else {
      expect(false, "a failed browser open delivers an authError")
    }
    expect(registry11.at(0)?.canceled == 1, "a failed browser open tears the listener down once")
    expect(http11.count == 0, "a failed browser open performs no exchange")
    expect(box11.calls == 1 && !seam11.delivered.isEmpty, "the synchronous opener completion never deadlocked")

    // ---- 11b. A stale browser-open false delivers nothing ----
    let clock11b = ManualClock(t0)
    let provider11b = VeyraNSIWCProvider(
      store: SyntheticStore(), http: successHTTP(), stream: ScriptedStream(),
      clock: clock11b, random: FixedRandom(byte: 0xAB)
    )
    let registry11b = ListenerRegistry()
    let queue11b = ManualQueue()
    let holder11b = CompletionHolder()
    let lifecycle11b = VeyraNSIWCLifecycle(
      providerFactory: { provider11b },
      listenerFactory: { registry11b.make() },
      openURL: { _, completion in holder11b.set(completion) },
      mainQueue: { queue11b.enqueue($0) }
    )
    let seam11b = AuthDeliverySeam(lifecycle: lifecycle11b, mainQueue: { queue11b.enqueue($0) })
    let box11b = ResultBox<VeyraNSIWCLifecycle.AuthStartPayload>()
    lifecycle11b.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { box11b.set($0) }
    )
    registry11b.at(0)?.ready()
    queue11b.drain()
    expect(holder11b.hasValue, "the opener captured its completion")
    lifecycle11b.fence()
    holder11b.call(false)
    await pump(queue11b)
    expect(seam11b.delivered.isEmpty, "a stale browser-open false delivers nothing")

    // ---- 12. Exactly one per-source producer wins ----
    let e12a = makeEnv()
    e12a.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e12a.box.set($0) }
    )
    e12a.registry.at(0)?.ready()
    e12a.queue.drain()
    e12a.registry.at(0)?.expire()
    await pump(e12a.queue)
    e12a.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    await pump(e12a.queue)
    expect(
      e12a.seam.delivered.count == 1,
      "a late callback after expiry adds no second terminal event"
    )

    let e12b = makeEnv()
    e12b.lifecycle.beginAuth(
      mode: .fresh, ownerAccountId: "notes-1", loginHint: nil,
      completion: { e12b.box.set($0) }
    )
    e12b.registry.at(0)?.ready()
    e12b.queue.drain()
    e12b.registry.at(0)?.valid(["code": "c", "state": state, "client_id": "issued-client-abc"])
    await pump(e12b.queue)
    expect(e12b.seam.delivered.count == 1, "the claimed flow delivers once")
    e12b.registry.at(0)?.expire()
    e12b.registry.at(0)?.fail()
    await pump(e12b.queue)
    expect(e12b.seam.delivered.count == 1, "a post-claim expiry/failure adds nothing")
  }
}

private final class Counter {
  private let lock = NSLock()
  private var count = 0
  var value: Int { lock.lock(); defer { lock.unlock() }; return count }
  func increment() { lock.lock(); count += 1; lock.unlock() }
}

/// A bounded, thread-safe list of observed strings (request bodies, urls, …).
private final class Recorder {
  private let lock = NSLock()
  private var items: [String] = []
  func record(_ value: String) { lock.lock(); items.append(value); lock.unlock() }
  var values: [String] { lock.lock(); defer { lock.unlock() }; return items }
  var last: String? { values.last }
  var count: Int { values.count }
}

/// A store whose next save can be paused *after* the provider has entered the
/// commit critical section. It proves the check+write+adopt section is real: the
/// pausing thread holds the provider lock while the test fences from another
/// thread.
private final class BarrierStore: VeyraNSIWCStore {
  private let lock = NSLock()
  private var document: VeyraNSIWCPersisted?
  private(set) var saves = 0
  var pauseNextSave: DispatchSemaphore?
  var saveStarted: DispatchSemaphore?
  var failSave = false

  init(document: VeyraNSIWCPersisted? = nil) { self.document = document }

  var current: VeyraNSIWCPersisted? {
    lock.lock()
    defer { lock.unlock() }
    return document
  }

  func load() -> VeyraNSIWCStoreRead {
    guard let current else { return .missing }
    return .loaded(current)
  }

  /// Create-if-absent: an existing record is returned, never overwritten.
  func createIfAbsent(_ value: VeyraNSIWCPersisted) -> VeyraNSIWCStoreCreate {
    lock.lock()
    defer { lock.unlock() }
    if failSave { return .failed }
    if let document { return .existing(document) }
    saves += 1
    document = value
    return .created
  }

  @discardableResult
  func save(_ value: VeyraNSIWCPersisted) -> Bool {
    lock.lock()
    if let pause = pauseNextSave {
      pauseNextSave = nil
      let started = saveStarted
      lock.unlock()
      started?.signal()
      pause.wait()
      lock.lock()
    }
    if failSave {
      lock.unlock()
      return false
    }
    saves += 1
    document = value
    lock.unlock()
    return true
  }

  @discardableResult
  func delete() -> Bool {
    lock.lock()
    document = nil
    lock.unlock()
    return true
  }
}

/// A one-shot gate the scripted transport can wait on.
private final class Gate {
  private let semaphore = DispatchSemaphore(value: 0)
  func open() { semaphore.signal() }
  func wait() { semaphore.wait() }
}

/// A synthetic single-use listener: the test decides exactly *when* `ready` and
/// a valid callback are delivered, so a deferred delivery can be replayed after
/// a fence or a newer flow.
///
/// It models the production seam faithfully: `valid()` only hands the query to
/// the owner, and `expire()`/`fail()` fire unconditionally — a delivered valid
/// callback *never* disarms the TTL by itself; only the owner's `cancel()`
/// (acceptance) can. The real listener's socket-level version of that rule is
/// covered by `rejectedCallbackLifetimeTests`.
private final class SyntheticListener: VeyraNSIWCCallbackListener {
  var onReady: ((Int) -> Void)?
  var onValid: (([String: String]) -> Void)?
  var onExpiry: (() -> Void)?
  var onFailure: (() -> Void)?
  private let lock = NSLock()
  private var startedCount = 0
  private var canceledCount = 0
  var port = 49152
  var startError: Error?
  /// Every `flowTTL` passed to `start`, so the shared bound is provable.
  private(set) var startTTLs: [TimeInterval] = []

  var started: Int { lock.lock(); defer { lock.unlock() }; return startedCount }
  var canceled: Int { lock.lock(); defer { lock.unlock() }; return canceledCount }

  func start(flowTTL: TimeInterval) throws {
    lock.lock()
    startedCount += 1
    startTTLs.append(flowTTL)
    let error = startError
    lock.unlock()
    if let error { throw error }
  }

  func cancel() {
    lock.lock()
    canceledCount += 1
    lock.unlock()
  }

  /// Deliver the deferred `ready` for this listener.
  func ready() { onReady?(port) }

  /// Deliver a syntactically valid callback for this listener.
  func valid(_ query: [String: String]) { onValid?(query) }

  /// Deliver the listener's own TTL expiry.
  func expire() { onExpiry?() }

  /// Deliver the listener's own failure.
  func fail() { onFailure?() }
}

/// The listener factory behind the coordinator: it hands out synthetic listeners
/// and remembers every one, so a superseded listener can be driven late.
private final class ListenerRegistry {
  private let lock = NSLock()
  private var created: [SyntheticListener] = []
  private(set) var count = 0
  /// When set, the *next* listener handed out starts with this error so the
  /// pre-`ready` start failure path is reproducible.
  var nextStartError: Error?

  func make() -> VeyraNSIWCCallbackListener {
    lock.lock()
    let listener = SyntheticListener()
    if let nextStartError {
      listener.startError = nextStartError
      self.nextStartError = nil
    }
    created.append(listener)
    count = created.count
    lock.unlock()
    return listener
  }

  func at(_ index: Int) -> SyntheticListener? {
    lock.lock()
    defer { lock.unlock() }
    guard index >= 0, index < created.count else { return nil }
    return created[index]
  }
}

/// A manually drained main queue: the test decides when a deferred browser hop
/// actually runs.
private final class ManualQueue {
  private let lock = NSLock()
  private var pending: [() -> Void] = []

  func enqueue(_ work: @escaping () -> Void) {
    lock.lock()
    pending.append(work)
    lock.unlock()
  }

  var count: Int { lock.lock(); defer { lock.unlock() }; return pending.count }

  func drain() {
    lock.lock()
    let work = pending
    pending = []
    lock.unlock()
    for item in work { item() }
  }
}

/// A one-shot typed completion box with an exact call count.
private final class ResultBox<T> {
  private let lock = NSLock()
  private var stored: Result<T, VeyraNSIWCError>?
  private var storedCalls = 0

  func set(_ value: Result<T, VeyraNSIWCError>) {
    lock.lock()
    storedCalls += 1
    stored = value
    lock.unlock()
  }

  var result: Result<T, VeyraNSIWCError>? {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }

  var calls: Int { lock.lock(); defer { lock.unlock() }; return storedCalls }
}

/// Wait (bounded, real time) until `condition` holds.
private func waitUntil(
  _ label: String,
  timeout: TimeInterval = 5,
  _ condition: () -> Bool
) async -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
  _ = label
  return condition()
}

/// Give any queued asynchronous delivery the chance to run (used for the
/// negative assertions: nothing must happen).
private func settle(_ seconds: Double = 0.25) async {
  try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}

/// A counting transport double: it records every request (so "zero network
/// work" is provable) and can block the first request on a gate so a deferred
/// step can be interleaved deterministically.
private final class RecordingHTTP: VeyraNSIWCTransport {
  private let lock = NSLock()
  private var recorded: [VeyraNSIWCHTTPRequest] = []
  var response = VeyraNSIWCHTTPResponse(status: 200, headers: [:], body: Data())
  var error: Error?
  /// When set, the first request whose URL matches `gatedURL` (or any request
  /// when `gatedURL` is nil) waits for this gate before answering.
  var gate: DispatchSemaphore?
  var gatedURL: String?

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return recorded.count
  }

  var urls: [String] {
    lock.lock()
    defer { lock.unlock() }
    return recorded.map { $0.url }
  }

  func send(
    _ request: VeyraNSIWCHTTPRequest,
    timeout: TimeInterval
  ) async throws -> VeyraNSIWCHTTPResponse {
    lock.lock()
    recorded.append(request)
    var gateToWait: DispatchSemaphore?
    if let gate, gatedURL == nil || gatedURL == request.url {
      gateToWait = gate
      self.gate = nil
    }
    let response = self.response
    let error = self.error
    lock.unlock()
    if let gateToWait { gateToWait.wait() }
    if let error { throw error }
    return response
  }
}

/// A URL-aware scripted transport that records every request, answers a fixed
/// response per URL, and can hold the first request for a chosen URL on a gate so
/// a claimed exchange can be superseded deterministically while it is in flight.
private final class GatedHTTP: VeyraNSIWCTransport {
  private let lock = NSLock()
  private var recorded: [VeyraNSIWCHTTPRequest] = []
  var responses: [String: VeyraNSIWCHTTPResponse] = [:]
  /// When set, the first request whose URL matches `gatedURL` (or any request
  /// when `gatedURL` is nil) waits for this gate before answering.
  var gate: DispatchSemaphore?
  var gatedURL: String?

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return recorded.count
  }

  var urls: [String] {
    lock.lock()
    defer { lock.unlock() }
    return recorded.map { $0.url }
  }

  func send(
    _ request: VeyraNSIWCHTTPRequest,
    timeout: TimeInterval
  ) async throws -> VeyraNSIWCHTTPResponse {
    lock.lock()
    recorded.append(request)
    var gateToWait: DispatchSemaphore?
    if let gate, gatedURL == nil || gatedURL == request.url {
      gateToWait = gate
      self.gate = nil
    }
    let response = responses[request.url]
      ?? VeyraNSIWCHTTPResponse(status: 404, headers: [:], body: Data())
    lock.unlock()
    if let gateToWait { gateToWait.wait() }
    return response
  }
}

/// A thread-safe one-slot holder for an opener's completion closure, so a test
/// can invoke it after the source has become stale.
private final class CompletionHolder {
  private let lock = NSLock()
  private var value: ((Bool) -> Void)?

  func set(_ closure: @escaping (Bool) -> Void) {
    lock.lock()
    value = closure
    lock.unlock()
  }

  var hasValue: Bool {
    lock.lock()
    defer { lock.unlock() }
    return value != nil
  }

  func call(_ success: Bool) {
    lock.lock()
    let closure = value
    lock.unlock()
    closure?(success)
  }
}

/// Run one throwing provider call and return the bounded error it raised.
private func capture(_ body: () async throws -> Void) async -> VeyraNSIWCError? {
  do {
    try await body()
    return nil
  } catch let error as VeyraNSIWCError {
    return error
  } catch {
    return .transportUnavailable
  }
}

/// A synthetic `URLProtocol` serving one scripted response for the fixed
/// official URLs. It exercises the *production* URLSession delegate with real
/// URLSession semantics (headers, chunked arrival, redirect decision,
/// cancellation) and dials nothing.
private final class ScriptedURLProtocol: URLProtocol {
  struct Plan {
    var status = 200
    var headers: [String: String] = [:]
    var chunks: [Data] = []
    var chunkDelay: TimeInterval = 0
    /// An explicit declared `Content-Length` (possibly larger than the body, to
    /// script a truncated response). `nil` declares no length at all.
    var declaredLength: Int?
    var failWith: Error?
  }

  private static let lock = NSLock()
  private static var storedPlan = Plan()
  private static var storedRequests: [URLRequest] = []
  private static var storedStops = 0

  static var plan: Plan {
    get {
      lock.lock()
      defer { lock.unlock() }
      return storedPlan
    }
    set {
      lock.lock()
      storedPlan = newValue
      lock.unlock()
    }
  }

  static var requests: [URLRequest] {
    lock.lock()
    defer { lock.unlock() }
    return storedRequests
  }

  static var stops: Int {
    lock.lock()
    defer { lock.unlock() }
    return storedStops
  }

  static func reset() {
    lock.lock()
    storedPlan = Plan()
    storedRequests = []
    storedStops = 0
    lock.unlock()
  }

  private var stopped = false

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let plan = Self.plan
    Self.lock.lock()
    Self.storedRequests.append(request)
    Self.lock.unlock()
    guard !stopped, let url = request.url else { return }
    if let error = plan.failWith {
      client?.urlProtocol(self, didFailWithError: error)
      return
    }
    var headers = plan.headers
    if let declared = plan.declaredLength {
      headers["Content-Length"] = String(declared)
    }
    guard let response = HTTPURLResponse(
      url: url,
      statusCode: plan.status,
      httpVersion: "HTTP/1.1",
      headerFields: headers
    ) else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    if plan.chunkDelay <= 0 {
      for chunk in plan.chunks {
        guard !stopped else { return }
        client?.urlProtocol(self, didLoad: chunk)
      }
      client?.urlProtocolDidFinishLoading(self)
      return
    }
    deliverChunks(plan, index: 0)
  }

  private func deliverChunks(_ plan: Plan, index: Int) {
    guard !stopped else { return }
    guard index < plan.chunks.count else {
      client?.urlProtocolDidFinishLoading(self)
      return
    }
    client?.urlProtocol(self, didLoad: plan.chunks[index])
    let next = index + 1
    DispatchQueue.global().asyncAfter(deadline: .now() + plan.chunkDelay) { [weak self] in
      self?.deliverChunks(plan, index: next)
    }
  }

  override func stopLoading() {
    stopped = true
    Self.lock.lock()
    Self.storedStops += 1
    Self.lock.unlock()
  }
}

// MARK: - terminal delivery seam + loopback probes

/// A faithful stand-in for the React Native module's auth delivery path.
///
/// The harness links only the Foundation/Core production files — it cannot
/// import `VeyraNSIWCModule` (React/UIKit) — so this reproduces the module's
/// *exact* two-stage path against the **real** production methods: a
/// non-consuming `lifecycle.allowsAuthDelivery(event)` pre-queue gate before the
/// hop, then, at the actual dispatch, the consuming/linearizing
/// `lifecycle.withAuthorizedAuthDelivery(event)` primitive wrapping the
/// synchronous delivery — precisely as `emitAuthEvent` does. It is not a
/// permission facade: the grant *and* the one-time terminal-ticket consumption
/// are decided solely by the production coordinator.
private final class AuthDeliverySeam {
  private let lifecycle: VeyraNSIWCLifecycle
  private let mainQueue: (@escaping () -> Void) -> Void
  private let lock = NSLock()
  private var events: [VeyraNSIWCLifecycle.AuthEvent] = []
  private var observing = true

  init(
    lifecycle: VeyraNSIWCLifecycle,
    mainQueue: @escaping (@escaping () -> Void) -> Void
  ) {
    self.lifecycle = lifecycle
    self.mainQueue = mainQueue
    lifecycle.setAuthHandler { [weak self] event in
      self?.queueAuthDelivery(event)
    }
  }

  var delivered: [VeyraNSIWCLifecycle.AuthEvent] {
    lock.lock()
    defer { lock.unlock() }
    return events
  }

  private func isObserving() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return observing
  }

  /// The module's exact two-stage auth delivery for one event. Exposed so a
  /// test can queue the *same* terminal event twice and prove the single
  /// production primitive still delivers it exactly once.
  func queueAuthDelivery(_ event: VeyraNSIWCLifecycle.AuthEvent) {
    guard lifecycle.allowsAuthDelivery(event), isObserving() else { return }
    mainQueue { [weak self] in
      guard let self else { return }
      self.lifecycle.withAuthorizedAuthDelivery(event) {
        guard self.isObserving() else { return }
        self.lock.lock()
        self.events.append(event)
        self.lock.unlock()
      }
    }
  }
}

/// Bind a real callback server on an ephemeral loopback port and wait for its
/// `ready` callback. Returns `nil` if the bind fails or no port is reported.
private func startRealServer(
  ttl: TimeInterval
) -> (server: VeyraNSIWCCallbackServer, port: Int)? {
  let server = VeyraNSIWCCallbackServer()
  let portBox = ResultBox<Int>()
  server.onReady = { portBox.set(.success($0)) }
  do {
    try server.start(flowTTL: ttl)
  } catch {
    return nil
  }
  guard waitSync(3, { portBox.result != nil }),
    case let .success(port)? = portBox.result
  else { return nil }
  return (server, port)
}

/// A synchronous, bounded poll (used where the test itself must not be async).
private func waitSync(
  _ timeout: TimeInterval,
  _ condition: () -> Bool
) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    Thread.sleep(forTimeInterval: 0.01)
  }
  return condition()
}

/// True when a TCP connection to `127.0.0.1:<port>` is accepted right now. A
/// refused connection (nothing listening) returns false. Loopback only.
private func canConnectLoopback(port: Int) -> Bool {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  var address = sockaddr_in()
  address.sin_family = sa_family_t(AF_INET)
  address.sin_port = UInt16(port).bigEndian
  address.sin_addr.s_addr = inet_addr("127.0.0.1")
  var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  let result = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
      connect(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
  }
  return result == 0
}

/// Send one raw, syntactically exact HTTP GET to `127.0.0.1:<port>` and read the
/// static response. Returns true only when the whole request was written. It
/// dials loopback only and never touches a foreign origin.
@discardableResult
private func sendLoopbackGET(port: Int, path: String, host: String) -> Bool {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  var address = sockaddr_in()
  address.sin_family = sa_family_t(AF_INET)
  address.sin_port = UInt16(port).bigEndian
  address.sin_addr.s_addr = inet_addr("127.0.0.1")
  var timeout = timeval(tv_sec: 2, tv_usec: 0)
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
      connect(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
  }
  guard connected == 0 else { return false }
  let request = "GET \(path) HTTP/1.1\r\nHost: \(host)\r\nConnection: close\r\n\r\n"
  let bytes = Array(request.utf8)
  let sent = bytes.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
  var scratch = [UInt8](repeating: 0, count: 512)
  _ = read(fd, &scratch, scratch.count)
  return sent == bytes.count
}
