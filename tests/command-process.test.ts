import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawnManagedCommand } from '../src/command-process.js';

test('guardian preserves stdin and command environment without preloading target NODE_OPTIONS itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-command-stdio-'));
  try {
    const preload = join(root, 'preload.mjs'), count = join(root, 'preloads');
    await writeFile(preload, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(count)},'x');process.env.PRELOADED='yes';`);
    const child = spawnManagedCommand(process.execPath, ['-e', "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',value=>text+=value);process.stdin.on('end',()=>console.log(JSON.stringify({text,custom:process.env.CUSTOM,preloaded:process.env.PRELOADED})));"], { cwd: root,
      env: { PATH: process.env.PATH, CUSTOM: 'exact custom value', NODE_OPTIONS: '--import=' + pathToFileURL(preload).href }, stdio: ['pipe', 'pipe', 'pipe'] }, process.execPath);
    const errors: Error[] = []; let stdout = '', stderr = '';
    child.on('error', error => errors.push(error)); child.stdout!.on('data', value => stdout += value); child.stderr!.on('data', value => stderr += value);
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    child.stdin!.end('中文 input\n');
    assert.equal(await closed, 0, stderr); assert.deepEqual(errors, []);
    assert.deepEqual(JSON.parse(stdout), { text: '中文 input\n', custom: 'exact custom value', preloaded: 'yes' });
    assert.equal(await readFile(count, 'utf8'), 'x');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing managed command retains its original spawn error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-command-missing-'));
  try {
    const child = spawnManagedCommand(join(root, 'missing-executable'), [], { cwd: root, env: {}, stdio: ['ignore', 'ignore', 'ignore'] }, process.execPath);
    const errors: NodeJS.ErrnoException[] = []; child.on('error', error => errors.push(error));
    await new Promise(resolve => child.once('close', resolve));
    assert.equal(errors[0]?.code, 'ENOENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a command terminating by signal is never converted to a successful exit', { skip: process.platform === 'win32' }, async () => {
  const child = spawnManagedCommand(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"], { cwd: process.cwd(), env: {}, stdio: ['ignore', 'ignore', 'ignore'] }, process.execPath);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: null, signal: 'SIGTERM' });
});

test('a failed guardian launch never masquerades as a command exit', { skip: process.platform === 'win32' }, async () => {
  const child = spawnManagedCommand(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd(), env: {}, stdio: ['ignore', 'ignore', 'ignore'] }, '/usr/bin/false');
  const errors: Error[] = []; child.on('error', error => errors.push(error));
  await new Promise(resolve => child.once('close', resolve));
  assert.ok(errors.length > 0, 'exit status alone is not an execution receipt');
});
