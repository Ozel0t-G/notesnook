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

// Device-only Keychain storage for the SIWC identity document.
//
// The app's entitlements carry exactly one keychain access group, the shared
// `$(AppIdentifierPrefix)group.com.ozel0t.note.notesnookpencil`. This record
// deliberately does NOT request an app-identifier access group (the app has no
// such entitlement): it writes a *new, namespaced service* into the same
// entitled default group, marked `kSecUseDataProtectionKeychain: true`,
// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `synchronizable: false`.
//
// **Typed reads.** `load` answers one of four distinct outcomes and *only*
// `errSecItemNotFound` means `missing`. A Keychain error is `unavailable` and a
// record whose bytes do not parse is `invalid`; neither is ever reported as an
// absent record, so a corrupt/hostile/locked record can never be silently
// replaced or initialized over.
//
// **Create-if-absent.** Initialization uses `SecItemAdd` first: an existing item
// makes the add fail with `errSecDuplicateItem`, and the existing record is then
// *read back and validated* instead of being overwritten. A concurrent
// initialization can therefore never be clobbered by a fresh host.
//
// The credential *update* path (`save`) is atomic: `SecItemUpdate` first, and
// `SecItemAdd` only when the item does not exist yet. Any other error leaves the
// previous item untouched, so a failed persist never strands the store without a
// secret. The credential, the access/refresh tokens and the id_token live only
// here — never in the renderer, MMKV, an encrypted Notes row, a browser store, a
// log, a URL or a telemetry payload.
//
// This file imports only Foundation and Security. Every Security call goes
// through the injected `VeyraNSIWCSecAPI`, so the harness exercises the exact
// production dictionaries and outcome mapping with a synthetic API — no real
// Keychain is ever touched by a test.

import Foundation
import Security

// MARK: - injected Security API

/// The exact Security-framework calls the production adapter performs.
protocol VeyraNSIWCSecAPI {
  func copyMatching(
    _ query: CFDictionary,
    _ result: UnsafeMutablePointer<CFTypeRef?>?
  ) -> OSStatus
  func update(_ query: CFDictionary, _ attributes: CFDictionary) -> OSStatus
  func add(
    _ attributes: CFDictionary,
    _ result: UnsafeMutablePointer<CFTypeRef?>?
  ) -> OSStatus
  func delete(_ query: CFDictionary) -> OSStatus
}

/// The real Security framework. Never used by a test.
struct VeyraNSIWCSystemSecAPI: VeyraNSIWCSecAPI {
  func copyMatching(
    _ query: CFDictionary,
    _ result: UnsafeMutablePointer<CFTypeRef?>?
  ) -> OSStatus {
    SecItemCopyMatching(query, result)
  }

  func update(_ query: CFDictionary, _ attributes: CFDictionary) -> OSStatus {
    SecItemUpdate(query, attributes)
  }

  func add(
    _ attributes: CFDictionary,
    _ result: UnsafeMutablePointer<CFTypeRef?>?
  ) -> OSStatus {
    SecItemAdd(attributes, result)
  }

  func delete(_ query: CFDictionary) -> OSStatus {
    SecItemDelete(query)
  }
}

enum VeyraNSIWCKeychain {
  /// The exact production read, mapped to a typed outcome.
  static func load(api: VeyraNSIWCSecAPI = VeyraNSIWCSystemSecAPI()) -> VeyraNSIWCStoreRead {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = api.copyMatching(query as CFDictionary, &item)
    // Only an actually absent item is `missing`; every other status (including
    // an entitlement/locked/unavailable failure) is `unavailable`.
    if status == errSecItemNotFound { return .missing }
    guard status == errSecSuccess else { return .unavailable }
    guard let data = item as? Data, let document = VeyraNSIWCPersisted.parse(data)
    else { return .invalid }
    return .loaded(document)
  }

  /// Create the record only if it does not exist yet. An existing record is read
  /// back (and validated) instead of being overwritten.
  static func createIfAbsent(
    _ value: VeyraNSIWCPersisted,
    api: VeyraNSIWCSecAPI = VeyraNSIWCSystemSecAPI()
  ) -> VeyraNSIWCStoreCreate {
    guard let data = value.serialized(), !data.isEmpty else { return .failed }
    let status = api.add(addAttributes(data) as CFDictionary, nil)
    if status == errSecSuccess { return .created }
    guard status == errSecDuplicateItem else { return .failed }
    switch load(api: api) {
    case let .loaded(document): return .existing(document)
    case .missing: return .failed
    case .invalid, .unavailable: return .duplicateUnreadable
    }
  }

  /// Replace an existing record (the credential/registration commit path).
  @discardableResult
  static func save(
    _ value: VeyraNSIWCPersisted,
    api: VeyraNSIWCSecAPI = VeyraNSIWCSystemSecAPI()
  ) -> Bool {
    guard let data = value.serialized(), !data.isEmpty else { return false }
    // `SecItemUpdate` takes *real item attributes* as its second argument only.
    // `kSecUseDataProtectionKeychain` is a query/scope option and must never
    // appear there: it belongs to the query (`baseQuery`) and to the `SecItemAdd`
    // dictionary, where it is honoured.
    let updateStatus = api.update(
      baseQuery() as CFDictionary,
      updateAttributes(data) as CFDictionary
    )
    if updateStatus == errSecSuccess { return true }
    guard updateStatus == errSecItemNotFound else { return false }

    return api.add(addAttributes(data) as CFDictionary, nil) == errSecSuccess
  }

  @discardableResult
  static func delete(api: VeyraNSIWCSecAPI = VeyraNSIWCSystemSecAPI()) -> Bool {
    let status = api.delete(baseQuery() as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }

  /// The scope/selector query. It carries the default entitled access group
  /// implicitly (no `kSecAttrAccessGroup`), `synchronizable:false` and the
  /// data-protection keychain option.
  static func baseQuery() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: VeyraNSIWC.keychainService,
      kSecAttrAccount as String: VeyraNSIWC.keychainAccount,
      kSecAttrSynchronizable as String: false,
      kSecUseDataProtectionKeychain as String: true
    ]
  }

  /// The exact second argument of `SecItemUpdate`: item attributes only.
  static func updateAttributes(_ data: Data) -> [String: Any] {
    return [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]
  }

  /// The `SecItemAdd` dictionary used only when the item does not exist yet.
  static func addAttributes(_ data: Data) -> [String: Any] {
    var attributes = baseQuery()
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] =
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    attributes[kSecUseDataProtectionKeychain as String] = true
    return attributes
  }
}

/// The production store adapter. The harness injects a synthetic store so no
/// test ever touches the real Keychain.
struct VeyraNSIWCKeychainStore: VeyraNSIWCStore {
  func load() -> VeyraNSIWCStoreRead { VeyraNSIWCKeychain.load() }
  func createIfAbsent(_ value: VeyraNSIWCPersisted) -> VeyraNSIWCStoreCreate {
    VeyraNSIWCKeychain.createIfAbsent(value)
  }
  @discardableResult
  func save(_ value: VeyraNSIWCPersisted) -> Bool { VeyraNSIWCKeychain.save(value) }
  @discardableResult
  func delete() -> Bool { VeyraNSIWCKeychain.delete() }
}
