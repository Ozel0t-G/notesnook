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

// The pure SIWC provider state machine: authorization, credential persistence,
// single-flight refresh, models and the streaming Responses invocation.
//
// Everything is dependency-injected (store, HTTP transport, streaming
// transport, clock, random) so the standalone harness drives the exact
// production logic with synthetic transports and no network, Keychain, app or
// simulator.
//
// Fencing shape: one monotonic `epoch` is bumped synchronously by `fence()` at
// every lifecycle seam (lock, logout, account switch, migration, unmount). Every
// asynchronous flow snapshots the epoch *before* its first await and re-checks
// it *after every* await, both before any credential read and before any persist
// or emit. A flow that lost its epoch can never adopt a credential, replace an
// identity or emit a result.
//
// Method-entry shape: the epoch snapshot is not taken inside the provider (a
// deferred `Task` would then observe the *new* epoch and happily work with a
// newer credential). Instead every entry point takes an immutable
// `VeyraNSIWCProviderEntry` captured by the caller at the exact method entry and
// re-checks it before every credential read, request and commit. The provider
// never restamps an entry from `currentEpoch()`.
//
// Storage shape: a store read is *typed*. Only `errSecItemNotFound` is `missing`
// (the single state that may be initialized, create-if-absent); a corrupt record
// or an unreadable store is a hard `keychainFailure` — never "no document", and
// never overwritten.
//
// This file imports only Foundation (plus the pure sibling files).

import Foundation

// MARK: - method-entry identity

/// The immutable identity of one provider *method entry*.
///
/// It is captured synchronously by the caller — the lifecycle coordinator, or
/// the standalone harness — at the exact moment a native method is entered, and
/// presented to every provider entry point. The provider refuses to read a
/// credential, send a request or write a commit unless the entry's exact
/// provider epoch still owns the store, so a *deferred* task that lost its
/// account (cancel, fence, account switch, new flow) can never touch a newer
/// flow. The value is never restamped from `currentEpoch()` later.
struct VeyraNSIWCProviderEntry: Equatable {
  /// The provider epoch observed at method entry.
  let providerEpoch: Int
  /// The exact Notes account at method entry (`nil` = provider-wide entry).
  let ownerAccountId: String?
  /// The exact coordinator generation at method entry: the listener-bound auth
  /// flow generation for an auth entry, or the monotonic *stream* generation for
  /// a stream entry (`nil` outside both). It makes an older deferred stream
  /// unable to supersede a newer one.
  let flowGeneration: Int?

  init(
    providerEpoch: Int,
    ownerAccountId: String?,
    flowGeneration: Int? = nil
  ) {
    self.providerEpoch = providerEpoch
    self.ownerAccountId = ownerAccountId
    self.flowGeneration = flowGeneration
  }

  /// Capture the entry for `provider` **now**.
  static func capture(
    _ provider: VeyraNSIWCProvider,
    ownerAccountId: String?,
    flowGeneration: Int? = nil
  ) -> VeyraNSIWCProviderEntry {
    VeyraNSIWCProviderEntry(
      providerEpoch: provider.currentEpoch(),
      ownerAccountId: ownerAccountId,
      flowGeneration: flowGeneration
    )
  }

  /// The entry is bound to *this* owner (or to no owner at all).
  func matches(ownerAccountId: String) -> Bool {
    self.ownerAccountId == nil || self.ownerAccountId == ownerAccountId
  }
}

// MARK: - typed reads

/// The truthful outcome of one credential status read. A store that cannot be
/// read is never reported as "no credential".
enum VeyraNSIWCCredentialStatus: Equatable {
  /// The entry no longer owns the store: **zero** store reads were performed.
  case stale
  /// The store was read and holds no credential for this account.
  case signedOut
  /// The record could not be read (a Keychain error or a corrupt document).
  case keychainFailure
  /// A live credential with both direct scopes.
  case ready(VeyraNSIWCCredential)
  /// A live credential without the direct scopes (identity only).
  case missingPermission(VeyraNSIWCCredential)
}

/// The typed read of the persisted document behind one provider method.
enum VeyraNSIWCDocumentRead {
  case document(VeyraNSIWCPersisted)
  case missing
  /// A record exists but cannot be read as a valid document.
  case failed
}

/// The cacheable outcome of a *successful* store read. A failed read is never
/// cached, so a later call re-reads the original record.
private enum VeyraNSIWCCachedDocument {
  case missing
  case loaded(VeyraNSIWCPersisted)
}

// MARK: - Flow / token shapes

enum VeyraNSIWCAuthMode: Equatable {
  /// First registration: `dynamic_agent_client` + agent host URN.
  case fresh
  /// Returning sign-in with an own issued client id.
  case returning(clientId: String)
  /// Explicit, human-initiated "release ChatGPT usage" recovery
  /// (`prompt=consent`).
  case consent(clientId: String)

  var requestClientId: String {
    switch self {
    case .fresh: return VeyraNSIWC.dynamicAgentClientId
    case let .returning(clientId), let .consent(clientId): return clientId
    }
  }

  var prompt: String? {
    if case .consent = self { return VeyraNSIWC.consentPrompt }
    return nil
  }
}

struct VeyraNSIWCAuthStart {
  let authorizeURL: URL
  let redirectURI: String
  let port: Int
}

private struct VeyraNSIWCPendingFlow {
  /// The exact, monotonic identity of this one begun attempt. It makes a callback
  /// claim exact: two attempts at the same provider epoch (a supersede or a
  /// cancel followed by a new auth) can share a state when the random source is
  /// deterministic, so the state alone is never proof of ownership.
  let attempt: Int
  let state: String
  let nonce: String
  let verifier: String
  let clientId: String
  let redirectURI: String
  let port: Int
  let ownerAccountId: String
  let epoch: Int
  let deadline: Date
  let mode: VeyraNSIWCAuthMode
  let loginHint: String?
}

struct VeyraNSIWCTokenResponse {
  let accessToken: String
  let refreshToken: String?
  let idToken: String?
  let grantedScopes: [String]
  let expiresIn: Int?
}

enum VeyraNSIWCStreamEmission {
  /// The first emission of a stream: it announces the exact native provider
  /// generation (and request id) so the JS side can learn the generation it must
  /// match before any delta arrives. Without this handshake JS would have to
  /// guess the native counter and could never adopt an emission.
  case started(requestId: String, providerGeneration: Int)
  /// A bounded output-text delta, stamped with the request id and provider
  /// generation the JS side must adopt before emitting.
  case delta(text: String, requestId: String, providerGeneration: Int)
  /// A terminal function call, adopted *before* it is emitted.
  case functionCall(VeyraNSIWCFunctionCall, requestId: String, providerGeneration: Int)
}

/// A non-200 provider response surfaced by the transport, carrying only a
/// bounded status and an optional *catalogued* provider error code.
struct VeyraNSIWCProviderFailure: Error {
  let status: Int
  let providerCode: String?
}

// MARK: - Provider

final class VeyraNSIWCProvider {
  private let store: VeyraNSIWCStore
  private let http: VeyraNSIWCTransport
  private let streamTransport: VeyraNSIWCStreamingTransport
  private let clock: VeyraNSIWCClock
  private let random: VeyraNSIWCRandomSource
  private let lock = NSLock()

  // Guarded by `lock`.
  private var epoch = 0
  private var pendingFlow: VeyraNSIWCPendingFlow?
  /// The monotonic attempt counter for begun auth flows (never reused).
  private var authAttemptCounter = 0
  /// The attempt that currently owns the store's *claimed* auth flow, if any.
  /// A commit for any other attempt is refused, so a claimed-but-in-flight flow
  /// that was canceled or superseded at the same epoch can never persist after
  /// its owner lost the claim.
  private var claimedAttempt: Int?
  private var cachedDocument: VeyraNSIWCCachedDocument?
  private var refreshInFlight: Task<VeyraNSIWCCredential, Error>?
  private var refreshOwner: String?
  private var refreshGeneration = 0
  /// The one stream that owns the streaming transport right now (0 = idle).
  private var activeStreamID = 0
  private var streamCounter = 0
  /// The highest coordinator stream generation ever admitted. A *deferred*
  /// stream that was superseded while it was still fetching its catalog can
  /// therefore never be admitted late and supersede the newer stream.
  private var admittedStreamGeneration = 0
  /// The stream ids that may no longer report anything (cancel/supersede/fence).
  private var canceledStreamIDs: Set<Int> = []
  /// Set by a fence: every flow admitted before the fence is invalid.
  private var fencedStreams = false

  init(
    store: VeyraNSIWCStore,
    http: VeyraNSIWCTransport,
    stream: VeyraNSIWCStreamingTransport,
    clock: VeyraNSIWCClock = VeyraNSIWCSystemClock(),
    random: VeyraNSIWCRandomSource = VeyraNSIWCSystemRandom()
  ) {
    self.store = store
    self.http = http
    self.streamTransport = stream
    self.clock = clock
    self.random = random
  }

  @inline(__always)
  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  // MARK: epoch / host

  func currentEpoch() -> Int { withLock { epoch } }

  /// Bump the epoch, drop any pending flow, cancel the active stream and
  /// invalidate the refresh flight. Every in-flight auth/refresh/models/stream
  /// flow is invalidated by the entry + epoch re-check it performs after its
  /// next await; the refresh *flight* is additionally unregistered here, so an
  /// old flight's completion can neither answer a new caller with a stale result
  /// nor clear a newer flight, and a new eligible identity starts its own flight.
  @discardableResult
  func fence() -> Int {
    withLock {
      epoch += 1
      pendingFlow = nil
      claimedAttempt = nil
      fencedStreams = true
      if activeStreamID != 0 {
        canceledStreamIDs.insert(activeStreamID)
      }
      refreshGeneration += 1
      let stale = refreshInFlight
      refreshInFlight = nil
      refreshOwner = nil
      stale?.cancel()
      return epoch
    }
  }

  /// The entry check every entry point starts with: the exact epoch must still
  /// own the store, and the entry must be bound to the account being served.
  private func requireEntry(
    _ entry: VeyraNSIWCProviderEntry,
    ownerAccountId: String
  ) throws {
    guard entry.matches(ownerAccountId: ownerAccountId) else {
      throw VeyraNSIWCError.accountChanged
    }
    try requireEntry(entry)
  }

  /// The epoch-only half of the entry check (for owner-independent reads).
  private func requireEntry(_ entry: VeyraNSIWCProviderEntry) throws {
    guard entry.providerEpoch == currentEpoch() else {
      throw VeyraNSIWCError.accountChanged
    }
  }

  // MARK: locked primitives
  //
  // The methods suffixed `Locked` assume `lock` is held. Every mutation of the
  // store + the in-memory cache happens inside *one* critical section with its
  // epoch/identity guard, so a concurrent fence can never interleave between the
  // check and the write (see `docs/veyran-connect/SIWC.md` §5).

  /// Read the persisted document once. Caller must hold `lock`.
  ///
  /// A *successful* read (`.loaded`/`.missing`) is cached and authoritative
  /// until this process writes. A *failed* read (`.invalid`/`.unavailable`) is
  /// never cached and never treated as an absent record: the caller sees
  /// `.failed` and the next call re-reads the original record, so a transient
  /// Keychain failure can never be converted into "no document" (which would
  /// initialize a fresh host over the real one).
  private func documentLocked() -> VeyraNSIWCDocumentRead {
    if let cachedDocument {
      switch cachedDocument {
      case .missing: return .missing
      case let .loaded(document): return .document(document)
      }
    }
    switch store.load() {
    case let .loaded(document):
      cachedDocument = .loaded(document)
      return .document(document)
    case .missing:
      cachedDocument = .missing
      return .missing
    case .invalid, .unavailable:
      return .failed
    }
  }

  private func document() -> VeyraNSIWCDocumentRead {
    withLock { documentLocked() }
  }

  /// Ensure a stable host URN exists and is persisted. Caller must hold `lock`.
  ///
  /// A record this process can read (with a valid host) is adopted unchanged.
  /// When no record exists, a new one is *created only if absent*: if a record
  /// appeared concurrently, the create refuses and the original record is read
  /// and validated instead of being overwritten. A record that exists but cannot
  /// be read (a Keychain error or a corrupt document) always fails closed — the
  /// stored bytes are never replaced with a freshly generated host.
  private func ensureHostLocked() throws -> String {
    switch documentLocked() {
    case let .document(document):
      guard VeyraNSIWCValidate.hostURN(document.hostURN) else {
        throw VeyraNSIWCError.keychainFailure
      }
      return document.hostURN
    case .failed:
      throw VeyraNSIWCError.keychainFailure
    case .missing:
      guard let urn = VeyraNSIWCValidate.makeHostURN(random) else {
        throw VeyraNSIWCError.keychainFailure
      }
      let document = VeyraNSIWCPersisted.empty(hostURN: urn)
      switch store.createIfAbsent(document) {
      case .created:
        cachedDocument = .loaded(document)
        return urn
      case let .existing(existing):
        // A concurrent initialization won: adopt its record, never overwrite it.
        guard VeyraNSIWCValidate.hostURN(existing.hostURN) else {
          throw VeyraNSIWCError.keychainFailure
        }
        cachedDocument = .loaded(existing)
        return existing.hostURN
      case .duplicateUnreadable, .failed:
        throw VeyraNSIWCError.keychainFailure
      }
    }
  }

  /// A read-only view of the persisted document (registrations/host only; the
  /// caller must never forward tokens to JS). A record that cannot be read is
  /// reported as `nil` here; the typed `credentialStatus` distinguishes it.
  func persistedForRead() -> VeyraNSIWCPersisted? {
    withLock {
      guard case let .document(document) = documentLocked() else { return nil }
      return document
    }
  }

  /// The latest verified own registration's client id, for a returning/consent
  /// flow.
  ///
  /// A record that exists but cannot be read is a hard failure — never "not
  /// signed in" — so a corrupt store can never silently degrade a returning
  /// sign-in into a fresh foreign registration.
  func latestRegistration(entry: VeyraNSIWCProviderEntry) throws -> String? {
    try requireEntry(entry)
    return try withLock {
      switch documentLocked() {
      case let .document(document):
        return document.registrations.last(where: { $0.isComplete })?.clientId
      case .missing:
        return nil
      case .failed:
        throw VeyraNSIWCError.keychainFailure
      }
    }
  }

  /// Ensure a stable host URN exists and is persisted. The host and the
  /// registrations survive logout; only the credential is cleared.
  func ensureHost(entry: VeyraNSIWCProviderEntry) throws -> String {
    try requireEntry(entry)
    return try withLock {
      guard entry.providerEpoch == epoch else {
        throw VeyraNSIWCError.accountChanged
      }
      return try ensureHostLocked()
    }
  }

  // MARK: authorization

  /// Begin one fresh authorization flow bound to the exact method entry — the
  /// exact Notes account, the exact provider epoch and the exact listener
  /// generation — returning the fixed authorize URL for the system browser.
  ///
  /// The store rule (the entry check, the document read and the possibly
  /// *writing* host creation) runs **before any fresh challenge material is
  /// generated**, so a corrupt or unavailable record consumes no randomness and
  /// creates nothing. The pending-flow claim is its own critical section, again
  /// under the exact entry epoch — never a restamped one.
  func beginAuth(
    mode: VeyraNSIWCAuthMode,
    ownerAccountId: String,
    port: Int,
    loginHint: String?,
    entry: VeyraNSIWCProviderEntry
  ) throws -> VeyraNSIWCAuthStart {
    guard entry.matches(ownerAccountId: ownerAccountId) else {
      throw VeyraNSIWCError.accountChanged
    }
    guard !ownerAccountId.isEmpty, ownerAccountId.utf8.count <= 512 else {
      throw VeyraNSIWCError.accountChanged
    }
    guard let redirect = VeyraNSIWCRedirect.uri(port: port) else {
      throw VeyraNSIWCError.callbackInvalid
    }
    let clientId = mode.requestClientId

    let host: String = try withLock {
      guard entry.providerEpoch == epoch else {
        throw VeyraNSIWCError.accountChanged
      }
      // A returning/consent flow must reference an existing, verified own
      // registration; a fresh flow never reuses one. A record that cannot be
      // read is never treated as "no document".
      switch documentLocked() {
      case let .document(document):
        switch mode {
        case .fresh:
          guard clientId == VeyraNSIWC.dynamicAgentClientId else {
            throw VeyraNSIWCError.callbackInvalid
          }
        case .returning, .consent:
          guard let registration = document.registration(clientId: clientId),
            registration.isComplete
          else { throw VeyraNSIWCError.notSignedIn }
        }
      case .missing:
        // No document yet: the host is created lazily below.
        guard case .fresh = mode else { throw VeyraNSIWCError.notSignedIn }
      case .failed:
        throw VeyraNSIWCError.keychainFailure
      }

      return try ensureHostLocked()
    }

    guard let state = VeyraNSIWCPKCE.state(random),
      let nonce = VeyraNSIWCPKCE.nonce(random),
      let verifier = VeyraNSIWCPKCE.verifier(random),
      let challenge = VeyraNSIWCPKCE.challenge(verifier: verifier)
    else { throw VeyraNSIWCError.keychainFailure }

    let flow: VeyraNSIWCPendingFlow = try withLock {
      guard entry.providerEpoch == epoch else {
        throw VeyraNSIWCError.accountChanged
      }
      authAttemptCounter += 1
      let flow = VeyraNSIWCPendingFlow(
        attempt: authAttemptCounter,
        state: state,
        nonce: nonce,
        verifier: verifier,
        clientId: clientId,
        redirectURI: redirect,
        port: port,
        ownerAccountId: ownerAccountId,
        // The *entry's* epoch, never a restamped one.
        epoch: entry.providerEpoch,
        deadline: clock.now().addingTimeInterval(VeyraNSIWC.flowTTLSeconds),
        mode: mode,
        loginHint: loginHint
      )
      pendingFlow = flow
      // A newly begun attempt invalidates any previous claim of this epoch: a
      // claimed-but-in-flight superseded flow must never commit afterwards.
      claimedAttempt = nil
      return flow
    }

    let params = VeyraNSIWCAuthorizeParams(
      clientId: clientId,
      redirectURI: redirect,
      state: state,
      nonce: nonce,
      codeChallenge: challenge,
      loginHint: loginHint,
      prompt: mode.prompt,
      // The agent-name hint is sent *only* on the initial registration.
      agentNameHint: mode == .fresh ? VeyraNSIWC.agentNameHint : nil,
      // The own *stable* host URN is sent on *every* attempt (fresh, returning
      // and consent): the browser flow is always bound to this device's own
      // persistent host, and the own issued client id stays
      // registration/account-bound. A returning/consent flow never presents a
      // placeholder exchange or a fresh foreign identity instead of its own.
      extAgentHostId: host
    )
    guard let url = VeyraNSIWCAuthorize.url(params) else {
      // The claim is released again: no flow exists without a valid URL.
      discardFlow(attempt: flow.attempt, epoch: entry.providerEpoch)
      throw VeyraNSIWCError.callbackInvalid
    }
    return VeyraNSIWCAuthStart(
      authorizeURL: url,
      redirectURI: redirect,
      port: port
    )
  }

  private func discardFlow(attempt: Int, epoch flowEpoch: Int) {
    withLock {
      guard epoch == flowEpoch, pendingFlow?.attempt == attempt else { return }
      pendingFlow = nil
      claimedAttempt = nil
    }
  }

  /// Cancel the pending flow only while `entry` still owns the store: an old
  /// (deferred) cancel can never tear down a newer flow. Any *claimed* attempt of
  /// this epoch is disowned at the same time, so a cancel can never be followed by
  /// a late commit of the flow it just superseded.
  func cancelFlow(entry: VeyraNSIWCProviderEntry) {
    withLock {
      guard entry.providerEpoch == epoch else { return }
      pendingFlow = nil
      claimedAttempt = nil
    }
  }

  // MARK: callback admission / completion

  /// The **synchronous admission** of one callback — the minimal pre-claim guard
  /// set factored out of the exchange pipeline.
  ///
  /// Every validation (entry epoch, port, owner, TTL, flow epoch, constant-time
  /// state, client-id rules) runs *before* the flow is atomically claimed, and
  /// the claim itself is *exact*: it consumes the one pending attempt the callback
  /// was validated against (a plain state match is not ownership when the random
  /// source is deterministic). A rejected callback consumed **nothing** — the
  /// pending flow, the listener and its TTL deadline all stay live for the genuine
  /// callback (or the one expiry). An admitted callback returns a sealed,
  /// single-use ticket.
  ///
  /// It performs no `await` and invokes no injected closure, so the lifecycle can
  /// run it **under the coordinator lock** (coordinator → provider order) and
  /// thereby linearize "a genuinely claimed callback beats the flow TTL" against
  /// the expiry seam: whichever takes the lock first wins, and the loser is a
  /// no-op.
  func prepareCallback(
    query: [String: String],
    port: Int,
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) -> VeyraNSIWCCallbackAdmission {
    guard entry.matches(ownerAccountId: ownerAccountId) else {
      return .rejected(.accountChanged)
    }
    guard entry.providerEpoch == currentEpoch() else {
      return .rejected(.accountChanged)
    }
    let flow: VeyraNSIWCPendingFlow? = withLock { pendingFlow }
    guard let flow, flow.epoch == entry.providerEpoch else {
      return .rejected(.callbackInvalid)
    }
    guard flow.port == port, flow.ownerAccountId == ownerAccountId else {
      return .rejected(.callbackInvalid)
    }
    // TTL + epoch are checked before consuming. A late callback releases only the
    // exact flow it was validated against (by attempt, not by state).
    guard clock.now() < flow.deadline else {
      discardFlow(attempt: flow.attempt, epoch: flow.epoch)
      return .rejected(.flowExpired)
    }
    guard flow.epoch == currentEpoch() else { return .rejected(.accountChanged) }

    // Constant-time state comparison happens before anything else. An
    // invalid/empty/wrong state (or a callback for another flow) never reaches
    // any claim below.
    guard let state = query["state"],
      VeyraNSIWCValidate.constantTimeEquals(state, flow.state)
    else { return .rejected(.stateMismatch) }

    // Callback client id handling (all *before* the claim).
    let callbackClientId = query["client_id"]
    switch flow.mode {
    case .fresh:
      // A new issued client id is required; the placeholder is never persisted.
      guard let callbackClientId,
        VeyraNSIWCValidate.issuedClientId(callbackClientId)
      else { return .rejected(.callbackInvalid) }
    case .returning, .consent:
      if let callbackClientId {
        guard VeyraNSIWCValidate.constantTimeEquals(
          callbackClientId,
          flow.clientId
        ) else { return .rejected(.identityMismatch) }
      }
    }

    // A provider-reported error is only correlated *after* the exact state
    // match above: the user really declined this flow, so it is consumed and
    // reported as a bounded failure.
    if query["error"] != nil {
      guard claim(flow) else { return .rejected(.accountChanged) }
      return .admitted(
        VeyraNSIWCPreparedCallback(
          flow: flow,
          issuedClientId: flow.clientId,
          code: nil,
          immediate: .authCanceled
        )
      )
    }
    // A missing/malformed code never consumes a live flow: the genuine callback
    // (or an explicit cancel) may still arrive.
    guard let code = query["code"], VeyraNSIWCValidate.opaque(code, max: 4096)
    else { return .rejected(.callbackInvalid) }

    // The pending flow is consumed atomically and exactly with the "still
    // current" check.
    guard claim(flow) else { return .rejected(.accountChanged) }

    let issuedClientId = flow.mode.requestClientId == VeyraNSIWC.dynamicAgentClientId
      ? (callbackClientId ?? flow.clientId)
      : flow.clientId
    guard VeyraNSIWCValidate.issuedClientId(issuedClientId) else {
      return .admitted(
        VeyraNSIWCPreparedCallback(
          flow: flow, issuedClientId: issuedClientId,
          code: code, immediate: .callbackInvalid
        )
      )
    }

    // A fresh registration is retained as an INCOMPLETE registration *before*
    // the token exchange, so a crash mid-exchange can recover without reusing a
    // foreign callback. A verified registration is never overwritten here. All
    // of this is synchronous and happens while this exact attempt still owns the
    // claim.
    if case .fresh = flow.mode, let callbackClientId {
      switch commitPendingRegistration(
        clientId: callbackClientId,
        attempt: flow.attempt,
        epoch: flow.epoch
      ) {
      case .committed: break
      case .stale:
        return .admitted(
          VeyraNSIWCPreparedCallback(
            flow: flow, issuedClientId: issuedClientId,
            code: code, immediate: .accountChanged
          )
        )
      case .refusedIdentity:
        return .admitted(
          VeyraNSIWCPreparedCallback(
            flow: flow, issuedClientId: issuedClientId,
            code: code, immediate: .identityMismatch
          )
        )
      case .storeFailed:
        return .admitted(
          VeyraNSIWCPreparedCallback(
            flow: flow, issuedClientId: issuedClientId,
            code: code, immediate: .keychainFailure
          )
        )
      }
    }

    return .admitted(
      VeyraNSIWCPreparedCallback(
        flow: flow, issuedClientId: issuedClientId,
        code: code, immediate: nil
      )
    )
  }

  /// Complete one callback.
  ///
  /// This is the async, source-compatible wrapper: it runs the synchronous
  /// `prepareCallback` admission and then, only for a genuinely claimed flow, the
  /// bounded exchange. The result is a value, not a throw, because the caller must
  /// be able to tell a *rejected* attempt (nothing was consumed — the pending
  /// flow, the listener and the browser session stay alive for the genuine
  /// callback) from a *claimed* attempt (this exact callback atomically consumed
  /// the pending flow, so a replay or a concurrent second exchange can never claim
  /// it again).
  func completeCallback(
    query: [String: String],
    port: Int,
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) async -> VeyraNSIWCCallbackResult {
    switch prepareCallback(
      query: query,
      port: port,
      ownerAccountId: ownerAccountId,
      entry: entry
    ) {
    case let .rejected(error):
      return .rejected(error)
    case let .admitted(ticket):
      return await finishCallback(ticket)
    }
  }

  /// Run the remainder of exactly one claimed callback: the bounded token
  /// exchange, the identity verification and the single linearized commit.
  ///
  /// The prepared ticket is consumed **exactly once** here, so a replayed ticket
  /// performs zero exchanges and zero commits. Every commit is guarded by the
  /// exact claimed attempt (under the provider lock), so a claim that was canceled
  /// or superseded at the same epoch can never persist afterwards.
  func finishCallback(
    _ ticket: VeyraNSIWCPreparedCallback
  ) async -> VeyraNSIWCCallbackResult {
    guard ticket.consume() else { return .rejected(.callbackInvalid) }
    let flow = ticket.flow
    // The sealed ticket proves the callback was validated against this exact
    // attempt, but the claim may already have been disowned (a cancel, a new
    // begin or a fence) between `prepareCallback` and this task actually
    // starting. Prove the store still credits this exact attempt with the claim
    // under the provider lock before any immediate outcome, exchange, JWKS work
    // or commit.
    guard stillOwnsClaim(attempt: flow.attempt, epoch: flow.epoch) else {
      return .claimed(.accountChanged)
    }
    if let immediate = ticket.immediate { return .claimed(immediate) }
    guard let code = ticket.code else { return .claimed(.callbackInvalid) }
    let issuedClientId = ticket.issuedClientId
    let ownerAccountId = flow.ownerAccountId

    let token: VeyraNSIWCTokenResponse
    do {
      token = try await exchange(
        code: code,
        clientId: issuedClientId,
        verifier: flow.verifier,
        redirectURI: flow.redirectURI
      )
    } catch let error as VeyraNSIWCError {
      return .claimed(error)
    } catch {
      return .claimed(.transportUnavailable)
    }
    guard isCurrent(epoch: flow.epoch),
      stillOwnsClaim(attempt: flow.attempt, epoch: flow.epoch)
    else { return .claimed(.accountChanged) }

    let (subject, email, idToken): (String, String?, String)
    do {
      (subject, email, idToken) = try await verifiedIdentity(
        token: token,
        clientId: issuedClientId,
        nonce: flow.nonce,
        epoch: flow.epoch
      )
    } catch let error as VeyraNSIWCError {
      return .claimed(error)
    } catch {
      return .claimed(.tokenInvalid)
    }

    // A returning *or* consent flow must authenticate the same verified subject
    // as the selected registration: a foreign ChatGPT account can therefore
    // never overwrite a previously verified registration under its issued
    // client id. Only a fresh registration has no prior subject to match.
    if case .fresh = flow.mode {
      // Fresh registration: a *new* own issued client id is bound below; it
      // never mutates an existing verified registration.
    } else {
      guard case let .document(document) = document(),
        let registration = document.registration(clientId: issuedClientId),
        registration.subject == subject
      else { return .claimed(.identityMismatch) }
    }

    guard isCurrent(epoch: flow.epoch),
      stillOwnsClaim(attempt: flow.attempt, epoch: flow.epoch)
    else { return .claimed(.accountChanged) }
    let credential = VeyraNSIWCCredential(
      clientId: issuedClientId,
      subject: subject,
      ownerAccountId: ownerAccountId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      idToken: idToken,
      grantedScopes: token.grantedScopes,
      expiresAt: token.expiresIn.map { Int(clock.now().timeIntervalSince1970) + $0 },
      providerEpoch: flow.epoch
    )
    switch commitAuthorization(
      attempt: flow.attempt,
      epoch: flow.epoch,
      credential: credential,
      email: email,
      subject: subject
    ) {
    case .committed: return .authenticated(credential)
    case .stale: return .claimed(.accountChanged)
    case .refusedIdentity: return .claimed(.identityMismatch)
    case .storeFailed: return .claimed(.keychainFailure)
    }
  }

  /// Atomically consume exactly the flow the callback was validated against —
  /// the exact attempt, not merely a matching state at the same epoch — and
  /// record the claim as the flow that now owns this epoch's commit.
  private func claim(_ flow: VeyraNSIWCPendingFlow) -> Bool {
    withLock {
      guard pendingFlow?.attempt == flow.attempt,
        pendingFlow?.state == flow.state,
        epoch == flow.epoch
      else { return false }
      pendingFlow = nil
      claimedAttempt = flow.attempt
      return true
    }
  }

  private func isCurrent(epoch flowEpoch: Int) -> Bool {
    currentEpoch() == flowEpoch
  }

  /// Whether the exact attempt handed out in a prepared ticket still owns the
  /// store's *claimed* flow at `flowEpoch`.
  ///
  /// The fields are read directly under `lock` (never via `currentEpoch()` /
  /// `requireEntry`, which would re-enter the non-recursive lock) so a cancel, a
  /// new begin or a fence that disowned the claim can never be followed by a late
  /// exchange, JWKS verification or commit of the superseded flow.
  private func stillOwnsClaim(attempt: Int, epoch flowEpoch: Int) -> Bool {
    withLock { epoch == flowEpoch && claimedAttempt == attempt }
  }

  // MARK: credential / scopes

  /// The direct-scope-gated credential status behind the exact entry.
  ///
  /// A record that cannot be read is `keychainFailure` — never `signedOut` — so
  /// the host can report a truthful error instead of silently claiming "not
  /// signed in", and zero credential fields are ever surfaced for it.
  func credentialStatus(
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) -> VeyraNSIWCCredentialStatus {
    withLock {
      guard entry.providerEpoch == epoch, entry.matches(ownerAccountId: ownerAccountId)
      else { return .stale }
      switch documentLocked() {
      case .missing:
        return .signedOut
      case .failed:
        return .keychainFailure
      case let .document(document):
        guard let credential = document.credential,
          credential.ownerAccountId == ownerAccountId
        else { return .signedOut }
        return VeyraNSIWC.requiredDirectScopes.allSatisfy {
          credential.grantedScopes.contains($0)
        } ? .ready(credential) : .missingPermission(credential)
      }
    }
  }

  /// The credential behind the exact entry, or `nil` when there is none (or when
  /// the entry no longer owns the store, or when the store cannot be read).
  func loadCredential(
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) -> VeyraNSIWCCredential? {
    switch credentialStatus(ownerAccountId: ownerAccountId, entry: entry) {
    case let .ready(credential), let .missingPermission(credential):
      return credential
    case .stale, .signedOut, .keychainFailure:
      return nil
    }
  }

  /// Clear only the credential locally; the host and the registrations stay so
  /// a returning sign-in can reuse the issued client id. The read, the write and
  /// the in-memory adoption are one critical section, so a concurrent fence or
  /// commit can never interleave. A record that cannot be read is never written
  /// over: the clear fails truthfully.
  @discardableResult
  func clearCredential(entry: VeyraNSIWCProviderEntry) -> Bool {
    withLock {
      guard entry.providerEpoch == epoch else { return false }
      switch documentLocked() {
      case .missing:
        // Nothing to clear: the record is absent.
        return true
      case .failed:
        // An unreadable record is never written over.
        return false
      case let .document(document):
        // An owner-bound entry only ever clears its own credential.
        if let owner = entry.ownerAccountId,
          let credential = document.credential,
          credential.ownerAccountId != owner
        {
          return true
        }
        let next = document.withCredential(nil)
        guard store.save(next) else { return false }
        cachedDocument = .loaded(next)
        return true
      }
    }
  }

  /// The direct-scope gate: identity alone never authorizes models/inference.
  func requireDirectScopes(_ credential: VeyraNSIWCCredential) throws {
    for scope in VeyraNSIWC.requiredDirectScopes
    where !credential.grantedScopes.contains(scope) {
      throw VeyraNSIWCError.missingPlanScope
    }
  }

  // MARK: refresh

  func refresh(
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) async throws -> VeyraNSIWCCredential {
    // The entry is re-verified *before* any flight is joined or created, so a
    // deferred refresh that lost its account performs zero work.
    try requireEntry(entry, ownerAccountId: ownerAccountId)
    let (task, generation) = withLock {
      () -> (Task<VeyraNSIWCCredential, Error>, Int) in
      // Only an in-flight refresh for the *same* owner is joined; a different
      // owner starts its own flight (the old one is doomed by the identity
      // guards on every read/write it performs).
      if let existing = refreshInFlight, refreshOwner == ownerAccountId {
        return (existing, refreshGeneration)
      }
      refreshGeneration += 1
      let created = Task { [self] in
        try await performRefresh(ownerAccountId: ownerAccountId, entry: entry)
      }
      refreshInFlight = created
      refreshOwner = ownerAccountId
      return (created, refreshGeneration)
    }
    defer {
      withLock {
        // Only the *current* flight may unregister itself; a fenced flight can
        // therefore never clear a newer flight.
        if refreshGeneration == generation {
          refreshInFlight = nil
          refreshOwner = nil
        }
      }
    }
    return try await task.value
  }

  private func performRefresh(
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) async throws -> VeyraNSIWCCredential {
    try requireEntry(entry, ownerAccountId: ownerAccountId)
    guard case let .document(document) = document(),
      let credential = document.credential,
      credential.ownerAccountId == ownerAccountId,
      let refreshToken = credential.refreshToken
    else { throw VeyraNSIWCError.notSignedIn }
    let flowEpoch = entry.providerEpoch

    guard let body = VeyraNSIWCTokenRequest.refresh(
      refreshToken: refreshToken,
      clientId: credential.clientId
    ) else { throw VeyraNSIWCError.tokenInvalid }

    let response: VeyraNSIWCHTTPResponse
    do {
      response = try await http.send(
        VeyraNSIWCHTTPRequest(
          method: "POST",
          url: VeyraNSIWC.tokenEndpoint,
          headers: ["Content-Type": "application/x-www-form-urlencoded"],
          body: body
        ),
        timeout: 30
      )
    } catch {
      // An ambiguous refresh (no response) must not be retried blindly: clear
      // the credential and require a fresh sign-in. The clear is *linearized*
      // against the epoch and the exact source credential, so a stale flight
      // that lost its account (or was superseded by a new login) during the
      // await can never wipe a newer, live credential.
      _ = clearCredential(ifCurrent: credential, epoch: flowEpoch)
      throw VeyraNSIWCError.transportUnavailable
    }
    try requireEpoch(flowEpoch)

    guard response.status == 200 else {
      // An invalid_grant (or any 4xx) is terminal for this credential — but
      // only for *this exact* credential under the *current* epoch.
      if response.status == 400 || response.status == 401 {
        _ = clearCredential(ifCurrent: credential, epoch: flowEpoch)
        throw VeyraNSIWCError.tokenInvalid
      }
      throw VeyraNSIWCError.transportUnavailable
    }
    guard let token = parseTokenResponse(response.body) else {
      throw VeyraNSIWCError.tokenInvalid
    }

    // A replacement id_token is re-validated with the retained subject and, if
    // supplied, the retained original nonce. No new nonce is invented and a
    // standard refresh is not rejected solely for omitting one.
    var subject = credential.subject
    var idToken = credential.idToken
    var email: String?
    if let replacement = token.idToken {
      let retainedNonce = VeyraNSIWCJWT.retainedNonce(credential.idToken)
      let jwks = try await fetchJWKS(epoch: flowEpoch)
      try requireEpoch(flowEpoch)
      guard let claims = VeyraNSIWCJWT.verify(
        token: replacement,
        jwks: jwks,
        now: clock.now(),
        expectedIssuer: VeyraNSIWC.issuer,
        expectedAudience: credential.clientId,
        expectedNonce: nil
      ) else { throw VeyraNSIWCError.tokenInvalid }
      if let suppliedNonce = claims.nonce {
        guard let retainedNonce,
          VeyraNSIWCValidate.constantTimeEquals(suppliedNonce, retainedNonce)
        else { throw VeyraNSIWCError.tokenInvalid }
      }
      guard claims.subject == credential.subject else {
        throw VeyraNSIWCError.identityMismatch
      }
      subject = claims.subject
      idToken = replacement
      email = claims.email
    }

    // `offline_access` (and thus a refresh token) is never invented.
    if token.refreshToken == nil,
      !credential.grantedScopes.contains("offline_access")
    {
      throw VeyraNSIWCError.tokenInvalid
    }

    let refreshed = VeyraNSIWCCredential(
      clientId: credential.clientId,
      subject: subject,
      ownerAccountId: ownerAccountId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? credential.refreshToken,
      idToken: idToken,
      grantedScopes: token.grantedScopes.isEmpty
        ? credential.grantedScopes : token.grantedScopes,
      expiresAt: token.expiresIn.map {
        Int(clock.now().timeIntervalSince1970) + $0
      },
      providerEpoch: flowEpoch
    )

    // Replace exactly the credential this flight started from, under the exact
    // epoch, in one critical section (guard + store write + adoption). A failed
    // store write surfaces truthfully and keeps the previous item and the
    // previous in-memory credential.
    switch commitRefresh(
      epoch: flowEpoch,
      from: credential,
      to: refreshed,
      email: email,
      ownerAccountId: ownerAccountId
    ) {
    case .committed: return refreshed
    case .stale: throw VeyraNSIWCError.accountChanged
    case .refusedIdentity: throw VeyraNSIWCError.identityMismatch
    case .storeFailed: throw VeyraNSIWCError.keychainFailure
    }
  }

  // MARK: models

  func fetchModels(
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) async throws -> VeyraNSIWCCatalog {
    // Entry first: a deferred models read for a lost account performs zero
    // credential reads and zero requests.
    try requireEntry(entry, ownerAccountId: ownerAccountId)
    var credential = try currentCredential(ownerAccountId: ownerAccountId, entry: entry)
    try requireDirectScopes(credential)
    let flowEpoch = entry.providerEpoch

    var response = try await requestModels(credential: credential, epoch: flowEpoch)
    if response.status == 401 {
      // A bounded, single refresh-then-retry for model metadata only.
      credential = try await refresh(ownerAccountId: ownerAccountId, entry: entry)
      try requireDirectScopes(credential)
      try requireEpoch(flowEpoch)
      response = try await requestModels(credential: credential, epoch: flowEpoch)
    }
    try requireEpoch(flowEpoch)
    guard response.status == 200 else {
      throw Self.error(status: response.status, providerCode: nil)
    }
    guard let catalog = VeyraNSIWCCatalog.parse(response.body) else {
      throw VeyraNSIWCError.modelUnavailable
    }
    return catalog
  }

  private func requestModels(
    credential: VeyraNSIWCCredential,
    epoch flowEpoch: Int
  ) async throws -> VeyraNSIWCHTTPResponse {
    guard let headers = VeyraNSIWCResponsesRequest.modelsHeaders(
      accessToken: credential.accessToken
    ) else { throw VeyraNSIWCError.tokenInvalid }
    try requireEpoch(flowEpoch)
    return try await http.send(
      VeyraNSIWCHTTPRequest(
        method: "GET",
        url: VeyraNSIWC.modelsEndpoint,
        headers: headers,
        body: nil
      ),
      timeout: 30
    )
  }

  // MARK: streaming invocation

  /// Start one Responses stream. Only a single active stream is allowed. The
  /// partial draft is delivered through `emit` (never persisted here) so a
  /// failure preserves what the caller already received.
  ///
  /// The stream owns a monotonic stream id: a new invocation *supersedes* the
  /// previous one (which is marked canceled and can no longer emit, report or
  /// clear the newer stream's ownership), and only the exact owner may clear the
  /// active-stream slot.
  func invoke(
    ownerAccountId: String,
    model: String,
    input: [Any],
    tools: [Any]?,
    instructions: String?,
    requestId: String,
    catalog: VeyraNSIWCCatalog,
    authorizedNames: Set<String>,
    entry: VeyraNSIWCProviderEntry,
    emit: @escaping (VeyraNSIWCStreamEmission) -> Void
  ) async throws -> VeyraNSIWCCompletedResponse {
    // The entry check comes *first*, before any credential read.
    try requireEntry(entry, ownerAccountId: ownerAccountId)
    let credential = try currentCredential(ownerAccountId: ownerAccountId, entry: entry)
    try requireDirectScopes(credential)
    guard catalog.allows(slug: model) else {
      throw VeyraNSIWCError.modelUnavailable
    }
    // The JS host owns the request id it will adopt: it generates it before the
    // call and every emission (including the handshake) is stamped with exactly
    // this value, so JS never has to adopt an arbitrary first emission.
    guard VeyraNSIWCValidate.opaque(requestId, max: 128) else {
      throw VeyraNSIWCError.streamInvalid
    }

    let streamID: Int = try withLock {
      guard entry.providerEpoch == epoch, entry.matches(ownerAccountId: ownerAccountId)
      else { throw VeyraNSIWCError.accountChanged }
      if let flowGeneration = entry.flowGeneration {
        // The coordinator stream generation is monotonic: a superseded stream
        // that was deferred while it fetched its catalog is refused admission
        // and can therefore never supersede (or cancel) a newer stream.
        guard flowGeneration > admittedStreamGeneration else {
          throw VeyraNSIWCError.canceled
        }
        admittedStreamGeneration = flowGeneration
      }
      // A new stream supersedes the previous one: the superseded stream is
      // marked canceled so its completion can never be mistaken for a success
      // and can never clear this stream's slot.
      if activeStreamID != 0 {
        canceledStreamIDs.insert(activeStreamID)
      }
      streamCounter += 1
      let id = streamCounter
      activeStreamID = id
      canceledStreamIDs.remove(id)
      fencedStreams = false
      return id
    }
    defer { finishStream(id: streamID) }

    guard let body = VeyraNSIWCResponsesRequest.body(
      model: model,
      input: input,
      tools: tools,
      instructions: instructions
    ), let headers = VeyraNSIWCResponsesRequest.headers(
      accessToken: credential.accessToken
    ) else { throw VeyraNSIWCError.streamInvalid }

    // Announce the exact provider generation *before* the request is sent, so
    // the JS side adopts the native generation ahead of any delta.
    emit(.started(requestId: requestId, providerGeneration: entry.providerEpoch))

    let started = clock.now()
    let stream = streamTransport.stream(
      VeyraNSIWCHTTPRequest(
        method: "POST",
        url: VeyraNSIWC.responsesEndpoint,
        headers: headers,
        body: body
      )
    )

    var decoder = VeyraNSIWCSSEDecoder()
    var total = 0
    var eventCount = 0
    var outputBytes = 0
    var completed: VeyraNSIWCCompletedResponse?

    do {
      for try await chunk in stream {
        if isStreamCanceled(id: streamID) { throw VeyraNSIWCError.canceled }
        try requireEpoch(entry.providerEpoch)
        guard clock.now().timeIntervalSince(started)
          <= VeyraNSIWC.streamWallclockSeconds
        else { throw VeyraNSIWCError.streamInvalid }
        total += chunk.count
        guard total <= VeyraNSIWC.maxStreamBytes else {
          throw VeyraNSIWCError.streamInvalid
        }
        let events = try decoder.append(chunk)
        for event in events {
          eventCount += 1
          guard eventCount <= VeyraNSIWC.maxEvents else {
            throw VeyraNSIWCError.streamInvalid
          }
          if let terminal = try handle(
            event: event,
            requestId: requestId,
            providerGeneration: entry.providerEpoch,
            authorizedNames: authorizedNames,
            outputBytes: &outputBytes,
            emit: emit
          ) {
            completed = terminal
            break
          }
        }
        if completed != nil { break }
      }
    } catch let failure as VeyraNSIWCProviderFailure {
      throw Self.error(status: failure.status, providerCode: failure.providerCode)
    }

    if isStreamCanceled(id: streamID) { throw VeyraNSIWCError.canceled }
    try requireEpoch(entry.providerEpoch)
    guard let completed else {
      // An EOF, a 200 with no `response.completed`, or a truncated stream is
      // never a success.
      throw VeyraNSIWCError.streamInvalid
    }
    return completed
  }

  /// Release the active-stream slot only when *this* stream still owns it.
  private func finishStream(id: Int) {
    withLock {
      if activeStreamID == id { activeStreamID = 0 }
    }
  }

  /// Handle one SSE event. Returns a completed response only for the single
  /// success terminal.
  private func handle(
    event: VeyraNSIWCSSEEvent,
    requestId: String,
    providerGeneration: Int,
    authorizedNames: Set<String>,
    outputBytes: inout Int,
    emit: @escaping (VeyraNSIWCStreamEmission) -> Void
  ) throws -> VeyraNSIWCCompletedResponse? {
    let name = event.name ?? ""
    guard name.hasPrefix("response.") || name == "error" else { return nil }

    if name == "response.output_text.delta" {
      guard let delta = Self.extractDelta(event.data) else {
        throw VeyraNSIWCError.streamInvalid
      }
      outputBytes += delta.utf8.count
      guard outputBytes <= VeyraNSIWC.maxOutputBytes else {
        throw VeyraNSIWCError.streamInvalid
      }
      emit(.delta(text: delta, requestId: requestId, providerGeneration: providerGeneration))
      return nil
    }
    if name == "response.completed" {
      guard let completed = VeyraNSIWCCompletedResponse.parse(
        eventData: event.data,
        authorizedNames: authorizedNames
      ) else { throw VeyraNSIWCError.streamInvalid }
      for call in completed.functionCalls {
        emit(.functionCall(
          call,
          requestId: requestId,
          providerGeneration: providerGeneration
        ))
      }
      return completed
    }
    if name == "response.failed" || name == "response.incomplete"
      || name == "response.canceled" || name == "error"
    {
      throw Self.error(status: 0, providerCode: Self.extractErrorCode(event.data))
    }
    return nil
  }

  /// Cancel the stream only while `entry` still owns the store: a deferred
  /// cancel can never stop a newer stream.
  func cancelStream(entry: VeyraNSIWCProviderEntry) {
    withLock {
      guard entry.providerEpoch == epoch else { return }
      guard activeStreamID != 0 else { return }
      canceledStreamIDs.insert(activeStreamID)
    }
  }

  private func isStreamCanceled(id: Int) -> Bool {
    withLock { fencedStreams || canceledStreamIDs.contains(id) }
  }

  // MARK: logout

  /// Local clear is immediate; a single best-effort revocation is attempted at
  /// the discovery-provided endpoint. A 200-empty confirms; anything else is
  /// reported as manual.
  func logout(
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) async -> Bool {
    let outcome = await logoutDetailed(ownerAccountId: ownerAccountId, entry: entry)
    return outcome.revocationConfirmed
  }

  /// Logout as one outcome: the local clear result, whether remote revocation
  /// was actually confirmed, and whether there was no active connection at all.
  ///
  /// The credential is loaded, the local clear is performed and the single
  /// best-effort revocation is issued *inside* this call, so a caller can never
  /// clear first and thereby skip the revocation. The old credential lives only
  /// in this function's bounded local scope for the duration of the one
  /// best-effort request: it is never logged, queued or restored.
  ///
  /// A deferred logout that lost its entry (cancel, fence, account switch, new
  /// sign-in) performs **zero** reads, writes and requests: it can therefore
  /// never clear a newer credential.
  ///
  /// Neither a missing record nor an unreadable store implies a confirmed
  /// remote revocation: no request means `revocationConfirmed == false`, and
  /// `noActiveConnection` distinguishes that case explicitly.
  func logoutDetailed(
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) async -> VeyraNSIWCLogoutOutcome {
    guard entry.matches(ownerAccountId: ownerAccountId) else {
      return VeyraNSIWCLogoutOutcome(
        cleared: false,
        revocationConfirmed: false,
        noActiveConnection: false
      )
    }
    // The read, the local clear and the in-memory adoption are one critical
    // section under the exact entry epoch.
    let claim: (credential: VeyraNSIWCCredential?, cleared: Bool) = withLock {
      guard entry.providerEpoch == epoch else { return (nil, false) }
      teardownLocked()
      switch documentLocked() {
      case .failed:
        // Unreadable: never written over, never reported as "nothing there".
        return (nil, false)
      case .missing:
        return (nil, true)
      case let .document(document):
        guard let credential = document.credential,
          credential.ownerAccountId == ownerAccountId
        else { return (nil, true) }
        let next = document.withCredential(nil)
        guard store.save(next) else { return (credential, false) }
        cachedDocument = .loaded(next)
        return (credential, true)
      }
    }
    let cleared = claim.cleared
    guard let credential = claim.credential else {
      // No record: there is nothing to revoke, and nothing was confirmed.
      return VeyraNSIWCLogoutOutcome(
        cleared: cleared,
        revocationConfirmed: false,
        noActiveConnection: claim.cleared
      )
    }
    // The local clear already happened under the entry guard. The best-effort
    // revocation is only attempted while the entry still owns the store, so a
    // superseded logout issues no request at all.
    guard entry.providerEpoch == currentEpoch() else {
      return VeyraNSIWCLogoutOutcome(
        cleared: cleared,
        revocationConfirmed: false,
        noActiveConnection: false
      )
    }
    // Prefer the refresh token (it mints new access); a credential without one
    // still revokes its access token instead of silently skipping the request.
    let token: String
    let hint: String
    if let refreshToken = credential.refreshToken {
      token = refreshToken
      hint = "refresh_token"
    } else {
      token = credential.accessToken
      hint = "access_token"
    }
    guard let body = VeyraNSIWCTokenRequest.revocation(
      token: token,
      clientId: credential.clientId,
      hint: hint
    ) else {
      return VeyraNSIWCLogoutOutcome(
        cleared: cleared,
        revocationConfirmed: false,
        noActiveConnection: false
      )
    }
    guard let endpoint = await revocationEndpoint() else {
      // An unknown outcome is reported as unknown, never as confirmed.
      return VeyraNSIWCLogoutOutcome(
        cleared: cleared,
        revocationConfirmed: false,
        noActiveConnection: false
      )
    }
    guard entry.providerEpoch == currentEpoch() else {
      return VeyraNSIWCLogoutOutcome(
        cleared: cleared,
        revocationConfirmed: false,
        noActiveConnection: false
      )
    }
    do {
      let response = try await http.send(
        VeyraNSIWCHTTPRequest(
          method: "POST",
          url: endpoint,
          headers: ["Content-Type": "application/x-www-form-urlencoded"],
          body: body
        ),
        timeout: 15
      )
      return VeyraNSIWCLogoutOutcome(
        cleared: cleared,
        revocationConfirmed: response.status == 200 && response.body.isEmpty,
        noActiveConnection: false
      )
    } catch {
      return VeyraNSIWCLogoutOutcome(
        cleared: cleared,
        revocationConfirmed: false,
        noActiveConnection: false
      )
    }
  }

  /// Logout tears the pending browser flow down and cancels the active stream.
  /// Caller must hold `lock`.
  private func teardownLocked() {
    pendingFlow = nil
    claimedAttempt = nil
    if activeStreamID != 0 {
      canceledStreamIDs.insert(activeStreamID)
    }
  }

  /// Resolve the revocation endpoint from the official OIDC discovery document:
  /// same origin as the fixed authorization server, HTTPS, no redirect.
  private func revocationEndpoint() async -> String? {
    do {
      let response = try await http.send(
        VeyraNSIWCHTTPRequest(
          method: "GET",
          url: VeyraNSIWC.discoveryEndpoint,
          headers: ["Accept": "application/json"],
          body: nil
        ),
        timeout: 15
      )
      guard response.status == 200 else { return nil }
      guard let value = try? JSONSerialization.jsonObject(
        with: response.body,
        options: [.fragmentsAllowed]
      ), let object = value as? [String: Any],
        let raw = object["revocation_endpoint"] as? String
      else { return nil }
      return VeyraNSIWCValidate.discoveryEndpoint(raw)
    } catch {
      return nil
    }
  }

  // MARK: token endpoint

  private func exchange(
    code: String,
    clientId: String,
    verifier: String,
    redirectURI: String
  ) async throws -> VeyraNSIWCTokenResponse {
    guard let body = VeyraNSIWCTokenRequest.exchange(
      code: code,
      clientId: clientId,
      verifier: verifier,
      redirectURI: redirectURI
    ) else { throw VeyraNSIWCError.callbackInvalid }
    let response = try await http.send(
      VeyraNSIWCHTTPRequest(
        method: "POST",
        url: VeyraNSIWC.tokenEndpoint,
        headers: ["Content-Type": "application/x-www-form-urlencoded"],
        body: body
      ),
      timeout: 30
    )
    guard response.status == 200, let token = parseTokenResponse(response.body)
    else { throw VeyraNSIWCError.tokenInvalid }
    return token
  }

  private func verifiedIdentity(
    token: VeyraNSIWCTokenResponse,
    clientId: String,
    nonce: String,
    epoch flowEpoch: Int
  ) async throws -> (subject: String, email: String?, idToken: String) {
    guard let idToken = token.idToken else {
      throw VeyraNSIWCError.tokenInvalid
    }
    let jwks = try await fetchJWKS(epoch: flowEpoch)
    try requireEpoch(flowEpoch)
    guard let claims = VeyraNSIWCJWT.verify(
      token: idToken,
      jwks: jwks,
      now: clock.now(),
      expectedIssuer: VeyraNSIWC.issuer,
      expectedAudience: clientId,
      expectedNonce: nonce
    ) else { throw VeyraNSIWCError.tokenInvalid }
    return (claims.subject, claims.email, idToken)
  }

  private func fetchJWKS(epoch flowEpoch: Int) async throws -> VeyraNSIWCJWKS {
    try requireEpoch(flowEpoch)
    let response = try await http.send(
      VeyraNSIWCHTTPRequest(
        method: "GET",
        url: VeyraNSIWC.jwksEndpoint,
        headers: ["Accept": "application/json"],
        body: nil
      ),
      timeout: 30
    )
    try requireEpoch(flowEpoch)
    guard response.status == 200,
      let jwks = VeyraNSIWCJWKS.parse(response.body)
    else { throw VeyraNSIWCError.tokenInvalid }
    return jwks
  }

  // MARK: linearized credential store commits
  //
  // Every store write happens inside *one* lock critical section together with
  // its epoch/identity guard and the in-memory adoption (the shape of
  // `VeyraNConnectLifecycle.commitPick`). A fence therefore either lands before
  // the critical section — the guard fails and *nothing* is written — or it
  // lands after it and owns the final state. There is no window in which a check
  // and its write can be separated, and no `await` is ever performed while the
  // lock is held.

  private enum VeyraNSIWCCommit: Equatable {
    case committed
    case stale
    case refusedIdentity
    case storeFailed
  }

  /// Persist the credential of a completed authorization together with its
  /// verified registration.
  private func commitAuthorization(
    attempt: Int,
    epoch flowEpoch: Int,
    credential: VeyraNSIWCCredential,
    email: String?,
    subject: String
  ) -> VeyraNSIWCCommit {
    withLock {
      // The commit is owned by the *exact* claimed attempt: a fence (epoch) or a
      // cancel/supersede that disowned the claim (attempt) both refuse it. This
      // is the ownership guard, not a global credential delete.
      guard flowEpoch == epoch, claimedAttempt == attempt else { return .stale }
      let urn: String
      do {
        urn = try ensureHostLocked()
      } catch {
        return .storeFailed
      }
      let document: VeyraNSIWCPersisted
      switch documentLocked() {
      case let .document(existing):
        document = existing
      case .missing:
        document = VeyraNSIWCPersisted.empty(hostURN: urn)
      case .failed:
        return .storeFailed
      }
      let registration = VeyraNSIWCRegistration(
        clientId: credential.clientId,
        subject: subject,
        email: email,
        createdAt: document.registration(clientId: credential.clientId)?.createdAt
          ?? Int(clock.now().timeIntervalSince1970)
      )
      guard let withRegistration = document.withRegistration(registration)
      else { return .refusedIdentity }
      let next = withRegistration.withCredential(credential)
      guard store.save(next) else { return .storeFailed }
      cachedDocument = .loaded(next)
      return .committed
    }
  }

  /// Retain the first-time registration as *incomplete* before the exchange.
  private func commitPendingRegistration(
    clientId: String,
    attempt: Int,
    epoch flowEpoch: Int
  ) -> VeyraNSIWCCommit {
    withLock {
      guard flowEpoch == epoch, claimedAttempt == attempt else { return .stale }
      let urn: String
      do {
        urn = try ensureHostLocked()
      } catch {
        return .storeFailed
      }
      let document: VeyraNSIWCPersisted
      switch documentLocked() {
      case let .document(existing):
        document = existing
      case .missing:
        document = VeyraNSIWCPersisted.empty(hostURN: urn)
      case .failed:
        return .storeFailed
      }
      let registration = VeyraNSIWCRegistration(
        clientId: clientId,
        subject: nil,
        email: nil,
        createdAt: Int(clock.now().timeIntervalSince1970)
      )
      guard let next = document.withRegistration(registration)
      else { return .refusedIdentity }
      guard store.save(next) else { return .storeFailed }
      cachedDocument = .loaded(next)
      return .committed
    }
  }

  /// Replace exactly the source credential of one refresh flight, under the
  /// exact epoch.
  private func commitRefresh(
    epoch flowEpoch: Int,
    from source: VeyraNSIWCCredential,
    to replacement: VeyraNSIWCCredential,
    email: String?,
    ownerAccountId: String
  ) -> VeyraNSIWCCommit {
    withLock {
      guard flowEpoch == epoch else { return .stale }
      guard case let .document(document) = documentLocked(),
        let live = document.credential,
        live.ownerAccountId == ownerAccountId,
        live.matchesIdentity(of: source)
      else { return .stale }
      var nextDocument = document
      if let email,
        let registration = document.registration(clientId: source.clientId)
      {
        let updatedRegistration = VeyraNSIWCRegistration(
          clientId: registration.clientId,
          subject: registration.subject,
          email: email,
          createdAt: registration.createdAt
        )
        guard let next = nextDocument.withRegistration(updatedRegistration)
        else { return .refusedIdentity }
        nextDocument = next
      }
      let next = nextDocument.withCredential(replacement)
      guard store.save(next) else { return .storeFailed }
      cachedDocument = .loaded(next)
      return .committed
    }
  }

  /// Clear the credential only while the *exact* credential a flight started
  /// from is still the live one under the *exact* epoch. Returns `false` when a
  /// newer credential (or a fence, or an unreadable record) owns the store:
  /// nothing is written.
  @discardableResult
  private func clearCredential(
    ifCurrent source: VeyraNSIWCCredential,
    epoch flowEpoch: Int
  ) -> Bool {
    withLock {
      guard flowEpoch == epoch else { return false }
      guard case let .document(document) = documentLocked(),
        let live = document.credential,
        live.matchesIdentity(of: source)
      else { return false }
      let next = document.withCredential(nil)
      guard store.save(next) else { return false }
      cachedDocument = .loaded(next)
      return true
    }
  }

  // MARK: small helpers

  private func requireEpoch(_ value: Int) throws {
    guard currentEpoch() == value else {
      throw VeyraNSIWCError.accountChanged
    }
  }

  private func currentCredential(
    ownerAccountId: String,
    entry: VeyraNSIWCProviderEntry
  ) throws -> VeyraNSIWCCredential {
    switch credentialStatus(ownerAccountId: ownerAccountId, entry: entry) {
    case let .ready(credential), let .missingPermission(credential):
      return credential
    case .stale:
      throw VeyraNSIWCError.accountChanged
    case .signedOut:
      throw VeyraNSIWCError.notSignedIn
    case .keychainFailure:
      throw VeyraNSIWCError.keychainFailure
    }
  }

  private func parseTokenResponse(_ data: Data) -> VeyraNSIWCTokenResponse? {
    guard !data.isEmpty, data.count <= VeyraNSIWC.maxTokenBytes else {
      return nil
    }
    guard let text = String(data: data, encoding: .utf8),
      VeyraNConnectStrictJSON.hasUniqueObjectKeys(text),
      let value = try? JSONSerialization.jsonObject(
        with: data,
        options: [.fragmentsAllowed]
      ),
      let object = value as? [String: Any],
      let accessToken = object["access_token"] as? String,
      VeyraNSIWCValidate.tokenString(accessToken)
    else { return nil }
    // The officially documented `earliest_refresh_at` is accepted (its type and
    // units are not documented, so it is neither guessed nor rejected and never
    // used as a schedule) and every other documented field is validated below.
    // Any *unknown* key still fails the whole response closed.
    let allowed: Set<String> = [
      "access_token", "refresh_token", "id_token", "scope", "token_type",
      "expires_in", "earliest_refresh_at"
    ]
    guard Set(object.keys).isSubset(of: allowed) else { return nil }

    // The official `token_type` is a string and must be `Bearer`. A malformed
    // (non-string) or non-Bearer value is rejected, never ignored.
    if let rawType = object["token_type"], !(rawType is NSNull) {
      guard let tokenType = rawType as? String, tokenType == "Bearer" else {
        return nil
      }
    }

    var refreshToken: String?
    if let raw = object["refresh_token"], !(raw is NSNull) {
      guard let parsed = raw as? String, VeyraNSIWCValidate.tokenString(parsed)
      else { return nil }
      refreshToken = parsed
    }
    var idToken: String?
    if let raw = object["id_token"], !(raw is NSNull) {
      guard let parsed = raw as? String, VeyraNSIWCValidate.tokenString(parsed)
      else { return nil }
      idToken = parsed
    }
    // Only an *actually returned* scope set is ever adopted. A missing `scope`
    // is NOT widened to the full requested set (the standard permits the issuer
    // to omit it, but an omitted grant is not evidence of a granted direct
    // scope): the identity is still retained, and the direct-scope gate then
    // truthfully reports `MISSING_PLAN_SCOPE` before any model or inference
    // work. Scopes are never invented.
    var scopes: [String] = []
    if let raw = object["scope"], !(raw is NSNull) {
      guard let scope = raw as? String else { return nil }
      let parsed = scope.split(separator: " ").map(String.init)
      guard !parsed.isEmpty, parsed.count <= 64,
        parsed.allSatisfy({ VeyraNSIWCValidate.opaque($0, max: 128) })
      else { return nil }
      scopes = parsed
    }
    var expiresIn: Int?
    if let raw = object["expires_in"], !(raw is NSNull) {
      guard let parsed = VeyraNConnectValidate.strictInt(raw), parsed >= 0
      else { return nil }
      expiresIn = parsed
    }
    return VeyraNSIWCTokenResponse(
      accessToken: accessToken,
      refreshToken: refreshToken,
      idToken: idToken,
      grantedScopes: scopes,
      expiresIn: expiresIn
    )
  }

  private static func extractDelta(_ data: String) -> String? {
    guard data.utf8.count <= VeyraNSIWC.maxLineBytes else { return nil }
    guard let bytes = data.data(using: .utf8),
      VeyraNConnectStrictJSON.hasUniqueObjectKeys(data),
      let value = try? JSONSerialization.jsonObject(
        with: bytes,
        options: [.fragmentsAllowed]
      ),
      let object = value as? [String: Any],
      object["type"] as? String == "response.output_text.delta",
      let delta = object["delta"] as? String
    else { return nil }
    return delta
  }

  /// A bounded provider error code from an `error`/`response.failed` event.
  ///
  /// The official `response.failed` packet nests the error inside the response
  /// object (`{"type":"response.failed","response":{...,"error":{"code":…}}}`),
  /// so that shape is checked first; the flat `error.code`, a top-level `code`
  /// and a nested `response.code` are also recognized. Everything else is
  /// ignored (never surfaced as a raw body).
  private static func extractErrorCode(_ data: String) -> String? {
    guard let bytes = data.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(
        with: bytes,
        options: [.fragmentsAllowed]
      ),
      let object = value as? [String: Any]
    else { return nil }
    if let response = object["response"] as? [String: Any] {
      if let error = response["error"] as? [String: Any],
        let code = boundedCode(error["code"])
      {
        return code
      }
      if let code = boundedCode(response["code"]) { return code }
    }
    if let error = object["error"] as? [String: Any],
      let code = boundedCode(error["code"])
    {
      return code
    }
    return boundedCode(object["code"])
  }

  /// A bounded, alphanumeric provider code; longer/odder values are dropped.
  private static func boundedCode(_ value: Any?) -> String? {
    guard let code = value as? String, !code.isEmpty, code.utf8.count <= 128
    else { return nil }
    for scalar in code.unicodeScalars {
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9", "_", "-", ".", ":":
        continue
      default:
        return nil
      }
    }
    return code
  }

  /// Map an HTTP status + optional catalogued provider code to a static error.
  static func error(status: Int, providerCode: String?) -> VeyraNSIWCError {
    if let code = providerCode {
      switch code {
      case "subscription_sharing_user_not_eligible": return .notEligible
      case "subscription_sharing_usage_limit_exceeded", "usage_limit_exceeded":
        return .usageLimitExceeded
      case "usage_unavailable", "subscription_sharing_usage_unavailable":
        return .usageUnavailable
      case "invalid_user", "subscription_sharing_invalid_user":
        return .invalidUser
      default: break
      }
    }
    switch status {
    case 401: return .invalidUser
    case 403: return .notEligible
    case 429: return .usageLimitExceeded
    case 503: return .usageUnavailable
    default: return .streamInvalid
    }
  }
}

// MARK: - credential identity

extension VeyraNSIWCCredential {
  /// The exact-identity comparison behind every late credential read, write and
  /// delete: two values are the *same live credential* only when the own client
  /// id, the verified subject, the Notes owner and both rotating secrets match.
  func matchesIdentity(of other: VeyraNSIWCCredential) -> Bool {
    clientId == other.clientId
      && subject == other.subject
      && ownerAccountId == other.ownerAccountId
      && accessToken == other.accessToken
      && refreshToken == other.refreshToken
  }
}

// MARK: - callback / logout outcome values

/// The outcome of one callback attempt.
///
/// `claimed` is true only when *this* exact, fully correlated callback
/// atomically consumed the pending flow — so a replay or a concurrent second
/// exchange can never claim it again. A rejected attempt consumed nothing: the
/// pending flow, the listener and the browser session stay alive for the genuine
/// callback.
struct VeyraNSIWCCallbackResult {
  let claimed: Bool
  let credential: VeyraNSIWCCredential?
  let failure: VeyraNSIWCError?

  static func rejected(_ error: VeyraNSIWCError) -> VeyraNSIWCCallbackResult {
    VeyraNSIWCCallbackResult(claimed: false, credential: nil, failure: error)
  }

  static func claimed(_ error: VeyraNSIWCError) -> VeyraNSIWCCallbackResult {
    VeyraNSIWCCallbackResult(claimed: true, credential: nil, failure: error)
  }

  static func authenticated(_ credential: VeyraNSIWCCredential) -> VeyraNSIWCCallbackResult {
    VeyraNSIWCCallbackResult(claimed: true, credential: credential, failure: nil)
  }
}

/// The synchronous admission outcome of one callback attempt.
enum VeyraNSIWCCallbackAdmission {
  /// Nothing was consumed: the pending flow, the listener and its TTL deadline
  /// all stay alive for the genuine callback (or the one expiry).
  case rejected(VeyraNSIWCError)
  /// The exact pending flow was atomically claimed; `finishCallback` may now run
  /// the bounded exchange for it, exactly once.
  case admitted(VeyraNSIWCPreparedCallback)
}

/// A sealed, single-use claim over one exact, fully validated pending flow.
///
/// It exists only after `prepareCallback` has synchronously passed every
/// validation and atomically consumed the flow, so holding it proves this exact
/// callback — not a replay, not a concurrent twin, not a same-state sibling
/// attempt at the same epoch — owns the flow. `consume()` returns `true` exactly
/// once: a prepared ticket can therefore never drive a second exchange or a
/// second terminal event.
final class VeyraNSIWCPreparedCallback {
  fileprivate let flow: VeyraNSIWCPendingFlow
  fileprivate let issuedClientId: String
  fileprivate let code: String?
  /// A claimed outcome that needs no exchange (a correlated provider error, an
  /// invalid issued client id, or a registration conflict).
  fileprivate let immediate: VeyraNSIWCError?

  private let lock = NSLock()
  private var consumed = false

  fileprivate init(
    flow: VeyraNSIWCPendingFlow,
    issuedClientId: String,
    code: String?,
    immediate: VeyraNSIWCError?
  ) {
    self.flow = flow
    self.issuedClientId = issuedClientId
    self.code = code
    self.immediate = immediate
  }

  /// Consume the ticket exactly once. `false` means it is already spent, so the
  /// caller performs no work at all.
  func consume() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if consumed { return false }
    consumed = true
    return true
  }
}

/// The complete logout outcome. `revocationConfirmed` is true only for an
/// actually confirmed remote revocation (a 200 with an empty body for the one
/// best-effort request); `noActiveConnection` marks the no-credential case so an
/// absent record is never reported as a confirmed revocation.
struct VeyraNSIWCLogoutOutcome: Equatable {
  let cleared: Bool
  let revocationConfirmed: Bool
  let noActiveConnection: Bool
}
