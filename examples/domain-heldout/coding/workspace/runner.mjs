import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The subject computes its record from a frozen held-out test-result panel,
// rather than emitting a pre-baked "pass" number. A regression is any test in
// `previously_passing` that now fails; coverage is the ratio of covered to
// total lines across the panel. CRAFT_EVAL_CASE_ID can inject one degradation
// so the negative path is exercised by real computation, not a constant.
const outputDir = process.env.CRAFT_EVAL_OUTPUT_DIR;
if (!outputDir) throw new Error('CRAFT_EVAL_OUTPUT_DIR is required');
mkdirSync(outputDir, { recursive: true });
const panel = JSON.parse(readFileSync(join(import.meta.dirname, 'test-results.json'), 'utf8'));
const degraded = process.env.CRAFT_EVAL_CASE_ID === 'coding-regression';
const tests = panel.tests.map((test, index) =>
  degraded && index === 0 ? { ...test, passed: false } : test);
const covered = tests.reduce((sum, test) => sum + test.covered_lines, 0);
const total = tests.reduce((sum, test) => sum + test.total_lines, 0);
const regressions = panel.previously_passing.filter((id) =>
  !tests.find((test) => test.id === id)?.passed).length;
const result = {
  domain: 'coding',
  tests_passed: tests.filter((test) => test.passed).length,
  tests_total: tests.length,
  coverage_lines: total > 0 ? covered / total : 0,
  regressions,
};
writeFileSync(join(outputDir, 'result.json'), JSON.stringify(result));
