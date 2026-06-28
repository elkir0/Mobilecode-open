// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
// Terminal console — runs one-shot shell commands in a session's directory via
// opencode's `POST /session/:id/shell`. NOT an interactive PTY: opencode's /shell
// is request/response, so each command runs fresh in the session directory (no
// `cd` state, no job control, no interactive programs like vim/top). Styled to
// match the Matrix "hacker console" skin.
//
// DEBUG: every command also stores the raw `parts` JSON (collapsible "raw response"
// under each entry) so we can see exactly what opencode returns and fix output
// extraction if the shape differs from the assumed {tool:{state:{output}}}.
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { api } from "./api"
import type { MessageEnvelope, MessagePart, ModelSelection, ServerConfig } from "./types"

type EntryStatus = "running" | "ok" | "error"
interface Entry { id: number; command: string; output: string; status: EntryStatus; raw?: string }

export interface TerminalLabels {
  title: string
  hint: string
  placeholder: string
  running: string
  prompt: string
}
export interface TerminalConsoleProps {
  config: ServerConfig
  sessionID: string
  directory: string
  agent: string
  model?: ModelSelection
  labels: TerminalLabels
}

/** Pull human-readable output from a /session/:id/shell response.
 *  Tries tool.state.output / tool.state.error, then text parts. The raw `parts`
 *  JSON is always returned too so the UI can surface it when extraction is empty. */
function extractOutput(env: MessageEnvelope): { output: string; status: EntryStatus; raw: string } {
  let errored = false
  const lines: string[] = []
  for (const part of env.parts as MessagePart[]) {
    const t = part.type
    if (t === "tool") {
      const st = part.state
      if (st?.status === "error") {
        errored = true
        if (st.error) lines.push(String(st.error))
      }
      if (st?.output !== undefined && st.output !== null && st.output !== "") {
        const out = typeof st.output === "string" ? st.output : JSON.stringify(st.output, null, 2)
        if (out) lines.push(out)
      }
    } else if (t === "text" && part.text) {
      lines.push(part.text)
    } else {
      // Forward-compat fallback: surface any string-bearing field on unknown part
      // types so shell output in an unexpected shape is still visible (prefixed).
      const probe = part as Record<string, unknown>
      const extra = probe.output ?? probe.content ?? probe.result ?? probe.text
      if (typeof extra === "string" && extra.trim()) lines.push(`[${t}] ${extra}`)
    }
  }
  return { output: lines.join("\n").trim(), status: errored ? "error" : "ok", raw: JSON.stringify(env.parts, null, 2) }
}

let entrySeq = 1

export function TerminalConsole({ config, sessionID, directory, agent, model, labels }: TerminalConsoleProps) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [running, setRunning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dirName = directory ? directory.replace(/\/+$/, "").split("/").pop() || directory : ""

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, running])

  async function run(command: string) {
    const cmd = command.trim()
    if (!cmd || running) return
    const id = entrySeq++
    setEntries((prev) => [...prev, { id, command: cmd, output: "", status: "running" }])
    setInput("")
    setHistory((prev) => (prev.includes(cmd) ? prev : [...prev, cmd]))
    setHistoryIdx(-1)
    setRunning(true)
    try {
      const env = await api.shell(config, sessionID, cmd, agent, model, directory)
      const { output, status, raw } = extractOutput(env)
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, output, status, raw } : e)))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, output: msg, status: "error", raw: msg } : e)))
    } finally {
      setRunning(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault()
      run(input)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      if (history.length === 0) return
      const next = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(next)
      setInput(history[next])
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      if (historyIdx < 0) return
      const next = historyIdx + 1
      if (next >= history.length) { setHistoryIdx(-1); setInput("") }
      else { setHistoryIdx(next); setInput(history[next]) }
    }
  }

  return (
    <div className="terminal-view" role="region" aria-label={labels.title}>
      <div className="terminal-output" ref={scrollRef}>
        <div className="terminal-banner">
          <strong className="fx-glow">{labels.title}</strong>
          <small>{dirName} · {labels.hint}</small>
        </div>
        {entries.map((e) => (
          <div key={e.id} className="terminal-entry">
            <div className="terminal-cmd"><span className="terminal-prompt" aria-hidden="true">{labels.prompt}</span>{e.command}</div>
            {e.status === "running" ? (
              <div className="terminal-out is-running">{labels.running}…</div>
            ) : e.output ? (
              <pre className={`terminal-out is-${e.status}`}>{e.output}</pre>
            ) : (
              <div className="terminal-out is-ok subtle">(no parseable output — expand “raw response” below)</div>
            )}
            {e.raw && (
              <details className="terminal-debug">
                <summary>raw response</summary>
                <pre>{e.raw}</pre>
              </details>
            )}
          </div>
        ))}
      </div>
      <div className="terminal-input-row">
        <span className="terminal-prompt" aria-hidden="true">{labels.prompt}</span>
        <input
          className="terminal-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={labels.placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={running}
          aria-label={labels.placeholder}
        />
      </div>
    </div>
  )
}
