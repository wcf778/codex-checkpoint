<p align="center">
  <img src="assets/context-checkpoint-logo.png" alt="Codex Checkpoint logo" width="160">
</p>

<h1 align="center">Codex Checkpoint</h1>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/wcf778/codex-checkpoint/actions/workflows/ci.yml"><img src="https://github.com/wcf778/codex-checkpoint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center"><strong>Recover long Codex tasks after context compaction—without rereading the full transcript.</strong></p>

<p align="center">Incremental checkpoints, freshness-gated recovery, and no extra model calls by default.</p>

## The problem

After a long task has crossed several compaction boundaries, its recovery state is difficult to inspect. Repeatedly scanning the full transcript grows with the task, while blindly restoring an old summary risks injecting stale goals, decisions, or next actions. Codex Checkpoint adds a small, deterministic recovery layer while native Codex compaction remains the primary semantic compressor.

## Before / after

**Native compaction only**

- No plugin-owned recovery generation
- No durable transcript cursor
- No independent freshness gate

**With Codex Checkpoint**

- `PreCompact` captures only unseen transcript bytes
- `PostCompact` commits the completed generation and transcript cursor
- `SessionStart` restores only when freshness checks pass

## Why Codex Checkpoint

- **Low overhead by default** — deterministic Node.js hooks make no network request and launch no model.
- **Incremental, not cumulative** — each generation stores only the uncommitted transcript byte range.
- **Freshness-gated recovery** — replaced, rewritten, stale, or mismatched transcripts are not auto-injected.
- **Failure-safe lifecycle** — the completed-generation count and committed transcript cursor advance only during `PostCompact`.
- **No repository pollution** — state lives under Codex/plugin data, never in the target workspace.
- **Semantic refresh when useful** — a manual skill and an opt-in read-only sidecar can preserve bounded task semantics.

## Evidence

### Reproducible input-size benchmark

The bundled six-generation fixture compares rereading the complete growing transcript at every compaction with capturing each byte once as a delta.

| Strategy | Input bytes | Change |
| --- | ---: | ---: |
| Full reread | 1,015,521 | baseline |
| Delta capture | 210,506 | **−79.27%** |

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
codex plugin marketplace add wcf778/codex-checkpoint
codex plugin add context-checkpoint@context-checkpoint
```

Restart Codex, review the command hooks when prompted, and start a new task. Routine compaction then needs no manual action.

The repository and marketplace are named `codex-checkpoint`; the installed plugin id remains `context-checkpoint` for compatibility.

The plugin cannot install project configuration. To use the recommended native compact prompt, merge [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) into the target repository's `.codex/config.toml`.

## Use

For an explicit semantic refresh at a handoff or phase boundary:

```text
$context-checkpoint refresh the current task checkpoint
```

## Advanced usage

<details>
<summary><strong>Inspect checkpoint state</strong></summary>

<br>

Run these commands from the plugin directory:

```bash
node hooks/context-checkpoint.cjs sessions
node hooks/context-checkpoint.cjs status --session-id <id>
node hooks/context-checkpoint.cjs show --session-id <id>
node hooks/context-checkpoint.cjs semantic --input checkpoint.json --session-id <id>
```

Manual commands refuse to guess when a workspace has multiple sessions.

</details>

<details>
<summary><strong>Optional semantic sidecar</strong></summary>

<br>

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

</details>

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

<details>
<summary><strong>Repository layout</strong></summary>

<br>

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

</details>

## Security

Please review [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Do not include transcripts, checkpoint state, credentials, or other private data in a public issue.

## License

MIT
