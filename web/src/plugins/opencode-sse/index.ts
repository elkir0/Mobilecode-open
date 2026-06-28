// SPDX-License-Identifier: Apache-2.0
import { registerPlugin } from "@capacitor/core"
import type { OpenCodeSSEPlugin } from "./definitions.ts"

export const OpenCodeSSE = registerPlugin<OpenCodeSSEPlugin>("OpenCodeSSE")
export * from "./definitions.ts"
