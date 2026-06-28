// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
const passed = []
const test = (n, f) => passed.push((async()=>{await f();console.log("  ✓ "+n)})().catch(e=>{console.error("  ✗ "+n+"\n"+e);process.exitCode=1}))

const { shouldNotify } = await import("./feedback.ts")

await test("shouldNotify true when app backgrounded and session completes", () => {
  assert.equal(shouldNotify({ appVisible: false, viewingSessionID: "s1", completedSessionID: "s1" }), true)
})

await test("shouldNotify false when actively viewing the completing session", () => {
  assert.equal(shouldNotify({ appVisible: true, viewingSessionID: "s1", completedSessionID: "s1" }), false)
})

await test("shouldNotify true when app visible but a different session completes", () => {
  assert.equal(shouldNotify({ appVisible: true, viewingSessionID: "s1", completedSessionID: "s2" }), true)
})

await Promise.all(passed)
