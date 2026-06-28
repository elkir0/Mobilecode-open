// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
import type { EventSource, ServerConfigLike, SSEEvent, SSEState } from "./event-source.ts"
import { createSSEEventSource } from "./sse.ts"

export interface StoreState {
  // The store normalizes transport "error" into "reconnecting"/"offline",
  // so listeners never observe the raw "error" state.
  connection: Exclude<SSEState, "error">
  lastError?: string
  // True when at least one tracked session is currently busy (running/active).
  // Drives adaptive polling: 1s when busy, 5s when idle. Updated from BOTH the
  // SSE event stream (session.status) and the polled session statuses (see
  // markSessionStatus / syncBusyFromStatuses), so the UI's polling interval can
  // read this even when the Tailscale Serve proxy buffers session-scoped SSE.
  hasBusySessions?: boolean
}

export interface StoreOptions {
  eventSourceFactory?: (config: ServerConfigLike) => EventSource
  // Called when an SSE event implies a session changed (list/detail refresh trigger).
  onSessionActivity?: (event: SSEEvent) => void
  // Called when a tracked session transitions busy -> idle (notification trigger).
  onSessionCompleted?: (sessionID: string) => void
}

// ---------------------------------------------------------------------------
// Adaptive polling (spec §5).
//
// The polling loop itself lives in App.tsx (setInterval in the connection
// useEffect). App.tsx is owned by a later UI workflow, so the store only
// exposes the *policy* — a pure helper returning the interval in ms — plus the
// busy-tracking that feeds it. The UI workflow wires the setInterval period to
// adaptivePollIntervalMs() (read every tick, see below).
//
//   1000 ms  — ≥1 followed/open session is busy (status busy or retry)
//   5000 ms  — idle, app in foreground
//   20000 ms — idle, app in background (document.hidden) — same as before
// ---------------------------------------------------------------------------

/** Polling interval (ms) for the foreground/background polling loop. */
export const POLL_INTERVAL_BUSY_MS = 1000
export const POLL_INTERVAL_IDLE_MS = 5000
export const POLL_INTERVAL_BACKGROUND_MS = 20000

/**
 * Pure helper returning the adaptive polling interval in milliseconds.
 *
 * @param state    The current StoreState (or any object with hasBusySessions).
 * @param options  Optional hints the loop already knows about:
 *                 - background: true when the document/app is hidden. When true
 *                   the loop slows to POLL_INTERVAL_BACKGROUND_MS regardless of
 *                   busy state (backgrounded apps shouldn't hammer the server).
 *
 * The UI workflow must call this on EVERY tick and reschedule the next
 * setTimeout with the returned value (a fixed setInterval cannot adapt — see
 * the wiring snippet in the return message / spec §5).
 */
export function adaptivePollIntervalMs(
  state: Pick<StoreState, "hasBusySessions"> | { hasBusySessions?: boolean },
  options: { background?: boolean } = {},
): number {
  if (options.background) return POLL_INTERVAL_BACKGROUND_MS
  return state.hasBusySessions ? POLL_INTERVAL_BUSY_MS : POLL_INTERVAL_IDLE_MS
}

export function createStore(opts: StoreOptions = {}) {
  type Listener = (s: StoreState) => void
  const listeners = new Set<Listener>()
  let state: StoreState = { connection: "offline" }
  let source: EventSource | null = null
  let errorStreak = 0
  const busySessions = new Set<string>()

  function emit(next: Partial<StoreState>) {
    state = { ...state, ...next }
    listeners.forEach(l => l(state))
  }

  // Emits a hasBusySessions snapshot iff it actually changed. Called from both
  // the SSE handler and the polled-status syncer so the adaptive interval
  // reflects reality whichever transport delivered the status.
  function emitBusyIfChanged() {
    const next = busySessions.size > 0
    if (next !== !!state.hasBusySessions) emit({ hasBusySessions: next })
  }

  function factory(cfg: ServerConfigLike): EventSource {
    return opts.eventSourceFactory ? opts.eventSourceFactory(cfg) : createSSEEventSource()
  }

  function handleEvent(e: SSEEvent) {
    errorStreak = 0
    // opencode SSE events are shaped as { id, type, properties: { sessionID?, status?, ... } }.
    // The event type lives in data.type (not the SSE "event:" header, which defaults to "message").
    const data = (e.data ?? {}) as {
      type?: string
      properties?: { sessionID?: string; status?: { type?: string } }
    }
    const props = data.properties ?? {}
    const sid = props.sessionID
    if (!sid) {
      // Global events (server.connected, heartbeat, etc.) — keep connection
      // liveness handling intact, nothing per-session to do.
      return
    }
    const statusType = props.status?.type
    const wasBusy = busySessions.has(sid)
    if (statusType === "busy" || statusType === "retry") busySessions.add(sid)
    else if (statusType && statusType !== "busy" && statusType !== "retry") busySessions.delete(sid)
    emitBusyIfChanged()
    // Opportunistic instant refresh: when the proxy actually delivers a
    // session-scoped event (session.status / message.part.updated / todo.updated),
    // let the UI refresh immediately instead of waiting for the next poll tick.
    // The store does NOT depend on this (polling remains the source of truth).
    opts.onSessionActivity?.({ type: data.type ?? e.type, data: props as unknown })
    if (wasBusy && !busySessions.has(sid)) opts.onSessionCompleted?.(sid)
  }

  function handleState(s: { state: SSEState; error?: string }) {
    if (s.state === "error") {
      errorStreak += 1
      if (errorStreak >= 3) emit({ connection: "offline", lastError: s.error })
      else emit({ connection: "reconnecting", lastError: s.error })
      return
    }
    if (s.state === "connected") errorStreak = 0
    emit({ connection: s.state, lastError: s.error })
  }

  return {
    subscribe(l: Listener): () => void { listeners.add(l); l(state); return () => listeners.delete(l) },
    getState(): StoreState { return state },
    setConfig(cfg: ServerConfigLike) {
      source?.stop()
      errorStreak = 0
      emit({ connection: "connecting" })
      source = factory(cfg)
      source.start(cfg, handleEvent, handleState)
    },
    clearConfig() { source?.stop(); source = null; busySessions.clear(); emit({ connection: "offline", hasBusySessions: false }) },
    stop() { source?.stop(); source = null; listeners.clear() },
    // ---- Adaptive polling support (spec §5) ---------------------------------
    // These let the UI's poll loop feed polled session statuses back into the
    // store so adaptivePollIntervalMs() reflects busy state even when the SSE
    // proxy buffers session-scoped events (it usually does — CLAUDE.md #4).
    /** True when at least one tracked session is busy/retry. */
    hasBusySessions(): boolean { return busySessions.size > 0 },
    /**
     * Update the busy state for ONE session from a polled status string.
     * Call this each tick for the open/followed sessions (and any whose status
     * the poll just fetched). `status` is the opencode session status type:
     * "busy" | "retry" → busy; anything else (idle/completed/error/...) → not.
     */
    markSessionStatus(sessionID: string, status?: string) {
      if (!sessionID) return
      if (status === "busy" || status === "retry") busySessions.add(sessionID)
      else busySessions.delete(sessionID)
      emitBusyIfChanged()
    },
    /**
     * Bulk-sync busy state from a polled statuses snapshot (e.g. the result of
     * GET /session/status). `statuses` maps sessionID → status type. Sessions
     * NOT present in the map are pruned from the busy set (the snapshot is
     * authoritative for the visible cohort), so a session that disappears from
     * the list no longer pins the interval at 1s.
     */
    syncBusyFromStatuses(statuses: Record<string, string | undefined>) {
      const nextBusy = new Set<string>()
      for (const [sid, status] of Object.entries(statuses ?? {})) {
        if (sid && (status === "busy" || status === "retry")) nextBusy.add(sid)
      }
      // Replace contents in place to keep the Set identity stable.
      busySessions.clear()
      for (const sid of nextBusy) busySessions.add(sid)
      emitBusyIfChanged()
    },
  }
}
