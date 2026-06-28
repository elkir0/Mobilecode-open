// SPDX-License-Identifier: Apache-2.0
import type { Plugin, PluginListenerHandle } from "@capacitor/core"

export interface SpeechStartOptions {
  /** BCP-47 locale, e.g. "en-US", "fr-FR". Defaults to the device locale. */
  locale?: string
}

/** Streaming partial transcript while the recognizer is still listening. */
export interface SpeechTranscriptEvent {
  text: string
}

/** Final/segment transcript. `finished` is true when recognition has stopped. */
export interface SpeechResultEvent {
  text: string
  finished: boolean
}

export interface SpeechPlugin extends Plugin {
  /** Whether on-device speech recognition is available on this platform. */
  isSupported(): Promise<{ value: boolean }>
  /** Request authorization + start streaming partial results. */
  start(options?: SpeechStartOptions): Promise<void>
  /** Stop listening and end the recognition request. */
  stop(): Promise<void>
  addListener(eventName: "partial", listener: (e: SpeechTranscriptEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: "result", listener: (e: SpeechResultEvent) => void): Promise<PluginListenerHandle>
}
