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
import UIKit

/// Bridges the public UIApplication settings URLs to JS. Notifee's iOS
/// `openNotificationSettings()` is a documented no-op (it only calls native
/// code on Android), so Tasks notification rows must not depend on it here.
@objc(NotificationSettingsModule)
final class NotificationSettingsModule: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc(openNotificationSettings:rejecter:)
  func openNotificationSettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      func openVerified(_ url: URL, opened: @escaping () -> Void, failed: @escaping () -> Void) {
        var didBackground = false
        var settled = false
        var observer: NSObjectProtocol?
        func finish(_ success: Bool) {
          guard !settled else { return }
          settled = true
          if let observer { NotificationCenter.default.removeObserver(observer) }
          if success { opened() } else { failed() }
        }
        observer = NotificationCenter.default.addObserver(
          forName: UIApplication.didEnterBackgroundNotification,
          object: nil,
          queue: .main
        ) { _ in
          didBackground = true
          finish(true)
        }
        UIApplication.shared.open(url, options: [:]) { accepted in
          if !accepted {
            finish(false)
          } else if didBackground || UIApplication.shared.applicationState == .background {
            finish(true)
          } else {
            // Some simulator builds report an accepted URL without displaying
            // Settings. Verify that our app actually left the foreground.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
              finish(didBackground || UIApplication.shared.applicationState == .background)
            }
          }
        }
      }

      func openAppSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
          reject("notification_settings_unavailable", "Could not construct the app Settings URL.", nil)
          return
        }
        openVerified(url, opened: {
          resolve("settings")
        }, failed: {
            reject("notification_settings_failed", "The system declined to open Settings.", nil)
        })
      }

      // UIApplication.openNotificationSettingsURLString (Swift: iOS 16+) is the
      // public, Apple-documented way to deep link straight to this app's
      // notification settings. Its value is opaque and must be read at
      // runtime rather than hardcoded. Fall back to the app's general
      // Settings page (openSettingsURLString) on older iOS or if the direct
      // link fails to open.
      if #available(iOS 16.0, *) {
        let notificationSettingsURLString = UIApplication.openNotificationSettingsURLString
        if let url = URL(string: notificationSettingsURLString) {
          openVerified(url, opened: { resolve("notifications") }, failed: openAppSettings)
          return
        }
      }

      openAppSettings()
    }
  }
}
