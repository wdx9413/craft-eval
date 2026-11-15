import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { reportRun, runSuite, type RunOptions } from '../src/evaluation.js';

const RUNTIME = {
  environment_digest: 'retention-env',
  budget_digest: 'retention-budget',
  host_digest: 'retention-host',
  model_digest: 'none',
  tools_digest: 'node',
};

/** Two cases: one exits 0, the other exits 2 so both verdicts are observable. */
async function fixture(): Promise<{ root: string; workspace: string; suite: string; subject: string; runtime: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'craft-retention-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'pass.mjs'), 'process.stdout.write("passed-output");\nprocess.exit(0);\n', 'utf8');
  await writeFile(join(workspace, 'fail.mjs'), 'process.stderr.write("failed-output");\nprocess.exit(2);\n', 'utf8');
  const suite = join(root, 'suite.json');
  await writeFile(suite, JSON.stringify({
    schema: 'craft-eval.eval.v1', suite_id: 'retention', subject_kind: 'software',
    partition: 'development', sanitized: true,
    cases: [
      { id: 'ok', argv: [process.execPath, 'pass.mjs'], timeout_s: 10, checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] },
      { id: 'bad', argv: [process.execPath, 'fail.mjs'], timeout_s: 10, checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] },
    ],
  }), 'utf8');
  const subject = join(root, 'subject.json');
  await writeFile(subject, JSON.stringify({ kind: 'software', id: 'retention', version: '1' }), 'utf8');
  const runtime = join(root, 'runtime.json');
  await writeFile(runtime, JSON.stringify(RUNTIME), 'utf8');
  return { root, workspace, suite, subject, runtime, output: join(root, 'runs') };
}

async function planControls(run: string): Promise<Record<string, unknown>> {
  const plan = JSON.parse(await readFile(join(run, 'plan.json'), 'utf8')) as { execution_controls: Record<string, unknown> };
  return plan.execution_controls;
}

test('never keeps digests only and records the mode in the plan', async () => {
  const f = await fixture();
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output, { keep_traces: 'never' });
    assert.equal(existsSync(join(run, 'captures')), false);
    assert.equal((await planControls(run)).keep_traces, 'never');
    const report = await reportRun(run);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('on-failure exports only non-passing cases', async () => {
  const f = await fixture();
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output, { keep_traces: 'on-failure' });
    assert.equal((await planControls(run)).keep_traces, 'on-failure');
    assert.equal(existsSync(join(run, 'captures', 'ok-1')), false);
    const failedDir = join(run, 'captures', 'bad-1');
    assert.equal(existsSync(failedDir), true);
    assert.match(await readFile(join(failedDir, 'stderr'), 'utf8'), /failed-output/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('always exports every case and legacy boolean still maps', async () => {
  const f = await fixture();
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output, { keep_traces: 'always' });
    assert.equal((await planControls(run)).keep_traces, 'always');
    assert.equal(existsSync(join(run, 'captures', 'ok-1', 'stdout')), true);
    assert.equal(existsSync(join(run, 'captures', 'bad-1', 'stderr')), true);

    const legacyOn = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output, { keep_traces: true });
    assert.equal((await planControls(legacyOn)).keep_traces, 'always');
    const legacyOff = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output, {} as RunOptions);
    assert.equal((await planControls(legacyOff)).keep_traces, 'never');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an unknown retention value is rejected before any case runs', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output, { keep_traces: 'sometimes' as unknown as 'never' }),
      /keep_traces must be never, on-failure, always or a boolean/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
