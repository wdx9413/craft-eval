import assert from 'node:assert/strict';
import test from 'node:test';

import { coverageSuites } from '../src/audit.js';
import type { Case, Suite } from '../src/evaluation.js';

function caseWith(id: string): Case {
  return { id, argv: [process.execPath, '-e', 'process.exit(0)'], checks: [{ id: `exit-${id}`, kind: 'exit_code', equals: 0 }] };
}

function suiteWith(business: Suite['business'], ids = ['a', 'b']): Suite {
  return {
    schema: 'craft-eval.eval.v1', suite_id: 'biz', subject_kind: 'software',
    partition: 'development', sanitized: true, business,
    cases: ids.map(caseWith),
  } as Suite;
}

test('an invariant covered on both sides reports covered', () => {
  const coverage = coverageSuites([suiteWith({
    invariants: [{ id: 'inv', statement: 's', positive_cases: ['a'], negative_cases: ['b'] }],
  })]).suites[0]!;
  assert.deepEqual(coverage.by_business_invariant?.inv, { positive: 1, negative: 1, covered: true });
});

test('an invariant missing a negative case is a gap', () => {
  const result = coverageSuites([suiteWith({
    invariants: [{ id: 'inv', statement: 's', positive_cases: ['a'], negative_cases: [] }],
  })]);
  assert.equal(result.suites[0]?.by_business_invariant?.['inv']?.covered, false);
  assert.ok(result.gaps.some((gap) => gap.includes('inv has no negative case')));
});

test('unknown case references do not count as coverage', () => {
  const coverage = coverageSuites([suiteWith({
    invariants: [{ id: 'inv', statement: 's', positive_cases: ['ghost'], negative_cases: ['ghost'] }],
  })]).suites[0]!;
  assert.deepEqual(coverage.by_business_invariant?.inv, { positive: 0, negative: 0, covered: false });
});

test('transitions and rule boundaries report their own gaps', () => {
  const result = coverageSuites([suiteWith({
    transitions: [
      { id: 't-covered', entity: 'order', from: null, to: 'created', allowed: true, cases: ['a'] },
      { id: 't-gap', entity: 'order', from: 'created', to: 'paid', allowed: true, cases: [] },
    ],
    rules: [{ id: 'r', statement: 's', parameter: 'amount', boundaries: [
      { value: 199, cases: ['a'] },
      { value: 200, cases: [] },
    ] }],
  })]);
  const suite = result.suites[0]!;
  assert.equal(suite.by_business_transition?.['t-covered']?.covered, true);
  assert.equal(suite.by_business_transition?.['t-gap']?.covered, false);
  assert.equal(suite.by_business_rule?.['r']?.covered, false);
  assert.deepEqual(suite.by_business_rule?.['r']?.boundaries, [{ value: 199, cases: 1 }, { value: 200, cases: 0 }]);
  assert.ok(result.gaps.some((gap) => gap.includes('t-gap has no case')));
  assert.ok(result.gaps.some((gap) => gap.includes('boundary 200 has no case')));
});

test('a suite without a business model omits the business dimensions', () => {
  const coverage = coverageSuites([suiteWith(undefined)]).suites[0]!;
  assert.equal(coverage.by_business_invariant, undefined);
  assert.equal(coverage.by_business_transition, undefined);
  assert.equal(coverage.by_business_rule, undefined);
});
