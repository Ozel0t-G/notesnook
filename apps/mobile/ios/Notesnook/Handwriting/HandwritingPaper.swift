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

import UIKit

/// Draws the page underneath the strokes. The same code renders the live
/// editor and the exported PNG, so both are identical by construction.
///
/// The page background is filled separately (`fillBackground`), because a
/// transparent page must not fill anything in the export. `draw` only renders
/// the paper template in the template colour.
///
/// All coordinates are canvas points (origin = top-left of the page). Template
/// lines / dots sit at multiples of the spacing, starting one spacing away from
/// the top-left edge, so nothing is cut in half at the page border.
enum PaperRenderer {
  private static let lineThickness: CGFloat = 1
  private static let dotRadius: CGFloat = 1.3

  /// Fills `rect` (canvas points) with the page's own background colour. Does
  /// nothing for a transparent page, so the exported PNG keeps an alpha
  /// channel. The context's transform must already map canvas points.
  static func fillBackground(
    _ metadata: HandwritingMetadata, in context: CGContext, rect: CGRect
  ) {
    guard let color = metadata.pageBackgroundColor else { return }
    context.saveGState()
    defer { context.restoreGState() }
    context.setFillColor(color.cgColor)
    context.fill(rect)
  }

  /// Draws the paper template (lines / grid / dots) in the template colour.
  /// Never fills a background.
  static func draw(_ metadata: HandwritingMetadata, in context: CGContext, rect: CGRect) {
    let spacing = metadata.effectiveSpacing
    guard metadata.paperType != .blank, spacing >= 4 else { return }

    context.saveGState()
    defer { context.restoreGState() }
    context.setFillColor(metadata.templateColor.cgColor)

    let firstRow = max(1, Int(floor(rect.minY / spacing)))
    let lastRow = Int(ceil(rect.maxY / spacing))
    let firstColumn = max(1, Int(floor(rect.minX / spacing)))
    let lastColumn = Int(ceil(rect.maxX / spacing))
    guard firstRow <= lastRow, firstColumn <= lastColumn else { return }
    let left = max(rect.minX, 0)
    let top = max(rect.minY, 0)

    switch metadata.paperType {
    case .blank:
      break
    case .lined:
      for row in firstRow...lastRow {
        let y = CGFloat(row) * spacing - lineThickness / 2
        context.fill(CGRect(x: left, y: y, width: rect.maxX - left, height: lineThickness))
      }
    case .grid:
      for row in firstRow...lastRow {
        let y = CGFloat(row) * spacing - lineThickness / 2
        context.fill(CGRect(x: left, y: y, width: rect.maxX - left, height: lineThickness))
      }
      for column in firstColumn...lastColumn {
        let x = CGFloat(column) * spacing - lineThickness / 2
        context.fill(CGRect(x: x, y: top, width: lineThickness, height: rect.maxY - top))
      }
    case .dotted:
      for row in firstRow...lastRow {
        for column in firstColumn...lastColumn {
          let center = CGPoint(x: CGFloat(column) * spacing, y: CGFloat(row) * spacing)
          context.fillEllipse(
            in: CGRect(
              x: center.x - dotRadius, y: center.y - dotRadius, width: dotRadius * 2,
              height: dotRadius * 2))
        }
      }
    }
  }
}

/// Sits behind the (transparent) PKCanvasView and mirrors its scroll offset and
/// zoom, so the paper moves together with the strokes. Because it is a
/// separate view underneath, the template can never be selected, erased or
/// become part of the PKDrawing.
final class PaperBackgroundView: UIView {
  var metadata: HandwritingMetadata = .legacy {
    didSet {
      // Opaque editor surface: white for a transparent page. Never exported.
      backgroundColor = metadata.drawingSurfaceColor
      setNeedsDisplay()
    }
  }
  var contentOffset: CGPoint = .zero { didSet { setNeedsDisplay() } }
  var zoomScale: CGFloat = 1 { didSet { setNeedsDisplay() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = true
    backgroundColor = metadata.drawingSurfaceColor
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    let zoom = max(zoomScale, 0.01)
    context.translateBy(x: -contentOffset.x, y: -contentOffset.y)
    context.scaleBy(x: zoom, y: zoom)
    let visible = CGRect(
      x: contentOffset.x / zoom, y: contentOffset.y / zoom, width: bounds.width / zoom,
      height: bounds.height / zoom)
    // Filled here (not only by the layer colour) so a manual draw() snapshot
    // matches the exported PNG for old opaque pages.
    PaperRenderer.fillBackground(metadata, in: context, rect: visible)
    PaperRenderer.draw(metadata, in: context, rect: visible)
  }
}
