import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/** Only called with a freshly owned group; never accepts a persisted PID lease. */
export function terminateCommandTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2_000 }); }
    catch { /* A minimal Windows runtime may have no taskkill. */ }
  }
  try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); }
  catch { /* The owned command/group has already exited. */ }
}

type Start = { type: 'start'; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

/** IPC lifetime belongs to the evaluator; command lifetime belongs to this process. */
export function startCommandGuardian(host = process, launch = spawn, terminate = terminateCommandTree): void {
  let child: ChildProcess | undefined, started = false, ended = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null = null, notice?: object): void => {
    if (ended) return;
    ended = true;
    terminate(child?.pid);
    const leave = (): void => {
      if (host.connected) host.disconnect!();
      if (signal) { host.removeAllListeners(signal); host.kill(host.pid, signal); }
      else host.exitCode = code ?? 1;
    };
    if (notice && host.connected) {
      try { host.send!(notice, leave); } catch { leave(); }
    } else leave();
  };
  host.on('disconnect', () => finish(1));
  host.on('SIGTERM', () => finish(143));
  host.on('SIGINT', () => finish(130));
  host.on('message', (message: Start) => {
    if (ended || started || message?.type !== 'start') return;
    started = true;
    const failure = (error: NodeJS.ErrnoException): void => {
      finish(1, null, { type: 'command-error', code: error.code, name: error.name, message: error.message });
    };
    try {
      child = launch(message.command, message.args, { cwd: message.cwd, env: message.env,
        stdio: ['inherit', 'inherit', 'inherit'], detached: process.platform !== 'win32', shell: false, windowsHide: true });
      child.once('error', failure);
      child.once('exit', (code, signal) => finish(code, signal, { type: 'command-exit', code, signal }));
    } catch (error) { failure(error as NodeJS.ErrnoException); }
  });
  // An owner can disappear before this module has finished loading.
  if (!host.connected) finish(1);
}
