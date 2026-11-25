// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Structural views over opencode's session messages.
 *
 * Two jobs:
 * 1. `countWireMessages` mirrors the harness's message → wire conversion so a
 *    `cache_control.msg_offset` never exceeds the consumer's `len(messages)`
 *    check. Uncertain shapes under-count on purpose: an under-count keeps a
 *    valid (smaller) declaration, an over-count loses the declaration.
 * 2. `rebuildFacts` recovers `call_index` / `epoch` from durable history after
 *    a process restart, so counts never move backwards for the consumer.
 *
 * @module opencode-agent-hints/messages
 */

/** Agents whose model calls are auxiliary and must never carry a hint. */
export const AUXILIARY_AGENTS: ReadonlySet<string> = new Set(["title", "compaction", "summary"])

export function isAuxiliaryAgent(agent: string | undefined): boolean {
  return agent !== undefined && AUXILIARY_AGENTS.has(agent)
}

export interface MessageInfo {
  id: string
  role: string
  sessionID?: string
  parentID?: string
  agent?: string
  mode?: string
  summary?: boolean
  finish?: string
  error?: unknown
  modelID?: string
  providerID?: string
  model?: { providerID?: string; modelID?: string }
  time?: { created?: number; completed?: number }
}

export interface PartBase {
  type: string
}

export interface TextPart extends PartBase {
  type: "text"
  text: string
  ignored?: boolean
  synthetic?: boolean
}

export interface FilePart extends PartBase {
  type: "file"
  mime: string
  filename?: string
}

export interface ToolPart extends PartBase {
  type: "tool"
  tool: string
  callID: string
  state: {
    status: string
    input?: unknown
    output?: unknown
    error?: unknown
    time?: { compacted?: number }
  }
}

export interface ReasoningPart extends PartBase {
  type: "reasoning"
  text: string
}

export type MessagePart = TextPart | FilePart | ToolPart | ReasoningPart | (PartBase & Record<string, unknown>)

export interface Message {
  info: MessageInfo
  parts: MessagePart[]
}

function isText(part: MessagePart): part is TextPart {
  return part.type === "text"
}

function isFile(part: MessagePart): part is FilePart {
  return part.type === "file"
}

function isTool(part: MessagePart): part is ToolPart {
  return part.type === "tool"
}

function isReasoning(part: MessagePart): part is ReasoningPart {
  return part.type === "reasoning"
}

/** True when the user message contributes at least one wire message. */
function userMessageCounts(parts: readonly MessagePart[]): boolean {
  return parts.some((part) => {
    if (isText(part)) return !part.ignored && part.text !== ""
    if (isFile(part)) return part.mime !== "text/plain" && part.mime !== "application/x-directory"
    // A compaction part becomes the "What did we do so far?" text; a subtask
    // part becomes a fixed text line.
    return part.type === "compaction" || part.type === "subtask"
  })
}

function assistantIsHidden(info: MessageInfo, parts: readonly MessagePart[]): boolean {
  if (!info.error) return false
  // An aborted message that already produced content is still replayed.
  const aborted = (info.error as { name?: string } | undefined)?.name === "MessageAbortedError"
    || (info.error as { name?: string } | undefined)?.name === "AbortedError"
  if (!aborted) return true
  return !parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
}

/**
 * Count the messages an OpenAI-compatible endpoint receives for this snapshot.
 * `system` counts the single system message the harness prepends.
 */
export function countWireMessages(messages: readonly Message[], options?: { system?: boolean }): number {
  let count = options?.system === false ? 0 : 1
  for (const message of messages) {
    const parts = message.parts
    if (parts.length === 0) continue
    if (message.info.role === "user") {
      if (userMessageCounts(parts)) count += 1
      continue
    }
    if (message.info.role !== "assistant") continue
    if (assistantIsHidden(message.info, parts)) continue
    // `step-start`-only messages are filtered before conversion.
    if (!parts.some((part) => part.type !== "step-start")) continue
    // Reasoning-only messages may or may not survive conversion; skip them so
    // the offset stays a lower bound.
    const hasContent = parts.some((part) => (isText(part) && !part.ignored) || isTool(part))
    if (hasContent) count += 1
    for (const part of parts) {
      // Every tool part becomes its own tool-role message (completed, failed or
      // interrupted), matching the harness's `tool-<name>` conversion.
      if (isTool(part)) count += 1
    }
  }
  return count
}

/** Strings that make up the model prefix, for the 128-token suppression check. */
export function prefixTexts(messages: readonly Message[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (isText(part) || isReasoning(part)) {
        if (part.text !== "") out.push(part.text)
      } else if (isTool(part)) {
        const state = part.state
        if (typeof state.output === "string") out.push(state.output)
        else if (state.output !== undefined) out.push(JSON.stringify(state.output))
        if (state.input !== undefined) out.push(JSON.stringify(state.input))
        if (typeof state.error === "string") out.push(state.error)
      } else if (isFile(part) && part.filename !== undefined) {
        out.push(part.filename)
      }
    }
  }
  return out
}

export interface RebuiltFacts {
  /** Main-line calls that have finished (or failed) in the durable history. */
  completedCalls: number
  /** Compaction rewrites committed in the durable history. */
  epoch: number
  /** Model of the newest main-line message, so a pre-request manage request can name it. */
  lastModelID?: string
  lastProviderID?: string
}

/**
 * True when the session already carries history before this request.
 *
 * The step's own assistant message is persisted before the request is prepared,
 * so an assistant with neither a completion time nor an error is the in-flight
 * call and must not count as history.
 */
export function hasHistoryBefore(messages: readonly Message[], currentUserId: string | undefined): boolean {
  if (messages.length === 0) return false
  if (currentUserId === undefined) return true
  return messages.some((message) => {
    const info = message.info
    if (info.id === currentUserId) return false
    if (info.role === "assistant" && info.time?.completed === undefined && info.error === undefined) return false
    return true
  })
}

/**
 * Rebuild durable counters from the full session history.
 *
 * `call_index = completed main-line calls + 1` (the in-flight message has no
 * completion/error and is excluded). `epoch` counts user messages whose
 * compaction part produced a completed summary.
 */
export function rebuildFacts(messages: readonly Message[]): RebuiltFacts {
  const completedCompactionParents = new Set<string>()
  for (const message of messages) {
    const info = message.info
    if (info.role !== "assistant") continue
    if (info.summary !== true) continue
    if (info.error) continue
    if (!info.parentID) continue
    if (info.time?.completed === undefined && info.time?.created === undefined) continue
    completedCompactionParents.add(info.parentID)
  }
  let epoch = 0
  let completedCalls = 0
  for (const message of messages) {
    const info = message.info
    if (info.role === "user") {
      if (!info.id) continue
      if (!completedCompactionParents.has(info.id)) continue
      if (message.parts.some((part) => part.type === "compaction")) epoch += 1
      continue
    }
    if (info.role !== "assistant") continue
    if (info.summary === true) continue
    if (info.agent !== undefined && isAuxiliaryAgent(info.agent)) continue
    if (info.time?.completed === undefined && info.error === undefined) continue
    completedCalls += 1
  }
  let lastModelID: string | undefined
  let lastProviderID: string | undefined
  for (const message of messages) {
    const info = message.info
    if (info.role === "assistant" && info.summary !== true && info.modelID !== undefined) {
      lastModelID = info.modelID
      lastProviderID = info.providerID ?? lastProviderID
    } else if (info.role === "user" && info.model?.modelID !== undefined) {
      lastModelID = info.model.modelID
      lastProviderID = info.model.providerID ?? lastProviderID
    }
  }
  return {
    completedCalls,
    epoch,
    ...(lastModelID === undefined ? {} : { lastModelID }),
    ...(lastProviderID === undefined ? {} : { lastProviderID }),
  }
}
