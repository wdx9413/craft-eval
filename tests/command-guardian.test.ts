import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test, { mock } from 'node:test';
import { startCommandGuardian, terminateCommandTree } from '../src/command-guardian.js';
import { spawnManagedCommand, stopManagedCommand, evaluationNodeBinary } from '../src/command-process.js';

function host(connected = true) {
  const killed: unknown[][] = [], sent: unknown[] = [];
  const channel = Object.assign(new EventEmitter(), { connected, pid: 400, exitCode: undefined as number | undefined,
    disconnect(this: EventEmitter & { connected: boolean }) { this.connected = false; this.emit('disconnect'); },
    kill(...args: unknown[]) { killed.push(args); return true; },
    send(message: unknown, callback: () => void) { sent.push(message); callback(); },
  });
  return { channel, killed, sent };
}
const start = { type: 'start', command: 'owned', args: ['arg'], cwd: '/workspace', env: { CUSTOM: 'value' } };

test('Node discovery preserves explicit overrides and Electron fallback without launching the wrapper', () => {
  const savedNode = process.env.CRAFT_EVAL_NODE_BINARY, savedPath = process.env.PATH, electron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  mock.method(fs, 'existsSync', () => true); syncBuiltinESMExports();
  try {
    process.env.CRAFT_EVAL_NODE_BINARY = '/explicit/node'; assert.equal(evaluationNodeBinary(), '/explicit/node');
    delete process.env.CRAFT_EVAL_NODE_BINARY; assert.equal(evaluationNodeBinary(), process.execPath);
    Object.defineProperty(process.versions, 'electron', { value: 'test-wrapper', configurable: true });
    process.env.PATH = ';/DSH Desktop/bin;/real/bin'; assert.equal(evaluationNodeBinary(), join('/real/bin', 'node.exe'));
    process.env.PATH = ';'; assert.equal(evaluationNodeBinary(), process.execPath);
    delete process.env.PATH; assert.equal(evaluationNodeBinary(), process.execPath);
    mock.restoreAll(); mock.method(fs, 'existsSync', () => false); syncBuiltinESMExports();
    process.env.PATH = '/missing/bin'; assert.equal(evaluationNodeBinary(), process.execPath);
  } finally {
    if (savedNode === undefined) delete process.env.CRAFT_EVAL_NODE_BINARY; else process.env.CRAFT_EVAL_NODE_BINARY = savedNode;
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (electron) Object.defineProperty(process.versions, 'electron', electron); else delete process.versions.electron;
    mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('guardian launches once, preserves nonzero exit and clears only its owned child', () => {
  const { channel } = host(), child = Object.assign(new EventEmitter(), { pid: 600 });
  const launched: unknown[][] = [], terminated: unknown[] = [];
  startCommandGuardian(channel as unknown as NodeJS.Process, ((...args: unknown[]) => { launched.push(args); return child; }) as typeof childProcess.spawn, pid => terminated.push(pid));
  channel.emit('message', { type: 'other' }); channel.emit('message', start); channel.emit('message', start);
  assert.equal(launched.length, 1); assert.deepEqual(launched[0]!.slice(0, 2), ['owned', ['arg']]);
  assert.deepEqual((launched[0]![2] as { env: object }).env, start.env);
  child.emit('exit', 7, null); channel.emit('SIGTERM');
  assert.equal(channel.exitCode, 7); assert.deepEqual(terminated, [600]); assert.equal(channel.connected, false);
});

test('guardian cannot launch after losing its owner, including before module initialization', () => {
  for (const preDisconnected of [false, true]) {
    const { channel } = host(!preDisconnected), terminated: unknown[] = [];
    startCommandGuardian(channel as unknown as NodeJS.Process, (() => { throw new Error('must not launch'); }) as typeof childProcess.spawn, pid => terminated.push(pid));
    if (!preDisconnected) channel.disconnect();
    channel.emit('message', start);
    assert.equal(channel.exitCode, 1); assert.deepEqual(terminated, [undefined]);
  }
});

test('guardian relays launch errors, tolerates a lost error channel and retains signal exits', () => {
  for (const mode of ['async-error', 'sync-error', 'send-error', 'disconnected-error', 'signal', 'sigterm', 'sigint', 'null-code']) {
    const { channel, sent, killed } = host(), child = Object.assign(new EventEmitter(), { pid: 600 });
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (mode === 'send-error') channel.send = () => { throw new Error('channel gone'); };
    const launch = (() => { if (mode === 'sync-error') throw error; return child; }) as unknown as typeof childProcess.spawn;
    startCommandGuardian(channel as unknown as NodeJS.Process, launch, () => {});
    channel.emit('message', start);
    if (mode === 'disconnected-error') channel.connected = false;
    if (['async-error', 'send-error', 'disconnected-error'].includes(mode)) child.emit('error', error);
    else if (mode === 'signal') child.emit('exit', null, 'SIGTERM');
    else if (mode === 'sigterm') channel.emit('SIGTERM');
    else if (mode === 'sigint') channel.emit('SIGINT');
    else if (mode === 'null-code') child.emit('exit', null, null);
    if (mode === 'signal') { assert.deepEqual(killed, [[400, 'SIGTERM']]); assert.equal(channel.listenerCount('SIGTERM'), 0); }
    else assert.equal(channel.exitCode, mode === 'sigterm' ? 143 : mode === 'sigint' ? 130 : 1);
    if (['async-error', 'sync-error'].includes(mode)) assert.deepEqual(sent, [{ type: 'command-error', code: 'ENOENT', name: 'Error', message: 'missing' }]);
  }
});

test('process-tree termination handles POSIX, Windows taskkill fallback and an already exited owner', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const kills: unknown[][] = [], taskkills: unknown[][] = [];
  let failTaskkill = false, failKill = false;
  mock.method(process, 'kill', ((...args: unknown[]) => { kills.push(args); if (failKill) throw new Error('gone'); return true; }) as typeof process.kill);
  mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => { taskkills.push(args); if (failTaskkill) throw new Error('missing taskkill'); return {}; }) as unknown as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
    terminateCommandTree(undefined); terminateCommandTree(600);
    assert.deepEqual(kills, [[-600, 'SIGKILL']]);
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    terminateCommandTree(700); failTaskkill = true; failKill = true; terminateCommandTree(800);
    assert.deepEqual(kills.slice(1), [[700, 'SIGKILL'], [800, 'SIGKILL']]);
    assert.deepEqual(taskkills[0]!.slice(0, 2), ['taskkill', ['/PID', '700', '/T', '/F']]);
  } finally { Object.defineProperty(process, 'platform', descriptor); mock.restoreAll(); syncBuiltinESMExports(); }
});

test('managed command IPC never uses a stale PID and preserves startup and error details', async () => {
  let nextPid: number | undefined = 900, throwSend = false, callbackError = false;
  const children: Array<EventEmitter & { pid?: number; connected: boolean; disconnect(): void }> = [], requests: unknown[] = [], forks: unknown[][] = [];
  mock.method(childProcess, 'fork', ((...args: unknown[]) => {
    forks.push(args);
    const child = Object.assign(new EventEmitter(), { pid: nextPid, connected: true,
      disconnect() { this.connected = false; },
      send(message: unknown, callback: (error: Error | null) => void) { requests.push(message); if (throwSend) throw new Error('send threw'); const error = callbackError ? new Error('send failed') : null; process.nextTick(() => callback(error)); },
    });
    children.push(child); return child;
  }) as unknown as typeof childProcess.fork);
  syncBuiltinESMExports();
  try {
    const options = { cwd: '/workspace', env: { NODE_OPTIONS: '--import=target-only', CUSTOM: 'exact' }, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const child = spawnManagedCommand('owned', ['arg'], options, '/node');
    const errors: Error[] = []; child.on('error', error => errors.push(error));
    assert.equal(Object.hasOwn((forks[0]![2] as { env: object }).env, 'NODE_OPTIONS'), false);
    assert.deepEqual((requests[0] as { env: object }).env, options.env);
    child.emit('message', { type: 'ignored' }); child.emit('message', { type: 'command-error', code: 'ENOENT', name: 'LaunchError', message: 'missing' });
    assert.equal((errors[0] as NodeJS.ErrnoException).code, 'ENOENT'); assert.equal(errors[0]!.name, 'LaunchError');
    stopManagedCommand(undefined); stopManagedCommand(900); stopManagedCommand(900); assert.equal(children[0]!.connected, false);
    child.emit('close'); stopManagedCommand(900);
    nextPid = undefined; callbackError = true;
    const second = spawnManagedCommand('other', [], options, '/node'); second.on('error', error => errors.push(error));
    await new Promise(resolve => setImmediate(resolve)); second.emit('close');
    throwSend = true;
    const third: ChildProcess = spawnManagedCommand('last', [], options, '/node'); third.on('error', error => errors.push(error));
    await new Promise(resolve => setImmediate(resolve)); third.emit('close');
    assert.ok(errors.some(error => error.message === 'send failed')); assert.ok(errors.some(error => error.message === 'send threw'));
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});
