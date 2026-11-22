// app-click helper (ticket 171): drive one app by pid through Accessibility and CGEvent, like a user.
// Usage: ax <cmd> ...
//   window PID [onscreen]      -> "<windowNumber> x y w h" of the pid's front window (layer 0, widest)
//   tree PID [MAXDEPTH]        -> one line per element: depth role | title | description | value | x,y,w,h
//   menu PID TITLE             -> AXPress the menu-bar item with that title
//   press PID TEXT [N]         -> AXPress the Nth (default 1) element whose title/description/value equals TEXT ("#id|Label": see matches)
//   find PID TEXT              -> frames of matching elements, one per line ("x y w h role")
//   ping PID                   -> "ok" if the window and its web area answer within 5 s
//   click PID X Y | rclick PID X Y | drag PID X1 Y1 X2 Y2 | move PID X Y | down PID X Y | dragto PID X Y | up PID X Y
//     (screen points; refused unless PID owns the topmost window there)
//   type PID TEXT | key PID KEYCODE [cmd,shift,alt,ctrl]
//   activate PID | pixel FILE X Y | bbox FILE X Y W H | access | screen
// Exit codes: 0 ok, 1 usage or not found, 3 HANG (the app did not answer an AX call within 5 s).
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

let HANG_SECS: Float = 5

func die(_ msg: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

func app(_ pid: pid_t) -> AXUIElement {
  let a = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(a, HANG_SECS)
  return a
}

// One attribute; a timeout (kAXErrorCannotComplete) is a hang, never "missing".
func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  let started = Date()
  let err = AXUIElementCopyAttributeValue(el, name as CFString, &v)
  if err == .cannotComplete && Date().timeIntervalSince(started) >= Double(HANG_SECS) - 0.5 {
    die("HANG: no answer to \(name) for \(Int(HANG_SECS)) s", 3)
  }
  return err == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String {
  guard let v = attr(el, name) else { return "" }
  if let s = v as? String { return s }
  if CFGetTypeID(v) == CFNumberGetTypeID() || CFGetTypeID(v) == CFBooleanGetTypeID() { return "\(v)" }
  return ""
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return CGRect(origin: pt, size: sz)
}

func kids(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func walk(_ el: AXUIElement, _ depth: Int, _ maxDepth: Int, _ visit: (AXUIElement, Int) -> Bool) {
  if !visit(el, depth) || depth >= maxDepth { return }
  for k in kids(el) { walk(k, depth + 1, maxDepth, visit) }
}

func labels(_ el: AXUIElement) -> [String] {
  [str(el, kAXTitleAttribute), str(el, kAXDescriptionAttribute), str(el, kAXValueAttribute)]
}

// Window content only; menu-bar items are reached with `menu` (the Apple menu alone has ~100 items).
// TEXT is "#dom-id|Label|Other label": alternatives tried in order, the first with any hit wins. "#x" matches the web
// element's id (AXDOMIdentifier, stable across label changes); anything else matches title, description or value.
func matches(_ pid: pid_t, _ text: String, menus: Bool = false) -> [AXUIElement] {
  for alt in text.components(separatedBy: "|") {
    var out: [AXUIElement] = []
    walk(app(pid), 0, 60) { el, d in
      if d == 1 && (str(el, kAXRoleAttribute) == "AXMenuBar") != menus { return false }
      if alt.hasPrefix("#") ? str(el, "AXDOMIdentifier") == String(alt.dropFirst()) : labels(el).contains(alt) { out.append(el) }
      return true
    }
    if !out.isEmpty { return out }
  }
  return []
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)!.post(tap: .cghidEventTap)
  usleep(30_000)
}

// Safety: a point event goes only where our pid owns the topmost on-screen window; else it would land in another app.
func ownsPoint(_ pid: pid_t, _ p: CGPoint) -> Bool {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
  for w in list where (w[kCGWindowLayer as String] as? Int) ?? 1 <= 0 || (w[kCGWindowOwnerPID as String] as? Int32) == pid {
    let b = w[kCGWindowBounds as String] as! [String: Any]
    let r = CGRect(x: (b["X"] as! NSNumber).doubleValue, y: (b["Y"] as! NSNumber).doubleValue,
                   width: (b["Width"] as! NSNumber).doubleValue, height: (b["Height"] as! NSNumber).doubleValue)
    if (w[kCGWindowAlpha as String] as? Double) == 0 || !r.contains(p) { continue }
    return (w[kCGWindowOwnerPID as String] as? Int32) == pid
  }
  return false
}

// Look 1117 v10 (the side Schedules "+"): each app copy's own bundle id makes macOS ask "<app> Notifications" in a
// Notification Center banner at the screen's top right. Its window (full screen, layer 23, so skipped above) takes clicks
// on the banner while hover still reaches the window below, and the click was lost without a word. Banners are its
// small AX groups.
func bannerAt(_ p: CGPoint) -> Bool {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for w in list where (w[kCGWindowOwnerName as String] as? String) == "Notification Center" {
    guard let owner = w[kCGWindowOwnerPID as String] as? Int32 else { continue }
    var hit = false
    walk(app(owner), 0, 8) { el, _ in
      if !hit, str(el, kAXRoleAttribute) == "AXGroup", let f = frame(el), f.width < 800, f.height < 400, f.contains(p) { hit = true }
      return !hit
    }
    if hit { return true }
  }
  return false
}

func guardPoint(_ pid: pid_t, _ p: CGPoint) {
  if !ownsPoint(pid, p) { die("refused: (\(Int(p.x)),\(Int(p.y))) is not on pid \(pid)'s topmost window") }
  if bannerAt(p) { die("refused: a Notification Center banner covers (\(Int(p.x)),\(Int(p.y))); move the window or wait for it to go") }
}

func num(_ s: String) -> Double {
  guard let v = Double(s) else { die("not a number: \(s)") }
  return v
}

let a = CommandLine.arguments
guard a.count >= 2 else { die("usage: ax <cmd> ...") }
let pid: pid_t = a.count >= 3 ? (pid_t(a[2]) ?? 0) : 0

switch a[1] {
case "window":
  // On-screen first; a window on another Space (the owner switched desktops) is still found for AX and capture.
  var list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  if a.count < 4 && !list.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }) {
    list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
  }
  let wins = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
  let best = wins.max { a, b in
    ((a[kCGWindowBounds as String] as! [String: Any])["Width"] as! NSNumber).doubleValue
      < ((b[kCGWindowBounds as String] as! [String: Any])["Width"] as! NSNumber).doubleValue
  }
  guard let w = best else { die("no window for pid \(pid)") }
  let b = w[kCGWindowBounds as String] as! [String: Any]
  let n = { (k: String) in Int((b[k] as! NSNumber).doubleValue) }
  print("\(w[kCGWindowNumber as String] as! Int) \(n("X")) \(n("Y")) \(n("Width")) \(n("Height"))")
case "tree":
  let maxDepth = a.count >= 4 ? Int(a[3]) ?? 40 : 40
  walk(app(pid), 0, maxDepth) { el, d in
    let f = frame(el).map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))" } ?? ""
    let l = labels(el).map { $0.replacingOccurrences(of: "\n", with: " ").prefix(80) }
    print("\(d) \(str(el, kAXRoleAttribute)) | \(l[0]) | \(l[1]) | \(l[2]) | \(f)")
    return true
  }
case "find":
  for el in matches(pid, a[3]) {
    if let f = frame(el) { print("\(Int(f.minX)) \(Int(f.minY)) \(Int(f.width)) \(Int(f.height)) \(str(el, kAXRoleAttribute))") }
  }
case "press", "menu":
  let nth = a.count >= 5 ? Int(a[4]) ?? 1 : 1
  let m = matches(pid, a[3], menus: a[1] == "menu")
  guard m.count >= nth else { die("not found: \(a[3]) (\(m.count) matches)") }
  let el = m[nth - 1]
  let started = Date()
  let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
  if err == .cannotComplete && Date().timeIntervalSince(started) >= Double(HANG_SECS) - 0.5 {
    die("HANG: press \(a[3]) got no answer for \(Int(HANG_SECS)) s", 3)
  }
  if err != .success {
    // Some web elements expose no AXPress: click their centre instead.
    guard let f = frame(el) else { die("press failed (\(err.rawValue)) and no frame") }
    let p = CGPoint(x: f.midX, y: f.midY)
    guardPoint(pid, p)
    mouse(.mouseMoved, p); mouse(.leftMouseDown, p); mouse(.leftMouseUp, p)
  }
  print("ok")
case "ping":
  let root = app(pid)
  guard let wins = attr(root, kAXWindowsAttribute) as? [AXUIElement], let w = wins.first else { die("no AX window") }
  var web: AXUIElement?
  walk(w, 0, 12) { el, _ in
    if web != nil { return false }
    if str(el, kAXRoleAttribute) == "AXWebArea" { web = el; return false }
    return true
  }
  if let web = web { _ = kids(web).first.map { str($0, kAXRoleAttribute) } }
  print(web == nil ? "ok (no web area)" : "ok")
case "click", "rclick", "move":
  let p = CGPoint(x: num(a[3]), y: num(a[4]))
  guardPoint(pid, p)
  if a[1] == "move" { mouse(.mouseMoved, p) }
  else if a[1] == "click" { mouse(.mouseMoved, p); mouse(.leftMouseDown, p); mouse(.leftMouseUp, p) }
  else { mouse(.mouseMoved, p); mouse(.rightMouseDown, p, .right); mouse(.rightMouseUp, p, .right) }
  print("ok")
case "down":
  let p = CGPoint(x: num(a[3]), y: num(a[4]))
  guardPoint(pid, p)
  mouse(.mouseMoved, p); mouse(.leftMouseDown, p)
  print("ok")
case "dragto", "up":
  let p = CGPoint(x: num(a[3]), y: num(a[4]))
  mouse(a[1] == "up" ? .leftMouseUp : .leftMouseDragged, p)
  print("ok")
case "drag":
  let p0 = CGPoint(x: num(a[3]), y: num(a[4])), p1 = CGPoint(x: num(a[5]), y: num(a[6]))
  guardPoint(pid, p0); guardPoint(pid, p1)
  mouse(.mouseMoved, p0); mouse(.leftMouseDown, p0)
  for i in 1...20 {
    let t = Double(i) / 20
    mouse(.leftMouseDragged, CGPoint(x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t))
  }
  mouse(.leftMouseUp, p1)
  print("ok")
case "type":
  for ch in a[3].utf16 {
    var c = ch
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)!
      e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
      e.postToPid(pid)
    }
    usleep(15_000)
  }
  print("ok")
case "key":
  let code = CGKeyCode(num(a[3]))
  var flags: CGEventFlags = []
  for m in (a.count >= 5 ? a[4] : "").split(separator: ",") {
    switch m {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    default: die("unknown modifier \(m)")
    }
  }
  // WKWebView ignores keycode-only events posted to the pid; when our app is frontmost, post them as the keyboard
  // would. Not frontmost: postToPid (never a global key into another app).
  let front = str(app(pid), kAXFrontmostAttribute) == "1"
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
    e.flags = flags
    if front { e.post(tap: .cghidEventTap) } else { e.postToPid(pid) }
    usleep(20_000)
  }
  print("ok")
case "pixel":
  // pixel FILE X Y -> "#rrggbb" of a PNG at image pixel (X, Y)
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { die("cannot read \(a[2])") }
  var px = [UInt8](repeating: 0, count: 4)
  let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(img, in: CGRect(x: -num(a[3]), y: num(a[4]) - Double(img.height) + 1, width: Double(img.width), height: Double(img.height)))
  print(String(format: "#%02x%02x%02x %d %d", px[0], px[1], px[2], img.width, img.height))
case "bbox":
  // bbox FILE X Y W H -> "x y w h" (image pixels) of the pixels that differ from the region's corner colour by > 40
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { die("cannot read \(a[2])") }
  let (rx, ry, rw, rh) = (Int(num(a[3])), Int(num(a[4])), Int(num(a[5])), Int(num(a[6])))
  var buf = [UInt8](repeating: 0, count: rw * rh * 4)
  let ctx = CGContext(data: &buf, width: rw, height: rh, bitsPerComponent: 8, bytesPerRow: rw * 4,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(img, in: CGRect(x: -rx, y: ry + rh - img.height, width: img.width, height: img.height))
  let bg = Array(buf[0..<3])
  var (x0, y0, x1, y1) = (rw, rh, -1, -1)
  for y in 0..<rh { for x in 0..<rw {
    let i = (y * rw + x) * 4
    if abs(Int(buf[i]) - Int(bg[0])) + abs(Int(buf[i+1]) - Int(bg[1])) + abs(Int(buf[i+2]) - Int(bg[2])) > 40 {
      x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
    }
  } }
  print(x1 < 0 ? "none" : "\(rx + x0) \(ry + y0) \(x1 - x0 + 1) \(y1 - y0 + 1)")
case "activate":
  // NSRunningApplication.activate from a background tool is refused (cooperative activation); AX frontmost is not.
  let root = app(pid)
  AXUIElementSetAttributeValue(root, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  if let wins = attr(root, kAXWindowsAttribute) as? [AXUIElement], let w = wins.first {
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
  }
  NSRunningApplication(processIdentifier: pid)?.activate()
  usleep(300_000)
  print(str(root, kAXFrontmostAttribute) == "1" ? "ok" : "ok (not frontmost)")
case "access":
  // access -> "screen yes|no": Screen Recording for this process's responsible app, asked without a prompt
  // (a window capture without it comes back blank). scripts/gate-app-boot.sh no longer needs it: it reads the page's
  // own snapshot, which an ssh login can (gate-app-boot-ssh).
  print("screen \(CGPreflightScreenCaptureAccess() ? "yes" : "no")")
case "screen":
  // screen -> "locked yes|no asleep yes|no console yes|no": whether a window capture can show anything now (a locked
  // screen, a sleeping main display or a session switched away gives a black picture). No prompt.
  let session = (CGSessionCopyCurrentDictionary() as? [String: Any]) ?? [:]
  let locked = (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
  let console = (session[kCGSessionOnConsoleKey as String] as? Bool) ?? true
  let asleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0
  print("locked \(locked ? "yes" : "no") asleep \(asleep ? "yes" : "no") console \(console ? "yes" : "no")")
default:
  die("unknown command \(a[1])")
}
