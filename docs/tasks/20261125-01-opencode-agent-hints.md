# 任务：opencode Agent Hint 插件首版（L1 + L2 + L3-lite）

- 日期：2026-11-25
- 设计：[`../design/20261125-01-opencode-agent-hints.md`](../design/20261125-01-opencode-agent-hints.md)
- 协议：`../../agent-hint-protocol.md` v1.0

## 范围

1. 纯函数核心：wire 对象与编码、TTL / 128-token / 签名、wire 消息计数、重启计数重建、配置校验、
   manage 传输与结果分类。
2. server part：`chat.headers` 注入、快照与优先级、生命周期四动词、屏障与隔离、归档/删除/退出 stop。
3. TUI part：轮询 route，经回环通道发送 focus/blur。
4. 验证：62 个单测、脚本上游 e2e（A1/A2/B/C/D）、真 TUI pty 检查、真网关抓包。

## 验收

- [x] `npm run typecheck`、`npm run build`、`npm test` 全绿
- [x] `bash e2e/run.sh all`：A1 47、A2 49、B 75、C 67、D 42 项断言通过
- [x] `python3 e2e/tui-check.py`：真实 TUI 发出 focus/blur
- [x] `bash e2e/real-gateway.sh`：22 项断言通过，脱敏抓包入库
- [x] 实现画像、触发源登记表、符合性清单入库

## 已知未验证

- 配套消费端接受空 messages 的 manage 请求（本地真实网关是普通 OpenAI 兼容代理，返回 400）
- Desktop / web 客户端焦点信号
- opencode 2.x 插件 API
