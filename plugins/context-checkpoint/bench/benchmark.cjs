'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const checkpoint = require('../hooks/context-checkpoint.cjs');

const work = path.resolve('work');
fs.mkdirSync(work, { recursive: true });
const root = fs.mkdtempSync(path.join(work, 'context-checkpoint-bench-'));
const workspace = path.join(root, 'repo');
const transcript = path.join(root, 'transcript.jsonl');
const data = path.join(root, 'state');
fs.mkdirSync(workspace, { recursive: true });
const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
assert.equal(git.status, 0, git.stderr);
fs.writeFileSync(transcript, `${'initial context '.repeat(8000)}\n`);

let baselineBytes = 0;
let deltaBytes = 0;
let baselineReadMs = 0;
let preCompactMs = 0;
let postCompactMs = 0;
let sessionStartMs = 0;
const generations = 6;
const started = performance.now();
try {
  for (let generation = 1; generation <= generations; generation += 1) {
    if (generation > 1) fs.appendFileSync(transcript, `${`new turn ${generation} `.repeat(1500)}\n`);
    const baselineStarted = performance.now();
    const baseline = fs.readFileSync(transcript);
    baselineReadMs += performance.now() - baselineStarted;
    baselineBytes += baseline.length;
    const input = {
      session_id: 'benchmark-session',
      turn_id: `turn-${generation}`,
      cwd: workspace,
      transcript_path: transcript,
      trigger: 'auto',
      model: 'benchmark',
    };
    const preCompactStarted = performance.now();
    checkpoint.handleHook({ ...input, hook_event_name: 'PreCompact' }, {
      ...process.env,
      CONTEXT_CHECKPOINT_DATA_DIR: data,
    });
    preCompactMs += performance.now() - preCompactStarted;
    const ctx = checkpoint.resolveContext(input, { CONTEXT_CHECKPOINT_DATA_DIR: data });
    const current = JSON.parse(fs.readFileSync(ctx.current, 'utf8'));
    deltaBytes += current.transcript_delta.bytes;
    assert.equal(current.sidecar.status, 'disabled');
    const postCompactStarted = performance.now();
    checkpoint.handleHook({ ...input, hook_event_name: 'PostCompact' }, {
      ...process.env,
      CONTEXT_CHECKPOINT_DATA_DIR: data,
    });
    postCompactMs += performance.now() - postCompactStarted;
    const sessionStartStarted = performance.now();
    checkpoint.handleHook({ ...input, hook_event_name: 'SessionStart', source: 'compact' }, {
      ...process.env,
      CONTEXT_CHECKPOINT_DATA_DIR: data,
    });
    sessionStartMs += performance.now() - sessionStartStarted;
  }
  const snapshotProbeStarted = performance.now();
  for (let sample = 0; sample < generations; sample += 1) checkpoint.workspaceSnapshot(workspace);
  const fullWorkspaceSnapshotProbeMs = performance.now() - snapshotProbeStarted;
  assert.equal(deltaBytes, fs.statSync(transcript).size);
  assert.ok(deltaBytes < baselineBytes);
  const report = {
    generations,
    baseline_full_rescan_bytes: baselineBytes,
    transcript_delta_bytes: deltaBytes,
    byte_reduction_percent: Number((100 * (1 - deltaBytes / baselineBytes)).toFixed(2)),
    input_byte_proxy_reduction_percent: Number((100 * (1 - deltaBytes / baselineBytes)).toFixed(2)),
    baseline_full_read_ms: Number(baselineReadMs.toFixed(2)),
    pre_compact_ms: Number(preCompactMs.toFixed(2)),
    post_compact_ms: Number(postCompactMs.toFixed(2)),
    session_start_ms: Number(sessionStartMs.toFixed(2)),
    checkpoint_hook_ms: Number((preCompactMs + postCompactMs + sessionStartMs).toFixed(2)),
    full_workspace_snapshot_probe_calls: generations,
    full_workspace_snapshot_probe_ms: Number(fullWorkspaceSnapshotProbeMs.toFixed(2)),
    sidecar_calls: 0,
    total_elapsed_ms: Number((performance.now() - started).toFixed(2)),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  assert.ok(root.startsWith(work + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
