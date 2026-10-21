// RIGS Control: the macOS screen and input helper (docs/full-access.md §4, docs/control-implementation.md).
//
// Runs as its own LaunchAgent (dev.rigs.control), so it is its own TCC responsible process: Screen Recording
// and Accessibility are granted to "RIGS Control", never to the daemon's node. The daemon talks to it over
// RIGS_HOME/run/control.sock (0600) with JSON lines {id, op, token, ...args} → {id, ok, result | error}.
// The per-start token is written to RIGS_HOME/run/control.token (0600) and checked on every request.
//
// Kept compatible with Swift 5.6 / the macOS 12.3 SDK (the toolchain on macbookpro): capture spawns
// /usr/sbin/screencapture from this process (SCScreenshotManager needs the macOS 14 SDK), so the grant
// still belongs to the helper. App streaming (docs/app-streaming.md §3.6) uses ScreenCaptureKit's SCStream
// (macOS 12.3) and VideoToolbox in this process, under the same two grants.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import VideoToolbox

// 2: the appStream / appStreams ops (app streaming host).
let VERSION = "2"

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

/**
 * The app always lives in <home>/bin/RIGS Control.app. When macOS starts it on its own (System Settings
 * "Quit & Reopen" goes through LaunchServices, without --home), that location still names the right home,
 * so it can never serve another RIGS install's socket.
 */
func bundleHome() -> String? {
  let bundle = URL(fileURLWithPath: Bundle.main.bundlePath)
  guard bundle.pathExtension == "app", bundle.deletingLastPathComponent().lastPathComponent == "bin" else { return nil }
  return bundle.deletingLastPathComponent().deletingLastPathComponent().path
}

let home = argValue("--home") ?? bundleHome() ?? ProcessInfo.processInfo.environment["RIGS_HOME"] ?? (NSHomeDirectory() + "/.rigs")
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
    let started = stops.current
    var n = 0
    for ch in text {
      if stops.current != started { throw Fail("off", "stopped after \(n) characters") }
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

/**
 * Bumped by stop, the kill hotkey, SIGTERM and a driving client's disconnect, without waiting for inputLock:
 * typing in progress sees it and ends at the next character, instead of finishing its text first.
 */
final class Stops {
  private var n = 0
  private let lock = NSLock()
  func bump() { lock.lock(); n += 1; lock.unlock() }
  var current: Int { lock.lock(); defer { lock.unlock() }; return n }
}
let stops = Stops()
let INPUT_OPS: Set<String> = ["move", "button", "scroll", "key", "type"]

// ------------------------------------------------------------------------- app streaming (docs/app-streaming.md §3.6, §4.4)
//
// One streamed app = one AppSession here: the app's windows on the real desktop, captured with ScreenCaptureKit
// (SCContentFilter: that app on the display its window is on, cropped to the window), encoded with VideoToolbox H.264
// and served on its own socket RIGS_HOME/run/appstream/<sid>.sock with the Linux runner's protocol (u32 LE length +
// u8 type + body; type 1 JSON, type 2 a §5.3 media frame), so the daemon's hub, flow control and reattach work the
// same. The control op `appStream` starts a session (behind the daemon's full control gate); everything after that
// goes over the session socket. Sessions live in this LaunchAgent, so a daemon restart keeps them.

let appStreamDir = runDir + "/appstream/"

func monoUs() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000 }

extension Data {
  mutating func appendLE<T: FixedWidthInteger>(_ v: T) {
    var x = v.littleEndian
    Swift.withUnsafeBytes(of: &x) { append(contentsOf: $0) }
  }
}

func runnerMessage(_ type: UInt8, _ body: Data) -> Data {
  var d = Data(capacity: 5 + body.count)
  d.appendLE(UInt32(body.count)); d.append(type); d.append(body)
  return d
}

/** The 32-byte media frame header of §5.3 (little-endian), then the payload. */
func mediaFrame(kind: UInt8, flags: UInt8, seq: UInt32, captureUs: UInt64, encodeUs: UInt32, inputSeq: UInt32, width: Int, height: Int, payload: Data) -> Data {
  var d = Data(capacity: 32 + payload.count)
  d.append(kind); d.append(flags); d.appendLE(UInt16(32)); d.appendLE(seq); d.appendLE(captureUs); d.appendLE(encodeUs); d.appendLE(inputSeq)
  d.appendLE(UInt16(clamping: width)); d.appendLE(UInt16(clamping: height)); d.appendLE(UInt32(0))
  d.append(payload)
  return d
}

let FLAG_KEY: UInt8 = 1, FLAG_CONFIG: UInt8 = 2, FLAG_REPEAT: UInt8 = 8

/** VideoToolbox's length-prefixed sample → Annex-B, with SPS/PPS in front of a keyframe (what the Linux runner sends). */
func annexB(_ sb: CMSampleBuffer, key: Bool) -> Data? {
  guard let block = CMSampleBufferGetDataBuffer(sb), let fmt = CMSampleBufferGetFormatDescription(sb) else { return nil }
  let start: [UInt8] = [0, 0, 0, 1]
  var out = Data()
  var count = 0, nalLen: Int32 = 4
  _ = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLen)
  if key {
    for i in 0..<count {
      var p: UnsafePointer<UInt8>?
      var n = 0
      if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &n, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p = p {
        out.append(contentsOf: start); out.append(p, count: n)
      }
    }
  }
  let len = CMBlockBufferGetDataLength(block)
  var raw = Data(count: len)
  let st = raw.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: len, destination: $0.baseAddress!) }
  guard st == kCMBlockBufferNoErr else { return nil }
  let h = Int(nalLen)
  raw.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
    var off = 0
    while off + h <= len {
      var n = 0
      for i in 0..<h { n = (n << 8) | Int(b[off + i]) }
      off += h
      guard n > 0, off + n <= len else { break }
      out.append(contentsOf: start)
      out.append(b.baseAddress!.advanced(by: off).assumingMemoryBound(to: UInt8.self), count: n)
      off += n
    }
  }
  return out
}

func isKeyframe(_ sb: CMSampleBuffer) -> Bool {
  guard let list = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]], let a = list.first else { return true }
  return !((a[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
}

/** H.264 for one size: hardware, low-latency rate control, no B-frames, keyframes only on request (§4.4). */
final class H264Encoder {
  let width: Int, height: Int
  let session: VTCompressionSession
  let hw: Bool
  let lowLatency: Bool

  init(width: Int, height: Int, fps: Int, kbps: Int) throws {
    self.width = width; self.height = height
    let specs: [[CFString: Any]] = [
      [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true, kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true],
      [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true],
      [:],
    ]
    var made: (VTCompressionSession, Int)?
    var status: OSStatus = -1
    for (i, spec) in specs.enumerated() {
      var s: VTCompressionSession?
      status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264, encoderSpecification: spec as CFDictionary,
                                          imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s)
      if status == noErr, let s = s { made = (s, i); break }
    }
    guard let (s, which) = made else { throw Fail("unsupported", "VideoToolbox could not create an H.264 encoder for \(width)x\(height) (\(status))") }
    session = s
    lowLatency = which < 2
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    if VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel) != noErr {
      VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
    }
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: 0))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 0))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
    // The low-latency encoder (…h264.rtvc) does not answer this property (-12900): then the hardware requirement of
    // the specification it was created with decides.
    var used: CFTypeRef?
    let asked = VTSessionCopyProperty(s, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, allocator: nil, valueOut: &used)
    hw = asked == noErr ? (used as? NSNumber)?.boolValue ?? false : which == 0
    setBitrate(kbps)
    VTCompressionSessionPrepareToEncodeFrames(s)
  }

  func setBitrate(_ kbps: Int) {
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: kbps * 1000))
    // At most 1.5× the average in any one second, so a burst cannot flood the viewer's queue.
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: [kbps * 1000 / 8 * 3 / 2, 1] as CFArray)
  }

  func encode(_ pb: CVPixelBuffer, ptsUs: UInt64, forceKey: Bool, done: @escaping (CMSampleBuffer?) -> Void) -> Bool {
    let props: CFDictionary? = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let st = VTCompressionSessionEncodeFrame(session, imageBuffer: pb, presentationTimeStamp: CMTime(value: CMTimeValue(ptsUs), timescale: 1_000_000),
                                             duration: .invalid, frameProperties: props, infoFlagsOut: nil) { status, _, sb in done(status == noErr ? sb : nil) }
    return st == noErr
  }

  func close() {
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    VTCompressionSessionInvalidate(session)
  }
}

/** The app's ordinary windows on screen (layer 0), front to back, in global points. Needs no grant (no titles). */
func appWindows(_ pid: pid_t) -> [(id: CGWindowID, frame: CGRect)] {
  windowInfos([.optionOnScreenOnly, .excludeDesktopElements]).compactMap { w in
    guard (w[kCGWindowLayer as String] as? Int) == 0, (w[kCGWindowOwnerPID as String] as? Int) == Int(pid), let id = w[kCGWindowNumber as String] as? Int,
          let r = bounds(of: w), r.width > 1, r.height > 1 else { return nil }
    if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0 { return nil }
    return (CGWindowID(id), r)
  }
}

func axWindow(_ pid: pid_t, _ wid: CGWindowID) -> AXUIElement? {
  let wins = (axValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
  return wins.first { w in var id: CGWindowID = 0; return _AXUIElementGetWindow(w, &id) == .success && id == wid }
}

/** Fit a capture of `points` at `scale` px/pt into max × max, even sides, at least 16 px. */
func captureSize(_ points: CGSize, scale: Double, maxWidth: Int, maxHeight: Int) -> (Int, Int) {
  var w = Double(points.width) * scale, h = Double(points.height) * scale
  let s = min(1, Double(maxWidth) / w, Double(maxHeight) / h)
  w = (w * s).rounded(.down); h = (h * s).rounded(.down)
  return (max(16, Int(w) - Int(w) % 2), max(16, Int(h) - Int(h) % 2))
}

/** KeyboardEvent.code → mask for the macOS modifier keys (the daemon sends virtual key codes, CODE_TO_MAC). */
let MAC_MODIFIERS: [CGKeyCode: CGEventFlags] = [55: .maskCommand, 54: .maskCommand, 56: .maskShift, 60: .maskShift, 58: .maskAlternate, 61: .maskAlternate,
                                                59: .maskControl, 62: .maskControl, 57: .maskAlphaShift, 63: .maskSecondaryFn]

final class AppSession: NSObject, SCStreamOutput, SCStreamDelegate {
  let sid: String
  let sockPath: String
  let pid: pid_t
  let name: String
  let bundleId: String
  let launched: Bool
  /** Everything below runs on q: socket messages, capture output, the window watch, input. */
  let q: DispatchQueue
  private var listenFd: Int32 = -1
  private var client: Int32 = -1
  private let writeLock = NSLock()
  private var ended = false
  private var lostClientAt: Date? = Date()

  // stream
  private var scStream: SCStream?
  /** idle → (waiting for a window) → starting → live; a failure goes back to idle with an error to the daemon. */
  private enum Phase { case idle, waiting, starting, live }
  private var phase = Phase.idle
  private var fps = 60, kbps = 8000, transport = "h264", maxWidth = 3840, maxHeight = 2160
  private var encoder: H264Encoder?
  private var targetWindow: CGWindowID = 0
  private var winFrame = CGRect.zero         // the target window, global points
  private var capRect = CGRect.zero          // what is captured (window ∩ its display), global points
  private var displayId: CGDirectDisplayID = 0
  private var outW = 0, outH = 0
  private var seq: UInt32 = 0
  private var skip = false
  private var forceKey = true
  private var lastPB: CVPixelBuffer?
  private var lastFrameAt = Date.distantPast
  private var lastJpegAt = Date.distantPast
  private var lastPts: UInt64 = 0
  private var stats = (frames: 0, bytes: 0, skipped: 0, enc: [Double](), since: Date())
  private let statsLock = NSLock()
  private var watch: DispatchSourceTimer?
  private var tick = 0

  // input
  private let src = CGEventSource(stateID: .hidSystemState)
  private var inputSeq: UInt32 = 0
  private var modifiers: CGEventFlags = []
  private var heldKeys: [CGKeyCode] = []
  private var heldButtons = Set<Int>()
  private var lastClick: (button: Int, at: Date, pos: CGPoint, count: Int64)?
  private var warnedInput = false
  private var clipboardSeen = 0

  init(sid: String, sockPath: String, pid: pid_t, name: String, bundleId: String, launched: Bool) {
    self.sid = sid; self.sockPath = sockPath; self.pid = pid; self.name = name; self.bundleId = bundleId; self.launched = launched
    q = DispatchQueue(label: "dev.rigs.appstream.\(sid)")
    super.init()
    clipboardSeen = onMain { NSPasteboard.general.changeCount }
  }

  var json: [String: Any] {
    ["sid": sid, "pid": Int(pid), "name": name, "bundleId": bundleId, "launched": launched, "socket": sockPath, "streaming": phase == .live, "connected": client >= 0]
  }

  // ---- socket

  func listen() throws {
    mkdir(appStreamDir, 0o700)
    chmod(appStreamDir, 0o700)
    var addr = sockaddr_un()
    let path = Array(sockPath.utf8)
    guard path.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw Fail("bad-args", "socket path is too long for macOS: \(sockPath)") }
    addr.sun_family = sa_family_t(AF_UNIX)
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &addr.sun_path) { p in for (i, b) in path.enumerated() { p[i] = b }; p[path.count] = 0 }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Fail("error", "socket: \(String(cString: strerror(errno)))") }
    unlink(sockPath)
    let old = umask(0o177)
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    umask(old)
    guard bound == 0, Darwin.listen(fd, 2) == 0 else { close(fd); throw Fail("error", "bind \(sockPath): \(String(cString: strerror(errno)))") }
    chmod(sockPath, 0o600)
    listenFd = fd
    Thread.detachNewThread { [weak self] in
      while true {
        let c = accept(fd, nil, nil)
        guard let self = self else { close(c); return }
        if c < 0 { if errno == EINTR || errno == ECONNABORTED { continue }; return }
        var uid: uid_t = 0, gid: gid_t = 0
        if getpeereid(c, &uid, &gid) != 0 || uid != getuid() { close(c); continue }
        var one: Int32 = 1
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        self.q.async { self.adopt(c) }
      }
    }
    startWatch()
  }

  /** A daemon connected (first start, or a reattach after its restart): it replaces any earlier connection. */
  private func adopt(_ c: Int32) {
    if ended { close(c); return }
    if client >= 0 { stopStream(); shutdown(client, SHUT_RDWR); close(client) }
    client = c
    lostClientAt = nil
    sendJSON(["ev": "ready", "compositor": "screencapturekit", "display": String(displayId), "width": outW, "height": outH,
              "app": ["pid": Int(pid), "name": name, "bundleId": bundleId, "launched": launched]])
    Thread.detachNewThread { [weak self] in self?.readLoop(c) }
  }

  private func readLoop(_ c: Int32) {
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(c, &chunk, chunk.count)
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { break }
      buf.append(contentsOf: chunk[0..<n])
      while buf.count >= 5 {
        let len = Int(buf[buf.startIndex]) | Int(buf[buf.startIndex + 1]) << 8 | Int(buf[buf.startIndex + 2]) << 16 | Int(buf[buf.startIndex + 3]) << 24
        guard len <= 8 * 1024 * 1024 else { shutdown(c, SHUT_RDWR); return }
        guard buf.count >= 5 + len else { break }
        let type = buf[buf.startIndex + 4]
        let body = buf.subdata(in: (buf.startIndex + 5)..<(buf.startIndex + 5 + len))
        buf.removeSubrange(buf.startIndex..<(buf.startIndex + 5 + len))
        if type == 1, let m = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] { q.async { self.onMessage(m) } }
      }
    }
    q.async {
      guard self.client == c else { return }
      close(c)
      self.client = -1
      self.lostClientAt = Date()
      // The daemon went away (restart or crash): nothing may stay pressed, and nobody is watching.
      self.releaseInput()
      self.stopStream()
    }
  }

  private func write(_ d: Data) -> Bool {
    writeLock.lock(); defer { writeLock.unlock() }
    let c = client
    guard c >= 0 else { return false }
    return d.withUnsafeBytes { (b: UnsafeRawBufferPointer) -> Bool in
      var off = 0
      while off < b.count {
        let n = Darwin.write(c, b.baseAddress! + off, b.count - off)
        if n <= 0 { if errno == EINTR { continue }; return false }
        off += n
      }
      return true
    }
  }

  func sendJSON(_ o: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: o, options: []) else { return }
    _ = write(runnerMessage(1, body))
  }

  private func fail(_ code: String, _ message: String) { sendJSON(["ev": "error", "code": code, "message": message]) }
  /** A capture that cannot go on: back to idle, and the daemon tells the viewers. */
  private func failStream(_ code: String, _ message: String) { stopStream(); fail(code, message) }

  // ---- messages from the daemon (the Linux runner's ops, docs/app-streaming.md §7)

  private func onMessage(_ m: [String: Any]) {
    if ended { return }
    switch (m["op"] as? String) ?? "" {
    case "start-stream":
      fps = max(5, min(120, Int(num(m["fps"]) ?? 60)))
      kbps = max(500, Int(num(m["bitrateKbps"]) ?? 8000))
      transport = (m["transport"] as? String) == "jpeg" ? "jpeg" : "h264"
      maxWidth = max(320, Int(num(m["maxWidth"]) ?? 3840))
      maxHeight = max(240, Int(num(m["maxHeight"]) ?? 2160))
      startStream()
    case "stop-stream": stopStream(); releaseInput()
    case "keyframe": requestKeyframe()
    case "bitrate":
      if let k = num(m["kbps"]) { kbps = max(500, Int(k)); encoder?.setBitrate(kbps) }
    case "skip": skip = (m["on"] as? Bool) ?? false
    case "input":
      if let e = m["e"] as? [[String: Any]] { applyInput(e) }
      if let s = num(m["seq"]) { inputSeq = UInt32(clamping: Int(s)) }
    case "release-all": releaseInput()
    case "resize": resize(width: num(m["width"]) ?? 0, height: num(m["height"]) ?? 0)
    case "clipboard-set":
      if let t = m["text"] as? String {
        clipboardSeen = onMain { () -> Int in
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(t, forType: .string)
          return NSPasteboard.general.changeCount
        }
      }
    case "stop": stop(force: (m["force"] as? Bool) ?? false)
    default: break
    }
  }

  // ---- capture

  /** The window to stream: the current one while it is on screen, else the app's front window. */
  private func pickWindow() -> (id: CGWindowID, frame: CGRect)? {
    let wins = appWindows(pid)
    return wins.first(where: { $0.id == targetWindow }) ?? wins.first
  }

  private func geometry(_ frame: CGRect) -> (rect: CGRect, display: Display, w: Int, h: Int)? {
    let ds = displays()
    guard let d = ds.first(where: { $0.bounds.contains(CGPoint(x: frame.midX, y: frame.midY)) }) ?? ds.first(where: { $0.bounds.intersects(frame) }) else { return nil }
    let rect = frame.intersection(d.bounds)
    guard rect.width >= 8, rect.height >= 8 else { return nil }
    let (w, h) = captureSize(rect.size, scale: d.scale, maxWidth: maxWidth, maxHeight: maxHeight)
    return (rect, d, w, h)
  }

  private func configuration(_ g: (rect: CGRect, display: Display, w: Int, h: Int)) -> SCStreamConfiguration {
    let c = SCStreamConfiguration()
    c.width = g.w
    c.height = g.h
    c.sourceRect = CGRect(x: g.rect.minX - g.display.bounds.minX, y: g.rect.minY - g.display.bounds.minY, width: g.rect.width, height: g.rect.height)
    c.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    c.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
    c.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    c.queueDepth = 5
    c.showsCursor = true
    return c
  }

  private func startStream() {
    stopStream()
    guard screenAccess() else {
      return fail("needs-permission", "RIGS Control needs Screen Recording to stream \(name) (System Settings > Privacy & Security > Screen Recording)")
    }
    guard let win = pickWindow() else {
      // Launching, or every window is closed or minimized: the watch starts the stream when one appears.
      phase = .waiting
      return fail("no-window", "\(name) has no window on screen yet")
    }
    guard let g = geometry(win.frame) else { return fail("stream-failed", "\(name)'s window is not on a display") }
    targetWindow = win.id; winFrame = win.frame; capRect = g.rect; displayId = g.display.id; outW = g.w; outH = g.h
    phase = .starting
    let generation = UUID()
    streamGeneration = generation
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
      self.q.async {
        guard self.streamGeneration == generation else { return }
        guard let content = content else {
          let denied = (error as NSError?)?.code == -3801  // SCStreamErrorUserDeclined
          return self.failStream(denied ? "needs-permission" : "stream-failed", denied ? "Screen Recording was declined for RIGS Control" : "ScreenCaptureKit: \(error?.localizedDescription ?? "no shareable content")")
        }
        guard let app = content.applications.first(where: { $0.processID == self.pid }), let display = content.displays.first(where: { $0.displayID == self.displayId }) else {
          return self.failStream("stream-failed", "ScreenCaptureKit does not list \(self.name) on display \(self.displayId)")
        }
        let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        let s = SCStream(filter: filter, configuration: self.configuration(g), delegate: self)
        do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.q) } catch { return self.failStream("stream-failed", "ScreenCaptureKit: \(error.localizedDescription)") }
        do { try self.makeEncoder(width: g.w, height: g.h) } catch let f as Fail { return self.failStream(f.code, f.message) } catch { return self.failStream("stream-failed", "\(error)") }
        self.scStream = s
        s.startCapture { err in
          self.q.async {
            guard self.streamGeneration == generation else { return }
            if let err = err {
              let denied = (err as NSError).code == -3801
              return self.failStream(denied ? "needs-permission" : "stream-failed", denied ? "Screen Recording was declined for RIGS Control" : "ScreenCaptureKit could not start: \(err.localizedDescription)")
            }
            self.phase = .live
            self.announceStream()
          }
        }
      }
    }
  }
  private var streamGeneration = UUID()

  private func makeEncoder(width: Int, height: Int) throws {
    encoder?.close()
    encoder = nil
    if transport == "h264" { encoder = try H264Encoder(width: width, height: height, fps: fps, kbps: kbps) }
    outW = width; outH = height
    forceKey = true
  }

  private func announceStream() {
    let hw = encoder?.hw ?? false
    let enc: [String: Any] = transport == "jpeg" ? ["name": "jpeg", "hw": false, "path": "sck"] : ["name": "h264_videotoolbox", "hw": hw, "path": encoder?.lowLatency == true ? "sck-lowlatency" : "sck"]
    sendJSON(["ev": "stream", "encoder": enc, "width": outW, "height": outH, "fps": fps, "fallback": transport == "h264" && !hw,
              "fallbackReason": hw ? NSNull() : "the hardware H.264 encoder is not available" as Any])
    log("appstream \(sid): streaming \(name) \(outW)x\(outH)@\(fps) with \(enc["name"]!)\(hw ? " (hw)" : "")")
  }

  private func stopStream() {
    streamGeneration = UUID()
    phase = .idle
    if let s = scStream { scStream = nil; s.stopCapture { _ in } }
    encoder?.close()
    encoder = nil
    lastPB = nil
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    q.async {
      guard self.scStream === stream else { return }
      self.failStream("stream-failed", "ScreenCaptureKit stopped: \(error.localizedDescription)")
    }
  }

  /** Runs on q (the sample handler queue). */
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, scStream === stream, phase == .live, CMSampleBufferIsValid(sb), let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    if let list = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
       let raw = list.first?[.status] as? Int, let st = SCFrameStatus(rawValue: raw), st != .complete { return }
    let now = monoUs()
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    // SCK stamps frames on the host clock (mach_absolute_time, as the daemon's hrtime): use it when it is plausible.
    var captureUs = now
    if pts.isValid { let us = UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000); if us <= now && now - us < 1_000_000 { captureUs = us } }
    lastPB = pb
    lastFrameAt = Date()
    if skip { statsLock.lock(); stats.skipped += 1; statsLock.unlock(); return }
    submit(pb, captureUs: captureUs, repeatFrame: false)
  }

  private func submit(_ pb: CVPixelBuffer, captureUs: UInt64, repeatFrame: Bool) {
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    if transport == "jpeg" { return submitJpeg(pb, captureUs: captureUs, width: w, height: h) }
    if encoder == nil || encoder!.width != w || encoder!.height != h {
      // The capture changed size (window resized): a new encoder, and the viewers get meta + a fresh IDR.
      do { try makeEncoder(width: w, height: h) } catch let f as Fail { return fail(f.code, f.message) } catch { return }
      sendJSON(["ev": "meta", "width": w, "height": h])
    }
    guard let enc = encoder else { return }
    let key = forceKey
    forceKey = false
    let myInput = inputSeq, started = monoUs()
    var pts = captureUs
    if pts <= lastPts { pts = lastPts + 1 }
    lastPts = pts
    let ok = enc.encode(pb, ptsUs: pts, forceKey: key) { [weak self] sb in
      guard let self = self, let sb = sb else { return }
      let isKey = isKeyframe(sb)
      guard let au = annexB(sb, key: isKey) else { return }
      let encUs = UInt32(clamping: monoUs() - started)
      let flags: UInt8 = (isKey ? FLAG_KEY | FLAG_CONFIG : 0) | (repeatFrame ? FLAG_REPEAT : 0)
      // Numbered as they leave the encoder (outputs come in order): a frame the rate control dropped leaves no gap,
      // which the viewer would take for a lost frame and answer with a keyframe request.
      self.statsLock.lock(); self.seq &+= 1; let mySeq = self.seq; self.statsLock.unlock()
      _ = self.write(runnerMessage(2, mediaFrame(kind: 1, flags: flags, seq: mySeq, captureUs: captureUs, encodeUs: encUs, inputSeq: myInput, width: w, height: h, payload: au)))
      self.statsLock.lock(); self.stats.frames += 1; self.stats.bytes += au.count; self.stats.enc.append(Double(encUs) / 1000); self.statsLock.unlock()
    }
    if !ok { forceKey = true }
  }

  private func submitJpeg(_ pb: CVPixelBuffer, captureUs: UInt64, width: Int, height: Int) {
    guard Date().timeIntervalSince(lastJpegAt) >= 1.0 / Double(min(fps, 15)) || forceKey else { return }
    lastJpegAt = Date()
    forceKey = false
    let started = monoUs()
    var img: CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(pb, options: nil, imageOut: &img) == noErr, let image = img else { return }
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return }
    statsLock.lock(); seq &+= 1; let mySeq = seq; statsLock.unlock()
    let jpg = out as Data
    _ = write(runnerMessage(2, mediaFrame(kind: 3, flags: FLAG_KEY, seq: mySeq, captureUs: captureUs, encodeUs: UInt32(clamping: monoUs() - started), inputSeq: inputSeq, width: width, height: height, payload: jpg)))
    statsLock.lock(); stats.frames += 1; stats.bytes += jpg.count; statsLock.unlock()
  }

  /** An IDR now: the next captured frame, or the last one again when the window is idle (SCK sends nothing then). */
  private func requestKeyframe() {
    forceKey = true
    q.asyncAfter(deadline: .now() + 0.12) {
      guard self.forceKey, self.phase == .live, let pb = self.lastPB, Date().timeIntervalSince(self.lastFrameAt) >= 0.1 else { return }
      self.submit(pb, captureUs: monoUs(), repeatFrame: true)
    }
  }

  /** Every 250 ms: follow the window (move, resize, another display), notice the app quitting, clipboard, stats. */
  private func startWatch() {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + 0.25, repeating: 0.25)
    t.setEventHandler { [weak self] in self?.onWatch() }
    t.resume()
    watch = t
  }

  private func onWatch() {
    if ended { return }
    tick += 1
    if kill(pid, 0) != 0 && errno == ESRCH {
      sendJSON(["ev": "app-exit", "code": NSNull(), "signal": NSNull()])
      log("appstream \(sid): \(name) quit")
      return end()
    }
    // With no daemon for 10 minutes (it was removed, or its session state is gone) nobody can reattach: let go.
    if let lost = lostClientAt, Date().timeIntervalSince(lost) > 600 { log("appstream \(sid): no daemon for 10 min; ending"); return end() }
    if phase == .waiting, pickWindow() != nil { startStream() }
    else if phase == .live {
      if let win = pickWindow() {
        if win.id != targetWindow || win.frame != winFrame { follow(win) }
      } else {
        // Every window closed or minimized: wait for one (the app is still running).
        stopStream()
        phase = .waiting
        fail("no-window", "\(name) has no window on screen")
      }
    }
    if tick % 2 == 0 && client >= 0 { watchClipboard() }
    if tick % 8 == 0 && client >= 0 && phase == .live { sendStats() }
  }

  private func follow(_ win: (id: CGWindowID, frame: CGRect)) {
    guard let g = geometry(win.frame), let s = scStream else { return }
    let otherDisplay = g.display.id != displayId
    targetWindow = win.id; winFrame = win.frame; capRect = g.rect
    if otherDisplay { displayId = g.display.id; return startStream() }
    // Same display: a new crop (and output size); the encoder follows the next frame's size.
    s.updateConfiguration(configuration(g)) { err in if let err = err { self.q.async { self.failStream("stream-failed", "ScreenCaptureKit: \(err.localizedDescription)") } } }
  }

  private func watchClipboard() {
    let (count, front) = onMain { (NSPasteboard.general.changeCount, NSWorkspace.shared.frontmostApplication?.processIdentifier) }
    guard count != clipboardSeen else { return }
    clipboardSeen = count
    // Only a copy made while the streamed app is in front: the viewer never sees what Sir copies elsewhere.
    guard front == pid, let text = onMain({ NSPasteboard.general.string(forType: .string) }), text.utf8.count <= 1024 * 1024 else { return }
    sendJSON(["ev": "clipboard", "text": text])
  }

  private func sendStats() {
    statsLock.lock()
    let st = stats
    stats = (0, 0, 0, [], Date())
    statsLock.unlock()
    let span = max(0.001, Date().timeIntervalSince(st.since))
    let enc = st.enc.sorted()
    sendJSON(["ev": "stats", "fps": (Double(st.frames) / span * 10).rounded() / 10, "kbps": Int(Double(st.bytes) * 8 / 1000 / span), "skipped": st.skipped,
              "encodeMsP50": enc.isEmpty ? NSNull() : (enc[enc.count / 2] * 100).rounded() / 100 as Any,
              "encodeMsP95": enc.isEmpty ? NSNull() : (enc[Int(Double(enc.count) * 0.95)] * 100).rounded() / 100 as Any,
              "encoder": ["name": transport == "jpeg" ? "jpeg" : "h264_videotoolbox", "hw": encoder?.hw ?? false, "path": "sck"]])
  }

  /** A remote resize: the window gets the size that makes the stream width × height (through AX; needs Accessibility). */
  private func resize(width: Double, height: Double) {
    guard width >= 16, height >= 16, targetWindow != 0, outW > 0, capRect.width > 0 else { return }
    guard AXIsProcessTrusted() else { return fail("needs-permission", "RIGS Control needs Accessibility to resize \(name)'s window") }
    guard let win = axWindow(pid, targetWindow) else { return }
    let pxPerPt = Double(outW) / Double(capRect.width)
    let ds = displays()
    let visible = ds.first(where: { $0.id == displayId })?.bounds ?? CGRect(x: 0, y: 0, width: 1e5, height: 1e5)
    var size = CGSize(width: min(width / pxPerPt, Double(visible.maxX - winFrame.minX)), height: min(height / pxPerPt, Double(visible.maxY - winFrame.minY)))
    if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, v) }
  }

  // ---- input (§5.3 events, already validated by the daemon; coordinates are stream pixels)

  private func global(_ x: Double, _ y: Double) -> CGPoint {
    let sx = Double(capRect.width) / Double(max(1, outW)), sy = Double(capRect.height) / Double(max(1, outH))
    return CGPoint(x: Double(capRect.minX) + x * sx, y: Double(capRect.minY) + y * sy)
  }

  private var cursor: CGPoint { CGEvent(source: nil)?.location ?? .zero }

  /** Viewer buttons 1 middle, 3 back, 4 forward → Quartz button numbers 2, 3, 4. */
  private func otherButton(_ b: Int) -> CGMouseButton? { CGMouseButton(rawValue: UInt32(b == 1 ? 2 : b)) }

  /** Before a click: bring the app and its window to the front, or the click would land on whatever covers it. */
  private func bringToFront() {
    let front = onMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    guard front != pid else { return }
    _ = try? focusWindow(targetWindow)
    usleep(60_000)
  }

  private func applyInput(_ events: [[String: Any]]) {
    guard phase == .live else { return }
    guard AXIsProcessTrusted() else {
      if !warnedInput { warnedInput = true; fail("needs-permission", "RIGS Control needs Accessibility to send input to \(name) (System Settings > Privacy & Security > Accessibility)") }
      return
    }
    warnedInput = false
    for e in events {
      switch (e["k"] as? String) ?? "" {
      case "pm":
        guard let x = num(e["x"]), let y = num(e["y"]) else { continue }
        let p = global(x, y)
        let other = heldButtons.first(where: { $0 != 0 && $0 != 2 })
        let t: CGEventType = heldButtons.contains(0) ? .leftMouseDragged : heldButtons.contains(2) ? .rightMouseDragged : other != nil ? .otherMouseDragged : .mouseMoved
        let b: CGMouseButton = heldButtons.contains(0) ? .left : heldButtons.contains(2) ? .right : other.flatMap { otherButton($0) } ?? .left
        CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: b)?.post(tap: .cghidEventTap)
      case "pb":
        guard let bn = num(e["b"]), let d = num(e["d"]) else { continue }
        button(Int(bn), down: d == 1)
      case "pw":
        let dx = num(e["dx"]) ?? 0, dy = num(e["dy"]) ?? 0
        let units: CGScrollEventUnit = (e["mode"] as? String) == "line" ? .line : .pixel
        // Browser deltas: positive dy scrolls down; Quartz: positive wheel1 scrolls up.
        CGEvent(scrollWheelEvent2Source: src, units: units, wheelCount: 2, wheel1: Int32(clamping: Int(-dy.rounded())), wheel2: Int32(clamping: Int(-dx.rounded())), wheel3: 0)?.post(tap: .cghidEventTap)
      case "kc":
        guard let c = num(e["code"]), let d = num(e["d"]) else { continue }
        key(CGKeyCode(c), down: d == 1)
      case "tx":
        guard let s = e["s"] as? String else { continue }
        typeText(s)
      case "ra": releaseInput()
      default: break  // touch passthrough ('tc') has no macOS equivalent; the viewer emulates the pointer
      }
    }
  }

  private func button(_ b: Int, down: Bool) {
    let (dn, up, mb): (CGEventType, CGEventType, CGMouseButton) = b == 0 ? (.leftMouseDown, .leftMouseUp, .left) : b == 2 ? (.rightMouseDown, .rightMouseUp, .right)
      : (.otherMouseDown, .otherMouseUp, otherButton(b) ?? .center)
    if down { bringToFront() }
    let pos = cursor
    var count: Int64 = 1
    if down {
      if let l = lastClick, l.button == b, Date().timeIntervalSince(l.at) < NSEvent.doubleClickInterval, abs(l.pos.x - pos.x) < 4, abs(l.pos.y - pos.y) < 4 { count = min(l.count + 1, 3) }
      lastClick = (b, Date(), pos, count)
    } else if let l = lastClick, l.button == b { count = l.count }
    let ev = CGEvent(mouseEventSource: src, mouseType: down ? dn : up, mouseCursorPosition: pos, mouseButton: mb)
    ev?.setIntegerValueField(.mouseEventClickState, value: count)
    ev?.post(tap: .cghidEventTap)
    if down { heldButtons.insert(b) } else { heldButtons.remove(b) }
  }

  /** Keys go to the app's process only (postToPid): Sir's other apps never get a remote keystroke. */
  private func key(_ code: CGKeyCode, down: Bool) {
    let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
    if let flag = MAC_MODIFIERS[code] {
      if down { modifiers.insert(flag) } else { modifiers.remove(flag) }
      ev?.type = .flagsChanged
    }
    ev?.flags = modifiers
    ev?.postToPid(pid)
    if down { heldKeys.append(code) } else if let i = heldKeys.lastIndex(of: code) { heldKeys.remove(at: i) }
  }

  private func typeText(_ text: String) {
    for ch in text {
      let u = Array(String(ch).utf16)
      for down in [true, false] {
        let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
        ev?.flags = []
        ev?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
        ev?.postToPid(pid)
      }
      usleep(2000)
    }
  }

  func releaseInput() {
    let pos = cursor
    for b in heldButtons {
      let (t, mb): (CGEventType, CGMouseButton) = b == 0 ? (.leftMouseUp, .left) : b == 2 ? (.rightMouseUp, .right) : (.otherMouseUp, otherButton(b) ?? .center)
      CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: pos, mouseButton: mb)?.post(tap: .cghidEventTap)
    }
    heldButtons.removeAll()
    for code in heldKeys.reversed() {
      let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
      if MAC_MODIFIERS[code] != nil { ev?.type = .flagsChanged }
      ev?.flags = []
      ev?.postToPid(pid)
    }
    heldKeys.removeAll()
    modifiers = []
  }

  // ---- stop

  /**
   * DELETE / park expiry. An app this session launched is asked to quit like ⌘Q (it may save or ask) and gets 10 s;
   * force quits it at once. It is never killed after the wait: on the real desktop that would lose Sir's work. An app
   * that was already running when the session attached keeps running.
   */
  private func stop(force: Bool) {
    stopStream()
    releaseInput()
    if launched, let app = onMain({ NSRunningApplication(processIdentifier: pid) }) {
      _ = onMain { force ? app.forceTerminate() : app.terminate() }
      let until = Date().addingTimeInterval(force ? 3 : 10)
      while Date() < until && !(kill(pid, 0) != 0 && errno == ESRCH) { usleep(100_000) }
      if !(kill(pid, 0) != 0 && errno == ESRCH) { log("appstream \(sid): \(name) did not quit (it may be asking to save); left running") }
      else { sendJSON(["ev": "app-exit", "code": NSNull(), "signal": NSNull()]) }
    }
    end()
  }

  /** Ends the session here: capture, input, sockets. The app itself is left as it is. Runs on q. */
  func end() {
    if ended { return }
    ended = true
    stopStream()
    releaseInput()
    watch?.cancel()
    if listenFd >= 0 { shutdown(listenFd, SHUT_RDWR); close(listenFd); listenFd = -1 }
    unlink(sockPath)
    writeLock.lock()
    if client >= 0 { shutdown(client, SHUT_RDWR); close(client); client = -1 }
    writeLock.unlock()
    appSessions.remove(sid)
    log("appstream \(sid): ended")
  }
}

final class AppSessions {
  private var map: [String: AppSession] = [:]
  private let lock = NSLock()
  func remove(_ sid: String) { lock.lock(); map[sid] = nil; lock.unlock() }
  var all: [AppSession] { lock.lock(); defer { lock.unlock() }; return Array(map.values) }

  /**
   * The `appStream` control op: {sid, socket, path (a .app bundle) | bundleId, files?}. Launches the app (or attaches to
   * it when it is already running), opens the session socket and returns at once; the daemon connects to the socket.
   */
  func start(_ a: [String: Any]) throws -> [String: Any] {
    guard screenAccess() else { throw Fail("needs-permission", "RIGS Control needs Screen Recording to stream an app (System Settings > Privacy & Security > Screen Recording)") }
    guard let sid = a["sid"] as? String, sid.range(of: "^as-[0-9a-f]{8}$", options: .regularExpression) != nil else { throw Fail("bad-args", "sid must be as-<8 hex>") }
    // Only the daemon's own run folder, under this session's name: a confused caller cannot bind elsewhere.
    guard (a["socket"] as? String) == appStreamDir + sid + ".sock" else { throw Fail("bad-args", "socket must be \(appStreamDir)\(sid).sock") }
    lock.lock(); let exists = map[sid] != nil; lock.unlock()
    if exists { throw Fail("bad-args", "session \(sid) already exists") }
    var url: URL?
    if let p = a["path"] as? String, p.hasSuffix(".app"), FileManager.default.fileExists(atPath: p) { url = URL(fileURLWithPath: p) }
    else if let b = a["bundleId"] as? String { url = onMain { NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) } }
    guard let appURL = url, let bundle = Bundle(url: appURL), let bid = bundle.bundleIdentifier else { throw Fail("bad-args", "no application at \(a["path"] ?? a["bundleId"] ?? "?")") }
    let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? appURL.deletingPathExtension().lastPathComponent
    let files = ((a["files"] as? [String]) ?? []).filter { $0.hasPrefix("/") }.prefix(50).map { URL(fileURLWithPath: $0) }
    var running = onMain { NSRunningApplication.runningApplications(withBundleIdentifier: bid).first(where: { !$0.isTerminated }) }
    let launched = running == nil
    if running == nil || !files.isEmpty {
      let cfg = NSWorkspace.OpenConfiguration()
      cfg.activates = true
      let done = DispatchSemaphore(value: 0)
      var err: Error?
      let handler: (NSRunningApplication?, Error?) -> Void = { app, e in if let app = app { running = app }; err = e; done.signal() }
      if files.isEmpty { NSWorkspace.shared.openApplication(at: appURL, configuration: cfg, completionHandler: handler) }
      else { NSWorkspace.shared.open(Array(files), withApplicationAt: appURL, configuration: cfg, completionHandler: handler) }
      if done.wait(timeout: .now() + 6) == .timedOut, running == nil { throw Fail("timeout", "\(name) did not start within 6 s") }
      if let e = err, running == nil { throw Fail("error", "\(name) could not be opened: \(e.localizedDescription)") }
    }
    guard let app = running else { throw Fail("error", "\(name) did not start") }
    let s = AppSession(sid: sid, sockPath: appStreamDir + sid + ".sock", pid: app.processIdentifier, name: name, bundleId: bid, launched: launched)
    try s.listen()
    lock.lock(); map[sid] = s; lock.unlock()
    log("appstream \(sid): \(launched ? "launched" : "attached to") \(name) (pid \(app.processIdentifier))")
    return s.json
  }

  /** The kill hotkey: let go of every key and button at once and stop capturing; the daemon's kill follows. */
  func panic() {
    for s in all { s.q.async { s.releaseInput(); s.sendJSON(["ev": "error", "code": "killed", "message": "⌃⌥⌘⎋ pressed on the Mac"]) } }
  }

  /** SIGTERM: end every session quickly (input released, capture stopped, sockets removed); the apps keep running. */
  func endAll(timeout: TimeInterval) {
    let g = DispatchGroup()
    for s in all { g.enter(); s.q.async { s.end(); g.leave() } }
    _ = g.wait(timeout: .now() + timeout)
  }
}
let appSessions = AppSessions()

/**
 * `rigs-control --selftest-encode <file> [width height frames]`: encodes a moving NV12 test pattern through the
 * session's encoder, Annex-B conversion and frame header into <file> as runner messages, with no capture and no grant.
 * test/app-stream.test.js decodes it (and ffprobe when present) to check the VideoToolbox path on a Mac.
 */
func selftestEncode(_ args: [String]) -> Int32 {
  guard let file = args.first else { log("usage: --selftest-encode <file> [width height frames]"); return 2 }
  let w = Int(args.count > 1 ? args[1] : "") ?? 640, h = Int(args.count > 2 ? args[2] : "") ?? 360, n = Int(args.count > 3 ? args[3] : "") ?? 30
  guard let enc = try? H264Encoder(width: w, height: h, fps: 30, kbps: 4000) else { log("no H.264 encoder"); return 1 }
  var out = Data()
  out.append(runnerMessage(1, try! JSONSerialization.data(withJSONObject: ["ev": "stream", "encoder": ["name": "h264_videotoolbox", "hw": enc.hw, "path": enc.lowLatency ? "sck-lowlatency" : "sck"], "width": w, "height": h])))
  let lock = NSLock(), done = DispatchGroup()
  var seq: UInt32 = 0, dropped = 0
  for i in 0..<n {
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
    guard let buf = pb else { return 1 }
    CVPixelBufferLockBaseAddress(buf, [])
    for plane in 0..<2 {
      let base = CVPixelBufferGetBaseAddressOfPlane(buf, plane)!.assumingMemoryBound(to: UInt8.self)
      let stride = CVPixelBufferGetBytesPerRowOfPlane(buf, plane), ph = CVPixelBufferGetHeightOfPlane(buf, plane)
      for y in 0..<ph { for x in 0..<stride { base[y * stride + x] = plane == 0 ? UInt8(truncatingIfNeeded: x + y + i * 8) : UInt8(truncatingIfNeeded: 128 + (x / 2 + i) % 64) } }
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    let started = monoUs()
    done.enter()
    let ok = enc.encode(buf, ptsUs: UInt64(i) * 33_333 + 1, forceKey: i == 0 || i == n / 2) { sb in
      defer { done.leave() }
      guard let sb = sb else { lock.lock(); dropped += 1; lock.unlock(); return }
      lock.lock(); seq += 1; let mySeq = seq; lock.unlock()
      let key = isKeyframe(sb)
      guard let au = annexB(sb, key: key) else { return }
      let frame = mediaFrame(kind: 1, flags: key ? FLAG_KEY | FLAG_CONFIG : 0, seq: mySeq, captureUs: started, encodeUs: UInt32(clamping: monoUs() - started), inputSeq: 0, width: w, height: h, payload: au)
      lock.lock(); out.append(runnerMessage(2, frame)); lock.unlock()
    }
    if !ok { done.leave() }
    usleep(33_333)  // paced like a 30 fps capture, so encodeUs is per frame, not queueing
  }
  VTCompressionSessionCompleteFrames(enc.session, untilPresentationTimeStamp: .invalid)
  _ = done.wait(timeout: .now() + 10)
  enc.close()
  do { try out.write(to: URL(fileURLWithPath: file)) } catch { log("cannot write \(file)"); return 1 }
  print("{\"hw\":\(enc.hw),\"lowLatency\":\(enc.lowLatency),\"width\":\(w),\"height\":\(h),\"dropped\":\(dropped)}")
  return 0
}

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
  case "appStream":
    return try appSessions.start(a)
  case "appStreams":
    return appSessions.all.map { $0.json }
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
  /** Requests run in order off the reading thread, so a stop is seen while typing is still in progress. */
  let work = DispatchQueue(label: "dev.rigs.control.client")
  /** Sent input (reading thread only): only its disconnect ends typing and releases input, not a status probe's. */
  var drove = false
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
        if INPUT_OPS.contains(op) { drove = true }
        if op == "stop" || op == "release" { stops.bump() }
        work.async { self.perform(id, op, req) }
      }
    }
    // The daemon went away (crash, stop): end its typing and never leave a key or button pressed.
    let drove = self.drove
    if drove { stops.bump() }
    work.async {
      if drove { inputLock.lock(); input.release(); inputLock.unlock() }
      clients.remove(self)
      close(self.fd)
    }
  }

  func perform(_ id: Any, _ op: String, _ req: [String: Any]) {
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
  // One helper per home: a second copy (started by macOS rather than launchd) leaves the running one alone.
  let probe = socket(AF_UNIX, SOCK_STREAM, 0)
  let live = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
  close(probe)
  if live == 0 { log("another RIGS Control already serves \(sockPath); exiting"); exit(0) }
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
    stops.bump()
    // Never wait for inputLock on the main thread: its holder may be waiting for the main thread (onMain).
    DispatchQueue.global().async {
      clients.broadcast(["event": "hotkey", "reason": "⌃⌥⌘⎋ pressed on the Mac"])
      appSessions.panic()
      inputLock.lock(); input.release(); inputLock.unlock()
    }
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
  stops.bump()
  // Typing ends at the next character. A holder still busy after 2 s is a capture or a request waiting for this
  // (main) thread, neither of which touches input, so release anyway rather than hang until launchd's SIGKILL.
  let locked = inputLock.lock(before: Date().addingTimeInterval(2))
  input.release()
  if locked { inputLock.unlock() }
  // Streamed apps keep running; their sessions end (input released, capture stopped, sockets removed).
  appSessions.endAll(timeout: 1)
  unlink(sockPath)
  exit(0)
}
term.resume()

if CommandLine.arguments.contains("--version") { print(VERSION); exit(0) }
if CommandLine.arguments.contains("--preflight") { exit(CGPreflightScreenCaptureAccess() ? 0 : 1) }
if let i = CommandLine.arguments.firstIndex(of: "--selftest-encode") { exit(selftestEncode(Array(CommandLine.arguments[(i + 1)...]))) }
do { try serve() } catch let f as Fail { log("cannot start: \(f.message)"); exit(1) } catch { log("cannot start: \(error)"); exit(1) }
/**
 * After a Screen Recording switch, System Settings offers "Quit & Reopen". Quitting is not needed (grants are
 * re-checked in a fresh child) and would leave launchd's job stopped, so the quit request is declined. The daemon
 * stops the helper with launchctl bootout (SIGTERM), which does not go through here.
 */
final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    log("declined a quit request (stop RIGS Control with: rigs control helper stop)")
    return .terminateCancel
  }
}
let delegate = AppDelegate()
let app = NSApplication.shared
app.delegate = delegate
app.setActivationPolicy(.accessory)
registerHotkey()
app.run()
