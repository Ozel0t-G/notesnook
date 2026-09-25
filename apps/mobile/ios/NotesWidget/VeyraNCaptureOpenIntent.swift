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

@available(iOS 18.0, *)
enum VeyraNCaptureTarget: String, AppEnum {
  case task, note

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "VeyraN Capture")
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .task: "New Task", .note: "New Note"
  ]
}

private enum VeyraNControlRoute {
  static let key = "veyran.control.captureTarget"

  static func request(_ target: String) throws {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "appGroupId") as? String,
          let defaults = UserDefaults(suiteName: group) else {
      throw VeyraNCaptureFailure.unavailable
    }
    // The shared value is only an action marker. User text and Task data never
    // pass through App Group defaults or the control extension.
    defaults.set(target, forKey: key)
    defaults.set(Date().timeIntervalSince1970, forKey: key + ".timestamp")
    guard defaults.synchronize(), defaults.string(forKey: key) == target else {
      throw VeyraNCaptureFailure.unavailable
    }
    DispatchQueue.main.async {
      NotificationCenter.default.post(
        name: Notification.Name("veyran.control.pending"), object: nil
      )
    }
  }

  static func consume() -> String? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "appGroupId") as? String,
          let defaults = UserDefaults(suiteName: group) else { return nil }
    let target = defaults.string(forKey: key)
    let timestamp = defaults.double(forKey: key + ".timestamp")
    defaults.removeObject(forKey: key)
    defaults.removeObject(forKey: key + ".timestamp")
    defaults.synchronize()
    guard timestamp > 0,
          Date().timeIntervalSince1970 - timestamp < 15 * 60 else { return nil }
    return target
  }
}

private enum VeyraNCaptureFailure: LocalizedError {
  case unavailable

  var errorDescription: String? {
    "VeyraN could not open capture. Open the app and try again."
  }
}

@available(iOS 18.0, *)
struct VeyraNOpenCaptureIntent: OpenIntent {
  static let title: LocalizedStringResource = "Open VeyraN Capture"
  @available(iOS 26.0, *)
  static let supportedModes: IntentModes = .foreground(.immediate)

  @Parameter(title: "Capture") var target: VeyraNCaptureTarget

  init() {}
  init(target: VeyraNCaptureTarget) { self.target = target }

  func perform() async throws -> some IntentResult {
    try VeyraNControlRoute.request(target.rawValue)
    return .result()
  }
}

// Included in the host target as well as the Widget extension. React Native
// consumes this marker only after the app has passed its own App Lock gate.
@objc(VeyraNControlCapture)
final class VeyraNControlCapture: NSObject {
  @objc static func consume() -> String? { VeyraNControlRoute.consume() }
}
