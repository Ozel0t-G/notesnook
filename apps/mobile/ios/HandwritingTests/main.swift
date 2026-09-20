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

// Native tests for the handwriting page model, paper rendering and PNG export.
// Not part of the app target. Run with scripts/handwriting-native-tests.sh
// (compiles the Handwriting sources together with this file for the iOS
// simulator and runs it there, so PencilKit and UIKit behave like on device).

import PencilKit
import UIKit

setvbuf(stdout, nil, _IONBF, 0)
var failures = 0
var passes = 0

func check(_ condition: @autoclosure () -> Bool, _ name: String, file: String = #file, line: Int = #line) {
  if condition() {
    passes += 1
    print("PASS  \(name)")
  } else {
    failures += 1
    print("FAIL  \(name)  (line \(line))")
  }
}

// MARK: - Helpers

struct Bitmap {
  let width: Int
  let height: Int
  let data: [UInt8]  // RGBA, sRGB, top-left origin

  func pixel(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
    let i = (y * width + x) * 4
    return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]))
  }
}

func bitmap(_ png: Data) -> Bitmap {
  let image = UIImage(data: png)!.cgImage!
  let w = image.width, h = image.height
  var data = [UInt8](repeating: 0, count: w * h * 4)
  let ctx = CGContext(
    data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  return Bitmap(width: w, height: h, data: data)
}

func stroke(_ from: CGPoint, _ to: CGPoint, color: UIColor = .black, width: CGFloat = 10)
  -> PKStroke
{
  let points = (0...12).map { i -> PKStrokePoint in
    let t = CGFloat(i) / 12
    return PKStrokePoint(
      location: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t),
      timeOffset: TimeInterval(i) * 0.01, size: CGSize(width: width, height: width), opacity: 1,
      force: 1, azimuth: 0, altitude: .pi / 2)
  }
  return PKStroke(
    ink: PKInk(.pen, color: color), path: PKStrokePath(controlPoints: points, creationDate: Date()))
}

func drawing(_ strokes: PKStroke...) -> PKDrawing { PKDrawing(strokes: strokes) }

func meta(_ bg: String, _ type: PaperType = .blank, _ spacing: PaperSpacing = .medium)
  -> HandwritingMetadata
{
  var m = HandwritingMetadata.legacy
  m.backgroundHex = bg
  m.paperType = type
  m.spacing = spacing
  return m
}

func near(_ p: (r: Int, g: Int, b: Int), _ r: Int, _ g: Int, _ b: Int, tol: Int = 2) -> Bool {
  abs(p.r - r) <= tol && abs(p.g - g) <= tol && abs(p.b - b) <= tol
}

func luminance(_ p: (r: Int, g: Int, b: Int)) -> Double {
  (0.2126 * Double(p.r) + 0.7152 * Double(p.g) + 0.0722 * Double(p.b)) / 255
}

func differs(_ a: (r: Int, g: Int, b: Int), _ b: (r: Int, g: Int, b: Int)) -> Bool {
  abs(a.r - b.r) + abs(a.g - b.g) + abs(a.b - b.b) > 12
}

let scale = 2
let pageWidth: CGFloat = 800
// A stroke far away from the template samples used below.
let corner = stroke(CGPoint(x: 700, y: 20), CGPoint(x: 760, y: 20))

// MARK: - Metadata model

do {
  let legacy = HandwritingMetadata.parse(nil as Data?)
  check(legacy == .legacy, "missing metadata -> legacy defaults")
  check(legacy.backgroundHex == "#FFFFFF" && legacy.paperType == .blank, "legacy = white + blank")
  check(HandwritingMetadata.parse(Data()) == .legacy, "empty data -> legacy")
  for bad in ["{oops", "[]", "42", "null", "{\"background\":{}}", "{\"version\":0}", "{\"version\":\"1\"}"] {
    check(HandwritingMetadata.parse(json: bad) == .legacy, "invalid metadata (\(bad)) -> legacy")
  }

  let example = HandwritingMetadata.parse(
    json: """
      {"version":1,"background":{"type":"color","color":"#000000"},
       "paper":{"type":"lined","spacing":"medium"}}
      """)
  check(example.backgroundHex == "#000000" && example.paperType == .lined, "documented example parses")

  let repaired = HandwritingMetadata.parse(
    json: """
      {"version":1,"background":{"color":"red"},"paper":{"type":"hex","spacing":"large","spacingPt":3},
       "canvas":{"width":"x"}}
      """)
  check(repaired.backgroundHex == "#FFFFFF", "invalid colour -> default colour")
  check(repaired.paperType == .blank && repaired.spacing == .large, "field-wise repair keeps valid fields")
  check(repaired.spacingPt == nil && repaired.canvasWidth == nil, "out-of-range values dropped")

  let newer = HandwritingMetadata.parse(
    json: "{\"version\":9,\"background\":{\"color\":\"#2c2c2e\"},\"paper\":{\"type\":\"grid\",\"spacing\":\"small\"},\"x\":1}")
  check(newer.backgroundHex == "#2C2C2E" && newer.paperType == .grid, "newer version read best-effort")

  var full = meta("#FF8800", .dotted, .large)
  full.spacingPt = 30
  full.canvasWidth = 1366
  let bytes = try! full.serialized()
  check(HandwritingMetadata.parse(bytes) == full, "serialize -> parse round trip")
  check(try! full.serialized() == bytes, "serialization is deterministic")
  let json = String(data: bytes, encoding: .utf8)!
  check(json.hasPrefix("{\"background\""), "keys are sorted")
  check(json.contains("\"version\":1"), "current version written")

  check(HandwritingMetadata.normalizeHex("#abc") == "#AABBCC", "#RGB is expanded")
  check(HandwritingMetadata.normalizeHex("ff0000") == nil, "missing # rejected")
  check(HandwritingMetadata.hex(from: UIColor(red: 1, green: 0.5, blue: 0, alpha: 1)) == "#FF8000", "UIColor -> hex")

  check(!meta("#FFFFFF").isDarkBackground, "white is a light background")
  check(!meta("#FBF3DD").isDarkBackground, "paper is a light background")
  check(!meta("#E9E9EC").isDarkBackground, "light gray is a light background")
  check(meta("#2C2C2E").isDarkBackground, "dark gray is a dark background")
  check(meta("#000000").isDarkBackground, "black is a dark background")
  check(meta("#000000").inkStyle == .dark && meta("#FFFFFF").inkStyle == .light, "ink style follows the background")

  let table: [(PaperType, PaperSpacing, CGFloat)] = [
    (.lined, .small, 24), (.lined, .medium, 32), (.lined, .large, 44),
    (.grid, .small, 16), (.grid, .medium, 24), (.grid, .large, 36),
    (.dotted, .small, 16), (.dotted, .medium, 24), (.dotted, .large, 36),
  ]
  for (type, spacing, pt) in table {
    check(meta("#FFFFFF", type, spacing).effectiveSpacing == pt, "spacing \(type) \(spacing) = \(pt)pt")
  }
  check(meta("#FFFFFF", .blank, .large).effectiveSpacing == 0, "blank paper has no spacing")
  var pinned = meta("#FFFFFF", .lined, .small)
  pinned.pinSpacing()
  check(pinned.spacingPt == 24, "pinSpacing stores the exact value")
  pinned.setSpacing(.large)
  check(pinned.spacingPt == nil && pinned.effectiveSpacing == 44, "changing the preset resets the exact value")
}

// MARK: - Export: background

do {
  let white = HandwritingExporter.render(drawing(corner), metadata: .legacy, pageWidth: pageWidth)!
  let wb = bitmap(white.pngData)
  check(near(wb.pixel(2, 2), 255, 255, 255), "white background is rendered white")
  check(white.width == wb.width && white.height == wb.height, "reported size = PNG size")

  let dark = HandwritingExporter.render(drawing(corner), metadata: meta("#2C2C2E"), pageWidth: pageWidth)!
  check(near(bitmap(dark.pngData).pixel(2, 2), 0x2C, 0x2C, 0x2E, tol: 1), "dark background is rendered #2C2C2E")

  let custom = HandwritingExporter.render(drawing(corner), metadata: meta("#FF8800"), pageWidth: pageWidth)!
  check(near(bitmap(custom.pngData).pixel(2, 2), 0xFF, 0x88, 0x00, tol: 1), "custom colour is rendered exactly")

  let black = HandwritingExporter.render(drawing(corner), metadata: meta("#000000"), pageWidth: pageWidth)!
  check(near(bitmap(black.pngData).pixel(2, 2), 0, 0, 0, tol: 1), "black background is rendered black")
}

// MARK: - Export: strokes and ink style

do {
  let line = stroke(CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 100), width: 12)
  let onWhite = HandwritingExporter.render(drawing(line), metadata: .legacy, pageWidth: pageWidth)!
  let wb = bitmap(onWhite.pngData)
  // the blank export is cropped to the strokes + 24pt padding, origin = (76, 76)
  let mid = wb.pixel(wb.width / 2, wb.height / 2)
  check(luminance(mid) < 0.25, "black ink on white stays dark")

  let onBlack = HandwritingExporter.render(drawing(line), metadata: meta("#000000"), pageWidth: pageWidth)!
  let bb = bitmap(onBlack.pngData)
  check(luminance(bb.pixel(bb.width / 2, bb.height / 2)) > 0.7, "black ink on a dark page is light (same as in the editor)")
  check(near(bb.pixel(1, 1), 0, 0, 0, tol: 1), "...on the black background")

  let red = stroke(CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 100), color: .red, width: 12)
  let redPixel = bitmap(HandwritingExporter.render(drawing(red), metadata: .legacy, pageWidth: pageWidth)!.pngData)
    .pixel(bitmap(onWhite.pngData).width / 2, bitmap(onWhite.pngData).height / 2)
  check(redPixel.r > 180 && redPixel.g < 90, "coloured ink keeps its colour")
}

// MARK: - Export: paper templates

/// Rows (device pixels) in column  whose colour differs from the page background.
func markedRows(_ b: Bitmap, x: Int, background: (r: Int, g: Int, b: Int)) -> [Int] {
  (0..<b.height).filter { differs(b.pixel(x, $0), background) }
}

for (type, spacing, pt) in [
  (PaperType.lined, PaperSpacing.small, 24), (.lined, .medium, 32), (.lined, .large, 44),
  (.grid, .small, 16), (.grid, .medium, 24), (.grid, .large, 36),
  (.dotted, .small, 16), (.dotted, .medium, 24), (.dotted, .large, 36),
] as [(PaperType, PaperSpacing, Int)] {
  for bg in ["#FFFFFF", "#2C2C2E"] {
    let m = meta(bg, type, spacing)
    let out = HandwritingExporter.render(drawing(corner), metadata: m, pageWidth: pageWidth)!
    let b = bitmap(out.pngData)
    let base = b.pixel(1, 1)  // (1,1) is never on a template mark
    let name = "\(type) \(spacing) on \(bg)"

    check(out.width == Int(pageWidth) * scale, "\(name): PNG has the full page width")
    check(out.height % (pt * scale) == 0, "\(name): height is a whole number of cells")
    check(out.metadata.canvasWidth == Double(pageWidth) && out.metadata.spacingPt == Double(pt), "\(name): metadata pins width + spacing")

    // pick a column that is on a grid line for grid, off it for the others
    let x = type == .grid ? 2 * pt * 3 : 2 * pt * 3 + pt
    let rows = markedRows(b, x: type == .dotted ? 2 * pt * 3 : x, background: base)
    switch type {
    case .lined:
      let centres = rows.filter { $0 % (2 * pt) == 0 || $0 % (2 * pt) == 2 * pt - 1 }
      check(!rows.isEmpty && rows.allSatisfy { $0 % (2 * pt) <= 1 || $0 % (2 * pt) == 2 * pt - 1 }, "\(name): only the line rows are marked")
      check(centres.count >= 2 * (b.height / (2 * pt) - 2), "\(name): a line every \(pt)pt")
      check(b.pixel(1, 2 * pt) != base && differs(b.pixel(1, 2 * pt), base), "\(name): first line sits one spacing below the top")
      check(!differs(b.pixel(1, pt), base), "\(name): between two lines the page is clean")
      check(!differs(b.pixel(1, 1), base) && !differs(b.pixel(b.width - 1, 0), base), "\(name): nothing on the page edge")
    case .grid:
      check(b.pixel(2 * pt, 5) != base && differs(b.pixel(2 * pt, 5), base), "\(name): vertical lines")
      check(differs(b.pixel(5, 2 * pt), base), "\(name): horizontal lines")
      check(!differs(b.pixel(pt, pt), base), "\(name): cell interior is clean")
    case .dotted:
      check(differs(b.pixel(2 * pt, 2 * pt), base), "\(name): a dot at the first crossing")
      check(!differs(b.pixel(pt, pt), base) && !differs(b.pixel(2 * pt, pt), base), "\(name): nothing between the dots")
      check(!differs(b.pixel(5, 2 * pt), base), "\(name): dots only, no lines")
    case .blank: break
    }
  }
}

do {
  // template colour follows the background: dark marks on light, light marks on dark
  let l = bitmap(HandwritingExporter.render(drawing(corner), metadata: meta("#FFFFFF", .lined), pageWidth: pageWidth)!.pngData)
  check(luminance(l.pixel(1, 64)) < luminance(l.pixel(1, 1)), "lines are darker than a light page")
  let d = bitmap(HandwritingExporter.render(drawing(corner), metadata: meta("#2C2C2E", .lined), pageWidth: pageWidth)!.pngData)
  check(luminance(d.pixel(1, 64)) > luminance(d.pixel(1, 1)), "lines are lighter than a dark page")
}

// MARK: - Export: strokes are on top of the template

for type in [PaperType.lined, .grid, .dotted] {
  // horizontal stroke exactly along a template row (y = 3 * spacing)
  let spacing = meta("#FFFFFF", type, .medium).effectiveSpacing
  let y = 3 * spacing
  let s = stroke(CGPoint(x: 100, y: y), CGPoint(x: 400, y: y), width: 14)
  for bg in ["#FFFFFF", "#000000"] {
    let out = HandwritingExporter.render(drawing(s), metadata: meta(bg, type, .medium), pageWidth: pageWidth)!
    let b = bitmap(out.pngData)
    let p = b.pixel(2 * 250, Int(y) * scale)
    let ink = luminance(p)
    check(bg == "#FFFFFF" ? ink < 0.2 : ink > 0.8, "\(type) on \(bg): the stroke is drawn over the template")
    // the template row is still visible next to the stroke
    let base = b.pixel(1, 1)
    check(type == .dotted || differs(b.pixel(2 * 600, Int(y) * scale), base), "\(type) on \(bg): template continues beside the stroke")
  }
}

// MARK: - Export: extent

do {
  let s = stroke(CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 500), width: 10)
  let blank = HandwritingExporter.render(drawing(s), metadata: .legacy, pageWidth: pageWidth)!
  let bounds = drawing(s).bounds.insetBy(dx: -24, dy: -24).integral
  check(blank.width == Int(bounds.width) * scale && blank.height == Int(bounds.height) * scale, "blank paper: cropped to strokes + padding (unchanged from Build 1/2)")
  check(blank.metadata.canvasWidth == Double(pageWidth), "blank paper still remembers the page width")

  let lined = HandwritingExporter.render(drawing(s), metadata: meta("#FFFFFF", .lined, .medium), pageWidth: pageWidth)!
  check(lined.width == Int(pageWidth) * scale, "templated paper: full page width")
  check(lined.height >= Int(drawing(s).bounds.maxY) * scale, "templated paper: covers all strokes")

  let wide = stroke(CGPoint(x: 100, y: 100), CGPoint(x: 1200, y: 100))
  let wideOut = HandwritingExporter.render(drawing(wide), metadata: meta("#FFFFFF", .grid), pageWidth: pageWidth)!
  check(wideOut.width > Int(pageWidth) * scale, "ink beyond the page widens the export instead of being cut")

  check(HandwritingExporter.render(PKDrawing(), metadata: .legacy, pageWidth: pageWidth) == nil, "empty drawing is not exported")

  let huge = stroke(CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 30000))
  let hugeOut = HandwritingExporter.render(drawing(huge), metadata: meta("#FFFFFF", .lined), pageWidth: 1366)!
  check(hugeOut.width * hugeOut.height <= 24_500_000, "very long pages are scaled down to a bounded pixel count")
}

// MARK: - Editor / export parity

do {
  // The live editor draws the same renderer: a snapshot of the paper view at
  // scroll offset (0,0) must equal the exported template.
  for type in [PaperType.lined, .grid, .dotted] {
    let m = meta("#FBF3DD", type, .small)
    let view = PaperBackgroundView(frame: CGRect(x: 0, y: 0, width: 400, height: 240))
    view.metadata = m
    let image = UIGraphicsImageRenderer(size: view.bounds.size, format: {
      let f = UIGraphicsImageRendererFormat(); f.scale = 2; f.opaque = true; f.preferredRange = .standard; return f
    }()).image { _ in view.draw(view.bounds) }
    let editor = bitmap(image.pngData()!)
    let out = HandwritingExporter.render(drawing(corner), metadata: m, pageWidth: pageWidth)!
    let exported = bitmap(out.pngData)
    var mismatches = 0
    for y in 0..<min(editor.height, exported.height) {
      for x in stride(from: 0, to: 800, by: 1) where near(editor.pixel(x, y), exported.pixel(x, y).r, exported.pixel(x, y).g, exported.pixel(x, y).b, tol: 1) == false {
        mismatches += 1
      }
    }
    check(mismatches == 0, "\(type): editor paper == exported paper (\(mismatches) differing pixels)")
  }

  // scrolling / zooming keeps the template glued to the content
  let m = meta("#FFFFFF", .lined, .medium)  // 32pt lines
  let view = PaperBackgroundView(frame: CGRect(x: 0, y: 0, width: 300, height: 300))
  view.metadata = m
  view.contentOffset = CGPoint(x: 0, y: 40)
  view.zoomScale = 2
  let image = UIGraphicsImageRenderer(size: view.bounds.size, format: {
    let f = UIGraphicsImageRendererFormat(); f.scale = 1; f.opaque = true; f.preferredRange = .standard; return f
  }()).image { _ in view.draw(view.bounds) }
  let b = bitmap(image.pngData()!)
  // content line at y=96 (3 * 32) is drawn at 96 * 2 - 40 = 152 on screen
  check(differs(b.pixel(10, 152), b.pixel(10, 100)), "scrolled + zoomed: line appears at content_y * zoom - offset")
  check(!differs(b.pixel(10, 130), b.pixel(10, 100)), "scrolled + zoomed: nothing between lines")
}

print("\n\(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
