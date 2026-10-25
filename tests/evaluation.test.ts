import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareRuns, loadSuite, reportRun, runSuite, signProbability } from '../src/evaluation.js';
import type { CaseResult, CheckResult } from '../src/evaluation.js';
import { main } from '../src/cli.js';

const RUNTIME_KEYS = ['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'];

/** Asserting accessor: a run that produced no result is a broken run, not a soft miss. */
function only<T>(values: T[], description = 'result'): T {
  assert.equal(values.length, 1, `expected exactly one ${description}`);
  const value = values[0];
  assert.ok(value !== undefined, `expected one ${description}`);
  return value;
}

async function firstResult(runDir: string): Promise<CaseResult> {
  return only((await reportRun(runDir)).results, 'case result');
}

async function firstCheck(runDir: string): Promise<CheckResult> {
  return only((await firstResult(runDir)).checks, 'check result');
}

/**
 * The host shell may run Node inside an Electron wrapper, where process.execPath
 * points at the wrapper application instead of the Node binary. Adapters must be
 * launched with a real Node executable, so resolve one explicitly.
 */
function resolveNodeBinary(): string {
  if (process.env.CRAFT_EVAL_NODE_BINARY) {
    return process.env.CRAFT_EVAL_NODE_BINARY;
  }
  if (!process.versions.electron) {
    return process.execPath;
  }
  for (const directory of (process.env.PATH ?? '').split(';')) {
    if (!directory) {
      continue;
    }
    const candidate = `${directory.replace(/[\\/]+$/, '')}\\node.exe`;
    if (existsSync(candidate) && !candidate.includes('DSH Desktop')) {
      return candidate;
    }
  }
  throw new Error('no Node binary found for adapter execution');
}

const NODE_BINARY = resolveNodeBinary();

function runtime(): Record<string, string> {
  const value: Record<string, string> = {};
  for (const key of RUNTIME_KEYS) {
    value[key] = `${key}-fixed`;
  }
  return value;
}

function suiteDoc(kind: string, cases: unknown[], partition = 'held_out'): Record<string, unknown> {
  return {
    schema: 'craft-eval.eval.v1',
    suite_id: `${kind}-suite`,
    subject_kind: kind,
    partition,
    sanitized: true,
    approved_by: 'reviewer',
    cases,
  };
}

interface CaseOptions {
  checks?: unknown[];
  safety?: unknown[];
  [key: string]: unknown;
}

/**
 * Write a real skill directory into the workspace so cases can pin a binding the
 * evaluator resolves, rather than declaring a bare id that nothing checks.
 */
const SKILL_ID = 'answer-skill';

async function writeSkill(workspace: string, skillId = SKILL_ID): Promise<void> {
  const directory = join(workspace, 'skills', skillId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    ['---', `name: ${skillId}`, 'description: A test skill used by the evaluator suite.', '---', '', '# Body', ''].join('\n'),
    'utf8',
  );
}

function skillBinding(shouldTrigger: boolean, skillId = SKILL_ID): Record<string, unknown> {
  return { skill_id: skillId, skill_path: `skills/${skillId}`, should_trigger: shouldTrigger };
}

function caseDoc(id: string, options: CaseOptions = {}): Record<string, unknown> {
  return {
    id,
    argv: [NODE_BINARY, 'host.mjs'],
    timeout_s: 3,
    checks: options.checks ?? [{ id: 'exit', kind: 'exit_code', equals: 0 }],
    safety_checks: options.safety ?? [],
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'checks' && key !== 'safety')),
  };
}

class Fixture {
  root!: string;
  workspace!: string;
  output!: string;
  runtimePath!: string;
  counter = 0;

  async setup(): Promise<void> {
    this.root = await mkdtemp(join(tmpdir(), 'craft-eval-test-'));
    this.workspace = join(this.root, 'workspace');
    await mkdir(this.workspace);
    this.output = join(this.root, 'runs');
    this.runtimePath = await write(this.root, 'runtime.json', runtime());
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  async project(script: string): Promise<void> {
    await writeFile(join(this.workspace, 'host.mjs'), script, 'utf8');
  }

  async runEval(kind: string, cases: unknown[], subjectEnv: Record<string, string> = {}, trials = 1): Promise<string> {
    this.counter += 1;
    const suitePath = await write(this.root, `${kind}-suite.json`, suiteDoc(kind, cases));
    const subjectPath = await write(this.root, `${kind}-${this.counter}.json`, {
      kind,
      id: `${kind}-subject`,
      version: 'v1',
      env: subjectEnv,
    });
    return runSuite(suitePath, subjectPath, this.runtimePath, this.workspace, this.output, { trials });
  }
}

async function write(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
  return path;
}

async function captureStdout<T>(work: () => Promise<T>): Promise<{ value: T; text: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    const value = await work();
    return { value, text: chunks.join('') };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

async function captureStderr<T>(work: () => Promise<T>): Promise<{ value: T; text: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    const value = await work();
    return { value, text: chunks.join('') };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

/**
 * Directory links are the capability the guards actually rely on: jobs are
 * created as directory junctions on Windows, which need no elevation, whereas a
 * file symlink requires Developer Mode or admin rights. Both traverse the same
 * `lstat().isSymbolicLink()` check, so a junction exercises the guard.
 */
async function canCreateDirectoryLink(root: string): Promise<boolean> {
  const target = join(root, '.probe-dir');
  const link = join(root, '.probe-dir-link');
  try {
    await mkdir(target, { recursive: true });
    await symlink(target, link, 'junction');
    return true;
  } catch {
    return false;
  } finally {
    await rm(link, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
}

test('software executes in copy and reports observed failures', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { mkdirSync, writeFileSync } from 'node:fs';
const id = process.env.CRAFT_EVAL_CASE_ID;
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/state.json', JSON.stringify({ ok: id === 'fixed' }));
process.exit(id === 'fixed' ? 0 : 3);
`);
    const cases = [
      caseDoc('fixed', {
        checks: [
          { id: 'exit', kind: 'exit_code', equals: 0 },
          { id: 'state', kind: 'json_equals', path: 'outputs/state.json', key: 'ok', equals: true },
        ],
        safety: [{ id: 'artifact', kind: 'file_exists', path: 'outputs/state.json' }],
      }),
      caseDoc('broken'),
    ];
    const run = await fx.runEval('software', cases);
    const report = await reportRun(run);
    assert.deepEqual(
      [report.expected, report.recorded, report.passed, report.failed],
      [2, 2, 1, 1],
    );
    assert.equal(report.status, 'complete');
    assert.equal(existsSync(join(fx.workspace, 'outputs')), false);
    // Two cases run here; the first is the healthy one with a safety check.
    const healthy = report.results[0];
    assert.ok(healthy !== undefined);
    assert.equal(healthy.safety_verdict, 'passed');
    assert.ok(healthy.stdout_sha256);
    await captureStdout(async () => assert.equal(await main(['validate', join(fx.root, 'software-suite.json')]), 0));
    await captureStdout(async () => assert.equal(await main(['report', run]), 0));
  } finally {
    await fx.cleanup();
  }
});

test('agent checks environment state and completed host trace', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ task: { done: true } }));
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
const events = [
  { source: 'host', task_run_id: id, event: 'tool.called' },
  { source: 'host', task_run_id: id, event: 'run.finished', cost_units: 2.5 },
];
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`);
    const checks = [
      { id: 'result', kind: 'json_equals', path: 'outputs/result.json', key: 'task.done', equals: true },
      { id: 'tool', kind: 'trace_event', event: 'tool.called', present: true },
    ];
    const run = await fx.runEval('agent', [caseDoc('do-task', { checks })]);
    const result = await firstResult(run);
    assert.deepEqual(
      [result.verdict, result.task_verdict, result.cost_units, result.trace_complete],
      ['passed', 'passed', 2.5, true],
    );
  } finally {
    await fx.cleanup();
  }
});

test('missing terminal trace is inconclusive even when skill not selected', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({ source: 'host', task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID, event: 'started' }) + '\\n');
`);
    const run = await fx.runEval('skill', [
      caseDoc('adjacent', { checks: [], skill: skillBinding(false) }),
    ]);
    const result = await firstResult(run);
    assert.deepEqual([result.verdict, result.trigger?.verdict, result.trigger?.evidence], ['inconclusive', 'inconclusive', 'unobserved']);
  } finally {
    await fx.cleanup();
  }
});

test('agent requires completed host trace even for file checks', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ done: true }));
`);
    const checks = [{ id: 'result', kind: 'json_equals', path: 'outputs/result.json', key: 'done', equals: true }];
    const run = await fx.runEval('agent', [caseDoc('agent', { checks })]);
    const result = await firstResult(run);
    assert.deepEqual([result.task_verdict, result.verdict, result.trace_complete], ['passed', 'inconclusive', false]);
  } finally {
    await fx.cleanup();
  }
});

test('skill paired gain requires positive negative and real distinct runs', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
const enabled = process.env.SKILL_ENABLED === '1';
const positive = process.env.CRAFT_EVAL_CASE_ID.startsWith('task-');
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: positive ? enabled : true }));
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
const events = [];
if (enabled && positive) {
  // Emitted by the evaluator's wrapper (source: gateway), not by the subject.
  events.push({ source: 'gateway', task_run_id: id, event: 'skill.invoked', skill_id: 'answer-skill' });
}
events.push({ source: 'host', task_run_id: id, event: 'run.finished', cost_units: 1 });
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`);
    const checks = [{ id: 'outcome', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true }];
    const cases = [] as unknown[];
    for (let index = 0; index < 20; index += 1) {
      cases.push(caseDoc(`task-${index}`, { checks, skill: skillBinding(true) }));
    }
    cases.push(caseDoc('adjacent', { checks: [], skill: skillBinding(false) }));
    const baseline = await fx.runEval('skill', cases, { SKILL_ENABLED: '0' });
    const candidate = await fx.runEval('skill', cases, { SKILL_ENABLED: '1' });
    const compared = await compareRuns(baseline, candidate);
    assert.deepEqual(
      [compared.measured_pairs, compared.candidate_wins, compared.candidate_trigger_failures],
      [20, 20, 0],
    );
    assert.equal(compared.skill_gain_supported, true);
    assert.ok((compared.one_sided_p ?? 1) < 0.05);
    assert.equal(compared.independent_task_runs, true);
    assert.equal(compared.gateway_observed_triggers, true);
    assert.equal(compared.unobserved_triggers, 0);
    await captureStdout(async () => assert.equal(await main(['compare', baseline, candidate]), 0));
  } finally {
    await fx.cleanup();
  }
});

test('plan and result tampering or incomplete work cannot pass', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`process.exit(0);
`);
    const run = await fx.runEval('software', [caseDoc('one'), caseDoc('two')], {}, 2);
    await unlink(join(run, 'results', 'one-1.json'));
    const report = await reportRun(run);
    assert.deepEqual([report.missing, report.status], [1, 'incomplete']);
    const other = await fx.runEval('software', [caseDoc('one'), caseDoc('two')], {}, 2);
    assert.equal((await compareRuns(run, other)).status, 'inconclusive');
    const changed = JSON.parse(await readFile(join(run, 'plan.json'), 'utf8'));
    changed.suite.cases[0].id = 'different';
    await write(run, 'plan.json', changed);
    await assert.rejects(reportRun(run), /invalid or changed/);
  } finally {
    await fx.cleanup();
  }
});

test('suite validation rejects unsafe or ambiguous contracts', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    const base = suiteDoc('software', [caseDoc('a')]);
    const variants: [unknown, RegExp][] = [
      [{ ...base, schema: 'wrong' }, /schema/],
      [{ ...base, sanitized: false }, /sanitized/],
      [{ ...base, approved_by: '' }, /approved_by/],
      [{ ...base, partition: 'wrong' }, /partition/],
      [{ ...base, cases: [] }, /1\.\.1000/],
      [{ ...base, cases: [caseDoc('a'), caseDoc('a')] }, /unique/],
      [{ ...base, cases: [caseDoc('../bad')] }, /identifier/],
      [{ ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'file_exists', path: '../secret' }] })] }, /relative/],
      [{ ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'unknown' }] })] }, /unsupported/],
    ];
    for (const [value, message] of variants) {
      await assert.rejects(loadSuite(await write(fx.root, 'invalid.json', value)), message);
    }
    const badSubject = await write(fx.root, 'bad-subject.json', {
      kind: 'software',
      id: 'build',
      version: 'v1',
      env: { CRAFT_EVAL_TASK_RUN_ID: 'fake' },
    });
    const goodSuite = await write(fx.root, 'valid.json', base);
    await assert.rejects(runSuite(goodSuite, badSubject, fx.runtimePath, fx.workspace, fx.output), /override/);
  } finally {
    await fx.cleanup();
  }
});

test('runtime mismatch and adapter errors are explicit', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`process.exit(0);
`);
    const suitePath = await write(fx.root, 'suite.json', suiteDoc('software', [caseDoc('one')]));
    const subjectPath = await write(fx.root, 'subject.json', { kind: 'software', id: 'build', version: 'v1' });
    await assert.rejects(
      runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, join(fx.workspace, 'output')),
      /outside workspace/,
    );
    const badRuntime = await write(fx.root, 'bad-runtime.json', { model_digest: 'only' });
    await assert.rejects(
      runSuite(suitePath, subjectPath, badRuntime, fx.workspace, fx.output),
      /runtime must pin/,
    );
    const missing = caseDoc('missing');
    missing.argv = ['/definitely/missing/craft-eval-adapter'];
    const brokenSuite = await write(fx.root, 'broken-suite.json', suiteDoc('software', [missing]));
    const run = await runSuite(brokenSuite, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    assert.equal((await reportRun(run)).results[0]?.verdict, 'invalid');
  } finally {
    await fx.cleanup();
  }
});

test('timeout and untrusted trace cannot count as success', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`await new Promise((done) => setTimeout(done, 5000));
`);
    const slow = caseDoc('slow');
    slow.timeout_s = 0.5;
    const run = await fx.runEval('software', [slow]);
    const result = await firstResult(run);
    assert.deepEqual([result.issue, result.verdict], ['timeout', 'inconclusive']);
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({ source: 'agent', task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID, event: 'run.finished' }) + '\\n');
`);
    await writeSkill(fx.workspace);
    const second = await fx.runEval('skill', [
      caseDoc('negative', { checks: [], skill: skillBinding(false) }),
    ]);
    assert.equal((await firstResult(second)).trigger?.verdict, 'inconclusive');
  } finally {
    await fx.cleanup();
  }
});

test('artifact links cannot read outside workspace', async (t) => {
  const fx = new Fixture();
  await fx.setup();
  try {
    if (!(await canCreateDirectoryLink(fx.root))) {
      t.skip('directory links are not creatable on this platform');
      return;
    }
    const outside = join(fx.root, 'secret');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'result.json'), '{"safe":true}', 'utf8');
    await fx.project(`import { mkdirSync, symlinkSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
symlinkSync(process.env.OUTSIDE_DIR, 'outputs/linked', 'junction');
`);
    const run = await fx.runEval(
      'software',
      [
        caseDoc('leak', {
          checks: [
            { id: 'leak', kind: 'json_equals', path: 'outputs/linked/result.json', key: 'safe', equals: true },
          ],
        }),
      ],
      { OUTSIDE_DIR: outside },
    );
    const check = await firstCheck(run);
    assert.equal(check.passed, false, 'reading through a link must not pass');
    assert.equal((await firstResult(run)).task_verdict, 'failed');
  } finally {
    await fx.cleanup();
  }
});

test('contract rejects all invalid case and check shapes', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    const base = suiteDoc('software', [caseDoc('a')]);
    const variants: [unknown, RegExp][] = [
      [[], /JSON object/],
      [{ ...base, cases: [null] }, /case must/],
      // Deliberately malformed: checks must be an array, so bypass the helper's typing.
      [{ ...base, cases: [{ ...caseDoc('a'), checks: 'not-an-array' }] }, /array/],
      [{ ...base, cases: [caseDoc('a', { checks: [null] })] }, /objects/],
      [{ ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'exit_code', equals: true }] })] }, /integer/],
      [
        { ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'json_equals', path: 'result.json', key: '' }] })] },
        /key/,
      ],
      [
        { ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'json_equals', path: 'result.json', key: 'a' }] })] },
        /equals/,
      ],
      [
        {
          ...base,
          cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'trace_event', event: 'done', present: 1 }] })],
        },
        /boolean/,
      ],
      [
        {
          ...base,
          cases: [
            caseDoc('a', {
              checks: [
                { id: 'x', kind: 'exit_code', equals: 0 },
                { id: 'x', kind: 'exit_code', equals: 1 },
              ],
            }),
          ],
        },
        /unique/,
      ],
      [
        { ...base, cases: [caseDoc('a', { safety: [{ id: 'exit', kind: 'exit_code', equals: 0 }] })] },
        /distinct/,
      ],
      [{ ...base, cases: [{ ...caseDoc('a'), argv: [] }] }, /argv/],
      [{ ...base, cases: [{ ...caseDoc('a'), timeout_s: 0 }] }, /timeout/],
      [{ ...base, cases: [caseDoc('a', { checks: [] })] }, /task checks/],
      [suiteDoc('skill', [caseDoc('a')]), /skill binding/],
      [suiteDoc('skill', [{ ...caseDoc('a'), skill: { skill_id: 'x', skill_path: 'skills/x', should_trigger: 'yes' } }]), /boolean/],
      [suiteDoc('skill', [caseDoc('a', { checks: [], skill: skillBinding(true, 'mismatched') })]), /positive/],
      [
        {
          ...base,
          cases: [caseDoc('a', { checks: [{ id: 's', kind: 'script', path: 'check.mjs', pass_exit_codes: 'zero' }] })],
        },
        /pass_exit_codes/,
      ],
    ];
    for (const [value, message] of variants) {
      await assert.rejects(loadSuite(await write(fx.root, 'bad.json', value)), message);
    }
  } finally {
    await fx.cleanup();
  }
});

test('subject workspace trials and cli errors', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`process.exit(0);
`);
    const suitePath = await write(fx.root, 'suite.json', suiteDoc('software', [caseDoc('a')]));
    const valid = { kind: 'software', id: 'subject', version: 'v1' };
    const subjectVariants: [unknown, RegExp][] = [
      [{ ...valid, kind: 'agent' }, /kind/],
      [{ ...valid, env: [] }, /env/],
      [{ ...valid, env: { 'BAD-NAME': 'x' } }, /env/],
    ];
    for (const [value, message] of subjectVariants) {
      await assert.rejects(
        runSuite(suitePath, await write(fx.root, 'subject.json', value), fx.runtimePath, fx.workspace, fx.output),
        message,
      );
    }
    const subjectPath = await write(fx.root, 'subject.json', valid);
    for (const trials of [0, true, 21]) {
      await assert.rejects(runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output, { trials: trials as number }), /trials/);
    }
    await assert.rejects(
      runSuite(suitePath, subjectPath, fx.runtimePath, join(fx.root, 'missing'), fx.output),
      /workspace/,
    );
    // A workspace containing a directory link must be rejected before copying.
    if (await canCreateDirectoryLink(fx.root)) {
      await symlink(fx.root, join(fx.workspace, 'linked'), 'junction');
      await assert.rejects(runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output), /symlinks/);
    }
    const failed = await captureStderr(async () => main(['validate', join(fx.root, 'missing.json')]));
    assert.equal(failed.value, 2);
  } finally {
    await fx.cleanup();
  }
});

test('artifact and trace failure modes', async (t) => {
  const fx = new Fixture();
  await fx.setup();
  try {
    if (!(await canCreateDirectoryLink(fx.root))) {
      t.skip('directory links are not creatable on this platform');
      return;
    }
    // A link pointing outside the workspace must never satisfy file_exists.
    await mkdir(join(fx.root, 'outside-dir'), { recursive: true });
    await writeFile(join(fx.root, 'outside-dir', 'linked.json'), '{}', 'utf8');
    await fx.project(`import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
mkdirSync('outputs/folder', { recursive: true });
writeFileSync('outputs/folder/result.json', '{bad json');
symlinkSync(process.env.OUTSIDE_DIR, 'outputs/folder/linked', 'junction');
`);
    const checks = [
      { id: 'missing', kind: 'file_exists', path: 'outputs/missing' },
      { id: 'bad', kind: 'json_equals', path: 'outputs/folder/result.json', key: 'x', equals: true },
      { id: 'linked', kind: 'file_exists', path: 'outputs/folder/linked/linked.json' },
      { id: 'no-trace', kind: 'trace_event', event: 'tool.called', present: false },
    ];
    const run = await fx.runEval(
      'software',
      [caseDoc('bad', { checks })],
      { OUTSIDE_DIR: join(fx.root, 'outside-dir') },
    );
    const result = await firstResult(run);
    assert.deepEqual(
      result.checks.map((item: any) => item.passed),
      [false, false, false, null],
    );
  } finally {
    await fx.cleanup();
  }
});

test('comparison guards and pair directions', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`const id = process.env.CRAFT_EVAL_CASE_ID;
const enabled = process.env.ENABLED === '1';
process.exit((id === 'gain' && enabled) || (id === 'loss' && !enabled) ? 0 : 1);
`);
    const cases = [caseDoc('gain'), caseDoc('loss')];
    const baseline = await fx.runEval('software', cases, { ENABLED: '0' });
    const candidate = await fx.runEval('software', cases, { ENABLED: '1' });
    const result = await compareRuns(baseline, candidate);
    assert.deepEqual([result.candidate_wins, result.baseline_wins], [1, 1]);
    assert.equal(result.one_sided_p, 0.75);
    const changed = await fx.runEval('software', [caseDoc('other')]);
    await assert.rejects(compareRuns(baseline, changed), /not comparable/);
    assert.equal(signProbability(0, 0), null);
    assert.equal(signProbability(0, 2), 1);
    const tampered = join(candidate, 'results', 'gain-1.json');
    const data = JSON.parse(await readFile(tampered, 'utf8'));
    data.trial = 2;
    await writeFile(tampered, JSON.stringify(data), 'utf8');
    await assert.rejects(compareRuns(baseline, candidate), /does not match/);
  } finally {
    await fx.cleanup();
  }
});

test('self-reported triggers can diagnose but never support a gain claim', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
const enabled = process.env.SKILL_ENABLED === '1';
const positive = process.env.CRAFT_EVAL_CASE_ID.startsWith('task-');
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: positive ? enabled : true }));
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
const events = [];
if (enabled && positive) {
  // Forged by the subject itself: source is "host", not the evaluator's gateway.
  events.push({ source: 'host', task_run_id: id, event: 'skill.invoked', skill_id: 'answer-skill' });
}
events.push({ source: 'host', task_run_id: id, event: 'run.finished', cost_units: 1 });
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`);
    const checks = [{ id: 'outcome', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true }];
    const cases = [] as unknown[];
    for (let index = 0; index < 20; index += 1) {
      cases.push(caseDoc(`task-${index}`, { checks, skill: skillBinding(true) }));
    }
    cases.push(caseDoc('adjacent', { checks: [], skill: skillBinding(false) }));
    const baseline = await fx.runEval('skill', cases, { SKILL_ENABLED: '0' });
    const candidate = await fx.runEval('skill', cases, { SKILL_ENABLED: '1' });
    // The trigger verdict reads as passed because the numbers line up, but the
    // evidence class makes it unusable for gain claims.
    const positiveResult = (await reportRun(candidate)).results.filter((item) => item.trigger !== null)[0];
    assert.equal(positiveResult?.trigger?.evidence, 'self_reported');
    const compared = await compareRuns(baseline, candidate);
    assert.equal(compared.gateway_observed_triggers, false);
    assert.equal(compared.skill_gain_supported, false, 'self-reported evidence must not support a gain');
  } finally {
    await fx.cleanup();
  }
});

test('script checks grade by exit code and classify failures', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: true }));
const script = process.env.CRAFT_EVAL_CASE_ID === 'passing'
  ? "import { writeFileSync } from 'node:fs'; writeFileSync('graded.txt', 'pass'); process.exit(0);"
  : "process.exit(2);";
writeFileSync('grade.mjs', script);
`);
    const scriptCheck = { id: 'grade', kind: 'script', path: 'grade.mjs' };
    const passing = await fx.runEval('software', [caseDoc('passing', { checks: [scriptCheck] })]);
    const passingCheck = await firstCheck(passing);
    assert.deepEqual([passingCheck.passed, passingCheck.reason], [true, 'ok']);
    // The failing case must still exit 0 so the script check alone decides.
    const failingSuite = await fx.runEval(
      'software',
      [caseDoc('failing', { checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }, scriptCheck] })],
    );
    const failingCheck = (await reportRun(failingSuite)).results[0]?.checks.find((item) => item.id === 'grade');
    assert.deepEqual([failingCheck?.passed, failingCheck?.reason, failingCheck?.evidence.exit_code], [false, 'script_failed', 2]);
    const missing = await fx.runEval('software', [
      caseDoc('missing', { checks: [{ id: 'grade', kind: 'script', path: 'nope/grade.mjs' }] }),
    ]);
    const missingCheck = await firstCheck(missing);
    assert.deepEqual([missingCheck.passed, missingCheck.reason], [false, 'not_found']);
    const accepted = { id: 'grade', kind: 'script', path: 'grade.mjs', pass_exit_codes: [0, 2] };
    const custom = await fx.runEval(
      'software',
      [caseDoc('failing', { checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }, accepted] })],
    );
    assert.equal(((await reportRun(custom)).results[0]?.checks.find((item) => item.id === 'grade'))?.passed, true);
  } finally {
    await fx.cleanup();
  }
});

test('development suite and command entry points', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`process.exit(0);
`);
    const suitePath = await write(fx.root, 'development.json', suiteDoc('software', [caseDoc('one')], 'development'));
    const subjectPath = await write(fx.root, 'subject.json', { kind: 'software', id: 'build', version: 'v1' });
    assert.equal((await loadSuite(suitePath)).partition, 'development');
    const captured = await captureStdout(async () =>
      main([
        'run',
        suitePath,
        subjectPath,
        fx.runtimePath,
        '--workspace',
        fx.workspace,
        '--output',
        fx.output,
      ]),
    );
    assert.equal(captured.value, 0);
    const runDir = JSON.parse(captured.text).run_dir as string;
    assert.equal((await reportRun(runDir)).passed, 1);
    const cli = spawnSync(NODE_BINARY, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'validate', suitePath], {
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
  } finally {
    await fx.cleanup();
  }
});

test('mocked mcp servers serve tools and tool_call checks grade from evaluator evidence', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // The host acts as a real MCP client: it reads the evaluator's server
    // descriptor, connects over stdio, initializes, lists tools and calls one.
    await fx.project(`import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const servers = JSON.parse(process.env.CRAFT_EVAL_MCP);
const server = servers[0];
mkdirSync('outputs', { recursive: true });

const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 1;
function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\\n');
  });
}
child.stdout.setEncoding('utf8');
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval-host', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
const listed = await request('tools/list', {});
const called = await request('tools/call', { name: 'lookup', arguments: { q: 'craft' } });
const wrongArgs = await request('tools/call', { name: 'lookup', arguments: { q: 'other' } });

writeFileSync('outputs/mcp-result.json', JSON.stringify({
  tools: listed.result?.tools?.map((t) => t.name) ?? [],
  call_ok: !called.result?.isError,
  call_text: called.result?.content?.[0]?.text ?? '',
  wrong_call_ok: !wrongArgs.result?.isError,
}));
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
const events = [
  { source: 'host', task_run_id: id, event: 'tool.called' },
  { source: 'host', task_run_id: id, event: 'run.finished', cost_units: 1 },
];
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
child.kill();
`);
    const mcp = [
      {
        name: 'search',
        tools: [
          {
            name: 'lookup',
            description: 'Look up a term',
            input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
            response: { content: [{ type: 'text', text: 'found:1' }] },
          },
        ],
      },
    ];
    const checks = [
      { id: 'result', kind: 'json_equals', path: 'outputs/mcp-result.json', key: 'call_ok', equals: true },
      { id: 'served', kind: 'json_equals', path: 'outputs/mcp-result.json', key: 'tools', equals: ['lookup'] },
      { id: 'called', kind: 'tool_call', server: 'search', tool: 'lookup', called: true },
      { id: 'args', kind: 'tool_call', server: 'search', tool: 'lookup', called: true, with_arguments: { q: 'craft' } },
      { id: 'not-called', kind: 'tool_call', server: 'search', tool: 'missing-tool', called: false },
    ];
    const run = await fx.runEval('agent', [caseDoc('use-mcp', { checks, mcp })]);
    const result = await firstResult(run);
    assert.deepEqual(
      [result.verdict, result.checks.map((item) => item.passed)],
      ['passed', [true, true, true, true, true]],
    );
    const argsCheck = result.checks.find((item) => item.id === 'args');
    assert.equal(argsCheck?.evidence.calls, 2, 'both calls are recorded even when only one matches');
    // A wrong-arguments expectation fails with a precise reason and observed values.
    const wrong = await fx.runEval('agent', [
      caseDoc('wrong', {
        mcp,
        checks: [
          { id: 'args', kind: 'tool_call', server: 'search', tool: 'lookup', called: true, with_arguments: { q: 'nope' } },
          { id: 'absent', kind: 'tool_call', server: 'search', tool: 'lookup', called: false },
        ],
      }),
    ]);
    const wrongResult = await firstResult(wrong);
    assert.deepEqual(
      wrongResult.checks.map((item) => [item.reason, item.passed]),
      [
        ['arguments_mismatch', false],
        ['tool_unexpectedly_called', false],
      ],
    );
  } finally {
    await fx.cleanup();
  }
});

test('mcp contract validation rejects malformed declarations', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    const withMcp = (mcp: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => {
      const check = { id: 'c', kind: 'tool_call', server: 'a', tool: 't', called: true };
      return suiteDoc('software', [caseDoc('x', { checks: [check], mcp: mcp as unknown[], ...extra })]);
    };
    const variants: [unknown, RegExp][] = [
      [withMcp([]), /1\.\.32|mcp/],
      [withMcp([{ name: 'a', tools: [] }]), /1\.\.32/],
      [withMcp([{ name: 'a', tools: [{ name: 't' }] }, { name: 'a', tools: [{ name: 'u' }] }]), /unique/],
      [withMcp([{ name: 'a', tools: [{ name: 't' }, { name: 't' }] }]), /unique/],
      [withMcp([{ name: 'a', tools: [{ name: 'bad name' }] }]), /identifier/],
      [
        suiteDoc('software', [
          caseDoc('x', { checks: [{ id: 'c', kind: 'tool_call', server: 'undeclared', tool: 't', called: true }] }),
        ]),
        /undeclared/,
      ],
      [
        suiteDoc('software', [caseDoc('x', { checks: [{ id: 'c', kind: 'tool_call', server: 'a', called: true }] })]),
        /tool name/,
      ],
    ];
    for (const [value, message] of variants) {
      await assert.rejects(loadSuite(await write(fx.root, 'bad-mcp.json', value)), message);
    }
  } finally {
    await fx.cleanup();
  }
});
