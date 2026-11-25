import { describe, expect, it } from "vitest"
import { defaultOptions, matchesProvider, parseOptions } from "../src/config.js"

describe("parseOptions", () => {
  it("returns defaults for an absent config", () => {
    expect(parseOptions(undefined)).toEqual(defaultOptions())
    expect(parseOptions({}).sessionControl.enabled).toBe(true)
    expect(parseOptions({}).providers).toEqual([])
  })

  it("rejects unknown keys with a precise path", () => {
    expect(() => parseOptions({ nope: 1 })).toThrow(/options\.nope/)
    expect(() => parseOptions({ sessionControl: { nope: 1 } })).toThrow(/sessionControl\.nope/)
    expect(() => parseOptions({ trace: { nope: 1 } })).toThrow(/trace\.nope/)
  })

  it("validates ranges and types", () => {
    expect(() => parseOptions({ enabled: "yes" })).toThrow(/enabled/)
    expect(() => parseOptions({ providers: [1] })).toThrow(/providers\[0\]/)
    expect(() => parseOptions({ sessionControl: { retries: 99 } })).toThrow(/retries/)
    expect(() => parseOptions({ sessionControl: { controlTimeoutMs: 0 } })).toThrow(/controlTimeoutMs/)
  })

  it("folds static priority onto the two-value admission line", () => {
    expect(parseOptions({ priority: { level: 9, reason: "user_waiting" } }).priority).toEqual({
      level: 3,
      reason: "user_waiting",
    })
    expect(parseOptions({ priority: { level: 0, reason: "critical_path" } }).priority).toEqual({
      level: 1,
      reason: "critical_path",
    })
    expect(() => parseOptions({ priority: { level: 3 } })).not.toThrow()
    expect(() => parseOptions({ priority: { level: 3, reason: "critical_path" } })).toThrow(/user_waiting/)
    expect(() => parseOptions({ priority: { level: 1, reason: "user_waiting" } })).toThrow(/critical_path/)
  })

  it("validates static cache control", () => {
    expect(parseOptions({ cacheControl: { ttl_s: 600 } }).cacheControl).toEqual({ ttl_s: 600 })
    expect(() => parseOptions({ cacheControl: { ttl_s: 10 } })).toThrow(/ttl_s/)
    expect(() => parseOptions({ cacheControl: { ttl_s: 600, msg_offset: 0 } })).toThrow(/msg_offset/)
  })
})

describe("matchesProvider", () => {
  it("matches everything when no pattern is configured", () => {
    expect(matchesProvider([], "any")).toBe(true)
  })

  it("supports exact ids, globs and escapes", () => {
    expect(matchesProvider(["火山AI网关"], "火山AI网关")).toBe(true)
    expect(matchesProvider(["*gateway*"], "my-gateway")).toBe(true)
    expect(matchesProvider(["a.b"], "axb")).toBe(false)
    expect(matchesProvider(["a.b"], "a.b")).toBe(true)
    expect(matchesProvider(["a*"], "b")).toBe(false)
  })
})
