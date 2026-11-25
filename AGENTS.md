# 仓库开发规范

本文件适用于整个仓库（`opencode-agent-hints`）。协议契约在父目录的
`../agent-hint-protocol.md`，本仓库只实现 opencode 侧的发送方（消费端不在范围内）。

## 目录结构

```text
src/
├── hint.ts            # 四块 wire 对象、verb → edit 映射、base64url（无填充）
├── cache.ts           # TTL 推导、128-token 抑制、前缀签名
├── messages.ts        # wire 消息计数、重启后的计数重建、辅助 agent 判定
├── config.ts          # 选项解析与校验（加载期报错）
├── control-client.ts  # manage 传输：超时、仅 resume 重试、accepted/failed/unknown
├── session-store.ts   # 会话事实状态机、四个动词、屏障与隔离
├── ipc.ts             # TUI ↔ server 回环通道（127.0.0.1 + 实例文件 + 令牌）
├── trace.ts           # 无内容 JSONL 诊断
├── index.ts           # server part：hook 接线（唯一 default 导出）
└── tui/index.ts       # TUI part：轮询 route，发送 focus/blur
tests/                 # vitest（直测 src）
e2e/                   # 抓包 stub、四个场景、真网关脚本、TUI pty 检查
docs/                  # design/ tasks/ evidence/ 实现画像与符合性清单
```

## 命令

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json → dist/
bash e2e/run.sh A   # A/B/C/D 或 all
python3 e2e/tui-check.py
bash e2e/real-gateway.sh [provider/model]
```

## 硬性规则

1. **body 零 hint**：任何 hint 字段都只能出现在 `X-Agent-Hint` 头。
2. **纯函数优先**：wire 构造、取值算法、计数与重建都必须是纯函数，可单测；有状态的部分集中在
   `session-store.ts`。
3. **fail-open**：所有 hook 必须吞掉自身异常并记警告；唯一例外是协议要求的屏障/隔离，用
   `ControlBarrierError` 抛给用户（文案必须避开 opencode 的可重试错误关键词）。
4. **event hook 同步记账**：opencode 的 `event` hook 是 fire-and-forget。状态更新必须在第一个
   `await` 之前同步完成，异步 IO 之后 fire-and-forget。
5. **单导出**：`src/index.ts` 只能 `export default`；opencode 的 V1 loader 会把模块的每个导出都当插件候选。
6. **无凭据落盘**：trace 只记录 hint 与结果，不记录 endpoint、token 或请求体。
7. **辅助请求不记账**：`title` / `compaction` / `summary` 不得推进任何会话计数。
8. 改状态机必须补测试向量（附录 B 的 V1–V10 已覆盖在 `tests/session-store.spec.ts`）。
9. 改 wire 形状必须同步 `docs/implementation-profile.md` 与 `docs/conformance.md`。
10. 文档命名 `docs/design/YYYYMMDD-NN-slug.md`、`docs/tasks/YYYYMMDD-NN-slug.md`。

## 变更检查

- 涉及 hook 行为：跑 `npm test` + `bash e2e/run.sh all`。
- 涉及 IPC/TUI：再跑 `python3 e2e/tui-check.py`。
- 涉及端点/凭据：跑 `bash e2e/real-gateway.sh` 并把脱敏抓包更新到 `docs/evidence/`。
