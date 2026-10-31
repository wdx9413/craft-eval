import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type Options = { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore' | 'pipe', 'ignore' | 'pipe', 'ignore' | 'pipe']; signal?: AbortSignal };
const commands = new Map<number, { child: ChildProcess; stopped: boolean }>();

/** Closing this live IPC channel asks the independent guardian to reap its command. */
export function stopManagedCommand(pid: number | undefined): void {
  if (pid === undefined) return;
  const managed = commands.get(pid);
  if (managed) { managed.stopped = true; if (managed.child.connected) managed.child.disconnect(); }
}

/** Stdio stays in OS pipes; only the bounded startup message uses IPC. */
export function spawnManagedCommand(command: string, args: string[], options: Options, nodeExecutable: string): ChildProcess {
  const names = ['PATH', 'LANG', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'NODE_V8_COVERAGE'];
  const guardianEnv = Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  const child = fork(new URL('./command-guardian-entry.js', import.meta.url), [], {
    execPath: nodeExecutable, execArgv: [], env: guardianEnv, cwd: options.cwd,
    detached: process.platform !== 'win32', windowsHide: true, signal: options.signal,
    stdio: [...options.stdio, 'ipc'],
  });
  const pid = child.pid;
  const managed = { child, stopped: false };
  let terminal = false, errored = false;
  child.on('error', () => { errored = true; });
  if (pid !== undefined) commands.set(pid, managed);
  child.once('close', () => {
    if (pid !== undefined) commands.delete(pid);
    if (!terminal && !errored && !managed.stopped) {
      const error = new Error('Command guardian exited without an execution receipt'); error.name = 'CommandSupervisionError'; child.emit('error', error);
    }
  });
  child.on('message', (message: { type: string; code?: string; name: string; message: string }) => {
    if (message.type === 'command-exit') { terminal = true; return; }
    if (message.type !== 'command-error') return;
    terminal = true;
    const error: NodeJS.ErrnoException = new Error(message.message); error.code = message.code; error.name = message.name;
    child.emit('error', error);
  });
  try {
    child.send({ type: 'start', command, args, cwd: options.cwd, env: options.env }, error => { if (error) child.emit('error', error); });
  } catch (error) { queueMicrotask(() => child.emit('error', error)); }
  return child;
}

/** Preserve the evaluator Host override, including Electron-hosted Node discovery. */
export function evaluationNodeBinary(): string {
  if (process.env.CRAFT_EVAL_NODE_BINARY) {
    return process.env.CRAFT_EVAL_NODE_BINARY;
  }
  if (!process.versions.electron) {
    return process.execPath;
  }
  for (const directory of (process.env.PATH ?? '').split(';')) {
    if (!directory) {
      continue;
    }
    const candidate = join(directory.replace(/[\\/]+$/, ''), 'node.exe');
    if (existsSync(candidate) && !candidate.includes('DSH Desktop')) {
      return candidate;
    }
  }
  return process.execPath;
}

