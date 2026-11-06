// Generate the craft-eval self-check suite: one case per evaluator capability.
//
// The evaluator's own tests are organised as one file of 22 named tests. Running
// them as a single blob tells you "something regressed"; selecting one test at a
// time makes the failing case name the capability that broke (trace handling,
// artifact guards, MCP mocking, comparison guards, ...).
import { writeFileSync } from 'node:fs';

/** Test names, in file order. Kept explicit so a renamed test fails loudly. */
const tests = [
  'software executes in copy and reports observed failures',
  'agent checks environment state and completed host trace',
  'missing terminal trace is inconclusive even when skill not selected',
  'agent requires completed host trace even for file checks',
  'skill paired gain requires positive negative and real distinct runs',
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

const cases = [
  {
    id: 'build-succeeds',
    in_place: true,
    argv: ['cmd', '/c', 'npm', 'run', 'build'],
    timeout_s: 300,
    checks: [{ id: 'built', kind: 'exit_code', equals: 0 }],
  },
  ...tests.map((name, index) => ({
    // A stable, readable id: index keeps order, slug keeps intent.
    id: `${String(index + 1).padStart(2, '0')}-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)}`,
    in_place: true,
    argv: ['py', '-3', 'run-self-test.py', name],
    timeout_s: 180,
    checks: [
      { id: 'ran', kind: 'exit_code', equals: 0 },
      // A filter that matches nothing exits 0; the launcher turns that into a
      // failure, and this check keeps the intent visible in the report.
      { id: 'matched', kind: 'stdout_not_contains', value: 'tests 0' },
    ],
  })),
];

const suite = {
  schema: 'craft-eval.eval.v1',
  suite_id: 'craft-eval-capabilities',
  subject_kind: 'software',
  partition: 'development',
  sanitized: true,
  cases,
};

writeFileSync('suite.json', JSON.stringify(suite, null, 2) + '\n');
console.log(`wrote suite.json with ${cases.length} cases`);
