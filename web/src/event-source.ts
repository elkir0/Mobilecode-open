// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.

export type SSEState = "connecting" | "connected" | "reconnecting" | "offline" | "error"

export interface SSEEvent {
  type: string
  data: unknown
}

export interface ServerConfigLike {
  host: string
  port: number
  username: string
  password: string
  protocol?: "https" | "http"
  acceptSelfSigned?: boolean
}

export interface EventSource {
  start(config: ServerConfigLike, onEvent: (e: SSEEvent) => void, onState: (s: { state: SSEState; error?: string }) => void): void
  stop(): void
}

// Used by tests and as a fallback when no native plugin is present (web/dev).
export function createInMemoryEventSource(): EventSource & {
  push(e: SSEEvent): void
  setState(state: SSEState, error?: string): void
} {
  let onEvent: ((e: SSEEvent) => void) | null = null
  let onState: ((s: { state: SSEState; error?: string }) => void) | null = null
  let started = false
  return {
    start(_config, ev, st) {
      onEvent = ev
      onState = st
      started = true
      onState?.({ state: "connecting" })
    },
    push(e) { if (started) onEvent?.(e) },
    setState(state, error) { if (started) onState?.({ state, error }) },
    stop() { started = false; onEvent = null; onState = null }
  }
}
