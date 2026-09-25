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
import React
import WidgetKit
import CryptoKit

@objc(ReminderWidgetModule)
final class ReminderWidgetModule: NSObject {
  private static let snapshotFilename = "reminder-widget-snapshot.json"
  private static let widgetKind = "ReminderWidget"
  private static let maximumSnapshotSize = 256 * 1024
  private static let actionFolder = "task-widget-actions-v1"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(writeSnapshot:resolver:rejecter:)
  func writeSnapshot(
    _ snapshot: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      guard let data = snapshot.data(using: .utf8) else {
        throw SnapshotError.invalidUTF8
      }
      guard data.count <= Self.maximumSnapshotSize else {
        throw SnapshotError.snapshotTooLarge
      }
      _ = try JSONSerialization.jsonObject(with: data)
      let url = try Self.snapshotURL()

      try data.write(to: url, options: [.atomic])
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: url.path
      )
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      var mutableURL = url
      try mutableURL.setResourceValues(resourceValues)

      WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
      resolve(nil)
    } catch {
      reject("reminder_widget_write_failed", error.localizedDescription, error)
    }
  }

  @objc(clearSnapshot:rejecter:)
  func clearSnapshot(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      let url = try Self.snapshotURL()
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
      WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
      resolve(nil)
    } catch {
      reject("reminder_widget_clear_failed", error.localizedDescription, error)
    }
  }

  @objc(listPendingCompletions:rejecter:)
  func listPendingCompletions(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      let directory = try Self.actionDirectory()
      guard FileManager.default.fileExists(atPath: directory.path) else {
        resolve([])
        return
      }
      let files = try FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.fileSizeKey])
        .filter { Self.validActionFilename($0.lastPathComponent) }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
      var actions = [[String: Any]]()
      for file in files.prefix(50) {
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= 1024,
              let data = try? Data(contentsOf: file),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = value["id"] as? String,
              let scope = value["scope"] as? String,
              let updatedAt = value["updatedAt"] as? Int,
              Self.actionFilename(id: id, scope: scope, updatedAt: updatedAt)
                == file.lastPathComponent
        else {
          // Atomic writes mean a malformed action is not an in-progress write.
          try? FileManager.default.removeItem(at: file)
          continue
        }
        actions.append(value.merging(["filename": file.lastPathComponent]) { _, new in new })
      }
      resolve(actions)
    } catch {
      reject("reminder_widget_actions_read_failed", error.localizedDescription, error)
    }
  }

  @objc(acknowledgeCompletion:resolver:rejecter:)
  func acknowledgeCompletion(
    _ filename: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      guard Self.validActionFilename(filename) else { throw SnapshotError.invalidAction }
      let url = try Self.actionDirectory().appendingPathComponent(filename)
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
      WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
      resolve(nil)
    } catch {
      reject("reminder_widget_action_ack_failed", error.localizedDescription, error)
    }
  }

  private static func actionDirectory() throws -> URL {
    try snapshotURL().deletingLastPathComponent()
      .appendingPathComponent(actionFolder, isDirectory: true)
  }

  private static func validActionFilename(_ name: String) -> Bool {
    name.range(of: "^[0-9a-f]{64}\\.json$", options: .regularExpression) != nil
  }

  private static func actionFilename(id: String, scope: String, updatedAt: Int) -> String {
    let input = Data("\(scope):\(id):\(updatedAt)".utf8)
    return SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined() + ".json"
  }

  private static func snapshotURL() throws -> URL {
    guard
      let appGroup = Bundle.main.object(forInfoDictionaryKey: "appGroupId") as? String,
      !appGroup.isEmpty,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup
      )
    else {
      throw SnapshotError.appGroupUnavailable
    }
    return container.appendingPathComponent(snapshotFilename, isDirectory: false)
  }

  private enum SnapshotError: LocalizedError {
    case invalidUTF8
    case snapshotTooLarge
    case appGroupUnavailable
    case invalidAction

    var errorDescription: String? {
      switch self {
      case .invalidUTF8: return "The reminder widget snapshot is not valid UTF-8."
      case .snapshotTooLarge: return "The reminder widget snapshot is too large."
      case .appGroupUnavailable: return "The reminder widget App Group is unavailable."
      case .invalidAction: return "The Task widget action is invalid."
      }
    }
  }
}
