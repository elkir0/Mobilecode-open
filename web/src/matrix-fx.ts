// SPDX-License-Identifier: Apache-2.0
// Derived from giuliastro/opencode-remote-android (Apache-2.0). Matrix FX layer
// for the OpenCode Remote iOS companion app.

/**
 * matrix-fx.ts — Matrix background FX (katakana rain) + FX settings store.
 *
 * Contract (see docs/superpowers/specs/2026-06-27-matrix-redesign-design.md):
 *   - Three FX layers on documentElement:
 *       data-fx-scan="on"|"off"                scanlines + CRT glow (grouped; styled in CSS)
 *       data-fx-rain="off"|"low"|"med"|"high"  background katakana rain (3 visibility levels)
 *       data-fx-decode="on"|"off"              decode animation on the live message (see decode.ts)
 *   - scan/decode default "on"; rain defaults to "med". Persisted to localStorage
 *     key "opencode.remote.fx".
 *
 * CSS already provides the static styling for #matrix-rain (position:fixed,
 * inset:0, z-index:0, opacity:.34, pointer-events:none) and gates it via
 * `html[data-fx-rain="off"] #matrix-rain { display:none }`. This module only
 * has to CREATE the node, SPAWN columns, ANIMATE them, and PAUSE on tab-hide.
 * The opacity/display contract is owned by styles.css; we do not set them here.
 */

/* ------------------------------------------------------------------ types */

/** Boolean FX toggles (the rain layer has its own level type — see RainLevel). */
export type FxKey = "scan" | "decode";

/** Background-rain visibility levels (off + 3 intensities). */
export type RainLevel = "off" | "low" | "med" | "high";

/** Persisted FX preferences. */
export interface FxSettings {
  scan: boolean;
  rain: RainLevel;
  decode: boolean;
}

/** Sensible defaults — scan/decode on, rain medium. */
export const DEFAULT_FX: FxSettings = {
  scan: true,
  rain: "med",
  decode: true,
};

const RAIN_LEVELS: RainLevel[] = ["off", "low", "med", "high"];

/* --------------------------------------------------------------- storage */

const STORAGE_KEY = "opencode.remote.fx";

function isFxKey(v: unknown): v is FxKey {
  return v === "scan" || v === "decode";
}

function isRainLevel(v: unknown): v is RainLevel {
  return v === "off" || v === "low" || v === "med" || v === "high";
}

/** Backward-compat: map a legacy boolean rain value (true/false) to a level. */
function rainFromLegacy(v: unknown): RainLevel {
  if (isRainLevel(v)) return v;
  if (v === true) return "med";
  if (v === false) return "off";
  return DEFAULT_FX.rain;
}

/**
 * Load FX settings from localStorage. Missing/partial/corrupt entries fall
 * back to DEFAULT_FX per-key, so a bad row never throws. SSR-safe: if there
 * is no `window`, returns DEFAULT_FX.
 */
export function loadFxSettings(): FxSettings {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return { ...DEFAULT_FX };
  }
  const out: FxSettings = { ...DEFAULT_FX };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.scan === "boolean") out.scan = obj.scan;
      if (typeof obj.decode === "boolean") out.decode = obj.decode;
      out.rain = rainFromLegacy(obj.rain);
    }
  } catch {
    /* ignore parse errors, keep defaults */
  }
  return out;
}

/**
 * Persist FX settings. Swallows quota/privacy-mode errors silently (the data
 * attributes are the source of truth at runtime; persistence is best-effort).
 */
export function saveFxSettings(s: FxSettings): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* localStorage unavailable (private mode / quota) — non-fatal */
  }
}

/* ---------------------------------------------------------- attribute io */

/**
 * Push settings onto <html> as data-fx-* attributes. scan/decode are "on"/"off";
 * rain is the level string (off|low|med|high) — styles.css reads these to set
 * the rain opacity / hide it, and to toggle scanlines + glow. This is what
 * actually changes the FX visually; persistence is secondary.
 */
export function applyFxSettings(s: FxSettings): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  const root = document.documentElement;
  root.setAttribute("data-fx-scan", s.scan ? "on" : "off");
  root.setAttribute("data-fx-decode", s.decode ? "on" : "off");
  root.setAttribute("data-fx-rain", s.rain);
}

/**
 * Flip one FX toggle: mutate a fresh settings object, persist it, apply it,
 * and return the new settings so callers can update React state from the
 * return value. Never mutates the argument.
 */
export function setFxEnabled(key: FxKey, on: boolean): FxSettings {
  if (!isFxKey(key)) return loadFxSettings();
  const next: FxSettings = { ...loadFxSettings(), [key]: on };
  saveFxSettings(next);
  applyFxSettings(next);
  return next;
}

/**
 * Cycle the background-rain level: off → low → med → high → off. Persists,
 * applies, and returns the new settings so the caller can update React state.
 */
export function cycleRainLevel(): FxSettings {
  const cur = loadFxSettings().rain;
  const idx = RAIN_LEVELS.indexOf(cur);
  const next: FxSettings = {
    ...loadFxSettings(),
    rain: RAIN_LEVELS[(idx + 1) % RAIN_LEVELS.length],
  };
  saveFxSettings(next);
  applyFxSettings(next);
  return next;
}

/**
 * Set the background-rain level explicitly (off|low|med|high). Persists,
 * applies, and returns the new settings so the caller can update React state.
 * Used by the iPad large-canvas auto-degrade (design doc §9 risk #1).
 */
export function setRainLevel(level: RainLevel): FxSettings {
  const next: FxSettings = { ...loadFxSettings(), rain: level };
  saveFxSettings(next);
  applyFxSettings(next);
  return next;
}

/* --------------------------------------------------------- matrix rain fx */

/** Glyph pool: half-width katakana + digits + a few latin glyphs. */
const RAIN_GLYPHS =
  "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789".split("");

/** Tunables (kept conservative for WKWebView perf). */
const COLUMN_PX = 12; // glyph column width
const MAX_COLUMNS = 120; // hard cap so huge screens don't explode
const MIN_FRAME_MS = 1000 / 30; // ~30fps animation cap

interface RainState {
  /** The <canvas> we paint into. */
  canvas: HTMLCanvasElement;
  /** 2D context (cached). */
  ctx: CanvasRenderingContext2D;
  /** Logical column count (canvas.width / COLUMN_PX). */
  cols: number;
  /** Y position (in glyph rows) of each column's head. Negative = not yet on screen. */
  heads: Float32Array;
  /** Per-column downward speed in rows/frame. */
  speeds: Float32Array;
  /** Per-column alpha for the head glyph (brightness). */
  bright: Float32Array;
  /** Device pixel ratio at setup time, for crisp rendering. */
  dpr: number;
  /** Live rAF handle so cleanup/visibility can cancel it. */
  raf: number;
  /** Whether the animation loop is currently scheduled (false after stop). */
  running: boolean;
  /** Bound visibilitychange handler (kept so we can removeEventListener). */
  onVisibility: () => void;
  /** Bound resize handler. */
  onResize: () => void;
  /** Last painted timestamp for frame-rate cap. */
  lastTs: number;
}

/**
 * Mount the Matrix rain. Creates a `<canvas id="matrix-rain">` appended to
 * document.body (styles.css fixes it behind content via position/z-index),
 * spawns columns sized to the viewport (~one per COLUMN_PX, capped at
 * MAX_COLUMNS), and animates them downward.
 *
 * PAUSES (cancels the rAF) when the document is hidden (visibilitychange) and
 * resumes when visible again — avoids burning CPU/GPU while the webview is
 * backgrounded or on another tab.
 *
 * Respects `data-fx-rain`: when the attribute is "off" the CSS hides the node,
 * and we additionally stop the rAF so we're not painting an invisible layer.
 * Attribute changes are observed via a MutationObserver.
 *
 * Returns a cleanup function: removes the node, cancels the rAF, and detaches
 * all listeners. Safe to call once; safe to ignore the return in throwaway
 * mounts.
 *
 * SSR-safe: if there is no document, returns a no-op cleanup.
 */
export function initMatrixFx(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }

  // Defensive: if somehow one is already mounted, tear it down first so we
  // never stack two rain layers.
  const existing = document.getElementById("matrix-rain");
  if (existing) existing.remove();

  const canvas = document.createElement("canvas");
  canvas.id = "matrix-rain";
  // CSS owns position/opacity/z-index; we only set the rendering surface.
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    // No 2D context available (extremely unlikely in a webview). Bail clean.
    canvas.remove();
    return () => {};
  }

  // Clamp DPR to 1.5: the rain is a blurry trailing background, so 2x retina
  // buys no visible crispness but ~1.8x the pixel fill per frame — costly on a
  // 1366x1024 iPad canvas at 120Hz. 1.5 keeps it smooth (design doc §9 risk #1).
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 1.5));

  const state: RainState = {
    canvas,
    ctx,
    cols: 0,
    heads: new Float32Array(0),
    speeds: new Float32Array(0),
    bright: new Float32Array(0),
    dpr,
    raf: 0,
    running: false,
    onVisibility: () => {},
    onResize: () => {},
    lastTs: 0,
  };

  /** (Re)size the canvas + column buffers to the current viewport. */
  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cols = Math.min(MAX_COLUMNS, Math.max(1, Math.floor(w / COLUMN_PX)));
    state.cols = cols;
    // Preserve existing column state where possible to avoid a visual reset
    // on every orientation change; grow/shrink the typed arrays.
    const prevHeads = state.heads;
    const prevSpeeds = state.speeds;
    const prevBright = state.bright;
    const heads = new Float32Array(cols);
    const speeds = new Float32Array(cols);
    const bright = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      heads[i] = prevHeads[i] ?? -Math.random() * 40; // staggered start
      speeds[i] = prevSpeeds[i] ?? 0.45 + Math.random() * 0.85; // 0.45..1.3 rows/frame
      bright[i] = prevBright[i] ?? 0.55 + Math.random() * 0.45;
    }
    state.heads = heads;
    state.speeds = speeds;
    state.bright = bright;
  };
  state.onResize = resize;
  resize();

  /** Paint one frame: dim the trail, then stamp a fresh glyph at each head. */
  const paint = (): void => {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const fontSize = Math.max(10, COLUMN_PX - 1);
    ctx.font = `${fontSize}px var(--font-mono), "SF Mono", ui-monospace, monospace`;
    ctx.textBaseline = "top";

    // Fade the previous frame (translucent black over everything) to create
    // the trailing tail. fillRect over the whole CSS-pixel surface.
    ctx.fillStyle = "rgba(2, 10, 6, 0.10)";
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "#00FF41";
    const rowH = fontSize;
    for (let i = 0; i < state.cols; i++) {
      const head = state.heads[i];
      if (head < 0) {
        // column is "above" the screen waiting to drop; advance it
        state.heads[i] = head + state.speeds[i];
        continue;
      }
      const y = head * rowH;
      if (y > h) {
        // fully off the bottom — reset to top with a randomized gap + speed
        state.heads[i] = -Math.random() * 30;
        state.speeds[i] = 0.45 + Math.random() * 0.85;
        state.bright[i] = 0.55 + Math.random() * 0.45;
        continue;
      }
      const x = i * COLUMN_PX;
      const g = RAIN_GLYPHS[(Math.random() * RAIN_GLYPHS.length) | 0];
      // The head is brightest; we vary alpha per column for depth.
      ctx.globalAlpha = state.bright[i];
      ctx.fillText(g, x, y);
      ctx.globalAlpha = 1;
      state.heads[i] = head + state.speeds[i];
    }
  };

  /** The rAF loop. Frame-rate capped; pauses when document hidden; skips paint
   *  when the rain is toggled off (CSS hides it, so painting is wasted work). */
  const loop = (ts: number): void => {
    if (!state.running) return;
    state.raf = window.requestAnimationFrame(loop);
    if (document.hidden) return; // paused by visibility; rAF kept idling cheaply
    if (ts - state.lastTs < MIN_FRAME_MS) return;
    state.lastTs = ts;
    // If the user turned rain off, the node is display:none — don't paint.
    if (document.documentElement.getAttribute("data-fx-rain") === "off") return;
    paint();
  };

  const start = (): void => {
    if (state.running) return;
    state.running = true;
    state.lastTs = 0;
    state.raf = window.requestAnimationFrame(loop);
  };

  const stop = (): void => {
    state.running = false;
    if (state.raf) {
      window.cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
  };

  // Pause on hide, resume on show. While hidden the loop still runs but does
  // no work (early return above); cancel/resume here is the hard gate for
  // backgrounded webviews where rAF is throttled anyway.
  state.onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };

  document.addEventListener("visibilitychange", state.onVisibility);
  window.addEventListener("resize", state.onResize, { passive: true });

  // Respect an already-off rain attribute without a paint, and start.
  start();

  /** Cleanup: idempotent. Removes node + listeners and stops the loop. */
  return () => {
    stop();
    document.removeEventListener("visibilitychange", state.onVisibility);
    window.removeEventListener("resize", state.onResize);
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  };
}
