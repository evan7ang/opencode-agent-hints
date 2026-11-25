import { describe, expect, it } from "vitest"
import { defaultOptions, type AgentHintOptions } from "../src/config.js"
import type { ControlResult, ManageRequest } from "../src/control-client.js"
import type { AgentHint } from "../src/hint.js"
import type { Message, MessagePart } from "../src/messages.js"
import { ControlBarrierError, SessionStore, type ControlSender } from "../src/session-store.js"

const CONNECTION = { endpoint: "http://gw/v1/chat/completions", apiKey: "k", authHeader: "authorization" as const }

interface Harness {
  store: SessionStore
  sent: ManageRequest[]
  queue: ControlResult[]
  options: AgentHintOptions
  at(ms: number): void
  now(): number
}

function harness(overrides?: { options?: Partial<AgentHintOptions>; history?: Message[] }): Harness {
  let now = 1_000_000
  const sent: ManageRequest[] = []
  const queue: ControlResult[] = []
  const control: ControlSender = {
    async send(request) {
      sent.push(request)
      return queue.shift() ?? { status: "accepted", httpStatus: 200 }
    },
  }
  const options: AgentHintOptions = {
    ...defaultOptions(),
    ...overrides?.options,
    sessionControl: {
      ...defaultOptions().sessionControl,
      ...overrides?.options?.sessionControl,
    },
    focus: { ...defaultOptions().focus, ...overrides?.options?.focus },
    trace: { ...defaultOptions().trace, ...overrides?.options?.trace },
  }
  const history = overrides?.history ?? []
  const store = new SessionStore({
    options,
    control,
    history: { async messages() { return history } },
    providerConfig: () => ({ baseURL: "http://gw/v1", apiKey: "k", npm: "@ai-sdk/openai-compatible" }),
    now: () => now,
  })
  return {
    store,
    sent,
    queue,
    options,
    at(ms) { now = ms },
    now: () => now,
  }
}

let clock = 5_000
const PREFIX = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(40)
function userMessage(id: string, parts: MessagePart[] = [{ type: "text", text: PREFIX }], sessionID = "ses_1"): Message {
  return { info: { id, role: "user", sessionID, time: { created: clock++ } }, parts }
}

function assistantMessage(
  id: string,
  parentID: string,
  parts: MessagePart[] = [{ type: "text", text: "ok" }],
  extra: Partial<Message["info"]> = {},
): Message {
  return {
    info: {
      id,
      role: "assistant",
      parentID,
      sessionID: "ses_1",
      time: { created: clock++, completed: clock++ },
      modelID: "deepseek-v4",
      providerID: "gw",
      ...extra,
    },
    parts,
  }
}

interface CallSpec {
  sessionID?: string
  userMessageID?: string
  assistantMessageID?: string
  providerID?: string
  modelID?: string
  tools?: string[]
  snapshot?: Message[]
  /** False for post-compaction replay / synthetic continuation messages. */
  announce?: boolean
}

/** Simulate one main-line dispatch the way opencode drives the hooks. */
async function call(h: Harness, spec: CallSpec = {}): Promise<AgentHint> {
  const sessionID = spec.sessionID ?? "ses_1"
  const userMessageID = spec.userMessageID ?? "u1"
  if (spec.announce !== false) h.store.onChatMessage(sessionID, userMessageID)
  for (const tool of spec.tools ?? ["read"]) h.store.onToolDefinition(tool)
  h.store.onMessagesTransform(spec.snapshot ?? [userMessage(userMessageID, undefined, sessionID)])
  const assistantMessageID = spec.assistantMessageID ?? `a_${userMessageID}`
  h.store.onBusEvent({
    type: "message.updated",
    properties: {
      info: { id: assistantMessageID, role: "assistant", sessionID, parentID: userMessageID, time: { created: h.now() } },
    },
  })
  return h.store.prepareMainline({
    sessionID,
    userMessageID,
    agent: "build",
    providerID: spec.providerID ?? "gw",
    modelID: spec.modelID ?? "deepseek-v4",
    connection: CONNECTION,
  })
}

function accepted(h: Harness, assistantMessageID: string, sessionID = "ses_1", completed = true): void {
  h.store.onBusEvent({
    type: "message.part.updated",
    properties: { part: { id: "p1", sessionID, messageID: assistantMessageID, type: "text" } },
  })
  if (completed) {
    h.store.onBusEvent({
      type: "message.updated",
      properties: {
        info: { id: assistantMessageID, role: "assistant", sessionID, finish: "stop", time: { created: clock, completed: h.now() } },
      },
    })
  }
}

function failed(h: Harness, assistantMessageID: string, sessionID = "ses_1"): void {
  h.store.onBusEvent({
    type: "message.updated",
    properties: {
      info: {
        id: assistantMessageID,
        role: "assistant",
        sessionID,
        error: { name: "APIError" },
        time: { created: clock },
      },
    },
  })
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("ordinary requests", () => {
  it("V1: a fresh session starts exactly once with turn-opening priority and a cache declaration", async () => {
    const h = harness()
    const hint = await call(h)
    expect(hint.session).toEqual({ session_id: "ses_1", call_index: 1, epoch: 0, state: "start" })
    expect(hint.priority_control).toEqual({ priority: { level: 3, reason: "user_waiting" } })
    expect(hint.cache_control).toEqual({ type: "ephemeral", ttl_s: 600, msg_offset: 2 })
  })

  it("V2: a tool continuation appends, keeps the epoch and derives the TTL from the interval", async () => {
    const h = harness()
    await call(h)
    h.at(1_030_000)
    accepted(h, "a_u1")
    h.at(1_090_000)
    const hint = await call(h, {
      assistantMessageID: "a_u1_step2",
      snapshot: [
        userMessage("u1"),
        assistantMessage("a_u1", "u1", [
          { type: "text", text: "calling" },
          { type: "tool", tool: "read", callID: "c1", state: { status: "completed", output: "body" } },
        ]),
      ],
    })
    expect(hint.session.state).toBe("append")
    expect(hint.session.call_index).toBe(2)
    expect(hint.session.epoch).toBe(0)
    expect(hint.priority_control).toEqual({ priority: { level: 1, reason: "critical_path" } })
    expect(hint.cache_control).toEqual({ type: "ephemeral", ttl_s: 120, msg_offset: 4 })
  })

  it("V3: a new user input is a new turn opening", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    const hint = await call(h, { userMessageID: "u2" })
    expect(hint.session.call_index).toBe(2)
    expect(hint.priority_control).toEqual({ priority: { level: 3, reason: "user_waiting" } })
  })

  it("V9: a failed first request keeps start for the user's retry and counts the failed call", async () => {
    const h = harness()
    await call(h)
    failed(h, "a_u1")
    const hint = await call(h, { userMessageID: "u2", assistantMessageID: "a_u2" })
    expect(hint.session).toEqual({ session_id: "ses_1", call_index: 2, epoch: 0, state: "start" })
  })

  it("reuses the identical hint for a processor-level retry of the same call", async () => {
    const h = harness()
    const first = await call(h)
    const retry = await h.store.prepareMainline({
      sessionID: "ses_1",
      userMessageID: "u1",
      agent: "build",
      providerID: "gw",
      modelID: "deepseek-v4",
      connection: CONNECTION,
    })
    expect(retry).toEqual(first)
    expect(h.store.inspect("ses_1")?.calls).toBe(1)
  })

  it("V10: a model change suppresses the declaration for one round", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    const changed = await call(h, { userMessageID: "u2", modelID: "other" })
    expect(changed.cache_control).toBeUndefined()
    const stable = await call(h, { userMessageID: "u2", assistantMessageID: "a_u2_step2", modelID: "other" })
    expect(stable.cache_control).toBeDefined()
  })

  it("omits the declaration when the request shape is unknown", async () => {
    const h = harness()
    h.store.onChatMessage("ses_1", "u1")
    h.store.onBusEvent({
      type: "message.updated",
      properties: { info: { id: "a_u1", role: "assistant", sessionID: "ses_1", parentID: "u1" } },
    })
    const hint = await h.store.prepareMainline({
      sessionID: "ses_1",
      userMessageID: "u1",
      agent: "build",
      providerID: "gw",
      modelID: "deepseek-v4",
      connection: CONNECTION,
    })
    expect(hint.cache_control).toBeUndefined()
    expect(hint.session.state).toBe("start")
  })
})

describe("seeded sessions", () => {
  it("V4: rebuilds counts, appends and resumes before the first request", async () => {
    const history: Message[] = [
      userMessage("u0", undefined, "ses_1"),
      assistantMessage("a0", "u0"),
    ]
    const h = harness({ history })
    const hint = await call(h)
    expect(hint.session).toEqual({ session_id: "ses_1", call_index: 2, epoch: 0, state: "append" })
    // The restart rule: the prefix signature is unknown, so the first round is suppressed.
    expect(hint.cache_control).toBeUndefined()
    expect(h.sent.map((request) => request.hint.session.state)).toEqual(["resume"])
    expect(h.sent[0]?.hint.session.call_index).toBe(2)
    const next = await call(h, { userMessageID: "u1", assistantMessageID: "a_u1_step2" })
    expect(next.cache_control).toBeDefined()
  })

  it("rebuilds epoch from completed compactions", async () => {
    const history: Message[] = [
      userMessage("u0", undefined, "ses_1"),
      assistantMessage("a0", "u0"),
      userMessage("uc", [{ type: "compaction" }], "ses_1"),
      assistantMessage("ac", "uc", [{ type: "text", text: "summary" }], { summary: true }),
      userMessage("u1", undefined, "ses_1"),
      assistantMessage("a1", "u1"),
    ]
    const h = harness({ history })
    const hint = await call(h)
    expect(hint.session.epoch).toBe(1)
    expect(hint.session.call_index).toBe(3)
  })
})

describe("compaction, prune and retries", () => {
  it("V6: compact carries the old epoch, the next call bumps it and suppresses the cache", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    await call(h, { assistantMessageID: "a_u1_step2" })
    accepted(h, "a_u1_step2")
    h.store.onBusEvent({ type: "session.compacted", properties: { sessionID: "ses_1" } })
    await flush()
    const compact = h.sent.find((request) => request.hint.session.state === "compact")
    expect(compact?.hint.session).toMatchObject({ epoch: 0, call_index: 2 })
    const after = await call(h, { userMessageID: "uc", assistantMessageID: "a_uc", announce: false })
    expect(after.session.epoch).toBe(1)
    expect(after.cache_control).toBeUndefined()
    expect(after.priority_control).toEqual({ priority: { level: 1, reason: "critical_path" } })
    const recovered = await call(h, { userMessageID: "uc", assistantMessageID: "a_uc2", announce: false })
    expect(recovered.cache_control).toBeDefined()
  })

  it("keeps call_index on the overflow → compact → retry step", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    await call(h, { assistantMessageID: "a_u1_step2" })
    failed(h, "a_u1_step2")
    h.store.onBusEvent({ type: "session.compacted", properties: { sessionID: "ses_1" } })
    await flush()
    const retried = await call(h, { userMessageID: "u1_replay", assistantMessageID: "a_u1_retry", announce: false })
    expect(retried.session).toMatchObject({ call_index: 2, epoch: 1, state: "append" })
    expect(retried.cache_control).toBeUndefined()
    expect(retried.priority_control).toEqual({ priority: { level: 1, reason: "critical_path" } })
  })

  it("keeps call_index when the cut step only reports a completion time", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    await call(h, { assistantMessageID: "a_u1_step2" })
    h.store.onBusEvent({
      type: "message.updated",
      properties: {
        info: { id: "a_u1_step2", role: "assistant", sessionID: "ses_1", time: { created: 1, completed: 2 } },
      },
    })
    h.store.onBusEvent({ type: "session.compacted", properties: { sessionID: "ses_1" } })
    await flush()
    const retried = await call(h, { userMessageID: "u_continue", assistantMessageID: "a_u1_retry", announce: false })
    expect(retried.session).toMatchObject({ call_index: 2, epoch: 1 })
    expect(retried.cache_control).toBeUndefined()
  })

  it("treats a newly compacted old tool result as a rewrite", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    await call(h, { assistantMessageID: "a_u1_step2" })
    accepted(h, "a_u1_step2")
    h.store.onBusEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "t1",
          sessionID: "ses_1",
          messageID: "a_u1",
          type: "tool",
          state: { status: "completed", time: { compacted: h.now() } },
        },
      },
    })
    await flush()
    expect(h.sent.filter((request) => request.hint.session.state === "compact")).toHaveLength(1)
    const hint = await call(h, { userMessageID: "u2" })
    expect(hint.session.epoch).toBe(1)
    expect(hint.cache_control).toBeUndefined()
    expect(hint.priority_control).toEqual({ priority: { level: 3, reason: "user_waiting" } })
    const recovered = await call(h, { userMessageID: "u2", assistantMessageID: "a_u2_step2" })
    expect(recovered.cache_control).toBeDefined()
  })

  it("ignores repeated part updates for the same compacted tool result", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    await call(h, { assistantMessageID: "a_u1_step2" })
    for (let index = 0; index < 3; index++) {
      h.store.onBusEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "t1",
            sessionID: "ses_1",
            messageID: "a_u1",
            type: "tool",
            state: { status: "completed", time: { compacted: 1 } },
          },
        },
      })
    }
    await flush()
    expect(h.sent.filter((request) => request.hint.session.state === "compact")).toHaveLength(1)
  })
})

describe("lifecycle", () => {
  it("V5: without focus signals, another session's acceptance pauses the idle one", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    h.store.onBusEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })
    await call(h, { sessionID: "ses_2", userMessageID: "b1", assistantMessageID: "b_a" })
    accepted(h, "b_a", "ses_2")
    await flush()
    const pause = h.sent.find((request) => request.hint.session.state === "pause")
    expect(pause?.hint.session).toMatchObject({ session_id: "ses_1", call_index: 1, epoch: 0 })
    expect(pause?.hint.context_management?.edits[0]).toEqual({ type: "offload", target: "session" })
  })

  it("does not pause a busy session", async () => {
    const h = harness()
    await call(h)
    h.store.onBusEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
    await call(h, { sessionID: "ses_2", userMessageID: "b1", assistantMessageID: "b_a" })
    accepted(h, "b_a", "ses_2")
    await flush()
    expect(h.sent.some((request) => request.hint.session.state === "pause")).toBe(false)
  })

  it("with focus signals, blur pauses and focus resumes with prefetch", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    h.store.onBusEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })
    h.store.onFocus("ses_1")
    // Headless fallback is disabled while a TUI is connected.
    await call(h, { sessionID: "ses_2", userMessageID: "b1", assistantMessageID: "b_a" })
    accepted(h, "b_a", "ses_2")
    await flush()
    expect(h.sent.some((request) => request.hint.session.state === "pause")).toBe(false)
    h.store.onBlur("ses_1")
    await flush()
    const pause = h.sent.find((request) => request.hint.session.state === "pause")
    expect(pause?.hint.session.session_id).toBe("ses_1")
    h.store.onFocus("ses_1")
    await flush()
    const resume = h.sent.filter((request) => request.hint.session.state === "resume" && request.hint.session.session_id === "ses_1")
    expect(resume).toHaveLength(1)
    expect(resume[0]?.hint.context_management?.edits[0]).toEqual({ type: "prefetch", target: "session" })
  })

  it("resumes a paused session before letting its next request through", async () => {
    const h = harness({
      history: [userMessage("u0"), assistantMessage("a0", "u0")],
    })
    await call(h)
    accepted(h, "a_u1")
    h.store.onBusEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })
    h.store.onBlur("ses_1")
    await flush()
    const pause = h.sent.find((request) => request.hint.session.state === "pause")
    expect(pause?.hint.session.session_id).toBe("ses_1")
    h.sent.length = 0
    await call(h, { userMessageID: "u2", assistantMessageID: "a_u2" })
    const resume = h.sent.find((request) => request.hint.session.state === "resume")
    expect(resume?.hint.session.call_index).toBe(3)
  })

  it("V7: deletion and archiving send stop once each", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    h.store.onBusEvent({ type: "session.deleted", properties: { info: { id: "ses_1" } } })
    await flush()
    h.store.onBusEvent({ type: "session.updated", properties: { info: { id: "ses_1", time: { archived: 1 } } } })
    await flush()
    const stops = h.sent.filter((request) => request.hint.session.state === "stop")
    expect(stops).toHaveLength(1)
    expect(stops[0]?.hint.context_management?.edits[0]).toEqual({ type: "evict", target: "session" })
  })

  it("stops every live session on dispose", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    await h.store.dispose()
    expect(h.sent.filter((request) => request.hint.session.state === "stop")).toHaveLength(1)
  })
})

describe("barriers and quarantine", () => {
  it("quarantines the session after an unknown mutation and refuses the next request", async () => {
    const h = harness()
    await call(h)
    accepted(h, "a_u1")
    h.store.onBusEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })
    h.queue.push({ status: "unknown" })
    h.store.onBlur("ses_1")
    await flush()
    await expect(call(h, { userMessageID: "u2", assistantMessageID: "a_u2" })).rejects.toBeInstanceOf(
      ControlBarrierError,
    )
    await expect(
      h.store.prepareMainline({
        sessionID: "ses_1",
        userMessageID: "u2",
        agent: "build",
        providerID: "gw",
        modelID: "deepseek-v4",
        connection: CONNECTION,
      }),
    ).rejects.toBeInstanceOf(ControlBarrierError)
  })

  it("fails a request with a clear error when a mutation never settles", async () => {
    const h = harness({ options: { sessionControl: { ...defaultOptions().sessionControl, pendingOpAwaitMs: 20 } } })
    let release: (() => void) | undefined
    const hanging: ControlSender = {
      send() {
        return new Promise<ControlResult>((resolve) => {
          release = () => resolve({ status: "accepted", httpStatus: 200 })
        })
      },
    }
    const store = new SessionStore({
      options: h.options,
      control: hanging,
      history: { async messages() { return [] } },
      providerConfig: () => ({ baseURL: "http://gw/v1", apiKey: "k" }),
      now: () => 1_000_000,
    })
    store.onChatMessage("ses_1", "u1")
    store.onMessagesTransform([userMessage("u1")])
    store.onBusEvent({
      type: "message.updated",
      properties: { info: { id: "a1", role: "assistant", sessionID: "ses_1", parentID: "u1" } },
    })
    await store.prepareMainline({
      sessionID: "ses_1",
      userMessageID: "u1",
      agent: "build",
      providerID: "gw",
      modelID: "deepseek-v4",
      connection: CONNECTION,
    })
    store.onBusEvent({
      type: "message.part.updated",
      properties: { part: { id: "p1", sessionID: "ses_1", messageID: "a1", type: "text" } },
    })
    store.onBusEvent({
      type: "message.updated",
      properties: { info: { id: "a1", role: "assistant", sessionID: "ses_1", finish: "stop", time: { created: 1, completed: 2 } } },
    })
    store.onBusEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })
    store.onBlur("ses_1")
    await expect(
      store.prepareMainline({
        sessionID: "ses_1",
        userMessageID: "u2",
        agent: "build",
        providerID: "gw",
        modelID: "deepseek-v4",
        connection: CONNECTION,
      }),
    ).rejects.toBeInstanceOf(ControlBarrierError)
    release?.()
  })
})

describe("provider resolution", () => {
  it("derives the manage endpoint and keeps credentials only on the same origin", () => {
    const h = harness()
    expect(
      h.store.resolveConnection(
        { id: "gw", options: { baseURL: "http://gw/v1/", apiKey: "secret" } },
        "@ai-sdk/openai-compatible",
      ),
    ).toEqual({ endpoint: "http://gw/v1/chat/completions", apiKey: "secret", authHeader: "authorization" })
    expect(
      h.store.resolveConnection({ info: { id: "gw", options: { baseURL: "http://gw/v1" } } }, undefined),
    ).toEqual({ endpoint: "http://gw/v1/chat/completions", authHeader: "authorization" })
    expect(h.store.resolveConnection({ id: "gw", options: {} }, undefined)).toBeUndefined()
  })
})
