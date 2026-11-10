import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Proves the three domain graders are not tautologies: each accepts a compliant
// record and rejects a degraded one. Without this, "all green" would only mean
// the graders always pass.
const here = dirname(fileURLToPath(import.meta.url));
const domains = [
  { name: 'coding', good: { domain: 'coding', tests_passed: 12, tests_total: 12, coverage_lines: 0.94, regressions: 0 },
    bad: { domain: 'coding', tests_passed: 11, tests_total: 12, coverage_lines: 0.72, regressions: 1 },
    degradedCase: 'coding-regression' },
  { name: 'quant', good: { domain: 'quant', net_return: 0.08, max_drawdown: 0.12, out_of_sample: true, trades: 40 },
    bad: { domain: 'quant', net_return: -0.03, max_drawdown: 0.31, out_of_sample: true, trades: 5 },
    degradedCase: 'quant-negative' },
  { name: 'writing', good: { domain: 'writing', rubric: { clarity: 0.9, factual_accuracy: 0.88, style_consistency: 0.86 }, forbidden_claims: 0, audience_match: true },
    bad: { domain: 'writing', rubric: { clarity: 0.5, factual_accuracy: 0.6, style_consistency: 0.55 }, forbidden_claims: 2, audience_match: false },
    degradedCase: 'writing-negative' },
];

const root = mkdtempSync(join(tmpdir(), 'domain-grader-'));
let failures = 0;
try {
  for (const domain of domains) {
    const grade = join(here, domain.name, 'workspace', 'grade.mjs');
    for (const [label, record, expected] of [['good', domain.good, 0], ['bad', domain.bad, 1]]) {
      const file = join(root, `${domain.name}-${label}.json`);
      writeFileSync(file, JSON.stringify(record));
      const run = spawnSync(process.execPath, [grade, file], { encoding: 'utf8' });
      const ok = run.status === expected;
      if (!ok) failures += 1;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${domain.name}/${label}: exit ${run.status} (expected ${expected}) ${run.stderr.trim()}`);
    }
    // Also drive the real runner with a degradation flag and grade its computed
    // output, so "negative path" is exercised by computation, not a fixture.
    const runner = join(here, domain.name, 'workspace', 'runner.mjs');
    const degradedOut = join(root, `${domain.name}-computed`);
    const executed = spawnSync(process.execPath, [runner], { encoding: 'utf8',
      env: { ...process.env, CRAFT_EVAL_OUTPUT_DIR: degradedOut, CRAFT_EVAL_CASE_ID: domain.degradedCase } });
    let computedStatus = null;
    if (executed.status === 0) {
      const computed = spawnSync(process.execPath, [grade, join(degradedOut, 'result.json')], { encoding: 'utf8' });
      computedStatus = computed.status;
    }
    const computedOk = computedStatus === 1;
    if (!computedOk) failures += 1;
    console.log(`${computedOk ? 'PASS' : 'FAIL'} ${domain.name}/computed-degraded: grade exit ${computedStatus} (expected 1) ${executed.status !== 0 ? executed.stderr.trim() : ''}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
