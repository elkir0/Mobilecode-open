// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
import Foundation
import Capacitor
#if canImport(WidgetKit)
import WidgetKit
#endif

private let appGroup = "group.ai.opencode.remote.ios"
private let snapshotKey = "sessions_snapshot"

@objc(SharedSnapshot)
public class SharedSnapshot: CAPPlugin {
    @objc func writeSnapshot(_ call: CAPPluginCall) {
        guard let data = call.getObject("data") else { call.reject("missing data"); return }
        guard let json = try? JSONSerialization.data(withJSONObject: data),
              let suite = UserDefaults(suiteName: appGroup) else {
            call.reject("cannot encode/write snapshot"); return
        }
        suite.set(json, forKey: snapshotKey)
        // Refresh the widget timelines so the home screen updates promptly.
        #if canImport(WidgetKit)
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        #endif
        call.resolve()
    }

    @objc func readSnapshot(_ call: CAPPluginCall) {
        guard let suite = UserDefaults(suiteName: appGroup),
              let data = suite.data(forKey: snapshotKey),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            call.resolve()  // resolve with no value → null
            return
        }
        call.resolve(obj)
    }

    // Static reader for the Widget Extension (no Capacitor bridge there).
    public static func readSnapshotData() -> Data? {
        guard let suite = UserDefaults(suiteName: appGroup) else { return nil }
        return suite.data(forKey: snapshotKey)
    }
}
