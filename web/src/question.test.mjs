// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
//
// Exercises the Question API (list / reply / reject) against the mock server,
// validating the wire contract the QuestionPrompt UI depends on.
import assert from "node:assert/strict"

const { createMockServer } = await import("../../scripts/mock-opencode.mjs")
const { api } = await import("./api.ts")

const server = await createMockServer({ port: 0 })
const config = { host: "127.0.0.1", port: server.address().port, username: "", password: "" }

const pending = await api.listPendingQuestions(config)
assert.ok(Array.isArray(pending) && pending.length >= 1, "GET /question returns pending questions")
assert.equal(pending[0].id, "que_seed1")
assert.equal(pending[0].questions[0].header, "Approach")
assert.equal(pending[0].questions[1].multiple, true, "second question is multi-select")

const ok = await api.replyQuestion(config, "que_seed1", [["Incremental"], ["Lint", "Tests"], ["main"]])
assert.equal(ok, true, "reply returns true")

const after = await api.listPendingQuestions(config)
assert.ok(!after.find((q) => q.id === "que_seed1"), "answered question is cleared")

const rejected = await api.rejectQuestion(config, "que_seed1")
assert.equal(rejected, true, "reject returns true")

server.close()

// --- non-OK response body-read bug regression ---
import http from "node:http"
const errServer = http.createServer((req, res) => {
  res.writeHead(400, { "Content-Type": "text/plain" })
  res.end("boom")
})
await new Promise((r) => errServer.listen(0, "127.0.0.1", r))
const errConfig = { host: "127.0.0.1", port: errServer.address().port, username: "", password: "" }
let threw = null
try { await api.listPendingQuestions(errConfig) } catch (e) { threw = e }
assert.ok(threw, "non-OK response should reject")
assert.ok(threw.message.includes("boom"), "error should surface the server body text")
assert.ok(!threw.message.includes("body stream already read"), "must not double-read the response body")
errServer.close()

console.log("question api tests passed")
