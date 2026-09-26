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

import AppIntents
import Foundation

// The Shortcuts Task picker. This file is compiled into the application target
// only, which is also where the system runs these queries: the project declares
// no App Intents extension, so `suggestedEntities()` and `entities(for:)` run in
// the app's own process, which is the only process that can open the encrypted
// React Native Task domain.
//
// Nothing here reads or writes Tasks itself. Every list comes from the host
// JavaScript through `VeyraNIntentMailbox`, which starts the React Native host
// without mounting a UI surface, and there is no Swift copy of any Task.

/// One real Task, addressed by `<account scope>:<Task id>`.
///
/// A Shortcuts parameter round trip preserves the identifier and nothing else,
/// so the account a Task belongs to is part of the identifier rather than a
/// property of this value. `title` and `subtitle` exist only for what the picker
/// draws; the authoritative record stays in the encrypted database.
@available(iOS 16.0, *)
struct VeyraNTaskEntity: AppEntity {
  let id: String
  let title: String
  let subtitle: String

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "VeyraN Task")
  static let defaultQuery = VeyraNTaskEntityQuery()

  var displayRepresentation: DisplayRepresentation {
    if subtitle.isEmpty {
      return DisplayRepresentation(title: "\(title)")
    }
    return DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)")
  }
}

private struct VeyraNTaskCandidate: Decodable {
  let id: String
  let title: String
  let subtitle: String
}

@available(iOS 16.0, *)
struct VeyraNTaskEntityQuery: EntityStringQuery {
  /// Matches `encodeTaskEntityId` in app-intent-tasks.ts, case for case.
  private static let identifier =
    "^[0-9a-f]{32}:(?:[0-9a-f]{24}|[0-9a-f]{32})$"
  private static let matching: String.CompareOptions = [
    .regularExpression, .caseInsensitive
  ]
  /// Matches `MAX_TASK_ENTITY_IDS`.
  private static let maximumIdentifiers = 50
  /// A picker query may be a cold start that has to load the bundle and open
  /// the encrypted database, but it is also blocking a visible list.
  private static let timeout: TimeInterval = 20

  // iOS 27 is the first release that can route this query to the main app
  // process explicitly. The encrypted Task domain only exists there, so
  // background routing must not be left to guess a target.
  @available(iOS 27.0, *)
  static var allowedExecutionTargets: IntentExecutionTargets { .main }

  /// Resolving a parameter a Shortcut already saved.
  func entities(for identifiers: [String]) async throws -> [VeyraNTaskEntity] {
    let wellFormed = identifiers.filter {
      $0.range(of: Self.identifier, options: Self.matching) != nil
    }
    guard !wellFormed.isEmpty else { return [] }
    let requested = Array(wellFormed.prefix(Self.maximumIdentifiers))
    guard let encoded = try? JSONEncoder().encode(requested),
          let ids = String(data: encoded, encoding: .utf8) else {
      throw VeyraNIntentFailure.invalidInput
    }
    do {
      return try await candidates(action: "resolveTasks", payload: ["ids": ids])
    } catch VeyraNIntentFailure.locked {
      // App Lock withholds titles from everything outside the app. Returning a
      // redacted stand-in keeps a saved Shortcut intact and selectable rather
      // than making it look broken, and it reveals nothing about the library.
      return requested.map {
        VeyraNTaskEntity(id: $0, title: "VeyraN Task", subtitle: "Protected by App Lock")
      }
    }
  }

  /// What Shortcuts and Siri search when the person types or says a title.
  func entities(matching string: String) async throws -> [VeyraNTaskEntity] {
    await suggestions(query: string)
  }

  /// The list the picker offers before anything is typed.
  func suggestedEntities() async throws -> [VeyraNTaskEntity] {
    await suggestions(query: nil)
  }

  /// Suggestions are advisory and the system asks for them at moments of its
  /// own choosing, so an App Lock refusal, a cold start that could not finish
  /// or an unavailable database is an empty list rather than an error. A saved
  /// parameter and the completion itself do report their failures.
  private func suggestions(query: String?) async -> [VeyraNTaskEntity] {
    var payload: [String: String] = [:]
    if let query, !query.isEmpty { payload["query"] = query }
    return (try? await candidates(action: "suggestTasks", payload: payload)) ?? []
  }

  private func candidates(
    action: String, payload: [String: String]
  ) async throws -> [VeyraNTaskEntity] {
    let json = try await VeyraNIntentMailbox.shared.submit(
      action: action, payload: payload, requiresHost: true, timeout: Self.timeout
    )
    guard let data = json.data(using: .utf8),
          let decoded = try? JSONDecoder().decode([VeyraNTaskCandidate].self, from: data) else {
      throw VeyraNIntentFailure.failed
    }
    return decoded.compactMap { candidate in
      guard candidate.id.range(
        of: Self.identifier, options: Self.matching
      ) != nil else { return nil }
      return VeyraNTaskEntity(
        id: candidate.id, title: candidate.title, subtitle: candidate.subtitle
      )
    }
  }
}
