// SPDX-License-Identifier: Apache-2.0
export interface NotifyContext {
  appVisible: boolean
  viewingSessionID: string | null
  completedSessionID: string
}

// Anti-noise rule: do not notify if the user is actively viewing the completing session.
export function shouldNotify(ctx: NotifyContext): boolean {
  if (ctx.appVisible && ctx.viewingSessionID === ctx.completedSessionID) return false
  return true
}
