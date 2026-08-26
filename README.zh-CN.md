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
- **可选语义恢复模式**需要显式调用 `$context-checkpoint` 或主动启用 sidecar。只有新鲜且非空的 semantic checkpoint 才会在压缩后注入一次。

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
- 已存在语义状态时，`SessionStart` 才会在通过新鲜度校验后恢复根任务；若该恢复未发生，首个匹配的 `UserPromptSubmit` 会提供一次性兜底，也用于压缩后的子任务

## 为什么选择 Codex Checkpoint

- **默认开销低** — 确定性的 Node.js hooks 不访问网络，也不启动模型。
- **增量而非累积** — 每个 generation 只保存尚未提交的 transcript 字节区间。
- **通过新鲜度校验才恢复** — 被替换、重写、过期或不匹配的 transcript 不会自动注入。
- **可解释的一次性恢复** — 稳定的判定原因和不含正文的本地输出 receipt 支持审计；本地 Hook 输出失败时保留待恢复状态以便重试。
- **故障安全的生命周期** — 生命周期只提交一次，来源为 `PostCompact` 或精确匹配、仅限根任务的 `SessionStart(compact)` 兜底，并记录来源。
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

### 生命周期与故障模式覆盖

自动化测试覆盖锁所有权、幂等性、transcript 替换与原地重写检测、过期状态拒绝、根任务兜底收尾、根任务与子任务的 one-shot 恢复、输出 receipt 与失败重试、恢复诊断、身份发现、历史查看、容量报告、原子元数据更新、保留策略、sidecar 累计阈值、sidecar 启动约束、递归保护、CLI thread 歧义、Windows 启动器和有界 Schema 校验。

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
  -> SessionStart(compact)：存在且新鲜的 semantic checkpoint 才会一次性恢复根任务
  -> UserPromptSubmit：首个匹配的压缩后提示及新鲜子任务 semantic checkpoint 的一次性兜底
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
node hooks/context-checkpoint.cjs show --generation <n> --thread-id <selector>
node hooks/context-checkpoint.cjs semantic --input checkpoint.json --thread-id <selector>
```

同一工作区存在多个 thread 时，手动命令不会猜测。将 `sessions` 返回的 `selector` 传给 `--thread-id`；子任务 selector 使用 `agent:<编码后的-session-id>:<编码后的-agent-id>`，`--session-id` 仅作为 root task 兼容别名。`status` 报告恢复资格以及 reset-aware semantic backlog；history 或 delta 区间缺失时会明确报告并阻止 sidecar 推进。Retention 不会删除尚未解决的 backlog。`history` 索引已保留的 generation，`sessions --storage` 报告每个线程的字节数、最后更新时间、恢复资格和工作区总量，不执行删除。`sessions --discover` 只读报告具有完全相同规范化工作区 root 的其他已存身份，不自动合并或选择。如需显式检查其中一个身份，可仅为该命令将 `CONTEXT_CHECKPOINT_DATA_DIR` 设为 `PLUGIN_DATA/workspaces/<identity>/context-checkpoint`；使用 fallback 布局时则设为 `CODEX_HOME/plugin-data/context-checkpoint/workspaces/<identity>`。Hook 恢复使用独立的任务状态 payload，语义校验会拒绝超过 2500 UTF-8 字节的 payload。配置的 `additionalContextLimit: 2500` 是约 2500 token 的阈值；更大的 hook context 由 Codex 完整写入临时文件，并向模型提供首尾预览。`show` 仍保留完整诊断视图。

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

子进程使用 `codex exec --ephemeral --sandbox read-only`，禁用 hooks，并采用最小环境。其 cwd 不是目标工作区、没有写权限，且被明确指示只读取列出的、上次语义检查点之后尚未处理的 transcript 增量。这些启动约束并非针对本地文件读取的强隔离边界。Sidecar 失败不会阻塞原生压缩。

</details>

## 存储与隐私

- 原始 transcript 增量保存在 `PLUGIN_DATA/workspaces/<workspace-id>/context-checkpoint`。如果没有 `PLUGIN_DATA`，则回退到 `CODEX_HOME/plugin-data/context-checkpoint`；状态不会写入目标仓库。
- Transcript 增量可能包含敏感对话内容。插件在 POSIX 上以 `0700`/`0600` 模式创建目录/文件；Windows 继续使用当前账户已有的 ACL。
- 单次增量默认上限为 64 MiB。超限区间记为 `skipped-too-large`；cursor 仅在生命周期成功完成后前进，后续增量恢复正常，而显式 semantic gap 会阻止 sidecar 跨越，直到手动建立新的语义基线。系统保留最近 50 个 generation，以及尚未被 semantic checkpoint 覆盖的更早 generation。可通过 `CONTEXT_CHECKPOINT_MAX_DELTA_BYTES` 和 `CONTEXT_CHECKPOINT_RETENTION_GENERATIONS` 调整上限。
- 历史 session 不会自动删除。可先用 `sessions --storage` 检查容量；清理仍须由操作者显式执行。
- 确定性 hook 路径不会发起网络请求。只有显式启用 sidecar 后，提示内容才会通过已配置的 Codex 执行路径发送。

## 开发

```bash
cd plugins/context-checkpoint
npm test
npm run benchmark
```

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
  bench/                               输入规模 Benchmark
```

</details>

## 安全

报告漏洞前请阅读 [`SECURITY.md`](SECURITY.md)。请勿在公开 Issue 中附加 transcript、checkpoint 状态、凭据或其他隐私数据。

## 许可证

MIT
