// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Agent Hint v1 wire objects: four blocks (`session` / `context_management` /
 * `priority_control` / `cache_control`) encoded as UTF-8 JSON into the
 * `X-Agent-Hint` header (base64url, no padding).
 *
 * Pure and side-effect free: the request body never carries hint fields, and
 * every value below is derived from session facts supplied by the adapter.
 *
 * @module opencode-agent-hints/hint
 */

/** Session lifecycle state carried on the wire. */
export type SessionState = "start" | "append" | "pause" | "resume" | "stop" | "compact"

/** Lifecycle verbs that own a manage request (never `start` / `append`). */
export type ManageState = "pause" | "resume" | "stop" | "compact"

/** Context edit action, derived from the lifecycle verb. */
export type ContextEditType = "offload" | "prefetch" | "evict"

/** Session block: who is calling, from which lineage, at which call, in which state. */
export interface AgentHintSession {
  /** Session id; stable within one context. */
  session_id: string
  /** Parent session id; omitted when lineage has no reliable source. */
  parent_session_id?: string
  /** Call index inside the session, starting at 1. */
  call_index: number
  /** Context version; bumped after a history rewrite. */
  epoch: number
  /** Lifecycle state of this request. */
  state: SessionState
}

/** One context edit. Only whole-session edits are emitted by a harness. */
export interface AgentHintEdit {
  type: ContextEditType
  target: "session"
}

/** Context management block: manage-request marker plus its edits. */
export interface AgentHintContextManagement {
  /** True: the request body is not executed, only the edits are processed. */
  manage_request: boolean
  edits: AgentHintEdit[]
}

/** `priority_control.priority` block. */
export interface AgentHintPriority {
  level: number
  reason: string
}

/** `cache_control` block: one ephemeral declaration for the current prefix. */
export interface AgentHintCacheControl {
  type: "ephemeral"
  /** Retention seconds for the current prefix. */
  ttl_s: number
  /** 1-based effective message offset; the request's wire message count. */
  msg_offset: number
}

/** The complete AgentHint object encoded into the `X-Agent-Hint` header value. */
export interface AgentHint {
  session: AgentHintSession
  context_management?: AgentHintContextManagement
  priority_control?: { priority: AgentHintPriority }
  cache_control?: AgentHintCacheControl
}

/** Verb → edit map shared by the adapter and the control client. */
export const STATE_EDIT: Readonly<Record<ManageState, ContextEditType>> = Object.freeze({
  pause: "offload",
  resume: "prefetch",
  stop: "evict",
  compact: "evict",
})

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/**
 * base64url (RFC 4648 §5) without padding. Implemented locally so the encoder
 * works in both Bun and Node without a Buffer dependency.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = ""
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!
  }
  const remaining = bytes.length - i
  if (remaining === 1) {
    const n = bytes[i]! << 16
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!
  } else if (remaining === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!
  }
  return out
}

/** Encode one AgentHint as the `X-Agent-Hint` header value (base64url, no padding). */
export function encodeAgentHintHeader(hint: AgentHint): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(hint)))
}

/** Facts for one ordinary request's hint. */
export interface OrdinaryHintFacts {
  sessionId: string
  parentSessionId?: string | undefined
  callIndex: number
  epoch: number
  /** `start` on a fresh session's first accepted request, `append` afterwards. */
  state: "start" | "append"
  priority?: AgentHintPriority | undefined
  cacheControl?: AgentHintCacheControl | undefined
}

/** Build the hint for one ordinary (main-line) request. */
export function buildOrdinaryHint(facts: OrdinaryHintFacts): AgentHint {
  const session: AgentHintSession = {
    session_id: facts.sessionId,
    call_index: facts.callIndex,
    epoch: facts.epoch,
    state: facts.state,
  }
  if (facts.parentSessionId !== undefined) session.parent_session_id = facts.parentSessionId
  const hint: AgentHint = { session }
  if (facts.priority !== undefined) hint.priority_control = { priority: { ...facts.priority } }
  if (facts.cacheControl !== undefined) hint.cache_control = { ...facts.cacheControl }
  return hint
}

/** Facts for one manage request's hint. */
export interface ManageHintFacts {
  sessionId: string
  parentSessionId?: string | undefined
  callIndex: number
  /** For `compact`: the epoch of the context being evicted; otherwise the current one. */
  epoch: number
  state: ManageState
}

/**
 * Build the hint for one manage request: the verb plus the edit it asks for.
 * The request body is a placeholder (`messages: []`, `stream: false`) and the
 * consumer must not execute it as inference.
 */
export function buildManageHint(facts: ManageHintFacts): AgentHint {
  const session: AgentHintSession = {
    session_id: facts.sessionId,
    call_index: facts.callIndex,
    epoch: facts.epoch,
    state: facts.state,
  }
  if (facts.parentSessionId !== undefined) session.parent_session_id = facts.parentSessionId
  return {
    session,
    context_management: {
      manage_request: true,
      edits: [{ type: STATE_EDIT[facts.state], target: "session" }],
    },
  }
}
