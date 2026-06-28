// SPDX-License-Identifier: Apache-2.0
import type { Plugin } from "@capacitor/core"

export interface LiveActivityPlugin extends Plugin {
  startActivity(opts: { sessionID: string; title?: string; status?: string; detail?: string; progress?: number }): Promise<void>
  updateActivity(opts: { sessionID: string; title?: string; status?: string; detail?: string; progress?: number }): Promise<void>
  endActivity(opts: { sessionID: string }): Promise<void>
}
