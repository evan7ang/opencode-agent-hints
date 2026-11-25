import { describe, expect, it } from "vitest"
import {
  countWireMessages,
  hasHistoryBefore,
  isAuxiliaryAgent,
  prefixTexts,
  rebuildFacts,
  type Message,
  type MessagePart,
} from "../src/messages.js"

let clock = 1_000

function user(id: string, parts: MessagePart[], sessionID = "ses_1"): Message {
  return { info: { id, role: "user", sessionID, time: { created: clock++ } }, parts }
}

function assistant(
  id: string,
  parentID: string,
  parts: MessagePart[],
  extra: Partial<Message["info"]> = {},
  sessionID = "ses_1",
): Message {
  return {
    info: {
      id,
      role: "assistant",
      parentID,
      sessionID,
      time: { created: clock++, completed: clock++ },
      modelID: "deepseek-v4",
      providerID: "gateway",
      ...extra,
    },
    parts,
  }
}

const text = (value: string): MessagePart => ({ type: "text", text: value })
const tool = (status: string, compacted?: number): MessagePart => ({
  type: "tool",
  tool: "read",
  callID: `call_${clock++}`,
  state: { status, input: { file: "a" }, output: "body", ...(compacted === undefined ? {} : { time: { compacted } }) },
})

describe("countWireMessages", () => {
  it("counts the system message plus one per user/assistant message", () => {
    expect(countWireMessages([])).toBe(1)
    expect(countWireMessages([user("u1", [text("hi")])])).toBe(2)
    expect(countWireMessages([user("u1", [text("hi")]), assistant("a1", "u1", [text("hello")])])).toBe(3)
  })

  it("counts each tool part as its own wire message", () => {
    const messages = [
      user("u1", [text("hi")]),
      assistant("a1", "u1", [text("calling"), tool("completed")]),
    ]
    expect(countWireMessages(messages)).toBe(4)
  })

  it("skips step-start-only, reasoning-only and errored assistants", () => {
    expect(countWireMessages([user("u1", [text("hi")]), assistant("a1", "u1", [{ type: "step-start" }])])).toBe(2)
    expect(
      countWireMessages([user("u1", [text("hi")]), assistant("a1", "u1", [{ type: "reasoning", text: "why" }])]),
    ).toBe(2)
    expect(
      countWireMessages([
        user("u1", [text("hi")]),
        assistant("a1", "u1", [text("boom")], { error: { name: "APIError" } }),
      ]),
    ).toBe(2)
  })

  it("ignores empty and ignored user text and counts compaction parts", () => {
    expect(countWireMessages([user("u1", [{ type: "text", text: "", ignored: true }])])).toBe(1)
    expect(countWireMessages([user("u1", [{ type: "compaction" }])])).toBe(2)
    expect(countWireMessages([user("u1", [{ type: "subtask", prompt: "x" }])])).toBe(2)
  })
})

describe("prefixTexts", () => {
  it("collects content but no ids", () => {
    const texts = prefixTexts([
      user("u1", [text("hello")]),
      assistant("a1", "u1", [{ type: "reasoning", text: "why" }, tool("completed")]),
    ])
    expect(texts.join("|")).toContain("hello")
    expect(texts.join("|")).toContain("why")
    expect(texts.join("|")).not.toContain("u1")
  })
})

describe("rebuildFacts", () => {
  it("counts completed compactions as epoch", () => {
    const messages = [
      user("u1", [{ type: "compaction" }]),
      assistant("a1", "u1", [text("summary")], { summary: true }),
      user("u2", [text("next")]),
      assistant("a2", "u2", [text("ok")]),
    ]
    expect(rebuildFacts(messages).epoch).toBe(1)
  })

  it("does not count an unfinished or failed summary", () => {
    const messages = [
      user("u1", [{ type: "compaction" }]),
      assistant("a1", "u1", [text("summary")], { summary: true, error: { name: "APIError" } }),
    ]
    expect(rebuildFacts(messages).epoch).toBe(0)
  })

  it("counts finished and failed main-line calls but not the in-flight one", () => {
    const inFlight: Message = {
      info: { id: "a3", role: "assistant", parentID: "u2", sessionID: "ses_1", time: { created: clock++ } },
      parts: [text("...")],
    }
    const messages = [
      assistant("a1", "u1", [text("ok")]),
      assistant("a2", "u2", [text("boom")], { error: { name: "APIError" } }),
      inFlight,
    ]
    const facts = rebuildFacts(messages)
    expect(facts.completedCalls).toBe(2)
    expect(facts.lastModelID).toBe("deepseek-v4")
    expect(facts.lastProviderID).toBe("gateway")
  })

  it("excludes auxiliary and summary assistants", () => {
    const messages = [
      assistant("a1", "u1", [text("title")], { agent: "title" }),
      assistant("a2", "u1", [text("summary")], { summary: true }),
      assistant("a3", "u1", [text("ok")]),
    ]
    expect(rebuildFacts(messages).completedCalls).toBe(1)
  })
})

describe("hasHistoryBefore", () => {
  it("is false only when the current message is the whole history", () => {
    expect(hasHistoryBefore([], "u1")).toBe(false)
    expect(hasHistoryBefore([user("u1", [text("hi")])], "u1")).toBe(false)
    expect(hasHistoryBefore([user("u0", [text("old")]), user("u1", [text("hi")])], "u1")).toBe(true)
  })
})

describe("auxiliary agents", () => {
  it("covers the hidden built-ins only", () => {
    expect(isAuxiliaryAgent("title")).toBe(true)
    expect(isAuxiliaryAgent("compaction")).toBe(true)
    expect(isAuxiliaryAgent("summary")).toBe(true)
    expect(isAuxiliaryAgent("build")).toBe(false)
    expect(isAuxiliaryAgent(undefined)).toBe(false)
  })
})
