// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Session facts and lifecycle bookkeeping.
 *
 * One store per opencode server instance (one project directory). Facts arrive
 * from hooks and bus events; bus-event handling mutates state synchronously and
 * only then fires manage requests, so a later `chat.headers` always observes a
 * consistent ledger even though the plugin `event` hook itself is not awaited.
 *
 * @module opencode-agent-hints/session-store
 */

import { buildCacheControl, cacheSignature, estimatePrefixTokens } from "./cache.js"
import { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS, matchesProvider, type AgentHintOptions } from "./config.js"
import type { ControlConnection, ControlResult, ManageRequest } from "./control-client.js"
import { buildManageHint, buildOrdinaryHint, type AgentHint, type AgentHintPriority, type ManageState } from "./hint.js"
import {
  countWireMessages,
  hasHistoryBefore,
  isAuxiliaryAgent,
  prefixTexts,
  rebuildFacts,
  type Message,
} from "./messages.js"

/** Deliberate failure surfaced to the user when a mutation outcome is unknown. */
export class ControlBarrierError extends Error {
  constructor() {
    super(
      "agent-hints: this session cannot start another request because a previous pause/stop/compact"
        + " has an unknown outcome. Start a new session or restart opencode to continue.",
    )
    this.name = "AgentHintControlBarrierError"
  }
}

export interface SessionHistorySource {
  /** Full stored history, including messages before the last compaction. */
  messages(sessionID: string): Promise<Message[] | undefined>
}

export interface ProviderRuntime {
  /** Provider/endpoint/credential facts resolved for this request. */
  connection: ControlConnection | undefined
  providerID: string
  modelID: string
}

export interface MainlineRequest extends ProviderRuntime {
  sessionID: string
  userMessageID: string
  agent: string
}

export interface Snapshot {
  wireCount: number
  prefixTokens: number
}

interface CallRecord {
  assistantMessageID: string | undefined
  userMessageID: string
  hint: AgentHint
  outcome: "pending" | "accepted" | "completed" | "failed"
  requestedAt: number
}

interface SessionState {
  id: string
  ready: boolean
  init: Promise<void> | undefined
  /** Session already had messages before its first call in this process. */
  seeded: boolean
  /** Logical main-line calls dispatched so far. */
  calls: number
  epoch: number
  firstOrdinaryAccepted: boolean
  lastUserMessageID: string | undefined
  lastResponseEndAt: number | undefined
  /** Suppress the cache declaration for the next call only. */
  afterRewrite: boolean
  /** The next call continues a rewritten context (replay / synthetic continue). */
  continuation: boolean
  lastCallFailed: boolean
  current: CallRecord | undefined
  signature: string | undefined
  toolNames: string[] | undefined
  snapshot: Snapshot | undefined
  systemTokens: number | undefined
  status: "busy" | "idle" | "retry"
  inFlight: number
  paused: boolean
  pausePending: boolean
  stopSent: boolean
  archived: boolean
  resumedThisProcess: boolean
  resumeInFlight: Promise<void> | undefined
  nextResumeAt: number
  mutations: number
  pendingOp: Promise<void> | undefined
  unsafe: boolean
  lastModelID: string | undefined
  lastProviderID: string | undefined
  connection: ControlConnection | undefined
  assistantByParent: Map<string, string>
  announced: Set<string>
  expectRealInput: boolean
  lastActivityAt: number
  pruneSeen: Set<string>
  lastPruneAt: number
}

export interface TraceRecord {
  at: number
  kind: "ordinary" | "manage"
  sessionID: string
  hint: AgentHint
  wireCount?: number
  detail?: string
  httpStatus?: number
}

export interface ControlSender {
  send(request: ManageRequest, signal?: AbortSignal): Promise<ControlResult>
}

export interface SessionStoreDeps {
  options: AgentHintOptions
  control: ControlSender
  history: SessionHistorySource
  /** Provider id/options from the merged opencode config, for pre-request control. */
  providerConfig: (providerID: string) => { baseURL?: string; apiKey?: string; npm?: string } | undefined
  trace?: (record: TraceRecord) => void
  warn?: (message: string, error?: unknown) => void
  now?: () => number
}

const FOCUS_STALE_MS = 10 * 60 * 1000
const PRUNE_DEBOUNCE_MS = 1_000

export class SessionStore {
  private readonly states = new Map<string, SessionState>()
  private pendingToolNames: string[] = []
  private lastOrdinarySessionID: string | undefined
  private focusedSessionID: string | undefined
  private tuiConnectedAt: number | undefined
  private disposed = false
  private readonly now: () => number
  private readonly lifetime = new AbortController()

  constructor(private readonly deps: SessionStoreDeps) {
    this.now = deps.now ?? Date.now
  }

  // ------------------------------------------------------------------ hooks

  /** Bind the tool-id batch collected for this request and record the snapshot. */
  onMessagesTransform(messages: readonly Message[]): void {
    if (messages.length === 0) return
    const sessionID = messages[0]?.info.sessionID
    if (sessionID === undefined) return
    const toolNames = this.pendingToolNames.length > 0 ? [...this.pendingToolNames] : undefined
    this.pendingToolNames = []
    const state = this.state(sessionID)
    state.snapshot = {
      wireCount: countWireMessages(messages),
      prefixTokens: estimatePrefixTokens(prefixTexts(messages)),
    }
    if (toolNames !== undefined) state.toolNames = toolNames
  }

  /** Record the system-prompt size so the 128-token gate sees the real prefix. */
  onSystemTransform(sessionID: string | undefined, system: readonly string[]): void {
    if (sessionID === undefined || system.length === 0) return
    const state = this.state(sessionID)
    const tokens = estimatePrefixTokens(system)
    // Over-estimation is harmless (the engine drops sub-block declarations);
    // under-estimation would silently lose caching.
    state.systemTokens = Math.max(state.systemTokens ?? 0, tokens)
  }

  /** Called by the `tool.definition` hook once per offered tool per request. */
  onToolDefinition(toolID: string): void {
    if (this.pendingToolNames.length < 256) this.pendingToolNames.push(toolID)
  }

  /** A real user message was submitted (prompt or command). */
  onChatMessage(sessionID: string, messageID: string | undefined): void {
    const state = this.state(sessionID)
    state.continuation = false
    state.expectRealInput = true
    if (messageID !== undefined) this.announce(state, messageID)
  }

  onUserCommand(sessionID: string): void {
    const state = this.state(sessionID)
    state.continuation = false
    state.expectRealInput = true
  }

  private providerConfigs = new Map<string, { baseURL?: string; apiKey?: string; npm?: string }>()

  // -------------------------------------------------------------- main line

  /**
   * Resolve the hint for one main-line request. Retries of the same logical
   * call return the cached hint verbatim. Throws {@link ControlBarrierError}
   * when a mutation outcome is unknown.
   */
  async prepareMainline(request: MainlineRequest): Promise<AgentHint> {
    const state = this.state(request.sessionID)
    const assistantID = state.assistantByParent.get(request.userMessageID)
    if (
      state.current !== undefined
      && state.current.assistantMessageID !== undefined
      && state.current.assistantMessageID === assistantID
    ) {
      // Processor-level retry: same logical call, identical hint.
      return state.current.hint
    }
    await this.ensureReady(state, request.userMessageID)
    await this.barrier(state)
    if (request.connection !== undefined) state.connection = request.connection
    state.lastModelID = request.modelID
    state.lastProviderID = request.providerID
    await this.ensureResume(state, request.modelID, true)
    const hint = this.buildOrdinary(state, request)
    state.current = {
      assistantMessageID: assistantID,
      userMessageID: request.userMessageID,
      hint,
      outcome: "pending",
      requestedAt: this.now(),
    }
    state.inFlight += 1
    state.lastUserMessageID = request.userMessageID
    state.lastActivityAt = this.now()
    state.stopSent = false
    state.archived = false
    state.pausePending = false
    this.deps.trace?.({
      at: this.now(),
      kind: "ordinary",
      sessionID: state.id,
      hint,
      wireCount: state.snapshot?.wireCount,
    })
    return hint
  }

  private buildOrdinary(state: SessionState, request: MainlineRequest): AgentHint {
    const retryAfterRewrite = state.continuation && state.lastCallFailed
    const callIndex = retryAfterRewrite ? Math.max(1, state.calls) : state.calls + 1
    if (!retryAfterRewrite) state.calls = callIndex
    const sameTurn = state.lastUserMessageID === request.userMessageID
    const realInput = state.expectRealInput
      || (state.lastUserMessageID === undefined && !state.seeded)
      || state.announced.has(request.userMessageID)
    const turnOpening = !state.continuation && !sameTurn && realInput
    const afterRewrite = state.afterRewrite
    state.afterRewrite = false
    state.continuation = false
    state.expectRealInput = false
    const priority = this.priorityFor(turnOpening)
    const cacheControl = this.cacheFor(state, request, callIndex, afterRewrite)
    return buildOrdinaryHint({
      sessionId: state.id,
      callIndex,
      epoch: state.epoch,
      state: !state.seeded && !state.firstOrdinaryAccepted ? "start" : "append",
      ...(priority === undefined ? {} : { priority }),
      ...(cacheControl === undefined ? {} : { cacheControl }),
    })
  }

  private priorityFor(turnOpening: boolean): AgentHintPriority | undefined {
    const mode = this.deps.options.priority
    if (mode === "omit") return undefined
    if (mode !== "dynamic") return { level: mode.level, reason: mode.reason }
    return turnOpening
      ? { level: 3, reason: "user_waiting" }
      : { level: 1, reason: "critical_path" }
  }

  private cacheFor(
    state: SessionState,
    request: MainlineRequest,
    callIndex: number,
    afterRewrite: boolean,
  ): AgentHint["cache_control"] {
    const mode = this.deps.options.cacheControl
    if (mode === "omit") return undefined
    const modelKey = `${request.providerID}/${request.modelID}`
    const signature = cacheSignature(modelKey, state.toolNames)
    const stable = state.signature !== undefined ? state.signature === signature : callIndex <= 1
    state.signature = signature
    if (!stable || afterRewrite) return undefined
    const snapshot = state.snapshot
    if (mode !== "dynamic") {
      const offset = mode.msg_offset ?? snapshot?.wireCount
      if (offset === undefined) return undefined
      return { type: "ephemeral", ttl_s: mode.ttl_s, msg_offset: offset }
    }
    if (snapshot === undefined) return undefined
    const intervalMs = state.lastResponseEndAt === undefined ? undefined : this.now() - state.lastResponseEndAt
    const prefixTokens = snapshot.prefixTokens + (state.systemTokens ?? 0)
    return buildCacheControl(snapshot.wireCount, prefixTokens, intervalMs)
  }

  // ------------------------------------------------------- session lifecycle

  private async ensureReady(state: SessionState, userMessageID: string): Promise<void> {
    if (state.ready) return
    state.init ??= this.initialize(state, userMessageID).finally(() => {
      state.ready = true
    })
    await state.init
  }

  private async initialize(state: SessionState, userMessageID: string): Promise<void> {
    let messages: Message[] | undefined
    try {
      messages = await this.deps.history.messages(state.id)
    } catch (error) {
      this.deps.warn?.(`agent-hints: cannot read history for ${state.id}; treating it as seeded`, error)
      state.seeded = true
      return
    }
    if (messages === undefined) {
      state.seeded = true
      return
    }
    const rebuilt = rebuildFacts(messages)
    state.calls = rebuilt.completedCalls
    state.epoch = rebuilt.epoch
    state.seeded = hasHistoryBefore(messages, userMessageID)
    state.firstOrdinaryAccepted = rebuilt.completedCalls > 0
    if (rebuilt.lastModelID !== undefined) state.lastModelID = rebuilt.lastModelID
    if (rebuilt.lastProviderID !== undefined) state.lastProviderID = rebuilt.lastProviderID
    const assistant = messages.findLast((message) => message.info.role === "assistant" && message.info.time?.completed !== undefined)
    if (assistant?.info.time?.completed !== undefined) state.lastResponseEndAt = assistant.info.time.completed
  }

  private async barrier(state: SessionState): Promise<void> {
    // Wall clock, not the injectable logical clock: this is a real bounded wait.
    const deadline = Date.now() + this.deps.options.sessionControl.pendingOpAwaitMs
    while (state.pendingOp !== undefined) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        this.deps.warn?.(`agent-hints: control barrier timed out for ${state.id}; outcome remains unknown`)
        if (state.mutations > 0 || state.unsafe) throw new ControlBarrierError()
        break
      }
      await Promise.race([state.pendingOp, delay(remaining)])
    }
    if (state.unsafe) throw new ControlBarrierError()
  }

  private async ensureResume(state: SessionState, modelID: string, awaitAcceptance: boolean): Promise<void> {
    if (state.unsafe) return
    const needed = state.paused || (state.seeded && !state.resumedThisProcess)
    if (!needed) {
      if (awaitAcceptance && state.resumeInFlight !== undefined) await state.resumeInFlight
      return
    }
    if (state.resumeInFlight !== undefined) {
      if (awaitAcceptance) await state.resumeInFlight
      return
    }
    if (this.now() < state.nextResumeAt) return
    const promise = this.track(state, "resume", modelID)
    state.resumeInFlight = promise
    if (awaitAcceptance) await promise
  }

  /** Record that a main-line request was accepted by the endpoint. */
  noteAccepted(state: SessionState): void {
    state.firstOrdinaryAccepted = true
    if (!this.focusAvailable()) {
      const previous = this.lastOrdinarySessionID
      this.lastOrdinarySessionID = state.id
      if (previous !== undefined && previous !== state.id) {
        const previousState = this.states.get(previous)
        if (previousState !== undefined) this.markForPause(previousState)
      }
    } else {
      this.lastOrdinarySessionID = state.id
    }
  }

  // -------------------------------------------------------------- focus (IPC)

  onFocus(sessionID: string): void {
    if (this.disposed) return
    this.tuiConnectedAt = this.now()
    this.focusedSessionID = sessionID
    const state = this.state(sessionID)
    const modelID = state.lastModelID
    if (modelID === undefined) return
    if (state.connection === undefined) {
      const connection = this.connectionFromConfig(state.lastProviderID)
      if (connection === undefined) return
      state.connection = connection
    }
    if (state.paused && !state.resumeInFlight) {
      void this.ensureResume(state, modelID, false)
      return
    }
    // A seeded session's first sight resumes early, before the user submits.
    void this.ensureResume(state, modelID, false)
  }

  onBlur(sessionID: string): void {
    if (this.disposed) return
    this.tuiConnectedAt = this.now()
    if (this.focusedSessionID === sessionID) this.focusedSessionID = undefined
    const state = this.states.get(sessionID)
    if (state !== undefined) this.markForPause(state)
  }

  private focusAvailable(): boolean {
    if (!this.deps.options.focus.enabled) return false
    return this.tuiConnectedAt !== undefined && this.now() - this.tuiConnectedAt < FOCUS_STALE_MS
  }

  private markForPause(state: SessionState): void {
    if (state.paused || state.pausePending || state.stopSent || state.unsafe) return
    if (state.lastModelID === undefined) return
    // The user must not be looking at it.
    if (this.focusedSessionID === state.id) return
    state.pausePending = true
    if (state.status === "idle" && state.inFlight === 0) this.flushPause(state)
  }

  private flushPause(state: SessionState): void {
    if (!state.pausePending) return
    state.pausePending = false
    state.paused = true
    state.resumedThisProcess = false
    const modelID = state.lastModelID
    if (modelID === undefined) return
    if (state.connection === undefined) state.connection = this.connectionFromConfig(state.lastProviderID)
    if (state.connection === undefined) return
    void this.track(state, "pause", modelID)
  }

  // ------------------------------------------------------------------- bus

  /** Synchronous state update; async IO is fired afterwards. */
  onBusEvent(event: { type: string; properties?: Record<string, unknown> }): void {
    try {
      const properties = event.properties ?? {}
      switch (event.type) {
        case "chat.message":
          return
        case "message.updated": {
          const info = properties.info as
            | {
                id?: string
                role?: string
                sessionID?: string
                parentID?: string
                error?: unknown
                finish?: string
                time?: { completed?: number }
              }
            | undefined
          if (info?.role !== "assistant" || info.sessionID === undefined || info.id === undefined) return
          const state = this.states.get(info.sessionID)
          if (state === undefined) return
          if (info.parentID !== undefined) state.assistantByParent.set(info.parentID, info.id)
          if (state.current?.assistantMessageID !== info.id) return
          if (info.error) {
            state.current.outcome = "failed"
            state.lastCallFailed = true
            state.inFlight = Math.max(0, state.inFlight - 1)
            return
          }
          if (info.time?.completed !== undefined) {
            // A normal end carries a finish reason. A completed message without
            // one was cut short (context overflow, abort), so the step that
            // follows a compaction is a retry of the same logical call.
            const normal = info.finish !== undefined && info.finish !== ""
            state.current.outcome = normal ? "completed" : "failed"
            state.lastCallFailed = !normal
            state.firstOrdinaryAccepted = true
            state.lastResponseEndAt = info.time.completed
            state.inFlight = Math.max(0, state.inFlight - 1)
            this.noteAccepted(state)
            if (state.pausePending && state.status === "idle" && state.inFlight === 0) this.flushPause(state)
          }
          return
        }
        case "message.part.updated": {
          const part = properties.part as
            | {
                sessionID?: string
                messageID?: string
                id?: string
                type?: string
                state?: { time?: { compacted?: number } }
              }
            | undefined
          if (part?.sessionID === undefined) return
          const state = this.states.get(part.sessionID)
          if (state === undefined) return
          const call = state.current
          if (call !== undefined && call.assistantMessageID === part.messageID && call.outcome === "pending") {
            call.outcome = "accepted"
            state.firstOrdinaryAccepted = true
            this.noteAccepted(state)
          }
          if (part.type === "tool" && part.state?.time?.compacted !== undefined) {
            this.detectPrune(state, part.messageID, part.id)
          }
          return
        }
        case "session.status": {
          const sessionID = properties.sessionID as string | undefined
          const status = (properties.status as { type?: string } | undefined)?.type
          if (sessionID === undefined) return
          const state = this.states.get(sessionID)
          if (state === undefined) return
          if (status === "busy" || status === "idle" || status === "retry") state.status = status
          if (status === "idle" && state.pausePending) this.flushPause(state)
          return
        }
        case "session.idle": {
          const sessionID = properties.sessionID as string | undefined
          const state = sessionID === undefined ? undefined : this.states.get(sessionID)
          if (state === undefined) return
          state.status = "idle"
          if (state.pausePending) this.flushPause(state)
          return
        }
        case "session.compacted": {
          const sessionID = properties.sessionID as string | undefined
          if (sessionID === undefined) return
          this.onRewrite(this.states.get(sessionID), "compaction")
          return
        }
        case "session.updated": {
          const info = properties.info as { id?: string; time?: { archived?: number } } | undefined
          if (info?.id === undefined) return
          const state = this.states.get(info.id)
          if (state === undefined) return
          const archived = info.time?.archived !== undefined
          if (archived && !state.archived) {
            state.archived = true
            void this.stop(state)
          } else if (!archived) {
            state.archived = false
          }
          return
        }
        case "session.deleted": {
          const info = properties.info as { id?: string } | undefined
          if (info?.id === undefined) return
          const state = this.states.get(info.id)
          if (state !== undefined) void this.stop(state)
          return
        }
        case "server.instance.disposed": {
          void this.dispose()
          return
        }
        default:
          return
      }
    } catch (error) {
      this.deps.warn?.("agent-hints: event handling failed", error)
    }
  }

  private detectPrune(state: SessionState, messageID: string | undefined, partID: string | undefined): void {
    if (messageID === undefined || partID === undefined) return
    const key = `${messageID}:${partID}`
    if (state.pruneSeen.has(key)) return
    state.pruneSeen.add(key)
    if (state.current?.assistantMessageID === messageID) return
    const at = this.now()
    if (at - state.lastPruneAt < PRUNE_DEBOUNCE_MS) return
    state.lastPruneAt = at
    this.onRewrite(state, "prune")
  }

  private onRewrite(state: SessionState | undefined, kind: "compaction" | "prune"): void {
    if (state === undefined || this.disposed) return
    const oldEpoch = state.epoch
    state.epoch = oldEpoch + 1
    state.afterRewrite = true
    // A compaction inserts a replay or synthetic continue message, so the next
    // call is a continuation. A prune runs at turn end, before new user input.
    if (kind === "compaction") state.continuation = true
    const modelID = state.lastModelID
    if (modelID === undefined) return
    if (state.connection === undefined) state.connection = this.connectionFromConfig(state.lastProviderID)
    if (state.connection === undefined) return
    void this.track(state, "compact", modelID, oldEpoch)
  }

  private async stop(state: SessionState): Promise<void> {
    if (state.stopSent || this.disposed) return
    state.stopSent = true
    state.paused = false
    state.pausePending = false
    const modelID = state.lastModelID
    if (modelID === undefined) return
    if (state.connection === undefined) state.connection = this.connectionFromConfig(state.lastProviderID)
    if (state.connection === undefined) return
    state.pendingOp = this.track(state, "stop", modelID)
    await state.pendingOp.catch(() => undefined)
  }

  /** Stop every live session; called on plugin disposal / instance disposal. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    const pending: Promise<void>[] = []
    for (const state of this.states.values()) {
      if (state.stopSent || state.lastModelID === undefined) continue
      state.stopSent = true
      if (state.connection === undefined) state.connection = this.connectionFromConfig(state.lastProviderID)
      if (state.connection === undefined) continue
      pending.push(this.track(state, "stop", state.lastModelID).catch(() => undefined))
    }
    if (pending.length > 0) {
      await Promise.race([Promise.allSettled(pending), delay(1_500)])
    }
    this.disposed = true
    this.lifetime.abort()
  }

  // ---------------------------------------------------------------- control

  private manageCallIndex(verb: ManageState, state: SessionState): number {
    if (verb === "resume") return Math.max(1, state.calls + 1)
    return Math.max(1, state.calls)
  }

  private track(state: SessionState, verb: ManageState, modelID: string, epochOverride?: number): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const mutating = verb !== "resume"
    if (mutating) state.mutations += 1
    const connection = state.connection
    if (connection === undefined) {
      if (mutating) state.mutations = Math.max(0, state.mutations - 1)
      return Promise.resolve()
    }
    const hint = buildManageHint({
      sessionId: state.id,
      callIndex: this.manageCallIndex(verb, state),
      epoch: epochOverride ?? state.epoch,
      state: verb,
    })
    const request = { verb, model: modelID, connection, hint }
    const dependencies = [state.pendingOp].filter((value): value is Promise<void> => value !== undefined)
    const dispatch = (): Promise<ControlResult> =>
      dependencies.length === 0
        ? this.deps.control.send(request, this.lifetime.signal)
        : Promise.allSettled(dependencies).then(() => this.deps.control.send(request, this.lifetime.signal))
    const promise = dispatch()
      .then((result) => {
        this.deps.trace?.({
          at: this.now(),
          kind: "manage",
          sessionID: state.id,
          hint,
          detail: result.status,
          ...("httpStatus" in result && result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        })
        if (mutating && (result.status === "unknown" || (result.status === "cancelled" && result.dispatched))) {
          state.unsafe = true
          this.deps.warn?.(
            `agent-hints: ${verb} for ${state.id} has an unknown outcome; the session is quarantined`,
          )
        }
        if (verb === "resume") {
          state.resumeInFlight = undefined
          if (result.status === "accepted") {
            state.paused = false
            state.resumedThisProcess = true
            state.nextResumeAt = 0
          } else if (result.status === "failed" || (result.status === "cancelled" && !result.dispatched)) {
            state.nextResumeAt = this.now() + 1_000
          }
        }
      })
      .catch((error) => {
        if (mutating) state.unsafe = true
        this.deps.warn?.(`agent-hints: control ${verb} failed`, error)
      })
      .finally(() => {
        if (mutating) state.mutations = Math.max(0, state.mutations - 1)
      })
    state.pendingOp = promise
    void promise.then(() => {
      if (state.pendingOp === promise) state.pendingOp = undefined
    })
    return promise
  }

  private connectionFromConfig(providerID: string | undefined): ControlConnection | undefined {
    if (providerID === undefined) return undefined
    const configured = this.providerConfigs.get(providerID) ?? this.deps.providerConfig(providerID)
    if (configured?.baseURL === undefined) return undefined
    const endpoint = this.deps.options.sessionControl.endpoint
      ?? `${configured.baseURL.replace(/\/+$/, "")}/chat/completions`
    let apiKey = configured.apiKey
    if (apiKey !== undefined) apiKey = resolveEnvTemplate(apiKey)
    const sameOrigin = sameOriginAs(endpoint, configured.baseURL)
    const authHeader = configured.npm === "@ai-sdk/anthropic" ? "x-api-key" : "authorization"
    return {
      endpoint,
      ...(apiKey === undefined || !sameOrigin ? {} : { apiKey }),
      authHeader,
    }
  }

  /** Resolve the manage connection for a live request. */
  resolveConnection(provider: {
    id?: string
    key?: string
    options?: Record<string, unknown>
    info?: { id?: string; key?: string; options?: Record<string, unknown> }
  }, npm: string | undefined): ControlConnection | undefined {
    const info = provider.info ?? provider
    const options = info.options ?? provider.options ?? {}
    const baseURL = typeof options.baseURL === "string" ? options.baseURL : undefined
    if (baseURL === undefined) return undefined
    const endpoint = this.deps.options.sessionControl.endpoint ?? `${baseURL.replace(/\/+$/, "")}/chat/completions`
    const rawKey = typeof options.apiKey === "string" ? options.apiKey : info.key
    const apiKey = rawKey === undefined ? undefined : resolveEnvTemplate(rawKey)
    const sameOrigin = sameOriginAs(endpoint, baseURL)
    const authHeader = npm === "@ai-sdk/anthropic" ? "x-api-key" : "authorization"
    return {
      endpoint,
      ...(apiKey === undefined || !sameOrigin ? {} : { apiKey }),
      authHeader,
    }
  }

  noteProviderConfig(providerID: string, options: { baseURL?: string; apiKey?: string; npm?: string }): void {
    this.providerConfigs.set(providerID, options)
  }

  // ----------------------------------------------------------------- helpers

  private announce(state: SessionState, messageID: string): void {
    state.announced.add(messageID)
    if (state.announced.size > 64) {
      const first = state.announced.values().next().value
      if (first !== undefined) state.announced.delete(first)
    }
  }

  private state(sessionID: string): SessionState {
    let state = this.states.get(sessionID)
    if (state === undefined) {
      state = {
        id: sessionID,
        ready: false,
        init: undefined,
        seeded: false,
        calls: 0,
        epoch: 0,
        firstOrdinaryAccepted: false,
        lastUserMessageID: undefined,
        lastResponseEndAt: undefined,
        afterRewrite: false,
        continuation: false,
        lastCallFailed: false,
        current: undefined,
        signature: undefined,
        toolNames: undefined,
        snapshot: undefined,
        systemTokens: undefined,
        status: "idle",
        inFlight: 0,
        paused: false,
        pausePending: false,
        stopSent: false,
        archived: false,
        resumedThisProcess: false,
        resumeInFlight: undefined,
        nextResumeAt: 0,
        mutations: 0,
        pendingOp: undefined,
        unsafe: false,
        lastModelID: undefined,
        lastProviderID: undefined,
        connection: undefined,
        assistantByParent: new Map(),
        announced: new Set(),
        expectRealInput: false,
        lastActivityAt: this.now(),
        pruneSeen: new Set(),
        lastPruneAt: 0,
      }
      this.states.set(sessionID, state)
    }
    return state
  }

  /** Snapshot of a session's facts, for tests and diagnostics. */
  inspect(sessionID: string): Record<string, unknown> | undefined {
    const state = this.states.get(sessionID)
    if (state === undefined) return undefined
    return {
      seeded: state.seeded,
      calls: state.calls,
      epoch: state.epoch,
      paused: state.paused,
      unsafe: state.unsafe,
      status: state.status,
      firstOrdinaryAccepted: state.firstOrdinaryAccepted,
      signature: state.signature,
      toolNames: state.toolNames,
    }
  }

  get controlDefaults(): { timeoutMs: number; retries: number } {
    return {
      timeoutMs: this.deps.options.sessionControl.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
      retries: this.deps.options.sessionControl.retries ?? DEFAULT_CONTROL_RETRIES,
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveEnvTemplate(value: string): string {
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  if (match === null) return value
  return process.env[match[1]!] ?? value
}

function sameOriginAs(endpoint: string, baseURL: string): boolean {
  try {
    return new URL(endpoint).origin === new URL(baseURL).origin
  } catch {
    return false
  }
}

export function providerMatches(options: AgentHintOptions, providerID: string): boolean {
  return matchesProvider(options.providers, providerID)
}

export function auxiliaryAgent(agent: string | undefined): boolean {
  return isAuxiliaryAgent(agent)
}
