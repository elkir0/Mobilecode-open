// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

// Shared Live Activity attributes + state. This file is compiled into BOTH the
// App target (to start/update/end activities) and the Widget Extension (to render).
struct OpenCodeActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var title: String
    var status: String       // "busy" | "retry" | "idle"
    var detail: String       // short progress text (e.g. last todo or "Working…")
    var progress: Double     // 0...1 (fraction done); -1 hides the progress bar.
    init(title: String, status: String, detail: String, progress: Double = -1) {
      self.title = title; self.status = status; self.detail = detail; self.progress = progress
    }
  }
  var sessionID: String
}
