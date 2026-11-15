import assert from 'node:assert/strict';
import test from 'node:test';

import { auditSuites } from '../src/audit.js';
import type { Case, Suite } from '../src/evaluation.js';
import { diffSuites, suiteContentDigest, suiteLineage } from '../src/suite-diff.js';

function caseItem(id: string, prompt = `prompt for ${id}`): Case {
  return {
    id,
    prompt,
    checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
  };
}

function suiteDocument(
  suiteId: string,
  cases: Case[],
  lineage: { version?: unknown; parent_digest?: unknown; expires_at?: string } = {},
): Record<string, unknown> {
  return {
    schema: 'craft-eval.eval.v1',
    suite_id: suiteId,
    subject_kind: 'software',
    partition: 'development',
    sanitized: true,
    cases,
    ...lineage,
  };
}

/**
 * Production suites come from `loadSuite`, i.e. plain JSON. Round-tripping here
 * reproduces that shape instead of in-memory spread artifacts.
 */
function suite(
  suiteId: string,
  cases: Case[],
  lineage: { version?: unknown; parent_digest?: unknown; expires_at?: string } = {},
): Suite {
  return JSON.parse(JSON.stringify(suiteDocument(suiteId, cases, lineage))) as Suite;
}

function codes(suites: Suite[]): string[] {
  return auditSuites(suites).findings.map((item) => item.code);
}

test('lineage orders a declared chain parent-first with version and digests', () => {
  const root = suite('suite-root', [caseItem('a')], { version: '1.0.0' });
  const child = suite('suite-child', [caseItem('a'), caseItem('b')], {
    version: '1.1.0',
    parent_digest: suiteContentDigest(root),
  });
  // Entries keep input order; `parent_digest` is what links them.
  const lineage = suiteLineage([child, root]);
  assert.equal(lineage.schema, 'craft-eval.suite-lineage.v1');
  assert.deepEqual(
    lineage.suites.map((entry) => [entry.suite_id, entry.version, entry.parent_digest]),
    [
      ['suite-child', '1.1.0', suiteContentDigest(root)],
      ['suite-root', '1.0.0', null],
    ],
  );
  assert.equal(lineage.suites[0]?.digest, suiteContentDigest(child));
  assert.equal(lineage.suites[1]?.digest, suiteContentDigest(root));
  assert.equal(lineage.suites[0]?.parent_digest, lineage.suites[1]?.digest);

  const audit = auditSuites([root, child]);
  // auditSuites reports lineage in the order it was given.
  assert.deepEqual(audit.suite_lineage, suiteLineage([root, child]));
  assert.deepEqual(
    audit.findings.filter((item) => item.code.startsWith('suite_parent') || item.code === 'suite_version_unchanged').map((item) => item.code),
    [],
  );
});

test('an unresolved parent is a warning', () => {
  const orphan = suite('suite-orphan', [caseItem('orphan')], {
    version: '2.0.0',
    parent_digest: `sha256:${'0'.repeat(64)}`,
  });
  const lineage = suiteLineage([orphan]);
  assert.equal(lineage.suites[0]?.parent_digest, `sha256:${'0'.repeat(64)}`);

  const audit = auditSuites([orphan]);
  const unresolved = audit.findings.find((item) => item.code === 'suite_parent_unresolved');
  assert.equal(unresolved?.severity, 'warning');
  assert.deepEqual(unresolved?.suite_ids, ['suite-orphan']);

  const parent = suite('suite-parent', [caseItem('parent')]);
  const childOfKnown = suite('suite-known-child', [caseItem('b')], {
    parent_digest: suiteContentDigest(parent),
  });
  const linked = auditSuites([childOfKnown, parent]);
  assert.equal(linked.findings.filter((item) => item.code === 'suite_parent_unresolved').length, 0);
});

test('two suites naming each other as parent are an error, not an infinite chain', () => {
  const left = suite('suite-left', [caseItem('a')]);
  const right = suite('suite-right', [caseItem('b')]);
  // Each names the other's content digest as its parent.
  const cyclic = [
    { ...left, parent_digest: suiteContentDigest(right) },
    { ...right, parent_digest: suiteContentDigest(left) },
  ] as Suite[];
  const lineage = suiteLineage(cyclic);
  assert.equal(lineage.suites.length, 2);

  const report = auditSuites(cyclic);
  const cycle = report.findings.filter((item) => item.code === 'suite_parent_cycle');
  assert.equal(cycle.length, 2);
  assert.equal(cycle[0]?.severity, 'error');
  assert.deepEqual(cycle[0]?.suite_ids, ['suite-left', 'suite-right']);
  assert.equal(report.status, 'failed');
});

test('a suite naming itself as parent is reported as an unchanged version', () => {
  const base = suite('suite-self', [caseItem('a')], { version: '1.0.0' });
  const self = { ...base, parent_digest: suiteContentDigest(base) } as Suite;
  const report = auditSuites([self]);
  const unchanged = report.findings.find((item) => item.code === 'suite_version_unchanged');
  assert.equal(unchanged?.severity, 'warning');
  assert.deepEqual(unchanged?.suite_ids, ['suite-self']);
});

test('malformed lineage declarations are ignored instead of trusted', () => {
  const malformed = suite('suite-malformed', [caseItem('a')], {
    version: 42,
    parent_digest: 'not-a-digest',
  });
  const lineage = suiteLineage([malformed]);
  assert.equal(lineage.suites[0]?.version, null);
  assert.equal(lineage.suites[0]?.parent_digest, null);
  assert.deepEqual(codes([malformed]).filter((code) => code.startsWith('suite_parent_')), []);
  assert.throws(() => suiteLineage([{} as Suite]), /string suite_id/);
  assert.throws(() => suiteLineage(['nope' as unknown as Suite]), /string suite_id/);
  assert.throws(() => diffSuites({} as Suite, malformed), /string suite_id/);
  assert.throws(() => diffSuites(malformed, [] as unknown as Suite), /string suite_id/);
});

test('diff reports added, removed and modified cases against the declared parent', () => {
  const kept = caseItem('kept');
  const edited = caseItem('edited');
  const dropped = caseItem('dropped');
  const before = suite('suite-before', [kept, edited, dropped], { version: '1.0.0' });

  const empty = diffSuites(before, suite('suite-diff', [kept, edited, dropped], {
    version: '1.0.1',
    parent_digest: suiteContentDigest(before),
  }));
  assert.equal(empty.schema, 'craft-eval.suite-diff.v1');
  assert.equal(empty.parent_matches, true);
  assert.deepEqual([empty.added.length, empty.removed.length, empty.modified.length], [0, 0, 0]);

  const next = suite('suite-diff', [kept, { ...edited, prompt: 'edited prompt' }, caseItem('new')], {
    version: '1.1.0',
    parent_digest: suiteContentDigest(before),
  });
  const diff = diffSuites(before, next);
  assert.equal(diff.parent_matches, true);
  assert.deepEqual(diff.added.map((item) => item.id), ['new']);
  assert.deepEqual(diff.removed.map((item) => item.id), ['dropped']);
  assert.deepEqual(diff.modified.map((item) => item.case_id), ['edited']);
  assert.equal(diff.modified[0]?.before.prompt, 'prompt for edited');
  assert.equal(diff.modified[0]?.after.prompt, 'edited prompt');

  // Same case set, but the parent digest still points at `before`, so the
  // declared lineage matches even though the suite metadata changed.
  const reparented = diffSuites(before, suite('suite-diff', [kept, edited, dropped], {
    parent_digest: suiteContentDigest(before),
    expires_at: '2099-01-01',
  }));
  assert.equal(reparented.parent_matches, true);
  assert.deepEqual([reparented.added.length, reparented.removed.length, reparented.modified.length], [0, 0, 0]);

  // A parent digest pointing somewhere else is the case that must not match.
  const mismatched = diffSuites(before, suite('suite-diff', [kept, edited, dropped], {
    parent_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  }));
  assert.equal(mismatched.parent_matches, false);
});
