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

// The production `URLSession` transports for the SIWC provider.
//
// Exactly two adapters are provided:
//   - a bounded request/response transport for the token, JWKS, discovery and
//     models endpoints, and
//   - a *dedicated* incremental data-delegate streaming transport for the
//     Responses SSE endpoint (never the JS/RCTNetworking/EventSource path, and
//     never `db.connectSSE`).
//
// Both pin the fixed official HTTPS endpoints: a request whose URL is not one
// of the fixed origins/paths is refused before any byte is written. Proxies,
// cookies and redirects are disabled and the default system TLS validation is
// used (no custom trust, no Notesnook server URL is ever dialed).
//
// **Bounded before allocation.** The request/response transport is an
// incremental `URLSessionDataDelegate`: the declared `Content-Length`, the
// decoded header block and *every* body chunk are checked against the byte
// bound *before* they are retained, so an oversized (or hostile, or
// decompression-bomb) response aborts the task instead of being buffered first
// and validated afterwards.
//
// **Absolute deadline.** The caller's `timeout` (15s for discovery/revocation,
// 30s for token/JWKS/models) is enforced as a hard wall-clock deadline in
// addition to the `URLRequest` inactivity timeout, so a slow trickle cannot hold
// a request open indefinitely. The continuation is resumed exactly once, and a
// cancelled Swift task cancels the underlying URLSession task.
//
// The session configuration and delegate queue are injectable so the harness can
// drive the *actual* production delegate with a synthetic `URLProtocol` and the
// fixed official URLs — never a live network call and never a test-only
// fallback inside production code.

import Foundation

// MARK: - Fixed endpoint guard

enum VeyraNSIWCFixedEndpoints {
  static let allowed: Set<String> = [
    VeyraNSIWC.authorizeEndpoint,
    VeyraNSIWC.tokenEndpoint,
    VeyraNSIWC.jwksEndpoint,
    VeyraNSIWC.discoveryEndpoint,
    VeyraNSIWC.modelsEndpoint,
    VeyraNSIWC.responsesEndpoint
  ]

  static func allows(_ url: String) -> Bool {
    if allowed.contains(url) { return true }
    // The revocation endpoint is the only runtime value, and it is validated
    // against the fixed authorization origin before it gets here.
    return VeyraNSIWCValidate.discoveryEndpoint(url) != nil
  }
}

private enum VeyraNSIWCTransportConfig {
  static func ephemeral() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.connectionProxyDictionary = [:]
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.waitsForConnectivity = false
    return configuration
  }
}

/// Refuses every redirect: the fixed endpoints never legitimately redirect, and
/// following one would let an intermediary move the request to another origin.
private final class VeyraNSIWCNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

// MARK: - Request / response

final class VeyraNSIWCURLSessionTransport: VeyraNSIWCTransport {
  /// The injected session configuration (tests register a synthetic
  /// `URLProtocol` here). The production default is the hardened ephemeral
  /// configuration: no cookies, no proxy, no cache, no connectivity wait.
  private let configuration: URLSessionConfiguration?
  private let delegateQueue: OperationQueue?
  /// The maximum decoded response body the transport ever retains. The provider
  /// re-validates every endpoint's own smaller bound on top of this.
  private let maxBytes: Int

  init(
    configuration: URLSessionConfiguration? = nil,
    delegateQueue: OperationQueue? = nil,
    maxBytes: Int = VeyraNSIWC.maxModelsBytes
  ) {
    self.configuration = configuration
    self.delegateQueue = delegateQueue
    self.maxBytes = maxBytes
  }

  func send(
    _ request: VeyraNSIWCHTTPRequest,
    timeout: TimeInterval
  ) async throws -> VeyraNSIWCHTTPResponse {
    guard VeyraNSIWCFixedEndpoints.allows(request.url),
      let url = URL(string: request.url)
    else { throw VeyraNSIWCError.transportUnavailable }
    guard timeout > 0, timeout.isFinite else {
      throw VeyraNSIWCError.transportUnavailable
    }
    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = request.method
    // The inactivity timeout is kept *and* the same value is enforced as an
    // absolute wall-clock deadline by the delegate: a slow trickle that keeps
    // resetting the inactivity timer can no longer keep the request alive.
    urlRequest.timeoutInterval = timeout
    urlRequest.httpBody = request.body
    for (name, value) in request.headers {
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }

    let delegate = VeyraNSIWCBoundedRequestDelegate(
      maxBytes: maxBytes,
      absoluteTimeout: timeout
    )
    let session = URLSession(
      configuration: configuration ?? VeyraNSIWCTransportConfig.ephemeral(),
      delegate: delegate,
      delegateQueue: delegateQueue
    )
    let task = session.dataTask(with: urlRequest)
    do {
      return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          // The continuation is attached *before* the task is resumed and is
          // resumed exactly once, from one of the delegate callbacks.
          delegate.attach(continuation: continuation, session: session, task: task)
          task.resume()
        }
      } onCancel: {
        delegate.cancel()
      }
    } catch let error as VeyraNSIWCError {
      throw error
    } catch {
      throw VeyraNSIWCError.transportUnavailable
    }
  }
}

/// The bounded, redirect-refusing data delegate behind one request.
///
/// It owns the whole response budget: header bytes, the declared content length
/// and the accumulated decoded body. Every bound is enforced *before* the bytes
/// are retained, and the task is aborted the moment a bound is exceeded.
private final class VeyraNSIWCBoundedRequestDelegate: NSObject, URLSessionDataDelegate {
  private let maxBytes: Int
  private let absoluteTimeout: TimeInterval

  private let lock = NSLock()
  // Guarded by `lock`.
  private var continuation: CheckedContinuation<VeyraNSIWCHTTPResponse, Error>?
  private var session: URLSession?
  private var task: URLSessionDataTask?
  private var deadline: DispatchWorkItem?
  private var data = Data()
  private var headers: [String: String] = [:]
  private var status = 0
  private var expectedLength: Int64 = -1
  /// True when the response declared a real content encoding: the delegate
  /// receives the body *decoded*, while `expectedLength` describes the encoded
  /// wire size, so the decoded length may legitimately be smaller.
  private var contentEncoded = false
  private var finished = false
  private var cancelled = false
  private var startedAt: Date?

  init(maxBytes: Int, absoluteTimeout: TimeInterval) {
    self.maxBytes = maxBytes
    self.absoluteTimeout = absoluteTimeout
  }

  func attach(
    continuation: CheckedContinuation<VeyraNSIWCHTTPResponse, Error>,
    session: URLSession,
    task: URLSessionDataTask
  ) {
    lock.lock()
    self.continuation = continuation
    self.session = session
    self.task = task
    self.startedAt = Date()
    let alreadyCancelled = cancelled
    let item = DispatchWorkItem { [weak self] in
      self?.fail()
    }
    deadline = item
    let timeout = absoluteTimeout
    lock.unlock()
    if alreadyCancelled {
      fail()
      return
    }
    // The absolute deadline fires even when no further byte and no error is ever
    // delivered (a slow trickle, a stalled socket).
    DispatchQueue.global(qos: .utility).asyncAfter(
      deadline: .now() + timeout,
      execute: item
    )
  }

  /// Cancel from the consuming Swift task.
  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
    fail()
  }

  // MARK: bounds

  private func hasExpiredLocked() -> Bool {
    guard let startedAt else { return false }
    return Date().timeIntervalSince(startedAt) >= absoluteTimeout
  }

  // MARK: delegate

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      fail()
      return
    }
    if expired() {
      completionHandler(.cancel)
      fail()
      return
    }
    // Bound the *decoded* header block before any body byte is retained.
    var collected: [String: String] = [:]
    var headerBytes = 0
    for (key, value) in http.allHeaderFields {
      guard let key = key as? String, let value = value as? String else { continue }
      headerBytes += key.utf8.count + value.utf8.count
      guard headerBytes <= VeyraNSIWC.maxResponseHeaderBytes,
        collected.count < VeyraNSIWC.maxResponseHeaders
      else {
        completionHandler(.cancel)
        fail()
        return
      }
      collected[key] = value
    }
    // Bound the *declared* body length before the first chunk arrives. A
    // compressed response declares (at most) its compressed size here; the
    // decoded bytes are bounded chunk-by-chunk below.
    let declared = http.expectedContentLength
    guard declared < 0 || declared <= Int64(maxBytes) else {
      completionHandler(.cancel)
      fail()
      return
    }

    lock.lock()
    status = http.statusCode
    headers = collected
    expectedLength = declared
    contentEncoded = Self.declaresContentEncoding(collected)
    lock.unlock()
    completionHandler(.allow)
  }

  /// True when the response headers declare a real (non-`identity`) content
  /// encoding. `Content-Encoding` is matched case-insensitively because the
  /// header dictionary is not guaranteed to preserve the wire casing.
  private static func declaresContentEncoding(_ headers: [String: String]) -> Bool {
    for (key, value) in headers
    where key.caseInsensitiveCompare("Content-Encoding") == .orderedSame {
      let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
      return !normalized.isEmpty && normalized != "identity"
    }
    return false
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive chunk: Data
  ) {
    lock.lock()
    // The bound is checked *before* the bytes are retained: an oversized chunk
    // is never appended to the buffer.
    let fits = chunk.count <= maxBytes && self.data.count <= maxBytes - chunk.count
    let expired = hasExpiredLocked()
    if fits && !expired {
      self.data.append(chunk)
    }
    lock.unlock()
    if !fits || expired {
      fail()
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    lock.lock()
    if finished {
      lock.unlock()
      return
    }
    let status = self.status
    let data = self.data
    let headers = self.headers
    let expectedLength = self.expectedLength
    let contentEncoded = self.contentEncoded
    let expired = hasExpiredLocked()
    lock.unlock()

    // Any transport error — including a dropped/truncated connection — is a
    // failure, never a partial success.
    if error != nil || expired || status == 0 {
      fail()
      return
    }
    // A truncated body (fewer decoded bytes than the declared length) is never
    // accepted as a complete response — but only when the response is *not*
    // content-encoded. A compressed response declares its encoded wire length in
    // `Content-Length` while the delegate receives the decoded bytes, so the
    // decoded length may legitimately be smaller; the decoded byte bound is
    // still enforced chunk-by-chunk above, and a compressed transport error is
    // still a failure here.
    if !contentEncoded, expectedLength > 0, Int64(data.count) < expectedLength {
      fail()
      return
    }
    succeed(VeyraNSIWCHTTPResponse(status: status, headers: headers, body: data))
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // A redirect is never followed: the 3xx response itself is surfaced so every
    // caller fails closed on a non-200.
    completionHandler(nil)
  }

  // MARK: exactly-once completion

  private func expired() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return hasExpiredLocked()
  }

  /// Abort with the single bounded transport failure.
  private func fail() {
    finish(returning: nil)
  }

  private func succeed(_ response: VeyraNSIWCHTTPResponse) {
    finish(returning: response)
  }

  private func finish(returning response: VeyraNSIWCHTTPResponse?) {
    lock.lock()
    guard !finished, let continuation else {
      lock.unlock()
      return
    }
    finished = true
    deadline?.cancel()
    deadline = nil
    let session = self.session
    let task = self.task
    self.session = nil
    self.task = nil
    self.continuation = nil
    // The continuation is resumed *after* the lock is released: the resumed task
    // must never be able to re-enter the delegate while the lock is held.
    lock.unlock()
    task?.cancel()
    if let response {
      session?.finishTasksAndInvalidate()
      continuation.resume(returning: response)
    } else {
      session?.invalidateAndCancel()
      continuation.resume(throwing: VeyraNSIWCError.transportUnavailable)
    }
  }
}

// MARK: - Streaming

/// A dedicated streaming transport. It hands the exact, decompressed SSE body
/// chunks to the provider, which owns every bound. It also surfaces a non-200
/// status as a typed failure carrying only a bounded, catalogued provider code.
final class VeyraNSIWCURLSessionStreamingTransport: NSObject, VeyraNSIWCStreamingTransport {
  private let noRedirect = VeyraNSIWCNoRedirectDelegate()

  func stream(_ request: VeyraNSIWCHTTPRequest) -> AsyncThrowingStream<Data, Error> {
    AsyncThrowingStream { continuation in
      guard VeyraNSIWCFixedEndpoints.allows(request.url),
        let url = URL(string: request.url)
      else {
        continuation.finish(throwing: VeyraNSIWCError.transportUnavailable)
        return
      }
      var urlRequest = URLRequest(url: url)
      urlRequest.httpMethod = request.method
      urlRequest.timeoutInterval = 30
      urlRequest.httpBody = request.body
      for (name, value) in request.headers {
        urlRequest.setValue(value, forHTTPHeaderField: name)
      }

      let delegate = VeyraNSIWCStreamDelegate(continuation: continuation)
      let configuration = VeyraNSIWCTransportConfig.ephemeral()
      // A hard total wallclock bound: the resource timeout fires even when the
      // server stalls between chunks, so the provider's 120s limit does not
      // depend on receiving more data.
      configuration.timeoutIntervalForResource = VeyraNSIWC.streamWallclockSeconds
      let session = URLSession(
        configuration: configuration,
        delegate: delegate,
        delegateQueue: nil
      )
      delegate.session = session
      delegate.noRedirect = noRedirect
      let task = session.dataTask(with: urlRequest)
      delegate.task = task
      continuation.onTermination = { _ in
        task.cancel()
        session.invalidateAndCancel()
      }
      task.resume()
    }
  }
}

private final class VeyraNSIWCStreamDelegate: NSObject, URLSessionDataDelegate {
  private let continuation: AsyncThrowingStream<Data, Error>.Continuation
  private var status = 0
  private var errorBody = Data()
  private var finished = false
  var task: URLSessionDataTask?
  var session: URLSession?
  var noRedirect: VeyraNSIWCNoRedirectDelegate?

  init(continuation: AsyncThrowingStream<Data, Error>.Continuation) {
    self.continuation = continuation
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    status = (response as? HTTPURLResponse)?.statusCode ?? 0
    completionHandler(status == 200 ? .allow : .allow)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive data: Data
  ) {
    if status == 200 {
      continuation.yield(data)
    } else if errorBody.count + data.count <= 64 * 1024 {
      errorBody.append(data)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    finish()
    if let error {
      continuation.finish(throwing: error)
      return
    }
    if status != 200 {
      continuation.finish(throwing: VeyraNSIWCProviderFailure(
        status: status,
        providerCode: VeyraNSIWCProviderBody.errorCode(errorBody)
      ))
      return
    }
    continuation.finish()
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  private func finish() {
    if finished { return }
    finished = true
    session?.finishTasksAndInvalidate()
  }
}

/// Extract only a bounded, catalogued provider error code from a small error
/// body. Nothing else is ever surfaced.
enum VeyraNSIWCProviderBody {
  static func errorCode(_ data: Data) -> String? {
    guard !data.isEmpty, data.count <= 64 * 1024 else { return nil }
    guard let value = try? JSONSerialization.jsonObject(
      with: data,
      options: [.fragmentsAllowed]
    ), let object = value as? [String: Any]
    else { return nil }
    let code: String?
    if let error = object["error"] as? [String: Any] {
      code = error["code"] as? String
    } else {
      code = object["code"] as? String
    }
    guard let code, code.utf8.count <= 128 else { return nil }
    return code
  }
}
