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

// The native lifecycle coordinator for the SIWC provider.
//
// This is the production seam the React Native module delegates to. It owns the
// one thing the module cannot own safely: the *immutable method entry*. Every
// native method captures a `VeyraNSIWCProviderEntry` (provider epoch + owner)
// and a flow generation **synchronously, before anything is deferred** — before
// a `Task` is created, before the listener can report `ready`, before a main
// queue hop. Every deferred step then presents that exact capture:
//
//   - the provider re-checks the entry epoch before every credential read,
//     request and store commit (a deferred task that lost its account performs
//     zero work),
//   - a reserved auth source is claimed *before* the listener starts and its
//     callbacks carry only that immutable snapshot, so an old `onReady`, an old
//     `onValid`, an old error/catch path or an old main-queue browser hop can
//     never open a browser, touch a credential, issue a request or cancel a
//     newer flow,
//   - the listener, the browser hand-off and the stream tasks are all mutated
//     under **one** lock, never from a foreign queue without it.
//
// Lock order is fixed and one-way: the coordinator lock is always taken first
// and the provider's own lock is only ever nested inside it (coordinator →
// provider). No `await` is ever performed while the lock is held, and no
// injected closure (promise completion, event handler, main-queue hop) is ever
// invoked while the lock is held, with **two deliberate, non-reentrant
// exceptions** described below — the synchronous browser opener and the
// synchronous auth-event delivery — so the emitter can never deadlock against
// the lifecycle.
//
// The **browser opener is one deliberate exception**: the exact-source +
// provider-epoch check and the synchronous system-open API call are linearized
// in a single critical section, so a fence/new flow cannot interleave between
// the check and the invocation. The production opener (`UIApplication.open`)
// performs no `await`, so holding the lock across it cannot deadlock; a fence
// that lands after the invocation simply waits and then invalidates the source
// (the OS may still complete an already-issued open — that limitation is stated
// at the call site). The opener's completion may be invoked *synchronously*
// inside that critical section (a synthetic opener does), so it **never**
// re-enters the lock: it only schedules the checked failure effect on the
// injected main queue, which applies it later, outside the lock.
//
// The **auth-event delivery is the second exception**
// (`withAuthorizedAuthDelivery`): the exact-identity check, the one-time
// consumption of the terminal ticket and the synchronous actual `sendEvent`
// are linearized in one critical section, so a duplicate queued terminal event
// is delivered once and a fence/new flow can never interleave between the check
// and the invocation. The production body (`RCTEventEmitter.sendEvent`)
// enqueues to JS asynchronously and never re-enters the coordinator, so holding
// the lock across it cannot deadlock.
//
// The file imports only Foundation (plus the pure sibling files). The listener
// is injected as a protocol and the browser/queue/completion surfaces as
// closures, so the standalone harness drives the *exact* production coordinator
// with a synthetic listener, a controllable main queue and a real provider — no
// React, no UIKit, no network, no Keychain.

import Foundation

// MARK: - injected listener seam

/// The single-use loopback listener behind one reserved auth source. The
/// production implementation is `VeyraNSIWCCallbackServer`; the harness injects
/// a synthetic listener so a *deferred* ready/callback delivery can be replayed
/// against the exact production lifecycle.
protocol VeyraNSIWCCallbackListener: AnyObject {
  var onReady: ((Int) -> Void)? { get set }
  var onValid: (([String: String]) -> Void)? { get set }
  /// Called exactly once when the flow TTL elapses without the owner canceling
  /// the listener — a callback the owner *rejected* (wrong state / missing code
  /// / foreign client id) never suppresses it: the abandoned *started* flow ends
  /// with the one bounded `flow_expired`. It is distinct from an owner
  /// `cancel()` (which is silent).
  var onExpiry: (() -> Void)? { get set }
  /// Called exactly once when the listener fails on its own (a bind/accept
  /// failure) — never for an owner `cancel()`, and never suppressed by a
  /// rejected callback.
  var onFailure: (() -> Void)? { get set }
  func start(flowTTL: TimeInterval) throws
  func cancel()
}

#if canImport(Network)
extension VeyraNSIWCCallbackServer: VeyraNSIWCCallbackListener {}
#endif

// MARK: - lifecycle

final class VeyraNSIWCLifecycle {
  /// The immutable identity of one *reserved auth source*.
  ///
  /// `generation` is the identity of exactly one listener/flow pair and is never
  /// reused; `providerEpoch` is the provider epoch captured *before* the
  /// listener was started and is never restamped.
  struct Source: Equatable {
    let generation: Int
    let ownerAccountId: String
    let providerEpoch: Int

    var entry: VeyraNSIWCProviderEntry {
      VeyraNSIWCProviderEntry(
        providerEpoch: providerEpoch,
        ownerAccountId: ownerAccountId,
        flowGeneration: generation
      )
    }
  }

  /// One successfully started flow, exactly as JS must correlate it.
  struct AuthStartPayload: Equatable {
    let started: Bool
    let port: Int
    let redirectUri: String
    let generation: Int
    let ownerAccountId: String
    let providerEpoch: Int
  }

  /// One authorized auth event, already stamped with the flow identity.
  enum AuthEvent: Equatable {
    case authenticated(
      subject: String, clientId: String, generation: Int, ownerAccountId: String,
      providerEpoch: Int
    )
    case authError(
      code: String, generation: Int, ownerAccountId: String, providerEpoch: Int
    )
  }

  private struct Reserved {
    let source: Source
    let mode: VeyraNSIWCAuthMode
    let loginHint: String?
    let listener: VeyraNSIWCCallbackListener
    let completion: (Result<AuthStartPayload, VeyraNSIWCError>) -> Void
    var port: Int
    var authorizeURL: URL?
    var started: Bool
    /// A genuine, fully correlated callback claimed this exact flow (and its
    /// listener was torn down). An expiry/failure for an already-claimed flow is a
    /// no-op: the claim won.
    var claimed: Bool
    /// The listener was already torn down for this source, so a later supersede /
    /// cancel / fence effect never cancels it a second time.
    var listenerCanceled: Bool
    var browserOpened: Bool
    var completionCalled: Bool
  }

  private struct Stream {
    let generation: Int
    let entry: VeyraNSIWCProviderEntry
    let ownerAccountId: String
    let requestId: String
    let completion: (Result<VeyraNSIWCCompletedResponse, VeyraNSIWCError>) -> Void
    var canceled: Bool
    var task: Task<Void, Never>?
  }

  /// The immutable, revocable ownership of the one *terminal* auth delivery that
  /// may still reach JS after its flow has already ended.
  ///
  /// A claimed callback ends its flow *before* the queued event effect runs, so
  /// the flow is no longer `current` by the time the module re-checks it. The
  /// terminal ticket is minted for the exact ended source (generation + owner +
  /// provider epoch) and is a distinct, immutable, non-consuming grant that the
  /// module presents at dispatch time. It is revoked by any source change (a new
  /// auth flow, an explicit cancel, a fence, a logout or an account change), so
  /// a superseded terminal delivery can never be mistakenly delivered.
  private struct TerminalTicket: Equatable {
    let generation: Int
    let ownerAccountId: String
    let providerEpoch: Int
  }

  private let providerFactory: () -> VeyraNSIWCProvider
  private let listenerFactory: () -> VeyraNSIWCCallbackListener
  /// Open one browser URL and report whether the system accepted the open. The
  /// completion may be invoked synchronously (a synthetic opener) or later (the
  /// real `UIApplication.open`); it must never re-enter the coordinator lock, so
  /// the failure effect is checked + applied as a deferred main-queue step.
  private let openURL: (URL, @escaping (Bool) -> Void) -> Void
  private let mainQueue: (@escaping () -> Void) -> Void
  private let lock = NSLock()

  // Guarded by `lock`.
  private var provider: VeyraNSIWCProvider?
  private var generation = 0
  private var current: Reserved?
  /// The single terminal delivery still authorized after its flow ended.
  private var terminalDelivery: TerminalTicket?
  private var streamGeneration = 0
  private var activeStreamGeneration = 0
  private var streams: [Int: Stream] = [:]
  private var authHandler: ((AuthEvent) -> Void)?
  private var streamHandler: ((VeyraNSIWCStreamEmission) -> Void)?

  init(
    providerFactory: @escaping () -> VeyraNSIWCProvider,
    listenerFactory: @escaping () -> VeyraNSIWCCallbackListener,
    openURL: @escaping (URL, @escaping (Bool) -> Void) -> Void,
    mainQueue: @escaping (@escaping () -> Void) -> Void = {
      DispatchQueue.main.async(execute: $0)
    }
  ) {
    self.providerFactory = providerFactory
    self.listenerFactory = listenerFactory
    self.openURL = openURL
    self.mainQueue = mainQueue
  }

  /// The event sinks. Both are invoked **outside** every lock, and only for an
  /// event that still owns the exact current flow/stream.
  func setAuthHandler(_ handler: ((AuthEvent) -> Void)?) {
    lock.lock()
    authHandler = handler
    lock.unlock()
  }

  func setStreamHandler(_ handler: ((VeyraNSIWCStreamEmission) -> Void)?) {
    lock.lock()
    streamHandler = handler
    lock.unlock()
  }

  // MARK: entries

  /// The reserved source that may right now consume a callback (if any).
  func currentSource() -> Source? {
    lock.lock()
    defer { lock.unlock() }
    return current?.source
  }

  /// True only while `generation` still owns the exact current flow. The module
  /// re-checks this synchronously before dispatching any event to JS.
  func isCurrentAuthFlow(_ generation: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return current?.source.generation == generation && current?.started == true
  }

  /// The non-consuming dispatch gate for one auth event.
  ///
  /// An event is deliverable only when it carries the identity of (a) the exact
  /// still-current started flow, or (b) the one terminal ticket minted for the
  /// claimed callback that ended its flow. The module presents this at the
  /// pre-queue check *and* again at the actual main-queue dispatch, so a fence
  /// that lands between the two drops the event. The ticket is revoked by every
  /// source change, so a superseded terminal delivery is never delivered.
  func allowsAuthDelivery(_ event: AuthEvent) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let generation: Int
    let ownerAccountId: String
    let providerEpoch: Int
    switch event {
    case let .authenticated(_, _, gen, owner, epoch):
      generation = gen
      ownerAccountId = owner
      providerEpoch = epoch
    case let .authError(_, gen, owner, epoch):
      generation = gen
      ownerAccountId = owner
      providerEpoch = epoch
    }
    if let current, current.started, current.source.generation == generation,
      current.source.ownerAccountId == ownerAccountId,
      current.source.providerEpoch == providerEpoch
    {
      return true
    }
    if let ticket = terminalDelivery, ticket.generation == generation,
      ticket.ownerAccountId == ownerAccountId,
      ticket.providerEpoch == providerEpoch
    {
      return true
    }
    return false
  }

  /// The consuming, linearized authorization for one auth event — the **only**
  /// path that may actually deliver an event to JS.
  ///
  /// Under the coordinator lock it re-checks the exact event identity: either
  /// the still-current started flow (retryable — a nonterminal `authError` for
  /// the correct current owner may be delivered again) or the one terminal
  /// ticket minted for the claimed callback that ended its flow. For the
  /// terminal ticket it **consumes the ticket exactly once before** invoking
  /// `body`, so a duplicate queued copy of the same terminal event is dropped.
  ///
  /// `body` (the synchronous actual `sendEvent`) is invoked while the lock is
  /// held — the documented auth-delivery exception — so the check and the
  /// invocation form one critical section: a fence/new flow either wins before
  /// the check (nothing is delivered, `body` is never called) or loses and
  /// blocks until `body` returns (dispatch-wins). `body` must be synchronous
  /// and must never re-enter the coordinator. Returns whether `body` ran.
  @discardableResult
  func withAuthorizedAuthDelivery(
    _ event: AuthEvent,
    _ body: () -> Void
  ) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let generation: Int
    let ownerAccountId: String
    let providerEpoch: Int
    switch event {
    case let .authenticated(_, _, gen, owner, epoch):
      generation = gen
      ownerAccountId = owner
      providerEpoch = epoch
    case let .authError(_, gen, owner, epoch):
      generation = gen
      ownerAccountId = owner
      providerEpoch = epoch
    }
    if let current, current.started, current.source.generation == generation,
      current.source.ownerAccountId == ownerAccountId,
      current.source.providerEpoch == providerEpoch
    {
      // A still-current started flow stays deliverable (a nonterminal authError
      // may be retried for its correct owner); nothing is consumed.
      body()
      return true
    }
    if let ticket = terminalDelivery, ticket.generation == generation,
      ticket.ownerAccountId == ownerAccountId,
      ticket.providerEpoch == providerEpoch
    {
      // Consume the terminal ticket exactly once *before* the synchronous
      // delivery, so the identical queued event can never be delivered twice.
      terminalDelivery = nil
      body()
      return true
    }
    return false
  }

  /// Revoke the terminal ticket. Called inside the lock by every path that ends
  /// or replaces the current source (so a stale terminal delivery cannot survive
  /// a new flow, cancel, fence, logout or account change).
  private func revokeTerminalLocked() {
    terminalDelivery = nil
  }

  func currentProviderEpoch() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return providerLocked().currentEpoch()
  }

  /// Resolve one native `mode` string into an exact auth mode. A returning or
  /// consent flow must reference an existing verified own registration, and a
  /// record that exists but cannot be read fails as `keychainFailure` — never as
  /// "not signed in".
  func authMode(_ mode: String) -> Result<VeyraNSIWCAuthMode, VeyraNSIWCError> {
    lock.lock()
    defer { lock.unlock() }
    let provider = providerLocked()
    switch mode {
    case "fresh":
      return .success(.fresh)
    case "returning", "consent":
      let entry = VeyraNSIWCProviderEntry.capture(provider, ownerAccountId: nil)
      do {
        guard let clientId = try provider.latestRegistration(entry: entry) else {
          return .failure(.notSignedIn)
        }
        return .success(
          mode == "returning" ? .returning(clientId: clientId) : .consent(clientId: clientId)
        )
      } catch let error as VeyraNSIWCError {
        return .failure(error)
      } catch {
        return .failure(.keychainFailure)
      }
    default:
      return .failure(.callbackInvalid)
    }
  }

  // MARK: auth flow

  /// Begin one auth flow.
  ///
  /// The source (generation + provider entry + listener) is reserved **before**
  /// the listener is started, and the completion is called exactly once: either
  /// synchronously (a listener `start` failure) or from the listener's own
  /// `ready` callback. The browser is opened only for the *exact* reserved
  /// source, after the promise was answered, and only if that source is still
  /// current when the main-queue hop actually runs.
  func beginAuth(
    mode: VeyraNSIWCAuthMode,
    ownerAccountId: String,
    loginHint: String?,
    completion: @escaping (Result<AuthStartPayload, VeyraNSIWCError>) -> Void
  ) {
    var effects: [() -> Void] = []

    lock.lock()
    let provider = providerLocked()
    let previous = current
    current = nil
    // A new attempt revokes any terminal delivery that belonged to a previous
    // flow: its event must not be adopted after this newer flow is armed.
    revokeTerminalLocked()
    // A new attempt supersedes the previous one: its listener, its pending
    // provider flow and its (still unanswered) promise are all resolved now,
    // outside the lock.
    provider.cancelFlow(
      entry: VeyraNSIWCProviderEntry.capture(provider, ownerAccountId: nil)
    )
    generation += 1
    let source = Source(
      generation: generation,
      ownerAccountId: ownerAccountId,
      // Captured *now*, before the listener can report ready and before any
      // task is scheduled. It is never restamped.
      providerEpoch: provider.currentEpoch()
    )
    let listener = listenerFactory()
    let reserved = Reserved(
      source: source,
      mode: mode,
      loginHint: loginHint,
      listener: listener,
      completion: completion,
      port: 0,
      authorizeURL: nil,
      started: false,
      claimed: false,
      listenerCanceled: false,
      browserOpened: false,
      completionCalled: false
    )
    // The callbacks carry the immutable source snapshot only, and every one of
    // them runs **outside** this lock (the listener invokes them on its own
    // queue), so the coordinator re-takes the lock inside each handler.
    listener.onReady = { [weak self] port in
      self?.listenerReady(source, port: Int(port))
    }
    listener.onValid = { [weak self] query in
      self?.listenerValid(source, query: query)
    }
    listener.onExpiry = { [weak self] in
      self?.listenerExpired(source)
    }
    listener.onFailure = { [weak self] in
      self?.listenerFailed(source)
    }
    current = reserved
    lock.unlock()

    if let previous {
      // The superseded attempt is answered truthfully as canceled when its
      // promise is still unanswered, but its listener is torn down
      // **unconditionally** (once): an already-ready (started) superseded
      // listener must never be left alive. Only the promise answer is
      // conditional.
      if !previous.completionCalled {
        effects.append { previous.completion(.failure(.authCanceled)) }
      }
      if !previous.listenerCanceled {
        effects.append { previous.listener.cancel() }
      }
    }

    do {
      try listener.start(flowTTL: VeyraNSIWC.flowTTLSeconds)
    } catch {
      lock.lock()
      if var failed = current, failed.source == source, !failed.started,
        !failed.completionCalled
      {
        failed.completionCalled = true
        current = nil
        generation += 1
        let dismissal = failed
        lock.unlock()
        effects.append { dismissal.completion(.failure(.transportUnavailable)) }
        effects.append { dismissal.listener.cancel() }
      } else {
        lock.unlock()
      }
    }

    run(effects)
  }

  /// Cancel the current auth flow (an explicit user action). A newer flow
  /// started afterwards is untouched, and a superseded flow's deferred steps are
  /// all invalidated.
  func cancelAuth() {
    var effects: [() -> Void] = []
    lock.lock()
    let reserved = current
    current = nil
    generation += 1
    revokeTerminalLocked()
    let provider = providerLocked()
    provider.cancelFlow(
      entry: VeyraNSIWCProviderEntry.capture(provider, ownerAccountId: nil)
    )
    lock.unlock()
    if let reserved {
      if !reserved.completionCalled {
        effects.append { reserved.completion(.failure(.authCanceled)) }
      }
      effects.append { reserved.listener.cancel() }
    }
    run(effects)
  }

  /// The synchronous lifecycle seam: every lock / logout / account-change /
  /// migration / unmount path calls this **before** any await. The provider
  /// epoch is bumped atomically with the coordinator invalidation, so a fence
  /// either wins before a commit (nothing is written) or after it (it owns the
  /// final state).
  func fence() {
    var effects: [() -> Void] = []
    lock.lock()
    generation += 1
    let reserved = current
    current = nil
    revokeTerminalLocked()
    let stream = streams[activeStreamGeneration]
    if stream != nil { streams[activeStreamGeneration]?.canceled = true }
    activeStreamGeneration = 0
    providerLocked().fence()
    lock.unlock()
    if let reserved {
      if !reserved.completionCalled {
        effects.append { reserved.completion(.failure(.authCanceled)) }
      }
      effects.append { reserved.listener.cancel() }
    }
    if let stream {
      effects.append { stream.task?.cancel() }
    }
    run(effects)
  }

  // MARK: callback delivery

  private func listenerReady(_ source: Source, port: Int) {
    var effects: [() -> Void] = []
    var openSource: Source?

    lock.lock()
    if var reserved = current, reserved.source == source, !reserved.started {
      let provider = providerLocked()
      if provider.currentEpoch() == source.providerEpoch {
        do {
          let start = try provider.beginAuth(
            mode: reserved.mode,
            ownerAccountId: source.ownerAccountId,
            port: port,
            loginHint: reserved.loginHint,
            entry: source.entry
          )
          reserved.started = true
          reserved.port = start.port
          reserved.authorizeURL = start.authorizeURL
          if !reserved.completionCalled {
            reserved.completionCalled = true
            let completion = reserved.completion
            let payload = AuthStartPayload(
              started: true,
              port: start.port,
              redirectUri: start.redirectURI,
              generation: source.generation,
              ownerAccountId: source.ownerAccountId,
              providerEpoch: source.providerEpoch
            )
            effects.append { completion(.success(payload)) }
          }
          if !reserved.browserOpened {
            // The browser-open *claim* is atomic with the source check; the
            // opener itself runs later, on the injected main queue, and only if
            // this exact source (and its URL) is still current then.
            reserved.browserOpened = true
            openSource = source
          }
          current = reserved
        } catch {
          let code = (error as? VeyraNSIWCError) ?? .transportUnavailable
          if !reserved.completionCalled {
            reserved.completionCalled = true
            let completion = reserved.completion
            effects.append { completion(.failure(code)) }
          }
          current = nil
          generation += 1
          revokeTerminalLocked()
          effects.append { reserved.listener.cancel() }
        }
      } else {
        // The provider epoch moved on (a fence raced the ready callback): the
        // source is dead on arrival and performs zero work.
        if !reserved.completionCalled {
          reserved.completionCalled = true
          let completion = reserved.completion
          effects.append { completion(.failure(.accountChanged)) }
        }
        current = nil
        generation += 1
        revokeTerminalLocked()
        effects.append { reserved.listener.cancel() }
      }
    }
    lock.unlock()

    run(effects)
    if let openSource {
      mainQueue { [weak self] in
        self?.openBrowserIfCurrent(openSource)
      }
    }
  }

  private func openBrowserIfCurrent(_ source: Source) {
    lock.lock()
    // The exact-source + provider-epoch validation and the synchronous opener
    // invocation are linearized in *one* critical section: a fence or a newer
    // flow cannot interleave between the check and the system-open API call.
    // The opener (production: `UIApplication.shared.open` on the main queue) is
    // a plain system call that performs no `await`, so holding the lock across it
    // is safe (the provider lock is nested inside the coordinator lock — the one
    // allowed order).
    //
    // The opener's completion (which may run *synchronously*, inside this very
    // critical section, for a synthetic opener) must therefore never re-enter the
    // coordinator lock: it only schedules the checked failure effect on the
    // injected main queue, and the effect re-takes the lock later, outside it.
    //
    // Honest limitation: an invocation that is accepted before a concurrent
    // fence may still be completed by the OS afterwards. The fence only
    // guarantees that a *later* invocation cannot start; it cannot unsend an
    // already-issued open.
    guard current?.source == source, current?.started == true,
      providerLocked().currentEpoch() == source.providerEpoch,
      let url = current?.authorizeURL
    else {
      lock.unlock()
      return
    }
    let schedule = mainQueue
    openURL(url) { [weak self] success in
      guard !success else { return }
      schedule { [weak self] in self?.browserOpenFailed(source) }
    }
    lock.unlock()
  }

  /// The synchronous admission of one callback, run under the coordinator lock
  /// (coordinator → provider order).
  ///
  /// A genuinely claimed callback is marked and its listener (with its own TTL
  /// deadline) is torn down *atomically* here, so it beats a racing expiry; the
  /// bounded exchange then runs outside every lock. A rejected callback consumed
  /// nothing: a wrong state/client/malformed query leaves the flow, the listener
  /// and the deadline live and waits for the genuine callback — except a stale
  /// `flow_expired`, which ends the flow exactly once.
  private func listenerValid(_ source: Source, query: [String: String]) {
    var effects: [() -> Void] = []
    var ticket: VeyraNSIWCPreparedCallback?

    lock.lock()
    if var reserved = current, reserved.source == source, reserved.started,
      !reserved.claimed
    {
      switch providerLocked().prepareCallback(
        query: query,
        port: reserved.port,
        ownerAccountId: source.ownerAccountId,
        entry: source.entry
      ) {
      case let .admitted(prepared):
        reserved.claimed = true
        reserved.listenerCanceled = true
        current = reserved
        ticket = prepared
        // Disarm the listener's own wait deadline before the exchange runs: the
        // claim already won, so no expiry may fire for this flow.
        effects.append { reserved.listener.cancel() }
      case let .rejected(error):
        if error == .flowExpired {
          // Expiry wins cleanly: the provider consumed nothing further. End the
          // flow exactly once (the helper is a no-op for a stale/claimed source).
          endCurrentLocked(source, code: .flowExpired, effects: &effects)
        }
        // Any other rejection consumed nothing and leaves the flow live.
      }
    }
    lock.unlock()
    run(effects)

    guard let ticket else { return }
    Task { [weak self] in
      guard let self else { return }
      let result = await self.providerRef().finishCallback(ticket)
      self.deliverCallbackResult(source: source, result: result)
    }
  }

  /// The listener's TTL seam: an abandoned *started* flow ends with the one
  /// bounded `flow_expired`; a failure before `ready` answers the promise.
  private func listenerExpired(_ source: Source) {
    handleListenerEnd(source, startedCode: .flowExpired)
  }

  /// The listener's own failure seam (a bind/accept failure).
  private func listenerFailed(_ source: Source) {
    handleListenerEnd(source, startedCode: .transportUnavailable)
  }

  /// The listener reported its own terminal outcome (`onExpiry`/`onFailure`).
  /// Invoked outside every lock by the listener. A started flow ends with exactly
  /// one bounded `authError`; a pre-`ready` failure answers the still-unanswered
  /// start promise once; a stale source is a no-op.
  private func handleListenerEnd(_ source: Source, startedCode: VeyraNSIWCError) {
    var effects: [() -> Void] = []
    lock.lock()
    if let reserved = current, reserved.source == source {
      if reserved.started {
        endCurrentLocked(source, code: startedCode, effects: &effects)
      } else if !reserved.completionCalled {
        // The listener died before it was ready: the flow never started, so the
        // start promise is answered (exactly once) rather than an auth event.
        current = nil
        generation += 1
        let completion = reserved.completion
        effects.append { completion(.failure(.transportUnavailable)) }
        effects.append { reserved.listener.cancel() }
      }
    }
    lock.unlock()
    run(effects)
  }

  /// The browser-open failure seam (the opener reported `false`). Bound to the
  /// exact source; a stale, superseded, fenced or already-claimed source is a
  /// no-op, so exactly one producer can ever end a flow.
  private func browserOpenFailed(_ source: Source) {
    var effects: [() -> Void] = []
    lock.lock()
    endCurrentLocked(source, code: .transportUnavailable, effects: &effects)
    lock.unlock()
    run(effects)
  }

  /// End the exact current source with one terminal `authError`, **under the
  /// coordinator lock**. It is a no-op for a stale source, an unstarted source or
  /// a flow that was already claimed, so a single per-source producer wins and no
  /// two producers (claim / expiry / failure) can ever both end it. The terminal
  /// ticket is minted before the queued effect runs, so the module still delivers
  /// the event; any later source change revokes it.
  private func endCurrentLocked(
    _ source: Source,
    code: VeyraNSIWCError,
    effects: inout [() -> Void]
  ) {
    guard let reserved = current, reserved.source == source, reserved.started,
      !reserved.claimed
    else { return }
    terminalDelivery = TerminalTicket(
      generation: source.generation,
      ownerAccountId: source.ownerAccountId,
      providerEpoch: source.providerEpoch
    )
    let handler = authHandler
    let event = AuthEvent.authError(
      code: code.code,
      generation: source.generation,
      ownerAccountId: source.ownerAccountId,
      providerEpoch: source.providerEpoch
    )
    current = nil
    generation += 1
    effects.append { reserved.listener.cancel() }
    if let handler { effects.append { handler(event) } }
  }

  private func deliverCallbackResult(
    source: Source,
    result: VeyraNSIWCCallbackResult
  ) {
    var effects: [() -> Void] = []
    lock.lock()
    let stillCurrent =
      current?.source == source
      && providerLocked().currentEpoch() == source.providerEpoch
    if result.claimed, stillCurrent {
      let handler = authHandler
      // The single immutable terminal ticket for this exact ended source. It is
      // minted *before* the queued event effect runs and survives the
      // `current = nil` teardown below, so the module still delivers the event
      // at dispatch time. Any later source change revokes it.
      terminalDelivery = TerminalTicket(
        generation: source.generation,
        ownerAccountId: source.ownerAccountId,
        providerEpoch: source.providerEpoch
      )
      if let credential = result.credential {
        effects.append {
          handler?(.authenticated(
            subject: credential.subject,
            clientId: credential.clientId,
            generation: source.generation,
            ownerAccountId: source.ownerAccountId,
            providerEpoch: source.providerEpoch
          ))
        }
      } else {
        let code = (result.failure ?? .callbackInvalid).code
        effects.append {
          handler?(.authError(
            code: code,
            generation: source.generation,
            ownerAccountId: source.ownerAccountId,
            providerEpoch: source.providerEpoch
          ))
        }
      }
      // A claimed callback ends exactly this flow. Its listener was already torn
      // down synchronously at admission (so the TTL can never also end it).
      if let reserved = current, reserved.source == source {
        current = nil
        generation += 1
      }
    }
    lock.unlock()
    run(effects)
  }

  // MARK: credential

  /// The credential status for the exact method entry. The entry is captured and
  /// presented synchronously, so a concurrent fence can never turn a status read
  /// into a stale-credential leak.
  func credentialStatus(ownerAccountId: String) -> VeyraNSIWCCredentialStatus {
    lock.lock()
    defer { lock.unlock() }
    let provider = providerLocked()
    let entry = VeyraNSIWCProviderEntry.capture(
      provider,
      ownerAccountId: ownerAccountId
    )
    return provider.credentialStatus(ownerAccountId: ownerAccountId, entry: entry)
  }

  func clearCredential(completion: @escaping (Bool) -> Void) {
    lock.lock()
    let provider = providerLocked()
    let entry = VeyraNSIWCProviderEntry.capture(provider, ownerAccountId: nil)
    lock.unlock()
    completion(provider.clearCredential(entry: entry))
  }

  /// Logout with an exact entry. The local clear happens under the entry guard
  /// inside the provider; a deferred logout whose entry lost the store performs
  /// **zero** reads, writes and requests and can therefore never clear a newer
  /// credential.
  func logout(
    ownerAccountId: String,
    completion: @escaping (VeyraNSIWCLogoutOutcome) -> Void
  ) {
    var effects: [() -> Void] = []
    lock.lock()
    let provider = providerLocked()
    let entry = VeyraNSIWCProviderEntry.capture(
      provider,
      ownerAccountId: ownerAccountId
    )
    // The pending browser flow belongs to this logout: it is invalidated
    // synchronously, and a flow started *afterwards* is untouched.
    let reserved = current
    current = nil
    generation += 1
    revokeTerminalLocked()
    provider.cancelFlow(
      entry: VeyraNSIWCProviderEntry.capture(provider, ownerAccountId: nil)
    )
    lock.unlock()
    if let reserved {
      if !reserved.completionCalled {
        effects.append { reserved.completion(.failure(.authCanceled)) }
      }
      effects.append { reserved.listener.cancel() }
    }
    run(effects)

    Task {
      let outcome = await provider.logoutDetailed(
        ownerAccountId: ownerAccountId,
        entry: entry
      )
      completion(outcome)
    }
  }

  // MARK: refresh / models

  func refresh(
    ownerAccountId: String,
    completion: @escaping (Result<String, VeyraNSIWCError>) -> Void
  ) {
    let entry: VeyraNSIWCProviderEntry
    lock.lock()
    let provider = providerLocked()
    entry = VeyraNSIWCProviderEntry.capture(provider, ownerAccountId: ownerAccountId)
    lock.unlock()
    Task {
      do {
        // The stored entry is presented before any credential read or request.
        let credential = try await provider.refresh(
          ownerAccountId: ownerAccountId,
          entry: entry
        )
        completion(.success(credential.subject))
      } catch let error as VeyraNSIWCError {
        completion(.failure(error))
      } catch {
        completion(.failure(.transportUnavailable))
      }
    }
  }

  func fetchModels(
    ownerAccountId: String,
    completion: @escaping (Result<[VeyraNSIWCModel], VeyraNSIWCError>) -> Void
  ) {
    let entry: VeyraNSIWCProviderEntry
    lock.lock()
    let provider = providerLocked()
    entry = VeyraNSIWCProviderEntry.capture(provider, ownerAccountId: ownerAccountId)
    lock.unlock()
    Task {
      do {
        let catalog = try await provider.fetchModels(
          ownerAccountId: ownerAccountId,
          entry: entry
        )
        completion(.success(catalog.models))
      } catch let error as VeyraNSIWCError {
        completion(.failure(error))
      } catch {
        completion(.failure(.transportUnavailable))
      }
    }
  }

  // MARK: streaming

  /// Start one stream invocation under its own immutable entry. A new invocation
  /// supersedes the previous one: the superseded stream is marked canceled, its
  /// task is cancelled, and it can neither emit, report a success nor clear the
  /// newer stream's ownership. Its own promise is still answered truthfully as
  /// `canceled`.
  func streamInvoke(
    ownerAccountId: String,
    model: String,
    input: [Any],
    tools: [Any]?,
    instructions: String?,
    requestId: String,
    authorizedNames: Set<String>,
    completion: @escaping (Result<VeyraNSIWCCompletedResponse, VeyraNSIWCError>) -> Void
  ) {
    var previousTask: Task<Void, Never>?
    let generation: Int
    let entry: VeyraNSIWCProviderEntry
    let provider: VeyraNSIWCProvider

    lock.lock()
    provider = providerLocked()
    if let superseded = streams[activeStreamGeneration] {
      streams[activeStreamGeneration]?.canceled = true
      previousTask = superseded.task
    }
    streamGeneration += 1
    generation = streamGeneration
    entry = VeyraNSIWCProviderEntry.capture(
      provider,
      ownerAccountId: ownerAccountId,
      // The monotonic stream generation: a superseded stream that is admitted
      // late can never supersede this one.
      flowGeneration: generation
    )
    streams[generation] = Stream(
      generation: generation,
      entry: entry,
      ownerAccountId: ownerAccountId,
      requestId: requestId,
      completion: completion,
      canceled: false,
      task: nil
    )
    activeStreamGeneration = generation
    lock.unlock()

    previousTask?.cancel()
    if previousTask != nil {
      // Only the superseded invocation is cancelled at the provider, and only
      // while its own entry still owns the store.
      provider.cancelStream(entry: entry)
    }

    let task = Task { [weak self] in
      guard let self else { return }
      do {
        let catalog = try await provider.fetchModels(
          ownerAccountId: ownerAccountId,
          entry: entry
        )
        let completed = try await provider.invoke(
          ownerAccountId: ownerAccountId,
          model: model,
          input: input,
          tools: tools,
          instructions: instructions,
          requestId: requestId,
          catalog: catalog,
          authorizedNames: authorizedNames,
          entry: entry
        ) { emission in
          self.emitStream(generation, emission)
        }
        self.finishStream(generation, result: .success(completed))
      } catch let error as VeyraNSIWCError {
        self.finishStream(generation, result: .failure(error))
      } catch {
        self.finishStream(generation, result: .failure(.streamInvalid))
      }
    }

    lock.lock()
    if streams[generation] != nil, activeStreamGeneration == generation {
      streams[generation]?.task = task
    }
    lock.unlock()
  }

  /// Cancel the *current* stream only: a newer invocation started afterwards is
  /// untouched, and a superseded invocation's completion can never clear it.
  func cancelStream() {
    var task: Task<Void, Never>?
    lock.lock()
    let provider = providerLocked()
    if let stream = streams[activeStreamGeneration] {
      streams[activeStreamGeneration]?.canceled = true
      task = stream.task
    }
    activeStreamGeneration = 0
    let entry = VeyraNSIWCProviderEntry.capture(provider, ownerAccountId: nil)
    lock.unlock()
    task?.cancel()
    provider.cancelStream(entry: entry)
  }

  private func emitStream(_ generation: Int, _ emission: VeyraNSIWCStreamEmission) {
    lock.lock()
    let stream = streams[generation]
    let justified =
      activeStreamGeneration == generation
      && stream?.canceled == false
      && providerLocked().currentEpoch() == stream?.entry.providerEpoch
    let handler = streamHandler
    lock.unlock()
    // The emission is dropped, and the handler is never invoked, for any stream
    // that no longer owns the fence.
    guard justified, let handler else { return }
    handler(emission)
  }

  private func finishStream(
    _ generation: Int,
    result: Result<VeyraNSIWCCompletedResponse, VeyraNSIWCError>
  ) {
    lock.lock()
    guard let stream = streams.removeValue(forKey: generation) else {
      lock.unlock()
      return
    }
    let wasActive = activeStreamGeneration == generation
    if wasActive { activeStreamGeneration = 0 }
    let owned =
      wasActive && !stream.canceled
      && providerLocked().currentEpoch() == stream.entry.providerEpoch
    // A superseded, canceled or fenced invocation always reports `canceled`,
    // never its own late result.
    let outcome: Result<VeyraNSIWCCompletedResponse, VeyraNSIWCError> =
      owned ? result : .failure(.canceled)
    lock.unlock()
    stream.completion(outcome)
  }

  // MARK: internals

  /// The provider lock is always nested *inside* the coordinator lock.
  private func providerLocked() -> VeyraNSIWCProvider {
    if let provider { return provider }
    let created = providerFactory()
    provider = created
    return created
  }

  private func providerRef() -> VeyraNSIWCProvider {
    lock.lock()
    defer { lock.unlock() }
    return providerLocked()
  }

  /// Apply the deferred effects of one locked transition. Every effect runs
  /// outside the lock, in the order it was queued, so no injected closure can
  /// re-enter the lifecycle while the lock is held. `rethrows` is avoided on
  /// purpose: an effect closure can never fail this call.
  private func run(_ effects: [() -> Void]) {
    for effect in effects { effect() }
  }
}
