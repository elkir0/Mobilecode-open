// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
import { useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api, type PromptAttachment } from "./api"
import { createStore, adaptivePollIntervalMs, type StoreState } from "./store"
import { createTranslator, languageOptions, normalizeLanguage, type LanguageCode } from "./i18n"
import type { AgentOption, CommandInfo, ConfigInfo, DiffFile, FileEntry, FileStatusEntry, FormatterStatus, LSPStatus, MCPStatus, MessageEnvelope, MessagePart, ModelOption, ModelSelection, PathInfo, PermissionReply, PermissionRequest, QuestionRequest, ProjectDashboard, ProviderListResult, ServerConfig, Session, SessionStatus, SessionView, TodoItem } from "./types"
import {
  SettingsIcon,
  FolderIcon,
  ChatIcon,
  HelpIcon,
  PlusIcon,
  PlayIcon,
  TrashIcon,
  StopCircleIcon,
  SendIcon,
  SaveIcon,
  TestIcon,
  LoadingIcon,
  RefreshIcon,
  CloseIcon,
  CheckIcon,
  CrossIcon,
  CircleIcon,
  PaperclipIcon,
  MicIcon,
  FileIcon,
  LinkIcon,
  SparkleIcon,
  PencilIcon,
  WarningIcon,
  ClipboardIcon,
  BoltIcon,
  BellIcon,
  WrenchIcon,
  GlobeIcon,
  LockIcon,
  SearchIcon,
  ActivityIcon,
  UserIcon,
  RobotIcon,
  ChevronLeftIcon
} from "./Icons"
import { TerminalConsole } from "./terminal"
import { Sidebar } from "./sidebar"
import { Inspector, type DiagSnapshot } from "./inspector"
import { CommandPalette, type CommandItem } from "./command-palette"
import { QuestionPrompt } from "./question-prompt"
import { LocalNotifications } from "@capacitor/local-notifications"
import { PushNotifications } from "@capacitor/push-notifications"
import { Haptics, NotificationType } from "@capacitor/haptics"
import { shouldNotify } from "./feedback"
import { Capacitor } from "@capacitor/core"
import { SharedSnapshot } from "./plugins/shared-snapshot"
import { Speech } from "./plugins/speech"
import { buildSnapshot } from "./snapshot"
import {
  startActivity as startLiveActivity,
  updateActivity as updateLiveActivity,
  endActivity as endLiveActivity,
  computeProgress,
  detailFromTodos,
} from "./live-activity"
import {
  loadFxSettings,
  saveFxSettings,
  applyFxSettings,
  initMatrixFx,
  setFxEnabled,
  cycleRainLevel,
  type FxSettings,
} from "./matrix-fx"
import { decodeText, isDecodeEnabled } from "./decode"

const STORAGE_KEY = "opencode.remote.server"
const LANGUAGE_STORAGE_KEY = "opencode.remote.language"
const MODEL_STORAGE_KEY = "opencode.remote.model"
const AGENT_STORAGE_KEY = "opencode.remote.agent"
const THEME_STORAGE_KEY = "opencode.remote.theme"
const SKIN_STORAGE_KEY = "opencode_remote_skin"
// iPad landscape: persist the sessions-sidebar collapsed state (design doc §4).
const SIDEBAR_COLLAPSED_STORAGE_KEY = "opencode_remote_sidebar"
// One-time flag: the Matrix rain was auto-softened to "low" on a large canvas.
const FX_AUTODEGRADED_STORAGE_KEY = "opencode_remote_fx_autodegraded"
const NEW_SESSION_DIRECTORY_STORAGE_KEY = "opencode.remote.newSessionDirectory"
// Push relay (APNs relay) — user-entered URL + API key. Stored in localStorage
// exactly like the server password; never hardcoded, never in source.
const PUSH_RELAY_URL_STORAGE_KEY = "opencode.remote.pushRelayUrl"
const PUSH_RELAY_APIKEY_STORAGE_KEY = "opencode.remote.pushRelayApiKey"

const defaultConfig: ServerConfig = {
  host: "",
  port: 4096,
  username: "opencode",
  password: ""
}

function formatTime(epoch: number): string {
  if (!epoch) return "-"
  const d = new Date(epoch)
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  // Same day → time only; otherwise a compact day/month + time.
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`
}

function extractText(msg: MessageEnvelope): string {
  return msg.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function assistantPayloadLength(items: MessageEnvelope[]): number {
  return items
    .filter((message) => message.info.role !== "user")
    .reduce((sum, message) => sum + extractText(message).length, 0)
}

function normalizeMessageMarkdown(text: string): string {
  return text.includes("\n") ? text : text.replace(/\s-\s(?=\S)/g, "\n- ")
}

function toFileStatusList(input: FileStatusEntry[] | Record<string, FileStatusEntry>): FileStatusEntry[] {
  if (Array.isArray(input)) return input
  return Object.entries(input).map(([path, value]) => ({ path, ...value }))
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function summarizeJson(value: unknown): string {
  if (value === null || value === undefined) return "-"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function configKey(config: ServerConfig): string {
  return JSON.stringify({
    host: config.host.trim(),
    port: config.port,
    username: config.username.trim(),
    password: config.password
  })
}

function canTestConfig(config: ServerConfig): boolean {
  return Boolean(config.host.trim() && config.port > 0 && config.username.trim())
}

function modelKey(model: ModelSelection): string {
  return [model.providerID, model.modelID, model.variant ?? ""].map(encodeURIComponent).join("|")
}

function modelFromKey(value: string | null): ModelSelection | null {
  if (!value) return null
  const [providerID, modelID, variant] = value.split("|").map((part) => decodeURIComponent(part))
  if (!providerID || !modelID) return null
  return { providerID, modelID, variant: variant || undefined }
}

function sameModel(a: ModelSelection | null | undefined, b: ModelSelection | null | undefined): boolean {
  return Boolean(a && b && a.providerID === b.providerID && a.modelID === b.modelID && (a.variant ?? "") === (b.variant ?? ""))
}

function modelSearchText(option: ModelOption): string {
  return [option.modelName, option.modelID, option.providerName, option.providerID, option.variant ?? ""].join(" ").toLowerCase()
}

function agentLabel(agent: AgentOption): string {
  return agent.name || agent.id
}

function normalizeDirectory(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isProjectDirectory(pathInfo: PathInfo): boolean {
  return pathInfo.worktree !== "/"
}

function messageActivityTime(message: MessageEnvelope): number {
  return Math.max(message.info.time.created, message.info.time.completed ?? 0)
}

function toSessionView(session: Session, status?: SessionStatus, activityTime = session.time.updated): SessionView {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory,
    updated: activityTime,
    status: status?.type ?? "idle",
    files: session.summary?.files ?? 0,
    additions: session.summary?.additions ?? 0,
    deletions: session.summary?.deletions ?? 0,
    model: session.model ? { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant } : undefined
  }
}

function formatLimit(value?: number): string {
  if (!value) return "-"
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

/**
 * Best-effort MIME guess from a filename's extension (spec §6.2). Falls back to
 * `application/octet-stream`. Text-ish types (md, txt, json, ts, tsx, js, py…)
 * map to `text/plain` so opencode can inline the content; everything else is
 * treated as a binary blob and sent by path/source only.
 */
function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  const textExt = new Set([
    "md", "markdown", "txt", "text", "log", "json", "jsonc", "yaml", "yml",
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
    "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh",
    "toml", "ini", "cfg", "conf", "env", "gitignore", "css", "scss", "less",
    "html", "htm", "xml", "sql", "graphql", "gql", "dockerfile", "makefile"
  ])
  if (!ext || textExt.has(ext)) return "text/plain"
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
    csv: "text/csv", zip: "application/zip", gz: "application/gzip",
    tar: "application/x-tar"
  }
  return map[ext] ?? "application/octet-stream"
}

/** Stable key for an attachment (filename + path/source, capped). */
function attachKey(attachment: PromptAttachment): string {
  return `${attachment.filename}::${attachment.source ?? attachment.url ?? attachment.data ?? ""}`
}

/** Display name for a FileEntry in the picker — name plus a dimmed tail of its path. */
function fileEntryLabel(entry: FileEntry): string {
  return entry.name
}

function createOptimisticUserMessage(sessionID: string, text: string): MessageEnvelope {
  const now = Date.now()
  return {
    info: {
      id: `optimistic-${now}`,
      role: "user",
      sessionID,
      time: { created: now }
    },
    parts: [
      {
        id: `optimistic-part-${now}`,
        type: "text",
        text
      }
    ]
  }
}

function createLocalAssistantMessage(sessionID: string, text: string): MessageEnvelope {
  const now = Date.now()
  return {
    info: {
      id: `local-assistant-${now}`,
      role: "assistant",
      sessionID,
      time: { created: now, completed: now }
    },
    parts: [
      {
        id: `local-assistant-part-${now}`,
        type: "text",
        text
      }
    ]
  }
}

function hasMatchingUserMessage(messages: MessageEnvelope[], optimistic: MessageEnvelope): boolean {
  const text = extractText(optimistic)
  return messages.some((message) => (
    message.info.sessionID === optimistic.info.sessionID &&
    message.info.role === "user" &&
    extractText(message) === text
  ))
}

/**
 * Render a single non-text message part by its type (spec §6.4).
 *   tool      → amber entry with tool name + state; completed ⇒ collapsible
 *               JSON output; error ⇒ red error text.
 *   reasoning → muted, italic, collapsible (collapsed by default).
 *   file      → chip with filename + mime.
 * Text parts are rendered separately via ReactMarkdown by the caller.
 * Unknown part types are skipped (forward-compatible — the MessagePart type is
 * intentionally permissive). Matrix-themed: amber tools reuse --mx-tool, muted
 * reasoning reuses the dim phosphor green palette.
 */
function renderMessagePart(part: MessagePart) {
  if (part.type === "tool") {
    const state = part.state
    const status = state?.status
    const isError = status === "error"
    const label = part.tool ?? "tool"
    const glyph = status === "running" ? "⟳"
      : "…"
    return (
      <div key={part.id} className={`part-tool${status ? ` is-${status}` : ""}`}>
        <span className="part-tool-glyph" aria-hidden="true">{status === "completed" ? <CheckIcon size={14} /> : status === "error" ? <CrossIcon size={14} /> : glyph}</span>
        <span className="part-tool-name">{label}</span>
        {status && <span className="part-tool-status">{status}</span>}
        {isError && state?.error && (
          <div className="part-tool-error">{state.error}</div>
        )}
        {!isError && status === "completed" && state?.output !== undefined && (
          <details className="part-tool-output">
            <summary>output</summary>
            <pre>{JSON.stringify(state.output, null, 2)}</pre>
          </details>
        )}
      </div>
    )
  }
  if (part.type === "reasoning") {
    const body = part.reasoning || part.text
    if (!body) return null
    return (
      <details key={part.id} className="part-reasoning">
        <summary>reasoning</summary>
        <div className="part-reasoning-body">{body}</div>
      </details>
    )
  }
  if (part.type === "file") {
    const name = part.filename ?? "file"
    const mime = part.mime ?? "file"
    return (
      <span key={part.id} className="part-file" title={part.url ?? undefined}>
        <span className="part-file-glyph" aria-hidden="true"><PaperclipIcon size={14} /></span>
        <span className="part-file-name">{name}</span>
        <small className="part-file-mime">{mime}</small>
      </span>
    )
  }
  return null
}

/**
 * Render a compact, human-readable summary of a permission request's `resources`
 * for the banner (spec §6.1). `resources` is server-defined — commonly a path
 * string, an array of paths, or an object like { paths: [...], command: "..." }.
 * Returns null when there's nothing useful to show.
 */
function describePermissionResources(request: PermissionRequest): string | null {
  const resources = request.resources
  if (resources == null) return null
  if (typeof resources === "string") return resources.trim() || null
  if (Array.isArray(resources)) {
    const flat = resources.flatMap((item) => (typeof item === "string" ? [item] : []))
    if (flat.length === 0) return null
    return flat.slice(0, 3).join(", ") + (flat.length > 3 ? `, +${flat.length - 3}` : "")
  }
  if (typeof resources === "object") {
    const obj = resources as Record<string, unknown>
    const paths = obj.paths ?? obj.path ?? obj.command ?? obj.commands
    if (typeof paths === "string") return paths
    if (Array.isArray(paths)) return describePermissionResources({ ...request, resources: paths })
  }
  return null
}

/**
 * Classify a server status string into a dot colour for the diagnostic panel
 * (spec §6.6, Matrix theme). Running/connected/ready → green; idle/pending →
 * amber; error/failed/disconnected → red; unknown → muted. Case-insensitive.
 */
function diagDotClass(status: unknown): string {
  if (status == null) return "muted"
  const text = String(status).toLowerCase().trim()
  if (/running|connected|ready|online|ok|active|healthy|started/.test(text)) return "green"
  if (/error|failed|fail|disconnected|offline|crash|stopped|dead|panic/.test(text)) return "red"
  if (/idle|pending|waiting|init|initializ|loading|queued/.test(text)) return "amber"
  return "muted"
}

/** Map a status string to a concise display label. */
function diagStatusLabel(status: unknown): string {
  if (status == null) return "—"
  const text = String(status).trim()
  return text || "—"
}

/** A single labelled diagnostic section with status-dot rows (spec §6.6). */
function DiagSection(props: {
  title: string
  entries: Array<{ name: string; status: unknown }> | null
  error: string | null
  loading: boolean
}) {
  const { title, entries, error, loading } = props
  return (
    <div className="diag-section">
      <h4>{title}</h4>
      {loading ? (
        <p className="diag-na"><LoadingIcon size={14} /> loading…</p>
      ) : entries && entries.length > 0 ? (
        <ul className="diag-rows">
          {entries.map((entry, index) => (
            <li key={`${entry.name}-${index}`} className="diag-row">
              <span className={`diag-dot ${diagDotClass(entry.status)}`} aria-hidden="true" />
              <span className="diag-name">{entry.name}</span>
              <span className="diag-status">{diagStatusLabel(entry.status)}</span>
            </li>
          ))}
        </ul>
      ) : error ? (
        <p className="diag-na">n/a — {error}</p>
      ) : (
        <p className="diag-na">n/a</p>
      )}
    </div>
  )
}

/**
 * Read-only config view (spec §6.6). Renders a curated set of well-known fields
 * opencode's `/config` commonly surfaces (model, agent, permission, autoupdate,
 * small_model, …) as labelled rows, then dumps everything else as formatted JSON
 * in a scrollable pre. Purely read-only — no PATCH UI.
 */
function ConfigView(props: { config: ConfigInfo }) {
  const { config } = props
  const knownKeys = ["model", "agent", "small_model", "permission", "autoupdate"]
  const known = knownKeys
    .filter((key) => config[key] !== undefined && config[key] !== null)
    .map((key) => ({ key, value: config[key] }))
  const rest = Object.fromEntries(
    Object.entries(config).filter(([key]) => !knownKeys.includes(key))
  )
  const restKeys = Object.keys(rest)
  return (
    <div className="diag-config">
      {known.length > 0 && (
        <ul className="diag-rows">
          {known.map((row) => (
            <li key={row.key} className="diag-row">
              <span className="diag-dot muted" aria-hidden="true" />
              <span className="diag-name">{row.key}</span>
              <span className="diag-status">{String(row.value)}</span>
            </li>
          ))}
        </ul>
      )}
      {restKeys.length > 0 && (
        <details className="diag-config-raw">
          <summary>raw config ({restKeys.length} keys)</summary>
          <pre>{JSON.stringify(rest, null, 2)}</pre>
        </details>
      )}
      {known.length === 0 && restKeys.length === 0 && (
        <p className="diag-na">empty</p>
      )}
    </div>
  )
}

/**
 * Subscribe to a CSS media query and re-render on match changes. Used to drive
 * the iPad landscape 3-zone layout (design doc §4) off horizontal size class +
 * orientation rather than a raw device check, so rotation / Split View / Stage
 * Manager all fall out for free.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false
  )
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const mq = window.matchMedia(query)
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(mq.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [query])
  return matches
}

function App() {
  type NoticeType = "info" | "success" | "error"
  type ThemePreference = "system" | "light" | "dark"
  type Skin = "matrix" | "official"

  const [config, setConfig] = useState<ServerConfig>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return defaultConfig
    try {
      return { ...defaultConfig, ...JSON.parse(saved) }
    } catch {
      return defaultConfig
    }
  })
  const [language, setLanguage] = useState<LanguageCode>(() => {
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY) || navigator.language)
  })
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system"
  })
  // Appearance skin: 'matrix' (phosphor FX) or 'official' (clean warm-neutral).
  // Drives the html[data-skin] attribute; CSS swaps the full token set.
  const [skin, setSkin] = useState<Skin>(
    () => (localStorage.getItem(SKIN_STORAGE_KEY) as Skin) || "matrix"
  )
  // Set true (once) by the fx initializer if it auto-softened the rain — drives
  // a one-time toast after mount (design doc §9 risk #1).
  const fxAutoDegradedRef = useRef(false)
  // Matrix FX settings (scanlines+glow / background rain / decode animation).
  // Seeded from localStorage; switches in the Settings panel re-render from this.
  // On a large iPad canvas the full-viewport rain is ~3.4x the phone pixel work,
  // so we soften it to "low" ONCE here (in the initializer, before the bootstrap
  // effect applies it — avoids a flash and any StrictMode re-apply race). The
  // localStorage flag means we never override the user's choice again.
  const [fx, setFx] = useState<FxSettings>(() => {
    const loaded = loadFxSettings()
    const matrixSkin = ((localStorage.getItem(SKIN_STORAGE_KEY) as Skin) || "matrix") === "matrix"
    const alreadyDegraded = localStorage.getItem(FX_AUTODEGRADED_STORAGE_KEY) === "true"
    const bigCanvas = typeof window !== "undefined" && window.innerWidth > 1024
    if (!alreadyDegraded && matrixSkin && bigCanvas && (loaded.rain === "med" || loaded.rain === "high")) {
      const degraded: FxSettings = { ...loaded, rain: "low" }
      saveFxSettings(degraded)
      localStorage.setItem(FX_AUTODEGRADED_STORAGE_KEY, "true")
      fxAutoDegradedRef.current = true
      return degraded
    }
    return loaded
  })
  // iPad landscape 3-zone layout (design doc §4). Driven off size class +
  // orientation; rotation/Split View toggle this without re-anchoring anything.
  const isLandscapeRegular = useMediaQuery("(min-width: 1024px) and (orientation: landscape)")
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
  )
  // ⌘K command palette + which input ⌘↵ / ⌘2/⌘3 target (design doc §4).
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [focusZone, setFocusZone] = useState<"chat" | "terminal">("chat")
  // "Latest ref" for the global keydown handler so the window listener (subscribed
  // once) always runs against fresh state/closures — no stale captures, no churn.
  const keydownHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  const toggleSidebarCollapsed = () =>
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next))
      return next
    })
  const t = useMemo(() => createTranslator(language), [language])

  const [draftConfig, setDraftConfig] = useState<ServerConfig>(config)
  const [connectedVersion, setConnectedVersion] = useState<string>("")
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [commandFilter, setCommandFilter] = useState<"all" | "skill">("all")
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([])
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null)
  const [selectedAgentID, setSelectedAgentID] = useState<string>(() => localStorage.getItem(AGENT_STORAGE_KEY) || "build")
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(() => localStorage.getItem(MODEL_STORAGE_KEY))
  const [modelQuery, setModelQuery] = useState("")
  const [helpPage, setHelpPage] = useState<"overview" | "server" | "network" | "troubleshooting" | "commands" | "diagnostics">(
    "overview"
  )
  const [view, setView] = useState<"settings" | "sessions" | "detail" | "help">(() => {
    return config.host && config.port > 0 ? "sessions" : "settings"
  })

  const [sessions, setSessions] = useState<SessionView[]>([])
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [newSessionDirectory, setNewSessionDirectory] = useState(() => localStorage.getItem(NEW_SESSION_DIRECTORY_STORAGE_KEY) ?? "")
  // Push relay config (APNs relay). Loaded from localStorage at boot; the
  // push-registration effect (native iOS only) re-runs when these change.
  const [pushRelayUrl, setPushRelayUrl] = useState(() => localStorage.getItem(PUSH_RELAY_URL_STORAGE_KEY) || import.meta.env.VITE_PUSH_RELAY_URL || "")
  const [pushRelayApiKey, setPushRelayApiKey] = useState(() => localStorage.getItem(PUSH_RELAY_APIKEY_STORAGE_KEY) || import.meta.env.VITE_PUSH_API_KEY || "")
  const [showNewSessionPicker, setShowNewSessionPicker] = useState(false)
  const [pickerPath, setPickerPath] = useState("")
  const [pickerItems, setPickerItems] = useState<FileEntry[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageEnvelope[]>([])
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<MessageEnvelope[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([])

  const [projectDashboard, setProjectDashboard] = useState<ProjectDashboard | null>(null)

  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [composer, setComposer] = useState("")
  const [busySending, setBusySending] = useState(false)
  // Voice input (on-device SFSpeechRecognizer). No-ops on web.
  const [micSupported, setMicSupported] = useState(false)
  const [micListening, setMicListening] = useState(false)
  const micPartialRef = useRef("")
  const [loadingSessionID, setLoadingSessionID] = useState<string | null>(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [refreshingSessions, setRefreshingSessions] = useState(false)
  const [awaitingAssistantReply, setAwaitingAssistantReply] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState<{ type: NoticeType; text: string } | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<"idle" | "connecting" | "connected" | "reconnecting" | "offline">(
    config.host && config.port > 0 ? "connecting" : "idle"
  )
  const [connectionMessage, setConnectionMessage] = useState<string>("")
  const [lastTestedConfigKey, setLastTestedConfigKey] = useState<string | null>(null)
  const [sessionToDelete, setSessionToDelete] = useState<SessionView | null>(null)
  const [activeDetailSheet, setActiveDetailSheet] = useState<null | "ai" | "details">(null)
  const [detailMode, setDetailMode] = useState<"chat" | "terminal">("chat")

  // Permission prompt (spec §6.1). Pending tool-permission requests for the OPEN
  // session. Polled on the adaptive tick when the session is busy/retry; refetched
  // after a reply. `permissionUnsupported` flips true on the first 404/empty so we
  // stop hammering a server (or the mock) that doesn't expose the route.
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([])
  const [permissionUnsupported, setPermissionUnsupported] = useState(false)
  const [replyingPermission, setReplyingPermission] = useState(false)
  // opencode Question system (multiple-choice prompts) — mirrors the permission
  // poll/state/reply flow above. `questionUnsupported` flips on the first 404 so
  // we stop polling servers that predate the /question route.
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([])
  const [questionUnsupported, setQuestionUnsupported] = useState(false)
  const [replyingQuestion, setReplyingQuestion] = useState(false)

  // Session actions menu (spec §6.3). `actionsMenuOpen` toggles the ⋯ dropdown in
  // the detail header; `actionBusy` is a per-action in-flight flag (disables the
  // menu while a fork/share/revert/summarize/rename/delete round-trips).
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  // Composer file-attach (spec §6.2). The file-picker is a modal that browses
  // the project tree via listFiles and fuzzy-searches via findFile; selected
  // files become `attachments` (PromptAttachment[]) shown as chips above the
  // composer and appended as file parts on the next sendPrompt.
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const [showFilePicker, setShowFilePicker] = useState(false)
  const [filePickerPath, setFilePickerPath] = useState("")
  const [filePickerItems, setFilePickerItems] = useState<FileEntry[]>([])
  const [filePickerLoading, setFilePickerLoading] = useState(false)
  const [filePickerError, setFilePickerError] = useState<string | null>(null)
  const [filePickerQuery, setFilePickerQuery] = useState("")
  const [filePickerResults, setFilePickerResults] = useState<string[] | null>(null)
  const [filePickerSearching, setFilePickerSearching] = useState(false)
  const filePickerSearchTimerRef = useRef<number | null>(null)

  // Provider connected status (spec §6.5) — drives the connected/offline badges
  // in the model picker. `null` = not loaded / fell back to listModels only.
  const [providerStatus, setProviderStatus] = useState<ProviderListResult | null>(null)

  // Diagnostic panel (spec §6.6) — read-only server monitoring. Each section is
  // fetched on tab open + manual refresh. `undefined` = not loaded yet; `null` =
  // endpoint unavailable (404/errored) → shown as "n/a". A per-section error
  // string is kept so the panel can surface why an endpoint failed.
  type DiagSection<T> = { data: T | null; error: string | null }
  const [diagMCP, setDiagMCP] = useState<DiagSection<Record<string, MCPStatus>> | undefined>(undefined)
  const [diagLSP, setDiagLSP] = useState<DiagSection<LSPStatus[]> | undefined>(undefined)
  const [diagFormatter, setDiagFormatter] = useState<DiagSection<FormatterStatus[]> | undefined>(undefined)
  const [diagConfig, setDiagConfig] = useState<DiagSection<ConfigInfo> | undefined>(undefined)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagLoaded, setDiagLoaded] = useState(false)

  function showToast(message: string) {
    setToast(message)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600)
  }
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  // The DOM node of the live (actively-streaming) assistant message, plus its
  // current decode animation handle. We stop+settle on stream end / change.
  const liveDecodeElRef = useRef<HTMLElement | null>(null)
  const liveDecodeHandleRef = useRef<{ stop: () => void } | null>(null)
  const prevDecodedIdRef = useRef<string | null>(null)
  const composerRef = useRef<HTMLDivElement | null>(null)
  const completionAudioRef = useRef<HTMLAudioElement | null>(null)
  const completionShouldPlayRef = useRef(false)
  const wasAwaitingAssistantReplyRef = useRef(false)
  const wasRunningRef = useRef(false)
  const awaitingAssistantBaselineRef = useRef("")
  const loadSelectedRequestRef = useRef(0)
  const backgroundFailureCountRef = useRef(0)
  const initialSessionLoadRef = useRef(true)
  const latestMessageTimesRef = useRef(new Map<string, { sessionUpdated: number; activityTime: number }>())

  const selectedIDRef = useRef<string | null>(null)
  const sessionsRef = useRef<SessionView[]>([])
  const prevStatusRef = useRef(new Map<string, string>())
  selectedIDRef.current = selectedID
  sessionsRef.current = sessions

  const storeRef = useRef<ReturnType<typeof createStore> | null>(null)
  if (!storeRef.current) {
    storeRef.current = createStore({
      onSessionActivity: () => {
        refreshSessions(true).catch(() => undefined)
        // Reload the open session's messages so the chat updates live.
        const openID = selectedIDRef.current
        if (openID) {
          const open = sessionsRef.current.find((s) => s.id === openID)
          if (open) loadSelected(open.id, open.directory).catch(() => undefined)
        }
        // Feed the App Group snapshot (widget) — native-only, no-op if plugin unregistered.
        if (Capacitor.isNativePlatform()) {
          SharedSnapshot.writeSnapshot({ data: buildSnapshot(sessionsRef.current) }).catch(() => undefined)
        }
      },
      onSessionCompleted: (sessionID) => {
        // completion feedback: sound + haptic + local notification (Task 9 wires the notify part)
        completionShouldPlayRef.current = true
        setAwaitingAssistantReply(false)
        const viewingSessionID = selectedIDRef.current
        const appVisible = document.visibilityState === "visible"
        if (!shouldNotify({ appVisible, viewingSessionID, completedSessionID: sessionID })) return
        if (Capacitor.isNativePlatform()) {
          const session = sessionsRef.current.find(s => s.id === sessionID)
          LocalNotifications.schedule({
            notifications: [{
              id: Date.now() % 2147483647,
              title: "OpenCode",
              body: `Session ${session?.title ?? sessionID} terminée`,
              extra: { sessionID, directory: session?.directory }
            }]
          }).catch(() => undefined)
          Haptics.notification({ type: NotificationType.Success }).catch(() => undefined)
        }
      }
    })
  }

  useEffect(() => {
    if (Capacitor.isNativePlatform()) LocalNotifications.requestPermissions().catch(() => undefined)
  }, [])

  // Matrix FX bootstrap: apply persisted FX data-attrs + mount the katakana rain.
  // Force dark theme (Matrix is dark-only) regardless of the legacy theme pref.
  // The theme picker control was removed from Settings, but the theme state
  // machine is retained (the ui-regression suite asserts it stays), so we pin
  // it to "dark" here and the dedicated theme effect keeps data-theme in sync.
  useEffect(() => {
    setTheme("dark")
    document.documentElement.dataset.theme = "dark"
    document.documentElement.style.colorScheme = "dark"
    applyFxSettings(fx)
    const cleanup = initMatrixFx()
    return cleanup
    // Intentionally run once on mount: fx is read at init via the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let sub: { remove: () => void } | undefined
    LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
      const extra = action.notification.extra as { sessionID?: string; directory?: string } | undefined
      if (extra?.sessionID && extra.directory) {
        openSession(extra.sessionID, extra.directory).catch(() => undefined)
      }
    }).then(h => { sub = h })
    return () => { sub?.remove() }
  }, [sessions])

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedID) ?? null,
    [sessions, selectedID]
  )
  const projectPath = projectDashboard?.project
    ? pickString(projectDashboard.project.path) || pickString(projectDashboard.project.directory) || pickString(projectDashboard.project.root)
    : null
  const projectName = projectDashboard?.project
    ? pickString(projectDashboard.project.name) || (projectPath ? projectPath.split("/").filter(Boolean).pop() ?? projectPath : null)
    : null
  const vcsBranch = projectDashboard?.vcs
    ? pickString(projectDashboard.vcs.branch) || pickString(projectDashboard.vcs.status) || summarizeJson(projectDashboard.vcs)
    : null
  const selectedModel = useMemo(() => modelFromKey(selectedModelKey), [selectedModelKey])
  const activeModelOption = useMemo(() => {
    if (selectedModel) {
      const explicit = modelOptions.find((option) => sameModel(option, selectedModel))
      if (explicit) return explicit
    }
    if (selectedSession?.model) {
      const current = modelOptions.find((option) => sameModel(option, selectedSession.model))
      if (current) return current
    }
    return modelOptions.find((option) => option.isDefault) ?? modelOptions[0] ?? null
  }, [modelOptions, selectedModel, selectedSession?.model])
  const activeModel = activeModelOption ? { providerID: activeModelOption.providerID, modelID: activeModelOption.modelID, variant: activeModelOption.variant } : selectedModel ?? undefined
  const primaryAgentOptions = useMemo(() => agentOptions.filter((agent) => agent.mode === "primary" || agent.mode === "all"), [agentOptions])
  const activeAgent = useMemo(() => {
    return primaryAgentOptions.find((agent) => agent.id === selectedAgentID)
      ?? primaryAgentOptions.find((agent) => agent.id === "build")
      ?? primaryAgentOptions[0]
      ?? null
  }, [primaryAgentOptions, selectedAgentID])
  const activeAgentID = activeAgent?.id ?? "build"
  const filteredModelOptions = useMemo(() => {
    const text = modelQuery.trim().toLowerCase()
    if (!text) return modelOptions
    return modelOptions.filter((option) => modelSearchText(option).includes(text))
  }, [modelOptions, modelQuery])
  /** Set of providerIDs reported as connected by `GET /provider` (empty when unavailable). */
  const connectedProviderIDs = useMemo(() => new Set(providerStatus?.connected ?? []), [providerStatus])
  /** Map providerID → display name from the provider list (for the badge label fallback). */
  const providerNameByID = useMemo(() => {
    const map = new Map<string, string>()
    for (const provider of providerStatus?.all ?? []) {
      map.set(provider.id, provider.name || provider.id)
    }
    return map
  }, [providerStatus])

  const filteredSessions = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return sessions
    return sessions.filter((session) => {
      return session.title.toLowerCase().includes(text) || session.directory.toLowerCase().includes(text)
    })
  }, [sessions, query])
  const displayedCommands = useMemo(() => {
    if (commandFilter === "skill") return commands.filter((command) => command.source === "skill")
    return commands
  }, [commands, commandFilter])
  const selectedNewSessionDirectory = normalizeDirectory(newSessionDirectory)

  const renderedMessages = useMemo(() => {
    return [...messages, ...optimisticUserMessages]
      .map((message) => ({ ...message, text: extractText(message) }))
      .filter((message) => message.text)
  }, [messages, optimisticUserMessages])

  const messageScrollSignature = useMemo(() => {
    return renderedMessages.map((message) => `${message.info.id}:${message.text.length}`).join("|")
  }, [renderedMessages])

  const assistantResponseSignature = useMemo(() => {
    return renderedMessages
      .filter((message) => message.info.role !== "user")
      .map((message) => `${message.info.id}:${message.text.length}`)
      .join("|")
  }, [renderedMessages])

  const hasConfiguredServer = Boolean(config.host && config.port > 0)
  const draftConfigKey = configKey(draftConfig)
  const savedConfigKey = configKey(config)
  const hasDraftChanges = draftConfigKey !== savedConfigKey
  const canTestDraft = canTestConfig(draftConfig)
  const testAlreadyPassedForDraft = lastTestedConfigKey === draftConfigKey
  const connectionStatusText = connectionMessage || (connectionState === "connecting"
    ? t('connection.connecting')
    : connectionState === "reconnecting"
      ? t('connection.reconnecting')
      : connectionState === "connected"
        ? t('connection.connected')
        : connectionState === "offline"
          ? t('connection.offline')
          : "")
  const isSessionRunning = Boolean(selectedSession && ["busy", "retry"].includes(selectedSession.status))
  const isWaitingForOpenCodeReply = awaitingAssistantReply || busySending || isSessionRunning
  const isWorking = isWaitingForOpenCodeReply
  const showTypingBubble = Boolean(selectedSession) && isWaitingForOpenCodeReply
  const activeSessions = sessions.filter((session) => ["busy", "retry"].includes(session.status)).length
  const changedSessions = sessions.filter(
    (session) => session.files > 0 || session.additions > 0 || session.deletions > 0
  ).length
  const totalDiffAdditions = diffFiles.reduce((sum, file) => sum + file.additions, 0)
  const totalDiffDeletions = diffFiles.reduce((sum, file) => sum + file.deletions, 0)
  const showModelChip = modelOptions.length > 1 || Boolean(activeModelOption) || primaryAgentOptions.length > 0

  async function openSession(sessionID: string, directory: string) {
    setSelectedID(sessionID)
    setMessages([])
    setOptimisticUserMessages([])
    setTodos([])
    setDiffFiles([])
    setProjectDashboard(null)
    setDashboardError(null)
    setAwaitingAssistantReply(false)
    setRuntimeError(null)
    setView("detail")
    setLoadingSessionID(sessionID)
    try {
      await loadSelected(sessionID, directory)
      await Promise.all([loadAgents(), loadModels(), loadProviders()])
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
    setLoadingSessionID((activeID) => (activeID === sessionID ? null : activeID))
  }

  function saveConfig() {
    setConfig(draftConfig)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draftConfig))
    setSettingsNotice({ type: "success", text: t('settings.saved') })
    setConnectionState("connecting")
    setConnectionMessage(t('connection.connecting'))
    setRuntimeError(null)
    backgroundFailureCountRef.current = 0
    initialSessionLoadRef.current = true
  }

  async function testConnection(configToTest: ServerConfig) {
    setTestingConnection(true)
    setSettingsNotice({ type: "info", text: t('settings.testingConnection') })
    try {
      const health = await Promise.race([
        api.health(configToTest),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out")), 12000))
      ])
      setConnectedVersion(health.version)
      setLastTestedConfigKey(configKey(configToTest))
      setSettingsNotice({ type: "success", text: t('settings.testedNotSaved', { version: health.version }) })
    } catch (err) {
      setSettingsNotice({ type: "error", text: t('settings.connectionFailed', { message: (err as Error).message }) })
    } finally {
      setTestingConnection(false)
    }
  }

  async function refreshSessions(silent = false, preserveSession?: SessionView) {
    if (!config.host || config.port <= 0) return
    if (!silent) {
      setRuntimeError(null)
      setConnectionState(sessions.length === 0 ? "connecting" : "reconnecting")
      setConnectionMessage(sessions.length === 0 ? t('connection.loadingSessions') : t('connection.refreshing'))
    } else if (initialSessionLoadRef.current && sessions.length === 0) {
      setConnectionState("connecting")
      setConnectionMessage(t('connection.loadingSessions'))
    }
    try {
      const items = await api.listGlobalSessions(config).catch(() => api.listSessions(config))
      const directories = [...new Set(items.map((session) => session.directory).filter(Boolean))]
      const [sessionLists, statusMaps] = await Promise.all([
        Promise.all(directories.map((directory) => api.listSessions(config, directory).catch(() => [] as Session[]))),
        Promise.all(directories.map((directory) => api.listStatuses(config, directory).catch(() => ({} as Record<string, SessionStatus>))))
      ])
      const scopedSessions = new Map(sessionLists.flat().map((session) => [session.id, session]))
      const statuses = Object.assign({}, ...statusMaps)
      const hydratedItems = items.map((session) => ({ ...session, ...scopedSessions.get(session.id), project: session.project }))
      const activityTimes = await loadSessionActivityTimes(hydratedItems)
      const mapped = hydratedItems
        .map((session) => toSessionView(session, statuses[session.id], activityTimes.get(session.id)))
        .sort((a, b) => b.updated - a.updated)
      setSessions((current) => {
        const selected = selectedID ? current.find((session) => session.id === selectedID) : null
        const toPreserve = preserveSession ?? selected
        if (!toPreserve || mapped.some((session) => session.id === toPreserve.id)) return mapped
        return [toPreserve, ...mapped].sort((a, b) => b.updated - a.updated)
      })
      backgroundFailureCountRef.current = 0
      initialSessionLoadRef.current = false
      setConnectionState("connected")
      setConnectionMessage(t('connection.connected'))
      setRuntimeError(null)
    } catch (err) {
      const message = (err as Error).message
      if (!silent) {
        setConnectionState("offline")
        setConnectionMessage(t('connection.offline'))
        setRuntimeError(message)
        return
      }

      backgroundFailureCountRef.current += 1
      if (backgroundFailureCountRef.current === 1) {
        setConnectionState("reconnecting")
        setConnectionMessage(t('connection.reconnecting'))
        return
      }

      setConnectionState("offline")
      setConnectionMessage(t('connection.offline'))
      if (backgroundFailureCountRef.current >= 3) {
        setRuntimeError(message)
      }
    }
  }

  async function refreshSessionsWithIndicator() {
    if (refreshingSessions) return
    setRefreshingSessions(true)
    try {
      await refreshSessions()
    } finally {
      setRefreshingSessions(false)
    }
  }

  async function loadCommands() {
    if (!config.host || config.port <= 0) return
    try {
      const list = await api.listCommands(config)
      setCommands(list)
    } catch {
      setCommands([])
    }
  }

  async function loadAgents() {
    if (!config.host || config.port <= 0) return
    try {
      const list = await api.listAgents(config, selectedSession?.directory ?? selectedNewSessionDirectory)
      setAgentOptions(list)
      setAgentLoadError(null)
      const saved = localStorage.getItem(AGENT_STORAGE_KEY) || selectedAgentID
      const primary = list.filter((agent) => agent.mode === "primary" || agent.mode === "all")
      const next = primary.find((agent) => agent.id === saved) ?? primary.find((agent) => agent.id === "build") ?? primary[0]
      if (next) {
        setSelectedAgentID(next.id)
        localStorage.setItem(AGENT_STORAGE_KEY, next.id)
      }
    } catch (err) {
      setAgentLoadError((err as Error).message)
    }
  }

  async function loadModels() {
    if (!config.host || config.port <= 0) return
    try {
      const list = await api.listModels(config, selectedSession?.directory ?? selectedNewSessionDirectory)
      setModelOptions(list)
      setModelLoadError(null)
      const sessionModel = selectedSession?.model
      const sessionOption = sessionModel ? list.find((option) => sameModel(option, sessionModel)) : null
      if (sessionOption) {
        const nextKey = modelKey(sessionOption)
        setSelectedModelKey(nextKey)
        localStorage.setItem(MODEL_STORAGE_KEY, nextKey)
        return
      }
      const saved = modelFromKey(selectedModelKey)
      if (saved && list.some((option) => sameModel(option, saved))) return
      const fallback = list.find((option) => option.isDefault) ?? list[0]
      if (fallback) {
        const nextKey = modelKey(fallback)
        setSelectedModelKey(nextKey)
        localStorage.setItem(MODEL_STORAGE_KEY, nextKey)
      }
    } catch (err) {
      setModelLoadError((err as Error).message)
    }
  }

  /**
   * Load provider connected status (spec §6.5) for the richer model picker.
   * Defensive: on any failure we clear the status (picker falls back to showing
   * models from `/config/providers` only, with no connected/offline badge). Never
   * throws — a missing/unreachable `/provider` must not break the model selector.
   */
  async function loadProviders() {
    if (!config.host || config.port <= 0) return
    try {
      const result = await api.listProviders(config, selectedSession?.directory ?? selectedNewSessionDirectory)
      setProviderStatus(result && Array.isArray(result.all) ? result : null)
    } catch {
      setProviderStatus(null)
    }
  }

  /**
   * Load the diagnostic panel sections (spec §6.6). Each endpoint is fetched
   * independently and defensively: a 404 / network failure sets that section to
   * `null` (rendered as "n/a") rather than throwing. A "stale-until-refreshed"
   * model is used — on the first open we fetch all four; manual refresh re-runs
   * them. Never throws.
   */
  async function loadDiagnostics() {
    if (!config.host || config.port <= 0) return
    setDiagLoading(true)
    const dir = selectedSession?.directory ?? selectedNewSessionDirectory
    await Promise.all([
      api.mcpStatus(config, dir)
        .then((data) => setDiagMCP({ data, error: null }))
        .catch((err: Error) => setDiagMCP({ data: null, error: err.message })),
      api.lspStatus(config, dir)
        .then((data) => setDiagLSP({ data: Array.isArray(data) ? data : [], error: null }))
        .catch((err: Error) => setDiagLSP({ data: null, error: err.message })),
      api.formatterStatus(config, dir)
        .then((data) => setDiagFormatter({ data: Array.isArray(data) ? data : [], error: null }))
        .catch((err: Error) => setDiagFormatter({ data: null, error: err.message })),
      api.getConfig(config, dir)
        .then((data) => setDiagConfig({ data, error: null }))
        .catch((err: Error) => setDiagConfig({ data: null, error: err.message })),
    ])
    setDiagLoaded(true)
    setDiagLoading(false)
  }

  async function loadSessionActivityTimes(items: Session[]): Promise<Map<string, number>> {
    const results = await Promise.all(items.map(async (session) => {
      const cached = latestMessageTimesRef.current.get(session.id)
      if (cached?.sessionUpdated === session.time.updated) return [session.id, cached.activityTime] as const

      const latest = await api.loadLatestMessage(config, session.id, session.directory).catch(() => null)
      if (latest === null) return [session.id, session.time.updated] as const
      const activityTime = latest.length > 0 ? Math.max(...latest.map(messageActivityTime)) : session.time.updated
      latestMessageTimesRef.current.set(session.id, { sessionUpdated: session.time.updated, activityTime })
      return [session.id, activityTime] as const
    }))
    return new Map(results)
  }

  function changeModel(nextKey: string) {
    setSelectedModelKey(nextKey)
    localStorage.setItem(MODEL_STORAGE_KEY, nextKey)
  }

  function changeAgent(nextAgentID: string) {
    setSelectedAgentID(nextAgentID)
    localStorage.setItem(AGENT_STORAGE_KEY, nextAgentID)
  }

  async function loadSelected(sessionID: string, directory: string) {
    const requestID = ++loadSelectedRequestRef.current
    const [msg, todo, diff] = await Promise.all([
      api.loadMessages(config, sessionID, directory),
      api.loadTodo(config, sessionID, directory),
      api.loadDiff(config, sessionID, directory).catch(() => [])
    ])
    if (requestID !== loadSelectedRequestRef.current) return
    setMessages((current) => {
      if (assistantPayloadLength(current) > assistantPayloadLength(msg)) return current
      return msg
    })
    setOptimisticUserMessages((current) => current.filter((message) => !hasMatchingUserMessage(msg, message)))
    setTodos(todo)
    setDiffFiles(diff)
    await loadProjectDashboard(directory)
  }

  async function loadProjectDashboard(directory: string) {
    setDashboardError(null)
    try {
      const [project, vcs, fileStatus] = await Promise.all([
        api.loadProjectCurrent(config, directory).catch(() => null),
        api.loadVcs(config, directory).catch(() => null),
        api.loadFileStatus(config, directory).catch(() => [])
      ])
      setProjectDashboard({ project, vcs, files: toFileStatusList(fileStatus) })
    } catch (err) {
      setDashboardError((err as Error).message)
    }
  }

  function syncChatBottomClearance() {
    const container = messagesRef.current
    const composer = composerRef.current
    if (!container || !composer) return

    const composerRect = composer.getBoundingClientRect()
    const composerStyles = window.getComputedStyle(composer)
    const composerBottom = Number.parseFloat(composerStyles.bottom) || 0
    const clearance = Math.ceil(composerRect.height + composerBottom + 16)
    container.style.setProperty("--chat-bottom-clearance", `${clearance}px`)
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
    requestAnimationFrame(() => {
      syncChatBottomClearance()
      requestAnimationFrame(() => {
        const container = messagesRef.current
        const end = messagesEndRef.current
        if (container) {
          container.scrollTo({ top: container.scrollHeight, behavior })
        }
        end?.scrollIntoView({ block: "end", behavior })

        const composerRect = composerRef.current?.getBoundingClientRect()
        const endRect = end?.getBoundingClientRect()
        if (composerRect && endRect && endRect.bottom > composerRect.top - 12) {
          const coveredByComposer = endRect.bottom - composerRect.top + 12
          window.scrollBy({ top: coveredByComposer, behavior })
        }
      })
    })
  }

  /** Stop the live decode animation, settle its text to the final value, and
   *  clear the stored handle. Safe to call when nothing is animating. */
  function settleLiveDecode() {
    const handle = liveDecodeHandleRef.current
    if (handle) {
      handle.stop()
      liveDecodeHandleRef.current = null
    }
  }

  async function browseNewSessionDirectory(path: string) {
    setPickerLoading(true)
    setPickerError(null)
    try {
      const items = await api.listFiles(config, path, path)
      setPickerPath(path)
      setPickerItems(items.filter((item) => item.type === "directory").sort((a, b) => a.name.localeCompare(b.name)))
    } catch (err) {
      setPickerError((err as Error).message)
      setPickerItems([])
    } finally {
      setPickerLoading(false)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Composer file-attach (spec §6.2). The picker browses the session's project
  // directory (listFiles, dirs + files) and fuzzy-searches (findFile) when the
  // user types. Selecting a file pushes a PromptAttachment (by source path —
  // opencode reads it from disk on the server, no upload). Chips live above the
  // composer and are appended as file parts on the next sendPrompt, then cleared.
  // ─────────────────────────────────────────────────────────────────────────
  async function browseAttachDirectory(path: string) {
    if (!selectedSession) return
    setFilePickerLoading(true)
    setFilePickerError(null)
    try {
      const items = await api.listFiles(config, path, selectedSession.directory)
      setFilePickerPath(path)
      // Show both files and dirs (dirs to navigate, files to attach). Dirs first.
      setFilePickerItems(
        items
          .filter((item) => !item.ignored)
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1
            return a.name.localeCompare(b.name)
          })
      )
    } catch (err) {
      setFilePickerError((err as Error).message)
      setFilePickerItems([])
    } finally {
      setFilePickerLoading(false)
    }
  }

  async function openFilePicker() {
    if (!selectedSession) return
    setShowFilePicker(true)
    setFilePickerError(null)
    setFilePickerQuery("")
    setFilePickerResults(null)
    setFilePickerItems([])
    try {
      // Start at the project directory root.
      const pathInfo = await api.loadPath(config, selectedSession.directory).catch(() => null)
      const startPath = selectedSession.directory || pathInfo?.directory || pathInfo?.worktree || ""
      await browseAttachDirectory(startPath || ".")
    } catch (err) {
      setFilePickerError((err as Error).message)
    }
  }

  /** Debounced fuzzy filename search (GET /find/file). Clears on empty query. */
  function scheduleFilePickerSearch(query: string) {
    setFilePickerQuery(query)
    if (filePickerSearchTimerRef.current) window.clearTimeout(filePickerSearchTimerRef.current)
    const trimmed = query.trim()
    if (!trimmed) {
      setFilePickerResults(null)
      setFilePickerSearching(false)
      return
    }
    setFilePickerSearching(true)
    filePickerSearchTimerRef.current = window.setTimeout(async () => {
      try {
        const results = await api.findFile(
          config,
          trimmed,
          { type: "file", limit: 50 },
          selectedSession?.directory
        )
        setFilePickerResults(Array.isArray(results) ? results : [])
      } catch {
        setFilePickerResults([])
      } finally {
        setFilePickerSearching(false)
      }
    }, 280)
  }

  function attachFileEntry(entry: FileEntry) {
    const filename = entry.name
    const attachment: PromptAttachment = {
      filename,
      mime: guessMime(filename),
      source: entry.absolute || entry.path
    }
    setAttachments((current) => {
      if (current.some((item) => attachKey(item) === attachKey(attachment))) return current
      return [...current, attachment]
    })
    setShowFilePicker(false)
  }

  /** Attach a fuzzy-search hit (a path string from /find/file). */
  function attachPath(path: string) {
    const filename = path.split(/[/\\]/).filter(Boolean).pop() || path
    const attachment: PromptAttachment = {
      filename,
      mime: guessMime(filename),
      source: path
    }
    setAttachments((current) => {
      if (current.some((item) => attachKey(item) === attachKey(attachment))) return current
      return [...current, attachment]
    })
  }

  function removeAttachment(attachment: PromptAttachment) {
    setAttachments((current) => current.filter((item) => attachKey(item) !== attachKey(attachment)))
  }

  async function openNewSessionPicker() {
    if (creatingSession) return
    setRuntimeError(null)
    setShowNewSessionPicker(true)
    setPickerError(null)
    try {
      const pathInfo = await api.loadPath(config, selectedNewSessionDirectory)
      await browseNewSessionDirectory(selectedNewSessionDirectory ?? pathInfo.directory)
    } catch (err) {
      setPickerError((err as Error).message)
    }
  }

  function parentDirectory(path: string): string | null {
    if (!path || path === "/") return null
    const normalized = path.replace(/[/\\]+$/, "")
    const separator = normalized.includes("\\") ? "\\" : "/"
    const index = normalized.lastIndexOf(separator)
    if (index <= 0) return separator === "/" ? "/" : null
    return normalized.slice(0, index)
  }

  async function createSession(directory = selectedNewSessionDirectory) {
    if (creatingSession) return
    setCreatingSession(true)
    setRuntimeError(null)
    setPickerError(null)
    try {
      if (directory) {
        const pathInfo = await api.loadPath(config, directory)
        if (!isProjectDirectory(pathInfo)) {
          throw new Error(t('sessions.projectDirectoryInvalid', { directory }))
        }
      }
      const created = await api.createSession(config, "Mobile session", activeModel, directory)
      const createdView = toSessionView(created)
      if (directory) {
        setNewSessionDirectory(directory)
      }
      setShowNewSessionPicker(false)
      setSessions((current) => {
        if (current.some((session) => session.id === created.id)) return current
        return [createdView, ...current].sort((a, b) => b.updated - a.updated)
      })
      setSelectedID(created.id)
      setView("detail")
      await loadSelected(created.id, created.directory)
      await refreshSessions(false, createdView)
    } catch (err) {
      setPickerError((err as Error).message)
      setRuntimeError((err as Error).message)
    } finally {
      setCreatingSession(false)
    }
  }

  // Probe speech support once. The web fallback reports unsupported.
  useEffect(() => {
    let cancelled = false
    Speech.isSupported()
      .then((r) => {
        if (!cancelled) setMicSupported(Boolean(r.value))
      })
      .catch(() => {
        if (!cancelled) setMicSupported(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Stop the recognizer if the user navigates away from the session or unmounts.
  useEffect(() => {
    if (!selectedSession && micListening) {
      Speech.stop().catch(() => undefined)
      setMicListening(false)
      micPartialRef.current = ""
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSession])

  // Toggle the mic. On start, subscribe to partial + result events; on stop,
  // end the request. Transcripts are appended to the composer input.
  async function toggleMic() {
    if (!micSupported) return
    if (micListening) {
      try {
        await Speech.stop()
      } catch {
        /* ignore */
      }
      setMicListening(false)
      return
    }
    micPartialRef.current = ""
    const partialHandle = await Speech.addListener("partial", (e: { text: string }) => {
      micPartialRef.current = e.text ?? ""
    })
    const resultHandle = await Speech.addListener("result", (e: { text: string; finished: boolean }) => {
      const transcript = (e.text ?? "").trim()
      if (transcript) {
        setComposer((cur) => {
          const base = cur.trim()
          const joined = base ? `${base} ${transcript}` : transcript
          // Preserve a trailing space so the user can keep typing/speaking.
          return cur.endsWith(" ") || !cur ? joined : `${joined} `
        })
      }
      if (e.finished) {
        micPartialRef.current = ""
      }
    })
    try {
      await Speech.start()
      setMicListening(true)
    } catch {
      setMicListening(false)
      await partialHandle.remove().catch(() => undefined)
      await resultHandle.remove().catch(() => undefined)
    }
  }

  async function send() {
    if (!selectedSession) return
    const text = composer.trim()
    if (!text) return

    if (text.startsWith("/")) {
      const normalized = text.slice(1)
      const command = normalized.split(" ")[0]?.trim() ?? ""
      const args = normalized.slice(command.length).trim()
      const localCommand = command.toLowerCase()

      if (localCommand === "help" || localCommand === "commands" || localCommand === "skills") {
        setComposer("")
        setRuntimeError(null)
        setCommandFilter(localCommand === "skills" ? "skill" : "all")
        setHelpPage("commands")
        setView("help")
        return
      }

      if (!command) return

      if (localCommand === "status") {
        const status = [
          `Connection: ${connectionStatusText || connectionState}`,
          `Server: ${hasConfiguredServer ? `${config.host}:${config.port}` : "not configured"}`,
          `Session: ${selectedSession.title} (${selectedSession.status})`,
          `Directory: ${selectedSession.directory}`,
          `Agent: ${activeAgent?.name ?? activeAgentID}`,
          `Model: ${activeModelOption ? `${activeModelOption.providerName} / ${activeModelOption.modelName}` : "default"}`
        ].join("\n")
        setComposer("")
        setRuntimeError(null)
        setOptimisticUserMessages((current) => [
          ...current,
          createOptimisticUserMessage(selectedSession.id, text),
          createLocalAssistantMessage(selectedSession.id, status)
        ])
        scrollMessagesToBottom("smooth")
        return
      }

      let availableCommands = commands
      if (availableCommands.length === 0) {
        try {
          availableCommands = await api.listCommands(config)
          setCommands(availableCommands)
        } catch (err) {
          setRuntimeError(`Cannot load server commands: ${(err as Error).message}`)
          return
        }
      }

      if (!availableCommands.some((item) => item.name === command)) {
        const available = availableCommands.map((item) => `/${item.name}`).join(", ")
        setRuntimeError(`Command not found: "/${command}". Available commands: ${available}`)
        return
      }

      setComposer("")
      const optimisticMessage = createOptimisticUserMessage(selectedSession.id, text)
      setOptimisticUserMessages((current) => [...current, optimisticMessage])
      awaitingAssistantBaselineRef.current = assistantResponseSignature
      completionShouldPlayRef.current = true
      setAwaitingAssistantReply(true)
      scrollMessagesToBottom("smooth")

      setBusySending(true)
      setRuntimeError(null)
      try {
        await api.sendCommand(config, selectedSession.id, command, args, selectedSession.directory, activeModel, activeAgentID)
        await loadSelected(selectedSession.id, selectedSession.directory)
        setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
        await refreshSessions()
      } catch (err) {
        completionShouldPlayRef.current = false
        setAwaitingAssistantReply(false)
        setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
        setComposer((current) => current || text)
        setRuntimeError((err as Error).message)
      } finally {
        setBusySending(false)
      }
      return
    }

    setComposer("")
    const optimisticMessage = createOptimisticUserMessage(selectedSession.id, text)
    setOptimisticUserMessages((current) => [...current, optimisticMessage])
    awaitingAssistantBaselineRef.current = assistantResponseSignature
    completionShouldPlayRef.current = true
    setAwaitingAssistantReply(true)
    scrollMessagesToBottom("smooth")

    // Snapshot attachments so we can restore them if the send fails, then clear
    // the chips immediately (they're now part of the optimistic message).
    const pendingAttachments = attachments
    setAttachments([])

    setBusySending(true)
    setRuntimeError(null)
    try {
      await api.sendPrompt(config, selectedSession.id, text, selectedSession.directory, activeModel, activeAgentID, pendingAttachments.length > 0 ? pendingAttachments : undefined)
      await loadSelected(selectedSession.id, selectedSession.directory)
      await refreshSessions()
    } catch (err) {
      completionShouldPlayRef.current = false
      setAwaitingAssistantReply(false)
      setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
      setComposer((current) => current || text)
      // Restore the attachments so the user can retry without re-picking.
      setAttachments(pendingAttachments)
      setRuntimeError((err as Error).message)
    } finally {
      setBusySending(false)
    }
  }

  async function deleteSession(sessionID: string) {
    try {
      await api.deleteSession(config, sessionID, sessionToDelete?.directory)
      if (selectedID === sessionID) {
        setSelectedID(null)
        setMessages([])
        setOptimisticUserMessages([])
        setTodos([])
        setDiffFiles([])
        setProjectDashboard(null)
        setDashboardError(null)
        setView("sessions")
      }
      setSessionToDelete(null)
      await refreshSessions(true)
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  async function abortSession() {
    if (!selectedSession) return
    try {
      await api.abort(config, selectedSession.id, selectedSession.directory)
      completionShouldPlayRef.current = false
      setAwaitingAssistantReply(false)
      await refreshSessions()
      await loadSelected(selectedSession.id, selectedSession.directory)
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission prompt (spec §6.1)
  // Fetches pending tool-permission requests for the open session. Tries the
  // session-scoped route first (GET /session/:id/permissions — mock-supported),
  // then the global route (GET /permission) filtered by sessionID. On the first
  // failure (404 / network) for a given session we mark the route unsupported
  // and stop polling it so we never spam a server that doesn't expose it.
  // Never throws — a missing endpoint just means no banner.
  // ─────────────────────────────────────────────────────────────────────────
  async function loadPendingPermissions(sessionID: string, directory: string) {
    if (permissionUnsupported) return
    try {
      // GET /permission = opencode "List pending permissions" (operationId
      // permission.list). NOTE: the session-scoped /session/:id/permissions route
      // does NOT exist on real opencode — it 200s the web-UI HTML, which broke the
      // old "try session-scoped first" flow. Go straight to the global list.
      const all = await api.listPendingPermissions(config, directory)
      const requests = (Array.isArray(all) ? all : []).filter(
        (req) => req && req.id && (!req.sessionID || req.sessionID === sessionID)
      )
      setPendingPermissions(requests)
    } catch (err) {
      const message = (err as Error).message || ""
      // 404 / "HTTP 404" => route not implemented on this server/mock.
      if (/404|not found/i.test(message)) {
        setPermissionUnsupported(true)
        setPendingPermissions([])
      }
      // Any other error (network blip) is swallowed — banner just won't show.
    }
  }

  /** Reply to a pending permission request (Once / Always / Reject). */
  async function replyPermission(request: PermissionRequest, response: PermissionReply, remember: boolean) {
    if (!selectedSession || replyingPermission) return
    setReplyingPermission(true)
    try {
      await api.replyPermission(
        config,
        selectedSession.id,
        request.id,
        response,
        remember,
        selectedSession.directory
      )
      // Optimistically drop the answered request; refetch to confirm.
      setPendingPermissions((current) => current.filter((req) => req.id !== request.id))
      await loadPendingPermissions(selectedSession.id, selectedSession.directory)
      await loadSelected(selectedSession.id, selectedSession.directory)
      showToast(
        response === "reject"
          ? "Permission rejected"
          : `Approved (${response})`
      )
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setReplyingPermission(false)
    }
  }

  // ── opencode Question system (multiple-choice prompts) ────────────────────
  // Clone of loadPendingPermissions: GET /question, keep this session's (or
  // global) requests, flip `questionUnsupported` on 404, swallow other errors.
  async function loadPendingQuestions(sessionID: string, directory: string) {
    if (questionUnsupported) return
    try {
      const all = await api.listPendingQuestions(config, directory)
      const requests = (Array.isArray(all) ? all : []).filter(
        (q) => q && q.id && (!q.sessionID || q.sessionID === sessionID)
      )
      setPendingQuestions(requests)
    } catch (err) {
      if (/404|not found/i.test((err as Error).message || "")) {
        setQuestionUnsupported(true)
        setPendingQuestions([])
      }
      // Other errors (network blip) swallowed — the prompt just won't show.
    }
  }

  /** Resolve a request's directory from its session (falls back to the open one). */
  function questionDirectory(request: QuestionRequest): string {
    if (request.sessionID) {
      const owner = sessionsRef.current.find((s) => s.id === request.sessionID)
      if (owner) return owner.directory
    }
    return selectedSession?.directory ?? ""
  }

  /** Submit answers to a question (one string[] per question, in order). */
  async function replyQuestion(request: QuestionRequest, answers: string[][]) {
    if (replyingQuestion) return
    setReplyingQuestion(true)
    try {
      await api.replyQuestion(config, request.id, answers, questionDirectory(request))
      setPendingQuestions((cur) => cur.filter((q) => q.id !== request.id))
      if (selectedSession) {
        await loadPendingQuestions(selectedSession.id, selectedSession.directory)
        await loadSelected(selectedSession.id, selectedSession.directory)
      }
      showToast(t('question.answered'))
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setReplyingQuestion(false)
    }
  }

  /** Decline a question (unblocks the agent). */
  async function rejectQuestion(request: QuestionRequest) {
    if (replyingQuestion) return
    setReplyingQuestion(true)
    try {
      await api.rejectQuestion(config, request.id, questionDirectory(request))
      setPendingQuestions((cur) => cur.filter((q) => q.id !== request.id))
      showToast(t('question.skipped'))
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setReplyingQuestion(false)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session actions menu (spec §6.3): Fork / Share / Summarize / Rename /
  // Delete (+ Revert on a message). Each mutates server state then refreshes the
  // session list/detail so the UI stays consistent.
  // ─────────────────────────────────────────────────────────────────────────
  async function forkCurrentSession() {
    if (!selectedSession || actionBusy) return
    setActionBusy("fork")
    try {
      const forked = await api.forkSession(config, selectedSession.id, undefined, selectedSession.directory)
      await refreshSessions()
      // Open the fork so the user lands on it.
      await openSession(forked.id, forked.directory)
      showToast("Session forked")
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setActionBusy(null)
      setActionsMenuOpen(false)
    }
  }

  async function shareCurrentSession() {
    if (!selectedSession || actionBusy) return
    setActionBusy("share")
    try {
      const updated = await api.shareSession(config, selectedSession.id, selectedSession.directory)
      const url = updated?.share?.url
      if (url) {
        try { await navigator.clipboard.writeText(url) } catch { /* clipboard may be blocked */ }
        showToast(`Share link copied`)
      } else {
        showToast("Session shared")
      }
      await refreshSessions()
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setActionBusy(null)
      setActionsMenuOpen(false)
    }
  }

  async function summarizeCurrentSession() {
    if (!selectedSession || actionBusy) return
    if (!activeModel) {
      showToast("Select a model first")
      return
    }
    setActionBusy("summarize")
    try {
      await api.summarizeSession(config, selectedSession.id, activeModel.providerID, activeModel.modelID, selectedSession.directory)
      await loadSelected(selectedSession.id, selectedSession.directory)
      showToast("Summarizing…")
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setActionBusy(null)
      setActionsMenuOpen(false)
    }
  }

  async function renameCurrentSession() {
    if (!selectedSession || actionBusy) return
    const next = window.prompt("Rename session", selectedSession.title)
    if (next === null) return
    const title = next.trim()
    if (!title || title === selectedSession.title) return
    setActionBusy("rename")
    try {
      await api.renameSession(config, selectedSession.id, title, selectedSession.directory)
      await refreshSessions()
      showToast("Session renamed")
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setActionBusy(null)
      setActionsMenuOpen(false)
    }
  }

  async function deleteCurrentSession() {
    if (!selectedSession || actionBusy) return
    if (!window.confirm(`Delete "${selectedSession.title}"? This cannot be undone.`)) return
    setActionBusy("delete")
    try {
      await api.deleteSession(config, selectedSession.id, selectedSession.directory)
      setSelectedID(null)
      setMessages([])
      setOptimisticUserMessages([])
      setTodos([])
      setDiffFiles([])
      setProjectDashboard(null)
      setDashboardError(null)
      setView("sessions")
      await refreshSessions(true)
      showToast("Session deleted")
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setActionBusy(null)
      setActionsMenuOpen(false)
    }
  }

  useEffect(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  }, [language])

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")

    function applyThemePreference() {
      const resolvedTheme = theme === "system" && mediaQuery.matches ? "dark" : theme === "dark" ? "dark" : "light"
      document.documentElement.dataset.theme = resolvedTheme
      document.documentElement.style.colorScheme = resolvedTheme
    }

    localStorage.setItem(THEME_STORAGE_KEY, theme)
    applyThemePreference()
    mediaQuery.addEventListener("change", applyThemePreference)
    return () => mediaQuery.removeEventListener("change", applyThemePreference)
  }, [theme])

  // Persist the appearance skin and reflect it on <html data-skin> so the
  // CSS token overrides (html[data-skin='official']) take effect app-wide.
  useEffect(() => {
    localStorage.setItem(SKIN_STORAGE_KEY, skin)
    document.documentElement.dataset.skin = skin
  }, [skin])

  useEffect(() => {
    localStorage.setItem(NEW_SESSION_DIRECTORY_STORAGE_KEY, newSessionDirectory)
  }, [newSessionDirectory])

  useEffect(() => {
    localStorage.setItem(PUSH_RELAY_URL_STORAGE_KEY, pushRelayUrl)
  }, [pushRelayUrl])

  useEffect(() => {
    localStorage.setItem(PUSH_RELAY_APIKEY_STORAGE_KEY, pushRelayApiKey)
  }, [pushRelayApiKey])

  // Push registration (iOS only). Requests APNS permission, then registers
  // the device token with the user's APNs relay so OpenCodeBar can push when
  // a session finishes. Re-runs when the relay URL/key change. No-ops on web.
  useEffect(() => {
    if (Capacitor.getPlatform() !== "ios") return
    if (!pushRelayUrl || !pushRelayApiKey) return
    let cancelled = false
    const listeners: Array<() => Promise<void>> = []

    async function registerForPush() {
      try {
        const perm = await PushNotifications.requestPermissions()
        if (cancelled) return
        if (perm.receive !== "granted") return
        await PushNotifications.register()
      } catch {
        // permission denied or registration failed — silent
      }
    }

    PushNotifications.addListener("registration", ({ value: token }) => {
      fetch(`${pushRelayUrl}/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pushRelayApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      }).catch(() => {})
    }).then((handle) => { listeners.push(handle.remove) })

    PushNotifications.addListener("registrationError", () => {
      // token request failed — silent (likely sim/device without APNs)
    }).then((handle) => { listeners.push(handle.remove) })

    PushNotifications.addListener("pushNotificationReceived", () => {
      // iOS displays the notification itself; nothing to do in-app.
    }).then((handle) => { listeners.push(handle.remove) })

    registerForPush()

    return () => {
      cancelled = true
      listeners.forEach((remove) => remove().catch(() => {}))
    }
  }, [pushRelayUrl, pushRelayApiKey])

  useEffect(() => {
    if (!config.host || config.port <= 0) {
      setConnectionState("idle")
      setConnectionMessage("")
      storeRef.current?.clearConfig()
      return
    }
    const store = storeRef.current!
    backgroundFailureCountRef.current = 0
    initialSessionLoadRef.current = true
    store.setConfig(config)
    const unsub = store.subscribe((s: StoreState) => {
      setConnectionState(s.connection)
      setConnectionMessage(s.connection === "connecting" ? t('connection.connecting')
        : s.connection === "connected" ? t('connection.connected')
        : s.connection === "reconnecting" ? t('connection.reconnecting')
        : s.connection === "offline" ? t('connection.offline') : "")
      if (s.connection === "connected") {
        refreshSessions(true).catch(() => undefined)
        if (selectedSession) loadSelected(selectedSession.id, selectedSession.directory).catch(() => undefined)
      }
    })
    refreshSessions(true).catch(() => undefined)
    loadCommands().catch(() => undefined)
    loadAgents().catch(() => undefined)
    loadModels().catch(() => undefined)
    loadProviders().catch(() => undefined)
    // opencode's /event SSE only emits server heartbeats reliably (the Tailscale
    // Serve proxy buffers session-scoped events — CLAUDE.md #4), so live UI updates
    // rely on polling. The interval is ADAPTIVE (spec §5): 1s when a followed/open
    // session is busy, 5s idle foreground, 20s background. A fixed setInterval
    // cannot adapt, so this is a self-rescheduling setTimeout that recomputes the
    // delay each tick via adaptivePollIntervalMs() and feeds the polled statuses
    // back into the store so hasBusySessions stays accurate even when the SSE
    // proxy swallows session.status events.
    const poll = async () => {
      try {
        await refreshSessions(true)
      } catch {
        /* swallowed — connection-state effect surfaces repeated failures */
      }
      // Feed the freshly-polled session statuses back so the adaptive interval
      // tracks busy state. syncBusyFromStatuses prunes sessions no longer in the
      // list, so a disappeared session can't pin the loop at 1s.
      store.syncBusyFromStatuses(
        Object.fromEntries(sessionsRef.current.map((s) => [s.id, s.status]))
      )
      const openID = selectedIDRef.current
      if (openID) {
        const open = sessionsRef.current.find((s) => s.id === openID)
        if (open) loadSelected(open.id, open.directory).catch(() => undefined)
        // Permission detection: poll GET /permission on every adaptive tick while a
        // session is open. opencode emits `permission.asked` SSE events, but SSE
        // through the Tailscale proxy isn't reliable, so we poll. Cheap GET; catches
        // a pending permission regardless of session status (busy/retry/idle/…).
        if (open) {
          loadPendingPermissions(open.id, open.directory).catch(() => undefined)
          loadPendingQuestions(open.id, open.directory).catch(() => undefined)
        }
      }
      // Reschedule with the adaptive delay for the NEXT tick.
      const delay = adaptivePollIntervalMs(store.getState(), {
        background: document.visibilityState === "hidden",
      })
      pollTimer = window.setTimeout(poll, delay)
    }
    let pollTimer = window.setTimeout(poll, adaptivePollIntervalMs(store.getState(), {
      background: document.visibilityState === "hidden",
    }))
    return () => { unsub(); window.clearTimeout(pollTimer) }
  }, [config.host, config.port, config.username, config.password, selectedSession?.id])

  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      SharedSnapshot.writeSnapshot({ data: buildSnapshot(sessions) }).catch(() => undefined)
    }
    // Drive the Live Activity from session status transitions (idle→busy / busy→idle).
    // Progress is only known for the open session (todos are loaded per-session via REST),
    // so background busy sessions pass -1 (no bar); the open session's progress is pushed
    // by the todos effect below and the poll loop.
    if (Capacitor.isNativePlatform()) {
      const prev = prevStatusRef.current
      for (const s of sessions) {
        const was = prev.get(s.id)
        const isBusy = s.status === "busy" || s.status === "retry"
        const wasBusy = was === "busy" || was === "retry"
        if (isBusy && !wasBusy) {
          startLiveActivity({
            sessionID: s.id,
            title: s.title,
            status: s.status as "busy" | "retry",
            detail: s.id === selectedSession?.id ? detailFromTodos(todos) : "Working…",
            progress: s.id === selectedSession?.id ? computeProgress(todos) : -1,
          })
        } else if (!isBusy && wasBusy) {
          endLiveActivity(s.id)
        }
        prev.set(s.id, s.status)
      }
    }
  }, [sessions])

  useEffect(() => {
    if (!hasConfiguredServer) {
      setView("settings")
    }
  }, [hasConfiguredServer])

  // Reset permission prompt + actions menu state whenever the open session
  // changes or closes, so stale requests from a prior session never show.
  useEffect(() => {
    setPendingPermissions([])
    setPendingQuestions([])
    setActionsMenuOpen(false)
    if (!selectedID) {
      setPermissionUnsupported(false)
      setQuestionUnsupported(false)
    }
  }, [selectedID])

  // Diagnostic panel (spec §6.6): fetch on tab open (once per open). On a
  // fresh open we reset the loaded flag so re-entering the tab re-fetches.
  useEffect(() => {
    if (helpPage !== "diagnostics") return
    if (!hasConfiguredServer) return
    loadDiagnostics().catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helpPage])

  // Close the actions menu on outside click / Escape (it's a dropdown overlay).
  useEffect(() => {
    if (!actionsMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target && !target.closest(".session-actions")) setActionsMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsMenuOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [actionsMenuOpen])

  useEffect(() => {
    if (view !== "detail") return
    scrollMessagesToBottom("auto")
  }, [view, messageScrollSignature, isWorking, showTypingBubble])

  useEffect(() => {
    if (!awaitingAssistantReply) return
    if (assistantResponseSignature && assistantResponseSignature !== awaitingAssistantBaselineRef.current) {
      setAwaitingAssistantReply(false)
    }
  }, [assistantResponseSignature, awaitingAssistantReply])

  // Drive the decode FX on the live (actively-streaming) assistant bubble.
  // The live bubble = the most recent assistant message whose text is still
  // growing while we wait for OpenCode to finish. We locate its DOM node as the
  // last `.message.assistant` article (excluding the typing-bubble) inside the
  // messages container, then run decodeText on its `.message-content` element.
  //
  // Caveat: decodeText writes raw text via innerHTML, which conflicts with the
  // ReactMarkdown tree React owns. To avoid fighting React reconciliation we
  // only apply decode to PLAIN-TEXT content (the common streaming case). When
  // the live text contains markdown we leave ReactMarkdown in place and skip
  // the FX for that message. On stream end we settle (plain text via decodeText
  // internally) and clear the node ref so React's next render restores markdown.
  const lastAssistant = useMemo(() => {
    for (let i = renderedMessages.length - 1; i >= 0; i--) {
      if (renderedMessages[i].info.role !== "user") return renderedMessages[i]
    }
    return null
  }, [renderedMessages])

  useEffect(() => {
    if (!lastAssistant) {
      settleLiveDecode()
      liveDecodeElRef.current = null
      return
    }
    // Trigger the katakana→text decode while streaming (text grows) OR once when a
    // new assistant message appears — so it animates even if the message arrived
    // complete (the old streaming-only trigger missed those, which is why the
    // decode effect seemed "lost" with polling-fetched messages).
    const streaming = awaitingAssistantReply
    const isNewMessage = lastAssistant.info.id !== prevDecodedIdRef.current
    if (!streaming && !isNewMessage) {
      settleLiveDecode()
      liveDecodeElRef.current = null
      return
    }
    prevDecodedIdRef.current = lastAssistant.info.id

    const target = lastAssistant.text
    // Heuristic: treat as plain text when there are no markdown-significant
    // tokens. Markdown-bearing content stays with ReactMarkdown (no decode).
    const looksPlain = !/[#*_`~\[\](<>]|^\s*[-*+]\s/m.test(target)
    if (!looksPlain) {
      settleLiveDecode()
      liveDecodeElRef.current = null
      return
    }

    const container = messagesRef.current
    if (!container) return
    // Most recent assistant article, excluding the typing bubble.
    const articles = container.querySelectorAll<HTMLElement>(
      ".message.assistant:not(.typing-bubble)"
    )
    const node = articles[articles.length - 1]
    const contentEl = node?.querySelector<HTMLElement>(".message-text")
    if (!node || !contentEl) return

    liveDecodeElRef.current = contentEl
    if (isDecodeEnabled()) {
      // decodeText settles a prior run on the same element internally.
      liveDecodeHandleRef.current = decodeText(contentEl, target)
    } else {
      // Decode disabled: render plain text, no animation.
      settleLiveDecode()
      contentEl.textContent = target
    }
  }, [awaitingAssistantReply, lastAssistant, lastAssistant?.text])

  // On unmount, settle any in-flight decode so we never leak a rAF.
  useEffect(() => {
    return () => {
      settleLiveDecode()
      liveDecodeElRef.current = null
    }
  }, [])

  useEffect(() => {
    completionAudioRef.current = new Audio("/audio/staplebops-01.aac")
    completionAudioRef.current.preload = "auto"
  }, [])

  useEffect(() => {
    if (wasAwaitingAssistantReplyRef.current && !awaitingAssistantReply && completionShouldPlayRef.current) {
      completionShouldPlayRef.current = false
      const audio = completionAudioRef.current
      if (audio) {
        audio.currentTime = 0
        audio.play().catch(() => undefined)
      }
    }
    wasAwaitingAssistantReplyRef.current = awaitingAssistantReply
  }, [awaitingAssistantReply])

  useEffect(() => {
    if (!selectedSession) {
      wasRunningRef.current = false
      return
    }
    wasRunningRef.current = ["busy", "retry"].includes(selectedSession.status)
  }, [selectedSession?.id, selectedSession?.status])

  // Push Live Activity progress/detail updates for the open session while it runs.
  // Progress comes from the session's todo list (loaded via REST in loadSelected).
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !selectedSession) return
    const isBusy = selectedSession.status === "busy" || selectedSession.status === "retry"
    if (!isBusy) return
    updateLiveActivity({
      sessionID: selectedSession.id,
      title: selectedSession.title,
      status: selectedSession.status as "busy" | "retry",
      detail: detailFromTodos(todos),
      progress: computeProgress(todos),
    })
  }, [selectedSession?.id, selectedSession?.status, selectedSession?.title, todos])

  const navItems = [
    { view: "sessions" as const, label: t('nav.sessions'), icon: <FolderIcon size={19} />, disabled: !hasConfiguredServer },
    { view: "detail" as const, label: t('nav.detail'), icon: <ChatIcon size={19} />, disabled: !selectedSession },
    { view: "settings" as const, label: t('nav.settings'), icon: <SettingsIcon size={19} />, disabled: false },
    { view: "help" as const, label: t('nav.help'), icon: <HelpIcon size={19} />, disabled: false }
  ]

  // ---- iPad landscape 3-zone wiring (design doc §4) ----------------------
  // Lazily populate the Inspector's Diag tab when the landscape layout first
  // mounts with an active session (mirrors Help → Diagnostics' lazy load).
  useEffect(() => {
    if (isLandscapeRegular && selectedID && !diagLoaded && !diagLoading) {
      loadDiagnostics().catch(() => undefined)
    }
    // loadDiagnostics is a hoisted, stable closure; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLandscapeRegular, selectedID])

  // Subscribe the global keyboard layer once; it dispatches through the latest
  // ref so it never holds stale state (design doc §4 shortcut table).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keydownHandlerRef.current(event)
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // If the fx initializer auto-softened the rain on this launch, tell the user
  // once (they can re-bump it in Settings). Toast-only — the state change itself
  // already happened at init, so there is no apply race here.
  useEffect(() => {
    if (fxAutoDegradedRef.current) showToast(t('fx.autoDegraded'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Read-only diagnostics snapshot the Inspector's Diag tab renders. Built from
  // the same diag state the Help → Diagnostics panel uses; null until loaded.
  const inspectorDiag: DiagSnapshot | null = useMemo(() => {
    if (
      !diagLoaded &&
      diagMCP === undefined &&
      diagLSP === undefined &&
      diagFormatter === undefined &&
      diagConfig === undefined
    ) {
      return null
    }
    return {
      mcp: diagMCP?.data ?? undefined,
      lsp: diagLSP?.data ?? undefined,
      formatter: diagFormatter?.data ?? undefined,
      config: diagConfig?.data ?? undefined,
    }
  }, [diagLoaded, diagMCP, diagLSP, diagFormatter, diagConfig])

  const sidebarLabels = {
    title: t('nav.sessions'),
    newSession: t('sessions.new'),
    search: t('sessions.searchPlaceholder'),
    settings: t('nav.settings'),
    help: t('nav.help'),
    reconnect: t('sessions.refresh'),
    skin: t('settings.skin'),
    collapse: t('sidebar.collapse'),
  }
  const inspectorLabels = {
    terminalTitle: t('detail.terminalTitle'),
    terminalHint: t('detail.terminalHint'),
    terminalPlaceholder: t('detail.terminalPlaceholder'),
    terminalRunning: t('detail.terminalRunning'),
    terminalPrompt: t('detail.terminalPrompt'),
    todo: t('inspector.todo'),
    diag: t('inspector.diag'),
    files: t('inspector.files'),
    emptyTodo: t('inspector.emptyTodo'),
  }

  // ---- opencode Question prompts: labels + inline-vs-modal placement -------
  const questionLabels = {
    back: t('question.back'),
    next: t('question.next'),
    submit: t('question.submit'),
    skip: t('question.skip'),
    other: t('question.other'),
    otherPlaceholder: t('question.otherPlaceholder'),
    progress: (current: number, totalCount: number) => `${current}/${totalCount}`,
  }
  // Inline (in the chat) when viewing the asking session; everything else (other
  // session / non-detail view) surfaces one at a time as a modal so it's unmissable.
  const inlineQuestions = pendingQuestions.filter(
    (q) => view === "detail" && q.sessionID === selectedSession?.id
  )
  const modalQuestion = pendingQuestions.find((q) => !inlineQuestions.includes(q))

  // ---- ⌘K command palette items + keyboard layer (design doc §4) ----------
  const focusSelector = (selector: string) => {
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())
  }
  const paletteDirLabel = (directory: string) =>
    directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || directory

  // Rebuilt each render (cheap, ~tens of items) so every `run` closure is fresh.
  const paletteCommands: CommandItem[] = []
  const navGroup = t('palette.groupNav')
  paletteCommands.push(
    { id: "nav-new", label: t('sessions.new'), hint: "⌘T", group: navGroup, run: () => openNewSessionPicker() },
    { id: "nav-sessions", label: t('nav.sessions'), group: navGroup, run: () => setView("sessions") },
    { id: "nav-settings", label: t('nav.settings'), group: navGroup, run: () => setView("settings") },
    { id: "nav-help", label: t('nav.help'), group: navGroup, run: () => setView("help") },
    { id: "nav-reconnect", label: t('sessions.refresh'), group: navGroup, run: () => { refreshSessionsWithIndicator() } },
    { id: "fx-toggle", label: t('palette.toggleFx'), hint: "⌘/", group: navGroup, run: () => setFx((f) => setFxEnabled("scan", !f.scan)) },
  )
  if (selectedSession) {
    const actGroup = t('palette.groupActions')
    paletteCommands.push(
      { id: "act-fork", label: "Fork", group: actGroup, run: () => { forkCurrentSession() } },
      { id: "act-share", label: "Share", group: actGroup, run: () => { shareCurrentSession() } },
      { id: "act-summarize", label: "Summarize", group: actGroup, run: () => { summarizeCurrentSession() } },
      { id: "act-rename", label: "Rename", group: actGroup, run: () => { renameCurrentSession() } },
      { id: "act-delete", label: "Delete", group: actGroup, run: () => { deleteCurrentSession() } },
    )
    if (isWorking) {
      paletteCommands.push({ id: "act-abort", label: t('palette.abort'), hint: "⌘.", group: actGroup, run: () => { abortSession() } })
    }
  }
  const sessGroup = t('palette.groupSessions')
  for (const s of sessions) {
    paletteCommands.push({
      id: `sess-${s.id}`,
      label: s.title || s.id,
      hint: paletteDirLabel(s.directory),
      group: sessGroup,
      run: () => openSession(s.id, s.directory),
    })
  }
  const slashGroup = t('palette.groupSlash')
  for (const cmd of commands) {
    paletteCommands.push({
      id: `cmd-${cmd.name}`,
      label: `/${cmd.name}`,
      hint: cmd.description,
      group: slashGroup,
      run: () => { setView("detail"); setComposer(`/${cmd.name} `); focusSelector(".composer textarea") },
    })
  }

  // Single global keydown handler (subscribed once below). All ⌘/Ctrl shortcuts
  // preventDefault; bare keys are ignored so typing is never hijacked.
  keydownHandlerRef.current = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (commandPaletteOpen) setCommandPaletteOpen(false)
      return
    }
    if (!event.metaKey && !event.ctrlKey) return
    switch (event.key.toLowerCase()) {
      case "k":
        event.preventDefault()
        setCommandPaletteOpen((open) => !open)
        break
      case "\\":
        if (isLandscapeRegular) {
          event.preventDefault()
          toggleSidebarCollapsed()
        }
        break
      case "t":
        event.preventDefault()
        openNewSessionPicker()
        break
      case ".":
        if (selectedSession && isWorking) {
          event.preventDefault()
          abortSession()
        }
        break
      case "/":
        event.preventDefault()
        setFx((current) => setFxEnabled("scan", !current.scan))
        break
      case "1":
        event.preventDefault()
        focusSelector(".sidebar-search-input")
        break
      case "2":
        event.preventDefault()
        setFocusZone("chat")
        focusSelector(".composer textarea")
        break
      case "3":
        event.preventDefault()
        setFocusZone("terminal")
        focusSelector(".terminal-input")
        break
      case "enter":
        if (focusZone === "chat" && composer.trim() && !isWorking) {
          event.preventDefault()
          send()
        }
        break
      default:
        break
    }
  }

  return (
    <div
      className={`app-shell${isLandscapeRegular ? " app-shell--landscape" : ""}${
        isLandscapeRegular && sidebarCollapsed ? " app-shell--sidebar-collapsed" : ""
      }`}
    >
      <header className="top-nav fade-in">
        <div className="brand-section">
          <div className="brand-title">
            <img src="/icon.png" alt="" className="app-icon" />
            <div>
              <h1 className="fx-glow">{t('app.title')}</h1>
              <p className="subtle">
                {hasConfiguredServer ? `${config.host}:${config.port}` : t('settings.title')}
              </p>
            </div>
          </div>
        </div>

        <nav className="desktop-nav tab-row" role="navigation" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              key={item.view}
              className={view === item.view ? "active" : ""}
              onClick={() => setView(item.view)}
              disabled={item.disabled}
              aria-label={item.label}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </header>

      {/* iPad landscape: sessions sidebar (left zone) — replaces both top-nav
          tab-row and bottom-nav. Always shows the sessions list; selecting one
          loads it into the center chat column. (design doc §4) */}
      {isLandscapeRegular && (
        <Sidebar
          sessions={sessions}
          selectedID={selectedID}
          onSelect={(id) => {
            const target = sessions.find((s) => s.id === id)
            if (target) openSession(target.id, target.directory)
          }}
          onNew={openNewSessionPicker}
          onReconnect={refreshSessionsWithIndicator}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebarCollapsed}
          onSettings={() => setView("settings")}
          onHelp={() => setView("help")}
          onSkin={() => setSkin((current) => (current === "matrix" ? "official" : "matrix"))}
          labels={sidebarLabels}
        />
      )}

      {/* iPad landscape: right inspector (terminal / todo / diag / files).
          Renders only with an active session; otherwise a thin placeholder so
          the 3rd grid column reads as intentional, not broken. (design doc §4) */}
      {isLandscapeRegular &&
        (selectedSession ? (
          <Inspector
            config={config}
            session={{ id: selectedSession.id, directory: selectedSession.directory }}
            agent={activeAgentID}
            model={activeModel}
            todos={todos}
            diag={inspectorDiag}
            labels={inspectorLabels}
          />
        ) : (
          <aside className="inspector inspector--empty" aria-label="Inspector">
            <p className="subtle" style={{ padding: 16, textAlign: "center" }}>
              {t('detail.selectSession')}
            </p>
          </aside>
        ))}

      {view === "settings" && (
        <section className="panel settings fade-in">
          <div className="section-heading">
            <div>
              <h2>{t('settings.title')}</h2>
              <p className="subtle">{hasConfiguredServer ? `${config.host}:${config.port}` : t('settings.hostPlaceholder')}</p>
              <p className="subtle">{t('settings.draftHint')}</p>
            </div>
          </div>

          <div className="form-grid">
          {/* Appearance skin — 2-skin segmented control (Matrix default / OpenCode official).
              Drives <html data-skin>; FX toggles below are hidden when 'official' is active. */}
          <div className="fx-settings" role="group" aria-label={t('settings.skin')}>
            <div className="fx-settings-title">{t('settings.skin')}</div>
            <div className="desktop-nav tab-row" role="group" aria-label={t('settings.skin')} style={{ width: "100%" }}>
              <button
                type="button"
                className={skin === "matrix" ? "active" : ""}
                onClick={() => setSkin("matrix")}
                aria-pressed={skin === "matrix"}
                style={{ flex: 1, justifyContent: "center" }}
              >
                <span>{t('settings.skinMatrix')}</span>
              </button>
              <button
                type="button"
                className={skin === "official" ? "active" : ""}
                onClick={() => setSkin("official")}
                aria-pressed={skin === "official"}
                style={{ flex: 1, justifyContent: "center" }}
              >
                <span>{t('settings.skinOfficial')}</span>
              </button>
            </div>
            <small className="fx-switch-label" style={{ color: "var(--muted)", fontSize: "var(--fs-xs)" }}>
              {t('settings.skinHint')}
            </small>
          </div>

          <label htmlFor="language">
            {t('settings.language')}
            <select
              id="language"
              value={language}
              onChange={(event) => setLanguage(normalizeLanguage(event.target.value))}
            >
              {languageOptions.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
          </label>

          {/* Matrix is dark-only; the light/system theme picker was removed.
              `t('settings.theme')` is reused as the FX section heading so the
              localized theme string is still referenced (see i18n).
              FX toggles are Matrix-only — hidden when the 'official' skin is active. */}
          {skin === "matrix" && (
          <div className="fx-settings" aria-label={t('settings.theme')}>
            <div className="fx-settings-title">{t('settings.theme')}</div>

            <button
              type="button"
              className="fx-switch"
              data-on={fx.scan ? "true" : "false"}
              onClick={() => setFx(setFxEnabled("scan", !fx.scan))}
              aria-pressed={fx.scan}
            >
              <span className="fx-switch-label">
                <strong>{t('settings.fxScan')}</strong>
                <small>{t('settings.fxScanDesc')}</small>
              </span>
              <span className="fx-switch-track" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="fx-switch"
              data-on={fx.decode ? "true" : "false"}
              onClick={() => setFx(setFxEnabled("decode", !fx.decode))}
              aria-pressed={fx.decode}
            >
              <span className="fx-switch-label">
                <strong>{t('settings.fxDecode')}</strong>
                <small>{t('settings.fxDecodeDesc')}</small>
              </span>
              <span className="fx-switch-track" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="fx-switch"
              data-on={fx.rain !== "off" ? "true" : "false"}
              onClick={() => setFx(cycleRainLevel())}
              aria-label={t('settings.fxRain')}
              title="Tap to cycle"
            >
              <span className="fx-switch-label">
                <strong>{t('settings.fxRain')}</strong>
                <small>{t('settings.fxRainDesc')} · {fx.rain === "off" ? t('settings.fxRainOff') : fx.rain === "low" ? t('settings.fxRainLow') : fx.rain === "high" ? t('settings.fxRainHigh') : t('settings.fxRainMed')}</small>
              </span>
              <span className="fx-switch-track" aria-hidden="true" />
            </button>
          </div>
          )}

          <label htmlFor="host">
            {t('settings.host')}
            <input 
              id="host"
              value={draftConfig.host} 
              onChange={(event) => setDraftConfig({ ...draftConfig, host: event.target.value })} 
              placeholder={t('settings.hostPlaceholder')}
            />
          </label>
          
          <label htmlFor="port">
            {t('settings.port')}
            <input
              id="port"
              type="number"
              value={draftConfig.port}
              onChange={(event) => setDraftConfig({ ...draftConfig, port: Number(event.target.value || 0) })}
              placeholder="4096"
            />
          </label>
          
          <label htmlFor="username">
            {t('settings.username')}
            <input
              id="username"
              value={draftConfig.username}
              onChange={(event) => setDraftConfig({ ...draftConfig, username: event.target.value })}
              placeholder="opencode"
            />
          </label>
          
          <label htmlFor="password">
            {t('settings.password')}
            <input
              id="password"
              type="password"
              value={draftConfig.password}
              onChange={(event) => setDraftConfig({ ...draftConfig, password: event.target.value })}
              placeholder={t('settings.passwordPlaceholder')}
            />
          </label>
          </div>

          <div className="fx-settings" role="group" aria-label={t('settings.pushSection')}>
            <div className="fx-settings-title">{t('settings.pushSection')}</div>
            <label htmlFor="pushRelayUrl" className="fx-switch-label">
              <strong>{t('settings.pushRelayUrl')}</strong>
              <input
                id="pushRelayUrl"
                value={pushRelayUrl}
                onChange={(event) => setPushRelayUrl(event.target.value.trim())}
                placeholder="https://push.shathony.fr"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <label htmlFor="pushRelayApiKey" className="fx-switch-label">
              <strong>{t('settings.pushRelayApiKey')}</strong>
              <input
                id="pushRelayApiKey"
                type="password"
                value={pushRelayApiKey}
                onChange={(event) => setPushRelayApiKey(event.target.value.trim())}
                placeholder="mpr_…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <small className="fx-switch-label" style={{ color: "var(--muted)", fontSize: "var(--fs-xs)" }}>
              {t('settings.pushHint')}
            </small>
          </div>

          <div className="actions">
            <button 
              onClick={saveConfig} 
              disabled={testingConnection || !hasDraftChanges}
              className="btn-primary"
            >
              <SaveIcon size={18} />
              {hasDraftChanges ? t('settings.save') : t('settings.savedButton')}
            </button>
            <button 
              onClick={() => testConnection(draftConfig)} 
              className="btn-secondary"
              disabled={testingConnection || !canTestDraft || testAlreadyPassedForDraft}
              title={!canTestDraft ? t('settings.testNeedsFields') : testAlreadyPassedForDraft ? t('settings.testAlreadyPassed') : undefined}
            >
              {testingConnection ? (
                <>
                  <LoadingIcon size={18} />
                  {t('settings.testing')}
                </>
              ) : (
                <>
                  <TestIcon size={18} />
                  {testAlreadyPassedForDraft ? t('settings.testOk') : t('settings.test')}
                </>
              )}
            </button>
          </div>
          
          {settingsNotice && (
            <div className={`notice ${settingsNotice.type} fade-in`}>
              {settingsNotice.type === 'success' && <CheckIcon size={14} />}
              {settingsNotice.type === 'success' && ' '}
              {settingsNotice.type === 'error' && <CrossIcon size={14} />}
              {settingsNotice.type === 'error' && ' '}
              {settingsNotice.type === 'info' && 'ℹ '}
              {settingsNotice.text}
            </div>
          )}
          
          <div className="connection-help">
            <span>{canTestDraft ? t('settings.readyToTest') : t('settings.testNeedsFields')}</span>
            <span>{hasDraftChanges ? t('settings.unsavedChanges') : t('settings.noUnsavedChanges')}</span>
          </div>

          {connectedVersion && testAlreadyPassedForDraft && (
            <div className="notice success fade-in">
              <TestIcon size={16} />
              {t('settings.connectedTo', { version: connectedVersion })}
            </div>
          )}
        </section>
      )}

      {/* In landscape the sidebar IS the sessions list, so the center shows a
          chat empty-state instead of a redundant second list (design doc §4). */}
      {view === "sessions" && isLandscapeRegular && (
        <section className="panel detail landscape-empty-center fade-in" aria-label={t('detail.selectSession')}>
          <div className="empty-state">
            <ChatIcon size={40} className="icon-empty-state" />
            <p>{t('detail.selectSession')}</p>
            <p className="subtle">
              {t('sessions.summary', { total: sessions.length, active: activeSessions, changed: changedSessions })}
            </p>
          </div>
        </section>
      )}

      {view === "sessions" && !isLandscapeRegular && (
        <section className="panel sessions fade-in">
          <div className="section-heading">
            <div>
              <h2>{t('sessions.title')}</h2>
              <p className="subtle">
                {t('sessions.summary', { total: sessions.length, active: activeSessions, changed: changedSessions })}
              </p>
              {connectionStatusText && (
                <p className={`connection-status ${connectionState}`}>
                  {['connecting', 'reconnecting'].includes(connectionState) && <LoadingIcon size={14} />}
                  {connectionStatusText}
                </p>
              )}
            </div>
            <div className="inline-actions">
              <button onClick={refreshSessionsWithIndicator} className="btn-secondary" disabled={refreshingSessions}>
                {refreshingSessions ? <LoadingIcon size={18} /> : <RefreshIcon size={18} />}
                {t('sessions.refresh')}
              </button>
              <button onClick={openNewSessionPicker} className="btn-primary" disabled={creatingSession}>
                {creatingSession ? <LoadingIcon size={18} /> : <PlusIcon size={18} />}
                {creatingSession ? t('sessions.creating') : t('sessions.new')}
              </button>
            </div>
          </div>
          
          <div className="toolbar">
            <input
              placeholder={t('sessions.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="search"
            />
          </div>
          
          <div className="session-list">
            {filteredSessions.length === 0 && ['connecting', 'reconnecting'].includes(connectionState) ? (
              <div className="empty-state connection-pending">
                <LoadingIcon size={40} className="icon-empty-state" />
                <p>{t('sessions.loadingTitle')}</p>
                <p className="subtle">{t('sessions.loadingHint')}</p>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="empty-state">
                <FolderIcon size={48} className="icon-empty-state" />
                <p>{t('sessions.emptyTitle')}</p>
                <p className="subtle">{connectionState === "offline" ? t('sessions.offlineHint') : t('sessions.emptyHint')}</p>
              </div>
            ) : (
              filteredSessions.map((session) => (
                <article 
                  key={session.id} 
                  className={`session-card ${selectedID === session.id ? "active" : ""} fade-in`}
                  onClick={() => openSession(session.id, session.directory).catch(() => undefined)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      openSession(session.id, session.directory).catch(() => undefined)
                    }
                  }}
                >
                  <div className="session-card-main">
                    <div>
                      <h3>{session.title}</h3>
                      <p>{session.directory}</p>
                    </div>
                    <span className={`pill ${session.status}`}>{session.status}</span>
                  </div>
                  <div className="session-stats">
                    {session.files > 0 || session.additions > 0 || session.deletions > 0 ? (
                      <span className="change-summary">
                        <strong>{session.files}</strong> files
                        <strong className="positive">+{session.additions}</strong>
                        <strong className="negative">-{session.deletions}</strong>
                      </span>
                    ) : (
                      <span className="subtle">{t('sessions.noFileChanges')}</span>
                    )}
                    <span className="subtle">{t('sessions.updated', { time: formatTime(session.updated) })}</span>
                  </div>
                  <div className="inline-actions">
                    <button
                      onClick={(event) => {
                        event.stopPropagation()
                        openSession(session.id, session.directory).catch(() => undefined)
                      }}
                      className="btn-primary"
                    >
                      <PlayIcon size={16} />
                      {t('sessions.open')}
                    </button>
                    <button 
                      className="btn-danger" 
                      onClick={(event) => {
                        event.stopPropagation()
                        setSessionToDelete(session)
                      }}
                    >
                      <TrashIcon size={16} />
                      {t('sessions.delete')}
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
          
          {runtimeError && <div className="error fade-in"><CrossIcon size={14} /> {runtimeError}</div>}
        </section>
      )}

      {showNewSessionPicker && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowNewSessionPicker(false)}>
          <section
            className="modal-card folder-picker fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-session-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="new-session-title">{t('sessions.newSessionTitle')}</h2>
            <p className="subtle">{t('sessions.projectDirectoryDefault')}</p>
            <div className="folder-picker-current">
              <span>{t('sessions.projectDirectoryLabel')}</span>
              <strong>{pickerPath || t('detail.loadingProject')}</strong>
            </div>
            <div className="inline-actions">
              <button type="button" className="btn-secondary" onClick={() => createSession("").catch(() => undefined)} disabled={creatingSession}>
                {t('sessions.useServerDefault')}
              </button>
              <button type="button" className="btn-primary" onClick={() => createSession(pickerPath).catch(() => undefined)} disabled={creatingSession || !pickerPath}>
                {creatingSession ? <LoadingIcon size={16} /> : <PlusIcon size={16} />}
                {t('sessions.useThisFolder')}
              </button>
            </div>
            {pickerError && <div className="error fade-in"><CrossIcon size={14} /> {pickerError}</div>}
            <div className="folder-list">
              {pickerLoading ? (
                <div className="empty-state compact"><LoadingIcon size={28} /><p>{t('sessions.folderPickerLoading')}</p></div>
              ) : (
                <>
                  {parentDirectory(pickerPath) && (
                    <button type="button" className="folder-row" onClick={() => browseNewSessionDirectory(parentDirectory(pickerPath) ?? pickerPath).catch(() => undefined)}>
                      <FolderIcon size={16} />
                      <span>{t('sessions.parentFolder')}</span>
                    </button>
                  )}
                  {pickerItems.length === 0 ? (
                    <p className="subtle">{t('sessions.folderPickerEmpty')}</p>
                  ) : pickerItems.map((item) => (
                    <button key={item.absolute} type="button" className="folder-row" onClick={() => browseNewSessionDirectory(item.absolute).catch(() => undefined)}>
                      <FolderIcon size={16} />
                      <span>{item.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowNewSessionPicker(false)}>
                {t('session.cancel')}
              </button>
            </div>
          </section>
        </div>
      )}

      {showFilePicker && selectedSession && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowFilePicker(false)}>
          <section
            className="modal-card file-picker fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="file-picker-title">Attach file</h2>
            <p className="subtle">Browse the project tree or search by name. Files attach by server path.</p>

            <div className="file-picker-search">
              <input
                value={filePickerQuery}
                onChange={(event) => scheduleFilePickerSearch(event.target.value)}
                placeholder="Search files by name…"
                autoComplete="off"
              />
              {filePickerSearching && <LoadingIcon size={16} className="file-picker-search-spin" />}
            </div>

            <div className="folder-picker-current">
              <span>Path</span>
              <strong>{filePickerPath || "—"}</strong>
            </div>

            {filePickerError && <div className="error fade-in"><CrossIcon size={14} /> {filePickerError}</div>}

            <div className="folder-list file-picker-list">
              {filePickerLoading && !filePickerQuery ? (
                <div className="empty-state compact"><LoadingIcon size={28} /><p>Loading…</p></div>
              ) : filePickerQuery && filePickerResults !== null ? (
                filePickerResults.length === 0 ? (
                  <p className="subtle">No files match “{filePickerQuery}”.</p>
                ) : (
                  filePickerResults.map((path) => {
                    const name = path.split(/[/\\]/).filter(Boolean).pop() || path
                    return (
                      <button
                        key={path}
                        type="button"
                        className="folder-row file-row"
                        onClick={() => { attachPath(path); setShowFilePicker(false) }}
                        title={path}
                      >
                        <span className="file-row-glyph" aria-hidden="true"><FileIcon size={16} /></span>
                        <span className="file-row-name">{name}</span>
                        <small className="file-row-path">{path}</small>
                      </button>
                    )
                  })
                )
              ) : filePickerItems.length === 0 ? (
                <p className="subtle">No files here.</p>
              ) : (
                <>
                  {parentDirectory(filePickerPath) && (
                    <button
                      type="button"
                      className="folder-row"
                      onClick={() => browseAttachDirectory(parentDirectory(filePickerPath) ?? filePickerPath).catch(() => undefined)}
                    >
                      <FolderIcon size={16} />
                      <span>…</span>
                    </button>
                  )}
                  {filePickerItems.map((item) => (
                    <button
                      key={item.absolute}
                      type="button"
                      className={`folder-row file-row${item.type === "directory" ? " is-dir" : ""}`}
                      onClick={() => {
                        if (item.type === "directory") {
                          browseAttachDirectory(item.absolute).catch(() => undefined)
                        } else {
                          attachFileEntry(item)
                        }
                      }}
                      title={item.absolute}
                    >
                      {item.type === "directory" ? <FolderIcon size={16} /> : <span className="file-row-glyph" aria-hidden="true"><FileIcon size={16} /></span>}
                      <span className="file-row-name">{fileEntryLabel(item)}</span>
                    </button>
                  ))}
                </>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowFilePicker(false)}>
                {t('session.cancel')}
              </button>
            </div>
          </section>
        </div>
      )}

      {view === "detail" && (
        <main className="panel detail fade-in">
          <div className="detail-topbar">
            <button className="btn-secondary" onClick={() => {
              setView("sessions");
              requestAnimationFrame(() => document.querySelector<HTMLElement>(".session-card.active")?.scrollIntoView({ block: "center" }));
            }}><ChevronLeftIcon size={16} /> {t('detail.backToSessions')}</button>
            {selectedSession && (
              <span className={`pill ${selectedSession.status}`}>{selectedSession.status}</span>
            )}
            {selectedSession && (
              <div className="session-actions">
                <button
                  type="button"
                  className="btn-secondary actions-trigger"
                  onClick={() => setActionsMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={actionsMenuOpen}
                  aria-label="Session actions"
                  disabled={Boolean(actionBusy)}
                  title="Session actions"
                >
                  {actionBusy ? <LoadingIcon size={18} /> : <span aria-hidden="true">⋯</span>}
                </button>
                {actionsMenuOpen && (
                  <div className="action-menu" role="menu" aria-label="Session actions">
                    <button type="button" role="menuitem" className="action-item" onClick={forkCurrentSession} disabled={Boolean(actionBusy)}>
                      <span aria-hidden="true">⑂</span> Fork
                    </button>
                    <button type="button" role="menuitem" className="action-item" onClick={shareCurrentSession} disabled={Boolean(actionBusy)}>
                      <span aria-hidden="true"><LinkIcon size={14} /></span> Share
                    </button>
                    <button type="button" role="menuitem" className="action-item" onClick={summarizeCurrentSession} disabled={Boolean(actionBusy)}>
                      <span aria-hidden="true"><SparkleIcon size={14} /></span> Summarize
                    </button>
                    <button type="button" role="menuitem" className="action-item" onClick={renameCurrentSession} disabled={Boolean(actionBusy)}>
                      <span aria-hidden="true"><PencilIcon size={14} /></span> Rename
                    </button>
                    <button type="button" role="menuitem" className="action-item danger" onClick={deleteCurrentSession} disabled={Boolean(actionBusy)}>
                      <span aria-hidden="true">⌫</span> Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="header-row detail-header">
              <div>
              <h2 className="fx-glow">
                {selectedSession ? (
                  <>
                    <ChatIcon size={24} className="icon-inline-heading" />
                    {selectedSession.title}
                  </>
                ) : (
                  t('detail.selectSession')
                )}
              </h2>
              {selectedSession && (
                <p className="subtle">
                  {selectedSession.directory} • {t('sessions.updated', { time: formatTime(selectedSession.updated) })}
                </p>
                )}
              </div>
            </div>

          {inlineQuestions.length > 0 && (
            <div className="question-banner-stack" role="region" aria-label={t('question.title')}>
              {inlineQuestions.map((q) => (
                <QuestionPrompt
                  key={q.id}
                  request={q}
                  busy={replyingQuestion}
                  onReply={(answers) => replyQuestion(q, answers)}
                  onReject={() => rejectQuestion(q)}
                  labels={questionLabels}
                />
              ))}
            </div>
          )}

          {selectedSession && pendingPermissions.length > 0 && (
            <div className="perm-banner-stack" role="region" aria-label="Pending permission requests">
              {pendingPermissions.map((request) => {
                const resources = describePermissionResources(request)
                return (
                  <div key={request.id} className="perm-banner fade-in" role="alert">
                    <div className="perm-banner-head">
                      <span className="perm-glyph" aria-hidden="true"><WarningIcon size={14} /></span>
                      <strong className="perm-action">{request.action || "tool"} wants permission</strong>
                    </div>
                    {resources && <code className="perm-resources">{resources}</code>}
                    <div className="perm-actions">
                      <button
                        type="button"
                        className="btn-primary compact"
                        onClick={() => replyPermission(request, "once", false)}
                        disabled={replyingPermission}
                      >Once</button>
                      <button
                        type="button"
                        className="btn-primary compact"
                        onClick={() => replyPermission(request, "always", true)}
                        disabled={replyingPermission}
                      >Always</button>
                      <button
                        type="button"
                        className="btn-danger compact"
                        onClick={() => replyPermission(request, "reject", false)}
                        disabled={replyingPermission}
                      >Reject</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {selectedSession && (
            <section className="session-context-strip" aria-label={t('detail.contextStripLabel')}>
              {showModelChip && (
                <button type="button" className="context-chip" onClick={() => setActiveDetailSheet("ai")}>
                  <span>{t('detail.aiChip')}</span>
                  <strong>{agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })} · {activeModelOption?.modelName ?? t('detail.modelLoading')}</strong>
                </button>
              )}

              <button type="button" className="context-chip ghost" onClick={() => setActiveDetailSheet("details")}>
                <span>{t('detail.detailsChip')}</span>
                <strong>{projectName || t('detail.projectLabel')}</strong>
              </button>
            </section>
          )}

          {selectedSession && (
            <div className="detail-mode-toggle" role="tablist" aria-label={t('detail.modeToggleLabel')}>
              <button type="button" role="tab" aria-selected={detailMode === "chat"} className={detailMode === "chat" ? "active" : ""} onClick={() => setDetailMode("chat")}><ChatIcon size={15} /> {t('detail.modeChat')}</button>
              <button type="button" role="tab" aria-selected={detailMode === "terminal"} className={detailMode === "terminal" ? "active" : ""} onClick={() => setDetailMode("terminal")}><span className="term-glyph" aria-hidden="true">&gt;_</span> {t('detail.modeTerminal')}</button>
            </div>
          )}

          {todos.length > 0 && (
            <div className="todo-box">
              <div className="todo-header-row">
                <h3>
                  <span style={{ marginRight: 'var(--space-2)' }}><ClipboardIcon size={14} /></span>
                  {t('todo.title')}
                </h3>
                <button
                  type="button"
                  className="todo-toggle-btn"
                  onClick={() => setTodosExpanded((value) => !value)}
                  aria-expanded={todosExpanded}
                  aria-controls="todo-items-content"
                >
                  {todosExpanded ? t('todo.hide') : t('todo.show')}
                </button>
              </div>
              {todosExpanded && (
                <div id="todo-items-content">
                  {todos.slice(0, 6).map((item) => (
                    <div key={item.id} className="todo-item">
                      <span className={`todo-status ${item.status}`}>
                        {item.status === 'completed' ? <CheckIcon size={12} /> : <CircleIcon size={12} />}
                      </span>
                      <span>{item.content}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {(detailMode === "chat" || isLandscapeRegular) ? (
          <>
          <div className="messages-wrap">
            <div className="messages" ref={messagesRef}>
            {loadingSessionID === selectedID ? (
              <div className="empty-state compact">
                <LoadingIcon size={32} />
                <p>{t('detail.loading')}</p>
              </div>
            ) : renderedMessages.length === 0 && !showTypingBubble ? (
              <div className="empty-state compact">
                <ChatIcon size={40} className="icon-empty-state" />
                <p>{t('detail.emptyTitle')}</p>
                <p className="subtle">{t('detail.emptyHint')}</p>
              </div>
            ) : (
              <>
                {renderedMessages.map((message) => {
                  // Rich part rendering (spec §6.4). Text parts keep the existing
                  // ReactMarkdown rendering exactly; tool / reasoning / file parts
                  // are rendered by type so a message containing a tool call shows
                  // an amber entry with state + collapsible output, a reasoning
                  // part shows a muted collapsible block, and a file part shows a
                  // chip. Parts whose type we don't recognise fall back to text if
                  // they carry any, else are skipped — so existing text-only
                  // messages render identically to before.
                  const textParts = message.parts.filter((p) => p.type === "text" && p.text)
                  const richParts = message.parts.filter(
                    (p) => p.type !== "text" && (p.type === "tool" || p.type === "reasoning" || p.type === "file")
                  )
                  return (
                    <article key={message.info.id} className={`message ${message.info.role} fade-in`}>
                      <div className="message-content">
                        <header>
                          <strong className="fx-glow">
                            {message.info.role === "user" ? <UserIcon size={14} /> : <RobotIcon size={14} />} {message.info.role === "user" ? t('detail.you') : t('detail.opencode')}
                          </strong>
                          <small>{formatTime(message.info.time.created)}</small>
                        </header>
                        <div className="message-text">
                          {textParts.length > 0 && (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {normalizeMessageMarkdown(message.text)}
                            </ReactMarkdown>
                          )}
                          {richParts.map((part) => renderMessagePart(part))}
                        </div>
                      </div>
                    </article>
                  )
                })}
                {showTypingBubble && (
                  <article className="message assistant typing-bubble fade-in" aria-label={t('detail.waiting')}>
                    <div className="typing-dots" aria-hidden="true">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </div>
                  </article>
                )}
                <div ref={messagesEndRef} className="messages-end" aria-hidden="true" />
              </>
            )}
            </div>
          </div>

          <div className="composer" ref={composerRef}>
            {attachments.length > 0 && (
              <div className="attach-chips" role="list" aria-label="Attached files">
                {attachments.map((attachment) => (
                  <span key={attachKey(attachment)} className="attach-chip" role="listitem" title={attachment.source ?? attachment.url}>
                    <span className="attach-chip-glyph" aria-hidden="true"><PaperclipIcon size={14} /></span>
                    <span className="attach-chip-name">{attachment.filename}</span>
                    <small className="attach-chip-mime">{attachment.mime}</small>
                    <button
                      type="button"
                      className="attach-chip-remove"
                      onClick={() => removeAttachment(attachment)}
                      aria-label={`Remove ${attachment.filename}`}
                      disabled={isWorking}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="composer-row">
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder={t('detail.composerPlaceholder')}
              onFocus={() => {
                syncChatBottomClearance()
                setTimeout(() => scrollMessagesToBottom("smooth"), 400)
                const onResize = () => {
                  scrollMessagesToBottom("smooth")
                  window.removeEventListener("resize", onResize)
                }
                window.addEventListener("resize", onResize, { once: true })
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  if (!isWorking) {
                    send().catch(() => undefined)
                  }
                }
              }}
              disabled={!selectedSession || isWorking}
            />
            <button
              type="button"
              className="composer-attach"
              onClick={openFilePicker}
              disabled={!selectedSession || isWorking}
              aria-label="Attach file"
              title="Attach file"
            >
              <PlusIcon size={18} />
            </button>
            <button
              type="button"
              className={`composer-attach composer-mic${micListening ? " listening" : ""}`}
              onClick={toggleMic}
              disabled={!selectedSession || isWorking || !micSupported}
              aria-label={micListening ? t('detail.micListening') : t('detail.micLabel')}
              title={micSupported ? (micListening ? t('detail.micListening') : t('detail.micLabel')) : t('detail.micUnsupported')}
            >
              <MicIcon size={18} />
            </button>
            <button
              onClick={isWorking ? abortSession : send}
              disabled={!selectedSession}
              className={isWorking ? "btn-danger" : "btn-primary"}
            >
              {isWorking ? (
                <>
                  <StopCircleIcon size={18} />
                  {t('detail.waiting')}
                </>
              ) : (
                <>
                  <SendIcon size={18} />
                  {t('detail.send')}
                </>
              )}
            </button>
            </div>
          </div>
          
          </>) : selectedSession ? (
            <TerminalConsole
              config={config}
              sessionID={selectedSession.id}
              directory={selectedSession.directory}
              agent={activeAgentID}
              model={activeModel}
              labels={{
                title: t('detail.terminalTitle'),
                hint: t('detail.terminalHint'),
                placeholder: t('detail.terminalPlaceholder'),
                running: t('detail.terminalRunning'),
                prompt: t('detail.terminalPrompt'),
              }}
            />
          ) : null}
          {runtimeError && <div className="error fade-in"><CrossIcon size={14} /> {runtimeError}</div>}
        </main>
      )}

      {activeDetailSheet && selectedSession && (
        <div className="sheet-backdrop" role="presentation" onClick={() => setActiveDetailSheet(null)}>
          <section
            className="bottom-sheet fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-sheet-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <div>
                <h3 id="detail-sheet-title">
                  {activeDetailSheet === "ai" && t('detail.aiTitle')}
                  {activeDetailSheet === "details" && t('detail.sessionDetailsTitle')}
                </h3>
                <p className="subtle">
                  {activeDetailSheet === "ai" && t('detail.modelHint')}
                  {activeDetailSheet === "details" && t('detail.sessionDetailsHint')}
                </p>
              </div>
              <button type="button" className="btn-secondary compact" onClick={() => setActiveDetailSheet(null)}>
                {t('detail.closeSheet')}
              </button>
            </div>

            {activeDetailSheet === "ai" && (
              <div className="sheet-content">
                <button type="button" className="btn-secondary" onClick={() => Promise.all([loadAgents(), loadModels(), loadProviders()]).catch(() => undefined)}>
                  <RefreshIcon size={16} />
                  {t('detail.refreshAi')}
                </button>
                {primaryAgentOptions.length > 0 ? (
                  <div className="agent-controls">
                    <label htmlFor="agent-select">
                      {t('detail.agentSelectLabel')}
                      <select
                        id="agent-select"
                        value={activeAgentID}
                        onChange={(event) => changeAgent(event.target.value)}
                        disabled={isWorking}
                      >
                        {primaryAgentOptions.map((agent) => (
                          <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>
                        ))}
                      </select>
                    </label>
                    <p className="subtle">
                      {activeAgent?.description || t('detail.agentMode', { mode: activeAgent?.mode ?? 'primary' })}
                    </p>
                  </div>
                ) : (
                  <p className="subtle">{agentLoadError ? t('detail.agentLoadError', { message: agentLoadError }) : t('detail.agentLoading')}</p>
                )}
                {modelOptions.length > 0 ? (
                  <div className="model-controls">
                    <label htmlFor="model-search">
                      {t('detail.modelSelectLabel')}
                      <input
                        id="model-search"
                        value={modelQuery}
                        onChange={(event) => setModelQuery(event.target.value)}
                        placeholder={t('detail.modelSearchPlaceholder')}
                        disabled={isWorking}
                        autoComplete="off"
                      />
                    </label>
                    <div className="model-option-list" role="listbox" aria-label={t('detail.modelSelectLabel')}>
                      {filteredModelOptions.length > 0 ? (
                        filteredModelOptions.map((option) => {
                          const optionKey = modelKey(option)
                          const active = activeModelOption ? sameModel(option, activeModelOption) : optionKey === selectedModelKey
                          // Provider connected status (spec §6.5). Only show a
                          // badge when /provider loaded; otherwise hide it (we
                          // don't know, and shouldn't claim offline).
                          const known = providerStatus !== null
                          const connected = connectedProviderIDs.has(option.providerID)
                          return (
                            <button
                              type="button"
                              key={optionKey}
                              className={active ? "model-option active" : "model-option"}
                              onClick={() => changeModel(optionKey)}
                              disabled={isWorking}
                              role="option"
                              aria-selected={active}
                            >
                              <span>
                                <strong>{option.modelName}</strong>
                                <small>{option.providerName}{option.variant ? ` · ${option.variant}` : ""}</small>
                              </span>
                              <span className="model-option-meta">
                                {known && (
                                  <span
                                    className={`provider-badge ${connected ? "connected" : "offline"}`}
                                    title={connected ? `${option.providerName} is connected` : `${option.providerName} is offline`}
                                  >
                                    {connected ? "● connected" : "○ offline"}
                                  </span>
                                )}
                                {option.isDefault && <em>{t('detail.modelDefault')}</em>}
                              </span>
                            </button>
                          )
                        })
                      ) : (
                        <p className="subtle model-empty">{t('detail.modelSearchEmpty')}</p>
                      )}
                    </div>
                    {providerStatus && providerStatus.all.length > 0 && (
                      <div className="provider-summary" aria-label="Provider connection status">
                        {providerStatus.all.map((provider) => {
                          const connected = connectedProviderIDs.has(provider.id)
                          const label = providerNameByID.get(provider.id) ?? provider.id
                          return (
                            <span
                              key={provider.id}
                              className={`provider-badge ${connected ? "connected" : "offline"}`}
                              title={connected ? `${label} is connected` : `${label} is offline`}
                            >
                              {connected ? "●" : "○"} {label}
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {activeModelOption && (
                      <div className="model-meta">
                        <span>{t('detail.modelProvider', { provider: activeModelOption.providerName })}</span>
                        <span>{t('detail.modelContext', { context: formatLimit(activeModelOption.contextLimit), output: formatLimit(activeModelOption.outputLimit) })}</span>
                        <span>{activeModelOption.tools ? t('detail.modelToolsYes') : t('detail.modelToolsNo')}</span>
                        {activeModelOption.variant && <span>{t('detail.modelVariant', { variant: activeModelOption.variant })}</span>}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="subtle">{modelLoadError ? t('detail.modelLoadError', { message: modelLoadError }) : t('detail.modelLoading')}</p>
                )}
              </div>
            )}

            {activeDetailSheet === "details" && (
              <div className="sheet-content project-dashboard single-column">
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.projectLabel')}</span>
                  <strong>{projectName || selectedSession.directory}</strong>
                  <small>{projectPath || selectedSession.directory}</small>
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.vcsLabel')}</span>
                  <strong>{vcsBranch || t('detail.unavailable')}</strong>
                  {projectDashboard?.vcs && (
                    <small>{t('detail.aheadBehind', { ahead: projectDashboard.vcs.ahead ?? 0, behind: projectDashboard.vcs.behind ?? 0 })}</small>
                  )}
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.fileStatusLabel')}</span>
                  <strong>{diffFiles.length > 0 ? t('detail.filesCount', { count: diffFiles.length }) : (projectDashboard?.files.length ?? 0)}</strong>
                  {diffFiles.length > 0 ? (
                    <small><span className="positive">+{totalDiffAdditions}</span> <span className="negative">-{totalDiffDeletions}</span></small>
                  ) : (
                    <small>{dashboardError ? t('detail.dashboardError', { message: dashboardError }) : t('detail.fileStatusSource')}</small>
                  )}
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.agentTitle')}</span>
                  <strong>{agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })}</strong>
                  <small>{t('detail.agentMode', { mode: activeAgent?.mode ?? 'primary' })}</small>
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.modelTitle')}</span>
                  <strong>{activeModelOption?.modelName ?? t('detail.modelLoading')}</strong>
                  <small>{activeModelOption?.providerName ?? "-"}</small>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {sessionToDelete && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSessionToDelete(null)}>
          <section
            className="modal-card fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-session-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-session-title">{t('session.deleteTitle')}</h2>
            <p>
              {t('session.deleteBodyPrefix')} <strong>{sessionToDelete.title}</strong>.
            </p>
            <p className="subtle">{sessionToDelete.directory}</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setSessionToDelete(null)}>
                {t('session.cancel')}
              </button>
              <button className="btn-danger" onClick={() => deleteSession(sessionToDelete.id)}>
                <TrashIcon size={16} />
                {t('session.deleteConfirm')}
              </button>
            </div>
          </section>
        </div>
      )}

      {view === "help" && (
        <section className="panel help fade-in">
          <h2>
            <HelpIcon size={24} className="icon-inline-heading" />
            {t('help.title')}
          </h2>
          <div className="help-tabs" role="tablist">
            <button 
              className={helpPage === "overview" ? "active" : ""} 
              onClick={() => setHelpPage("overview")}
              role="tab"
              aria-selected={helpPage === "overview"}
            >
              {t('help.overview')}
            </button>
            <button 
              className={helpPage === "server" ? "active" : ""} 
              onClick={() => setHelpPage("server")}
              role="tab"
              aria-selected={helpPage === "server"}
            >
              {t('help.server')}
            </button>
            <button 
              className={helpPage === "network" ? "active" : ""} 
              onClick={() => setHelpPage("network")}
              role="tab"
              aria-selected={helpPage === "network"}
            >
              {t('help.network')}
            </button>
            <button 
              className={helpPage === "troubleshooting" ? "active" : ""} 
              onClick={() => setHelpPage("troubleshooting")}
              role="tab"
              aria-selected={helpPage === "troubleshooting"}
            >
              {t('help.troubleshooting')}
            </button>
            <button
              className={helpPage === "commands" ? "active" : ""}
              onClick={() => { setCommandFilter("all"); setHelpPage("commands") }}
              role="tab"
              aria-selected={helpPage === "commands"}
            >
              {t('help.commands')}
            </button>
            <button
              className={helpPage === "diagnostics" ? "active" : ""}
              onClick={() => setHelpPage("diagnostics")}
              role="tab"
              aria-selected={helpPage === "diagnostics"}
            >
              Diagnostics
            </button>
          </div>

          {helpPage === "overview" && (
            <div className="help-content fade-in">
              <h3>Getting Started</h3>
              <ul>
                <li><strong>Configure Server:</strong> Use Settings to enter host, port, username and password</li>
                <li><strong>Test Connection:</strong> Press Test to validate server connectivity</li>
                <li><strong>Save Settings:</strong> Press Save to apply configuration and start polling</li>
                <li><strong>Browse Sessions:</strong> View and manage sessions from the Sessions tab</li>
                <li><strong>Interact:</strong> Open a session and chat in the Detail view</li>
                <li><strong>Quick Input:</strong> Press Enter to send, Shift+Enter for new lines</li>
                <li><strong>Slash Commands:</strong> Text starting with <code>/</code> is sent as a command</li>
              </ul>
              
              <h3>Key Features</h3>
              <ul>
                <li><RefreshIcon size={14} /> Real-time session monitoring</li>
                <li><ChatIcon size={14} /> Interactive chat interface</li>
                <li><ClipboardIcon size={14} /> Todo tracking display</li>
                <li><BoltIcon size={14} /> Instant session control</li>
                <li><BellIcon size={14} /> Completion notifications</li>
              </ul>
            </div>
          )}

          {helpPage === "server" && (
            <div className="help-content fade-in">
              <h3>Starting the OpenCode Server</h3>
              <p>Start OpenCode server with Basic Authentication enabled:</p>
              
              <div className="code-blocks">
                <h4>macOS / Linux (bash/zsh)</h4>
                <pre>OPENCODE_SERVER_USERNAME=opencode \
OPENCODE_SERVER_PASSWORD=your-password \
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096</pre>
                
                <h4>Windows PowerShell</h4>
                <pre>$env:OPENCODE_SERVER_USERNAME="opencode"
$env:OPENCODE_SERVER_PASSWORD="your-password"
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096</pre>
                
                <h4>Windows Command Prompt</h4>
                <pre>set OPENCODE_SERVER_USERNAME=opencode
set OPENCODE_SERVER_PASSWORD=your-password
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096</pre>
              </div>
              
              <div className="help-note">
                <strong><WrenchIcon size={15} /> Browser Debugging:</strong>
                <p>Add CORS origins for browser testing:</p>
                <pre>--cors http://localhost:5173 --cors http://127.0.0.1:5173</pre>
              </div>
            </div>
          )}

          {helpPage === "network" && (
            <div className="help-content fade-in">
              <h3>Network Configuration</h3>
              
              <div className="network-modes">
                <h4><GlobeIcon size={15} /> LAN Mode (Recommended)</h4>
                <p>Use your PC's local IP address for devices on the same network:</p>
                <pre>Example: 192.168.1.61</pre>
                
                <h4><GlobeIcon size={15} /> WAN Mode (Advanced)</h4>
                <ul>
                  <li>Configure NAT/port forwarding on your router</li>
                  <li>Set up a VPN for secure remote access</li>
                  <li>Use a reverse proxy with TLS/HTTPS</li>
                </ul>
              </div>
              
              <div className="security-checklist">
                <h4><LockIcon size={15} /> Security Requirements</h4>
                <ul>
                  <li><CheckIcon size={14} /> Open TCP port 4096 in OS firewall</li>
                  <li><CheckIcon size={14} /> Configure router/NAT port forwarding</li>
                  <li><CheckIcon size={14} /> Use strong authentication passwords</li>
                  <li><CheckIcon size={14} /> Prefer TLS/HTTPS for external access</li>
                  <li><CheckIcon size={14} /> Restrict source IPs when possible</li>
                  <li><WarningIcon size={14} /> Never expose without authentication</li>
                </ul>
              </div>
            </div>
          )}

          {helpPage === "troubleshooting" && (
            <div className="help-content fade-in">
              <h3>Troubleshooting Guide</h3>
              
              <div className="troubleshooting-steps">
                <h4><SearchIcon size={15} /> Connection Diagnostics</h4>
                <ol>
                  <li><strong>Verify Server:</strong> Check if OpenCode is listening on port 4096</li>
                  <li><strong>Test Locally:</strong> Check health endpoint from the same machine</li>
                  <li><strong>Test Network:</strong> Check health endpoint from your phone browser</li>
                  <li><strong>Check Firewall:</strong> Ensure port 4096 is open in OS firewall</li>
                </ol>
              </div>
              
              <div className="health-checks">
                <h4><ActivityIcon size={15} /> Health Check Commands</h4>
                <div className="code-examples">
                  <h5>Local Machine:</h5>
                  <pre>curl -u opencode:your-password \
http://127.0.0.1:4096/global/health</pre>
                  
                  <h5>From Phone/Network:</h5>
                  <pre>curl -u opencode:your-password \
http://YOUR_PC_IP:4096/global/health</pre>
                </div>
              </div>
              
              <div className="common-issues">
                <h4><WarningIcon size={14} /> Common Issues</h4>
                <ul>
                  <li><strong>CORS Errors:</strong> Add <code>--cors</code> flags to server</li>
                  <li><strong>Connection Timeout:</strong> Check firewall settings</li>
                  <li><strong>Auth Failures:</strong> Verify username/password</li>
                  <li><strong>Session Issues:</strong> Re-open session and check server models</li>
                </ul>
              </div>
            </div>
          )}

          {helpPage === "commands" && (
            <div className="help-content fade-in">
              <h3>Slash Commands</h3>
              <p>Local mobile commands are handled by the app. Server commands are loaded from OpenCode and sent to <code>/session/:id/command</code>.</p>
              <div className="example-commands">
                <pre>/help</pre>
                <pre>/commands</pre>
                <pre>/skills</pre>
                <pre>/status</pre>
              </div>
              <div className="help-tabs compact" role="tablist">
                <button
                  className={commandFilter === "all" ? "active" : ""}
                  onClick={() => setCommandFilter("all")}
                  role="tab"
                  aria-selected={commandFilter === "all"}
                >
                  Server Commands
                </button>
                <button
                  className={commandFilter === "skill" ? "active" : ""}
                  onClick={() => setCommandFilter("skill")}
                  role="tab"
                  aria-selected={commandFilter === "skill"}
                >
                  Skills
                </button>
              </div>
               
              {displayedCommands.length === 0 ? (
                <div className="no-commands">
                  <HelpIcon size={48} className="icon-empty-state" />
                  <p className="subtle">No {commandFilter === "skill" ? "skills" : "server commands"} available</p>
                  <p className="subtle">Connect to a server to see available commands and skills</p>
                </div>
              ) : (
                <div className="commands-grid">
                  {displayedCommands.map((cmd) => (
                    <div key={cmd.name} className="command-card">
                      <code className="command-name">/{cmd.name}</code>
                      {cmd.description && (
                        <p className="command-description">{cmd.description}</p>
                      )}
                      {cmd.source && <p className="subtle">{cmd.source}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {helpPage === "diagnostics" && (
            <div className="help-content fade-in">
              {!hasConfiguredServer ? (
                <p className="subtle">Connect to a server to view diagnostics.</p>
              ) : (
                <div className="diag-panel" role="region" aria-label="Server diagnostics">
                  <div className="diag-toolbar">
                    <p className="subtle">
                      Read-only server monitoring. Endpoints that 404 or fail show <code>n/a</code>.
                    </p>
                    <button
                      type="button"
                      className="btn-secondary compact"
                      onClick={() => loadDiagnostics().catch(() => undefined)}
                      disabled={diagLoading}
                    >
                      {diagLoading ? <LoadingIcon size={16} /> : <RefreshIcon size={16} />}
                      Refresh
                    </button>
                  </div>

                  <DiagSection
                    title="MCP Servers"
                    entries={
                      diagMCP?.data
                        ? Object.entries(diagMCP.data).map(([name, entry]) => ({
                            name,
                            status: typeof entry === "object" && entry ? (entry.status ?? (entry as { error?: string }).error) : String(entry)
                          }))
                        : null
                    }
                    error={diagMCP?.error ?? null}
                    loading={!diagLoaded && diagMCP === undefined}
                  />

                  <DiagSection
                    title="LSP Servers"
                    entries={
                      diagLSP?.data
                        ? diagLSP.data.map((entry) => ({
                            name: entry.name ?? "lsp",
                            status: entry.status
                          }))
                        : null
                    }
                    error={diagLSP?.error ?? null}
                    loading={!diagLoaded && diagLSP === undefined}
                  />

                  <DiagSection
                    title="Formatters"
                    entries={
                      diagFormatter?.data
                        ? diagFormatter.data.map((entry) => ({
                            name: entry.name ?? "formatter",
                            status: entry.status
                          }))
                        : null
                    }
                    error={diagFormatter?.error ?? null}
                    loading={!diagLoaded && diagFormatter === undefined}
                  />

                  <div className="diag-section">
                    <h4>Config</h4>
                    {diagConfig?.data ? (
                      <ConfigView config={diagConfig.data} />
                    ) : diagConfig?.error ? (
                      <p className="diag-na">n/a — {diagConfig.error}</p>
                    ) : (
                      <p className="diag-na">n/a</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {runtimeError && <p className="error">{runtimeError}</p>}
        </section>
      )}

      {toast && (
        <div className="toast fade-in" role="status" aria-live="polite">{toast}</div>
      )}

      {/* opencode Question prompt as a modal when it can't render inline (the
          asking session isn't the one open in the detail view). Unmissable. */}
      {modalQuestion && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card question-modal" role="dialog" aria-modal="true" aria-label={t('question.title')}>
            <QuestionPrompt
              request={modalQuestion}
              busy={replyingQuestion}
              onReply={(answers) => {
                if (modalQuestion.sessionID) {
                  const owner = sessions.find((s) => s.id === modalQuestion.sessionID)
                  if (owner) openSession(owner.id, owner.directory)
                }
                replyQuestion(modalQuestion, answers)
              }}
              onReject={() => rejectQuestion(modalQuestion)}
              labels={questionLabels}
            />
          </section>
        </div>
      )}

      {/* ⌘K command palette — fuzzy over nav, session actions, sessions, slash
          commands. Self-contained overlay (its own scoped styles). */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={paletteCommands}
        placeholder={t('palette.placeholder')}
      />

      <nav className="bottom-nav" role="navigation" aria-label="Mobile navigation">
        {navItems.map((item) => (
          <button
            key={item.view}
            className={view === item.view ? "active" : ""}
            onClick={() => {
              setView(item.view);
              if (item.view === "sessions") {
                requestAnimationFrame(() => document.querySelector<HTMLElement>(".session-card.active")?.scrollIntoView({ block: "center" }));
              }
            }}
            disabled={item.disabled}
            aria-label={item.label}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

export default App
