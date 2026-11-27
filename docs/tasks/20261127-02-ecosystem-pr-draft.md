# Ecosystem 收录 PR 草稿（待发布后提交）

- 目标仓库：`anomalyco/opencode`（默认分支 `dev`）
- 目标文件：`services/site/src/docs/v1/content/ecosystem.mdx`
- 分支名建议：`docs/ecosystem-agent-hints`
- 前置：npm 包已发布（`opencode-agent-hints@0.1.0`）

## 改动

在 `## Plugins` 表格末尾追加一行：

```markdown
| [opencode-agent-hints](https://github.com/evan7ang/opencode-agent-hints)                           | Send the Agent Hint protocol to prefix-caching inference gateways: session identity, priority and cache intent on every request, plus pause/resume/stop/compact lifecycle requests |
```

## PR 标题

```text
docs(ecosystem): add opencode-agent-hints
```

## PR 正文

```markdown
Adds `opencode-agent-hints` to the Ecosystem plugin list.

**What it does**

It sends the Agent Hint protocol (`X-Agent-Hint`, base64url JSON) to inference gateways that manage
prompt-cache / KV retention for self-hosted serving (vLLM, MindIE, custom coordinators):

- per main-line request: session id, call index, context epoch, `start`/`append`, a two-level soft
  priority, and an optional ephemeral cache-retention declaration (TTL + message offset);
- out of band: `pause` / `resume` / `stop` / `compact` requests with an explicit session edit.

The request body is never modified — the hint is one header. Auxiliary calls (title generation,
compaction summaries) never carry it.

**Install**

```bash
opencode plugin opencode-agent-hints
```

Works on the V1 plugin API (opencode 1.18.29 – 1.19.x). The package also exports a TUI part that
reports focus changes for `pause`/`resume`; the CLI writes both config entries.

**Verification**

- 62 unit tests; 4 headless end-to-end scenarios drive real `opencode run` / `opencode serve`
  processes against a scripted upstream and assert on captured bytes (`start` once, `append`
  afterwards, auxiliary exemption, `msg_offset == len(body.messages)`, retries reuse the hint,
  adoption + early `resume`, headless and focus-driven pause/resume, overflow → compact → retry
  with the old epoch, `stop` on dispose);
- the TUI part is verified by driving the real TUI in a pty;
- a real-gateway run through a transparent proxy is committed as sanitized evidence
  (`docs/evidence/real-gateway-*.jsonl`).

**Safety**

The hint carries only the session id, integer counters and closed enums: no prompt text, no
credentials. The diagnostic trace is content-free. Lifecycle requests reuse the data-plane
credential only for the same origin. Providers that do not understand the header simply ignore it.
```

## 提交前检查

- [x] npm 包可见：`npm view opencode-agent-hints version` → `0.1.0`
- [x] 干净环境按 README 安装成功，`opencode run` 抓到 `X-Agent-Hint`
- [ ] 本仓库 README 顶部写明支持的 opencode 版本区间
- [ ] PR 只改 `ecosystem.mdx`，不加其他文件
