// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"

const passed = []
function test(name, fn) { passed.push((async () => { await fn(); console.log("  ✓ " + name) })().catch(e => { console.error("  ✗ " + name + "\n" + e); process.exitCode = 1 })) }

const { createMockServer } = await import("../../scripts/mock-opencode.mjs")

await test("health endpoint returns healthy true and a version", async () => {
  const server = await createMockServer({ port: 0 })
  const base = `http://127.0.0.1:${server.address().port}`
  const res = await fetch(base + "/global/health")
  const json = await res.json()
  assert.equal(json.healthy, true)
  assert.ok(typeof json.version === "string" && json.version.length > 0)
  server.close()
})

await test("session list returns at least one session", async () => {
  const server = await createMockServer({ port: 0 })
  const base = `http://127.0.0.1:${server.address().port}`
  const res = await fetch(base + "/session")
  const json = await res.json()
  assert.ok(Array.isArray(json) && json.length >= 1)
  assert.ok(json[0].id)
  server.close()
})

await test("SSE /event emits a session.updated event", async () => {
  const server = await createMockServer({ port: 0 })
  const base = `http://127.0.0.1:${server.address().port}`
  const http = await import("node:http")
  let sseReq
  const firstEvent = await new Promise((resolve, reject) => {
    sseReq = http.request(base + "/event", { method: "GET" }, res => {
      let buf = ""
      res.on("data", chunk => {
        buf += chunk.toString()
        const m = buf.match(/data: (.+)/)
        if (m) { try { resolve(JSON.parse(m[1])) } catch { /* wait more */ } }
      })
      res.on("error", reject)
      setTimeout(() => reject(new Error("timeout")), 3000)
    })
    sseReq.on("error", reject)
    sseReq.end()
  })
  assert.equal(firstEvent.type, "session.updated")
  sseReq.destroy()
  server.close()
})

await Promise.all(passed)
