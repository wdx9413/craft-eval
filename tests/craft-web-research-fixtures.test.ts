import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadScenario, runScenario } from '../src/scenario.js';

test('public web research synthetic fixtures cover required report outcomes without networking', async () => {
  const path = join(process.cwd(), 'examples/real-world/craft-web-research/workspace/cases.json');
  const fixture = JSON.parse(await readFile(path, 'utf8')) as {
    schema: string;
    suite_id: string;
    execution_mode: string;
    limitations: string[];
    cases: Array<{
      id: string;
      input: string;
      observations: Array<{ source_id: string; url: string; accessed_at: string; content_digest: string; text: string }>;
      access_error?: string;
      expected_sections: string[];
      forbidden_claims: string[];
    }>;
  };
  assert.equal(fixture.schema, 'craft-eval.web-research-fixtures.v1');
  assert.equal(fixture.suite_id, 'craft-public-web-research');
  assert.equal(fixture.execution_mode, 'synthetic_only');
  assert.deepEqual(fixture.cases.map((item) => item.id), [
    'normal-sourced-facts', 'source-conflict', 'missing-promotion-conditions',
    'prompt-injection-is-untrusted', 'access-failure', 'partial-delivery',
  ]);
  assert.equal(fixture.limitations.length, 2);
  for (const item of fixture.cases) {
    assert.ok(item.input.length > 0, item.id);
    assert.ok(item.expected_sections.length > 0, item.id);
    assert.ok(item.forbidden_claims.length > 0, item.id);
    for (const source of item.observations) {
      assert.match(source.url, /^https:\/\//u, item.id);
      assert.match(source.accessed_at, /^\d{4}-\d\d-\d\dT/u, item.id);
      assert.match(source.content_digest, /^sha256:/u, item.id);
    }
  }
  assert.equal(fixture.cases.find((item) => item.id === 'access-failure')?.access_error, 'public page request timed out');
  assert.equal(fixture.cases.find((item) => item.id === 'source-conflict')?.observations.length, 2);
  assert.equal(fixture.cases.find((item) => item.id === 'access-failure')?.observations.length, 0);
});

test('six fixed web research outcomes pass the normal Craft-Eval shared-workspace scenario runner', async () => {
  const fixture = join(process.cwd(), 'examples/real-world/craft-web-research');
  const root = await mkdtemp(join(tmpdir(), 'craft-public-web-eval-'));
  const workspace = join(root, 'workspace');
  await cp(join(fixture, 'workspace'), workspace, { recursive: true });
  try {
    const subject = join(root, 'subject.json');
    const runtime = join(root, 'runtime.json');
    await writeFile(subject, JSON.stringify({ kind: 'agent', id: 'synthetic-web-fixture', version: '1',
      host: { kind: 'codex', binary: process.execPath, args_prefix: ['host.mjs'] } }));
    await writeFile(runtime, JSON.stringify({ environment_digest: 'synthetic-only', budget_digest: 'synthetic-only',
      host_digest: 'fake-host', model_digest: 'none', tools_digest: 'none' }));
    const scenario = await loadScenario(join(fixture, 'scenario.json'));
    const result = await runScenario(scenario, { subject, runtime, workspace, output: join(root, 'out') });
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.completed_step, 'partial-delivery');
    assert.equal(result.report.results.length, 6);
    assert.equal(result.report.results.every((item) => item.checks.every((check) => check.passed)), true);
    assert.ok(await readFile(result.report_path, 'utf8').then((report) => report.includes('"status": "passed"')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
