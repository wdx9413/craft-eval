import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { calibrateJudge } from '../src/calibration.js';

test('calibration retains error details and rejects invalid or pre-aborted work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-calibration-controls-')), path = join(root, 'manifest.json');
  const sample = { id: 'one', answer: 'answer.txt', expected: 'passed' };
  const manifest = (code: string) => ({ command: [process.execPath, '-e', code], repeats: 1, samples: [sample] });
  try {
    await writeFile(path, JSON.stringify({ ...manifest('void 0'), command: [] })); await assert.rejects(calibrateJudge(path), /command/);
    await writeFile(path, JSON.stringify({ ...manifest('void 0'), command: 'invalid' })); await assert.rejects(calibrateJudge(path), /command/);
    for (const command of [[null], [''], [process.execPath, 3]]) { await writeFile(path, JSON.stringify({ ...manifest('void 0'), command })); await assert.rejects(calibrateJudge(path), /command/); }
    await writeFile(path, JSON.stringify({ ...manifest('void 0'), samples: [] })); await assert.rejects(calibrateJudge(path), /sample/);
    await writeFile(path, JSON.stringify({ ...manifest('void 0'), samples: 'invalid' })); await assert.rejects(calibrateJudge(path), /sample/);
    for (const repeats of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) { await writeFile(path, JSON.stringify({ ...manifest('void 0'), repeats })); await assert.rejects(calibrateJudge(path), /repeats/); }
    const controller = new AbortController(); controller.abort(); await assert.rejects(calibrateJudge(path, { signal: controller.signal }), /abort/i);
    for (const [code, error] of [
      ['process.exit(3)', 'judge exited 3'], ["console.log('not json')", 'judge output is not JSON'],
      ["console.log('{}')", 'judge output has no numeric score'], ["console.log('{\"score\":1e999}')", 'judge output has no numeric score'],
    ]) {
      await writeFile(path, JSON.stringify(manifest(code!))); const report = await calibrateJudge(path);
      assert.equal(report.per_sample[0]!.error, error); assert.equal(report.accuracy, null); assert.equal(report.consistency, null);
    }
    await writeFile(path, JSON.stringify({ ...manifest('void 0'), command: [join(root, 'missing')] }));
    assert.equal((await calibrateJudge(path)).per_sample[0]!.error, 'Error');
    await writeFile(path, JSON.stringify({ ...manifest("console.log('{\"score\":1}')"), repeats: undefined }));
    const valid = await calibrateJudge(path); assert.equal(valid.repeats, 3); assert.equal(valid.accuracy, 1);
    await writeFile(join(root, 'relative-judge.mjs'), "console.log(JSON.stringify({score:process.env.CRAFT_EVAL_JUDGE_RUBRIC==='rubric' ? 1 : 0}))");
    await writeFile(path, JSON.stringify({ ...manifest('void 0'), command: [process.execPath, 'relative-judge.mjs'], dir: '.', rubric: 'rubric' }));
    assert.equal((await calibrateJudge(path)).accuracy, 1);
    await assert.rejects(calibrateJudge(path, { timeout_ms: 0 }), /timeout_ms/);
    await assert.rejects(calibrateJudge(path, { max_output_bytes: 0 }), /max_output_bytes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('calibration CLI applies timeout/output budgets and reports malformed options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-calibration-cli-')), path = join(root, 'manifest.json');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  try {
    await writeFile(path, JSON.stringify({ command: [process.execPath, '-e', "console.log('x'.repeat(4096))"], repeats: 1, samples: [{ id: 'one', answer: 'answer.txt', expected: 'passed' }] }));
    const result = spawnSync(process.execPath, [cli, 'calibrate', path, '--max-output-bytes', '128', '--timeout-ms', '1000'], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).per_sample[0].error, 'output_limit');
    for (const flag of ['--timeout-ms', '--max-output-bytes']) {
      const missing = spawnSync(process.execPath, [cli, 'calibrate', path, flag], { encoding: 'utf8', timeout: 5_000 });
      assert.equal(missing.status, 2); assert.match(missing.stderr, /requires a value/);
    }
    for (const [command, flag] of [['validate', '--timeout-ms'], ['report', '--max-output-bytes']]) {
      const wrong = spawnSync(process.execPath, [cli, command!, path, flag!, '128'], { encoding: 'utf8', timeout: 5_000 });
      assert.equal(wrong.status, 2); assert.match(wrong.stderr, /only supported/);
    }
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const suite = join(root, 'suite.json'), subject = join(root, 'subject.json'), runtime = join(root, 'runtime.json');
    await writeFile(suite, JSON.stringify({ schema: 'craft-eval.eval.v1', suite_id: 'cli-output', subject_kind: 'software', partition: 'development', sanitized: true, cases: [{ id: 'one', argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(4096))"], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }] }));
    await writeFile(subject, JSON.stringify({ kind: 'software', id: 'cli-output', version: '1' }));
    await writeFile(runtime, JSON.stringify(Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map(key => [key, 'fixed']))));
    const run = spawnSync(process.execPath, [cli, 'run', suite, subject, runtime, '--workspace', workspace, '--output', join(root, 'out'), '--max-output-bytes', '128', '--fail-on-failed'], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(run.status, 1, run.stderr); assert.equal(JSON.parse(run.stdout).report.results[0].issue, 'output_limit');
  } finally { await rm(root, { recursive: true, force: true }); }
});
