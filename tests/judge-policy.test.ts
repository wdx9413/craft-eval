import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { reportRun, runSuite, type RunOptions } from '../src/evaluation.js';

const RUNTIME = {
  environment_digest: 'policy-env',
  budget_digest: 'policy-budget',
  host_digest: 'policy-host',
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
  const root = await mkdtemp(join(tmpdir(), 'craft-judge-policy-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const suite = join(root, 'suite.json');
  const subject = join(root, 'subject.json');
  const runtime = join(root, 'runtime.json');
  await writeFile(subject, JSON.stringify({ kind: 'software', id: 'policy', version: '1' }), 'utf8');
  await writeFile(runtime, JSON.stringify(RUNTIME), 'utf8');
  return { root, workspace, suite, subject, runtime, output: join(root, 'runs') };
}

/**
 * Judge command. `mixed` makes the alpha judge accept and beta reject, which is
 * what the `any` and `weighted` policies need to be distinguishable.
 */
async function writeJudge(
  f: Fixture,
  behavior: 'good' | 'bad' | 'crash' | 'garbage' | 'mixed',
): Promise<void> {
  const script =
    behavior === 'crash' ? 'process.exit(9);'
    : behavior === 'garbage' ? 'process.stdout.write("not-json");'
    : behavior === 'bad' ? 'console.log(JSON.stringify({ score: 0, reason: "bad" }));'
    : behavior === 'mixed'
      ? 'console.log(JSON.stringify({ score: process.argv[2] === "alpha" ? 1 : 0, reason: "mixed" }));'
    : 'console.log(JSON.stringify({ score: 1, reason: "good" }));';
  await writeFile(join(f.workspace, 'judge.mjs'), script, 'utf8');
}

function gradedCheck(judge: string, threshold: number, weight?: number): Record<string, unknown> {
  return {
    id: judge,
    kind: 'model_graded',
    judge,
    command: [process.execPath, 'judge.mjs', judge],
    answer: 'outputs/answer.md',
    rubric: 'any',
    threshold,
    ...(weight === undefined ? {} : { weight }),
  };
}

async function runPolicy(
  f: Fixture,
  policy: Record<string, unknown> | undefined,
  behavior: 'good' | 'bad' | 'crash' | 'garbage' | 'mixed',
): Promise<{ verdict: string; issue: string | null }> {
  await writeJudge(f, behavior);
  const suiteBody = {
    schema: 'craft-eval.eval.v1', suite_id: 'policy', subject_kind: 'software',
    partition: 'development', sanitized: true,
    cases: [{
      id: 'c1',
      argv: [process.execPath, '-e', 'const fs=require("node:fs");fs.mkdirSync("outputs",{recursive:true});fs.writeFileSync("outputs/answer.md","answer");'],
      timeout_s: 10,
      ...(policy === undefined ? {} : { judge_policy: policy }),
      checks: [
        gradedCheck('alpha', 1),
        gradedCheck('beta', 1),
      ],
    }],
  };
  await writeFile(f.suite, JSON.stringify(suiteBody), 'utf8');
  const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
  const report = await reportRun(run);
  const result = report.results[0]!;
  return { verdict: result.verdict, issue: result.issue };
}

test('all_required passes when every judge passes and fails when one rejects', async () => {
  const f = await fixture();
  try {
    assert.equal((await runPolicy(f, { mode: 'all_required' }, 'good')).verdict, 'passed');
    assert.equal((await runPolicy(f, { mode: 'all_required' }, 'bad')).verdict, 'failed');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('any passes when a single judge accepts even if the other rejects', async () => {
  const f = await fixture();
  try {
    assert.equal((await runPolicy(f, { mode: 'any' }, 'mixed')).verdict, 'passed');
    // Both judges reject: `any` cannot rescue the case.
    assert.equal((await runPolicy(f, { mode: 'any' }, 'bad')).verdict, 'failed');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('weighted aggregates by declared weights against min_score', async () => {
  const f = await fixture();
  try {
    // One of two equal-weight judges passes: 0.5.
    const failing = await runPolicy(f, { mode: 'weighted', min_score: 0.9 }, 'mixed');
    assert.equal(failing.verdict, 'failed');
    // The same split is acceptable when the bar is low enough.
    const passing = await runPolicy(f, { mode: 'weighted', min_score: 0.5 }, 'mixed');
    assert.equal(passing.verdict, 'passed');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a judge error keeps the case inconclusive under every policy', async () => {
  const f = await fixture();
  try {
    for (const policy of [{ mode: 'all_required' }, { mode: 'any' }, { mode: 'weighted', min_score: 0.5 }]) {
      assert.equal((await runPolicy(f, policy, 'crash')).verdict, 'inconclusive');
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('invalid judge output is inconclusive, never a low score', async () => {
  const f = await fixture();
  try {
    assert.equal((await runPolicy(f, { mode: 'all_required' }, 'garbage')).verdict, 'inconclusive');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an uncalibrated judge withholds its verdict instead of failing the case', async () => {
  const f = await fixture();
  try {
    // The calibration manifest does not exist, so the gate cannot be satisfied.
    const policy = { mode: 'all_required' };
    const calibration = { manifest: 'missing-calibration.json', minimum_accuracy: 0.9 };
    await writeJudge(f, 'good');
    await writeFile(f.suite, JSON.stringify({
      schema: 'craft-eval.eval.v1', suite_id: 'gate', subject_kind: 'software',
      partition: 'development', sanitized: true,
      cases: [{
        id: 'c1',
        argv: [process.execPath, '-e', 'const fs=require("node:fs");fs.mkdirSync("outputs",{recursive:true});fs.writeFileSync("outputs/answer.md","answer");'],
        timeout_s: 10,
        judge_policy: policy,
        judge_calibration: calibration,
        checks: [gradedCheck('alpha', 1), gradedCheck('beta', 1)],
      }],
    }), 'utf8');
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output);
    const report = await reportRun(run);
    assert.equal(report.results[0]!.verdict, 'inconclusive');
    const graded = report.results[0]!.checks.filter((item) => item.judge !== undefined);
    assert.ok(graded.every((item) => item.reason === 'judge_uncalibrated'));
    assert.ok(graded.every((item) => (item.evidence as unknown as { calibration?: unknown }).calibration !== undefined));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a satisfied calibration gate lets the judge grade normally', async () => {
  const f = await fixture();
  try {
    // A perfect judge against the shipped gold set: gate passes, case passes.
    // The manifest must be workspace-relative, so copy the pool in first.
    await cp(join(process.cwd(), 'examples/judge-pool/v1'), join(f.workspace, 'judge-pool'), { recursive: true });
    const calibration = { manifest: 'judge-pool/manifest.json' };
    await writeJudge(f, 'good');
    await writeFile(f.suite, JSON.stringify({
      schema: 'craft-eval.eval.v1', suite_id: 'gate-ok', subject_kind: 'software',
      partition: 'development', sanitized: true,
      cases: [{
        id: 'c1',
        argv: [process.execPath, '-e', 'const fs=require("node:fs");fs.mkdirSync("outputs",{recursive:true});fs.writeFileSync("outputs/answer.md","answer");'],
        timeout_s: 60,
        judge_policy: { mode: 'all_required' },
        judge_calibration: calibration,
        checks: [gradedCheck('alpha', 1)],
      }],
    }), 'utf8');
    const run = await runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output, {
      max_output_bytes: 2 * 1024 * 1024,
    } as RunOptions);
    const report = await reportRun(run);
    assert.equal(report.results[0]!.verdict, 'passed');
    const graded = report.results[0]!.checks.find((item) => item.judge !== undefined);
    assert.equal(graded?.reason, 'ok');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('invalid judge_policy shapes are rejected at load time', async () => {
  const f = await fixture();
  try {
    const cases = [
      { judge_policy: { mode: 'sometimes' } },
      { judge_policy: { mode: 'weighted', min_score: 2 } },
      { judge_policy: { mode: 'all_required', extra: true } },
    ];
    for (const [index, item] of cases.entries()) {
      await writeFile(f.suite, JSON.stringify({
        schema: 'craft-eval.eval.v1', suite_id: `bad-${index}`, subject_kind: 'software',
        partition: 'development', sanitized: true,
        cases: [{
          id: 'c1', argv: [process.execPath, '-e', 'process.exit(0)'], timeout_s: 5,
          ...item,
          checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
        }],
      }), 'utf8');
      await assert.rejects(runSuite(f.suite, f.subject, f.runtime, f.workspace, f.output), /judge_policy/);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
