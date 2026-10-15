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

// The fixed Responses request builder, the incremental SSE decoder, the strict
// `veyran` function namespace/terminal-item parser and the full-input
// continuation builder.
//
// The request body is *fixed*: only `model`, `input`, `store:false`,
// `stream:true`, an optional `instructions` and the fixed `veyran` tool
// namespace are ever emitted. The unsupported Responses parameters
// (background, conversation, max_output_tokens, max_tool_calls, metadata,
// moderation, multi_agent, prompt, prompt_cache_retention, safety_identifier,
// temperature, top_logprobs, top_p, truncation, user, previous_response_id)
// are never constructible here, and a `system` role is rejected.
//
// Only `response.completed` is a success terminal. Deltas, `[DONE]`, a 200
// EOF, `response.failed`, `response.incomplete`, `response.canceled` and an
// `error` event never authorize a tool call, a write or a success.
//
// This file imports only Foundation.

import Foundation

// MARK: - Function namespace

struct VeyraNSIWCFunctionTool {
  let name: String
  let description: String
  /// A strict JSON-schema object: `type:"object"`, a `properties` map, a
  /// `required` array covering *every* property and `additionalProperties:false`.
  let parameters: [String: Any]
}

enum VeyraNSIWCTools {
  static let namespaceName = "veyran"
  static let maxFunctions = 32

  /// The official namespace entry: `{ type:"namespace", name:"veyran",
  /// tools:[ { type:"function", name, description, strict:true, parameters } ] }`.
  static func namespace(_ functions: [VeyraNSIWCFunctionTool]) -> [String: Any]? {
    guard !functions.isEmpty, functions.count <= maxFunctions else { return nil }
    var names = Set<String>()
    var entries: [[String: Any]] = []
    for function in functions {
      guard functionName(function.name),
        !function.description.isEmpty, function.description.utf8.count <= 4096,
        validSchema(function.parameters),
        names.insert(function.name).inserted
      else { return nil }
      entries.append([
        "type": "function",
        "name": function.name,
        "description": function.description,
        "strict": true,
        "parameters": function.parameters
      ])
    }
    return [
      "type": "namespace",
      "name": namespaceName,
      "tools": entries
    ]
  }

  static func functionName(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 64 else { return false }
    for scalar in value.unicodeScalars {
      switch scalar {
      case "a"..."z", "A"..."Z", "0"..."9", "_", "-":
        continue
      default:
        return false
      }
    }
    return true
  }

  /// A strict object schema: `type == object`, `properties` a map of
  /// sub-schemas, `required` exactly the property names, `additionalProperties`
  /// false. No nested `$ref`/`anyOf` is accepted.
  static func validSchema(_ schema: [String: Any]) -> Bool {
    guard Set(schema.keys) == [
      "type", "properties", "required", "additionalProperties"
    ] else { return false }
    guard schema["type"] as? String == "object" else { return false }
    guard let additional = schema["additionalProperties"] as? Bool,
      additional == false
    else { return false }
    guard let properties = schema["properties"] as? [String: Any],
      let required = schema["required"] as? [Any]
    else { return false }
    let names = required.compactMap { $0 as? String }
    guard names.count == required.count else { return false }
    guard Set(names) == Set(properties.keys), names.count == properties.count
    else { return false }
    for value in properties.values {
      guard let sub = value as? [String: Any], primitiveSchema(sub) else {
        return false
      }
    }
    return true
  }

  private static func primitiveSchema(_ schema: [String: Any]) -> Bool {
    guard let type = schema["type"] as? String else { return false }
    switch type {
    case "string", "boolean":
      return Set(schema.keys) == ["type", "description"]
        || Set(schema.keys) == ["type"]
    case "number", "integer":
      return Set(schema.keys) == ["type", "description"]
        || Set(schema.keys) == ["type"]
    default:
      return false
    }
  }
}

// MARK: - Input items

enum VeyraNSIWCInput {
  static let maxTextBytes = 256 * 1024

  /// A simple message item. Only `user`, `developer` and `assistant` roles are
  /// constructible; `system` is refused.
  static func message(role: String, text: String) -> [String: Any]? {
    guard role == "user" || role == "developer" || role == "assistant" else {
      return nil
    }
    guard !text.isEmpty, text.utf8.count <= maxTextBytes else { return nil }
    return ["role": role, "content": [["type": "input_text", "text": text]]]
  }

  /// `{ type:"function_call_output", call_id, output }` where `output` is a
  /// JSON *string* the controlled host executor produced.
  static func functionCallOutput(callId: String, output: String) -> [String: Any]? {
    guard !callId.isEmpty, callId.utf8.count <= 128,
      !output.isEmpty, output.utf8.count <= maxTextBytes,
      isValidJSONText(output)
    else { return nil }
    return [
      "type": "function_call_output",
      "call_id": callId,
      "output": output
    ]
  }

  /// Full-input continuation: the original user/developer messages, the actual
  /// returned reasoning/function_call items verbatim, then the one
  /// `function_call_output`. There is never an HTTP `previous_response_id`.
  static func continuation(
    original: [Any],
    returned: [Any],
    functionCallOutput: [String: Any]
  ) -> [Any] {
    var out = original
    for item in returned {
      guard let object = item as? [String: Any],
        let type = object["type"] as? String
      else { continue }
      if type == "reasoning" || type == "function_call" || type == "message" {
        out.append(object)
      }
    }
    out.append(functionCallOutput)
    return out
  }

  static func isValidJSONText(_ value: String) -> Bool {
    guard value.utf8.count <= maxTextBytes else { return false }
    guard VeyraNConnectStrictJSON.hasUniqueObjectKeys(value) else { return false }
    guard let data = value.data(using: .utf8),
      (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil
    else { return false }
    return true
  }
}

// MARK: - Request body

enum VeyraNSIWCResponsesRequest {
  /// The fixed body. `model` must already be a member of the live catalog; the
  /// caller enforces that, and this builder only enforces shape and bounds.
  static func body(
    model: String,
    input: [Any],
    tools: [Any]?,
    instructions: String?
  ) -> Data? {
    guard VeyraNSIWCValidate.modelSlug(model) else { return nil }
    guard !input.isEmpty else { return nil }
    var object: [String: Any] = [
      "model": model,
      "input": input,
      "store": false,
      "stream": true
    ]
    if let tools, !tools.isEmpty { object["tools"] = tools }
    if let instructions {
      guard !instructions.isEmpty, instructions.utf8.count <= VeyraNSIWCInput.maxTextBytes
      else { return nil }
      object["instructions"] = instructions
    }
    guard JSONSerialization.isValidJSONObject(object) else { return nil }
    let data = try? JSONSerialization.data(withJSONObject: object, options: [])
    guard let data, data.count <= VeyraNSIWC.maxStreamBytes else { return nil }
    return data
  }

  /// The fixed headers for the streaming POST. Only these are ever set.
  static func headers(accessToken: String) -> [String: String]? {
    guard VeyraNSIWCValidate.tokenString(accessToken) else { return nil }
    return [
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Authorization": "Bearer \(accessToken)"
    ]
  }

  /// The fixed headers for the models GET.
  static func modelsHeaders(accessToken: String) -> [String: String]? {
    guard VeyraNSIWCValidate.tokenString(accessToken) else { return nil }
    return [
      "Accept": "application/json",
      "Authorization": "Bearer \(accessToken)"
    ]
  }
}

// MARK: - SSE decoder

struct VeyraNSIWCSSEEvent: Equatable {
  let name: String?
  let data: String
}

/// A bounded, incremental `text/event-stream` decoder. It refuses a line longer
/// than the fixed bound and a running field that would exceed it, so a hostile
/// or truncated stream cannot grow memory without limit.
struct VeyraNSIWCSSEDecoder {
  private var lineBuffer = Data()
  private var eventName: String?
  private var dataLines: [String] = []
  private var sawAnyLine = false

  mutating func append(_ chunk: Data) throws -> [VeyraNSIWCSSEEvent] {
    var events: [VeyraNSIWCSSEEvent] = []
    lineBuffer.append(chunk)
    while let newlineIndex = lineBuffer.firstIndex(of: 0x0A) {
      var line = lineBuffer.subdata(in: lineBuffer.startIndex..<newlineIndex)
      lineBuffer.removeSubrange(lineBuffer.startIndex...newlineIndex)
      // Strip a trailing CR.
      if line.last == 0x0D { line.removeLast() }
      guard line.count <= VeyraNSIWC.maxLineBytes else {
        throw VeyraNSIWCError.streamInvalid
      }
      if let event = try consume(line: line) { events.append(event) }
    }
    guard lineBuffer.count <= VeyraNSIWC.maxLineBytes else {
      throw VeyraNSIWCError.streamInvalid
    }
    return events
  }

  /// Flush a final, unterminated event at EOF. A truncated event is discarded
  /// rather than adopted.
  mutating func finish() -> VeyraNSIWCSSEEvent? {
    guard !dataLines.isEmpty || eventName != nil else { return nil }
    let event = VeyraNSIWCSSEEvent(
      name: eventName,
      data: dataLines.joined(separator: "\n")
    )
    eventName = nil
    dataLines = []
    return event
  }

  private mutating func consume(line: Data) throws -> VeyraNSIWCSSEEvent? {
    if line.isEmpty {
      // Blank line terminates a dispatch.
      guard sawAnyLine else { return nil }
      sawAnyLine = false
      guard !dataLines.isEmpty || eventName != nil else { return nil }
      let event = VeyraNSIWCSSEEvent(
        name: eventName,
        data: dataLines.joined(separator: "\n")
      )
      eventName = nil
      dataLines = []
      return event
    }
    sawAnyLine = true
    guard let text = String(data: line, encoding: .utf8) else {
      throw VeyraNSIWCError.streamInvalid
    }
    if text.hasPrefix(":") {
      // A comment line is ignored.
      return nil
    }
    let field: String
    let value: String
    if let colon = text.firstIndex(of: ":") {
      field = String(text[text.startIndex..<colon])
      var rest = String(text[text.index(after: colon)...])
      if rest.hasPrefix(" ") { rest.removeFirst() }
      value = rest
    } else {
      field = text
      value = ""
    }
    switch field {
    case "event":
      eventName = value
    case "data":
      dataLines.append(value)
    default:
      // `id`, `retry` and unknown fields are ignored.
      break
    }
    return nil
  }
}

// MARK: - Terminal function call

struct VeyraNSIWCFunctionCall: Equatable {
  let id: String?
  let callId: String
  let name: String
  let arguments: String
  let status: String?
  let asyncFlag: Bool?

  /// Parse one terminal `function_call` item. `authorizedNames` is the set of
  /// function names this provider itself offered. Every deviation — a missing
  /// namespace, a program caller, an unknown/dangerous field, a non-completed
  /// status, a malformed arguments string, an unknown name — fails closed.
  static func parse(
    _ value: Any,
    authorizedNames: Set<String>
  ) -> VeyraNSIWCFunctionCall? {
    guard let item = value as? [String: Any],
      let type = item["type"] as? String, type == "function_call",
      let namespace = item["namespace"] as? String,
      namespace == VeyraNSIWCTools.namespaceName,
      let callId = item["callId"] as? String ?? item["call_id"] as? String,
      !callId.isEmpty, callId.utf8.count <= 128,
      let name = item["name"] as? String,
      authorizedNames.contains(name),
      let arguments = item["arguments"] as? String, !arguments.isEmpty,
      arguments.utf8.count <= VeyraNSIWCInput.maxTextBytes,
      VeyraNSIWCInput.isValidJSONText(arguments)
    else { return nil }

    let allowed: Set<String> = [
      "type", "id", "call_id", "callId", "namespace", "name", "arguments",
      "status", "async", "caller"
    ]
    guard Set(item.keys).isSubset(of: allowed) else { return nil }

    var status: String?
    if let raw = item["status"], !(raw is NSNull) {
      guard let parsed = raw as? String else { return nil }
      // A contradictory (non-completed) item status authorizes nothing.
      guard parsed == "completed" else { return nil }
      status = parsed
    }

    var asyncFlag: Bool?
    if let raw = item["async"], !(raw is NSNull) {
      guard let parsed = VeyraNConnectValidate.strictBool(raw) else {
        return nil
      }
      asyncFlag = parsed
    }

    // `caller` is only ever the official `{ "type": "direct" }`; a `program`
    // caller is refused.
    if let rawCaller = item["caller"], !(rawCaller is NSNull) {
      guard let caller = rawCaller as? [String: Any],
        Set(caller.keys) == ["type"],
        caller["type"] as? String == "direct"
      else { return nil }
    }

    var id: String?
    if let raw = item["id"], !(raw is NSNull) {
      guard let parsed = raw as? String, !parsed.isEmpty,
        parsed.utf8.count <= 128
      else { return nil }
      id = parsed
    }

    return VeyraNSIWCFunctionCall(
      id: id,
      callId: callId,
      name: name,
      arguments: arguments,
      status: status,
      asyncFlag: asyncFlag
    )
  }
}

// MARK: - Completed response

enum VeyraNSIWCResponseItem: Equatable {
  case text(String)
  case functionCall(VeyraNSIWCFunctionCall)
  case other(type: String)
}

struct VeyraNSIWCCompletedResponse {
  let items: [VeyraNSIWCResponseItem]
  /// The raw returned output items, kept verbatim for a full-input
  /// continuation.
  let rawOutput: [Any]

  var text: String {
    items.compactMap {
      if case let .text(value) = $0 { return value }
      return nil
    }.joined()
  }

  var functionCalls: [VeyraNSIWCFunctionCall] {
    items.compactMap {
      if case let .functionCall(call) = $0 { return call }
      return nil
    }
  }

  /// Parse a `response.completed` event's `data` payload. Only this event is a
  /// success terminal; the caller enforces that. Shape deviations fail closed.
  static func parse(
    eventData: String,
    authorizedNames: Set<String>
  ) -> VeyraNSIWCCompletedResponse? {
    guard let data = eventData.data(using: .utf8),
      data.count <= VeyraNSIWC.maxStreamBytes,
      VeyraNConnectStrictJSON.hasUniqueObjectKeys(eventData),
      let value = try? JSONSerialization.jsonObject(
        with: data,
        options: [.fragmentsAllowed]
      ),
      let root = value as? [String: Any],
      root["type"] as? String == "response.completed",
      let response = root["response"] as? [String: Any],
      let output = response["output"] as? [Any]
    else { return nil }

    var items: [VeyraNSIWCResponseItem] = []
    var callIds = Set<String>()
    for entry in output {
      guard let object = entry as? [String: Any],
        let type = object["type"] as? String
      else { return nil }
      switch type {
      case "function_call":
        guard let call = VeyraNSIWCFunctionCall.parse(
          object,
          authorizedNames: authorizedNames
        ) else { return nil }
        // A duplicate call id is ambiguous, never adopted.
        guard callIds.insert(call.callId).inserted else { return nil }
        items.append(.functionCall(call))
      case "message":
        guard let content = object["content"] as? [Any] else { return nil }
        var text = ""
        for part in content {
          guard let partObject = part as? [String: Any],
            let partType = partObject["type"] as? String
          else { return nil }
          if partType == "output_text" {
            guard let value = partObject["text"] as? String else { return nil }
            text += value
          } else if partType == "refusal" {
            // A refusal is not a success; the caller treats empty text
            // accordingly.
            continue
          } else {
            continue
          }
        }
        items.append(.text(text))
      case "reasoning":
        items.append(.other(type: "reasoning"))
      default:
        items.append(.other(type: type))
      }
    }
    return VeyraNSIWCCompletedResponse(items: items, rawOutput: output)
  }
}
