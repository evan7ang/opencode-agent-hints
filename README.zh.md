# opencode-agent-hints

[Agent Hint 协议 v1](../agent-hint-protocol.md) 的 [opencode](https://opencode.ai) 实现：每条主线模型请求都用
`X-Agent-Hint` 头携带会话身份、生命周期状态、优先级与缓存意图；会话生命周期用独立的 manage 请求
（`pause` / `resume` / `stop` / `compact`）驱动。

请求体一个字节都不改——hint 只在头里，base64url 编码的 JSON，无填充。

已发布到 npm：[`opencode-agent-hints`](https://www.npmjs.com/package/opencode-agent-hints)。

- 符合性：**L1 + L2 + L3-lite**（焦点驱动的 pause/resume、归档 → stop；草稿信号未实现，
  见[实现画像](docs/implementation-profile.md)）。
- opencode 基线：**1.18.x**（V1 插件 API，`@opencode-ai/plugin`）。
- 运行时零依赖，TypeScript 直接编译成 ESM。

## 安装

```bash
# opencode 1.x（V1 插件 API）：安装包并更新配置
opencode plugin opencode-agent-hints          # 加 -g 写入全局配置
```

插件分两半。opencode 从 `opencode.json` 加载 **server** 插件，从 `tui.json` 加载 **TUI** 插件。
包同时导出两部分，所以上面的 CLI 会把两个条目都写好；手工接线时记得自己补 `tui.json`。

```jsonc
// ~/.config/opencode/opencode.json（或项目里的 opencode.json）
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-agent-hints", { "sessionControl": { "enabled": true } }]
  ]
}
```

```jsonc
// ~/.config/opencode/tui.json —— 只有需要“焦点驱动 pause/resume”时才必须
{
  "plugin": ["opencode-agent-hints"]
}
```

本地开发可以用绝对路径（两个文件里分别写 `["/path/to/opencode-agent-hints", { ... }]` 和
`"/path/to/opencode-agent-hints"`）。改完配置要重启 opencode。

## 交互观察（本地调试）

不修改全局配置，用额外的 `OPENCODE_CONFIG` 启动 opencode，并打开插件 trace：

```bash
bash scripts/opencode-hint-demo.sh
# 另一个终端
npm run hint:watch
```

- `scripts/opencode-hint-demo.sh` 生成 `$TMPDIR/opencode-agent-hints-demo/opencode.json`，
  只追加本插件和 `trace.file`，再 `exec opencode`；全局 provider/凭据/已有插件保持不变。
- trace 写在 `$TMPDIR/opencode-agent-hints-demo/trace.jsonl`，每行是一条普通或 manage 请求的
  完整 hint（无请求体、无凭据）。
- `npm run hint:watch` 默认跟随上面的文件，打印 `state` / `call_index` / `epoch` /
  `priority` / `cache_control` / manage 结果，以及可直接对照的 base64url header。
  可选 `--file <path>`、`--tail <n>`、`--all`、`--json`、`--once`。

## 线上形态

```http
POST /v1/chat/completions
X-Agent-Hint: eyJzZXNzaW9uIjp7InNlc3Npb25faWQiOi...
content-type: application/json

{ "model": "...", "messages": [ ... ], "stream": true }   ← 不变
```

解码后的 hint（全新会话首条）：

```json
{
  "session": { "session_id": "ses_...", "call_index": 1, "epoch": 0, "state": "start" },
  "priority_control": { "priority": { "level": 3, "reason": "user_waiting" } },
  "cache_control": { "type": "ephemeral", "ttl_s": 600, "msg_offset": 2 }
}
```

- `msg_offset` 等于真实 wire body 里的消息条数（`len(body.messages)`），也就是消费端校验的口径。
  插件复刻了 harness 的消息转换规则，形状不确定时**宁可少算**，保证声明不会因为越界被丢弃。
- 辅助调用（标题生成、压缩摘要）**不带** hint。
- 同一次调用的重试复用完全相同的 hint（`call_index` 不变）。
- 对 `@ai-sdk/openai-compatible` 的 provider，manage 请求发到 `<baseURL>/chat/completions`，
  占位 body 是 `{"model":"…","messages":[],"stream":false}`。

## 生命周期触发源

| state | 触发 | 说明 |
| --- | --- | --- |
| `start` / `append` | 每条主线请求 | `start` 每会话恰好一次：仅当这条调用之前会话没有任何历史 |
| `pause` | TUI 焦点离开一个空闲会话；没有 TUI 时，另一会话请求被接受而本会话空闲 | 每个暂停周期一次，且无在途流 |
| `resume` | 暂停过或带历史的会话下次请求前；TUI 聚焦到这类会话时 | 在主线请求放行前等待它被接受 |
| `stop` | 会话删除、归档、插件卸载 / 进程退出 | 退出时尽力而为（协议允许丢失） |
| `compact` | `session.compacted`（epoch + 1）与工具输出被 prune | `compact` 携带**旧** epoch；紧随其后的请求带新 epoch，并抑制一轮缓存声明 |

`parent_session_id` 从不发送：opencode 不记录 fork 血缘，子代理的 `parentID` 表示创建者而非上下文父，
协议禁止这样声称。

## 配置

配置在加载期校验一次；非法配置直接让插件加载失败，而不是请求中途悄悄降级。

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `providers` | `[]`（全部） | 生效的 provider id glob |
| `priority` | `"dynamic"` | `"omit"` / `"dynamic"`（轮次开局 3/`user_waiting`，其余 1/`critical_path`）/ 静态 `{ level, reason }` |
| `cacheControl` | `"dynamic"` | `"omit"` / `"dynamic"` / 静态 `{ ttl_s, msg_offset? }` |
| `sessionControl.enabled` | `true` | 是否发 manage 请求（关闭后仍注入 hint 头） |
| `sessionControl.endpoint` | 推导 | 显式 manage URL；默认 `<baseURL>/chat/completions` |
| `sessionControl.pendingOpAwaitMs` | `5000` | 主线请求等待在途 mutation 的上限 |
| `sessionControl.controlTimeoutMs` | `5000` | 单次 manage 超时 |
| `sessionControl.retries` | `1` | 仅 `resume` 对明确瞬态拒绝重试 |
| `focus.enabled` | `true` | 接受 TUI 部分的焦点信号 |
| `trace.enabled` / `trace.file` | `false` / stdout | 无内容的 JSONL 诊断 trace |

## 验证

```bash
npm install
npm run typecheck
npm test                 # 62 个单测：wire 向量、状态机、IPC、control client
bash e2e/run.sh all      # 真 opencode 进程 + 脚本化上游（A–D 四个场景）
python3 e2e/tui-check.py # pty 里跑真 TUI，验证焦点/失焦信号
bash e2e/real-gateway.sh # 通过 agent-hint-watcher 打真网关（需要本机配置）
```

e2e 场景驱动真实的 `opencode run` / `opencode serve`，并对抓到的字节做断言：`start` 唯一、
后续 `append`、辅助请求豁免、`msg_offset == len(body.messages)`、重试复用、收养后提前 `resume`、
headless pause/resume、焦点 pause/resume、溢出 → compact → 重试保持旧 epoch、卸载时 `stop`。
场景抓包在 `e2e/.tmp/`；脱敏后的真网关抓包在 [`docs/evidence/`](docs/evidence/)。

## 已知限制

- 普通 OpenAI 兼容网关会用 `400` 拒绝空 messages 的 manage 请求。这会被归类为 `failed`
  （不重试、不隔离）；配套的 Agent Hint 消费端会接受它。详见[实现画像](docs/implementation-profile.md)。
- 没有草稿信号：`resume` 在 TUI 聚焦会话时触发，而不是在打字时。
- 暂不支持 opencode 2.x（`Plugin.define`、RPC part）。
- Desktop / web 客户端没有焦点信号，生命周期退回 headless 触发源。

## 合入上游

合入 opencode 本体的可行性调研与分阶段方案：[`docs/design/20261127-01-upstreaming-opencode.md`](docs/design/20261127-01-upstreaming-opencode.md)。
