import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionAll]
let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as! [[String: Any]]
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  if CommandLine.arguments.count > 1 && !owner.lowercased().contains(CommandLine.arguments[1].lowercased()) { continue }
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print(w[kCGWindowNumber as String]!, owner, w[kCGWindowOwnerPID as String]!, w[kCGWindowLayer as String]!, w[kCGWindowName as String] ?? "-", b["Width"] ?? 0, b["Height"] ?? 0, w[kCGWindowIsOnscreen as String] ?? false)
}
