'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const env = {
  ...process.env,
  CONTEXT_CHECKPOINT_DATA_DIR: data,
  CONTEXT_CHECKPOINT_SIDECAR_EVERY: '0',
};
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
    checkpoint.handleHook({ ...input, hook_event_name: 'PreCompact' }, env);
    preCompactMs += performance.now() - preCompactStarted;
    const ctx = checkpoint.resolveContext(input, { CONTEXT_CHECKPOINT_DATA_DIR: data });
    const current = JSON.parse(fs.readFileSync(ctx.current, 'utf8'));
    deltaBytes += current.transcript_delta.bytes;
    assert.equal(current.sidecar.status, 'disabled');
    const postCompactStarted = performance.now();
    checkpoint.handleHook({ ...input, hook_event_name: 'PostCompact' }, env);
    postCompactMs += performance.now() - postCompactStarted;
    const sessionStartStarted = performance.now();
    checkpoint.handleHook({ ...input, hook_event_name: 'SessionStart', source: 'compact' }, env);
    sessionStartMs += performance.now() - sessionStartStarted;
  }
  const snapshotProbeStarted = performance.now();
  for (let sample = 0; sample < generations; sample += 1) checkpoint.workspaceSnapshot(workspace);
  const fullWorkspaceSnapshotProbeMs = performance.now() - snapshotProbeStarted;
  assert.equal(deltaBytes, fs.statSync(transcript).size);
  assert.ok(deltaBytes < baselineBytes);

  const projectionDelta = path.join(root, 'sidecar-projection.jsonl');
  const duplicate = `duplicate:${'D'.repeat(32 * 1024)}`;
  const ordinary = `compiler error: ${'source-line '.repeat(4000)}`;
  fs.writeFileSync(projectionDelta, [
    { content: `data:image/png;base64,${Buffer.alloc(24 * 1024, 0x41).toString('base64')}` },
    { payload: { encoding: 'base64', media_type: 'application/octet-stream', data: Buffer.alloc(24 * 1024, 0x42).toString('base64') } },
    { content: ordinary },
    { content: duplicate },
    { content: duplicate },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const projectionBefore = crypto.createHash('sha256').update(fs.readFileSync(projectionDelta)).digest('hex');
  const projectionContext = checkpoint.resolveContext({
    session_id: 'benchmark-projection', cwd: workspace,
  }, { CONTEXT_CHECKPOINT_DATA_DIR: data });
  fs.mkdirSync(projectionContext.sessionDir, { recursive: true });
  let projectedPaths;
  const projection = checkpoint.runSidecar({
    generation: 1,
    sidecar_delta_paths: [projectionDelta],
    semantic: {
      goal: 'Measure the deterministic sidecar projection.',
      acceptance_criteria: ['Report byte-proxy metrics only.'],
      constraints: ['Do not claim token savings.'],
      decisions: [], current_progress: [], negative_knowledge: [], open_questions: [],
      next_actions: ['Inspect the projection metrics.'],
    },
  }, projectionContext, {
    ...env, CONTEXT_CHECKPOINT_CODEX_BIN: process.execPath,
  }, (_command, args, options) => {
    const prefix = 'Disposable sidecar-view files derived from transcript deltas since the last semantic checkpoint: ';
    const line = options.input.split('\n').find((item) => item.startsWith(prefix));
    projectedPaths = JSON.parse(line.slice(prefix.length));
    const values = fs.readFileSync(projectedPaths[0], 'utf8').trimEnd()
      .split('\n').map((item) => JSON.parse(item));
    assert.equal(values[2].content, ordinary);
    const output = args[args.indexOf('--output-last-message') + 1];
    fs.writeFileSync(output, JSON.stringify({
      goal: 'Measure the deterministic sidecar projection.',
      acceptance_criteria: ['Report byte-proxy metrics only.'],
      constraints: ['Do not claim token savings.'],
      decisions: [], current_progress: [], negative_knowledge: [], open_questions: [],
      next_actions: ['Inspect the projection metrics.'],
    }));
    return { status: 0 };
  });
  assert.equal(projection.status, 'completed');
  assert.equal(projection.reduction_bytes,
    projection.raw_input_bytes - projection.projected_input_bytes);
  assert.equal(projection.reduction_percent,
    Number((100 * projection.reduction_bytes / projection.raw_input_bytes).toFixed(2)));
  assert.deepEqual([
    projection.masked_data_urls,
    projection.masked_binary_payloads,
    projection.deduplicated_payloads,
  ], [1, 1, 1]);
  const projectionRawUnchanged = crypto.createHash('sha256')
    .update(fs.readFileSync(projectionDelta)).digest('hex') === projectionBefore;
  assert.equal(projectionRawUnchanged, true);
  assert.ok(projectedPaths.every((file) => !fs.existsSync(file)));
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
    sidecar_projection_raw_input_bytes: projection.raw_input_bytes,
    sidecar_projection_projected_input_bytes: projection.projected_input_bytes,
    sidecar_projection_reduction_bytes: projection.reduction_bytes,
    sidecar_projection_input_byte_proxy_reduction_percent: projection.reduction_percent,
    sidecar_projection_masked_data_urls: projection.masked_data_urls,
    sidecar_projection_masked_binary_payloads: projection.masked_binary_payloads,
    sidecar_projection_deduplicated_payloads: projection.deduplicated_payloads,
    sidecar_projection_raw_delta_sha256_unchanged: projectionRawUnchanged,
    sidecar_calls: 0,
    model_or_network_calls: 0,
    total_elapsed_ms: Number((performance.now() - started).toFixed(2)),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  assert.ok(root.startsWith(work + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
