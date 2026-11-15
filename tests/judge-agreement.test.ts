import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compareRuns, runSuite } from '../src/evaluation.js';

const RUNTIME = {
  environment_digest: 'agreement-env',
  budget_digest: 'agreement-budget',
  host_digest: 'agreement-host',
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

async function fixture(judgeScript: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'craft-judge-agreement-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'judge.mjs'), judgeScript, 'utf8');
  const suite = join(root, 'suite.json');
  await writeFile(suite, JSON.stringify({
    schema: 'craft-eval.eval.v1', suite_id: 'agreement', subject_kind: 'software',
    partition: 'development', sanitized: true,
    cases: [{
      id: 'c1',
      argv: [process.execPath, '-e', 'const fs=require("node:fs");fs.mkdirSync("outputs",{recursive:true});fs.writeFileSync("outputs/answer.md","answer");'],
      timeout_s: 15,
      checks: [{
        id: 'quality', kind: 'model_graded', judge: 'alpha',
        command: [process.execPath, 'judge.mjs'],
        answer: 'outputs/answer.md', rubric: 'any', threshold: 1,
      }],
    }],
  }), 'utf8');
  const subject = join(root, 'subject.json');
  await writeFile(subject, JSON.stringify({ kind: 'software', id: 'agreement', version: '1' }), 'utf8');
  const runtime = join(root, 'runtime.json');
  await writeFile(runtime, JSON.stringify(RUNTIME), 'utf8');
  return { root, workspace, suite, subject, runtime, output: join(root, 'runs') };
}

const PASS = 'console.log(JSON.stringify({ score: 1, reason: "pass" }));';
const FAIL = 'console.log(JSON.stringify({ score: 0, reason: "fail" }));';

test('identical judge behaviour yields perfect agreement', async () => {
  const f = await fixture(PASS);
  try {
    const baseline = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const candidate = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const comparison = await compareRuns(baseline, candidate);
    assert.deepEqual(comparison.judge_agreements, [{ judge: 'alpha', agreement: 1, cases: 1 }]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a judge that flips between runs reports disagreement', async () => {
  const f = await fixture(PASS);
  try {
    const baseline = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    // Swap the judge behaviour, then re-run the same suite.
    await writeFile(join(f.workspace, 'judge.mjs'), FAIL, 'utf8');
    const candidate = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const comparison = await compareRuns(baseline, candidate);
    assert.deepEqual(comparison.judge_agreements, [{ judge: 'alpha', agreement: 0, cases: 1 }]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('runs without judges report an empty agreement list', async () => {
  const f = await fixture(PASS);
  try {
    await writeFile(f.suite, JSON.stringify({
      schema: 'craft-eval.eval.v1', suite_id: 'no-judge', subject_kind: 'software',
      partition: 'development', sanitized: true,
      cases: [{ id: 'c1', argv: [process.execPath, '-e', 'process.exit(0)'], timeout_s: 10,
        checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }],
    }), 'utf8');
    const baseline = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const candidate = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const comparison = await compareRuns(baseline, candidate);
    assert.deepEqual(comparison.judge_agreements, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
