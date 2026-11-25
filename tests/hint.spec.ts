import { describe, expect, it } from "vitest"
import {
  buildManageHint,
  buildOrdinaryHint,
  encodeAgentHintHeader,
  encodeBase64Url,
  STATE_EDIT,
} from "../src/hint.js"

describe("encoding", () => {
  it("encodes base64url without padding", () => {
    // RFC 4648 test vectors, adapted to the url-safe alphabet.
    expect(encodeBase64Url(new TextEncoder().encode(""))).toBe("")
    expect(encodeBase64Url(new TextEncoder().encode("f"))).toBe("Zg")
    expect(encodeBase64Url(new TextEncoder().encode("fo"))).toBe("Zm8")
    expect(encodeBase64Url(new TextEncoder().encode("foo"))).toBe("Zm9v")
    expect(encodeBase64Url(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy")
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8")
  })

  it("round-trips a hint with JSON types intact", () => {
    const hint = buildOrdinaryHint({
      sessionId: "ses_1",
      callIndex: 2,
      epoch: 1,
      state: "append",
      priority: { level: 3, reason: "user_waiting" },
      cacheControl: { type: "ephemeral", ttl_s: 600, msg_offset: 4 },
    })
    const header = encodeAgentHintHeader(hint)
    expect(header).not.toContain("=")
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/)
    const decoded = JSON.parse(new TextDecoder().decode(Buffer.from(header, "base64url")))
    expect(decoded).toEqual(hint)
    expect(typeof decoded.session.call_index).toBe("number")
    expect(typeof decoded.session.epoch).toBe("number")
    expect(decoded.cache_control.ttl_s).toBe(600)
  })
})

describe("builders", () => {
  it("omits every optional block that has no value", () => {
    const hint = buildOrdinaryHint({ sessionId: "s", callIndex: 1, epoch: 0, state: "start" })
    expect(hint).toEqual({ session: { session_id: "s", call_index: 1, epoch: 0, state: "start" } })
    expect("priority_control" in hint).toBe(false)
    expect("cache_control" in hint).toBe(false)
  })

  it("adds lineage only when known", () => {
    const hint = buildOrdinaryHint({
      sessionId: "s",
      parentSessionId: "p",
      callIndex: 5,
      epoch: 2,
      state: "append",
    })
    expect(hint.session.parent_session_id).toBe("p")
  })

  it("maps every lifecycle verb to its edit", () => {
    for (const [verb, edit] of Object.entries(STATE_EDIT)) {
      const hint = buildManageHint({ sessionId: "s", callIndex: 3, epoch: 0, state: verb as never })
      expect(hint.context_management).toEqual({ manage_request: true, edits: [{ type: edit, target: "session" }] })
      expect(hint.session.state).toBe(verb)
      expect(hint.priority_control).toBeUndefined()
      expect(hint.cache_control).toBeUndefined()
    }
  })
})
