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

/// Everything about a handwriting page that PKDrawing does not store: page
/// background colour, paper template and page width. Persisted as
/// `handwriting-<UUID>.json` (see `app/services/handwriting/metadata.ts`,
/// which implements the same schema and spacing presets; keep both in sync).
///
/// Rendering order everywhere (editor and PNG): background colour, paper
/// template, PKDrawing strokes. Background and paper are never part of the
/// strokes, so the eraser cannot remove them. A nil `backgroundHex` means a
/// transparent page: the editor draws on white but the exported PNG has an
/// alpha channel and no background at all.
enum PaperType: String, CaseIterable {
  case blank, lined, grid, dotted
}

enum PaperSpacing: String, CaseIterable {
  case small, medium, large
}

struct HandwritingMetadata: Equatable {
  static let currentVersion = 1

  /// Spacing presets in points. Same values as SPACING_POINTS in metadata.ts.
  static func presetSpacing(_ type: PaperType, _ spacing: PaperSpacing) -> CGFloat {
    switch (type, spacing) {
    case (.blank, _): return 0
    case (.lined, .small): return 24
    case (.lined, .medium): return 32
    case (.lined, .large): return 44
    case (_, .small): return 16
    case (_, .medium): return 24
    case (_, .large): return 36
    }
  }

  /// Page background as sRGB hex. `nil` = transparent page (new drawings): the
  /// exported PNG has alpha 0 wherever nothing is drawn.
  var backgroundHex: String?
  var paperType: PaperType
  var spacing: PaperSpacing
  /// Exact spacing in points; wins over the preset when present.
  var spacingPt: Double?
  /// Optional overrides for the template colour. Derived from the background otherwise.
  var templateColorHex: String?
  var templateOpacity: Double?
  /// Page width in points (the PNG is width * scale pixels wide).
  var canvasWidth: Double?

  /// White, blank paper: how every drawing from before metadata existed looked.
  /// Still opaque so old drawings keep rendering exactly as before.
  static let legacy = HandwritingMetadata(
    backgroundHex: "#FFFFFF", paperType: .blank, spacing: .medium, spacingPt: nil,
    templateColorHex: nil, templateOpacity: nil, canvasWidth: nil)

  /// A brand-new drawing: transparent page, blank paper, medium spacing.
  static let newDrawing = HandwritingMetadata(
    backgroundHex: nil, paperType: .blank, spacing: .medium, spacingPt: nil,
    templateColorHex: nil, templateOpacity: nil, canvasWidth: nil)

  // MARK: - Derived values

  var isTransparent: Bool { backgroundHex == nil }

  /// The page's own background colour, `nil` for a transparent page. Used by
  /// the export, which must not fill anything for a transparent page.
  var pageBackgroundColor: UIColor? {
    backgroundHex.flatMap { UIColor(hex: $0) }
  }

  /// Opaque colour of the editor's drawing surface. A transparent page is shown
  /// on white (the editor is forced to the light style), but the exported PNG
  /// never contains this surface.
  var drawingSurfaceColor: UIColor { pageBackgroundColor ?? .white }

  /// Perceived luminance of the background, 0 (black) ... 1 (white).
  /// A transparent page reports 1 so it uses the light template/ink defaults.
  var backgroundLuminance: CGFloat {
    guard let hex = backgroundHex, let c = HandwritingMetadata.rgb(hex) else { return 1 }
    return 0.2126 * c.0 + 0.7152 * c.1 + 0.0722 * c.2
  }

  var isDarkBackground: Bool { backgroundLuminance < 0.5 }

  /// PencilKit adapts ink colours to the interface style (default black ink
  /// turns white in dark mode). The editor and the PNG export must use the SAME
  /// style, otherwise strokes would look different after saving. The style is
  /// therefore derived from the background, never from the system appearance.
  /// A transparent page is always `.light` (normal black ink); the editor
  /// adapts to dark mode separately.
  var inkStyle: UIUserInterfaceStyle { isDarkBackground ? .dark : .light }

  /// Effective line / grid / dot distance in points, 0 for blank paper.
  var effectiveSpacing: CGFloat {
    if paperType == .blank { return 0 }
    if let pt = spacingPt { return CGFloat(pt) }
    return HandwritingMetadata.presetSpacing(paperType, spacing)
  }

  /// Colour of lines / grid / dots, blended over the background by the renderer.
  var templateColor: UIColor {
    if let hex = templateColorHex, let color = UIColor(hex: hex) {
      return color.withAlphaComponent(CGFloat(templateOpacity ?? defaultTemplateAlpha))
    }
    let alpha = CGFloat(templateOpacity ?? defaultTemplateAlpha)
    if isDarkBackground { return UIColor(white: 1, alpha: alpha) }
    return paperType == .dotted
      ? UIColor(white: 0, alpha: alpha)
      : UIColor(red: 0.20, green: 0.33, blue: 0.55, alpha: alpha)
  }

  private var defaultTemplateAlpha: Double {
    switch paperType {
    case .dotted: return isDarkBackground ? 0.40 : 0.38
    default: return isDarkBackground ? 0.20 : 0.30
    }
  }

  // MARK: - Editing helpers

  mutating func setPaper(_ type: PaperType) {
    paperType = type
    spacingPt = nil  // presets differ per type
  }

  mutating func setSpacing(_ value: PaperSpacing) {
    spacing = value
    spacingPt = nil
  }

  /// Pins the exact spacing so the page looks the same even if presets change.
  mutating func pinSpacing() {
    spacingPt = paperType == .blank ? nil : Double(effectiveSpacing)
  }

  // MARK: - Parsing (lenient, never fails)

  /// Missing / empty / invalid data gives `fallback` (`.legacy` unless the
  /// caller creates a new drawing). Single invalid fields are replaced by their
  /// defaults. A newer schema version is read best-effort.
  static func parse(_ data: Data?, fallback: HandwritingMetadata = .legacy) -> HandwritingMetadata {
    guard let data = data, !data.isEmpty,
      let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let version = raw["version"] as? Int, version >= 1
    else { return fallback }

    var result = fallback
    if let bg = raw["background"] as? [String: Any] {
      if (bg["type"] as? String) == "none" {
        // transparent page
        result.backgroundHex = nil
      } else if let hex = normalizeHex(bg["color"]) {
        result.backgroundHex = hex
      }
    }
    if let paper = raw["paper"] as? [String: Any] {
      if let type = (paper["type"] as? String).flatMap(PaperType.init(rawValue:)) {
        result.paperType = type
      }
      if let spacing = (paper["spacing"] as? String).flatMap(PaperSpacing.init(rawValue:)) {
        result.spacing = spacing
      }
      if let pt = number(paper["spacingPt"]), pt >= 8, pt <= 128 { result.spacingPt = pt }
      if let hex = normalizeHex(paper["color"]) { result.templateColorHex = hex }
      if let opacity = number(paper["opacity"]), opacity >= 0, opacity <= 1 {
        result.templateOpacity = opacity
      }
    }
    if let canvas = raw["canvas"] as? [String: Any], let width = number(canvas["width"]),
      width >= 64, width <= 8192
    {
      result.canvasWidth = width
    }
    return result
  }

  static func parse(json: String?, fallback: HandwritingMetadata = .legacy)
    -> HandwritingMetadata
  {
    parse(json?.data(using: .utf8), fallback: fallback)
  }

  /// Deterministic JSON (sorted keys): identical metadata gives identical bytes
  /// and therefore the same attachment hash.
  func serialized() throws -> Data {
    var paper: [String: Any] = ["type": paperType.rawValue, "spacing": spacing.rawValue]
    if let spacingPt = spacingPt { paper["spacingPt"] = spacingPt }
    if let hex = templateColorHex { paper["color"] = hex }
    if let opacity = templateOpacity { paper["opacity"] = opacity }
    let background: [String: Any] =
      backgroundHex.map { ["type": "color", "color": $0] } ?? ["type": "none"]
    var root: [String: Any] = [
      "version": HandwritingMetadata.currentVersion,
      "background": background,
      "paper": paper,
    ]
    if let width = canvasWidth { root["canvas"] = ["width": width] }
    return try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])
  }

  // MARK: - Colour helpers

  static func normalizeHex(_ value: Any?) -> String? {
    guard var hex = value as? String, hex.hasPrefix("#") else { return nil }
    hex.removeFirst()
    guard hex.count == 3 || hex.count == 6, hex.allSatisfy({ $0.isHexDigit }) else { return nil }
    if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
    return "#" + hex.uppercased()
  }

  static func rgb(_ hex: String) -> (CGFloat, CGFloat, CGFloat)? {
    guard let normalized = normalizeHex(hex), let value = UInt32(normalized.dropFirst(), radix: 16)
    else { return nil }
    return (
      CGFloat((value >> 16) & 0xFF) / 255, CGFloat((value >> 8) & 0xFF) / 255,
      CGFloat(value & 0xFF) / 255
    )
  }

  static func hex(from color: UIColor) -> String {
    // custom colours from the system picker may be wide-gamut; store sRGB
    let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
    let converted = color.cgColor.converted(to: srgb, intent: .defaultIntent, options: nil)
    let c = converted?.components ?? [1, 1, 1]
    func byte(_ v: CGFloat) -> Int { max(0, min(255, Int((v * 255).rounded()))) }
    let comps = c.count >= 3 ? c : [c.first ?? 1, c.first ?? 1, c.first ?? 1]
    return String(format: "#%02X%02X%02X", byte(comps[0]), byte(comps[1]), byte(comps[2]))
  }

  private static func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber, !(value is Bool) else { return nil }
    let d = n.doubleValue
    return d.isFinite ? d : nil
  }
}

extension UIColor {
  convenience init?(hex: String) {
    guard let (r, g, b) = HandwritingMetadata.rgb(hex) else { return nil }
    self.init(red: r, green: g, blue: b, alpha: 1)
  }
}
