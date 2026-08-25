# Context Checkpoint

[English](README.md) | **简体中文**

[![CI](https://github.com/wcf778/context-checkpoint/actions/workflows/ci.yml/badge.svg)](https://github.com/wcf778/context-checkpoint/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个面向 Codex 的低 Token 上下文检查点插件，在原生上下文压缩前后记录确定性的恢复状态。

Codex 原生压缩仍负责主要的语义压缩。本插件只增加可恢复的任务状态层，默认不会额外启动模型。

## 功能

- `PreCompact` 仅保存尚未提交的 transcript 字节增量和轻量 Git 状态标记。
- `PostCompact` 在检查点持久化后提交 generation 和 transcript cursor。
- `SessionStart(source=compact)` 仅在 transcript 身份与覆盖范围仍匹配时恢复结构化语义检查点。
- `$context-checkpoint` 可在任务交接点刷新目标、约束、决策、进度、失败经验、开放问题和下一步行动。
- 可选的只读 sidecar 能每隔 _N_ 次完成的压缩刷新一次语义状态；默认关闭。

```text
Codex 任务
  -> PreCompact：确定性增量 + 工作区状态标记
  -> 原生 compact：主要语义压缩
  -> PostCompact：持久化 generation 提交
  -> SessionStart(compact)：通过新鲜度校验后恢复检查点
```

## 环境要求

- 支持命令型生命周期 hooks 和插件机制的 Codex
- Node.js 18 或更高版本
- Git 可选；非 Git 工作区使用稳定路径身份代替 Git 状态标记

## 安装

先将本仓库添加为 marketplace，再安装插件：

```bash
codex plugin marketplace add wcf778/context-checkpoint
codex plugin add context-checkpoint@context-checkpoint
```

重启 Codex，在提示时审查并批准 command hooks，然后新建任务。

插件不能自动安装项目配置。若要使用推荐的原生压缩提示词，请将 [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) 合并到目标仓库的 `.codex/config.toml`。

## 使用

日常自动压缩不需要手动操作。需要显式刷新语义状态时，可输入：

```text
$context-checkpoint 刷新当前任务检查点
```

也可以在插件目录运行检查命令：

```bash
node hooks/context-checkpoint.cjs sessions
node hooks/context-checkpoint.cjs status --session-id <id>
node hooks/context-checkpoint.cjs show --session-id <id>
node hooks/context-checkpoint.cjs semantic --input checkpoint.json --session-id <id>
```

同一工作区存在多个 session 时，手动命令会要求明确指定 `--session-id`，不会自行猜测。

## 可选 sidecar

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

## 存储与隐私

- 原始 transcript 增量保存在 `PLUGIN_DATA/workspaces/<workspace-id>/context-checkpoint`。如果没有 `PLUGIN_DATA`，则回退到 `CODEX_HOME/plugin-data/context-checkpoint`；状态不会写入目标仓库。
- Transcript 增量可能包含敏感对话内容，请使用正常的用户目录权限保护 Codex 数据目录。
- 单次增量默认上限为 64 MiB，并保留最近 50 个 generation。可通过 `CONTEXT_CHECKPOINT_MAX_DELTA_BYTES` 和 `CONTEXT_CHECKPOINT_RETENTION_GENERATIONS` 调整。
- 确定性 hook 路径不会发起网络请求。只有显式启用 sidecar 后，提示内容才会通过已配置的 Codex 执行路径发送。

## 开发

```bash
cd plugins/context-checkpoint
npm test
npm run benchmark
```

Benchmark 分别比较重复读取完整 transcript 与增量捕获的耗时。报告的字节减少比例只是输入规模代理，不代表真实 Token 成本或任务质量。

## 仓库结构

```text
.agents/plugins/marketplace.json       Marketplace 入口
plugins/context-checkpoint/
  .codex-plugin/plugin.json            插件清单
  hooks/                               命令 hooks 与状态机
  skills/context-checkpoint/           手动语义刷新 Skill
  schemas/                             结构化检查点 Schema
  tests/                               生命周期和失败模式测试
  bench/                               输入规模 Benchmark
```

## 安全

报告漏洞前请阅读 [`SECURITY.md`](SECURITY.md)。请勿在公开 Issue 中附加 transcript、检查点状态、凭据或其他隐私数据。

## 许可证

MIT
