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

/// Surfaces shared between the app target and the NotesWidget extension target.
///
/// AlarmKit hands the widget extension the same `AlarmAttributes` the app used to
/// schedule the alarm, and a Live Activity view must agree with the app on the
/// attributes' Codable shape, so everything in this file is compiled into both
/// binaries. It therefore must stay free of React Native and other app-only
/// imports. See `docs/urgent-reminders-architecture.md`.

// AlarmKit/ActivityKit import on Mac Catalyst but their types are unavailable there.
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
#endif

import AppIntents
import Foundation

#if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
import AlarmKit

/// Metadata for an Urgent Task alarm. Deliberately empty: Task titles and every
/// other piece of user content stay on the app side and never reach the widget
/// extension or the system's alarm store through AlarmKit.
@available(iOS 26.0, *)
struct TaskAlarmMetadata: AlarmMetadata {}

/// The intents behind the alarm Live Activity's controls. They carry only the
/// alarm's UUID (a SHA-256-derived value, never user content) and forward the
/// tap to `AlarmManager`, so Stop/Pause/Resume keep exactly the same meaning as
/// the system alert's own buttons. Stop only silences the alert; it never
/// completes the Task.
@available(iOS 26.0, *)
struct TaskAlarmStopIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Stop"
  static var description = IntentDescription("Silence a Task alarm.")

  @Parameter(title: "alarmID")
  var alarmID: String

  init(alarmID: String) {
    self.alarmID = alarmID
  }

  init() {
    self.alarmID = ""
  }

  func perform() throws -> some IntentResult {
    guard let id = UUID(uuidString: alarmID) else { return .result() }
    try AlarmManager.shared.stop(id: id)
    return .result()
  }
}

@available(iOS 26.0, *)
struct TaskAlarmPauseIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Pause"
  static var description = IntentDescription("Pause a Task alarm countdown.")

  @Parameter(title: "alarmID")
  var alarmID: String

  init(alarmID: String) {
    self.alarmID = alarmID
  }

  init() {
    self.alarmID = ""
  }

  func perform() throws -> some IntentResult {
    guard let id = UUID(uuidString: alarmID) else { return .result() }
    try AlarmManager.shared.pause(id: id)
    return .result()
  }
}

@available(iOS 26.0, *)
struct TaskAlarmResumeIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Resume"
  static var description = IntentDescription("Resume a paused Task alarm.")

  @Parameter(title: "alarmID")
  var alarmID: String

  init(alarmID: String) {
    self.alarmID = alarmID
  }

  init() {
    self.alarmID = ""
  }

  func perform() throws -> some IntentResult {
    guard let id = UUID(uuidString: alarmID) else { return .result() }
    try AlarmManager.shared.resume(id: id)
    return .result()
  }
}

/// Snooze. The system runs this when somebody taps the alert's secondary button;
/// it starts a countdown (the `CountdownDuration.postAlert` interval) and then
/// re-alerts. The Task's own reminder occurrence is never modified.
@available(iOS 26.0, *)
struct TaskAlarmRepeatIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Snooze"
  static var description = IntentDescription("Postpone the next Task alert.")

  @Parameter(title: "alarmID")
  var alarmID: String

  init(alarmID: String) {
    self.alarmID = alarmID
  }

  init() {
    self.alarmID = ""
  }

  func perform() throws -> some IntentResult {
    guard let id = UUID(uuidString: alarmID) else { return .result() }
    try AlarmManager.shared.countdown(id: id)
    return .result()
  }
}
#endif

#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
/// Attributes for the "Task is overdue and still incomplete" Live Activity.
///
/// Only the opaque Task id is static. The Task title lives in `ContentState` so
/// an App Lock change (which swaps the title for its redacted placeholder) can
/// update the existing activity instead of ending and recreating it. The title
/// is already redacted by the app before it is handed over.
@available(iOS 16.2, *)
struct OverdueTaskActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// The local instant the Task's reminder was due. The widget renders the
    /// elapsed time from this date with a self-updating SwiftUI timer; no
    /// JavaScript timer and no app-side refresh drives it.
    var dueDate: Date
    /// Task title, redacted by the app whenever App Lock is enabled.
    var title: String
  }

  /// Opaque Task database id: used to route a tap back to the Task's List and
  /// to correlate the activity with its Task. Never user content.
  var taskId: String
}
#endif
