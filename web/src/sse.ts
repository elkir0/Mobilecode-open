// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
import type { EventSource, ServerConfigLike, SSEEvent } from "./event-source.ts"
import { createInMemoryEventSource } from "./event-source.ts"

// Parses a raw SSE text buffer into typed events. Exported for testing.
export function parseSSEStream(raw: string): SSEEvent[] {
  const events: SSEEvent[] = []
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue
    let type = "message"
    const dataLines: string[] = []
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    const dataStr = dataLines.join("\n")
    let data: unknown = dataStr
    try { data = JSON.parse(dataStr) } catch { /* keep as string */ }
    events.push({ type, data })
  }
  return events
}

function authHeader(c: ServerConfigLike): string {
  return `Basic ${btoa(`${c.username}:${c.password}`)}`
}

function eventUrl(c: ServerConfigLike): string {
  const host = c.host.trim()
  const scheme = host.startsWith("https://") ? "https" : host.startsWith("http://") ? "http" : (c.protocol ?? "https")
  const cleanHost = host.replace(/^https?:\/\//, "")
  return `${scheme}://${cleanHost}:${c.port}/event`
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Fetch-based SSE client running in the WKWebView. Kept for connection liveness
// (connected/offline). opencode's /event only emits server heartbeats through the
// Tailscale Serve proxy, so live UI updates rely on the 3s polling in App.tsx.
function createFetchEventSource(): EventSource {
  let stopped = false
  let controller: AbortController | null = null

  return {
    start(config, onEvent, onState) {
      stopped = false
      onState({ state: "connecting" })
      const run = async () => {
        let backoff = 1000
        while (!stopped) {
          controller = new AbortController()
          try {
            const headers: Record<string, string> = { Accept: "text/event-stream" }
            if (config.username) headers.Authorization = authHeader(config)
            const res = await fetch(eventUrl(config), { signal: controller.signal, headers })
            if (!res.ok || !res.body) {
              onState({ state: "error", error: `HTTP ${res.status}` })
              await sleep(backoff); backoff = Math.min(backoff * 2, 30000); continue
            }
            onState({ state: "connected" })
            backoff = 1000
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buf = ""
            while (!stopped) {
              const { done, value } = await reader.read()
              if (done) break
              buf += decoder.decode(value, { stream: true })
              const frames = buf.split("\n\n")
              buf = frames.pop() ?? ""
              for (const frame of frames) {
                if (!frame.trim()) continue
                for (const ev of parseSSEStream(frame + "\n\n")) onEvent(ev)
              }
            }
            if (!stopped) onState({ state: "reconnecting" })
          } catch (err) {
            if (stopped) return
            onState({ state: "error", error: String((err as Error)?.message ?? err) })
            await sleep(backoff); backoff = Math.min(backoff * 2, 30000)
          } finally {
            try { controller?.abort() } catch { /* ignore */ }
          }
        }
      }
      run()
    },
    stop() {
      stopped = true
      try { controller?.abort() } catch { /* ignore */ }
    }
  }
}

export interface CreateSSEOptions { isNative?: boolean }

export function createSSEEventSource(opts: CreateSSEOptions = {}): EventSource {
  // Tests inject isNative:false to get the deterministic in-memory source (no network).
  if (opts.isNative === false) return createInMemoryEventSource()
  return createFetchEventSource()
}
