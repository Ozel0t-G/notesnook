import ApplicationServices
import Foundation
// usage: axpress <pid> <label> [index]   |  axpress <pid> --dump
let pid = pid_t(Int32(CommandLine.arguments[1])!)
let target = CommandLine.arguments[2]
let wantIdx = CommandLine.arguments.count > 3 ? Int(CommandLine.arguments[3])! : 0
let app = AXUIElementCreateApplication(pid)
func attr(_ e: AXUIElement, _ a: String) -> String? {
  var v: CFTypeRef?; guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success, let s = v as? String, !s.isEmpty else { return nil }; return s
}
var hits: [AXUIElement] = []
func walk(_ e: AXUIElement, _ d: Int) {
  let role = attr(e, kAXRoleAttribute) ?? ""
  let labels = [attr(e, kAXTitleAttribute), attr(e, kAXDescriptionAttribute), attr(e, kAXValueAttribute), attr(e, "AXLabel")].compactMap { $0 }
  if target == "--dump" { if !labels.isEmpty && d < 60 { print(String(repeating: " ", count: min(d,30)) + role + " " + labels.joined(separator: " | ").prefix(100)) } }
  else if labels.contains(where: { $0 == target }) { hits.append(e) }
  var c: CFTypeRef?
  if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &c) == .success, let kids = c as? [AXUIElement] { for k in kids { walk(k, d+1) } }
}
var wins: CFTypeRef?
AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &wins)
for w in (wins as? [AXUIElement]) ?? [] { walk(w, 0) }
if target != "--dump" {
  print("hits:", hits.count)
  if wantIdx < hits.count { print("press:", AXUIElementPerformAction(hits[wantIdx], kAXPressAction as CFString).rawValue) }
}
