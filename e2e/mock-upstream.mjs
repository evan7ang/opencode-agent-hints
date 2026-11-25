#!/usr/bin/env node
// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Scripted OpenAI-compatible upstream for the Agent Hint e2e harness.
 *
 * Records every request (decoded `X-Agent-Hint`, identity headers, message
 * shape) as one JSONL line and answers with scripted SSE. Nothing here is part
 * of the plugin: it is the wire observer the assertions run against.
 *
 * Usage: node mock-upstream.mjs --capture <file.jsonl> --mode A|B|C [--port 0]
 */
import { createServer } from "node:http"
import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const capture = option("capture", "")
const mode = option("mode", "A")
const requestedPort = Number(option("port", "0"))

const sessions = new Map()
let sequence = 0

const titleMarker = "Generate a title for this conversation:"

function plan(body) {
  const tools = body.tools && typeof body.tools === "object" ? Object.keys(body.tools) : []
  if (tools.length === 0) return { kind: "aux" }
  const messages = Array.isArray(body.messages) ? body.messages : []
  // A step continues from a tool result only when the whole prompt ends with one.
  const hasToolResult = messages.at(-1)?.role === "tool"
  return { kind: "mainline", hasToolResult, messages }
}

function sessionScript(sessionID) {
  let state = sessions.get(sessionID)
  if (!state) {
    state = { overflowSent: false, calls: 0 }
    sessions.set(sessionID, state)
  }
  return state
}

function decide(body, sessionID) {
  const shape = plan(body)
  if (shape.kind === "aux") {
    const text = JSON.stringify(body.messages ?? []).includes(titleMarker) ? "A short title" : "Summary of the work"
    return { kind: "text", text }
  }
  const state = sessionScript(sessionID)
  state.calls += 1
  if (mode === "B") return { kind: "text", text: "ok" }
  if (mode === "A") return shape.hasToolResult ? { kind: "text", text: "done" } : { kind: "tool" }
  if (mode === "C") {
    if (!state.overflowSent && !shape.hasToolResult) return { kind: "tool" }
    if (!state.overflowSent && shape.hasToolResult) {
      state.overflowSent = true
      return { kind: "overflow" }
    }
    return { kind: "text", text: "continued" }
  }
  return { kind: "text", text: "ok" }
}

function chunk(delta, finish = null, usage) {
  const payload = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage }),
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sse(response, decision) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  if (decision.kind === "tool") {
    response.write(
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${Date.now()}_${sequence}`,
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ filePath: "seed.txt" }) },
          },
        ],
      }),
    )
    response.write(chunk({}, "tool_calls", { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 }))
  } else {
    response.write(chunk({ role: "assistant", content: decision.text }))
    response.write(chunk({}, "stop", { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 }))
  }
  response.write("data: [DONE]\n\n")
  response.end()
}

function record(entry) {
  sequence += 1
  if (!capture) return
  appendFileSync(capture, `${JSON.stringify({ sequence, ...entry })}\n`)
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (request.method === "GET" && url.pathname.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }))
    return
  }
  if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    response.writeHead(404).end()
    return
  }
  const raw = await readBody(request)
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {
    body = {}
  }
  const hintHeader =
    request.headers["x-agent-hint"] ?? request.headers["X-Agent-Hint"] ?? undefined
  let hint
  if (typeof hintHeader === "string") {
    try {
      hint = JSON.parse(Buffer.from(hintHeader, "base64url").toString("utf8"))
    } catch {
      hint = { decodeError: hintHeader.slice(0, 40) }
    }
  }
  const hintInBody = JSON.stringify(body).includes("agent_hint") || "agent_hint" in body
  const sessionID = String(request.headers["x-session-id"] ?? request.headers["x-session-id"] ?? "unknown")
  const messages = Array.isArray(body.messages) ? body.messages : []
  record({
    at: Date.now(),
    method: request.method,
    path: url.pathname,
    sessionHeader: sessionID,
    stream: body.stream === true,
    model: body.model,
    hintHeader: typeof hintHeader === "string" ? hintHeader : null,
    hint: hint ?? null,
    hintInBody,
    managePlaceholder: messages.length === 0,
    messageCount: messages.length,
    roles: messages.map((message) => message.role),
    tools: body.tools && typeof body.tools === "object" ? Object.keys(body.tools) : [],
    lastUserText: (() => {
      const last = messages.filter((message) => message.role === "user").at(-1)
      if (!last) return undefined
      const content = last.content
      if (typeof content === "string") return content.slice(0, 120)
      if (Array.isArray(content)) {
        const text = content.find((part) => part && part.type === "text")
        return typeof text?.text === "string" ? text.text.slice(0, 120) : undefined
      }
      return undefined
    })(),
  })

  if (messages.length === 0) {
    // Manage request: the hint says it must not be executed as inference.
    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
    return
  }

  const decision = decide(body, sessionID)
  if (decision.kind === "overflow") {
    response.writeHead(400, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 8192 tokens. However, your request has 999999 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
    )
    return
  }
  sse(response, decision)
})

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address()
  process.stdout.write(`PORT=${address.port}\n`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
