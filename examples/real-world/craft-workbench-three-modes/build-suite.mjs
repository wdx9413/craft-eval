// Generate the Craft Workbench three-mode suite: one case per delivery promise
// the split into 领航员 / 控制台 / 工作台 must keep.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const workbench = join(root, 'craft-workbench');

const digestOf = (relative) => {
  const file = join(workbench, relative);
  try {
    return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  } catch {
    return null;
  }
};

const cases = [
  {
    id: 'mode-pages-are-independent-modules',
    category: 'architecture',
    risk: 'high',
    language: 'javascript',
    in_place: true,
    argv: ['node', '--experimental-strip-types', '--test', '--test-isolation=none', 'tests/mode-shell.test.ts'],
    timeout_s: 120,
    expected_behavior:
      'Each mode page is its own module, no mode module imports a sibling, and the app fetches the owning mode page lazily so a single-surface build never downloads the other two projections.',
    provenance: { source: 'craft-workbench/tests/mode-shell.test.ts', source_digest: digestOf('tests/mode-shell.test.ts') },
    checks: [
      { id: 'tests-pass', kind: 'exit_code', equals: 0 },
      { id: 'no-test-failures', kind: 'stdout_contains', value: 'ℹ fail 0' },
      { id: 'module-boundary-asserted', kind: 'stdout_contains', value: 'each mode page is an independent module' },
    ],
  },
  {
    id: 'pilot-control-workshop-behaviour',
    category: 'behaviour',
    risk: 'high',
    language: 'javascript',
    in_place: true,
    argv: ['node', '--experimental-strip-types', '--test', '--test-isolation=none', 'tests/mode-pages.test.ts',
      'tests/three-mode-consistency.test.ts', 'tests/three-mode-journey.test.ts'],
    timeout_s: 180,
    expected_behavior:
      '领航员 keeps its minimal surface for non-technical users, 控制台 shows the shared task board, and 工作台 keeps the plugin and Mod configuration surface; all three read the same Runtime truth.',
    provenance: { source: 'craft-workbench/tests/mode-pages.test.ts', source_digest: digestOf('tests/mode-pages.test.ts') },
    checks: [
      { id: 'tests-pass', kind: 'exit_code', equals: 0 },
      { id: 'no-test-failures', kind: 'stdout_contains', value: 'ℹ fail 0' },
      { id: 'pilot-surface-asserted', kind: 'stdout_contains', value: 'viewPilot is a minimal superagent surface' },
    ],
  },
  {
    id: 'single-surface-builds-pin-their-mode',
    category: 'packaging',
    risk: 'high',
    language: 'javascript',
    in_place: true,
    argv: ['node', '--experimental-strip-types', '--test', '--test-isolation=none', 'tests/workbench-boot.test.ts'],
    timeout_s: 120,
    expected_behavior:
      'A single-surface desktop build pins its mode through CRAFT_MODE_ONLY, hides the mode switcher, and resolves cross-mode navigation back into its own projection.',
    provenance: { source: 'craft-workbench/tests/workbench-boot.test.ts', source_digest: digestOf('tests/workbench-boot.test.ts') },
    checks: [
      { id: 'tests-pass', kind: 'exit_code', equals: 0 },
      { id: 'no-test-failures', kind: 'stdout_contains', value: 'ℹ fail 0' },
      { id: 'single-surface-pinning-asserted', kind: 'stdout_contains', value: 'each flavor names its own window' },
    ],
  },
  {
    id: 'page-inventory-renders-every-routable-page',
    category: 'coverage',
    risk: 'medium',
    language: 'javascript',
    in_place: true,
    argv: ['node', '--experimental-strip-types', '--test', '--test-isolation=none', 'tests/page-inventory.test.ts'],
    timeout_s: 180,
    expected_behavior:
      'Every routable page of every mode renders a heading and at least one control without an unhandled page error.',
    provenance: { source: 'craft-workbench/tests/page-inventory.test.ts', source_digest: digestOf('tests/page-inventory.test.ts') },
    checks: [
      { id: 'tests-pass', kind: 'exit_code', equals: 0 },
      { id: 'no-test-failures', kind: 'stdout_contains', value: 'ℹ fail 0' },
      { id: 'page-inventory-asserted', kind: 'stdout_contains', value: 'every mode exposes a non-empty routable page set' },
    ],
  },
  {
    id: 'settings-keystore-and-navigation',
    category: 'settings',
    risk: 'high',
    language: 'javascript',
    in_place: true,
    argv: ['node', '--experimental-strip-types', '--test', '--test-isolation=none', 'tests/workbench-model-setup.test.ts',
      'tests/model-key-direct.test.ts'],
    timeout_s: 180,
    expected_behavior:
      'Settings are split into sections with a back button, and a pasted API key is stored as a value in the owner-only local keystore instead of an environment variable name.',
    provenance: { source: 'craft-workbench/tests/workbench-model-setup.test.ts', source_digest: digestOf('tests/workbench-model-setup.test.ts') },
    checks: [
      { id: 'tests-pass', kind: 'exit_code', equals: 0 },
      { id: 'no-test-failures', kind: 'stdout_contains', value: 'ℹ fail 0' },
      { id: 'secret-value-flow-asserted', kind: 'stdout_contains', value: '模型配置页直接接收密钥值' },
    ],
  },
  {
    id: 'design-layer-has-no-contrast-or-type-violations',
    category: 'design',
    risk: 'medium',
    language: 'javascript',
    in_place: true,
    argv: ['node', '--experimental-strip-types', '--test', '--test-isolation=none', 'tests/visual-layer.test.ts'],
    timeout_s: 120,
    expected_behavior:
      'The visual layer keeps the documented design tokens, contrast rules and composer visibility contract.',
    provenance: { source: 'craft-workbench/tests/visual-layer.test.ts', source_digest: digestOf('tests/visual-layer.test.ts') },
    checks: [
      { id: 'tests-pass', kind: 'exit_code', equals: 0 },
      { id: 'no-test-failures', kind: 'stdout_contains', value: 'ℹ fail 0' },
      { id: 'design-tokens-asserted', kind: 'stdout_contains', value: 'every CSS custom property resolves to the design system' },
    ],
  },
];

const suite = {
  schema: 'craft-eval.eval.v1',
  suite_id: 'craft-workbench-three-modes',
  subject_kind: 'software',
  partition: 'development',
  sanitized: true,
  claim: {
    statement:
      'Craft Workbench can ship the three surfaces (领航员 / 控制台 / 工作台) as separate desktop apps whose pages never depend on each other, while every mode still reads the same Runtime truth.',
    scope:
      'Deterministic regression checks over the Craft Workbench checkout: mode module boundaries, per-mode behaviour, single-surface pinning, page inventory, settings and design contract.',
    limitations: [
      'These cases run the repository test suite, not an installed desktop app, so installer behaviour and real user sessions are not covered.',
      'No model is involved: the checks prove the UI contract, not task quality or model accuracy.',
    ],
  },
  metrics: {
    primary: {
      id: 'case_pass_rate',
      kind: 'binary_pass_rate',
      direction: 'higher_is_better',
      minimum_sample: cases.length,
    },
  },
  cases,
};

const output = join(dirname(fileURLToPath(import.meta.url)), 'suite.json');
writeFileSync(output, JSON.stringify(suite, null, 2) + '\n');
console.log(`wrote suite.json with ${cases.length} cases`);
