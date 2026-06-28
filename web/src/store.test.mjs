// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
const passed = []
const test = (n, f) => passed.push((async()=>{await f();console.log("  ✓ "+n)})().catch(e=>{console.error("  ✗ "+n+"\n"+e);process.exitCode=1}))

const { createStore } = await import("./store.ts")
const { createInMemoryEventSource } = await import("./event-source.ts")

await test("store goes connecting -> connected on SSE open and emits listeners", () => {
  const es = createInMemoryEventSource()
  const store = createStore({ eventSourceFactory: () => es })
  const seen = []
  const unsub = store.subscribe(s => seen.push(s.connection))
  store.setConfig({ host: "h", port: 443, username: "u", password: "p" })
  es.setState("connected")
  assert.deepEqual(seen.at(-1), "connected")
  unsub()
  store.stop()
})

await test("store dispatches a refresh when a session.updated event arrives for an unknown session", () => {
  const es = createInMemoryEventSource()
  let refreshed = 0
  const store = createStore({ eventSourceFactory: () => es, onSessionActivity: () => { refreshed++ } })
  store.setConfig({ host: "h", port: 443, username: "u", password: "p" })
  // opencode SSE event shape: { type, properties: { sessionID, status } }
  es.push({ type: "message", data: { type: "session.updated", properties: { sessionID: "sess-1", status: { type: "idle" } } } })
  assert.equal(refreshed, 1)
  store.stop()
})

await test("store forwards question.asked events so the UI can refresh pending questions instantly", () => {
  const es = createInMemoryEventSource()
  let lastType = null
  const store = createStore({ eventSourceFactory: () => es, onSessionActivity: (a) => { lastType = a.type } })
  store.setConfig({ host: "h", port: 443, username: "u", password: "p" })
  // opencode Question event: { type: "question.asked", properties: { id, sessionID, questions } }
  es.push({ type: "message", data: { type: "question.asked", properties: { id: "que_1", sessionID: "sess-1", questions: [] } } })
  assert.equal(lastType, "question.asked")
  store.stop()
})

await test("store marks offline after 3 consecutive error states", () => {
  const es = createInMemoryEventSource()
  const store = createStore({ eventSourceFactory: () => es })
  const seen = []
  store.subscribe(s => seen.push(s.connection))
  store.setConfig({ host: "h", port: 443, username: "u", password: "p" })
  es.setState("error"); es.setState("error"); es.setState("error")
  assert.equal(seen.at(-1), "offline")
  store.stop()
})

await Promise.all(passed)
