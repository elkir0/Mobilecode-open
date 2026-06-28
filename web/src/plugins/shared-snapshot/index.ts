// SPDX-License-Identifier: Apache-2.0
import { registerPlugin } from "@capacitor/core"
import type { SharedSnapshotPlugin } from "./definitions.ts"

export const SharedSnapshot = registerPlugin<SharedSnapshotPlugin>("SharedSnapshot")
export * from "./definitions.ts"
