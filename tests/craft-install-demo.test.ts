import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadScenario, runScenario } from '../src/scenario.js';

test('fixed synthetic install lifecycle survives independent host processes without model or network claims', async () => {
  const fixture = join(process.cwd(), 'examples/real-world/craft-install-demo');
  const root = await mkdtemp(join(tmpdir(), 'craft-install-demo-'));
  const workspace = join(root, 'workspace');
  await cp(join(fixture, 'workspace'), workspace, { recursive: true });
  try {
    const subject = join(root, 'subject.json'), runtime = join(root, 'runtime.json');
    await writeFile(subject, JSON.stringify({ kind: 'agent', id: 'synthetic-install-demo', version: '1',
      host: { kind: 'codex', binary: process.execPath, args_prefix: ['host.mjs'] } }));
    await writeFile(runtime, JSON.stringify({ environment_digest: 'synthetic-only', budget_digest: 'synthetic-only',
      host_digest: 'fixture-host-no-model', model_digest: 'none', tools_digest: 'none' }));
    const scenario = await loadScenario(join(fixture, 'scenario.json'));
    const result = await runScenario(scenario, { subject, runtime, workspace, output: join(root, 'out') });
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.completed_step, 'undo-correction');
    assert.equal(result.report.results.length, 7);
    assert.equal(result.report.results.every(item => item.checks.every(check => check.passed)), true);
    const finalWorkspace = join(root, 'out', 'checkpoints', scenario.scenario_id, 'undo-correction');
    const document = await readFile(join(finalWorkspace, 'deliverables/comparison.md'), 'utf8');
    assert.match(document, /page-west/u);
    assert.match(document, /User edit: South has higher priority/u);
    const report = await readFile(result.report_path, 'utf8');
    assert.match(report, /craft-install-lifecycle-synthetic/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
