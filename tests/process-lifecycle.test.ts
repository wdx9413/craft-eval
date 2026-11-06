import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import childProcess, { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { reportRun, runSuite } from '../src/evaluation.js';

const marker = 'CRAFT_EVAL_DESCENDANT_TEST';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  // A terminated process can briefly remain as a zombie before the OS reaps it.
  const status = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  return status !== '' && !status.startsWith('Z');
}

test('judge output already buffered after its limit is ignored without a second settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-judge-buffer-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  mock.method(childProcess, 'fork', (() => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter(),
      send(message: { args: string[] }, callback: (error: Error | null) => void) {
        process.nextTick(() => {
          callback(null);
          if (message.args.includes('judge.mjs')) {
            child.stderr.emit('data', Buffer.from('diagnostic'));
            child.stdout.emit('data', Buffer.alloc(1024, 'x'));
            child.stderr.emit('data', Buffer.from('late buffered diagnostic'));
          }
          child.emit('message', { type: 'command-exit', code: 0, signal: null }); child.emit('exit', 0); child.emit('close', 0);
        });
      } });
    return child;
  }) as unknown as typeof childProcess.fork);
  syncBuiltinESMExports();
  try {
    await writeFile(join(workspace, 'answer.txt'), 'answer');
    const suite = { schema: 'craft-eval.eval.v1', suite_id: 'judge-buffer', subject_kind: 'software', partition: 'held_out', sanitized: true, approved_by: 'test', cases: [{ id: 'one', argv: [process.execPath, '-e', 'void 0'], checks: [{ id: 'grade', kind: 'model_graded', command: [process.execPath, 'judge.mjs'], answer: 'answer.txt' }] }] };
    const runtime = Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map(key => [key, 'fixed']));
    for (const [name, value] of Object.entries({ suite, subject: { kind: 'software', id: 'judge-buffer', version: '1' }, runtime })) await writeFile(join(root, name + '.json'), JSON.stringify(value));
    const run = await runSuite(join(root, 'suite.json'), join(root, 'subject.json'), join(root, 'runtime.json'), workspace, join(root, 'runs'), { max_output_bytes: 128 });
    const check = (await reportRun(run)).results[0]!.checks[0]!;
    assert.equal(check.evidence.issue, 'output_limit');
    assert.equal(check.evidence.judge_stderr_tail, 'diagnostic');
    assert.equal(check.passed, null);
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

async function untilStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (running(pid) && Date.now() < deadline) await pause(20);
  assert.equal(running(pid), false, 'completed evaluation left its descendant running');
}

for (const role of ['adapter', 'script', 'judge'] as const) {
  for (const inheritedPipes of [false, true]) {
    for (const mode of ['exit', ...(!inheritedPipes ? ['cancel', 'timeout'] : []), ...(role === 'judge' && !inheritedPipes ? ['output_limit'] : [])]) {
    test(`${role} ${mode} cleans descendants with ${inheritedPipes ? 'inherited' : 'closed'} output pipes`, { skip: process.platform === 'win32' }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'craft-eval-process-'));
      const workspace = join(root, 'workspace'); await mkdir(workspace);
      const pidPath = join(root, 'descendant.pid');
      try {
        const source = `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',${JSON.stringify(`process.title='${marker}';setInterval(()=>{},1000)`)}],{stdio:${JSON.stringify(inheritedPipes ? ['ignore', 'inherit', 'inherit'] : 'ignore')}});
writeFileSync(${JSON.stringify(pidPath)},String(child.pid));child.unref();
${role === 'judge' ? "console.log(JSON.stringify({score:1}));" : ''}
${mode === 'output_limit' ? "process.stdout.write('x'.repeat(1024*1024));process.stderr.write('y'.repeat(1024*1024));setInterval(()=>{},1000);" : mode === 'exit' ? '' : 'setInterval(()=>{},1000);'}
`;
        await writeFile(join(workspace, 'background.mjs'), source);
        await writeFile(join(workspace, 'host.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('answer.txt','answer');");
        const checks = role === 'script' ? [{ id: 'grade', kind: 'script', path: 'background.mjs' }]
          : role === 'judge' ? [{ id: 'grade', kind: 'model_graded', command: [process.execPath, 'background.mjs'], answer: 'answer.txt', threshold: 1 }]
            : [{ id: 'exit', kind: 'exit_code', equals: 0 }];
        const suite = { schema: 'craft-eval.eval.v1', suite_id: 'lifecycle', subject_kind: 'software', partition: 'held_out', sanitized: true, approved_by: 'test', cases: [{ id: 'one', argv: [process.execPath, role === 'adapter' ? 'background.mjs' : 'host.mjs'], timeout_s: 1.5, checks }] };
        const runtime = Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map(key => [key, 'fixed']));
        for (const [name, value] of Object.entries({ suite, subject: { kind: 'software', id: 'lifecycle', version: '1' }, runtime })) await writeFile(join(root, name + '.json'), JSON.stringify(value));
        const controller = new AbortController();
        const timer = mode === 'cancel' ? setInterval(() => { if (existsSync(pidPath)) controller.abort(); }, 5) : undefined;
        let run: string;
        try {
          run = await runSuite(join(root, 'suite.json'), join(root, 'subject.json'), join(root, 'runtime.json'), workspace, join(root, 'runs'), { signal: controller.signal, ...(mode === 'output_limit' ? { max_output_bytes: 128 } : {}) });
        } finally { clearInterval(timer); }
        const result = (await reportRun(run)).results[0]!;
        const pid = Number(await readFile(pidPath, 'utf8'));
        await untilStopped(pid);
        if (mode === 'exit') {
          assert.equal(result.verdict, 'passed', JSON.stringify(result));
          assert.equal(result.issue, null);
        } else {
          assert.notEqual(result.verdict, 'passed');
          if (mode === 'cancel') assert.equal(controller.signal.aborted, true);
          else if (mode === 'output_limit' || role !== 'adapter') assert.equal(result.checks[0]?.evidence.issue, mode === 'output_limit' ? 'output_limit' : 'timeout');
          else assert.equal(result.issue, 'timeout');
        }
      } finally {
        // Cleanup a regression's orphan only when its fresh PID still belongs to this fixture.
        try {
          const pid = Number(await readFile(pidPath, 'utf8'));
          const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout;
          if (command.includes(marker)) process.kill(pid, 'SIGKILL');
        } catch { /* The evaluator already cleaned it. */ }
        await rm(root, { recursive: true, force: true });
      }
    });
    }
  }
}
