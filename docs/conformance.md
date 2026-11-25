# 符合性清单（Agent Hint v1 · opencode）

基线：opencode 1.18.32，`npm test`（62 项）、`bash e2e/run.sh all`（A1/A2/B/C/D，280 项断言）、
`python3 e2e/tui-check.py`、`bash e2e/real-gateway.sh`（22 项断言）。

- [x]：已实现并有自动化证据；[~]：按协议降级并记录；[ ]：未实现。

## 传输（W）

- [x] W-01 hint 只在 `X-Agent-Hint` 头（e2e 断言头存在、body 无 hint）
- [x] W-02 请求 body 不含任何 hint 字段（`tests/verify` + stub 抓包 `hintInBody=false`）
- [x] W-03 base64url、无填充、UTF-8、合法 JSON（`tests/hint.spec.ts`）
- [x] W-04 单头值，典型约 250–350 字节（e2e 抓包实测）
- [x] W-05 辅助请求无 hint（A1/C：标题与压缩摘要请求 `hint=null`）
- [x] W-06 无会话身份的请求无 hint（无 `sessionID` 直接跳过）
- [x] W-07 重试复用同一 hint（`tests/session-store.spec.ts` “reuses the identical hint”；processor 级重试验证）
- [x] W-08 hint 中无密钥、token、隐私内容（只有会话 id、计数、枚举）

## 会话（S）

- [x] S-01 `session_id` 会话内稳定、跨会话唯一（e2e 与 `x-session-id` 一致）
- [~] S-02 `parent_session_id` 省略：fork 无血缘、子代理 `parentID` 是创建者（见实现画像）
- [x] S-03 `call_index` 从 1 起、含本次、单调不减、重试不增（A1/A2/C + 单测）
- [x] S-04 `epoch` 从 0 起、每次改写 +1、重启后从存储重建（C + 单测）
- [x] S-05 每个 hint 都有 `state`（e2e 不变量）
- [x] S-06 `start` 每会话恰好一次；带历史用 `append`（A1/A2）
- [x] S-07 并发/乱序下 hint 仍是请求级确定值（每请求快照 + 按会话记账）
- [x] S-08 新会话（fork/子代理）使用新的 `session_id`（opencode 天然保证）

## 优先级（P）

- [x] P-01 每条普通请求带 `priority_control`（除非配置 `omit`）
- [x] P-02 轮次开局 = 3/`user_waiting`（A1 首条、A2 收养后首条）
- [x] P-03 续接 = 1/`critical_path`（A1 工具续接、C 重试）
- [x] P-04 level/reason 成对且语义一致（配置期与运行期都校验）
- [x] P-05 manage / 辅助请求不带 priority（e2e 不变量）

## 缓存（C）

- [x] C-01 单个 `ephemeral` 对象
- [x] C-02 `ttl_s ∈ [60,3600]`；无样本时 600（A1 首条 600s；单测覆盖边界）
- [x] C-03 `msg_offset` = wire 消息数，≥ 1（所有带声明的请求逐一断言相等）
- [x] C-04 改写当轮抑制（C：重试那轮无声明，随后恢复）
- [x] C-05 模型/工具集签名变化当轮抑制（V10 单测）
- [x] C-06 前缀 < 128 token 时抑制（单测 + 短会话实测无声明）
- [x] C-07 重启后首轮抑制（A2：收养后首条无声明）
- [x] C-08 manage / 辅助请求不带 cache（e2e 不变量）

## 生命周期（L）

- [x] L-01 `start` 触发正确（A1）
- [x] L-02 `append` 覆盖其余主线请求（A1/A2/B/C）
- [x] L-03 `pause` 在“空闲 + 无在途流 + 离开”时发出且去重（B 回退触发、D 焦点触发；单测覆盖 busy 不 pause）
- [x] L-04 `resume` 在暂停/带历史会话再次使用前发出且去重（A2/B/D）
- [x] L-05 `stop` 在会话结束（删除/归档/卸载）时发出（单测 + A1 卸载；退出可能丢失已记录）
- [x] L-06 `compact` 在改写提交后发出、携带旧 epoch；下一条请求 epoch+1（C）
- [x] L-07 `state` 与 `edits[].type` 始终一致（`STATE_EDIT` 单一来源）
- [~] L-08 缺失触发源按画像降级（草稿信号、fork 血缘、退出 stop 已记录）

## Manage（M）

- [x] M-01 动词只出现在 manage 请求（e2e 不变量）
- [x] M-02 `manage_request === true`（布尔）（e2e）
- [x] M-03 恰好一个 edit，type 正确，target 为 `session`（e2e）
- [x] M-04 body 为占位 `{model, messages: [], stream: false}`（e2e：`messageCount=0`、`stream=false`）
- [x] M-05 凭据仅在控制端点与数据面同源时转发（`resolveConnection` 单测）
- [x] M-06 manage 只含四个动词（类型 + 状态机）
- [x] M-07 同会话串行 + 变更屏障（`pendingOp` 队列，主线请求等待/失败）
- [x] M-08 未知结果进入隔离，抛明确错误（单测：unknown → `ControlBarrierError`；超时同样）
- [x] M-09 只有 `resume` 可对明确瞬态拒绝重试（单测：pause 503 → unknown 不重试；resume 503 → 重试）
- [x] M-10 卸载后不再派发；退出 stop 丢失已记录（`dispose()` 先派发后置位）

## 消费端（R）

不适用：本仓库只实现发送方。

## 未验证

- 真实 Agent Hint 消费端（配套推理服务）接受 manage 请求：本地真实网关是普通 OpenAI 兼容代理，
  以 `400` 拒绝空 messages。插件按 `failed` 处理；接受行为需在配套服务上复核。
- Desktop / web 客户端的焦点信号（它们不发送）。
- opencode 2.x 插件 API。
