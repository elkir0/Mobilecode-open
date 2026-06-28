// SPDX-License-Identifier: Apache-2.0
import type { SessionView } from "./types.ts"

export interface SnapshotSession {
  id: string
  title: string
  status: string
  updated: number
}

export interface Snapshot {
  activeCount: number
  sessions: SnapshotSession[]
  updatedAt: number
}

const ACTIVE_STATUSES = new Set(["busy", "retry"])

export function buildSnapshot(sessions: SessionView[]): Snapshot {
  return {
    activeCount: sessions.filter((s) => ACTIVE_STATUSES.has(s.status)).length,
    sessions: sessions
      .map((s) => ({ id: s.id, title: s.title, status: s.status, updated: s.updated }))
      .sort((a, b) => b.updated - a.updated),
    updatedAt: Date.now()
  }
}
