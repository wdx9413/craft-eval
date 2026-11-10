import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the three domain held-out suites against the evaluator and asserts each
// is complete with no failed/inconclusive cases, then verifies the graders are
// not tautologies. This grades the domain *mechanism*, not model quality.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const cli = join(repo, 'dist', 'src', 'cli.js');
const runtime = join(repo, 'examples', 'runtime.json');
const domains = ['coding', 'quant', 'writing'];
const output = mkdtempSync(join(tmpdir(), 'domain-heldout-runs-'));
let failures = 0;
try {
  for (const domain of domains) {
    const base = join(here, domain);
    const run = spawnSync(process.execPath, [cli, 'run', join(base, 'suite.json'), join(base, 'subject.json'), runtime,
      '--workspace', join(base, 'workspace'), '--output', join(output, domain), '--workspace-mode', 'isolated', '--fail-on-failed'],
    { encoding: 'utf8', cwd: repo });
    let parsed = null;
    try { parsed = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).at(-1) ?? 'null'); } catch { /* reported below */ }
    const report = parsed?.report;
    const ok = run.status === 0 && report?.status === 'complete' && report.passed === 1
      && report.failed === 0 && report.inconclusive === 0;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${domain}: status=${report?.status ?? 'none'} passed=${report?.passed ?? '?'} failed=${report?.failed ?? '?'} exit=${run.status}`);
    if (!ok && run.stderr) console.log(run.stderr.trim().slice(-400));
  }
  const graders = spawnSync(process.execPath, [join(here, 'verify-graders.mjs')], { encoding: 'utf8' });
  process.stdout.write(graders.stdout);
  if (graders.status !== 0) failures += 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
console.log(failures ? `domain held-out: ${failures} failure(s)` : 'domain held-out: all green');
process.exitCode = failures ? 1 : 0;
