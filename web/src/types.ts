// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
export type ServerConfig = {
  host: string
  port: number
  username: string
  password: string
}

export type HealthResponse = {
  healthy: boolean
  version: string
}

export type ModelSelection = {
  providerID: string
  modelID: string
  variant?: string
}

export type AgentOption = {
  id: string
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
}

export type ModelOption = ModelSelection & {
  providerName: string
  modelName: string
  status?: string
  contextLimit?: number
  outputLimit?: number
  tools?: boolean
  attachments?: boolean
  isDefault?: boolean
}

export type Session = {
  id: string
  title: string
  directory: string
  time: {
    created: number
    updated: number
  }
  summary?: {
    additions: number
    deletions: number
    files: number
  }
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  project?: {
    id: string
    name?: string
    worktree: string
  } | null
  /** Share link set by `POST /session/:id/share` (spec §6.3 / mock). Null when unshared. */
  share?: {
    url: string
    time?: number
  } | null
}

export type SessionStatus = {
  type: string
  attempt?: number
  message?: string
  next?: number
}

/**
 * State of a tool-execution part.
 *
 * Mirrors the opencode `Part.Tool.State` shape: a status lifecycle plus the
 * (best-effort, server-dependent) input/output/error payload. Kept permissive
 * (`unknown`) so the client never breaks when the server enriches it.
 */
export type ToolPartState = {
  status: "pending" | "running" | "completed" | "error"
  input?: unknown
  output?: unknown
  error?: string
  title?: string
  time?: {
    start?: number
    end?: number
  }
}

/**
 * A single part of a message.
 *
 * opencode emits many part kinds (text, reasoning, tool, file, step-start/finish,
 * …). To stay forward-compatible with the full API (spec §4) AND keep the existing
 * App.tsx build green (which reads `part.type === "text"` and `part.text`), this
 * is intentionally a PERMISSIVE typed object — NOT a strict discriminated union.
 *
 * Any unknown discriminant still type-checks, while the known fields are typed
 * for the upcoming rich-rendering UI (tool parts → amber, reasoning → collapsible,
 * file parts → chip). A later UI workflow can narrow on `type` at render time.
 */
export type MessagePart = {
  id: string
  type: string
  // Text-bearing parts (text, reasoning, …)
  text?: string
  // Tool parts
  tool?: string
  state?: ToolPartState
  // File parts
  mime?: string
  filename?: string
  url?: string
  source?: unknown
  // Reasoning parts may carry their own payload
  reasoning?: string
  // Catch-all for server-injected metadata the client passes through
  metadata?: unknown
  // Optional time window (step/tool parts)
  time?: {
    start?: number
    end?: number
  }
  // Forward-compat: opencode adds new part fields over time
  [k: string]: unknown
}

export type MessageEnvelope = {
  info: {
    id: string
    role: string
    sessionID: string
    time: {
      created: number
      completed?: number
    }
  }
  parts: MessagePart[]
}

export type TodoItem = {
  content: string
  status: string
  priority: string
  id: string
}

export type DiffFile = {
  file: string
  additions: number
  deletions: number
}

export type ProjectCurrent = Record<string, unknown> & {
  name?: string
  path?: string
  directory?: string
  root?: string
}

export type VcsStatus = Record<string, unknown> & {
  branch?: string
  status?: string
  ahead?: number
  behind?: number
}

export type FileStatusEntry = Record<string, unknown> & {
  path?: string
  file?: string
  status?: string
}

export type FileEntry = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored?: boolean
}

export type PathInfo = {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

export type ProjectDashboard = {
  project: ProjectCurrent | null
  vcs: VcsStatus | null
  files: FileStatusEntry[]
}

export type SessionView = {
  id: string
  title: string
  directory: string
  updated: number
  status: string
  files: number
  additions: number
  deletions: number
  model?: ModelSelection
}

export type CommandInfo = {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
}

// ---------------------------------------------------------------------------
// Types for the full opencode API surface (spec §4 + https://opencode.ai/docs/fr/server/)
// Added for endpoint alignment. All shapes are best-effort: known fields are
// typed, an index signature accepts server-injected extras so the client never
// breaks when opencode enriches a response.
// ---------------------------------------------------------------------------

/** Reply to a tool permission request (`POST /session/:id/permissions/:permissionID`). */
export type PermissionReply = "once" | "always" | "reject"

/**
 * A pending permission request surfaced by the server for a session.
 * `action` is the tool name requesting approval; `resources` describes what it
 * wants to touch (paths, commands, … — server-defined shape).
 */
export type PermissionRequest = {
  id: string
  action: string
  resources?: unknown
  sessionID?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// opencode Question system (multiple-choice human-in-the-loop) — distinct from
// permissions. The agent asks N questions; the user answers each with one or
// more option labels (or custom text). Mirrors packages/schema/src/v1/question.ts.
// ---------------------------------------------------------------------------
export type QuestionOption = { label: string; description: string }
export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  /** default true on opencode — allow a typed "Other" answer. */
  custom?: boolean
}
/** Payload of the `question.asked` event / an item of `GET /question`. */
export type QuestionRequest = {
  id: string
  sessionID?: string
  questions: QuestionInfo[]
  tool?: { messageID?: string; callID?: string }
  [k: string]: unknown
}
/** Selected option labels for a single question (the reply is `QuestionAnswer[]`). */
export type QuestionAnswer = string[]

/** Response of `GET /file/content?path=` — file body as text or base64 binary. */
export type FileContent = {
  type: "text" | "binary"
  content?: string
  data?: string
  encoding?: string
  patch?: string
  [k: string]: unknown
}

/** A single match from `GET /find?pattern=` (content search). */
export type FindMatch = {
  path: string
  lines?: unknown
  line_number?: number
  absolute_offset?: number
  submatches?: unknown[]
  [k: string]: unknown
}

/** Options for `GET /find/file?query=` (filename search). */
export type FindFileOptions = {
  type?: "file" | "directory"
  directory?: string
  limit?: number
  /** Legacy flag: `"false"` returns only files (no directories). */
  dirs?: string
}

/** A workspace symbol from `GET /find/symbol?query=` (LSP-backed). */
export type SymbolInfo = {
  name?: string
  kind?: string
  path?: string
  line?: number
  [k: string]: unknown
}

/**
 * A provider entry from `GET /provider` (richer than `/config/providers`).
 * `models` maps modelID → model descriptor (best-effort, server-defined).
 */
export type ProviderInfo = {
  id: string
  name?: string
  models?: Record<string, unknown>
  [k: string]: unknown
}

/** Response of `GET /provider`: all providers, the default model map, and which are connected. */
export type ProviderListResult = {
  all: ProviderInfo[]
  default: Record<string, string>
  connected: string[]
}

/** A single MCP server status entry (value of the `{[name]: MCPStatus}` map from `GET /mcp`). */
export type MCPStatus = {
  name?: string
  status?: string
  [k: string]: unknown
}

/** A single LSP server status entry from `GET /lsp` (returns `LSPStatus[]`). */
export type LSPStatus = {
  name?: string
  status?: string
  [k: string]: unknown
}

/** A single formatter status entry from `GET /formatter` (returns `FormatterStatus[]`). */
export type FormatterStatus = {
  name?: string
  status?: string
  [k: string]: unknown
}

/** A project entry from `GET /project` (returns `Project[]`). */
export type ProjectInfo = {
  id?: string
  name?: string
  path?: string
  worktree?: string
  [k: string]: unknown
}

/**
 * Server configuration from `GET /config` / `PATCH /config`.
 * opencode's Config is a large, evolving object — typed best-effort: a few
 * commonly-consumed fields are surfaced, the rest passes through as a record.
 */
export type ConfigInfo = Record<string, unknown> & {
  model?: string
  agent?: string
  permission?: string
  autoupdate?: boolean
}
