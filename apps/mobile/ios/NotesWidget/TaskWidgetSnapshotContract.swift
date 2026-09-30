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

// Run with TaskWidgetSnapshotCodec.swift from the mobile Jest contract test.
@main
struct TaskWidgetSnapshotContract {
  static func main() throws {
    let now = Date(timeIntervalSince1970: Double(CommandLine.arguments[1])!)
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let result: [String: Any]
    switch ReminderSnapshotStore.decode(data, at: now) {
    case .unavailable:
      result = ["available": false]
    case let .available(snapshot):
      func listPayload(_ list: TaskWidgetList) -> [String: Any] {
        [
          "count": TaskWidgetClock.count(snapshot, list: list, at: now),
          "ids": TaskWidgetClock.tasks(snapshot, list: list, at: now).map(\.id)
        ]
      }
      result = [
        "available": true,
        "privacyHidden": snapshot.privacyHidden == true,
        "accountScope": snapshot.accountScope as Any? ?? NSNull(),
        "count": TaskWidgetClock.visibleCount(snapshot, at: now),
        "ids": TaskWidgetClock.visibleTasks(snapshot, at: now).map(\.id),
        "revisions": Dictionary(uniqueKeysWithValues:
          TaskWidgetClock.visibleTasks(snapshot, at: now).compactMap { item in
            item.updatedAt.map { (item.id, Int($0)) }
          }),
        "lists": [
          "today": listPayload(.today),
          "scheduled": listPayload(.scheduled),
          "all": listPayload(.all),
          "flagged": listPayload(.flagged)
        ]
      ]
    }
    let output = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(output)
  }
}
