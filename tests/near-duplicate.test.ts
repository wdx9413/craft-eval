import assert from 'node:assert/strict';
import test from 'node:test';

import { auditSuites } from '../src/audit.js';
import type { Case, Suite } from '../src/evaluation.js';

function caseWith(id: string, prompt: string | undefined, source?: string): Case {
  return {
    id,
    argv: [process.execPath, '-e', 'process.exit(0)'],
    checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
    ...(prompt === undefined ? {} : { prompt }),
    ...(source === undefined ? {} : { provenance: { source } }),
  };
}

function suiteOf(id: string, partition: 'development' | 'held_out', cases: Case[]): Suite {
  return {
    schema: 'craft-eval.eval.v1',
    suite_id: id,
    subject_kind: 'software',
    partition,
    sanitized: true,
    cases,
  } as Suite;
}

const LONG = 'Please audit this product listing for compliance and report every claim that lacks supporting evidence.';
const NEAR = 'Please audit this product listing for compliance and report every claim that lacks supporting evidence!';

test('a reworded long prompt is reported as a near duplicate', () => {
  const audit = auditSuites([suiteOf('s', 'development', [
    caseWith('a', LONG),
    caseWith('b', NEAR),
  ])]);
  const finding = audit.findings.find((item) => item.code === 'near_duplicate_prompt');
  assert.ok(finding);
  assert.deepEqual(finding?.case_ids, ['a', 'b']);
  assert.match(String(finding?.message), /similar/);
});

test('a lower threshold admits a pair that the default rejects', () => {
  // Shares most of its wording with LONG but adds a distinct trailing clause, so
  // similarity sits between the two thresholds rather than above both.
  const different = 'Please audit this product listing for compliance and report every claim that lacks supporting evidence, then summarise the findings in a table for the reviewer.';
  const strict = auditSuites([suiteOf('s', 'development', [caseWith('a', LONG), caseWith('b', different)])], { near_duplicate_threshold: 0.95 });
  assert.equal(strict.findings.some((item) => item.code === 'near_duplicate_prompt'), false);
  const loose = auditSuites(
    [suiteOf('s', 'development', [caseWith('a', LONG), caseWith('b', different)])],
    { near_duplicate_threshold: 0.5 },
  );
  assert.equal(loose.findings.some((item) => item.code === 'near_duplicate_prompt'), true);
});

test('short prompts are skipped to avoid false positives', () => {
  const audit = auditSuites([suiteOf('s', 'development', [
    caseWith('a', 'fix the bug'),
    caseWith('b', 'fix the bug'),
  ])]);
  assert.equal(audit.findings.some((item) => item.code === 'near_duplicate_prompt'), false);
});

test('a shared source across partitions is reported even when sanitized', () => {
  const audit = auditSuites([
    suiteOf('dev', 'development', [caseWith('d1', undefined, 'handbook.pdf')]),
    suiteOf('held', 'held_out', [caseWith('h1', undefined, 'handbook.pdf')]),
  ]);
  const finding = audit.findings.find((item) => item.code === 'shared_source_cross_partition');
  assert.ok(finding);
  assert.deepEqual(finding?.case_ids, ['d1', 'h1']);
});

test('a source confined to one partition is not reported', () => {
  const audit = auditSuites([
    suiteOf('dev', 'development', [caseWith('d1', undefined, 'only-dev.pdf')]),
    suiteOf('held', 'held_out', [caseWith('h1', undefined, 'only-held.pdf')]),
  ]);
  assert.equal(audit.findings.some((item) => item.code === 'shared_source_cross_partition'), false);
});

test('an invalid threshold is rejected', () => {
  assert.throws(
    () => auditSuites([suiteOf('s', 'development', [caseWith('a', LONG)])], { near_duplicate_threshold: 2 }),
    /near_duplicate_threshold must be within 0\.\.1/,
  );
});
