// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Loopback channel between the TUI part and the server part.
 *
 * opencode's V1 plugin API has no TUI → server plugin channel, so the server
 * part listens on a random loopback port and publishes `{port, token, pid}` in a
 * per-directory instance file (0600). The TUI part reads that file and posts
 * focus signals. The token stops other local processes from injecting events.
 *
 * @module opencode-agent-hints/ipc
 */

import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export interface InstanceFile {
  version: 1
  directory: string
  port: number
  token: string
  pid: number
  startedAt: number
}

/**
 * Fixed per-user location. Deliberately ignores `XDG_STATE_HOME`: the TUI and
 * its server child do not always share the same environment, and both halves
 * must agree on where the instance file lives.
 */
export function stateRoot(): string {
  const override = process.env.OPENCODE_AGENT_HINTS_STATE
  if (override !== undefined && override.length > 0) return override
  return path.join(homedir(), ".local", "state", "opencode-agent-hints")
}

export function instanceFilePath(directory: string): string {
  const hash = createHash("sha1").update(path.resolve(directory)).digest("hex").slice(0, 16)
  return path.join(stateRoot(), "instances", `${hash}.json`)
}

export interface IpcOptions {
  directory: string
  onFocus(sessionID: string): void
  onBlur(sessionID: string): void
  warn?: (message: string, error?: unknown) => void
}

export interface IpcHandle {
  port: number
  token: string
  file: string
  url: string
  close(): Promise<void>
}

const MAX_BODY = 4 * 1024

export async function startIpc(options: IpcOptions): Promise<IpcHandle | undefined> {
  const token = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 32)
  const server = createServer((request, response) => {
    void handle(request, response, token, options)
  })
  const port = await listen(server)
  if (port === undefined) {
    options.warn?.("agent-hints: focus channel unavailable; falling back to headless pause triggers")
    return undefined
  }
  const file = instanceFilePath(options.directory)
  const payload: InstanceFile = {
    version: 1,
    directory: path.resolve(options.directory),
    port,
    token,
    pid: process.pid,
    startedAt: Date.now(),
  }
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    await chmod(file, 0o600).catch(() => undefined)
  } catch (error) {
    options.warn?.("agent-hints: cannot publish the focus channel instance file", error)
    await close(server)
    return undefined
  }
  return {
    port,
    token,
    file,
    url: `http://127.0.0.1:${port}/signal`,
    async close() {
      await close(server)
      try {
        const current = JSON.parse(await readFile(file, "utf8")) as InstanceFile
        if (current.token === token) await unlink(file)
      } catch {
        // Missing or replaced by another instance: nothing to clean up.
      }
    },
  }
}

async function handle(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  token: string,
  options: IpcOptions,
): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== "/signal") {
      response.writeHead(404).end()
      return
    }
    const body = await readBody(request)
    if (body === undefined) {
      response.writeHead(413).end()
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      response.writeHead(400).end()
      return
    }
    const signal = parsed as { token?: unknown; type?: unknown; sessionID?: unknown }
    if (signal.token !== token) {
      response.writeHead(401).end()
      return
    }
    const sessionID = typeof signal.sessionID === "string" ? signal.sessionID : undefined
    if (signal.type === "focus" && sessionID !== undefined) {
      options.onFocus(sessionID)
    } else if (signal.type === "blur" && sessionID !== undefined) {
      options.onBlur(sessionID)
    } else if (signal.type !== "ping") {
      response.writeHead(400).end()
      return
    }
    response.writeHead(204).end()
  } catch (error) {
    options.warn?.("agent-hints: focus signal failed", error)
    response.writeHead(500).end()
  }
}

function readBody(request: import("node:http").IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve(undefined)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", () => resolve(undefined))
  })
}

function listen(server: Server): Promise<number | undefined> {
  return new Promise((resolve) => {
    server.once("error", () => resolve(undefined))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address !== null ? address.port : undefined)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

export interface FocusSender {
  signal(type: "focus" | "blur", sessionID: string): Promise<boolean>
}

/** Read the instance file for a directory and build a sender. */
export async function openFocusSender(directory: string): Promise<FocusSender | undefined> {
  const file = instanceFilePath(directory)
  let instance: InstanceFile
  try {
    instance = JSON.parse(await readFile(file, "utf8")) as InstanceFile
  } catch {
    return undefined
  }
  if (instance.version !== 1 || instance.directory !== path.resolve(directory)) return undefined
  if (!isAlive(instance.pid)) return undefined
  const url = `http://127.0.0.1:${instance.port}/signal`
  return {
    async signal(type, sessionID) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: instance.token, type, sessionID }),
          signal: AbortSignal.timeout(1_000),
        })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
