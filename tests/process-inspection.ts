import { spawnSync } from 'node:child_process';

const probe = process.platform === 'win32' ? null : spawnSync('ps', ['-p', String(process.pid), '-o', 'stat='], { encoding: 'utf8' });
export const processTreeInspectionSkip = process.platform === 'win32' ? 'requires POSIX process inspection'
  : probe?.error || probe?.status !== 0 ? `process inspection unavailable (${probe?.error?.message ?? probe?.status})` : false;
