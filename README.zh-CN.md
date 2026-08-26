<p align="center">
  <img src="assets/context-checkpoint-logo.png" alt="Codex Checkpoint 标志" width="160">
</p>

<h1 align="center">Codex Checkpoint</h1>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://github.com/wcf778/codex-checkpoint/actions/workflows/ci.yml"><img src="https://github.com/wcf778/codex-checkpoint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center"><strong>让长时间运行的 Codex 任务在上下文压缩后仍可恢复，而不必反复读取完整对话。</strong></p>

<p align="center">增量检查点、通过新鲜度校验才恢复，默认不调用额外模型。</p>

## 工作模式

- **默认机械模式**自动记录 transcript 增量、生命周期状态和已提交 cursor，不生成也不注入语义任务状态。
- **可选语义恢复模式**需要显式调用 `$context-checkpoint` 或主动启用 sidecar。只有新鲜、Goal 非空且至少包含一个 Next action 的 semantic checkpoint 才会在压缩后注入一次。

## 它解决的问题

长任务经过多次上下文压缩后，恢复状态会变得难以检查。每次重新读取完整 transcript 的处理量会随任务持续增长，而盲目恢复旧摘要又可能重新注入过期的目标、决策或下一步行动。Codex Checkpoint 在原生压缩外围增加一个轻量、确定性的恢复层，Codex 原生压缩仍负责主要的语义压缩。

## 使用前 / 使用后

**仅使用原生压缩**

- 没有插件维护的恢复 generation
- 没有持久化 transcript cursor
- 没有独立的新鲜度校验

**使用 Codex Checkpoint**

- `PreCompact` 只捕获尚未处理的 transcript 字节
- `PostCompact` 提交已完成的 generation 和 transcript cursor；精确匹配的根任务 `SessionStart(compact)` 可补齐遗漏的 `PostCompact`
- 已存在语义状态时，匹配的生命周期 Hook 会接受同一 transcript source 的追加内容，而不解析 Codex 私有 transcript 记录类型；首个被插件观察到且匹配的 `UserPromptSubmit` 提供一次性兜底，也用于压缩后的子任务

## 为什么选择 Codex Checkpoint

- **默认开销低** — 确定性的 Node.js hooks 不访问网络，也不启动模型。
- **增量而非累积** — 每个 generation 只保存尚未提交的 transcript 字节区间。
- **通过新鲜度校验才恢复** — 被替换、重写或 source 不匹配的 transcript 不会自动注入；匹配的生命周期 Hook 可接受未改变 snapshot prefix 后的同源追加。
- **可解释的一次性恢复** — 稳定的判定原因和不含正文的本地输出 receipt 支持审计；本地 Hook 输出失败时保留待恢复状态以便重试。
- **故障安全的生命周期** — 完成态 checkpoint 在写入中断后会重新协调文件、cursor，以及持久化的 `pending`/`delivered`/`retired` 恢复状态。
- **语义续作 fail-closed** — Goal 或 Next action 缺失时拒绝恢复；未知约束或验收条件继续保持未知，不为通过 Schema 而虚构。
- **模型上下文可检查** — `show-context` 输出真正准备恢复的语义 payload；`show` 继续提供诊断视图。
- **不污染目标仓库** — 状态保存在 Codex/plugin data 下，不写入目标工作区。
- **按需刷新语义** — 手动 Skill 和可选只读 sidecar 可保存有边界的任务语义。

## 效果与证据

### 可复现的输入规模 Benchmark

仓库自带的 6-generation fixture 比较两种方式：每次压缩都重新读取不断增长的完整 transcript，以及把每个字节仅作为增量捕获一次。

| 策略 | 输入字节数 | 变化 |
| --- | ---: | ---: |
| 完整重读 | 1,015,521 | 基线 |
| 增量捕获 | 210,506 | **−79.27%** |

运行 `npm run benchmark` 即可复现。这是合成 fixture 的输入字节代理，并非实测 Token、成本、延迟或任务质量。运行时间单独报告，因为它取决于具体机器。

同一个确定性 Benchmark 还会在不调用模型和网络的前提下验证一次性 sidecar 投影：

| Sidecar 输入 | 字节数 | 变化 |
| --- | ---: | ---: |
| 原始 unseen deltas | 179,274 | 基线 |
| 派生 sidecar view | 81,263 | **−54.67%** |

该 fixture 会替换 1 个 base64 data URL 和 1 个明确 binary envelope，折叠 1 个完全相同的超大重复项，保留普通长文本，删除派生 view，并确认原始 delta 的 SHA-256 未改变。这只是该 fixture 的输入字节代理，不是 Token 节省量。

### 生命周期与故障模式覆盖

自动化测试覆盖锁所有权、幂等性、完成态中断协调、transcript 替换与原地重写检测、生命周期追加恢复、根任务与子任务的 one-shot 恢复、输出 receipt 与失败重试、恢复诊断、Goal/Next-action 语义 gate、精确去重与恢复排序、身份发现、legacy 路径边界、历史查看、容量报告、保留策略、sidecar 累计阈值、delta checksum gate、一次性 sidecar 投影与字节指标、sidecar 启动与语义质量约束、递归保护、CLI thread 歧义、Windows 启动器和有界 Schema 校验。

```bash
cd plugins/context-checkpoint
npm test
```

测试和 Benchmark 是这些代码路径可公开复现的证据，但不能替代重启宿主后执行“手动语义刷新 → compact → `SessionStart` 或首个提示兜底恢复”的验收。

## 工作原理

```text
Codex 任务
  -> PreCompact：捕获确定性增量 + 工作区状态标记
  -> 原生 compact：主要语义压缩
  -> PostCompact：提交 generation + transcript cursor
     （若 PostCompact 遗漏，则由精确匹配的根任务 SessionStart(compact) 兜底）
  -> SessionStart(compact)：保存的 transcript prefix 未改变时一次性恢复根任务
  -> UserPromptSubmit：首个被插件观察到且匹配的压缩后提示及 semantic 子任务的一次性兜底
```

`$context-checkpoint` 还能按需刷新有边界的语义记录，包括目标、约束、决策、进度、失败经验、开放问题和下一步行动。

## 快速开始

### 环境要求

- 支持命令型生命周期 hooks 和插件机制的 Codex
- Node.js 18 或更高版本
- Git 可选；非 Git 工作区使用稳定路径身份代替 Git 状态标记

### 安装

先将本仓库添加为 marketplace，再安装插件：

```bash
codex plugin marketplace add wcf778/codex-checkpoint
codex plugin add context-checkpoint@context-checkpoint
```

重启 Codex，在提示时审查并批准 command hooks，然后新建任务。之后的日常机械捕获不需要手动操作；语义恢复仍需手动 Skill 或显式启用 sidecar。

该 Skill 仅支持显式调用，可能不会出现在初始自动 Skill 列表中。安装或更新后请新建任务并显式选择 `$context-checkpoint`；若更新仍不可用，再重启 Codex。

仓库和 marketplace 名称为 `codex-checkpoint`；为保持兼容，安装后的插件 id 仍为 `context-checkpoint`。

插件不能自动安装项目配置。若要使用推荐的原生压缩提示词，请将 [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) 合并到目标仓库的 `.codex/config.toml`。

## 使用

需要在交接点或阶段边界显式刷新语义状态时，可输入：

```text
$context-checkpoint 刷新当前任务检查点
```

若要立即恢复，请在提交下一条普通用户 prompt 前执行 compact。后续 prompt 会使待传递的手动语义失效，而不会把更新后的任务内容误判为已覆盖。

## 高级用法

<details>
<summary><strong>检查 checkpoint 状态</strong></summary>

<br>

在插件目录运行：

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

同一工作区存在多个 thread 时，手动命令不会猜测。将 `sessions` 返回的 `selector` 传给 `--thread-id`；子任务 selector 使用 `agent:<编码后的-session-id>:<编码后的-agent-id>`，`--session-id` 仅作为 root task 兼容别名。`status` 报告严格 snapshot 恢复诊断以及 reset-aware semantic backlog；生命周期 Hook 仍可能接受该 snapshot 后的同源追加。history 或 delta 区间缺失时会明确报告并阻止 sidecar 推进。Retention 不会删除尚未解决的 backlog。`history` 索引已保留的 generation，`sessions --storage` 报告每个线程的字节数、最后更新时间、同样的严格 snapshot 诊断和工作区总量，不执行删除。`sessions --discover` 只读报告具有完全相同规范化工作区 root 的其他已存身份，不自动合并或选择。如需显式检查其中一个身份，可仅为该命令将 `CONTEXT_CHECKPOINT_DATA_DIR` 设为 `PLUGIN_DATA/workspaces/<identity>/context-checkpoint`；使用 fallback 布局时则设为 `CODEX_HOME/plugin-data/context-checkpoint/workspaces/<identity>`。Hook 恢复使用由共享字段级 JSON Schema 限定的独立任务状态 payload：Goal 必须是含非空白字符的单行字符串，Next actions 必须包含一到三条含非空白字符的单行项，其他数组可为空。数组项上限提升为 80 字符，使审计示例路径和 SHA-256 literal 可以原样保存，同时继续限制上下文规模；每个字段内完全相同的条目会独立去重，而大小写或空白差异仍保留。恢复顺序固定为 Goal、Constraints、Do not retry、Acceptance criteria、Next actions、Current progress、Decisions、Open questions；插件不会猜测措辞相近的决策或错误是否互相取代。不再叠加第二套总字节数 Schema。配置的 `additionalContextLimit: 2500` 仍是宿主近似 token 阈值；更大的 Hook context 由 Codex 处理。`show-context` 只输出实际恢复 payload；`show` 保留完整诊断视图。`semantic_source=manual` 或 `sidecar` 只表示来源，不表示用户已审阅，因此诊断均标为 `unreviewed`。

</details>

<details>
<summary><strong>可选语义 sidecar</strong></summary>

<br>

Sidecar 默认关闭。下面的配置会在每 3 次完成的压缩前检查一次，并仅在 semantic checkpoint 尚未覆盖的已保留 delta 累计至少为 32 KiB 时刷新：

```bash
export CONTEXT_CHECKPOINT_SIDECAR_EVERY=3
export CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES=32768
```

PowerShell：

```powershell
$env:CONTEXT_CHECKPOINT_SIDECAR_EVERY = '3'
$env:CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES = '32768'
```

启动前，插件会按记录的 SHA-256 校验每个原始 retained delta，然后创建一次性、按内容处理的 `sidecar-view`。它只替换规范的 base64 data URL、精确的 `{encoding, media_type, data}` base64 envelope，以及后续出现且字节完全相同、至少 32 KiB 的字符串 payload；第一次出现的超大内容，以及唯一的普通源码、日志、diff、数值输出和错误都保持不变。Transformer 不检查 Codex transcript record type，不总结文本，也不做相似度启发式。子进程只读取这些派生文件，并使用 `codex exec --ephemeral --sandbox read-only`，禁用 hooks，采用最小环境，cwd 不指向目标工作区。子进程返回后——包括本地失败——插件会重新校验原始 SHA-256 并尝试删除 view；清理失败会被报告，并使该次 sidecar 标记为失败。Sidecar 结果只保存原始/投影字节数、减少量和规则命中数，不保存投影正文。Prompt 会将未知信息保存在 `open_questions`，原样保留 Schema 边界内影响执行的 literal 与否定极性，区分 runtime completion 和结果 validation，并且只有后续证据明确说明时才省略已被取代的决策或已解决的错误。这些启动约束并非针对本地文件读取的强隔离边界。无效 sidecar semantic 会 fail-closed，且不会推进 semantic coverage。Sidecar 失败不会阻塞原生压缩。

</details>

## 存储与隐私

- 原始 transcript 增量保存在 `PLUGIN_DATA/workspaces/<workspace-id>/context-checkpoint`。如果没有 `PLUGIN_DATA`，则回退到 `CODEX_HOME/plugin-data/context-checkpoint`；状态不会写入目标仓库。
- Transcript 增量可能包含敏感对话内容。插件在 POSIX 上以 `0700`/`0600` 模式创建目录/文件；Windows 继续使用当前账户已有的 ACL。
- Sidecar view 是插件状态目录中的临时派生输入。每次 sidecar 正常完成或本地失败后都会尝试清理；清理失败会被报告并使该次尝试失败。原始 delta 始终是审计依据，投影路径不会改写它们。
- 单次增量默认上限为 64 MiB。超限区间记为 `skipped-too-large`；cursor 仅在生命周期成功完成后前进，后续增量恢复正常，而显式 semantic gap 会阻止 sidecar 跨越，直到手动建立新的语义基线。系统保留最近 50 个 generation，以及尚未被 semantic checkpoint 覆盖的更早 generation。可通过 `CONTEXT_CHECKPOINT_MAX_DELTA_BYTES` 和 `CONTEXT_CHECKPOINT_RETENTION_GENERATIONS` 调整上限。
- 历史 session 不会自动删除。可先用 `sessions --storage` 检查容量；清理仍须由操作者显式执行。
- 确定性 hook 路径不会发起网络请求。只有显式启用 sidecar 后，提示内容才会通过已配置的 Codex 执行路径发送。

## 开发

```bash
cd plugins/context-checkpoint
npm test
npm run benchmark
```

`npm run benchmark:semantic` 是独立、显式的 sidecar 质量探针。它会调用已配置的 Codex 模型/网络，报告 literal、否定、未知项、next action 与预设虚构陷阱命中情况，因此刻意不纳入确定性测试和发布门禁。

<details>
<summary><strong>仓库结构</strong></summary>

<br>

```text
.agents/plugins/marketplace.json       Marketplace 入口
plugins/context-checkpoint/
  .codex-plugin/plugin.json            插件清单
  hooks/                               命令 hooks 与状态机
  skills/context-checkpoint/           手动语义刷新 Skill
  schemas/                             结构化 checkpoint Schema
  tests/                               生命周期和故障模式测试
  bench/                               输入规模与显式语义质量 Benchmark
```

</details>

## 安全

报告漏洞前请阅读 [`SECURITY.md`](SECURITY.md)。请勿在公开 Issue 中附加 transcript、checkpoint 状态、凭据或其他隐私数据。

## 许可证

MIT
