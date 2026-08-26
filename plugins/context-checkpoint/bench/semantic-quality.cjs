'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emptySemantic, runSidecar, validateSemantic } = require('../hooks/context-checkpoint.cjs');

const FIXTURES = Object.freeze([
  {
    id: 'oversized-delta',
    transcript: [
      'Goal: Fix recovery after an oversized transcript delta.',
      'Constraint: Do not increase CONTEXT_CHECKPOINT_MAX_DELTA_BYTES=67108864.',
      'Acceptance criterion: A later <=64 MiB delta must be captured.',
      'Current progress: The oversized-delta failure is reproduced.',
      'Decision: Keep the 64 MiB default limit.',
      'Negative knowledge: Do not treat skipped bytes as reviewed.',
      'Unknown: Whether PostCompact always fires on Windows is unknown.',
      'Next action: Add oversized-delta recovery regression test.',
      'Path: plugins/context-checkpoint/hooks/context-checkpoint.cjs',
    ].join('\n'),
    expected: {
      goal: 'Fix recovery after an oversized transcript delta.',
      acceptance_criteria: ['A later <=64 MiB delta must be captured.'],
      constraints: ['Do not increase CONTEXT_CHECKPOINT_MAX_DELTA_BYTES=67108864.'],
      decisions: ['Keep the 64 MiB default limit.', 'Path: plugins/context-checkpoint/hooks/context-checkpoint.cjs'],
      current_progress: ['The oversized-delta failure is reproduced.'],
      negative_knowledge: ['Do not treat skipped bytes as reviewed.'],
      open_questions: ['Whether PostCompact always fires on Windows is unknown.'],
      next_actions: ['Add oversized-delta recovery regression test.'],
    },
    literals: [
      'CONTEXT_CHECKPOINT_MAX_DELTA_BYTES=67108864',
      '<=64 MiB',
      'plugins/context-checkpoint/hooks/context-checkpoint.cjs',
    ],
    forbidden_claims: [
      'Skipped bytes were reviewed.',
      'PostCompact always fires on Windows.',
      'Increase CONTEXT_CHECKPOINT_MAX_DELTA_BYTES.',
    ],
  },
  {
    id: 'release-boundary',
    transcript: [
      'Goal: Prepare the local v9.9.9-fixture semantic-quality patch.',
      'Constraint: Do not push commit deadbeef or create release v9.9.9-fixture.',
      'Acceptance criterion: npm test passes with sidecar_calls: 0.',
      'Current progress: The patch is local and NOT_VALIDATED on a restarted host.',
      'Decision: Keep CommonJS and add no runtime dependency.',
      'Negative knowledge: A matching hash does not prove host activation.',
      'Unknown: Whether the user will authorize a GitHub release is unknown.',
      'Next action: Run npm test from plugins/context-checkpoint.',
      'Command: npm test',
    ].join('\n'),
    expected: {
      goal: 'Prepare the local v9.9.9-fixture semantic-quality patch.',
      acceptance_criteria: ['npm test passes with sidecar_calls: 0.'],
      constraints: ['Do not push commit deadbeef or create release v9.9.9-fixture.'],
      decisions: ['Keep CommonJS and add no runtime dependency.'],
      current_progress: ['The patch is local and NOT_VALIDATED on a restarted host.'],
      negative_knowledge: ['A matching hash does not prove host activation.'],
      open_questions: ['Whether the user will authorize a GitHub release is unknown.'],
      next_actions: ['Run npm test from plugins/context-checkpoint.'],
    },
    literals: [
      'v9.9.9-fixture',
      'deadbeef',
      'sidecar_calls: 0',
      'NOT_VALIDATED',
      'npm test',
      'plugins/context-checkpoint',
    ],
    forbidden_claims: [
      'Commit deadbeef was pushed.',
      'Release v9.9.9-fixture was created.',
      'The restarted host is validated.',
    ],
  },
  {
    id: 'runtime-versus-validation',
    transcript: [
      'Goal: Resume job PCSEL-O108 without repeating the expensive solve.',
      'Constraint: Do not rerun solve.mph before checking writer.lock.',
      'Acceptance criterion: Report runtime completion separately from scientific validation.',
      'Current progress: result.mph exists; its scientific result is not verified.',
      'Decision: Inspect C:\\runs\\PCSEL-O108\\writer.lock first.',
      'Negative knowledge: File existence is not scientific validation.',
      'Unknown: Whether process 7312 still owns writer.lock is unknown.',
      'Next action: Check writer.lock and process ID 7312 with stability_window_seconds=30.',
    ].join('\n'),
    expected: {
      goal: 'Resume job PCSEL-O108 without repeating the expensive solve.',
      acceptance_criteria: ['Report runtime completion separately from scientific validation.'],
      constraints: ['Do not rerun solve.mph before checking writer.lock.'],
      decisions: ['Inspect C:\\runs\\PCSEL-O108\\writer.lock first.'],
      current_progress: ['result.mph exists; its scientific result is not verified.'],
      negative_knowledge: ['File existence is not scientific validation.'],
      open_questions: ['Whether process 7312 still owns writer.lock is unknown.'],
      next_actions: ['Check writer.lock and process ID 7312 with stability_window_seconds=30.'],
    },
    literals: [
      'PCSEL-O108',
      'solve.mph',
      'C:\\runs\\PCSEL-O108\\writer.lock',
      '7312',
      'stability_window_seconds=30',
    ],
    forbidden_claims: [
      'The scientific result is verified.',
      'Process 7312 owns writer.lock.',
      'Rerun solve.mph.',
    ],
  },
]);

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function semanticStrings(candidate) {
  if (!candidate || typeof candidate !== 'object') return [];
  return Object.values(candidate).flatMap((value) => (
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
  ));
}

function scoreCandidate(fixture, candidate) {
  const strings = semanticStrings(candidate);
  const literal_checks = fixture.literals.map((literal) => ({
    literal,
    preserved: strings.some((value) => value.includes(literal)),
  }));
  const forbidden_claim_hits = fixture.forbidden_claims.filter((claim) => (
    strings.some((value) => value.includes(claim))
  ));
  const checks = {
    goal_exact: candidate?.goal === fixture.expected.goal,
    constraints_exact: sameStrings(candidate?.constraints, fixture.expected.constraints),
    literals_exact: literal_checks.every(({ preserved }) => preserved),
    negative_knowledge_exact: sameStrings(candidate?.negative_knowledge, fixture.expected.negative_knowledge),
    open_questions_exact: sameStrings(candidate?.open_questions, fixture.expected.open_questions),
    next_actions_exact: sameStrings(candidate?.next_actions, fixture.expected.next_actions),
    forbidden_claims_clear: forbidden_claim_hits.length === 0,
  };
  return {
    checks,
    passed_checks: Object.values(checks).filter(Boolean).length,
    total_checks: Object.keys(checks).length,
    literal_checks,
    forbidden_claim_hits,
  };
}

function aggregateScores(results) {
  const completed = results.filter((result) => result.sidecar_status === 'completed');
  const scores = completed.map((result) => result.score);
  const totalChecks = scores.reduce((total, score) => total + score.total_checks, 0);
  const passedChecks = scores.reduce((total, score) => total + score.passed_checks, 0);
  const literalChecks = scores.flatMap((score) => score.literal_checks);
  const checkRate = (name) => (scores.length
    ? Number((scores.filter((score) => score.checks[name]).length / scores.length).toFixed(4))
    : null);
  return {
    fixture_count: FIXTURES.length,
    completed_sidecars: completed.length,
    exact_check_pass_rate: totalChecks ? Number((passedChecks / totalChecks).toFixed(4)) : 0,
    literal_preservation_rate: literalChecks.length
      ? Number((literalChecks.filter(({ preserved }) => preserved).length / literalChecks.length).toFixed(4))
      : 0,
    constraint_negation_error_rate: scores.length
      ? Number((1 - scores.filter((score) => (
        score.checks.constraints_exact && score.checks.negative_knowledge_exact
      )).length / scores.length).toFixed(4))
      : null,
    unknown_preservation_rate: checkRate('open_questions_exact'),
    next_action_exact_rate: checkRate('next_actions_exact'),
    forbidden_claim_trap_hit_count: scores.reduce(
      (total, score) => total + score.forbidden_claim_hits.length,
      0,
    ),
  };
}

function pathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeRemoveTemp(root, tempDir) {
  assert.ok(root !== tempDir && pathWithin(tempDir, root));
  assert.match(path.basename(root), /^context-checkpoint-semantic-quality-/);
  fs.rmSync(root, { recursive: true, force: true });
}

function runLive(env = process.env) {
  const tempDir = fs.realpathSync(os.tmpdir());
  const targetWorkspace = path.resolve(__dirname, '..');
  assert.equal(pathWithin(targetWorkspace, tempDir), false);
  const root = fs.mkdtempSync(path.join(tempDir, 'context-checkpoint-semantic-quality-'));
  const results = [];
  try {
    assert.equal(pathWithin(targetWorkspace, root), false);
    const deltaDir = path.join(root, 'deltas');
    fs.mkdirSync(deltaDir);
    for (const [index, fixture] of FIXTURES.entries()) {
      const delta = path.join(deltaDir, `${fixture.id}.jsonl`);
      const sessionDir = path.join(root, 'sessions', fixture.id);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(delta, `${JSON.stringify({ type: 'controlled_fixture', text: fixture.transcript })}\n`, 'utf8');
      const sidecar = runSidecar({
        generation: index + 1,
        semantic: emptySemantic(),
        sidecar_backlog_reset: true,
        sidecar_delta_paths: [delta],
      }, { sessionDir }, env);
      results.push({
        id: fixture.id,
        sidecar_status: sidecar.status,
        ...(sidecar.status === 'completed'
          ? { candidate: sidecar.semantic, score: scoreCandidate(fixture, sidecar.semantic) }
          : { error: sidecar.error }),
      });
    }
    return {
      benchmark: 'context-checkpoint-sidecar-semantic-quality',
      scope: 'sidecar-only',
      determinism: 'nondeterministic-model-evaluation',
      quality_gate: 'none; inspect exact checks and forbidden-claim trap hits',
      results,
      aggregate: aggregateScores(results),
    };
  } finally {
    safeRemoveTemp(root, tempDir);
  }
}

function runSelfTest() {
  for (const fixture of FIXTURES) validateSemantic(fixture.expected);
  const exact = scoreCandidate(FIXTURES[0], FIXTURES[0].expected);
  assert.equal(exact.passed_checks, exact.total_checks);
  assert.deepEqual(exact.forbidden_claim_hits, []);
  const broken = scoreCandidate(FIXTURES[0], {
    goal: 'Wrong goal',
    current_progress: [FIXTURES[0].forbidden_claims[0]],
    constraints: [],
    decisions: [],
    negative_knowledge: [],
    open_questions: [],
    next_actions: ['Wrong next action'],
  });
  assert.deepEqual(broken.checks, {
    goal_exact: false,
    constraints_exact: false,
    literals_exact: false,
    negative_knowledge_exact: false,
    open_questions_exact: false,
    next_actions_exact: false,
    forbidden_claims_clear: false,
  });
  assert.deepEqual(broken.forbidden_claim_hits, [FIXTURES[0].forbidden_claims[0]]);
  assert.deepEqual(aggregateScores([
    { sidecar_status: 'completed', score: exact },
    { sidecar_status: 'completed', score: broken },
  ]), {
    fixture_count: 3,
    completed_sidecars: 2,
    exact_check_pass_rate: 0.5,
    literal_preservation_rate: 0.5,
    constraint_negation_error_rate: 0.5,
    unknown_preservation_rate: 0.5,
    next_action_exact_rate: 0.5,
    forbidden_claim_trap_hit_count: 1,
  });
  return {
    benchmark: 'context-checkpoint-sidecar-semantic-quality',
    mode: 'self-test',
    model_or_network_calls: 0,
    fixtures: FIXTURES.length,
    status: 'passed',
  };
}

module.exports = { FIXTURES, aggregateScores, scoreCandidate };

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--self-test')) {
      throw new Error('usage: node bench/semantic-quality.cjs [--self-test]');
    }
    const report = args[0] === '--self-test' ? runSelfTest() : runLive();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.results?.some((result) => result.sidecar_status !== 'completed')) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`semantic-quality: ${error.message}\n`);
    process.exitCode = 1;
  }
}
