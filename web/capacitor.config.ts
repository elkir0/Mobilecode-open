// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "ai.opencode.remote.ios",
  appName: "Mobilecode",
  webDir: "dist",
  ios: {
    path: "../ios",
    scheme: "OpenCodeRemote"
  },
  server: {
    iosScheme: "https",
    cleartext: true
  },
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_icon",
      iconColor: "#ffffff",
      sound: "staplebops-01.caf"
    }
  }
}

export default config
