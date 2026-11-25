// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Dynamic `cache_control` derivation: one `ephemeral` declaration per
 * main-line request declaring "keep the current prefix for N more seconds",
 * with the effective point expressed as a 1-based `msg_offset` (the request's
 * wire message count).
 *
 * TTL policy: `clamp(gap × 2, 60, 3600)` where `gap` is the latest observed
 * request interval (response end → request start); the factor 2 tolerates the
 * real gap being twice the estimate because under-estimation loses the whole
 * prefix while over-estimation only holds memory slightly longer. Without a
 * sample the 300 s fallback applies. A declaration below one engine block
 * (128 tokens) is pointless and therefore omitted.
 *
 * @module opencode-agent-hints/cache
 */

import type { AgentHintCacheControl } from "./hint.js"

/** Lower clamp bound: declarations below this are raised. */
export const TTL_MIN_S = 60
/** Upper clamp bound: declarations above this are truncated, never dropped. */
export const TTL_MAX_S = 3600
/** Gap assumed when no interval sample exists. */
export const TTL_FALLBACK_GAP_S = 300
/** Safety factor over the estimated gap. */
export const TTL_FACTOR = 2
/** The engine stores whole KV blocks; a shorter prefix cannot be cached. */
export const MIN_PREFIX_TOKENS = 128

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x9fff],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
]

function isCjk(code: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true
  }
  return false
}

/**
 * CJK-aware prefix size estimate: one token per CJK/full-width character, one
 * token per four other characters. Under-estimation is the benign direction
 * (a skipped declaration), over-estimation is clamped by the engine's own
 * block threshold.
 */
export function estimatePrefixTokens(texts: Iterable<string>): number {
  let cjk = 0
  let other = 0
  for (const text of texts) {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0
      if (isCjk(code)) cjk += 1
      else other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * Walk an arbitrary JSON-ish value and collect every string, so a caller can
 * estimate a whole request without knowing the message shape.
 */
export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value)
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into)
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectStrings(entry, into)
  }
  return into
}

/** Derive the declaration TTL from the latest request interval. */
export function deriveTtlS(intervalMs: number | undefined): number {
  const gapS = intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs / 1000
    : TTL_FALLBACK_GAP_S
  return Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, Math.round(gapS * TTL_FACTOR)))
}

/**
 * Assemble the single ephemeral declaration for one request.
 * @param wireMessageCount - the wire message count of this request; becomes `msg_offset`.
 * @param prefixTokens - the estimated prefix size; below one block the declaration is omitted.
 * @param intervalMs - the interval sample feeding the TTL.
 */
export function buildCacheControl(
  wireMessageCount: number,
  prefixTokens: number,
  intervalMs: number | undefined,
): AgentHintCacheControl | undefined {
  if (!Number.isSafeInteger(wireMessageCount) || wireMessageCount < 1) return undefined
  if (prefixTokens > 0 && prefixTokens < MIN_PREFIX_TOKENS) return undefined
  return {
    type: "ephemeral",
    ttl_s: deriveTtlS(intervalMs),
    msg_offset: wireMessageCount,
  }
}

/**
 * The prefix-key signature of one request: the model plus the tool-set names.
 * A declaration from a different signature would pin a prefix the engine
 * cached under another key, so it is suppressed for that round.
 */
export function cacheSignature(model: string, toolNames: readonly string[] | undefined): string {
  const tools = toolNames === undefined ? [] : [...toolNames].sort()
  return JSON.stringify([model, tools])
}
