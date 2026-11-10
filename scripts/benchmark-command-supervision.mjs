import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnManagedCommand, stopManagedCommand } from '../dist/src/command-process.js';

const pairs = Number(process.argv[2] ?? 30);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 200) throw new Error('pairs must be within 1..200');
const samples = { direct: [], supervised: [] };
const options = { cwd: process.cwd(), env: { PATH: process.env.PATH, LANG: process.env.LANG }, stdio: ['ignore', 'pipe', 'pipe'] };
async function observe(mode) {
  const before = performance.now(), args = ['-e', "process.stdout.write('ok')"];
  const child = mode === 'supervised' ? spawnManagedCommand(process.execPath, args, options, process.execPath)
    : spawn(process.execPath, args, { ...options, detached: process.platform !== 'win32', windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (mode === 'supervised') stopManagedCommand(child.pid);
      else if (child.pid) try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      reject(new Error('Benchmark command timed out'));
    }, 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  if (result.code !== 0 || result.signal !== null || stdout !== 'ok') throw new Error('Benchmark command failed: ' + stderr);
  return performance.now() - before;
}
await observe('direct'); await observe('supervised');
for (let pair = 0; pair < pairs; pair++) {
  for (const mode of pair % 2 ? ['supervised', 'direct'] : ['direct', 'supervised']) samples[mode].push(await observe(mode));
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summarize = values => ({ count: values.length, p50_ms: percentile(values, .5), p95_ms: percentile(values, .95), max_ms: Math.max(...values) });
const files = ['command-process.js', 'command-guardian.js', 'command-guardian-entry.js'];
console.log(JSON.stringify({ schema_version: 1, observed_at: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version,
  method: 'One warmup per mode, then alternating order in sequential pairs; empty Node command with exact output and exit checks; no V8 coverage.',
  limitation: 'Subprocess startup only; excludes evaluation setup, real task duration and native desktop. Local observations are not an SLO or a production percentile.',
  direct: summarize(samples.direct), supervised: summarize(samples.supervised), samples,
  compiled_sha256: Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(new URL('../dist/src/' + file, import.meta.url))).digest('hex')]))),
}, null, 2));
