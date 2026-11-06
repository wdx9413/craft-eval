// Generate the craft-eval self-check suite: one case per evaluator capability.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Test names, in file order. Kept explicit so a renamed test fails loudly. */
const tests = [
  'software executes in copy and reports observed failures',
  'agent checks environment state and completed host trace',
  'missing terminal trace is inconclusive even when skill not selected',
  'agent local argv checks do not require a host trace',
  'skill paired gain requires evaluator-observed host events',
  'plan and result tampering or incomplete work cannot pass',
  'suite validation rejects unsafe or ambiguous contracts',
  'runtime mismatch and adapter errors are explicit',
  'timeout and untrusted trace cannot count as success',
  'artifact links cannot read outside workspace',
  'contract rejects all invalid case and check shapes',
  'subject workspace trials and cli errors',
  'artifact and trace failure modes',
  'comparison guards and pair directions',
  'self-reported triggers can diagnose but never support a gain claim',
  'script checks grade by exit code and classify failures',
  'development suite and command entry points',
  'mocked mcp servers serve tools and tool_call checks grade from evaluator evidence',
  'mcp contract validation rejects malformed declarations',
  'script checks accept an explicit interpreter for any language',
  'server-mode cases start a service, drive it, and terminate it',
  'stdout assertions work for a bare-print adapter',
];

export const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceDigest = `sha256:${createHash('sha256').update(readFileSync(join(root, 'tests/evaluation.test.ts'))).digest('hex')}`;

const cases = [
  {
    id: 'build-succeeds',
    category: 'build',
    risk: 'high',
    language: 'typescript',
    in_place: true,
    argv: ['npm', 'run', 'build'],
    timeout_s: 300,
    expected_behavior: 'The craft-eval TypeScript package builds successfully on the current host.',
    provenance: { source: 'craft-eval/package.json:scripts.build' },
    checks: [{ id: 'built', kind: 'exit_code', equals: 0 }],
  },
  ...tests.map((name, index) => ({
    // A stable, readable id: index keeps order, slug keeps intent.
    id: `${String(index + 1).padStart(2, '0')}-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)}`,
    category: 'evaluator-regression',
    risk: 'high',
    language: 'typescript',
    in_place: true,
    argv: ['node', '--test', '--test-isolation=none', '--test-reporter=spec', `--test-name-pattern=^${escapeRegExp(name)}$`, '{{craft-eval}}/dist/tests/evaluation.test.js'],
    timeout_s: 60,
    expected_behavior: `The named evaluator regression test passes: ${name}.`,
    provenance: { source: 'craft-eval/tests/evaluation.test.ts', source_digest: sourceDigest },
    checks: [
      { id: 'named-test-ran-once', kind: 'stdout_contains', value: 'ℹ tests 1' },
      { id: 'named-test-passed', kind: 'stdout_contains', value: `✔ ${name}` },
      { id: 'single-selected-test-passed', kind: 'stdout_contains', value: 'ℹ pass 1' },
      { id: 'no-test-failures', kind: 'stdout_contains', value: 'ℹ fail 0' },
      { id: 'process-exited-successfully', kind: 'exit_code', equals: 0 },
    ],
  })),
];

const suite = {
  schema: 'craft-eval.eval.v1',
  suite_id: 'craft-eval-capabilities',
  subject_kind: 'software',
  partition: 'development',
  sanitized: true,
  claim: {
    statement: 'The named craft-eval regression tests and package build pass on the declared local runtime.',
    scope: 'Local deterministic regression checks for craft-eval only.',
    limitations: ['Does not establish Craft or Workbench product quality or real-world task benefit.'],
  },
  metrics: {
    primary: { id: 'case_pass_rate', kind: 'binary_pass_rate', direction: 'higher_is_better', minimum_sample: cases.length },
    guardrails: [{ id: 'build_pass', metric: 'build_pass', comparator: 'gte', threshold: 1 }],
  },
  cases,
};

const output = join(dirname(fileURLToPath(import.meta.url)), 'suite.json');
writeFileSync(output, JSON.stringify(suite, null, 2) + '\n');
console.log(`wrote suite.json with ${cases.length} cases`);
