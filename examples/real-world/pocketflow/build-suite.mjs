// Generate the PocketFlow suite: one case per execution semantic.
//
// PocketFlow is a graph engine, so the interesting surface is behaviour (how a
// walk, a retry, a batch, an async fan-out resolves), not "do its tests pass".
// Each case runs one probe from workspace/probe.py against the library.
import { writeFileSync } from 'node:fs';

const probes = [
  'default-transition',
  'conditional-action',
  'shared-state-visible',
  'retry-succeeds',
  'fallback-on-exhaustion',
  'batch-node-iterates',
  'batch-flow-params',
  'async-flow-runs',
  'async-parallel-batch',
  'flow-composition',
  'set-params',
  'start-override',
  'unmapped-action-noop',
  // Library's own suite, split by area so a regression names its domain.
  'unit-flow-basic',
  'unit-flow-composition',
  'unit-batch-node',
  'unit-batch-flow',
  'unit-fall-back',
  'unit-async-flow',
  'unit-async-batch-node',
  'unit-async-batch-flow',
  'unit-async-parallel-batch-node',
  'unit-async-parallel-batch-flow',
];

/** Probes handled by probe.py; the rest map to the library's own test files. */
const UNIT_FILES = {
  'unit-flow-basic': 'tests/test_flow_basic.py',
  'unit-flow-composition': 'tests/test_flow_composition.py',
  'unit-batch-node': 'tests/test_batch_node.py',
  'unit-batch-flow': 'tests/test_batch_flow.py',
  'unit-fall-back': 'tests/test_fall_back.py',
  'unit-async-flow': 'tests/test_async_flow.py',
  'unit-async-batch-node': 'tests/test_async_batch_node.py',
  'unit-async-batch-flow': 'tests/test_async_batch_flow.py',
  'unit-async-parallel-batch-node': 'tests/test_async_parallel_batch_node.py',
  'unit-async-parallel-batch-flow': 'tests/test_async_parallel_batch_flow.py',
};

const cases = probes.map((name) => {
  const unit = UNIT_FILES[name];
  if (unit !== undefined) {
    return {
      id: name,
      argv: ['py', '-3', 'run-unit.py', unit],
      timeout_s: 120,
      checks: [{ id: 'passed', kind: 'exit_code', equals: 0 }],
    };
  }
  return {
    id: name,
    argv: ['py', '-3', 'probe.py', name],
    timeout_s: 60,
    checks: [
      { id: 'exit', kind: 'exit_code', equals: 0 },
      { id: 'ok', kind: 'stdout_contains', value: `${name}: ok` },
    ],
  };
});

const suite = {
  schema: 'craft-eval.eval.v1',
  suite_id: 'pocketflow-semantics',
  subject_kind: 'software',
  partition: 'development',
  sanitized: true,
  cases,
};

writeFileSync('suite.json', JSON.stringify(suite, null, 2) + '\n');
console.log(`wrote suite.json with ${cases.length} cases`);
