'use strict';

const assert = require('node:assert/strict');
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
  const env = { ...process.env, CONTEXT_CHECKPOINT_DATA_DIR: data };
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
  assert.equal(runCli(f, ['semantic', '--input', semanticFile, '--session-id', 'session-1']).status, 0);
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
});

test('semantic restoration keeps every bounded checkpoint section', () => {
  const f = fixture();
  complete(f);
  const semanticFile = path.join(f.root, 'semantic.json');
  const value = semantic('Restore this task', 'TAIL-NEXT-ACTION');
  value.constraints = new Array(3).fill('x'.repeat(50));
  fs.writeFileSync(semanticFile, JSON.stringify(value));
  const update = runCli(f, ['semantic', '--input', semanticFile, '--session-id', 'session-1']);
  assert.equal(update.status, 0, update.stderr);
  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env);
  assert.match(restored.hookSpecificOutput.additionalContext, /TAIL-NEXT-ACTION/);
  assert.ok(restored.hookSpecificOutput.additionalContext.length < 7500);
});

test('semantic restoration allows only the compacted record appended by native compact', () => {
  const f = fixture();
  const env = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '1',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
  };
  checkpoint.handleHook(f.event('PreCompact'), env, {
    runSidecar() { return { status: 'completed', semantic: semantic('Fresh compact goal') }; },
  });
  fs.appendFileSync(f.transcript, `${JSON.stringify({ type: 'compacted', payload: {} })}\n`);
  fs.appendFileSync(f.transcript, `${JSON.stringify({ type: 'world_state', payload: {} })}\n`);
  checkpoint.handleHook(f.event('PostCompact'), env);
  const restored = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env);
  assert.match(restored.hookSpecificOutput.additionalContext, /Fresh compact goal/);

  fs.appendFileSync(f.transcript, `${JSON.stringify({ type: 'message', payload: {} })}\n`);
  assert.equal(checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, env), null);
});

test('stale semantic state is never auto-injected', () => {
  const f = fixture();
  complete(f);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic('Durable handoff')));
  const update = runCli(f, ['semantic', '--input', semanticFile, '--session-id', 'session-1']);
  assert.equal(update.status, 0, update.stderr);

  fs.appendFileSync(f.transcript, '{"newer":true}\n');
  complete(f, 'turn-2');
  const compact = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'compact' }, f.env);
  assert.equal(compact, null);
  const resume = checkpoint.handleHook({ ...f.event('SessionStart'), source: 'resume' }, f.env);
  assert.equal(resume, null);
});

test('manual CLI refuses an ambiguous workspace and accepts an explicit session', () => {
  const f = fixture();
  complete(f, 'turn-a', 'session-a');
  complete(f, 'turn-b', 'session-b');
  const ambiguous = runCli(f, ['status']);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /multiple sessions/i);
  const explicit = runCli(f, ['status', '--session-id', 'session-a']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).session_id, 'session-a');
});

test('semantic CLI reports lock contention instead of false success', () => {
  const f = fixture();
  complete(f);
  const semanticFile = path.join(f.root, 'semantic.json');
  fs.writeFileSync(semanticFile, JSON.stringify(semantic()));
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), f.env);
  fs.writeFileSync(ctx.lock, 'owner');
  const result = runCli(f, ['semantic', '--input', semanticFile, '--session-id', 'session-1']);
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

test('oversized transcript deltas fail closed without a large state file', () => {
  const f = fixture('x'.repeat(1024));
  const env = { ...f.env, CONTEXT_CHECKPOINT_MAX_DELTA_BYTES: '100' };
  checkpoint.handleHook(f.event('PreCompact'), env);
  const current = readCurrent(f, 'session-1', env);
  assert.equal(current.transcript_delta.status, 'too-large');
  assert.equal(current.transcript_delta.delta_path, null);
});

test('retention removes generations older than the configured window', () => {
  const f = fixture();
  const env = { ...f.env, CONTEXT_CHECKPOINT_RETENTION_GENERATIONS: '2' };
  complete(f, 'turn-1', 'session-1', env);
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  complete(f, 'turn-2', 'session-1', env);
  fs.appendFileSync(f.transcript, '{"turn":3}\n');
  complete(f, 'turn-3', 'session-1', env);
  const ctx = checkpoint.resolveContext(f.event('PreCompact'), env);
  assert.equal(fs.existsSync(path.join(ctx.history, 'generation-0001.json')), false);
  assert.equal(fs.existsSync(path.join(ctx.deltas, 'generation-0001.jsonl')), false);
  assert.equal(fs.existsSync(path.join(ctx.history, 'generation-0002.json')), true);
});

test('sidecar receives a minimal environment and cannot browse the workspace', () => {
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
  assert.match(observed.options.input, /untrusted data/);
  assert.match(observed.options.input, /do not inspect workspace files/);
});

test('sidecar is opt-in, generation-gated, and receives every unseen delta', () => {
  const f = fixture();
  const sidecarEnv = {
    ...f.env,
    CONTEXT_CHECKPOINT_SIDECAR_EVERY: '3',
    CONTEXT_CHECKPOINT_SIDECAR_MIN_BYTES: '1',
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
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), sidecarEnv, deps);
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), sidecarEnv, deps);
  assert.equal(calls, 1);
  assert.equal(paths.length, 3);
  assert.ok(paths.every((file) => fs.existsSync(file)));
  assert.equal(readCurrent(f).semantic.goal, 'Sidecar goal');
});

test('status lists every delta unseen by the semantic checkpoint', () => {
  const f = fixture();
  complete(f, 'turn-1');
  fs.appendFileSync(f.transcript, '{"turn":2}\n');
  complete(f, 'turn-2');
  fs.appendFileSync(f.transcript, '{"turn":3}\n');
  checkpoint.handleHook(f.event('PreCompact', 'turn-3'), f.env);
  const status = runCli(f, ['status', '--session-id', 'session-1']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).unseen_delta_paths.length, 3);
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
  const status = runCli(f, ['status', '--session-id', 'session-1'], env);
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
  const result = spawnSync(command, {
    cwd: f.workspace,
    shell: true,
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
  const result = spawnSync(command, {
    cwd: f.workspace,
    shell: true,
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
  const result = spawnSync(command, {
    cwd: f.workspace,
    shell: true,
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
  assert.throws(() => checkpoint.validateSemantic({ goal: '', extra: true }), /unsupported/);
  assert.throws(() => checkpoint.validateSemantic({
    ...checkpoint.emptySemantic(),
    next_actions: new Array(4).fill('x'),
  }), /at most 3/);
});
