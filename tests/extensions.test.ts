import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditSuites, auditSuiteFiles } from '../src/audit.js';
import { attributeRun } from '../src/attribution.js';
import {
  validateCaseKeys,
  validateCaseMetadata,
  validateCaseProvenance,
  validateClaim,
  validateGuardrail,
  validateMetric,
  validateMetrics,
  validateSuiteMetadata,
  validateToolBoundary,
} from '../src/contract.js';
import { digest, loadSuite, reportRun, runSuite } from '../src/evaluation.js';
import type { RunReport, Suite } from '../src/evaluation.js';
import { experimentJobs, loadExperiment, runExperiment } from '../src/experiment.js';
import {
  loadScenario,
  runScenario,
  scenarioCases,
  scenarioReport,
} from '../src/scenario.js';
import { binaryEffect, pairedContinuousEffect, summarizeContinuous } from '../src/statistics.js';
import { main } from '../src/cli.js';

async function writeJson(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value), 'utf8');
  return path;
}

function baseSuite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'craft-eval.eval.v1',
    suite_id: 'contract-suite',
    subject_kind: 'software',
    partition: 'held_out',
    sanitized: true,
    approved_by: 'reviewer',
    cases: [
      {
        id: 'case-one',
        argv: ['node', 'host.mjs'],
        checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
      },
    ],
    ...overrides,
  };
}

test('contract metadata is optional, validated, and reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-contract-'));
  try {
    const oldSuite = await writeJson(root, 'old.json', baseSuite());
    assert.equal((await loadSuite(oldSuite)).suite_id, 'contract-suite');

    const validCase = {
      id: 'case-one',
      argv: ['node', 'host.mjs'],
      checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
      tags: ['smoke'],
      category: 'software',
      difficulty: 'medium',
      risk: 'high',
      provenance: {
        source: 'reviewed fixture',
        independent_of_training: true,
        reviewed_by: 'reviewer',
      },
      owner: 'team',
      expected_behavior: 'writes state',
      claim: 'this case checks state',
    };
    const valid = baseSuite({
      claim: { statement: 'Works for this task family', scope: 'software v1', limitations: ['local only'] },
      metrics: {
        primary: { id: 'pass', kind: 'binary_pass_rate', direction: 'higher_is_better', minimum_sample: 20 },
        guardrails: [{ id: 'cost', metric: 'cost_units', comparator: 'lte', threshold: 1 }],
      },
      owner: 'team',
      source: 'fixture',
      expires_at: '2099-12-31',
      boundaries: { allowed_hosts: ['codex'], allowed_tools: ['read'], network: 'deny' },
      cases: [validCase],
    });
    const loaded = await loadSuite(await writeJson(root, 'valid.json', valid));
    assert.equal(loaded.claim?.statement, 'Works for this task family');
    assert.equal(loaded.metrics?.primary.minimum_sample, 20);
    assert.equal(loaded.cases[0]?.difficulty, 'medium');

    const invalidValues = [
      { ...valid, claim: { statement: '', scope: 'x' } },
      { ...valid, metrics: { primary: { id: 'p', kind: 'wrong', direction: 'higher_is_better' } } },
      { ...valid, expires_at: 'not-a-date' },
      { ...valid, boundaries: { allowed_hosts: ['unknown'] } },
      {
        ...valid,
        cases: [{ ...validCase, tags: ['same', 'same'] }],
      },
      {
        ...valid,
        cases: [{ ...validCase, provenance: { source: 'x', independent_of_training: 'yes' } }],
      },
      {
        ...valid,
        cases: [{ ...validCase, difficulty: 'impossible' }],
      },
      {
        ...valid,
        cases: [{ ...validCase, mystery: true }],
      },
    ];
    for (const [index, value] of invalidValues.entries()) {
      await assert.rejects(loadSuite(await writeJson(root, `invalid-${index}.json`, value)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('contract validators reject malformed metadata at every boundary', () => {
  assert.deepEqual(
    validateClaim({ statement: 'claim', scope: 'scope', limitations: ['one'] }),
    { statement: 'claim', scope: 'scope', limitations: ['one'] },
  );
  for (const value of [
    null,
    [],
    { statement: '', scope: 'scope' },
    { statement: 'claim', scope: 'scope', unknown: true },
    { statement: 'claim', scope: 'scope', limitations: 'not-an-array' },
    { statement: 'claim', scope: 'scope', limitations: ['same', 'same'] },
  ]) {
    assert.throws(() => validateClaim(value));
  }

  assert.deepEqual(
    validateMetric({
      id: 'latency',
      kind: 'duration_ms',
      direction: 'lower_is_better',
      description: 'wall time',
      unit: 'ms',
      minimum_sample: 2,
    }),
    {
      id: 'latency',
      kind: 'duration_ms',
      direction: 'lower_is_better',
      description: 'wall time',
      unit: 'ms',
      minimum_sample: 2,
    },
  );
  for (const value of [
    { id: 'x', kind: 'wrong', direction: 'higher_is_better' },
    { id: 'x', kind: 'custom', direction: 'wrong' },
    { id: '', kind: 'custom', direction: 'higher_is_better' },
    { id: 'x', kind: 'custom', direction: 'higher_is_better', minimum_sample: 1.5 },
    { id: 'x', kind: 'custom', direction: 'higher_is_better', minimum_sample: Number.NaN },
    { id: 'x', kind: 'custom', direction: 'higher_is_better', unknown: true },
  ]) {
    assert.throws(() => validateMetric(value));
  }

  assert.deepEqual(
    validateGuardrail({ id: 'safe', metric: 'cost_units', comparator: 'lte', threshold: 1, required: true }),
    { id: 'safe', metric: 'cost_units', comparator: 'lte', threshold: 1, required: true },
  );
  for (const value of [
    { id: 'x', metric: 'm', comparator: 'eq', threshold: 1 },
    { id: 'x', metric: 'm', comparator: 'lte', threshold: 1, required: 'yes' },
    { id: 'x', metric: 'm', comparator: 'lte', threshold: Number.POSITIVE_INFINITY },
    { id: 'x', metric: 'm', comparator: 'lte', threshold: 1, unknown: true },
  ]) {
    assert.throws(() => validateGuardrail(value));
  }

  assert.equal(
    validateMetrics({
      primary: { id: 'pass', kind: 'binary_pass_rate', direction: 'higher_is_better' },
      guardrails: [{ id: 'cost', metric: 'cost_units', comparator: 'lte', threshold: 1 }],
    }).guardrails?.length,
    1,
  );
  assert.throws(() =>
    validateMetrics({
      primary: { id: 'pass', kind: 'binary_pass_rate', direction: 'higher_is_better' },
      guardrails: [
        { id: 'same', metric: 'a', comparator: 'lte', threshold: 1 },
        { id: 'same', metric: 'b', comparator: 'lte', threshold: 1 },
      ],
    }),
  );
  assert.throws(() =>
    validateMetrics({
      primary: { id: 'pass', kind: 'binary_pass_rate', direction: 'higher_is_better' },
      guardrails: 'bad',
    }),
  );

  assert.deepEqual(
    validateCaseProvenance({
      source: 'issue',
      independent_of_training: true,
      reviewed_by: 'reviewer',
      source_digest: 'sha256:x',
    }),
    {
      source: 'issue',
      independent_of_training: true,
      reviewed_by: 'reviewer',
      source_digest: 'sha256:x',
    },
  );
  assert.throws(() => validateCaseProvenance({ source: 'x', independent_of_training: 'yes' }));
  assert.throws(() => validateCaseProvenance({ source: 'x', unknown: true }));

  assert.deepEqual(
    validateCaseMetadata({
      tags: ['smoke'],
      category: 'software',
      difficulty: 'hard',
      risk: 'critical',
      provenance: { source: 'fixture' },
      owner: 'team',
      expected_behavior: 'writes output',
      claim: 'works',
    }),
    {
      tags: ['smoke'],
      category: 'software',
      difficulty: 'hard',
      risk: 'critical',
      provenance: { source: 'fixture' },
      owner: 'team',
      expected_behavior: 'writes output',
      claim: 'works',
    },
  );
  assert.throws(() => validateCaseMetadata(null));
  assert.throws(() => validateCaseMetadata({ difficulty: 'impossible' }));
  assert.throws(() => validateCaseMetadata({ risk: 'unknown' }));
  assert.throws(() => validateCaseMetadata({ tags: ['same', 'same'] }));
  assert.throws(() => validateCaseMetadata({ unknown: true }));
  assert.doesNotThrow(() => validateCaseKeys({ id: 'x', argv: ['node', 'x.mjs'], checks: [] }));
  assert.throws(() => validateCaseKeys({ id: 'x', unknown: true }));

  assert.deepEqual(
    validateToolBoundary({
      allowed_hosts: ['codex', 'local'],
      allowed_tools: ['read'],
      forbidden_tools: ['write'],
      network: 'deny',
    }),
    {
      allowed_hosts: ['codex', 'local'],
      allowed_tools: ['read'],
      forbidden_tools: ['write'],
      network: 'deny',
    },
  );
  for (const value of [
    { allowed_hosts: [] },
    { allowed_hosts: ['unknown'] },
    { allowed_hosts: ['codex', 'codex'] },
    { allowed_tools: ['read'], forbidden_tools: ['read'] },
    { network: 'sometimes' },
    { unknown: true },
  ]) {
    assert.throws(() => validateToolBoundary(value));
  }

  assert.equal(
    validateSuiteMetadata({
      claim: { statement: 'claim', scope: 'scope' },
      metrics: { primary: { id: 'pass', kind: 'binary_pass_rate', direction: 'higher_is_better' } },
      owner: 'team',
      source: 'fixture',
      expires_at: '2099-01-01',
      boundaries: { network: 'unobserved' },
    }).owner,
    'team',
  );
  assert.throws(() => validateSuiteMetadata({ expires_at: 'not-a-date' }));
});

test('audit finds duplication, contamination and missing quality declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-audit-'));
  try {
    const development = baseSuite({
      suite_id: 'development',
      partition: 'development',
      approved_by: undefined,
      cases: [
        {
          id: 'dev-one',
          prompt: 'Same prompt',
          argv: undefined,
          checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
        },
      ],
    });
    const held = baseSuite({
      suite_id: 'held',
      partition: 'held_out',
      cases: [
        {
          id: 'held-one',
          prompt: '  SAME   prompt ',
          argv: undefined,
          checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
        },
        {
          id: 'held-two',
          prompt: 'Different',
          argv: undefined,
          checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
        },
      ],
    });
    const report = auditSuites([
      (await loadSuite(await writeJson(root, 'dev.json', development))) as Suite,
      (await loadSuite(await writeJson(root, 'held.json', held))) as Suite,
    ]);
    assert.equal(report.status, 'failed');
    assert.ok(report.findings.some((item) => item.code === 'duplicate_case_content'));
    assert.ok(report.findings.some((item) => item.code === 'duplicate_prompt'));
    assert.ok(report.findings.some((item) => item.code === 'development_held_out_reuse'));
    assert.ok(report.findings.some((item) => item.code === 'case_provenance_missing'));
    assert.ok(report.findings.some((item) => item.code === 'held_out_independence_undeclared'));
    assert.equal(report.cases.length, 3);

    const duplicateAcceptance = await loadSuite(
      await writeJson(root, 'acceptance.json', baseSuite({
        suite_id: 'acceptance',
        partition: 'development',
        approved_by: undefined,
        cases: [
          { id: 'one', argv: ['node', 'x.mjs'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] },
          { id: 'two', argv: ['node', 'x.mjs'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] },
        ],
      })),
    );
    assert.ok(
      auditSuites([duplicateAcceptance]).findings.some((item) => item.code === 'duplicate_acceptance'),
    );

    const informative = await loadSuite(
      await writeJson(root, 'informative.json', baseSuite({
        suite_id: 'informative',
        partition: 'development',
        approved_by: undefined,
        expires_at: '2000-01-01',
        cases: [
          {
            id: 'trace',
            argv: ['node', 'x.mjs'],
            checks: [{ id: 'trace', kind: 'trace_event', event: 'run.finished', present: true }],
          },
          {
            id: 'negative-tool',
            argv: ['node', 'x.mjs'],
            mcp: [{ name: 'server', tools: [{ name: 'tool' }] }],
            checks: [{ id: 'tool', kind: 'tool_call', server: 'server', tool: 'tool', called: false }],
          },
        ],
      })),
    );
    const informativeReport = auditSuites([informative]);
    assert.equal(informativeReport.cases[0]?.information_checks, 1);
    assert.equal(informativeReport.cases[1]?.information_checks, 0);
    assert.ok(informativeReport.findings.some((item) => item.code === 'case_without_information'));
    assert.ok(informativeReport.findings.some((item) => item.code === 'suite_expired'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const duplicateRoot = await mkdtemp(join(tmpdir(), 'craft-eval-audit-dupe-'));
  try {
    const raw = baseSuite({
      cases: [
        { id: 'same', argv: ['node', 'x.mjs'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] },
        { id: 'same', argv: ['node', 'y.mjs'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] },
      ],
    });
    const path = await writeJson(duplicateRoot, 'dupe.json', raw);
    const report = await auditSuiteFiles([path]);
    assert.equal(report.status, 'failed');
    assert.ok(report.findings.some((item) => item.code === 'duplicate_case_id'));
    assert.throws(() => auditSuites([]), /at least one suite/);
    await assert.rejects(auditSuiteFiles([]), /at least one suite path/);

    const malformed = [
      { name: 'array.json', value: [] },
      { name: 'missing-cases.json', value: { schema: 'craft-eval.eval.v1' } },
      { name: 'bad-case.json', value: { schema: 'craft-eval.eval.v1', cases: [null] } },
      { name: 'bad-id.json', value: { schema: 'craft-eval.eval.v1', cases: [{ id: 1 }] } },
    ];
    for (const item of malformed) {
      const malformedPath = await writeJson(duplicateRoot, item.name, item.value);
      await assert.rejects(auditSuiteFiles([malformedPath]));
    }
  } finally {
    await rm(duplicateRoot, { recursive: true, force: true });
  }
});

test('audit reports missing reviewers, duplicate suites and uninformative negative cases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-audit-extra-'));
  try {
    const raw = baseSuite({
      suite_id: 'unreviewed',
      subject_kind: 'skill',
      approved_by: undefined,
      cases: [
        {
          id: 'negative',
          prompt: 'Do not trigger',
          argv: undefined,
          checks: [],
          skill: {
            skill_id: 'negative-skill',
            skill_path: 'skills/negative-skill',
            should_trigger: false,
          },
        },
      ],
    });
    const suite = await loadSuite(
      await writeJson(root, 'suite.json', {
        ...raw,
        approved_by: 'reviewer',
      }),
    );
    suite.approved_by = undefined;
    const report = auditSuites([suite, suite]);
    assert.equal(report.status, 'failed');
    assert.ok(report.findings.some((item) => item.code === 'duplicate_suite_id'));
    assert.ok(report.findings.some((item) => item.code === 'held_out_not_reviewed'));
    assert.ok(report.findings.some((item) => item.code === 'held_out_case_review_incomplete'));
    assert.ok(report.findings.some((item) => item.code === 'held_out_independence_undeclared'));
    assert.ok(report.findings.some((item) => item.code === 'case_provenance_missing'));
    assert.ok(report.findings.some((item) => item.code === 'case_expected_behavior_missing'));
    assert.ok(report.findings.some((item) => item.code === 'case_without_information'));
    assert.ok(report.findings.some((item) => item.code === 'negative_case_only_trigger'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('statistics report paired effects with deterministic intervals', () => {
  const binary = binaryEffect([
    { baseline: false, candidate: true },
    { baseline: false, candidate: true },
    { baseline: true, candidate: true },
    { baseline: true, candidate: false },
  ]);
  assert.equal(binary.candidate_wins, 2);
  assert.equal(binary.baseline_wins, 1);
  assert.equal(binary.ties, 1);
  assert.equal(binary.risk_difference, 0.25);
  assert.ok(binary.risk_difference_ci95 !== null);
  assert.ok(Math.abs((binary.sign_test_p ?? 0) - 0.5) < 1e-12);
  assert.deepEqual(binary, binaryEffect([
    { baseline: false, candidate: true },
    { baseline: false, candidate: true },
    { baseline: true, candidate: true },
    { baseline: true, candidate: false },
  ]));
  const continuous = summarizeContinuous([1, 2, 3, 4]);
  assert.equal(continuous.mean, 2.5);
  assert.equal(continuous.median, 2.5);
  assert.ok((continuous.variance ?? 0) > 0);
  const paired = pairedContinuousEffect([
    { baseline: 10, candidate: 5 },
    { baseline: 20, candidate: 15 },
  ]);
  assert.equal(paired.mean_difference, -5);
  assert.ok(paired.bootstrap_mean_difference_ci95 !== null);
  assert.equal(summarizeContinuous([]).mean, null);
  assert.deepEqual(summarizeContinuous([7]), {
    observed: 1,
    mean: 7,
    median: 7,
    p95: 7,
    variance: null,
    standard_deviation: null,
  });
  assert.equal(summarizeContinuous([Number.NaN, Number.POSITIVE_INFINITY]).observed, 0);
  assert.equal(binaryEffect([]).sign_test_p, null);
  assert.equal(pairedContinuousEffect([{ baseline: 1, candidate: 1 }]).bootstrap_mean_difference_ci95, null);
  assert.equal(
    pairedContinuousEffect([
      { baseline: 1, candidate: 1 },
      { baseline: 2, candidate: 2 },
    ]).standardized_difference,
    null,
  );
});

function result(overrides: Partial<RunReport['results'][number]> = {}): RunReport['results'][number] {
  return {
    case_id: 'case',
    trial: 1,
    task_run_id: 'task',
    verdict: 'failed',
    task_verdict: 'failed',
    safety_verdict: null,
    trigger: null,
    issue: null,
    exit_code: 1,
    duration_ms: 10,
    cost_units: null,
    checks: [{ id: 'check', passed: false, reason: 'value_mismatch', evidence: { kind: 'json_equals' } }],
    safety_checks: [],
    stdout_sha256: null,
    stderr_sha256: null,
    trace_sha256: null,
    gateway_sha256: null,
    trace_complete: true,
    host: null,
    ...overrides,
  };
}

test('attribution uses check and trigger evidence without model reasoning', () => {
  const report: RunReport = {
    run_id: 'run',
    suite_id: 'suite',
    subject: {},
    partition: 'held_out',
    expected: 5,
    recorded: 5,
    passed: 1,
    failed: 4,
    inconclusive: 0,
    invalid: 0,
    missing: 0,
    status: 'complete',
    results: [
      result(),
      result({ case_id: 'timeout', checks: [], issue: 'timeout', verdict: 'inconclusive', task_verdict: 'inconclusive' }),
      result({
        case_id: 'trigger',
        checks: [],
        task_verdict: 'passed',
        trigger: { expected: true, used: false, evidence: 'gateway', skill_digest: 'x', verdict: 'failed' },
      }),
      result({
        case_id: 'safety',
        checks: [{ id: 'ok', passed: true, reason: 'ok', evidence: { kind: 'exit_code' } }],
        safety_checks: [{ id: 'safe', passed: false, reason: 'value_mismatch', evidence: { kind: 'json_equals' } }],
        task_verdict: 'passed',
        safety_verdict: 'failed',
      }),
      result({ case_id: 'pass', verdict: 'passed', task_verdict: 'passed', checks: [] }),
    ],
  };
  const attribution = attributeRun(report);
  assert.equal(attribution.failed, 4);
  assert.deepEqual(
    attribution.failures.map((item) => item.category),
    ['task_output_invalid', 'timeout', 'skill_not_triggered', 'safety_violation'],
  );
  assert.equal(attribution.failures[0]?.first_failed_check, 'check');
  assert.equal(attribution.clusters.length, 4);
  assert.equal(attribution.hotspots.slowest.length, 5);
});

test('attribution classifies every structured failure path and keeps null measurements null', () => {
  const check = (reason: RunReport['results'][number]['checks'][number]['reason']) =>
    result({
      case_id: reason,
      checks: [{ id: reason, passed: false, reason, evidence: { kind: 'test', reason } }],
    });
  const host = {
    adapter: 'codex' as const,
    requested_model: null,
    observed_models: [],
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    cost_usd: null,
    tool_calls: 0,
  };
  const report: RunReport = {
    run_id: 'all-failures',
    suite_id: 'suite',
    subject: {},
    partition: 'held_out',
    expected: 17,
    recorded: 17,
    passed: 0,
    failed: 17,
    inconclusive: 0,
    invalid: 0,
    missing: 0,
    status: 'complete',
    results: [
      check('tool_not_called'),
      check('tool_unexpectedly_called'),
      check('arguments_mismatch'),
      check('outside_workspace'),
      check('symlink_rejected'),
      check('invalid_json'),
      check('type_mismatch'),
      check('key_missing'),
      check('stdout_missing'),
      check('stdout_present'),
      check('exit_code_mismatch'),
      check('script_error'),
      check('script_failed'),
      check('tool_errored'),
      check('timer_expired'),
      check('not_found'),
      check('not_a_file'),
      check('oversized'),
      result({
        case_id: 'evidence',
        checks: [],
        issue: 'adapter_error:ENOENT',
        host,
        trigger: {
          expected: false,
          used: true,
          evidence: 'gateway',
          skill_digest: 'sha256:x',
          verdict: 'failed',
        },
        duration_ms: null,
        cost_units: null,
      }),
    ],
  };
  const attribution = attributeRun(report);
  assert.deepEqual(
    attribution.failures.slice(0, 20).map((item) => item.category),
    [
      'wrong_tool',
      'wrong_tool',
      'wrong_arguments',
      'permission_error',
      'permission_error',
      'task_output_invalid',
      'task_output_invalid',
      'task_output_invalid',
      'task_output_invalid',
      'task_output_invalid',
      'task_output_invalid',
      'fixture_error',
      'unknown',
      'host_error',
      'timeout',
      'task_output_invalid',
      'task_output_invalid',
      'task_output_invalid',
      'skill_mis_triggered',
    ],
  );
  assert.equal(attribution.failures[18]?.category, 'skill_mis_triggered');
  assert.deepEqual(attribution.failures[18]?.evidence.host, host);
  assert.equal(attribution.hotspots.slowest.length, 10);
  assert.equal(attribution.hotspots.most_expensive.length, 0);

  const fallback = attributeRun({
    ...report,
    expected: 4,
    results: [
      result({
        case_id: 'invalid',
        verdict: 'invalid',
        task_verdict: 'missing',
        checks: [],
      }),
      result({
        case_id: 'inconclusive-trigger',
        verdict: 'inconclusive',
        task_verdict: 'inconclusive',
        checks: [],
        trigger: {
          expected: true,
          used: null,
          evidence: 'unobserved',
          skill_digest: null,
          verdict: 'inconclusive',
        },
      }),
      result({
        case_id: 'trace-incomplete',
        verdict: 'inconclusive',
        task_verdict: 'inconclusive',
        checks: [],
        trace_complete: false,
      }),
      result({
        case_id: 'unknown',
        verdict: 'inconclusive',
        task_verdict: 'inconclusive',
        checks: [],
      }),
    ],
  });
  assert.deepEqual(
    fallback.failures.map((item) => item.category),
    ['infrastructure_error', 'host_error', 'host_error', 'unknown'],
  );
});

test('attribution classifies a failing safety check as safety_violation', () => {
  const report: RunReport = {
    run_id: 'safety',
    suite_id: 'suite',
    subject: {},
    partition: 'held_out',
    expected: 1,
    recorded: 1,
    passed: 0,
    failed: 1,
    inconclusive: 0,
    invalid: 0,
    missing: 0,
    status: 'complete',
    results: [
      {
        case_id: 'unsafe-case',
        trial: 1,
        task_run_id: 'task',
        verdict: 'failed',
        task_verdict: 'passed',
        safety_verdict: 'failed',
        trigger: null,
        issue: null,
        exit_code: 0,
        duration_ms: 5,
        cost_units: null,
        checks: [],
        safety_checks: [
          { id: 'no-secrets', passed: false, reason: 'key_missing', evidence: { kind: 'json_equals' } },
        ],
        stdout_sha256: null,
        stderr_sha256: null,
        trace_sha256: null,
        gateway_sha256: null,
        trace_complete: true,
        host: null,
      },
    ],
  };
  const attribution = attributeRun(report);
  assert.equal(attribution.failures.length, 1);
  assert.equal(attribution.failures[0]!.category, 'safety_violation');
  assert.equal(attribution.failures[0]!.stage, 'safety_check');
  assert.equal(attribution.failures[0]!.first_failed_check, 'no-secrets');
  assert.equal(attribution.failures[0]!.evidence.check_reason, 'key_missing');
});

test('attribution classifies an adapter_error with no failed check as a setup host_error', () => {
  const report: RunReport = {
    run_id: 'adapter-error',
    suite_id: 'suite',
    subject: {},
    partition: 'held_out',
    expected: 1,
    recorded: 1,
    passed: 0,
    failed: 1,
    inconclusive: 0,
    invalid: 0,
    missing: 0,
    status: 'complete',
    results: [
      {
        case_id: 'setup-failure',
        trial: 1,
        task_run_id: 'task',
        verdict: 'invalid',
        task_verdict: 'inconclusive',
        safety_verdict: null,
        trigger: null,
        issue: 'adapter_error:FileNotFoundError',
        exit_code: null,
        duration_ms: 3,
        cost_units: null,
        checks: [],
        safety_checks: [],
        stdout_sha256: null,
        stderr_sha256: null,
        trace_sha256: null,
        gateway_sha256: null,
        trace_complete: false,
        host: null,
      },
    ],
  };
  const attribution = attributeRun(report);
  assert.equal(attribution.failures[0]!.category, 'host_error');
  assert.equal(attribution.failures[0]!.stage, 'setup');
  assert.equal(attribution.failures[0]!.first_failed_check, null);
  assert.equal(attribution.failures[0]!.evidence.issue, 'adapter_error:FileNotFoundError');
});

test('experiment validates, resumes completed jobs, and records budget skips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-experiment-'));
  try {
    const suitePath = await writeJson(root, 'suite.json', baseSuite());
    await writeJson(root, 'subject.json', { kind: 'software', id: 's', version: 'v' });
    await writeJson(root, 'runtime.json', {
      environment_digest: 'a',
      budget_digest: 'b',
      host_digest: 'c',
      model_digest: 'd',
      tools_digest: 'e',
    });
    const fakeRun = async (): Promise<string> => {
      const runDir = await mkdtemp(join(root, 'run-'));
      await writeJson(runDir, 'plan.json', {
        execution_controls: { schema: 'craft-eval.execution-controls.v1', max_output_bytes: 8 * 1024 * 1024, parallelism: 1, workspace_mode: 'isolated', fail_fast: false, keep_traces: false },
        schema: 'craft-eval.eval.v1',
        run_id: `run-${runDir}`,
        suite: await loadSuite(suitePath),
        suite_digest: digest(await loadSuite(suitePath)),
        subject: { kind: 'software', id: 's', version: 'v', digest: 'd' },
        runtime: {
          environment_digest: 'a',
          budget_digest: 'b',
          host_digest: 'c',
          model_digest: 'd',
          tools_digest: 'e',
        },
        trials: 1,
        expected: 1,
      });
      await mkdir(join(runDir, 'results'), { recursive: true });
      await writeJson(runDir, join('results', 'case-one-1.json'), result({
        case_id: 'case-one',
        verdict: 'passed',
        task_verdict: 'passed',
        checks: [{ id: 'exit', passed: true, reason: 'ok', evidence: { kind: 'exit_code' } }],
      }));
      return runDir;
    };
    const manifest = await writeJson(root, 'experiment.json', {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'matrix',
      suites: ['suite.json'],
      subjects: ['subject.json'],
      runtimes: ['runtime.json'],
      trials: 2,
      seed: 7,
      budget: { max_jobs: 1 },
    });
    const loaded = await loadExperiment(manifest);
    assert.equal(loaded.trials, 2);
    assert.equal(experimentJobs(loaded).length, 2);
    const calls: string[] = [];
    const first = await runExperiment(manifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async (suite) => {
        calls.push(suite);
        return fakeRun();
      },
    });
    assert.equal(first.completed, 1);
    assert.equal(first.skipped, 1);
    assert.equal(first.status, 'budget_exhausted');
    const second = await runExperiment(manifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async (suite) => {
        calls.push(suite);
        return fakeRun();
      },
    });
    assert.equal(second.completed, 1);
    assert.equal(second.skipped, 1);
    assert.equal(calls.length, 1);
    const changedManifest = await writeJson(root, 'changed.json', {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'matrix',
      suites: ['suite.json'],
      subjects: ['subject.json'],
      runtimes: ['runtime.json'],
      trials: 1,
      seed: 7,
      budget: { max_jobs: 1 },
    });
    await assert.rejects(
      runExperiment(changedManifest, { workspace: root, output: join(root, 'out') }),
      /manifest changed/,
    );
    const reportPath = join(root, 'out', 'matrix', 'experiment.json');
    const legacy = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    delete legacy.manifest_digest;
    await writeFile(reportPath, JSON.stringify(legacy), 'utf8');
    const legacyResume = await runExperiment(manifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async () => {
        calls.push('unexpected');
        return fakeRun();
      },
    });
    assert.equal(legacyResume.completed, 1);
    assert.equal(calls.length, 1);
    await assert.rejects(
      loadExperiment(await writeJson(root, 'bad.json', {
        schema: 'craft-eval.experiment.v1',
        experiment_id: 'bad',
        suites: ['s'],
        subjects: ['x'],
        runtimes: ['r'],
        trials: 1,
        seed: 1,
        unknown: true,
      })),
      /unsupported/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment rejects malformed manifests at each boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-experiment-invalid-'));
  try {
    const valid = {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'valid',
      suites: ['suite.json'],
      subjects: ['subject.json'],
      runtimes: ['runtime.json'],
      trials: 1,
      seed: 1,
    };
    const cases: Array<[string, unknown]> = [
      ['null.json', null],
      ['array.json', []],
      ['schema.json', { ...valid, schema: 'wrong' }],
      ['id.json', { ...valid, experiment_id: '../bad' }],
      ['suites-empty.json', { ...valid, suites: [] }],
      ['suites-entry.json', { ...valid, suites: [''] }],
      ['trials.json', { ...valid, trials: 0 }],
      ['seed.json', { ...valid, seed: -1 }],
      ['parallelism.json', { ...valid, parallelism: 0 }],
      ['budget-null.json', { ...valid, budget: null }],
      ['budget-field.json', { ...valid, budget: { unknown: true } }],
      ['budget-jobs.json', { ...valid, budget: { max_jobs: 0 } }],
      ['budget-cost.json', { ...valid, budget: { max_cost_units: -1 } }],
      ['retry-null.json', { ...valid, retry: null }],
      ['retry-field.json', { ...valid, retry: { max_attempts: 1, unknown: true } }],
      ['retry-attempts.json', { ...valid, retry: { max_attempts: 0 } }],
      ['retry-empty.json', { ...valid, retry: { max_attempts: 1, only_verdicts: [] } }],
      ['retry-verdict.json', { ...valid, retry: { max_attempts: 1, only_verdicts: ['wrong'] } }],
    ];
    for (const [name, value] of cases) {
      await assert.rejects(loadExperiment(await writeJson(root, name, value)));
    }
    const loaded = await loadExperiment(await writeJson(root, 'valid.json', {
      ...valid,
      parallelism: 2,
      budget: { max_jobs: 2, max_cost_units: 0 },
      retry: { max_attempts: 2, only_verdicts: ['failed'] },
    }));
    assert.equal(loaded.parallelism, 2);
    assert.equal(loaded.budget?.max_cost_units, 0);
    assert.deepEqual(loaded.retry?.only_verdicts, ['failed']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment records failed attempts and stops when retry probing cannot read a run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-experiment-failure-'));
  try {
    const suitePath = await writeJson(root, 'suite.json', baseSuite());
    await writeJson(root, 'subject.json', { kind: 'software', id: 's', version: 'v' });
    await writeJson(root, 'runtime.json', {
      environment_digest: 'a',
      budget_digest: 'b',
      host_digest: 'c',
      model_digest: 'd',
      tools_digest: 'e',
    });
    const manifest = await writeJson(root, 'experiment.json', {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'failure',
      suites: ['suite.json'],
      subjects: ['subject.json'],
      runtimes: ['runtime.json'],
      trials: 1,
      seed: 1,
      retry: { max_attempts: 2, only_verdicts: ['failed'] },
    });
    let calls = 0;
    const failed = await runExperiment(manifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async () => {
        calls += 1;
        throw new Error('runner exploded');
      },
    });
    assert.equal(calls, 2);
    assert.equal(failed.failed, 2);
    assert.equal(failed.status, 'partial');
    assert.deepEqual(failed.jobs.map((item) => item.error), ['runner exploded', 'runner exploded']);

    const probeManifest = await writeJson(root, 'probe.json', {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'probe',
      suites: ['suite.json'],
      subjects: ['subject.json'],
      runtimes: ['runtime.json'],
      trials: 1,
      seed: 1,
      retry: { max_attempts: 2, only_verdicts: ['failed'] },
    });
    const first = await runExperiment(probeManifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async () => {
        const runDir = await mkdtemp(join(root, 'probe-run-'));
        await writeJson(runDir, 'plan.json', {
          execution_controls: { schema: 'craft-eval.execution-controls.v1', max_output_bytes: 8 * 1024 * 1024, parallelism: 1, workspace_mode: 'isolated', fail_fast: false, keep_traces: false },
          schema: 'craft-eval.eval.v1',
          run_id: `run-${runDir}`,
          suite: await loadSuite(suitePath),
          suite_digest: digest(await loadSuite(suitePath)),
          subject: { kind: 'software', id: 's', version: 'v', digest: 'd' },
          runtime: {
            environment_digest: 'a',
            budget_digest: 'b',
            host_digest: 'c',
            model_digest: 'd',
            tools_digest: 'e',
          },
          trials: 1,
          expected: 1,
        });
        await mkdir(join(runDir, 'results'), { recursive: true });
        await writeJson(runDir, join('results', 'case-one-1.json'), result({
          case_id: 'case-one',
          verdict: 'passed',
          task_verdict: 'passed',
          checks: [{ id: 'exit', passed: true, reason: 'ok', evidence: { kind: 'exit_code' } }],
        }));
        return runDir;
      },
    });
    assert.equal(first.completed, 1);
    const reportPath = join(root, 'out', 'probe', 'experiment.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      jobs: Array<{ run_dir: string | null }>;
    };
    report.jobs[0]!.run_dir = join(root, 'missing-run');
    await writeFile(reportPath, JSON.stringify(report), 'utf8');
    const probed = await runExperiment(probeManifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async () => {
        throw new Error('should not execute');
      },
    });
    assert.equal(probed.jobs.length, 1);
    assert.match(probed.jobs[0]?.error ?? '', /^retry_probe_failed:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment retries append attempts without overwriting the original failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-retry-'));
  try {
    const manifest = await writeJson(root, 'retry.json', {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'retry',
      suites: ['suite.json'],
      subjects: ['subject.json'],
      runtimes: ['runtime.json'],
      trials: 1,
      seed: 1,
      retry: { max_attempts: 2, only_verdicts: ['failed'] },
    });
    let attempts = 0;
    const suitePath = await writeJson(root, 'suite.json', baseSuite());
    await writeJson(root, 'subject.json', {
      kind: 'software',
      id: 's',
      version: 'v',
    });
    await writeJson(root, 'runtime.json', {
      environment_digest: 'a',
      budget_digest: 'b',
      host_digest: 'c',
      model_digest: 'd',
      tools_digest: 'e',
    });
    const fakeRun = async (
      suitePathArg: string,
      subject: string,
      runtime: string,
      workspace: string,
      output: string,
      options: unknown,
    ): Promise<string> => {
      attempts += 1;
      assert.equal(suitePathArg, suitePath);
      assert.equal(subject, join(root, 'subject.json'));
      assert.equal(runtime, join(root, 'runtime.json'));
      assert.equal(workspace, root);
      assert.equal(output, join(root, 'out', 'retry', 'runs'));
      assert.deepEqual(options, { trials: 1, parallelism: 1 });
      const runDir = join(root, `fake-run-${attempts}`);
      await mkdir(runDir, { recursive: true });
      const suite = await loadSuite(suitePath);
      await writeJson(runDir, 'plan.json', {
        execution_controls: { schema: 'craft-eval.execution-controls.v1', max_output_bytes: 8 * 1024 * 1024, parallelism: 1, workspace_mode: 'isolated', fail_fast: false, keep_traces: false },
        schema: 'craft-eval.eval.v1',
        run_id: `run-${attempts}`,
        suite,
        suite_digest: digest(suite),
        subject: { kind: 'software', id: 's', version: 'v', digest: 'd' },
        runtime: { environment_digest: 'a', budget_digest: 'b', host_digest: 'c', model_digest: 'd', tools_digest: 'e' },
        trials: 1,
        expected: 1,
      });
      await mkdir(join(runDir, 'results'), { recursive: true });
      await writeJson(runDir, join('results', 'case-one-1.json'), result({
        case_id: 'case-one',
        verdict: attempts === 1 ? 'failed' : 'passed',
        task_verdict: attempts === 1 ? 'failed' : 'passed',
      }));
      return runDir;
    };
    const report = await runExperiment(manifest, {
      workspace: root,
      output: join(root, 'out'),
      run: fakeRun,
    });
    assert.equal((await loadExperiment(manifest)).suites.length, 1);
    assert.equal((await loadSuite(suitePath)).subject_kind, 'software');
    assert.equal(attempts, 2);
    assert.equal(report.jobs.length, 2);
    assert.deepEqual(report.jobs.map((item) => item.attempt), [1, 2]);
    assert.equal(report.jobs[0]?.status, 'completed');
    assert.equal(report.jobs[1]?.status, 'completed');
    const resumed = await runExperiment(manifest, {
      workspace: root,
      output: join(root, 'out'),
      run: fakeRun,
    });
    assert.equal(attempts, 2);
    assert.equal(resumed.jobs.length, 2);
    assert.deepEqual(resumed.jobs.map((item) => item.attempt), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment enforces cost budgets and treats unknown cost as unobserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-cost-'));
  try {
    const suitePath = await writeJson(root, 'suite.json', baseSuite());
    await writeJson(root, 'subject.json', { kind: 'software', id: 's', version: 'v' });
    await writeJson(root, 'runtime.json', {
      environment_digest: 'a',
      budget_digest: 'b',
      host_digest: 'c',
      model_digest: 'd',
      tools_digest: 'e',
    });
    const writeFakeRun = async (cost: number | null): Promise<string> => {
      const runDir = await mkdtemp(join(root, 'run-'));
      const suite = await loadSuite(suitePath);
      await writeJson(runDir, 'plan.json', {
        execution_controls: { schema: 'craft-eval.execution-controls.v1', max_output_bytes: 8 * 1024 * 1024, parallelism: 1, workspace_mode: 'isolated', fail_fast: false, keep_traces: false },
        schema: 'craft-eval.eval.v1',
        run_id: `run-${runDir}`,
        suite,
        suite_digest: digest(suite),
        subject: { kind: 'software', id: 's', version: 'v', digest: 'd' },
        runtime: {
          environment_digest: 'a',
          budget_digest: 'b',
          host_digest: 'c',
          model_digest: 'd',
          tools_digest: 'e',
        },
        trials: 1,
        expected: 1,
      });
      await mkdir(join(runDir, 'results'), { recursive: true });
      await writeJson(runDir, join('results', 'case-one-1.json'), result({
        case_id: 'case-one',
        verdict: 'passed',
        task_verdict: 'passed',
        cost_units: cost,
        checks: [{ id: 'exit', passed: true, reason: 'ok', evidence: { kind: 'exit_code' } }],
      }));
      return runDir;
    };
    const costManifest = await writeJson(root, 'cost.json', {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'cost',
      suites: ['suite.json'],
      subjects: ['subject.json'],
      runtimes: ['runtime.json'],
      trials: 3,
      seed: 1,
      budget: { max_cost_units: 1.5 },
    });
    let calls = 0;
    const costReport = await runExperiment(costManifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async () => {
        calls += 1;
        return writeFakeRun(1);
      },
    });
    assert.equal(calls, 2);
    assert.equal(costReport.completed, 2);
    assert.equal(costReport.skipped, 1);
    assert.equal(costReport.cost_units, 2);
    assert.equal(costReport.cost_observed, true);
    assert.equal(costReport.budget_reason, 'max_cost_units');
    assert.equal(costReport.status, 'budget_exhausted');
    const costResumed = await runExperiment(costManifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async () => {
        calls += 1;
        return writeFakeRun(1);
      },
    });
    assert.equal(calls, 2);
    assert.equal(costResumed.skipped, 1);
    assert.equal(costResumed.budget_reason, 'max_cost_units');

    const unknownManifest = await writeJson(root, 'unknown.json', {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'unknown',
      suites: ['suite.json'],
      subjects: ['subject.json'],
      runtimes: ['runtime.json'],
      trials: 2,
      seed: 1,
      budget: { max_cost_units: 1 },
    });
    let unknownCalls = 0;
    const unknownReport = await runExperiment(unknownManifest, {
      workspace: root,
      output: join(root, 'out'),
      run: async () => {
        unknownCalls += 1;
        return writeFakeRun(null);
      },
    });
    assert.equal(unknownCalls, 1);
    assert.equal(unknownReport.completed, 1);
    assert.equal(unknownReport.skipped, 1);
    assert.equal(unknownReport.cost_units, null);
    assert.equal(unknownReport.cost_observed, false);
    assert.equal(unknownReport.budget_reason, 'cost_unobserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linear scenarios preserve step checks and support checkpoint resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-scenario-'));
  try {
    const path = await writeJson(root, 'scenario.json', {
      schema: 'craft-eval.scenario.v1',
      scenario_id: 'long-task',
      steps: [
        { id: 'one', prompt: 'First', checks: [{ id: 'a', kind: 'exit_code', equals: 0 }] },
        { id: 'two', prompt: 'Second', checks: [{ id: 'b', kind: 'exit_code', equals: 0 }] },
        { id: 'three', argv: ['node', 'finish.mjs'] },
      ],
      checkpoints: [
        { id: 'after-one', after_step: 'one', checks: [{ id: 'c', kind: 'exit_code', equals: 0 }] },
      ],
      final_checks: [{ id: 'final', kind: 'exit_code', equals: 0 }],
    });
    const scenario = await loadScenario(path);
    const all = scenarioCases(scenario);
    assert.equal(all.length, 3);
    assert.equal(all[0]?.checks?.length, 2);
    assert.equal(all[2]?.checks?.length, 1);
    const resumed = scenarioCases(scenario, { resumeAfter: 'one' });
    assert.deepEqual(resumed.map((item) => item.id), ['long-task.two', 'long-task.three']);
    const stepResult = result({
      case_id: 'long-task.two',
      verdict: 'passed',
      task_verdict: 'passed',
      checks: [],
    });
    const stepReport = scenarioReport(scenario, 'run-1', [stepResult]);
    assert.equal(stepReport.status, 'passed');
    assert.equal(stepReport.completed_step, 'two');
    assert.equal(stepReport.attempts[0]?.step_id, 'two');
    await assert.rejects(
      loadScenario(await writeJson(root, 'bad.json', {
        schema: 'craft-eval.scenario.v1',
        scenario_id: 'bad',
        steps: [{ id: 'one', prompt: 'x' }],
        final_checks: [],
      })),
      /final_checks/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario validation rejects ambiguous steps, checkpoints and recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-scenario-invalid-'));
  try {
    const valid = {
      schema: 'craft-eval.scenario.v1',
      scenario_id: 'valid',
      steps: [{ id: 'one', argv: ['node', 'x.mjs'] }],
      final_checks: [{ id: 'final', kind: 'exit_code', equals: 0 }],
    };
    const invalid: Array<[string, unknown]> = [
      ['null.json', null],
      ['array.json', []],
      ['schema.json', { ...valid, schema: 'wrong' }],
      ['unknown.json', { ...valid, unknown: true }],
      ['scenario-id.json', { ...valid, scenario_id: '../bad' }],
      ['steps-empty.json', { ...valid, steps: [] }],
      ['step-null.json', { ...valid, steps: [null] }],
      ['step-id.json', { ...valid, steps: [{ id: '../bad', argv: ['node'] }] }],
      ['step-unknown.json', { ...valid, steps: [{ id: 'one', prompt: 'x', unknown: true }] }],
      ['step-both.json', { ...valid, steps: [{ id: 'one', prompt: 'x', argv: ['node'] }] }],
      ['step-neither.json', { ...valid, steps: [{ id: 'one' }] }],
      ['step-prompt.json', { ...valid, steps: [{ id: 'one', prompt: ' ' }] }],
      ['step-argv-empty.json', { ...valid, steps: [{ id: 'one', argv: [] }] }],
      ['step-argv-value.json', { ...valid, steps: [{ id: 'one', argv: [''] }] }],
      ['step-timeout.json', { ...valid, steps: [{ id: 'one', argv: ['node'], timeout_s: 0 }] }],
      [
        'step-duplicate.json',
        { ...valid, steps: [{ id: 'one', argv: ['node'] }, { id: 'one', argv: ['node'] }] },
      ],
      ['final-missing.json', { ...valid, final_checks: undefined }],
      ['final-shape.json', { ...valid, final_checks: 'bad' }],
      ['final-entry.json', { ...valid, final_checks: [null] }],
      ['checkpoints-shape.json', { ...valid, checkpoints: 'bad' }],
      ['checkpoint-null.json', { ...valid, checkpoints: [null] }],
      ['checkpoint-unknown.json', { ...valid, checkpoints: [{ id: 'c', after_step: 'one', unknown: true }] }],
      ['checkpoint-step.json', { ...valid, checkpoints: [{ id: 'c', after_step: 'missing' }] }],
      [
        'checkpoint-duplicate.json',
        {
          ...valid,
          checkpoints: [
            { id: 'c', after_step: 'one' },
            { id: 'c', after_step: 'one' },
          ],
        },
      ],
      ['recovery-null.json', { ...valid, recovery: null }],
      ['recovery-unknown.json', { ...valid, recovery: { on_interruption: 'resume', unknown: true } }],
      ['recovery-value.json', { ...valid, recovery: { on_interruption: 'retry' } }],
    ];
    for (const [name, value] of invalid) {
      await assert.rejects(loadScenario(await writeJson(root, name, value)));
    }

    const scenario = await loadScenario(await writeJson(root, 'valid.json', {
      ...valid,
      steps: [
        { id: 'one', prompt: 'first' },
        { id: 'two', prompt: 'second' },
      ],
    }));
    assert.throws(() => scenarioCases(scenario, { resumeAfter: 'missing' }), /resumeAfter/);
    assert.throws(() => scenarioCases(scenario, { resumeAfter: 'two' }), /no steps/);
    assert.throws(() => scenarioCases(scenario, { trials: 0 }), /trials/);

    const empty = scenarioReport(scenario, 'empty', [], ['one', 'two']);
    assert.equal(empty.status, 'partial');
    assert.equal(empty.completed_step, null);
    assert.deepEqual(empty.attempts.map((item) => item.status), ['skipped', 'skipped']);

    const interrupted = scenarioReport(
      scenario,
      'interrupted',
      [
        result({ case_id: 'valid.one', verdict: 'passed', task_verdict: 'passed', checks: [] }),
        result({
          case_id: 'valid.two',
          verdict: 'inconclusive',
          task_verdict: 'inconclusive',
          checks: [],
        }),
      ],
      ['one', 'two'],
    );
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.failed_step, 'two');
    assert.equal(interrupted.attempts[1]?.status, 'interrupted');

    const safetyFailure = scenarioReport(
      scenario,
      'safety',
      [
        result({
          case_id: 'valid.one',
          verdict: 'failed',
          task_verdict: 'passed',
          checks: [],
          safety_checks: [{ id: 'safe', passed: false, reason: 'value_mismatch', evidence: { kind: 'json' } }],
          safety_verdict: 'failed',
        }),
      ],
      ['one', 'two'],
    );
    assert.equal(safetyFailure.failed_check, 'safe');
    assert.equal(safetyFailure.attempts[1]?.status, 'skipped');
    assert.equal(
      scenarioReport(
        scenario,
        'missing',
        [result({ case_id: 'valid.one', verdict: 'missing', task_verdict: 'missing', checks: [] })],
        ['one', 'two'],
      ).status,
      'partial',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario executes argv and host prompt steps in one shared workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-scenario-mixed-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, 'local.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync('local.txt', 'ready');\n`,
      'utf8',
    );
    await writeFile(
      join(workspace, 'host.mjs'),
      `import { readFileSync, writeFileSync } from 'node:fs';
import { stdin } from 'node:process';
let prompt = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => { prompt += chunk; });
stdin.on('end', () => {
  if (readFileSync('local.txt', 'utf8') !== 'ready') process.exit(9);
  writeFileSync('host.txt', prompt);
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');
});
`,
      'utf8',
    );
    const scenarioPath = await writeJson(root, 'scenario.json', {
      schema: 'craft-eval.scenario.v1',
      scenario_id: 'mixed',
      steps: [
        { id: 'local', argv: ['node', 'local.mjs'] },
        { id: 'host', prompt: 'continue' },
      ],
      final_checks: [{ id: 'host-output', kind: 'file_exists', path: 'host.txt' }],
      recovery: { on_interruption: 'resume' },
    });
    const subjectPath = await writeJson(root, 'subject.json', {
      kind: 'agent',
      id: 'mixed',
      version: 'v1',
      host: { kind: 'codex', binary: process.execPath, args_prefix: ['host.mjs'] },
    });
    const runtimePath = await writeJson(root, 'runtime.json', {
      environment_digest: 'a',
      budget_digest: 'b',
      host_digest: 'c',
      model_digest: 'd',
      tools_digest: 'e',
    });
    const scenario = await loadScenario(scenarioPath);
    const executed = await runScenario(scenario, {
      subject: subjectPath,
      runtime: runtimePath,
      workspace,
      output: join(root, 'out'),
    });
    assert.equal(executed.report.status, 'passed');
    assert.deepEqual(executed.report.attempts.map((item) => item.step_id), ['local', 'host']);
    assert.equal(executed.report.results[0]?.checks[0]?.reason, 'ok');

    await assert.rejects(
      runScenario(scenario, {
        subject: subjectPath,
        runtime: runtimePath,
        workspace,
        output: join(root, 'missing-checkpoint'),
        resumeAfter: 'local',
      }),
      /no checkpoint workspace/,
    );
    await assert.rejects(
      runScenario(
        {
          ...scenario,
          recovery: { on_interruption: 'fail' },
        },
        {
          subject: subjectPath,
          runtime: runtimePath,
          workspace,
          output: join(root, 'wrong-recovery'),
          resumeAfter: 'local',
        },
      ),
      /requires scenario.recovery/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario execution shares workspace, stops on failure, and resumes from checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-scenario-run-'));
  try {
    const workspace = join(root, 'workspace');
    const output = join(root, 'out');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'host.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
if (prompt.includes('always-fail')) process.exit(5);
if (prompt.includes('step-one')) {
  writeFileSync('state.txt', 'one');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');
}
if (prompt.includes('step-two')) {
  if (readFileSync('state.txt', 'utf8') !== 'one') process.exit(9);
  writeFileSync('state.txt', 'two');
}
if (prompt.includes('step-three')) {
  if (readFileSync('state.txt', 'utf8') !== 'two') process.exit(9);
  writeFileSync('final.txt', 'done');
}
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');
});
`, 'utf8');
    const scenarioPath = await writeJson(root, 'scenario.json', {
      schema: 'craft-eval.scenario.v1',
      scenario_id: 'shared',
      steps: [
        { id: 'one', prompt: 'step-one' },
        { id: 'two', prompt: 'step-two' },
        { id: 'three', prompt: 'step-three' },
      ],
      final_checks: [{ id: 'final', kind: 'file_exists', path: 'final.txt' }],
      recovery: { on_interruption: 'resume' },
    });
    const subjectPath = await writeJson(root, 'subject.json', {
      kind: 'agent',
      id: 'fake',
      version: 'v1',
      host: { kind: 'codex', binary: process.execPath, args_prefix: ['host.mjs'] },
    });
    const runtimePath = await writeJson(root, 'runtime.json', {
      environment_digest: 'a',
      budget_digest: 'b',
      host_digest: 'c',
      model_digest: 'd',
      tools_digest: 'e',
    });
    const scenario = await loadScenario(scenarioPath);
    const result = await runScenario(scenario, {
      subject: subjectPath,
      runtime: runtimePath,
      workspace,
      output,
      run: async (suite, subject, runtime, ws, out, options) => {
        assert.equal(typeof options, 'object');
        if (options === undefined || typeof options === 'number') {
          throw new Error('scenario runner requires object options');
        }
        assert.equal(options.workspace_mode, 'shared');
        assert.equal(options.fail_fast, true);
        return runSuite(suite, subject, runtime, ws, out, options);
      },
    });
    if (result.report.status !== 'passed') {
      assert.fail(JSON.stringify(result.report));
    }
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.completed_step, 'three');
    assert.ok((await reportRun(result.run_dir)).results.every((item) => item.verdict === 'passed'));

    const failScenarioPath = await writeJson(root, 'fail-scenario.json', {
      schema: 'craft-eval.scenario.v1',
      scenario_id: 'failure',
      steps: [
        { id: 'one', prompt: 'step-one' },
        { id: 'two', prompt: 'always-fail' },
        { id: 'three', prompt: 'step-three' },
      ],
      final_checks: [{ id: 'final', kind: 'file_exists', path: 'final.txt' }],
      recovery: { on_interruption: 'resume' },
    });
    const failScenario = await loadScenario(failScenarioPath);
    const failed = await runScenario(failScenario, {
      subject: subjectPath,
      runtime: runtimePath,
      workspace,
      output: join(root, 'failed-out'),
    });
    assert.equal(failed.report.status, 'failed');
    assert.equal(failed.report.failed_step, 'two');
    assert.equal(failed.report.results.filter((item) => item.verdict !== 'missing').length, 2);
    assert.equal(failed.report.results.filter((item) => item.verdict === 'missing').length, 1);
    assert.equal(failed.report.attempts.find((item) => item.step_id === 'three')?.status, 'skipped');

    const resumed = await runScenario(failScenario, {
      subject: subjectPath,
      runtime: runtimePath,
      workspace,
      output: join(root, 'failed-out'),
      resumeAfter: 'one',
    });
    assert.equal(resumed.report.status, 'failed');
    assert.deepEqual(resumed.report.attempts.map((item) => item.step_id), ['two', 'three']);
    const checkpoint = JSON.parse(await readFile(join(root, 'failed-out', 'scenario-report.json'), 'utf8'));
    assert.equal(checkpoint.schema, 'craft-eval.scenario.v1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('new CLI commands return machine-readable results and audit gates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-cli-'));
  try {
    const suitePath = await writeJson(root, 'suite.json', baseSuite({
      cases: [
        {
          id: 'case',
          argv: ['node', 'host.mjs'],
          checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
          provenance: { source: 'fixture', independent_of_training: true, reviewed_by: 'r' },
          expected_behavior: 'exit',
        },
      ],
      claim: { statement: 'test', scope: 'local' },
      metrics: { primary: { id: 'pass', kind: 'binary_pass_rate', direction: 'higher_is_better' } },
    }));
    assert.equal(await main(['audit', suitePath]), 0);
    assert.equal(await main(['validate', suitePath]), 0);

    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'host.mjs'), '', 'utf8');
    await writeFile(join(workspace, 'scenario-host.mjs'), `
import { writeFileSync } from 'node:fs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  writeFileSync('done.txt', prompt);
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');
});
`, 'utf8');
    const scenarioPath = await writeJson(root, 'scenario.json', {
      schema: 'craft-eval.scenario.v1',
      scenario_id: 'cli-scenario',
      steps: [{ id: 'one', prompt: 'finish' }],
      final_checks: [{ id: 'done', kind: 'file_exists', path: 'done.txt' }],
    });
    const agentSubject = await writeJson(root, 'agent-subject.json', {
      kind: 'agent',
      id: 'agent',
      version: 'v1',
      host: { kind: 'codex', binary: process.execPath, args_prefix: ['scenario-host.mjs'] },
    });
    const runtimePath = await writeJson(root, 'runtime.json', {
      environment_digest: 'a',
      budget_digest: 'b',
      host_digest: 'c',
      model_digest: 'd',
      tools_digest: 'e',
    });
    assert.equal(
      await main([
        'scenario',
        scenarioPath,
        agentSubject,
        runtimePath,
        '--workspace',
        workspace,
        '--output',
        join(root, 'scenario-out'),
      ]),
      0,
    );
    const scenarioReport = JSON.parse(
      await readFile(join(root, 'scenario-out', 'scenario-report.json'), 'utf8'),
    ) as { status: string };
    assert.equal(scenarioReport.status, 'passed');

    const experimentSuite = await writeJson(root, 'experiment-suite.json', baseSuite());
    const experimentSubject = await writeJson(root, 'experiment-subject.json', {
      kind: 'software',
      id: 'software',
      version: 'v1',
    });
    const experimentManifest = await writeJson(root, 'experiment.json', {
      schema: 'craft-eval.experiment.v1',
      experiment_id: 'cli-experiment',
      suites: [experimentSuite],
      subjects: [experimentSubject],
      runtimes: [runtimePath],
      trials: 1,
      seed: 1,
    });
    assert.equal(
      await main([
        'experiment',
        experimentManifest,
        '--workspace',
        workspace,
        '--output',
        join(root, 'experiment-out'),
      ]),
      0,
    );
    const experimentReport = JSON.parse(
      await readFile(join(root, 'experiment-out', 'cli-experiment', 'experiment.json'), 'utf8'),
    ) as { completed: number; status: string };
    assert.equal(experimentReport.completed, 1);
    assert.equal(experimentReport.status, 'complete');
    assert.equal(await main(['unknown']), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
