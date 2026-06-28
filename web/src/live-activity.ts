// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
// Live Activity driver: typed helpers around the LiveActivity Capacitor plugin,
// including progress computation from opencode todo lists. No-op off native platforms.
import { Capacitor } from "@capacitor/core"
import { LiveActivity } from "./plugins/live-activity"
import type { TodoItem } from "./types"

export type SessionStatus = "busy" | "retry" | "idle"

export interface LiveActivityState {
  sessionID: string
  title: string
  status: SessionStatus
  detail: string
  /** 0...1 fraction complete, or -1 to hide the progress bar. */
  progress: number
}

/** Hide the progress bar (no tour/todos data available). */
export const NO_PROGRESS = -1

/**
 * Compute a 0...1 progress fraction from an opencode todo list.
 * Todos whose status is "completed" count as done; any other status counts as
 * pending. Returns -1 when the list is empty/missing so the bar stays hidden.
 */
export function computeProgress(todos: TodoItem[] | null | undefined): number {
  if (!todos || todos.length === 0) return NO_PROGRESS
  const done = todos.filter((t) => (t.status ?? "").toLowerCase() === "completed").length
  if (done === 0) return 0
  if (done >= todos.length) return 1
  return done / todos.length
}

/** Build a short detail string from todos (most recent non-completed item). */
export function detailFromTodos(todos: TodoItem[] | null | undefined, fallback = "Working…"): string {
  if (!todos || todos.length === 0) return fallback
  const pending = todos.find((t) => (t.status ?? "").toLowerCase() !== "completed")
  const label = (pending ?? todos[todos.length - 1]).content
  if (!label) return fallback
  return label.length > 48 ? label.slice(0, 47) + "…" : label
}

function native(): boolean {
  return Capacitor.isNativePlatform()
}

/** Start (or update if already running) the Live Activity for a session. */
export function startActivity(state: LiveActivityState): Promise<void> {
  if (!native()) return Promise.resolve()
  return LiveActivity.startActivity({
    sessionID: state.sessionID,
    title: state.title,
    status: state.status,
    detail: state.detail,
    progress: state.progress,
  }).catch(() => undefined)
}

/** Update an already-running Live Activity (no-op if none exists for the session). */
export function updateActivity(state: LiveActivityState): Promise<void> {
  if (!native()) return Promise.resolve()
  return LiveActivity.updateActivity({
    sessionID: state.sessionID,
    title: state.title,
    status: state.status,
    detail: state.detail,
    progress: state.progress,
  }).catch(() => undefined)
}

/** End the Live Activity for a session. */
export function endActivity(sessionID: string): Promise<void> {
  if (!native()) return Promise.resolve()
  return LiveActivity.endActivity({ sessionID }).catch(() => undefined)
}
