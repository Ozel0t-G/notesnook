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

// The pure session engine behind the native client: it owns the per-session
// nonce sequence, the single outstanding claim correlation and the bounded
// backoff, but never performs I/O itself. `VeyraNConnectTransport` is injected,
// so the standalone harness drives the exact production state machine with a
// scripted in-memory transport and no network, app, entitlements or simulator.
//
// This file imports only Foundation.
//
// Concurrency shape: every mutable field is guarded by a single `NSLock`, and
// every lock acquisition happens inside the synchronous `withLock` helper — the
// lock is never held across an `await`. Each asynchronous flow (health, session,
// claim, reply) snapshots the monotonic `leaseGeneration` *before* its first
// await and re-checks it *after every* await, so an `invalidate()` that lands
// mid-flight can never be resurrected by a late result.

import Foundation

// MARK: - Injected seams

protocol VeyraNConnectTransport {
  /// POST the given already-framed body to `path` on the pinned broker. Must
  /// reject any TLS handshake that does not present the paired root and the
  /// exact pinned leaf before writing a single request byte.
  func send(path: String, body: Data, timeout: TimeInterval) async throws -> Data
}

protocol VeyraNConnectClock {
  func now() -> Date
}

protocol VeyraNConnectRandom {
  /// Cryptographically secure random bytes, or `nil` on failure (fail closed).
  func bytes(_ count: Int) -> Data?
}

struct VeyraNConnectSystemClock: VeyraNConnectClock {
  func now() -> Date { Date() }
}

struct VeyraNConnectSystemRandom: VeyraNConnectRandom {
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

// MARK: - Engine

/// A single live broker session. The engine is deliberately *synchronous* about
/// its own state (an `NSLock` guards the fields) and only awaits around the
/// injected transport, so the module can cancel it deterministically.
final class VeyraNConnectSessionEngine {
  /// How long a session — and a claim-maintained lease — stays valid.
  static let leaseSeconds: TimeInterval = 120
  /// Bounded exponential backoff between poll attempts (milliseconds).
  static func backoffMillis(attempt: Int) -> Int {
    let bounded = max(0, min(attempt, 6))
    return min(5_000, 250 * (1 << bounded))
  }

  private let pairing: VeyraNConnectPairing
  private let transport: VeyraNConnectTransport
  private let clock: VeyraNConnectClock
  private let random: VeyraNConnectRandom
  private let lock = NSLock()

  // Guarded by `lock`.
  private var session: VeyraNConnectSession?
  private var clientId: String?
  private var accountId: String?
  private var bootId: String?
  private var nonce = 0
  private var outstandingTicketId: String?
  /// Deadline for the outstanding (unanswered) ticket. When it passes with no
  /// reply the claim is dropped as *uncertain*, never silently retried.
  private var ticketDeadline: Date?
  private var leaseDeadline: Date?
  /// Monotonic per-host lease generation; a stale reply carries a stale value.
  private var leaseGeneration = 0
  /// True between taking the claim slot and its response, so two concurrent
  /// claims can never share one nonce sequence.
  private var claimInFlight = false
  private var active = false

  init(
    pairing: VeyraNConnectPairing,
    transport: VeyraNConnectTransport,
    clock: VeyraNConnectClock = VeyraNConnectSystemClock(),
    random: VeyraNConnectRandom = VeyraNConnectSystemRandom()
  ) {
    self.pairing = pairing
    self.transport = transport
    self.clock = clock
    self.random = random
  }

  /// Run `body` while holding the lock. Never call this across an `await`.
  @inline(__always)
  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  // MARK: status

  func statusSummary() -> VeyraNConnectStatusSummary {
    withLock {
      VeyraNConnectStatusSummary(
        paired: true,
        pairedBrokerId: pairing.brokerId,
        pairedPort: pairing.port,
        sessionActive: active,
        bootId: bootId,
        sessionId: session?.sessionId,
        grantsGeneration: session?.grantsGeneration
      )
    }
  }

  func currentLeaseGeneration() -> Int {
    withLock { leaseGeneration }
  }

  func isActive() -> Bool {
    withLock { active }
  }

  func hasOutstandingClaim() -> Bool {
    withLock { outstandingTicketId != nil }
  }

  /// The exact (generation, sessionId) a new event would belong to, or `nil`
  /// when no session is live. The module stamps this onto every emitted request
  /// so a stale event can be discarded after a re-pair/restart.
  func sessionContext() -> (generation: Int, sessionId: String)? {
    withLock {
      guard active, let session else { return nil }
      return (leaseGeneration, session.sessionId)
    }
  }

  /// Abort the session: invalidate the broker session, drop any outstanding
  /// correlation and bump the lease generation so a late reply is refused.
  @discardableResult
  func invalidate() -> Int {
    withLock {
      session = nil
      outstandingTicketId = nil
      ticketDeadline = nil
      leaseDeadline = nil
      claimInFlight = false
      active = false
      nonce = 0
      leaseGeneration += 1
      return leaseGeneration
    }
  }

  /// Throw unless the flow generation captured before an await is still live.
  private func requireFlow(_ flow: Int) throws {
    if withLock({ leaseGeneration }) != flow {
      throw VeyraNConnectError.sessionRequired
    }
  }

  // MARK: handshake

  /// Verify the broker identity and establish a fresh app session.
  ///
  /// The health check refuses a broker whose `brokerId`/`port` are not the
  /// paired identity, and a changed `bootId` means a restarted broker: the
  /// previous session and nonce sequence are discarded under the current host
  /// lease, never reused. An `invalidate()` during any await aborts the flow
  /// without ever resurrecting `active`.
  ///
  /// `expectedLease` is the engine's lease generation as captured *atomically
  /// with the adoption of this engine* (see `VeyraNConnectLifecycle.ensureEngine`).
  /// The first engine-lock check refuses a mismatch *before* the first
  /// `health()` frame, so a stop/disconnect that landed between the adoption and
  /// this handshake — or between the caller receiving the engine and entering
  /// here — can never open a broker session under a replaced pairing. The flow
  /// is then fixed to the verified value, and every existing post-await
  /// `requireFlow` guard is retained.
  func establishSession(
    accountId: String,
    grantsGeneration: Int,
    clientId: String,
    expectedLease: Int
  ) async throws -> VeyraNConnectSession {
    guard VeyraNConnectValidate.accountId(accountId),
      VeyraNConnectValidate.clientId(clientId),
      grantsGeneration >= 0, grantsGeneration <= Int.max
    else { throw VeyraNConnectError.responseInvalid }

    let flow = try withLock {
      guard leaseGeneration == expectedLease else {
        throw VeyraNConnectError.sessionRequired
      }
      return leaseGeneration
    }

    let health = try await health()
    try requireFlow(flow)
    guard health.brokerId == pairing.brokerId, health.port == pairing.port
    else { throw VeyraNConnectError.tlsRejected }

    guard let nonceData = random.bytes(VeyraNConnectWire.instanceNonceBytes)
    else { throw VeyraNConnectError.keychainFailure }
    let clientNonce = VeyraNConnectBase64URL.encode(nonceData)
    guard
      let body = VeyraNConnectRequests.session(
        clientNonce: clientNonce,
        accountId: accountId,
        grantsGeneration: grantsGeneration
      )
    else { throw VeyraNConnectError.responseInvalid }

    let data = try await send(route: "session", body: body)
    try requireFlow(flow)
    let result = try successResult(data)
    guard let session = VeyraNConnectSession.parse(result) else {
      throw VeyraNConnectError.responseInvalid
    }

    // Adopt the session only when nothing invalidated the flow while the
    // session request was in flight.
    return try withLock {
      guard leaseGeneration == flow else { throw VeyraNConnectError.sessionRequired }
      self.session = session
      self.clientId = clientId
      self.accountId = accountId
      self.bootId = health.bootId
      self.nonce = 0
      self.outstandingTicketId = nil
      self.ticketDeadline = nil
      self.leaseDeadline = clock.now().addingTimeInterval(Self.leaseSeconds)
      self.active = true
      self.leaseGeneration += 1
      return session
    }
  }

  func health() async throws -> VeyraNConnectHealth {
    guard let body = VeyraNConnectRequests.health() else {
      throw VeyraNConnectError.responseInvalid
    }
    let data = try await send(route: "health", body: body)
    let result = try successResult(data)
    guard let health = VeyraNConnectHealth.parse(result) else {
      throw VeyraNConnectError.responseInvalid
    }
    return health
  }

  // MARK: claim / reply

  /// Take the single outstanding claim slot, if any.
  ///
  /// The in-flight flag is set *before* the awaits, so a second concurrent
  /// claim is refused locally (matching the broker's `maxClaimsPerClient: 1`)
  /// and can never share a nonce: the app must answer or let the request
  /// expire, never fire-and-forget a cross-session write.
  func claim() async throws -> VeyraNConnectClaim {
    let context: (session: VeyraNConnectSession, clientId: String, nonce: Int, flow: Int) =
      try withLock {
        guard active, let session, let clientId else {
          throw VeyraNConnectError.sessionRequired
        }
        if outstandingTicketId != nil || claimInFlight {
          throw VeyraNConnectError.busy
        }
        claimInFlight = true
        nonce += 1
        return (session, clientId, nonce, leaseGeneration)
      }

    do {
      guard
        let body = VeyraNConnectRequests.claim(
          sessionId: context.session.sessionId,
          nonce: context.nonce,
          clientId: context.clientId
        )
      else { throw VeyraNConnectError.responseInvalid }

      let data = try await send(route: "claim", body: body)
      let result = try successResult(data)
      guard let claim = VeyraNConnectClaim.parse(result) else {
        throw VeyraNConnectError.responseInvalid
      }

      return try withLock {
        claimInFlight = false
        // A claim that lands after invalidation must not resurrect the session.
        guard active, self.session?.sessionId == context.session.sessionId,
          leaseGeneration == context.flow
        else { throw VeyraNConnectError.sessionRequired }
        self.leaseDeadline = clock.now().addingTimeInterval(Self.leaseSeconds)
        switch claim {
        case .empty:
          self.ticketDeadline = nil
          return .empty
        case let .request(ticketId, request):
          self.outstandingTicketId = ticketId
          self.ticketDeadline = clock.now().addingTimeInterval(Self.leaseSeconds)
          return .request(ticketId: ticketId, request: request)
        }
      }
    } catch {
      // Always release the in-flight slot, whatever went wrong.
      withLock { claimInFlight = false }
      throw error
    }
  }

  /// Answer exactly the outstanding, correlated request.
  ///
  /// When `expectedFlow` / `expectedSessionId` are supplied (by the module, from
  /// the context JS adopted before activating), they are re-checked under the
  /// lock *before* the reply is sent: a reply that belongs to a replaced session
  /// is refused even if the ticket id is still outstanding, so a stale JS ticket
  /// can never be delivered into a different session.
  func reply(
    ticketId: String,
    response: Any,
    expectedFlow: Int? = nil,
    expectedSessionId: String? = nil
  ) async throws {
    let context: (session: VeyraNConnectSession, clientId: String, nonce: Int, flow: Int) =
      try withLock {
        guard active, let session, let clientId else {
          throw VeyraNConnectError.sessionRequired
        }
        if let expectedFlow, leaseGeneration != expectedFlow {
          throw VeyraNConnectError.sessionRequired
        }
        if let expectedSessionId, session.sessionId != expectedSessionId {
          throw VeyraNConnectError.sessionRequired
        }
        guard outstandingTicketId == ticketId else {
          throw VeyraNConnectError.correlationMismatch
        }
        nonce += 1
        return (session, clientId, nonce, leaseGeneration)
      }

    guard JSONSerialization.isValidJSONObject(response),
      let body = VeyraNConnectRequests.reply(
        sessionId: context.session.sessionId,
        nonce: context.nonce,
        clientId: context.clientId,
        ticketId: ticketId,
        response: response
      ),
      body.count <= VeyraNConnectWire.maxReplyBytes
    else { throw VeyraNConnectError.responseInvalid }

    let data = try await send(route: "reply", body: body)
    let value = try successResult(data)
    guard VeyraNConnectReplyAck.parse(value) else {
      throw VeyraNConnectError.responseInvalid
    }

    try withLock {
      // Clear the correlation only for the exact ticket *and* the exact
      // session/generation that produced it, and only when still active.
      guard active, leaseGeneration == context.flow,
        self.session?.sessionId == context.session.sessionId
      else { throw VeyraNConnectError.sessionRequired }
      if outstandingTicketId == ticketId {
        outstandingTicketId = nil
        ticketDeadline = nil
      }
    }
  }

  func leaseExpired() -> Bool {
    withLock {
      guard let leaseDeadline else { return true }
      return clock.now() >= leaseDeadline
    }
  }

  /// True when an unanswered ticket has outlived its own deadline. The module
  /// then drops the claim as uncertain instead of polling forever.
  func outstandingTicketExpired() -> Bool {
    withLock {
      guard outstandingTicketId != nil, let ticketDeadline else { return false }
      return clock.now() >= ticketDeadline
    }
  }

  // MARK: transport glue

  /// Decode a broker envelope and return its success `result`, or throw.
  ///
  /// A broker-reported session error (`SESSION_CHANGED`, `SESSION_REQUIRED`,
  /// `REPLAY`) is surfaced as `.sessionRequired` so the caller invalidates and
  /// re-establishes explicitly instead of retrying blindly against a session the
  /// broker has already replaced.
  private func successResult(_ data: Data) throws -> Any {
    guard let response = VeyraNConnectBroker.decode(data) else {
      throw VeyraNConnectError.responseInvalid
    }
    switch response {
    case let .success(result):
      return result
    case let .failure(code):
      if code == "SESSION_CHANGED" || code == "SESSION_REQUIRED" || code == "REPLAY" {
        throw VeyraNConnectError.sessionRequired
      }
      throw VeyraNConnectError.responseInvalid
    }
  }

  private func send(route: String, body: Data) async throws -> Data {
    guard let path = VeyraNConnectValidate.routePath(route) else {
      throw VeyraNConnectError.responseInvalid
    }
    // The route map is closed and the caller never supplies a host, so no
    // arbitrary target can be dialed.
    return try await transport.send(path: path, body: body, timeout: 15)
  }
}
