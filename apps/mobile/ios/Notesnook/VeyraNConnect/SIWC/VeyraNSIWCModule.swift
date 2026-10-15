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

// The React Native bridge for the SIWC provider.
//
// Mac Catalyst is the only supported platform. Every method answers
// `supported:false`/`unsupported` elsewhere *before* any Keychain, listener or
// browser work, and no credential method ever touches the real Keychain on an
// unsupported platform.
//
// The bridge is deliberately thin. Every security-relevant decision — the
// immutable method entry (provider epoch + owner + flow generation captured
// before anything is deferred), the callback listener, the browser hand-off,
// the stream ownership and every credential read/write — lives in the pure
// `VeyraNSIWCLifecycle` coordinator, which delegates to the pure
// `VeyraNSIWCProvider`. The provider is never handed an externally supplied
// token, URL authority or model; the model is validated against the live
// catalog inside the provider and the function namespace is rebuilt and
// validated natively.
//
// This file is the only one that imports React/UIKit. It owns the event
// emission and the `observing` flag; the coordinator owns the flow identity.
// The auth event sink is invoked outside the coordinator's lock, but the actual
// `sendEvent` runs through the coordinator's `withAuthorizedAuthDelivery`
// primitive, which linearizes the exact-identity check, the one-time terminal
// ticket consumption and the synchronous `sendEvent` in one critical section.
// `sendEvent` only enqueues to JS asynchronously and never re-enters the
// coordinator, so emitting cannot deadlock against the lifecycle. Stream
// emissions stay outside every lock.

import Foundation
import React
import UIKit

@objc(VeyraNSIWCModule)
final class VeyraNSIWCModule: RCTEventEmitter {
  private let lock = NSLock()
  private var observing = false
  private lazy var lifecycle = VeyraNSIWCLifecycle(
    providerFactory: {
      VeyraNSIWCProvider(
        store: VeyraNSIWCKeychainStore(),
        http: VeyraNSIWCURLSessionTransport(),
        stream: VeyraNSIWCURLSessionStreamingTransport()
      )
    },
    listenerFactory: { VeyraNSIWCCallbackServer() },
    openURL: { url, completion in
      // The listener is already `ready` (the coordinator only opens the browser
      // for the exact reserved source and only from the main queue). The system
      // reports whether it accepted the open; a `false` is surfaced to the
      // coordinator as the exact-source `transport_unavailable` terminal instead
      // of being silently discarded.
      UIApplication.shared.open(url, options: [:]) { success in
        completion(success)
      }
    }
  )

  @objc override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    ["siwcEvent", "siwcStream"]
  }

  override init() {
    super.init()
    // The event sinks are installed once. The coordinator only ever invokes them
    // outside its own lock, and only for an event that still owns the exact
    // current flow or stream.
    lifecycle.setAuthHandler { [weak self] event in
      self?.emitAuthEvent(event)
    }
    lifecycle.setStreamHandler { [weak self] emission in
      self?.emitEmission(emission)
    }
  }

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

  // MARK: status

  @objc(getStatus:rejecter:)
  func getStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    resolve(["supported": true])
    #else
    resolve(["supported": false])
    #endif
  }

  @objc(statusForAccount:resolver:rejecter:)
  func statusForAccount(
    _ ownerAccountId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    // The status read captures its exact method entry inside the coordinator and
    // distinguishes an absent credential from a record that cannot be read: a
    // Keychain error is reported as the static `keychain_failure` — never as
    // "signed out" — and no credential field is ever surfaced for it.
    switch lifecycle.credentialStatus(ownerAccountId: ownerAccountId) {
    case .signedOut, .stale:
      resolve(["signedIn": false, "status": VeyraNSIWCStatus.signedOut.rawValue])
    case .keychainFailure:
      resolve([
        "signedIn": false,
        "status": VeyraNSIWCStatus.failed.rawValue,
        "error": VeyraNSIWCError.keychainFailure.code
      ])
    case let .ready(credential):
      resolve([
        "signedIn": true,
        "subject": credential.subject,
        "clientId": credential.clientId,
        "status": VeyraNSIWCStatus.ready.rawValue,
        "hasDirectScopes": true
      ])
    case let .missingPermission(credential):
      resolve([
        "signedIn": true,
        "subject": credential.subject,
        "clientId": credential.clientId,
        "status": VeyraNSIWCStatus.missingPermission.rawValue,
        "hasDirectScopes": false
      ])
    }
    #else
    resolve(["signedIn": false, "status": "signedout", "supported": false])
    #endif
  }

  // MARK: auth

  @objc(beginAuth:ownerAccountId:loginHint:resolver:rejecter:)
  func beginAuth(
    _ mode: String,
    ownerAccountId: String,
    loginHint: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    // The mode is resolved (for returning/consent) under an exact entry *before*
    // any source is reserved.
    switch lifecycle.authMode(mode) {
    case let .failure(error):
      reject(error.code, error.code, nil)
    case let .success(authMode):
      lifecycle.beginAuth(
        mode: authMode,
        ownerAccountId: ownerAccountId,
        loginHint: loginHint
      ) { result in
        switch result {
        case let .success(payload):
          resolve([
            "started": payload.started,
            "port": payload.port,
            "redirectUri": payload.redirectUri,
            "generation": payload.generation,
            "ownerAccountId": payload.ownerAccountId,
            "providerEpoch": payload.providerEpoch
          ])
        case let .failure(error):
          reject(error.code, error.code, nil)
        }
      }
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  @objc(cancelAuth:rejecter:)
  func cancelAuth(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    lifecycle.cancelAuth()
    resolve(nil)
  }

  // MARK: credential lifecycle

  @objc(logout:resolver:rejecter:)
  func logout(
    _ ownerAccountId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    // Local clear is immediate and the single best-effort revocation is
    // attempted inside `logoutDetailed`. The module must NOT pre-clear: doing so
    // would null the in-memory credential before `logoutDetailed` loads it and
    // silently skip the revocation. The coordinator captures the exact entry
    // now, so a deferred logout that loses its account afterwards performs zero
    // reads, writes and requests and can never clear a newer credential.
    lifecycle.logout(ownerAccountId: ownerAccountId) { outcome in
      resolve([
        "cleared": outcome.cleared,
        "revocationConfirmed": outcome.revocationConfirmed,
        "noActiveConnection": outcome.noActiveConnection
      ])
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  @objc(clearCredential:rejecter:)
  func clearCredential(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    lifecycle.clearCredential { cleared in
      resolve(["cleared": cleared])
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  @objc(refresh:resolver:rejecter:)
  func refresh(
    _ ownerAccountId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    lifecycle.refresh(ownerAccountId: ownerAccountId) { result in
      switch result {
      case let .success(subject):
        resolve(["refreshed": true, "subject": subject])
      case let .failure(error):
        reject(error.code, error.code, nil)
      }
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  // MARK: models

  @objc(getModels:resolver:rejecter:)
  func getModels(
    _ ownerAccountId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    lifecycle.fetchModels(ownerAccountId: ownerAccountId) { result in
      switch result {
      case let .success(models):
        resolve([
          "models": models.map { ["slug": $0.slug, "displayName": $0.displayName] }
        ])
      case let .failure(error):
        reject(error.code, error.code, nil)
      }
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  // MARK: streaming

  @objc(streamInvoke:model:input:functions:instructions:requestId:resolver:rejecter:)
  func streamInvoke(
    _ ownerAccountId: String,
    model: String,
    input: [Any],
    functions: [Any],
    instructions: String?,
    requestId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(macCatalyst)
    // A tool-less text stream is allowed (the fixed body simply omits `tools`).
    // A non-empty function list must build into the strict `veyran` namespace.
    let toolList: [Any]?
    if functions.isEmpty {
      toolList = nil
    } else {
      guard let tools = Self.buildTools(functions) else {
        reject(VeyraNSIWCError.functionCallDenied.code, "invalid tools", nil)
        return
      }
      toolList = [tools]
    }
    guard Self.validateInput(input) else {
      reject(VeyraNSIWCError.streamInvalid.code, "invalid input", nil)
      return
    }
    let authorizedNames = Self.authorizedNames(functions)

    lifecycle.streamInvoke(
      ownerAccountId: ownerAccountId,
      model: model,
      input: input,
      tools: toolList,
      instructions: instructions,
      requestId: requestId,
      authorizedNames: authorizedNames
    ) { result in
      switch result {
      case let .success(completed):
        resolve(["completed": true, "text": completed.text])
      case let .failure(error):
        reject(error.code, error.code, nil)
      }
    }
    #else
    reject("unsupported", "unsupported", nil)
    #endif
  }

  @objc(cancelStream:rejecter:)
  func cancelStream(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    lifecycle.cancelStream()
    resolve(nil)
  }

  /// The single synchronous lifecycle seam. It is called as the *first* line of
  /// every lock / logout / account-change / migration / unmount path, before any
  /// await, so an in-flight auth flow, refresh, model read or stream can never
  /// adopt a credential or emit a result after the seam.
  @objc(fence:rejecter:)
  func fence(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    lifecycle.fence()
    resolve(nil)
  }

  // MARK: internals

  private static func authorizedNames(_ functions: [Any]) -> Set<String> {
    var names = Set<String>()
    for entry in functions {
      if let object = entry as? [String: Any],
        let name = object["name"] as? String
      {
        names.insert(name)
      }
    }
    return names
  }

  private static func buildTools(_ functions: [Any]) -> [String: Any]? {
    var tools: [VeyraNSIWCFunctionTool] = []
    for entry in functions {
      guard let object = entry as? [String: Any],
        let name = object["name"] as? String,
        let description = object["description"] as? String,
        let parameters = object["parameters"] as? [String: Any]
      else { return nil }
      tools.append(VeyraNSIWCFunctionTool(
        name: name,
        description: description,
        parameters: parameters
      ))
    }
    return VeyraNSIWCTools.namespace(tools)
  }

  /// Reject a `system` role and any non-object item before the body is built.
  private static func validateInput(_ input: [Any]) -> Bool {
    guard !input.isEmpty, input.count <= 256 else { return false }
    for item in input {
      guard let object = item as? [String: Any] else { return false }
      if let role = object["role"] as? String, role == "system" { return false }
    }
    return true
  }

  /// Deliver one auth event for the exact flow generation that produced it.
  ///
  /// The event is dropped unless it still owns the current flow *at dispatch
  /// time* (checked synchronously against the coordinator, before any teardown),
  /// and it carries the authorized-flow identity (generation + owner + provider
  /// epoch) so the JS host can re-correlate it against its own active flow and
  /// host eligibility. Only redacted fields (subject/clientId/error code) are
  /// ever included.
  private func emitAuthEvent(_ event: VeyraNSIWCLifecycle.AuthEvent) {
    let body: [String: Any]
    switch event {
    case let .authenticated(subject, clientId, gen, owner, epoch):
      body = [
        "type": "authenticated",
        "subject": subject,
        "clientId": clientId,
        "generation": gen,
        "ownerAccountId": owner,
        "providerEpoch": epoch
      ]
    case let .authError(code, gen, owner, epoch):
      body = [
        "type": "authError",
        "code": code,
        "generation": gen,
        "ownerAccountId": owner,
        "providerEpoch": epoch
      ]
    }
    // The pre-queue gate is a non-consuming early drop (an event that owns
    // neither the current flow nor the terminal ticket is never even queued).
    // The *actual* dispatch below presents the consuming, linearized
    // `withAuthorizedAuthDelivery` primitive: under the coordinator lock it
    // re-checks the exact identity, consumes the terminal ticket exactly once
    // and invokes the synchronous `sendEvent` in the same critical section — so
    // a duplicate queued terminal event is delivered once and a fence/new flow
    // can never interleave between the check and the delivery (it either wins
    // before the check, dropping the event, or blocks until the delivery
    // finishes).
    guard lifecycle.allowsAuthDelivery(event), isObserving() else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lifecycle.withAuthorizedAuthDelivery(event) {
        guard self.isObserving() else { return }
        self.sendEvent(withName: "siwcEvent", body: body)
      }
    }
  }

  private func emitEmission(_ emission: VeyraNSIWCStreamEmission) {
    switch emission {
    case let .started(requestId, generation):
      emitStream([
        "type": "start",
        "requestId": requestId,
        "providerGeneration": generation
      ])
    case let .delta(text, requestId, generation):
      emitStream([
        "type": "delta",
        "requestId": requestId,
        "providerGeneration": generation,
        "text": text
      ])
    case let .functionCall(call, requestId, generation):
      emitStream([
        "type": "functionCall",
        "requestId": requestId,
        "providerGeneration": generation,
        "callId": call.callId,
        "name": call.name,
        "arguments": call.arguments
      ])
    }
  }

  private func emitStream(_ body: [String: Any]) {
    guard isObserving() else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.isObserving() else { return }
      self.sendEvent(withName: "siwcStream", body: body)
    }
  }

  private func isObserving() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return observing
  }
}
