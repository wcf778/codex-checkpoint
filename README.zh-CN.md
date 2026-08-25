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

## 它解决的问题

长任务经过多次上下文压缩后，恢复状态会变得难以检查。每次重新读取完整 transcript 的处理量会随任务持续增长，而盲目恢复旧摘要又可能重新注入过期的目标、决策或下一步行动。Codex Checkpoint 在原生压缩外围增加一个轻量、确定性的恢复层，Codex 原生压缩仍负责主要的语义压缩。

## 使用前 / 使用后

**仅使用原生压缩**

- 没有插件维护的恢复 generation
- 没有持久化 transcript cursor
- 没有独立的新鲜度校验

**使用 Codex Checkpoint**

- `PreCompact` 只捕获尚未处理的 transcript 字节
- `PostCompact` 提交已完成的 generation 和 transcript cursor
- `SessionStart` 仅在通过新鲜度校验后恢复根任务；`UserPromptSubmit` 为压缩后的子任务提供一次性兜底

## 为什么选择 Codex Checkpoint

- **默认开销低** — 确定性的 Node.js hooks 不访问网络，也不启动模型。
- **增量而非累积** — 每个 generation 只保存尚未提交的 transcript 字节区间。
- **通过新鲜度校验才恢复** — 被替换、重写、过期或不匹配的 transcript 不会自动注入。
- **可解释的一次性恢复** — 稳定的判定原因解释每次恢复决定；根任务与子任务只有在成功注入后才消费当前 generation。
- **故障安全的生命周期** — completed-generation 计数和已提交的 transcript cursor 只在 `PostCompact` 阶段推进。
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

仓库包含 **33 个自动化测试**，覆盖锁所有权、幂等性、transcript 替换与原地重写检测、过期状态拒绝、根任务与子任务的一次性恢复、输出失败重试、恢复诊断、历史查看、容量报告、原子元数据更新、保留策略、sidecar 隔离、递归保护、CLI session 歧义、Windows 启动器和有界 Schema 校验。

```bash
cd plugins/context-checkpoint
npm test
```

测试和 Benchmark 是可公开复现的证据。真实宿主 smoke run 用于验证集成行为，但不作为跨机器性能数据。

## 工作原理

```text
Codex 任务
  -> PreCompact：捕获确定性增量 + 工作区状态标记
  -> 原生 compact：主要语义压缩
  -> PostCompact：提交 generation + transcript cursor
  -> SessionStart(compact)：通过新鲜度校验后一次性恢复根任务
  -> UserPromptSubmit：子任务没有 SessionStart 时的一次性兜底
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

重启 Codex，在提示时审查并批准 command hooks，然后新建任务。之后的日常压缩不需要手动操作。

仓库和 marketplace 名称为 `codex-checkpoint`；为保持兼容，安装后的插件 id 仍为 `context-checkpoint`。

插件不能自动安装项目配置。若要使用推荐的原生压缩提示词，请将 [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) 合并到目标仓库的 `.codex/config.toml`。

## 使用

需要在交接点或阶段边界显式刷新语义状态时，可输入：

```text
$context-checkpoint 刷新当前任务检查点
```

## 高级用法

<details>
<summary><strong>检查 checkpoint 状态</strong></summary>

<br>

在插件目录运行：

```bash
node hooks/context-checkpoint.cjs sessions
node hooks/context-checkpoint.cjs sessions --storage
node hooks/context-checkpoint.cjs status --session-id <id>
node hooks/context-checkpoint.cjs history --session-id <id>
node hooks/context-checkpoint.cjs show --session-id <id>
node hooks/context-checkpoint.cjs show --generation <n> --session-id <id>
node hooks/context-checkpoint.cjs semantic --input checkpoint.json --session-id <id>
```

同一工作区存在多个 session 时，手动命令会要求明确指定 `--session-id`，不会自行猜测。`status` 解释恢复资格，`history` 索引已保留的 generation，`sessions --storage` 报告每个线程的字节数、最后更新时间、恢复资格和工作区总量，不执行删除。

</details>

<details>
<summary><strong>可选语义 sidecar</strong></summary>

<br>

Sidecar 默认关闭。下面的配置会在每 3 次完成的压缩前检查一次，并仅在当前增量至少为 32 KiB 时刷新：

```bash
export CONTEXT_CHECKPOINT_SIDECAR_EVERY=3
export CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES=32768
```

PowerShell：

```powershell
$env:CONTEXT_CHECKPOINT_SIDECAR_EVERY = '3'
$env:CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES = '32768'
```

子进程使用 `codex exec --ephemeral --sandbox read-only`，禁用 hooks，只接收最小环境和上次语义检查点之后尚未处理的 transcript 增量，且不能浏览目标工作区。Sidecar 失败不会阻塞原生压缩。

</details>

## 存储与隐私

- 原始 transcript 增量保存在 `PLUGIN_DATA/workspaces/<workspace-id>/context-checkpoint`。如果没有 `PLUGIN_DATA`，则回退到 `CODEX_HOME/plugin-data/context-checkpoint`；状态不会写入目标仓库。
- Transcript 增量可能包含敏感对话内容，请使用正常的用户目录权限保护 Codex 数据目录。
- 单次增量默认上限为 64 MiB，并保留最近 50 个 generation。可通过 `CONTEXT_CHECKPOINT_MAX_DELTA_BYTES` 和 `CONTEXT_CHECKPOINT_RETENTION_GENERATIONS` 调整。
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
