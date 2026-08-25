# Context Checkpoint

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/wcf778/context-checkpoint/actions/workflows/ci.yml/badge.svg)](https://github.com/wcf778/context-checkpoint/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A low-token Codex plugin that records deterministic recovery checkpoints around native context compaction.

Native Codex compaction remains the primary semantic compressor. The plugin adds a recoverable task-state layer without launching another model by default.

## What it does

- `PreCompact` stores only the uncommitted transcript byte range and a cheap Git status marker.
- `PostCompact` commits the generation and transcript cursor after the checkpoint is durable.
- `SessionStart(source=compact)` restores a structured semantic checkpoint only when transcript identity and coverage still match.
- `$context-checkpoint` lets you refresh Goal, Constraints, Decisions, Progress, Negative Knowledge, Open Questions, and Next Actions at a handoff boundary.
- An optional read-only sidecar can refresh semantics every _N_ completed compactions; it is disabled by default.

```text
Codex task
  -> PreCompact: deterministic delta + workspace marker
  -> native compact: primary semantic compression
  -> PostCompact: durable generation commit
  -> SessionStart(compact): freshness-gated checkpoint restore
```

## Requirements

- Codex with command lifecycle hooks and plugin support
- Node.js 18 or newer
- Git is optional; non-Git workspaces use a stable path identity instead of a status marker

## Install

Add this repository as a marketplace, then install the plugin:

```bash
codex plugin marketplace add wcf778/context-checkpoint
codex plugin add context-checkpoint@context-checkpoint
```

Restart Codex, review the command hooks when prompted, and start a new task.

The plugin cannot install project configuration. To use the recommended native compact prompt, merge [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) into the target repository's `.codex/config.toml`.

## Use

Routine compaction needs no manual action. For an explicit semantic refresh:

```text
$context-checkpoint refresh the current task checkpoint
```

Manual inspection commands are also available from the plugin directory:

```bash
node hooks/context-checkpoint.cjs sessions
node hooks/context-checkpoint.cjs status --session-id <id>
node hooks/context-checkpoint.cjs show --session-id <id>
node hooks/context-checkpoint.cjs semantic --input checkpoint.json --session-id <id>
```

Manual commands refuse to guess when a workspace has multiple sessions.

## Optional sidecar

The sidecar is opt-in. This example requests a refresh before every third completed compaction when the current delta is at least 32 KiB:

```bash
export CONTEXT_CHECKPOINT_SIDECAR_EVERY=3
export CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES=32768
```

On PowerShell:

```powershell
$env:CONTEXT_CHECKPOINT_SIDECAR_EVERY = '3'
$env:CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES = '32768'
```

The child runs with `codex exec --ephemeral --sandbox read-only`, hooks disabled, a minimal environment, and only transcript deltas unseen by the last semantic checkpoint. It cannot browse the target workspace. A sidecar failure never blocks native compaction.

## Storage and privacy

- Raw transcript deltas are stored under `PLUGIN_DATA/workspaces/<workspace-id>/context-checkpoint`. If `PLUGIN_DATA` is unavailable, the fallback is under `CODEX_HOME/plugin-data/context-checkpoint`; state is never written to the target repository.
- Transcript deltas can contain sensitive conversation content. Protect the Codex data directory with normal user-directory permissions.
- A single delta is limited to 64 MiB by default, and the newest 50 generations are retained. Override these with `CONTEXT_CHECKPOINT_MAX_DELTA_BYTES` and `CONTEXT_CHECKPOINT_RETENTION_GENERATIONS`.
- The deterministic hook path makes no network request. Enabling the sidecar explicitly sends its prompt through the configured Codex execution path.

## Development

```bash
cd plugins/context-checkpoint
npm test
npm run benchmark
```

The benchmark compares repeated full transcript reads with delta capture and reports timings separately. Its byte reduction is an input-size proxy, not a claim about real token cost or task quality.

## Repository layout

```text
.agents/plugins/marketplace.json       Marketplace entry
plugins/context-checkpoint/
  .codex-plugin/plugin.json            Plugin manifest
  hooks/                               Command hooks and state machine
  skills/context-checkpoint/           Manual semantic refresh skill
  schemas/                             Structured checkpoint schema
  tests/                               Lifecycle and failure-mode tests
  bench/                               Input-size benchmark
```

## Security

Please review [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Do not include transcripts, checkpoint state, credentials, or other private data in a public issue.

## License

MIT
