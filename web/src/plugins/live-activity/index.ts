// SPDX-License-Identifier: Apache-2.0
import { registerPlugin } from "@capacitor/core"
import type { LiveActivityPlugin } from "./definitions.ts"

export const LiveActivity = registerPlugin<LiveActivityPlugin>("LiveActivity")
export * from "./definitions.ts"
