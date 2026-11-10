import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test, { mock } from 'node:test';
import { runBoundedCommand } from '../src/bounded-command.js';

test('bounded commands preserve results, cap combined output and settle only once', async () => {
  let mode = 'normal', racingAbort: AbortController | undefined;
  mock.method(childProcess, 'fork', (() => {
    const child = Object.assign(new EventEmitter(), { pid: 700, connected: true, stdout: new EventEmitter(), stderr: new EventEmitter(),
      disconnect() { this.connected = false; child.emit('close', 1, null); },
      send(_message: unknown, callback: (error: Error | null) => void) {
        racingAbort?.abort();
        process.nextTick(() => {
          callback(null);
          if (mode === 'timeout' || mode === 'cancel') return;
          if (mode === 'error') { child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); return; }
          child.stdout.emit('data', Buffer.from('out')); child.stderr.emit('data', Buffer.from('err'));
          if (mode === 'flood') { child.stdout.emit('data', Buffer.alloc(200, 'x')); child.stderr.emit('data', Buffer.from('late')); }
          child.emit('message', { type: 'command-exit', code: 3, signal: null }); child.emit('close', 3, null);
        });
      } });
    return child;
  }) as unknown as typeof childProcess.fork);
  syncBuiltinESMExports();
  const options = { cwd: process.cwd(), env: {}, timeout_ms: 100, max_output_bytes: 128 };
  try {
    let result = await runBoundedCommand('owned', [], options);
    assert.equal(result.status, 3); assert.equal(result.issue, null); assert.equal(result.stdout.toString(), 'out'); assert.equal(result.stderr.toString(), 'err');
    mode = 'flood'; result = await runBoundedCommand('owned', [], options);
    assert.equal(result.issue, 'output_limit'); assert.equal(result.stdout.length + result.stderr.length, 128);
    mode = 'error'; result = await runBoundedCommand('owned', [], options);
    assert.equal(result.issue, 'spawn_error'); assert.equal(result.error?.code, 'ENOENT');
    mode = 'timeout'; result = await runBoundedCommand('owned', [], { ...options, timeout_ms: 1 }); assert.equal(result.issue, 'timeout');
    mode = 'cancel'; racingAbort = new AbortController(); result = await runBoundedCommand('owned', [], { ...options, signal: racingAbort.signal }); assert.equal(result.issue, 'cancelled');
    racingAbort = undefined;
    const controller = new AbortController(), pending = runBoundedCommand('owned', [], { ...options, signal: controller.signal });
    controller.abort(); assert.equal((await pending).issue, 'cancelled');
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test('bounded commands validate budgets and reject pre-aborted execution without spawning', async () => {
  const options = { cwd: process.cwd(), env: {}, timeout_ms: 100, max_output_bytes: 128 };
  for (const timeout_ms of [0, 1.5, Infinity, 2_147_483_648]) await assert.rejects(runBoundedCommand('unused', [], { ...options, timeout_ms }), /timeout_ms/);
  for (const max_output_bytes of [0, 1.5, Infinity]) await assert.rejects(runBoundedCommand('unused', [], { ...options, max_output_bytes }), /max_output_bytes/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runBoundedCommand('unused', [], { ...options, signal: controller.signal }), /abort/i);
});

test('silent managed commands discard diagnostics while preserving command availability', async () => {
  const result = await runBoundedCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096));process.exit(3)"], { cwd: process.cwd(), env: {}, timeout_ms: 2_000, max_output_bytes: 1, capture: false });
  assert.equal(result.status, 3); assert.equal(result.issue, null); assert.equal(result.stdout.length + result.stderr.length, 0);
});
