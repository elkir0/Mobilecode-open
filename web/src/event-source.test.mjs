// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
const passed = []
const test = (n, f) => passed.push((async()=>{await f();console.log("  ✓ "+n)})().catch(e=>{console.error("  ✗ "+n+"\n"+e);process.exitCode=1}))

const { createInMemoryEventSource } = await import("./event-source.ts")

await test("createInMemoryEventSource forwards pushed events to onEvent", async () => {
  const es = createInMemoryEventSource()
  const events = []
  es.start({}, (e)=>events.push(e), ()=>{})
  es.push({ type: "session.updated", data: { sessionID: "x" } })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, "session.updated")
  es.stop()
})

await test("createInMemoryEventSource reports state transitions via onState", async () => {
  const es = createInMemoryEventSource()
  const states = []
  es.start({}, ()=>{}, (s)=>states.push(s.state))
  es.setState("connected")
  assert.deepEqual(states, ["connecting","connected"])
  es.stop()
})

await Promise.all(passed)
