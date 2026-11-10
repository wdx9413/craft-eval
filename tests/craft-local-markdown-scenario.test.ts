import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadScenario, runScenario } from '../src/scenario.js';

test('fixed Craft local Markdown case checks source attribution, verification, and omissions', async () => {
  const fixture = join(process.cwd(), 'examples/real-world/craft-local-markdown');
  const root = await mkdtemp(join(tmpdir(), 'craft-local-markdown-eval-'));
  const workspace = join(root, 'workspace');
  await cp(join(fixture, 'workspace'), workspace, { recursive: true });
  try {
    await writeFile(join(workspace, 'host.mjs'), `
      import { readFile, mkdir, writeFile } from 'node:fs/promises';
      import { stdin } from 'node:process';
      let prompt = ''; stdin.setEncoding('utf8'); stdin.on('data', chunk => prompt += chunk);
      stdin.on('end', async () => {
        const source = await readFile('materials/prices.md', 'utf8');
        if (!prompt.includes('Do not claim completion') || !source.includes('Atlas')) process.exit(2);
        await mkdir('deliverables', { recursive: true });
        await writeFile('deliverables/price-comparison.md', '| Product | Price | Source |\\n| --- | ---: | --- |\\n| Atlas | 29 | materials/prices.md |\\n| Beacon | 35 | materials/prices.md |\\n');
        await writeFile('deliverables/task-report.md', 'Executed the comparison. Checked both prices against materials/prices.md. Omissions: none.');
        process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');
      });
    `, 'utf8');
    const subject = join(root, 'subject.json');
    const runtime = join(root, 'runtime.json');
    await writeFile(subject, JSON.stringify({ kind: 'agent', id: 'fixture-agent', version: '1',
      host: { kind: 'codex', binary: process.execPath, args_prefix: ['host.mjs'] } }));
    await writeFile(runtime, JSON.stringify({ environment_digest: 'test', budget_digest: 'test', host_digest: 'test', model_digest: 'test', tools_digest: 'test' }));
    const scenario = await loadScenario(join(fixture, 'scenario.json'));
    const result = await runScenario(scenario, { subject, runtime, workspace, output: join(root, 'out') });
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.completed_step, 'deliver-markdown');
    assert.equal(result.report.results[0]?.checks.every((check) => check.passed), true);
    assert.equal(await readFile(join(workspace, 'materials/prices.md'), 'utf8').then((text) => text.includes('synthetic')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
