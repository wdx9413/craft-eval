import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { calibrateJudge, type CalibrationOptions } from '../src/calibration.js';
import { reportRun, runSuite } from '../src/evaluation.js';

const marker = 'CRAFT_EVAL_AUXILIARY';
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
function running(pid: number): boolean {
  const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  return !!state && !state.startsWith('Z');
}
async function fixture(code: string) {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-auxiliary-')), workspace = join(root, 'project'); await mkdir(workspace);
  const identity = join(root, 'owned.json'), starts = join(root, 'starts'), script = join(workspace, 'auxiliary.mjs');
  await writeFile(script, `#!/usr/bin/env node
import {spawn} from 'node:child_process';import {appendFileSync,writeFileSync} from 'node:fs';
process.title=${JSON.stringify(marker)};const child=spawn(process.execPath,['-e',"process.title='CRAFT_EVAL_AUX_DESC';setInterval(()=>{},1000)"],{stdio:'ignore'});child.unref();
appendFileSync(${JSON.stringify(starts)},'x');writeFileSync(${JSON.stringify(identity)},JSON.stringify({pid:process.pid,descendant:child.pid}));${code}
`);
  await chmod(script, 0o755);
  const manifest = join(root, 'calibration.json');
  await writeFile(manifest, JSON.stringify({ command: [process.execPath, script], repeats: 1, samples: [{ id: 'one', answer: 'answer.md', expected: 'passed' }] }));
  return { root, workspace, identity, starts, script, manifest };
}
async function ready(path: string): Promise<{ pid: number; descendant: number }> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { await pause(); } }
  throw new Error('auxiliary command did not start');
}
async function stopped(path: string): Promise<void> {
  const owned = await ready(path), deadline = Date.now() + 2_000;
  while ((running(owned.pid) || running(owned.descendant)) && Date.now() < deadline) await pause();
  assert.equal(running(owned.pid), false); assert.equal(running(owned.descendant), false);
}
async function cleanup(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  try {
    const owned = await ready(f.identity);
    for (const [pid, title] of [[owned.pid, marker], [owned.descendant, 'CRAFT_EVAL_AUX_DESC']] as const) {
      const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout;
      if (command.includes(title)) try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
  } catch { /* No command started. */ }
  await rm(f.root, { recursive: true, force: true });
}

for (const mode of ['success', 'timeout', 'output_limit', 'cancel']) {
  test(`calibration ${mode} is bounded, remains responsive and reaps descendants`, { skip: process.platform === 'win32' }, async () => {
    const code = mode === 'success' ? "console.log(JSON.stringify({score:1}));"
      : mode === 'output_limit' ? "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);"
        : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
    const f = await fixture(code), controller = new AbortController();
    try {
      if (mode === 'cancel') {
        const manifest = JSON.parse(await readFile(f.manifest, 'utf8')); manifest.repeats = 3; manifest.samples.push({ id: 'two', answer: 'answer.md', expected: 'passed' });
        await writeFile(f.manifest, JSON.stringify(manifest));
      }
      const pending = calibrateJudge(f.manifest, { signal: controller.signal, timeout_ms: mode === 'timeout' ? 500 : 3_000, max_output_bytes: 128 });
      if (mode === 'cancel') {
        const rejected = assert.rejects(pending, /abort/i);
        await ready(f.identity); controller.abort(); await rejected;
        assert.equal(await readFile(f.starts, 'utf8'), 'x', 'cancellation must not start another scoring attempt');
      } else {
        const report = await pending;
        assert.equal(report.accuracy, mode === 'success' ? 1 : null);
        assert.equal(report.per_sample[0]!.error, mode === 'success' ? null : mode);
      }
      await stopped(f.identity);
    } finally { controller.abort(); await cleanup(f); }
  });
}

test('calibration keeps one control snapshot across repeated scoring attempts', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture("import {existsSync} from 'node:fs';const waiting=setInterval(()=>{if(existsSync(GATE_PATH)){clearInterval(waiting);console.log(JSON.stringify({score:1}));}},5);");
  try {
    const gate = join(f.root, 'continue');
    await writeFile(f.script, (await readFile(f.script, 'utf8')).replace('GATE_PATH', JSON.stringify(gate)));
    const manifest = JSON.parse(await readFile(f.manifest, 'utf8')); manifest.repeats = 3; await writeFile(f.manifest, JSON.stringify(manifest));
    const options: CalibrationOptions = { timeout_ms: 3_000, max_output_bytes: 128 };
    const pending = calibrateJudge(f.manifest, options);
    await ready(f.identity); options.timeout_ms = 1; options.max_output_bytes = 1; await writeFile(gate, 'continue');
    const report = await pending; assert.deepEqual(report.per_sample[0]!.verdicts, ['passed', 'passed', 'passed']);
    assert.equal(await readFile(f.starts, 'utf8'), 'xxx'); await stopped(f.identity);
  } finally { await cleanup(f); }
});

test('requirement probes can be cancelled before the case executes', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"), controller = new AbortController();
  try {
    const suite = join(f.root, 'suite.json'), subject = join(f.root, 'subject.json'), runtime = join(f.root, 'runtime.json');
    const forbidden = join(f.root, 'must-not-run');
    await writeFile(suite, JSON.stringify({ schema: 'craft-eval.eval.v1', suite_id: 'probe', subject_kind: 'software', partition: 'development', sanitized: true, cases: [{ id: 'one', requires: { commands: [f.script] }, argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'x')`], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }] }));
    await writeFile(subject, JSON.stringify({ kind: 'software', id: 'probe', version: '1' }));
    await writeFile(runtime, JSON.stringify(Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map(key => [key, 'fixed']))));
    const pending = runSuite(suite, subject, runtime, f.workspace, join(f.root, 'out'), { signal: controller.signal });
    const rejected = assert.rejects(pending, /abort/i);
    await ready(f.identity); controller.abort(); await rejected;
    await assert.rejects(readFile(forbidden), /ENOENT/);
    await stopped(f.identity);
  } finally { controller.abort(); await cleanup(f); }
});

test('an existing version probe may exit nonzero without making its command unavailable', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('process.exit(3);');
  try {
    const suite = join(f.root, 'suite.json'), subject = join(f.root, 'subject.json'), runtime = join(f.root, 'runtime.json');
    await writeFile(suite, JSON.stringify({ schema: 'craft-eval.eval.v1', suite_id: 'probe-exit', subject_kind: 'software', partition: 'development', sanitized: true, cases: [{ id: 'one', requires: { commands: [f.script] }, argv: [process.execPath, '-e', 'process.exit(0)'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }] }));
    await writeFile(subject, JSON.stringify({ kind: 'software', id: 'probe', version: '1' }));
    await writeFile(runtime, JSON.stringify(Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map(key => [key, 'fixed']))));
    const report = await reportRun(await runSuite(suite, subject, runtime, f.workspace, join(f.root, 'out')));
    assert.equal(report.passed, 1); await stopped(f.identity);
  } finally { await cleanup(f); }
});
