// RIGS Control: the macOS screen and input helper (docs/full-access.md §4, docs/control-implementation.md).
//
// Runs as its own LaunchAgent (dev.rigs.control), so it is its own TCC responsible process: Screen Recording
// and Accessibility are granted to "RIGS Control", never to the daemon's node. The daemon talks to it over
// RIGS_HOME/run/control.sock (0600) with JSON lines {id, op, token, ...args} → {id, ok, result | error}.
// The per-start token is written to RIGS_HOME/run/control.token (0600) and checked on every request.
//
// Kept compatible with Swift 5.6 / the macOS 12.3 SDK (the toolchain on macbookpro): capture spawns
// /usr/sbin/screencapture from this process (SCScreenshotManager needs the macOS 14 SDK), so the grant
// still belongs to the helper.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO

let VERSION = "1"

struct Fail: Error {
  let code: String
  let message: String
  init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

// ------------------------------------------------------------------------- paths and token

func argValue(_ name: String) -> String? {
  let a = CommandLine.arguments
  if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
  return nil
}

let home = argValue("--home") ?? ProcessInfo.processInfo.environment["RIGS_HOME"] ?? (NSHomeDirectory() + "/.rigs")
let runDir = home + "/run"
let sockPath = runDir + "/control.sock"
let tokenPath = runDir + "/control.token"
let shotsDir = runDir + "/shots/"

func log(_ s: String) {
  FileHandle.standardError.write(("[\(ISO8601DateFormatter().string(from: Date()))] " + s + "\n").data(using: .utf8)!)
}

func randomToken() -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess { fatalError("no random bytes") }
  return bytes.map { String(format: "%02x", $0) }.joined()
}

/** Writes a 0600 file atomically: the daemon must never read a half-written token. */
func writePrivate(_ path: String, _ text: String) throws {
  let tmp = path + ".\(getpid()).tmp"
  guard FileManager.default.createFile(atPath: tmp, contents: text.data(using: .utf8), attributes: [.posixPermissions: 0o600]) else {
    throw Fail("error", "cannot write \(tmp)")
  }
  if rename(tmp, path) != 0 { throw Fail("error", "cannot rename \(tmp): \(String(cString: strerror(errno)))") }
}

// ------------------------------------------------------------------------- JSON helpers

func num(_ v: Any?) -> Double? {
  if let n = v as? NSNumber, !(v is Bool) { return n.doubleValue }
  return nil
}
func str(_ v: Any?) -> String? {
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}
func rectDict(_ r: CGRect) -> [String: Any] {
  ["x": Int(r.origin.x.rounded()), "y": Int(r.origin.y.rounded()), "width": Int(r.width.rounded()), "height": Int(r.height.rounded())]
}

// ------------------------------------------------------------------------- main-thread helper

func onMain<T>(_ fn: () -> T) -> T {
  if Thread.isMainThread { return fn() }
  return DispatchQueue.main.sync(execute: fn)
}

// ------------------------------------------------------------------------- displays and lock

struct Display {
  let id: CGDirectDisplayID
  let index: Int
  let bounds: CGRect  // global points
  let pixelWidth: Int
  let pixelHeight: Int
  let primary: Bool
  var scale: Double { Double(pixelWidth) / Double(bounds.width) }
  var json: [String: Any] {
    ["id": String(id), "index": index, "name": "display \(index + 1)", "x": Double(bounds.origin.x), "y": Double(bounds.origin.y),
     "width": pixelWidth, "height": pixelHeight, "scale": scale, "primary": primary]
  }
}

func displays() -> [Display] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 16)
  var n: UInt32 = 0
  guard CGGetActiveDisplayList(16, &ids, &n) == .success else { return [] }
  let main = CGMainDisplayID()
  // screencapture -D numbers displays from 1 with the main display first.
  let ordered = ids[0..<Int(n)].sorted { a, b in a == main && b != main }
  return ordered.enumerated().map { i, id in
    let b = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    return Display(id: id, index: i, bounds: b, pixelWidth: mode?.pixelWidth ?? Int(b.width), pixelHeight: mode?.pixelHeight ?? Int(b.height), primary: id == main)
  }
}

func display(_ want: Any?) throws -> Display {
  let ds = displays()
  guard !ds.isEmpty else { throw Fail("no-session", "no active display") }
  guard let w = str(want), !w.isEmpty else { return ds.first(where: { $0.primary }) ?? ds[0] }
  if let d = ds.first(where: { String($0.id) == w || String($0.index) == w }) { return d }
  throw Fail("bad-args", "no display \(w) (have \(ds.map { String($0.id) }.joined(separator: ", ")))")
}

/** true when locked or the session is not on the console (fast user switching); nil when unknown. */
func isLocked() -> Bool? {
  guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
  if (d["CGSSessionScreenIsLocked"] as? Bool) == true { return true }
  if let on = d[kCGSessionOnConsoleKey as String] as? Bool, !on { return true }
  return false
}

func lockedValue() -> Any {
  if let l = isLocked() { return l }
  return NSNull()
}

/**
 * Screen Recording as of now. A running process keeps the answer it got at launch, so when that was "no" a fresh
 * child (`rigs-control --preflight`, same responsible process) asks again: a grant made in System Settings then
 * works at once, without restarting the helper. screencapture is a child too, so it sees the new grant.
 */
func screenAccess() -> Bool {
  if CGPreflightScreenCaptureAccess() { return true }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
  p.arguments = ["--preflight"]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  guard (try? p.run()) != nil else { return false }
  p.waitUntilExit()
  return p.terminationStatus == 0
}

func grants() -> [String: Any] {
  ["screen": screenAccess(), "ax": AXIsProcessTrusted(), "post": CGPreflightPostEventAccess(), "listen": CGPreflightListenEventAccess()]
}

// ------------------------------------------------------------------------- windows

func windowInfos(_ options: CGWindowListOption, _ relativeTo: CGWindowID = kCGNullWindowID) -> [[String: Any]] {
  (CGWindowListCopyWindowInfo(options, relativeTo) as? [[String: Any]]) ?? []
}

func bounds(of w: [String: Any]) -> CGRect? {
  guard let b = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: b as CFDictionary)
}

func displayFor(_ r: CGRect, _ ds: [Display]) -> Display? {
  ds.first(where: { $0.bounds.contains(CGPoint(x: r.midX, y: r.midY)) })
}

func listWindows() -> [[String: Any]] {
  let front = onMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
  let ds = displays()
  var focusedSeen = false
  var out: [[String: Any]] = []
  // Front to back; layer 0 is ordinary application windows (menu bar, Dock and overlays are other layers).
  for w in windowInfos([.optionOnScreenOnly, .excludeDesktopElements]) {
    guard (w[kCGWindowLayer as String] as? Int) == 0, let id = w[kCGWindowNumber as String] as? Int,
          let pid = w[kCGWindowOwnerPID as String] as? Int, let r = bounds(of: w), r.width > 1, r.height > 1 else { continue }
    if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
    let focused = !focusedSeen && front != nil && pid == Int(front!)
    if focused { focusedSeen = true }
    out.append(["id": String(id), "title": (w[kCGWindowName as String] as? String) ?? "", "app": (w[kCGWindowOwnerName as String] as? String) ?? "",
                "pid": pid, "display": displayFor(r, ds).map { String($0.id) } ?? NSNull(), "bounds": rectDict(r),
                "focused": focused, "minimized": false])
  }
  return out
}

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

func axValue(_ e: AXUIElement, _ attr: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success ? v : nil
}

func focusWindow(_ wid: CGWindowID) throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw Fail("needs-permission", "RIGS Control needs Accessibility to focus windows") }
  guard let info = windowInfos(.optionIncludingWindow, wid).first, let pid = info[kCGWindowOwnerPID as String] as? Int32 else {
    throw Fail("bad-args", "no window \(wid)")
  }
  let app = AXUIElementCreateApplication(pid)
  let wins = (axValue(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var match = wins.first { w in var id: CGWindowID = 0; return _AXUIElementGetWindow(w, &id) == .success && id == wid }
  if match == nil, let title = info[kCGWindowName as String] as? String, !title.isEmpty {
    match = wins.first { (axValue($0, kAXTitleAttribute) as? String) == title }
  }
  guard let win = match else { throw Fail("bad-args", "window \(wid) is not reachable through Accessibility (minimized or another Space?)") }
  AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
  AXUIElementPerformAction(win, kAXRaiseAction as CFString)
  // AX frontmost works for a background (LSUIElement) app, where NSRunningApplication.activate may be refused.
  AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  onMain { _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps]) }
  return ["windowId": String(wid), "pid": Int(pid)]
}

// ------------------------------------------------------------------------- capture

func runTool(_ path: String, _ args: [String], timeout: TimeInterval = 8) throws {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  let err = Pipe()
  p.standardError = err
  p.standardOutput = FileHandle.nullDevice
  try p.run()
  let deadline = Date().addingTimeInterval(timeout)
  while p.isRunning && Date() < deadline { usleep(20000) }
  if p.isRunning { p.terminate(); throw Fail("timeout", "\(path) did not finish in \(Int(timeout)) s") }
  if p.terminationStatus != 0 {
    let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    throw Fail("error", "\(path) failed (\(p.terminationStatus)): \(msg.trimmingCharacters(in: .whitespacesAndNewlines))")
  }
}

func loadImage(_ path: String) throws -> CGImage {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    throw Fail("error", "screencapture produced no image")
  }
  return img
}

func scaled(_ img: CGImage, width: Int) throws -> CGImage {
  let height = max(1, Int((Double(img.height) * Double(width) / Double(img.width)).rounded()))
  guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Fail("error", "cannot scale image") }
  ctx.interpolationQuality = .high
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
  guard let out = ctx.makeImage() else { throw Fail("error", "cannot scale image") }
  return out
}

func write(_ img: CGImage, to path: String, jpeg: Bool, quality: Double) throws {
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, (jpeg ? "public.jpeg" : "public.png") as CFString, 1, nil) else {
    throw Fail("error", "cannot create \(path)")
  }
  CGImageDestinationAddImage(dest, img, jpeg ? [kCGImageDestinationLossyCompressionQuality: quality / 100] as CFDictionary : nil)
  guard CGImageDestinationFinalize(dest) else { throw Fail("error", "cannot write \(path)") }
  chmod(path, 0o600)
}

func shot(_ a: [String: Any]) throws -> [String: Any] {
  guard screenAccess() else {
    throw Fail("needs-permission", "RIGS Control needs Screen Recording (System Settings > Privacy & Security > Screen Recording)")
  }
  // Only the daemon-allocated private shots folder: a confused caller cannot make the helper write elsewhere.
  guard let file = a["file"] as? String, file.hasPrefix(shotsDir), !file.contains("/../") else { throw Fail("bad-args", "file must be in \(shotsDir)") }
  let jpeg = (a["format"] as? String) == "jpeg"
  let src = file + ".src.png"
  defer { unlink(src) }
  var d: Display
  var region: CGRect?
  if let wid = str(a["window"]) {
    guard let id = UInt32(wid), let info = windowInfos(.optionIncludingWindow, id).first, let r = bounds(of: info) else { throw Fail("bad-args", "no visible window with that id") }
    let ds = displays()
    guard let on = ds.first(where: { $0.bounds.contains(r) }) else { throw Fail("unsupported", "window spans displays; capture a display or region") }
    d = on
    try runTool("/usr/sbin/screencapture", ["-x", "-o", "-t", "png", "-l", wid, src])
    region = CGRect(x: ((r.minX - on.bounds.minX) * CGFloat(on.scale)).rounded(), y: ((r.minY - on.bounds.minY) * CGFloat(on.scale)).rounded(), width: 0, height: 0)
  } else {
    d = try display(a["display"])
    try runTool("/usr/sbin/screencapture", ["-x", "-t", "png", "-D", String(d.index + 1), src])
  }
  var img = try loadImage(src)
  let sourceWidth = img.width, sourceHeight = img.height
  if region != nil {
    region!.size = CGSize(width: img.width, height: img.height)
  } else if let r = a["region"] as? [String: Any] {
    guard let x = num(r["x"]), let y = num(r["y"]), let w = num(r["width"]), let h = num(r["height"]) else { throw Fail("bad-args", "region needs x, y, width, height") }
    let rect = CGRect(x: x, y: y, width: w, height: h)
    guard CGRect(x: 0, y: 0, width: img.width, height: img.height).contains(rect) else { throw Fail("bad-args", "region is outside the display") }
    guard let c = img.cropping(to: rect) else { throw Fail("error", "cannot crop") }
    img = c
    region = rect
  }
  if let mw = num(a["maxWidth"]), Int(mw) > 0, Int(mw) < img.width { img = try scaled(img, width: Int(mw)) }
  try write(img, to: file, jpeg: jpeg, quality: num(a["quality"]) ?? 80)
  return ["file": file, "width": img.width, "height": img.height, "display": String(d.id), "sourceWidth": region == nil ? sourceWidth : Int(region!.width),
          "sourceHeight": region == nil ? sourceHeight : Int(region!.height), "region": region.map { rectDict($0) } ?? NSNull()]
}

// ------------------------------------------------------------------------- input

let NAMED: [String: CGKeyCode] = [
  "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "capslock": 57, "insert": 114,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
]
let MODIFIERS: [String: (CGKeyCode, CGEventFlags)] = [
  "ctrl": (59, .maskControl), "alt": (58, .maskAlternate), "shift": (56, .maskShift), "super": (55, .maskCommand),
]

/** Character → (key code, needs shift) on the active keyboard layout, so shortcuts like cmd+a hit the right key. */
func layoutMap() -> [String: (CGKeyCode, Bool)] {
  onMain {
    var map: [String: (CGKeyCode, Bool)] = [:]
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return map }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
      guard let layout = buf.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
      for shift in [false, true] {
        for code in 0..<128 {
          var dead: UInt32 = 0
          var chars = [UniChar](repeating: 0, count: 4)
          var len = 0
          let mods: UInt32 = shift ? UInt32(shiftKey >> 8) & 0xFF : 0
          let r = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), mods, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, 4, &len, &chars)
          if r == noErr && len > 0 {
            let s = String(utf16CodeUnits: chars, count: len)
            if map[s] == nil { map[s] = (CGKeyCode(code), shift) }
          }
        }
      }
    }
    return map
  }
}

final class Input {
  let source = CGEventSource(stateID: .hidSystemState)
  var heldButtons = Set<String>()
  var heldKeys: [CGKeyCode] = []
  var modifiers: CGEventFlags = []
  var layout: [String: (CGKeyCode, Bool)]?
  var lastClick: (button: String, at: Date, pos: CGPoint, count: Int64)?

  func requireAccess() throws {
    guard AXIsProcessTrusted() else { throw Fail("needs-permission", "RIGS Control needs Accessibility to send input (System Settings > Privacy & Security > Accessibility)") }
  }

  func post(_ e: CGEvent?) throws {
    guard let e = e else { throw Fail("error", "cannot create the input event") }
    e.post(tap: .cghidEventTap)
  }

  var location: CGPoint { CGEvent(source: nil)?.location ?? .zero }

  func move(_ a: [String: Any]) throws -> [String: Any] {
    try requireAccess()
    guard let x = num(a["x"]), let y = num(a["y"]) else { throw Fail("bad-args", "move needs x and y") }
    let d = try display(a["display"])
    guard x >= 0, y >= 0, x < Double(d.pixelWidth), y < Double(d.pixelHeight) else { throw Fail("bad-args", "point is outside the display") }
    // Public coordinates are display pixels; Quartz events take global points.
    let p = CGPoint(x: Double(d.bounds.minX) + x / d.scale, y: Double(d.bounds.minY) + y / d.scale)
    let held = heldButtons.contains("left") ? CGEventType.leftMouseDragged : heldButtons.contains("right") ? .rightMouseDragged : heldButtons.contains("middle") ? .otherMouseDragged : .mouseMoved
    let button: CGMouseButton = heldButtons.contains("right") ? .right : heldButtons.contains("middle") ? .center : .left
    try post(CGEvent(mouseEventSource: source, mouseType: held, mouseCursorPosition: p, mouseButton: button))
    return ["x": x, "y": y, "display": String(d.id)]
  }

  func button(_ name: String, down: Bool) throws {
    try requireAccess()
    let types: [String: (CGEventType, CGEventType, CGMouseButton)] = [
      "left": (.leftMouseDown, .leftMouseUp, .left), "right": (.rightMouseDown, .rightMouseUp, .right), "middle": (.otherMouseDown, .otherMouseUp, .center),
    ]
    guard let t = types[name] else { throw Fail("bad-args", "unknown button \(name)") }
    let pos = location
    var count: Int64 = 1
    if down {
      // Consecutive clicks at the same place within the double-click interval form a double/triple click.
      if let l = lastClick, l.button == name, Date().timeIntervalSince(l.at) < NSEvent.doubleClickInterval, abs(l.pos.x - pos.x) < 4, abs(l.pos.y - pos.y) < 4 { count = min(l.count + 1, 3) }
      lastClick = (name, Date(), pos, count)
    } else if let l = lastClick, l.button == name { count = l.count }
    let e = CGEvent(mouseEventSource: source, mouseType: down ? t.0 : t.1, mouseCursorPosition: pos, mouseButton: t.2)
    e?.setIntegerValueField(.mouseEventClickState, value: count)
    try post(e)
    if down { heldButtons.insert(name) } else { heldButtons.remove(name) }
  }

  func scroll(dx: Int32, dy: Int32) throws {
    try requireAccess()
    // Positive dy scrolls down like the Linux/Windows helpers; Quartz's positive wheel1 scrolls up.
    try post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0))
  }

  func key(_ name: String, down: Bool) throws {
    try requireAccess()
    if let (code, flag) = MODIFIERS[name] {
      if down { modifiers.insert(flag) } else { modifiers.remove(flag) }
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      e?.type = .flagsChanged
      e?.flags = modifiers
      try post(e)
      if down { heldKeys.append(code) } else { heldKeys.removeAll { $0 == code } }
      return
    }
    var code = NAMED[name]
    var shift = false
    if code == nil && name.count == 1 {
      if layout == nil { layout = layoutMap() }
      if let k = layout?[name] { code = k.0; shift = k.1 }
    }
    let e: CGEvent?
    if let c = code {
      e = CGEvent(keyboardEventSource: source, virtualKey: c, keyDown: down)
      e?.flags = shift ? modifiers.union(.maskShift) : modifiers
    } else if name.count == 1 {
      // Not on this layout: deliver the character itself (fine for typing, not for shortcuts).
      e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      let u = Array(name.utf16)
      e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
      e?.flags = modifiers
    } else {
      throw Fail("unsupported", "macOS has no \(name) key")
    }
    try post(e)
    let c = code ?? 0
    if down { heldKeys.append(c) } else if let i = heldKeys.lastIndex(of: c) { heldKeys.remove(at: i) }
  }

  func type(_ text: String, delayMs: Double) throws -> [String: Any] {
    try requireAccess()
    var n = 0
    for ch in text {
      if ch == "\n" || ch == "\r\n" || ch == "\t" {
        let code: CGKeyCode = ch == "\t" ? 48 : 36
        for down in [true, false] {
          let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
          e?.flags = []
          try post(e)
        }
      } else {
        // The Unicode string carries the character, so any script or emoji types as-is on any layout.
        let u = Array(String(ch).utf16)
        for down in [true, false] {
          let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
          e?.flags = []
          e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
          try post(e)
        }
      }
      n += 1
      usleep(useconds_t(max(4, delayMs) * 1000))
    }
    return ["typed": n, "via": "unicode"]
  }

  /** Lets go of everything this helper holds: on stop, error, client disconnect and exit. */
  @discardableResult func release() -> Int {
    var released = 0
    let pos = location
    for b in heldButtons {
      let t: (CGEventType, CGMouseButton) = b == "right" ? (.rightMouseUp, .right) : b == "middle" ? (.otherMouseUp, .center) : (.leftMouseUp, .left)
      CGEvent(mouseEventSource: source, mouseType: t.0, mouseCursorPosition: pos, mouseButton: t.1)?.post(tap: .cghidEventTap)
      released += 1
    }
    heldButtons.removeAll()
    for code in heldKeys.reversed() {
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
      if MODIFIERS.values.contains(where: { $0.0 == code }) { e?.type = .flagsChanged }
      e?.flags = []
      e?.post(tap: .cghidEventTap)
      released += 1
    }
    heldKeys.removeAll()
    modifiers = []
    return released
  }
}

let input = Input()
let inputLock = NSLock()

// ------------------------------------------------------------------------- requests

func handle(_ op: String, _ a: [String: Any]) throws -> Any {
  switch op {
  case "hello":
    return ["pid": Int(getpid()), "version": VERSION]
  case "probe":
    let helper: [String: Any] = ["kind": "mac-helper", "version": VERSION, "running": true, "pid": Int(getpid()), "path": Bundle.main.bundlePath,
                                 "bundleId": Bundle.main.bundleIdentifier ?? ""]
    let out: [String: Any] = ["locked": lockedValue(), "displays": displays().map { $0.json }, "grants": grants(), "helper": helper]
    return out
  case "locked":
    return ["locked": lockedValue()]
  case "displays":
    return displays().map { $0.json }
  case "shot":
    return try shot(a)
  case "windows":
    return listWindows()
  case "focus":
    guard let s = str(a["windowId"]), let id = UInt32(s) else { throw Fail("bad-args", "windowId must be a macOS window number") }
    return try focusWindow(id)
  case "move":
    return try input.move(a)
  case "button":
    guard let down = a["down"] as? Bool else { throw Fail("bad-args", "button needs down") }
    try input.button((a["button"] as? String) ?? "left", down: down)
    return [:] as [String: Any]
  case "scroll":
    try input.scroll(dx: Int32(num(a["dx"]) ?? 0), dy: Int32(num(a["dy"]) ?? 0))
    return [:] as [String: Any]
  case "key":
    guard let k = a["key"] as? String, let down = a["down"] as? Bool else { throw Fail("bad-args", "key needs key and down") }
    try input.key(k, down: down)
    return [:] as [String: Any]
  case "type":
    guard let t = a["text"] as? String else { throw Fail("bad-args", "type needs text") }
    return try input.type(t, delayMs: num(a["delayMs"]) ?? 0)
  case "release", "stop":
    return ["released": input.release()]
  case "grant":
    // Shows the system prompt once and adds RIGS Control to the list; a person still flips the switch.
    let p = (a["permission"] as? String) ?? ""
    if p == "screenCapture" { return ["permission": p, "granted": onMain { CGRequestScreenCaptureAccess() }] }
    if p == "accessibility" || p == "input" {
      let ok = onMain { AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
      _ = CGRequestPostEventAccess()
      return ["permission": p, "granted": ok]
    }
    throw Fail("bad-args", "unknown permission \(p)")
  default:
    throw Fail("bad-args", "unknown op \(op)")
  }
}

// ------------------------------------------------------------------------- socket server

final class Client {
  let fd: Int32
  let writeLock = NSLock()
  var authenticated = false
  init(fd: Int32) { self.fd = fd }

  func send(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
    data.append(10)
    writeLock.lock(); defer { writeLock.unlock() }
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
      var off = 0
      while off < buf.count {
        let n = Darwin.write(fd, buf.baseAddress! + off, buf.count - off)
        if n <= 0 { if errno == EINTR { continue }; return }
        off += n
      }
    }
  }

  func run(token: String) {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    loop: while true {
      let n = read(fd, &chunk, chunk.count)
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { break }
      buffer.append(contentsOf: chunk[0..<n])
      while let nl = buffer.firstIndex(of: 10) {
        let line = buffer.subdata(in: buffer.startIndex..<nl)
        buffer.removeSubrange(buffer.startIndex...nl)
        guard let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
        let id = req["id"] ?? NSNull()
        // Constant-time compare; a wrong token ends the connection.
        let given = Array(((req["token"] as? String) ?? "").utf8), want = Array(token.utf8)
        var diff = given.count ^ want.count
        for i in 0..<min(given.count, want.count) { diff |= Int(given[i] ^ want[i]) }
        if diff != 0 {
          send(["id": id, "ok": false, "error": ["code": "not-allowed", "message": "bad control token"]])
          break loop
        }
        authenticated = true
        let op = (req["op"] as? String) ?? ""
        inputLock.lock()
        do {
          let result = try handle(op, req)
          inputLock.unlock()
          send(["id": id, "ok": true, "result": result])
        } catch let f as Fail {
          input.release()
          inputLock.unlock()
          send(["id": id, "ok": false, "error": ["code": f.code, "message": f.message]])
        } catch {
          input.release()
          inputLock.unlock()
          send(["id": id, "ok": false, "error": ["code": "error", "message": "\(error)"]])
        }
      }
    }
    // The daemon went away (crash, stop): never leave a key or button pressed.
    inputLock.lock(); input.release(); inputLock.unlock()
    clients.remove(self)
    close(fd)
  }
}

final class Clients {
  private var list: [Client] = []
  private let lock = NSLock()
  func add(_ c: Client) { lock.lock(); list.append(c); lock.unlock() }
  func remove(_ c: Client) { lock.lock(); list.removeAll { $0 === c }; lock.unlock() }
  func broadcast(_ obj: [String: Any]) { lock.lock(); let l = list; lock.unlock(); for c in l where c.authenticated { c.send(obj) } }
}
let clients = Clients()

func serve() throws {
  mkdir(home, 0o700)
  mkdir(runDir, 0o700)
  chmod(runDir, 0o700)
  var addr = sockaddr_un()
  let path = Array(sockPath.utf8)
  guard path.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw Fail("bad-args", "socket path is too long for macOS (\(path.count) bytes): \(sockPath)") }
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { throw Fail("error", "socket: \(String(cString: strerror(errno)))") }
  addr.sun_family = sa_family_t(AF_UNIX)
  addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  withUnsafeMutableBytes(of: &addr.sun_path) { p in for (i, b) in path.enumerated() { p[i] = b }; p[path.count] = 0 }
  unlink(sockPath)
  let old = umask(0o177)
  let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
  umask(old)
  guard bound == 0 else { throw Fail("error", "bind \(sockPath): \(String(cString: strerror(errno)))") }
  chmod(sockPath, 0o600)
  guard listen(fd, 8) == 0 else { throw Fail("error", "listen: \(String(cString: strerror(errno)))") }
  let token = randomToken()
  try writePrivate(tokenPath, token + "\n")
  log("RIGS Control \(VERSION) listening on \(sockPath) (pid \(getpid()))")
  Thread.detachNewThread {
    while true {
      let c = accept(fd, nil, nil)
      if c < 0 { if errno == EINTR || errno == ECONNABORTED { continue }; log("accept: \(String(cString: strerror(errno)))"); exit(1) }
      // Only this user's processes; the socket mode already says so, this is belt and braces.
      var uid: uid_t = 0, gid: gid_t = 0
      if getpeereid(c, &uid, &gid) != 0 || uid != getuid() { close(c); continue }
      var one: Int32 = 1
      setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
      let client = Client(fd: c)
      clients.add(client)
      Thread.detachNewThread { client.run(token: token) }
    }
  }
}

// ------------------------------------------------------------------------- kill hotkey ⌃⌥⌘⎋

var hotKeyRef: EventHotKeyRef?
func registerHotkey() {
  var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
  InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
    log("kill hotkey pressed")
    inputLock.lock(); input.release(); inputLock.unlock()
    clients.broadcast(["event": "hotkey", "reason": "⌃⌥⌘⎋ pressed on the Mac"])
    return noErr
  }, 1, &spec, nil, nil)
  // RegisterEventHotKey needs no Input Monitoring grant.
  let id = EventHotKeyID(signature: OSType(0x5249_4753), id: 1)  // 'RIGS'
  let r = RegisterEventHotKey(UInt32(kVK_Escape), UInt32(cmdKey | optionKey | controlKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
  if r != noErr { log("kill hotkey not registered (\(r))") }
}

// ------------------------------------------------------------------------- main

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler {
  inputLock.lock(); input.release(); inputLock.unlock()
  unlink(sockPath)
  exit(0)
}
term.resume()

if CommandLine.arguments.contains("--version") { print(VERSION); exit(0) }
if CommandLine.arguments.contains("--preflight") { exit(CGPreflightScreenCaptureAccess() ? 0 : 1) }
do { try serve() } catch let f as Fail { log("cannot start: \(f.message)"); exit(1) } catch { log("cannot start: \(error)"); exit(1) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
registerHotkey()
app.run()
