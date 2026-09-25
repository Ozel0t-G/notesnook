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

import Foundation

// This is the production WidgetKit wire decoder. It is Foundation-only so the
// serialized output of the app's Task writer can be tested without a UI mock.
struct ReminderSnapshot: Codable {
  // Additive v3 fields must stay optional for snapshots written by older apps.
  let schemaVersion: Int
  let privacyHidden: Bool?
  let accountScope: String?
  let updatedAt: Double
  let generatedForDate: String
  let generatedForTimeZone: String
  let utcOffsetMinutes: Int // v3 compatibility; wall dates remain valid across DST.
  let count: Int
  let appearance: String
  let accentLight: String
  let accentDark: String
  let upcomingCounts: [String: Int]?
  let tasks: [ReminderSnapshotItem]
}

struct ReminderSnapshotItem: Codable, Identifiable {
  let id: String
  let updatedAt: Double?
  let title: String
  let dueDate: String?
  let dueTime: String?
  let flagged: Bool
  let priority: String
}

enum ReminderSnapshotState {
  case unavailable
  case available(ReminderSnapshot)
}

enum TaskWidgetClock {
  static var calendar: Calendar {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = .autoupdatingCurrent
    return value
  }

  static func localDate(_ date: Date) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  static func utcOffsetMinutes(_ date: Date) -> Int {
    TimeZone.autoupdatingCurrent.secondsFromGMT(for: date) / 60
  }

  static func isFresh(_ snapshot: ReminderSnapshot, at date: Date) -> Bool {
    if snapshot.privacyHidden == true { return true }
    // Calendar dates and times are local wall-clock values. Midnight and DST
    // do not invalidate the cache; a real timezone change still requires the
    // host app to regenerate it in the new zone. Compare effective offsets
    // so equivalent IANA aliases from Hermes and Foundation do not hide rows.
    guard !snapshot.generatedForTimeZone.isEmpty,
          let generatedZone = TimeZone(identifier: snapshot.generatedForTimeZone) else {
      return true
    }
    return generatedZone.secondsFromGMT(for: date)
      == TimeZone.autoupdatingCurrent.secondsFromGMT(for: date)
  }

  static func visibleTasks(_ snapshot: ReminderSnapshot, at date: Date) -> [ReminderSnapshotItem] {
    if snapshot.privacyHidden == true { return [] }
    let today = localDate(date)
    return snapshot.tasks.filter { item in
      guard let dueDate = item.dueDate else { return false }
      return dueDate <= today
    }
  }

  static func visibleCount(_ snapshot: ReminderSnapshot, at date: Date) -> Int {
    let cachedCount = visibleTasks(snapshot, at: date).count
    if let upcomingCounts = snapshot.upcomingCounts,
       snapshot.generatedForDate <= localDate(date) {
      let today = localDate(date)
      return max(cachedCount, snapshot.count + upcomingCounts.reduce(0) { total, pair in
        total + (pair.key <= today ? max(0, pair.value) : 0)
      })
    }
    // Old v3 files have no date counts. Their generation-day total is still
    // authoritative; after midnight use the rows present in the old cache.
    return snapshot.generatedForDate == localDate(date) ? max(snapshot.count, cachedCount) : cachedCount
  }

  static func nextMidnight(after date: Date) -> Date {
    let nextDay = calendar.date(byAdding: .day, value: 1, to: date) ?? date.addingTimeInterval(86400)
    return calendar.startOfDay(for: nextDay)
  }

  static func dueInstant(_ task: ReminderSnapshotItem) -> Date? {
    guard let dueDate = task.dueDate, let dueTime = task.dueTime else { return nil }
    let day = dueDate.split(separator: "-").compactMap { Int($0) }
    let time = dueTime.split(separator: ":").compactMap { Int($0) }
    guard day.count == 3, time.count == 2 else { return nil }
    return calendar.date(from: DateComponents(
      year: day[0], month: day[1], day: day[2], hour: time[0], minute: time[1]
    ))
  }

  static func isOverdue(_ task: ReminderSnapshotItem, at date: Date) -> Bool {
    guard let dueDate = task.dueDate else { return false }
    let today = localDate(date)
    if dueDate < today { return true }
    if dueDate > today { return false }
    guard let dueInstant = dueInstant(task) else { return false }
    return dueInstant < date
  }
}

enum ReminderSnapshotStore {
  private static let filename = "reminder-widget-snapshot.json"

  static func decode(_ data: Data, at now: Date) -> ReminderSnapshotState {
    let snapshot: ReminderSnapshot
    do {
      snapshot = try JSONDecoder().decode(ReminderSnapshot.self, from: data)
    } catch {
      NSLog("Task widget snapshot unavailable: decode")
      return .unavailable
    }
    guard snapshot.schemaVersion == 3 else {
      NSLog("Task widget snapshot unavailable: version")
      return .unavailable
    }
    guard snapshot.count >= 0 else {
      NSLog("Task widget snapshot unavailable: count")
      return .unavailable
    }
    guard TaskWidgetClock.isFresh(snapshot, at: now) else {
      NSLog("Task widget snapshot unavailable: timezone")
      return .unavailable
    }
    return .available(snapshot)
  }

  static func load(at now: Date = Date()) -> ReminderSnapshotState {
    guard
      let appGroup = Bundle.main.object(forInfoDictionaryKey: "appGroupId") as? String,
      !appGroup.isEmpty,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup
      )
    else {
      NSLog("Task widget snapshot unavailable: app-group")
      return .unavailable
    }

    let url = container.appendingPathComponent(filename, isDirectory: false)
    do {
      return decode(try Data(contentsOf: url), at: now)
    } catch {
      if (error as NSError).code != NSFileReadNoSuchFileError {
        NSLog("Task widget snapshot unavailable: read")
      }
      return .unavailable
    }
  }
}
