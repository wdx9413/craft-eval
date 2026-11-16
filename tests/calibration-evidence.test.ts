import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { calibrateJudge } from '../src/calibration.js';

async function withGoldSet(
  body: Record<string, unknown>,
  samples: unknown[],
  run: (manifestPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'craft-calibration-evidence-'));
  try {
    await writeFile(join(root, 'answer.txt'), 'the answer', 'utf8');
    await writeFile(
      join(root, 'samples.json'),
      JSON.stringify({ schema: 'craft-eval.judge-gold-set.v1', version: 'v1', samples }),
      'utf8',
    );
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ samples_file: 'samples.json', ...body }), 'utf8');
    await run(manifestPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const GOOD = "import {readFileSync} from 'node:fs';console.log(JSON.stringify({score:readFileSync(process.env.CRAFT_EVAL_JUDGE_ANSWER,'utf8').includes('answer')?1:0}))";

test('a manifest can read its gold set from a single shared file', async () => {
  await withGoldSet(
    { command: [process.execPath, '-e', GOOD], repeats: 1 },
    [{ id: 'one', answer: 'answer.txt', expected: 'passed' }],
    async (manifestPath) => {
      const report = await calibrateJudge(manifestPath);
      assert.equal(report.samples, 1);
      assert.equal(report.accuracy, 1);
      assert.equal(report.per_sample[0]?.id, 'one');
    },
  );
});

test('a gold set file that is not a gold set is rejected', async () => {
  await withGoldSet(
    { command: [process.execPath, '-e', GOOD] },
    [{ id: 'one', answer: 'answer.txt', expected: 'passed' }],
    async (manifestPath) => {
      // A manifest without any sample source at all has nothing to measure.
      await writeFile(manifestPath, JSON.stringify({ command: [process.execPath, '-e', GOOD] }), 'utf8');
      await assert.rejects(calibrateJudge(manifestPath), /sample/);
      await writeFile(manifestPath, JSON.stringify({ command: [process.execPath, '-e', GOOD], samples_file: 'missing.json' }), 'utf8');
      await assert.rejects(calibrateJudge(manifestPath), /ENOENT|no such file/i);
    },
  );
});

test('a per-sample rubric overrides the manifest default', async () => {
  const echo = "console.log(JSON.stringify({score:process.env.CRAFT_EVAL_JUDGE_RUBRIC==='per-sample'?1:0}))";
  await withGoldSet(
    { command: [process.execPath, '-e', echo], repeats: 1, rubric: 'manifest' },
    [{ id: 'one', answer: 'answer.txt', expected: 'passed', rubric: 'per-sample' }],
    async (manifestPath) => {
      const report = await calibrateJudge(manifestPath);
      assert.equal(report.accuracy, 1);
    },
  );
});

test('a sample that never produced a verdict cannot certify the judge', async () => {
  // The judge crashes on one sample and answers correctly on the other. The
  // measured sample alone would pass an accuracy bar, but the judge never
  // graded the whole set, so the gate stays undecided.
  const flaky = "import {readFileSync} from 'node:fs';if(process.env.CRAFT_EVAL_JUDGE_RUBRIC==='broken')process.exit(4);const a=readFileSync(process.env.CRAFT_EVAL_JUDGE_ANSWER,'utf8');console.log(JSON.stringify({score:a.includes('the answer')?1:0}))";
  await withGoldSet(
    { command: [process.execPath, '-e', flaky], repeats: 1, minimum_accuracy: 0.5 },
    [
      { id: 'ok', answer: 'answer.txt', expected: 'passed', rubric: 'fine' },
      { id: 'broken', answer: 'answer.txt', expected: 'passed', rubric: 'broken' },
    ],
    async (manifestPath) => {
      const report = await calibrateJudge(manifestPath);
      assert.equal(report.unmeasured_samples, 1);
      assert.equal(report.measured_samples, 1);
      assert.equal(report.errors, 1);
      assert.equal(report.passed, null);
      assert.match(String(report.gate_undecided_reason), /no verdict/);
    },
  );
});

test('a judge that keeps failing reports why, not just that it failed', async () => {
  await withGoldSet(
    { command: [process.execPath, '-e', "console.error('gateway unreachable: ECONNREFUSED');process.exit(2)"], repeats: 1 },
    [{ id: 'one', answer: 'answer.txt', expected: 'passed' }],
    async (manifestPath) => {
      const report = await calibrateJudge(manifestPath);
      assert.equal(report.per_sample[0]?.error, 'judge exited 2');
      assert.match(String(report.per_sample[0]?.error_detail), /gateway unreachable/);
    },
  );
});

