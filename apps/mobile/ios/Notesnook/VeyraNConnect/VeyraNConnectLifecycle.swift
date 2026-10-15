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

// The single native lifecycle linearization primitive for VeyraN Connect.
//
// Every lifecycle decision — authorization of a pairing pick, the credential
// store, memory/engine adoption, stop invalidation and disconnect deletion —
// happens inside *one* lock, as a guarded synchronous closure. The previous
// split (a pair gate with its own lock, a module lock, and a Keychain call
// between two separately locked sections) left two resurrection windows:
//
//   1. a picker completion could take the store slot, then lose the lock while
//      a disconnect ran to completion, and finally save + adopt the credential
//      after the disconnect had deleted it;
//   2. `ensureEngine` could snapshot the epoch before taking the module lock,
//      be preempted for the whole disconnect, and then adopt the previous
//      pairing/engine because the cached comparison still matched.
//
// Both are closed by construction here: the check, the credential store call,
// the re-check and the memory adoption are one critical section, so no fence
// (stop, disconnect, lock, unmount, account change, re-pair, new pick) can
// interleave with a commit or an engine adoption. A fence that lands *before*
// the critical section wins (the token/epoch no longer matches ⇒ zero writes);
// a fence that lands *after* it owns the final state (the engine is invalidated
// and the credential deleted synchronously inside the fence).
//
// Lock order is fixed and one-way: the lifecycle lock is always taken first,
// the engine's own lock only ever nested inside it (`invalidate()`). Nothing in
// this file calls back into the lifecycle while the lock is held, and the
// injected credential store closures must be pure storage access that never
// re-enters the lifecycle.
//
// This file imports only Foundation, so the exact production primitive is
// exercised by the standalone harness with an injected synthetic credential
// store, an injected engine factory and real concurrent threads — no Keychain,
// app, entitlement or simulator.

import Foundation

// MARK: - injected seams

/// The credential storage behind the lifecycle. The production adapter is the
/// module-owned Keychain record; the harness injects a synthetic store. All
/// methods are synchronous and must never call back into the lifecycle.
protocol VeyraNConnectCredentialStore {
  /// The stored pairing, or `nil` when absent/unreadable.
  func load() -> VeyraNConnectPairing?
  /// Replace the stored pairing; `false` on any failure (fail closed).
  @discardableResult
  func save(_ pairing: VeyraNConnectPairing) -> Bool
  /// Remove only this module's record; `false` when it could not be removed.
  @discardableResult
  func delete() -> Bool
}

/// The only thing the lifecycle needs from a session engine: the ability to
/// invalidate it and to read its monotonic lease generation. The concrete
/// `VeyraNConnectSessionEngine` conforms below; the harness injects a synthetic
/// engine that records the call.
protocol VeyraNConnectLifecycleEngine: AnyObject {
  /// Abort the session and bump its lease generation, returning the new
  /// generation. Never blocks.
  @discardableResult
  func invalidate() -> Int
  /// The engine's current monotonic lease generation. Read *inside* the
  /// lifecycle lock, so the value captured with an engine adoption can never
  /// desynchronize from the adoption itself.
  func currentLeaseGeneration() -> Int
}

extension VeyraNConnectSessionEngine: VeyraNConnectLifecycleEngine {}

// MARK: - lifecycle

/// One monotonic epoch fences every lifecycle transition; one monotonic pick
/// generation owns the single pending pairing pick. Both, together with the
/// cached pairing/engine, are mutated only under one lock.
final class VeyraNConnectLifecycle<Engine: VeyraNConnectLifecycleEngine> {
  /// The identity of one pairing pick: valid only at its exact epoch and while
  /// it is still the pending pick.
  struct Token: Equatable {
    let epoch: Int
    let generation: Int
  }

  /// The outcome of one picker completion. `stale` and `storeFailed` both mean
  /// *nothing was adopted in memory*; only `stale` guarantees that this commit
  /// wrote nothing to the credential store.
  enum CommitResult: Equatable {
    /// The credential was stored and adopted; the previous engine is invalid.
    case stored
    /// The token no longer owns the store slot: the pick was fenced (stop,
    /// disconnect, lock, unmount, account change, concurrent pick) before any
    /// store call. Zero writes.
    case stale
    /// The token was current, but the credential store refused the write. The
    /// pick slot is consumed; nothing is adopted.
    case storeFailed
  }

  private let store: VeyraNConnectCredentialStore
  private let lock = NSLock()

  // Guarded by `lock`.
  private var epoch = 0
  private var pendingPick: Int?
  private var nextPick = 0
  private var pairing: VeyraNConnectPairing?
  private var engine: Engine?

  init(store: VeyraNConnectCredentialStore) {
    self.store = store
  }

  /// Run `body` while holding the lifecycle lock. Never call any public method
  /// of this type from inside `body` (the lock is not recursive).
  @inline(__always)
  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  // MARK: epoch

  /// The current lifecycle epoch. Callers snapshot this value and pass it back
  /// to `ensureEngine`; a fence that landed in between makes it stale.
  func currentEpoch() -> Int {
    withLock { epoch }
  }

  /// Bump the epoch and drop any pending pick: stop, disconnect, lock,
  /// unmount, account change, engine replacement. A picker still on screen is
  /// stale from this moment on and can never reach the credential store.
  @discardableResult
  func invalidate() -> Int {
    withLock { bumpEpoch() }
  }

  // MARK: pick

  /// Fence the lifecycle and open a fresh pick generation in one atomic step.
  ///
  /// This is the only correct way to open a picker: doing "invalidate, then
  /// beginPick" as separate locked steps would let a disconnect complete in
  /// between, and the pick would then be stamped with the *post-disconnect*
  /// epoch — a late completion would still pass the token check and resurrect
  /// the credential after the disconnect deleted it.
  @discardableResult
  func fenceAndBeginPick() -> Token {
    withLock {
      _ = bumpEpoch()
      engine?.invalidate()
      return openPick()
    }
  }

  /// True while a pairing pick is still pending (diagnostics/tests).
  func hasPendingPick() -> Bool {
    withLock { pendingPick != nil }
  }

  /// True only while `token` still owns the pending pick slot at the current
  /// epoch. This is the exact predicate the module re-checks when deferred
  /// (main-queue) work that was scheduled at the *native method entry* actually
  /// runs: a stop/disconnect/re-pair or a newer pick that landed while the work
  /// was queued makes the entry token stale, so the queued work bails before it
  /// shows the picker or touches the poll loop. It never re-stamps a fresh token
  /// at queue-execution time.
  func isCurrentPick(_ token: Token) -> Bool {
    withLock { pendingPick == token.generation && epoch == token.epoch }
  }

  /// Commit one picker completion atomically: authorize the token, write the
  /// credential, re-check, invalidate + drop the previous engine and adopt the
  /// new pairing — all in one critical section.
  func commitPick(
    token: Token,
    pairing newPairing: VeyraNConnectPairing
  ) -> CommitResult {
    withLock {
      guard pendingPick == token.generation, epoch == token.epoch else {
        // A fence or a newer pick owns the state: no store call at all.
        return .stale
      }
      // Consume the slot *before* the store call, so a failed save can never be
      // retried by a duplicate completion of the same pick.
      pendingPick = nil
      guard store.save(newPairing) else { return .storeFailed }
      // The whole check+save+adopt is one critical section, so no fence can
      // have interleaved; the re-check is kept so the invariant is enforced
      // locally even if `save` ever changes shape.
      guard epoch == token.epoch else {
        // Roll back exactly what this commit wrote (nothing else can have
        // written in between: the store calls are inside this lock).
        _ = store.delete()
        return .stale
      }
      engine?.invalidate()
      engine = nil
      pairing = newPairing
      return .stored
    }
  }

  // MARK: session

  /// Fence the epoch, drop any pending pick and invalidate the live engine.
  /// The pairing and the (invalidated) engine stay cached so an explicit start
  /// can reuse them; the credential is *not* touched.
  @discardableResult
  func stop() -> Int {
    withLock {
      let newEpoch = bumpEpoch()
      engine?.invalidate()
      return newEpoch
    }
  }

  /// Fence the epoch, invalidate *and drop* the engine, drop the cached
  /// pairing and delete the stored credential — one critical section.
  ///
  /// A concurrent `commitPick` that already entered its critical section wins
  /// the store call (this method waits for it), and then this method deletes
  /// what it wrote and clears the memory: after `disconnect()` returns, memory
  /// and credential are `nil` in every interleaving.
  @discardableResult
  func disconnect() -> Bool {
    withLock {
      _ = bumpEpoch()
      engine?.invalidate()
      engine = nil
      pairing = nil
      return store.delete()
    }
  }

  /// Build (or reuse) the engine atomically against the *live* epoch, and
  /// return it together with the exact lease generation it had at the moment of
  /// adoption.
  ///
  /// `requestedEpoch` is the caller's snapshot. A stop/disconnect/re-pair that
  /// completed after the snapshot fails the check *inside the same lock* that
  /// adopts the engine, so the previous pairing/engine can never be adopted
  /// after a disconnect. A fence that lands while `make` runs waits for this
  /// critical section and then invalidates + drops the engine it adopted.
  ///
  /// The returned `expectedLease` is read *inside* this critical section, so it
  /// is atomic with the adoption: a stop/disconnect that lands after
  /// `ensureEngine` returns but before the caller enters `establishSession`
  /// bumps the engine's lease generation, and the handshake's first engine-lock
  /// check refuses the mismatch before any health/session traffic. A separate
  /// (unlocked) lease read after this returns would reopen exactly that window.
  func ensureEngine(
    epoch requestedEpoch: Int,
    make: (VeyraNConnectPairing) throws -> Engine
  ) throws -> (engine: Engine, expectedLease: Int) {
    try withLock {
      guard requestedEpoch == epoch else {
        throw VeyraNConnectError.sessionRequired
      }
      if let engine {
        return (engine, engine.currentLeaseGeneration())
      }
      guard let resolved = pairing ?? store.load() else {
        throw VeyraNConnectError.notPaired
      }
      let built = try make(resolved)
      // Same lock, so the epoch cannot have changed; kept explicit so adoption
      // and authorization are provably one step.
      guard requestedEpoch == epoch else {
        built.invalidate()
        throw VeyraNConnectError.sessionRequired
      }
      pairing = resolved
      engine = built
      return (built, built.currentLeaseGeneration())
    }
  }

  /// The live engine, or `nil` after a disconnect.
  func currentEngine() -> Engine? {
    withLock { engine }
  }

  /// The cached pairing, falling back to the credential store. The read runs
  /// inside the lifecycle lock, so it can never observe a credential written by
  /// a commit that a concurrent fence has already invalidated.
  func pairingOrStored() -> VeyraNConnectPairing? {
    withLock { pairing ?? store.load() }
  }

  // MARK: internals

  /// Bump the epoch and drop the pending pick. Must be called with the lock
  /// held; never calls another locked method.
  @discardableResult
  private func bumpEpoch() -> Int {
    epoch += 1
    pendingPick = nil
    return epoch
  }

  /// Open a new pick generation. Must be called with the lock held.
  private func openPick() -> Token {
    nextPick += 1
    pendingPick = nextPick
    return Token(epoch: epoch, generation: nextPick)
  }
}
