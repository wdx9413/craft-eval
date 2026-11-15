import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { attributeRun } from '../src/attribution.js';
import { findFlakyCases, reportRun, runSuite } from '../src/evaluation.js';

const RUNTIME = {
  environment_digest: 'flaky-env',
  budget_digest: 'flaky-budget',
  host_digest: 'flaky-host',
  model_digest: 'none',
  tools_digest: 'node',
};

const result = (caseId: string, trial: number, verdict: 'passed' | 'failed'): Parameters<typeof findFlakyCases>[0][number] =>
  ({ case_id: caseId, trial, verdict } as Parameters<typeof findFlakyCases>[0][number]);

test('a single trial can never be flaky', () => {
  assert.deepEqual(findFlakyCases([result('a', 1, 'failed')], 1), []);
});

test('stable pass and stable failure are not flaky', () => {
  const stablePass = [1, 2, 3].map((trial) => result('a', trial, 'passed'));
  const stableFail = [1, 2, 3].map((trial) => result('b', trial, 'failed'));
  assert.deepEqual(findFlakyCases([...stablePass, ...stableFail], 3), []);
});

test('two passes and one failure is flaky with verdict counts', () => {
  const flaky = findFlakyCases(
    [result('flip', 1, 'passed'), result('flip', 2, 'passed'), result('flip', 3, 'failed')],
    3,
  );
  assert.equal(flaky.length, 1);
  assert.equal(flaky[0]?.case_id, 'flip');
  assert.deepEqual(flaky[0]?.verdicts, { passed: 2, failed: 1 });
  assert.equal(flaky[0]?.trials, 3);
});

test('report exposes flaky cases and attribution clusters them once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-flaky-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  // Fails on the third trial only, so the same case passes and fails.
  await writeFile(
    join(workspace, 'host.mjs'),
    'import { readFileSync, writeFileSync, existsSync } from "node:fs";\n'
      + 'const marker = "trial-marker";\n'
      + 'const count = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;\n'
      + 'writeFileSync(marker, String(count));\n'
      + 'process.exit(count >= 3 ? 3 : 0);\n',
    'utf8',
  );
  const suite = join(root, 'suite.json');
  await writeFile(suite, JSON.stringify({
    schema: 'craft-eval.eval.v1', suite_id: 'flaky', subject_kind: 'software',
    partition: 'development', sanitized: true,
    cases: [{ id: 'flip', argv: [process.execPath, 'host.mjs'], in_place: true, timeout_s: 10,
      checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }],
  }), 'utf8');
  const subject = join(root, 'subject.json');
  await writeFile(subject, JSON.stringify({ kind: 'software', id: 'flaky', version: '1' }), 'utf8');
  const runtime = join(root, 'runtime.json');
  await writeFile(runtime, JSON.stringify(RUNTIME), 'utf8');
  try {
    const run = await runSuite(suite, subject, runtime, workspace, join(root, 'runs'), { trials: 3 });
    const report = await reportRun(run);
    assert.equal(report.flaky_cases?.length, 1);
    assert.deepEqual(report.flaky_cases?.[0]?.verdicts, { passed: 2, failed: 1 });
    const attribution = attributeRun(report);
    const flakyCluster = attribution.clusters.find((item) => item.category === 'flaky');
    assert.equal(flakyCluster?.count, 1);
    assert.deepEqual(flakyCluster?.cases, ['flip']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
