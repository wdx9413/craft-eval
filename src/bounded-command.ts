import { spawnManagedCommand, stopManagedCommand, evaluationNodeBinary } from './command-process.js';

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout_ms: number;
  max_output_bytes: number;
  signal?: AbortSignal;
  capture?: boolean;
}
export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  issue: 'timeout' | 'cancelled' | 'output_limit' | 'spawn_error' | null;
  error?: NodeJS.ErrnoException;
  stdout: Buffer;
  stderr: Buffer;
}

/** One monitored lifetime, with bounded capture and cancellable wall-clock time. */
export async function runBoundedCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const control = Object.freeze({ ...options });
  control.signal?.throwIfAborted();
  if (!Number.isSafeInteger(control.timeout_ms) || control.timeout_ms < 1 || control.timeout_ms > 2_147_483_647) throw new Error('timeout_ms must be an integer within 1..2147483647');
  if (!Number.isSafeInteger(control.max_output_bytes) || control.max_output_bytes < 1) throw new Error('max_output_bytes must be a positive safe integer');
  return new Promise(resolve => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, settled = false;
    const capture = control.capture !== false;
    const child = spawnManagedCommand(command, args, { cwd: control.cwd, env: control.env,
      stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore'] }, evaluationNodeBinary());
    const finish = (status: number | null, signal: NodeJS.Signals | null, issue: CommandResult['issue'], error?: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); control.signal?.removeEventListener('abort', abort);
      if (issue !== null) stopManagedCommand(child.pid);
      resolve({ status, signal, issue, error, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const abort = (): void => finish(null, null, 'cancelled');
    const timer = setTimeout(() => finish(null, null, 'timeout'), control.timeout_ms);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      target.push(chunk.subarray(0, Math.max(0, control.max_output_bytes - bytes))); bytes += chunk.length;
      if (bytes > control.max_output_bytes) finish(null, null, 'output_limit');
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk)); child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', error => finish(null, null, 'spawn_error', error));
    child.once('close', (status, signal) => finish(status, signal, null));
    control.signal?.addEventListener('abort', abort, { once: true });
    if (control.signal?.aborted) abort();
  });
}
