# 上游 feature request 草稿（opencode）

按 `CONTRIBUTING.md`，功能 PR 之前必须先提 feature request 并通过设计评审。下面是可以直接粘贴的正文
（遵循"短、说清问题与方案、不要长 AI 文案"）。

- 标题：`[FEATURE]: Session lifecycle hints for prefix-caching inference servers`
- 关联调研：`docs/design/20261127-01-upstreaming-opencode.md`
- 参考实现（独立插件）：https://github.com/evan7ang/opencode-agent-hints

## 正文

**Problem**

Self-hosted prefix-caching inference servers (vLLM, MindIE, and gateway/coordinator setups) cannot tell
when a session starts, pauses, ends, or whether a prefix is worth keeping. They guess from request
traffic alone, so a session that goes away keeps its KV blocks pinned, and a session that comes back
pays a full prefill. The same cost shows up as the cache-eviction reports in #55243, #61318 and #61556.

**Proposal**

An opt-in header that follows each main-line model request, telling an inference gateway:

- which session/context the request belongs to (plus fork lineage, which the repo already records),
- the lifecycle state (`start` / `append` outside band, `pause` / `resume` / `stop` / `compact` on a
  configured control endpoint),
- a two-level soft priority,
- a cache-retention intent (`ephemeral`, TTL, message offset).

Wire contract: one `X-Agent-Hint` header, base64url JSON, request body unchanged. Manage requests are
`POST <configured control endpoint>` with `{"model","messages":[],"stream":false}` and the same header.
Default off; providers are allowlisted; nothing changes on the wire unless enabled.

The V2 plugin API already exposes what is needed (`session.hook("model.request")` with `kind`,
`session.hook("context")` with `messages`/`tools`, `compaction`, `retry`, `experimental.idle`, `fork`).
Two small core enablers are requested:

1. WebSocket channels: a way to mark handshake headers as not part of the affinity key. A per-request
   hint header currently changes the key and reopens the socket on every call.
2. Presence: a server-side "which client is looking at which session" signal (TUI/app/desktop report
   focus), so `pause` can fire when the user leaves an idle session.

**Alternatives**

- Provider-side cache breakpoints (already in `packages/ai/src/cache-policy.ts`) cover provider prompt
  caching but not a serving layer's KV retention/lifecycle.
- A standalone plugin works today for HTTP transports; it cannot avoid the WebSocket reconnect and has
  no focus signal.

**Scope**

Phase 1 of the plan (the two core enablers) is small and independently testable; the protocol encoder and
lifecycle live in a plugin package. Happy to open the first PR (WebSocket volatile headers) once the
direction is approved.

---

## 当前进度

- 已本地实现并推到 fork（未提 issue、未开 PR）：`ws-volatile-headers`、`agent-hint-plugin` 两个分支，
  详见 `docs/design/20261127-01-upstreaming-opencode.md` §10。
- 提交 issue 前建议先跑一次 `packages/core` 的全量测试，并把两份 commit 的 diff 附在 issue 里作为"可评审的最小改动"。

## 提交后要做的事

1. 等维护者对方向的回复；若要求缩小范围，先只落"volatile handshake headers"。
2. 按 `docs/design/20261127-01-upstreaming-opencode.md` §6 拆 PR（P1 → P5），每个 PR 基于 `dev`，
   `type(scope): ...`，按包跑 `bun run test` / `bun typecheck`。
3. 每个 PR 描述控制在几段话，附 e2e 抓包/截图；不要粘贴长报告。
