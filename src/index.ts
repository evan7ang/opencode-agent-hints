// SPDX-License-Identifier: MulanPSL-2.0
/**
 * opencode server part: inject `X-Agent-Hint` on main-line requests and drive
 * the session lifecycle with dedicated manage requests.
 *
 * Every hook is fail-open except the two deliberate failures the protocol
 * requires: a pending/unknown cache mutation blocks the next main-line request
 * with an explicit, non-retryable error.
 *
 * @module opencode-agent-hints
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { matchesProvider, parseOptions } from "./config.js"
import { SessionControlClient } from "./control-client.js"
import { encodeAgentHintHeader } from "./hint.js"
import { startIpc, type IpcHandle } from "./ipc.js"
import { isAuxiliaryAgent, type Message } from "./messages.js"
import { ControlBarrierError, SessionStore } from "./session-store.js"
import { createTrace } from "./trace.js"

interface Logger {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

function createLogger(): Logger {
  const seen = new Map<string, number>()
  const warn = (message: string, error?: unknown): void => {
    const now = Date.now()
    const last = seen.get(message) ?? 0
    if (now - last < 30_000 && last !== 0) return
    seen.set(message, now)
    // eslint-disable-next-line no-console
    console.warn(`[agent-hints] ${message}`, error === undefined ? "" : error)
  }
  return {
    info: (message) => console.info(`[agent-hints] ${message}`),
    warn,
  }
}

async function historySource(input: PluginInput): Promise<{ messages(sessionID: string): Promise<Message[] | undefined> }> {
  return {
    async messages(sessionID) {
      const result = await input.client.session.messages({
        path: { id: sessionID },
        signal: AbortSignal.timeout(3_000),
      } as never)
      const data = (result as { data?: unknown }).data
      if (!Array.isArray(data)) return undefined
      return data as Message[]
    },
  }
}

const plugin: Plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions)
  if (!options.enabled) return {}
  const log = createLogger()
  const providerConfigs = new Map<string, { baseURL?: string; apiKey?: string; npm?: string }>()
  let ipc: IpcHandle | undefined
  const history = await historySource(input)
  const store = new SessionStore({
    options,
    control: new SessionControlClient({
      timeoutMs: options.sessionControl.controlTimeoutMs,
      retries: options.sessionControl.retries,
      warn: log.warn,
    }),
    history,
    providerConfig: (providerID) => providerConfigs.get(providerID),
    trace: createTrace(options.trace),
    warn: log.warn,
  })

  let focusLog = 0
  if (options.focus.enabled) {
    ipc = await startIpc({
      directory: input.directory,
      onFocus: (sessionID) => {
        if (focusLog++ < 50) log.info(`focus signal ${sessionID}`)
        store.onFocus(sessionID)
      },
      onBlur: (sessionID) => {
        if (focusLog++ < 50) log.info(`blur signal ${sessionID}`)
        store.onBlur(sessionID)
      },
      warn: log.warn,
    }).catch((error) => {
      log.warn("agent-hints: focus channel failed to start", error)
      return undefined
    })
  }

  log.info(
    `loaded (providers=${options.providers.length === 0 ? "*" : options.providers.join(",")},`
      + ` sessionControl=${options.sessionControl.enabled ? "on" : "off"}, focus=${ipc === undefined ? "off" : `127.0.0.1:${ipc.port}`})`,
  )

  return {
    config: async (config) => {
      const providers = (config as { provider?: Record<string, { npm?: string; options?: Record<string, unknown> }> })
        .provider
      if (!providers) return
      for (const [id, entry] of Object.entries(providers)) {
        if (!entry) continue
        const raw = entry.options ?? {}
        const baseURL = typeof raw.baseURL === "string" ? raw.baseURL : undefined
        const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : undefined
        providerConfigs.set(id, {
          ...(baseURL === undefined ? {} : { baseURL }),
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(entry.npm === undefined ? {} : { npm: entry.npm }),
        })
      }
    },

    "chat.headers": async (hookInput, output) => {
      try {
        const agent = hookInput.agent
        if (isAuxiliaryAgent(agent)) return
        const sessionID = hookInput.sessionID
        if (typeof sessionID !== "string" || sessionID.length === 0) return
        const model = hookInput.model as { id?: string; providerID?: string; api?: { npm?: string } }
        const providerID = model.providerID
        const modelID = model.id
        if (providerID === undefined || modelID === undefined) return
        if (!matchesProvider(options.providers, providerID)) return
        const connection = options.sessionControl.enabled
          ? store.resolveConnection(hookInput.provider as never, model.api?.npm)
          : undefined
        const message = hookInput.message as { id?: string }
        const hint = await store.prepareMainline({
          sessionID,
          userMessageID: message.id ?? "",
          agent,
          providerID,
          modelID,
          connection,
        })
        output.headers["X-Agent-Hint"] = encodeAgentHintHeader(hint)
      } catch (error) {
        if (error instanceof ControlBarrierError) throw error
        log.warn("agent-hints: failed to prepare the hint; sending without it", error)
      }
    },

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      try {
        store.onMessagesTransform(output.messages as unknown as Message[])
      } catch (error) {
        log.warn("agent-hints: snapshot failed", error)
      }
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      try {
        store.onSystemTransform(hookInput.sessionID, output.system)
      } catch {
        // Prefix estimation is advisory.
      }
    },

    "tool.definition": async (hookInput) => {
      try {
        store.onToolDefinition(hookInput.toolID)
      } catch {
        // Tool bookkeeping is advisory.
      }
    },

    "chat.message": async (hookInput) => {
      try {
        store.onChatMessage(hookInput.sessionID, hookInput.messageID)
      } catch (error) {
        log.warn("agent-hints: chat.message bookkeeping failed", error)
      }
    },

    "command.execute.before": async (hookInput) => {
      try {
        store.onUserCommand(hookInput.sessionID)
      } catch (error) {
        log.warn("agent-hints: command bookkeeping failed", error)
      }
    },

    event: async ({ event }) => {
      store.onBusEvent(event as unknown as { type: string; properties?: Record<string, unknown> })
    },

    dispose: async () => {
      await store.dispose().catch(() => undefined)
      await ipc?.close().catch(() => undefined)
    },
  }
}

export default plugin
