#!/usr/bin/env node
// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Assertions over the captured wire bytes. Usage:
 *   node verify.mjs A1|A2|B|C <capture.jsonl>
 */
import { readFileSync } from "node:fs"

const [phase, file] = process.argv.slice(2)
if (!phase || !file) {
  console.error("usage: verify.mjs <A1|A2|B|C> <capture.jsonl>")
  process.exit(2)
}

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))

const problems = []
let checks = 0
function check(condition, message) {
  checks += 1
  if (!condition) problems.push(message)
}

const isManage = (record) => record.managePlaceholder === true
const ordinary = lines.filter((record) => !record.marker && !isManage(record) && record.tools.length > 0)
const auxiliary = lines.filter((record) => !record.marker && !isManage(record) && record.tools.length === 0)
const manages = lines.filter((record) => !record.marker && isManage(record))
const state = (record) => record.hint?.session?.state
const hintSession = (record) => record.hint?.session

// Invariants for every phase.
for (const record of lines.filter((entry) => !entry.marker)) {
  check(record.hintInBody === false, `#${record.sequence}: hint leaked into the body`)
  if (record.hint !== null) {
    check(typeof record.hint === "object", `#${record.sequence}: hint is not a JSON object`)
    check(typeof record.hint.session?.session_id === "string", `#${record.sequence}: missing session_id`)
    check(Number.isInteger(record.hint.session?.call_index), `#${record.sequence}: call_index is not an integer`)
    check(Number.isInteger(record.hint.session?.epoch), `#${record.sequence}: epoch is not an integer`)
    if (!isManage(record)) {
      check(record.hint.session?.session_id === record.sessionHeader, `#${record.sequence}: hint session id differs from the identity header`)
    }
  }
  if (record.hint?.cache_control) {
    check(record.hint.cache_control.type === "ephemeral", `#${record.sequence}: cache type is not ephemeral`)
    check(
      record.hint.cache_control.ttl_s >= 60 && record.hint.cache_control.ttl_s <= 3600,
      `#${record.sequence}: ttl_s out of range`,
    )
    check(
      record.hint.cache_control.msg_offset === record.messageCount,
      `#${record.sequence}: msg_offset ${record.hint.cache_control.msg_offset} != wire messages ${record.messageCount}`,
    )
  }
  if (isManage(record)) {
    check(record.messageCount === 0, `#${record.sequence}: manage request body is not empty`)
    check(record.stream === false, `#${record.sequence}: manage request is streaming`)
    check(record.hint?.context_management?.manage_request === true, `#${record.sequence}: manage_request is not true`)
    check(
      Array.isArray(record.hint?.context_management?.edits) && record.hint.context_management.edits.length === 1,
      `#${record.sequence}: manage request needs exactly one edit`,
    )
    check(record.hint?.priority_control === undefined, `#${record.sequence}: manage request carries priority`)
    check(record.hint?.cache_control === undefined, `#${record.sequence}: manage request carries a cache declaration`)
  }
}

// Auxiliary calls (title, compaction summary) never carry a hint.
for (const record of auxiliary) {
  check(record.hint === null, `#${record.sequence}: auxiliary request carries a hint`)
}

function expectFirstOrdinary(records, label) {
  const first = records[0]
  check(first !== undefined, `${label}: no ordinary request captured`)
  return first
}

function expectStartOnce() {
  const starts = ordinary.filter((record) => state(record) === "start")
  check(starts.length === 1, `expected exactly one start, saw ${starts.length}`)
  check(ordinary[0] === starts[0], "the first ordinary request must be the start")
}

if (phase === "A1") {
  const first = expectFirstOrdinary(ordinary, "A1")
  expectStartOnce()
  check(hintSession(first)?.call_index === 1, "A1: the start must be call 1")
  check(hintSession(first)?.epoch === 0, "A1: the start must be epoch 0")
  check(first.hint?.priority_control?.priority?.level === 3, "A1: the start must be priority 3")
  check(first.hint?.priority_control?.priority?.reason === "user_waiting", "A1: the start must be user_waiting")
  check(first.hint?.cache_control !== undefined, "A1: a fresh session's start declares the cache")
  const second = ordinary[1]
  check(second !== undefined, "A1: expected a tool-continuation request")
  check(state(second) === "append", "A1: the continuation must append")
  check(hintSession(second)?.call_index === 2, "A1: the continuation must be call 2")
  check(second.hint?.priority_control?.priority?.level === 1, "A1: the continuation must be priority 1")
  check(second.hint?.priority_control?.priority?.reason === "critical_path", "A1: the continuation must be critical_path")
  check(second.hint?.cache_control !== undefined, "A1: the continuation declares the cache")
  check(
    !manages.some((record) => state(record) === "resume"),
    "A1: a brand-new session must not send resume",
  )
  check(manages.some((record) => state(record) === "stop"), "A1: disposing the server sends stop")
}

if (phase === "A2") {
  const first = expectFirstOrdinary(ordinary, "A2")
  check(state(first) === "append", "A2: an adopted session's first request is append")
  check(hintSession(first)?.call_index === 3, `A2: the adopted call must be 3, saw ${hintSession(first)?.call_index}`)
  check(hintSession(first)?.epoch === 0, "A2: the adopted session keeps epoch 0")
  const resume = manages.find((record) => state(record) === "resume")
  check(resume !== undefined, "A2: an adopted session resumes before its first request")
  check(resume !== undefined && resume.sequence < first.sequence, "A2: resume must precede the request")
  check(resume?.hint?.context_management?.edits[0]?.type === "prefetch", "A2: resume asks for prefetch")
  check(hintSession(resume)?.call_index === 3, "A2: resume names the upcoming call")
  check(first.hint?.cache_control === undefined, "A2: the restart round suppresses the cache declaration")
  const second = ordinary[1]
  check(second !== undefined, "A2: expected a second request in the adopted turn")
  check(second?.hint?.cache_control !== undefined, "A2: the cache declaration returns after the restart round")
  check(manages.some((record) => state(record) === "stop"), "A2: disposing the server sends stop")
}

if (phase === "B") {
  const firstA = expectFirstOrdinary(ordinary, "B")
  const sessionA = firstA?.sessionHeader
  const sessionB = ordinary.find((record) => record.sessionHeader !== sessionA)?.sessionHeader
  check(typeof sessionA === "string" && typeof sessionB === "string", "B: expected two distinct sessions")
  const bAccepted = ordinary.find((record) => record.sessionHeader === sessionB)
  const pause = manages.find((record) => state(record) === "pause")
  check(pause !== undefined, "B: the idle session must be paused")
  check(pause?.hint?.session?.session_id === sessionA, "B: pause targets the idle session")
  check(pause?.hint?.context_management?.edits[0]?.type === "offload", "B: pause asks for offload")
  check(
    pause !== undefined && bAccepted !== undefined && bAccepted.sequence < pause.sequence,
    "B: pause follows the second session's request",
  )
  check(pause?.hint?.session?.call_index === 1, "B: pause names the latest call of the idle session")
  const resume = manages.find((record) => state(record) === "resume" && record.hint?.session?.session_id === sessionA)
  check(resume !== undefined, "B: the paused session resumes before it is used again")
  check(resume?.hint?.context_management?.edits[0]?.type === "prefetch", "B: resume asks for prefetch")
  const reused = ordinary.filter((record) => record.sessionHeader === sessionA).at(-1)
  check(reused !== undefined && resume !== undefined && resume.sequence < reused.sequence, "B: resume precedes the reused request")
  check(state(reused) === "append", "B: the reused request appends")
}

if (phase === "C") {
  const first = expectFirstOrdinary(ordinary, "C")
  expectStartOnce()
  check(first?.hint?.priority_control?.priority?.level === 3, "C: the start is a turn opening")
  const overflowRequest = ordinary.find((record) => record.hint?.session?.call_index === 2)
  check(overflowRequest !== undefined, "C: expected the overflowing call 2")
  const summary = auxiliary.find((record) => record.sequence > (overflowRequest?.sequence ?? 0))
  check(summary !== undefined, "C: the compaction summary request must be captured")
  check(summary?.hint === null, "C: the compaction summary carries no hint")
  const compact = manages.find((record) => state(record) === "compact")
  check(compact !== undefined, "C: a compaction sends compact")
  check(compact?.hint?.session?.epoch === 0, "C: compact carries the old epoch")
  check(compact?.hint?.session?.call_index === 2, "C: compact names the rewritten call")
  check(compact?.hint?.context_management?.edits[0]?.type === "evict", "C: compact asks for evict")
  const retried = ordinary.filter((record) => record.sequence > (compact?.sequence ?? 0))[0]
  check(retried !== undefined, "C: expected the retried request")
  check(hintSession(retried)?.call_index === 2, `C: the retry keeps call_index 2, saw ${hintSession(retried)?.call_index}`)
  check(hintSession(retried)?.epoch === 1, "C: the retry carries epoch 1")
  check(state(retried) === "append", "C: the retry appends")
  check(retried?.hint?.cache_control === undefined, "C: the rewrite round suppresses the cache")
  check(retried?.hint?.priority_control?.priority?.level === 1, "C: the retry is a continuation")
}

if (phase === "D") {
  const first = expectFirstOrdinary(ordinary, "D")
  const session = first?.sessionHeader
  const pause = manages.find((record) => state(record) === "pause")
  check(pause !== undefined, "D: blurring the idle session pauses it")
  check(pause?.hint?.session?.session_id === session, "D: pause targets the focused session")
  check(pause?.hint?.context_management?.edits[0]?.type === "offload", "D: pause asks for offload")
  const resume = manages.find((record) => state(record) === "resume")
  check(resume !== undefined, "D: focusing the paused session resumes it")
  check(resume?.hint?.context_management?.edits[0]?.type === "prefetch", "D: resume asks for prefetch")
  check(resume !== undefined && pause !== undefined && resume.sequence > pause.sequence, "D: resume follows pause")
  check(hintSession(resume)?.call_index === 2, "D: resume names the upcoming call")
  check(!ordinary.some((record) => record.sequence > (pause?.sequence ?? 0)), "D: pause does not trigger new inference")
}

if (problems.length > 0) {
  console.error(`✗ ${phase}: ${problems.length}/${checks} checks failed`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`✓ ${phase}: ${checks} checks passed`)
