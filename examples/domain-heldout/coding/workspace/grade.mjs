import { readFileSync } from 'node:fs';

// Deterministic coding grader: all tests pass, line coverage meets the frozen
// threshold, and no previously-passing test regressed. Exits 1 with a reason on
// stderr otherwise, so a failure is explainable rather than a bare exit code.
const path = process.argv[2];
if (!path) { console.error('usage: grade.mjs <outputs/result.json>'); process.exit(2); }
const result = JSON.parse(readFileSync(path, 'utf8'));
if (result.domain !== 'coding') { console.error('wrong domain'); process.exit(1); }
if (result.tests_passed !== result.tests_total || result.tests_total < 1) {
  console.error(`tests: ${result.tests_passed}/${result.tests_total}`); process.exit(1);
}
if (!(result.coverage_lines >= 0.9)) { console.error(`coverage too low: ${result.coverage_lines}`); process.exit(1); }
if (result.regressions !== 0) { console.error(`regressions: ${result.regressions}`); process.exit(1); }
