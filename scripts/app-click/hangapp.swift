// no_freeze_detector fixture (ticket 171): a window that answers for 2 s, then blocks its main thread for 30 s.
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let win = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
win.title = "app-click hang fixture"
win.contentView = NSButton(title: "Hang soon", target: nil, action: nil)
win.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 2) { sleep(30) }
app.run()
