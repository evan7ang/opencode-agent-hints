// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Opt-in, content-free diagnostic trace of emitted hints. Credentials never
 * enter a record: the hint carries no key material and the endpoint is omitted.
 *
 * @module opencode-agent-hints/trace
 */

import { appendFile } from "node:fs/promises"
import type { TraceRecord } from "./session-store.js"

export interface TraceOptions {
  enabled: boolean
  file?: string
}

export function createTrace(options: TraceOptions): ((record: TraceRecord) => void) | undefined {
  if (!options.enabled) return undefined
  const line = (record: TraceRecord): string => JSON.stringify(record)
  if (options.file === undefined) {
    return (record) => console.info(`agent-hint/trace ${line(record)}`)
  }
  const file = options.file
  return (record) => {
    void appendFile(file, `${line(record)}\n`).catch(() => undefined)
  }
}
