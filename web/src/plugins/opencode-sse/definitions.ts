// SPDX-License-Identifier: Apache-2.0
import type { Plugin, PluginListenerHandle } from "@capacitor/core"

export interface SSEConnectOptions {
  url: string
  basicAuth?: string
  acceptSelfSigned?: boolean
}

export interface SSEStatePayload { state: "connecting" | "connected" | "reconnecting" | "offline" | "error"; error?: string }
export interface SSEEventPayload { type: string; data: unknown }

export interface OpenCodeSSEPlugin extends Plugin {
  connect(opts: SSEConnectOptions): Promise<void>
  disconnect(): Promise<void>
  addListener(eventName: "opencode:event", listener: (e: SSEEventPayload) => void): Promise<PluginListenerHandle>
  addListener(eventName: "opencode:state", listener: (s: SSEStatePayload) => void): Promise<PluginListenerHandle>
}
