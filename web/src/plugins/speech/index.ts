// SPDX-License-Identifier: Apache-2.0
import { registerPlugin, Capacitor } from "@capacitor/core"
import type { SpeechPlugin, SpeechStartOptions } from "./definitions.ts"

// Web/no-op fallback so `npm run dev` (browser) keeps working. Capacitor's
// registerPlugin returns a proxy on every platform; on the web that proxy's
// methods reject at runtime. We detect the web platform explicitly and swap in
// a graceful no-op that reports speech as unsupported, so the composer mic
// button simply renders disabled instead of throwing.
const noopSpeech: SpeechPlugin = {
  isSupported: async () => ({ value: false }),
  start: async (_options?: SpeechStartOptions) => {
    /* no-op on web */
  },
  stop: async () => {
    /* no-op on web */
  },
  async addListener() {
    return { remove: async () => undefined }
  },
  async removeAllListeners() {
    /* no-op on web */
  },
}

const nativeSpeech = registerPlugin<SpeechPlugin>("Speech")

export const Speech: SpeechPlugin =
  Capacitor.getPlatform() === "web" ? noopSpeech : nativeSpeech

export * from "./definitions.ts"
