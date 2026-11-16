import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compareRunReports } from '../src/compare-run-reports.js';
import { main } from '../src/cli.js';
import { writeHtmlReport } from '../src/report-html.js';
import { runSuite, type Comparison } from '../src/evaluation.js';
import type { MutationReport } from '../src/mutation.js';

const RUNTIME = {
  environment_digest: 'report-env',
  budget_digest: 'report-budget',
  host_digest: 'report-host',
  model_digest: 'none',
  tools_digest: 'node',
};

interface Fixture {
  root: string;
  workspace: string;
  suite: string;
  subject: string;
  runtime: string;
  output: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'craft-report-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'host.mjs'), 'process.exit(0);\n', 'utf8');
  const suite = join(root, 'suite.json');
  await writeFile(suite, JSON.stringify({
    schema: 'craft-eval.eval.v1', suite_id: 'report', subject_kind: 'software',
    partition: 'development', sanitized: true,
    cases: [{
      id: 'c1',
      argv: [process.execPath, 'host.mjs'],
      timeout_s: 10,
      checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
    }],
  }), 'utf8');
  const subject = join(root, 'subject.json');
  await writeFile(subject, JSON.stringify({ kind: 'software', id: 'report', version: '1' }), 'utf8');
  const runtime = join(root, 'runtime.json');
  await writeFile(runtime, JSON.stringify(RUNTIME), 'utf8');
  return { root, workspace, suite, subject, runtime, output: join(root, 'runs') };
}

const COMPARISON = {
  status: 'comparable',
  subject_kind: 'software',
  baseline_run_id: 'baseline-run-000000',
  candidate_run_id: 'candidate-run-00000',
  expected_pairs: 2,
  measured_pairs: 2,
  unmeasured_pairs: 0,
  candidate_wins: 1,
  baseline_wins: 0,
  ties: 1,
  one_sided_p: 0.5,
  candidate_trigger_failures: 0,
  candidate_safety_failures: 0,
  independent_task_runs: true,
  gateway_observed_triggers: true,
  unobserved_triggers: 0,
  excluded_duplicate_case_ids: [],
  flaky_excluded: ['flaky-case'],
  judge_agreements: [{ judge: 'alpha', agreement: 0.5, cases: 2 }],
  result_integrity: 'unverified',
  diagnostic_skill_gain: false,
  skill_gain_supported: false,
  primary_metric: 'binary_pass_rate',
  primary_effect: {},
  guardrails: [],
  duration_ms: {},
  cost_units: {},
  duration_effect: {},
  cost_effect: {},
} as unknown as Comparison;

const MUTATION: MutationReport = {
  schema: 'craft-eval.mutation.v1',
  total: 2,
  killed: 1,
  survived: 1,
  errored: 0,
  mutation_score: 0.5,
  mutants: [
    { id: 'flip', status: 'killed', expected: 'failed', observed: 'failed' },
    { id: 'noop', status: 'survived', expected: 'passed', observed: 'passed' },
  ],
};

test('a report without artefacts shows the comparison and mutation sections as not measured', async () => {
  const f = await fixture();
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const htmlPath = join(f.root, 'report.html');
    await writeHtmlReport(run, htmlPath);
    const html = await readFile(htmlPath, 'utf8');
    assert.match(html, /<h2>Comparison<\/h2><p><em>not measured<\/em><\/p>/);
    assert.match(html, /<h2>Mutation score<\/h2><p><em>not measured<\/em><\/p>/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the report folds in a comparison and a mutation report', async () => {
  const f = await fixture();
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const htmlPath = join(f.root, 'report.html');
    await writeHtmlReport(run, htmlPath, { comparison: COMPARISON, mutation: MUTATION });
    const html = await readFile(htmlPath, 'utf8');
    assert.match(html, /flaky-case/);
    assert.match(html, /Judge agreement/);
    assert.match(html, /alpha/);
    assert.match(html, /mutation score 0\.5/);
    assert.match(html, /survived/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the report escapes artefact text instead of breaking the page', async () => {
  const f = await fixture();
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const htmlPath = join(f.root, 'report.html');
    await writeHtmlReport(run, htmlPath, {
      comparison: { ...COMPARISON, flaky_excluded: ['<script>alert(1)</script>'] } as Comparison,
    });
    const html = await readFile(htmlPath, 'utf8');
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the cli writes comparison and mutation artefacts and feeds them to the html report', async () => {
  const f = await fixture();
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const comparisonPath = join(f.root, 'comparison.json');
    const mutationDir = join(f.root, 'mutation');
    const mutationPath = join(mutationDir, 'mutation-report.json');
    const htmlPath = join(f.root, 'report.html');

    await main(['compare', run, run, '--output', comparisonPath]);
    const comparison = JSON.parse(await readFile(comparisonPath, 'utf8')) as Comparison;
    assert.equal(comparison.status, 'comparable');

    // A manifest whose baseline copy holds the host keeps the mutation run
    // offline; the point here is that the artefact reaches the report.
    await mkdir(mutationDir, { recursive: true });
    await writeFile(mutationPath, JSON.stringify(MUTATION), 'utf8');

    await main(['report-html', run, '--output', htmlPath, '--comparison', comparisonPath, '--mutation', mutationPath]);
    const html = await readFile(htmlPath, 'utf8');
    assert.match(html, /<h2>Comparison<\/h2><p>/);
    assert.match(html, /mutation score 0\.5/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the mutation command persists its report next to the mutant runs', async () => {
  const f = await fixture();
  try {
    const baseline = join(f.root, 'baseline');
    await mkdir(baseline, { recursive: true });
    await writeFile(join(baseline, 'host.mjs'), 'const ok = true;\nif (ok) { process.exit(0); } else { process.exit(1); }\n', 'utf8');
    await writeFile(join(baseline, 'subject.json'), JSON.stringify({ kind: 'software', id: 'mut', version: '1' }), 'utf8');
    const manifest = join(f.root, 'manifest.json');
    await writeFile(manifest, JSON.stringify({
      baseline_dir: 'baseline',
      mutations: [{ id: 'flip', file: 'host.mjs', find: 'const ok = true;', replace: 'const ok = false;' }],
    }), 'utf8');
    const output = join(f.root, 'mutation-out');
    await main(['mutation', manifest, f.suite, f.runtime, '--workspace', f.workspace, '--output', output]);
    const report = JSON.parse(await readFile(join(output, 'mutation-report.json'), 'utf8')) as MutationReport;
    assert.equal(report.schema, 'craft-eval.mutation.v1');
    assert.equal(report.total, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

const LEDGER_REPORT = {
  schema: 'craft-eval-run-report.v1',
  provider: 'local-openai',
  base_url: 'http://127.0.0.1:3425/v1',
  model: 'group/free',
  suite_digest: `sha256:${'a'.repeat(64)}`,
};

test('the three-ledger comparator scores judge agreement only when both sides carry judge verdicts', () => {
  const baseline = {
    ...LEDGER_REPORT,
    results: [
      { case_id: 'a', verdict: 'passed', judges: { alpha: 'passed' } },
      { case_id: 'b', verdict: 'passed', judges: { alpha: 'passed' } },
    ],
  };
  const candidate = {
    ...LEDGER_REPORT,
    results: [
      { case_id: 'a', verdict: 'passed', judges: { alpha: 'passed' } },
      { case_id: 'b', verdict: 'failed', judges: { alpha: 'failed' } },
    ],
  };
  const comparison = compareRunReports(baseline, candidate);
  assert.deepEqual(comparison.judge_agreements, [{ judge: 'alpha', agreement: 0.5, cases: 2 }]);
});

test('a judge that only one side graded is not counted as agreement', () => {
  const baseline = {
    ...LEDGER_REPORT,
    results: [{ case_id: 'a', verdict: 'passed', judges: { alpha: 'passed' } }],
  };
  const candidate = {
    ...LEDGER_REPORT,
    results: [{ case_id: 'a', verdict: 'passed' }],
  };
  assert.deepEqual(compareRunReports(baseline, candidate).judge_agreements, []);
});

test('reports without judge verdicts report no agreement rather than perfect agreement', () => {
  const report = { ...LEDGER_REPORT, results: [{ case_id: 'a', verdict: 'passed' }] };
  assert.deepEqual(compareRunReports(report, report).judge_agreements, []);
});

test('runs that are not comparable report no judge agreement', () => {
  const baseline = { ...LEDGER_REPORT, results: [{ case_id: 'a', verdict: 'passed', judges: { alpha: 'passed' } }] };
  const candidate = { ...baseline, model: 'other-model' };
  const comparison = compareRunReports(baseline, candidate);
  assert.equal(comparison.comparable, false);
  assert.deepEqual(comparison.judge_agreements, []);
});

