// SPDX-License-Identifier: MulanPSL-2.0
/**
 * opencode TUI part: observe which session the user is looking at and forward
 * focus/blur signals to the server part over the loopback channel.
 *
 * Detection polls `api.route.current` instead of replacing a UI slot, so a
 * missing or changed host hook degrades to "no focus signal" (the server part
 * then uses its headless triggers) rather than breaking the prompt.
 *
 * @module opencode-agent-hints/tui
 */

import { appendFile } from "node:fs/promises"
import path from "node:path"
import { openFocusSender, stateRoot, type FocusSender } from "../ipc.js"

function debug(directory: string, message: string): void {
  if (process.env.AGENT_HINTS_TUI_DEBUG !== "1") return
  void appendFile(path.join(stateRoot(), "tui-debug.log"), `${new Date().toISOString()} ${directory} ${message}\n`).catch(
    () => undefined,
  )
}

interface RouteCurrent {
  name?: string
  params?: Record<string, unknown>
}

interface TuiApi {
  route?: { current?: RouteCurrent }
  state?: { path?: { directory?: string } }
  lifecycle?: { onDispose?: (fn: () => void | Promise<void>) => unknown }
}

const POLL_MS = 300
const SENDER_RETRY_MS = 2_000

export async function tui(api: TuiApi): Promise<void> {
  const directory = api.state?.path?.directory
  debug(String(directory), `tui start route=${JSON.stringify(api.route?.current ?? null)}`)
  if (directory === undefined) return

  let current: string | undefined
  let sender: FocusSender | undefined
  let senderAt = 0
  let disposed = false
  const queue: Array<{ type: "focus" | "blur"; sessionID: string }> = []

  const readRoute = (): string | undefined => {
    const route = api.route?.current
    if (route?.name !== "session") return undefined
    const sessionID = route.params?.sessionID
    return typeof sessionID === "string" ? sessionID : undefined
  }

  const ensureSender = async (): Promise<FocusSender | undefined> => {
    if (sender !== undefined && Date.now() - senderAt < SENDER_RETRY_MS) return sender
    sender = await openFocusSender(directory).catch(() => undefined)
    senderAt = Date.now()
    debug(directory, `sender ${sender === undefined ? "missing" : "ready"}`)
    return sender
  }

  const flush = async (): Promise<void> => {
    const target = sender ?? (await ensureSender())
    if (target === undefined) return
    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) return
      const delivered = await target.signal(next.type, next.sessionID)
      debug(directory, `signal ${next.type} ${next.sessionID} delivered=${delivered}`)
      if (!delivered) {
        // The server may have restarted; retry the whole queue next tick.
        queue.unshift(next)
        sender = undefined
        return
      }
    }
  }

  const tick = async (): Promise<void> => {
    if (disposed) return
    const next = readRoute()
    if (next !== current) {
      debug(directory, `route change ${String(current)} -> ${String(next)}`)
      const previous = current
      current = next
      if (previous !== undefined) queue.push({ type: "blur", sessionID: previous })
      if (next !== undefined) queue.push({ type: "focus", sessionID: next })
    }
    if (queue.length > 0) await flush()
  }

  void tick()
  const timer = setInterval(() => {
    void tick()
  }, POLL_MS)

  api.lifecycle?.onDispose?.(() => {
    disposed = true
    clearInterval(timer)
    const last = current
    current = undefined
    debug(directory, `dispose blur ${String(last)} sender=${sender === undefined ? "none" : "ready"}`)
    if (last !== undefined) void sender?.signal("blur", last).catch(() => undefined)
  })
}

export default {
  id: "opencode-agent-hints",
  tui,
}
