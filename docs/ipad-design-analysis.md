// SPDX-License-Identifier: Apache-2.0
# Mobilecode-open — iPad Design Analysis (Synthesized)

> One app, two postures. Consolidated from 4 sub-analyses (audit, HIG research, landscape design, portrait design). Last updated: 2026-06-28.

**Source files:** `web/src/App.tsx` (~3468 lines, single `App()` component, 4-view state machine), `web/src/styles.css` (~1547 lines, 2 skins via `data-skin`, 3 FX layers via `data-fx-*`), `web/src/terminal.tsx` (one-shot `POST /session/:id/shell`, no PTY), `web/src/matrix-fx.ts` + `web/src/decode.ts` (FX/decode).

---

## 1. TL;DR — recommended adaptive system

**One app, size-class-driven.** Key everything off **horizontal size class** (compact vs regular), not raw orientation — this is Apple's own model and it makes iPad rotation, Slide Over, Split View, and Stage Manager all fall out for free.

- **Compact width (<810px CSS / Slide Over / 1/3 Split View / phone):** the *current* mobile layout unchanged. Bottom-nav dock + single column + fixed composer. Zero work — already shipping, already verified on device.
- **Regular width, portrait touch (≥1024px, no keyboard):** single-column, the existing 760px content cap centered with gutters. **Top-nav tab-row promoted to primary** (it already is above 780px), bottom-nav hidden, all touch targets bumped to 44pt via `@media (pointer: coarse)`. Terminal stays a `[Chat][Terminal]` detail-mode toggle. **~3 additive CSS rules, zero new components, zero App.tsx edits.**
- **Regular width, landscape + keyboard (≥1024px AND landscape):** the headline upgrade. **3-zone split** — sessions sidebar (left) | chat (center, always) | inspector panel (right, hosts Terminal + Files + Todo + Diagnostics as tabs). New `⌘K` command palette, `⌘1/2/3` zone focus, `⌘↵` send, `⌘\` toggle sidebar. Settings/Help become overlays, not columns.

**Why this shape:** the app is a *monitor-and-pilot* surface for a remote agent (architecturally identical to Cursor Remote Agents). You read the agent's output fast and send the next instruction fast. Landscape+keyboard is where that flow is best — three zones let you watch the agent (center), glance at artifacts (right), and switch projects (left) without context-switching. Portrait/touch optimizes for comfortable one-handed prompting, where the composer is the hero and a split would shrink chat to phone-width for no gain.

**Reuse posture:** the *entire* theme/FX/token system, all content components (cards, bubbles, composer internals, sheets, diagnostics, terminal), and the 4-view state machine are reused untouched. The deltas are: one CSS grid for landscape, one new `<CommandPalette/>` overlay, one `focusZone` state + a `window` keydown handler, and a new `<Inspector/>` column wrapping the already-built `<TerminalConsole/>` + diagnostics. The verified mobile path is never touched.

---

## 2. Current-state audit

The whole app is **one `App.tsx`** returning a single `.app-shell` div with a `{view === "x" && ...}` switch. No router.

### Views (4-state machine, `App.tsx:511`)
| View | Purpose | Render |
|---|---|---|
| `settings` (connect) | host/port/user/password, Test/Save, **skin segmented control**, FX toggles, language, push-relay | `.panel.settings` (L2088) |
| `sessions` (list) | summary + Refresh/New, search toolbar, `.session-list` of `.session-card` | `.panel.sessions` (L2323) |
| `detail` (chat/terminal) | topbar (back/status/⋯), header, **permission banner stack**, context-strip (AI/details chips), `[Chat][Terminal]` mode toggle, todo-box, then `.messages-wrap`+`.composer` OR `<TerminalConsole>` | `.panel.detail` (L2591) |
| `help` | tabs (overview/server/network/troubleshooting/commands/diagnostics) + content | `.panel.help` (L3127) |

Boot default = `settings` if no host/port, else `sessions`. `detailMode: "chat" | "terminal"` (L557) is an in-view toggle, not a top-level view.

### Navigation — TWO redundant systems (key finding)
1. **Desktop top tabs** — `.top-nav .desktop-nav.tab-row` (L2072), always in DOM. 4 buttons (`navItems` L2050): Sessions / Detail(disabled unless selected) / Settings / Help.
2. **Mobile bottom dock** — `.bottom-nav` (L3444), same `navItems`. CSS decides visibility.

Both render the identical `navItems` array — duplication a sidebar would collapse.

### Overlays (not views)
`showNewSessionPicker` (folder modal), `showFilePicker` (composer-attach modal + fuzzy `findFile`), `activeDetailSheet: null|"ai"|"details"` (AI=model picker / details=dashboard), `sessionToDelete` (confirm), `actionsMenuOpen` (fork/share/summarize/rename/delete dropdown), `toast` (2.6s auto-hide).

### Responsiveness today — exactly 3 media blocks (styles.css)
1. `@media (max-width:780px)` @ L949 — `.project-dashboard` 3-col→1-col.
2. `@media (max-width:780px)` @ L1242 — the main mobile block: hides `.desktop-nav.tab-row`, full-bleed panels, stacks `.form-grid`, truncates card titles, full-width bubbles, **composer widens + lifts `bottom:+76px`**, dims scanlines.
3. `@media (prefers-reduced-motion:reduce)` @ L1284 — a11y.

**Critical:** there is **NO iPad / `min-width` breakpoint anywhere.** Layout is binary: ≤780px = mobile, >780px = the un-tuned default. iPad portrait (1024) and landscape (1366) both fall through to base rules with zero adaptation.

### What is phone-specific (needs iPad equivalent)
1. **`.bottom-nav`** — fixed bottom pill dock, 4 items. Phone canonical; iPad wants a left sidebar.
2. **`.top-nav .desktop-nav.tab-row`** — currently "desktop" nav but a horizontal tab row, not a sidebar. Duplicated `navItems`.
3. **Full-screen sheets/modals** — `.modal-card` max 460px, `.sheet-content` max 760px/85vh. Phone reachability; iPad wants side inspectors.
4. **≤780 composer lift** (`bottom:+76px`) + full-bleed panels — phone ergonomics. (`--chat-bottom-clearance` JS var at L1087 is view-agnostic and ports.)
5. **`.messages { max-width:760px; margin:0 auto }`** — already a centered column (intentional phone-readability); on iPad leaves wide gutters — candidate for a 2-pane layout.

### Theme / FX system (viewport-independent — reuse 100%)
- **Two skins** via `<html data-skin="matrix|official">`. Matrix=default (CRT green). Official=warm-neutral+gold, a single override block (L1388) that re-defines every `--mx-*` token. **Zero class renames** to switch — every component reads tokens.
- **3 FX layers** (Matrix only, gated by `<html data-fx-*>`): `data-fx-scan` (scanlines via `.app-shell::after` + `.fx-glow` phosphor shadow, one toggle), `data-fx-rain` (`#matrix-rain` canvas, opacity-tiered off/low/med/high), `data-fx-decode` (katakana→text on live bubble via `decode.ts`, skipped for markdown text).
- Official skin kills all FX unconditionally (L1475).

---

## 3. iPad patterns applied (cited)

| Pattern | Source | Applied here as |
|---|---|---|
| **Split view at multiple widths** ("iPad windows are fluidly resizable… consider the design at multiple widths") | [HIG Split views](https://developer.apple.com/design/human-interface-guidelines/split-views), [WWDC25 S208](https://developer.apple.com/videos/play/wwdc2025/208/) | 3-zone landscape split tested at 5 widths, not 2 orientations. |
| **Three-column + inspector** (first-class inspector columns, interactive resize) | [WWDC25 S282](https://developer.apple.com/videos/play/wwdc2025/282/) | Right inspector pane = Terminal/Files/Todo/Diagnostics tabs. |
| **Tab bar ↔ sidebar morph** (compact tab bar becomes regular sidebar) | [WWDC24 S10147](https://developer.apple.com/videos/play/wwdc2024/10147/) | Bottom-nav (compact) → sessions sidebar (regular). |
| **Sidebar conversation list** | [ChatGPT iOS FAQ](https://help.openai.com/en/articles/7885016-chatgpt-ios-app-faq) | Left sidebar = sessions list, persistent in landscape. |
| **Split panes + ⌘T/⌘W + swipe nav** | [Blink Shell](https://docs.blink.sh/), [Blevins review](https://jblevins.org/log/blink-shell) | ⌘T new session, ⌘W close, swipe between sessions. |
| **Command palette** (keyboard-first, context-aware) | [Termius X](https://termius.com/blog/termius-x), [UX Patterns](https://uxpatterns.dev/patterns/advanced/command-palette), [Solomon](https://solomon.io/designing-command-palettes/) | ⌘K palette: fuzzy sessions + slash-commands + session-scoped actions. |
| **Hold-⌘ shortcut overlay** (free discoverability) | [HIG Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards), `UIKeyCommand` | Register shortcuts so the system overlay works for free. |
| **Companion, not editor** (monitor + control surface) | [Cursor Remote Agents](https://www.buildfastwithai.com/blogs/cursor-remote-agents-any-device-2026) | Optimize for read-output-fast + send-instruction-fast, not code editing. |
| **Size-class reflow, not orientation** | [Use Your Loaf](https://useyourloaf.com/blog/size-classes/), [5-layer adaptive](https://medium.com/@wesleymatlock/swiftui-ipad-adaptive-layout-five-layers-for-apps-that-dont-break-in-split-view-8433b726f293) | All breakpoints gated on width/size-class; rotation never toggles a media query. |
| **Readable content width** (~672pt) | [HIG Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | Keep `.messages` 760px cap in chat pane; widen only in single-pane full-width. |
| **44pt min touch targets** | HIG | `@media (pointer: coarse)` bumps all interactive targets to 44pt. |

---

## 4. LANDSCAPE design (primary vibe-coding posture)

### The pick: 3-zone split (sidebar | chat | inspector)

Chose 3-zone over 2-zone-with-tabbed-terminal. Decisive fact: the terminal is **not a PTY** — it's one-shot `POST /session/:id/shell`, request/response, no `cd`/job-control. So the terminal is *not* something you live in (rules out co-equal center tab), but *is* something you want visible while the agent works (rules out hidden). **Right panel = always-visible inspector containing the terminal as one tab.** Center is always chat. This matches how vibe-coding actually feels: talk to the agent (middle), peek at artifacts (right), switch projects (left).

### ASCII — landscape (1366×1024, 11" iPad; works down to 1024-wide)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⌘ top bar: brand · host:port · conn ● · skin ◑ · ⌘K search        (h ≈ 44px)  │
├────────────────┬───────────────────────────────────┬──────────────────────────┤
│  SESSIONS      │  CHAT (always center)              │  INSPECTOR               │
│  (sidebar)     │  ┌─────────────────────────────┐   │  ┌────────────────────┐  │
│                │  │ context-strip: model·project │   │  │ ▸Terminal ▸Files   │  │
│ ▸ project-A    │  ├─────────────────────────────┤   │  │ ▸Todo    ▸Diag     │  │
│ ● project-B ▣  │  │ user:  "refactor the parser" │   │  ├────────────────────┤  │
│   idle 12m     │  │ ai:    [tool: edit ✓]        │   │  │ $ git status       │  │
│ ▸ project-C    │  │       "done, see diff"       │   │  │ nothing to commit  │  │
│   busy ▰▱▱     │  │       <file diff>            │   │  │ $ ls src/          │  │
│ ▸ project-D    │  │                              │   │  │ parser.ts utils.ts │  │
│                │  │ [perm-banner: allow edit?]   │   │  ├────────────────────┤  │
│ ─────────────  │  │                              │   │  │ > _   (term input) │  │
│ + new session  │  ├─────────────────────────────┤   │  │ ↑↓ history · ⏎ run │  │
│                │  │ composer                     │   │  └────────────────────┘  │
│                │  │ [📎][/(slash)] type… [⏎ send] │   │                          │
│                │  └─────────────────────────────┘   │                          │
├────────────────┴───────────────────────────────────┴──────────────────────────┤
│ NO bottom-nav in landscape (replaced by sidebar).                              │
└────────────────────────────────────────────────────────────────────────────────┘
   18% (clamp 220–280px)    52% (flex, min 480px)         30% (clamp 300–440, collapsible→44px rail)
```

**Zone rationale:** Chat ~52% (≈700px on 11") = readable wrapped code + diffs, not 100+ char prose lines. Inspector 30% = glanceable artifacts (terminal + the already-built diagnostics panel + todos moved out of the chat column so they stop pushing the composer below the fold). Sidebar 18% = launcher.

Activates at `@media (min-width:1024px) and (orientation:landscape)`. Below 1024-wide landscape (rare, old 9.7"), falls back to single-column.

### Keyboard shortcuts (one `window` keydown handler, ~40 lines)
| Key | Action |
|---|---|
| **⌘K** | Command palette (fuzzy: sessions, slash-commands, session-scoped actions, settings) |
| **⌘↵** | Send to *active* zone (chat prompt OR terminal command) |
| **⌘1 / ⌘2 / ⌘3** | Focus sidebar search / chat composer / terminal input |
| **⌘\\** | Toggle sidebar collapse (persist in `localStorage`) |
| **⌘] / ⌘[** | Expand / collapse inspector |
| **⌘T / ⌘W** | New / close session (Blink lineage) |
| **⌘.** | Abort active session |
| **⌘/** | Toggle Matrix FX on/off (one-key "calm mode") |
| **Esc** | Close any overlay (palette, picker, menu) |
| **/** (in composer) | Open slash-command menu |
| **↑↓** (empty composer) | Recall previous prompt (mirrors terminal history) |
| **↑↓** (sidebar) | Move session selection, ↵ open |

Gate all ⌘-shortcuts behind `if (e.metaKey || e.ctrlKey)` + `preventDefault()`; let unmodified keys (Esc, /, arrows) pass through only when not typing in an input unless it's a known in-field binding.

### Sidebar (replaces both `.top-nav tab-row` and `.bottom-nav` in landscape)
- **Top = sessions list** (existing `.session-list` + search + "new session"). Selecting loads it into the chat column — no "back to sessions" button; sessions always visible.
- **Bottom = utility rail (icon-only):** ⚙ settings, ? help, ⟳ reconnect, ◑ skin. These 3 non-session views open as **overlays** (consulted, not occupied).
- **Collapsible** to a 44px icon rail via `[«]` toggle (persist `opencode_remote_sidebar`).

### Composer + terminal coexistence (explicit focus)
- **Single `focusZone: "chat" | "terminal"` state.** ⌘2→chat, ⌘3→terminal. Click sets zone. Active zone gets phosphor glow border (Matrix) / accent ring (official); inactive dims to 60%.
- **⌘↵ sends to active zone.** Terminal keeps plain ↵ too.
- **Slash commands + file-attach are chat-only** — hidden when terminal is active zone.
- Composer anchors to the chat pane (`position:absolute/sticky` scoped to detail), not the viewport.

### Both skins at iPad scale
- **Matrix perf is the real risk, not aesthetics.** `#matrix-rain` redraws the full viewport per frame — at 1366×1024 that's ~3.4× a phone canvas; on a 120Hz ProMotion display it'll chew battery and can jank chat scroll. Fixes (no behavior change): clamp `devicePixelRatio` to `min(dpr,1.5)`; gate rAF on `document.hidden` + `prefers-reduced-motion`; **auto-force `data-fx-rain="low"` above 1024px wide** unless user bumps it (one-time toast). Scanline overlay = static CSS (free). `.fx-glow` = cheap. Decode animation = per-element (unaffected).
- **Official skin:** just needs the 3-zone chrome — warm-neutral fills, hairline separators. Layout containers are skin-agnostic; FX auto-disabled by existing `html[data-skin]` rules.

---

## 5. PORTRAIT design (touch, no keyboard)

### The pick: single-column capped (NOT 2-column)
Keep the existing 760px content column centered. **Reject 2-column master-detail** because: (a) the `view` state machine is a single string — sessions/detail are mutually exclusive; 2-column needs splitting `view` into two states + refactoring every `setView("detail")` (openSession, deleteSession, notification handler) + reworking the composer's one-detail-open assumption = structural rewrite of a ~3468-line file for a *secondary* form factor; (b) portrait iPad is held, not propped — a 320px rail + 700px chat leaves chat at phone-width anyway; (c) touch + no keyboard = composer is the hero, wants full thumb-arc width; (d) the app is message-centric (launch-then-work, not browse-then-read).

At 1024px the 760px cap stops being a constraint and becomes the design — centered with ~130px gutters looks intentional, not stretched.

### ASCII — portrait, single-column capped (recommended)
```
┌─────────────────────────────────────────────────────────────┐ 1024px
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [▣] OPencode Remote   [Sessions][Chat][Settings][Help]  │ │ ← top-nav tab-row VISIBLE (≥781px), primary nav
│ │     macbook…:443 • connected                            │ │
│ └─────────────────────────────────────────────────────────┘ │
│        ┌──────────────────────────────────────────┐         │ ← 760px content col, centered
│        │ SESSIONS                          [＋ New]│         │
│        │ ┌──────────────────────────────────────┐ │         │
│        │ │ ▸ M2 widget + Live Activity   ●busy  │ │         │ ← wider cards, 2-line OK
│        │ │   /Users/anthony/mobilecode-ios      │ │         │
│        │ ├──────────────────────────────────────┤ │         │
│        │ │ ▸ fix(design) mobile responsive  idle│ │         │
│        │ └──────────────────────────────────────┘ │         │
│        └──────────────────────────────────────────┘         │
│   (bottom-nav dock HIDDEN at ≥781px)                        │
└─────────────────────────────────────────────────────────────┘
```

Detail view, same column — chat or terminal via the existing `[Chat][Terminal]` toggle:
```
        ┌──────────────────────────────────────────┐
        │ ‹  M2 widget + Live Activity        ⋯    │ ← detail-topbar (sticky)
        │    [ • Chat ]  [  Terminal  ]            │ ← detail-mode-toggle, 44pt
        ├──────────────────────────────────────────┤
        │ ▌user  10:42                             │
        │ ┌────────────────────────────────────┐   │ ← wider bubbles, role-coded left border
        │ │ add a home widget                  │   │
        │ └────────────────────────────────────┘   │
        │ ▌assistant  10:43                       │
        │ ┌────────────────────────────────────┐   │
        │ │ ```swift                           │   │ ← code blocks get real width
        │ │ struct Widget { … }                │   │
        │ │ ```                                │   │
        │ └────────────────────────────────────┘   │
        ├──────────────────────────────────────────┤
        │ ┌──────────────────────────────────────┐ │ ← composer centered, 44pt buttons
        │ │ ＋  type a message…        🎙  ➤     │ │
        │ └──────────────────────────────────────┘ │
        └──────────────────────────────────────────┘
```

### Navigation in portrait
- **Top-nav tab-row is primary** (it already is above 780px). Hide `.bottom-nav` at ≥781px (one rule, symmetric to L1248). No sidebar, no new tab bar — 4 destinations fit comfortably beside the brand.
- **Touch targets:** bump tab-row buttons (currently ~32px) to `min-height:44px`, composer buttons (38px) to 44px, mode-toggle to 44px. Use **`@media (pointer: coarse)`** as the adaptive selector (catches touch MacBooks too), not pure width.

### Terminal in portrait
**Stays a detail-mode toggle** (`[Chat][Terminal]`, scoped to the open session). Do NOT promote to a top tab (over-ranks a keyboard-starved surface) or a bottom sheet (collides with the fixed composer). One tap away when in-session = correct hierarchy. Touch-ups: 44pt toggle buttons; cap `.terminal-output` to the same 760px column for visual rhythm; keep `font:16px` input to dodge iOS zoom.

### Landscape → portrait reflow (zero jank by construction)
- **iPad portrait (1024) and landscape (1366) are BOTH above the 780px breakpoint** → rotation never toggles a media query, never re-anchors a fixed element, never switches nav mode. This is the key anti-jank property.
- Only `env(safe-area-inset-*)` and viewport dims change; top-nav/composer offsets recompute from `calc(env(safe-area-inset-*) + …)` — already handled, GPU-composited.
- **Persists across rotation:** current `view`, `selectedID`, composer text, scroll position (browser preserves on resize), open sheets, FX toggles, skin. Nothing hidden by rotation itself.
- **Slide Over / 1/3 Split View** dips below 780px → mobile breakpoint kicks in correctly for free.

---

## 6. Shared system

### Nav model (by size class)
| Size class | Nav | Source |
|---|---|---|
| Compact (<810px) | `.bottom-nav` dock (current) | unchanged |
| Regular portrait (≥1024px, touch) | `.top-nav` tab-row (current, promoted) | hide bottom-nav, 44pt targets |
| Regular landscape (≥1024px + landscape) | left sessions sidebar + icon utility rail | new `<Sidebar/>`, replaces both navs |

### Keyboard layer
- One `useEffect` on `window`, one switch, ~40 lines. Cross-platform via `metaKey || ctrlKey`.
- All shortcuts registered so the system hold-⌘ overlay works for free (`UIKeyCommand` lineage).
- Default focus into the composer on keyboard attach (agent stream is read-mostly).
- `focusZone` state disambiguates the two visible inputs (chat composer + terminal) in landscape.

### Theme / FX at iPad scale
- Token architecture is viewport-independent — both skins render identically at any width. Reuse 100%.
- **Matrix rain perf** is the only FX concern on big canvas. Mitigations: DPR clamp, visibility-gated rAF, **auto-degrade to `low` above 1024px** (one-time toast, user can override in Settings). Scanlines/glow/decode unaffected.
- 3-zone focus glow reuses existing `--glow-strong`.

### Responsive breakpoint strategy
```
@media (max-width: 780px)                         /* existing — mobile/Slide Over */
@media (min-width: 781px) and (pointer: coarse)   /* NEW — portrait touch targets */
@media (min-width: 781px)                         /* NEW — hide bottom-nav */
@media (min-width: 1024px) and (orientation: landscape)  /* NEW — 3-zone split */
```
Plus auto-FX-degrade guard inside `matrix-fx.ts` keyed on `window.innerWidth > 1024`. No `min-width:1180px` tier needed — the landscape grid uses proportional clamps, not fixed widths, so it scales 1024→1366+ without an intermediate break.

---

## 7. Implementation approach

### Pure-CSS-responsive (no React changes) — effort **S**
1. Hide `.bottom-nav` at ≥781px.
2. `@media (pointer: coarse)` — 44pt targets (tab-row, composer buttons, mode-toggle, action items).
3. Cap `.terminal-output`/`.terminal-input-row` to 760px centered.
4. Landscape grid: `@media (min-width:1024px) and (orientation:landscape)` reshapes `.app-shell` into `grid-template-columns: 18% 1fr 30%` (with clamps), hides bottom-nav, relaxes composer bottom offset (no dock to clear), widens panel caps.

All additive, no class renames → **ui-regression test stays green.**

### Needs new React components — effort **M–L**
1. **`<Sidebar/>`** — maps over existing `navItems` + sessions list; collapsible; persists state. Reuses `.session-list`/`.session-card` markup. **M.**
2. **`<Inspector/>`** — right column hosting `<TerminalConsole/>` (already built) + Files (existing file-picker retargeted) + Todo (move `todo-box` here) + Diagnostics (move from Help modal). Tabbed. **M.**
3. **`<CommandPalette/>`** — centered overlay, fuzzy over sessions + slash-commands + session-actions + settings; arrow-nav, ↵ select, Esc close. ~150 lines. **M.**
4. **`focusZone` state + `window` keydown handler** — ~40 lines. **S.**
5. **Landscape reinterpretation of `view`/`detailMode`** — `view="sessions"` shows chat empty-state ("select a session"); `view="detail"` shows it in the chat column; settings/help overlay. State machine preserved, only render reinterpretation. **M.**

### Capacitor iPad specifics
- **Orientation:** support both; never pin. React to size class, not `UIDevice.orientation`.
- **Safe areas:** honor `env(safe-area-inset-*)` for iPadOS 26 window controls (traffic-light title-bar controls — content must not sit under them). Composer pinned via `safeAreaInset`-equivalent CSS.
- **Multitasking sizes:** test at 5 widths — Slide Over (~320), Split 1/3 (~438–507), Split 1/2 (~694), portrait full (~1024), landscape full (~1366).
- **Multi-window/scenes:** future enhancement (one window per project).

### Reuse vs new
- **Reuse untouched:** entire theme/FX/token system, all content components (cards, bubbles, composer internals, sheets, diagnostics, terminal), the 4-view state machine, `--chat-bottom-clearance` JS var.
- **New:** `<Sidebar/>`, `<Inspector/>`, `<CommandPalette/>`, `focusZone` state, keydown handler, landscape CSS grid, portrait touch-target CSS.

### Build / test plan
1. Portrait CSS first (S) — `npm run dev` + Playwright 1024×1366, `npm run test:ui` (must stay green), `npm run check`.
2. Landscape CSS grid (S) — Playwright 1366×1024, verify zones + composer anchoring + no horizontal overflow.
3. `<Inspector/>` + move Todo/Diagnostics (M) — verify terminal still fires one-shot shell.
4. `<CommandPalette/>` + keydown layer (M) — verify shortcuts, hold-⌘ overlay (device only).
5. `<Sidebar/>` + landscape `view` reinterpretation (M) — verify selection persists across rotation.
6. `npm run build:ios` + Xcode ⌘R on device — visual QA each view + rotation + Slide Over.

### Effort summary
| Piece | Effort |
|---|---|
| Portrait CSS (touch targets, hide bottom-nav, terminal cap) | **S** |
| Landscape CSS grid | **S** |
| Keydown handler + focusZone | **S** |
| `<Inspector/>` (tabs: Terminal/Files/Todo/Diag) | **M** |
| `<CommandPalette/>` | **M** |
| `<Sidebar/>` + landscape view reinterpretation | **M** |
| Matrix FX auto-degrade | **S** |
| Device QA (5 widths, rotation, Slide Over) | **M** |

---

## 8. OPEN QUESTIONS (each with recommended default)

1. **3-zone vs 2-zone landscape?** 3-zone = sidebar | chat | inspector(terminal as tab). 2-zone = sidebar | chat, terminal as co-equal center tab you switch into.
   **Default: 3-zone.** The terminal is one-shot (not a PTY), so it's a glance-surface, not a live-in surface — inspector tab keeps it visible without stealing center stage. Higher effort, right vibe-coding shape.

2. **⌘K command palette — ship now or defer?** It's the highest-leverage keyboard feature but net-new (~150 lines).
   **Default: ship with the shortcut set.** The shortcuts are only half the payoff without the palette; together they're the "physical keyboard" value proposition. The other shortcuts still work if deferred.

3. **Settings & Help — overlays or full columns in landscape?**
   **Default: overlays (modal sheets).** They're consulted occasionally, not occupied. Overlays keep sidebar/chat/inspector always-visible behind a dimmed sheet. Full columns would force a 4th column or make those views tab-based.

4. **Sidebar persistence — always-on, collapsible, or auto-hide?**
   **Default: collapsible (⌘\ toggle), state persisted.** Default expanded; collapse to a 44px icon rail for max chat width. Satisfies both "always see my sessions" and "give me room."

5. **Matrix FX auto-degrade on large canvas — silent, prompted, or untouched?**
   **Default: auto-set `data-fx-rain="low"` above 1024px wide + one-time toast ("Reduced Matrix FX for performance — adjust in Settings").** Silent auto-degrade would surprise users who set `high`; untouched risks jank/battery drain on a 3.4×-bigger canvas. One-time toast is the middle ground.

6. **Terminal focus model — explicit `focusZone` (⌘2/⌘3) or implicit (last-clicked)?**
   **Default: explicit `focusZone` state.** Two visible inputs need unambiguous ownership; ⌘↵-sends-to-active-zone means a keyboard user never context-switches to send in either place. Implicit (last-clicked) strands keyboard users.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Matrix rain jank/battery on 1366×1024 canvas** (3.4× pixel work, 120Hz) | High | DPR clamp, visibility-gated rAF, auto-degrade to `low` >1024px. Verify on device with ProMotion. |
| **`view` state machine resists 2-pane** (single string, sessions/detail mutually exclusive) | Medium | **Avoided in portrait** (single-column). In landscape, reinterpret `view` without splitting it — sidebar always shows sessions, chat column shows the selected one. Don't refactor `setView` call sites. |
| **`-ObjC` link flag / local plugin registration** (existing iOS gotcha) | Low (already fixed) | No change; FX/terminal don't touch plugins. Re-verify after any pbxproj regen. |
| **Composer fixed-bottom anchoring breaks in 2-pane** (`position:fixed` assumes full-width) | Medium | Scope composer to chat pane (`position:absolute/sticky`) in landscape grid. Test composer height-measure (`syncChatBottomClearance`) against the pane, not viewport. |
| **Selection lost on compact↔regular reflow** (the #1 reported iPad regression across apps) | Medium | Key off size class not orientation; preserve `selectedID`/scroll across the transition. Test Slide Over ↔ full. |
| **iPadOS 26 window controls overlapping content** | Medium | Honor `env(safe-area-inset-top)`; don't pin content to y:0. |
| **ui-regression test breaks on class renames** | Low | All CSS is additive; no class renames. Run `npm run test:ui` after each step. |
| **Terminal one-shot nature frustrates users expecting a REPL** | Low (existing) | Document; the inspector's Files/Todo/Diag tabs compensate by surfacing more state. |
| **Command palette scope creep** (trying to index everything) | Medium | v1 = sessions + slash-commands + session-actions + settings jumps only. Defer file/symbol search. |

---

### Primary sources
- [Apple HIG — Split views](https://developer.apple.com/design/human-interface-guidelines/split-views) · [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) · [Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards)
- [WWDC25 S208 — Elevate the design of your iPad app](https://developer.apple.com/videos/play/wwdc2025/208/) · [S282 — Make your UIKit app more flexible](https://developer.apple.com/videos/play/wwdc2025/282/)
- [WWDC24 S10147 — Elevate your tab and sidebar experience](https://developer.apple.com/videos/play/wwdc2024/10147/) · [WWDC21 S10260 — Focus on iPad Keyboard Navigation](https://developer.apple.com/videos/play/wwdc2021/10260/)
- [Blink Shell docs](https://docs.blink.sh/) · [Termius X](https://termius.com/blog/termius-x) · [Termius Workspaces](https://termius.com/blog/workspaces)
- [ChatGPT iOS FAQ](https://help.openai.com/en/articles/7885016-chatgpt-ios-app-faq) · [Cursor Remote Agents](https://www.buildfastwithai.com/blogs/cursor-remote-agents-any-device-2026)
- [Command Palette — UX Patterns](https://uxpatterns.dev/patterns/advanced/command-palette) · [Solomon](https://solomon.io/designing-command-palettes/)
- [SwiftUI iPad Adaptive Layout — 5 layers](https://medium.com/@wesleymatlock/swiftui-ipad-adaptive-layout-five-layers-for-apps-that-dont-break-in-split-view-8433b726f293) · [Use Your Loaf — Size Classes](https://useyourloaf.com/blog/size-classes/)
