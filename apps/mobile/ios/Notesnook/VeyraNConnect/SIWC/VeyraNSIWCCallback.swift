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

// The loopback OAuth callback listener and its strict HTTP parser.
//
// A real `NWListener` is bound to IPv4 `127.0.0.1` only, on an ephemeral port,
// and is `ready` *before* the caller opens the system browser. Every incoming
// request is parsed by a bounded, allocation-light parser that refuses a
// non-GET request, a wrong path, a `Host` that is not exactly
// `127.0.0.1:<port>`, a header-folding/duplicate/pipelined request, a request
// that exceeds 16 KiB of headers or 32 KiB total, and any malformed percent
// encoding or duplicate query parameter.
//
// The response body is a *static* HTML document with no interpolation: the
// `state`, `code` and any provider error are never echoed back to the browser.
//
// An *invalid* request never reaches the flow owner, so it can never consume a
// genuine pending flow. A *parse-valid* callback is handed to the owner, which
// decides: acceptance (the owner cancels this listener) or rejection (wrong
// state, missing code, foreign client id — the listener is left live for the
// genuine callback). `cancel` stops the listener, every open connection and
// every deadline. The listener emits at most one *report* over its lifetime: the
// flow-TTL expiry (`onExpiry`) or a listener failure (`onFailure`). An owner
// `cancel()` is silent and is the *only* thing that disarms a pending report —
// so a callback the owner rejected can never suppress the remaining TTL, and an
// abandoned flow always ends with exactly one bounded terminal.
//
// This file imports only Foundation and Network (no UIKit/React), so the parser
// is exercised by the standalone harness and only the listener path needs a
// real socket.

import Foundation
import Network

#if canImport(Network)

// MARK: - Parsed request

enum VeyraNSIWCCallbackRequest: Equatable {
  /// A fully valid callback carrying the exact query parameter map.
  case valid([String: String])
  /// A refused request. The associated error is the bounded reason; the
  /// response is always the same static HTML.
  case invalid(VeyraNSIWCError)
}

enum VeyraNSIWCCallbackParser {
  private static let crlf = Data([0x0D, 0x0A])
  private static let terminator = Data([0x0D, 0x0A, 0x0D, 0x0A])

  /// Parse one complete HTTP request for `expectedPort`. The input must contain
  /// the whole request (header block); a trailing body or a second pipelined
  /// request is refused.
  static func parse(_ data: Data, expectedPort: Int) -> VeyraNSIWCCallbackRequest {
    guard !data.isEmpty, data.count <= VeyraNSIWC.maxRequestBytes else {
      return .invalid(.callbackInvalid)
    }
    guard let terminatorRange = data.range(of: terminator) else {
      return .invalid(.callbackInvalid)
    }
    let headerBlock = data.subdata(in: data.startIndex..<terminatorRange.lowerBound)
    // Anything after the header terminator is a body (or a pipelined request).
    guard terminatorRange.upperBound == data.endIndex else {
      return .invalid(.callbackInvalid)
    }
    guard headerBlock.count <= VeyraNSIWC.maxHeaderBytes else {
      return .invalid(.callbackInvalid)
    }

    let lines = splitLines(headerBlock)
    guard let requestLine = lines.first else { return .invalid(.callbackInvalid) }

    // A folded header line (leading SP/HTAB) is refused anywhere in the block.
    for line in lines where !line.isEmpty {
      if line.first == " " || line.first == "\t" {
        return .invalid(.callbackInvalid)
      }
    }

    let parts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return .invalid(.callbackInvalid) }
    guard parts[0] == "GET" else { return .invalid(.callbackInvalid) }
    guard parts[2] == "HTTP/1.1" || parts[2] == "HTTP/1.0" else {
      return .invalid(.callbackInvalid)
    }
    let target = String(parts[1])
    guard !target.contains("#"), target.hasPrefix("/") else {
      return .invalid(.callbackInvalid)
    }

    let pathAndQuery = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let path = String(pathAndQuery[0])
    guard path == VeyraNSIWC.callbackPath else {
      return .invalid(.callbackInvalid)
    }
    let query = pathAndQuery.count == 2 ? String(pathAndQuery[1]) : ""

    // Headers: no duplicates, no folding, no hop-by-hop surprises.
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard !line.isEmpty else { continue }
      guard let colon = line.firstIndex(of: ":") else {
        return .invalid(.callbackInvalid)
      }
      let name = String(line[line.startIndex..<colon]).lowercased()
      let value = String(line[line.index(after: colon)...])
        .trimmingCharacters(in: .whitespaces)
      guard !name.isEmpty, !name.contains(" ") else {
        return .invalid(.callbackInvalid)
      }
      guard headers[name] == nil else { return .invalid(.callbackInvalid) }
      // A refused hop-by-hop/body framing header.
      if name == "transfer-encoding" || name == "content-length" {
        return .invalid(.callbackInvalid)
      }
      headers[name] = value
    }

    // Exact Host including the ephemeral port.
    guard let host = headers["host"], host == "\(VeyraNSIWC.callbackHost):\(expectedPort)"
    else { return .invalid(.callbackInvalid) }

    guard let params = parseQuery(query) else { return .invalid(.callbackInvalid) }
    return .valid(params)
  }

  private static func splitLines(_ block: Data) -> [String] {
    guard let text = String(data: block, encoding: .utf8) else { return [] }
    return text.components(separatedBy: "\r\n")
  }

  /// Parse `k=v&k=v`, refusing a duplicate key, a missing `=`, an empty key and
  /// any malformed percent-escape. Keys are compared case-sensitively.
  private static func parseQuery(_ query: String) -> [String: String]? {
    if query.isEmpty { return [:] }
    var out: [String: String] = [:]
    for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
      let fields = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard fields.count == 2 else { return nil }
      guard let key = percentDecode(String(fields[0])), !key.isEmpty else {
        return nil
      }
      guard let value = percentDecode(String(fields[1])) else { return nil }
      guard out[key] == nil else { return nil }
      out[key] = value
    }
    return out
  }

  static func percentDecode(_ value: String) -> String? {
    guard value.contains("%") || value.contains("+") else { return value }
    var bytes: [UInt8] = []
    let scalars = Array(value.utf8)
    var index = 0
    while index < scalars.count {
      let byte = scalars[index]
      if byte == 0x25 { // '%'
        guard index + 2 < scalars.count,
          let high = hexValue(scalars[index + 1]),
          let low = hexValue(scalars[index + 2])
        else { return nil }
        bytes.append((high << 4) | low)
        index += 3
      } else if byte == 0x2B { // '+' is a literal plus in a query string
        bytes.append(0x2B)
        index += 1
      } else {
        bytes.append(byte)
        index += 1
      }
    }
    return String(bytes: bytes, encoding: .utf8)
  }

  private static func hexValue(_ byte: UInt8) -> UInt8? {
    switch byte {
    case 0x30...0x39: return byte - 0x30
    case 0x41...0x46: return byte - 0x41 + 10
    case 0x61...0x66: return byte - 0x61 + 10
    default: return nil
    }
  }
}

// MARK: - Static response

enum VeyraNSIWCCallbackResponse {
  /// A fixed document. It never carries a state, code or provider error, and it
  /// claims **no** authentication success: the code exchange and the JWT
  /// verification are still in flight (and a syntactically valid but wrong-state
  /// callback receives the same body). It truthfully says only that the request
  /// was received and VeyraN is checking it.
  static let ok = """
    <!doctype html><html><head><meta charset="utf-8">\
    <title>VeyraN</title></head><body>\
    <p>Anfrage empfangen. VeyraN prueft die Anmeldung. Du kannst dieses Fenster \
    schliessen und zu VeyraN zurueckkehren.</p></body></html>
    """
  static let invalid = """
    <!doctype html><html><head><meta charset="utf-8">\
    <title>VeyraN</title></head><body>\
    <p>Diese Anfrage wurde abgelehnt.</p></body></html>
    """

  static func httpResponse(_ body: String) -> Data {
    let bytes = Data(body.utf8)
    let head = """
      HTTP/1.1 200 OK\r
      Content-Type: text/html; charset=utf-8\r
      Content-Length: \(bytes.count)\r
      Cache-Control: no-store\r
      Connection: close\r
      \r

      """
    return Data(head.utf8) + bytes
  }
}

// MARK: - Listener

/// A single-use loopback listener for one auth flow. It is `ready` (and its
/// ephemeral port known) before the owner opens the browser; it hands every
/// parse-valid callback to the owner and keeps running through any number of
/// invalid or owner-rejected requests until the owner cancels it at flow end
/// (acceptance) or its own TTL reports the abandoned flow.
///
/// Admission is **serialized and monotonic**: `start`/`cancel` are linearized by
/// one lock, a `cancel` sets a synchronous fence that a later (or racing)
/// `start` observes, and a second `start` is refused. A `cancel` therefore can
/// never be lost to an in-flight `start`, and a cancel-before-start can never be
/// revived into a permanent live listener. All shared state is touched only
/// under the lock (or on the listener's own serial queue), so the caller thread
/// and the listener callbacks can never race a reassignment.
final class VeyraNSIWCCallbackServer {
  private let queue = DispatchQueue(label: "veyran.siwc.callback")
  private let lock = NSLock()

  // Guarded by `lock`.
  private var listener: NWListener?
  private var connections: [ObjectIdentifier: NWConnection] = [:]
  private var deadlines: [ObjectIdentifier: DispatchWorkItem] = [:]
  private var flowDeadline: DispatchWorkItem?
  private var canceled = false
  private var admitted = false
  /// A terminal report (expiry or failure) was already emitted exactly once.
  private var reported = false

  /// Called once the listener is bound, with the ephemeral port.
  var onReady: ((Int) -> Void)?
  /// Called for each fully valid callback. A wrong-state / missing-code /
  /// foreign-client query is parse-valid too — only the owner can reject it —
  /// so the owner must `cancel()` the server once it *accepts* a callback. A
  /// rejected callback leaves the listener (and its TTL) live for the genuine
  /// one, so this may be delivered more than once per listener.
  var onValid: (([String: String]) -> Void)?
  /// Called exactly once when the flow TTL elapses without the owner canceling
  /// the listener — with or without a callback the owner rejected in between.
  /// The owner treats it as the abandoned-flow terminal (`flow_expired`); it is
  /// *not* an owner cancel.
  var onExpiry: (() -> Void)?
  /// Called exactly once when the listener fails on its own (a bind/accept
  /// failure) without the owner canceling it. An owner `cancel()` is silent and
  /// never reports a failure.
  var onFailure: (() -> Void)?

  func start(flowTTL: TimeInterval) throws {
    // Single-use admission. A prior cancel is observed under the same lock, and
    // a second start (including one after a cancel) is refused.
    lock.lock()
    if canceled || admitted {
      lock.unlock()
      throw VeyraNSIWCError.transportUnavailable
    }
    admitted = true
    lock.unlock()

    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    // Force the local endpoint to the IPv4 loopback literal so nothing else can
    // even connect. Port `.any` asks the kernel for an ephemeral port.
    params.requiredLocalEndpoint = .hostPort(
      host: .ipv4(.loopback),
      port: .any
    )
    let listener = try NWListener(using: params)

    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        // Never report `ready` for a server that was canceled before/while it
        // bound: the caller must not open a browser for a dead listener.
        self.lock.lock()
        let port = self.listener?.port?.rawValue
        let canceled = self.canceled
        self.lock.unlock()
        if canceled { return }
        if let port { self.onReady?(Int(port)) }
      case .failed:
        // A listener failure is a transport failure, never an owner cancel.
        self.fail()
      case .cancelled:
        // Reached only through our own `cancel()`/teardown (which already set the
        // fence); it is silent and never reports a failure.
        self.cancel()
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }

    // Publish the listener and start it under the lock: a `cancel` that won the
    // admission in the meantime is observed here and the listener is torn down
    // instead of being started (so no deadline is ever scheduled for it). The
    // start call is non-blocking and never re-enters the lock.
    lock.lock()
    if canceled {
      lock.unlock()
      listener.cancel()
      return
    }
    self.listener = listener
    let deadline = DispatchWorkItem { [weak self] in self?.expire() }
    flowDeadline = deadline
    listener.start(queue: queue)
    lock.unlock()

    // A flow that is never completed stops listening at its TTL and reports the
    // one bounded expiry (never a silent cancel).
    queue.asyncAfter(deadline: .now() + flowTTL, execute: deadline)
  }

  func cancel() { teardown(report: nil) }

  /// The flow TTL elapsed without the owner canceling the listener (whether or
  /// not a callback the owner rejected was seen): report the one expiry.
  private func expire() { teardown(report: onExpiry) }

  /// The listener failed on its own: report the one failure.
  private func fail() { teardown(report: onFailure) }

  /// The synchronous fence + teardown shared by `cancel`/`expire`/`fail`.
  ///
  /// `canceled` is set (and every owned resource is captured + cleared) under the
  /// lock before any teardown is enqueued, so a concurrent `start` observes a
  /// fully-fenced cancel and can never publish a listener afterwards. Idempotent.
  /// A `report` closure (expiry or failure) is invoked **outside** the lock and
  /// at most once over the listener's whole lifetime: an owner cancel is silent
  /// and is the only thing that suppresses a report, so a callback the owner
  /// *rejected* (which never cancels the listener) can never disarm the TTL.
  ///
  /// Exactly-once holds even against a concurrent valid delivery: the only
  /// report-carrying callers (`expire`/`fail`) run on the listener's serial
  /// `queue` — the very queue that delivers `handle` — so a report and a valid
  /// delivery can never interleave; the only off-queue caller (`cancel`) reports
  /// nothing.
  private func teardown(report: (() -> Void)?) {
    lock.lock()
    if canceled {
      lock.unlock()
      return
    }
    canceled = true
    let listener = self.listener
    self.listener = nil
    let connections = self.connections
    self.connections.removeAll()
    let deadlines = self.deadlines
    self.deadlines.removeAll()
    let flowDeadline = self.flowDeadline
    self.flowDeadline = nil
    // Only an *owner cancel* suppresses a report. It reaches here as
    // `report == nil` (or it returned above, having won the fence); no delivered
    // valid callback is ever consulted, so a callback the owner *rejected* can
    // never disarm the listener's remaining TTL. `reported` remains as a second,
    // defensive fence behind the `canceled` one.
    let suppressReport = reported
    if report != nil { reported = true }
    lock.unlock()

    flowDeadline?.cancel()
    // The teardown runs on the listener's own serial queue.
    queue.async {
      for connection in connections.values { connection.cancel() }
      for deadline in deadlines.values { deadline.cancel() }
      listener?.cancel()
    }

    if let report, !suppressReport { report() }
  }

  private func isCanceled() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return canceled
  }

  private func accept(_ connection: NWConnection) {
    lock.lock()
    // The cancellation fence is re-checked here (on the listener queue), and the
    // bounded concurrent-connection budget is enforced under the same lock.
    if canceled || connections.count >= VeyraNSIWC.maxConnections {
      lock.unlock()
      connection.cancel()
      return
    }
    let id = ObjectIdentifier(connection)
    connections[id] = connection

    // Per-connection read deadline.
    let deadline = DispatchWorkItem { [weak self] in
      self?.finish(id: id, response: VeyraNSIWCCallbackResponse.invalid)
    }
    deadlines[id] = deadline
    lock.unlock()

    queue.asyncAfter(
      deadline: .now() + VeyraNSIWC.readTimeoutSeconds,
      execute: deadline
    )
    connection.start(queue: queue)
    receive(on: connection, id: id, buffer: Data())
  }

  private func receive(on connection: NWConnection, id: ObjectIdentifier, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) {
      [weak self] chunk, _, isComplete, error in
      guard let self else { return }
      if self.isCanceled() {
        self.finish(id: id, response: VeyraNSIWCCallbackResponse.invalid)
        return
      }
      if error != nil {
        self.finish(id: id, response: VeyraNSIWCCallbackResponse.invalid)
        return
      }
      var buffer = buffer
      if let chunk { buffer.append(chunk) }
      guard buffer.count <= VeyraNSIWC.maxRequestBytes else {
        self.finish(id: id, response: VeyraNSIWCCallbackResponse.invalid)
        return
      }
      // A full header block has arrived: parse it.
      if buffer.range(of: Data([0x0D, 0x0A, 0x0D, 0x0A])) != nil {
        self.handle(buffer: buffer, id: id)
        return
      }
      if isComplete {
        self.finish(id: id, response: VeyraNSIWCCallbackResponse.invalid)
        return
      }
      self.receive(on: connection, id: id, buffer: buffer)
    }
  }

  private func handle(buffer: Data, id: ObjectIdentifier) {
    lock.lock()
    let port = listener?.port?.rawValue
    let canceled = self.canceled
    lock.unlock()
    guard !canceled, let port else {
      finish(id: id, response: VeyraNSIWCCallbackResponse.invalid)
      return
    }
    switch VeyraNSIWCCallbackParser.parse(buffer, expectedPort: Int(port)) {
    case let .valid(params):
      // A parse-valid request is *not* a terminal outcome: the owner correlates
      // state / client id and either accepts (and cancels this listener) or
      // rejects (leaving this listener live for the genuine callback or the
      // TTL). The listener therefore never disarms its own deadline here.
      // Answer first, then report; the owner cancels the whole server on accept.
      finish(id: id, response: VeyraNSIWCCallbackResponse.ok)
      onValid?(params)
    case .invalid:
      // An invalid request never reaches the flow owner.
      finish(id: id, response: VeyraNSIWCCallbackResponse.invalid)
    }
  }

  private func finish(id: ObjectIdentifier, response: String) {
    lock.lock()
    guard let connection = connections[id] else {
      lock.unlock()
      return
    }
    connections[id] = nil
    deadlines[id]?.cancel()
    deadlines[id] = nil
    lock.unlock()
    let payload = VeyraNSIWCCallbackResponse.httpResponse(response)
    connection.send(
      content: payload,
      completion: .contentProcessed { _ in connection.cancel() }
    )
  }
}

#endif
