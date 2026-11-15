import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { calibrateJudge } from '../src/calibration.js';

const answer = 'answer.txt';
const sample = { id: 'one', answer, expected: 'passed' as const };
// Correct judge: 1 for the passing answer, 0 for anything else.
const correctJudge = "import {readFileSync} from 'node:fs';console.log(JSON.stringify({score:readFileSync(process.env.CRAFT_EVAL_JUDGE_ANSWER,'utf8').includes('good')?1:0}))";
const alwaysPerfectJudge = "console.log(JSON.stringify({score:1}))";
// Tests run from dist/, so the checked-in examples live two levels up.
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

async function withManifest(
  body: Record<string, unknown>,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'craft-calibration-gate-'));
  const path = join(root, 'manifest.json');
  try {
    await writeFile(join(root, answer), 'good answer');
    await writeFile(path, JSON.stringify({ repeats: 2, samples: [sample], ...body }));
    await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('calibration passes when every declared gate is met', async () => {
  await withManifest(
    { command: [process.execPath, '-e', correctJudge], minimum_accuracy: 1, minimum_consistency: 1 },
    async (path) => {
      const report = await calibrateJudge(path);
      assert.equal(report.accuracy, 1);
      assert.equal(report.consistency, 1);
      assert.equal(report.passed, true);
      assert.equal(report.minimum_accuracy, 1);
      assert.equal(report.minimum_consistency, 1);
      // Backward-compatible fields stay untouched.
      assert.equal(report.samples, 1);
      assert.equal(report.repeats, 2);
      assert.equal(report.per_sample[0]!.id, 'one');
    },
  );
});

test('calibration fails when accuracy or consistency misses its gate', async () => {
  // Correctness follows the majority verdict, so 1-then-0 still reads as
  // correct while consistency drops to 0.5.
  const flakyJudge = `import {readFileSync,appendFileSync} from 'node:fs';const f=process.env.CRAFT_EVAL_JUDGE_ANSWER+'.count';let n=0;try{n=Number(readFileSync(f,'utf8'))}catch{}appendFileSync(f,String(n+1));console.log(JSON.stringify({score:n===0?1:0}))`;
  await withManifest({ command: [process.execPath, '-e', flakyJudge], minimum_consistency: 1 }, async (path) => {
    const report = await calibrateJudge(path);
    assert.equal(report.accuracy, 1);
    assert.equal(report.passed, false);
    assert.equal(report.minimum_consistency, 1);
    assert.equal(report.consistency, 0.5);
    // Only the declared gate is echoed.
    assert.equal('minimum_accuracy' in report, false);
  });
  // A judge that always answers 0 is reliably wrong: accuracy fails while
  // consistency passes, proving the two gates are scored independently.
  const alwaysWrongJudge = "console.log(JSON.stringify({score:0}))";
  await withManifest({ command: [process.execPath, '-e', alwaysWrongJudge], minimum_accuracy: 0.5 }, async (path) => {
    const report = await calibrateJudge(path);
    assert.deepEqual(report.per_sample[0]!.verdicts, ['failed', 'failed']);
    assert.equal(report.accuracy, 0);
    assert.equal(report.consistency, 1);
    assert.equal(report.passed, false);
    assert.equal(report.minimum_accuracy, 0.5);
    assert.equal('minimum_consistency' in report, false);
  });
});

test('calibration without declared gates keeps reporting numbers only', async () => {
  await withManifest({ command: [process.execPath, '-e', correctJudge] }, async (path) => {
    const report = await calibrateJudge(path);
    assert.equal(report.accuracy, 1);
    assert.equal(report.consistency, 1);
    assert.equal(report.passed, null);
    assert.equal('minimum_accuracy' in report, false);
    assert.equal('minimum_consistency' in report, false);
  });
});

test('declared gates stay undecided when nothing could be scored', async () => {
  await withManifest(
    { command: [process.execPath, '-e', "console.log('not json')"], minimum_accuracy: 0.5, minimum_consistency: 0 },
    async (path) => {
      const report = await calibrateJudge(path);
      assert.equal(report.accuracy, null);
      assert.equal(report.consistency, null);
      assert.equal(report.passed, null);
      assert.equal(report.per_sample[0]!.error, 'judge output is not JSON');
      // Gates are still echoed so the report shows what was supposed to apply.
      assert.equal(report.minimum_accuracy, 0.5);
      assert.equal(report.minimum_consistency, 0);
    },
  );
});

test('calibration records a crashing judge and refuses to declare a gate passed', async () => {
  await withManifest(
    { command: [process.execPath, '-e', 'process.exit(7)'], minimum_accuracy: 0, minimum_consistency: 0 },
    async (path) => {
      const report = await calibrateJudge(path);
      assert.equal(report.per_sample[0]!.error, 'judge exited 7');
      assert.deepEqual(report.per_sample[0]!.verdicts, ['error', 'error']);
      assert.equal(report.accuracy, null);
      assert.equal(report.consistency, null);
      assert.equal(report.passed, null);
    },
  );
});

test('calibration rejects gate values outside 0..1 or not finite', async () => {
  for (const [key, value, pattern] of [
    ['minimum_accuracy', 1.5, /minimum_accuracy/],
    ['minimum_accuracy', -0.1, /minimum_accuracy/],
    ['minimum_accuracy', 'high', /minimum_accuracy/],
    ['minimum_consistency', Number.POSITIVE_INFINITY, /minimum_consistency/],
    ['minimum_consistency', null, /minimum_consistency/],
  ] as const) {
    await withManifest({ command: [process.execPath, '-e', alwaysPerfectJudge], [key]: value }, async (path) => {
      await assert.rejects(calibrateJudge(path), pattern);
    });
  }
});

test('a judge that always returns full marks scores below 1 on the v1 gold set', async () => {
  const goldSet = join(repositoryRoot, 'examples/judge-pool/v1/samples.json');
  const { samples } = JSON.parse(await readFile(goldSet, 'utf8')) as { samples: Array<{ id: string; answer: string; expected: string }> };
  assert.ok(samples.length >= 10, `gold set has ${samples.length} samples, expected at least 10`);
  const count = (kind: string) => samples.filter((item) => item.id.startsWith(kind)).length;
  assert.ok(count('p') >= 3 && count('n') >= 3 && count('b') >= 2, 'gold set must cover positives, negatives and boundaries');
  assert.ok(samples.some((item) => item.id.includes('empty')), 'gold set needs an empty-output boundary');
  assert.ok(samples.some((item) => item.id.includes('oversized')), 'gold set needs an oversized-output boundary');
  assert.ok(samples.some((item) => item.id.includes('malformed')), 'gold set needs a malformed-output boundary');
  const v1 = join(repositoryRoot, 'examples/judge-pool/v1');
  assert.ok((await readdir(join(v1, 'answers'))).length >= 10);

  const root = await mkdtemp(join(tmpdir(), 'craft-calibration-gold-'));
  const manifest = join(root, 'manifest.json');
  try {
    await writeFile(
      manifest,
      JSON.stringify({
        command: [process.execPath, '-e', alwaysPerfectJudge],
        repeats: 1,
        samples: samples.map((item) => ({ id: item.id, answer: join(v1, item.answer), expected: item.expected })),
      }),
    );
    const report = await calibrateJudge(manifest);
    assert.equal(report.samples, samples.length);
    assert.ok(report.accuracy !== null && report.accuracy < 1, `expected accuracy < 1, got ${String(report.accuracy)}`);
    assert.equal(report.passed, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the v1 gold set ships a provenance source for every sample', async () => {
  const goldSet = join(repositoryRoot, 'examples/judge-pool/v1/samples.json');
  const parsed = JSON.parse(await readFile(goldSet, 'utf8')) as {
    samples: Array<{ id: string; provenance?: { source?: unknown } }>;
  };
  for (const item of parsed.samples) {
    assert.equal(typeof item.provenance?.source, 'string', `${item.id} needs provenance.source`);
    assert.ok(String(item.provenance?.source).length > 0, `${item.id} has an empty provenance.source`);
  }
  // The manifest must resolve to a real, measurable judge command.
  const report = await calibrateJudge(join(repositoryRoot, 'examples/judge-pool/v1/manifest.json'));
  assert.equal(report.passed, true);
  assert.equal(report.accuracy, 1);
  assert.equal(report.consistency, 1);
});
