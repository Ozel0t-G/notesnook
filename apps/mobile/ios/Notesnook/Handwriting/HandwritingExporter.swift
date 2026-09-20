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

import PencilKit
import UIKit

/// Renders the saved page to a PNG: background colour, paper template, then the
/// strokes on top. The PNG is the single source of truth for every other
/// Notesnook client, so it never depends on the theme of the device that
/// displays it.
enum HandwritingExporter {
  struct Output {
    let pngData: Data
    /// Pixel size of the PNG.
    let width: Int
    let height: Int
    /// The metadata to store: `canvasWidth` and the pinned spacing are filled in.
    let metadata: HandwritingMetadata
  }

  static let padding: CGFloat = 24
  private static let minimumTemplateHeight: CGFloat = 240
  /// Upper bound for the PNG size so very long pages cannot exhaust memory.
  private static let maxPixels: CGFloat = 24_000_000
  private static let minimumScale: CGFloat = 0.25
  /// PencilKit renders through a GPU texture (max 8192 px per side), so strokes
  /// are rendered in tiles of at most this many pixels per side.
  private static let maxTilePixels: CGFloat = 4096

  /// The area of the page that ends up in the PNG, in canvas points.
  ///
  /// - Blank paper: cropped to the strokes plus padding (unchanged behaviour,
  ///   there is no template to keep aligned).
  /// - Lined / grid / dotted: the full page width, from the top of the page down
  ///   to the last stroke, rounded up to a whole template cell. The template is
  ///   anchored at the page origin, so the PNG lines up with the editor.
  static func exportRect(for drawing: PKDrawing, metadata: HandwritingMetadata, pageWidth: CGFloat)
    -> CGRect?
  {
    let bounds = drawing.bounds
    guard !bounds.isNull, !bounds.isInfinite, !bounds.isEmpty else { return nil }

    if metadata.paperType == .blank {
      let rect = bounds.insetBy(dx: -padding, dy: -padding).integral
      return rect.width > 0 && rect.height > 0 ? rect : nil
    }

    let spacing = max(metadata.effectiveSpacing, 4)
    let width = max(pageWidth, ceil(bounds.maxX + padding))
    let content = max(ceil(bounds.maxY + padding), minimumTemplateHeight)
    let height = ceil(content / spacing) * spacing
    return CGRect(x: 0, y: 0, width: ceil(width), height: height)
  }

  static func render(
    _ drawing: PKDrawing, metadata: HandwritingMetadata, pageWidth: CGFloat, scale: CGFloat = 2
  ) -> Output? {
    guard let rect = exportRect(for: drawing, metadata: metadata, pageWidth: pageWidth) else {
      return nil
    }

    let area = rect.width * rect.height
    let effectiveScale = max(minimumScale, min(scale, (maxPixels / area).squareRoot()))

    var image: UIImage?
    // Same interface style as the editor (derived from the background): ink
    // colours are adapted by PencilKit according to it.
    UITraitCollection(userInterfaceStyle: metadata.inkStyle).performAsCurrent {
      let format = UIGraphicsImageRendererFormat()
      format.scale = effectiveScale
      format.opaque = true
      format.preferredRange = .standard
      let tile = floor(maxTilePixels / effectiveScale)
      let strokeBounds = drawing.bounds
      image = UIGraphicsImageRenderer(size: rect.size, format: format).image { renderer in
        let context = renderer.cgContext
        // canvas coordinates -> image coordinates
        context.translateBy(x: -rect.minX, y: -rect.minY)
        PaperRenderer.draw(metadata, in: context, rect: rect)
        // strokes on top, tile by tile
        var y = rect.minY
        while y < rect.maxY {
          var x = rect.minX
          while x < rect.maxX {
            let area = CGRect(x: x, y: y, width: min(tile, rect.maxX - x), height: min(tile, rect.maxY - y))
            if area.intersects(strokeBounds) {
              drawing.image(from: area, scale: effectiveScale).draw(in: area)
            }
            x += tile
          }
          y += tile
        }
      }
    }
    guard let png = image?.pngData() else { return nil }

    var stored = metadata
    stored.canvasWidth = Double(max(pageWidth, rect.width))
    stored.pinSpacing()
    return Output(
      pngData: png, width: Int((rect.width * effectiveScale).rounded()),
      height: Int((rect.height * effectiveScale).rounded()), metadata: stored)
  }
}
