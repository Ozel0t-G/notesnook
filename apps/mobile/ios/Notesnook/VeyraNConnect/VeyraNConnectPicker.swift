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

// The public, local-only file picker for the operator's pairing document.
//
// Only the public `UIDocumentPickerViewController` is used, only for
// `public.json`, and only on Mac Catalyst. A picked URL is a security-scoped
// URL; access is opened, the file is read once through the symlink-safe reader
// and access is closed again. Nothing here touches the filesystem generically
// or reads any other file.

import Foundation
import UIKit
import UniformTypeIdentifiers

#if targetEnvironment(macCatalyst)

final class VeyraNConnectPairingPicker: NSObject, UIDocumentPickerDelegate {
  private let completion: (Result<VeyraNConnectPairing, VeyraNConnectError>) -> Void
  // Retained while the picker is on screen.
  private var picker: UIDocumentPickerViewController?

  init(
    completion: @escaping (Result<VeyraNConnectPairing, VeyraNConnectError>) -> Void
  ) {
    self.completion = completion
  }

  func start() {
    guard let presenter = VeyraNConnectPairingPicker.topViewController() else {
      completion(.failure(.transportUnavailable))
      return
    }
    let controller = UIDocumentPickerViewController(
      forOpeningContentTypes: [UTType.json],
      asCopy: false
    )
    controller.delegate = self
    controller.allowsMultipleSelection = false
    controller.shouldShowFileExtensions = true
    picker = controller
    presenter.present(controller, animated: true)
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController,
    didPickDocumentsAt urls: [URL]
  ) {
    guard let url = urls.first else {
      finish(.failure(.pairingCancelled))
      return
    }
    let scoped = url.startAccessingSecurityScopedResource()
    defer {
      if scoped { url.stopAccessingSecurityScopedResource() }
    }
    switch VeyraNConnectPairingFileReader.read(path: url.path) {
    case let .success(pairing):
      finish(.success(pairing))
    case .failure(.insecure):
      finish(.failure(.pairingFileInsecure))
    case .failure:
      finish(.failure(.pairingInvalid))
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(.failure(.pairingCancelled))
  }

  private func finish(_ result: Result<VeyraNConnectPairing, VeyraNConnectError>) {
    picker = nil
    completion(result)
  }

  static func topViewController() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    let key = windows.first(where: { $0.isKeyWindow }) ?? windows.first
    var top = key?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

#endif
