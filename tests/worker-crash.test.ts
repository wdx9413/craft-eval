import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function running(pid: number): boolean {
  const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

for (const role of ['adapter', 'probe', 'calibration']) {
test(`${role} evaluator SIGKILL does not leave its active command or descendant alive`, { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-worker-crash-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const identity = join(root, 'owned-processes.json');
  const marker = 'CRAFT_EVAL_CRASH_ADAPTER';
  const paths = [join(root, 'suite.json'), join(root, 'subject.json'), join(root, 'runtime.json'), workspace, join(root, 'out')];
  const adapter = join(workspace, 'adapter.mjs');
  await writeFile(adapter, `#!/usr/bin/env node
import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
process.title=${JSON.stringify(marker)};const child=spawn(process.execPath,['-e',"process.title='CRAFT_EVAL_CRASH_DESCENDANT';setInterval(()=>{},1000)"],{stdio:'ignore'});
writeFileSync(${JSON.stringify(identity)},JSON.stringify({adapter:process.pid,descendant:child.pid}));setInterval(()=>{},1000);`);
  await chmod(adapter, 0o755);
  await writeFile(paths[0]!, JSON.stringify({ schema: 'craft-eval.eval.v1', suite_id: 'worker-crash', subject_kind: 'software', partition: 'development', sanitized: true, cases: [{ id: 'one', argv: [process.execPath, 'adapter.mjs'], ...(role === 'probe' ? { requires: { commands: [adapter] } } : {}), timeout_s: 30, checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }] }));
  await writeFile(paths[1]!, JSON.stringify({ kind: 'software', id: 'crash', version: '1' }));
  await writeFile(paths[2]!, JSON.stringify(Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map(key => [key, 'fixed']))));
  const runner = join(root, 'runner.mjs');
  const calibration = join(root, 'calibration.json');
  await writeFile(calibration, JSON.stringify({ command: [process.execPath, adapter], repeats: 1, samples: [{ id: 'one', answer: 'answer.md', expected: 'passed' }] }));
  await writeFile(runner, role === 'calibration'
    ? `import {calibrateJudge} from ${JSON.stringify(new URL('../src/calibration.js', import.meta.url).href)};await calibrateJudge(${JSON.stringify(calibration)});`
    : `import {runSuite} from ${JSON.stringify(new URL('../src/evaluation.js', import.meta.url).href)};await runSuite(...${JSON.stringify(paths)});`);
  const evaluator = spawn(process.execPath, [runner], { stdio: 'ignore' });
  const exited = new Promise(resolve => evaluator.once('exit', resolve));
  let owned: { adapter: number; descendant: number } | undefined;
  try {
    const readyBy = Date.now() + 5_000;
    while (Date.now() < readyBy) {
      try { owned = JSON.parse(await readFile(identity, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(owned, 'command did not start');
    assert.equal(running(owned.adapter), true); assert.equal(running(owned.descendant), true);
    evaluator.kill('SIGKILL'); await exited;
    const stoppedBy = Date.now() + 2_000;
    while ((running(owned.adapter) || running(owned.descendant)) && Date.now() < stoppedBy) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(running(owned.adapter), false, 'adapter survived evaluator SIGKILL');
    assert.equal(running(owned.descendant), false, 'descendant survived evaluator SIGKILL');
  } finally {
    evaluator.kill('SIGKILL'); await exited;
    if (owned) {
      const command = spawnSync('ps', ['-p', String(owned.adapter), '-o', 'command='], { encoding: 'utf8' }).stdout;
      if (command.includes(marker)) try { process.kill(-owned.adapter, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});
}
