// SPDX-License-Identifier: Apache-2.0
// LiveActivity plugin (ActivityKit). Drives a Live Activity from JS based on
// session busy/idle transitions. iOS 16.1+. No-op below 16.1.
import Foundation
import Capacitor
#if canImport(ActivityKit)
import ActivityKit
#endif

@objc(LiveActivity)
public class LiveActivity: CAPPlugin {
  // Type-erased storage: [sessionID: Activity<OpenCodeActivityAttributes>] held as Any,
  // because ActivityKit types require iOS 16.1+ and cannot annotate a stored property.
  private var activities: [String: Any] = [:]

  @objc func startActivity(_ call: CAPPluginCall) {
    guard let sessionID = call.getString("sessionID") else { call.reject("missing sessionID"); return }
    let title = call.getString("title") ?? "Session"
    let status = call.getString("status") ?? "busy"
    let detail = call.getString("detail") ?? "Working…"
    // progress: optional 0...1 fraction; omit/null → -1 (no progress bar).
    let progress: Double = call.getValue("progress") != nil ? (call.getDouble("progress") ?? -1) : -1
    #if canImport(ActivityKit)
    guard #available(iOS 16.1, *) else { call.resolve(); return }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { call.resolve(); return }
    if activities[sessionID] != nil { update(sessionID, title, status, detail, progress); call.resolve(); return }
    let attrs = OpenCodeActivityAttributes(sessionID: sessionID)
    let state = OpenCodeActivityAttributes.ContentState(title: title, status: status, detail: detail, progress: progress)
    do {
      let activity: Activity<OpenCodeActivityAttributes> = try Activity.request(attributes: attrs, contentState: state, pushType: nil)
      activities[sessionID] = activity
      call.resolve()
    } catch {
      call.reject("cannot start activity: \(error.localizedDescription)")
    }
    #else
    call.resolve()
    #endif
  }

  @objc func updateActivity(_ call: CAPPluginCall) {
    guard let sessionID = call.getString("sessionID") else { call.reject("missing sessionID"); return }
    let title = call.getString("title") ?? "Session"
    let status = call.getString("status") ?? "busy"
    let detail = call.getString("detail") ?? "Working…"
    let progress: Double = call.getValue("progress") != nil ? (call.getDouble("progress") ?? -1) : -1
    #if canImport(ActivityKit)
    guard #available(iOS 16.1, *) else { call.resolve(); return }
    update(sessionID, title, status, detail, progress)
    #endif
    call.resolve()
  }

  @objc func endActivity(_ call: CAPPluginCall) {
    guard let sessionID = call.getString("sessionID") else { call.reject("missing sessionID"); return }
    #if canImport(ActivityKit)
    guard #available(iOS 16.1, *) else { call.resolve(); return }
    if let raw = activities[sessionID] {
      let activity = raw as! Activity<OpenCodeActivityAttributes>
      Task {
        if #available(iOS 16.2, *) {
          await activity.end(nil, dismissalPolicy: .immediate)
        } else {
          await activity.end(using: nil, dismissalPolicy: .immediate)
        }
      }
      activities.removeValue(forKey: sessionID)
    }
    #endif
    call.resolve()
  }

  #if canImport(ActivityKit)
  @available(iOS 16.1, *)
  private func update(_ sessionID: String, _ title: String, _ status: String, _ detail: String, _ progress: Double) {
    guard let raw = activities[sessionID] else { return }
    let activity = raw as! Activity<OpenCodeActivityAttributes>
    let state = OpenCodeActivityAttributes.ContentState(title: title, status: status, detail: detail, progress: progress)
    Task { await activity.update(using: state) }
  }
  #endif
}
