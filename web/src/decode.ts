// SPDX-License-Identifier: Apache-2.0
// Derived from giuliastro/opencode-remote-android (Apache-2.0). Decode FX for
// the OpenCode Remote iOS companion app.

/**
 * decode.ts — "decryption" reveal animation for the live streaming message.
 *
 * Contract (see docs/superpowers/specs/2026-06-27-matrix-redesign-design.md):
 *   - decodeText(el, target, opts?) animates `target` resolving left-to-right:
 *       a moving front; behind the front the real character is shown, ahead
 *       of it each character is a random katakana/digit glyph re-rolled every
 *       frame. As the front advances, characters lock into their final value.
 *   - isDecodeEnabled() returns true unless documentElement.dataset.fxDecode
 *       === "off". When disabled, decodeText writes the plain target and the
 *       stop() it returns is a no-op.
 *   - Honors ~24fps via timestamp gating on requestAnimationFrame.
 *   - One element animated at a time per call; each call owns its own rAF.
 *   - Returns { stop } that immediately settles to the full target text and
 *       cancels the pending rAF.
 *   - Writes via innerHTML with HTML-escaping so target text containing
 *       `<`, `&`, etc. is never injected as markup.
 */

/** Katakana + digits used for the "scrambled" portion ahead of the front. */
const SCRAMBLE_GLYPHS =
  "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789".split("");

/** Frame cap: target ~24fps so the animation reads as a gentle flicker. */
const MIN_FRAME_MS = 1000 / 24;

/** Default chars-per-second at which the resolving front advances. */
const DEFAULT_SPEED = 28; // chars/sec — ~ even, readable pace

export interface DecodeHandle {
  /** Settle immediately to full target text and cancel the animation. */
  stop: () => void;
}

/**
 * True unless the user has turned the decode FX off via
 * documentElement.dataset.fxDecode === "off". When false, callers should
 * just render the plain target (decodeText already does this internally).
 */
export function isDecodeEnabled(): boolean {
  if (typeof document === "undefined" || !document.documentElement) return true;
  return document.documentElement.dataset.fxDecode !== "off";
}

/** Escape a string for safe insertion via innerHTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A single random scramble glyph. */
function randGlyph(): string {
  return SCRAMBLE_GLYPHS[(Math.random() * SCRAMBLE_GLYPHS.length) | 0];
}

/**
 * Animate `target` resolving left-to-right on `el`.
 *
 * Behind the advancing front: the real character. Ahead of it: a random
 * scramble glyph re-rolled every frame. The front advances at ~`speed`
 * characters per second (default 28). HTML in `target` is escaped.
 *
 * If isDecodeEnabled() is false, the element is set to the plain target
 * text and a handle with a no-op stop() is returned (no rAF scheduled).
 *
 * The returned stop() cancels the rAF and writes the full target text
 * immediately. Calling it more than once is a no-op.
 *
 * Each call owns its own rAF and front position; calling decodeText on the
 * same element again before stopping will leave the previous animation's
 * state on the element's `__decodeStop` property and the prior handle's
 * stop() becomes inert.
 */
export function decodeText(
  el: HTMLElement,
  target: string,
  opts?: { speed?: number },
): DecodeHandle {
  // Fast / disabled path: render plain text, no animation.
  if (!isDecodeEnabled()) {
    el.textContent = target;
    return { stop: () => {} };
  }

  const speed = opts && typeof opts.speed === "number" && opts.speed > 0
    ? opts.speed
    : DEFAULT_SPEED;

  // If this element already has a live decode, settle it first so we never
  // double-schedule rAFs on the same node.
  const prev = (el as HTMLElement & { __decodeStop?: () => void }).__decodeStop;
  if (typeof prev === "function") prev();

  const codepoints = Array.from(target); // grapheme-ish split (handles surrogate pairs)
  const total = codepoints.length;

  let raf = 0;
  let stopped = false;
  let front = 0; // number of resolved chars (0..total)
  let lastTs = 0;
  let acc = 0; // accumulated fractional chars since last advance

  const write = (): void => {
    const resolved = codepoints.slice(0, Math.floor(front));
    let html = escapeHtml(resolved.join(""));
    if (front < total) {
      // Scrambled tail: one glyph per remaining position (cheap, capped by length).
      let tail = "";
      const remaining = total - Math.floor(front);
      // Cap the scramble width we render so very long messages don't paint
      // thousands of glyphs per frame. The visual is identical for a tail;
      // we just truncate the visible scramble to a window past the front.
      const windowSize = Math.min(remaining, 64);
      for (let i = 0; i < windowSize; i++) tail += randGlyph();
      html += `<span style="opacity:.82">${tail}</span>`;
    }
    el.innerHTML = html;
  };

  const tick = (ts: number): void => {
    if (stopped) return;
    raf = window.requestAnimationFrame(tick);
    if (lastTs === 0) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    if (dt < MIN_FRAME_MS) return; // frame-rate cap

    if (front >= total) {
      // Fully resolved; settle and stop scheduling.
      settle();
      return;
    }
    // Advance the front by `speed * dt`, accumulating fractional progress.
    acc += (speed * dt) / 1000;
    if (acc >= 1) {
      const step = Math.floor(acc);
      acc -= step;
      front = Math.min(total, front + step);
    }
    write();
  };

  const settle = (): void => {
    if (stopped) return;
    stopped = true;
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    el.innerHTML = escapeHtml(target);
  };

  const stop = (): void => {
    settle();
  };

  // Stash stop on the element so a subsequent decodeText call on the same
  // node can settle the prior run (see `prev` above).
  (el as HTMLElement & { __decodeStop?: () => void }).__decodeStop = stop;

  // Render the initial fully-scrambled frame, then kick off the loop.
  write();
  raf = window.requestAnimationFrame(tick);

  return { stop };
}
