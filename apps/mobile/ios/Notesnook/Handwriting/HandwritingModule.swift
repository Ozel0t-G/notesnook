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
import PencilKit
import UIKit

/// React Native bridge for PencilKit handwriting. Only exchanges file paths
/// (never base64) with JS. Drawing contents are never logged.
///
///   create(metadata)                     -> { id, pngPath, drawingPath, metadataPath, width, height }
///   edit(sourcePath, drawingId, metadata) -> same shape, keeps `drawingId`
///
/// `metadata` is the JSON of the page settings (background, paper, page width)
/// as sanitised by JS. Invalid or empty JSON falls back to white blank paper.

/// Cancelling rejects with code `E_CANCELLED`.
@objc(HandwritingModule)
final class HandwritingModule: NSObject {
  private static let tempFolder = "handwriting"
  private var isPresenting = false

  @objc static func requiresMainQueueSetup() -> Bool { true }

  /// Where the handwriting editor can run: iPad, and Mac Catalyst.
  ///
  /// Mac used to report `.pad` here because the app scaled the iPad UI; with
  /// "Optimize Interface for Mac" the user interface idiom is `.mac`, so the
  /// idiom alone would silently take handwriting away on Mac. The PencilKit
  /// canvas itself is available in both Catalyst builds (see the drawing
  /// policy in `HandwritingViewController`).
  private static var isSupportedIdiom: Bool {
    #if targetEnvironment(macCatalyst)
      return true
    #else
      return UIDevice.current.userInterfaceIdiom == .pad
    #endif
  }

  @objc(isAvailable:rejecter:)
  func isAvailable(
    _ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(HandwritingModule.isSupportedIdiom)
  }

  @objc(create:resolver:rejecter:)
  func create(
    _ metadata: String?, resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    present(
      drawing: PKDrawing(), metadata: HandwritingMetadata.parse(json: metadata),
      id: UUID().uuidString.lowercased(), resolve, reject)
  }

  @objc(edit:drawingId:metadata:resolver:rejecter:)
  func edit(
    _ sourcePath: String, drawingId: String, metadata: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard UUID(uuidString: drawingId) != nil else {
      return reject("E_INVALID_ID", "Invalid drawing id", nil)
    }
    let path = sourcePath.hasPrefix("file://")
      ? (URL(string: sourcePath)?.path ?? sourcePath) : sourcePath
    guard let data = FileManager.default.contents(atPath: path),
      let drawing = try? PKDrawing(data: data)
    else {
      return reject("E_INVALID_DRAWING", "Could not read the drawing source file", nil)
    }
    present(
      drawing: drawing, metadata: HandwritingMetadata.parse(json: metadata),
      id: drawingId.lowercased(), resolve, reject)
  }

  // MARK: - Private

  private func present(
    drawing: PKDrawing, metadata: HandwritingMetadata, id: String, _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      guard HandwritingModule.isSupportedIdiom else {
        return reject("E_UNSUPPORTED", "Handwriting is only available on iPad and Mac", nil)
      }
      guard !self.isPresenting, let presenter = Self.topViewController() else {
        return reject("E_BUSY", "Cannot present the handwriting editor", nil)
      }
      self.isPresenting = true
      Self.removeStaleTempFiles()

      let controller = HandwritingViewController(drawing: drawing, metadata: metadata) { [weak self] result in
        self?.isPresenting = false
        guard let result = result else {
          return reject("E_CANCELLED", "Handwriting cancelled", nil)
        }
        do {
          resolve(try Self.write(result, id: id))
        } catch {
          reject("E_WRITE_FAILED", "Could not write handwriting files", nil)
        }
      }
      let navigation = UINavigationController(rootViewController: controller)
      navigation.modalPresentationStyle = .fullScreen
      navigation.isModalInPresentation = true
      presenter.present(navigation, animated: true)
    }
  }

  private static func write(_ result: HandwritingResult, id: String) throws -> [String: Any] {
    let directory = tempRoot().appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let png = directory.appendingPathComponent("handwriting-\(id).png")
    let source = directory.appendingPathComponent("handwriting-\(id).pkdrawing")
    let metadata = directory.appendingPathComponent("handwriting-\(id).json")
    try result.pngData.write(to: png, options: .atomic)
    try result.drawing.dataRepresentation().write(to: source, options: .atomic)
    try result.metadata.serialized().write(to: metadata, options: .atomic)
    return [
      "id": id,
      "pngPath": png.path,
      "drawingPath": source.path,
      "metadataPath": metadata.path,
      "width": result.width,
      "height": result.height,
    ]
  }

  private static func tempRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(tempFolder, isDirectory: true)
  }

  /// Safety net: JS deletes temp files after import; this removes leftovers
  /// (e.g. after a crash) that are older than a day.
  private static func removeStaleTempFiles() {
    let root = tempRoot()
    let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
    guard
      let items = try? FileManager.default.contentsOfDirectory(
        at: root, includingPropertiesForKeys: [.contentModificationDateKey])
    else { return }
    for item in items {
      let date = (try? item.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate
      if let date = date, date < cutoff { try? FileManager.default.removeItem(at: item) }
    }
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window =
      scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow })
      ?? scenes.flatMap { $0.windows }.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController, !presented.isBeingDismissed {
      top = presented
    }
    return top
  }
}
