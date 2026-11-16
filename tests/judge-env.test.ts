import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadSuite, reportRun, runSuite } from '../src/evaluation.js';

const RUNTIME = {
  environment_digest: 'judge-env',
  budget_digest: 'judge-env',
  host_digest: 'judge-env',
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

async function fixture(check: Record<string, unknown>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'craft-judge-env-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, 'judge.mjs'),
    [
      'import { readFileSync } from "node:fs";',
      'const answer = readFileSync(process.env.CRAFT_EVAL_JUDGE_ANSWER, "utf8");',
      // The judge reports what it actually received, so the test asserts on
      // the environment the evaluator forwarded rather than on a stub value.
      'const token = process.env.CRAFT_EVAL_TEST_TOKEN;',
      'const score = answer.includes("expected-answer") && token === "secret-token" ? 1 : 0;',
      'console.log(JSON.stringify({ score, reason: `token=${String(token)}` }));',
    ].join('\n'),
    'utf8',
  );
  const suite = join(root, 'suite.json');
  await writeFile(suite, JSON.stringify({
    schema: 'craft-eval.eval.v1', suite_id: 'judge-env', subject_kind: 'software',
    partition: 'development', sanitized: true,
    cases: [{
      id: 'c1',
      argv: [process.execPath, '-e', 'const fs=require("node:fs");fs.mkdirSync("outputs",{recursive:true});fs.writeFileSync("outputs/answer.md","expected-answer");'],
      timeout_s: 30,
      checks: [{ id: 'quality', kind: 'model_graded', command: [process.execPath, 'judge.mjs'], answer: 'outputs/answer.md', threshold: 1, ...check }],
    }],
  }), 'utf8');
  const subject = join(root, 'subject.json');
  await writeFile(subject, JSON.stringify({ kind: 'software', id: 'judge-env', version: '1' }), 'utf8');
  const runtime = join(root, 'runtime.json');
  await writeFile(runtime, JSON.stringify(RUNTIME), 'utf8');
  return { root, workspace, suite, subject, runtime, output: join(root, 'runs') };
}

test('a judge receives the named variables the suite asks for', async () => {
  const f = await fixture({ judge_env: ['CRAFT_EVAL_TEST_TOKEN'] });
  const previous = process.env['CRAFT_EVAL_TEST_TOKEN'];
  process.env['CRAFT_EVAL_TEST_TOKEN'] = 'secret-token';
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const result = (await reportRun(run)).results[0]!;
    assert.equal(result.verdict, 'passed');
    assert.equal(result.checks[0]?.evidence.score, 1);
  } finally {
    if (previous === undefined) delete process.env['CRAFT_EVAL_TEST_TOKEN'];
    else process.env['CRAFT_EVAL_TEST_TOKEN'] = previous;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a judge without the declared variable is not given one', async () => {
  const f = await fixture({ judge_env: ['CRAFT_EVAL_TEST_TOKEN'] });
  const previous = process.env['CRAFT_EVAL_TEST_TOKEN'];
  delete process.env['CRAFT_EVAL_TEST_TOKEN'];
  try {
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const result = (await reportRun(run)).results[0]!;
    assert.equal(result.verdict, 'failed');
    assert.equal(result.checks[0]?.reason, 'value_mismatch');
  } finally {
    if (previous !== undefined) process.env['CRAFT_EVAL_TEST_TOKEN'] = previous;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('judge_env must name variables instead of carrying values', async () => {
  const f = await fixture({ judge_env: ['CRAFT_EVAL_TEST_TOKEN=secret-token'] });
  try {
    // A name that carries a value is not a name; the credential must come
    // from the evaluator process, not from the suite file.
    await assert.rejects(loadSuite(f.suite), /judge_env/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an empty judge_env list is rejected', async () => {
  const f = await fixture({ judge_env: [] });
  try {
    await assert.rejects(loadSuite(f.suite), /judge_env/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a judge command can point at an evaluator asset outside the subject workspace', async () => {
  const f = await fixture({});
  try {
    // The judge belongs to the evaluation, not to the tested project, so its
    // path is resolved with the same anchors as the other evaluator-owned
    // paths. A copy inside the subject workspace is not required.
    await writeFile(
      join(f.workspace, 'judge.mjs'),
      'console.log(JSON.stringify({ score: 1, reason: "anchored judge" }));',
      'utf8',
    );
    const suite = join(f.root, 'anchored-suite.json');
    await writeFile(suite, JSON.stringify({
      schema: 'craft-eval.eval.v1', suite_id: 'judge-anchor', subject_kind: 'software',
      partition: 'development', sanitized: true,
      cases: [{
        id: 'c1',
        argv: [process.execPath, '-e', 'const fs=require("node:fs");fs.mkdirSync("outputs",{recursive:true});fs.writeFileSync("outputs/answer.md","answer");'],
        timeout_s: 30,
        checks: [{
          id: 'quality', kind: 'model_graded',
          command: [process.execPath, '{{craft-eval}}/examples/judge-workspace/judge-http.mjs'],
          answer: 'outputs/answer.md', threshold: 1,
        }],
      }],
    }), 'utf8');
    const subject = join(f.root, 'anchored-subject.json');
    await writeFile(subject, JSON.stringify({ kind: 'software', id: 'judge-anchor', version: '1' }), 'utf8');
    const runtime = join(f.root, 'anchored-runtime.json');
    await writeFile(runtime, JSON.stringify(RUNTIME), 'utf8');
    const run = await runSuite(suite, subject, runtime, f.workspace, f.output);
    const result = (await reportRun(run)).results[0]!;
    // The HTTP judge has no gateway configured here, so it reports a
    // configuration gap rather than a score. The point is that the anchored
    // path was found and executed at all.
    assert.equal(result.checks[0]?.reason, 'judge_error');
    assert.match(String(result.checks[0]?.evidence.judge_stderr_tail), /missing environment variable/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

