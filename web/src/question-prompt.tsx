// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
//
// QuestionPrompt — renders an opencode Question request (the agent's
// multiple-choice human-in-the-loop, distinct from permissions). A step-through
// wizard: one question at a time, single-select tap-to-advance, multi-select
// chips + a submit button, an optional "Other…" custom text answer, Back to
// correct, and a ✕ to skip (reject). Self-contained — no App/store imports; all
// data + labels flow in via props; its own scoped <style> (Matrix --mx-* tokens
// with literal fallbacks) so it needs zero edits to styles.css.
//
// The reply is `string[][]` — one entry per question, in order, each entry the
// list of selected option labels (or the typed custom answer).

import { useEffect, useState } from "react"
import type { QuestionRequest } from "./types"

export interface QuestionPromptLabels {
  back: string
  next: string
  submit: string
  skip: string
  other: string
  otherPlaceholder: string
  /** e.g. (2, 3) => "2/3" */
  progress: (current: number, total: number) => string
}

export interface QuestionPromptProps {
  request: QuestionRequest
  onReply: (answers: string[][]) => void
  onReject: () => void
  busy?: boolean
  labels: QuestionPromptLabels
}

export function QuestionPrompt({ request, onReply, onReject, busy, labels }: QuestionPromptProps) {
  const total = request.questions.length
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<string[][]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [customOn, setCustomOn] = useState(false)
  const [customText, setCustomText] = useState("")

  const current = request.questions[index]
  const allowCustom = current?.custom !== false
  const isMulti = Boolean(current?.multiple)

  // Hydrate the working selection when the question changes (covers Back-nav:
  // a prior answer is split into known option labels + an optional custom value).
  useEffect(() => {
    const prior = answers[index] ?? []
    const optionLabels = new Set((current?.options ?? []).map((o) => o.label))
    const known = prior.filter((a) => optionLabels.has(a))
    const custom = prior.find((a) => !optionLabels.has(a))
    setSelected(known)
    setCustomOn(custom !== undefined)
    setCustomText(custom ?? "")
    // Re-run only when the step changes; answers is read for rehydration only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, request.id])

  if (!current) return null

  // Commit the answer for the current question, then advance or submit-all.
  const commit = (answer: string[]) => {
    if (busy) return
    const next = [...answers]
    next[index] = answer
    if (index >= total - 1) {
      onReply(next)
    } else {
      setAnswers(next)
      setIndex(index + 1)
    }
  }

  const trimmedCustom = customText.trim()
  const composedAnswer = [...selected, ...(trimmedCustom ? [trimmedCustom] : [])]
  // Single-select needs the explicit submit button only while typing a custom
  // answer; otherwise tapping an option commits directly.
  const showSubmit = isMulti || customOn
  const canSubmit = isMulti ? composedAnswer.length > 0 : trimmedCustom.length > 0
  const submitLabel = index >= total - 1 ? labels.submit : labels.next

  const toggleMulti = (label: string) => {
    if (busy) return
    setSelected((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]))
  }

  const onSubmitButton = () => {
    if (isMulti) commit(composedAnswer)
    else commit([trimmedCustom])
  }

  return (
    <section className="question-prompt" role="region" aria-label={current.header}>
      <style>{QUESTION_STYLE}</style>

      <div className="question-prompt-head">
        <span className="question-prompt-glyph" aria-hidden="true">?</span>
        <strong className="question-prompt-header">{current.header}</strong>
        {total > 1 && <span className="question-prompt-progress">{labels.progress(index + 1, total)}</span>}
        <button
          type="button"
          className="question-prompt-skip"
          onClick={onReject}
          disabled={busy}
          aria-label={labels.skip}
          title={labels.skip}
        >
          ✕
        </button>
      </div>

      <p className="question-prompt-question">{current.question}</p>

      <div className="question-prompt-options" role={isMulti ? "group" : "radiogroup"}>
        {current.options.map((opt) => {
          const active = selected.includes(opt.label)
          return (
            <button
              key={opt.label}
              type="button"
              className={`question-prompt-option${active ? " selected" : ""}`}
              role={isMulti ? "checkbox" : "radio"}
              aria-checked={active}
              disabled={busy}
              onClick={() => (isMulti ? toggleMulti(opt.label) : commit([opt.label]))}
            >
              <span className="question-prompt-option-label">
                {isMulti && <span className="question-prompt-check" aria-hidden="true">{active ? "☑" : "☐"}</span>}
                {opt.label}
              </span>
              {opt.description && <span className="question-prompt-option-desc">{opt.description}</span>}
            </button>
          )
        })}

        {allowCustom && (
          <div className="question-prompt-other">
            {!customOn ? (
              <button
                type="button"
                className="question-prompt-option question-prompt-other-toggle"
                disabled={busy}
                onClick={() => setCustomOn(true)}
              >
                <span className="question-prompt-option-label">{labels.other}</span>
              </button>
            ) : (
              <input
                type="text"
                className="question-prompt-other-input"
                placeholder={labels.otherPlaceholder}
                value={customText}
                autoFocus
                disabled={busy}
                onChange={(e) => setCustomText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) {
                    e.preventDefault()
                    onSubmitButton()
                  }
                }}
                aria-label={labels.other}
              />
            )}
          </div>
        )}
      </div>

      <div className="question-prompt-actions">
        {index > 0 && (
          <button type="button" className="question-prompt-back" disabled={busy} onClick={() => setIndex(index - 1)}>
            ‹ {labels.back}
          </button>
        )}
        <span className="question-prompt-spacer" />
        {showSubmit && (
          <button
            type="button"
            className="question-prompt-submit"
            disabled={busy || !canSubmit}
            onClick={onSubmitButton}
          >
            {submitLabel} ›
          </button>
        )}
      </div>
    </section>
  )
}

// -----------------------------------------------------------------------------
// Scoped styles. All rules are prefixed `.question-prompt` to avoid colliding
// with the global stylesheet. Matrix --mx-* tokens with literal fallbacks so it
// renders correctly even before the host app defines them (and re-skins live).
// -----------------------------------------------------------------------------
const QUESTION_STYLE = `
.question-prompt {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px;
  background: var(--mx-surface-2, rgba(2, 30, 12, 0.78));
  border: 1px solid var(--mx-tool, #FFB000);
  border-left-width: 3px;
  border-radius: 12px;
  box-shadow: 0 0 0 1px rgba(255, 176, 0, 0.10), 0 10px 30px rgba(0,0,0,0.45);
  font-family: var(--font-family, -apple-system, "SF Pro Text", system-ui, sans-serif);
}
.question-prompt-head { display: flex; align-items: center; gap: 8px; }
.question-prompt-glyph {
  flex: 0 0 auto; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--mx-tool, #FFB000); border-radius: 5px;
  color: var(--mx-tool, #FFB000); font-family: var(--font-mono, ui-monospace, monospace); font-weight: 700; font-size: 12px;
}
.question-prompt-header {
  flex: 1 1 auto; min-width: 0;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 13px; letter-spacing: 0.03em;
  text-transform: uppercase; color: var(--mx-tool, #FFB000);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.question-prompt-progress {
  flex: 0 0 auto; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px;
  color: var(--mx-text-dim, rgba(200,255,217,0.55));
}
.question-prompt-skip {
  flex: 0 0 auto; width: 28px; height: 28px; min-height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid var(--mx-border-soft, rgba(0,200,60,0.18)); border-radius: 7px;
  color: var(--mx-text-dim, rgba(200,255,217,0.55)); cursor: pointer; font-size: 13px;
}
.question-prompt-skip:hover:not(:disabled) { color: var(--mx-danger, #FF3B30); border-color: var(--mx-danger, #FF3B30); }
.question-prompt-question {
  margin: 0; font-size: 14px; line-height: 1.4; color: var(--mx-text, #C8FFD9);
}
.question-prompt-options { display: flex; flex-direction: column; gap: 6px; }
.question-prompt-option {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  width: 100%; min-height: 44px; box-sizing: border-box;
  padding: 8px 12px; text-align: left; cursor: pointer;
  background: var(--mx-surface, rgba(4,20,10,0.60));
  border: 1px solid var(--mx-border-soft, rgba(0,200,60,0.18)); border-radius: 9px;
  color: var(--mx-text, #C8FFD9);
  transition: background .12s, border-color .12s, box-shadow .12s;
}
.question-prompt-option:hover:not(:disabled) { background: var(--mx-surface-hover, rgba(0,255,65,0.10)); }
.question-prompt-option.selected {
  border-color: var(--mx-user, #00FF41);
  box-shadow: inset 0 0 0 1px var(--mx-user, #00FF41);
}
.question-prompt-option:disabled { opacity: 0.55; cursor: default; }
.question-prompt-option-label {
  display: inline-flex; align-items: center; gap: 7px;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 13px; font-weight: 600;
  color: var(--mx-user, #00FF41);
}
.question-prompt-check { font-size: 13px; }
.question-prompt-option-desc {
  font-size: 11.5px; line-height: 1.3; color: var(--mx-text-dim, rgba(200,255,217,0.55));
}
.question-prompt-other-toggle .question-prompt-option-label { color: var(--mx-ai, #00E5FF); }
.question-prompt-other-input {
  width: 100%; box-sizing: border-box; min-height: 44px;
  padding: 8px 12px; border-radius: 9px;
  background: var(--mx-surface, rgba(4,20,10,0.60));
  border: 1px solid var(--mx-ai, #00E5FF);
  color: var(--mx-text, #C8FFD9); caret-color: var(--mx-ai, #00E5FF);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 16px; /* >=16px dodges iOS auto-zoom */
  outline: none;
}
.question-prompt-actions { display: flex; align-items: center; gap: 8px; }
.question-prompt-spacer { flex: 1 1 auto; }
.question-prompt-back, .question-prompt-submit {
  min-height: 38px; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; letter-spacing: 0.03em;
  text-transform: uppercase; font-weight: 700;
}
.question-prompt-back {
  background: transparent; border: 1px solid var(--mx-border-soft, rgba(0,200,60,0.18));
  color: var(--mx-text-dim, rgba(200,255,217,0.55));
}
.question-prompt-back:hover:not(:disabled) { color: var(--mx-text, #C8FFD9); }
.question-prompt-submit {
  background: var(--mx-user, #00FF41); border: 1px solid var(--mx-user, #00FF41);
  color: var(--mx-bg, #020A06);
}
.question-prompt-submit:disabled { opacity: 0.4; cursor: default; }
`

export default QuestionPrompt
