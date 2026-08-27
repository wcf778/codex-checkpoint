<p align="center">
  <img src="assets/context-checkpoint-logo.png" alt="Codex Checkpoint 标志" width="144">
</p>

<h1 align="center">Codex Checkpoint</h1>

<p align="center"><strong>让长任务跨过上下文压缩，仍能接着做。</strong></p>

<p align="center">默认只做确定性的增量记录；需要时，再恢复有边界的语义状态。</p>

<p align="center">
  <a href="https://github.com/wcf778/codex-checkpoint/actions/workflows/ci.yml"><img src="https://github.com/wcf778/codex-checkpoint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/wcf778/codex-checkpoint/releases/latest"><img src="https://img.shields.io/github/v/release/wcf778/codex-checkpoint?display_name=tag&sort=semver" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#验证结果">验证结果</a> ·
  <a href="README.md">English</a> ·
  <strong>简体中文</strong>
</p>

Codex Checkpoint 为长时间运行的 Codex 任务补上一层恢复机制：在原生 compact 前后记录 transcript 增量与已提交 cursor，并且只在状态仍与当前 transcript 匹配时，恢复一份精简的任务状态。

Codex 原生 compact 继续负责主要的语义压缩。默认 Hook 路径完全确定：不启动模型、不访问网络，也不向目标仓库写入状态。

## 快速开始

**环境要求：** 支持命令型生命周期 Hook 和插件机制的 Codex，以及 Node.js 18 或更高版本。Git 可选。

### 安装

```bash
codex plugin marketplace add wcf778/codex-checkpoint
codex plugin add context-checkpoint@context-checkpoint
```

重启 Codex，在提示时检查并批准 command hooks，然后新建任务。机械检查点会自动开始工作。

在交接点或阶段边界保存语义状态：

```text
$context-checkpoint 刷新当前任务检查点
```

随后在发送下一条普通 prompt 之前执行 compact。若先提交了新 prompt，插件会让待恢复状态失效，而不是把新增工作误判为已经覆盖。

该 Skill 只支持显式调用，可能不会出现在初始自动 Skill 列表中。安装或更新后，请在新任务中选择 `$context-checkpoint`；若仍看不到新版本，再重启 Codex。

仓库与 marketplace 名称是 `codex-checkpoint`。为保持兼容，安装后的插件 id 仍为 `context-checkpoint`。如需使用推荐的原生 compact 提示词，请将 [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) 合并到目标仓库的 `.codex/config.toml`。

## 它增加了什么

| | 仅使用原生 compact | 加上 Codex Checkpoint |
| --- | --- | --- |
| Transcript 历史 | 没有插件维护的增量记录 | 每个 generation 只捕获尚未处理的字节 |
| 恢复 cursor | 没有插件维护的已提交 cursor | 写入中断后仍可协调的持久 cursor |
| 语义恢复 | 只依赖原生压缩后的上下文 | 可选的有界任务状态，只注入一次 |
| 过期状态 | 没有独立的插件校验 | source 替换、重写或身份不符时 fail closed |
| 默认开销 | 原生行为 | 本地确定性 Hook；不调用模型或网络 |

它刻意只做一件小事：提供可检查的恢复层。它不是 daemon、数据库、向量检索，也不是一套新的长期记忆系统。

## 三种工作方式

### 机械检查点——默认

生命周期 Hook 记录 transcript 增量、工作区身份、checkpoint generation 与已提交 cursor。这个路径不会生成或注入语义任务状态。

### 手动语义恢复——显式调用

`$context-checkpoint` 保存一份有边界的任务记录，包括 Goal、Constraints、Decisions、Progress、Do not retry、Open questions、Acceptance criteria 与 Next actions。只有 checkpoint 足够新、Goal 非空且至少包含一条 Next action 时，才允许恢复。

### Semantic sidecar——主动启用

Sidecar 可按 generation 周期与累计 unseen bytes 阈值刷新同一份记录。它默认关闭，也是唯一会在后台启动已配置 Codex 模型/网络请求的路径。

## 恢复流程

```text
Codex 任务
  ├─ PreCompact           捕获尚未处理的 transcript 字节
  ├─ 原生 compact         主要语义压缩
  ├─ PostCompact          提交 generation + cursor
  │    └─ SessionStart    可补齐一次精确匹配但遗漏的 PostCompact
  └─ 恢复
       ├─ SessionStart(compact)   根任务一次性恢复
       └─ UserPromptSubmit        首个匹配提示 / semantic 子任务兜底
```

只有当已保存 snapshot 仍是同一 transcript source 的前缀时，恢复才会通过。匹配的生命周期路径允许同源追加；source 被替换、原地重写或身份不符时，待恢复状态会失效。本地 Hook 输出失败则保留 pending 状态，供下一次重试。

`show-context` 只显示实际准备注入的语义 payload；`show` 保留完整诊断信息。

## 验证结果

### 输入处理量

仓库自带的 6-generation fixture 对比两种方式：每次 compact 都重新读取不断增长的完整 transcript，以及把每个字节只作为增量捕获一次。

| 策略 | 输入字节数 | 变化 |
| --- | ---: | ---: |
| 完整重读 | 1,015,521 | 基线 |
| 增量捕获 | 210,506 | **−79.27%** |

运行 `npm run benchmark` 即可复现。这是合成 fixture 的输入字节代理，并非实测 Token、成本、延迟或任务质量。运行时间会单独报告，因为它取决于具体机器。

<details>
<summary><strong>Sidecar 投影结果</strong></summary>

<br>

同一个确定性 Benchmark 还会在不调用模型和网络的前提下，验证一次性 sidecar 投影。

| Sidecar 输入 | 字节数 | 变化 |
| --- | ---: | ---: |
| 原始 unseen deltas | 179,274 | 基线 |
| 派生 sidecar view | 81,263 | **−54.67%** |

该 fixture 会替换一个 base64 data URL 和一个明确的 binary envelope，折叠一个完全相同的超大重复项，保留普通长文本，删除派生 view，并确认原始 delta 的 SHA-256 未改变。这些数字只代表该 fixture 的字节变化，不代表 Token 节省量。

</details>

### 任务状态保留

一次配对的真实宿主验收使用了三个现有 semantic fixture；每个 fixture 扩展到约 159 KiB，并分别运行“仅原生 compact”和“原生 compact + checkpoint restore”。

| 结果 | 仅原生 compact | Checkpoint restore |
| --- | ---: | ---: |
| 在正确字段保留的任务状态条目 | 24/25 (96%) | **25/25 (100%)** |
| 与预期完全一致的 semantic 字段 | 22/24 (91.7%) | **23/24 (95.8%)** |
| 保留的执行关键 literal | 13/14 (92.9%) | **14/14 (100%)** |
| 完全一致的 Constraints + Do not retry 字段 | 6/6 (100%) | 6/6 (100%) |
| 预设虚构陷阱命中数 | 0 | 0 |
| 成功的 `SessionStart` restore receipt | 不适用 | 3/3 |

原生 compact 在一个 fixture 中丢失了精确 Hook 路径；checkpoint restore 保留了它。Constraints 字段同为 6/6，因此这次观察到的是整体任务状态保留优势，而不是约束保留优势。

这是一次小型配对验收——三个 fixture、每个条件一次运行——不能视为统计性结论或普遍任务质量结论。

<details>
<summary><strong>验收方法与边界</strong></summary>

<br>

每个 fixture 都追加了 1,800 行中性日志（159,261–159,286 UTF-8 bytes）。两个条件均使用 fresh task、`gpt-5.6-sol`、相同输入与压缩点、真实 App Server [`thread/compact/start`](https://developers.openai.com/codex/app-server#trigger-thread-compaction)，以及相同的压缩后结构化 probe。评分按精确字符串和目标字段完成，不使用 LLM judge。本次运行使用 `codex-cli 0.150.0-alpha.8` 与插件 v0.4.0。

Restore 条件会在被测 compact 前写入该 fixture 预先标注的 semantic checkpoint。因此它测量的是 restore retention，而不是 semantic 生成质量。两个条件都会额外加入已有的 `Command: npm test` 作为 Next action，所以都没有达到所有字段完全一致。三个 restore receipt 均为 `local_output_succeeded`，payload 为 595–634 bytes；所有 probe 都返回有效 JSON，且未使用工具。

Semantic 生成质量由另一个显式探针负责：`npm run benchmark:semantic`。

</details>

### 生命周期覆盖

测试覆盖 checkpoint 事务、锁所有权、cursor 协调、retention、thread 选择、transcript 替换与原地重写、根任务和子任务恢复、输出失败重试、语义 gate、恢复顺序、sidecar 投影与阈值、Windows 启动，以及有界 Schema 校验。

```bash
cd plugins/context-checkpoint
npm test
```

测试和 Benchmark 是这些代码路径可复现的公开证据，但不能替代重启宿主后执行“手动语义刷新 → compact → `SessionStart` 或首个提示兜底恢复”的验收。

## 检查与配置

<details>
<summary><strong>Checkpoint 状态与 thread 选择</strong></summary>

<br>

在 `plugins/context-checkpoint` 目录运行：

```bash
node hooks/context-checkpoint.cjs sessions
node hooks/context-checkpoint.cjs sessions --storage
node hooks/context-checkpoint.cjs sessions --discover
node hooks/context-checkpoint.cjs status --thread-id <selector>
node hooks/context-checkpoint.cjs history --thread-id <selector>
node hooks/context-checkpoint.cjs show --thread-id <selector>
node hooks/context-checkpoint.cjs show-context --thread-id <selector>
node hooks/context-checkpoint.cjs show --generation <n> --thread-id <selector>
node hooks/context-checkpoint.cjs semantic --input checkpoint.json --thread-id <selector>
```

同一工作区存在多个 thread 时，手动命令不会猜测。将 `sessions` 返回的 `selector` 传给 `--thread-id`。子任务 selector 使用 `agent:<encoded-session-id>:<encoded-agent-id>`；`--session-id` 仅保留为根任务兼容别名。

- `status` 报告严格 snapshot 诊断和 reset-aware semantic backlog。
- `history` 索引已保留的 generation；history 或 delta 区间缺失时会阻止 sidecar 推进。
- `sessions --storage` 报告 thread 与工作区总量，不删除数据。
- `sessions --discover` 报告同一规范化工作区 root 下的其他已存身份，不自动合并或选择。

如需检查其他身份，可仅为该命令将 `CONTEXT_CHECKPOINT_DATA_DIR` 设为 `PLUGIN_DATA/workspaces/<identity>/context-checkpoint`；使用 fallback 布局时则设为 `CODEX_HOME/plugin-data/context-checkpoint/workspaces/<identity>`。

恢复 payload 遵循共享的字段级 JSON Schema。Goal 必须是非空单行文本；Next actions 必须包含一至三条非空单行项；其他数组可以为空。每项最长 80 个字符，字段内完全相同的条目会去重。恢复顺序固定为 Goal、Constraints、Do not retry、Acceptance criteria、Next actions、Current progress、Decisions、Open questions。

`additionalContextLimit: 2500` 仍是宿主的近似 Token 阈值；更大的 Hook context 由 Codex 处理。`semantic_source=manual` 或 `sidecar` 只表示来源，不表示已经审阅，因此都标记为 `unreviewed`。

</details>

<details>
<summary><strong>可选 semantic sidecar</strong></summary>

<br>

下面的配置会在每三次完成的 compact 前检查一次，并且只在 semantic checkpoint 尚未覆盖的 retained deltas 累计至少为 32 KiB 时刷新：

```bash
export CONTEXT_CHECKPOINT_SIDECAR_EVERY=3
export CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES=32768
```

PowerShell：

```powershell
$env:CONTEXT_CHECKPOINT_SIDECAR_EVERY = '3'
$env:CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES = '32768'
```

启动前，插件会按记录的 SHA-256 校验 retained raw deltas，并创建一次性 `sidecar-view`。投影只替换规范的 base64 data URL、明确的 base64 envelope，以及后续出现且字节完全相同、至少 32 KiB 的字符串 payload。唯一的源码、日志、diff、数值输出和错误保持不变。

子进程只读取派生文件，并使用 `codex exec --ephemeral --sandbox read-only`；Hook 被禁用，环境被缩减，工作目录也不在目标仓库内。子进程返回后，插件会重新检查原始 hash 并删除 view。无效语义会 fail closed；清理失败会使本次尝试失败；sidecar 失败不会阻塞原生 compact。

这些启动约束可以减少暴露面，但不是针对本地文件读取的强隔离边界。

</details>

## 存储与隐私

- **位置：** 原始 delta 保存在 `PLUGIN_DATA/workspaces/<workspace-id>/context-checkpoint`，若不可用则回退到 `CODEX_HOME/plugin-data/context-checkpoint`。目标仓库不会被写入状态。
- **内容：** Delta 可能包含敏感对话。插件在 POSIX 上请求 `0700`/`0600` 权限；Windows 使用当前账户已有的 ACL。
- **保留：** 系统保留最近 50 个 generation，以及尚未被 semantic checkpoint 覆盖的更早 generation。历史 session 不会自动删除。
- **上限：** 单次 delta 默认上限为 64 MiB。超限区间记为 `skipped-too-large`；后续捕获会恢复，而 semantic gap 会阻止 sidecar 跨越，直到手动建立新的语义基线。
- **网络：** 确定性 Hook 不访问网络。只有显式启用 sidecar 后，prompt 才会通过已配置的 Codex 执行路径发送。

使用 `sessions --storage` 检查磁盘占用。可通过 `CONTEXT_CHECKPOINT_MAX_DELTA_BYTES` 和 `CONTEXT_CHECKPOINT_RETENTION_GENERATIONS` 调整上限。

## 开发

```bash
cd plugins/context-checkpoint
npm test
npm run benchmark
```

`npm run benchmark:semantic` 是独立的 sidecar 质量探针。它会调用已配置的 Codex 模型/网络，因此刻意不纳入确定性测试和发布门禁。

<details>
<summary><strong>仓库结构</strong></summary>

<br>

```text
.agents/plugins/marketplace.json       Marketplace 入口
plugins/context-checkpoint/
  .codex-plugin/plugin.json            插件清单
  hooks/                               Command hooks 与状态机
  skills/context-checkpoint/           手动语义刷新 Skill
  schemas/                             结构化 checkpoint Schema
  tests/                               生命周期与故障模式测试
  bench/                               输入规模与语义质量探针
```

</details>

## 安全

报告漏洞前请阅读 [`SECURITY.md`](SECURITY.md)。请勿在公开 Issue 中附加 transcript、checkpoint 状态、凭据或其他隐私数据。

## 许可证

MIT
