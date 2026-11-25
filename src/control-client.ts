// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Bounded advisory manage transport. HTTP acceptance is not KV completion.
 *
 * @module opencode-agent-hints/control-client
 */

import { encodeAgentHintHeader, type AgentHint } from "./hint.js"

export type ControlResult =
  | { status: "accepted"; httpStatus: number }
  | { status: "failed"; retryable: boolean; httpStatus?: number }
  | { status: "unknown" }
  | { status: "cancelled"; dispatched: boolean }

export interface ControlConnection {
  endpoint: string
  apiKey?: string | undefined
  authHeader?: "authorization" | "x-api-key" | undefined
}

export interface ManageRequest {
  verb: "pause" | "resume" | "stop" | "compact"
  model: string
  connection: ControlConnection
  hint: AgentHint
}

export interface ControlClientOptions {
  timeoutMs: number
  retries: number
  /** Injected for tests. */
  fetch?: typeof fetch
  warn?: (message: string, error?: unknown) => void
}

export class SessionControlClient {
  constructor(private readonly options: ControlClientOptions) {}

  /**
   * Send one manage request. Only `resume` retries explicit transient HTTP
   * rejections; a 5xx/timeout on a mutating verb means the outcome is unknown.
   */
  async send(request: ManageRequest, signal?: AbortSignal): Promise<ControlResult> {
    const body = JSON.stringify({ model: request.model, messages: [], stream: false })
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) return { status: "cancelled", dispatched: false }
      const result = await this.attempt(request, body, signal)
      if (result.status !== "accepted") {
        this.options.warn?.(
          `agent-hints: session ${request.verb} for ${request.hint.session.session_id}: ${result.status}`
            + ("httpStatus" in result && result.httpStatus !== undefined ? ` HTTP ${result.httpStatus}` : ""),
        )
      }
      const retryable = result.status === "failed" && result.retryable
      if (request.verb !== "resume" || !retryable || attempt >= this.options.retries) return result
      await sleep(200, signal)
    }
  }

  private async attempt(request: ManageRequest, body: string, signal?: AbortSignal): Promise<ControlResult> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-agent-hint": encodeAgentHintHeader(request.hint),
    }
    const { apiKey, authHeader = "authorization" } = request.connection
    if (apiKey !== undefined) {
      headers[authHeader] = authHeader === "authorization" ? `Bearer ${apiKey}` : apiKey
    }
    let httpStatus: number | undefined
    try {
      const response = await (this.options.fetch ?? fetch)(request.connection.endpoint, {
        method: "POST",
        redirect: "error",
        headers,
        body,
        signal: combined,
      })
      httpStatus = response.status
      if (!response.ok) {
        const transient = response.status === 408 || response.status === 429 || response.status >= 500
        await response.body?.cancel().catch(() => undefined)
        if (request.verb !== "resume" && transient) return { status: "unknown" }
        return { status: "failed", retryable: transient, httpStatus: response.status }
      }
      // Drain before returning; an interrupted body leaves the outcome unknown.
      await response.arrayBuffer()
      return { status: "accepted", httpStatus: response.status }
    } catch {
      if (signal?.aborted) return { status: "cancelled", dispatched: true }
      this.options.warn?.(
        `agent-hints: control request failed for ${request.hint.session.session_id}`
          + (httpStatus === undefined ? " before a response" : ` after HTTP ${httpStatus}`),
      )
      return { status: "unknown" }
    }
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    signal?.addEventListener("abort", finish, { once: true })
  })
}
