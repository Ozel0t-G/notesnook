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

// Device-only Keychain storage for the paired broker identity.
//
// The app's entitlements carry exactly one keychain access group, the shared
// `$(AppIdentifierPrefix)group.com.ozel0t.note.notesnookpencil`. This record
// deliberately does NOT request an app-identifier access group (that would
// require an entitlement this app does not have): it writes a *new, namespaced
// service* into the same entitled default group, marked
// `kSecUseDataProtectionKeychain: true`,
// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `synchronizable: false`.
//
// It is a new record in a new service that only this module ever reads or
// deletes (`disconnect` removes only its own item). Any Security error fails
// closed to `nil`/`false`: this module never falls back to a legacy Keychain or
// to a file.
//
// Note: sibling signed extensions that share this app identifier could, in
// principle, reach the same access group. None of them reads this service.

import Foundation
import Security

enum VeyraNConnectKeychain {
  /// A new, module-owned service name; distinct from every existing service.
  static let service = "com.ozel0t.veyran.connect.pairing.v1"
  static let account = "pairing"

  /// Load the paired identity, or `nil` when absent or unreadable.
  static func load() -> VeyraNConnectPairing? {
    var query: [String: Any] = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess,
      let data = item as? Data,
      let pairing = VeyraNConnectPairing.parse(data: data)
    else { return nil }
    return pairing
  }

  /// Replace the stored identity. Returns `false` on any failure.
  ///
  /// The existing item is updated atomically with `SecItemUpdate`, so a failure
  /// can never leave the store without a secret. Only when no item exists yet is
  /// `SecItemAdd` used; any other error fails closed and the previous item — if
  /// any — is kept untouched. The caller must not activate the new pairing in
  /// memory unless this returns `true`.
  @discardableResult
  static func save(_ pairing: VeyraNConnectPairing) -> Bool {
    guard let data = serialize(pairing), !data.isEmpty else { return false }

    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecUseDataProtectionKeychain as String: true
    ]

    let updateStatus = SecItemUpdate(
      baseQuery() as CFDictionary,
      attributes as CFDictionary
    )
    if updateStatus == errSecSuccess { return true }
    // Any error other than "there is no item to update" is a real failure:
    // fail closed and leave whatever is stored in place.
    guard updateStatus == errSecItemNotFound else { return false }

    var addAttributes = baseQuery()
    addAttributes[kSecValueData as String] = data
    addAttributes[kSecAttrAccessible as String] =
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    addAttributes[kSecUseDataProtectionKeychain as String] = true

    let status = SecItemAdd(addAttributes as CFDictionary, nil)
    return status == errSecSuccess
  }

  /// Remove only this module's own record.
  @discardableResult
  static func delete() -> Bool {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }

  private static func baseQuery() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      // Never synced to iCloud/other devices.
      kSecAttrSynchronizable as String: false,
      kSecUseDataProtectionKeychain as String: true
    ]
  }

  private static func serialize(_ pairing: VeyraNConnectPairing) -> Data? {
    let object: [String: Any] = [
      "v": VeyraNConnectWire.protocolVersion,
      "service": VeyraNConnectWire.service,
      "brokerId": pairing.brokerId,
      "port": pairing.port,
      "app": ["id": pairing.appId, "secret": pairing.appSecret],
      "tls": ["rootPem": pairing.rootPem, "leafPin": pairing.leafPin]
    ]
    return try? JSONSerialization.data(withJSONObject: object, options: [])
  }
}
