// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
const passed = []
const test = (n, f) => passed.push((async()=>{await f();console.log("  ✓ "+n)})().catch(e=>{console.error("  ✗ "+n+"\n"+e);process.exitCode=1}))

const { buildSnapshot } = await import("./snapshot.ts")

await test("buildSnapshot maps sessions and counts active (busy/retry)", () => {
  const sessions = [
    { id: "s1", title: "One", directory: "/a", updated: 1, status: "busy", files: 0, additions: 0, deletions: 0 },
    { id: "s2", title: "Two", directory: "/b", updated: 2, status: "idle", files: 3, additions: 5, deletions: 1 },
    { id: "s3", title: "Three", directory: "/c", updated: 3, status: "retry", files: 0, additions: 0, deletions: 0 }
  ]
  const snap = buildSnapshot(sessions)
  assert.equal(snap.activeCount, 2)              // busy + retry
  assert.equal(snap.sessions.length, 3)
  assert.deepEqual(snap.sessions[1], { id: "s2", title: "Two", status: "idle", updated: 2 })
  assert.ok(typeof snap.updatedAt === "number")
})

await test("buildSnapshot handles empty list", () => {
  const snap = buildSnapshot([])
  assert.equal(snap.activeCount, 0)
  assert.equal(snap.sessions.length, 0)
})

await Promise.all(passed)
