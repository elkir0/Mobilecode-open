// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
//
// iPad LANDSCAPE right inspector — a vertical, tabbed panel hosting the four
// glanceable surfaces a vibe-coder wants beside the chat column:
//   • Terminal — embeds <TerminalConsole/> (one-shot POST /session/:id/shell)
//   • Todo     — the session's todo list (reuses .todo-box / .todo-item styles)
//   • Diag     — read-only server diagnostics (reuses .diag-panel styles)
//   • Files    — v1 placeholder pointing at the composer '+ file' attach
//
// Self-contained: owns its active-tab state, renders Matrix-skinned with --mx-*
// token fallbacks inline so it looks right even before styles.css gets an
// `.inspector` block. No edits to App.tsx or styles.css required to compile or
// render. The integration agent wires <Inspector/> into the landscape 3-zone
// grid (right column) and feeds it the shared props below.
//
// USAGE (2 lines):
//   import { Inspector } from "./inspector"
//   <Inspector config={config} session={session} agent={agent} model={model}
//              todos={todos} diag={diag} labels={inspectorLabels} />
import { useState, type CSSProperties } from "react"
import { TerminalConsole } from "./terminal"
import type { ModelSelection, ServerConfig, TodoItem } from "./types"

export type InspectorTab = "terminal" | "todo" | "diag" | "files"

export interface InspectorLabels {
  terminalTitle: string
  terminalHint: string
  terminalPlaceholder: string
  terminalRunning: string
  terminalPrompt: string
  todo: string
  diag: string
  files: string
  emptyTodo: string
}

/** Read-only diagnostic snapshot. Field shapes are intentionally `unknown` so
 *  the panel never breaks when opencode enriches a response; render() tolerates
 *  objects, arrays, and primitives. `error` short-circuits the whole view. */
export interface DiagSnapshot {
  mcp?: unknown
  lsp?: unknown
  formatter?: unknown
  config?: unknown
  error?: string
}

export interface InspectorProps {
  config: ServerConfig
  /** Only id + directory are needed (passed to the embedded terminal). Kept
   *  structural so a SessionView is assignable without a cast. */
  session: { id: string; directory: string }
  agent: string
  model?: ModelSelection
  todos: TodoItem[]
  diag: DiagSnapshot | null
  labels: InspectorLabels
}

// ---------------------------------------------------------------------------
// Matrix token fallbacks. styles.css defines these on :root (dark Matrix skin);
// the inline style below only acts as a safety net so the panel is legible if
// mounted in a context where the tokens aren't loaded yet. Real theming comes
// from the existing --mx-* variables.
// ---------------------------------------------------------------------------
const FALLBACK_STYLE: CSSProperties = {
  // surface + borders
  ["--mx-surface" as string]: "rgba(4,20,10,0.60)",
  ["--mx-bg" as string]: "#020A06",
  ["--mx-border" as string]: "#0C2",
  ["--mx-border-soft" as string]: "#0A3",
  // role colors
  ["--mx-user" as string]: "#00FF41",
  ["--mx-ai" as string]: "#00E5FF",
  ["--mx-tool" as string]: "#FFB000",
  ["--mx-danger" as string]: "#FF3B30",
  // type
  ["--font-mono" as string]:
    'ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
  ["--font-family" as string]:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif',
}

interface TabDef {
  id: InspectorTab
  label: string
  glyph: string
}

/** Map a diagnostic status-ish value to a CSS dot class mirroring App.tsx's
 *  diagDotClass semantics (green for healthy, amber for warning, red for error,
 *  muted for unknown). Tolerant of any shape. */
function diagDotClass(status: unknown): string {
  if (status == null) return "muted"
  if (typeof status === "string") {
    const s = status.toLowerCase()
    if (["ok", "ready", "running", "connected", "active", "healthy"].some((k) => s.includes(k))) return "ok"
    if (["error", "fail", "down", "stopped", "crash"].some((k) => s.includes(k))) return "error"
    if (["warn", "slow", "degraded", "pending"].some((k) => s.includes(k))) return "warn"
  }
  if (typeof status === "object") {
    const obj = status as Record<string, unknown>
    if (obj.status) return diagDotClass(obj.status)
    if (obj.error) return "error"
  }
  return "muted"
}

/** Human-readable label for a diag status value. */
function diagStatusLabel(status: unknown): string {
  if (status == null) return "n/a"
  if (typeof status === "string") return status
  if (typeof status === "number" || typeof status === "boolean") return String(status)
  if (typeof status === "object") {
    const obj = status as Record<string, unknown>
    const picked = obj.status ?? obj.state ?? obj.error ?? obj.name
    if (picked != null) return String(picked)
    return Object.keys(obj).length === 0 ? "{}" : JSON.stringify(obj)
  }
  return String(status)
}

/** Normalize a diag field into a list of {name,status} rows. Handles:
 *  - Record<string, unknown> (mcp-style map keyed by server name)
 *  - Array<{name?,status?,...}> (lsp/formatter-style)
 *  - primitives (single row) */
function toDiagRows(field: unknown, fallbackName: string): Array<{ name: string; status: unknown }> {
  if (field == null) return []
  if (Array.isArray(field)) {
    return field.map((entry, idx) => {
      if (typeof entry === "object" && entry !== null) {
        const e = entry as Record<string, unknown>
        return { name: typeof e.name === "string" ? e.name : `${fallbackName} ${idx + 1}`, status: e.status ?? e }
      }
      return { name: `${fallbackName} ${idx + 1}`, status: entry }
    })
  }
  if (typeof field === "object") {
    return Object.entries(field as Record<string, unknown>).map(([name, status]) => ({ name, status }))
  }
  return [{ name: fallbackName, status: field }]
}

/** Render one diag section (.diag-section / .diag-rows). Tolerant + read-only. */
function DiagSection({ title, field, fallbackName }: { title: string; field: unknown; fallbackName: string }) {
  const rows = toDiagRows(field, fallbackName)
  return (
    <div className="diag-section">
      <h4>{title}</h4>
      {field == null ? (
        <p className="diag-na">n/a</p>
      ) : rows.length > 0 ? (
        <ul className="diag-rows">
          {rows.map((row, idx) => (
            <li key={`${row.name}-${idx}`} className="diag-row">
              <span className={`diag-dot ${diagDotClass(row.status)}`} aria-hidden="true" />
              <span className="diag-name">{row.name}</span>
              <span className="diag-status">{diagStatusLabel(row.status)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="diag-na">n/a</p>
      )}
    </div>
  )
}

export function Inspector({ config, session, agent, model, todos, diag, labels }: InspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("terminal")

  const tabs: TabDef[] = [
    { id: "terminal", label: labels.terminalTitle, glyph: ">_" },
    { id: "todo", label: labels.todo, glyph: "✓" },
    { id: "diag", label: labels.diag, glyph: "◉" },
    { id: "files", label: labels.files, glyph: "▤" },
  ]

  const todoCount = todos.length

  return (
    <aside
      className="inspector"
      role="complementary"
      aria-label="Inspector"
      style={FALLBACK_STYLE}
    >
      {/* Tab bar — sticky at top, Matrix-skinned */}
      <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
        {tabs.map((tab) => {
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`inspector-panel-${tab.id}`}
              className={`inspector-tab${active ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="inspector-tab-glyph" aria-hidden="true">{tab.glyph}</span>
              <span className="inspector-tab-label">{tab.label}</span>
              {tab.id === "todo" && todoCount > 0 && (
                <span className="inspector-tab-badge" aria-label={`${todoCount} todos`}>{todoCount}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Panel body — each tab is a role=tabpanel */}
      <div className="inspector-body">
        {activeTab === "terminal" && (
          <div id="inspector-panel-terminal" role="tabpanel" aria-label={labels.terminalTitle} className="inspector-pane">
            <TerminalConsole
              config={config}
              sessionID={session.id}
              directory={session.directory}
              agent={agent}
              model={model}
              labels={{
                title: labels.terminalTitle,
                hint: labels.terminalHint,
                placeholder: labels.terminalPlaceholder,
                running: labels.terminalRunning,
                prompt: labels.terminalPrompt,
              }}
            />
          </div>
        )}

        {activeTab === "todo" && (
          <div id="inspector-panel-todo" role="tabpanel" aria-label={labels.todo} className="inspector-pane">
            {todoCount === 0 ? (
              <p className="subtle inspector-empty">{labels.emptyTodo}</p>
            ) : (
              <div className="todo-box">
                <div className="todo-header-row">
                  <h3>{labels.todo}</h3>
                </div>
                <div id="todo-items-content">
                  {todos.map((item) => (
                    <div key={item.id} className="todo-item">
                      <span className={`todo-status ${item.status}`} aria-hidden="true">
                        {item.status === "completed" ? "✓" : "○"}
                      </span>
                      <span>{item.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "diag" && (
          <div id="inspector-panel-diag" role="tabpanel" aria-label={labels.diag} className="inspector-pane">
            {diag == null ? (
              <p className="subtle inspector-empty">—</p>
            ) : diag.error ? (
              <p className="subtle inspector-empty inspector-error">{diag.error}</p>
            ) : (
              <div className="diag-panel" role="region" aria-label="Server diagnostics">
                <div className="diag-toolbar">
                  <p className="subtle">Read-only server monitoring.</p>
                </div>
                <DiagSection title="MCP Servers" field={diag.mcp} fallbackName="mcp" />
                <DiagSection title="LSP Servers" field={diag.lsp} fallbackName="lsp" />
                <DiagSection title="Formatters" field={diag.formatter} fallbackName="formatter" />
                <div className="diag-section">
                  <h4>Config</h4>
                  {diag.config == null ? (
                    <p className="diag-na">n/a</p>
                  ) : (
                    <pre className="diag-config-dump">{JSON.stringify(diag.config, null, 2)}</pre>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "files" && (
          <div id="inspector-panel-files" role="tabpanel" aria-label={labels.files} className="inspector-pane">
            <p className="subtle inspector-empty">
              {labels.files} — use the composer <strong>+ file</strong> attach to browse and attach files (v1).
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}
