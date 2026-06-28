// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
//
// iPad LANDSCAPE sessions sidebar for Mobilecode-open. Renders the left zone of
// the 3-zone landscape split (sidebar | chat | inspector) per
// docs/ipad-design-analysis.md §4. Reuses the Matrix "hacker console" visual
// language (--mx-* tokens) but is fully self-contained: no App.tsx imports, no
// store/i18n dependencies — all data + labels flow in via props.
//
// Two modes:
//   • expanded — full sessions list (search + compact rows + status dots) with a
//     bottom utility rail (settings / help / reconnect / skin).
//   • collapsed (collapsed===true) — a 44px icon rail (new-session + settings +
//     help) so chat can stretch wider. The ⌘\ hint is shown on the toggle.
//
// Visual tokens are read from the document (--mx-* with sensible fallbacks so
// the official skin overrides them and this component restyles automatically).

import { useMemo, useState } from "react"
import type { SessionView } from "./types"
import {
  FolderIcon,
  HelpIcon,
  LogoIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  SparkleIcon,
} from "./Icons"

// ---------------------------------------------------------------------------
// Public prop interfaces (shared with the integration agent — keep in sync).
// ---------------------------------------------------------------------------

export interface SidebarLabels {
  title: string
  newSession: string
  search: string
  settings: string
  help: string
  reconnect: string
  skin: string
  collapse: string
}

export interface SidebarProps {
  sessions: SessionView[]
  selectedID: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onReconnect: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  onSettings: () => void
  onHelp: () => void
  onSkin: () => void
  labels: SidebarLabels
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sessions whose status drives a glowing status dot (busy/retry). */
function isActiveStatus(status: string): boolean {
  return status === "busy" || status === "retry"
}

/**
 * Compact relative time ("5m", "3h", "2d") for sidebar rows. Falls back to the
 * absolute time when very old. Pure (no i18n dependency) so this module stays
 * self-contained.
 */
function relativeTime(epoch: number): string {
  if (!epoch) return "—"
  const now = Date.now()
  const diff = Math.max(0, now - epoch)
  const min = 60 * 1000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return "now"
  if (diff < hour) return `${Math.floor(diff / min)}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`
  const d = new Date(epoch)
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`
}

/** Directory basename (last path segment) — the compact project label. */
function dirBasename(directory: string): string {
  if (!directory) return ""
  // Handle both "/" and "\" separators (defensive) and trim trailing slash.
  const clean = directory.replace(/[\\/]+$/, "")
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] || clean
}

// ---------------------------------------------------------------------------
// Inline styles (token-driven, scoped). Using inline styles + CSS custom
// properties keeps this component zero-edit to styles.css while still honoring
// the global --mx-* design tokens (Matrix + official skins both work).
// ---------------------------------------------------------------------------

function useSidebarVars() {
  // A read of var(--mx-*) with a fallback. Reads at render time so skin
  // switches (data-skin on <html>) are picked up on the next render. We pass
  // these through inline `var(...)` in the style strings below rather than
  // resolving them here, so re-skinning recolors live without JS.
  return {
    // Surfaces
    bg: "var(--mx-bg, #020A06)",
    surface: "var(--mx-surface, rgba(4,20,10,0.60))",
    surfaceHover: "var(--mx-surface-hover, rgba(0,255,65,0.10))",
    border: "var(--mx-border, rgba(0,200,60,0.35))",
    borderSoft: "var(--mx-border-soft, rgba(0,200,60,0.18))",
    // Role / accent colors
    user: "var(--mx-user, #00FF41)",
    ai: "var(--mx-ai, #00E5FF)",
    tool: "var(--mx-tool, #FFB000)",
    danger: "var(--mx-danger, #FF3B30)",
    // Text
    text: "var(--mx-text, #C8FFD9)",
    textDim: "var(--mx-text-dim, rgba(200,255,217,0.55))",
    textFaint: "var(--mx-text-faint, rgba(200,255,217,0.35))",
    glow: "var(--glow-strong, 0 0 6px rgba(0,255,65,0.7))",
    mono: "var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace)",
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface UtilityButtonProps {
  label: string
  onClick: () => void
  children: React.ReactNode
  accent?: string
  title?: string
}

function UtilityButton({ label, onClick, children, accent, title }: UtilityButtonProps) {
  const v = useSidebarVars()
  return (
    <button
      type="button"
      className="sidebar-utility-btn"
      onClick={onClick}
      title={title ?? label}
      aria-label={label}
      style={{
        width: 44,
        height: 44,
        minHeight: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "transparent",
        border: `1px solid ${v.borderSoft}`,
        borderRadius: 10,
        color: accent ?? v.text,
        cursor: "pointer",
        fontFamily: v.mono,
        fontSize: 12,
        letterSpacing: 0.5,
        transition: "background 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease",
      }}
    >
      {children}
    </button>
  )
}

interface SessionRowProps {
  session: SessionView
  selected: boolean
  onSelect: (id: string) => void
}

function SessionRow({ session, selected, onSelect }: SessionRowProps) {
  const v = useSidebarVars()
  const active = isActiveStatus(session.status)
  const dir = dirBasename(session.directory)

  const handle = () => onSelect(session.id)
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      handle()
    }
  }

  return (
    <article
      className={`sidebar-session-row${selected ? " selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={handle}
      onKeyDown={onKeyDown}
      aria-label={session.title}
      aria-current={selected ? "true" : undefined}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 8,
        cursor: "pointer",
        // 2px left border = role-coded accent (busy/selected = user-green, idle = soft border).
        borderLeft: `2px solid ${selected ? v.user : active ? v.user : v.borderSoft}`,
        background: selected ? v.surfaceHover : "transparent",
        color: v.text,
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      {/* Status dot — glowing green while busy/retry, dim otherwise. */}
      <span
        aria-hidden="true"
        style={{
          flex: "0 0 auto",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: active ? v.user : v.textFaint,
          boxShadow: active ? `0 0 8px ${v.user}` : "none",
          animation: active ? "sidebar-pulse 1.6s ease-in-out infinite" : "none",
        }}
      />
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <div
          className="sidebar-session-title"
          style={{
            fontFamily: v.mono,
            fontSize: 13,
            lineHeight: 1.25,
            color: selected ? v.user : v.text,
            textShadow: active ? v.glow : "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={session.title}
        >
          {session.title || dir || session.id}
        </div>
        <div
          className="sidebar-session-meta"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: v.mono,
            fontSize: 10.5,
            color: v.textDim,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {dir && <span title={session.directory}>{dir}</span>}
          <span aria-hidden="true" style={{ opacity: 0.5 }}>·</span>
          <span style={{ flex: "0 0 auto" }}>{relativeTime(session.updated)}</span>
        </div>
      </div>
      {/* Optional model chip (right edge) when present. */}
      {session.model?.modelID && (
        <span
          title={session.model.modelID}
          style={{
            flex: "0 0 auto",
            fontFamily: v.mono,
            fontSize: 9,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: v.ai,
            opacity: 0.7,
            maxWidth: 56,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {session.model.modelID}
        </span>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Sidebar(props: SidebarProps) {
  const {
    sessions,
    selectedID,
    onSelect,
    onNew,
    onReconnect,
    collapsed,
    onToggleCollapse,
    onSettings,
    onHelp,
    onSkin,
    labels,
  } = props

  const v = useSidebarVars()
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => {
      return (
        (s.title || "").toLowerCase().includes(q) ||
        (s.directory || "").toLowerCase().includes(q)
      )
    })
  }, [sessions, query])

  // ---- Collapsed rail (44px icon column) ---------------------------------
  if (collapsed) {
    return (
      <aside
        className="sidebar sidebar-collapsed"
        role="navigation"
        aria-label={labels.title}
        style={{
          width: 44,
          minWidth: 44,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          padding: "10px 0",
          background: v.bg,
          borderRight: `1px solid ${v.border}`,
          boxSizing: "border-box",
        }}
      >
        {/* Expand toggle */}
        <button
          type="button"
          onClick={onToggleCollapse}
          title={labels.collapse}
          aria-label={labels.collapse}
          style={{
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: `1px solid ${v.borderSoft}`,
            borderRadius: 8,
            color: v.text,
            cursor: "pointer",
          }}
        >
          <ChevronExpandIcon size={16} color={v.text} />
        </button>

        {/* New-session (primary action when collapsed) */}
        <UtilityButton label={labels.newSession} onClick={onNew} accent={v.user} title={labels.newSession}>
          <PlusIcon size={18} />
        </UtilityButton>

        {/* Spacer pushes utilities toward the bottom. */}
        <div style={{ flex: "1 1 auto" }} />

        <UtilityButton label={labels.settings} onClick={onSettings} title={labels.settings}>
          <SettingsIcon size={18} />
        </UtilityButton>
        <UtilityButton label={labels.help} onClick={onHelp} title={labels.help}>
          <HelpIcon size={18} />
        </UtilityButton>
      </aside>
    )
  }

  // ---- Expanded sidebar (sessions list + utility rail) -------------------
  return (
    <aside
      className="sidebar sidebar-expanded"
      role="navigation"
      aria-label={labels.title}
      style={{
        width: "100%",
        minWidth: 220,
        maxWidth: 280,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: v.bg,
        borderRight: `1px solid ${v.border}`,
        boxSizing: "border-box",
      }}
    >
      {/* Header: collapse toggle (with ⌘\ hint) + brand mark. */}
      <div
        className="sidebar-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 10px 8px",
          borderBottom: `1px solid ${v.borderSoft}`,
        }}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title={`${labels.collapse} (⌘\\)`}
          aria-label={labels.collapse}
          style={{
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: `1px solid ${v.borderSoft}`,
            borderRadius: 8,
            color: v.text,
            cursor: "pointer",
            flex: "0 0 auto",
          }}
        >
          <ChevronCollapseIcon size={16} color={v.text} />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <LogoIcon size={22} />
          <h2
            className="fx-glow sidebar-brand"
            style={{
              margin: 0,
              fontFamily: v.mono,
              fontSize: 13,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: v.user,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {labels.title}
          </h2>
        </div>
      </div>

      {/* Search input — filters sessions by title/directory. */}
      <div style={{ padding: "8px 10px 4px" }}>
        <div
          className="sidebar-search"
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 9,
              display: "flex",
              color: v.textDim,
              pointerEvents: "none",
            }}
          >
            <SearchIcon size={14} />
          </span>
          <input
            type="text"
            className="search sidebar-search-input"
            placeholder={labels.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={labels.search}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px 8px 30px",
              background: v.surface,
              border: `1px solid ${v.borderSoft}`,
              borderRadius: 8,
              color: v.text,
              fontFamily: v.mono,
              fontSize: 12,
              outline: "none",
            }}
          />
        </div>
      </div>

      {/* New-session button (sits above the list, primary green accent). */}
      <div style={{ padding: "4px 10px 6px" }}>
        <button
          type="button"
          className="btn-primary sidebar-new-btn"
          onClick={onNew}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "8px 10px",
            background: `linear-gradient(180deg, ${v.user}, ${v.user})`,
            border: `1px solid ${v.user}`,
            borderRadius: 8,
            color: v.bg,
            fontFamily: v.mono,
            fontSize: 12,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          <PlusIcon size={15} />
          {labels.newSession}
        </button>
      </div>

      {/* Session list — scrolls independently of the rail. */}
      <div
        className="sidebar-session-list"
        role="listbox"
        aria-label={labels.title}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          padding: "2px 10px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {filtered.length === 0 ? (
          <div
            className="sidebar-empty"
            style={{
              padding: "20px 10px",
              textAlign: "center",
              fontFamily: v.mono,
              fontSize: 11,
              color: v.textDim,
            }}
          >
            <FolderIcon size={32} />
            <p style={{ margin: "8px 0 0", opacity: 0.7 }}>
              {query ? "—" : labels.newSession}
            </p>
          </div>
        ) : (
          filtered.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedID}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      {/* Bottom utility rail — icon buttons, each 44pt. */}
      <div
        className="sidebar-utility-rail"
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          padding: "8px 10px",
          borderTop: `1px solid ${v.borderSoft}`,
          background: v.surface,
        }}
      >
        <UtilityButton label={labels.settings} onClick={onSettings} title={labels.settings}>
          <SettingsIcon size={18} />
        </UtilityButton>
        <UtilityButton label={labels.help} onClick={onHelp} title={labels.help}>
          <HelpIcon size={18} />
        </UtilityButton>
        <UtilityButton
          label={labels.reconnect}
          onClick={onReconnect}
          accent={v.tool}
          title={labels.reconnect}
        >
          <RefreshIcon size={18} />
        </UtilityButton>
        <UtilityButton
          label={labels.skin}
          onClick={onSkin}
          accent={v.ai}
          title={labels.skin}
        >
          <SparkleIcon size={18} />
        </UtilityButton>
      </div>

      {/* Keyframes for the pulsing status dot. Inline <style> keeps it
          self-contained (no styles.css edit needed). */}
      <style>{`
        @keyframes sidebar-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
        .sidebar-session-row:hover { background: var(--mx-surface-hover, rgba(0,255,65,0.10)) !important; }
        .sidebar-utility-btn:hover {
          background: var(--mx-surface-hover, rgba(0,255,65,0.10)) !important;
          border-color: var(--mx-border, rgba(0,200,60,0.35)) !important;
        }
        @media (prefers-reduced-motion: reduce) {
          .sidebar-session-row span[aria-hidden="true"] { animation: none !important; }
        }
      `}</style>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Local chevron icons (Icons.tsx only exports ChevronLeftIcon; we need both
// expand/collapse directions for the toggle). Thin SVGs that inherit color.
// ---------------------------------------------------------------------------

function ChevronCollapseIcon({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  // Points left (collapse toward rail).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function ChevronExpandIcon({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  // Points right (expand back to full sidebar).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

export default Sidebar
