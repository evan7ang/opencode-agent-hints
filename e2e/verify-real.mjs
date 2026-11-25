#!/usr/bin/env node
// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Assertions over a real-gateway watcher capture, plus a sanitized evidence
 * file (no headers, no bodies) written under docs/evidence/.
 *
 * Usage: node verify-real.mjs <watcher-capture.jsonl> [evidence-output.jsonl] [plugin-trace.jsonl]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const file = process.argv[2]
if (!file) {
  console.error("usage: verify-real.mjs <capture.jsonl> [evidence.jsonl]")
  process.exit(2)
}
const records = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
const traceFile = process.argv[4]
const trace = traceFile
  ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : []
const problems = []
let checks = 0
const check = (condition, message) => {
  checks += 1
  if (!condition) problems.push(message)
}

const isManage = (record) => record.messageCount === 0
const isChat = (record) => typeof record.path === "string" && record.path.includes("/chat/completions")
const chat = records.filter((record) => isChat(record) && !isManage(record))
const hinted = chat.filter((record) => record.hint !== null)
const manages = records.filter((record) => isChat(record) && isManage(record))
const bodyOf = (record) => JSON.stringify(record.body ?? {})
const isAuxiliary = (record) => bodyOf(record).includes("Generate a title for this conversation:")

check(chat.length > 0, "no chat completion request captured")
check(hinted.length > 0, "no request carried an X-Agent-Hint header")
check(
  hinted.every((record) => record.hintSource === "header x-agent-hint"),
  "some hints did not arrive via the header channel",
)
check(
  records.every((record) => record.status === null || record.status < 400),
  "a request was rejected by the real gateway",
)

const start = hinted.find((record) => record.hint?.session?.state === "start")
check(start !== undefined, "the fresh session never emitted start")
check(
  hinted.filter((record) => record.hint?.session?.state === "start").length === 1,
  "start was emitted more than once",
)
check(hinted[0] === start, "the first hinted request is not the start")

for (const [index, record] of hinted.entries()) {
  const headerSession = record.headers?.["x-session-id"] ?? record.headers?.["x-session-affinity"]
  check(
    headerSession === record.hint?.session?.session_id,
    `#${index + 1}: hint session id does not match the identity header`,
  )
  if (record.hint?.cache_control) {
    check(
      record.hint.cache_control.msg_offset === record.messageCount,
      `#${index + 1}: msg_offset ${record.hint.cache_control.msg_offset} != wire messages ${record.messageCount}`,
    )
    check(
      record.hint.cache_control.ttl_s >= 60 && record.hint.cache_control.ttl_s <= 3600,
      `#${index + 1}: ttl_s out of range`,
    )
  }
  const priority = record.hint?.priority_control?.priority
  if (priority) {
    check(
      (priority.level === 3 && priority.reason === "user_waiting") || (priority.level === 1 && priority.reason === "critical_path"),
      `#${index + 1}: illegal priority pair`,
    )
  }
}

const auxiliary = chat.filter((record) => isAuxiliary(record))
for (const record of auxiliary) {
  check(record.hint === null, "the title request carried a hint")
}

const appends = hinted.filter((record) => record.hint?.session?.state === "append")
if (appends.length > 0) {
  check(
    appends.every((record) => record.hint.session.call_index > (start?.hint?.session?.call_index ?? 0)),
    "call_index did not advance",
  )
}

for (const [index, record] of manages.entries()) {
  check(record.hint?.context_management?.manage_request === true, `manage #${index + 1}: manage marker missing`)
  check(record.stream === false, `manage #${index + 1}: manage request is streaming`)
  check(record.headers?.["x-agent-hint"] !== undefined, `manage #${index + 1}: no hint header`)
}

// The plugin classifies each manage result. A plain OpenAI-compatible gateway
// rejects the empty-messages placeholder (a 4xx), which must stay a plain
// failure and never quarantine the session; a paired Agent-Hint consumer
// accepts it.
const manageTrace = trace.filter((entry) => entry.kind === "manage")
for (const entry of manageTrace) {
  const tolerated = entry.detail === "accepted" || (entry.detail === "failed" && (entry.httpStatus ?? 0) < 500)
  check(tolerated, `manage ${entry.hint?.session?.state} was ${entry.detail} HTTP ${entry.httpStatus}`)
  check(entry.detail !== "unknown", `manage ${entry.hint?.session?.state} had an unknown outcome`)
}

if (problems.length > 0) {
  console.error(`✗ real gateway: ${problems.length}/${checks} checks failed`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const evidence = process.argv[3] ?? path.join("docs", "evidence", `real-gateway-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
mkdirSync(path.dirname(evidence), { recursive: true })
const lines = records.map((record) =>
  JSON.stringify({
    t: record.t,
    path: record.path,
    status: record.status,
    model: record.model,
    messageCount: record.messageCount,
    roles: record.roles,
    hintSource: record.hintSource,
    identityMatch: record.identityMatch,
    hint: record.hint,
  }),
)
writeFileSync(evidence, `${lines.join("\n")}\n`)
const summary = manageTrace.map((entry) => `${entry.hint?.session?.state}:${entry.detail}${
  entry.httpStatus === undefined ? "" : `(${entry.httpStatus})`
}`)
console.log(
  `✓ real gateway: ${checks} checks passed (${chat.length} chat requests, ${hinted.length} hinted, ${manages.length} manage)`,
)
if (summary.length > 0) console.log(`· manage outcomes: ${summary.join(", ")}`)
console.log(`· sanitized evidence: ${evidence}`)
