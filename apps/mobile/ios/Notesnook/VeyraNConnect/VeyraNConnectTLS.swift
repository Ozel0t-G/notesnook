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

// The one outgoing HTTPS transport to the loopback broker, pinned to the paired
// identity.
//
// The broker is a separate foreground Node process bound to `127.0.0.1`. It
// presents a self-signed leaf signed by a dedicated self-signed root that is
// never in the system trust store, so this client trusts *only* the paired root
// (`anchorOnly: true`) and *additionally* requires the presented leaf's DER
// SHA-256 to equal the paired pin. A foreign process that owns the port is
// rejected during the TLS handshake, before any `Authorization`, `Host` or body
// byte is written. There is no `rejectUnauthorized:false`, no unconditional
// trust and no system-CA fallback.
//
// The session is ephemeral: no cookies, no cache, no proxy and no redirects.
// Responses are read incrementally through the data delegate and bounded to
// `maxResponseBytes` (5 MiB), so a hostile or buggy peer cannot make this client
// buffer an unbounded body before the size check. `Content-Encoding` other than
// `identity` is refused before any body byte is accepted, and the request asks
// for `identity` so a compressed body is never delivered at all.

import CryptoKit
import Foundation
import Security

enum VeyraNConnectTLS {
  /// SHA-256 of a certificate's DER bytes, lower-case hex (64 chars).
  static func pin(der: Data) -> String {
    SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
  }

  /// True when the presented leaf DER hashes to exactly the paired pin. The
  /// parameter is named `expectedPin` so it never shadows the static `pin(der:)`
  /// it calls.
  static func pinMatches(der: Data, pin expectedPin: String) -> Bool {
    Self.pin(der: der) == expectedPin
  }

  /// Parse a PEM document into the certificate chain it carries. Returns `nil`
  /// when any block cannot be parsed, so a malformed root fails closed.
  /// The complete production verification, factored out so the standalone
  /// harness can drive it with a real chain and a real `SecTrust`.
  ///
  /// 1. an SSL policy for the literal loopback host;
  /// 2. anchors = *only* the paired root (`anchorOnly: true`);
  /// 3. chain + validity-time evaluation;
  /// 4. the presented leaf's DER SHA-256 must equal the pin.
  static func evaluate(
    trust: SecTrust,
    anchors: [SecCertificate],
    host: String,
    leafPin: String
  ) -> Bool {
    guard host == VeyraNConnectWire.loopbackHost else { return false }
    // `SecPolicyCreateSSL` is non-optional on this SDK. A failure to set the
    // policy/anchor state fails closed below.
    let policy = SecPolicyCreateSSL(true, host as CFString)
    guard SecTrustSetPolicies(trust, policy) == errSecSuccess else { return false }
    guard SecTrustSetAnchorCertificates(trust, anchors as CFArray) == errSecSuccess
    else { return false }
    guard SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
    else { return false }

    var error: CFError?
    guard SecTrustEvaluateWithError(trust, &error) else { return false }

    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first
    else { return false }
    return pinMatches(der: SecCertificateCopyData(leaf) as Data, pin: leafPin)
  }

  static func certificates(pem: String) -> [SecCertificate]? {
    var certificates: [SecCertificate] = []
    let marker = "-----BEGIN CERTIFICATE-----"
    let endMarker = "-----END CERTIFICATE-----"
    var remaining = Substring(pem)
    while let start = remaining.range(of: marker) {
      guard let end = remaining.range(of: endMarker, range: start.upperBound..<remaining.endIndex)
      else { return nil }
      let body = remaining[start.upperBound..<end.lowerBound]
        .components(separatedBy: .whitespacesAndNewlines)
        .joined()
      remaining = remaining[end.upperBound...]
      guard let der = Data(base64Encoded: body),
        let certificate = SecCertificateCreateWithData(nil, der as CFData)
      else { return nil }
      certificates.append(certificate)
    }
    return certificates.isEmpty ? nil : certificates
  }
}

/// Per-task accumulation for the delegate-driven body reader. Guarded by the
/// transport's own lock.
private final class VeyraNConnectPendingResponse {
  var data = Data()
  var continuation: CheckedContinuation<Data, Error>?
  var finished = false
}

final class VeyraNConnectURLSessionTransport: NSObject, URLSessionDataDelegate,
  VeyraNConnectTransport
{
  private let pairing: VeyraNConnectPairing
  private let baseURL: URL
  private let anchors: [SecCertificate]
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    // An empty proxy dictionary means "use no proxy": never route loopback
    // traffic through a user- or system-configured proxy.
    configuration.connectionProxyDictionary = [:]
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = 15
    return URLSession(
      configuration: configuration,
      delegate: self,
      delegateQueue: nil
    )
  }()

  /// Set when this transport's trust evaluation refused the handshake, so the
  /// caller can surface a truthful TLS failure instead of a generic one.
  private let stateLock = NSLock()
  private var handshakeRejected = false
  private var pending: [Int: VeyraNConnectPendingResponse] = [:]

  /// Run `body` while holding the lock. Never call this across an `await`; the
  /// synchronous helper keeps the lock out of the async context so no lock is
  /// ever held through a suspension.
  @inline(__always)
  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    stateLock.lock()
    defer { stateLock.unlock() }
    return try body()
  }

  init(pairing: VeyraNConnectPairing) throws {
    guard let base = VeyraNConnectValidate.url(port: pairing.port),
      let anchors = VeyraNConnectTLS.certificates(pem: pairing.rootPem)
    else { throw VeyraNConnectError.pairingInvalid }
    self.pairing = pairing
    self.baseURL = base
    self.anchors = anchors
    super.init()
  }

  func send(path: String, body: Data, timeout: TimeInterval) async throws -> Data {
    guard let url = URL(string: baseURL.absoluteString + path) else {
      throw VeyraNConnectError.responseInvalid
    }
    let limit =
      path == "/v1/reply"
      ? VeyraNConnectWire.maxReplyBytes
      : VeyraNConnectWire.maxRequestBytes
    guard body.count <= limit else { throw VeyraNConnectError.responseInvalid }

    var request = URLRequest(
      url: url,
      cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
      timeoutInterval: timeout
    )
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    // Ask for an uncompressed body: a `Content-Encoding` other than `identity`
    // is refused below, and requesting `identity` avoids decompression entirely.
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    // The credential travels only in this header, never in the URL.
    request.setValue(pairing.bearerToken, forHTTPHeaderField: "Authorization")
    // Deliberately no `Origin` header. URLSession sets the exact `Host` header.

    withLock { handshakeRejected = false }

    do {
      let data = try await perform(request)
      guard data.count <= VeyraNConnectWire.maxResponseBytes else {
        throw VeyraNConnectError.responseInvalid
      }
      // Strict UTF-8: a body that is not decodable as UTF-8 is not JSON.
      guard String(data: data, encoding: .utf8) != nil else {
        throw VeyraNConnectError.responseInvalid
      }
      return data
    } catch let error as VeyraNConnectError {
      if withLock({ handshakeRejected }) { throw VeyraNConnectError.tlsRejected }
      throw error
    } catch {
      throw withLock({ handshakeRejected })
        ? VeyraNConnectError.tlsRejected
        : VeyraNConnectError.transportUnavailable
    }
  }

  private func perform(_ request: URLRequest) async throws -> Data {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Data, Error>) in
      let task = session.dataTask(with: request)
      let entry = VeyraNConnectPendingResponse()
      entry.continuation = continuation
      withLock { pending[task.taskIdentifier] = entry }
      task.resume()
    }
  }

  // MARK: URLSessionDelegate

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?)
      -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod
      == NSURLAuthenticationMethodServerTrust,
      VeyraNConnectValidate.isLoopbackHost(challenge.protectionSpace.host),
      let trust = challenge.protectionSpace.serverTrust
    else {
      reject(completionHandler)
      return
    }
    guard evaluate(trust) else {
      reject(completionHandler)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  /// No redirect is ever followed: a 3xx would let the broker (or an impostor
  /// that somehow passed the pin) move the request to another target.
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  // MARK: URLSessionDataDelegate

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else {
      finish(taskIdentifier: dataTask.taskIdentifier, error: .responseInvalid)
      completionHandler(.cancel)
      return
    }
    guard (200...299).contains(http.statusCode) else {
      finish(taskIdentifier: dataTask.taskIdentifier, error: .responseInvalid)
      completionHandler(.cancel)
      return
    }
    // A compressed response is refused BEFORE any body byte is accepted; we
    // never hand a decompressor an unbounded stream.
    if let encoding = http.value(forHTTPHeaderField: "Content-Encoding"),
      encoding.lowercased() != "identity"
    {
      finish(taskIdentifier: dataTask.taskIdentifier, error: .responseInvalid)
      completionHandler(.cancel)
      return
    }
    // A declared Content-Length over the bound is refused before the body.
    if http.expectedContentLength > Int64(VeyraNConnectWire.maxResponseBytes) {
      finish(taskIdentifier: dataTask.taskIdentifier, error: .responseInvalid)
      completionHandler(.cancel)
      return
    }
    completionHandler(.allow)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive data: Data
  ) {
    stateLock.lock()
    guard let entry = pending[dataTask.taskIdentifier], !entry.finished else {
      stateLock.unlock()
      return
    }
    entry.data.append(data)
    let overBound = entry.data.count > VeyraNConnectWire.maxResponseBytes
    stateLock.unlock()
    if overBound {
      // Abort the transfer the moment the running buffer exceeds the bound: a
      // chunked/undisclosed-length response can never grow this process.
      finish(taskIdentifier: dataTask.taskIdentifier, error: .responseInvalid)
      dataTask.cancel()
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    if let error {
      finish(
        taskIdentifier: task.taskIdentifier,
        error: (error as? VeyraNConnectError) ?? VeyraNConnectError.transportUnavailable
      )
    } else {
      finish(taskIdentifier: task.taskIdentifier, error: nil)
    }
  }

  /// Complete exactly once per task, either with the bounded body or an error.
  private func finish(taskIdentifier: Int, error: VeyraNConnectError?) {
    stateLock.lock()
    guard let entry = pending.removeValue(forKey: taskIdentifier), !entry.finished
    else {
      stateLock.unlock()
      return
    }
    entry.finished = true
    let continuation = entry.continuation
    let data = entry.data
    stateLock.unlock()
    guard let continuation else { return }
    if let error {
      continuation.resume(throwing: error)
    } else {
      continuation.resume(returning: data)
    }
  }

  private func reject(
    _ completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?)
      -> Void
  ) {
    stateLock.lock()
    handshakeRejected = true
    stateLock.unlock()
    completionHandler(.cancelAuthenticationChallenge, nil)
  }

  /// Full verification: build the SSL policy for the literal loopback host,
  /// anchor *only* to the paired root, evaluate chain + validity time, and
  /// finally require the exact pinned leaf. Any step failing rejects.
  private func evaluate(_ trust: SecTrust) -> Bool {
    return VeyraNConnectTLS.evaluate(
      trust: trust,
      anchors: anchors,
      host: VeyraNConnectWire.loopbackHost,
      leafPin: pairing.leafPin
    )
  }
}
