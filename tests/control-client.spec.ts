import { describe, expect, it } from "vitest"
import { SessionControlClient } from "../src/control-client.js"
import { buildManageHint, encodeAgentHintHeader } from "../src/hint.js"

interface Recorded {
  url: string
  init?: RequestInit
}

function client(
  responder: (url: string, init?: RequestInit) => Promise<Response>,
  options?: { timeoutMs?: number; retries?: number },
): { control: SessionControlClient; recorded: Recorded[] } {
  const recorded: Recorded[] = []
  const control = new SessionControlClient({
    timeoutMs: options?.timeoutMs ?? 500,
    retries: options?.retries ?? 1,
    fetch: (async (url: string, init?: RequestInit) => {
      recorded.push({ url, init })
      return responder(url, init)
    }) as unknown as typeof fetch,
    warn: () => undefined,
  })
  return { control, recorded }
}

const hint = (verb: "pause" | "resume" | "stop" | "compact") =>
  buildManageHint({ sessionId: "ses_1", callIndex: 2, epoch: verb === "compact" ? 1 : 2, state: verb })

describe("SessionControlClient", () => {
  it("sends the placeholder body, the hint header and the bearer credential", async () => {
    const { control, recorded } = client(async () => new Response("{}", { status: 200 }))
    const result = await control.send({
      verb: "pause",
      model: "deepseek-v4",
      connection: { endpoint: "http://gw/v1/chat/completions", apiKey: "secret" },
      hint: hint("pause"),
    })
    expect(result).toEqual({ status: "accepted", httpStatus: 200 })
    const [request] = recorded
    expect(request?.url).toBe("http://gw/v1/chat/completions")
    expect(request?.init?.method).toBe("POST")
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: "deepseek-v4",
      messages: [],
      stream: false,
    })
    const headers = request?.init?.headers as Record<string, string>
    expect(headers["x-agent-hint"]).toBe(encodeAgentHintHeader(hint("pause")))
    expect(headers.authorization).toBe("Bearer secret")
    expect(JSON.parse(Buffer.from(headers["x-agent-hint"]!, "base64url").toString())).toEqual(hint("pause"))
  })

  it("uses x-api-key when the provider wants it, and omits absent credentials", async () => {
    const { control, recorded } = client(async () => new Response("{}", { status: 200 }))
    await control.send({
      verb: "resume",
      model: "m",
      connection: { endpoint: "http://gw/v1/chat/completions", apiKey: "secret", authHeader: "x-api-key" },
      hint: hint("resume"),
    })
    await control.send({
      verb: "resume",
      model: "m",
      connection: { endpoint: "http://gw/v1/chat/completions" },
      hint: hint("resume"),
    })
    const first = recorded[0]?.init?.headers as Record<string, string>
    const second = recorded[1]?.init?.headers as Record<string, string>
    expect(first["x-api-key"]).toBe("secret")
    expect(first.authorization).toBeUndefined()
    expect(second.authorization).toBeUndefined()
    expect(second["x-api-key"]).toBeUndefined()
  })

  it("classifies a 4xx as a non-retryable failure", async () => {
    const { control, recorded } = client(async () => new Response("", { status: 404 }))
    const result = await control.send({
      verb: "stop",
      model: "m",
      connection: { endpoint: "http://gw/v1/chat/completions" },
      hint: hint("stop"),
    })
    expect(result).toEqual({ status: "failed", retryable: false, httpStatus: 404 })
    expect(recorded).toHaveLength(1)
  })

  it("treats a 5xx on a mutating verb as unknown, without retrying", async () => {
    const { control, recorded } = client(async () => new Response("", { status: 503 }))
    const result = await control.send({
      verb: "pause",
      model: "m",
      connection: { endpoint: "http://gw/v1/chat/completions" },
      hint: hint("pause"),
    })
    expect(result).toEqual({ status: "unknown" })
    expect(recorded).toHaveLength(1)
  })

  it("retries only resume, and only for explicit transient rejections", async () => {
    let calls = 0
    const { control, recorded } = client(async () => {
      calls += 1
      return new Response("", { status: calls === 1 ? 503 : 200 })
    }, { retries: 1 })
    const result = await control.send({
      verb: "resume",
      model: "m",
      connection: { endpoint: "http://gw/v1/chat/completions" },
      hint: hint("resume"),
    })
    expect(result).toEqual({ status: "accepted", httpStatus: 200 })
    expect(recorded).toHaveLength(2)
  })

  it("returns unknown when the request throws", async () => {
    const { control } = client(async () => {
      throw new Error("socket closed")
    })
    const result = await control.send({
      verb: "compact",
      model: "m",
      connection: { endpoint: "http://gw/v1/chat/completions" },
      hint: hint("compact"),
    })
    expect(result).toEqual({ status: "unknown" })
  })
})
