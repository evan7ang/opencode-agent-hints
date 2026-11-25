# 实现画像（Agent Hint v1 · opencode）

对应协议 §12.4 的降级画像与 §7.5 的触发源登记表。基线：opencode 1.18.32（V1 插件 API）。

## 能力清单（§12.1）

| 能力 | 本实现 | 说明 |
| --- | --- | --- |
| 请求出口 | ✅ | `chat.headers` hook，只加请求头 |
| 会话身份 | ✅ | `chat.headers.sessionID`，与 opencode 自带身份头一致 |
| 请求分类 | ✅ | 按 agent 名豁免 `title` / `compaction` / `summary` |
| 会话事实 | ✅ | 事件驱动 + 首次见到会话时从 `client.session.messages` 重建 |
| 独立 HTTP 出口 | ✅ | `fetch` + 回环自管通道；端点由 provider `baseURL` 推导，可显式覆盖 |

## 降级画像（§12.4）

| 能力缺失 | 本实现 | 影响 |
| --- | --- | --- |
| 无持久事件日志 | **有替代**：重启时从 opencode 消息存储重建 `call_index` / `epoch` | prune 批次无法重建，重启前多次 prune 时 epoch 可能偏小 |
| 无用户输入边界 | `chat.message` / `command.execute.before` 标记真实输入；压缩后的重放/续集不计 | 无 |
| 无间隔观测 | 用 assistant 消息 `time.completed` → 本次请求的时间差 | 无 |
| 无草稿信号 | **降级**：`resume` 在 TUI 聚焦或请求前发送，不在打字时 | 预取提前量 = 聚焦时刻，不是首个按键 |
| 无 focus 信号（Desktop / web / 纯 headless） | **降级**：回退到“本会话 idle 且另一会话请求被接受” | 单会话 headless 场景不发 pause |
| 无归档事件 | ✅ 归档（`session.updated.time.archived`）→ `stop` | 无 |
| 无法估算前缀 | 快照文本 + system 提示的 CJK 近似估算；拿不到快照时整块省略 `cache_control` | 无 |
| fork 血缘 | **缺失**：opencode 不记录；`parent_session_id` 从不发送 | 消费端看不到 fork 亲属关系 |
| 进程退出 stop | **尽力而为**：`dispose` 内最多等 1.5 秒 | 退出竞争可能丢失（协议允许） |
| 纯 OpenAI 兼容网关 | manage 空 messages 被 400 拒绝 | 结果 = `failed`，不重试、不隔离；配套消费端才接受 |
| opencode 2.x | 不支持 | 需要新的插件 API / RPC part |

## 触发源登记表（§7.5）

| state | 本 harness 的触发源 | 是否必需 | 缺失时的降级 |
| --- | --- | --- | --- |
| `start` / `append` | `chat.headers`；首次见到会话时用 `client.session.messages` 判断是否带历史 | 必需 | 无 |
| `pause` | 有 TUI：焦点离开（IPC `blur`）+ 状态 `idle` + 无在途流。无 TUI：另一会话主线请求被接受 + 本会话 `idle` | L2/L3 | 二者皆无 → 不发 pause |
| `resume` | ① 暂停过或带历史的会话下次请求前（`chat.headers` 内等待接受）② TUI 聚焦（IPC `focus`）③ 首次见到带历史会话且 TUI 聚焦 | L2 | 仅在请求前发 |
| `stop` | `session.deleted`；`session.updated` 新出现 `time.archived`；`dispose` / `server.instance.disposed` | L2/L3 | 退出时可能丢失 |
| `compact` | `session.compacted`（epoch+1，带旧 epoch）；旧工具结果新增 `time.compacted`（prune，1 秒窗口合并） | L2 | 不发送 compact |
| `parent_session_id` | 不发送（无可靠来源） | 可选 | 省略 |

## 取值来源（§6.1）

| 事实 | 来源 |
| --- | --- |
| 会话调用计数 | `chat.headers` 派发时自增；首见会话时 `completedCalls + 1`（完成的 assistant 消息数） |
| 历史改写计数 | 首见会话时统计“有已完成摘要的压缩 user 消息”；运行期按事件 +1 |
| 用户输入边界 | `chat.message` / `command.execute.before`；压缩后的重放/续集消息不由这两个 hook 产生 |
| 上次响应结束时刻 | assistant `message.updated` 的 `time.completed` |
| 当前前缀签名 | `providerID/modelID` + `tool.definition` 收集的工具 id（尽力而为） |
| 上次前缀签名 | 进程内按会话保存；重启后未知 → 首轮抑制 |
| 是否带历史 | 首见会话时，当前 user 消息之外存在非在途消息 |
| `msg_offset` | `messages.transform` 快照按 wire 口径计数（system + user + assistant + 每个 tool 结果） |
| 长度估算 | 快照文本 + `experimental.chat.system.transform` 的 system 文本，CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token |

## 有意省略的字段

| 字段 | 原因 |
| --- | --- |
| `session.parent_session_id` | fork 无血缘记录；子代理 `parentID` 是创建者，协议禁止 |
| `edits[].start/end` | v1 不允许 |
| `v`（版本字段） | v1 不引入 wire 版本 |

## 证据

| 证据 | 位置 |
| --- | --- |
| 单测（62） | `tests/`，`npm test` |
| 脚本上游 e2e（A/B/C/D） | `e2e/run.sh all`，抓包在 `e2e/.tmp/<phase>/cap-*.jsonl` |
| 真 TUI 焦点信号 | `python3 e2e/tui-check.py`（pty 驱动真 TUI） |
| 真网关抓包（脱敏） | `docs/evidence/real-gateway-*.jsonl` |
| 真网关结果摘要 | `bash e2e/real-gateway.sh` 输出：22 项断言，`stop:failed(400)`（普通网关拒绝空 messages） |
