// SPDX-License-Identifier: Apache-2.0
// Mock of `opencode serve` for local development & tests. NOT for production.
// Derivative work — shapes mirror https://opencode.ai/docs/fr/server/ best-effort,
// not the authoritative OpenAPI spec. Deterministic only (no RNG, no clock drift).
import http from "node:http"

// ---- helpers --------------------------------------------------------------

const T0 = 1_750_000_000_000 // fixed epoch anchor so outputs are deterministic

function json(res, value, status = 200) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(typeof value === "string" ? value : JSON.stringify(value))
}

function noContent(res) {
  res.statusCode = 204
  res.end()
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ""
    req.on("data", (c) => (buf += c))
    req.on("end", () => {
      if (!buf) return resolve({})
      try {
        resolve(JSON.parse(buf))
      } catch {
        resolve({})
      }
    })
  })
}

function session(id, opts = {}) {
  const created = opts.created ?? T0
  return {
    id,
    title: opts.title ?? `Session ${id}`,
    parentID: opts.parentID ?? null,
    directory: opts.directory ?? "/home/dev/project",
    version: opts.version ?? "main",
    time: { created, updated: created + 60_000 },
    summary: opts.summary ?? null,
    share: opts.share ?? null,
    model: opts.model ?? { id: "gpt-5", providerID: "openai" },
    project: opts.project ?? null,
  }
}

function message(id, role, opts = {}) {
  return {
    id,
    role, // "user" | "assistant"
    sessionID: opts.sessionID ?? "sess-1",
    time: { created: opts.created ?? T0, completed: opts.completed ?? T0 + 1000 },
    model: opts.model ?? { id: "gpt-5", providerID: "openai" },
    capabilities: opts.capabilities ?? [],
    cost: opts.cost ?? 0,
    tokens: opts.tokens ?? { input: 0, output: 0, reasoning: 0 },
    // `info` envelope for /message/* routes wraps this; see partEnvelope().
  }
}

// `{ info: Message, parts: Part[] }` — the shape returned by /message endpoints.
function partEnvelope(msg, parts) {
  return { info: msg, parts }
}

// Deterministic part builders (permissive — match types.ts MessagePart shape).
function textPart(id, text) {
  return { id, type: "text", text }
}
function toolPart(id, tool, status) {
  return {
    id,
    type: "tool",
    tool,
    state: {
      status,
      title: `${tool}()`,
      input: {},
      output: status === "completed" ? { ok: true } : undefined,
      error: status === "error" ? "mock error" : undefined,
      time: { start: T0, end: status === "running" ? undefined : T0 + 500 },
    },
  }
}

// ---- server ---------------------------------------------------------------

export function createMockServer({ port = 4096, tickMs = 1000 } = {}) {
  // Seed data — deterministic. `directory` query params are accepted but ignored
  // (the real server scopes responses to a project dir; for mock dev we no-op it).
  const sessions = [session("sess-1", { title: "Mock session" })]
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const statuses = { "sess-1": { type: "idle" } }

  // messages keyed by sessionID -> [{ info, parts }]
  const messages = {
    "sess-1": [
      partEnvelope(message("msg-1", "user"), [textPart("p-1", "Hello, opencode!")]),
      partEnvelope(
        message("msg-2", "assistant"),
        [
          textPart("p-2", "Hi! This is a deterministic mock reply."),
          toolPart("p-3", "read", "completed"),
          textPart("p-4", "I read the file (mock)."),
        ]
      ),
    ],
  }

  // pending permission requests per sessionID -> { id, action, resources, sessionID }
  const permissions = {}

  // pending Question requests keyed by requestID -> Request. Seeded with one
  // request that exercises single-select, multi-select, and custom answers so
  // browser dev + Playwright can walk the whole wizard.
  const questions = {
    que_seed1: {
      id: "que_seed1",
      sessionID: "sess-1",
      questions: [
        {
          question: "Which approach should I take for the refactor?",
          header: "Approach",
          options: [
            { label: "Incremental", description: "Small commits, verify each step" },
            { label: "Big bang", description: "One large change, verify at the end" },
          ],
          multiple: false,
          custom: true,
        },
        {
          question: "Which checks should I run before each commit?",
          header: "Checks",
          options: [
            { label: "Lint", description: "eslint / formatting" },
            { label: "Tests", description: "the node test suite" },
            { label: "Types", description: "tsc typecheck" },
          ],
          multiple: true,
          custom: false,
        },
        {
          question: "Which branch should I target?",
          header: "Branch",
          options: [
            { label: "main", description: "the default branch" },
            { label: "develop", description: "the integration branch" },
          ],
          multiple: false,
          custom: true,
        },
      ],
    },
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    const p = url.pathname
    const m = req.method

    // Permissive CORS so the Vite-served web build (browser dev) can hit the
    // mock directly via fetch. Native (CapacitorHttp) bypasses CORS; this is
    // purely a dev convenience for `npm run dev` + Playwright verification.
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*")
    if (m === "OPTIONS") {
      res.statusCode = 204
      res.end()
      return
    }

    // --- Global -----------------------------------------------------------
    if (m === "GET" && p === "/global/health") {
      return json(res, { healthy: true, version: "0.0.0-mock" })
    }

    // --- Session list / status -------------------------------------------
    if (m === "GET" && p === "/session") {
      return json(res, [...byId.values()])
    }
    if ((m === "POST" || m === "PUT") && p === "/session") {
      const body = await readBody(req)
      const id = `sess-${byId.size + 1}`
      const s = session(id, { title: body.title ?? "Untitled", parentID: body.parentID ?? null })
      byId.set(id, s)
      statuses[id] = { type: "idle" }
      messages[id] = []
      return json(res, s)
    }
    if (m === "GET" && p === "/session/status") {
      return json(res, statuses)
    }
    if (m === "GET" && p === "/experimental/session") {
      return json(res, [...byId.values()])
    }

    // --- Question system (root-scoped, like /permission) -----------------
    // GET /question — list pending question requests across all sessions
    if (m === "GET" && p === "/question") {
      return json(res, Object.values(questions))
    }
    {
      // POST /question/:requestID/reply — { answers: string[][] } -> boolean
      const qReply = p.match(/^\/question\/([^/]+)\/reply$/)
      if (m === "POST" && qReply) {
        await readBody(req) // { answers } — accepted, not validated by the mock
        delete questions[decodeURIComponent(qReply[1])]
        return json(res, true)
      }
      // POST /question/:requestID/reject -> boolean
      const qReject = p.match(/^\/question\/([^/]+)\/reject$/)
      if (m === "POST" && qReject) {
        delete questions[decodeURIComponent(qReject[1])]
        return json(res, true)
      }
    }

    // --- Session-scoped (/session/:id...) --------------------------------
    // Accept an optional trailing slash on the id segment (some clients add it).
    const sess = p.match(/^\/session\/([^/]+)(?:\/(.*))?$/)
    if (sess) {
      const id = decodeURIComponent(sess[1])
      const rest = sess[2] ?? ""

      // GET /session/:id — Session
      if (m === "GET" && rest === "") {
        if (!byId.has(id)) return json(res, { error: "session not found" }, 404)
        return json(res, byId.get(id))
      }
      // DELETE /session/:id — boolean
      if (m === "DELETE" && rest === "") {
        byId.delete(id)
        delete statuses[id]
        delete messages[id]
        return json(res, true)
      }
      // PATCH /session/:id — { title? } -> Session
      if (m === "PATCH" && rest === "") {
        if (!byId.has(id)) return json(res, { error: "session not found" }, 404)
        const body = await readBody(req)
        const s = byId.get(id)
        if (typeof body.title === "string") s.title = body.title
        s.time.updated = T0 + 120_000
        return json(res, s)
      }
      // GET /session/:id/children — Session[]
      if (m === "GET" && rest === "children") {
        const children = [...byId.values()].filter((s) => s.parentID === id)
        return json(res, children)
      }
      // GET /session/:id/todo — Todo[]
      if (m === "GET" && rest === "todo") {
        return json(res, [
          { id: "todo-1", content: "Mock todo item", status: "pending", priority: "normal", activeForm: "Working on mock todo" },
        ])
      }
      // GET /session/:id/diff — FileDiff[]
      if (m === "GET" && rest === "diff") {
        return json(res, [
          { path: "src/index.ts", status: "modified", additions: 3, deletions: 1, content: "-old\n+new", sections: [] },
        ])
      }

      // GET /session/:id/message — { info, parts }[]
      if (m === "GET" && rest === "message") {
        return json(res, messages[id] ?? [])
      }
      // POST /session/:id/message — synchronous prompt -> { info, parts }
      if (m === "POST" && rest === "message") {
        await readBody(req)
        const env = partEnvelope(
          message(`msg-${(messages[id]?.length ?? 0) + 1}`, "assistant"),
          [textPart(`p-${Date.now()}`, "Mock synchronous reply.")]
        )
        return json(res, env)
      }

      // GET /session/:id/message/:messageID — { info, parts }
      const msgMatch = rest.match(/^message\/([^/]+)$/)
      if (m === "GET" && msgMatch) {
        const messageID = decodeURIComponent(msgMatch[1])
        const found = (messages[id] ?? []).find((en) => en.info.id === messageID)
        if (!found) return json(res, { error: "message not found" }, 404)
        return json(res, found)
      }

      // POST /session/:id/prompt_async — 204
      if (m === "POST" && rest === "prompt_async") {
        await readBody(req)
        // Flip to busy to mimic a real run; SSE/test scenario below flips idle.
        statuses[id] = { type: "busy" }
        return noContent(res)
      }
      // POST /session/:id/command — { info, parts }
      if (m === "POST" && rest === "command") {
        await readBody(req)
        return json(res, partEnvelope(
          message(`msg-cmd-${Date.now()}`, "assistant"),
          [textPart(`p-${Date.now()}`, "Mock command output.")]
        ))
      }
      // POST /session/:id/shell — { info, parts }
      if (m === "POST" && rest === "shell") {
        const body = await readBody(req)
        const cmd = typeof body.command === "string" ? body.command : ""
        return json(res, partEnvelope(
          message(`msg-shell-${Date.now()}`, "assistant"),
          [
            toolPart(`p-${Date.now()}-1`, "shell", "completed"),
            textPart(`p-${Date.now()}-2`, `$ ${cmd}\nmock stdout`),
          ]
        ))
      }
      // POST /session/:id/abort — boolean
      if (m === "POST" && rest === "abort") {
        statuses[id] = { type: "idle" }
        return json(res, true)
      }

      // POST /session/:id/fork — { messageID? } -> Session
      if (m === "POST" && rest === "fork") {
        const body = await readBody(req)
        if (!byId.has(id)) return json(res, { error: "session not found" }, 404)
        const forkId = `fork-${byId.size + 1}`
        const parent = byId.get(id)
        const forked = session(forkId, {
          title: `${parent.title} (fork)`,
          parentID: id,
          created: T0 + 200_000,
        })
        byId.set(forkId, forked)
        statuses[forkId] = { type: "idle" }
        messages[forkId] = (messages[id] ?? []).filter((en) =>
          body.messageID ? en.info.id !== body.messageID : true
        )
        return json(res, forked)
      }

      // POST / DELETE /session/:id/share -> Session
      if ((m === "POST" || m === "DELETE") && rest === "share") {
        if (!byId.has(id)) return json(res, { error: "session not found" }, 404)
        const s = byId.get(id)
        if (m === "POST") {
          s.share = { url: `https://opencode.ai/share/${id}`, time: T0 + 300_000 }
        } else {
          s.share = null
        }
        return json(res, s)
      }

      // POST /session/:id/revert — { messageID, partID? } -> boolean
      if (m === "POST" && rest === "revert") {
        await readBody(req)
        return json(res, true)
      }
      // POST /session/:id/unrevert -> boolean
      if (m === "POST" && rest === "unrevert") {
        return json(res, true)
      }

      // POST /session/:id/summarize — { providerID, modelID, auto? } -> boolean
      if (m === "POST" && rest === "summarize") {
        await readBody(req)
        if (byId.has(id)) {
          const s = byId.get(id)
          s.summary = { additions: 5, deletions: 2, files: 2 }
        }
        return json(res, true)
      }

      // POST /session/:id/init — { messageID, providerID, modelID } -> boolean
      if (m === "POST" && rest === "init") {
        await readBody(req)
        return json(res, true)
      }

      // POST /session/:id/permissions/:permissionID — { response, remember? } -> boolean
      const permMatch = rest.match(/^permissions\/([^/]+)$/)
      if (m === "POST" && permMatch) {
        const permissionID = decodeURIComponent(permMatch[1])
        const body = await readBody(req)
        const valid = ["once", "always", "reject"].includes(body.response)
        if (!valid) return json(res, { error: "invalid response" }, 400)
        // Clear the pending permission (if any).
        if (permissions[id]) {
          delete permissions[id][permissionID]
        }
        return json(res, true)
      }
    }

    // --- SSE /event -------------------------------------------------------
    if (m === "GET" && p === "/event") {
      res.setHeader("Content-Type", "text/event-stream")
      res.setHeader("Cache-Control", "no-cache")
      res.setHeader("Connection", "keep-alive")
      const send = (obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`)
      // First event mirrors the store's expected shape: data.type + data.properties.
      send({ type: "session.updated", properties: { sessionID: "sess-1", status: statuses["sess-1"] } })
      const iv = setInterval(
        () => send({ type: "message.part", properties: { sessionID: "sess-1", text: "." } }),
        tickMs
      )
      req.on("close", () => clearInterval(iv))
      return
    }

    // --- Commands / agents -----------------------------------------------
    if (m === "GET" && p === "/command") {
      return json(res, [])
    }
    if (m === "GET" && p === "/agent") {
      return json(res, [{ id: "build", name: "Build", mode: "primary", builtIn: true }])
    }

    // --- Config / providers ----------------------------------------------
    if (m === "GET" && p === "/config") {
      return json(res, {
        model: "gpt-5",
        provider: { id: "openai", name: "OpenAI", models: [] },
        permission: { edit: "ask", bash: "ask", webfetch: "automatic" },
        small_model: "gpt-5-mini",
        theme: "opencode",
        autoupdate: true,
      })
    }
    if (m === "PATCH" && p === "/config") {
      await readBody(req)
      return json(res, {})
    }
    if (m === "GET" && p === "/config/providers") {
      return json(res, { providers: [], default: {} })
    }

    // --- Provider (rich model selector) ----------------------------------
    if (m === "GET" && p === "/provider") {
      const all = [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            { id: "gpt-5", name: "GPT-5", attachment: true, reasoning: true, cost: { input: 1, output: 2 }, limit: { context: 200000, output: 16000 } },
            { id: "gpt-5-mini", name: "GPT-5 Mini", attachment: false, reasoning: false, cost: { input: 0.1, output: 0.4 }, limit: { context: 200000, output: 16000 } },
          ],
          env: ["OPENAI_API_KEY"],
          npm: "@ai-sdk/openai",
          options: {},
          modelsSync: true,
        },
      ]
      return json(res, { all, default: { build: "openai/gpt-5" }, connected: ["openai"] })
    }
    if (m === "GET" && p === "/provider/auth") {
      return json(res, {
        openai: [{ id: "api_key", name: "API Key", type: "api_key" }],
      })
    }

    // --- Auth -------------------------------------------------------------
    if (m === "PUT" && p.startsWith("/auth/")) {
      await readBody(req)
      return json(res, true)
    }

    // --- Path / VCS / Project --------------------------------------------
    if (m === "GET" && p === "/path") {
      return json(res, { home: "/home/dev", state: "/home/dev/.local/state/opencode", config: "/home/dev/.config/opencode", worktree: "/home/dev/project", directory: "/home/dev/project" })
    }
    if (m === "GET" && p === "/vcs") {
      return json(res, { branch: "main", ahead: 0, behind: 0, dirty: true })
    }
    if (m === "GET" && p === "/project") {
      return json(res, [
        {
          directory: { worktree: "/home/dev/project" },
          git: { branch: "main", commit: { sha: "0123456789abcdef", message: "mock commit" } },
          time: { created: T0, updated: T0 + 60_000 },
        },
      ])
    }
    if (m === "GET" && p === "/project/current") {
      return json(res, {
        directory: { worktree: "/home/dev/project" },
        git: { branch: "main", commit: { sha: "0123456789abcdef", message: "mock commit" } },
        time: { created: T0, updated: T0 + 60_000 },
      })
    }

    // --- Files ------------------------------------------------------------
    if (m === "GET" && p === "/file") {
      // list files/dirs under ?path=
      return json(res, [
        { name: "README.md", path: "README.md", isDir: false, size: 1024 },
        { name: "src", path: "src", isDir: true, size: 0 },
      ])
    }
    if (m === "GET" && p === "/file/content") {
      // FileContent: { type: "text"|"binary", content?, data?, patch?, ... }
      return json(res, { type: "text", content: "// mock file content\nconsole.log('hello')\n", size: 44 })
    }
    if (m === "GET" && p === "/file/status") {
      return json(res, [{ path: "src/index.ts", state: "modified", staged: false }])
    }

    // --- Find -------------------------------------------------------------
    if (m === "GET" && p === "/find") {
      // FindMatch[]: { path, lines, line_number, absolute_offset, submatches }
      return json(res, [
        {
          path: "src/index.ts",
          lines: { text: "console.log('hello')" },
          line_number: 2,
          absolute_offset: 22,
          submatches: [{ match: "hello", start: 13, end: 18 }],
        },
      ])
    }
    if (m === "GET" && p === "/find/file") {
      // string[] (paths)
      return json(res, ["src/index.ts", "README.md", "package.json"])
    }
    if (m === "GET" && p === "/find/symbol") {
      // Symbol[] (LSP)
      return json(res, [
        { name: "main", kind: "function", path: "src/index.ts", line: 1, character: 0, containerName: "module" },
        { name: "Config", kind: "class", path: "src/config.ts", line: 5, character: 0, containerName: "module" },
      ])
    }

    // --- LSP / Formatter / MCP -------------------------------------------
    if (m === "GET" && p === "/lsp") {
      // LSPStatus[]
      return json(res, [
        { name: "typescript-language-server", version: "4.3.0", state: "running" },
      ])
    }
    if (m === "GET" && p === "/formatter") {
      // FormatterStatus[]
      return json(res, [
        { name: "prettier", version: "3.3.0", state: "running" },
      ])
    }
    if (m === "GET" && p === "/mcp") {
      // { [name: string]: MCPStatus }
      return json(res, {})
    }
    if (m === "POST" && p === "/mcp") {
      await readBody(req)
      return json(res, { state: "running", name: "mock-mcp" })
    }

    // --- Instance dispose -------------------------------------------------
    if (m === "POST" && p === "/instance/dispose") {
      return json(res, true)
    }

    // --- Log --------------------------------------------------------------
    if (m === "POST" && p === "/log") {
      await readBody(req)
      return json(res, true)
    }

    res.statusCode = 404
    res.end("not found")
  })

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve(server))
    server.on("error", reject)
  })
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 4096)
  createMockServer({ port }).then((s) =>
    console.log(`mock opencode serve on http://127.0.0.1:${s.address().port}`)
  )
}
