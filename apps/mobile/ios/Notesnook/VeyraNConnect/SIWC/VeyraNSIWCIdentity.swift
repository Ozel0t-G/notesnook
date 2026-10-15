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

// The persisted SIWC identity document and the live model catalog parser.
//
// One JSON document holds the stable host URN, the set of own issued
// registrations (an own issued client id + verified ChatGPT subject) and the
// single active credential. The host and the registrations *survive logout*;
// only the credential is cleared, so returning sign-in can reuse an issued
// client id without a fresh browser registration.
//
// The credential owner is the *persisted Notes account*, never the ChatGPT
// subject; the subject is a separate, independently verified field.
//
// This file imports only Foundation. The production Keychain adapter is in the
// sibling `VeyraNSIWCKeychain.swift`; the harness injects a synthetic store.

import Foundation

// MARK: - Model catalog

struct VeyraNSIWCModel: Equatable {
  let slug: String
  let displayName: String
}

/// The bounded extra-metadata tolerance of the official catalog response.
///
/// The official devkit models response is a projection of a richer internal
/// record set: extra *metadata* keys (at the root and on each row) are expected
/// and must be ignored — they carry no authorization meaning. The tolerance is
/// still bounded (a key budget and the total byte bound), and the projected
/// fields (`slug` / `display_name`) are the *only* fields ever read, so extra
/// metadata can never influence a model decision.
enum VeyraNSIWCCatalogShape {
  /// The maximum number of root keys (the required envelope key plus bounded
  /// metadata).
  static let maxRootKeys = 32
  /// The maximum number of keys on a projected row (the required fields plus
  /// bounded metadata).
  static let maxItemKeys = 32
  /// The maximum number of rows in either documented envelope.
  static let maxRows = 512
  /// The maximum byte length of a projected row field (`display_name` /
  /// `owned_by`).
  static let maxFieldBytes = 200
}

struct VeyraNSIWCCatalog: Equatable {
  let models: [VeyraNSIWCModel]

  func allows(slug: String) -> Bool {
    models.contains { $0.slug == slug }
  }

  /// Parse the live models response.
  ///
  /// The **same** `GET https://api.openai.com/v1/models` request may answer with
  /// either of two officially documented envelopes:
  ///
  ///  - the SIWC token-sharing devkit projection
  ///    `{ "models": [ { slug, display_name, visibility, …bounded metadata } ] }`; or
  ///  - the public API list envelope
  ///    `{ "object": "list", "data": [ { id, object:"model", created, owned_by,
  ///      shutdown_date? …bounded metadata } ] }`.
  ///
  /// The two are discriminated *narrowly* and never mixed: `models` selects the
  /// SIWC projection, `data` is only accepted when `models` is absent **and** the
  /// root `object` is exactly `"list"`, and a document carrying both envelopes
  /// fails closed. Either way the body is bounded by `maxModelsBytes`, the root by
  /// `maxRootKeys`, the rows by `maxRows`, each row by `maxItemKeys` and duplicate
  /// object keys anywhere fail the document closed.
  ///
  /// Only the projected identifier fields are ever read; extra metadata (root or
  /// row) is ignored and can never influence a model decision. No model list,
  /// name or prefix is ever invented, and no inference capability is implied by
  /// metadata alone.
  static func parse(_ data: Data) -> VeyraNSIWCCatalog? {
    guard !data.isEmpty, data.count <= VeyraNSIWC.maxModelsBytes else {
      return nil
    }
    guard let text = String(data: data, encoding: .utf8),
      VeyraNConnectStrictJSON.hasUniqueObjectKeys(text),
      let value = try? JSONSerialization.jsonObject(
        with: data,
        options: [.fragmentsAllowed]
      ),
      let object = value as? [String: Any],
      object.count <= VeyraNSIWCCatalogShape.maxRootKeys
    else { return nil }

    if let raw = object["models"] as? [Any] {
      // The SIWC envelope is the discriminator whenever `models` is present; a
      // *conflicting* `data` envelope in the same document fails closed.
      guard object["data"] == nil else { return nil }
      return parseSIWC(raw)
    }

    // The public API envelope: `models` absent, `object` exactly `"list"` and a
    // bounded `data` array of model rows.
    guard object["models"] == nil,
      object["object"] as? String == "list",
      let raw = object["data"] as? [Any],
      raw.count <= VeyraNSIWCCatalogShape.maxRows
    else { return nil }
    return parseAPIList(raw)
  }

  /// The SIWC token-sharing projection: every row whose `visibility` is not the
  /// string `"list"` — a missing or non-string value, `null`, an empty object, or
  /// a non-object row — is skipped **before** any slug/display-name validation,
  /// so an undeclared or hidden row with incomplete display fields never fails the
  /// document. A *displayed* row must carry a valid own slug and a non-empty
  /// bounded display name; only `slug`/`display_name` are ever projected, and rows
  /// are kept in the server's order (duplicate rows are not duplicate keys).
  private static func parseSIWC(_ raw: [Any]) -> VeyraNSIWCCatalog? {
    guard raw.count <= VeyraNSIWCCatalogShape.maxRows else { return nil }
    var models: [VeyraNSIWCModel] = []
    for entry in raw {
      guard let item = entry as? [String: Any],
        item["visibility"] as? String == "list"
      else { continue }
      guard item.count <= VeyraNSIWCCatalogShape.maxItemKeys,
        let slug = item["slug"] as? String,
        VeyraNSIWCValidate.modelSlug(slug),
        let displayName = item["display_name"] as? String,
        !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        displayName.utf8.count <= VeyraNSIWCCatalogShape.maxFieldBytes
      else { return nil }
      models.append(VeyraNSIWCModel(slug: slug, displayName: displayName))
    }
    return VeyraNSIWCCatalog(models: models)
  }

  /// The public `GET /v1/models` list projection: `data` rows carry an
  /// `object:"model"` discriminator, a valid returned `id`, a non-negative
  /// integer `created` and a non-empty bounded `owned_by`.
  ///
  /// The **returned** `id` is the faithful identifier: it is projected verbatim
  /// as both the slug and the display name (no invented friendly name), so a model
  /// the server returned is exactly the model that is later authorized. Order is
  /// preserved, ids are unique within one list envelope, and any invalid displayed
  /// row fails the whole document closed. `shutdown_date` (and any other extra
  /// metadata) is tolerated but ignored.
  private static func parseAPIList(_ raw: [Any]) -> VeyraNSIWCCatalog? {
    var models: [VeyraNSIWCModel] = []
    var seen = Set<String>()
    for entry in raw {
      guard let item = entry as? [String: Any],
        item.count <= VeyraNSIWCCatalogShape.maxItemKeys,
        item["object"] as? String == "model",
        let id = item["id"] as? String,
        VeyraNSIWCValidate.modelSlug(id),
        seen.insert(id).inserted,
        let created = VeyraNConnectValidate.strictInt(item["created"]),
        created >= 0,
        let ownedBy = item["owned_by"] as? String,
        !ownedBy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        ownedBy.utf8.count <= VeyraNSIWCCatalogShape.maxFieldBytes
      else { return nil }
      models.append(VeyraNSIWCModel(slug: id, displayName: id))
    }
    return VeyraNSIWCCatalog(models: models)
  }
}

// MARK: - Persisted document

struct VeyraNSIWCRegistration: Equatable {
  let clientId: String
  /// Present only after a verified ID token (never for an unverified pending
  /// registration).
  let subject: String?
  /// The saved email, when the issuer supplied one. Never an authorization
  /// input.
  let email: String?
  let createdAt: Int

  var isComplete: Bool { subject != nil }
}

struct VeyraNSIWCCredential: Equatable {
  /// The own issued client id this credential was minted for.
  let clientId: String
  /// The verified ChatGPT subject.
  let subject: String
  /// The persisted Notes account that owns this credential.
  let ownerAccountId: String
  let accessToken: String
  let refreshToken: String?
  /// The verified id_token. Retained protected, never placed in a browser URL.
  let idToken: String
  let grantedScopes: [String]
  /// `exp` of the verified id_token as an absolute epoch second, when known.
  let expiresAt: Int?
  /// The provider epoch this credential was adopted under.
  let providerEpoch: Int
}

struct VeyraNSIWCPersisted: Equatable {
  let hostURN: String
  let registrations: [VeyraNSIWCRegistration]
  let credential: VeyraNSIWCCredential?

  func registration(clientId: String) -> VeyraNSIWCRegistration? {
    registrations.first { $0.clientId == clientId }
  }

  func withCredential(_ credential: VeyraNSIWCCredential?) -> VeyraNSIWCPersisted {
    VeyraNSIWCPersisted(
      hostURN: hostURN,
      registrations: registrations,
      credential: credential
    )
  }

  /// Insert or replace a registration. Two silent replacements are refused:
  ///
  ///  - a pending (subject-less) registration for an already *verified* client
  ///    id, so an unverified pending document can never overwrite a verified
  ///    registration;
  ///  - a *different* verified subject under an existing verified client id, so
  ///    a returning/consent (or a replayed fresh) flow can never silently
  ///    rebind an own registration to another ChatGPT account. A new own
  ///    registration uses a new issued client id; it never mutates an existing
  ///    verified one.
  func withRegistration(_ registration: VeyraNSIWCRegistration) -> VeyraNSIWCPersisted? {
    if let existing = self.registration(clientId: registration.clientId),
      let verified = existing.subject
    {
      guard let incoming = registration.subject, incoming == verified else {
        return nil
      }
    }
    var next = registrations.filter { $0.clientId != registration.clientId }
    next.append(registration)
    return VeyraNSIWCPersisted(
      hostURN: hostURN,
      registrations: next,
      credential: credential
    )
  }

  static func empty(hostURN: String) -> VeyraNSIWCPersisted {
    VeyraNSIWCPersisted(hostURN: hostURN, registrations: [], credential: nil)
  }

  // MARK: codec

  func serialized() -> Data? {
    var object: [String: Any] = [
      "v": 1,
      "host": hostURN,
      "registrations": registrations.map { registration in
        var entry: [String: Any] = [
          "clientId": registration.clientId,
          "createdAt": registration.createdAt,
          "status": registration.subject == nil ? "incomplete" : "complete"
        ]
        if let subject = registration.subject { entry["subject"] = subject }
        if let email = registration.email { entry["email"] = email }
        return entry
      }
    ]
    if let credential {
      var entry: [String: Any] = [
        "clientId": credential.clientId,
        "subject": credential.subject,
        "ownerAccountId": credential.ownerAccountId,
        "accessToken": credential.accessToken,
        "idToken": credential.idToken,
        "grantedScopes": credential.grantedScopes,
        "providerEpoch": credential.providerEpoch
      ]
      if let refreshToken = credential.refreshToken {
        entry["refreshToken"] = refreshToken
      }
      if let expiresAt = credential.expiresAt {
        entry["expiresAt"] = expiresAt
      }
      object["credentials"] = entry
    }
    guard JSONSerialization.isValidJSONObject(object) else { return nil }
    return try? JSONSerialization.data(withJSONObject: object, options: [])
  }

  static func parse(_ data: Data) -> VeyraNSIWCPersisted? {
    guard !data.isEmpty, data.count <= 1024 * 1024 else { return nil }
    guard let text = String(data: data, encoding: .utf8),
      VeyraNConnectStrictJSON.hasUniqueObjectKeys(text),
      let value = try? JSONSerialization.jsonObject(
        with: data,
        options: [.fragmentsAllowed]
      )
    else { return nil }
    return parse(value)
  }

  static func parse(_ value: Any) -> VeyraNSIWCPersisted? {
    guard let object = value as? [String: Any],
      let v = VeyraNConnectValidate.strictInt(object["v"]), v == 1
    else { return nil }
    let allowed: Set<String> = ["v", "host", "registrations", "credentials"]
    guard Set(object.keys).isSubset(of: allowed) else { return nil }

    // A persisted document may predate the corrected wire format: a strictly
    // valid own legacy `urn:veyran:<v4>` host is canonicalized *in memory* to
    // `urn:uuid:` with the same UUID, so an existing record stays fully loadable
    // (host, registrations and credential preserved) and is never rewritten on
    // read. The wire validator itself stays canonical-only.
    guard let rawHost = object["host"] as? String,
      let host = VeyraNSIWCValidate.normalizePersistedHostURN(rawHost),
      let rawRegistrations = object["registrations"] as? [Any]
    else { return nil }

    var registrations: [VeyraNSIWCRegistration] = []
    var seen = Set<String>()
    for entry in rawRegistrations {
      guard let registration = parseRegistration(entry),
        seen.insert(registration.clientId).inserted
      else { return nil }
      registrations.append(registration)
    }

    var credential: VeyraNSIWCCredential?
    if let rawCredential = object["credentials"], !(rawCredential is NSNull) {
      guard let parsed = parseCredential(rawCredential),
        seen.contains(parsed.clientId)
      else { return nil }
      credential = parsed
    }

    return VeyraNSIWCPersisted(
      hostURN: host,
      registrations: registrations,
      credential: credential
    )
  }

  private static func parseRegistration(_ value: Any) -> VeyraNSIWCRegistration? {
    guard let entry = value as? [String: Any],
      let clientId = entry["clientId"] as? String,
      VeyraNSIWCValidate.issuedClientId(clientId),
      let createdAt = VeyraNConnectValidate.strictInt(entry["createdAt"]),
      createdAt >= 0,
      let status = entry["status"] as? String
    else { return nil }
    let subject = entry["subject"] as? String
    let email = entry["email"] as? String
    switch status {
    case "complete":
      guard let subject, VeyraNSIWCValidate.subject(subject) else { return nil }
    case "incomplete":
      guard subject == nil else { return nil }
    default:
      return nil
    }
    let allowed: Set<String> = ["clientId", "createdAt", "status", "subject", "email"]
    guard Set(entry.keys).isSubset(of: allowed) else { return nil }
    // A syntactically implausible email is *dropped* rather than failing the
    // whole document: a stale or corrupt value must never wipe the host, the
    // registrations and the credential on load.
    let storedEmail = email.flatMap {
      VeyraNSIWCValidate.email($0) ? $0 : nil
    }
    return VeyraNSIWCRegistration(
      clientId: clientId,
      subject: subject,
      email: storedEmail,
      createdAt: createdAt
    )
  }

  private static func parseCredential(_ value: Any) -> VeyraNSIWCCredential? {
    guard let entry = value as? [String: Any],
      let clientId = entry["clientId"] as? String,
      VeyraNSIWCValidate.issuedClientId(clientId),
      let subject = entry["subject"] as? String,
      VeyraNSIWCValidate.subject(subject),
      let ownerAccountId = entry["ownerAccountId"] as? String,
      !ownerAccountId.isEmpty, ownerAccountId.utf8.count <= 512,
      let accessToken = entry["accessToken"] as? String,
      VeyraNSIWCValidate.tokenString(accessToken),
      let idToken = entry["idToken"] as? String,
      VeyraNSIWCValidate.tokenString(idToken),
      let scopes = entry["grantedScopes"] as? [Any],
      let providerEpoch = VeyraNConnectValidate.strictInt(entry["providerEpoch"]),
      providerEpoch >= 0
    else { return nil }
    let allowed: Set<String> = [
      "clientId", "subject", "ownerAccountId", "accessToken", "refreshToken",
      "idToken", "grantedScopes", "expiresAt", "providerEpoch"
    ]
    guard Set(entry.keys).isSubset(of: allowed) else { return nil }
    // An *empty* granted-scope set is a legitimate, truthfully persisted state:
    // the identity is verified but no direct access grant was actually
    // established, so the direct-scope gate reports `MISSING_PLAN_SCOPE` before
    // any model or inference work. Scopes are never invented.
    let scopeStrings = scopes.compactMap { $0 as? String }
    guard scopeStrings.count == scopes.count,
      scopeStrings.allSatisfy({ !$0.isEmpty }),
      scopeStrings.count <= 64
    else {
      return nil
    }
    var refreshToken: String?
    if let value = entry["refreshToken"], !(value is NSNull) {
      guard let parsed = value as? String,
        VeyraNSIWCValidate.tokenString(parsed)
      else { return nil }
      refreshToken = parsed
    }
    var expiresAt: Int?
    if let value = entry["expiresAt"], !(value is NSNull) {
      guard let parsed = VeyraNConnectValidate.strictInt(value), parsed >= 0
      else { return nil }
      expiresAt = parsed
    }
    return VeyraNSIWCCredential(
      clientId: clientId,
      subject: subject,
      ownerAccountId: ownerAccountId,
      accessToken: accessToken,
      refreshToken: refreshToken,
      idToken: idToken,
      grantedScopes: scopeStrings,
      expiresAt: expiresAt,
      providerEpoch: providerEpoch
    )
  }
}

// MARK: - Injected store

/// One *typed* read of the persisted record.
///
/// The distinction is a security boundary, not a convenience: an absent record
/// is the only state that may be initialized (and only create-if-absent), while
/// a record that exists but cannot be read — a Keychain error or a corrupt
/// document — must fail closed and must never be overwritten, replaced or
/// treated as "missing".
enum VeyraNSIWCStoreRead: Equatable {
  /// Exactly `errSecItemNotFound`: no record exists. This is the *only* state
  /// that is allowed to initialize a fresh document.
  case missing
  /// A record exists and is a valid document.
  case loaded(VeyraNSIWCPersisted)
  /// A record exists but its bytes are not a valid document (corrupt/truncated).
  case invalid
  /// The store could not be read at all (any other Keychain status, no
  /// entitlement, locked/None data). Retrying may legitimately succeed.
  case unavailable
}

/// The outcome of one *create-if-absent* attempt.
enum VeyraNSIWCStoreCreate: Equatable {
  /// The record was created by this call.
  case created
  /// A record already existed and was read back; it was **not** overwritten.
  case existing(VeyraNSIWCPersisted)
  /// A record already existed but could not be read/validated: nothing is
  /// overwritten and the caller must fail closed.
  case duplicateUnreadable
  /// The store refused the create for another reason.
  case failed
}

/// The credential storage behind the provider. The production adapter is the
/// module-owned Keychain record; the harness injects a synthetic store. All
/// methods are synchronous and must never re-enter the provider.
protocol VeyraNSIWCStore {
  /// A typed read: absence, a loaded document, a corrupt record or an
  /// unavailable store are four distinct outcomes.
  func load() -> VeyraNSIWCStoreRead
  /// Create the record **only if it does not exist yet**. An existing record is
  /// read back and returned instead of being overwritten, so a concurrent
  /// initialization can never be clobbered.
  func createIfAbsent(_ value: VeyraNSIWCPersisted) -> VeyraNSIWCStoreCreate
  /// Replace the record this process already read (the credential/registration
  /// commit path). `false` on any failure (fail closed).
  @discardableResult
  func save(_ value: VeyraNSIWCPersisted) -> Bool
  @discardableResult
  func delete() -> Bool
}
