<p align="center">
  <img src="assets/context-checkpoint-logo.png" alt="Codex Checkpoint logo" width="144">
</p>

<h1 align="center">Codex Checkpoint</h1>

<p align="center"><strong>Carry the state of a long Codex task safely across context compaction.</strong></p>

<p align="center">Deterministic transcript checkpoints by default. Bounded semantic recovery when you ask for it.</p>

<p align="center">
  <a href="https://github.com/wcf778/codex-checkpoint/actions/workflows/ci.yml"><img src="https://github.com/wcf778/codex-checkpoint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/wcf778/codex-checkpoint/releases/latest"><img src="https://img.shields.io/github/v/release/wcf778/codex-checkpoint?display_name=tag&sort=semver" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#evidence">Evidence</a> ·
  <strong>English</strong> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

Codex Checkpoint is a recovery layer for long Codex tasks. It records transcript deltas around native compaction, keeps a committed cursor, and restores a small task-state payload only while that state still matches the live transcript.

Native Codex compaction remains the semantic compressor. The default hook path is deterministic: no model launch, no network request, and no state written into your repository.

## Quick start

**Requirements:** Codex with command lifecycle hooks and plugin support, plus Node.js 18 or newer. Git is optional.

### Install

```bash
codex plugin marketplace add wcf778/codex-checkpoint
codex plugin add context-checkpoint@context-checkpoint
```

Restart Codex, review the command hooks when prompted, and open a new task. Mechanical checkpointing now runs automatically.

For a semantic checkpoint at a handoff or phase boundary:

```text
$context-checkpoint refresh the current task checkpoint
```

Compact before sending another normal prompt. A later prompt retires the pending manual carry-forward rather than pretending the newer work was covered.

The Skill is explicit-only and may not appear in the initial automatic Skill list. After an install or update, select `$context-checkpoint` in a new task; restart Codex if the updated Skill is still unavailable.

The repository and marketplace are named `codex-checkpoint`. The installed plugin id remains `context-checkpoint` for compatibility. For the recommended native compact prompt, merge [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) into the target repository's `.codex/config.toml`.

## What it adds

| | Native compaction alone | With Codex Checkpoint |
| --- | --- | --- |
| Transcript history | No plugin-owned delta record | Unseen bytes captured once per generation |
| Recovery cursor | No plugin-owned committed cursor | Durable cursor reconciled after interrupted writes |
| Semantic restore | Native compacted context only | Optional bounded task state, injected once |
| Stale state | No independent plugin gate | Replacement, rewrite, and source mismatch fail closed |
| Default overhead | Native behavior | Local deterministic hooks; no model or network |

The result is deliberately narrow: an inspectable recovery layer, not a daemon, database, vector store, or replacement memory system.

## Recovery modes

### Mechanical checkpointing — default

Lifecycle hooks record transcript deltas, workspace identity, checkpoint generations, and the committed cursor. This path never generates or injects semantic task state.

### Manual semantic recovery — explicit

`$context-checkpoint` writes a bounded record of the current Goal, Constraints, Decisions, Progress, Do not retry items, Open questions, Acceptance criteria, and Next actions. Recovery requires a fresh checkpoint, a non-empty Goal, and at least one Next action.

### Semantic sidecar — opt-in

The sidecar can refresh the same record on a generation cadence and accumulated unseen-byte threshold. It is disabled by default and is the only background path that starts a configured Codex model/network request.

## How recovery works

```text
Codex task
  ├─ PreCompact           capture unseen transcript bytes
  ├─ native compact       primary semantic compression
  ├─ PostCompact          commit generation + cursor
  │    └─ SessionStart    may finish an exact missed PostCompact
  └─ recovery
       ├─ SessionStart(compact)   one-shot root restore
       └─ UserPromptSubmit        first matching fallback / semantic subtask restore
```

Recovery is accepted only while the saved transcript snapshot is still the prefix of the same source. Same-source appends are allowed on matching lifecycle paths; replacement, rewrite, or identity mismatch retires the pending restore. Failed local hook output keeps it pending for retry.

`show-context` prints the exact semantic payload prepared for recovery. `show` keeps diagnostic metadata separate.

## Evidence

### Input handling

The bundled six-generation fixture compares rereading the full growing transcript at every compaction with capturing each byte once as a delta.

| Strategy | Input bytes | Change |
| --- | ---: | ---: |
| Full reread | 1,015,521 | baseline |
| Delta capture | 210,506 | **−79.27%** |

Run `npm run benchmark` to reproduce it. This is an input-byte proxy from a synthetic fixture, not a measured token, cost, latency, or task-quality claim. Timings are reported separately because they depend on the machine.

<details>
<summary><strong>Sidecar projection result</strong></summary>

<br>

The same deterministic benchmark exercises the disposable sidecar projection without a model or network call.

| Sidecar input | Bytes | Change |
| --- | ---: | ---: |
| Raw unseen deltas | 179,274 | baseline |
| Derived sidecar view | 81,263 | **−54.67%** |

The fixture masks one base64 data URL and one explicit binary envelope, folds one exact oversized duplicate, preserves ordinary long text, deletes the derived view, and confirms that the raw delta SHA-256 is unchanged. These are byte measurements for this fixture, not token savings.

</details>

### Task-state retention

A paired real-host acceptance used three existing semantic fixtures, each extended to roughly 159 KiB, under native compact alone and native compact plus checkpoint restore.

| Result | Native compact | Checkpoint restore |
| --- | ---: | ---: |
| Task-state items retained in the correct field | 24/25 (96%) | **25/25 (100%)** |
| Entire semantic fields exactly equal | 22/24 (91.7%) | **23/24 (95.8%)** |
| Execution-critical literals retained | 13/14 (92.9%) | **14/14 (100%)** |
| Exact Constraints + Do not retry fields | 6/6 (100%) | 6/6 (100%) |
| Forbidden-claim trap hits | 0 | 0 |
| Successful `SessionStart` restore receipts | n/a | 3/3 |

Native compact dropped one exact hook path; checkpoint restore retained it. Constraint fields tied at 6/6, so the observed advantage was in overall task-state retention, not constraint retention.

This is a small paired acceptance—three fixtures and one run per arm—not a statistical or general task-quality claim.

<details>
<summary><strong>Acceptance method and limits</strong></summary>

<br>

Each fixture received 1,800 neutral log lines (159,261–159,286 UTF-8 bytes). Both arms used fresh tasks, `gpt-5.6-sol`, the same input and compaction point, a real App Server [`thread/compact/start`](https://developers.openai.com/codex/app-server#trigger-thread-compaction), and the same structured post-compact probe. Scoring used exact strings and expected fields, with no LLM judge. The run used `codex-cli 0.150.0-alpha.8` and plugin v0.4.0.

The restore arm wrote each fixture's predeclared semantic checkpoint immediately before the measured compact. It therefore measures restore retention, not semantic generation quality. Both arms added an already-present `Command: npm test` as an extra Next action, so neither achieved perfect field equality. All three restore receipts were `local_output_succeeded` with 595–634-byte payloads; every probe returned valid JSON and used no tool.

Semantic generation remains a separate, explicit probe: `npm run benchmark:semantic`.

</details>

### Lifecycle coverage

The test suite covers checkpoint transactions, lock ownership, cursor reconciliation, retention, thread selection, transcript replacement and rewrite detection, root and subtask recovery, failed-output retry, semantic gates, restore ordering, sidecar projection and thresholds, Windows launch behavior, and bounded schema validation.

```bash
cd plugins/context-checkpoint
npm test
```

Tests and benchmarks are reproducible evidence for those code paths. They do not replace a restarted-host acceptance of manual semantic refresh → compact → `SessionStart` or first-prompt fallback recovery.

## Inspect and configure

<details>
<summary><strong>Checkpoint state and thread selection</strong></summary>

<br>

Run these commands from `plugins/context-checkpoint`:

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

Manual commands refuse to guess when a workspace has multiple threads. Pass the `selector` returned by `sessions` to `--thread-id`. Child selectors use `agent:<encoded-session-id>:<encoded-agent-id>`; `--session-id` remains a root-task compatibility alias.

- `status` reports strict snapshot diagnostics and the reset-aware semantic backlog.
- `history` indexes retained generations. Missing history or delta ranges block sidecar advancement.
- `sessions --storage` reports per-thread and workspace totals without deleting data.
- `sessions --discover` reports alternate stored identities for the same normalized workspace root. It never merges or selects them.

To inspect an alternate identity, set `CONTEXT_CHECKPOINT_DATA_DIR` for that command to `PLUGIN_DATA/workspaces/<identity>/context-checkpoint`, or to `CODEX_HOME/plugin-data/context-checkpoint/workspaces/<identity>` for the fallback layout.

The recovery payload follows the shared field-level JSON Schema. Goal is a nonblank single line; Next actions contains one to three nonblank single-line items; other arrays may be empty. Items are capped at 80 characters and exact duplicates are removed within each field. Restore order is Goal, Constraints, Do not retry, Acceptance criteria, Next actions, Current progress, Decisions, and Open questions.

`additionalContextLimit: 2500` remains the host's approximate token threshold; larger hook context is handled by Codex. `semantic_source=manual` or `sidecar` identifies origin, not review status, so both are reported as `unreviewed`.

</details>

<details>
<summary><strong>Optional semantic sidecar</strong></summary>

<br>

This example checks before every third completed compaction and refreshes only when retained deltas unseen by the semantic checkpoint total at least 32 KiB:

```bash
export CONTEXT_CHECKPOINT_SIDECAR_EVERY=3
export CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES=32768
```

PowerShell:

```powershell
$env:CONTEXT_CHECKPOINT_SIDECAR_EVERY = '3'
$env:CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES = '32768'
```

Before launch, the plugin verifies retained raw deltas against their recorded SHA-256 values and builds a disposable `sidecar-view`. The projection replaces only canonical base64 data URLs, exact base64 envelopes, and later byte-identical string payloads of at least 32 KiB. Unique source, logs, diffs, numeric output, and errors remain intact.

The child reads only derived files and runs with `codex exec --ephemeral --sandbox read-only`, hooks disabled, a minimal environment, and a working directory outside the target workspace. Afterward, the plugin rechecks raw hashes and deletes the view. Invalid semantics fail closed; cleanup failure fails that attempt; sidecar failure never blocks native compaction.

These launch constraints reduce exposure but are not a hard local-file read isolation boundary.

</details>

## Storage and privacy

- **Location:** raw deltas live under `PLUGIN_DATA/workspaces/<workspace-id>/context-checkpoint`, falling back to `CODEX_HOME/plugin-data/context-checkpoint`. Nothing is written to the target repository.
- **Content:** deltas can contain sensitive conversation text. Plugin-created files request `0700`/`0600` modes on POSIX; Windows uses the current account's ACLs.
- **Retention:** the newest 50 generations and any older generation not yet covered by the semantic checkpoint are retained. Historical sessions are not deleted automatically.
- **Limits:** a delta is capped at 64 MiB by default. An oversized range is recorded as `skipped-too-large`; later capture resumes, while the semantic gap blocks sidecar coverage until a manual baseline is created.
- **Network:** deterministic hooks make no network request. Only an explicitly enabled sidecar sends its prompt through the configured Codex execution path.

Use `sessions --storage` to inspect disk use. Override limits with `CONTEXT_CHECKPOINT_MAX_DELTA_BYTES` and `CONTEXT_CHECKPOINT_RETENTION_GENERATIONS`.

## Development

```bash
cd plugins/context-checkpoint
npm test
npm run benchmark
```

`npm run benchmark:semantic` is a separate sidecar-quality probe. It invokes the configured Codex model/network and is intentionally excluded from deterministic tests and release gates.

<details>
<summary><strong>Repository layout</strong></summary>

<br>

```text
.agents/plugins/marketplace.json       Marketplace entry
plugins/context-checkpoint/
  .codex-plugin/plugin.json            Plugin manifest
  hooks/                               Command hooks and state machine
  skills/context-checkpoint/           Manual semantic refresh Skill
  schemas/                             Structured checkpoint Schema
  tests/                               Lifecycle and failure-mode tests
  bench/                               Input-size and semantic-quality probes
```

</details>

## Security

Read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Do not include transcripts, checkpoint state, credentials, or other private data in a public issue.

## License

MIT
