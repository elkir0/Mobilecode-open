// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
//
// CommandPalette — the ⌘K overlay (see docs/ipad-design-analysis.md §4 "Keyboard shortcuts").
// Self-contained: renders its own scoped <style> (Matrix --mx-* tokens with literal fallbacks),
// so it needs NO edits to styles.css. Integration agent wires <CommandPalette open onClose commands placeholder />
// and triggers it from the single window keydown handler on ⌘K.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/** A single selectable action surfaced in the ⌘K palette. */
export interface CommandItem {
  id: string
  label: string
  hint?: string
  /** Optional grouping header (rows are bucketed and rendered under a small header). */
  group?: string
  /** Invoked on Enter / click. Palette closes immediately after a successful run. */
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: CommandItem[]
  placeholder: string
}

// -----------------------------------------------------------------------------
// Matching — case-insensitive substring with a "consecutive chars" fuzzy boost.
// A label containing the query chars in order (possibly non-contiguous) scores
// higher than a plain substring miss. Empty query = show everything (stable order).
// -----------------------------------------------------------------------------
interface ScoredCommand {
  cmd: CommandItem
  score: number
}

function scoreCommand(query: string, cmd: CommandItem): number {
  if (!query) return 1
  const label = cmd.label.toLowerCase()
  const hint = cmd.hint?.toLowerCase() ?? ""
  const q = query.toLowerCase()

  // Exact / substring hits are the strongest signals.
  if (label === q) return 1000
  const subIdx = label.indexOf(q)
  if (subIdx === 0) return 800 // prefix match
  if (subIdx > 0) return 500 // mid substring
  if (hint.includes(q)) return 250 // hint match (weaker — labels are primary)

  // Fuzzy: consecutive run of query chars appearing in order anywhere in label.
  let qi = 0
  let run = 0
  let bestRun = 0
  for (let li = 0; li < label.length && qi < q.length; li++) {
    if (label[li] === q[qi]) {
      qi++
      run++
      bestRun = Math.max(bestRun, run)
    } else {
      run = 0
    }
  }
  if (qi === q.length) return 100 + bestRun * 5 // full query consumed in order
  return -1 // no match
}

function filterAndSort(query: string, commands: CommandItem[]): ScoredCommand[] {
  const scored: ScoredCommand[] = []
  for (const cmd of commands) {
    const s = scoreCommand(query, cmd)
    if (s >= 0) scored.push({ cmd, score: s })
  }
  // Stable sort by score desc, preserving caller order within equal scores.
  scored.sort((a, b) => b.score - a.score)
  return scored
}

// Group scored commands, preserving the (already score-sorted) order. Groups
// appear in order of first encounter.
interface GroupedRow {
  type: "header"
  label: string
  index: number // flat index for keyboard nav
}
interface ItemRow {
  type: "item"
  cmd: CommandItem
  index: number
}
type Row = GroupedRow | ItemRow

function buildRows(scored: ScoredCommand[]): Row[] {
  const rows: Row[] = []
  const seenGroups = new Set<string>()
  let flatIndex = 0
  for (const { cmd } of scored) {
    if (cmd.group && !seenGroups.has(cmd.group)) {
      seenGroups.add(cmd.group)
      rows.push({ type: "header", label: cmd.group, index: -1 })
    }
    rows.push({ type: "item", cmd, index: flatIndex })
    flatIndex++
  }
  return rows
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------
export function CommandPalette({ open, onClose, commands, placeholder }: CommandPaletteProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0) // index among item rows (not headers)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Reset filter + selection every time the palette opens, autofocus the input.
  useEffect(() => {
    if (open) {
      setQuery("")
      setActiveIndex(0)
      // Autofocus on next paint so the input is mounted/visible.
      const t = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
  }, [open])

  const rows = useMemo(() => buildRows(filterAndSort(query, commands)), [query, commands])
  const itemCount = useMemo(() => rows.filter((r) => r.type === "item").length, [rows])

  // Clamp active index when the filtered set shrinks.
  useEffect(() => {
    if (activeIndex > 0 && activeIndex >= itemCount) {
      setActiveIndex(Math.max(0, itemCount - 1))
    }
  }, [itemCount, activeIndex])

  // Scroll the active row into view whenever it changes.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-cp-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, open, rows])

  const runActive = useCallback(() => {
    const target = rows.find((r) => r.type === "item" && r.index === activeIndex)
    if (target && target.type === "item") {
      target.cmd.run()
      onClose()
    }
  }, [rows, activeIndex, onClose])

  const moveSelection = useCallback(
    (delta: number) => {
      if (itemCount === 0) return
      setActiveIndex((prev) => {
        const next = (prev + delta) % itemCount
        return next < 0 ? next + itemCount : next
      })
    },
    [itemCount]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault()
          moveSelection(1)
          break
        case "ArrowUp":
          e.preventDefault()
          moveSelection(-1)
          break
        case "Enter":
          e.preventDefault()
          runActive()
          break
        case "Escape":
          e.preventDefault()
          onClose()
          break
        case "Tab":
          // Prevent Tab from leaving the palette while it's open.
          e.preventDefault()
          moveSelection(e.shiftKey ? -1 : 1)
          break
        default:
          break
      }
    },
    [moveSelection, runActive, onClose]
  )

  if (!open) return null

  return (
    <div
      className="cp-root"
      role="dialog"
      aria-modal="true"
      aria-label={placeholder}
      onKeyDown={handleKeyDown}
    >
      <style>{PALETTE_STYLE}</style>

      {/* Backdrop — click anywhere outside the panel closes. */}
      <div className="cp-backdrop" onClick={onClose} aria-hidden="true" />

      <div className="cp-panel">
        <div className="cp-input-row">
          <span className="cp-prompt" aria-hidden="true">
            ⌘K
          </span>
          <input
            ref={inputRef}
            className="cp-input"
            type="text"
            value={query}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={placeholder}
            onChange={(e) => {
              setQuery(e.currentTarget.value)
              setActiveIndex(0)
            }}
            aria-label={placeholder}
          />
          <button
            type="button"
            className="cp-esc"
            onClick={onClose}
            aria-label="Close command palette"
          >
            esc
          </button>
        </div>

        <div className="cp-list" ref={listRef} role="listbox">
          {itemCount === 0 ? (
            <div className="cp-empty">No matches</div>
          ) : (
            rows.map((row, i) => {
              if (row.type === "header") {
                return (
                  <div key={`h-${row.label}-${i}`} className="cp-group">
                    {row.label}
                  </div>
                )
              }
              const isActive = row.index === activeIndex
              return (
                <button
                  type="button"
                  key={`i-${row.cmd.id}-${i}`}
                  className={`cp-item${isActive ? " cp-item-active" : ""}`}
                  data-cp-index={row.index}
                  role="option"
                  aria-selected={isActive}
                  onMouseMove={() => setActiveIndex(row.index)}
                  onClick={() => {
                    row.cmd.run()
                    onClose()
                  }}
                >
                  <span className="cp-item-label">{row.cmd.label}</span>
                  {row.cmd.hint ? <span className="cp-item-hint">{row.cmd.hint}</span> : null}
                </button>
              )
            })
          )}
        </div>

        <div className="cp-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Scoped styles. All rules are prefixed `.cp-` to avoid colliding with the
// global stylesheet. Colors use Matrix --mx-* tokens with literal fallbacks so
// the palette renders correctly even before the host app defines the tokens.
// -----------------------------------------------------------------------------
const PALETTE_STYLE = `
.cp-root {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: max(12vh, env(safe-area-inset-top, 0px));
  font-family: -apple-system, "SF Pro Text", system-ui, sans-serif;
}
.cp-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.cp-panel {
  position: relative;
  width: min(620px, calc(100vw - 32px));
  max-height: min(70vh, 620px);
  display: flex;
  flex-direction: column;
  background: var(--mx-surface-2, rgba(2, 30, 12, 0.78));
  border: 1px solid var(--mx-border, #0C2);
  border-radius: 14px;
  box-shadow:
    0 0 0 1px rgba(0, 204, 68, 0.08),
    0 18px 60px rgba(0, 0, 0, 0.6),
    0 0 40px rgba(0, 204, 68, 0.12);
  overflow: hidden;
}
.cp-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--mx-border, rgba(0, 204, 68, 0.35));
  background: var(--mx-surface, rgba(4, 20, 10, 0.6));
}
.cp-prompt {
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--mx-tool, #FFB000);
  padding: 2px 6px;
  border: 1px solid var(--mx-border, rgba(0, 204, 68, 0.4));
  border-radius: 4px;
  opacity: 0.85;
}
.cp-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: 0;
  color: var(--mx-user, #00FF41);
  font-size: 16px; /* >=16px dodges iOS auto-zoom */
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  caret-color: var(--mx-user, #00FF41);
}
.cp-input::placeholder {
  color: var(--mx-dim, #3A8A55);
}
.cp-esc {
  flex: 0 0 auto;
  background: transparent;
  border: 1px solid var(--mx-border, rgba(0, 204, 68, 0.3));
  border-radius: 5px;
  color: var(--mx-muted, #5FF58A);
  font-size: 11px;
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  padding: 3px 7px;
  cursor: pointer;
}
.cp-esc:hover { color: var(--mx-user, #00FF41); }

.cp-list {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 6px;
}
.cp-group {
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--mx-dim, #3A8A55);
  padding: 10px 10px 4px;
}
.cp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 44px;        /* 44pt touch target */
  box-sizing: border-box;
  padding: 8px 10px;
  margin: 0;
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--mx-user, #00FF41);
  font-size: 14px;
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
}
.cp-item-active,
.cp-item:hover {
  background: rgba(0, 204, 68, 0.12);
  box-shadow: inset 0 0 0 1px var(--mx-border-active, #0A4);
}
.cp-item-active .cp-item-label {
  text-shadow: 0 0 8px rgba(0, 255, 65, 0.45); /* phosphor glow on active */
}
.cp-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-item-hint {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--mx-dim, #3A8A55);
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
}
.cp-empty {
  padding: 24px 14px;
  text-align: center;
  color: var(--mx-dim, #3A8A55);
  font-size: 13px;
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
}
.cp-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  border-top: 1px solid var(--mx-border, rgba(0, 204, 68, 0.3));
  background: var(--mx-surface, rgba(4, 20, 10, 0.6));
  font-size: 11px;
  color: var(--mx-dim, #3A8A55);
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
}
.cp-foot kbd {
  display: inline-block;
  min-width: 16px;
  padding: 1px 5px;
  margin-right: 3px;
  border: 1px solid var(--mx-border, rgba(0, 204, 68, 0.35));
  border-radius: 3px;
  text-align: center;
  color: var(--mx-muted, #5FF58A);
}
@media (prefers-reduced-motion: reduce) {
  .cp-item-active .cp-item-label { text-shadow: none; }
}
`
