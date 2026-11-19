import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { compareRunReports } from '../src/compare-run-reports.js';
import { compareRuns, reportRun, runSuite } from '../src/evaluation.js';
import { main } from '../src/cli.js';
import { binaryEffect, pairedContinuousEffect, signProbability, summarizeContinuous } from '../src/statistics.js';
import { diffSuites, suiteLineage } from '../src/suite-diff.js';
import type { Suite } from '../src/evaluation.js';
import type { RunReport as LedgerRunReport } from '../src/compare-run-reports.js';

const RUNTIME = Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map((key) => [key, 'cli-stats']));

async function fixture(): Promise<{
  root: string; workspace: string; suite: string; subject: string; runtime: string; output: string; cli: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'craft-cli-stats-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'pass.mjs'), 'process.exit(0);\n', 'utf8');
  await writeFile(join(workspace, 'fail.mjs'), 'process.exit(1);\n', 'utf8');
  const suite = join(root, 'suite.json');
  await writeFile(suite, JSON.stringify({
    schema: 'craft-eval.eval.v1', suite_id: 'cli-stats', subject_kind: 'software',
    partition: 'development', sanitized: true,
    cases: [
      { id: 'pass', argv: [process.execPath, 'pass.mjs'], timeout_s: 10, checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] },
      { id: 'fail', argv: [process.execPath, 'fail.mjs'], timeout_s: 10, checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] },
    ],
  }), 'utf8');
  const subject = join(root, 'subject.json');
  await writeFile(subject, JSON.stringify({ kind: 'software', id: 'cli-stats', version: '1' }), 'utf8');
  const runtime = join(root, 'runtime.json');
  await writeFile(runtime, JSON.stringify(RUNTIME), 'utf8');
  return {
    root, workspace, suite, subject, runtime, output: join(root, 'runs'),
    cli: fileURLToPath(new URL('../src/cli.js', import.meta.url)),
  };
}

function ledgerReport(overrides: Partial<LedgerRunReport> = {}, results?: LedgerRunReport['results']): LedgerRunReport {
  return {
    schema: 'craft-eval-run-report.v1',
    provider: 'test', base_url: 'http://gateway', model: 'm', suite_digest: 'suite-1',
    isolation: 'isolated', ledgers: [
      { ledger: 'capability', score: '2/2', observed: 2, passed: 2 },
      { ledger: 'safety', score: null, observed: 0, passed: 0 },
      { ledger: 'value', score: '1/1', observed: 1, passed: 1 },
    ],
    results: results ?? [
      { case_id: 'one', verdict: 'passed', judges: { alpha: 'passed' } },
      { case_id: 'two', verdict: 'failed', judges: { alpha: 'failed' } },
      { case_id: 'three', verdict: 'inconclusive' },
    ],
    ...overrides,
  } as LedgerRunReport;
}

test('pure statistics summarise ties, effects and reproducible intervals', () => {
  const binary = binaryEffect([
    { baseline: false, candidate: true },
    { baseline: true, candidate: false },
    { baseline: true, candidate: true },
    { baseline: false, candidate: false },
  ]);
  assert.equal(binary.pairs, 4);
  assert.equal(binary.candidate_wins, 1);
  assert.equal(binary.baseline_wins, 1);
  assert.equal(binary.ties, 2);
  assert.equal(binary.risk_difference, 0);
  assert.ok(binary.risk_difference_ci95);
  assert.equal(binary.phi, 0);
  assert.equal(binary.sign_test_p, 0.75);
  assert.equal(binaryEffect([]).risk_difference, null);
  const allWins = binaryEffect([{ baseline: false, candidate: true }]);
  assert.equal(allWins.odds_ratio, Number.POSITIVE_INFINITY);
  assert.equal(binaryEffect([{ baseline: false, candidate: false }]).odds_ratio, null);
  assert.equal(binaryEffect([{ baseline: true, candidate: true }]).phi, null);
  const summary = summarizeContinuous([1, 2, 3, Number.NaN]);
  assert.equal(summary.observed, 3);
  assert.equal(summary.mean, 2);
  assert.equal(summary.median, 2);
  assert.equal(summary.p95, 2.9);
  assert.equal(summary.variance, 1);
  assert.equal(summary.standard_deviation, 1);
  assert.equal(summarizeContinuous([]).mean, null);
  assert.equal(summarizeContinuous([1]).variance, null);
  assert.equal(summarizeContinuous([1]).standard_deviation, null);
  const continuous = pairedContinuousEffect([
    { baseline: 1, candidate: 3 },
    { baseline: 2, candidate: 4 },
    { baseline: Number.NaN, candidate: 9 },
  ]);
  assert.equal(continuous.pairs, 2);
  assert.equal(continuous.mean_difference, 2);
  assert.equal(continuous.median_difference, 2);
  assert.equal(continuous.standardized_difference, null);
  assert.ok((pairedContinuousEffect([{ baseline: 1, candidate: 3 }, { baseline: 2, candidate: 3 }]).standardized_difference ?? 0) > 0);
  assert.ok(continuous.bootstrap_mean_difference_ci95);
  assert.equal(pairedContinuousEffect([]).pairs, 0);
  assert.equal(signProbability(0, 0), null);
  assert.equal(signProbability(1, 0), 0.5);
});

test('ledger reports compare only identical run identities and expose judge agreement', () => {
  const base = ledgerReport();
  const same = compareRunReports(base, ledgerReport({ suite_digest: 'suite-2' }, [
    { case_id: 'one', verdict: 'passed', judges: { alpha: 'passed' } },
    { case_id: 'two', verdict: 'passed', judges: { alpha: 'passed' } },
  ]));
  assert.equal(same.comparable, true);
  assert.equal(same.suite_evolution, true);
  assert.deepEqual(same.suite_digest_delta, { baseline: 'suite-1', candidate: 'suite-2' });
  assert.deepEqual(same.regressions, []);
  assert.match(String(same.improvements[0]), /^two:/);
  assert.deepEqual(same.judge_agreements, [{ judge: 'alpha', agreement: 0.5, cases: 2 }]);
  const removed = compareRunReports(base, ledgerReport({}, [
    { case_id: 'one', verdict: 'failed', judges: { alpha: 'failed' } },
    { case_id: 'two', verdict: 'failed' },
    { case_id: 'four', verdict: 'passed' },
  ]));
  assert.equal(removed.removedCases.includes('three'), true);
  assert.equal(removed.newCases.includes('four'), true);
  assert.equal(removed.judge_agreements?.[0]?.agreement, 0);
  const different = compareRunReports(base, ledgerReport({ model: 'other' }));
  assert.equal(different.comparable, false);
  assert.match(different.reason, /model/);
  const isolated = compareRunReports(base, ledgerReport({ isolation: 'shared' }));
  assert.match(isolated.reason, /isolation/);
  assert.equal(ledgerReport().suite_version, undefined);
  assert.throws(() => compareRunReports(null, base), /report object/);
  assert.throws(() => compareRunReports({}, base), /schema/);
  assert.throws(() => compareRunReports({ schema: 'wrong' }, base), /schema/);
  assert.throws(() => compareRunReports({ schema: 'craft-eval-run-report.v1' }, base), /identity/);
  const missingJudge = compareRunReports(base, ledgerReport({}, [
    { case_id: 'one', verdict: 'passed' },
    { case_id: 'two', verdict: 'failed' },
  ]));
  assert.deepEqual(missingJudge.judge_agreements, []);
});

test('suite diffs identify added, removed and modified cases with lineage digests', () => {
  const oldCase = { id: 'same', prompt: 'before', checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] };
  const newCase = { id: 'same', prompt: 'after', checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] };
  const oldSuite = { schema: 'craft-eval.eval.v1', suite_id: 's', version: '1', cases: [oldCase, { id: 'old', prompt: 'x', checks: [] }] } as unknown as Suite;
  const newSuite = { schema: 'craft-eval.eval.v1', suite_id: 's', version: '1.1', parent_digest: undefined, cases: [newCase, { id: 'new', prompt: 'y', checks: [] }] } as unknown as Suite;
  (newSuite as Record<string, unknown>).parent_digest = undefined;
  const diff = diffSuites(oldSuite, newSuite);
  assert.equal(diff.parent_matches, false);
  assert.deepEqual(diff.added.map((item) => item.id), ['new']);
  assert.deepEqual(diff.removed.map((item) => item.id), ['old']);
  assert.equal(diff.modified[0]?.case_id, 'same');
  const withParent = diffSuites(oldSuite, { ...newSuite, parent_digest: suiteLineage([oldSuite]).suites[0]!.digest } as Suite);
  assert.equal(withParent.parent_matches, true);
  assert.throws(() => diffSuites(oldSuite, null as unknown as Suite), /suite_id/);
  assert.throws(() => suiteLineage([null as unknown as Suite]), /suite_id/);
});

test('the CLI accepts every option and rejects malformed arguments through real processes', async () => {
  const f = await fixture();
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output, { trials: 1, parallelism: 1 });
    const report = await reportRun(run);
    assert.equal(report.expected, 2);
    const exportedSuite = JSON.parse(await readFile(f.suite, 'utf8')) as Suite;
    assert.equal(await main(['diff', f.suite, f.suite]), 0);
    assert.equal(await main(['audit', f.suite]), 0);
    assert.equal(await main(['coverage', f.suite]), 0);
    assert.equal(await main(['report', run]), 0);
    assert.equal(await main(['analyze', run]), 0);
    assert.equal(await main(['report-html', run, '--output', join(f.root, 'report.html')]), 0);
    assert.equal(await main(['compare', run, run]), 0);
    const comparisonPath = join(f.root, 'comparison.json');
    assert.equal(await main(['compare', run, run, '--output', comparisonPath]), 0);
    assert.equal(JSON.parse(await readFile(comparisonPath, 'utf8')).status, 'comparable');
    assert.equal(await main(['experiment', f.suite, '--workspace', f.workspace, '--output', join(f.root, 'experiment')]), 2);
    assert.equal(await main(['scenario', f.suite, f.subject, f.runtime, '--workspace', f.workspace, '--output', join(f.root, 'scenario')]), 2);
    const rescore = await main(['rescore', run, '--workspace', f.workspace, '--output', join(f.root, 'rescore')]);
    assert.equal(rescore, 0);
    const reportHtmlPath = join(f.root, 'html-with-artefacts.html');
    assert.equal(await main(['report-html', run, '--output', reportHtmlPath, '--comparison', comparisonPath]), 0);
    assert.ok((await readFile(reportHtmlPath, 'utf8')).includes('Comparison</h2><p>'));
    for (const argv of [
      ['run', f.suite, f.subject, f.runtime],
      ['mutation', f.suite, f.subject, f.runtime],
      ['run', f.suite, f.subject, f.runtime, '--trials'],
      ['run', f.suite, f.subject, f.runtime, '--parallelism'],
      ['run', f.suite, f.subject, f.runtime, '--workspace-mode'],
      ['run', f.suite, f.subject, f.runtime, '--workspace-mode', 'odd'],
      ['run', f.suite, f.subject, f.runtime, '--workspace-source'],
      ['run', f.suite, f.subject, f.runtime, '--keep-traces', 'never'],
      ['run', f.suite, f.subject, f.runtime, '--near-duplicate-threshold'],
      ['run', f.suite, f.subject, f.runtime, '--near-duplicate-threshold', '2'],
      ['run', f.suite, f.subject, f.runtime, '--workspace'],
      ['run', f.suite, f.subject, f.runtime, '--output'],
      ['compare', run, run, '--comparison'],
      ['report-html', run, '--comparison'],
      ['report-html', run, '--mutation'],
      ['unknown'],
      ['calibrate', f.suite, '--timeout-ms', '1'],
      ['calibrate', f.suite, '--max-output-bytes', '1'],
      ['run', f.suite, f.subject, f.runtime, '--timeout-ms', '1'],
      ['report', f.suite, '--max-output-bytes', '1'],
    ]) {
      assert.equal(await main(argv), 2, argv.join(' '));
    }
    for (const argv of [
      ['--trials'],
      ['--parallelism'],
      ['--timeout-ms'],
      ['--max-output-bytes'],
      ['--workspace-mode'],
      ['--workspace-source'],
      ['--near-duplicate-threshold'],
      ['--workspace'],
      ['--output'],
      ['--comparison'],
      ['--mutation'],
      ['--nope'],
    ]) {
      assert.equal(await main(['run', ...argv]), 2);
    }
    const wrongType = await main(['run', f.suite, f.subject, f.runtime, '--trials', '0']);
    assert.equal(wrongType, 2);
    const subprocess = spawnSync(process.execPath, [f.cli, 'report', run], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(subprocess.status, 0, subprocess.stderr);
    assert.match(subprocess.stdout, /"suite_id":"cli-stats"/);
    void exportedSuite;
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the evaluator comparison gate reports gain requirements and comparisons', async () => {
  const f = await fixture();
  try {
    const baseline = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const candidate = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const comparison = await compareRuns(baseline, candidate);
    assert.equal(comparison.status, 'comparable');
    assert.equal(await main(['compare', baseline, candidate, '--require-gain']), 1);
    assert.equal(await main(['validate', f.suite]), 0);
    assert.equal(await main(['validate']), 2);
    assert.equal(await main(['run', f.suite, f.subject, f.runtime, '--workspace', f.workspace, '--output', join(f.root, 'run2'), '--fail-on-failed']), 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
