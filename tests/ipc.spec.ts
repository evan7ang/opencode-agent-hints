import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtempSync } from "node:fs"
import { describe, expect, it } from "vitest"

process.env.OPENCODE_AGENT_HINTS_STATE = mkdtempSync(path.join(tmpdir(), "agent-hints-state-"))

import { instanceFilePath, openFocusSender, startIpc } from "../src/ipc.js"
import { tui } from "../src/tui/index.js"

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-hints-ipc-"))
}

async function post(url: string, body: unknown): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  await response.arrayBuffer().catch(() => undefined)
  return response.status
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("loopback focus channel", () => {
  it("publishes a private instance file and delivers authenticated signals", async () => {
    const directory = await tempDir()
    const events: string[] = []
    const ipc = await startIpc({
      directory,
      onFocus: (sessionID) => events.push(`focus:${sessionID}`),
      onBlur: (sessionID) => events.push(`blur:${sessionID}`),
    })
    expect(ipc).toBeDefined()
    const file = instanceFilePath(directory)
    expect(file).toBe(ipc!.file)
    const instance = JSON.parse(await readFile(file, "utf8"))
    expect(instance).toMatchObject({ version: 1, directory: path.resolve(directory), port: ipc!.port, pid: process.pid })
    expect((await stat(file)).mode & 0o777).toBe(0o600)

    expect(await post(ipc!.url, { token: "wrong", type: "focus", sessionID: "ses_1" })).toBe(401)
    expect(await post(ipc!.url, { token: ipc!.token, type: "focus", sessionID: "ses_1" })).toBe(204)
    expect(await post(ipc!.url, { token: ipc!.token, type: "blur", sessionID: "ses_1" })).toBe(204)
    expect(await post(ipc!.url, { token: ipc!.token, type: "ping" })).toBe(204)
    expect(await post(ipc!.url, { token: ipc!.token, type: "nonsense" })).toBe(400)
    expect(events).toEqual(["focus:ses_1", "blur:ses_1"])

    await ipc!.close()
    await expect(stat(file)).rejects.toThrow()
  })

  it("ignores a stale instance file", async () => {
    const directory = await tempDir()
    const file = instanceFilePath(directory)
    await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(file), { recursive: true }))
    await writeFile(
      file,
      JSON.stringify({ version: 1, directory: path.resolve(directory), port: 1, token: "t", pid: 2 ** 22 + 7, startedAt: 0 }),
    )
    expect(await openFocusSender(directory)).toBeUndefined()
  })

  it("reports delivery to a live server from the sender side", async () => {
    const directory = await tempDir()
    const seen: string[] = []
    const ipc = await startIpc({
      directory,
      onFocus: (sessionID) => seen.push(sessionID),
      onBlur: () => undefined,
    })
    const sender = await openFocusSender(directory)
    expect(sender).toBeDefined()
    expect(await sender!.signal("focus", "ses_9")).toBe(true)
    expect(seen).toEqual(["ses_9"])
    await ipc!.close()
    expect(await sender!.signal("focus", "ses_9")).toBe(false)
  })
})

describe("TUI part", () => {
  it("forwards route changes as focus/blur signals", async () => {
    const directory = await tempDir()
    const seen: string[] = []
    const ipc = await startIpc({
      directory,
      onFocus: (sessionID) => seen.push(`focus:${sessionID}`),
      onBlur: (sessionID) => seen.push(`blur:${sessionID}`),
    })
    const route: { current: { name: string; params?: Record<string, unknown> } } = { current: { name: "home" } }
    let disposed: (() => void | Promise<void>) | undefined
    await tui({
      route,
      state: { path: { directory } },
      lifecycle: { onDispose: (fn) => (disposed = fn) },
    })
    expect(seen).toEqual([])
    route.current = { name: "session", params: { sessionID: "ses_1" } }
    await wait(450)
    expect(seen).toEqual(["focus:ses_1"])
    route.current = { name: "home" }
    await wait(450)
    expect(seen).toEqual(["focus:ses_1", "blur:ses_1"])
    await disposed?.()
    await ipc!.close()
  })
})
