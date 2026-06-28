// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
const passed = []
const test = (n, f) => passed.push((async()=>{await f();console.log("  ✓ "+n)})().catch(e=>{console.error("  ✗ "+n+"\n"+e);process.exitCode=1}))

const { createSSEEventSource, parseSSEStream } = await import("./sse.ts")

await test("parseSSEStream splits a raw SSE buffer into typed events", () => {
  const raw = "event: session.updated\ndata: {\"sessionID\":\"s1\"}\n\nevent: message.part\ndata: {\"text\":\"hi\"}\n\n"
  const events = parseSSEStream(raw)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, "session.updated")
  assert.deepEqual(events[0].data, { sessionID: "s1" })
  assert.equal(events[1].type, "message.part")
})

await test("createSSEEventSource falls back to in-memory when no native plugin", async () => {
  const es = createSSEEventSource({ isNative: false })
  const states = []
  es.start({ host: "127.0.0.1", port: 4096, username: "u", password: "p" }, ()=>{}, (s)=>states.push(s.state))
  assert.ok(states.includes("connecting"))
  es.stop()
})

await Promise.all(passed)
