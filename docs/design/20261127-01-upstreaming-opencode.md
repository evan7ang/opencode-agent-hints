# 把 Agent Hint 能力合入 opencode 本体：可行性调研与方案

- 日期：2026-11-27
- 上游：`anomalyco/opencode`，默认分支 `dev`（2026-11-26 快照，V2 架构）
- 本仓库：`opencode-agent-hints`（opencode 1.18.x / V1 插件 API 的独立实现）
- 协议：`agent-hint-protocol.md` v1.0

## 1. 结论

**可行，而且上游已经具备大半基础设施**，但不应直接照搬本仓库的插件形态。

- 上游 V2 的 `session` 插件 hook 里有 `model.request`（可改 headers，且带 `kind: primary|compaction|title|generate`）、
  `context`（拿得到真实的 `messages` 与 `tools`）、`prompt`、`compaction`、`retry`、`experimental.idle`、
  `fork`、`http.*`、`experimental.ws.*`。这正好覆盖我们靠 `chat.headers` / `messages.transform` /
  `tool.definition` / 事件 hook 拼出来的全部输入，且更准确。
- 上游已经在做**会话亲和与 prompt 缓存**：`SessionAffinity.get`、`prompt_cache_key`、
  `packages/ai/src/cache-policy.ts` 的 provider 侧缓存断点；issue #55243 / #61318 / #61556 / #52933
  说明维护者对这个方向有明确兴趣。
- 但有三处**必须改核心**，纯插件做不到：
  1. 逐请求变化的 hint 头会改变 WebSocket 通道的 affinity 指纹（`model-transport.ts` 用
     `url + 排序后 headers 的哈希`），导致每个请求重开一次连接。需要核心把"不参与 affinity 的头"与
     "普通头"分开，或改用帧内字段。
  2. 焦点信号：上游只有 UI 层的 presence（`packages/app/src/runtime/presence*`、TUI 的
     `delayed-presence`），**没有**"某个客户端正在看哪个会话"的服务端状态。要做 L3 的焦点暂停，需要
     新增一条 presence 路由/服务。
  3. `call_index` / `epoch` 要精确且重启可续，应该由核心从会话事件与上下文版本直接给出，而不是让插件
     再从消息表反推（本仓库当前就是这么降级的）。

推荐路线：**先把能力做成仓库内的官方插件（`packages/plugin-agent-hints` 之类的独立包）+ 两个小的
核心前置改动；维护者认可后再把事实来源（计数、上下文版本、presence）收进核心**。理由见 §5。

## 2. 上游现状（已核实）

| 事实 | 位置 | 对我们的意义 |
| --- | --- | --- |
| V2 插件 hook 域：`aisdk / session / permission / shell / tool` | `packages/core/src/plugin/hooks.ts` | 有正式的扩展点 |
| `session.hook("model.request")` 事件：`sessionID / agent / model / kind / baseURL? / headers` | `packages/plugin/src/effect/session.ts` | **hint 头的官方注入点**；`kind` 直接对应辅助豁免 |
| `session.hook("context")` 事件：`system / messages / options / tools` | 同上 | `msg_offset` 与工具集签名可以精确计算 |
| `session.hook("prompt")` / `fork` / `compaction` / `retry` / `experimental.idle` | 同上 | 真实输入边界、血缘、改写、重试、空闲 |
| `model-request.ts` 已注入 `x-opencode-session-id`、`x-session-affinity`、`X-Session-Id`、`x-parent-session-id` | `packages/core/src/session/model-request.ts:319-330` | hint 与该处并列即可 |
| 逐请求请求体由 `model.request` hook 之后仍可改 `headers` | `model-request.ts:355` | 插件即可完成注入 |
| `SessionAffinity.get = parentID ?? fork?.sessionID ?? id` | `packages/core/src/session/affinity.ts` | 路由用亲和；**不是**协议里的 `session_id` |
| WebSocket 通道 affinity = `url + hash(sorted headers)` | `packages/core/src/session/model-transport.ts` | 逐请求变化的 hint 头会让通道重开 → 核心前置改动 ①（先在 P1 用失败用例确认握手头确实包含它） |
| provider 侧缓存断点（Anthropic 式 `cache_control`）已自动放置 | `packages/ai/src/cache-policy.ts` | 与"网关 KV 保留声明"是两层，需要在提案里讲清 |
| `prompt_cache_key` 来自 affinity；嵌套 fork 有已知 bug | issue #55243；`model-request.ts:333` TODO | 说明"会话身份/血缘"是上游自己在意的痛点 |
| 插件可订阅事件：`ctx.event.subscribe({ types })` | `packages/plugin/src/effect/event.ts` | `stop` 可挂在删除/归档事件上 |
| 官方插件包先例：`packages/plugin-browser`、`packages/gui-plugins` | 仓库结构 | 新插件有合规的落点 |
| presence 只在 UI 层（app/TUI 动画与焦点），无服务端状态 | `packages/app/src/runtime/presence*`、`packages/tui/src/util/delayed-presence.ts` | 焦点暂停需要新增路由 → 核心前置改动 ② |
| 贡献规则：功能需先提 feature request、等设计通过；PR 基于 `dev`；`type(scope): ...`；小 PR；按包 `bun run test` / `bun typecheck` | `CONTRIBUTING.md` | 见 §7 |

## 3. 能力 → 上游扩展点映射

| 本仓库实现 | 上游做法 | 备注 |
| --- | --- | --- |
| `chat.headers` 注入 | `session.hook("model.request")` 改 `event.headers` | 逐请求 |
| `agent ∈ {title, compaction, summary}` 豁免 | `event.kind !== "primary"` → 不发 | 类型化，不再猜名字 |
| `experimental.chat.messages.transform` 快照 | `session.hook("context")` 的 `messages` | 直接是即将发送的消息 |
| `tool.definition` 收集工具集 | `context.tools` 的 key | 精确，无并发交错问题 |
| `chat.message` 判定真实输入 | `session.hook("prompt")` | 精确 |
| `event` hook 记账 | 事件订阅 + `compaction` / `retry` / `experimental.idle` hook | 同步性与顺序由核心保证 |
| 重启后从消息表重建计数 | 核心给出 `call_index` / `epoch`（见 §4） | 插件版仍可降级重建 |
| TUI part + 回环 IPC + 令牌 | presence 路由（客户端上报焦点） | 无 IPC，无端口 |
| `dispose` 时 stop | 实例卸载 hook / 关闭流程 | 需确认插件是否有卸载时机 |
| `chat.headers` 抛错做屏障 | hook 失败即请求失败（`session` 域失败会中止执行） | 语义更清晰，但要控制错误文案 |

## 4. 与上游既有概念的关系（提案里必须写清）

1. **`session_id` ≠ `SessionAffinity`**。`SessionAffinity` 是"哪一组请求共享 provider 缓存"的路由键
   （子代理共享父会话的键）；协议里的 `session_id` 是"这段上下文/KV 前缀属于谁"。子代理有自己的上下文，
   不能把父 id 当 `session_id`，否则两个上下文会被消费端合并。上游的 `fork.sessionID` 才是协议的
   `parent_session_id`（血缘），而且上游已经记录，订阅 `fork` hook 即可——这比本仓库"从不发送父 id"更完整。
2. **`cache_control`（hint）≠ `cache-policy`（provider 断点）**。前者是对"推理服务/网关"的 KV 保留与
   生命周期声明（opt-in、面向自建 vLLM/Motor 一类服务），后者是 provider 线格式里的缓存断点。
   两者可以共存；提案要明确"不开这个功能时线缆与今天完全一致"。
3. **`prompt_cache_key`** 是 provider 级缓存键；hint 里的 `session_id` 是同一身份的另一种表达。可以在
   实现里保证两者一致（`prompt_cache_key` 用 affinity，hint 用真实 session id + fork 血缘）。
4. **`epoch`** 要映射到上游的上下文版本（压缩/裁剪使旧前缀失效），而不是插件自己数。上游已经有
   `context_epoch` 迁移与上下文版本概念，这是把能力收进核心的最强理由。

## 5. 落地方案

### 方案 A：官方插件（改动最小，推荐作为第一步）

新增 `packages/plugin-agent-hints`（官方插件，默认关闭，配置开启）：

```jsonc
"agent_hint": {
  "enabled": true,
  "providers": ["my-gateway"],
  "control": { "endpoint": "https://gw/v1/chat/completions" },   // 默认要求显式配置
  "transport": "http"                                            // WS 会话暂不发 hint
}
```

- 事实来源：`model.request` + `context` + `prompt` + `compaction` + `retry` + `experimental.idle` + 事件订阅。
- 计数：插件内记账（与现仓库一致），并在首次见到会话时从会话历史重建。
- manage 请求：默认要求显式控制端点，避免把空 messages 的 POST 打到普通 provider（我们实测 400）。
- 优点：符合上游"功能先做插件/先设计"的路径；不改变默认行为；可以先在插件生态验证。
- 缺点：拿不到精确的上下文版本；WS 通道需要核心前置改动 ①。

### 方案 B：核心特性（一次到位）

在 `packages/core/src/session/` 新增 `agent-hint.ts`：

- 由 `model-request.ts` 在组装 `LLMRequest` 时调用，直接拿到 `messages`、`tools`、`kind`、`session`。
- 计数与 `epoch` 来自核心的会话事实（事件日志/上下文版本），不再需要重建。
- 生命周期由 `SessionCompaction` 提交、会话删除/归档、实例卸载驱动；presence 由新路由提供。
- 配置进 `packages/schema/src/config.ts`，文档进站点。
- 优点：精确、可测、单一事实来源；缺点：改动面大，需要设计评审与维护者背书。

### 方案 C：分阶段（推荐）

1. **阶段 1（核心前置，2 个小 PR）**
   - ① `model.request` / `ws.handshake` 提供"不参与 affinity 的 header"能力（或明确的 frame 字段），
     保证逐请求变化的头不会重开 WebSocket。验收：#1 个 WS 模型连续 3 个请求只开 1 次连接。
   - ② presence：协议新增 `experimental` 路由（如 `POST /experimental/session/{id}/presence`），
     TUI/app/desktop 在切换会话时上报，服务端保存"哪个客户端在看哪个会话"。
     顺手在 `model.request` 事件里暴露 `affinity`（上游 TODO 已提到），插件就不用 `ctx.session.get`。
2. **阶段 2（官方插件）**：`packages/plugin-agent-hints`，用 §5 方案 A 的输入；presence 走 ②。
3. **阶段 3（收编事实来源）**：把计数、`epoch`、生命周期判定移入核心，插件退化为编码与传输；
   若维护者希望零配置，再把 `agent_hint` 变成核心配置项。

## 6. 分阶段 PR 计划（文件级）

| PR | 范围 | 关键文件 | 验收 |
| --- | --- | --- | --- |
| P1 | 不参与 affinity 的头 | `packages/core/src/session/model-request.ts`、`model-transport.ts`、`packages/plugin/src/effect/session.ts` | 单测：同一 WS 会话连续请求只握手一次；HTTP 行为不变 |
| P2 | presence 路由 + 客户端上报 | `packages/protocol/src/groups/experimental.ts`、`packages/core/src/session/presence.ts`（新）、`packages/tui/src/*`、`packages/app/src/runtime/*`、`packages/client` 生成物 | 协议生成 `bun run generate`；TUI/app 切换会话后服务端能读到焦点 |
| P3 | 插件骨架 + 编码 | `packages/plugin-agent-hints/*`（新包）、`packages/core/src/plugin/hooks.ts` 如需新事件 | 单测：附录 B 的 V1–V10 向量；e2e stub 断言 wire |
| P4 | 生命周期 | 同上 + `compaction`/`experimental.idle`/事件订阅 | e2e：pause/resume/stop/compact + 屏障隔离 |
| P5 | 文档与站点 | `services/site/src/docs/content/`、相关 `AGENTS.md` | 配置说明、wire 契约、降级画像 |

每个 PR 都要：`cd packages/core && bun run test && bun typecheck`（或对应包），conventional title
（`feat(core): ...` / `feat(plugin): ...`），补充变更说明；不要长 AI 文案。

## 7. 上游沟通路径

1. **先提 feature request**（CONTRIBUTING 明确要求功能需先设计通过）。建议标题：
   `[FEATURE]: Session lifecycle hints for prefix-caching inference servers (opt-in header + manage requests)`。
   正文建议只写四点：
   - 问题：自建前缀缓存/网关（vLLM、Motor 等）无法知道会话何时开始/暂停/结束、前缀是否值得保留；
     #55243 / #61318 / #61556 是同一类成本。
   - 方案：opt-in 的 `X-Agent-Hint` 头（会话身份/生命周期/优先级/缓存意图）+ 可配置控制端点上的
     manage 请求；默认关闭，线缆不变。
   - 需要上游配合：① WS 通道不因逐请求变化的头重开；② 客户端上报焦点。
   - 兼容：与 `cache-policy`、`prompt_cache_key` 的分层说明；协议文档链接。
2. 等设计通过后再开实现 PR；第一个 PR 只做 ①（最小、最独立）。
3. 准备的证据：本仓库的 e2e 抓包时间线、真实网关抓包、TUI pty 验证。

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 维护者认为这是厂商私有协议 | 默认关闭、provider 白名单、wire 契约文档化；强调与 `cache-policy` 的分层 |
| WS 重连 | 阶段 1 的核心前置改动，未完成前插件对 WS 会话不发 hint |
| manage 空 messages 被普通 provider 拒绝 | 默认要求显式控制端点；不自动从 `baseURL` 推导 |
| 额外网络请求与失败语义 | 只在显式启用时发；4xx 归类 failed、不重试、不隔离；只有未知结果才隔离 |
| 计数/`epoch` 不精确 | 阶段 3 收进核心；在此之前用"从历史重建 + 首轮抑制"降级 |
| 隐私 | session id 本来就在 `x-opencode-session-id`/`X-Session-Id` 上；hint 不含提示词 |
| PR 太大被拒 | 按 §6 拆成 5 个 PR，先做 P1 |

## 9. 备选：上游不接

- 保持独立插件（现状），发 npm `opencode-agent-hints`，在 README 里写清"需要 V1 API 的 1.18.x"。
- 另提一个更小的上游 PR：只暴露 "affinity + 不参与 affinity 的 header"（P1），让插件能安全地在 WS 会话上工作；
  这类"能力型"小改动更容易被接受。
- 关注上游 2.x 的插件 RPC part（已有 `packages/plugin/src/effect/rpc.ts`）：如果它能把 TUI 与 server 的
  插件通信用起来，本仓库的 IPC 可以整体删掉。

## 10. 已动手（2026-11-27）

本地仓库：`/home/evan/opencode`（`origin` = anomalyco/opencode，`fork` = evan7ang/opencode，基线 `dev@449c128`）。

| 分支 | 内容 | 验证 | 状态 |
| --- | --- | --- | --- |
| `ws-volatile-headers` | P1：`Handshake.volatileHeaders` 不参与 WebSocket 亲和键；`experimental.ws.handshake` 暴露该字段 | 新增 transport 单测（3 请求 1 连接）+ hooks 转发断言；`bun run typecheck`（core/plugin） | 已推到 fork，未开 PR |
| `agent-hint-plugin` | P3a：`agent_hint` 配置项 + 内部插件 `opencode.agent_hint`（编码、wire 计数、TTL、缓存门控、四个 manage 动词、事件驱动 epoch/stop、WS 头 + volatile 标记） | 8 个单测 + 配置归一化测试；core/schema typecheck；prettier/oxlint | 已推到 fork，未开 PR |

对比链接：

- P1：`https://github.com/anomalyco/opencode/compare/dev...evan7ang:opencode:ws-volatile-headers`
- P1+P3a：`https://github.com/anomalyco/opencode/compare/dev...evan7ang:opencode:agent-hint-plugin`

还没做：P2 presence 路由（焦点信号）、P3 的集成测试（用 `PluginTestLayer` 跑 hook 接线）、P4 的屏障/隔离与
真实 e2e。P3a 里 `compact` 与下一次请求之间没有强制屏障（事件订阅是独立 fiber），这是收编进核心事实源
（§5 阶段 3）时要一起解决的。

## 11. 工作量估计（单人、熟悉仓库后）

| 阶段 | 估计 |
| --- | --- |
| P1 不参与 affinity 的头 | 1–2 天 |
| P2 presence 路由 + TUI/app 上报（含协议生成） | 3–5 天 |
| P3 插件骨架 + 编码 + 单测 | 3–5 天 |
| P4 生命周期 + e2e | 3–5 天 |
| P5 文档与评审往返 | 2–3 天 |
| 合计 | 约 2–3 周（不含评审等待） |
