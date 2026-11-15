import assert from 'node:assert/strict';
import test from 'node:test';

import { attributeRun } from '../src/attribution.js';
import { summarizeJudges, type CaseResult, type CheckResult } from '../src/evaluation.js';

function judged(id: string, judge: string, passed: boolean | null): CheckResult {
  return { id, judge, passed, reason: passed === true ? 'ok' : passed === false ? 'value_mismatch' : 'judge_error', evidence: { kind: 'model_graded' } };
}

function result(caseId: string, trial: number, checks: CheckResult[]): CaseResult {
  return {
    case_id: caseId,
    trial,
    task_run_id: `${caseId}-${trial}`,
    verdict: 'passed',
    task_verdict: 'passed',
    safety_verdict: null,
    trigger: null,
    issue: null,
    exit_code: 0,
    duration_ms: 10,
    cost_units: null,
    checks,
    safety_checks: [],
    stdout_sha256: null,
    stderr_sha256: null,
    trace_sha256: null,
    gateway_sha256: null,
    trace_complete: true,
    host: null,
  };
}

test('agreeing judges produce tallies but no disagreement', () => {
  const summary = summarizeJudges([
    result('a', 1, [judged('alpha', 'alpha', true), judged('beta', 'beta', true)]),
  ]);
  assert.equal(summary.by_judge.alpha?.passed, 1);
  assert.equal(summary.by_judge.beta?.passed, 1);
  assert.deepEqual(summary.judge_disagreements, []);
});

test('split judges record both sides of the disagreement', () => {
  const summary = summarizeJudges([
    result('a', 1, [judged('alpha', 'alpha', true), judged('beta', 'beta', false)]),
  ]);
  assert.deepEqual(summary.judge_disagreements, [{
    case_id: 'a',
    trial: 1,
    passing_judges: ['alpha'],
    failing_judges: ['beta'],
  }]);
  assert.deepEqual(summary.by_judge.beta?.cases, ['a']);
});

test('a judge that never decided is counted as inconclusive, not as disagreement', () => {
  const summary = summarizeJudges([
    result('a', 1, [judged('alpha', 'alpha', true), judged('beta', 'beta', null)]),
  ]);
  assert.equal(summary.by_judge.beta?.inconclusive, 1);
  assert.equal(summary.by_judge.beta?.failed, 0);
  assert.deepEqual(summary.judge_disagreements, []);
});

test('cases without judges contribute nothing', () => {
  const summary = summarizeJudges([result('a', 1, [{ id: 'exit', passed: true, reason: 'ok', evidence: { kind: 'exit_code' } }])]);
  assert.deepEqual(summary.by_judge, {});
  assert.deepEqual(summary.judge_disagreements, []);
});

test('attribution surfaces judge disagreement as its own category', () => {
  const report = {
    run_id: 'r',
    suite_id: 's',
    subject: {},
    partition: 'development',
    expected: 1,
    recorded: 1,
    passed: 0,
    failed: 1,
    inconclusive: 0,
    invalid: 0,
    missing: 0,
    status: 'complete' as const,
    results: [result('a', 1, [judged('alpha', 'alpha', true), judged('beta', 'beta', false)])],
    judge_disagreements: [{ case_id: 'a', trial: 1, passing_judges: ['alpha'], failing_judges: ['beta'] }],
  };
  const attribution = attributeRun(report);
  const cluster = attribution.clusters.find((item) => item.category === 'judge_disagreement');
  assert.equal(cluster?.count, 1);
  assert.deepEqual(cluster?.cases, ['a#1']);
});

test('a report without judge data still renders', () => {
  const report = {
    run_id: 'r', suite_id: 's', subject: {}, partition: 'development',
    expected: 1, recorded: 1, passed: 1, failed: 0, inconclusive: 0, invalid: 0, missing: 0,
    status: 'complete' as const,
    results: [result('a', 1, [])],
  };
  const attribution = attributeRun(report);
  assert.equal(attribution.clusters.length, 0);
});
