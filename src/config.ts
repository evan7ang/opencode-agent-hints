// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Plugin options, validated once at load time. Illegal configuration fails the
 * plugin load (opencode logs and disables the plugin) instead of degrading
 * silently mid-request.
 *
 * @module opencode-agent-hints/config
 */

import type { AgentHintPriority } from "./hint.js"

export const DEFAULT_PENDING_OP_AWAIT_MS = 5_000
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000
export const DEFAULT_CONTROL_RETRIES = 1

export type PriorityConfig = "dynamic" | "omit" | AgentHintPriority

export interface StaticCacheControl {
  ttl_s: number
  msg_offset?: number
}

export type CacheControlConfig = "dynamic" | "omit" | StaticCacheControl

export interface SessionControlConfig {
  /** `false` keeps the data plane (hint header) but sends no manage requests. */
  enabled: boolean
  /** Explicit manage URL; omission derives `<baseURL>/chat/completions`. */
  endpoint?: string
  /** How long a main-line request waits for an in-flight mutation. */
  pendingOpAwaitMs: number
  /** Per-attempt control-request timeout. */
  controlTimeoutMs: number
  /** Bounded retries of explicit transient rejections, for `resume` only. */
  retries: number
}

export interface TraceConfig {
  enabled: boolean
  /** JSONL path; omission logs trace lines to stdout. */
  file?: string
}

export interface AgentHintOptions {
  enabled: boolean
  /** Provider-id globs; empty means every provider. */
  providers: string[]
  priority: PriorityConfig
  cacheControl: CacheControlConfig
  sessionControl: SessionControlConfig
  /** Accept focus signals from the TUI part over the loopback channel. */
  focus: { enabled: boolean }
  trace: TraceConfig
}

export function defaultOptions(): AgentHintOptions {
  return {
    enabled: true,
    providers: [],
    priority: "dynamic",
    cacheControl: "dynamic",
    sessionControl: {
      enabled: true,
      pendingOpAwaitMs: DEFAULT_PENDING_OP_AWAIT_MS,
      controlTimeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
      retries: DEFAULT_CONTROL_RETRIES,
    },
    focus: { enabled: true },
    trace: { enabled: false },
  }
}

type Json = Record<string, unknown>

function asObject(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`agent-hints: ${path} must be an object`)
  }
  return value as Json
}

function checkKeys(value: Json, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`agent-hints: unknown option ${path}.${key}`)
  }
}

function asBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`agent-hints: ${path} must be a boolean`)
  return value
}

function asInteger(value: unknown, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`agent-hints: ${path} must be an integer in [${min}, ${max}]`)
  }
  return value
}

function asString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0) throw new Error(`agent-hints: ${path} must be a non-empty string`)
  return value
}

function parsePriority(value: unknown): PriorityConfig {
  if (value === undefined) return "dynamic"
  if (value === "dynamic" || value === "omit") return value
  const object = asObject(value, "priority")
  checkKeys(object, ["level", "reason"], "priority")
  const level = object.level
  // Static overrides fold onto the two-value admission line.
  const folded = typeof level === "number" && Number.isFinite(level) ? (level >= 3 ? 3 : 1) : undefined
  if (folded === undefined) throw new Error("agent-hints: priority.level must be a number")
  const reason = asString(object.reason, "priority.reason") ?? (folded === 3 ? "user_waiting" : "critical_path")
  if (folded === 3 && reason !== "user_waiting") throw new Error("agent-hints: priority level 3 requires reason user_waiting")
  if (folded === 1 && reason !== "critical_path") throw new Error("agent-hints: priority level 1 requires reason critical_path")
  return { level: folded, reason }
}

function parseCacheControl(value: unknown): CacheControlConfig {
  if (value === undefined) return "dynamic"
  if (value === "dynamic" || value === "omit") return value
  const object = asObject(value, "cacheControl")
  checkKeys(object, ["ttl_s", "msg_offset"], "cacheControl")
  const ttl_s = asInteger(object.ttl_s, "cacheControl.ttl_s", 0, 60, 3600)
  const result: StaticCacheControl = { ttl_s }
  if (object.msg_offset !== undefined) result.msg_offset = asInteger(object.msg_offset, "cacheControl.msg_offset", 1, 1, 100000)
  return result
}

function parseProviders(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("agent-hints: providers must be an array of provider-id globs")
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`agent-hints: providers[${index}] must be a non-empty string`)
    }
    return entry
  })
}

/** Validate raw plugin options; throws with a precise path on any violation. */
export function parseOptions(raw: unknown): AgentHintOptions {
  const defaults = defaultOptions()
  if (raw === undefined || raw === null) return defaults
  const object = asObject(raw, "options")
  checkKeys(
    object,
    ["enabled", "providers", "priority", "cacheControl", "sessionControl", "focus", "trace"],
    "options",
  )
  const sessionControlRaw = object.sessionControl === undefined
    ? {}
    : asObject(object.sessionControl, "sessionControl")
  checkKeys(
    sessionControlRaw,
    ["enabled", "endpoint", "pendingOpAwaitMs", "controlTimeoutMs", "retries"],
    "sessionControl",
  )
  const focusRaw = object.focus === undefined ? {} : asObject(object.focus, "focus")
  checkKeys(focusRaw, ["enabled"], "focus")
  const traceRaw = object.trace === undefined ? {} : asObject(object.trace, "trace")
  checkKeys(traceRaw, ["enabled", "file"], "trace")

  return {
    enabled: asBoolean(object.enabled, "enabled", defaults.enabled),
    providers: parseProviders(object.providers),
    priority: parsePriority(object.priority),
    cacheControl: parseCacheControl(object.cacheControl),
    sessionControl: {
      enabled: asBoolean(sessionControlRaw.enabled, "sessionControl.enabled", defaults.sessionControl.enabled),
      ...(() => {
        const endpoint = asString(sessionControlRaw.endpoint, "sessionControl.endpoint")
        return endpoint === undefined ? {} : { endpoint }
      })(),
      pendingOpAwaitMs: asInteger(
        sessionControlRaw.pendingOpAwaitMs,
        "sessionControl.pendingOpAwaitMs",
        defaults.sessionControl.pendingOpAwaitMs,
        1,
        600_000,
      ),
      controlTimeoutMs: asInteger(
        sessionControlRaw.controlTimeoutMs,
        "sessionControl.controlTimeoutMs",
        defaults.sessionControl.controlTimeoutMs,
        1,
        600_000,
      ),
      retries: asInteger(sessionControlRaw.retries, "sessionControl.retries", defaults.sessionControl.retries, 0, 10),
    },
    focus: { enabled: asBoolean(focusRaw.enabled, "focus.enabled", defaults.focus.enabled) },
    trace: {
      enabled: asBoolean(traceRaw.enabled, "trace.enabled", defaults.trace.enabled),
      ...(() => {
        const file = asString(traceRaw.file, "trace.file")
        return file === undefined ? {} : { file }
      })(),
    },
  }
}

/** Glob match for provider ids (`*` matches any run of characters). */
export function matchesProvider(patterns: readonly string[], providerId: string): boolean {
  if (patterns.length === 0) return true
  return patterns.some((pattern) => {
    if (pattern === "*") return true
    const source = pattern
      .split("*")
      .map((chunk) => chunk.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")
    return new RegExp(`^${source}$`).test(providerId)
  })
}
