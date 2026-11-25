# opencode Agent Hint 插件：设计与决策

- 日期：2026-11-25
- 协议：`agent-hint-protocol.md` v1.0（2026-11-25）
- 目标：L1 + L2 + L3-lite，opencode 1.18.x（V1 插件 API）
- 参考实现：[`dsh-agent-hints`](https://github.com/evan7ang/dsh-agent-hints)

## 1. 已核实的 opencode 事实

全部对照 `anomalyco/opencode` 的 `v1.18.32` 源码与本机二进制，并用 e2e 实测确认。

| 事实 | 结论 | 影响 |
| --- | --- | --- |
| 注入点 | `chat.headers` 入参带 `sessionID / agent / model / provider / message`，输出 headers 在 provider 与 model headers 之后合并 | 可以只加一个头，body 零改动 |
| 自带身份头 | opencode 自己发送 `x-session-affinity`、`X-Session-Id`（子会话还有 `x-parent-session-id`） | 属于身份头而非 hint，保留；hint 的 `session_id` 与它们一致 |
| 辅助调用 | 标题 = `title` agent（小模型），压缩摘要 = `compaction` agent；内置隐藏 agent 只有 `compaction / title / summary` | 按 agent 名豁免，不靠猜内容 |
| 重试 | processor 对 429/5xx/网络错误做 `Effect.retry`，每次重试重新触发 `chat.headers`；AI SDK 层主线 `maxRetries: 0` | 必须按“同一逻辑调用”返回同一份 hint |
| 溢出 | provider 返回上下文超长 → `ContextOverflowError` → `needsCompaction` → 压缩 → 重放/续接；usage 超阈也会触发压缩 | 压缩后用 `session.compacted` 记 epoch；重试那一步保持 `call_index` |
| 历史改写 | `session.compacted` 只在压缩成功时发布；`compaction.prune` 会给旧工具结果写 `time.compacted`，没有专用事件 | epoch 只认这两者；revert（尾部截断）保留原前缀，不计 |
| 上下文快照 | `experimental.chat.messages.transform` 在每次主线请求前给出消息列表（含 reminders，压缩后的裁剪视图） | `msg_offset`、前缀 token、轮次开局都从这里取 |
| 会话历史 | `client.session.messages` 返回**完整**历史（含压缩前消息） | 重启后重建 `call_index` / `epoch` |
| 事件 hook | `event` hook 是 fire-and-forget（`void hook.event(...)`），并按目录过滤 | 记账必须同步；异步 IO 之后 fire-and-forget |
| hook 抛错 | `trigger` 用 `Effect.promise`，抛错会进入 processor 的 `Effect.catchCauseIf → fail → retry(policy) → catch(halt)` | 唯一可控的“失败”方式；文案要避开可重试关键词 |
| 子代理 | `task` 创建 `parentID` = 创建者的新会话，上下文独立 | 子会话是自身主线；`parent_session_id` 不能填创建者 |
| fork | `Session.fork` 复制消息但不记录血缘 | 无法得出父 id → 省略（SHOULD 级降级） |
| TUI 插件 | 1.18 从 `tui.json` 加载 TUI part（不是 `opencode.json` 的 plugin 列表）；`api.route.current` 可轮询；`session_prompt` 是 `mode: "replace"` | 焦点信号可行；草稿信号要替换输入框，风险高 |
| TUI→server 通道 | V1 没有官方通道（`tui.publish` 只接受 3 种事件；RPC part 是 2.x） | 自建回环 IPC |
| 本地插件加载 | 目录 spec 走 package.json exports；V1 loader 把模块**每个导出**当插件候选 | `src/index.ts` 只能 default 导出 |

## 2. 决策记录

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 目标 L3-lite：焦点 + 归档，不做草稿信号 | 替换 `session_prompt` slot 读草稿，slot 是 replace 语义，写错会让用户无法输入；焦点用 `route.current` 轮询即可，零 UI 风险 |
| D2 | 仓库：父目录 `agent-hint-plugins/`，`opencode-agent-hints/` 独立 git 仓库，根目录即包 | 与 dsh / langchain 仓库同构，后续每个 harness 一个仓库 |
| D3 | provider 范围：普通请求跟随会话 provider/model 全量；manage 对所有 provider 按 `${baseURL}/chat/completions` 推导，可显式覆盖 | 目标是配套推理服务；4xx 归类为 failed，不隔离 |
| D4 | pause：有 TUI 连接时只认“焦点离开 + idle + 无在途流”；无 TUI 回退到“本会话 idle 且另一会话请求被接受” | 焦点观察更准确；回退覆盖 `opencode run/serve` |
| D5 | 退出路径发 `stop`；删除、归档发 `stop` | 按协议字面执行 |
| D6 | 改写：`compact` + prune；revert 不算 | 只有替换/裁剪中段才让旧前缀失效；revert 是尾部截断 |
| D7 | 计数：首次见到会话时从 `client.session.messages` 重建 | 消费端“旧 epoch 忽略”的规则让重启归零不可接受；重建避免倒退回退 |
| D8 | 溢出 → 压缩 → 重试保持 `call_index` | 协议场景 C 的断言；用“上一调用未正常结束（无 error 只有 completed、或有 error）+ 期间发生压缩”识别 |
| D9 | 前缀签名：模型 + `tool.definition` 收集的工具名（尽力而为），并发交错时只会多抑制 | 少发优于错发 |
| D10 | 屏障：在途 mutation 最多等 5 秒，结果未知则隔离；在 `chat.headers` 抛不可重试的明确错误 | 源码确认这种错误不会重试、不会拖垮服务 |
| D11 | `session_id` 直接用 opencode 会话 id | 它本来就随 opencode 的身份头上线路；随机 id，无隐私内容 |
| D12 | TUI ↔ server：127.0.0.1 随机端口 + 实例文件 + 令牌 | 三平台通用、双向，以后可扩展状态查询 |

## 3. 架构

```text
chat.headers ─┐
messages.transform ─┤
tool.definition ─┼─▶ SessionStore ──▶ hint 对象 ──▶ header
chat.message ────┤        │
bus events ──────┤        ├──▶ ControlClient ──▶ manage 请求
TUI IPC ─────────┘        └──▶ TraceWriter
                    ▲
        client.session.messages（首次见到会话时重建计数）
```

- 纯函数：`hint.ts` / `cache.ts` / `messages.ts`（可单测、可重放）。
- 状态：`session-store.ts` 一个门店，按 `session_id` 记账；bus 事件同步更新，异步动作后置。
- 传输：`control-client.ts` 只做 HTTP 与结果分类；超时/重试策略与协议条款一一对应。
- 通道：`ipc.ts` 服务端监听、TUI 侧发送；实例文件按项目目录哈希命名，权限 0600。

## 4. 里程碑与状态

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 脚手架、纯函数核心、V1–V10 单测 | 完成 |
| M1 | L1 注入 + e2e A/D 雏形 | 完成（A1、A2、重试、辅助豁免） |
| M2 | L2 生命周期 + 屏障隔离 + e2e B/C | 完成 |
| M3 | L3-lite：IPC、TUI part、焦点逻辑、归档 | 完成（真 TUI pty 验证） |
| M4 | 真网关抓包、实现画像、符合性清单 | 完成 |

## 5. 风险与未验证项

- `experimental.chat.messages.transform`、`experimental.chat.system.transform`、`tool.definition` 都是
  V1 时代接口，opencode 2.x 可能移除；已锁定 1.18.x 并在缺失时 fail-open 降级。
- 焦点检测依赖 `api.route.current` 的轮询语义；真 TUI 已验证，但若未来 route 对象变为不可轮询，
  只会失去焦点信号（退回 headless 触发）。
- 桌面 / web 客户端没有 focus 信号，无法触发焦点 pause。
- 真实网关是普通 OpenAI 兼容代理，manage 请求返回 400：协议要求“配套消费端”接受空 messages，
  这是部署侧而非插件侧问题；插件按 failed 处理，不重试、不隔离。
