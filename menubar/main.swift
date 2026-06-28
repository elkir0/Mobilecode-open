// SPDX-License-Identifier: Apache-2.0
// OpenCodeBar — a tiny macOS menu-bar utility to start/stop `opencode serve`.
// Native AppKit (NSStatusItem). No dock icon (LSUIElement). Manages the opencode
// process, shows status, copies the Tailscale connection URL, can launch at login,
// stores the server password in the Keychain, and auto-restarts on crash.
//
// Build: see build.sh (swiftc → OpenCodeBar.app, ad-hoc signed).
// CLI mode (for scripting/testing): OpenCodeBar --status | --start | --stop | --url | --set-password

import AppKit
import Security
import ServiceManagement

// MARK: - Configuration

let BUNDLE_ID = "ai.opencode.remote.menubar"
let KEYCHAIN_SERVICE = "ai.opencode.remote.menubar"
let KEYCHAIN_ACCOUNT = "opencode"
let DEFAULT_PORT = "4096"
/// opencode serve CORS origins (must be concrete — "*" does not emit ACAO).
let CORS_ORIGINS = ["capacitor://localhost", "https://localhost", "http://localhost"]

/// Resolve a command name to an absolute path (homebrew locations, then `which`).
func resolveCommand(_ name: String) -> String? {
  let candidates = [
    "/opt/homebrew/bin/\(name)",
    "/usr/local/bin/\(name)",
    "/usr/bin/\(name)"
  ]
  for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
    return c
  }
  // fall back to `which`
  let p = Process()
  p.launchPath = "/usr/bin/which"
  p.arguments = [name]
  let pipe = Pipe()
  p.standardOutput = pipe
  do { try p.run(); p.waitUntilExit() } catch { return nil }
  let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return out.isEmpty ? nil : out
}

// MARK: - Shell helpers

@discardableResult
func runCapture(_ launchPath: String, _ args: [String] = []) -> (code: Int, out: String) {
  let p = Process()
  p.launchPath = launchPath
  p.arguments = args
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  do { try p.run(); p.waitUntilExit() } catch { return (-1, "") }
  let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  return (Int(p.terminationStatus), out)
}

/// Is an `opencode serve` process currently running (ours or external)?
func isServing() -> Bool {
  let (_, out) = runCapture("/usr/bin/pgrep", ["-f", "opencode serve"])
  return !out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

/// The https://<machine>.ts.net URL from `tailscale serve status`, if configured.
func connectionURL() -> String? {
  guard let ts = resolveCommand("tailscale") else { return nil }
  let (_, out) = runCapture(ts, ["serve", "status"])
  // first https:// token in the output
  if let range = out.range(of: #"https://[^\s|]+"#, options: .regularExpression) {
    return String(out[range])
  }
  return nil
}

// MARK: - Keychain

func keychainGet() -> String? {
  let q: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: KEYCHAIN_SERVICE,
    kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne
  ]
  var item: CFTypeRef?
  guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
        let data = item as? Data,
        let s = String(data: data, encoding: .utf8) else { return nil }
  return s
}

func keychainSet(_ password: String) {
  keychainDelete()
  let a: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: KEYCHAIN_SERVICE,
    kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
    kSecValueData as String: Data(password.utf8)
  ]
  SecItemAdd(a as CFDictionary, nil)
}

func keychainDelete() {
  let q: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: KEYCHAIN_SERVICE,
    kSecAttrAccount as String: KEYCHAIN_ACCOUNT
  ]
  SecItemDelete(q as CFDictionary)
}

/// Prompt for the server password (focusable alert). Returns nil if cancelled.
func promptPassword() -> String? {
  let alert = NSAlert()
  alert.messageText = "OpenCode server password"
  alert.informativeText = "Stored in the macOS Keychain (OPENCODE_SERVER_PASSWORD). Used to start opencode serve."
  alert.alertStyle = .informational
  alert.addButton(withTitle: "Save")
  alert.addButton(withTitle: "Cancel")
  let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
  field.placeholderString = "password"
  alert.accessoryView = field
  // accessory apps need to become regular briefly to get a focusable window
  NSApp.setActivationPolicy(.regular)
  NSApp.activate(ignoringOtherApps: true)
  defer {
    NSApp.setActivationPolicy(.accessory)
    // re-establish the menu bar item if it was affected
    (NSApp.delegate as? AppDelegate)?.refreshStatusItem()
  }
  let response = alert.runModal()
  guard response == .alertFirstButtonReturn else { return nil }
  let pw = field.stringValue
  return pw.isEmpty ? nil : pw
}

// MARK: - Server controller

final class ServerController {
  static let shared = ServerController()
  private var process: Process?
  /// True when WE started the process (so we terminate it cleanly); false if external.
  private(set) var owned = false
  private(set) var intentionalStop = false

  var autoRestart: Bool {
    get { UserDefaults.standard.bool(forKey: "autoRestart") }
    set { UserDefaults.standard.set(newValue, forKey: "autoRestart") }
  }

  var port: String {
    get { UserDefaults.standard.string(forKey: "port") ?? DEFAULT_PORT }
    set { UserDefaults.standard.set(newValue, forKey: "port") }
  }

  var password: String? { keychainGet() }

  /// Ensure we have a password (Keychain → prompt). Returns nil if the user cancelled.
  func ensurePassword() -> String? {
    if let pw = keychainGet(), !pw.isEmpty { return pw }
    if let pw = promptPassword() {
      keychainSet(pw)
      return pw
    }
    return nil
  }

  @discardableResult
    func start(reason: String = "manual") -> Bool {
    if isServing() {
      // already running (ours or external) — adopt the running state
      owned = false
      return true
    }
    guard let opencode = resolveCommand("opencode") else {
      lastError = "opencode binary not found on PATH"
      return false
    }
    guard let pw = ensurePassword() else {
      lastError = "no password set"
      return false
    }
    let p = Process()
    p.launchPath = opencode
    p.arguments = ["serve", "--hostname", "0.0.0.0", "--port", port]
      + CORS_ORIGINS.flatMap { ["--cors", $0] }
    var env = ProcessInfo.processInfo.environment
    env["OPENCODE_SERVER_PASSWORD"] = pw
    p.environment = env
    // silence the child's stdio (detached daemon)
    p.standardOutput = FileHandle(forWritingAtPath: "/dev/null")
    p.standardError = FileHandle(forWritingAtPath: "/dev/null")
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        guard let self = self else { return }
        let crashed = !self.intentionalStop
        self.process = nil
        self.owned = false
        self.intentionalStop = false
        if crashed && self.autoRestart && reason != "restart" {
          // relaunch after a short backoff
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            _ = self.start(reason: "restart")
            NotificationCenter.default.post(name: .serverStateChanged, object: nil)
          }
        }
        NotificationCenter.default.post(name: .serverStateChanged, object: nil)
      }
    }
    do {
      try p.run()
      process = p
      owned = true
      intentionalStop = false
      lastError = nil
      return true
    } catch {
      lastError = error.localizedDescription
      return false
    }
  }

  func stop() {
    intentionalStop = true
    if let p = process, p.isRunning {
      p.terminate()
      // give it a moment, then force if still alive
      DispatchQueue.global().asyncAfter(deadline: .now() + 3.0) {
        if p.isRunning { p.terminate() } // SIGTERM already; ForceKill isn't directly exposed
      }
    } else if isServing() {
      // external process — kill via pkill
      runCapture("/usr/bin/pkill", ["-f", "opencode serve"])
    }
    process = nil
    owned = false
  }

  var isRunning: Bool { process?.isRunning ?? isServing() }
  var lastError: String?
}

extension Notification.Name {
  static let serverStateChanged = Notification.Name("serverStateChanged")
}

// MARK: - Push watcher

/// Watches the LOCAL opencode serve for session busy→idle transitions and fires a
/// push-notification request to a user-configured relay.
///
/// SECURITY: opencode credentials (ServerController.shared.password) are used ONLY
/// to authenticate the local GET to http://localhost:4096. They NEVER leave the Mac.
/// The public relay receives only {title, body} plus the relay API key.
final class PushController {
  static let shared = PushController()
  private var timer: Timer?
  /// SessionIDs observed as busy on the previous poll. A session leaving this set
  /// (busy→idle transition) triggers one push.
  private var busySessions: Set<String> = []
  /// Best-effort in-memory log of recent push outcomes (newest first).
  private(set) var log: [String] = []
  private let maxLog = 25

  // MARK: Config (UserDefaults)

  var pushEnabled: Bool {
    get { UserDefaults.standard.bool(forKey: "pushEnabled") }
    set { UserDefaults.standard.set(newValue, forKey: "pushEnabled") }
  }

  /// Relay base URL, e.g. "https://push.shathony.fr" (no trailing /push).
  var relayURL: String {
    get { UserDefaults.standard.string(forKey: "pushRelayURL") ?? "" }
    set { UserDefaults.standard.set(newValue, forKey: "pushRelayURL") }
  }

  /// Relay API key (e.g. "mpr_..."). Stored in UserDefaults (not the opencode Keychain slot).
  var apiKey: String {
    get { UserDefaults.standard.string(forKey: "pushApiKey") ?? "" }
    set { UserDefaults.standard.set(newValue, forKey: "pushApiKey") }
  }

  // MARK: Lifecycle

  /// Start polling iff enabled AND a relay URL + key are configured AND opencode is running.
  func start() {
    stop()
    guard pushEnabled, isReady() else { return }
    // immediate first tick, then every 8s
    tick()
    let t = Timer.scheduledTimer(withTimeInterval: 8.0, repeats: true) { [weak self] _ in
      self?.tick()
    }
    timer = t
  }

  func stop() {
    timer?.invalidate()
    timer = nil
    // reset observed state so we don't fire a false push on the next start
    busySessions.removeAll()
  }

  /// Re-evaluate whether the watcher should be running (call on server state changes).
  /// Restarts only if the runtime conditions differ from current state.
  func reevaluate() {
    let shouldRun = pushEnabled && isReady() && ServerController.shared.isRunning
    if shouldRun && timer == nil {
      start()
    } else if !shouldRun && timer != nil {
      stop()
    }
  }

  /// True when a relay URL + API key are both set (config precondition for polling).
  func isReady() -> Bool {
    let u = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    let k = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    return !u.isEmpty && !k.isEmpty
  }

  func appendLog(_ s: String) {
    let stamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
    log.insert("[\(stamp)] \(s)", at: 0)
    if log.count > maxLog { log.removeLast(log.count - maxLog) }
  }

  // MARK: Poll

  /// One poll cycle: fetch /session/status, diff the busy set, fire pushes.
  private func tick() {
    guard ServerController.shared.isRunning else { stop(); return }
    guard let pw = ServerController.shared.password, !pw.isEmpty,
          let url = URL(string: "http://localhost:\(ServerController.shared.port)/session/status") else {
      return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 5
    req.setValue(basicAuthHeader(user: "opencode", pass: pw), forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Accept")

    let task = URLSession.shared.dataTask(with: req) { [weak self] data, response, err in
      guard let self = self else { return }
      if let err = err {
        // ECONNREFUSED / not serving — common; log quietly at debug
        self.appendLog("poll error: \(err.localizedDescription)")
        return
      }
      guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data else {
        self.appendLog("poll non-200 / no data")
        return
      }
      // Shape: { "<sessionID>": { "type": "busy" | "retry" | "idle" | ... }, ... }
      // (mirrors the opencode status endpoint used by the iOS app).
      guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        self.appendLog("poll: malformed JSON")
        return
      }
      let nowBusy = Set(obj.compactMap { (id, val) -> String? in
        guard let dict = val as? [String: Any],
              let type = dict["type"] as? String else { return nil }
        return (type == "busy" || type == "retry") ? id : nil
      })

      // Sessions that were busy but are no longer → transition(s) to fire.
      let finished = self.busySessions.subtracting(nowBusy)
      self.busySessions = nowBusy

      for id in finished {
        self.firePush(sessionID: id)
      }
    }
    task.resume()
  }

  // MARK: Fire push

  /// POST {title, body} to <relay>/push with Authorization: Bearer <apiKey>.
  /// Best-effort: never blocks the poll, only logs the outcome.
  private func firePush(sessionID: String) {
    let base = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !base.isEmpty, !apiKey.isEmpty else { return }
    // Join sensibly: append "/push" unless the base already ends with it.
    var endpoint = base
    while endpoint.hasSuffix("/") { endpoint.removeLast() }
    if !endpoint.hasSuffix("/push") { endpoint += "/push" }
    guard let url = URL(string: endpoint) else {
      appendLog("push: invalid relay URL")
      return
    }

    // Resolve a human-readable title (best-effort GET /session/:id).
    resolveSessionTitle(sessionID) { [weak self] title in
      guard let self = self else { return }
      var req = URLRequest(url: url)
      req.timeoutInterval = 5
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.setValue("Bearer \(self.apiKey)", forHTTPHeaderField: "Authorization")
      let payload: [String: String] = [
        "title": title,
        "body": "opencode session \(sessionID.prefix(8)) finished"
      ]
      req.httpBody = try? JSONSerialization.data(withJSONObject: payload)

      URLSession.shared.dataTask(with: req) { [weak self] _, response, err in
        guard let self = self else { return }
        if let err = err {
          self.appendLog("push failed: \(err.localizedDescription)")
          return
        }
        if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
          self.appendLog("push sent: \(title)")
        } else {
          let code = (response as? HTTPURLResponse)?.statusCode ?? -1
          self.appendLog("push rejected (HTTP \(code))")
        }
      }.resume()
    }
  }

  /// Best-effort GET /session/:id → "title" field; fallback "opencode session".
  private func resolveSessionTitle(_ sessionID: String, completion: @escaping (String) -> Void) {
    guard let pw = ServerController.shared.password, !pw.isEmpty,
          let url = URL(string: "http://localhost:\(ServerController.shared.port)/session/\(sessionID)") else {
      completion("opencode session"); return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 4
    req.setValue(basicAuthHeader(user: "opencode", pass: pw), forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    URLSession.shared.dataTask(with: req) { data, response, _ in
      guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data,
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let title = obj["title"] as? String, !title.isEmpty else {
        completion("opencode session"); return
      }
      completion(title)
    }.resume()
  }
}

/// Build an HTTP Basic "Authorization: <base64(user:pass)>" header value.
func basicAuthHeader(user: String, pass: String) -> String {
  let raw = "\(user):\(pass)"
  let b64 = (raw.data(using: .utf8) ?? Data()).base64EncodedString()
  return "Basic \(b64)"
}

// MARK: - CLI mode

func cliMode() -> Int32 {
  let args = CommandLine.arguments.dropFirst()
  guard let cmd = args.first else { return runGUI() } // no arg → GUI
  switch cmd {
  case "--status":
    print(ServerController.shared.isRunning ? "running" : "stopped")
    return ServerController.shared.isRunning ? 0 : 1
  case "--url":
    print(connectionURL() ?? "")
    return 0
  case "--start":
    let ok = ServerController.shared.start()
    if !ok { fputs("error: \(ServerController.shared.lastError ?? "unknown")\n", stderr) }
    return ok ? 0 : 1
  case "--stop":
    ServerController.shared.stop()
    // also stop an external opencode serve if present
    if isServing() { runCapture("/usr/bin/pkill", ["-f", "opencode serve"]) }
    return 0
  case "--set-password":
    let pw = args.dropFirst().first
    if let pw = pw, !pw.isEmpty { keychainSet(pw); print("password saved to Keychain"); return 0 }
    if let p = promptPassword() { keychainSet(p); print("password saved to Keychain"); return 0 }
    fputs("cancelled\n", stderr); return 1
  case "--set-relay":
    // --set-relay <url> <apikey>   (scriptable; GUI prompt if args missing)
    let rest = Array(args.dropFirst())
    if rest.count >= 2 {
      let url = rest[0].trimmingCharacters(in: .whitespacesAndNewlines)
      let key = rest[1].trimmingCharacters(in: .whitespacesAndNewlines)
      PushController.shared.relayURL = url
      PushController.shared.apiKey = key
      print("relay saved: \(url)")
      return 0
    }
    fputs("usage: OpenCodeBar --set-relay <url> <apikey>\n", stderr)
    return 64
  case "--push-status":
    // read-only helper for scripts: prints enabled/ready + last few log lines
    let pc = PushController.shared
    print("enabled=\(pc.pushEnabled) ready=\(pc.isReady()) relay=\(pc.relayURL.isEmpty ? "(none)" : pc.relayURL)")
    for line in pc.log.prefix(5) { print(line) }
    return 0
  case "--help", "-h":
    print("OpenCodeBar — menu-bar controller for opencode serve")
    print("Usage: OpenCodeBar [--status|--start|--stop|--url|--set-password [pw]|--set-relay <url> <apikey>|--push-status]")
    print("No arguments launches the menu-bar app.")
    return 0
  default:
    fputs("unknown command: \(cmd)\n", stderr); return 64
  }
}

// MARK: - GUI

final class AppDelegate: NSObject, NSApplicationDelegate {
  var statusItem: NSStatusItem!
  let menu = NSMenu()
  var statusMenuItem: NSMenuItem!
  var toggleMenuItem: NSMenuItem!
  var urlMenuItem: NSMenuItem!

  func applicationDidFinishLaunching(_ note: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    refreshStatusItem()
    buildMenu()
    // Start the push watcher now if already configured + opencode running.
    PushController.shared.reevaluate()
    // periodic refresh (icon + menu + external-state detection)
    Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
      self?.refreshStatusItem()
      self?.refreshMenu()
      // Re-evaluate the push watcher each cycle so it starts when opencode comes
      // up and stops cleanly when it goes down (covers external starts/stops).
      PushController.shared.reevaluate()
    }
    NotificationCenter.default.addObserver(self, selector: #selector(stateChanged),
                                           name: .serverStateChanged, object: nil)
  }

  func refreshStatusItem() {
    let running = ServerController.shared.isRunning
    let symbol = running ? "circle.fill" : "circle"
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "OpenCode server")
    image?.isTemplate = false
    statusItem.button?.image = image
    statusItem.button?.contentTintColor = running ? NSColor.systemGreen : NSColor.tertiaryLabelColor
    statusItem.button?.toolTip = running ? "OpenCode server — running" : "OpenCode server — stopped"
  }

  func buildMenu() {
    menu.delegate = self
    menu.autoenablesItems = false
    statusMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    toggleMenuItem = NSMenuItem(title: "", action: #selector(toggle), keyEquivalent: "")
    toggleMenuItem.target = self
    urlMenuItem = NSMenuItem(title: "Copy connection URL", action: #selector(copyURL), keyEquivalent: "")
    urlMenuItem.target = self
    menu.addItem(statusMenuItem)
    menu.addItem(toggleMenuItem)
    menu.addItem(urlMenuItem)
    menu.addItem(.separator())
    let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
    login.target = self
    menu.addItem(login)
    let restart = NSMenuItem(title: "Auto-restart on crash", action: #selector(toggleAutoRestart), keyEquivalent: "")
    restart.target = self
    menu.addItem(restart)
    menu.addItem(.separator())
    let pushItem = NSMenuItem(title: "Push notifications", action: #selector(togglePush), keyEquivalent: "")
    pushItem.target = self
    menu.addItem(pushItem)
    let relayItem = NSMenuItem(title: "Set relay…", action: #selector(setRelay), keyEquivalent: "")
    relayItem.target = self
    menu.addItem(relayItem)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit OpenCodeBar", action: #selector(quit), keyEquivalent: "q"))
    refreshMenu()
    statusItem.menu = menu
  }

  func refreshMenu() {
    let running = ServerController.shared.isRunning
    statusMenuItem.title = "OpenCode server — " + (running ? "Running" : "Stopped")
    toggleMenuItem.title = running ? "Stop" : "Start"
    let url = connectionURL()
    urlMenuItem.title = (url != nil) ? "Copy connection URL" : "Copy connection URL (Tailscale not configured)"
    urlMenuItem.isEnabled = (url != nil)
    // checkboxes
    for item in menu.items {
      if item.title.hasPrefix("Start at Login") || item.title == "Start at Login ✓" {
        item.state = loginEnabled() ? .on : .off
        item.title = "Start at Login"
      }
      if item.title.hasPrefix("Auto-restart") {
        item.state = ServerController.shared.autoRestart ? .on : .off
      }
      if item.action == #selector(togglePush) {
        item.state = PushController.shared.pushEnabled ? .on : .off
      }
      if item.action == #selector(setRelay) {
        // Show whether the relay is configured (URL + key present) so the user
        // can tell at a glance why push may not be firing.
        let ready = PushController.shared.isReady()
        item.title = ready ? "Set relay…  ✓" : "Set relay…"
      }
    }
  }

  @objc func stateChanged() {
    refreshStatusItem(); refreshMenu()
    PushController.shared.reevaluate()
  }

  @objc func toggle() {
    if ServerController.shared.isRunning {
      ServerController.shared.stop()
    } else {
      if !ServerController.shared.start() {
        showError(ServerController.shared.lastError ?? "Could not start opencode serve")
      }
    }
    refreshStatusItem(); refreshMenu()
  }

  @objc func copyURL() {
    if let url = connectionURL() {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(url, forType: .string)
    }
  }

  @objc func toggleLogin() {
    if loginEnabled() {
      try? SMAppService.mainApp.unregister()
    } else {
      try? SMAppService.mainApp.register()
    }
    refreshMenu()
  }

  @objc func toggleAutoRestart() {
    ServerController.shared.autoRestart = !ServerController.shared.autoRestart
    refreshMenu()
  }

  /// Toggle push notifications on/off. Persist the flag and (re)start-or-stop the watcher.
  /// Refuses to enable if no relay is configured (prompts the user to set one instead).
  @objc func togglePush() {
    let pc = PushController.shared
    if pc.pushEnabled {
      pc.pushEnabled = false
      pc.stop()
    } else {
      if !pc.isReady() {
        // Surface the relay config dialog instead of silently enabling.
        refreshMenu()
        setRelay()
        // setRelay may have configured things; only enable if ready now.
        if pc.isReady() {
          pc.pushEnabled = true
          pc.start()
        }
      } else {
        pc.pushEnabled = true
        pc.start()
      }
    }
    refreshMenu()
  }

  /// Prompt for the relay URL + API key. Re-evaluates the watcher afterwards so a
  /// newly-configured relay takes effect immediately if push is enabled.
  @objc func setRelay() {
    let pc = PushController.shared
    let alert = NSAlert()
    alert.messageText = "Push relay"
    alert.informativeText = "Sends {title, body} to your relay when an opencode session finishes. Your opencode password never leaves this Mac."
    alert.alertStyle = .informational
    alert.addButton(withTitle: "Save")
    alert.addButton(withTitle: "Cancel")

    let urlField = NSTextField(frame: NSRect(x: 0, y: 32, width: 320, height: 24))
    urlField.placeholderString = "https://push.shathony.fr"
    urlField.stringValue = pc.relayURL
    let keyField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    keyField.placeholderString = "mpr_…"
    keyField.stringValue = pc.apiKey

    let container = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 60))
    container.addSubview(urlField)
    container.addSubview(keyField)
    alert.accessoryView = container

    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    defer {
      NSApp.setActivationPolicy(.accessory)
      refreshStatusItem()
    }
    let response = alert.runModal()
    guard response == .alertFirstButtonReturn else { refreshMenu(); return }

    let url = urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let key = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    pc.relayURL = url
    pc.apiKey = key
    pc.reevaluate()
    refreshMenu()
  }

  @objc func quit() { NSApp.terminate(nil) }

  func loginEnabled() -> Bool { SMAppService.mainApp.status == .enabled }

  func showError(_ msg: String) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    defer { NSApp.setActivationPolicy(.accessory); refreshStatusItem() }
    let a = NSAlert()
    a.messageText = "OpenCodeBar"
    a.informativeText = msg
    a.alertStyle = .warning
    a.addButton(withTitle: "OK")
    a.runModal()
  }
}

extension AppDelegate: NSMenuDelegate {
  func menuNeedsUpdate(_ menu: NSMenu) { refreshMenu() }
}

func runGUI() -> Int32 {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let delegate = AppDelegate()
  app.delegate = delegate
  app.run()
  return 0
}

// MARK: - Entry

exit(cliMode())
