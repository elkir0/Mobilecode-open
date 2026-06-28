// SPDX-License-Identifier: Apache-2.0
import type { Plugin } from "@capacitor/core"
import type { Snapshot } from "../../snapshot.ts"

export interface SharedSnapshotPlugin extends Plugin {
  // Capacitor passes the argument object as the native options dict, so the
  // Swift side reads it via call.getObject("data"). Use the { data } wrapper.
  writeSnapshot(opts: { data: Snapshot }): Promise<void>
  readSnapshot(): Promise<Snapshot | null>
}
