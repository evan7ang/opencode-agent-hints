# 插件分发与官方收录调研

- 日期：2026-11-27
- 对象：本仓库独立插件 `opencode-agent-hints`
- 相关：[`20261127-01-upstreaming-opencode.md`](20261127-01-upstreaming-opencode.md)（把能力合入 opencode 本体）
- 协议：`../../agent-hint-protocol.md` v1.0

## 1. 结论

**没有官方"插件市场/商店"可以上架。** 官方渠道只有两条，且都是"发布到 npm + 被收录进官方列表"：

1. **npm + CLI 安装**：V1 `opencode plugin <module>`，V2 `opencode plugin add <module>`；`opencode.json(c)` /
   `tui.json` 里的 plugin 列表就是"已安装清单"。这是真正的分发通道。
2. **官方文档的 Ecosystem → Plugins 表格**：一张人工维护的表，收录方式是给
   `anomalyco/opencode` 提 PR（文件 `services/site/src/docs/v1/content/ecosystem.mdx`）。
3. 社区聚合（官方文档直接推荐）：`awesome-opencode/awesome-opencode`、`opencode.cafe`。

如果目标是"在官方视野里长期存在"，还有第三条更重的路：**把插件做成 opencode 仓库内的官方包**
（`packages/plugin-*`）。上游贡献规范要求先 feature request、过设计，再提 PR；
[`20261127-01`](20261127-01-upstreaming-opencode.md) 已经按这个方向做过调研。本文件聚焦"独立插件"的分发与收录。

## 2. 调研事实

| 问题 | 事实 | 证据 |
| --- | --- | --- |
| 有官方市场/商店吗 | 没有：`opencode.ai/plugins` 404；V1/V2 文档均无 registry / marketplace / 上架流程页 | 站点探测、`/docs/sitemap.xml`、`/docs/llms.txt` |
| 插件怎么装 | 从 npm / git 安装；V1 是 `opencode plugin <module> [-g] [-f]`，V2 是 `opencode plugin add` | `opencode plugin --help`；`/docs/plugins` |
| Desktop 的 Plugins 页 | 只是已安装列表、开关和 Reload，不是商店 | `/docs/plugins` |
| 官方会收录吗 | 会：Ecosystem 页写明 "Want to add your OpenCode related project to this list? Submit a PR." | `/docs/ecosystem`；源文件同上 |
| 当前稳定版 | `opencode-ai` `latest` = **1.19.6**（V1 线）；`@opencode-ai/plugin` `latest` = 1.19.6 | npm dist-tags |
| V2 状态 | `@opencode/plugin` `latest` = 2.4.2；V2 文档已上线；配置键改成 `plugins` | npm；`/docs/build/plugins` |
| V1 插件能在 V2 跑吗 | **不能**："V1 plugin implementations do not run in V2" | `/docs/build/plugins/migrate-v1` |
| 一个包双版本 | 能：default export 同时带 `setup()`（V2）与 `server()`（V1），V1 需 ≥ 1.18.29 | 同上，"Support V1 and V2 from one package" |
| npm 名字 | `opencode-agent-hints` 未被占用 | registry.npmjs.org |
| 收录页归属 | Ecosystem 页在 V1 文档树下（`docs/v1/content/`），V2 文档暂无对应页 | 仓库路径 + V2 文档索引 |

## 3. 可行的收录路径与成本

| 路径 | 做法 | 门槛 | 成本 | 效果 |
| --- | --- | --- | --- | --- |
| A. npm 发布 | `npm publish`（public，带 provenance） | npm 账号 | 半小时 | 任何人可 `opencode plugin add opencode-agent-hints` |
| B. 官方 Ecosystem 表 | 向 `anomalyco/opencode` 提 PR 加一行 | 人工 review | 1 小时 + 等待 | 官方文档可见，最接近"上架" |
| C. 社区聚合 | 向 awesome-opencode 提 PR；opencode.cafe 提交 | 无 | 半小时 | 社区曝光 |
| D. 官方仓库内置包 | 先 feature request / 设计通过，再提 `packages/plugin-agent-hints` | 高（需维护者认可方向） | 数天到数周 | "官方插件"身份；见 `20261127-01` |

推荐顺序：**A → C → B（在 V2 兼容完成后再提）→ D（可选，与上游方向绑定）**。

## 4. 方案

### P0 发布准备（不依赖外部账号，已完成）

- `package.json` 补 `repository` / `homepage` / `bugs` / `author` / `engines` / `publishConfig`
  （`access: public`、`provenance: true`）。
- 新增 `release.yml`：tag `v*` → typecheck + test + build → `npm publish --provenance`。
- `npm pack --dry-run` 校验打包内容（`dist` + 两个 README + LICENSE）。
- README 增加"从 npm 安装"的 CLI 写法。

### P1 发布到 npm（已完成 2026-11-27）

1. `npm publish --access public` 用 bypass-2FA granular token 发布 `opencode-agent-hints@0.1.0`。
   首次发布被 npm 转成“占位版本” `0.0.0-stage`（"Temporary package placeholder for staged publishing"），
   约 1–2 分钟后公开 packument 转为 `latest=0.1.0`。
2. 干净环境验证（XDG 目录全部隔离）：
   - `opencode plugin opencode-agent-hints` 把包安装到 `~/.cache/opencode/packages/...`，
     并同时写入 `.opencode/opencode.json` 与 `.opencode/tui.json`；
   - `opencode run` 打脚本上游的抓包：标题请求无 hint，主线 `start`（600s@2，`msg_offset == 2`）、
     `append`（60s@4，`msg_offset == 4`），退出时 `stop`。
3. GitHub Actions secret `NPM_TOKEN` 已写入（供 `release.yml` 后续版本使用）。
4. `release.yml` 加了幂等保护：目标版本已存在时跳过 `npm publish`，因此给已发布版本打 tag 也会是绿的。

验收：`npm view opencode-agent-hints version` → `0.1.0`；tarball 可下载；安装后真实 `opencode run` 抓到 hint。

### P2 V2 双入口（建议在 B 之前完成）

V1 插件在 V2 不运行，而 V2 已是 2.4.2。建议一个包同时支持，按官方迁移文档的形态：

```ts
// src/index.ts
import { Plugin } from "@opencode/plugin"

export default {
  ...Plugin.define({ id: "opencode-agent-hints", async setup(ctx) { /* V2 接线 */ } }),
  async server(input, options) { /* 现有 V1 hooks */ },
}
```

V2 侧映射（比 V1 更准，见 `20261127-01` §3）：

| 需求 | V2 扩展点 |
| --- | --- |
| 注入 hint 头 | `ctx.session.hook("http.request", e => e.request.headers.set(...))`；`e.kind ∈ {context,title,compaction,generate}` |
| `msg_offset` / 工具集签名 | `ctx.session.hook("context")` 的 `messages` / `tools` |
| 真实用户输入边界 | `ctx.session.hook("prompt")` |
| 生命周期事件 | `ctx.event.subscribe`：`session.execution.*`、`session.compaction.ended`、`session.archived/unarchived/deleted` |
| 计数持久化 | `ctx.storage`（不再需要从消息表重建） |
| fork 血缘 | `session.forked` / `fork` hook（可首次给出 `parent_session_id`） |
| 焦点信号 | `session.viewed` 事件（服务端可见），IPC/TUI part 可能可以去掉 |

验收：V1（1.18.32 / 1.19.x）与 V2 各自跑通 A、C、D；README 写清版本矩阵。

### P3 收录

1. **官方 Ecosystem 表**（PR 正文模板）：

   ```markdown
   Add to the Plugins table:

   | [opencode-agent-hints](https://github.com/evan7ang/opencode-agent-hints) | Opt-in Agent Hint protocol: session identity, priority and cache intent on every request, plus lifecycle manage requests |
   ```

   PR 描述包含：npm 包名、支持的 opencode 版本、安装一行命令、验证方式（单测数量、e2e 场景、真网关脱敏抓包）、
   安全说明（hint 不含密钥/对话内容，默认关闭时线缆不变）。
2. **awesome-opencode**：同样一行条目（名称 / 链接 / 一句话）。
3. **opencode.cafe**：站点提交入口。

### P4 维护

- 每次 opencode 发布新 minor 后跑 `e2e/run.sh all`，把验证过的版本写进 README 与 `docs/conformance.md`。
- 版本语义：修 bug → patch；新增字段/触发源 → minor（协议增量兼容）。
- 收录后如果 V1 线被 V2 取代，先发 V2 兼容版再在 README 标注。

## 5. 风险

| 风险 | 处理 |
| --- | --- |
| 收录页在 V1 文档树下，未来可能随 V2 迁移 | PR 时一并询问 V2 的收录入口；社区列表兜底 |
| V1 插件在 V2 装不上 | README 明确版本；尽快做 P2；PR 里写清支持区间 |
| 人工 review 慢或拒收 | 先发 npm 与社区列表；PR 附可复现验证；必要时改走"官方内置包"（D） |
| npm 名字被抢注 | 发布前再查一次；必要时用 scope（`@evan7ang/opencode-agent-hints`） |
| 审核对"hook 抛错做屏障"有疑问 | 在 PR/文档里说明：仅当 mutation 结果未知时抛出，错误文案不可重试，默认关闭时不触发 |

## 6. 需要决策

1. **npm 发布**：需要 npm 账号 token（或本地 `npm login` 后我执行）。
2. **P2 顺序**：先发 V1 再补 V2，还是做完双入口再发（推荐后者，收录时更好解释）。
3. **P3 授权**：是否同意用现有 GitHub 账号向 `anomalyco/opencode` 与 `awesome-opencode` 提公开 PR。
4. **D 路线**：是否同时推进"官方内置包"（依赖 `20261127-01` 的 feature request 是否被接受）。
