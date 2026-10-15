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

// Strict RS256 verification of the OpenAI-issued ID token against the fixed
// JWKS document.
//
// The whole point is to fail closed on *every* deviation: a non-canonical
// base64url segment, a duplicate JSON key, a non-RS256 `alg`, `use`/`key_ops`
// that do not authorize a signature verification, a `jku`/`x5u`/`crit`/`b64`
// header, a `kid` that is absent or ambiguous, a wrong issuer, a wrong audience
// (or `azp`), a non-numeric/expired `exp`, a `nbf` in the future, or a nonce
// mismatch. The signature is checked over the *original* ASCII
// `header.payload` bytes with `rsaSignatureMessagePKCS1v15SHA256` (the message
// is hashed exactly once — never re-serialized, never PSS).
//
// This file imports only Foundation and Security.

import Foundation
import Security

// MARK: - JWKS

struct VeyraNSIWCJWK {
  let kid: String
  let key: SecKey
}

struct VeyraNSIWCJWKS {
  let keys: [VeyraNSIWCJWK]

  func key(kid: String) -> SecKey? {
    // A duplicate kid is not ambiguous: it fails closed by matching none.
    let matches = keys.filter { $0.kid == kid }
    guard matches.count == 1 else { return nil }
    return matches[0].key
  }

  /// Parse a bounded JWKS document. Only RSA/RS256/sig keys usable for
  /// `verify` are admitted; any other `alg`, `use`, `key_ops`, `kty` or a
  /// private/secret material field fails closed for that key.
  static func parse(_ data: Data) -> VeyraNSIWCJWKS? {
    guard !data.isEmpty, data.count <= VeyraNSIWC.maxJwksBytes else {
      return nil
    }
    guard let text = String(data: data, encoding: .utf8),
      VeyraNConnectStrictJSON.hasUniqueObjectKeys(text),
      let value = try? JSONSerialization.jsonObject(
        with: data,
        options: [.fragmentsAllowed]
      ),
      let object = value as? [String: Any],
      Set(object.keys) == ["keys"],
      let rawKeys = object["keys"] as? [Any],
      !rawKeys.isEmpty, rawKeys.count <= 32
    else { return nil }

    var parsed: [VeyraNSIWCJWK] = []
    for raw in rawKeys {
      guard let entry = raw as? [String: Any],
        let kid = entry["kid"] as? String,
        !kid.isEmpty, kid.utf8.count <= 128,
        parseRSA(entry) != nil
      else { continue }
      guard let key = parseRSA(entry) else { continue }
      parsed.append(VeyraNSIWCJWK(kid: kid, key: key))
    }
    guard !parsed.isEmpty else { return nil }
    return VeyraNSIWCJWKS(keys: parsed)
  }

  /// A single RSA public JWK. Unknown fields are ignored only when they are
  /// harmless metadata; a field that changes the key's meaning (`d`, `p`,
  /// `q`, `dp`, `dq`, `qi`, `k`, `use` != sig, `key_ops` without verify,
  /// `alg` != RS256) fails the key.
  private static func parseRSA(_ entry: [String: Any]) -> SecKey? {
    guard let kty = entry["kty"] as? String, kty == "RSA" else { return nil }
    // Reject any private/secret material outright.
    for forbidden in ["d", "p", "q", "dp", "dq", "qi", "k", "oth"] {
      if entry[forbidden] != nil { return nil }
    }
    // A *present* metadata field must have the exact expected type *and* value:
    // a present-but-malformed `alg`/`use`/`key_ops` (a boolean, a number, a
    // string where an array is required, a wrong value) fails the key closed
    // instead of being silently treated as absent.
    if let rawAlg = entry["alg"] {
      guard let alg = rawAlg as? String, alg == "RS256" else { return nil }
    }
    if let rawUse = entry["use"] {
      guard let use = rawUse as? String, use == "sig" else { return nil }
    }
    if let rawKeyOps = entry["key_ops"] {
      guard let keyOps = rawKeyOps as? [Any] else { return nil }
      let ops = keyOps.compactMap { $0 as? String }
      guard !ops.isEmpty, ops.count == keyOps.count, ops.contains("verify")
      else { return nil }
    }
    guard let n = entry["n"] as? String, let e = entry["e"] as? String,
      let modulus = decodeCanonical(n), let exponent = decodeCanonical(e)
    else { return nil }
    // A bounded RSA-2048-or-larger modulus (>=2048 bits => >=256 bytes), and a
    // small, positive exponent.
    guard modulus.count >= 256, modulus.count <= 1024,
      exponent.count >= 1, exponent.count <= 8
    else { return nil }
    // `n` must not be zero and must not begin with a sign-extended byte.
    guard modulus.contains(where: { $0 != 0 }), modulus.first != 0
    else { return nil }

    let der = derSequence(modulus: modulus, exponent: exponent)
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: modulus.count * 8
    ]
    return SecKeyCreateWithData(der as CFData, attributes as CFDictionary, nil)
  }

  private static func decodeCanonical(_ value: String) -> Data? {
    guard !value.isEmpty else { return nil }
    guard let data = VeyraNConnectBase64URL.decode(value),
      VeyraNConnectBase64URL.encode(data) == value
    else { return nil }
    return data
  }

  /// `SEQUENCE { INTEGER n, INTEGER e }` (PKCS#1 RSAPublicKey), with the
  /// leading `0x00` the DER INTEGER encoding requires for a positive value
  /// whose high bit is set (a modulus always is).
  private static func derSequence(modulus: Data, exponent: Data) -> Data {
    let n = derInteger(modulus)
    let e = derInteger(exponent)
    let body = n + e
    return derTag(0x30, body)
  }

  private static func derInteger(_ bytes: Data) -> Data {
    // Strip leading zero bytes conservatively (rebasing the slice so the
    // result always has `startIndex == 0`), then re-add a single sign byte when
    // the top bit is set.
    let significant = bytes.drop(while: { $0 == 0 })
    var value = significant.isEmpty ? Data([0]) : Data(significant)
    if let first = value.first, first & 0x80 != 0 {
      value.insert(0, at: 0)
    }
    return derTag(0x02, value)
  }

  private static func derTag(_ tag: UInt8, _ body: Data) -> Data {
    var out = Data([tag])
    let length = body.count
    if length < 0x80 {
      out.append(UInt8(length))
    } else if length <= 0xFF {
      out.append(0x81)
      out.append(UInt8(length))
    } else if length <= 0xFFFF {
      out.append(0x82)
      out.append(UInt8((length >> 8) & 0xFF))
      out.append(UInt8(length & 0xFF))
    } else {
      out.append(0x83)
      out.append(UInt8((length >> 16) & 0xFF))
      out.append(UInt8((length >> 8) & 0xFF))
      out.append(UInt8(length & 0xFF))
    }
    return out + body
  }
}

// MARK: - JWT verification

enum VeyraNSIWCJWT {
  struct Claims {
    let issuer: String
    let subject: String
    let audience: [String]
    let authorizedParty: String?
    let expiration: Int
    let notBefore: Int?
    let issuedAt: Int?
    let nonce: String?
    let email: String?
  }

  /// Verify an RS256 id_token and return its bounded claims, or `nil` on any
  /// deviation. `expectedAudience` is the own issued client id; `expectedNonce`
  /// is `nil` for refresh grants that legitimately omit a nonce.
  static func verify(
    token: String,
    jwks: VeyraNSIWCJWKS,
    now: Date,
    expectedIssuer: String,
    expectedAudience: String,
    expectedNonce: String?
  ) -> Claims? {
    guard token.utf8.count <= VeyraNSIWC.maxTokenBytes else { return nil }
    let segments = token.split(separator: ".", omittingEmptySubsequences: false)
    guard segments.count == 3 else { return nil }
    let headerSegment = String(segments[0])
    let payloadSegment = String(segments[1])
    let signatureSegment = String(segments[2])

    guard let headerData = decodeCanonical(headerSegment),
      let payloadData = decodeCanonical(payloadSegment),
      let signature = decodeCanonical(signatureSegment),
      !signature.isEmpty
    else { return nil }

    guard let header = jsonObject(headerData),
      let alg = header["alg"] as? String, alg == "RS256",
      let kid = header["kid"] as? String, !kid.isEmpty,
      !header.keys.contains(where: {
        !["alg", "typ", "kid", "cty"].contains($0)
      })
    else { return nil }
    if let typ = header["typ"] as? String, typ != "JWT" { return nil }
    if let cty = header["cty"] as? String, cty != "JWT" { return nil }

    guard let claimsObject = jsonObject(payloadData) else { return nil }

    // Signature over the original ASCII `header.payload` bytes, hashed once.
    let signed = Data("\(headerSegment).\(payloadSegment)".utf8)
    guard let key = jwks.key(kid: kid) else { return nil }
    guard SecKeyVerifySignature(
      key,
      .rsaSignatureMessagePKCS1v15SHA256,
      signed as CFData,
      signature as CFData,
      nil
    ) else { return nil }

    guard let issuer = claimsObject["iss"] as? String,
      issuer == expectedIssuer
    else { return nil }
    guard let subject = claimsObject["sub"] as? String,
      VeyraNSIWCValidate.subject(subject)
    else { return nil }
    guard let audience = audience(claimsObject["aud"]), !audience.isEmpty
    else { return nil }
    guard audience.contains(expectedAudience) else { return nil }
    // When more than one audience is present OIDC requires `azp`; when it is
    // present it must always be the own issued client. A *present* `azp` of any
    // other type (`false`, a number, an array, an object) is malformed and is
    // rejected — it is never silently treated as absent.
    let azp: String?
    if let rawAzp = claimsObject["azp"] {
      guard let parsedAzp = rawAzp as? String, !parsedAzp.isEmpty else {
        return nil
      }
      azp = parsedAzp
    } else {
      azp = nil
    }
    if audience.count > 1, azp == nil { return nil }
    if let azp, azp != expectedAudience { return nil }

    guard let expiration = strictSeconds(claimsObject["exp"]) else {
      return nil
    }
    let skew = 0.0
    guard Double(expiration) > now.timeIntervalSince1970 + skew else {
      return nil
    }
    // An optional claim that is *present* must be a valid NumericDate. A
    // boolean, a string, a fraction or an out-of-range number is malformed and
    // is rejected rather than being treated as absent.
    let notBefore: Int?
    if let rawNotBefore = claimsObject["nbf"] {
      guard let parsed = strictSeconds(rawNotBefore) else { return nil }
      notBefore = parsed
    } else {
      notBefore = nil
    }
    if let notBefore, Double(notBefore) > now.timeIntervalSince1970 + skew {
      return nil
    }
    let issuedAt: Int?
    if let rawIssuedAt = claimsObject["iat"] {
      guard let parsed = strictSeconds(rawIssuedAt) else { return nil }
      guard parsed >= 0 else { return nil }
      issuedAt = parsed
    } else {
      issuedAt = nil
    }

    // A nonce, when present, must be a bounded string equal to the flow's
    // original nonce. A present non-string nonce is malformed, never absent.
    let nonce: String?
    if let rawNonce = claimsObject["nonce"] {
      guard let parsedNonce = rawNonce as? String,
        VeyraNSIWCValidate.opaque(parsedNonce, max: 128)
      else { return nil }
      nonce = parsedNonce
    } else {
      nonce = nil
    }
    if let expectedNonce {
      guard let nonce, VeyraNSIWCValidate.constantTimeEquals(nonce, expectedNonce)
      else { return nil }
    }

    // The saved email is display/login-hint metadata only, never an
    // authorization input. A syntactically implausible claim is dropped here
    // rather than persisted: the identity document rejects a bad email on
    // reload, so an unvalidated claim could otherwise poison the whole store.
    let email = (claimsObject["email"] as? String).flatMap {
      VeyraNSIWCValidate.email($0) ? $0 : nil
    }

    return Claims(
      issuer: issuer,
      subject: subject,
      audience: audience,
      authorizedParty: azp,
      expiration: expiration,
      notBefore: notBefore,
      issuedAt: issuedAt,
      nonce: nonce,
      email: email
    )
  }

  /// The `nonce` claim of a *previously verified* id_token, read leniently for
  /// use as the retained original auth nonce during a refresh. The signature is
  /// not re-checked here: the token was already verified when it was adopted.
  static func retainedNonce(_ token: String) -> String? {
    let segments = token.split(separator: ".", omittingEmptySubsequences: false)
    guard segments.count == 3,
      let payload = decodeCanonical(String(segments[1])),
      let object = jsonObject(payload)
    else { return nil }
    guard let nonce = object["nonce"] as? String,
      VeyraNSIWCValidate.opaque(nonce, max: 128)
    else { return nil }
    return nonce
  }

  private static func decodeCanonical(_ value: String) -> Data? {
    guard !value.isEmpty else { return nil }
    guard let data = VeyraNConnectBase64URL.decode(value),
      VeyraNConnectBase64URL.encode(data) == value
    else { return nil }
    return data
  }

  private static func jsonObject(_ data: Data) -> [String: Any]? {
    guard !data.isEmpty, data.count <= VeyraNSIWC.maxTokenBytes else {
      return nil
    }
    guard let text = String(data: data, encoding: .utf8),
      VeyraNConnectStrictJSON.hasUniqueObjectKeys(text),
      let value = try? JSONSerialization.jsonObject(
        with: data,
        options: [.fragmentsAllowed]
      )
    else { return nil }
    return value as? [String: Any]
  }

  private static func audience(_ value: Any?) -> [String]? {
    if let single = value as? String {
      return single.isEmpty ? nil : [single]
    }
    if let array = value as? [Any] {
      let strings = array.compactMap { $0 as? String }
      guard strings.count == array.count, !strings.isEmpty else { return nil }
      return strings
    }
    return nil
  }

  /// `exp`/`nbf`/`iat` must be a JSON number of seconds. A boolean or a
  /// fractional value is not a valid NumericDate here.
  private static func strictSeconds(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber else { return nil }
    guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    guard let parsed = Int(number.stringValue) else { return nil }
    return parsed
  }
}
