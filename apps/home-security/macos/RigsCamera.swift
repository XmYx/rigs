// RIGS Camera: the macOS helper that holds the Camera permission for the Home Security app.
//
// macOS only asks for camera access (and only lists an app under Privacy & Security › Camera) for a process that is an
// app bundle with NSCameraUsageDescription. The app's own node and ffmpeg binaries are not, so the helper is. It is
// started through LaunchServices (`open -W -n -g -j -a "RIGS Camera.app" --args …`), which makes it its own
// "responsible process", and runs ffmpeg as its child: the camera is then attributed to RIGS Camera.
//
//   rigs-camera status  --dir D                         write D/auth.json and exit
//   rigs-camera request --dir D                         ask for access (shows the Allow prompt), write D/auth.json, exit
//   rigs-camera run     --dir D --cwd C [--parent PID] -- <cmd> <args…>
//        wait for access (asking if undecided), then run <cmd> in C with stderr in D/ffmpeg.log; D/pid.json holds the
//        pids, D/exit.json the result. Exit 0 = the command ended normally, 3 = access denied or restricted.
//
// auth.json: {"status":"authorized|notDetermined|denied|restricted","at":<ms>}; exit.json: {"code":n,"signal":bool}.
import AppKit
import AVFoundation
import Foundation

func authName(_ s: AVAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

func writeJSON(_ path: String, _ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

var dir = ""
func writeAuth() -> AVAuthorizationStatus {
  let s = AVCaptureDevice.authorizationStatus(for: .video)
  if !dir.isEmpty { writeJSON(dir + "/auth.json", ["status": authName(s), "at": nowMs()]) }
  return s
}

/// Blocks until the person answers the prompt (or it is already answered). The answer arrives on another queue.
func requestAccess() -> AVAuthorizationStatus {
  let s = writeAuth()
  if s != .notDetermined { return s }
  let sem = DispatchSemaphore(value: 0)
  AVCaptureDevice.requestAccess(for: .video) { _ in sem.signal() }
  // the prompt waits as long as the person does; keep auth.json fresh so the app can show "waiting for Allow"
  while sem.wait(timeout: .now() + 2) == .timedOut { _ = writeAuth() }
  return writeAuth()
}

func parseArgs() -> (mode: String, opts: [String: String], cmd: [String]) {
  var args = Array(CommandLine.arguments.dropFirst())
  // LaunchServices may add -psn_… or -NS… flags in front
  args = args.filter { !$0.hasPrefix("-psn_") }
  let mode = args.first ?? ""
  var opts: [String: String] = [:]
  var cmd: [String] = []
  var i = 1
  while i < args.count {
    if args[i] == "--" { cmd = Array(args[(i + 1)...]); break }
    if args[i].hasPrefix("--"), i + 1 < args.count { opts[String(args[i].dropFirst(2))] = args[i + 1]; i += 2 } else { i += 1 }
  }
  return (mode, opts, cmd)
}

func run(_ opts: [String: String], _ cmd: [String]) -> Int32 {
  if cmd.isEmpty { return 64 }
  // the app signals us (SIGTERM) while we wait at the Allow prompt, so it needs our pid before anything else
  writeJSON(dir + "/pid.json", ["helper": Int(getpid())])
  let s = requestAccess()
  if s != .authorized {
    writeJSON(dir + "/exit.json", ["code": 3, "signal": false, "reason": authName(s), "at": nowMs()])
    return 3
  }
  let proc = Process()
  proc.executableURL = URL(fileURLWithPath: cmd[0])
  proc.arguments = Array(cmd.dropFirst())
  if let cwd = opts["cwd"] { proc.currentDirectoryURL = URL(fileURLWithPath: cwd) }
  proc.standardInput = FileHandle.nullDevice
  proc.standardOutput = FileHandle.nullDevice
  let logPath = dir + "/ffmpeg.log"
  FileManager.default.createFile(atPath: logPath, contents: nil)
  if let log = FileHandle(forWritingAtPath: logPath) { proc.standardError = log }
  let done = DispatchSemaphore(value: 0)
  proc.terminationHandler = { _ in done.signal() }
  do { try proc.run() } catch {
    writeJSON(dir + "/exit.json", ["code": 127, "signal": false, "error": "\(error)"])
    return 127
  }
  writeJSON(dir + "/pid.json", ["helper": Int(getpid()), "child": Int(proc.processIdentifier)])

  // SIGTERM/SIGINT from the app: let ffmpeg finish its segment (SIGINT), then SIGKILL if it hangs
  var stopping = false
  func stop() {
    if stopping { return }
    stopping = true
    kill(proc.processIdentifier, SIGINT)
    DispatchQueue.global().asyncAfter(deadline: .now() + 4) { if proc.isRunning { kill(proc.processIdentifier, SIGKILL) } }
  }
  var sources: [DispatchSourceSignal] = []
  var timers: [DispatchSourceTimer] = []
  for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    src.setEventHandler { stop() }
    src.resume()
    sources.append(src)
  }
  // the app that started us is gone: do not keep recording on our own
  if let p = opts["parent"], let ppid = Int32(p) {
    let t = DispatchSource.makeTimerSource(queue: .global())
    t.schedule(deadline: .now() + 2, repeating: 2)
    t.setEventHandler { if kill(ppid, 0) != 0 && errno == ESRCH { stop() } }
    t.resume()
    timers.append(t) // keep it alive until the function returns
  }
  done.wait()
  let signaled = proc.terminationReason == .uncaughtSignal
  writeJSON(dir + "/exit.json", ["code": Int(proc.terminationStatus), "signal": signaled, "at": nowMs()])
  return signaled ? 1 : proc.terminationStatus
}

let parsed = parseArgs()
dir = parsed.opts["dir"] ?? ""
if dir.isEmpty && parsed.mode != "" { FileHandle.standardError.write("rigs-camera: --dir is required\n".data(using: .utf8)!); exit(64) }
if !dir.isEmpty { try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.global().async {
  var code: Int32 = 0
  switch parsed.mode {
  case "status": _ = writeAuth()
  case "request": code = requestAccess() == .authorized ? 0 : 3
  case "run": code = run(parsed.opts, parsed.cmd)
  default: FileHandle.standardError.write("usage: rigs-camera status|request|run --dir D …\n".data(using: .utf8)!); code = 64
  }
  exit(code)
}
app.run()
