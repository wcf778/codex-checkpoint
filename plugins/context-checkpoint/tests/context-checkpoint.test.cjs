'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const project = path.resolve(__dirname, '..');
const runner = path.join(project, 'hooks', 'context-checkpoint.cjs');
const checkpoint = require(runner);
const work = path.join(project, 'work');
const roots = [];
fs.mkdirSync(work, { recursive: true });

function spawnHookCommand(command, options) {
  return process.platform === 'win32'
    ? spawnSync(command, { ...options, shell: process.env.ComSpec })
    : spawnSync(command, { ...options, shell: true });
}

after(() => {
  for (const root of roots) {
    assert.ok(root.startsWith(work + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(content = '{"turn":1}\n') {
  const root = fs.mkdtempSync(path.join(work, 'test-'));
  roots.push(root);
  const workspace = path.join(root, 'repo');
  const data = path.join(root, 'state');
  const pluginData = path.join(root, 'plugin-data');
  const transcript = path.join(root, 'transcript.jsonl');
  fs.mkdirSync(workspace, { recursive: true });
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  fs.writeFileSync(transcript, content);
  const env = {
    ...process.env,
    CONTEXT_CHECKPOINT_DATA_DIR: data,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '0',
  };
  function event(name, turn = 'turn-1', session = 'session-1', cwd = workspace) {
    return {
      session_id: session,
      turn_id: turn,
      cwd,
      transcript_path: transcript,
      hook_event_name: name,
      trigger: 'auto',
      model: 'test-model',
    };
  }
  return { root, workspace, data, pluginData, transcript, env, event };
}

function readCurrent(f, session = 'session-1', env = f.env) {
  const ctx = checkpoint.resolveContext(f.event('PreCompact', 'turn', session), env);
  return JSON.parse(fs.readFileSync(ctx.current, 'utf8'));
}

function complete(f, turn = 'turn-1', session = 'session-1', env = f.env, deps) {
  checkpoint.handleHook(f.event('PreCompact', turn, session), env, deps);
  checkpoint.handleHook(f.event('PostCompact', turn, session), env);
}

function semantic(goal = 'Current goal', next = 'Do the exact next action') {
  return {
    goal,
    acceptance_criteria: ['Focused checks pass.'],
    constraints: ['Keep hooks deterministic by default.'],
    decisions: ['Use command hooks only.'],
    current_progress: ['Checkpoint captured.'],
    negative_knowledge: ['Agent hooks are parsed but skipped.'],
    open_questions: [],
    next_actions: [next],
  };
}

function runCli(f, args, env = f.env) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: f.workspace,
    env,
    encoding: 'utf8',
  });
}

test('a process that does not own the lock leaves the active lock intact', () => {
  const f = fixture();
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  fs.mkdirSync(ctx.sessionDir, { recursive: true });
  fs.writeFileSync(ctx.lock, 'owner');
  const result = checkpoint.handleHook(f.event('PreCompact'), f.env);
  assert.deepEqual(result, { action: 'locked' });
  assert.equal(fs.readFileSync(ctx.lock, 'utf8'), 'owner');
});

test('generation guard and committed transcript cursor are idempotent', () => {
  const f = fixture();
  assert.deepEqual(checkpoint.handleHook(f.event('PreCompact'), f.env), {
    action: 'prepared', generation: 1,
  });
  assert.deepEqual(checkpoint.handleHook(f.event('PreCompact'), f.env), {
    action: 'duplicate', generation: 1,
  });
  assert.equal(checkpoint.handleHook(f.event('PostCompact', 'wrong'), f.env).action, 'stale-postcompact');
  checkpoint.handleHook(f.event('PostCompact'), f.env);
  assert.equal(readCurrent(f).completion_source, 'postcompact');

  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), f.env);
  const current = readCurrent(f);
  assert.equal(current.generation, 2);
  assert.equal(current.transcript_delta.mode, 'append');
  assert.equal(current.transcript_delta.bytes, Buffer.byteLength('{"turn":2}\n'));
});

test('a replaced transcript at the same path resets the delta cursor', () => {
  const f = fixture('AAAA');
  complete(f);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Old task')));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']).status, 0);
  fs.writeFileSync(f.transcript, 'BBBBBBBB');
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), f.env);
  checkpoint.handleHook(f.event('PostCompact', 'turn-2'), f.env);
  const current = readCurrent(f);
  assert.equal(current.transcript_delta.mode, 'reset');
  assert.equal(current.transcript_delta.bytes, 8);
  assert.equal(fs.readFileSync(current.transcript_delta.delta_path, 'utf8'), 'BBBBBBBB');
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env), null);
});

test('an in-place rewrite near the committed cursor resets the delta', () => {
  const f = fixture('A'.repeat(10000));
  complete(f);
  const fd = fs.openSync(f.transcript, 'r+');
  try {
    fs.writeSync(fd, Buffer.from('BBBB'), 0, 4, 8000);
  } finally {
    fs.closeSync(fd);
  }
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), f.env);
  assert.equal(readCurrent(f).transcript_delta.mode, 'reset');
});

test('empty mechanical checkpoints are not injected after native compaction', () => {
  const f = fixture();
  complete(f);
  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env);
  assert.equal(restored, null);
  assert.equal(fs.existsSync(checkpoint.resolveContext(f.event('PreCompact'), f.env).recovery), false);
});

test('semantic restoration keeps every bounded checkpoint section', () => {
  const f = fixture();
  complete(f);
  const semanticFile = path.join(f.root, 'semantic.json');
  const value = semantic('Restore this task', 'TAIL-NEXT-ACTION');
  value.constraints = new Array(3).fill('x'.repeat(50));
  fs.writeFileSync(semanticFile, JSON.stringify(value));
  const update = runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.equal(update.status, 0, update.stderr);
  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env);
  assert.match(restored.hookSpecificOutput.additionalContext, /TAIL-NEXT-ACTION/);
  assert.doesNotMatch(restored.hookSpecificOutput.additionalContext, /Generation|Workspace|Transcript|Semantic source/);
});

test('the maximum schema-valid multibyte semantic checkpoint remains restorable', () => {
  const f = fixture();
  complete(f);
  const semanticFile = path.join(f.root, 'semantic.json');
  const value = { goal: '目'.repeat(200) };
  const characters = {
    acceptance_criteria: '验',
    constraints: '限',
    decisions: '决',
    current_progress: '进',
    negative_knowledge: '禁',
    open_questions: '问',
    next_actions: '行',
  };
  for (const [key, character] of Object.entries(characters)) {
    value[key] = [1, 2, 3].map((index) => `${character.repeat(79)}${index}`);
  }
  fs.writeFileSync(semanticFile, JSON.stringify(value));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']).status, 0);

  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env);
  const payload = restored.hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(payload, 'utf8') > 2500);
  assert.match(payload, /## Goal/);
  assert.ok(payload.includes(value.goal));
  for (const items of Object.values(value).filter(Array.isArray)) {
    for (const item of items) assert.ok(payload.includes(item));
  }
  for (const heading of [
    'Acceptance criteria', 'Constraints', 'Decisions', 'Current progress',
    'Do not retry', 'Open questions', 'Next actions',
  ]) assert.ok(payload.includes(`## ${heading}`));
  assert.doesNotMatch(payload, /Generation|Workspace|Transcript|Semantic source/);
});

test('show-context prints the exact restore payload in execution order', () => {
  const f = fixture();
  complete(f);
  const semanticFile = path.join(f.root, 'semantic.json');
  const value = semantic('Inspect recovery payload');
  value.open_questions = ['Keep unknown facts unknown.'];
  fs.writeFileSync(semanticFile, JSON.stringify(value));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']).status, 0);

  const shown = runCli(f, ['show-context', '--thread-id', 'session-1']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, checkpoint.renderRestoreContext(readCurrent(f)));
  const headings = [
    'Goal', 'Constraints', 'Do not retry', 'Acceptance criteria',
    'Next actions', 'Current progress', 'Decisions', 'Open questions',
  ];
  assert.deepEqual(
    [...shown.stdout.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    headings,
  );
  assert.doesNotMatch(shown.stdout, /Generation|Workspace|Transcript|Semantic source/);
  const diagnostic = runCli(f, ['show', '--thread-id', 'session-1']);
  assert.match(diagnostic.stdout, /Semantic source: manual/);
  assert.match(diagnostic.stdout, /Semantic verification: unreviewed/);
  const legacy = semantic('Legacy duplicate state');
  legacy.constraints = ['Keep one exact item.', 'Keep one exact item.'];
  assert.equal(checkpoint.renderRestoreContext({ semantic: legacy })
    .match(/^- Keep one exact item\.$/gm).length, 1);
});

test('SessionStart trusts a same-source append without parsing transcript records', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Fresh compact goal') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  fs.appendFileSync(f.transcript, 'opaque-host-tail\n');
  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1'], env).stdout);
  assert.equal(status.restore_reason, 'unexpected_transcript_tail');
  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Fresh compact goal/);
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env), null);
});

test('the first observed UserPromptSubmit trusts a same-source append', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Fresh compact goal') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  fs.appendFileSync(f.transcript, 'opaque-prompt-tail\n');
  const restored = checkpoint.handleHook(f.event('UserPromptSubmit', 'prompt-turn'), env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Fresh compact goal/);
  assert.equal(checkpoint.handleHook(f.event('UserPromptSubmit', 'later-turn'), env), null);
});

test('same-path transcript replacement after PostCompact makes recovery stale', () => {
  const f = fixture('AAAA');
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Fresh compact goal') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  fs.writeFileSync(f.transcript, 'BBBB');
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env), null);
});

test('same-length transcript replacement between PreCompact and PostCompact is stale', () => {
  const f = fixture('AAAA');
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Old source') }; },
  });
  fs.writeFileSync(f.transcript, 'BBBB');
  checkpoint.handleHook(f.event('PostCompact'), env);
  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1'], env).stdout);
  assert.equal(status.restore_eligible, false);
  assert.equal(status.restore_reason, 'semantic_source_changed');
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env), null);
});

test('one-shot recovery consumes a compacted root checkpoint after local output succeeds', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('One-shot root') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);

  const input = { ...f.event('SessionStart'), source: 'compact' };
  let first;
  assert.deepEqual(checkpoint.handleHook(input, env, {
    emitHookOutput(output) { first = output; },
  }), { action: 'delivered' });
  assert.match(first.hookSpecificOutput.additionalContext, /One-shot root/);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  const receipt = JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).last_recovery_delivery;
  assert.deepEqual({
    generation: receipt.generation,
    event: receipt.event,
    attempt_count: receipt.attempt_count,
    status: receipt.status,
    payload_bytes: receipt.payload_bytes,
    payload_sha256_length: receipt.payload_sha256.length,
    error: receipt.error,
  }, {
    generation: 1,
    event: 'SessionStart',
    attempt_count: 1,
    status: 'local_output_succeeded',
    payload_bytes: Buffer.byteLength(first.hookSpecificOutput.additionalContext, 'utf8'),
    payload_sha256_length: 64,
    error: null,
  });
  assert.match(receipt.local_output_succeeded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(receipt), /One-shot root/);
  assert.equal(checkpoint.handleHook(input, env), null);
});

test('a delivered recovery repairs an interrupted success receipt without reinjection', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Repair success receipt') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  const rename = fs.renameSync;
  let metaWrites = 0;
  fs.renameSync = (source, target) => {
    if (target === ctx.meta && ++metaWrites === 2) throw new Error('injected receipt crash');
    return rename(source, target);
  };
  let outputs = 0;
  try {
    assert.throws(() => checkpoint.handleHook(f.event('UserPromptSubmit', 'prompt-turn'), env, {
      emitHookOutput() { outputs += 1; },
    }), /injected receipt crash/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(outputs, 1);
  assert.equal(JSON.parse(fs.readFileSync(ctx.current, 'utf8')).recovery_state, 'delivered');
  assert.equal(JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).last_recovery_delivery.status, 'attempting');

  assert.equal(checkpoint.handleHook(f.event('UserPromptSubmit', 'later-turn'), env), null);
  const receipt = JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).last_recovery_delivery;
  assert.equal(receipt.status, 'local_output_succeeded');
  assert.match(receipt.local_output_succeeded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    receipt.local_output_succeeded_at,
    JSON.parse(fs.readFileSync(ctx.current, 'utf8')).recovery_delivered_at,
  );
  assert.equal(outputs, 1);
  assert.equal(fs.existsSync(ctx.recovery), false);
});

test('one-shot recovery retries a same-source append after local output failure', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Retry delivery') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  fs.appendFileSync(f.transcript, 'opaque-host-tail\n');
  const input = { ...f.event('SessionStart'), source: 'compact' };
  assert.throws(() => checkpoint.handleHook(input, env, {
    emitHookOutput() { throw new Error('broken stdout'); },
  }), /broken stdout/);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  assert.ok(fs.existsSync(ctx.recovery));
  let receipt = JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).last_recovery_delivery;
  assert.equal(receipt.status, 'output_failed');
  assert.equal(receipt.attempt_count, 1);
  assert.match(receipt.error, /broken stdout/);
  assert.equal(receipt.local_output_succeeded_at, undefined);
  assert.doesNotMatch(JSON.stringify(receipt), /Retry delivery/);

  let retry;
  assert.deepEqual(checkpoint.handleHook(f.event('UserPromptSubmit', 'retry-turn'), env, {
    emitHookOutput(output) { retry = output; },
  }), { action: 'delivered' });
  assert.match(retry.hookSpecificOutput.additionalContext, /Retry delivery/);
  receipt = JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).last_recovery_delivery;
  assert.equal(receipt.event, 'UserPromptSubmit');
  assert.equal(receipt.status, 'local_output_succeeded');
  assert.equal(receipt.attempt_count, 2);
  assert.equal(receipt.error, null);
  assert.equal(fs.existsSync(ctx.recovery), false);
});

test('SessionStart accepts a large opaque postcompact tail', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Prompt fallback') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  fs.appendFileSync(f.transcript, 'x'.repeat(70 * 1024));

  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1'], env).stdout);
  assert.equal(status.restore_reason, 'unexpected_transcript_tail');
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Prompt fallback/);
  const receipt = JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).last_recovery_delivery;
  assert.equal(receipt.event, 'SessionStart');
  assert.equal(receipt.attempt_count, 1);
  assert.equal(fs.existsSync(ctx.recovery), false);
  assert.equal(checkpoint.handleHook(f.event('UserPromptSubmit', 'later-turn'), env), null);
});

test('postcompact user prompt recovery requires an explicit turn id', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Do not restore') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  fs.appendFileSync(f.transcript, 'opaque-prompt-tail\n');

  const input = { ...f.event('UserPromptSubmit'), turn_id: undefined };
  assert.equal(checkpoint.handleHook(input, env), null);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  assert.equal(JSON.parse(fs.readFileSync(ctx.current, 'utf8')).recovery_state, 'retired');
  assert.equal(fs.existsSync(ctx.recovery), false);
});

test('root SessionStart compact finalizes a missing PostCompact before recovery', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Fallback completion') }; },
  });
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  assert.equal(readCurrent(f, 'session-1', env).status, 'preparing');

  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Fallback completion/);
  const current = readCurrent(f, 'session-1', env);
  const meta = JSON.parse(fs.readFileSync(ctx.meta, 'utf8'));
  assert.equal(current.status, 'complete');
  assert.equal(current.completion_source, 'sessionstart-fallback');
  assert.equal(meta.completed_generations, 1);
  assert.equal(meta.cursor.offset, fs.statSync(f.transcript).size);

  assert.deepEqual(checkpoint.handleHook(f.event('PostCompact'), env), {
    action: 'already-complete', generation: 1,
  });
  assert.equal(JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).completed_generations, 1);
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env), null);
});

test('a completed checkpoint repairs metadata after an interrupted state write', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Repair state crash') }; },
  });
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === ctx.meta) throw new Error('injected state crash');
    return rename(source, target);
  };
  try {
    assert.throws(() => checkpoint.handleHook(f.event('PostCompact'), env), /injected state crash/);
  } finally {
    fs.renameSync = rename;
  }

  assert.equal(JSON.parse(fs.readFileSync(ctx.current, 'utf8')).status, 'complete');
  assert.equal(fs.existsSync(ctx.recovery), false);
  fs.unlinkSync(ctx.markdown);
  fs.unlinkSync(path.join(ctx.history, 'generation-0001.json'));
  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Repair state crash/);
  const meta = JSON.parse(fs.readFileSync(ctx.meta, 'utf8'));
  assert.equal(meta.completed_generations, 1);
  assert.equal(meta.cursor.offset, fs.statSync(f.transcript).size);
  assert.equal(JSON.parse(fs.readFileSync(ctx.current, 'utf8')).recovery_state, 'delivered');
  assert.ok(fs.existsSync(ctx.markdown));
  assert.ok(fs.existsSync(path.join(ctx.history, 'generation-0001.json')));
});

test('a pending recovery marker is rebuilt after an interrupted marker write', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Repair marker crash') }; },
  });
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === ctx.recovery) throw new Error('injected marker crash');
    return rename(source, target);
  };
  try {
    assert.throws(() => checkpoint.handleHook(f.event('PostCompact'), env), /injected marker crash/);
  } finally {
    fs.renameSync = rename;
  }

  assert.equal(JSON.parse(fs.readFileSync(ctx.current, 'utf8')).recovery_state, 'pending');
  assert.equal(fs.existsSync(ctx.recovery), false);
  const restored = checkpoint.handleHook(f.event('UserPromptSubmit', 'prompt-turn'), env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Repair marker crash/);
  assert.equal(JSON.parse(fs.readFileSync(ctx.current, 'utf8')).recovery_state, 'delivered');
  assert.equal(fs.existsSync(ctx.recovery), false);
});

test('a child prompt reconciles an interrupted completed checkpoint before recovery', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  const child = { ...f.event('PreCompact', 'child-turn'), agent_id: 'agent-1' };
  checkpoint.handleHook(child, env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Repair child state') }; },
  });
  const ctx = checkpoint.resolveContext(child, env);
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === ctx.meta) throw new Error('injected child state crash');
    return rename(source, target);
  };
  try {
    assert.throws(() => checkpoint.handleHook({
      ...child, hook_event_name: 'PostCompact',
    }, env), /injected child state crash/);
  } finally {
    fs.renameSync = rename;
  }

  const restored = checkpoint.handleHook({
    ...child, hook_event_name: 'UserPromptSubmit', turn_id: 'prompt-turn',
  }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Repair child state/);
  const meta = JSON.parse(fs.readFileSync(ctx.meta, 'utf8'));
  assert.equal(meta.completed_generations, 1);
  assert.equal(meta.pending_turn_id, null);
  assert.equal(meta.cursor.offset, fs.statSync(f.transcript).size);
});

test('the next PreCompact reconciles an interrupted completion before capturing', () => {
  const f = fixture();
  checkpoint.handleHook(f.event('PreCompact', 'turn-1'), f.env);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  const firstEnd = fs.statSync(f.transcript).size;
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === ctx.meta) throw new Error('injected state crash before next compact');
    return rename(source, target);
  };
  try {
    assert.throws(() => checkpoint.handleHook(
      f.event('PostCompact', 'turn-1'), f.env,
    ), /injected state crash before next compact/);
  } finally {
    fs.renameSync = rename;
  }

  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), f.env);
  const current = JSON.parse(fs.readFileSync(ctx.current, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(ctx.meta, 'utf8'));
  assert.equal(current.generation, 2);
  assert.equal(current.transcript_delta.start_offset, firstEnd);
  assert.equal(meta.completed_generations, 1);
  assert.equal(meta.cursor.offset, firstEnd);
});

test('SessionStart fallback is root-only, compact-only, and transcript-exact', () => {
  const f = fixture();
  checkpoint.handleHook(f.event('PreCompact'), f.env);
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'resume' }, f.env), null);
  assert.equal(readCurrent(f).status, 'preparing');

  const otherTranscript = path.join(f.root, 'other.jsonl');
  fs.writeFileSync(otherTranscript, fs.readFileSync(f.transcript));
  assert.equal(checkpoint.handleHook({
    ...f.event('SessionStart'), source: 'compact', transcript_path: otherTranscript,
  }, f.env), null);
  assert.equal(readCurrent(f).status, 'preparing');

  const child = { ...f.event('PreCompact', 'child-turn'), agent_id: 'agent-1' };
  checkpoint.handleHook(child, f.env);
  assert.equal(checkpoint.handleHook({
    ...child, hook_event_name: 'SessionStart', source: 'compact',
  }, f.env), null);
  const childCurrent = JSON.parse(fs.readFileSync(checkpoint.resolveContext(child, f.env).current, 'utf8'));
  assert.equal(childCurrent.status, 'preparing');
});

test('a terminal freshness rejection retires its pending recovery', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Stale delivery') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  fs.writeFileSync(f.transcript, '{"turn":2}\n');
  assert.equal(checkpoint.handleHook(f.event('UserPromptSubmit'), env), null);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  assert.equal(JSON.parse(fs.readFileSync(ctx.current, 'utf8')).recovery_state, 'retired');
  assert.equal(fs.existsSync(ctx.recovery), false);
});

test('semantic refresh does not re-arm an already consumed generation', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Initial delivery') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  assert.ok(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env));

  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Refreshed after delivery')));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1'], env).status, 0);
  assert.equal(checkpoint.handleHook(f.event('UserPromptSubmit'), env), null);
});

test('a compacted subtask falls back to the next user prompt without sharing parent state', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  const subtask = (name) => ({ ...f.event(name), agent_id: 'agent-1' });
  checkpoint.handleHook(subtask('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Subtask restore') }; },
  });
  checkpoint.handleHook(subtask('PostCompact'), env);

  const parent = checkpoint.resolveContext(f.event('PreCompact'), env);
  const child = checkpoint.resolveContext(subtask('PreCompact'), env);
  assert.notEqual(child.sessionDir, parent.sessionDir);

  const prompt = checkpoint.handleHook(subtask('UserPromptSubmit'), env);
  assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(prompt.hookSpecificOutput.additionalContext, /Subtask restore/);
  assert.equal(checkpoint.handleHook(subtask('UserPromptSubmit'), env), null);
});

test('subtask lifecycle stays isolated when later hook payloads omit agent_id', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  complete(f, 'parent-turn', 'session-1', env);
  const childTranscript = path.join(f.root, 'child-transcript.jsonl');
  fs.writeFileSync(childTranscript, '{"child":true}\n');
  const child = {
    ...f.event('PreCompact', 'child-turn'),
    agent_id: 'agent-1',
    transcript_path: childTranscript,
  };
  checkpoint.handleHook(child, env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Child without later agent id') }; },
  });

  const post = checkpoint.handleHook({
    ...child,
    hook_event_name: 'PostCompact',
    agent_id: undefined,
  }, env);
  assert.equal(post.action, 'completed');
  const prompt = checkpoint.handleHook({
    ...child,
    hook_event_name: 'UserPromptSubmit',
    agent_id: undefined,
  }, env);
  assert.match(prompt.hookSpecificOutput.additionalContext, /Child without later agent id/);
  assert.equal(readCurrent(f, 'session-1', env).turn_id, 'parent-turn');
});

test('an unmatched transcript cannot consume parent recovery when agent_id is absent', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Parent restore') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), env);
  const parent = checkpoint.resolveContext(f.event('PreCompact'), env);
  assert.ok(fs.existsSync(parent.recovery));

  const unrelated = path.join(f.root, 'unrelated-transcript.jsonl');
  fs.writeFileSync(unrelated, '{"other":true}\n');
  assert.equal(checkpoint.handleHook({
    ...f.event('UserPromptSubmit'),
    transcript_path: unrelated,
  }, env), null);
  assert.ok(fs.existsSync(parent.recovery));
});

test('the same agent id under two parent sessions has isolated state and recovery', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  const child = (session, event) => ({
    ...f.event(event, 'turn-1', session),
    agent_id: 'shared-agent',
  });
  const childA = child('session-a', 'PreCompact');
  const childB = child('session-b', 'PreCompact');
  checkpoint.handleHook(childA, env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Child A') }; },
  });
  checkpoint.handleHook({ ...childA, hook_event_name: 'PostCompact' }, env);
  checkpoint.handleHook(childB, env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Child B') }; },
  });
  checkpoint.handleHook({ ...childB, hook_event_name: 'PostCompact' }, env);

  const contextA = checkpoint.resolveContext(childA, env);
  const contextB = checkpoint.resolveContext(childB, env);
  assert.notEqual(contextA.sessionDir, contextB.sessionDir);
  assert.notEqual(contextA.recovery, contextB.recovery);
  assert.match(
    checkpoint.handleHook(child('session-a', 'UserPromptSubmit'), env)
      .hookSpecificOutput.additionalContext,
    /Child A/,
  );
  assert.match(
    checkpoint.handleHook(child('session-b', 'UserPromptSubmit'), env)
      .hookSpecificOutput.additionalContext,
    /Child B/,
  );
  const ambiguous = runCli(f, ['status', '--thread-id', 'shared-agent'], env);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /multiple threads/i);
  const selected = JSON.parse(runCli(
    f,
    ['status', '--thread-id', 'agent:session-a:shared-agent'],
    env,
  ).stdout);
  assert.equal(selected.session_id, 'session-a');
});

test('unsafe and colliding identifiers stay inside distinct storage paths', () => {
  const f = fixture();
  const sessionsRoot = path.join(f.data, 'sessions');
  const inputs = [
    f.event('PreCompact', 'turn-1', '.'),
    f.event('PreCompact', 'turn-1', '..'),
    { ...f.event('PreCompact'), agent_id: 'a/b' },
    { ...f.event('PreCompact'), agent_id: 'a_b' },
    { ...f.event('PreCompact', 'turn-1', 'a:b'), agent_id: 'c' },
    { ...f.event('PreCompact', 'turn-1', 'a'), agent_id: 'b:c' },
    f.event('PreCompact', 'turn-1', 'CON'),
  ];
  const directories = inputs.map((input) => checkpoint.resolveContext(input, f.env).sessionDir);
  assert.equal(new Set(directories).size, directories.length);
  for (const directory of directories) {
    const relative = path.relative(sessionsRoot, directory);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  }
});

test('legacy dot identifiers cannot escape the sessions directory', () => {
  for (const session of ['.', '..']) {
    const f = fixture();
    const sessionsRoot = path.join(f.data, 'sessions');
    const legacyDir = session === '.' ? sessionsRoot : f.data;
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'current.json'), JSON.stringify({
      session_id: session,
      agent_id: null,
      thread_id: session,
    }));

    const ctx = checkpoint.resolveContext(f.event('PreCompact', 'turn-1', session), f.env);
    const relative = path.relative(sessionsRoot, ctx.sessionDir);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    assert.notEqual(ctx.sessionDir, legacyDir);
  }
});

test('legacy child storage is reused only for the matching parent session', () => {
  const f = fixture();
  const legacyDir = path.join(f.data, 'sessions', 'legacy-agent');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'current.json'), JSON.stringify({
    session_id: 'session-a',
    agent_id: 'legacy-agent',
    thread_id: 'legacy-agent',
  }));
  const input = (session) => ({
    ...f.event('PreCompact', 'turn-1', session),
    agent_id: 'legacy-agent',
  });

  assert.equal(checkpoint.resolveContext(input('session-a'), f.env).sessionDir, legacyDir);
  assert.notEqual(checkpoint.resolveContext(input('session-b'), f.env).sessionDir, legacyDir);
});

test('v0.3.1 child state and pending recovery remain usable after thread-id migration', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  const child = { ...f.event('PreCompact'), agent_id: 'legacy-agent' };
  checkpoint.handleHook(child, env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Legacy child restore') }; },
  });
  checkpoint.handleHook({ ...child, hook_event_name: 'PostCompact' }, env);
  const canonical = checkpoint.resolveContext(child, env);
  const legacyDir = path.join(f.data, 'sessions', 'legacy-agent');
  const legacyRecovery = path.join(f.data, 'recovery-pending', 'legacy-agent.json');
  fs.renameSync(canonical.sessionDir, legacyDir);
  const currentFile = path.join(legacyDir, 'current.json');
  const current = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
  current.thread_id = 'legacy-agent';
  fs.writeFileSync(currentFile, `${JSON.stringify(current, null, 2)}\n`);
  const pending = JSON.parse(fs.readFileSync(canonical.recovery, 'utf8'));
  pending.thread_id = 'legacy-agent';
  fs.mkdirSync(path.dirname(legacyRecovery), { recursive: true });
  fs.writeFileSync(legacyRecovery, `${JSON.stringify(pending, null, 2)}\n`);
  fs.unlinkSync(canonical.recovery);

  const restored = checkpoint.handleHook({
    ...child, hook_event_name: 'UserPromptSubmit', agent_id: undefined,
  }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Legacy child restore/);
  assert.equal(checkpoint.resolveContext(child, env).sessionDir, legacyDir);
  assert.equal(fs.existsSync(legacyRecovery), false);
});

test('v0.3.1 unsafe root ids reuse verified state and pending recovery', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  const root = f.event('PreCompact', 'turn-1', 'root:a/b');
  checkpoint.handleHook(root, env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Legacy root restore') }; },
  });
  checkpoint.handleHook({ ...root, hook_event_name: 'PostCompact' }, env);
  const canonical = checkpoint.resolveContext(root, env);
  const legacyDir = path.join(f.data, 'sessions', 'root_a_b');
  const legacyRecovery = path.join(f.data, 'recovery-pending', 'root_a_b.json');
  fs.renameSync(canonical.sessionDir, legacyDir);
  const currentFile = path.join(legacyDir, 'current.json');
  const current = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
  current.thread_id = 'root:a/b';
  fs.writeFileSync(currentFile, `${JSON.stringify(current, null, 2)}\n`);
  const pending = JSON.parse(fs.readFileSync(canonical.recovery, 'utf8'));
  pending.thread_id = 'root:a/b';
  fs.writeFileSync(legacyRecovery, `${JSON.stringify(pending, null, 2)}\n`);
  fs.unlinkSync(canonical.recovery);

  const restored = checkpoint.handleHook({
    ...root, hook_event_name: 'SessionStart', source: 'compact',
  }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Legacy root restore/);
  assert.equal(checkpoint.resolveContext(root, env).sessionDir, legacyDir);
  assert.equal(fs.existsSync(legacyRecovery), false);
});

test('stale semantic state is never auto-injected', () => {
  const f = fixture();
  complete(f);
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env), null);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Durable handoff')));
  const update = runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.equal(update.status, 0, update.stderr);

  assert.equal(checkpoint.handleHook(f.event('UserPromptSubmit', 'new-prompt'), f.env), null);
  fs.appendFileSync(f.transcript, '{"newer":true}\n');
  complete(f, 'turn-2');
  const compact = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env);
  assert.equal(compact, null);
  const resume = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'resume' }, f.env);
  assert.equal(resume, null);
});

test('manual CLI refuses an ambiguous workspace and accepts an explicit thread', () => {
  const f = fixture();
  complete(f, 'turn-a', 'session-a');
  complete(f, 'turn-b', 'session-b');
  const ambiguous = runCli(f, ['status']);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /multiple threads/i);
  const explicit = runCli(f, ['status', '--thread-id', 'session-a']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).session_id, 'session-a');
});

test('--thread-id selects one subtask while --session-id remains a root-task alias', () => {
  const f = fixture();
  const parent = f.event('PreCompact');
  const agent1 = { ...parent, agent_id: 'agent-1' };
  const agent2 = { ...parent, agent_id: 'agent-2' };
  for (const input of [parent, agent1, agent2]) {
    checkpoint.handleHook(input, f.env);
    checkpoint.handleHook({ ...input, hook_event_name: 'PostCompact' }, f.env);
  }

  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Only agent 1')));
  const update = runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'agent:session-1:agent-1']);
  assert.equal(update.status, 0, update.stderr);

  const read = (input) => JSON.parse(fs.readFileSync(checkpoint.resolveContext(input, f.env).current, 'utf8'));
  assert.equal(read(agent1).semantic.goal, 'Only agent 1');
  assert.equal(read(parent).semantic.goal, '');
  assert.equal(read(agent2).semantic.goal, '');
  assert.equal(JSON.parse(runCli(f, ['status', '--session-id', 'session-1']).stdout).agent_id, null);

  const sessions = JSON.parse(runCli(f, ['sessions']).stdout);
  assert.deepEqual(sessions.map(({ selector, kind }) => ({ selector, kind })), [
    { selector: 'agent:session-1:agent-1', kind: 'agent' },
    { selector: 'agent:session-1:agent-2', kind: 'agent' },
    { selector: 'session-1', kind: 'root' },
  ]);
});

test('history lists retained generations and show selects one generation', () => {
  const f = fixture();
  complete(f, 'turn-1');
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  complete(f, 'turn-2');

  const history = runCli(f, ['history', '--thread-id', 'session-1']);
  assert.equal(history.status, 0, history.stderr);
  assert.deepEqual(JSON.parse(history.stdout).map((item) => item.generation), [1, 2]);
  assert.deepEqual(Object.keys(JSON.parse(history.stdout)[0]), [
    'generation', 'status', 'trigger', 'delta_bytes', 'semantic_source', 'created_at', 'completed_at',
  ]);

  const shown = runCli(f, ['show', '--generation', '1', '--thread-id', 'session-1']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Generation: 1/);
});

test('sessions storage reports per-session and workspace byte totals', () => {
  const f = fixture();
  complete(f, 'turn-a', 'session-a');
  complete(f, 'turn-b', 'session-b');

  const result = runCli(f, ['sessions', '--storage']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sessions.length, 2);
  assert.ok(report.sessions.every((session) => session.stored_bytes > 0));
  assert.ok(report.sessions.every((session) => typeof session.restore_eligible === 'boolean'));
  assert.ok(report.sessions.every((session) => typeof session.delta_bytes === 'number'));
  assert.ok(report.sessions.every((session) => typeof session.semantic_source === 'string'));
  assert.equal(
    report.workspace_total_bytes,
    report.sessions.reduce((total, session) => total + session.stored_bytes, 0),
  );
});

test('semantic CLI reports lock contention instead of false success', () => {
  const f = fixture();
  complete(f);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic()));
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  fs.writeFileSync(ctx.lock, 'owner');
  const result = runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /locked/i);
  assert.equal(fs.readFileSync(ctx.lock, 'utf8'), 'owner');
});

test('plugin hooks put raw deltas in PLUGIN_DATA without writing into the workspace', () => {
  const f = fixture();
  const pluginEnv = { ...process.env, PLUGIN_DATA: f.pluginData };
  complete(f, 'turn-1', 'session-1', pluginEnv);
  const current = readCurrent(f, 'session-1', pluginEnv);
  assert.ok(current.transcript_delta.delta_path.startsWith(f.pluginData + path.sep));
  assert.equal(fs.existsSync(path.join(f.workspace, '.codex')), false);

  const status = runCli(f, ['status'], pluginEnv);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).session_id, 'session-1');
});

test('sessions --discover reports an alternate identity for the same exact workspace root', () => {
  const root = fs.mkdtempSync(path.join(work, 'test-'));
  roots.push(root);
  const workspace = path.join(root, 'repo');
  const pluginData = path.join(root, 'plugin-data');
  const transcript = path.join(root, 'transcript.jsonl');
  fs.mkdirSync(workspace, { recursive: true });
  const gitBoundary = path.join(workspace, '.git');
  fs.writeFileSync(gitBoundary, 'gitdir: missing');
  fs.writeFileSync(transcript, '{"turn":1}\n');
  const env = { ...process.env, PLUGIN_DATA: pluginData };
  const event = (name) => ({
    session_id: 'session-1',
    turn_id: 'turn-1',
    cwd: workspace,
    transcript_path: transcript,
    hook_event_name: name,
    trigger: 'auto',
  });
  const oldIdentity = checkpoint.workspaceSnapshot(workspace).identity;
  checkpoint.handleHook(event('PreCompact'), env);
  checkpoint.handleHook(event('PostCompact'), env);

  fs.unlinkSync(gitBoundary);
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const currentIdentity = checkpoint.workspaceSnapshot(workspace).identity;
  assert.notEqual(currentIdentity, oldIdentity);

  const result = spawnSync(process.execPath, [runner, 'sessions', '--discover'], {
    cwd: workspace,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.current_workspace_identity, currentIdentity);
  assert.deepEqual(report.alternate_identities.map((entry) => ({
    identity: entry.identity,
    root: entry.root,
    git: entry.git,
    threads: entry.threads,
    has_bytes: entry.stored_bytes > 0,
  })), [{
    identity: oldIdentity,
    root: path.resolve(workspace),
    git: false,
    threads: 1,
    has_bytes: true,
  }]);
});

test('sessions --discover does not infer alternate identities from a custom data directory', () => {
  const f = fixture();
  complete(f);
  const result = runCli(f, ['sessions', '--discover']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.alternate_identities, []);
});

test('missing PLUGIN_DATA falls back to user Codex data, never the workspace', () => {
  const f = fixture();
  const codexHome = path.join(f.root, 'codex-home');
  const env = { ...process.env, CODEX_HOME: codexHome };
  complete(f, 'turn-1', 'session-1', env);
  const current = readCurrent(f, 'session-1', env);
  assert.ok(current.transcript_delta.delta_path.startsWith(codexHome + path.sep));
  assert.equal(current.transcript_delta.delta_path.startsWith(f.workspace + path.sep), false);
  assert.equal(fs.existsSync(path.join(f.workspace, '.codex')), false);
});

test('checkpoint directories and transcript data use private POSIX modes', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  complete(f);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  const mode = (file) => fs.statSync(file).mode & 0o777;
  for (const directory of [
    ctx.sessionDir,
    ctx.history,
    ctx.deltas,
    path.dirname(ctx.recovery),
  ]) assert.equal(mode(directory), 0o700, directory);
  for (const file of [
    ctx.meta,
    ctx.current,
    ctx.markdown,
    path.join(ctx.history, 'generation-0001.json'),
    path.join(ctx.deltas, 'generation-0001.jsonl'),
    ctx.recovery,
  ]) assert.equal(mode(file), 0o600, file);
});

test('oversized transcript deltas skip storage and resume from the skipped end', () => {
  const f = fixture('x'.repeat(1024));
  const env = { ...f.env, CONTEXT_CHECKPOINT_MAX_DELTA_BYTES: '100' };
  checkpoint.handleHook(f.event('PreCompact'), env);
  let current = readCurrent(f, 'session-1', env);
  assert.deepEqual({
    status: current.transcript_delta.status,
    start_offset: current.transcript_delta.start_offset,
    end_offset: current.transcript_delta.end_offset,
    source_bytes: current.transcript_delta.source_bytes,
    stored_bytes: current.transcript_delta.stored_bytes,
    semantic_gap: current.transcript_delta.semantic_gap,
    delta_path: current.transcript_delta.delta_path,
  }, {
    status: 'skipped-too-large',
    start_offset: 0,
    end_offset: 1024,
    source_bytes: 1024,
    stored_bytes: 0,
    semantic_gap: true,
    delta_path: null,
  });
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  assert.equal(JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).cursor.offset, 0);

  checkpoint.handleHook(f.event('PostCompact'), env);
  assert.equal(JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).cursor.offset, 1024);
  fs.appendFileSync(f.transcript, 'tail');
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), env);
  current = readCurrent(f, 'session-1', env);
  assert.equal(current.transcript_delta.status, 'captured');
  assert.equal(current.transcript_delta.start_offset, 1024);
  assert.equal(current.transcript_delta.end_offset, 1028);
});

test('a skipped oversized range blocks sidecar coverage until a manual semantic baseline', () => {
  const f = fixture('a');
  const baseEnv = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '2',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  let calls = 0;
  const deps = {
    runSidecar() {
      calls += 1;
      return { status: 'completed', semantic: semantic('Must not advance') };
    },
  };

  complete(f, 'turn-1', 'session-1', baseEnv, deps);
  fs.appendFileSync(f.transcript, 'x'.repeat(200));
  complete(f, 'turn-2', 'session-1', {
    ...baseEnv,
    CONTEXT_CHECKPOINT_MAX_DELTA_BYTES: '100',
  }, deps);
  assert.equal(calls, 0);
  assert.equal(readCurrent(f).semantic_generation, 0);
  const blocked = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout);
  assert.equal(blocked.semantic_backlog_complete, false);
  assert.equal(blocked.semantic_backlog_reason, 'delta_skipped-too-large');
  assert.equal(blocked.semantic_backlog_gap_generation, 2);

  fs.appendFileSync(f.transcript, 'tail');
  complete(f, 'turn-3', 'session-1', {
    ...baseEnv,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '3',
    CONTEXT_CHECKPOINT_MAX_DELTA_BYTES: '100',
  }, deps);
  assert.equal(calls, 0);
  assert.equal(readCurrent(f).transcript_delta.status, 'captured');

  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Manual gap baseline')));
  assert.equal(runCli(f, [
    'semantic', '--input', semanticFile, '--thread-id', 'session-1',
  ]).status, 0);
  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout);
  assert.equal(status.semantic_backlog_complete, true);
  assert.equal(status.semantic_backlog_reason, null);
  assert.equal(status.semantic_generation, 3);
});

test('a deleted unseen delta blocks sidecar advancement', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '3',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  let calls = 0;
  const deps = {
    runSidecar() {
      calls += 1;
      return { status: 'completed', semantic: semantic('Must not advance') };
    },
  };
  complete(f, 'turn-1', 'session-1', env, deps);
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  complete(f, 'turn-2', 'session-1', env, deps);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  fs.unlinkSync(path.join(ctx.deltas, 'generation-0001.jsonl'));
  fs.appendFileSync(f.transcript, '{"turn":3}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), env, deps);

  assert.equal(calls, 0);
  assert.equal(readCurrent(f).semantic_generation, 0);
  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout);
  assert.equal(status.semantic_backlog_complete, false);
  assert.equal(status.semantic_backlog_reason, 'delta_file_missing');
  assert.equal(status.semantic_backlog_gap_generation, 1);
});

test('status reports a missing unseen history generation', () => {
  const f = fixture();
  complete(f, 'turn-1');
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  complete(f, 'turn-2');
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  fs.unlinkSync(path.join(ctx.history, 'generation-0001.json'));

  const result = runCli(f, ['status', '--thread-id', 'session-1']);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.semantic_backlog_complete, false);
  assert.equal(status.semantic_backlog_reason, 'history_missing');
  assert.equal(status.semantic_backlog_gap_generation, 1);
  assert.deepEqual(status.unseen_delta_paths, []);
});

test('a missing reset history cannot be healed by a later append', () => {
  const f = fixture('AAAAAAAA');
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '3',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  let calls = 0;
  const deps = {
    runSidecar() {
      calls += 1;
      return { status: 'completed', semantic: semantic('Must not advance') };
    },
  };
  complete(f, 'turn-1', 'session-1', env, deps);
  fs.writeFileSync(f.transcript, 'BBBBBBBB');
  complete(f, 'turn-2', 'session-1', env, deps);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  fs.unlinkSync(path.join(ctx.history, 'generation-0002.json'));
  fs.appendFileSync(f.transcript, 'C');
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), env, deps);

  assert.equal(calls, 0);
  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1'], env).stdout);
  assert.equal(status.semantic_backlog_complete, false);
  assert.equal(status.semantic_backlog_reason, 'history_missing');
  assert.equal(status.semantic_backlog_gap_generation, 2);
});

test('retention removes generations older than the configured window', () => {
  const f = fixture();
  const env = { ...f.env, CONTEXT_CHECKPOINT_RETENTION_GENERATIONS: '2' };
  complete(f, 'turn-1', 'session-1', env);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Covered generation 1')));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1'], env).status, 0);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  const sidecarDir = path.join(ctx.sessionDir, 'sidecar');
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(path.join(sidecarDir, 'generation-0001.json'), '{}');
  fs.writeFileSync(path.join(sidecarDir, 'generation-0002.json'), '{}');
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  complete(f, 'turn-2', 'session-1', env);
  fs.appendFileSync(f.transcript, '{"turn":3}\n');
  complete(f, 'turn-3', 'session-1', env);
  assert.equal(fs.existsSync(path.join(ctx.history, 'generation-0001.json')), false);
  assert.equal(fs.existsSync(path.join(ctx.deltas, 'generation-0001.jsonl')), false);
  assert.equal(fs.existsSync(path.join(sidecarDir, 'generation-0001.json')), false);
  assert.equal(fs.existsSync(path.join(sidecarDir, 'generation-0002.json')), true);
  assert.equal(fs.existsSync(path.join(ctx.history, 'generation-0002.json')), true);
});

test('sidecar uses constrained launch settings and listed-delta instructions', () => {
  const f = fixture();
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  fs.mkdirSync(ctx.sessionDir, { recursive: true });
  let observed;
  const state = {
    generation: 1,
    workspace_before: ctx.workspace,
    sidecar_delta_paths: [f.transcript],
    semantic: semantic(),
  };
  const result = checkpoint.runSidecar(state, ctx, {
    ...process.env,
    CONTEXT_CHECKPOINT_CODEX_BIN: process.execPath,
    TEST_SECRET: 'must-not-cross',
  }, (_command, args, options) => {
    observed = { args, options };
    const output = args[args.indexOf('--output-last-message') + 1];
    fs.writeFileSync(output, JSON.stringify(semantic()));
    return { status: 0 };
  });
  assert.equal(result.status, 'completed');
  assert.equal(observed.options.cwd, ctx.sessionDir);
  assert.equal(observed.options.env.TEST_SECRET, undefined);
  assert.ok(observed.args.includes('--ephemeral'));
  assert.equal(observed.args[observed.args.indexOf('--sandbox') + 1], 'read-only');
  assert.match(observed.options.input, /untrusted data/);
  assert.match(observed.options.input, /Read only the listed delta files/);
  assert.match(observed.options.input, /do not inspect workspace files/);
  assert.match(observed.options.input, /Do not infer missing facts, requirements, results/);
  assert.match(observed.options.input, /unknown or ambiguous.*open_questions/i);
  assert.match(observed.options.input, /preserve execution-critical literals verbatim/i);
  assert.match(observed.options.input, /paths.*commands.*IDs.*numeric thresholds.*hashes.*error codes/i);
  assert.match(observed.options.input, /preserve the polarity and scope/i);
  assert.match(observed.options.input, /Runtime completion is not result validation/);
});

test('sidecar uses a disposable content-based view and records byte metrics', () => {
  const dataBytes = Buffer.alloc(24 * 1024, 0x41);
  const binaryBytes = Buffer.alloc(24 * 1024, 0x42);
  const duplicate = `large-payload:${'D'.repeat(32 * 1024)}`;
  const nearDuplicate = `${duplicate}!`;
  const ordinary = `compiler error: ${'source-line '.repeat(4000)}`;
  const dataUrl = `data:image/png;base64,${dataBytes.toString('base64')}`;
  const protoRecord = `{"type":"future-record","__proto__":{"keep":"critical"},"nested":{"value":${JSON.stringify(dataUrl)}}}`;
  const unsafeIntegerRecord = `{"image":"data:image/png;base64,QQ==","id":9007199254740993}`;
  const firstDelta = [
    protoRecord,
    unsafeIntegerRecord,
    JSON.stringify({ type: 'unknown-record', payload: { encoding: 'base64', media_type: 'application/octet-stream', data: binaryBytes.toString('base64') } }),
    JSON.stringify({ type: 'ordinary-text', content: ordinary }),
    JSON.stringify({ type: 'first-large', content: duplicate }),
  ];
  const secondDelta = [
    JSON.stringify({ type: 'renamed-record', content: duplicate }),
    JSON.stringify({ type: 'near-duplicate', content: nearDuplicate }),
  ];
  const f = fixture(firstDelta.join('\n') + '\n');
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '2',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
    CONTEXT_CHECKPOINT_CODEX_BIN: process.execPath,
  };
  complete(f, 'turn-1', 'session-1', env);
  fs.appendFileSync(f.transcript, secondDelta.join('\n') + '\n');
  let projectedPaths;
  let projectedBytes;
  let rawPaths;
  let rawHashes;
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), env, {
    runSidecar(state, ctx, sidecarEnv) {
      rawPaths = [...state.sidecar_delta_paths];
      rawHashes = rawPaths.map((file) => crypto.createHash('sha256')
        .update(fs.readFileSync(file)).digest('hex'));
      return checkpoint.runSidecar(state, ctx, sidecarEnv, (_command, args, options) => {
        const prefix = 'Disposable sidecar-view files derived from transcript deltas since the last semantic checkpoint: ';
        const line = options.input.split('\n').find((item) => item.startsWith(prefix));
        projectedPaths = JSON.parse(line.slice(prefix.length));
        assert.equal(projectedPaths.length, 2);
        assert.ok(projectedPaths.every((file) => !state.sidecar_delta_paths.includes(file)));
        projectedBytes = projectedPaths.reduce((total, file) => total + fs.statSync(file).size, 0);
        const projectedLines = projectedPaths.flatMap((file) => fs.readFileSync(file, 'utf8')
          .trimEnd().split('\n'));
        assert.equal(projectedLines[1], unsafeIntegerRecord);
        const projected = projectedLines.map((item) => JSON.parse(item));
        assert.equal(Object.prototype.hasOwnProperty.call(projected[0], '__proto__'), true);
        assert.deepEqual(projected[0].__proto__, { keep: 'critical' });
        assert.match(projected[0].nested.value, /^\[sidecar-view data-url media=image\/png bytes=24576 sha256=[a-f0-9]{64}\]$/);
        assert.equal(projected[1].image, 'data:image/png;base64,QQ==');
        assert.match(projected[2].payload, /^\[sidecar-view binary media=application\/octet-stream bytes=24576 sha256=[a-f0-9]{64}\]$/);
        assert.equal(projected[3].content, ordinary);
        assert.equal(projected[4].content, duplicate);
        assert.match(projected[5].content, /^\[sidecar-view duplicate bytes=32782 sha256=[a-f0-9]{64}; first occurrence retained\]$/);
        assert.equal(projected[6].content, nearDuplicate);
        const output = args[args.indexOf('--output-last-message') + 1];
        fs.writeFileSync(output, JSON.stringify(semantic('Projected semantic state')));
        return { status: 0 };
      });
    },
  });

  const current = readCurrent(f, 'session-1', env);
  assert.equal(current.sidecar.status, 'completed');
  assert.equal(current.sidecar.raw_input_bytes,
    rawPaths.reduce((total, file) => total + fs.statSync(file).size, 0));
  assert.equal(current.sidecar.projected_input_bytes, projectedBytes);
  assert.equal(current.sidecar.reduction_bytes, current.sidecar.raw_input_bytes - projectedBytes);
  assert.equal(current.sidecar.reduction_percent,
    Number((100 * current.sidecar.reduction_bytes / current.sidecar.raw_input_bytes).toFixed(2)));
  assert.equal(current.sidecar.masked_data_urls, 1);
  assert.equal(current.sidecar.masked_binary_payloads, 1);
  assert.equal(current.sidecar.deduplicated_payloads, 1);
  rawPaths.forEach((file, index) => assert.equal(crypto.createHash('sha256')
    .update(fs.readFileSync(file)).digest('hex'), rawHashes[index]));
  assert.equal(rawHashes.at(-1), current.transcript_delta.sha256);
  assert.ok(projectedPaths.every((file) => !fs.existsSync(file)));
  assert.doesNotMatch(JSON.stringify(current.sidecar), /large-payload|source-line|data:image/);
});

test('sidecar deletes its projected view after local process failure', () => {
  const f = fixture(JSON.stringify({ content: `data:image/png;base64,${Buffer.alloc(1024).toString('base64')}` }) + '\n');
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  fs.mkdirSync(ctx.sessionDir, { recursive: true });
  const before = crypto.createHash('sha256').update(fs.readFileSync(f.transcript)).digest('hex');
  let projectedPaths;
  const result = checkpoint.runSidecar({
    generation: 1,
    sidecar_delta_paths: [f.transcript],
    semantic: semantic(),
  }, ctx, {
    ...process.env,
    CONTEXT_CHECKPOINT_CODEX_BIN: process.execPath,
  }, (_command, _args, options) => {
    const prefix = 'Disposable sidecar-view files derived from transcript deltas since the last semantic checkpoint: ';
    const line = options.input.split('\n').find((item) => item.startsWith(prefix));
    projectedPaths = JSON.parse(line.slice(prefix.length));
    return { status: 1, stderr: 'local failure' };
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.masked_data_urls, 1);
  assert.ok(projectedPaths.every((file) => !fs.existsSync(file)));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.transcript)).digest('hex'), before);
});

test('invalid sidecar semantics cannot advance semantic coverage', () => {
  const f = fixture();
  complete(f, 'turn-1');
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Stable baseline')));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']).status, 0);
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  checkpoint.handleHook(f.event('UserPromptSubmit', 'prompt-turn'), f.env);
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_CODEX_BIN: process.execPath,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '2',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), env, {
    spawnSync(_command, args) {
      const output = args[args.indexOf('--output-last-message') + 1];
      fs.writeFileSync(output, JSON.stringify({ ...semantic(), next_actions: [] }));
      return { status: 0 };
    },
  });
  const ctx = checkpoint.resolveContext(f.event('PreCompact', 'turn-2'), env);
  let current = JSON.parse(fs.readFileSync(ctx.current, 'utf8'));
  let meta = JSON.parse(fs.readFileSync(ctx.meta, 'utf8'));
  const failedDelta = current.transcript_delta.delta_path;
  assert.equal(current.sidecar.status, 'failed');
  assert.match(current.sidecar.error, /next_actions.*at least 1/i);
  assert.equal(current.semantic.goal, 'Stable baseline');
  assert.equal(current.semantic_source, 'manual');
  assert.equal(current.semantic_generation, 1);
  assert.equal(meta.semantic_generation, 1);
  assert.ok(JSON.parse(runCli(
    f, ['status', '--thread-id', 'session-1'], env,
  ).stdout).unseen_delta_paths.includes(failedDelta));

  checkpoint.handleHook(f.event('PostCompact', 'turn-2'), env);
  fs.appendFileSync(f.transcript, '{"turn":3}\n');
  let retriedPaths;
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), {
    ...env, CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
  }, {
    runSidecar(state) {
      retriedPaths = state.sidecar_delta_paths;
      return { status: 'completed', semantic: semantic('Recovered backlog') };
    },
  });
  current = JSON.parse(fs.readFileSync(ctx.current, 'utf8'));
  meta = JSON.parse(fs.readFileSync(ctx.meta, 'utf8'));
  assert.ok(retriedPaths.includes(failedDelta));
  assert.equal(current.semantic.goal, 'Recovered backlog');
  assert.equal(current.semantic_source, 'sidecar');
  assert.equal(current.semantic_generation, 3);
  assert.equal(meta.semantic_generation, 3);
});

test('sidecar refuses a same-length delta checksum mismatch', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '2',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  let calls = 0;
  const deps = {
    runSidecar() {
      calls += 1;
      return { status: 'completed', semantic: semantic('Must not advance') };
    },
  };
  complete(f, 'turn-1', 'session-1', env, deps);
  const first = readCurrent(f, 'session-1', env);
  const corrupted = fs.readFileSync(first.transcript_delta.delta_path);
  corrupted[0] ^= 1;
  fs.writeFileSync(first.transcript_delta.delta_path, corrupted);

  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), env, deps);
  const current = readCurrent(f, 'session-1', env);
  const meta = JSON.parse(fs.readFileSync(checkpoint.resolveContext(
    f.event('PreCompact', 'turn-2'), env,
  ).meta, 'utf8'));
  assert.equal(calls, 0);
  assert.equal(current.sidecar.status, 'failed');
  assert.match(current.sidecar.error, /checksum mismatch.*generation 1/i);
  assert.equal(current.semantic_generation, 0);
  assert.equal(meta.semantic_generation, 0);
});

test('retention preserves every delta newer than semantic_generation for a later sidecar', () => {
  const f = fixture();
  const sidecarEnv = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '4',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
    CONTEXT_CHECKPOINT_RETENTION_GENERATIONS: '2',
  };
  let calls = 0;
  let paths = [];
  const deps = {
    runSidecar(state) {
      calls += 1;
      paths = state.sidecar_delta_paths;
      return { status: 'completed', semantic: semantic('Sidecar goal') };
    },
  };
  complete(f, 'turn-1', 'session-1', sidecarEnv, deps);
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  complete(f, 'turn-2', 'session-1', sidecarEnv, deps);
  fs.appendFileSync(f.transcript, '{"turn":3}\n');
  complete(f, 'turn-3', 'session-1', sidecarEnv, deps);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), sidecarEnv);
  assert.ok([1, 2, 3].every((generation) => fs.existsSync(path.join(
    ctx.deltas,
    `generation-${String(generation).padStart(4, '0')}.jsonl`,
  ))));

  fs.appendFileSync(f.transcript, '{"turn":4}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-4'), sidecarEnv, deps);
  assert.equal(calls, 1);
  assert.deepEqual(paths.map((file) => path.basename(file)), [
    'generation-0001.jsonl',
    'generation-0002.jsonl',
    'generation-0003.jsonl',
    'generation-0004.jsonl',
  ]);
  assert.ok(paths.every((file) => fs.existsSync(file)));
  assert.equal(readCurrent(f).semantic.goal, 'Sidecar goal');
});

test('sidecar byte threshold uses the accumulated unseen delta sizes', () => {
  const chunk = 'x'.repeat(20 * 1024);
  const f = fixture(chunk);
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '3',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: String(32 * 1024),
  };
  let calls = 0;
  let paths = [];
  const deps = {
    runSidecar(state) {
      calls += 1;
      paths = state.sidecar_delta_paths;
      return { status: 'completed', semantic: semantic('Accumulated backlog') };
    },
  };
  complete(f, 'turn-1', 'session-1', env, deps);
  fs.appendFileSync(f.transcript, chunk);
  complete(f, 'turn-2', 'session-1', env, deps);
  fs.appendFileSync(f.transcript, chunk);
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), env, deps);

  assert.equal(calls, 1);
  assert.equal(paths.length, 3);
  assert.equal(paths.reduce((total, file) => total + fs.statSync(file).size, 0), 60 * 1024);
});

test('a reset delta becomes the start of the semantic backlog', () => {
  const f = fixture('{"old":1}\n');
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '4',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  let paths = [];
  const deps = {
    runSidecar(state) {
      paths = state.sidecar_delta_paths;
      return { status: 'completed', semantic: semantic('Reset task') };
    },
  };
  complete(f, 'turn-1', 'session-1', env, deps);
  fs.appendFileSync(f.transcript, '{"old":2}\n');
  complete(f, 'turn-2', 'session-1', env, deps);
  fs.writeFileSync(f.transcript, '{"new":1}\n');
  complete(f, 'turn-3', 'session-1', env, deps);
  fs.appendFileSync(f.transcript, '{"new":2}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-4'), env, deps);

  assert.deepEqual(paths.map((file) => path.basename(file)), [
    'generation-0003.jsonl',
    'generation-0004.jsonl',
  ]);
});

test('a complete reset heals an earlier semantic backlog gap', () => {
  const f = fixture('{"old":1}\n');
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '3',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  let paths = [];
  const deps = {
    runSidecar(state) {
      paths = state.sidecar_delta_paths;
      return { status: 'completed', semantic: semantic('Reset task') };
    },
  };
  complete(f, 'turn-1', 'session-1', env, deps);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  fs.unlinkSync(path.join(ctx.deltas, 'generation-0001.jsonl'));
  fs.writeFileSync(f.transcript, '{"new":1}\n');
  complete(f, 'turn-2', 'session-1', env, deps);
  fs.appendFileSync(f.transcript, '{"new":2}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), env, deps);

  assert.deepEqual(paths.map((file) => path.basename(file)), [
    'generation-0002.jsonl',
    'generation-0003.jsonl',
  ]);
  assert.equal(readCurrent(f).semantic_generation, 3);
});

test('a reset backlog does not trust the previous semantic state', () => {
  const f = fixture('{"old":1}\n');
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '3',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
    CONTEXT_CHECKPOINT_CODEX_BIN: process.execPath,
  };
  complete(f, 'turn-1', 'session-1', env);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Old task')));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1'], env).status, 0);
  fs.writeFileSync(f.transcript, '{"new":1}\n');
  complete(f, 'turn-2', 'session-1', env);
  fs.appendFileSync(f.transcript, '{"new":2}\n');

  let prompt;
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), env, {
    runSidecar(state, ctx, sidecarEnv) {
      return checkpoint.runSidecar(state, ctx, sidecarEnv, (_command, args, options) => {
        prompt = options.input;
        const output = args[args.indexOf('--output-last-message') + 1];
        fs.writeFileSync(output, JSON.stringify(semantic('New task')));
        return { status: 0 };
      });
    },
  });

  assert.doesNotMatch(prompt, /Old task/);
  assert.match(prompt, /Previous semantic state: \{"goal":""/);
});

test('status lists every delta unseen by the semantic checkpoint', () => {
  const f = fixture();
  complete(f, 'turn-1');
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  complete(f, 'turn-2');
  fs.appendFileSync(f.transcript, '{"turn":3}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), f.env);
  const status = runCli(f, ['status', '--thread-id', 'session-1']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).unseen_delta_paths.length, 3);
});

test('status explains whether the current checkpoint can be restored', () => {
  const f = fixture();
  complete(f);

  const empty = runCli(f, ['status', '--thread-id', 'session-1']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).restore_eligible, false);
  assert.equal(JSON.parse(empty.stdout).restore_reason, 'semantic_empty');

  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Diagnosable restore')));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']).status, 0);
  const ready = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout);
  assert.equal(ready.restore_eligible, true);
  assert.equal(ready.restore_reason, 'eligible');

  fs.appendFileSync(f.transcript, '{"newer":true}\n');
  const stale = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout);
  assert.equal(stale.restore_eligible, false);
  assert.equal(stale.restore_reason, 'unexpected_transcript_tail');
});

test('semantic writes and legacy restore require a goal and next action only', () => {
  const writable = fixture();
  complete(writable);
  const semanticFile = path.join(writable.root, 'semantic.json');
  const missingGoal = semantic();
  missingGoal.goal = '';
  fs.writeFileSync(semanticFile, JSON.stringify(missingGoal));
  let result = runCli(writable, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /goal.*non-empty/i);

  const missingNext = semantic();
  missingNext.next_actions = [];
  fs.writeFileSync(semanticFile, JSON.stringify(missingNext));
  result = runCli(writable, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /next_actions.*at least 1/i);

  missingNext.next_actions = [''];
  fs.writeFileSync(semanticFile, JSON.stringify(missingNext));
  result = runCli(writable, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /next_actions.*non-empty/i);

  const minimal = semantic();
  minimal.constraints = [];
  minimal.acceptance_criteria = [];
  fs.writeFileSync(semanticFile, JSON.stringify(minimal));
  result = runCli(writable, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(runCli(
    writable, ['status', '--thread-id', 'session-1'],
  ).stdout).restore_reason, 'eligible');

  for (const [field, value, reason] of [
    ['goal', '', 'goal_missing'],
    ['goal', '   ', 'goal_missing'],
    ['next_actions', [], 'next_action_missing'],
    ['next_actions', ['\t'], 'next_action_missing'],
  ]) {
    const legacy = fixture();
    complete(legacy);
    const file = path.join(legacy.root, 'semantic.json');
    fs.writeFileSync(file, JSON.stringify(semantic('Legacy semantic')));
    assert.equal(runCli(legacy, ['semantic', '--input', file, '--thread-id', 'session-1']).status, 0);
    const ctx = checkpoint.resolveContext(legacy.event('PreCompact'), legacy.env);
    const current = JSON.parse(fs.readFileSync(ctx.current, 'utf8'));
    current.semantic[field] = value;
    delete current.recovery_state;
    fs.writeFileSync(ctx.current, JSON.stringify(current));
    assert.equal(fs.existsSync(ctx.recovery), true);
    const status = JSON.parse(runCli(legacy, ['status', '--thread-id', 'session-1']).stdout);
    assert.equal(status.restore_reason, reason);
    assert.equal(checkpoint.handleHook({ ...legacy.event('SessionStart'), source: 'compact' }, legacy.env), null);
    assert.equal(JSON.parse(fs.readFileSync(ctx.current, 'utf8')).recovery_state, 'retired');
    assert.equal(fs.existsSync(ctx.recovery), false);
  }
});

test('manual semantic coverage uses the committed cursor after compact transcript growth', () => {
  const f = fixture('before-compact');
  checkpoint.handleHook(f.event('PreCompact'), f.env);
  const committedEnd = fs.statSync(f.transcript).size;
  fs.appendFileSync(f.transcript, '-compact-metadata');
  checkpoint.handleHook(f.event('PostCompact'), f.env);

  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Committed semantic baseline')));
  const update = runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.equal(update.status, 0, update.stderr);
  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout);
  assert.equal(status.semantic_transcript.end_offset, committedEnd);
  assert.equal(status.restore_eligible, true);
});

test('manual semantic restores after an opaque host append following PostCompact', () => {
  const f = fixture('generation-one');
  complete(f);
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env), null);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Manual then compact')));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']).status, 0);
  assert.equal(JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout).restore_eligible, true);

  fs.appendFileSync(f.transcript, '-assistant-output');
  complete(f, 'turn-2');
  fs.appendFileSync(f.transcript, 'opaque-host-tail\n');
  const restored = checkpoint.handleHook({ ...f.event('SessionStart', 'turn-2'), source: 'compact' }, f.env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Manual then compact/);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  const receipt = JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).last_recovery_delivery;
  assert.equal(receipt.status, 'local_output_succeeded');
});

test('a later user prompt invalidates a pending manual semantic carry-forward', () => {
  const f = fixture('generation-one');
  complete(f);
  checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Must become stale')));
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']).status, 0);

  assert.equal(checkpoint.handleHook(f.event('UserPromptSubmit', 'new-prompt'), f.env), null);
  fs.appendFileSync(f.transcript, '-new-user-work');
  complete(f, 'turn-2');
  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout);
  assert.equal(status.restore_eligible, false);
  assert.equal(status.restore_reason, 'coverage_mismatch');
});

test('failed UserPrompt recovery still invalidates manual semantic carry-forward', () => {
  const f = fixture('generation-one');
  const sidecarEnv = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), sidecarEnv, {
    runSidecar() { return { status: 'completed', semantic: semantic('Initial pending') }; },
  });
  checkpoint.handleHook(f.event('PostCompact'), sidecarEnv);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Manual before failed output')));
  assert.equal(runCli(f, [
    'semantic', '--input', semanticFile, '--thread-id', 'session-1',
  ], sidecarEnv).status, 0);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), sidecarEnv);

  assert.throws(() => checkpoint.handleHook(f.event('UserPromptSubmit', 'new-prompt'), sidecarEnv, {
    emitHookOutput() { throw new Error('broken stdout'); },
  }), /broken stdout/);
  assert.ok(fs.existsSync(ctx.recovery));
  assert.equal(JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).manual_semantic_anchor, undefined);

  fs.appendFileSync(f.transcript, '-new-user-work');
  complete(f, 'turn-2');
  const status = JSON.parse(runCli(f, ['status', '--thread-id', 'session-1']).stdout);
  assert.equal(status.restore_eligible, false);
  assert.equal(status.restore_reason, 'coverage_mismatch');
});

test('manual semantic update refuses an uncommitted preparing checkpoint', () => {
  const f = fixture();
  checkpoint.handleHook(f.event('PreCompact'), f.env);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Must remain absent')));
  const update = runCli(f, ['semantic', '--input', semanticFile, '--thread-id', 'session-1']);
  assert.notEqual(update.status, 0);
  assert.match(update.stderr, /complete checkpoint/i);
  assert.equal(readCurrent(f).semantic.goal, '');
});

test('sidecar skips the duplicated delta from an interrupted generation', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  let calls = 0;
  let secondPaths;
  const deps = {
    runSidecar(state) {
      calls += 1;
      if (calls === 2) secondPaths = state.sidecar_delta_paths;
      return { status: 'failed', error: 'test failure' };
    },
  };
  checkpoint.handleHook(f.event('PreCompact', 'turn-1'), env, deps);
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), env, deps);
  assert.equal(calls, 2);
  assert.equal(secondPaths.length, 1);
});

test('an interrupted generation does not repeat a successful sidecar call', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  let calls = 0;
  let secondPaths;
  const deps = {
    runSidecar(state) {
      calls += 1;
      if (calls === 2) secondPaths = state.sidecar_delta_paths;
      return { status: 'completed', semantic: semantic('Already current') };
    },
  };
  checkpoint.handleHook(f.event('PreCompact', 'turn-1'), env, deps);
  checkpoint.handleHook(f.event('PreCompact', 'turn-2'), env, deps);
  assert.equal(calls, 1);
  checkpoint.handleHook(f.event('PostCompact', 'turn-2'), env);
  const status = runCli(f, ['status', '--thread-id', 'session-1'], env);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).unseen_delta_paths.length, 0);
  fs.appendFileSync(f.transcript, '{"turn":3}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), env, deps);
  assert.equal(calls, 2);
  assert.equal(secondPaths.length, 1);
});

test('failed semantic checkpoint write does not advance semantic metadata', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  const rename = fs.renameSync;
  let currentWrites = 0;
  fs.renameSync = (source, target) => {
    if (target === ctx.current && ++currentWrites === 2) throw new Error('injected write failure');
    return rename(source, target);
  };
  try {
    assert.throws(() => checkpoint.handleHook(f.event('PreCompact'), env, {
      runSidecar() { return { status: 'completed', semantic: semantic() }; },
    }), /injected write failure/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(JSON.parse(fs.readFileSync(ctx.meta, 'utf8')).semantic_generation, 0);
});

test('recursion guard exits without creating checkpoint state', () => {
  const f = fixture();
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'hooks', 'hooks.json'), 'utf8'));
  const handler = manifest.hooks.PreCompact[0].hooks[0];
  const command = process.platform === 'win32' ? handler.commandWindows : handler.command;
  const guardedData = path.join(f.root, 'guarded-state');
  const result = spawnHookCommand(command, {
    cwd: f.workspace,
    input: JSON.stringify(f.event('PreCompact')),
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGIN_ROOT: project,
      CONTEXT_CHECKPOINT_DATA_DIR: guardedData,
      CONTEXT_CHECKPOINT_HOOK_ACTIVE: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(guardedData), false);
});

test('hook command accepts Codex JSON on stdin', () => {
  const f = fixture();
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'hooks', 'hooks.json'), 'utf8'));
  const handler = manifest.hooks.PreCompact[0].hooks[0];
  const command = process.platform === 'win32' ? handler.commandWindows : handler.command;
  const commandData = path.join(f.root, 'command-state');
  const result = spawnHookCommand(command, {
    cwd: f.workspace,
    input: JSON.stringify(f.event('PreCompact', 'command-turn', 'command-session')),
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGIN_ROOT: project,
      CONTEXT_CHECKPOINT_DATA_DIR: commandData,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(fs.existsSync(path.join(commandData, 'sessions', 'command-session', 'current.json')));
});

test('Windows hook launcher ignores a workspace-provided node command', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  const marker = path.join(f.root, 'hijacked');
  fs.writeFileSync(path.join(f.workspace, 'node.cmd'), `@echo off\r\ntype nul > "${marker}"\r\n`);
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'hooks', 'hooks.json'), 'utf8'));
  const command = manifest.hooks.PreCompact[0].hooks[0].commandWindows;
  const result = spawnHookCommand(command, {
    cwd: f.workspace,
    input: JSON.stringify(f.event('PreCompact')),
    encoding: 'utf8',
    env: { ...f.env, PLUGIN_ROOT: project },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test('workspace fingerprint is explicitly a cheap status marker', () => {
  const f = fixture();
  const snapshot = checkpoint.workspaceSnapshot(f.workspace);
  const subdir = path.join(f.workspace, 'nested');
  fs.mkdirSync(subdir);
  const nested = checkpoint.workspaceSnapshot(subdir);
  assert.equal(snapshot.fingerprint_kind, 'git-status-v2');
  assert.match(snapshot.status_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(nested.identity, snapshot.identity);
  assert.equal('fingerprint' in snapshot, false);
});

test('semantic schema rejects unbounded or unknown content', () => {
  const schema = require('../schemas/semantic-checkpoint.schema.json');
  assert.equal(schema.properties.goal.minLength, 1);
  assert.equal(schema.properties.goal.maxLength, 200);
  assert.equal(schema.properties.goal.pattern, '^[^\\r\\n]*\\S[^\\r\\n]*$');
  assert.equal(schema.properties.next_actions.minItems, 1);
  assert.equal(schema.properties.next_actions.maxItems, 3);
  assert.equal(schema.properties.next_actions.items.minLength, 1);
  assert.equal(schema.properties.next_actions.items.pattern, '^[^\\r\\n]*\\S[^\\r\\n]*$');
  assert.equal(schema.properties.next_actions.items.maxLength, 80);
  assert.equal(schema.$defs.items.maxItems, 3);
  assert.equal(schema.$defs.items.items.minLength, 1);
  assert.equal(schema.$defs.items.items.maxLength, 80);
  assert.equal(schema.$defs.items.items.pattern, '^[^\\r\\n]*\\S[^\\r\\n]*$');
  assert.throws(() => checkpoint.validateSemantic({ goal: '', extra: true }), /unsupported/);
  assert.throws(() => checkpoint.validateSemantic({
    ...checkpoint.emptySemantic(),
    goal: '',
    next_actions: ['Continue'],
  }), /goal.*non-empty/i);
  assert.throws(() => checkpoint.validateSemantic({
    ...semantic(), goal: '   ',
  }), /goal.*non-whitespace/i);
  assert.throws(() => checkpoint.validateSemantic({
    ...semantic(), goal: 'Real goal\n## Next actions',
  }), /goal.*single-line/i);
  assert.throws(() => checkpoint.validateSemantic({
    ...checkpoint.emptySemantic(),
    goal: 'Continue task',
  }), /next_actions.*at least 1/i);
  assert.throws(() => checkpoint.validateSemantic({
    ...semantic(), next_actions: ['\t'],
  }), /items.*non-whitespace/i);
  assert.throws(() => checkpoint.validateSemantic({
    ...semantic(),
    next_actions: ['one', 'two', 'three', 'four'],
  }), /at most 3/);
  const multibyte = { ...semantic(), goal: '目'.repeat(200) };
  for (const key of Object.keys(multibyte).filter((key) => Array.isArray(multibyte[key]))) {
    multibyte[key] = new Array(3).fill('验'.repeat(80));
  }
  assert.doesNotThrow(() => checkpoint.validateSemantic(multibyte));
  const astral = {
    ...semantic(),
    goal: '😀'.repeat(200),
    constraints: ['🚧'.repeat(80)],
  };
  assert.doesNotThrow(() => checkpoint.validateSemantic(astral));
  assert.throws(() => checkpoint.validateSemantic({
    ...semantic(), constraints: ['x'.repeat(81)],
  }), /80 characters/);
  assert.throws(() => checkpoint.validateSemantic({
    ...semantic(), decisions: ['Decision\n## Goal'],
  }), /single-line/);
  assert.doesNotThrow(() => checkpoint.validateSemantic({
    ...semantic(),
    constraints: [],
    acceptance_criteria: [],
    decisions: ['plugins/context-checkpoint/hooks/context-checkpoint.cjs'],
    current_progress: ['sha256:'.concat('a'.repeat(64))],
  }));
  const duplicated = semantic();
  duplicated.negative_knowledge = ['Do not rerun', 'do not rerun', 'Do not rerun'];
  duplicated.constraints = ['Do not rerun', 'Do not rerun '];
  assert.deepEqual(checkpoint.validateSemantic(duplicated).negative_knowledge,
    ['Do not rerun', 'do not rerun']);
  assert.deepEqual(checkpoint.validateSemantic(duplicated).constraints,
    ['Do not rerun', 'Do not rerun ']);
});

test('package and plugin manifest versions match', () => {
  const pkg = require('../package.json');
  const plugin = require('../.codex-plugin/plugin.json');
  assert.equal(plugin.version, pkg.version);
});

test('semantic quality benchmark has a model-free self-check', () => {
  const result = spawnSync(process.execPath, [
    path.join(project, 'bench', 'semantic-quality.cjs'), '--self-test',
  ], { cwd: project, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    benchmark: 'context-checkpoint-sidecar-semantic-quality',
    mode: 'self-test',
    model_or_network_calls: 0,
    fixtures: 3,
    status: 'passed',
  });
});
