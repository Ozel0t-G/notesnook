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

@available(iOS 16.0, *)
enum VeyraNPriority: String, AppEnum {
  case none, low, medium, high

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task Priority")
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .none: "None", .low: "Low", .medium: "Medium", .high: "High"
  ]
}

@available(iOS 16.0, *)
enum VeyraNRepeat: String, AppEnum {
  case never, daily, weekly, monthly, yearly

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task Repeat")
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .never: "Never", .daily: "Daily", .weekly: "Weekly",
    .monthly: "Monthly", .yearly: "Yearly"
  ]
}

@available(iOS 16.0, *)
struct VeyraNCreateTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Create Task in VeyraN"
  static let description = IntentDescription("Create a Task in the encrypted VeyraN library.")
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static let supportedModes: IntentModes = .foreground(.immediate)

  @Parameter(title: "Title") var title: String
  @Parameter(title: "List Name") var listName: String?
  @Parameter(title: "Reminder") var reminder: Date?
  @Parameter(title: "Repeat") var repeatMode: VeyraNRepeat?
  @Parameter(title: "Priority") var priority: VeyraNPriority?
  @Parameter(title: "Flag") var flagged: Bool?
  @Parameter(title: "Urgent") var urgent: Bool?

  static var parameterSummary: some ParameterSummary {
    Summary("Create \(\.$title) in VeyraN")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
    var payload = ["title": title]
    if let listName { payload["listName"] = listName }
    if let reminder {
      payload["reminderTimestamp"] = String(Int64(reminder.timeIntervalSince1970 * 1000))
    }
    if let repeatMode { payload["repeatMode"] = repeatMode.rawValue }
    if let priority { payload["priority"] = priority.rawValue }
    if let flagged { payload["flagged"] = flagged ? "true" : "false" }
    if let urgent { payload["urgent"] = urgent ? "true" : "false" }
    let id = try await VeyraNIntentMailbox.shared.submit(
      action: "createTask", payload: payload
    )
    return .result(value: id, dialog: "Task created in VeyraN.")
  }
}

@available(iOS 16.0, *)
struct VeyraNQuickTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Quick Task in VeyraN"
  static let description = IntentDescription("Quickly save a Task in VeyraN.")
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static let supportedModes: IntentModes = .foreground(.immediate)

  @Parameter(title: "Task") var title: String
  @Parameter(title: "List Name") var listName: String?

  static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$title) to VeyraN")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
    var payload = ["title": title]
    if let listName { payload["listName"] = listName }
    let id = try await VeyraNIntentMailbox.shared.submit(
      action: "createTask", payload: payload
    )
    return .result(value: id, dialog: "Task added to VeyraN.")
  }
}

@available(iOS 16.0, *)
struct VeyraNCompleteTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Complete Task in VeyraN"
  static let description = IntentDescription("Complete a Task by its exact title.")
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static let supportedModes: IntentModes = .foreground(.immediate)

  @Parameter(title: "Task Title") var taskTitle: String

  static var parameterSummary: some ParameterSummary {
    Summary("Complete \(\.$taskTitle) in VeyraN")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    _ = try await VeyraNIntentMailbox.shared.submit(
      action: "completeTask", payload: ["title": taskTitle]
    )
    return .result(dialog: "Task completed in VeyraN.")
  }
}

@available(iOS 16.0, *)
struct VeyraNCreateNoteIntent: AppIntent {
  static let title: LocalizedStringResource = "Create Note in VeyraN"
  static let description = IntentDescription("Create a Note in the encrypted VeyraN library.")
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static let supportedModes: IntentModes = .foreground(.immediate)

  @Parameter(title: "Title") var title: String
  @Parameter(title: "Content") var content: String?

  static var parameterSummary: some ParameterSummary {
    Summary("Create \(\.$title) in VeyraN")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
    var payload = ["title": title]
    if let content { payload["content"] = content }
    let id = try await VeyraNIntentMailbox.shared.submit(
      action: "createNote", payload: payload
    )
    return .result(value: id, dialog: "Note created in VeyraN.")
  }
}

@available(iOS 16.0, *)
struct VeyraNQuickNoteIntent: AppIntent {
  static let title: LocalizedStringResource = "Quick Note in VeyraN"
  static let description = IntentDescription("Quickly save a Note in VeyraN.")
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static let supportedModes: IntentModes = .foreground(.immediate)

  @Parameter(title: "Text") var text: String

  static var parameterSummary: some ParameterSummary {
    Summary("Save \(\.$text) in VeyraN")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
    let id = try await VeyraNIntentMailbox.shared.submit(
      action: "createNote", payload: ["content": text]
    )
    return .result(value: id, dialog: "Note added to VeyraN.")
  }
}

@available(iOS 16.0, *)
struct VeyraNTodayTasksIntent: AppIntent {
  static let title: LocalizedStringResource = "Get Today's VeyraN Tasks"
  static let description = IntentDescription("Get titles of Tasks due today or overdue.")
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static let supportedModes: IntentModes = .foreground(.immediate)

  func perform() async throws -> some IntentResult & ReturnsValue<[String]> {
    let json = try await VeyraNIntentMailbox.shared.submit(
      action: "todayTasks", payload: [:]
    )
    guard let data = json.data(using: .utf8),
          let titles = try? JSONDecoder().decode([String].self, from: data) else {
      throw VeyraNIntentFailure.failed
    }
    return .result(value: titles)
  }
}

@available(iOS 16.0, *)
struct VeyraNAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: VeyraNQuickTaskIntent(),
      phrases: ["Add a task in \(.applicationName)", "Quick task in \(.applicationName)"],
      shortTitle: "Quick Task", systemImageName: "checklist"
    )
    AppShortcut(
      intent: VeyraNCreateTaskIntent(),
      phrases: ["Create a task in \(.applicationName)"],
      shortTitle: "Create Task", systemImageName: "checkmark.circle"
    )
    AppShortcut(
      intent: VeyraNCompleteTaskIntent(),
      phrases: ["Complete a task in \(.applicationName)"],
      shortTitle: "Complete Task", systemImageName: "checkmark"
    )
    AppShortcut(
      intent: VeyraNQuickNoteIntent(),
      phrases: ["Make a quick note in \(.applicationName)"],
      shortTitle: "Quick Note", systemImageName: "square.and.pencil"
    )
    AppShortcut(
      intent: VeyraNCreateNoteIntent(),
      phrases: ["Create a note in \(.applicationName)"],
      shortTitle: "Create Note", systemImageName: "note.text"
    )
    AppShortcut(
      intent: VeyraNTodayTasksIntent(),
      phrases: ["Show today's tasks in \(.applicationName)"],
      shortTitle: "Today's Tasks", systemImageName: "calendar"
    )
  }
}
