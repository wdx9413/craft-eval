import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareRuns, reportRun, runSuite, type RunOptions } from '../src/evaluation.js';

test('actual legacy package reports stay readable but cannot assert unrecorded execution conditions', async () => {
  const directory = fileURLToPath(new URL('../../tests/fixtures/legacy-execution-controls/', import.meta.url));
  const producer = JSON.parse(await readFile(join(directory, 'producer.json'), 'utf8'));
  for (const [file, digest] of Object.entries(producer.sha256)) assert.equal(createHash('sha256').update(await readFile(join(directory, file))).digest('hex'), digest);
  const baseline = join(directory, 'baseline');
  const candidate = fileURLToPath(new URL('../../tests/fixtures/legacy-execution-controls/candidate', import.meta.url));
  assert.equal((await reportRun(baseline)).passed, 1); assert.equal((await reportRun(candidate)).passed, 1);
  await assert.rejects(compareRuns(baseline, candidate), /execution controls/);
});

test('comparisons bind actual execution controls and keep legacy reports readable without inventing budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-controls-binding-')), workspace = join(root, 'workspace'); await mkdir(workspace);
  try {
    const paths = [join(root, 'suite.json'), join(root, 'subject.json'), join(root, 'runtime.json'), workspace, join(root, 'out')] as const;
    await writeFile(paths[0], JSON.stringify({ schema: 'craft-eval.eval.v1', suite_id: 'actual-controls', subject_kind: 'software', partition: 'development', sanitized: true, cases: [{ id: 'one', argv: [process.execPath, '-e', 'process.exit(0)'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }] }));
    await writeFile(paths[1], JSON.stringify({ kind: 'software', id: 'controls', version: '1' }));
    await writeFile(paths[2], JSON.stringify(Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map(key => [key, 'same-caller-label']))));
    const baseline = await runSuite(...paths), candidate = await runSuite(...paths);
    const leftPath = join(baseline, 'plan.json'), rightPath = join(candidate, 'plan.json');
    const left = JSON.parse(await readFile(leftPath, 'utf8')), right = JSON.parse(await readFile(rightPath, 'utf8'));
    const expected = { schema: 'craft-eval.execution-controls.v1', max_output_bytes: 8 * 1024 * 1024, parallelism: 1, workspace_mode: 'isolated', fail_fast: false, keep_traces: false };
    assert.deepEqual(left.execution_controls, expected); await assert.doesNotReject(compareRuns(baseline, candidate));
    const numeric = await runSuite(...paths, 2);
    assert.equal((await reportRun(numeric)).expected, 2);
    assert.deepEqual(JSON.parse(await readFile(join(numeric, 'plan.json'), 'utf8')).execution_controls, expected);
    const mutableSuite = JSON.parse(await readFile(paths[0], 'utf8'));
    mutableSuite.cases = ['first', 'second'].map(id => ({ id, argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(64))"], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }));
    const mutationPath = join(root, 'mutation-suite.json'); await writeFile(mutationPath, JSON.stringify(mutableSuite));
    const options: RunOptions = { max_output_bytes: 128, on_progress: () => { options.max_output_bytes = 1; } };
    const immutable = await runSuite(mutationPath, paths[1], paths[2], paths[3], paths[4], options);
    assert.equal(options.max_output_bytes, 1); assert.equal((await reportRun(immutable)).passed, 2);
    assert.equal(JSON.parse(await readFile(join(immutable, 'plan.json'), 'utf8')).execution_controls.max_output_bytes, 128);
    const different = await runSuite(...paths, { max_output_bytes: 128, parallelism: 2, keep_traces: true });
    const changed = JSON.parse(await readFile(join(different, 'plan.json'), 'utf8'));
    assert.deepEqual(changed.execution_controls, { ...expected, max_output_bytes: 128, parallelism: 2, keep_traces: true });
    await assert.rejects(compareRuns(baseline, different), /execution controls/);
    const shared = await runSuite(...paths, { workspace_mode: 'shared', parallelism: 4, fail_fast: true });
    assert.deepEqual(JSON.parse(await readFile(join(shared, 'plan.json'), 'utf8')).execution_controls, { ...expected, workspace_mode: 'shared', parallelism: 1, fail_fast: true });
    await assert.rejects(compareRuns(baseline, shared), /execution controls/);
    const invalid = [undefined, null, [], {}, { ...expected, schema: 'unknown' }, { ...expected, max_output_bytes: 1.5 }, { ...expected, max_output_bytes: 0 }, { ...expected, parallelism: 1.5 }, { ...expected, parallelism: 0 }, { ...expected, parallelism: 9 }, { ...expected, workspace_mode: 'unknown' }, { ...expected, fail_fast: 'false' }, { ...expected, keep_traces: 'false' }];
    for (const execution_controls of invalid) {
      await writeFile(leftPath, JSON.stringify({ ...left, execution_controls }));
      await assert.rejects(compareRuns(baseline, candidate), /execution controls/);
    }
    await writeFile(leftPath, JSON.stringify(left));
    await writeFile(rightPath, JSON.stringify({ ...right, execution_controls: undefined }));
    await assert.rejects(compareRuns(baseline, candidate), /execution controls/);
    await writeFile(leftPath, JSON.stringify({ ...left, execution_controls: undefined }));
    await assert.rejects(compareRuns(baseline, candidate), /execution controls/);
    assert.equal((await reportRun(baseline)).passed, 1, 'legacy reading does not imply comparable controls');
  } finally { await rm(root, { recursive: true, force: true }); }
});
