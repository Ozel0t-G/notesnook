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

// The native pairing/lifecycle gate.
//
// NOTE: the module no longer wires this gate directly. Authorization, the
// credential store, memory/engine adoption, stop invalidation and disconnect
// deletion are performed by the single `VeyraNConnectLifecycle` primitive
// (`VeyraNConnectLifecycle.swift`), which folds the gate's token semantics and
// the module's formerly separate lock into one critical section. This file is
// retained as the independently harness-tested `(epoch, pick generation)`
// predicate (and as the reference for the exact token rules the lifecycle
// preserves); it is Foundation-only and touches no Keychain, app or UIKit.
//
// One monotonic *epoch* fences every lifecycle transition (stop, disconnect,
// re-pair/replacement, account change via JS). One monotonic *pick generation*
// owns the single pairing picker: a new pick invalidates a previous pending
// pick, and the pending pick's token is consumed by exactly one successful
// "store" claim. The module performs that claim *before* the atomic Keychain
// store, so a completion that belongs to an invalidated flow — a lock, a
// disconnect, an unmount, an account switch or a concurrent pick that landed
// while the picker was open — can never replace the stored credential, and a
// late duplicate completion can never store twice.

import Foundation

final class VeyraNConnectPairGate {
  /// The identity of one pairing pick: valid only at its exact epoch and while
  /// it is still the pending pick.
  struct Token: Equatable {
    let epoch: Int
    let generation: Int
  }

  private let lock = NSLock()
  private var epoch = 0
  private var pendingPick: Int?
  private var nextPick = 0

  /// The current lifecycle epoch. The session handshake snapshots this value
  /// before each await and re-checks it afterwards.
  func currentEpoch() -> Int {
    withLock { epoch }
  }

  /// Bump the epoch and drop any pending pick: stop / disconnect / unmount /
  /// account change / engine replacement. A picker still on screen is stale
  /// from this moment on.
  @discardableResult
  func invalidate() -> Int {
    withLock {
      epoch += 1
      pendingPick = nil
      return epoch
    }
  }

  /// Claim the single pending-pick slot at the current epoch. A previously
  /// pending pick is invalidated: with concurrent picks only the newest may
  /// complete.
  @discardableResult
  func beginPick() -> Token {
    withLock {
      nextPick += 1
      pendingPick = nextPick
      return Token(epoch: epoch, generation: nextPick)
    }
  }

  /// True only while `token` still owns the pending slot at the current epoch.
  func isCurrent(_ token: Token) -> Bool {
    withLock { pendingPick == token.generation && epoch == token.epoch }
  }

  /// The exact check performed *before* the atomic Keychain store. The slot is
  /// consumed on success, so at most one completion of a pick can ever store —
  /// and a stale/cancelled/invalid completion can never reach the store.
  @discardableResult
  func takeStoreSlot(_ token: Token) -> Bool {
    withLock {
      guard pendingPick == token.generation, epoch == token.epoch else {
        return false
      }
      pendingPick = nil
      return true
    }
  }

  /// True while any pairing pick is still pending (for diagnostics/tests).
  func hasPendingPick() -> Bool {
    withLock { pendingPick != nil }
  }

  @inline(__always)
  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
