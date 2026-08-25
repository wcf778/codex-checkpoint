<p align="center">
  <img src="assets/context-checkpoint-logo.png" alt="Context Checkpoint logo" width="180">
</p>

# Context Checkpoint

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/wcf778/context-checkpoint/actions/workflows/ci.yml/badge.svg)](https://github.com/wcf778/context-checkpoint/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Keep long Codex tasks recoverable across context compaction—without rereading the full transcript or calling another model by default.**

Context Checkpoint captures only what changed, marks generations complete only after `PostCompact`, and restores state only when it still belongs to the current session. Native Codex compaction remains the primary semantic compressor.

## The problem

After a long task has crossed several compaction boundaries, its recovery state is difficult to inspect. Repeatedly scanning the full transcript grows with the task, while blindly restoring an old summary risks injecting stale goals, decisions, or next actions.

Context Checkpoint adds a small, deterministic recovery layer around native compaction:

- capture only transcript bytes not already committed;
- preserve a durable generation history outside the repository;
- reject restoration when transcript identity or coverage no longer matches;
- spend no additional model tokens on the default hook path.

## Before / after

```text
Native compaction only                 Native compaction + Context Checkpoint
-----------------------------------    -----------------------------------------
Codex compacts semantic context        Codex still compacts semantic context
No plugin-owned recovery generation    PreCompact captures only unseen bytes
No durable transcript cursor           PostCompact commits the durable cursor
No independent freshness gate          SessionStart restores only a fresh match
```

## Why Context Checkpoint

- **Low overhead by default** — deterministic Node.js hooks make no network request and launch no model.
- **Incremental, not cumulative** — each generation stores only the uncommitted transcript byte range.
- **Freshness-gated recovery** — replaced, rewritten, stale, or mismatched transcripts are not auto-injected.
- **Failure-safe lifecycle** — the completed-generation count and committed transcript cursor advance only during `PostCompact`.
- **No repository pollution** — state lives under Codex/plugin data, never in the target workspace.
- **Semantic refresh when useful** — a manual skill and an opt-in read-only sidecar can preserve bounded task semantics.

## Evidence

### Reproducible input-size benchmark

The bundled six-generation fixture compares rereading the complete growing transcript at every compaction with capturing each byte once as a delta.

| Strategy | Bytes processed | Difference |
| --- | ---: | ---: |
| Repeated full-transcript reads | 1,015,521 | baseline |
| Context Checkpoint deltas | 210,506 | **79.27% fewer bytes** |

Run it with `npm run benchmark`. This is an input-byte proxy from a synthetic fixture—not a measured token, cost, latency, or task-quality claim. Timings are reported separately because they depend on the machine.

### Lifecycle and failure-mode coverage

The repository includes **25 automated tests** covering lock ownership, idempotency, transcript replacement and rewrite detection, stale-state rejection, atomic metadata updates, retention, sidecar isolation, recursion guards, CLI ambiguity, Windows launcher behavior, and bounded schema validation.

```bash
cd plugins/context-checkpoint
npm test
```

The tests and benchmark are the reproducible public evidence. Host smoke runs validate integration behavior but are not presented as cross-machine performance data.

## How it works

```text
Codex task
  -> PreCompact: capture deterministic delta + workspace marker
  -> native compact: primary semantic compression
  -> PostCompact: commit generation + transcript cursor
  -> SessionStart(compact): restore only after freshness checks pass
```

`$context-checkpoint` can additionally refresh a bounded semantic record containing Goal, Constraints, Decisions, Progress, Negative Knowledge, Open Questions, and Next Actions.

## Quick start

### Requirements

- Codex with command lifecycle hooks and plugin support
- Node.js 18 or newer
- Git is optional; non-Git workspaces use a stable path identity instead of a status marker

### Install

Add this repository as a marketplace, then install the plugin:

```bash
codex plugin marketplace add wcf778/context-checkpoint
codex plugin add context-checkpoint@context-checkpoint
```

Restart Codex, review the command hooks when prompted, and start a new task. Routine compaction then needs no manual action.

The plugin cannot install project configuration. To use the recommended native compact prompt, merge [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) into the target repository's `.codex/config.toml`.

## Use

For an explicit semantic refresh at a handoff or phase boundary:

```text
$context-checkpoint refresh the current task checkpoint
```

## Advanced usage

### Inspect checkpoint state

Run these commands from the plugin directory:

```bash
node hooks/context-checkpoint.cjs sessions
node hooks/context-checkpoint.cjs status --session-id <id>
node hooks/context-checkpoint.cjs show --session-id <id>
node hooks/context-checkpoint.cjs semantic --input checkpoint.json --session-id <id>
```

Manual commands refuse to guess when a workspace has multiple sessions.

### Optional semantic sidecar

The sidecar is disabled by default. This example requests a refresh before every third completed compaction when the current delta is at least 32 KiB:

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
