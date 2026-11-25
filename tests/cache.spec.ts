import { describe, expect, it } from "vitest"
import {
  buildCacheControl,
  cacheSignature,
  deriveTtlS,
  estimatePrefixTokens,
  MIN_PREFIX_TOKENS,
  TTL_FALLBACK_GAP_S,
} from "../src/cache.js"

describe("deriveTtlS", () => {
  it("uses the 300 s fallback gap and clamps to the 60..3600 range", () => {
    expect(deriveTtlS(undefined)).toBe(TTL_FALLBACK_GAP_S * 2)
    expect(deriveTtlS(0)).toBe(600)
    expect(deriveTtlS(1_000)).toBe(60)
    expect(deriveTtlS(10_000)).toBe(60)
    expect(deriveTtlS(60_000)).toBe(120)
    expect(deriveTtlS(0.001)).toBe(60)
    expect(deriveTtlS(86_400_000)).toBe(3_600)
  })
})

describe("buildCacheControl", () => {
  it("emits one ephemeral declaration with the wire count as msg_offset", () => {
    expect(buildCacheControl(4, 1_000, undefined)).toEqual({ type: "ephemeral", ttl_s: 600, msg_offset: 4 })
  })

  it("suppresses sub-block prefixes", () => {
    expect(buildCacheControl(4, MIN_PREFIX_TOKENS - 1, undefined)).toBeUndefined()
    expect(buildCacheControl(4, MIN_PREFIX_TOKENS, undefined)).not.toBeUndefined()
  })

  it("omits an unusable offset", () => {
    expect(buildCacheControl(0, 1_000, undefined)).toBeUndefined()
    expect(buildCacheControl(Number.NaN, 1_000, undefined)).toBeUndefined()
  })
})

describe("estimatePrefixTokens", () => {
  it("counts CJK as one token per character and others at four chars per token", () => {
    expect(estimatePrefixTokens(["你好"])).toBe(2)
    expect(estimatePrefixTokens(["abcd"])).toBe(1)
    expect(estimatePrefixTokens(["abcde"])).toBe(2)
    expect(estimatePrefixTokens(["你好", "abcdefgh"])).toBe(4)
  })
})

describe("cacheSignature", () => {
  it("is order insensitive over tool names and includes the model", () => {
    expect(cacheSignature("m", ["b", "a"])).toBe(cacheSignature("m", ["a", "b"]))
    expect(cacheSignature("m", ["a"])).not.toBe(cacheSignature("n", ["a"]))
    expect(cacheSignature("m", undefined)).toBe(cacheSignature("m", []))
  })
})
