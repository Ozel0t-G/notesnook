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

// The React Native bridge for the VeyraN Connect native client.
//
// The native side is the *outgoing* loopback broker client only: it holds the
// paired credential (never exposed to JS), establishes the broker session and
// polls one correlated claim at a time, emitting each validated request to
// JavaScript. JavaScript executes the request against the encrypted Core
// domain and answers through `reply`. The API is deliberately small and typed.
//
// Mac Catalyst is the only supported platform; every method answers
// `supported: false` elsewhere instead of pretending, and no Keychain or engine
// operation ever runs on an unsupported platform.

import Foundation
import React

@objc(VeyraNConnectModule)
final class VeyraNConnectModule: RCTEventEmitter {
  /// Largest integer JavaScript can represent exactly.
  private static let maxSafeInteger = 9_007_199_254_740_991

  private let lock = NSLock()
  private var picker: AnyObject?
  private var pollTask: Task<Void, Never>?
  private var observing = false
  /// The *single* lifecycle linearization primitive. It owns the epoch, the
  /// pending pick, the cached pairing/engine and the credential store, and
  /// performs authorization, the Keychain write/delete and the memory/engine
  /// adoption inside one critical section. A picker completion whose token no
  /// longer matches can never reach the Keychain store, and an in-flight
  /// `ensureEngine` whose epoch no longer matches is discarded; neither can
  /// resurrect a credential/engine after a disconnect.
  private let lifecycle = VeyraNConnectLifecycle<VeyraNConnectSessionEngine>(
    store: VeyraNConnectKeychainCredentialStore()
  )

  @objc override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { ["connectRequest"] }

  override func startObserving() {
    lock.lock()
    observing = true
    lock.unlock()
  }

  override func stopObserving() {
    lock.lock()
    observing = false
    lock.unlock()
  }

  // MARK: pairing

  @objc(pickPairingFile:rejecter:)
  func pickPairingFile(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    // Importing a file must never race a live broker session: fence the
    // lifecycle, invalidate the live engine and open a *new* pick generation
    // synchronously at the native method entry — *before* the main-queue hop.
    // Claiming the token here (rather than inside the queued block) is what
    // makes a disconnect that lands while this work is queued effective: the
    // token then belongs to the pre-disconnect epoch, so the queued work must
    // verify it is still current and bail instead of re-stamping a fresh
    // post-disconnect token that a late picker would store. A re-pair therefore
    // only ever replaces an already-invalidated engine, and a disconnect can
    // only land either before this fence (making the pick stale) or after the
    // completion (owning the final state).
    let token = lifecycle.fenceAndBeginPick()
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      // The queued block consumes the exact entry token; it never calls
      // `fenceAndBeginPick()` itself. If a stop/disconnect/re-pair or a newer
      // pick landed while this work was queued the token is stale: resolve
      // truthfully, present no picker and leave the poll loop of a newer
      // pairing untouched.
      guard self.lifecycle.isCurrentPick(token) else {
        resolve(["paired": false, "cancelled": true, "stale": true])
        return
      }
      self.stopPolling()
      let picker = VeyraNConnectPairingPicker { [weak self] result in
        guard let self else { return }
        self.picker = nil
        switch result {
        case let .success(pairing):
          // The completion is authorized, stored and adopted in one critical
          // section: a lock, disconnect, unmount, account switch or a
          // concurrent pick that landed while the picker was open makes the
          // token stale and no store call at all happens.
          switch self.lifecycle.commitPick(token: token, pairing: pairing) {
          case .stored:
            // The adopted engine replaces (and has already invalidated) the
            // previous one: stop its poll loop here as well. A *stale*
            // completion deliberately does not, so it can never stop a poll
            // loop that belongs to a newer pairing.
            self.stopPolling()
            resolve([
              "paired": true,
              "brokerId": pairing.brokerId,
              "port": pairing.port
            ])
          case .storeFailed:
            reject("keychain_failure", VeyraNConnectError.keychainFailure.code, nil)
          case .stale:
            resolve(["paired": false, "cancelled": true, "stale": true])
          }
        case let .failure(error):
          if error == .pairingCancelled {
            resolve(["paired": false, "cancelled": true])
          } else {
            reject(error.code, error.code, nil)
          }
        }
      }
      self.picker = picker
      picker.start()
    }
    #else
    resolve(["paired": false, "supported": false])
    #endif
  }

  @objc(getStatus:rejecter:)
  func getStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    if let engine = lifecycle.currentEngine() {
      resolve(engine.statusSummary().jsonObject)
      return
    }
    if let pairing = lifecycle.pairingOrStored() {
      resolve([
        "paired": true,
        "brokerId": pairing.brokerId,
        "port": pairing.port,
        "sessionActive": false
      ])
      return
    }
    resolve(["paired": false, "sessionActive": false])
    #else
    resolve(["paired": false, "sessionActive": false, "supported": false])
    #endif
  }

  // MARK: session

  @objc(startSession:grantsGeneration:clientId:resolver:rejecter:)
  func startSession(
    _ accountId: String,
    grantsGeneration: NSNumber,
    clientId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    let generation = grantsGeneration.intValue
    guard generation >= 0, generation <= Self.maxSafeInteger else {
      reject(VeyraNConnectError.responseInvalid.code, "invalid generation", nil)
      return
    }
    // Snapshot the epoch synchronously at the native method entry, *before*
    // the Task is scheduled. Reading it inside the Task would let a stop that
    // landed while the work was queued be observed as the "current" epoch,
    // reopening the adoption-after-stop window.
    let entryEpoch = lifecycle.currentEpoch()
    Task { [weak self] in
      guard let self else { return }
      do {
        let adopted = try self.lifecycle.ensureEngine(
          epoch: entryEpoch,
          make: Self.makeEngine
        )
        let engine = adopted.engine
        // The lease was captured atomically with the adoption, so a
        // stop/disconnect that landed between the adoption and this handshake
        // is refused by the first engine-lock check before any broker traffic.
        let session = try await engine.establishSession(
          accountId: accountId,
          grantsGeneration: generation,
          clientId: clientId,
          expectedLease: adopted.expectedLease
        )
        // A re-pair / stop / disconnect that landed during the handshake must
        // not leave a live session behind under the previous pairing.
        guard self.lifecycle.currentEpoch() == entryEpoch,
          self.lifecycle.currentEngine() === engine
        else {
          engine.invalidate()
          reject(VeyraNConnectError.sessionRequired.code, "session replaced", nil)
          return
        }
        guard let context = engine.sessionContext() else {
          engine.invalidate()
          reject(VeyraNConnectError.sessionRequired.code, "no session", nil)
          return
        }
        // Phase one deliberately does NOT start polling. The lease generation
        // is returned so JS can adopt the exact context and then activate it;
        // no event can be emitted before that activation resolves.
        resolve([
          "sessionId": session.sessionId,
          "grantsGeneration": session.grantsGeneration,
          "nativeLeaseGeneration": context.generation
        ])
      } catch let error as VeyraNConnectError {
        reject(error.code, error.code, nil)
      } catch {
        reject(
          VeyraNConnectError.transportUnavailable.code,
          VeyraNConnectError.transportUnavailable.code,
          nil
        )
      }
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  @objc(activateSession:sessionId:resolver:rejecter:)
  func activateSession(
    _ nativeLeaseGeneration: NSNumber,
    sessionId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    let lease = nativeLeaseGeneration.intValue
    guard lease >= 0, lease <= Self.maxSafeInteger else {
      reject(VeyraNConnectError.responseInvalid.code, "invalid generation", nil)
      return
    }
    Task { [weak self] in
      guard let self else { return }
      let epoch = self.lifecycle.currentEpoch()
      // Re-check the exact (flow, session) tuple against the live engine before
      // any poll begins. A stop/re-pair that landed in between fails closed.
      guard self.lifecycle.currentEpoch() == epoch,
        let engine = self.lifecycle.currentEngine(),
        engine.isActive(),
        let context = engine.sessionContext(),
        context.generation == lease,
        context.sessionId == sessionId,
        self.lifecycle.currentEpoch() == epoch,
        self.lifecycle.currentEngine() === engine
      else {
        reject(VeyraNConnectError.sessionRequired.code, "session replaced", nil)
        return
      }
      self.startPolling(engine: engine)
      resolve(nil)
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  @objc(stopSession:rejecter:)
  func stopSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    stopPolling()
    lifecycle.stop()
    resolve(nil)
  }

  @objc(disconnect:rejecter:)
  func disconnect(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    stopPolling()
    // Fence, invalidate + drop the engine, drop the pairing and delete the
    // Keychain record atomically: a picker completion that raced this either
    // lost the token check (no store at all) or already committed, in which
    // case this deletion removes what it wrote.
    let removed = lifecycle.disconnect()
    if removed {
      resolve(nil)
    } else {
      reject("keychain_failure", VeyraNConnectError.keychainFailure.code, nil)
    }
    #else
    // No Keychain read/delete is ever attempted on an unsupported platform.
    resolve(["paired": false, "supported": false])
    #endif
  }

  @objc(reply:response:expectedLeaseGeneration:expectedSessionId:resolver:rejecter:)
  func reply(
    _ ticketId: String,
    response: Any,
    expectedLeaseGeneration: NSNumber,
    expectedSessionId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    let lease = expectedLeaseGeneration.intValue
    guard lease >= 0, lease <= Self.maxSafeInteger else {
      reject(VeyraNConnectError.responseInvalid.code, "invalid generation", nil)
      return
    }
    guard let engine = lifecycle.currentEngine() else {
      reject(VeyraNConnectError.sessionRequired.code, "no session", nil)
      return
    }
    Task { [weak self] in
      guard let self, self.lifecycle.currentEngine() === engine else { return }
      do {
        // The expected native lease generation + session id are re-checked
        // under the engine's own lock *before* the reply is sent, so a reply
        // that belongs to a replaced session is never delivered even when the
        // ticket id happens to still be outstanding.
        try await engine.reply(
          ticketId: ticketId,
          response: response,
          expectedFlow: lease,
          expectedSessionId: expectedSessionId
        )
        resolve(["accepted": true])
      } catch let error as VeyraNConnectError {
        reject(error.code, error.code, nil)
      } catch {
        reject(
          VeyraNConnectError.responseInvalid.code,
          VeyraNConnectError.responseInvalid.code,
          nil
        )
      }
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  // MARK: internals

  /// The production engine factory: the lifecycle builds and adopts a new
  /// engine only while the exact epoch snapshot it was called with is still
  /// live, so a disconnect that completed first can never be resurrected.
  private static func makeEngine(
    pairing: VeyraNConnectPairing
  ) throws -> VeyraNConnectSessionEngine {
    let transport = try VeyraNConnectURLSessionTransport(pairing: pairing)
    return VeyraNConnectSessionEngine(pairing: pairing, transport: transport)
  }

  private func startPolling(engine: VeyraNConnectSessionEngine) {
    stopPolling()
    pollTask = Task { [weak self] in
      guard let self else { return }
      // Only poll when a JS listener owns the other end of the claim.
      while !Task.isCancelled, engine.isActive(), self.isObserving() {
        // The session lease is checked BEFORE any outstanding claim so a
        // never-replied ticket cannot wedge the loop forever.
        if engine.leaseExpired() {
          engine.invalidate()
          break
        }
        if engine.hasOutstandingClaim() {
          if engine.outstandingTicketExpired() {
            // The app never answered before the ticket deadline: drop the claim
            // as uncertain rather than retrying under a new nonce.
            engine.invalidate()
            break
          }
          try? await Task.sleep(nanoseconds: 150_000_000)
          continue
        }
        do {
          let claim = try await engine.claim()
          if case let .request(ticketId, request) = claim {
            self.emitRequest(engine: engine, ticketId: ticketId, request: request)
          } else {
            try? await Task.sleep(
              nanoseconds: UInt64(
                VeyraNConnectSessionEngine.backoffMillis(attempt: 0)
              ) * 1_000_000
            )
          }
        } catch VeyraNConnectError.busy {
          try? await Task.sleep(nanoseconds: 150_000_000)
        } catch VeyraNConnectError.sessionRequired {
          // The broker explicitly replaced/refused the session (or the engine
          // was invalidated): end the loop instead of retrying blindly.
          engine.invalidate()
          break
        } catch {
          // Bounded backoff; the loop stops as soon as the session ends.
          try? await Task.sleep(
            nanoseconds: UInt64(
              VeyraNConnectSessionEngine.backoffMillis(attempt: 1)
            ) * 1_000_000
          )
        }
      }
    }
  }

  private func stopPolling() {
    pollTask?.cancel()
    pollTask = nil
  }

  private func isObserving() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return observing
  }

  private func emitRequest(
    engine: VeyraNConnectSessionEngine,
    ticketId: String,
    request: Any
  ) {
    guard isObserving() else { return }
    guard let context = engine.sessionContext() else { return }
    // Enforce the same 1 MiB frame bound as the broker before handing the
    // request to JS. A request that cannot be represented or is oversized is
    // answered with a static in-band error rather than emitted unbounded.
    guard JSONSerialization.isValidJSONObject(request),
      let data = try? JSONSerialization.data(withJSONObject: request),
      data.count <= VeyraNConnectWire.maxRequestBytes
    else {
      let errorResponse: [String: Any] = [
        "ok": false,
        "error": [
          "code": "INVALID_INPUT",
          "message": "The request is malformed or exceeds bounded limits."
        ]
      ]
      Task { [weak self] in
        guard let self, self.lifecycle.currentEngine() === engine else { return }
        try? await engine.reply(ticketId: ticketId, response: errorResponse)
      }
      return
    }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.isObserving() else { return }
      // Re-check the session/generation at dispatch time: a re-pair or restart
      // between the claim and this hop must discard the stale event instead of
      // letting JS execute a request from a previous session.
      guard let live = engine.sessionContext(),
        live.generation == context.generation,
        live.sessionId == context.sessionId,
        self.lifecycle.currentEngine() === engine
      else { return }
      self.sendEvent(
        withName: "connectRequest",
        body: [
          "ticketId": ticketId,
          "request": request,
          "generation": context.generation,
          "sessionId": context.sessionId
        ]
      )
    }
  }
}

/// The production credential store: the module-owned Keychain record, reached
/// only from inside the lifecycle primitive's critical sections. The harness
/// injects a synthetic store instead, so no test ever touches the Keychain.
private struct VeyraNConnectKeychainCredentialStore: VeyraNConnectCredentialStore {
  func load() -> VeyraNConnectPairing? {
    VeyraNConnectKeychain.load()
  }

  @discardableResult
  func save(_ pairing: VeyraNConnectPairing) -> Bool {
    VeyraNConnectKeychain.save(pairing)
  }

  @discardableResult
  func delete() -> Bool {
    VeyraNConnectKeychain.delete()
  }
}
