#!/usr/bin/env node
// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Live, content-free viewer for the plugin trace JSONL.
 *
 * The plugin writes one TraceRecord per emitted hint when `trace.enabled` is on.
 * This script tails that file, decodes nothing (the record already contains the
 * hint object), and prints a compact summary plus the original header value.
 *
 * Usage:
 *   node scripts/hint-watch.mjs [--file <trace.jsonl>] [--tail <n>|--all]
 *                               [--json] [--once]
 *
 * Defaults: $AGENT_HINTS_TRACE_FILE, else
 * $TMPDIR/opencode-agent-hints-demo/trace.jsonl.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
let file = process.env.AGENT_HINTS_TRACE_FILE
  ?? path.join(process.env.TMPDIR ?? "/tmp", "opencode-agent-hints-demo", "trace.jsonl")
let tail = 20
let raw = false
let once = false

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === "--file") file = args[++index]
  else if (arg === "--tail") tail = Number(args[++index])
  else if (arg === "--all") tail = Infinity
  else if (arg === "--json") raw = true
  else if (arg === "--once") once = true
  else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "usage: node scripts/hint-watch.mjs [--file <trace.jsonl>] [--tail <n>|--all] [--json] [--once]\n",
    )
    process.exit(0)
  } else {
    process.stderr.write(`unknown option: ${arg}\n`)
    process.exit(2)
  }
}
if ((!Number.isFinite(tail) && tail !== Infinity) || tail < 0) {
  process.stderr.write("--tail needs a non-negative number\n")
  process.exit(2)
}
if (typeof file !== "string" || file.length === 0) {
  process.stderr.write("--file needs a path\n")
  process.exit(2)
}

let encodeAgentHintHeader
try {
  ;({ encodeAgentHintHeader } = await import("../dist/hint.js"))
} catch {
  process.stderr.write("dist/hint.js is missing; run `npm run build` first\n")
  process.exit(1)
}

function shortID(value) {
  const id = typeof value === "string" ? value : ""
  if (id.length <= 18) return id
  return `${id.slice(0, 14)}…${id.slice(-4)}`
}

function stamp(at) {
  if (typeof at !== "number") return "--:--:--"
  const date = new Date(at)
  const pad = (value, width = 2) => String(value).padStart(width, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}`
}

function format(record) {
  if (raw) return JSON.stringify(record)
  const hint = record.hint ?? {}
  const session = hint.session ?? {}
  const when = stamp(record.at)
  const lines = [
    `[${when}] ${record.kind ?? "?"} session=${shortID(session.session_id ?? record.sessionID)}`
      + ` call=${session.call_index ?? "?"} epoch=${session.epoch ?? "?"} state=${session.state ?? "?"}`,
  ]
  const priority = hint.priority_control?.priority
  if (priority !== undefined) lines.push(`  priority  level=${priority.level} reason=${priority.reason}`)
  const cache = hint.cache_control
  if (cache !== undefined) {
    const wire = record.wireCount === undefined ? "" : ` wire=${record.wireCount}`
    lines.push(`  cache     type=${cache.type} ttl_s=${cache.ttl_s} msg_offset=${cache.msg_offset}${wire}`)
  } else if (record.wireCount !== undefined) {
    lines.push(`  wire      ${record.wireCount}`)
  }
  const manage = hint.context_management
  if (manage !== undefined) {
    const edits = Array.isArray(manage.edits)
      ? manage.edits.map((edit) => `${edit.type}(${edit.target})`).join(",")
      : "-"
    lines.push(`  manage    request=${manage.manage_request} edits=${edits}`)
  }
  if (record.detail !== undefined) {
    const status = record.httpStatus === undefined ? "" : ` http=${record.httpStatus}`
    lines.push(`  result    ${record.detail}${status}`)
  }
  try {
    lines.push(`  header    ${encodeAgentHintHeader(hint)}`)
  } catch {
    // A malformed record should not hide the rest of the line.
  }
  lines.push(`  json      ${JSON.stringify(hint)}`)
  return lines.join("\n")
}

function emit(line) {
  const text = line.trim()
  if (text.length === 0) return
  try {
    process.stdout.write(`${format(JSON.parse(text))}\n`)
  } catch {
    process.stdout.write(`[unparseable] ${text}\n`)
  }
}

function emitLast(buffer, count) {
  if (count === 0) return
  const text = buffer.toString("utf8")
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  const selected = count === Infinity ? lines : lines.slice(-count)
  for (const line of selected) emit(line)
}

let offset = 0
let pending = ""

function readFromFile() {
  let size
  try {
    size = statSync(file).size
  } catch {
    return false
  }
  if (size < offset) {
    offset = 0
    pending = ""
    process.stdout.write(`[watch] ${file} was truncated; following from the start\n`)
  }
  if (size === offset) return true
  const length = size - offset
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, "r")
  try {
    readSync(fd, buffer, 0, length, offset)
  } finally {
    closeSync(fd)
  }
  offset = size
  pending += buffer.toString("utf8")
  for (;;) {
    const newline = pending.indexOf("\n")
    if (newline === -1) break
    emit(pending.slice(0, newline))
    pending = pending.slice(newline + 1)
  }
  return true
}

let seeded = false
try {
  const buffer = readFileSync(file)
  const lastNewline = buffer.lastIndexOf(0x0a)
  const complete = lastNewline === -1 ? Buffer.alloc(0) : buffer.subarray(0, lastNewline + 1)
  emitLast(complete, tail)
  offset = complete.length
  seeded = true
} catch {
  process.stdout.write(`[watch] waiting for ${file}\n`)
}

if (once) process.exit(0)

if (!seeded) {
  // The file did not exist yet; seed from the first chunk that appears.
  if (readFromFile()) seeded = true
}

let busy = false
setInterval(() => {
  if (busy) return
  busy = true
  try {
    readFromFile()
  } finally {
    busy = false
  }
}, 250)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0))
}
