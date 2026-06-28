// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
import { Capacitor, CapacitorHttp } from "@capacitor/core"
import type {
  AgentOption,
  CommandInfo,
  ConfigInfo,
  DiffFile,
  FileContent,
  FileStatusEntry,
  FileEntry,
  FindFileOptions,
  FindMatch,
  FormatterStatus,
  HealthResponse,
  LSPStatus,
  MCPStatus,
  MessageEnvelope,
  ModelOption,
  ModelSelection,
  PathInfo,
  PermissionReply,
  PermissionRequest,
  QuestionRequest,
  ProjectCurrent,
  ProjectInfo,
  ProviderListResult,
  ServerConfig,
  Session,
  SessionStatus,
  SymbolInfo,
  TodoItem,
  VcsStatus
} from "./types"

function authHeader(config: ServerConfig): string {
  return `Basic ${btoa(`${config.username}:${config.password}`)}`
}

function baseUrl(config: ServerConfig): string {
  const host = config.host.trim()
  const schemeMatch = host.match(/^(https?):\/\//)
  const scheme = schemeMatch ? schemeMatch[1] : "http"
  const cleanHost = schemeMatch ? host.slice(schemeMatch[0].length) : host
  return `${scheme}://${cleanHost}:${config.port}`
}

function withDirectory(path: string, directory?: string): string {
  if (!directory) return path
  const joiner = path.includes("?") ? "&" : "?"
  return `${path}${joiner}directory=${encodeURIComponent(directory)}`
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT"
  body?: unknown
  readTimeout?: number
}

type ResponseWithHeaders<T> = {
  data: T
  headers: Record<string, string>
}

function responseDetail(body: unknown): string | null {
  if (!body) return null
  if (typeof body === "string") {
    try {
      return responseDetail(JSON.parse(body)) ?? body
    } catch {
      return body
    }
  }
  if (typeof body === "object") {
    const value = body as { data?: { message?: string }, message?: string }
    return value.data?.message ?? value.message ?? JSON.stringify(body)
  }
  return String(body)
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)])
  )
}

type ConfigProvidersResponse = {
  providers: Array<{
    id: string
    name: string
    models: Record<string, {
      id?: string
      name?: string
      status?: string
      capabilities?: {
        attachment?: boolean
        toolcall?: boolean
        tools?: boolean
      }
      limit?: {
        context?: number
        output?: number
      }
      variants?: Record<string, unknown>
    }>
  }>
  default?: Record<string, string>
}

type AgentResponse = Array<{
  id?: string
  name?: string
  description?: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
}>

async function requestWithHeaders<T>(config: ServerConfig, path: string, options: RequestOptions = {}): Promise<ResponseWithHeaders<T>> {
  const target = `${baseUrl(config)}${path}`

  const headers: Record<string, string> = {
    Accept: "application/json"
  }
  if (config.username && config.password) {
    headers.Authorization = authHeader(config)
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  const method = options.method ?? "GET"

  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.request({
        url: target,
        method,
        headers,
        data: options.body,
        connectTimeout: 12_000,
        readTimeout: options.readTimeout ?? 30_000
      })
    } catch {
      throw new Error(`Network error: cannot reach ${target}. Check host, port, and firewall.`)
    }

    if (response.status >= 400) {
      throw new Error(responseDetail(response.data) || `HTTP ${response.status}`)
    }

    const responseHeaders = normalizeHeaders(response.headers)
    if (response.status === 204) return { data: true as T, headers: responseHeaders }
    return { data: response.data as T, headers: responseHeaders }
  }

  let response: Response
  try {
    response = await fetch(target, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
  } catch {
    const corsHint = config.username && config.password
      ? " Browser mode + Basic Auth may be blocked by CORS preflight; use APK/native mode or disable auth temporarily for browser debugging."
      : ""
    throw new Error(
      `Network error: cannot reach ${target}. Check server hostname/port, Windows firewall, and CORS (--cors).${corsHint}`
    )
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    const text = await response.text().catch(() => "")
    if (text) {
      try {
        detail = responseDetail(JSON.parse(text)) ?? text
      } catch {
        detail = text
      }
    }
    throw new Error(detail)
  }

  const responseHeaders = normalizeHeaders(Object.fromEntries(response.headers.entries()))
  if (response.status === 204) return { data: true as T, headers: responseHeaders }
  return { data: (await response.json()) as T, headers: responseHeaders }
}

async function request<T>(config: ServerConfig, path: string, options: RequestOptions = {}): Promise<T> {
  return (await requestWithHeaders<T>(config, path, options)).data
}

function toAgentOption(agent: AgentResponse[number]): AgentOption {
  const id = agent.id || agent.name || ""
  return {
    id,
    name: agent.name || id,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden
  }
}

function toModelBody(model?: ModelSelection) {
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.modelID }
}

function toCreateSessionModel(model?: ModelSelection) {
  if (!model) return undefined
  return { providerID: model.providerID, id: model.modelID, variant: model.variant || undefined }
}

/**
 * A file attachment to include in a prompt's `parts` array (spec §6.2).
 * opencode's `/prompt_async` parts accept `{type:"file", ...}` entries. We pass
 * EITHER a `source` (server-side path that opencode resolves on the machine —
 * preferred, no upload) OR inline `url`/`data` (a base64 data: URL / remote URL).
 * `mime` + `filename` are surfaced for display + server routing.
 */
export type PromptAttachment = {
  filename: string
  mime: string
  /** Server-resolvable file path (opencode reads it from disk). Preferred. */
  source?: string
  /** Inline content: a `data:` / `http(s):` URL the server can fetch. */
  url?: string
  /** Raw base64 payload (paired with `mime`). Mutually exclusive with `url`. */
  data?: string
}

/** Builds the file part object sent in a prompt's `parts` array. */
function toFilePart(attachment: PromptAttachment) {
  const part: { type: "file"; mime: string; filename: string; source?: string; url?: string; data?: string } = {
    type: "file",
    mime: attachment.mime,
    filename: attachment.filename
  }
  if (attachment.source) part.source = attachment.source
  if (attachment.url) part.url = attachment.url
  if (attachment.data) part.data = attachment.data
  return part
}

export const api = {
  health(config: ServerConfig) {
    return request<HealthResponse>(config, "/global/health")
  },

  listSessions(config: ServerConfig, directory?: string) {
    return request<Session[]>(config, withDirectory("/session", directory))
  },

  async listGlobalSessions(config: ServerConfig) {
    const sessions: Session[] = []
    let cursor: string | undefined
    do {
      const path = cursor ? `/experimental/session?cursor=${encodeURIComponent(cursor)}` : "/experimental/session"
      const response = await requestWithHeaders<Session[]>(config, path)
      sessions.push(...response.data)
      cursor = response.headers["x-next-cursor"]
    } while (cursor)
    return sessions
  },

  listStatuses(config: ServerConfig, directory?: string) {
    return request<Record<string, SessionStatus>>(config, withDirectory("/session/status", directory))
  },

  loadPath(config: ServerConfig, directory?: string) {
    return request<PathInfo>(config, withDirectory("/path", directory))
  },

  listFiles(config: ServerConfig, path: string, directory?: string) {
    return request<FileEntry[]>(config, withDirectory(`/file?path=${encodeURIComponent(path)}`, directory))
  },

  listCommands(config: ServerConfig) {
    return request<CommandInfo[]>(config, "/command")
  },

  async listAgents(config: ServerConfig, directory?: string) {
    const agents = await request<AgentResponse>(config, withDirectory("/agent", directory))
    return agents.map(toAgentOption).filter((agent) => agent.id && !agent.hidden)
  },

  async listModels(config: ServerConfig, directory?: string) {
    const response = await request<ConfigProvidersResponse>(config, withDirectory("/config/providers", directory))
    return response.providers.flatMap((provider) => {
      const defaultModel = response.default?.[provider.id]
      return Object.entries(provider.models).flatMap(([modelID, model]) => {
        const base: ModelOption = {
          providerID: provider.id,
          providerName: provider.name || provider.id,
          modelID: model.id || modelID,
          modelName: model.name || model.id || modelID,
          status: model.status,
          contextLimit: model.limit?.context,
          outputLimit: model.limit?.output,
          tools: Boolean(model.capabilities?.toolcall || model.capabilities?.tools),
          attachments: Boolean(model.capabilities?.attachment),
          isDefault: defaultModel === modelID
        }
        const variantIDs = Object.keys(model.variants ?? {})
        return [
          base,
          ...variantIDs.map((variant) => ({ ...base, variant, isDefault: false }))
        ]
      })
    })
  },

  createSession(config: ServerConfig, title?: string, model?: ModelSelection, directory?: string) {
    return request<Session>(config, withDirectory("/session", directory), { method: "POST", body: { title, model: toCreateSessionModel(model) } })
  },

  renameSession(config: ServerConfig, id: string, title: string, directory?: string) {
    return request<Session>(config, withDirectory(`/session/${id}`, directory), { method: "PATCH", body: { title } })
  },

  deleteSession(config: ServerConfig, id: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${id}`, directory), { method: "DELETE" })
  },

  loadMessages(config: ServerConfig, sessionID: string, directory?: string) {
    return request<MessageEnvelope[]>(config, withDirectory(`/session/${sessionID}/message?limit=100`, directory))
  },

  loadLatestMessage(config: ServerConfig, sessionID: string, directory?: string) {
    return request<MessageEnvelope[]>(config, withDirectory(`/session/${sessionID}/message?limit=1`, directory))
  },

  loadTodo(config: ServerConfig, sessionID: string, directory?: string) {
    return request<TodoItem[]>(config, withDirectory(`/session/${sessionID}/todo`, directory))
  },

  loadDiff(config: ServerConfig, sessionID: string, directory?: string) {
    return request<DiffFile[]>(config, withDirectory(`/session/${sessionID}/diff`, directory))
  },

  loadProjectCurrent(config: ServerConfig, directory?: string) {
    return request<ProjectCurrent>(config, withDirectory("/project/current", directory))
  },

  loadVcs(config: ServerConfig, directory?: string) {
    return request<VcsStatus>(config, withDirectory("/vcs", directory))
  },

  loadFileStatus(config: ServerConfig, directory?: string) {
    return request<FileStatusEntry[] | Record<string, FileStatusEntry>>(config, withDirectory("/file/status", directory))
  },

  sendPrompt(config: ServerConfig, sessionID: string, text: string, directory?: string, model?: ModelSelection, agentID?: string, attachments?: PromptAttachment[]) {
    const parts: Array<{ type: "text"; text: string } | ReturnType<typeof toFilePart>> = [{ type: "text", text }]
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) parts.push(toFilePart(attachment))
    }
    return request<boolean>(config, withDirectory(`/session/${sessionID}/prompt_async`, directory), {
      method: "POST",
      body: { parts, model: toModelBody(model), agent: agentID, variant: model?.variant || undefined }
    })
  },

  sendCommand(config: ServerConfig, sessionID: string, command: string, argumentsText: string, directory?: string, model?: ModelSelection, agentID?: string) {
    return request<MessageEnvelope>(config, withDirectory(`/session/${sessionID}/command`, directory), {
      method: "POST",
      body: { command, arguments: argumentsText, agent: agentID, model: toModelBody(model), variant: model?.variant || undefined },
      readTimeout: 300_000
    })
  },

  abort(config: ServerConfig, sessionID: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${sessionID}/abort`, directory), {
      method: "POST",
      body: {}
    })
  },

  // -------------------------------------------------------------------------
  // Session lifecycle — interactive endpoints (spec §3.1)
  // Paths + bodies per https://opencode.ai/docs/fr/server/ and design §3.1.
  // -------------------------------------------------------------------------

  /** `GET /session/:id` — single session details. */
  getSession(config: ServerConfig, id: string, directory?: string) {
    return request<Session>(config, withDirectory(`/session/${id}`, directory))
  },

  /** `GET /session/:id/children` — child (forked) sessions. */
  getSessionChildren(config: ServerConfig, id: string, directory?: string) {
    return request<Session[]>(config, withDirectory(`/session/${id}/children`, directory))
  },

  /** `GET /session/:id/message/:messageID` — single message details. */
  getMessage(config: ServerConfig, sessionID: string, messageID: string, directory?: string) {
    return request<MessageEnvelope>(config, withDirectory(`/session/${sessionID}/message/${messageID}`, directory))
  },

  /** `POST /session/:id/fork` — fork a session (optionally at a message). */
  forkSession(config: ServerConfig, id: string, messageID?: string, directory?: string) {
    return request<Session>(config, withDirectory(`/session/${id}/fork`, directory), {
      method: "POST",
      body: messageID ? { messageID } : {}
    })
  },

  /** `POST /session/:id/share` — share a session, returns the updated session. */
  shareSession(config: ServerConfig, id: string, directory?: string) {
    return request<Session>(config, withDirectory(`/session/${id}/share`, directory), {
      method: "POST",
      body: {}
    })
  },

  /** `DELETE /session/:id/share` — unshare a session, returns the updated session. */
  unshareSession(config: ServerConfig, id: string, directory?: string) {
    return request<Session>(config, withDirectory(`/session/${id}/share`, directory), {
      method: "DELETE"
    })
  },

  /** `POST /session/:id/revert` — revert to a message (optionally a specific part). */
  revertSession(config: ServerConfig, id: string, messageID: string, partID?: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${id}/revert`, directory), {
      method: "POST",
      body: partID ? { messageID, partID } : { messageID }
    })
  },

  /** `POST /session/:id/unrevert` — restore all reverted messages. */
  unrevertSession(config: ServerConfig, id: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${id}/unrevert`, directory), {
      method: "POST",
      body: {}
    })
  },

  /** `POST /session/:id/summarize` — summarize the session with a model. */
  summarizeSession(config: ServerConfig, id: string, providerID: string, modelID: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${id}/summarize`, directory), {
      method: "POST",
      body: { providerID, modelID }
    })
  },

  /** `POST /session/:id/init` — analyze the app and generate AGENTS.md. */
  initSession(config: ServerConfig, id: string, messageID: string, providerID: string, modelID: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${id}/init`, directory), {
      method: "POST",
      body: { messageID, providerID, modelID }
    })
  },

  /** `POST /session/:id/permissions/:permissionID` — reply to a tool permission request. */
  replyPermission(config: ServerConfig, id: string, permissionID: string, response: PermissionReply, remember?: boolean, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${id}/permissions/${permissionID}`, directory), {
      method: "POST",
      body: remember === undefined ? { response } : { response, remember }
    })
  },

  /** `GET /question` — globally pending Question requests (opencode Question system). */
  listPendingQuestions(config: ServerConfig, directory?: string) {
    return request<QuestionRequest[]>(config, withDirectory("/question", directory))
  },
  /** `POST /question/:requestID/reply` — answer a question. `answers`: one string[] per question, in order. */
  replyQuestion(config: ServerConfig, requestID: string, answers: string[][], directory?: string) {
    return request<boolean>(config, withDirectory(`/question/${requestID}/reply`, directory), {
      method: "POST",
      body: { answers }
    })
  },
  /** `POST /question/:requestID/reject` — decline a question (unblocks the agent). */
  rejectQuestion(config: ServerConfig, requestID: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/question/${requestID}/reject`, directory), {
      method: "POST"
    })
  },

  /** `POST /session/:id/shell` — run a shell command in a session. */
  shell(config: ServerConfig, id: string, command: string, agent: string, model?: ModelSelection, directory?: string) {
    return request<MessageEnvelope>(config, withDirectory(`/session/${id}/shell`, directory), {
      method: "POST",
      body: model ? { agent, model: toModelBody(model), command } : { agent, command },
      readTimeout: 300_000
    })
  },

  // -------------------------------------------------------------------------
  // Files / search (spec §3.2)
  // -------------------------------------------------------------------------

  /** `GET /file/content?path=` — read a file (text or base64 binary). */
  readFile(config: ServerConfig, path: string, directory?: string) {
    return request<FileContent>(config, withDirectory(`/file/content?path=${encodeURIComponent(path)}`, directory))
  },

  /** `GET /find/file?query=` — fuzzy filename/dir search, returns paths. */
  findFile(config: ServerConfig, query: string, opts?: FindFileOptions, directory?: string) {
    const params = new URLSearchParams()
    params.set("query", query)
    if (opts?.type) params.set("type", opts.type)
    if (opts?.directory) params.set("directory", opts.directory)
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit))
    if (opts?.dirs !== undefined) params.set("dirs", opts.dirs)
    return request<string[]>(config, withDirectory(`/find/file?${params.toString()}`, directory))
  },

  /** `GET /find?pattern=` — content (ripgrep-style) search. */
  findContent(config: ServerConfig, pattern: string, directory?: string) {
    return request<FindMatch[]>(config, withDirectory(`/find?pattern=${encodeURIComponent(pattern)}`, directory))
  },

  /** `GET /find/symbol?query=` — LSP-backed workspace symbol search. */
  findSymbol(config: ServerConfig, query: string, directory?: string) {
    return request<SymbolInfo[]>(config, withDirectory(`/find/symbol?query=${encodeURIComponent(query)}`, directory))
  },

  // -------------------------------------------------------------------------
  // Monitoring / data (spec §3.3)
  // -------------------------------------------------------------------------

  /** `GET /provider` — all providers, default model map, and connected set. */
  listProviders(config: ServerConfig, directory?: string) {
    return request<ProviderListResult>(config, withDirectory("/provider", directory))
  },

  /** `GET /provider/auth` — auth methods per provider. */
  providerAuthMethods(config: ServerConfig, directory?: string) {
    return request<Record<string, Array<Record<string, unknown>>>>(config, withDirectory("/provider/auth", directory))
  },

  /** `GET /project` — list all known projects. */
  listProjects(config: ServerConfig, directory?: string) {
    return request<ProjectInfo[]>(config, withDirectory("/project", directory))
  },

  /** `GET /mcp` — MCP server status (name → status map). */
  mcpStatus(config: ServerConfig, directory?: string) {
    return request<Record<string, MCPStatus>>(config, withDirectory("/mcp", directory))
  },

  /** `GET /lsp` — LSP server status entries. */
  lspStatus(config: ServerConfig, directory?: string) {
    return request<LSPStatus[]>(config, withDirectory("/lsp", directory))
  },

  /** `GET /formatter` — formatter status entries. */
  formatterStatus(config: ServerConfig, directory?: string) {
    return request<FormatterStatus[]>(config, withDirectory("/formatter", directory))
  },

  /** `GET /config` — server configuration. */
  getConfig(config: ServerConfig, directory?: string) {
    return request<ConfigInfo>(config, withDirectory("/config", directory))
  },

  /** `PATCH /config` — partial config update, returns the updated config. */
  patchConfig(config: ServerConfig, cfg: ConfigInfo, directory?: string) {
    return request<ConfigInfo>(config, withDirectory("/config", directory), {
      method: "PATCH",
      body: cfg
    })
  },

  /** `PUT /auth/:id` — set credentials for a provider. */
  setAuth(config: ServerConfig, providerID: string, info: Record<string, unknown>, directory?: string) {
    return request<boolean>(config, withDirectory(`/auth/${encodeURIComponent(providerID)}`, directory), {
      method: "PUT",
      body: info
    })
  },

  /** `POST /log` — write a log entry on the server. */
  log(config: ServerConfig, service: string, level: string, message: string, extra?: Record<string, unknown>) {
    return request<boolean>(config, "/log", {
      method: "POST",
      body: extra ? { service, level, message, extra } : { service, level, message }
    })
  },

  /** `GET /session/:id` enriched — surfaces pending permission requests. Used by store.ts polling. */
  getPermissionRequests(config: ServerConfig, id: string, directory?: string) {
    return request<PermissionRequest[]>(config, withDirectory(`/session/${id}/permissions`, directory))
  },

  /**
   * `GET /permission` — globally pending tool-permission requests (spec §6.1).
   * Returns `PermissionRequest[]` (server-scoped or filtered by `directory`).
   * DEFENSIVE: some servers / the local mock don't implement this route and 404.
   * Callers MUST `.catch(() => [])` so a missing endpoint never crashes the UI.
   * The App filters the result by `sessionID === openSessionID` before showing
   * the permission banner.
   */
  listPendingPermissions(config: ServerConfig, directory?: string) {
    return request<PermissionRequest[]>(config, withDirectory("/permission", directory))
  }
}
