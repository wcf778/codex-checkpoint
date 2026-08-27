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

## Modes

- **Default mechanical mode** automatically records transcript deltas, lifecycle state, and a committed cursor. It does not generate or inject semantic task state.
- **Optional semantic recovery mode** requires an explicit `$context-checkpoint` refresh or the opt-in sidecar. Only a fresh checkpoint with a non-empty Goal and at least one Next action is injected once after compaction.

## The problem

After a long task has crossed several compaction boundaries, its recovery state is difficult to inspect. Repeatedly scanning the full transcript grows with the task, while blindly restoring an old summary risks injecting stale goals, decisions, or next actions. Codex Checkpoint adds a small, deterministic recovery layer while native Codex compaction remains the primary semantic compressor.

## Before / after

**Native compaction only**

- No plugin-owned recovery generation
- No durable transcript cursor
- No independent freshness gate

**With Codex Checkpoint**

- `PreCompact` captures only unseen transcript bytes
- `PostCompact` commits the completed generation and transcript cursor; an exact root `SessionStart(compact)` can finish a missed `PostCompact`
- When semantic state exists, matching lifecycle hooks accept same-source transcript appends without parsing Codex's private transcript record types; the first observed matching `UserPromptSubmit` is a one-shot fallback and handles compacted subtasks

## Why Codex Checkpoint

- **Low overhead by default** — deterministic Node.js hooks make no network request and launch no model.
- **Incremental, not cumulative** — each generation stores only the uncommitted transcript byte range.
- **Freshness-gated recovery** — replaced, rewritten, or mismatched transcript sources are not auto-injected; matching lifecycle hooks may accept an unchanged snapshot prefix followed by same-source appends.
- **Observable, one-shot restore** — stable eligibility reasons and a metadata-only local-output receipt support audits; failed local hook output retains pending recovery for retry.
- **Failure-safe lifecycle** — completed checkpoints reconcile their files, cursor, and durable `pending`/`delivered`/`retired` recovery disposition after an interrupted write.
- **Fail-closed semantic continuation** — missing Goal or Next action blocks restore, while unknown constraints or acceptance criteria remain explicitly unknown instead of being invented.
- **Inspectable model context** — `show-context` prints the exact semantic payload prepared for recovery; `show` remains the diagnostic view.
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

The same deterministic benchmark also exercises the disposable sidecar projection with no model or network call:

| Sidecar input | Bytes | Change |
| --- | ---: | ---: |
| Raw unseen deltas | 179,274 | baseline |
| Derived sidecar view | 81,263 | **−54.67%** |

That fixture masks one base64 data URL and one explicit binary envelope, folds one exact oversized duplicate, preserves ordinary long text, deletes the derived view, and confirms the raw delta SHA-256 is unchanged. These are byte-proxy measurements for this fixture, not token savings.

### Paired task-state retention acceptance (2026-08-27)

A bounded real-host acceptance compared the three existing semantic fixtures under native compact alone and native compact plus checkpoint restore. Each fixture was extended with 1,800 neutral log lines (159,261–159,286 UTF-8 bytes). Both arms used fresh tasks, `gpt-5.6-sol`, the same input and compaction point, a real App Server [`thread/compact/start`](https://developers.openai.com/codex/app-server#trigger-thread-compaction), and the same structured post-compact probe. Scoring was exact-string and field-aware, with no LLM judge. There was one run per fixture and arm: six tasks total. The run used `codex-cli 0.150.0-alpha.8` and plugin v0.4.0; the probe used low reasoning effort, while compaction remained host-native.

The restore arm wrote each fixture's predeclared semantic checkpoint immediately before the measured compact. This isolates restore retention; it does not measure semantic generation, which remains the separate purpose of `npm run benchmark:semantic`.

| Result | Native compact | Checkpoint restore |
| --- | ---: | ---: |
| Predeclared task-state items retained in the correct field | 24/25 (96%) | **25/25 (100%)** |
| Entire semantic fields exactly equal to the expected field | 22/24 (91.7%) | **23/24 (95.8%)** |
| Execution-critical literals retained | 13/14 (92.9%) | **14/14 (100%)** |
| Exact Constraints + Do not retry fields | 6/6 (100%) | 6/6 (100%) |
| Forbidden-claim trap hits | 0 | 0 |
| Successful `SessionStart` restore receipts | n/a | 3/3 |

Native compact dropped the exact `plugins/context-checkpoint/hooks/context-checkpoint.cjs` path from one fixture; restore retained it. The dedicated constraint fields tied at 6/6, so this run observed an overall task-state retention advantage, not a constraint-field advantage. Both arms added the already-present `Command: npm test` as an extra next action in the release fixture, so neither arm achieved perfect field equality. All three restore receipts were `local_output_succeeded` (595–634-byte payloads), every probe returned valid JSON, and no probe used a tool.

This small paired run shows better retention on these fixtures only. With three fixtures and one observation per arm, it is not a statistical or general task-quality claim. The one-off controller is intentionally not part of default tests or release gates.

### Lifecycle and failure-mode coverage

The automated tests cover lock ownership, idempotency, interrupted completion reconciliation, transcript replacement and rewrite detection, lifecycle append recovery, one-shot root and subtask recovery, failed-output receipts and retry, restore diagnostics, semantic Goal/Next-action gates, exact deduplication and restore ordering, identity discovery, legacy path boundaries, retained-history inspection, storage reporting, retention, accumulated sidecar thresholds, delta checksum gates, disposable sidecar projection and byte telemetry, sidecar launch and semantic-quality constraints, recursion guards, CLI ambiguity, Windows launcher behavior, and bounded schema validation.

```bash
cd plugins/context-checkpoint
npm test
```

The tests and benchmark are the reproducible public evidence for these code paths. They do not replace a restarted-host acceptance run of manual semantic refresh → compact → `SessionStart` or first-prompt fallback restore.

## How it works

```text
Codex task
  -> PreCompact: capture deterministic delta + workspace marker
  -> native compact: primary semantic compression
  -> PostCompact: commit generation + transcript cursor
     (or exact root SessionStart(compact) fallback if PostCompact was missed)
  -> SessionStart(compact): one-shot root restore when the saved transcript prefix is unchanged
  -> UserPromptSubmit: one-shot fallback for the first observed matching post-compact prompt and semantic subtasks
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

Restart Codex, review the command hooks when prompted, and start a new task. Routine mechanical capture then needs no manual action; semantic recovery still requires the manual Skill or an explicitly enabled sidecar.

The Skill is explicit-only and may be absent from the initial automatic Skill list. After installation or updates, use a new task and select `$context-checkpoint` explicitly; if the update is still unavailable, restart Codex.

The repository and marketplace are named `codex-checkpoint`; the installed plugin id remains `context-checkpoint` for compatibility.

The plugin cannot install project configuration. To use the recommended native compact prompt, merge [`plugins/context-checkpoint/examples/codex-config.toml`](plugins/context-checkpoint/examples/codex-config.toml) into the target repository's `.codex/config.toml`.

## Use

For an explicit semantic refresh at a handoff or phase boundary:

```text
$context-checkpoint refresh the current task checkpoint
```

For immediate recovery, compact before submitting another normal user prompt. A later prompt invalidates the pending manual carry-forward rather than treating newer task changes as covered.

## Advanced usage

<details>
<summary><strong>Inspect checkpoint state</strong></summary>

<br>

Run these commands from the plugin directory:

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

Manual commands refuse to guess when a workspace has multiple threads. Use the `selector` returned by `sessions` with `--thread-id`; child selectors use `agent:<encoded-session-id>:<encoded-agent-id>`, and `--session-id` remains a root-task compatibility alias. `status` reports strict snapshot restore diagnostics plus a reset-aware semantic backlog; lifecycle hooks may still accept a same-source append after that snapshot. A missing history or delta range is reported explicitly and blocks sidecar advancement. Retention never removes an unresolved backlog. `history` indexes retained generations, and `sessions --storage` reports per-thread bytes, last update, the same strict snapshot diagnostic, and workspace totals without deleting anything. `sessions --discover` read-only reports alternate stored identities with the exact same normalized workspace root; it never merges or selects them. To inspect one explicitly, set `CONTEXT_CHECKPOINT_DATA_DIR` for that command to `PLUGIN_DATA/workspaces/<identity>/context-checkpoint`, or to `CODEX_HOME/plugin-data/context-checkpoint/workspaces/<identity>` when using the fallback layout. Hook recovery uses a dedicated task-state payload bounded by the shared field-level JSON schema; Goal must be a nonblank single-line string, Next actions must contain one to three nonblank single-line items, and other arrays may be empty. Array items are capped at 80 characters so demonstrated paths and SHA-256 literals fit while context remains bounded. Exact duplicate items are removed independently within each field while case and whitespace differences remain distinct. Restore order is fixed as Goal, Constraints, Do not retry, Acceptance criteria, Next actions, Current progress, Decisions, and Open questions; the plugin does not guess whether similar decisions or errors supersede one another. It does not impose a second aggregate byte schema. The configured `additionalContextLimit: 2500` remains an approximate host token threshold; larger hook context is handled by Codex. `show-context` prints only the exact recovery payload; `show` keeps the full diagnostic view. `semantic_source=manual` or `sidecar` identifies origin, not user review, so diagnostics label either source `unreviewed`.

</details>

<details>
<summary><strong>Optional semantic sidecar</strong></summary>

<br>

The sidecar is disabled by default. This example requests a refresh before every third completed compaction when retained deltas unseen by the semantic checkpoint total at least 32 KiB:

```bash
export CONTEXT_CHECKPOINT_SIDECAR_EVERY=3
export CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES=32768
```

On PowerShell:

```powershell
$env:CONTEXT_CHECKPOINT_SIDECAR_EVERY = '3'
$env:CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES = '32768'
```

Before launch, the plugin verifies each retained raw delta against its recorded SHA-256, then creates a disposable, content-based `sidecar-view`. It replaces only canonical base64 data URLs, exact `{encoding, media_type, data}` base64 envelopes, and later byte-identical string payloads of at least 32 KiB; the first oversized occurrence and unique ordinary source, logs, diffs, numeric output, and errors remain unchanged. The transformer does not inspect Codex transcript record types, summarize text, or use similarity heuristics. The child reads only those derived files and runs with `codex exec --ephemeral --sandbox read-only`, hooks disabled, a minimal environment, and a cwd outside the target workspace. After the child returns—even with a local failure—the plugin rechecks the raw SHA-256 and attempts to delete the view; a cleanup failure is reported and marks that sidecar attempt failed. It stores only raw/projected byte counts, reduction, and rule-hit counts with the sidecar result, never projected content. The prompt keeps unknowns in `open_questions`, preserves bounded execution-critical literals and negative polarity, separates runtime completion from result validation, and omits a decision or error only when later evidence explicitly marks it superseded or resolved. These launch constraints are not a hard local-file read isolation boundary. Invalid sidecar semantics fail closed and never advance semantic coverage. A sidecar failure never blocks native compaction.

</details>

## Storage and privacy

- Raw transcript deltas are stored under `PLUGIN_DATA/workspaces/<workspace-id>/context-checkpoint`. If `PLUGIN_DATA` is unavailable, the fallback is under `CODEX_HOME/plugin-data/context-checkpoint`; state is never written to the target repository.
- Transcript deltas can contain sensitive conversation content. Plugin-created directories/files request `0700`/`0600` modes on POSIX; Windows continues to use the account's existing ACLs.
- Sidecar views are temporary derived inputs under plugin state. Cleanup is attempted after each completed or locally failed sidecar attempt; cleanup failure is reported and fails that attempt. Raw deltas remain the audit source of truth and are never rewritten by the projection path.
- A single delta is limited to 64 MiB by default. An oversized range is recorded as `skipped-too-large`; its cursor advances only after lifecycle completion, later deltas resume normally, and the explicit semantic gap blocks sidecar coverage until a manual semantic baseline is created. The newest 50 generations plus any older generations not yet covered by the semantic checkpoint are retained. Override the limits with `CONTEXT_CHECKPOINT_MAX_DELTA_BYTES` and `CONTEXT_CHECKPOINT_RETENTION_GENERATIONS`.
- Historical sessions are not deleted automatically. Inspect their size with `sessions --storage`; cleanup remains an explicit operator action.
- The deterministic hook path makes no network request. Enabling the sidecar explicitly sends its prompt through the configured Codex execution path.

## Development

```bash
cd plugins/context-checkpoint
npm test
npm run benchmark
```

`npm run benchmark:semantic` is a separate, explicit sidecar-quality probe. It invokes the configured Codex model/network, reports exact-literal, negation, unknown, next-action, and forbidden-claim-trap results, and is intentionally excluded from deterministic tests and release gates.

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
  bench/                               Input-size and opt-in semantic-quality benchmarks
```

</details>

## Security

Please review [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Do not include transcripts, checkpoint state, credentials, or other private data in a public issue.

## License

MIT
